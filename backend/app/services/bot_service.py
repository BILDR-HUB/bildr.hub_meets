"""
bot_service.py – Playwright-based Google Meet bot.

Launches a Chromium instance with the custom MV3 extension loaded,
joins a Google Meet call as a named bot, triggers audio recording
via DOM events, and waits for the meeting to end or a stop signal.

Requires a one-time Google login setup via `setup_google_login()`.

Usage:
    from app.services.bot_service import MeetBot

    bot = MeetBot(
        meet_url="https://meet.google.com/abc-defg-hij",
        meeting_id="uuid-here",
        bot_name="Jegyzetelő Bot",
    )
    await bot.run()
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path

import httpx

from playwright.async_api import (
    BrowserContext,
    Page,
    async_playwright,
)

from app.core.config import settings

logger = logging.getLogger(__name__)

# Path to the Chrome extension directory
EXTENSION_DIR = Path(__file__).resolve().parent.parent.parent / "extension"

# Persistent browser profile – stores Google login cookies
BOT_PROFILE_DIR = Path.home() / ".meeting-bot-profile"

# How long to wait for the "Ask to join" / "Join now" button (seconds)
JOIN_TIMEOUT_MS = 30_000

# How often to check if the bot was kicked or the meeting ended (seconds)
HEARTBEAT_INTERVAL = 10


class MeetBot:
    """Async Google Meet bot that records tab audio via a Chrome extension."""

    def __init__(
        self,
        meet_url: str,
        meeting_id: str | None = None,
        bot_name: str = "Meeting Bot",
        api_url: str | None = None,
        headless: bool = True,
        max_duration_minutes: int = 180,
    ):
        self.meet_url = meet_url
        self.meeting_id = meeting_id
        self.bot_name = bot_name
        self.api_url = api_url or os.getenv("BOT_API_URL", "http://localhost:8000")
        self.headless = headless
        self.max_duration_seconds = max_duration_minutes * 60

        self._context: BrowserContext | None = None
        self._page: Page | None = None
        self._stop_event = asyncio.Event()

    # ── Public API ───────────────────────────────────────────────────

    async def run(self) -> None:
        """Full lifecycle: launch → join → record → leave → close."""
        async with async_playwright() as pw:
            try:
                await self._launch_browser(pw)
                await self._join_meeting()
                await self._start_recording()
                await self._wait_until_done()
            except Exception:
                logger.exception("Bot encountered an error")
                raise
            finally:
                await self._stop_recording()
                await self._leave_meeting()
                await self._close_browser()

    def request_stop(self) -> None:
        """Signal the bot to stop recording and leave (thread-safe)."""
        self._stop_event.set()

    # ── Browser lifecycle ────────────────────────────────────────────

    async def _launch_browser(self, pw) -> None:
        """Launch Chromium with the extension loaded."""
        if not EXTENSION_DIR.exists():
            raise FileNotFoundError(
                f"Chrome extension not found at {EXTENSION_DIR}"
            )

        # Chrome's --load-extension uses comma as separator for multiple
        # extensions, so paths containing commas break it.
        # Copy extension to a temp dir with a clean path.
        ext_str = str(EXTENSION_DIR)
        if "," in ext_str:
            self._tmp_ext_dir = tempfile.mkdtemp(prefix="meet_ext_")
            shutil.copytree(EXTENSION_DIR, Path(self._tmp_ext_dir) / "ext", dirs_exist_ok=True)
            ext_path = str(Path(self._tmp_ext_dir) / "ext")
            logger.info("Copied extension to comma-free path: %s", ext_path)
        else:
            self._tmp_ext_dir = None
            ext_path = ext_str

        # Ensure persistent profile directory exists
        BOT_PROFILE_DIR.mkdir(parents=True, exist_ok=True)

        # Silent WAV for fake microphone (produces silence instead of real mic)
        silence_wav = Path(ext_path) / "silence.wav"
        if not silence_wav.exists():
            silence_wav = EXTENSION_DIR / "silence.wav"

        logger.info("Launching Chromium with extension: %s (profile: %s)", ext_path, BOT_PROFILE_DIR)

        self._context = await pw.chromium.launch_persistent_context(
            user_data_dir=str(BOT_PROFILE_DIR),
            headless=False,  # Must be False for extensions + tabCapture
            args=[
                f"--disable-extensions-except={ext_path}",
                f"--load-extension={ext_path}",
                # ── FAKE DEVICES: silent mic, no real camera/mic access ──
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                f"--use-file-for-fake-audio-capture={silence_wav}",
                # ── Hide the window completely ──
                "--window-position=-9999,-9999",
                "--window-size=1280,720",
                # ── Suppress all popups ──
                "--disable-infobars",
                "--disable-notifications",
                "--no-first-run",
                "--no-default-browser-check",
                # ── Background processing ──
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-gpu",
            ],
            viewport={"width": 1280, "height": 720},
        )

        # Inject script to replace camera with black canvas (no green animation)
        await self._context.add_init_script("""
            (() => {
                const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                navigator.mediaDevices.getUserMedia = async function(constraints) {
                    // Let tab capture through untouched
                    if (constraints?.audio?.mandatory?.chromeMediaSource === 'tab') {
                        return origGUM(constraints);
                    }
                    const stream = await origGUM(constraints);
                    // Kill video tracks → replace with black canvas
                    stream.getVideoTracks().forEach(t => t.stop());
                    const canvas = Object.assign(document.createElement('canvas'), {width:640, height:480});
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#000';
                    ctx.fillRect(0, 0, 640, 480);
                    const blackTrack = canvas.captureStream(1).getVideoTracks()[0];
                    if (blackTrack) stream.addTrack(blackTrack);
                    console.log('[MeetBot] Replaced camera with black, mic is silent WAV');
                    return stream;
                };
            })();
        """)

        # Use the first page (or create one)
        if self._context.pages:
            self._page = self._context.pages[0]
        else:
            self._page = await self._context.new_page()

        logger.info("Browser launched successfully (auto-mute injected).")

    async def _close_browser(self) -> None:
        """Close the browser context."""
        if self._context:
            try:
                await self._context.close()
            except Exception:
                logger.warning("Error closing browser context", exc_info=True)
            self._context = None
            self._page = None
        # Clean up temp extension dir
        if getattr(self, "_tmp_ext_dir", None):
            shutil.rmtree(self._tmp_ext_dir, ignore_errors=True)
            self._tmp_ext_dir = None
        logger.info("Browser closed.")

    # ── Meeting join flow ────────────────────────────────────────────

    async def _join_meeting(self) -> None:
        """Navigate to the Meet URL and join the call."""
        page = self._page
        if not page:
            raise RuntimeError("Browser page not initialized")

        logger.info("Navigating to %s", self.meet_url)
        await page.goto(self.meet_url, wait_until="networkidle")

        # Wait for the page to fully load
        await page.wait_for_timeout(5000)

        # ── Check for access denied ──────────────────────────────────
        denied_text = page.locator(
            'text="Nem csatlakozhat ehhez a videohíváshoz", '
            'text="You can\'t join this video call", '
            'text="Not allowed to join", '
            'text="Nincs jogosultsága"'
        )
        if await denied_text.count() > 0:
            raise RuntimeError(
                "A bot nem tud csatlakozni: a meeting nem enged vendégeket. "
                "Kérlek engedélyezd a 'Bárki csatlakozhat a linkkel' opciót a Meet beállításokban."
            )

        # ── Step 1: Enter the bot name ───────────────────────────────
        # Google Meet shows a "Your name" input before joining (for anonymous users)
        name_selectors = [
            'input[aria-label="Your name"]',
            'input[aria-label="Az Ön neve"]',      # Hungarian
            'input[aria-label="A neved"]',           # Hungarian informal
            'input[placeholder*="name" i]',
            'input[placeholder*="név" i]',
        ]
        for selector in name_selectors:
            name_input = page.locator(selector)
            if await name_input.count() > 0:
                logger.info("Entering bot name: %s (via %s)", self.bot_name, selector)
                await name_input.fill("")
                await name_input.fill(self.bot_name)
                await page.wait_for_timeout(500)
                break

        # ── Step 2: Disable camera and microphone ────────────────────
        await self._mute_camera_and_mic(page)

        # ── Step 3: Click "Ask to join" or "Join now" ────────────────
        join_button = page.locator(
            'button:has-text("Ask to join"), '
            'button:has-text("Join now"), '
            'button:has-text("Csatlakozás kérése"), '
            'button:has-text("Csatlakozás"), '
            'button:has-text("Belépés kérése")'
        )

        logger.info("Waiting for join button...")
        try:
            await join_button.first.wait_for(state="visible", timeout=JOIN_TIMEOUT_MS)
        except Exception:
            # Take a screenshot for debugging
            screenshot_path = "/tmp/meet_bot_debug.png"
            await page.screenshot(path=screenshot_path)
            logger.error("Join button not found. Screenshot saved to %s", screenshot_path)
            page_text = await page.inner_text("body")
            logger.error("Page text: %s", page_text[:500])
            raise RuntimeError(
                f"Nem található csatlakozás gomb. A meeting elutasíthatta a vendégeket. "
                f"Debug screenshot: {screenshot_path}"
            )

        await join_button.first.click()
        logger.info("Clicked join button. Waiting to be admitted...")

        # ── Step 4: Wait until we're actually in the meeting ─────────
        end_call_button = page.locator(
            'button[aria-label*="Leave call" i], '
            'button[aria-label*="End call" i], '
            'button[aria-label*="Hívás befejezése" i], '
            'button[aria-label*="Kilépés" i]'
        )
        try:
            await end_call_button.first.wait_for(
                state="visible", timeout=120_000  # 2 min to be admitted
            )
            logger.info("Successfully joined the meeting!")

            # Mute camera/mic again after joining (in case pre-join mute didn't stick)
            await page.wait_for_timeout(2000)
            await self._mute_camera_and_mic(page)
        except Exception:
            screenshot_path = "/tmp/meet_bot_waiting.png"
            await page.screenshot(path=screenshot_path)
            raise RuntimeError(
                f"A házigazda nem engedte be a botot 2 percen belül. "
                f"Debug screenshot: {screenshot_path}"
            )

    async def _leave_meeting(self) -> None:
        """Click the leave button or close the page."""
        if not self._page:
            return

        try:
            leave_btn = self._page.locator(
                'button[aria-label*="Leave call" i], '
                'button[aria-label*="End call" i], '
                'button[aria-label*="Hívás befejezése" i]'
            )
            if await leave_btn.count() > 0:
                await leave_btn.first.click()
                logger.info("Left the meeting via leave button.")
            else:
                logger.info("No leave button found; closing page.")
        except Exception:
            logger.warning("Error leaving meeting", exc_info=True)

    # ── Recording control via DOM events ─────────────────────────────

    async def _start_recording(self) -> None:
        """Dispatch START_BOT_RECORDING event to trigger the extension."""
        if not self._page:
            raise RuntimeError("Page not initialized")

        # Wait a moment for the extension content script to load
        await self._page.wait_for_timeout(2000)

        detail = json.dumps({
            "meetingId": self.meeting_id,
            "apiUrl": self.api_url,
        })

        logger.info("Dispatching START_BOT_RECORDING event...")
        await self._page.evaluate(f"""() => {{
            window.dispatchEvent(
                new CustomEvent('START_BOT_RECORDING', {{
                    detail: {detail}
                }})
            );
        }}""")
        logger.info("Recording started via extension.")

    async def _stop_recording(self) -> None:
        """Dispatch STOP_BOT_RECORDING event and wait for extension to finalize."""
        if not self._page:
            return

        try:
            await self._page.evaluate("""() => {
                window.dispatchEvent(new Event('STOP_BOT_RECORDING'));
            }""")
            logger.info("Dispatched STOP_BOT_RECORDING event. Waiting for extension to finalize...")
            # Wait up to 30 seconds for extension to upload final chunk + finalize
            await self._page.wait_for_timeout(15_000)
        except Exception:
            logger.warning("Error dispatching stop event", exc_info=True)

        # Fallback: if extension didn't finalize, trigger it from Python
        await self._ensure_finalized()

    async def _ensure_finalized(self) -> None:
        """Fallback: call /api/audio-finalize directly if the extension didn't."""
        if not self.meeting_id:
            return

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                # Check if meeting is still in 'recording' status (not yet finalized)
                status_resp = await client.get(
                    f"{self.api_url}/api/meetings/{self.meeting_id}/status"
                )
                if status_resp.status_code == 200:
                    status = status_resp.json().get("status")
                    if status in ("completed", "processing", "failed"):
                        logger.info("Meeting already finalized (status=%s), skipping.", status)
                        return

                logger.info("Extension didn't finalize. Calling /api/audio-finalize from bot...")
                resp = await client.post(
                    f"{self.api_url}/api/audio-finalize",
                    data={
                        "meeting_id": self.meeting_id,
                        "source": "bot",
                    },
                )
                if resp.status_code == 200:
                    logger.info("Finalize triggered successfully: %s", resp.json())
                elif resp.status_code == 404:
                    # No transcript text – nothing was recorded
                    logger.warning("No transcript found – marking meeting as failed.")
                    async with httpx.AsyncClient() as c2:
                        await c2.post(  # won't exist, but update DB directly
                            f"{self.api_url}/api/meetings/{self.meeting_id}/status"
                        )
                    from app.services.supabase_client import supabase_admin
                    supabase_admin.table("meetings").update(
                        {"status": "failed"}
                    ).eq("id", self.meeting_id).execute()
                else:
                    logger.error("Finalize failed: %s %s", resp.status_code, resp.text)
        except Exception:
            logger.warning("Error in _ensure_finalized", exc_info=True)

    # ── Wait logic ───────────────────────────────────────────────────

    async def _wait_until_done(self) -> None:
        """
        Wait until one of the following happens:
        1. request_stop() is called externally
        2. Max duration is reached
        3. The bot is removed from the meeting (end call button disappears)
        """
        logger.info(
            "Monitoring meeting (max %d min)...",
            self.max_duration_seconds // 60,
        )

        elapsed = 0
        while elapsed < self.max_duration_seconds:
            # Check external stop signal
            if self._stop_event.is_set():
                logger.info("Stop signal received.")
                return

            # Check if still in the meeting
            if not await self._is_in_meeting():
                logger.info("No longer in the meeting (kicked or meeting ended).")
                return

            await asyncio.sleep(HEARTBEAT_INTERVAL)
            elapsed += HEARTBEAT_INTERVAL

        logger.info("Max duration reached (%d min). Stopping.", self.max_duration_seconds // 60)

    async def _is_in_meeting(self) -> bool:
        """Check if the bot is still in the meeting."""
        if not self._page:
            return False

        try:
            # Check if we got kicked (no leave button = not in meeting)
            end_call_button = self._page.locator(
                'button[aria-label*="Leave call" i], '
                'button[aria-label*="End call" i], '
                'button[aria-label*="Hívás befejezése" i]'
            )
            if await end_call_button.count() == 0:
                return False

            # Check if we're the only one left (everyone else left)
            alone = await self._is_alone_in_meeting()
            if alone:
                logger.info("Bot is the only participant left. Leaving...")
                return False

            return True
        except Exception:
            return False

    async def _is_alone_in_meeting(self) -> bool:
        """Check if the bot is the only participant remaining."""
        if not self._page:
            return False

        try:
            # Method 1: Check for "You're the only one here" and similar text
            # Use page text content search (more reliable than exact locators)
            alone = await self._page.evaluate("""() => {
                const body = document.body.innerText.toLowerCase();
                const alonePatterns = [
                    "you're the only one here",
                    "ön az egyetlen",
                    "te vagy az egyetlen",
                    "egyedül van",
                    "csak ön van",
                    "no one else is here",
                    "senki más nincs",
                ];
                return alonePatterns.some(p => body.includes(p));
            }""")
            if alone:
                return True

            # Method 2: Check the URL – Meet redirects to a "meeting ended" page
            url = self._page.url
            if "meet.google.com" not in url or "/landing" in url:
                return True

            # Method 3: Count participant tiles / video feeds via JS
            count = await self._page.evaluate("""() => {
                // Method A: data-participant-id tiles (grid view)
                const tiles = document.querySelectorAll('[data-participant-id]');
                if (tiles.length > 0) return tiles.length;

                // Method B: data-self-name shows self, count sibling elements
                const selfTile = document.querySelector('[data-self-name]');
                if (selfTile) {
                    const parent = selfTile.closest('[data-allocation-index]')?.parentElement;
                    if (parent) return parent.children.length;
                }

                // Method C: count named participant elements in the call
                const names = document.querySelectorAll('[data-self-name], [data-requested-participant-id]');
                if (names.length > 0) return names.length;

                // Method D: video elements (includes self)
                const videos = document.querySelectorAll('video');
                return videos.length;
            }""")

            if isinstance(count, (int, float)):
                logger.debug("Participant count detected: %d", count)
                if count <= 1:
                    return True

            return False
        except Exception:
            return False

    # ── Helpers ──────────────────────────────────────────────────────

    async def _mute_camera_and_mic(self, page: Page) -> None:
        """Turn off camera and microphone using multiple strategies."""

        # Strategy 1: Click buttons whose aria-label says "Turn off" (= currently ON)
        # These are the CORRECT selectors – "Turn off" means it's ON, clicking turns it OFF
        camera_off_selectors = [
            'button[aria-label*="Turn off camera" i]',
            'button[aria-label*="Kamera kikapcsolása" i]',
            'button[aria-label*="camera" i][data-is-muted="false"]',
            'button[aria-label*="kamera" i][data-is-muted="false"]',
        ]
        mic_off_selectors = [
            'button[aria-label*="Turn off microphone" i]',
            'button[aria-label*="Mikrofon kikapcsolása" i]',
            'button[aria-label*="microphone" i][data-is-muted="false"]',
            'button[aria-label*="mikrofon" i][data-is-muted="false"]',
        ]

        for selector in camera_off_selectors:
            if await self._click_if_exists(page, selector):
                logger.info("Camera muted via: %s", selector)
                break

        await page.wait_for_timeout(300)

        for selector in mic_off_selectors:
            if await self._click_if_exists(page, selector):
                logger.info("Mic muted via: %s", selector)
                break

        await page.wait_for_timeout(300)

        # Strategy 2: JavaScript – kill all media tracks directly
        await page.evaluate("""() => {
            // Find all active media streams and stop their tracks
            if (window._meetBotMuted) return;
            const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            // Override getUserMedia to auto-disable tracks
            navigator.mediaDevices.getUserMedia = async (constraints) => {
                const stream = await origGetUserMedia(constraints);
                stream.getVideoTracks().forEach(t => { t.enabled = false; });
                stream.getAudioTracks().forEach(t => { t.enabled = false; });
                return stream;
            };
            window._meetBotMuted = true;
        }""")
        logger.info("Mute strategies applied.")

    @staticmethod
    async def _click_if_exists(page: Page, selector: str) -> bool:
        """Click an element if it exists, return True if clicked."""
        locator = page.locator(selector)
        if await locator.count() > 0:
            await locator.first.click()
            return True
        return False


# ── Convenience function for use as a background task ────────────────

async def spawn_bot(
    meet_url: str,
    meeting_id: str,
    bot_name: str = "Meeting Bot",
    api_url: str | None = None,
) -> None:
    """
    Spawn a MeetBot instance. Intended to be called from a
    FastAPI background task or Celery worker.
    """
    bot = MeetBot(
        meet_url=meet_url,
        meeting_id=meeting_id,
        bot_name=bot_name,
        api_url=api_url,
    )
    await bot.run()


# ── Google Login Setup ────────────────────────────────────────────────

async def setup_google_login() -> str:
    """
    Open a Chromium browser with the persistent profile so the user
    can manually log into their Google account. The session cookies
    are saved to BOT_PROFILE_DIR and reused by the bot.

    Returns a status message.
    """
    BOT_PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as pw:
        context = await pw.chromium.launch_persistent_context(
            user_data_dir=str(BOT_PROFILE_DIR),
            headless=False,
            args=[
                "--disable-infobars",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            viewport={"width": 1280, "height": 720},
        )

        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto("https://accounts.google.com", wait_until="networkidle")

        logger.info(
            "Setup browser opened at accounts.google.com. "
            "Please log in manually. The browser will stay open for 5 minutes."
        )

        # Wait until user logs in (myaccount page) or 5 minutes pass
        try:
            await page.wait_for_url(
                "**/myaccount.google.com/**",
                timeout=300_000,  # 5 minutes
            )
            logger.info("Google login detected! Saving profile...")
        except Exception:
            logger.info("Setup timed out, saving whatever state we have...")

        await context.close()

    return "Google login profile saved. The bot can now join meetings."


def is_google_logged_in() -> bool:
    """Check if the persistent profile directory exists and has cookies."""
    cookies_path = BOT_PROFILE_DIR / "Default" / "Cookies"
    return cookies_path.exists()
