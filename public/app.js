// Church Live Translator — operator client.
// Captures mic audio in 3s segments and runs each through:
//   /api/transcribe (Whisper) -> /api/translate (Google) -> /api/speak (ElevenLabs)
// then plays the Russian audio out the selected output device.

const SEGMENT_MS = 3000;     // send audio every 3 seconds
const MIN_BLOB_BYTES = 1500; // ignore near-silent / empty segments
const MAX_QUEUE = 5;         // drop oldest if we fall this far behind

const el = (id) => document.getElementById(id);
const startStopBtn = el("startStop");
const testBtn = el("testBtn");
const syscheck = el("syscheck");
const langToggle = el("langToggle");
const outputSelect = el("outputDevice");
const volume = el("volume");
const volVal = el("volVal");
const sourceBox = el("source");
const russianBox = el("russian");
const sourceLabel = el("sourceLabel");
const errorBox = el("error");
const dotMic = el("dotMic");
const dotProc = el("dotProc");
const dotAudio = el("dotAudio");
const queueCount = el("queueCount");

let running = false;
let stream = null;
let currentRec = null;
let mimeType = "";
let inputLang = "en";
let segCounter = 0;

const blobQueue = [];     // {id, blob} awaiting the API pipeline
let workerActive = false;
const player = new Audio();
player.autoplay = false;

// ---------- UI helpers ----------------------------------------------------
function setDot(dot, state) { dot.className = "dot" + (state ? " " + state : ""); }
function showError(msg) { errorBox.textContent = msg || ""; if (msg) setDot(dotMic, "err"); }
function setLangUI() {
  const isAr = inputLang === "ar";
  sourceLabel.textContent = isAr ? "Arabic transcript" : "English transcript";
  sourceBox.classList.toggle("rtl", isAr);
  [...langToggle.children].forEach((b) => b.classList.toggle("active", b.dataset.lang === inputLang));
}
function appendLine(box, text, cls) {
  const div = document.createElement("div");
  div.className = "line" + (cls ? " " + cls : "");
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}
function updateQueueUI() {
  queueCount.textContent = blobQueue.length ? `(${blobQueue.length} queued)` : "";
  setDot(dotProc, workerActive ? "busy" : (running ? "on" : ""));
}

// ---------- Output device + volume ---------------------------------------
async function refreshOutputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter((d) => d.kind === "audiooutput");
    const cur = outputSelect.value;
    outputSelect.innerHTML = '<option value="">Default output</option>';
    outs.forEach((d) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `Output ${outputSelect.length}`;
      outputSelect.appendChild(o);
    });
    if (cur) outputSelect.value = cur;
  } catch (e) { /* labels need permission; ignored until granted */ }
}
async function applySink() {
  const id = outputSelect.value;
  if (typeof player.setSinkId === "function" && id) {
    try { await player.setSinkId(id); }
    catch (e) { showError("Could not switch output device: " + e.message); }
  }
}
outputSelect.addEventListener("change", applySink);
volume.addEventListener("input", () => {
  player.volume = parseFloat(volume.value);
  volVal.textContent = Math.round(player.volume * 100) + "%";
});
langToggle.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || running) return;        // lock language while running
  inputLang = btn.dataset.lang;
  setLangUI();
});

// ---------- Recording: back-to-back complete 3s segments ------------------
function pickMimeType() {
  const prefs = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  for (const t of prefs) if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

function recordSegment() {
  if (!running) return;
  const chunks = [];
  let rec;
  try {
    rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (e) { showError("MediaRecorder error: " + e.message); return; }
  currentRec = rec;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
    if (blob.size >= MIN_BLOB_BYTES) enqueue(blob);
    if (running) recordSegment();     // immediately start the next segment
  };
  rec.start();
  setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, SEGMENT_MS);
}

