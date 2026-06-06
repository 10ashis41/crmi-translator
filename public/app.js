// CRMI Live Translator — operator client.
// Streams mic audio over WebRTC to the OpenAI Realtime API for live transcription,
// then runs each final transcript through:
//   /api/translate (Google) -> /api/speak (ElevenLabs)
// and plays the Russian audio out the selected output device.
// The OpenAI key never reaches the browser — /api/realtime-token mints a short-lived
// ephemeral token used only for the direct browser->OpenAI WebRTC connection.

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

const el = (id) => document.getElementById(id);
const startStopBtn = el("startStop");
const syscheck = el("syscheck");
const langToggle = el("langToggle");
const inputSelect = el("inputDevice");
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
let inputLang = "en";
let segCounter = 0;

// Realtime WebRTC state
let pc = null;                // RTCPeerConnection to OpenAI
let dc = null;                // "oai-events" data channel (transcription events)
let partialLine = null;       // live (pending) transcript line being filled by deltas
let partialText = "";
let partialTimer = null;      // setTimeout handle for client-side 6 s force-cut
let forcedCut = false;        // true if we force-cut the current utterance at least once

const textQueue = [];         // segments waiting to play (display only)
let workerActive = false;
let playChain = Promise.resolve(); // sequential play chain; fetch runs parallel
let activeSegments = 0;           // segments in-flight (fetching OR playing)
const player = new Audio();   // Russian (ElevenLabs) playback
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
  queueCount.textContent = textQueue.length ? `(${textQueue.length} queued)` : "";
  setDot(dotProc, workerActive ? "busy" : (running ? "on" : ""));
}

// ---------- Input / output devices + volume ------------------------------
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
    // Device labels are only exposed after mic permission has been granted.
    fillDeviceSelect(inputSelect, devices.filter((d) => d.kind === "audioinput"), "Default microphone", "Microphone");
    fillDeviceSelect(outputSelect, devices.filter((d) => d.kind === "audiooutput"), "Default output", "Output");
  } catch (e) { /* labels need permission; ignored until granted */ }
}

// Audio constraints honoring the chosen input device.
function audioConstraints() {
  const c = { channelCount: 1, echoCancellation: true, noiseSuppression: true };
  if (inputSelect.value) c.deviceId = { exact: inputSelect.value };
  return c;
}

// Switch microphone live: swap the track being sent over the existing WebRTC connection.
async function switchInputDevice() {
  if (!running) return;             // not connected yet — applied on next Start
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
    const newTrack = newStream.getAudioTracks()[0];
    const sender = pc?.getSenders().find((s) => s.track && s.track.kind === "audio");
    if (sender && newTrack) await sender.replaceTrack(newTrack);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = newStream;
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
langToggle.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || running) return;        // lock language while running (session is per-language)
  inputLang = btn.dataset.lang;
  setLangUI();
});

// ---------- English-mode transcript filters (synchronous, zero added latency) ----------
// Applied only when inputLang === "en", before any API call is made.

// Common English profanity and letter-substitution variants.
const PROFANITY_RE = /\b(?:f+u+c+k+(?:e[rd]|ing?|s|er)?|sh[i!1]+t+(?:s|t?ing?|ter|ty)?|b[i!1]+tch(?:es?|y|ing?)?|a+s{2,}(?:h[o0]+le|e[sd])?|bastards?|c+u+n+t+s?|c[o0]+c+k+(?:s|sucker)?|d[i!1]+c+k+s?|p+u+s{2,}(?:y|ie[sd])?|p[i!1]+ss(?:e[sd]|ing?)?|wh?[o0]+re+s?|sl+u+t+s?|nig+(?:e[rh]|as?|ers?)|bullshit|mother\s?f+u+c+k(?:e[rd]|ing?|er)?|jack\s?ass|dip\s?shit|douche\s?bag)\b/i;

// Romanized Arabic words that sound like / get mistranscribed as English profanity.
// fak (فك = open/undo), nik/naak (Arabic obscene verb forms), zib/zibb (زب, Arabic obscene),
// kuss/kus (كس, Arabic obscene), sharmuta/sharmouta (شرموطة, Arabic slur),
// manyak (مانياك, Turkish/Arabic slur), ibn el + expletive (ابن ال…).
const ARABIC_PHONEME_RE = /\b(?:fa+k+|f[ae]+kk?|ni+k+|na+a+k+|zi+bb?|ku+ss?|khu+ss?|sharmou?ta?|manyak|ibn\s+(?:el\s+)?(?:kalb|sharmou?ta?|zibb?|ku+ss?))\b/i;

