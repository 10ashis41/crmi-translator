// CRMI Live Translator — operator client.
// Streams mic audio over a Deepgram Nova-3 WebSocket connection for live STT,
// then runs each final transcript through:
//   /api/translate (Google) -> /api/speak (ElevenLabs)
// and plays the Russian audio out the selected output device.
//
// One WebSocket per session.  The connection stays open for the entire session;
// multiple utterances arrive on the same socket without reconnecting.
// Translate+speak fires on speech_final (natural sentence boundary) or is_final
// (300 ms VAD silence) — whichever comes first — so the pipeline never waits for
// the speaker to pause.  Exact-text deduplication prevents double-processing when
// both events carry the same transcript.
//
// DEEPGRAM_API_KEY never reaches the browser — /api/deepgram-token mints a
// short-lived (10 s) key used only to open the WebSocket handshake.

const el = (id) => document.getElementById(id);
const startStopBtn = el("startStop");
const syscheck     = el("syscheck");
const inputSelect  = el("inputDevice");
const outputSelect = el("outputDevice");
const volume       = el("volume");
const volVal       = el("volVal");
const sourceBox    = el("source");
const russianBox   = el("russian");
const sourceLabel  = el("sourceLabel");
const errorBox     = el("error");
const dotMic       = el("dotMic");
const dotProc      = el("dotProc");
const dotAudio     = el("dotAudio");
const queueCount   = el("queueCount");
const muteBtn      = el("muteBtn");
const connStatus   = el("connStatus");

let running    = false;
let stream     = null;
let inputLang  = "en";
let segCounter = 0;

// Deepgram streaming state — one socket + one recorder per session.
let dgSocket      = null;   // WebSocket to Deepgram
let mediaRecorder = null;   // feeds mic audio to dgSocket

// ---------- Resilience: KeepAlive, auto-reconnect, proactive refresh, mute ----
// Deepgram closes an idle socket after 10 s (NET-0001) and has practical limits
// on a single connection's lifetime.  We keep the socket warm with KeepAlive
// frames, reconnect automatically on any drop (buffering audio so no words are
// lost), and proactively refresh the connection before the ~60-minute hard limit.
const KEEPALIVE_MS       = 5000;            // KeepAlive text frame cadence (< 10 s timeout)
const SESSION_REFRESH_MS = 55 * 60 * 1000;  // proactive reconnect before 60-min hard limit
const MAX_BUFFER_CHUNKS  = 600;             // ~60 s of 100 ms audio slices kept during a drop

let keepAliveTimer   = null;   // setInterval: sends {"type":"KeepAlive"} frames
let refreshTimer     = null;   // setTimeout: fires the 55-min proactive reconnect
let reconnecting     = false;  // true while an auto/proactive reconnect is in flight
let reconnectAttempts = 0;     // backoff counter for retry delays
let intentionalClose = false;  // suppresses auto-reconnect on operator-initiated stop
let muted            = false;  // Mute: pause audio to Deepgram, keep socket alive
let headerChunk      = null;   // first webm chunk from the recorder (container init segment)
let audioBuffer      = [];     // audio slices captured while the socket is down

// Pending transcript state (interim Deepgram results shown live).
let partialLine        = null;   // live DOM element updated by interim events
let partialText        = "";     // current interim text
let lastCommittedText  = "";     // dedup: skip is_final when speech_final already committed it

// Translate->speak pipeline state.
const textQueue = [];                   // segments queued to play (display counter)
let workerActive = false;
let playChain = Promise.resolve();      // sequential play chain; fetch runs in parallel
let activeSegments = 0;                 // segments in-flight (fetching OR playing)
const player = new Audio();
player.autoplay = false;

// ---------- UI helpers -------------------------------------------------------
function setDot(dot, state) { dot.className = "dot" + (state ? " " + state : ""); }
function showError(msg) { errorBox.textContent = msg || ""; if (msg) setDot(dotMic, "err"); }
function setLangUI() {
  sourceLabel.textContent = "English transcript";
  sourceBox.classList.remove("rtl");
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
  queueCount.textContent = textQueue.length ? `(${textQueue.length} queued)` : "";
  setDot(dotProc, workerActive ? "busy" : (running ? "on" : ""));
}

