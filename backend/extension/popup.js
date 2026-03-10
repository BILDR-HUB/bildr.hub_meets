/**
 * popup.js – Controls recording from the extension popup.
 *
 * Popup click grants activeTab → tabCapture works from here.
 * Stop also calls backend directly to update meeting status.
 */

const API_URL = "https://bildr-meets.bator-turny.workers.dev";

const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const statusEl = document.getElementById("status");
const timerEl = document.getElementById("timer");
const notMeetEl = document.getElementById("not-meet");
const recIndicator = document.getElementById("rec-indicator");
const statusDot = document.getElementById("status-dot");

let timerInterval = null;

// ── Init ─────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.startsWith("https://meet.google.com/")) {
    notMeetEl.style.display = "block";
    statusEl.style.display = "none";
    btnStart.style.display = "none";
    return;
  }

  // Backend elérhetőség ellenőrzése
  try {
    const r = await fetch(`${API_URL}/api/health`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    statusEl.textContent = "Kész a felvételre.";
    statusEl.className = "";
    if (statusDot) statusDot.classList.add("online");
  } catch (e) {
    statusEl.textContent = `Backend nem elérhető: ${e.message}`;
    statusEl.className = "err";
    btnStart.disabled = true;
    console.error("[popup] Backend check failed:", e);
    return;
  }

  const state = await chrome.storage.local.get(["recording", "startTime"]);
  if (state.recording) {
    showStopUI(state.startTime);
  }
});

// ── Start ────────────────────────────────────────────────────────────

btnStart.addEventListener("click", async () => {
  btnStart.disabled = true;
  statusEl.textContent = "Indítás...";
  statusEl.className = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log("[popup] Tab:", tab?.url);

    // 1. Tab capture (popup has activeTab)
    statusEl.textContent = "Tab capture...";
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });
    console.log("[popup] streamId:", streamId);
    statusEl.textContent = "Stream OK, meeting létrehozása...";

    // 2. Create meeting in backend
    const title = tab.title?.replace(" - Google Meet", "").trim() || "Meeting";
    console.log("[popup] Fetching:", API_URL + "/api/meetings");
    let res;
    try {
      res = await fetch(`${API_URL}/api/meetings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, source: "extension" }),
      });
    } catch (fetchErr) {
      throw new Error(`Hálózati hiba: ${fetchErr.message} (${API_URL})`);
    }
    if (!res.ok) throw new Error(`Backend: HTTP ${res.status}`);
    const meeting = await res.json();
    console.log("[popup] Meeting created:", meeting.id);
    statusEl.textContent = "Meeting OK, capture indítása...";

    // 3. Tell background to start offscreen capture
    const bgRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: "START_CAPTURE_WITH_STREAM",
        payload: { streamId, meetingId: meeting.id, apiUrl: API_URL },
      }, resolve);
    });
    console.log("[popup] BG response:", bgRes);

    if (bgRes?.status === "error") throw new Error(bgRes.error);

    // 4. Save state
    const startTime = Date.now();
    await chrome.storage.local.set({ recording: true, meetingId: meeting.id, startTime });

    // 5. Notify content script (it will start mic recording)
    try {
      chrome.tabs.sendMessage(tab.id, {
        type: "RECORDING_STARTED",
        startTime,
        meetingId: meeting.id,
      });
    } catch {}

    showStopUI(startTime);
  } catch (err) {
    console.error("[popup]", err);
    statusEl.textContent = err.message;
    statusEl.className = "err";
    btnStart.disabled = false;
  }
});

// ── Stop ─────────────────────────────────────────────────────────────

btnStop.addEventListener("click", async () => {
  btnStop.disabled = true;
  statusEl.textContent = "Leállítás...";

  const state = await chrome.storage.local.get(["meetingId"]);
  const meetingId = state.meetingId;

  // 1. Tell background/offscreen to stop tab audio recording
  try {
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE_NOW" });
  } catch {}

  // 2. Tell content script to stop mic recording (it will upload final chunk)
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "RECORDING_STOPPED" });
  } catch {}

  // 3. Update meeting status to processing
  if (meetingId) {
    try {
      await fetch(`${API_URL}/api/bot/stop/${meetingId}`, { method: "POST" });
      console.log("[popup] Backend stop called for:", meetingId);
    } catch (err) {
      console.error("[popup] Backend stop failed:", err);
    }
  }

  // 4. Wait for final chunks to upload, then finalize
  if (meetingId) {
    statusEl.textContent = "Feldolgozás...";
    statusEl.className = "rec";
    setTimeout(async () => {
      try {
        const form = new FormData();
        form.append("meeting_id", meetingId);
        form.append("source", "bot");
        const res = await fetch(`${API_URL}/api/audio-finalize`, {
          method: "POST",
          body: form,
        });
        if (res.ok) {
          const data = await res.json();
          console.log("[popup] Finalize OK:", data);
          statusEl.textContent = "Kész!";
          statusEl.className = "ok";
          const officeBtn = document.getElementById("btn-office");
          if (officeBtn) officeBtn.style.display = "block";
        } else {
          console.error("[popup] Finalize failed:", await res.text());
          statusEl.textContent = "Feldolgozási hiba";
          statusEl.className = "err";
        }
      } catch (err) {
        console.error("[popup] Finalize error:", err);
        statusEl.textContent = "Feldolgozási hiba";
        statusEl.className = "err";
      }
    }, 4000); // 4s delay to let final chunks upload
  }

  // 5. Clear state
  await chrome.storage.local.set({ recording: false, meetingId: null, startTime: null });

  showStartUI();
});

// ── UI ──────────────────────────────────────────────────────────────

function showStopUI(startTime) {
  btnStart.style.display = "none";
  btnStop.style.display = "block";
  btnStop.disabled = false;
  statusEl.textContent = "";
  statusEl.className = "rec";
  if (recIndicator) recIndicator.classList.add("active");
  timerEl.style.display = "block";
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => tick(startTime), 1000);
  tick(startTime);
}

function showStartUI() {
  btnStart.style.display = "block";
  btnStart.disabled = false;
  btnStop.style.display = "none";
  timerEl.style.display = "none";
  if (recIndicator) recIndicator.classList.remove("active");
  statusEl.textContent = "Kész a felvételre.";
  statusEl.className = "";
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function tick(st) {
  const s = Math.floor((Date.now() - st) / 1000);
  timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
