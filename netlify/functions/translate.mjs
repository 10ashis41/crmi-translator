// POST /api/translate
// Body: { text: string, source?: "en"|"ar", target?: "ru" }
// Returns: { text, source, target }
//
// Translation is done by Google's Gemini 2.5 Flash-Lite model (Generative
// Language API) server-side.  Uses the non-streaming generateContent endpoint
// for lowest latency on short church-service utterances.
//
// API key: prefers GEMINI_API_KEY, falls back to the existing
// GOOGLE_TRANSLATE_API_KEY. Whichever key is set must have the Generative
// Language API ("generativelanguage.googleapis.com") enabled.

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const TARGET_LANG = process.env.TARGET_LANG || "ru";
const TIMEOUT_MS = 12000;  // Netlify functions have a 26 s max; fail fast at 12 s

const SYSTEM_PROMPT =
  "You are a professional simultaneous interpreter for a live Christian church service. " +
  "Translate spoken English into natural, fluent Russian exactly as a trained church interpreter would speak it.\n\n" +
  "REGISTER: Always use formal/plural address (вы/вас/вам) when the speaker addresses the congregation. " +
  "Never use the informal singular (ты/тебя/тебе) for congregation address.\n\n" +
  "IDIOMS & PROVERBS: When you encounter an English idiom, proverb, or figure of speech, " +
  "use the closest existing Russian equivalent that is actually used. Do not translate literally " +
  "or invent a new phrase. Only fall back to a literal translation if no Russian equivalent exists.\n\n" +
  "RELIGIOUS TERMINOLOGY — use these standard Russian equivalents:\n" +
  "• Holy Spirit → Святой Дух  • Lord → Господь  • Savior → Спаситель\n" +
  "• grace → благодать  • mercy → милость  • righteousness → праведность\n" +
  "• sanctification → освящение  • justification → оправдание  • atonement → искупление\n" +
  "• repentance → покаяние  • redemption → искупление  • intercession → ходатайство\n" +
  "• covenant → завет  • gospel → Евангелие  • scripture → Писание\n" +
  "• congregation → собрание/церковь  • sermon → проповедь  • prayer → молитва\n" +
  "• worship → поклонение  • praise → хвала  • glory → слава\n" +
  "• baptism → крещение  • communion → причастие  • resurrection → воскресение\n" +
  "• salvation → спасение  • eternal life → жизнь вечная  • sin → грех\n" +
  "• born again → рождённый свыше  • believe → веровать  • faith → вера\n" +
  "• lift/raise hands → воздеть руки  • hands raised → воздетые руки\n\n" +
  "PLACE NAMES: Transliterate consistently — Gethsemane → Гефсимания, " +
  "Golgotha → Голгофа, Calvary → Голгофа, Galilee → Галилея, " +
  "Bethlehem → Вифлеем, Nazareth → Назарет, Jerusalem → Иерусалим.\n\n" +
  "OUTPUT: Return only the translated Russian text. No explanations, no notes, no alternatives.\n\n" +
  "STT CORRECTION: The input is a live Deepgram transcript and may contain speech-to-text errors. " +
  "Before translating, silently correct obvious mishearings of biblical names, theological terms, and place names — " +
  "e.g. 'cavalry' → Calvary, 'get some money' / 'Geth seminary' → Gethsemane, 'the saloni ans' → Thessalonians, " +
  "'have a coke' / 'Haba cook' → Habakkuk, 'ecclesiastics' → Ecclesiastes, " +
  "'on the road to a mouse' / 'a mouse' → Emmaus (as in 'the road to Emmaus'), " +
  "'zack ee us' → Zacchaeus, 'nick oh deem us' → Nicodemus, 'sand hedrin' → Sanhedrin. " +
  "Only fix unambiguous STT artifacts on known church vocabulary; leave everything else exactly as transcribed.";

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

  if (!text) return json({ text: "", source, target });

  // Build the user turn — prepend rolling context when the caller supplies it.
  // context is [{en, ru}, ...] (up to 3 prior segments from this session).
  // We show it to the model for coherence (pronouns, topic, register) but
  // explicitly forbid re-outputting it; only the new segment must be translated.
  const context = Array.isArray(payload.context)
    ? payload.context.filter((c) => c && typeof c.en === "string" && typeof c.ru === "string")
    : [];

  let userTurn;
  if (context.length > 0) {
    const ctxBlock = context
      .map((c) => `[EN] ${c.en.trim()}\n[RU] ${c.ru.trim()}`)
      .join("\n\n");
    userTurn =
      `Recent sermon context (already translated — do NOT output these again):\n\n${ctxBlock}\n\n` +
      `Translate ONLY the following new segment into Russian. ` +
      `Return the Russian translation only, nothing else:\n${text}`;
  } else {
    userTurn = text;
  }

  const reqBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: userTurn }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 400,
    },
  };

  const params = new URLSearchParams({ key: apiKey });
  const url = `${GEMINI_URL}?${params}`;

  // Retry up to 3 times on 429 / 503 with exponential backoff.
  let resp;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err.name === "AbortError"
        ? `Gemini timed out after ${TIMEOUT_MS / 1000}s`
        : `Could not reach Gemini: ${err.message}`;
      return json({ error: msg }, 502);
    }
    clearTimeout(timer);
    if (resp.status !== 429 && resp.status !== 503) break;
    const retryAfterMs = parseInt(resp.headers.get("Retry-After") || "0", 10) * 1000
      || (2 ** attempt) * 1000;
    console.error(`Gemini ${resp.status} on attempt ${attempt + 1}; retrying after ${retryAfterMs}ms`);
    await new Promise((r) => setTimeout(r, retryAfterMs));
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error(`Gemini error: status=${resp.status} body=${detail}`);
    // Surface the HTTP status so the operator can distinguish key/quota errors (401/403/429)
    // from transient network errors (502/503).
    return json(
      { error: `Gemini API error (HTTP ${resp.status})`, detail },
      resp.status >= 500 ? 502 : resp.status,
    );
  }

  let data;
  try {
    data = await resp.json();
  } catch (err) {
    console.error(`Gemini JSON parse error: ${err.message}`);
    return json({ error: `Gemini returned invalid JSON: ${err.message}` }, 502);
  }

  const parts = data?.candidates?.[0]?.content?.parts;
  const translated = Array.isArray(parts)
    ? parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
    : "";

  return json({ text: translated.trim(), source, target });
};
