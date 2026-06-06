// POST /api/realtime-token   Body (optional): { language: "en" | "ar" }
// GET  /api/realtime-token?language=en
//
// Mints a short-lived ephemeral client secret for an OpenAI Realtime *transcription*
// session. The browser uses the returned token to open a WebRTC connection directly to
// OpenAI for streaming transcription — the real OPENAI_API_KEY never reaches the client.
//
// Endpoint: POST https://api.openai.com/v1/realtime/client_secrets
// Response shape: { value: "ek_...", expires_at, session: { ... } }
//   – token is at top-level "value" (NOT nested under client_secret.value).
//
// Returns to browser: { value, expires_at, model }

const OPENAI_URL = "https://api.openai.com/v1/realtime/client_secrets";
const TRANSCRIBE_MODEL = process.env.REALTIME_TRANSCRIBE_MODEL || "gpt-4o-transcribe";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "Use POST" }, 405);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json({ error: "OPENAI_API_KEY is not configured on the server" }, 500);

  // Optional spoken-language hint ("en"/"ar"); anything else -> let the model auto-detect.
  let language = "";
  if (req.method === "POST") {
    try { language = ((await req.json()).language || "").toString().toLowerCase(); } catch { /* no body */ }
  } else {
    language = (new URL(req.url).searchParams.get("language") || "").toLowerCase();
  }

  // Only the fields documented by the Realtime transcription_sessions schema are sent.
  // No extra fields (prompt, no_speech_threshold, etc.) — unknown fields cause 400 errors.
  const transcription = { model: TRANSCRIBE_MODEL };
  if (language === "en" || language === "ar") transcription.language = language;

  // For English, raise the VAD threshold so only clear close-mic speech triggers a turn.
  // threshold (0.0–1.0, default 0.5): higher = less sensitive to background noise.
  const turnDetection = language === "en"
    ? { type: "server_vad", threshold: 0.7, silence_duration_ms: 600 }
    : { type: "server_vad", silence_duration_ms: 500 };

  const sessionConfig = {
    session: {
      type: "transcription",
      audio: {
        input: {
          transcription,
          turn_detection: turnDetection,
        },
      },
    },
  };

  let resp;
  try {
    resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(sessionConfig),
    });
  } catch (err) {
    return json({ error: `Could not reach OpenAI: ${err.message}` }, 502);
  }

  if (!resp.ok) {
    // Parse the OpenAI error body so callers see the exact reason for the failure.
    const raw = await resp.text();
    let oaiError = null;
    try { oaiError = JSON.parse(raw); } catch { /* raw is not JSON */ }
    return json({
      error: "OpenAI realtime-token request failed",
      openai_status: resp.status,
      openai_error: oaiError ?? raw.slice(0, 1000),
      sent_config: sessionConfig,   // show exactly what we sent (no secrets — key is in header only)
    }, resp.status);
  }

  const data = await resp.json();
  // Response shape: { value: "ek_...", expires_at, session: { ... } }
  // Fall back to older nested shape just in case.
  const value = data.value || data.client_secret?.value;
  const expires_at = data.expires_at || data.client_secret?.expires_at || null;
  if (!value) {
    return json({
      error: "No ephemeral token in OpenAI response",
      openai_response: JSON.stringify(data).slice(0, 500),
    }, 502);
  }
  return json({ value, expires_at, model: TRANSCRIBE_MODEL });
};