// ---------- Input / output devices + volume ----------------------------------
function fillDeviceSelect(sel, devices, defaultLabel, fallbackPrefix) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${defaultLabel}</option>`;
  devices.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `${fallbackPrefix} ${i + 1}`;
    sel.appendChild(o);
  });
  if (cur) sel.value = cur;
}
async function refreshDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fillDeviceSelect(inputSelect,  devices.filter((d) => d.kind === "audioinput"),  "Default microphone", "Microphone");
    fillDeviceSelect(outputSelect, devices.filter((d) => d.kind === "audiooutput"), "Default output",      "Output");
  } catch (e) { /* labels unavailable until permission granted */ }
}
function audioConstraints() {
  const c = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (inputSelect.value) c.deviceId = { exact: inputSelect.value };
  return c;
}

// Switch microphone live: stop the current recorder and start a new one on the
// new stream.  The Deepgram WebSocket stays open — no reconnect needed.
async function switchInputDevice() {
  if (!running) return;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
      mediaRecorder = null;
    }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = newStream;
    startMediaRecorder();
    showError("");
  } catch (e) { showError("Could not switch microphone: " + e.message); }
}
inputSelect.addEventListener("change", switchInputDevice);

async function applySink(audio = player) {
  const id = outputSelect.value;
  if (typeof audio.setSinkId === "function" && id) {
    try { await audio.setSinkId(id); }
    catch (e) { showError("Could not switch output device: " + e.message); }
  }
}
outputSelect.addEventListener("change", applySink);
volume.addEventListener("input", () => {
  player.volume = parseFloat(volume.value);
  volVal.textContent = Math.round(player.volume * 100) + "%";
});

// ---------- Mute -------------------------------------------------------------
// Pause audio to Deepgram (e.g. when Arabic singing starts) without dropping the
// connection — KeepAlive frames hold the socket open so resuming is instant.
function updateMuteUI() {
  if (muteBtn) {
    muteBtn.textContent = muted ? "🔇 Unmute" : "🔊 Mute";
    muteBtn.classList.toggle("muted", muted);
    muteBtn.disabled = !running;
  }
  if (running) {
    const live = dgSocket && dgSocket.readyState === WebSocket.OPEN;
    setDot(dotMic, muted ? "busy" : (live ? "on" : "busy"));
  }
}
function toggleMute() {
  if (!running) return;
  muted = !muted;
  if (muted) audioBuffer = [];   // discard anything captured while toggling
  showError(muted ? "Muted — audio paused (connection kept alive)." : "");
  updateMuteUI();
}
if (muteBtn) muteBtn.addEventListener("click", toggleMute);

// ---------- Transcript filters -----------------------------------------------
// Applied to every Deepgram final before the translate->speak pipeline.
// All checks are synchronous — zero added latency.

// Common English profanity (whole-word, case-insensitive).
const PROFANITY_RE = /\b(?:f+u+c+k+(?:e[rd]|ing?|s|er)?|sh[i!1]+t+(?:s|t?ing?|ter|ty)?|b[i!1]+tch(?:es?|y|ing?)?|a+s{2,}(?:h[o0]+le|e[sd])?|bastards?|c+u+n+t+s?|c[o0]+c+k+(?:s|sucker)?|d[i!1]+c+k+s?|p+u+s{2,}(?:y|ie[sd])?|p[i!1]+ss(?:e[sd]|ing?)?|wh?[o0]+re+s?|sl+u+t+s?|nig+(?:e[rh]|as?|ers?)|bullshit|mother\s?f+u+c+k(?:e[rd]|ing?|er)?|jack\s?ass|dip\s?shit|douche\s?bag)\b/i;

// Arabic words that English STT engines frequently romanise as profanity-sounding
// English. Whole-word, case-insensitive. Drop the entire segment if any match.
// Covers: fak/fakh (unlock), nik/naak (obscene verb), zib/zibb, kus/kess/khus,
// sharmuta/sharmouta/sharmoota, manyak, weld/ibn el [expletive], air/ayr, teez.
const ARABIC_PHONEME_RE = /\b(?:fa+k+|f[ae]+kk?|ni+k+|na+a+k+|zi+bb?|ku+ss?|ke+ss?|khu+ss?|sharmou?ta?|sharmoota|manyak|ibn\s+(?:el\s+)?(?:kalb|sharmou?ta?|sharmoota|zibb?|ku+ss?|ke+ss?)|weld\s+(?:el\s+)?sharmou?ta?|ai+r|ay+r|te+ez?)\b/i;

// Latin-script characters: Basic Latin + Latin Supplement (U+0000-U+024F)
// and Latin Extended Additional (U+1E00-U+1EFF).
const LATIN_ONLY_RE = /[^ -ɏḀ-ỿ\s.,!?;:'"()\-\d]/;

// Arabic-script characters across the main Unicode blocks.
const HAS_ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

// Minimum Deepgram confidence score accepted in Arabic mode.
// Real Arabic speech scores ~0.8–0.99; English force-fitted into the Arabic
// model scores ~0.3–0.6, so 0.7 reliably drops English without cutting real Arabic.
const ARABIC_CONFIDENCE_MIN = 0.7;

// Returns true if this transcript should be silently dropped (no translate/speak/display).
function shouldDropTranscript(text, confidence = 1) {
  if (!text) return true;

  if (inputLang === "en") {
    // 1. Minimum length — reject single-word noise bursts.
    if (text.trim().split(/\s+/).filter(Boolean).length < 3) return true;

    // 2. Script lock — English mode must be Latin-only. Any non-Latin character
    //    (Arabic, Cyrillic, CJK…) means Deepgram drifted; drop the segment.
    if (LATIN_ONLY_RE.test(text)) return true;

    // 3. Profanity — common English swear words (whole-word match).
    if (PROFANITY_RE.test(text)) return true;

    // 4. Arabic-phoneme false positives — Arabic words that English STT engines
    //    romanise into English-looking text that resembles profanity.
    if (ARABIC_PHONEME_RE.test(text)) return true;
  }

  if (inputLang === "ar") {
    // Script lock — must contain at least one Arabic-script character.
    if (!HAS_ARABIC_RE.test(text)) return true;

    // Confidence gate — drops English speech that Deepgram force-fits into Arabic.
    if (confidence < ARABIC_CONFIDENCE_MIN) return true;
  }

  return false;
}

// ---------- Deepgram WebSocket streaming transcription -----------------------
// One persistent WebSocket per session.  Deepgram's server-VAD and endpointing
// (1 second of silence) determine utterance boundaries and emit final results
// automatically.

function startMediaRecorder() {
  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    .find((t) => MediaRecorder.isTypeSupported(t)) || "";
  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  headerChunk = null;   // a new recorder produces a new container header
  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    // The first slice carries the webm/EBML init segment. Keep it so a fresh
    // socket (after a reconnect) can be primed to decode mid-stream audio.
    if (!headerChunk) headerChunk = e.data;
    if (muted) return;                                 // Mute: drop audio, keep socket warm via KeepAlive
    if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(e.data);
    } else if (running) {
      // Socket is down (reconnecting) — buffer audio so no words are lost.
      audioBuffer.push(e.data);
      if (audioBuffer.length > MAX_BUFFER_CHUNKS) audioBuffer.shift();
    }
  };
  mediaRecorder.onerror = (e) => showError("Recorder: " + (e.error?.message || String(e)));
  mediaRecorder.start(100);   // 100 ms slices -> low-latency continuous stream
}

// Send {"type":"KeepAlive"} text frames so Deepgram never hits its 10 s idle
// timeout — essential while muted (no audio flows) and harmless during speech.
function startKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
      try { dgSocket.send(JSON.stringify({ type: "KeepAlive" })); } catch (e) {}
    }
  }, KEEPALIVE_MS);
}

// Proactively reconnect before Deepgram's ~60-minute hard limit forcibly closes
// the socket mid-service. Runs the same seamless reconnect path as a dropped link.
function scheduleSessionRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (running) triggerReconnect("proactive 55-min refresh");
  }, SESSION_REFRESH_MS);
}

// Show/hide the brief "Reconnecting…" status for the operator.
function showReconnecting(on, detail) {
  if (!connStatus) return;
  connStatus.textContent = on ? `⟳ Reconnecting…${detail ? " (" + detail + ")" : ""}` : "";
  connStatus.style.display = on ? "" : "none";
  if (on) setDot(dotMic, "busy");
}

// Tear down the current socket and open a fresh one without disturbing the mic
// recorder or the translate->speak pipeline. Used for both unexpected drops and
// the proactive 55-min refresh. Audio captured during the gap is replayed.
function triggerReconnect(reason) {
  if (reconnecting || !running) return;
  reconnecting = true;
  reconnectAttempts = 0;
  clearInterval(keepAliveTimer);
  clearTimeout(refreshTimer);
  showReconnecting(true, reason);
  if (dgSocket) {
    // Detach handlers so the imminent close doesn't recurse into another reconnect.
    try { dgSocket.onopen = dgSocket.onmessage = dgSocket.onerror = dgSocket.onclose = null; } catch (e) {}
    try { if (dgSocket.readyState <= WebSocket.OPEN) dgSocket.close(1000, "reconnect"); } catch (e) {}
    dgSocket = null;
  }
  reconnectLoop();
}

async function reconnectLoop() {
  if (!running) { reconnecting = false; return; }
  try {
    await openDeepgramSocket();   // resolves on open; replays header + buffered audio
    reconnecting = false;
    reconnectAttempts = 0;
    showReconnecting(false);
    showError("");
  } catch (e) {
    reconnectAttempts++;
    const delay = Math.min(5000, 250 * reconnectAttempts);   // first retry near-immediate, then back off
    showReconnecting(true, `retry ${reconnectAttempts}`);
    setTimeout(() => { running ? reconnectLoop() : (reconnecting = false); }, delay);
  }
}

// Establish the first connection for a session, then hand off to the resilient
// socket layer (openDeepgramSocket) for KeepAlive / auto-reconnect / refresh.
async function connectDeepgram() {
  intentionalClose = false;
  reconnecting     = false;
  reconnectAttempts = 0;
  audioBuffer      = [];
  headerChunk      = null;
  await openDeepgramSocket();
}

async function openDeepgramSocket() {
  // 1) Mint a short-lived Deepgram key server-side.
  const tokenResp = await fetch("/api/deepgram-token", { method: "POST" });
  if (!tokenResp.ok) {
    let detail = String(tokenResp.status);
    try {
      const errBody = await tokenResp.json();
      detail = errBody.error || detail;
      if (errBody.detail) detail += " -- " + errBody.detail;
    } catch { /* raw non-JSON */ }
    throw new Error("Deepgram token failed: " + detail);
  }
  const tokenData = await tokenResp.json();
  const key = tokenData.key;
  if (!key) throw new Error("No key in token response: " + JSON.stringify(tokenData).slice(0, 200));

  // 2) Open WebSocket to Deepgram Nova-3 (native streaming model).
  //    model=nova-3           — end-to-end streaming model; far better real-time
  //                             accuracy than whisper-large which runs batch internally.
  //    detect_language=false  — locks to Arabic; prevents mid-session drift.
  //    smart_format=true      — automatic punctuation, capitalisation, numerals.
  //    interim_results=true   — streams live updates while speech is in progress.
  //    endpointing=300        — minimum VAD silence (ms) before a forced is_final.
  //    utterance_end_ms=1500  — UtteranceEnd backstop if VAD misses a boundary.
  //    speech_final handled in onDeepgramMessage — fires without a silence gap.
  const params = new URLSearchParams({
    model:              "nova-3",
    language:           "en",
    detect_language:    "false",
    smart_format:       "true",
    interim_results:    "true",
    endpointing:        "300",
    utterance_end_ms:   "1500",
  });
  dgSocket = new WebSocket(
    `wss://api.deepgram.com/v1/listen?${params}`,
    ["token", key],
  );

  return new Promise((resolve, reject) => {
    const connTimeout = setTimeout(
      () => reject(new Error("Deepgram WebSocket connection timed out after 10 s")),
      10000,
    );

    dgSocket.onopen = () => {
      clearTimeout(connTimeout);
      setDot(dotMic, muted ? "busy" : "on");
      try {
        // 3) Start the recorder on first connect; on a reconnect it is already
        //    running, so reuse it and replay the container header + buffered audio
        //    so the new socket can decode mid-stream and no words are lost.
        if (!mediaRecorder || mediaRecorder.state === "inactive") {
          startMediaRecorder();
        } else if (!muted) {
          if (headerChunk) { try { dgSocket.send(headerChunk); } catch (e) {} }
          for (const chunk of audioBuffer) { try { dgSocket.send(chunk); } catch (e) {} }
        }
        audioBuffer = [];
        startKeepAlive();
        scheduleSessionRefresh();
        resolve();
      } catch (e) {
        reject(e);
      }
    };

    dgSocket.onmessage = (e) => onDeepgramMessage(e);

    dgSocket.onerror = () => {
      clearTimeout(connTimeout);
      // onerror is always followed by onclose — let onclose handle reconnection.
      reject(new Error("Deepgram WebSocket connection failed (see console for details)"));
    };

    dgSocket.onclose = (ev) => {
      clearTimeout(connTimeout);
      clearInterval(keepAliveTimer);
      if (intentionalClose) { intentionalClose = false; return; }   // operator pressed Stop
      if (!running || reconnecting) return;                          // already handled
      // Unexpected drop — reconnect immediately, buffering audio until restored.
      triggerReconnect(`connection lost (code ${ev.code})`);
    };
  });
}

