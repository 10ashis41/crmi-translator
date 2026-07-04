// GET /api/health        -> checks env vars AND that each provider accepts the key
// GET /api/health?quick=1 -> only checks that the env vars are present (no upstream calls)
//
// Never returns key values — only booleans / status codes.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function ping(label, run) {
  try {
    const r = await run();
    return { ok: r.ok, status: r.status, ...(r.ok ? {} : { detail: (await r.text()).slice(0, 300) }) };
  } catch (e) {
    return { ok: false, status: 0, detail: `${label}: ${e.message}` };
  }
}

function withTimeout(ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

export default async (req) => {
  // Translation now runs on Gemini; the function prefers GEMINI_API_KEY and
  // falls back to the legacy GOOGLE_TRANSLATE_API_KEY. Either one satisfies the
  // requirement, so report presence of whichever is configured.
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_TRANSLATE_API_KEY;
  const env = {
    DEEPGRAM_API_KEY: !!process.env.DEEPGRAM_API_KEY,
    GEMINI_API_KEY: !!geminiKey,
    ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
    ELEVENLABS_VOICE_ID: !!process.env.ELEVENLABS_VOICE_ID,
  };
  const envOk = Object.values(env).every(Boolean);

  const quick = new URL(req.url).searchParams.get("quick");
  if (quick) return json({ ok: envOk, env });

  const services = {};

  // Deepgram — list projects verifies the key works.
  if (env.DEEPGRAM_API_KEY) {
    services.deepgram = await ping("deepgram", () => {
      const t = withTimeout();
      return fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
        signal: t.signal,
      }).finally(t.done);
    });
  } else services.deepgram = { ok: false, status: 0, detail: "DEEPGRAM_API_KEY missing" };

  // Gemini — a tiny generateContent call verifies key + API enabled + billing
  // (catches the 429 "prepayment credits depleted" case, not just a bad key).
  if (geminiKey) {
    services.gemini = await ping("gemini", () => {
      const t = withTimeout();
      const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
      return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
        signal: t.signal,
      }).finally(t.done);
    });
  } else services.gemini = { ok: false, status: 0, detail: "GEMINI_API_KEY / GOOGLE_TRANSLATE_API_KEY missing" };

  // ElevenLabs — fetch the configured voice verifies BOTH the key and the voice ID.
  if (env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID) {
    services.elevenlabs = await ping("elevenlabs", () => {
      const t = withTimeout();
      return fetch(`https://api.elevenlabs.io/v1/voices/${process.env.ELEVENLABS_VOICE_ID}`, {
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
        signal: t.signal,
      }).finally(t.done);
    });
  } else {
    services.elevenlabs = { ok: false, status: 0, detail: "ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID missing" };
  }

  const ok = envOk && Object.values(services).every((s) => s.ok);
  return json({ ok, env, services }, ok ? 200 : 503);
};
