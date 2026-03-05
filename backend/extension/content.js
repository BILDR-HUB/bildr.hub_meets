/**
 * content.js – Google Meet recording widget.
 *
 * Captures microphone audio directly from the Meet page
 * (Meet already has mic permission, so no extra prompt needed).
 * Sends audio chunks to the backend for transcription.
 *
 * The offscreen document handles tab audio (remote participants).
 * This script handles YOUR voice via the mic.
 */

const API_URL = "http://localhost:8000";

let isRecording = false;
let startTime = null;
let timerInterval = null;
let endChecker = null;

// Mic recording state
let micRecorder = null;
let micStream = null;
let micChunkIndex = 0;
let micRotateInterval = null;
let currentMeetingId = null;
let micMimeType = null;

// ── Widget ──────────────────────────────────────────────────────────

function createWidget() {
  if (document.getElementById("bildr-rec-widget")) return;

  const widget = document.createElement("div");
  widget.id = "bildr-rec-widget";
  widget.innerHTML = `
    <button id="bildr-rec-btn" class="idle">
      <span class="dot"></span>
      <span id="bildr-rec-label">Felvétel</span>
      <span id="bildr-rec-timer" style="display:none">00:00</span>
    </button>
  `;
  document.body.appendChild(widget);

  document.getElementById("bildr-rec-btn").addEventListener("click", async () => {
    if (isRecording) {
      await doStop();
    }
  });
}

// ── Messages from popup/background ──────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "RECORDING_STARTED") {
    currentMeetingId = message.meetingId;
    startTime = message.startTime || Date.now();
    startMicRecording(message.meetingId);
    setRecordingUI();
  }
  if (message.type === "RECORDING_STOPPED") {
    stopMicRecording();
    setIdleUI();
  }
});

// ── Restore state on load ───────────────────────────────────────────

function restore() {
  chrome.storage.local.get(["recording", "startTime", "meetingId"], (s) => {
    if (s.recording && s.meetingId) {
      currentMeetingId = s.meetingId;
      startTime = s.startTime || Date.now();
      startMicRecording(s.meetingId);
      setRecordingUI();
    }
  });
}

// ── Mic recording (runs on Meet page – has mic permission) ──────────
//
// Strategy: stop/restart MediaRecorder every 30s so each chunk is a
// complete, valid WebM file with its own header. This avoids the bug
// where only the first chunk has the WebM initialization segment.

async function startMicRecording(meetingId) {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    console.log("[bildr] Mic stream obtained on Meet page");

    micMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";
    micChunkIndex = 0;

    // Start first segment
    startMicSegment(meetingId);

    // Rotate every 30s: stop current (triggers upload) + start new
    micRotateInterval = setInterval(() => rotateMicRecorder(meetingId), 30000);

  } catch (err) {
    console.error("[bildr] Mic capture error:", err.message);
  }
}

function startMicSegment(meetingId) {
  if (!micStream || !micStream.active) return;

  const recorder = new MediaRecorder(micStream, {
    mimeType: micMimeType,
    audioBitsPerSecond: 128000,
  });

  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data?.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type: "audio/webm" });
    const idx = micChunkIndex++;
    console.log(`[bildr] Uploading mic chunk #${idx} (${(blob.size / 1024).toFixed(1)} KB)`);

    const form = new FormData();
    form.append("file", blob, `mic_chunk_${idx}.webm`);
    form.append("meeting_id", meetingId);
    form.append("chunk_index", String(idx));

    try {
      const res = await fetch(`${API_URL}/api/audio-chunk`, {
        method: "POST",
        body: form,
      });
      if (res.ok) {
        const result = await res.json();
        console.log(`[bildr] Mic chunk #${idx} transcribed: ${result.chunk_text_length} chars`);
      } else {
        console.error(`[bildr] Mic chunk #${idx} failed:`, await res.text());
      }
    } catch (err) {
      console.error(`[bildr] Mic chunk #${idx} error:`, err);
    }
  };

  recorder.start(); // No timeslice → complete WebM per segment
  micRecorder = recorder;
  console.log("[bildr] Mic segment started");
}

function rotateMicRecorder(meetingId) {
  // Stop current → triggers onstop → uploads complete WebM
  if (micRecorder && micRecorder.state === "recording") {
    micRecorder.stop();
  }
  // Start new segment immediately
  startMicSegment(meetingId);
}

function stopMicRecording() {
  if (micRotateInterval) {
    clearInterval(micRotateInterval);
    micRotateInterval = null;
  }
  if (micRecorder && micRecorder.state !== "inactive") {
    micRecorder.stop(); // triggers onstop → uploads final chunk
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  micRecorder = null;
}

// ── Stop flow ───────────────────────────────────────────────────────

async function doStop() {
  const meetingId = currentMeetingId;
  stopMicRecording();

  try { chrome.runtime.sendMessage({ type: "STOP_CAPTURE_NOW" }); } catch {}

  if (meetingId) {
    try {
      await fetch(`${API_URL}/api/bot/stop/${meetingId}`, { method: "POST" });
    } catch {}
  }

  await chrome.storage.local.set({ recording: false, meetingId: null, startTime: null });
  setIdleUI();

  // Wait for final chunks to upload, then finalize
  if (meetingId) {
    setTimeout(async () => {
      try {
        const form = new FormData();
        form.append("meeting_id", meetingId);
        form.append("source", "bot");
        const res = await fetch(`${API_URL}/api/audio-finalize`, {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        console.log("[bildr] Finalize result:", data);
      } catch (err) {
        console.error("[bildr] Finalize error:", err);
      }
    }, 4000);
  }
}

// ── UI ──────────────────────────────────────────────────────────────

function setRecordingUI() {
  isRecording = true;
  const btn = document.getElementById("bildr-rec-btn");
  const label = document.getElementById("bildr-rec-label");
  const timer = document.getElementById("bildr-rec-timer");
  if (!btn) return;

  btn.className = "recording";
  label.textContent = "Leállítás";
  timer.style.display = "inline";
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(tick, 1000);
  tick();

  // Auto-stop detection
  startEndDetection();
}

function setIdleUI() {
  isRecording = false;
  startTime = null;
  currentMeetingId = null;
  const btn = document.getElementById("bildr-rec-btn");
  const label = document.getElementById("bildr-rec-label");
  const timer = document.getElementById("bildr-rec-timer");
  if (!btn) return;

  btn.className = "idle";
  label.textContent = "Felvétel";
  timer.style.display = "none";
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  stopEndDetection();
}

function tick() {
  if (!startTime) return;
  const s = Math.floor((Date.now() - startTime) / 1000);
  const el = document.getElementById("bildr-rec-timer");
  if (el) el.textContent =
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ── Auto-stop ───────────────────────────────────────────────────────

function startEndDetection() {
  stopEndDetection();
  const t0 = Date.now();
  endChecker = setInterval(() => {
    if (!isRecording || Date.now() - t0 < 15000) return;
    if (!location.pathname.match(/\/[a-z]{3}-[a-z]{4}-[a-z]{3}/)) {
      console.log("[bildr] Meeting URL changed – auto-stopping");
      doStop();
    }
  }, 5000);
}

function stopEndDetection() {
  if (endChecker) { clearInterval(endChecker); endChecker = null; }
}

// ── Init ────────────────────────────────────────────────────────────

setTimeout(() => {
  if (document.body) { createWidget(); restore(); }
}, 1500);