// Handle messages from the persistent Deepgram WebSocket.
// Multiple interim->final cycles arrive here over the session's lifetime.
//
// Firing order (per utterance):
//   interim  (is_final=false, speech_final=false) — live display only
//   speech_final (speech_final=true)              — natural sentence boundary → pipeline
//   is_final (is_final=true)                      — VAD/endpointing → pipeline if not dup
//   UtteranceEnd                                  — backstop if neither fired yet
function onDeepgramMessage(e) {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }

  if (msg.type === "Error") {
    showError("Deepgram error: " + (msg.description || msg.message || JSON.stringify(msg)));
    return;
  }

  // UtteranceEnd: fires after utterance_end_ms of audio silence if a partial is
  // still pending (speech_final and is_final haven't fired yet).
  if (msg.type === "UtteranceEnd") {
    if (partialText && partialText !== lastCommittedText) {
      flushPartial(partialText);
    }
    return;
  }

  if (msg.type !== "Results") return;   // Metadata, SpeechStarted, etc. — ignore

  const alt = msg.channel?.alternatives?.[0];
  if (!alt) return;
  const transcript = (alt.transcript || "").trim();
  const confidence = alt.confidence ?? 1;

  const isFinal     = !!msg.is_final;
  const speechFinal = !!msg.speech_final;

  if (!isFinal && !speechFinal) {
    // Pure interim — update the live pending line; no pipeline action.
    if (!transcript) return;
    if (!partialLine) partialLine = appendLine(sourceBox, "", "pending");
    partialText = transcript;
    partialLine.textContent = transcript;
    sourceBox.scrollTop = sourceBox.scrollHeight;
    return;
  }

  // speech_final fires on a natural sentence/clause boundary (no silence required).
  // is_final fires on VAD silence (endpointing).  Both can arrive together.
  // Dedup: if is_final carries the exact text we already committed via speech_final,
  // discard it — the speaker stopped after the sentence boundary.
  // Empty final: silence boundary detected but no speech transcribed.
  // Clear partialText without erasing the pending line — it belongs to
  // the next utterance already streaming in from Deepgram.
  if (!transcript) { partialText = ""; return; }

  if (transcript === lastCommittedText) {
    partialText = "";
    if (partialLine) { partialLine.remove(); partialLine = null; }
    return;
  }

  flushPartial(transcript, confidence);
}

