// POST /api/translate
// Body: { text: string, source?: "en"|"ar", target?: "ru" }
// Returns: { text, source, target }
//
// Calls Google Cloud Translation API v2 server-side (GOOGLE_TRANSLATE_API_KEY stays private).

const GOOGLE_URL = "https://translation.googleapis.com/language/translate/v2";
const TARGET_LANG = process.env.TARGET_LANG || "ru";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) return json({ error: "GOOGLE_TRANSLATE_API_KEY is not configured on the server" }, 500);

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

  const params = new URLSearchParams({ key: apiKey });
  const body = new URLSearchParams({ q: text, source, target, format: "text" });

  let resp;
  try {
    resp = await fetch(`${GOOGLE_URL}?${params}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    return json({ error: `Could not reach Google Translate: ${err.message}` }, 502);
  }

  if (!resp.ok) {
    const detail = await resp.text();
    return json({ error: "Google Translate API error", status: resp.status, detail }, resp.status);
  }

  const data = await resp.json();
  const translated = data?.data?.translations?.[0]?.translatedText ?? "";
  return json({ text: translated, source, target });
};
