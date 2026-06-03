// POST /api/transcribe
// Body: multipart/form-data with:
//   audio    - the recorded audio blob (webm/opus from the browser MediaRecorder)
//   language - "en" or "ar" (optional; Whisper auto-detects if omitted)
// Returns: { text, language }
//
// Calls the OpenAI Whisper API server-side so OPENAI_API_KEY never reaches the browser.

const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-1";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json({ error: "OPENAI_API_KEY is not configured on the server" }, 500);

  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected multipart/form-data with an 'audio' field" }, 400);
  }

  const audio = form.get("audio");
  if (!audio || typeof audio === "string") {
    return json({ error: "Missing 'audio' file in form data" }, 400);
  }

  // "en" / "ar". Anything else -> let Whisper auto-detect.
  const language = (form.get("language") || "").toString().toLowerCase();

  // Preserve a sensible filename/extension so OpenAI infers the container format.
  const type = audio.type || "audio/webm";
  const ext = type.includes("mp4") || type.includes("mp4a") ? "mp4"
            : type.includes("mpeg") || type.includes("mp3") ? "mp3"
            : type.includes("wav") ? "wav"
            : type.includes("ogg") ? "ogg"
            : "webm";

  const upstream = new FormData();
  upstream.append("file", audio, `audio.${ext}`);
  upstream.append("model", WHISPER_MODEL);
  upstream.append("response_format", "json");
  if (language === "en" || language === "ar") upstream.append("language", language);

  let resp;
  try {
    resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
    });
  } catch (err) {
    return json({ error: `Could not reach OpenAI: ${err.message}` }, 502);
  }

  if (!resp.ok) {
    const detail = await resp.text();
    return json({ error: "Whisper API error", status: resp.status, detail }, resp.status);
  }

  const data = await resp.json();
  return json({ text: (data.text || "").trim(), language: language || "auto" });
};