// Commit a transcript: update display, run language/profanity checks, enqueue pipeline.
function flushPartial(transcript, confidence = 1) {
  partialText = "";
  const drop = shouldDropTranscript(transcript, confidence);
  if (partialLine) {
    if (drop) { partialLine.remove(); }
    else { partialLine.textContent = transcript; partialLine.classList.remove("pending"); }
    partialLine = null;
  } else if (!drop && transcript) {
    appendLine(sourceBox, transcript);
  }
  if (!drop && transcript) {
    lastCommittedText = transcript;
    showError("");
    enqueueTranscript(transcript);
  }
}

// ---------- Parallel pipeline: fetch immediately, play sequentially ----------
// The moment a transcript is committed, translate->speak starts immediately
// (FETCH lane) in parallel with ongoing transcription and playback.
// Playback (PLAY lane) is strictly sequential via the promise chain.

function enqueueTranscript(text) {
  const id = ++segCounter;
  activeSegments++;
  workerActive = true;
  textQueue.push({ id, text });
  updateQueueUI();

  // FETCH lane: fire-and-forget, runs parallel with current playback.
  const fetchPromise = fetchTranslateSpeak(text).catch((e) => { showError(e.message); return null; });

  // PLAY lane: each segment waits only for the previous to finish playing.
  playChain = playChain
    .then(async () => {
      const idx = textQueue.findIndex((t) => t.id === id);
      if (idx !== -1) textQueue.splice(idx, 1);
      updateQueueUI();
      const blob = await fetchPromise;
      if (blob && running) await playAudio(blob);
    })
    .catch((e) => showError(e.message))
    .finally(() => {
      activeSegments--;
      if (activeSegments === 0) { workerActive = false; updateQueueUI(); }
    });
}

