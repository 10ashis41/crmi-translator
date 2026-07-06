// POST /api/translate
// Body: { text: string, source?: "en"|"ar", target?: "ru" }
// Returns: { text, source, target }
//
// Translation is done by Google's Gemini 2.5 Flash-Lite model (Generative
// Language API) server-side. We call the STREAMING endpoint (streamGenerateContent
// with alt=sse) and consume tokens as they arrive, so generation begins flowing
// immediately instead of waiting for the full response. The assembled text is
// then returned as the same JSON shape the previous Google Translate call used,
// so public/app.js needs zero changes (it reads `.json().text` and feeds the
// full string to /api/speak for TTS).
//
// API key: prefers GEMINI_API_KEY, falls back to the existing
// GOOGLE_TRANSLATE_API_KEY. Whichever key is set must have the Generative
// Language API ("generativelanguage.googleapis.com") enabled.

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent`;
const TARGET_LANG = process.env.TARGET_LANG || "ru";

const SYSTEM_PROMPT =
  "You are a professional church interpreter. Translate the following Arabic " +
  "text to natural, fluent Russian as it would be spoken in a Christian church " +
  "service. Preserve religious terminology, phrases, and the speaker's tone.\n\n" +
  "When you encounter an idiom, proverb, or figure of speech in the source text, " +
  "do not translate it literally or invent a new phrase. Instead, use the closest " +
  "existing equivalent idiom or proverb that is actually used in Russian. Only fall " +
  "back to a literal/explanatory translation if no equivalent idiom exists.\n\n" +
  "Example: Arabic 'الجمل لا يرى حدبته' (the camel doesn't see his own hump, " +
  "equivalent to 'the pot calling the kettle black') → Russian: " +
  "'Чья бы корова мычала, а твоя бы молчала'\n\n" +
  "Return only the translated text with no explanation.";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey)
    return json({ error: "GEMINI_API_KEY / GOOGLE_TRANSLATE_API_KEY is not configured on the server" }, 500);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Expected JSON body" }, 400);
  }

  const text = (payload.text || "").toString().trim();
  const source = (payload.source || "en").toString().toLowerCase();
  const target = (payload.target || TARGET_LANG).toString().toLowerCase();

  if (!text) return json({ text: "", source, target }); // nothing to translate

  const reqBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { temperature: 0.3 },
  };

  const params = new URLSearchParams({ alt: "sse", key: apiKey });
  const url = `${GEMINI_URL}?${params}`;
  const fetchOpts = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reqBody),
  };

  // Retry up to 3 times on 429 / 503 with exponential backoff.
  let resp;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      resp = await fetch(url, fetchOpts);
    } catch (err) {
      return json({ error: `Could not reach Gemini: ${err.message}` }, 502);
    }
    if (resp.status !== 429 && resp.status !== 503) break;
    const retryAfterMs = parseInt(resp.headers.get("Retry-After") || "0", 10) * 1000
      || (2 ** attempt) * 1000;
    console.error(`Gemini ${resp.status} on attempt ${attempt + 1}; retrying after ${retryAfterMs}ms`);
    await new Promise((r) => setTimeout(r, retryAfterMs));
  }

  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => "");
    console.error(`Gemini error: status=${resp.status} body=${detail}`);
    return json({ error: "Gemini API error", status: resp.status, detail }, resp.status || 502);
  }

  // Consume the SSE stream as it arrives, accumulating text tokens.
  // Each event is a line beginning with "data: " carrying a JSON chunk whose
  // candidates[0].content.parts[*].text holds the incremental translation.
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let translated = "";

  const consumeChunk = (jsonStr) => {
    let obj;
    try {
      obj = JSON.parse(jsonStr);
    } catch {
      return; // ignore keep-alive / non-JSON lines
    }
    const parts = obj?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) if (typeof p?.text === "string") translated += p.text;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines; process complete lines.
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) consumeChunk(line.slice(5).trim());
      }
    }
    // Flush any trailing buffered line.
    const tail = buffer.trim();
    if (tail.startsWith("data:")) consumeChunk(tail.slice(5).trim());
  } catch (err) {
    console.error(`Gemini stream error: ${err.message}`);
    return json({ error: `Gemini stream error: ${err.message}` }, 502);
  }

  return json({ text: translated.trim(), source, target });
};