function enqueue(blob) {
  blobQueue.push({ id: ++segCounter, blob });
  while (blobQueue.length > MAX_QUEUE) {
    blobQueue.shift();
    showError("Processing is behind — dropped an audio segment to catch up.");
  }
  updateQueueUI();
  if (!workerActive) drainQueue();
}

// ---------- Pipeline worker (sequential, preserves order & no overlap) ----
async function drainQueue() {
  workerActive = true;
  updateQueueUI();
  while (blobQueue.length) {
    const { blob } = blobQueue.shift();
    updateQueueUI();
    try { await processSegment(blob); }
    catch (e) { showError(e.message); }
  }
  workerActive = false;
  updateQueueUI();
}

async function processSegment(blob) {
  // 1) Transcribe
  const fd = new FormData();
  fd.append("audio", blob, "segment.webm");
  fd.append("language", inputLang);
  const tr = await fetch("/api/transcribe", { method: "POST", body: fd });
  if (!tr.ok) throw new Error("Transcribe failed: " + (await safeErr(tr)));
  const { text } = await tr.json();
  if (!text) return;                  // silence / no speech
  showError("");
  appendLine(sourceBox, text);

  // 2) Translate -> Russian
  const tl = await fetch("/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, source: inputLang, target: "ru" }),
  });
  if (!tl.ok) throw new Error("Translate failed: " + (await safeErr(tl)));
  const ru = (await tl.json()).text || "";
  if (!ru) return;
  const ruLine = appendLine(russianBox, ru);

  // 3) Speak (Russian) and play it out the selected device
  const sp = await fetch("/api/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: ru }),
  });
  if (!sp.ok) { ruLine.classList.add("pending"); throw new Error("Speak failed: " + (await safeErr(sp))); }
  const audioBlob = await sp.blob();
  await playAudio(audioBlob);
}

function playAudio(blob) {
  return new Promise(async (resolve) => {
    const url = URL.createObjectURL(blob);
    player.src = url;
    player.volume = parseFloat(volume.value);
    await applySink();
    setDot(dotAudio, "busy");
    const done = () => { setDot(dotAudio, running ? "on" : ""); URL.revokeObjectURL(url); resolve(); };
    player.onended = done;
    player.onerror = done;
    try { await player.play(); } catch (e) { showError("Playback blocked: " + e.message); done(); }
  });
}

async function safeErr(resp) {
  try { const j = await resp.json(); return j.error || resp.status; } catch { return resp.status; }
}

// ---------- Health check + Test Pipeline ----------------------------------
const SAMPLE_PHRASES = {
  en: "Welcome to our church service. May the grace and peace of God be with you all today.",
  ar: "أهلاً وسهلاً بكم في خدمة كنيستنا. نعمة الرب وسلامه معكم جميعاً اليوم.",
};

async function checkHealth() {
  syscheck.innerHTML = "Running system check…";
  try {
    const r = await fetch("/api/health");
    const h = await r.json();
    const s = h.services || {};
    const mark = (svc, label) =>
      `<span class="${svc?.ok ? "ok" : "bad"}">${svc?.ok ? "✓" : "✗"} ${label}</span>`;
    syscheck.innerHTML =
      `System check: ${h.ok ? '<span class="ok">all good</span>' : '<span class="bad">problems found</span>'} &nbsp; ` +
      `${mark(s.openai, "Whisper key")} &nbsp; ${mark(s.googleTranslate, "Translate")} &nbsp; ${mark(s.elevenlabs, "ElevenLabs voice")}`;
    return h.ok;
  } catch (e) {
    syscheck.innerHTML = `<span class="bad">System check failed: ${e.message}</span>`;
    return false;
  }
}