async function fetchTranslateSpeak(text) {
  // 1) Translate -> Russian
  const tl = await fetch("/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, source: inputLang, target: "ru" }),
  });
  if (!tl.ok) throw new Error("Translate failed: " + (await safeErr(tl)));
  const ru = (await tl.json()).text || "";
  if (!ru) return null;
  appendLine(russianBox, ru);

  // 2) Speak -> Russian MP3 (ElevenLabs, 1.3x speed set server-side)
  const sp = await fetch("/api/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: ru }),
  });
  if (!sp.ok) throw new Error("Speak failed: " + (await safeErr(sp)));
  return sp.blob();
}

function playAudio(blob) {
  return new Promise(async (resolve) => {
    const url = URL.createObjectURL(blob);
    player.src = url;
    player.volume = parseFloat(volume.value);
    await applySink();
    setDot(dotAudio, "busy");
    const done = () => {
      setDot(dotAudio, running ? "on" : "");
      player.onended = player.onerror = null;
      URL.revokeObjectURL(url);
      resolve();
    };
    player.onended = done;
    player.onerror = done;
    try { await player.play(); } catch (e) { showError("Playback blocked: " + e.message); done(); }
  });
}

async function safeErr(resp) {
  try {
    const j = await resp.json();
    const base = j.error || `HTTP ${resp.status}`;
    return j.detail ? `${base} — ${String(j.detail).slice(0, 120)}` : base;
  } catch { return `HTTP ${resp.status}`; }
}

