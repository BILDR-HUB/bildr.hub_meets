/**
 * offscreen.js – Captures tab audio (remote participants), sends chunks to backend.
 *
 * Uses stop/restart MediaRecorder cycle so every chunk is a complete,
 * valid WebM file with its own header.
 *
 * Your mic is recorded by content.js on the Meet page.
 */

let currentRecorder = null;
let tabStream = null;
let currentConfig = {};
let chunkIndex = 0;
let rotateInterval = null;
let mimeType = null;

const CHUNK_INTERVAL_MS = 30_000;

// ── Port to background ──────────────────────────────────────────────

let port = null;
try {
  port = chrome.runtime.connect({ name: "offscreen" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "START_CAPTURE") startCapture(msg.payload);
    if (msg.type === "STOP_CAPTURE") stopCapture();
  });
  port.onDisconnect.addListener(() => { port = null; });
} catch (e) { console.error("[OFF] port err:", e); }

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "OFFSCREEN_START_CAPTURE" || msg.type === "START_CAPTURE") startCapture(msg.payload);
  if (msg.type === "OFFSCREEN_STOP_CAPTURE" || msg.type === "STOP_CAPTURE") stopCapture();
});

// ── Start capture ───────────────────────────────────────────────────

async function startCapture(payload) {
  console.log("[OFF] startCapture:", payload.meetingId);
  const { streamId, meetingId, apiUrl } = payload;
  currentConfig = { meetingId, apiUrl };
  chunkIndex = 0;

  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    console.log("[OFF] Tab audio OK");

    mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";

    // Start first segment
    startSegment();

    // Rotate every 30s: stop current (triggers upload) + start new
    rotateInterval = setInterval(() => rotateRecorder(), CHUNK_INTERVAL_MS);

  } catch (err) {
    console.error("[OFF] startCapture error:", err);
    sendBG("UPLOAD_ERROR", { error: err.message });
  }
}

// ── Segment recording ───────────────────────────────────────────────

function startSegment() {
  if (!tabStream || !tabStream.active) return;

  const recorder = new MediaRecorder(tabStream, {
    mimeType,
    audioBitsPerSecond: 128000,
  });

  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data?.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type: "audio/webm" });
    const idx = chunkIndex++;
    const sizeKB = (blob.size / 1024).toFixed(1);

    console.log(`[OFF] Upload chunk #${idx}: ${sizeKB} KB`);

    const form = new FormData();
    form.append("file", blob, `tab_chunk_${idx}.webm`);
    form.append("meeting_id", currentConfig.meetingId);
    form.append("chunk_index", String(idx));

    try {
      const res = await fetch(`${currentConfig.apiUrl}/api/audio-chunk`, {
        method: "POST",
        body: form,
      });
      if (res.ok) {
        const data = await res.json();
        console.log(`[OFF] Chunk #${idx} response:`, data);
        if (data.question) {
          sendBG("AI_QUESTION", { question: data.question });
        }
      } else {
        console.error(`[OFF] Chunk #${idx} failed: ${res.status}`);
      }
    } catch (err) {
      console.error(`[OFF] Chunk #${idx} fetch error:`, err);
    }
  };

  recorder.onerror = (e) => {
    console.error("[OFF] Recorder error:", e.error);
  };

  recorder.start(); // No timeslice → complete WebM per segment
  currentRecorder = recorder;
  console.log("[OFF] Segment started");
}

function rotateRecorder() {
  if (currentRecorder && currentRecorder.state === "recording") {
    currentRecorder.stop(); // triggers onstop → upload
  }
  startSegment();
}

// ── Stop ────────────────────────────────────────────────────────────

function stopCapture() {
  console.log("[OFF] stopCapture");
  if (rotateInterval) { clearInterval(rotateInterval); rotateInterval = null; }
  if (currentRecorder && currentRecorder.state !== "inactive") {
    currentRecorder.stop(); // triggers onstop → uploads final chunk
  }
  // Small delay to let the final onstop handler complete, then cleanup
  setTimeout(() => {
    cleanup();
    sendBG("UPLOAD_COMPLETE", {});
  }, 2000);
}

// ── Helpers ─────────────────────────────────────────────────────────

function sendBG(type, payload) {
  try { if (port) { port.postMessage({ type, payload }); return; } } catch {}
  try { chrome.runtime.sendMessage({ type, payload }); } catch {}
}

function cleanup() {
  if (tabStream) {
    tabStream.getTracks().forEach(t => t.stop());
    tabStream = null;
  }
  currentRecorder = null;
  currentConfig = {};
}
