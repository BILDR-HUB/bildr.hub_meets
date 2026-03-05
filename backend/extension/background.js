/**
 * background.js – Service worker.
 *
 * Receives streamId from popup, manages offscreen document.
 * No tabCapture here – popup handles that (it has activeTab).
 */

let offscreenCreated = false;
let offscreenPort = null;

// ── Messages from popup & content script ────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_CAPTURE_WITH_STREAM") {
    startCapture(message.payload)
      .then(() => sendResponse({ status: "ok" }))
      .catch((err) => {
        console.error("[BG] start error:", err);
        sendResponse({ status: "error", error: err.message });
      });
    return true;
  }

  if (message.type === "STOP_CAPTURE_NOW" || message.type === "STOP_RECORDING") {
    stopCapture()
      .then(() => sendResponse({ status: "ok" }))
      .catch(() => sendResponse({ status: "ok" }));
    return true;
  }
});

// ── Start ────────────────────────────────────────────────────────────

async function startCapture(payload) {
  await ensureOffscreen();
  const ready = await waitForPort(3000);

  const msg = {
    type: "START_CAPTURE",
    payload: {
      streamId: payload.streamId,
      meetingId: payload.meetingId,
      apiUrl: payload.apiUrl,
    },
  };

  if (ready && offscreenPort) {
    offscreenPort.postMessage(msg);
    console.log("[BG] START_CAPTURE via port");
  } else {
    // fallback
    await chrome.runtime.sendMessage(Object.assign(msg, { type: "OFFSCREEN_START_CAPTURE" }));
    console.log("[BG] START_CAPTURE via sendMessage fallback");
  }
}

// ── Stop ─────────────────────────────────────────────────────────────

async function stopCapture() {
  if (offscreenPort) {
    offscreenPort.postMessage({ type: "STOP_CAPTURE" });
    console.log("[BG] STOP_CAPTURE via port");
  } else {
    try {
      await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_CAPTURE" });
    } catch {}
  }
}

// ── Offscreen document ──────────────────────────────────────────────

async function ensureOffscreen() {
  if (offscreenCreated) return;
  const ctx = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });
  if (ctx.length > 0) { offscreenCreated = true; return; }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Tab audio capture for transcription.",
  });
  offscreenCreated = true;
  console.log("[BG] offscreen created");
}

async function closeOffscreen() {
  if (!offscreenCreated) return;
  try { await chrome.offscreen.closeDocument(); } catch {}
  offscreenCreated = false;
  offscreenPort = null;
}

// ── Port from offscreen ─────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "offscreen") return;
  offscreenPort = port;
  console.log("[BG] offscreen port connected");

  port.onMessage.addListener((msg) => {
    if (msg.type === "UPLOAD_COMPLETE") {
      console.log("[BG] upload complete");
      closeOffscreen();
    }
    if (msg.type === "UPLOAD_ERROR") {
      console.error("[BG] upload error:", msg.payload);
      closeOffscreen();
    }
  });

  port.onDisconnect.addListener(() => { offscreenPort = null; });
});

function waitForPort(ms) {
  if (offscreenPort) return Promise.resolve(true);
  return new Promise((r) => {
    const t0 = Date.now();
    const check = () => {
      if (offscreenPort) r(true);
      else if (Date.now() - t0 > ms) r(false);
      else setTimeout(check, 100);
    };
    check();
  });
}