// ---------- Start / Stop -----------------------------------------------------
async function start() {
  showError("");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
  } catch (e) { showError("Microphone access denied: " + e.message); return; }

  await refreshDevices();
  await applySink();

  running     = true;
  segCounter  = 0;
  muted       = false;
  startStopBtn.textContent = "Stop";
  startStopBtn.classList.add("recording");
  setDot(dotMic,   "busy");    // "connecting..."
  setDot(dotProc,  "on");
  setDot(dotAudio, "on");
  updateMuteUI();

  try {
    await connectDeepgram();
    // connectDeepgram() resolves once the WebSocket is open and MediaRecorder
    // has started.  The session is now live; onDeepgramMessage() handles all
    // subsequent events for the lifetime of the session.
  } catch (e) {
    showError("Could not start transcription: " + e.message);
    stop();
  }
}

function stop() {
  running          = false;
  intentionalClose = true;    // suppress auto-reconnect for this deliberate close
  reconnecting     = false;
  muted            = false;

  // Halt the resilience timers (KeepAlive + proactive refresh).
  clearInterval(keepAliveTimer); keepAliveTimer = null;
  clearTimeout(refreshTimer);    refreshTimer   = null;

  // Stop audio capture first so no more data is sent to the socket.
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (e) {}
  }
  mediaRecorder = null;

  // Close the Deepgram WebSocket cleanly (1000 = normal closure).
  if (dgSocket) {
    try {
      if (dgSocket.readyState <= WebSocket.OPEN) dgSocket.close(1000, "session ended");
    } catch (e) {}
    dgSocket = null;
  }

  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  partialLine       = null;
  partialText       = "";
  lastCommittedText = "";
  headerChunk       = null;
  audioBuffer       = [];

  // Reset pipeline.
  playChain      = Promise.resolve();
  activeSegments = 0;
  textQueue.length = 0;
  workerActive   = false;

  startStopBtn.textContent = "Start";
  startStopBtn.classList.remove("recording");
  try { player.pause(); player.src = ""; } catch (e) {}
  showReconnecting(false);
  updateMuteUI();
  setDot(dotMic,   "");
  setDot(dotProc,  "");
  setDot(dotAudio, "");
}

startStopBtn.addEventListener("click", () => (running ? stop() : start()));

// Clock + init
setInterval(() => { el("clock").textContent = new Date().toLocaleTimeString(); }, 1000);
navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
setLangUI();
refreshDevices();
if (!navigator.mediaDevices || !window.MediaRecorder || !window.WebSocket) {
  showError("This browser does not support mic capture / WebSocket. Use Chrome.");
  startStopBtn.disabled = true;
}

// Passive health check on load -- verifies server env vars are configured.
fetch("/api/health?quick=1")
  .then((r) => r.json())
  .then((h) => {
    if (!h.ok) {
      const missing = Object.entries(h.env).filter(([, v]) => !v).map(([k]) => k);
      syscheck.innerHTML = `<span class="bad">&#9888; Server env vars missing: ${missing.join(", ")}.</span> Set them in Netlify and redeploy.`;
    } else {
      syscheck.innerHTML = '<span class="ok">&#10003; Server keys configured.</span> Click <strong>Start</strong> to begin live translation.';
    }
  })
  .catch(() => { /* health endpoint unreachable in a bare static preview */ });