// Returns true if the transcript should be silently dropped (English mode only).
// allowShort: skip the word-count check for force-cut tails that are part of longer speech.
function shouldDropTranscript(text, allowShort = false) {
  // 1. Minimum length: require at least 3 words to avoid single-word noise transcriptions.
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!allowShort && words.length < 3) return true;

  // 2. Non-Latin character check: drop if any character falls outside Basic Latin +
  //    Latin Supplement (U+0000-U+00FF), Latin Extended A/B (U+0100-U+024F),
  //    or Latin Extended Additional (U+1E00-U+1EFF). Arabic/CJK/etc. script in a
  //    transcript means the audio was non-English — drop silently.
  if (/[^\u0000-\u024F\u1E00-\u1EFF\s.,!?;:'"()\-\d]/.test(text)) return true;

  // 3. Profanity / Arabic false-positive check.
  if (PROFANITY_RE.test(text) || ARABIC_PHONEME_RE.test(text)) return true;

  return false;
}

// ---------- OpenAI Realtime (WebRTC) streaming transcription --------------
// Open a direct browser->OpenAI WebRTC connection: send the mic track, receive
// streaming transcription events on the "oai-events" data channel.
async function connectRealtime() {
  // 1) Mint a short-lived ephemeral token on our server (real key stays server-side).
  const tokenResp = await fetch("/api/realtime-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language: inputLang }),
  });
  if (!tokenResp.ok) {
    let detail = String(tokenResp.status);
    try {
      const errBody = await tokenResp.json();
      detail = errBody.error || detail;
      if (errBody.openai_status) detail += ` (OpenAI ${errBody.openai_status})`;
      if (errBody.openai_error) detail += " — " + JSON.stringify(errBody.openai_error);
      if (errBody.sent_config) console.error("[realtime-token] sent_config:", JSON.stringify(errBody.sent_config, null, 2));
    } catch { /* raw non-JSON from server */ }
    throw new Error("Realtime token failed: " + detail);
  }
  const tokenData = await tokenResp.json();
  const ephemeralKey = tokenData.value;
  if (!ephemeralKey) throw new Error("no ephemeral token returned — server response: " + JSON.stringify(tokenData).slice(0, 300));

  // 2) Peer connection + the mic track to stream up.
  pc = new RTCPeerConnection();
  pc.oniceconnectionstatechange = () => {
    if (!pc) return;
    if (["failed", "disconnected"].includes(pc.iceConnectionState) && running) {
      showError("Live transcription connection lost — click Stop then Start to reconnect.");
    }
  };
  stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));

  // 3) Data channel carries the transcription events.
  dc = pc.createDataChannel("oai-events");
  dc.onmessage = (e) => { try { onRealtimeEvent(JSON.parse(e.data)); } catch (err) { /* ignore non-JSON */ } };
  dc.onopen = () => { if (running) setDot(dotMic, "on"); };

  // 4) SDP offer -> OpenAI -> answer.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdpResp = await fetch(REALTIME_CALLS_URL, {
    method: "POST",
    body: offer.sdp,
    headers: { Authorization: `Bearer ${ephemeralKey}`, "Content-Type": "application/sdp" },
  });
  if (!sdpResp.ok) throw new Error("SDP exchange failed: " + sdpResp.status + " " + (await sdpResp.text()).slice(0, 200));
  await pc.setRemoteDescription({ type: "answer", sdp: await sdpResp.text() });
}

// Handle one event from the data channel.
function onRealtimeEvent(evt) {
  switch (evt.type) {
    case "conversation.item.input_audio_transcription.delta": {
      // Incremental partial — show it live in a pending line.
      partialText += evt.delta || "";
      if (!partialLine) {
        partialLine = appendLine(sourceBox, "", "pending");
        startPartialTimer();   // begin 6-second client-side force-cut countdown
      }
      partialLine.textContent = partialText;
      sourceBox.scrollTop = sourceBox.scrollHeight;
      break;
    }
    case "conversation.item.input_audio_transcription.completed": {
      clearPartialTimer();
      const wasForcedCut = forcedCut;
      forcedCut = false;
      // If we force-cut, partialText holds only the tail after the last cut point.
      // Use that tail rather than the full utterance transcript (which we already queued).
      // If no force-cut, use the authoritative full transcript from OpenAI.
      const text = (wasForcedCut ? partialText : (evt.transcript || partialText || "")).trim();
      partialText = "";
      const drop = !text || (inputLang === "en" && shouldDropTranscript(text, wasForcedCut));
      if (partialLine) {
        if (drop) {
          partialLine.remove();
        } else {
          partialLine.textContent = text;
          partialLine.classList.remove("pending");
        }
        partialLine = null;
      } else if (!drop && text) {
        appendLine(sourceBox, text);
      }
      if (!drop) { showError(""); enqueueTranscript(text); }
      break;
    }
    case "error":
      showError("Realtime: " + (evt.error?.message || JSON.stringify(evt.error || evt)));
      break;
  }
}

// ---------- Client-side 6-second force-cut for long continuous speech --------
// The OpenAI Realtime transcription API has no max-segment-duration parameter.
// If speech continues unbroken for 6 s we force a cut ourselves so the pipeline
// never stalls on a single giant utterance.

