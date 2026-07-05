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
  "You are a professional church interpreter. Translate the following English " +
  "text to natural, fluent Russian as it would be spoken in a Christian church " +
  "service. Preserve biblical terminology, religious phrases, and the speaker's " +
  "tone. Return only the translated text with no explanation.\n\n" +
  "IDIOM AND PROVERB RULE: When you encounter an idiom, proverb, or figure of " +
  "speech in the source text, do not translate it literally or invent a new phrase. " +
  "Instead, use the closest existing equivalent idiom or proverb that is actually " +
  "used in the target language. Only fall back to a literal or explanatory " +
  "translation if no equivalent idiom exists in the target language.\n\n" +
  "Examples:\n" +
  "- English \"the pot calling the kettle black\" → Russian: \"Чья бы корова мычала, а твоя бы молчала\"\n" +
  "- English \"it's raining cats and dogs\" → Russian: \"Льёт как из ведра\"\n" +
  "- English \"kill two birds with one stone\" → Russian: \"Убить двух зайцев\"\n" +
  "- Arabic \"الجمل لا يرى حدبته\" → Russian: \"Чья бы корова мычала, а твоя бы молчала\"\n" +
  "Apply this rule to all idioms and proverbs, not just these examples.";

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

  let resp;
  try {
    resp = await fetch(`${GEMINI_URL}?${params}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
  } catch (err) {
    return json({ error: `Could not reach Gemini: ${err.message}` }, 502);
  }

  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => "");
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
    return json({ error: `Gemini stream error: ${err.message}` }, 502);
  }

  return json({ text: translated.trim(), source, target });
};