async function runTestPipeline() {
  if (running) return;
  testBtn.disabled = true;
  startStopBtn.disabled = true;
  showError("");
  try {
    await checkHealth();

    let text = "";
    let source = "en";

    // Full chain: run the bundled spoken sample through Whisper first.
    try {
      const sample = await fetch("/sample-en.mp3");
      if (!sample.ok) throw new Error("bundled sample not found");
      const blob = await sample.blob();
      const fd = new FormData();
      fd.append("audio", blob, "sample-en.mp3");
      fd.append("language", "en");
      const tr = await fetch("/api/transcribe", { method: "POST", body: fd });
      if (!tr.ok) throw new Error(await safeErr(tr));
      text = (await tr.json()).text || "";
      appendLine(sourceBox, "[TEST · Whisper heard] " + (text || "(no speech detected)"));
    } catch (e) {
      // Fallback: skip Whisper, use the written sample phrase (translate + speak only).
      source = inputLang;
      text = SAMPLE_PHRASES[inputLang] || SAMPLE_PHRASES.en;
      appendLine(sourceBox, "[TEST] " + text + "  (Whisper step skipped: " + e.message + ")");
    }
    if (!text) throw new Error("Transcription returned no text");

    // translate -> Russian
    const tl = await fetch("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, source, target: "ru" }),
    });
    if (!tl.ok) throw new Error("Translate failed: " + (await safeErr(tl)));
    const ru = (await tl.json()).text || "";
    if (!ru) throw new Error("Translation returned empty text");
    appendLine(russianBox, "[TEST] " + ru);

    // speak -> play
    setDot(dotAudio, "busy");
    const sp = await fetch("/api/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: ru }),
    });
    if (!sp.ok) throw new Error("Speak failed: " + (await safeErr(sp)));
    await playAudio(await sp.blob());

    syscheck.innerHTML += ' &nbsp; <span class="ok">✓ Full chain OK — Russian audio played</span>';
  } catch (e) {
    showError("Test pipeline: " + e.message);
    setDot(dotAudio, "err");
  } finally {
    testBtn.disabled = false;
    startStopBtn.disabled = false;
    if (!running) setDot(dotAudio, "");
  }
}

testBtn.addEventListener("click", runTestPipeline);

// ---------- Start / Stop --------------------------------------------------
async function start() {
  showError("");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) { showError("Microphone access denied: " + e.message); return; }

  mimeType = pickMimeType();
  await refreshOutputDevices();       // labels now available after permission
  await applySink();

  running = true;
  segCounter = 0;
  startStopBtn.textContent = "Stop";
  startStopBtn.classList.add("recording");
  testBtn.disabled = true;
  setDot(dotMic, "on");
  setDot(dotProc, "on");
  setDot(dotAudio, "on");
  recordSegment();
}

function stop() {
  running = false;
  startStopBtn.textContent = "Start";
  startStopBtn.classList.remove("recording");
  testBtn.disabled = false;
  if (currentRec && currentRec.state !== "inactive") currentRec.stop();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  setDot(dotMic, "");
  setDot(dotProc, "");
  setDot(dotAudio, "");
}

startStopBtn.addEventListener("click", () => (running ? stop() : start()));

// Clock + init
setInterval(() => { el("clock").textContent = new Date().toLocaleTimeString(); }, 1000);
navigator.mediaDevices?.addEventListener?.("devicechange", refreshOutputDevices);
setLangUI();
refreshOutputDevices();
if (!navigator.mediaDevices || !window.MediaRecorder) {
  showError("This browser does not support microphone capture / MediaRecorder. Use Chrome.");
  startStopBtn.disabled = true;
}

// Passive check on load: are the server-side keys configured? (no upstream calls)
fetch("/api/health?quick=1")
  .then((r) => r.json())
  .then((h) => {
    if (!h.ok) {
      const missing = Object.entries(h.env).filter(([, v]) => !v).map(([k]) => k);
      syscheck.innerHTML = `<span class="bad">⚠ Server env vars missing: ${missing.join(", ")}.</span> Set them in Netlify, then click “Test Pipeline”.`;
    } else {
      syscheck.innerHTML = 'Server keys configured. Click <strong>🔎 Test Pipeline</strong> to verify the full chain before a service.';
    }
  })
  .catch(() => { /* health endpoint not reachable in a bare static preview; ignore */ });