function startPartialTimer() {
  if (partialTimer) return;
  partialTimer = setTimeout(forceSegmentCut, 6000);
}

function clearPartialTimer() {
  if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
}

function forceSegmentCut() {
  partialTimer = null;
  const cutText = partialText.trim();
  // Only cut if we have at least 3 words — fewer likely means we just started.
  if (cutText.split(/\s+/).filter(Boolean).length < 3) {
    partialTimer = setTimeout(forceSegmentCut, 6000);  // wait another 6 s
    return;
  }
  // Commit what we have to the translate→speak pipeline.
  if (!(inputLang === "en" && shouldDropTranscript(cutText))) {
    showError("");
    enqueueTranscript(cutText);
  }
  // Seal the current display line; subsequent deltas will open a fresh one.
  if (partialLine) { partialLine.classList.remove("pending"); partialLine = null; }
  partialText = "";   // reset accumulator; tail deltas go into the fresh partial
  forcedCut = true;
  // Restart timer in case speech continues past this cut.
  partialTimer = setTimeout(forceSegmentCut, 6000);
}

// ---------- Parallel pipeline: fetch immediately, play sequentially ----------
// When segment N is enqueued its translate→speak fetch starts immediately.
// Playback is strictly sequential — each segment waits only for the previous
// segment to finish playing, never for its own fetch to start.
// No segments are ever dropped.

function enqueueTranscript(text) {
  const id = ++segCounter;
  activeSegments++;
  workerActive = true;
  textQueue.push({ id, text });    // shown in queue-counter UI until play starts
  updateQueueUI();

  // FETCH lane: start translate→speak right now, parallel with current playback.
  const fetchPromise = fetchTranslateSpeak(text).catch((e) => {
    showError(e.message);
    return null;
  });

  // PLAY lane: append to the sequential play chain — will run after all prior segments.
  playChain = playChain
    .then(async () => {
      // Remove from visible queue when this segment's turn arrives.
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

  // 2) Speak (Russian) -> MP3 blob (ElevenLabs, 1.3× speed set server-side)
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
    const done = () => { setDot(dotAudio, running ? "on" : ""); player.onended = player.onerror = null; URL.revokeObjectURL(url); resolve(); };
    player.onended = done;
    player.onerror = done;
    try { await player.play(); } catch (e) { showError("Playback blocked: " + e.message); done(); }
  });
}

async function safeErr(resp) {
  try { const j = await resp.json(); return j.error || resp.status; } catch { return resp.status; }
}

// ---------- Start / Stop --------------------------------------------------
async function start() {
  showError("");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
  } catch (e) { showError("Microphone access denied: " + e.message); return; }

  await refreshDevices();             // labels now available after permission
  await applySink();

  running = true;
  segCounter = 0;
  startStopBtn.textContent = "Stop";
  startStopBtn.classList.add("recording");
  setDot(dotMic, "busy");             // connecting…
  setDot(dotProc, "on");
  setDot(dotAudio, "on");

  try {
    await connectRealtime();
    setDot(dotMic, "on");
  } catch (e) {
    showError("Could not start live transcription: " + e.message);
    stop();
  }
}

function stop() {
  running = false;
  startStopBtn.textContent = "Start";
  startStopBtn.classList.remove("recording");
  if (dc) { try { dc.close(); } catch (e) {} dc = null; }
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  partialLine = null;
  partialText = "";
  clearPartialTimer();
  forcedCut = false;
  // Reset parallel pipeline state.
  playChain = Promise.resolve();
  activeSegments = 0;
  textQueue.length = 0;
  workerActive = false;
  try { player.pause(); player.src = ""; } catch (e) {}
  setDot(dotMic, "");
  setDot(dotProc, "");
  setDot(dotAudio, "");
}

startStopBtn.addEventListener("click", () => (running ? stop() : start()));

// Clock + init
setInterval(() => { el("clock").textContent = new Date().toLocaleTimeString(); }, 1000);
navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
setLangUI();
refreshDevices();
if (!navigator.mediaDevices || !window.RTCPeerConnection) {
  showError("This browser does not support microphone capture / WebRTC. Use Chrome.");
  startStopBtn.disabled = true;
}

// Passive check on load: are the server-side keys configured? (no upstream calls)
fetch("/api/health?quick=1")
  .then((r) => r.json())
  .then((h) => {
    if (!h.ok) {
      const missing = Object.entries(h.env).filter(([, v]) => !v).map(([k]) => k);
      syscheck.innerHTML = `<span class="bad">⚠ Server env vars missing: ${missing.join(", ")}.</span> Set them in Netlify and redeploy.`;
    } else {
      syscheck.innerHTML = '<span class="ok">✓ Server keys configured.</span> Click <strong>Start</strong> to begin live translation.';
    }
  })
  .catch(() => { /* health endpoint not reachable in a bare static preview; ignore */ });
