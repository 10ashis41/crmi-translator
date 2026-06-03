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
  const env = {
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    GOOGLE_TRANSLATE_API_KEY: !!process.env.GOOGLE_TRANSLATE_API_KEY,
    ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
    ELEVENLABS_VOICE_ID: !!process.env.ELEVENLABS_VOICE_ID,
  };
  const envOk = Object.values(env).every(Boolean);

  const quick = new URL(req.url).searchParams.get("quick");
  if (quick) return json({ ok: envOk, env });

  const services = {};

  // OpenAI — list models verifies the key works.
  if (env.OPENAI_API_KEY) {
    services.openai = await ping("openai", () => {
      const t = withTimeout();
      return fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        signal: t.signal,
      }).finally(t.done);
    });
  } else services.openai = { ok: false, status: 0, detail: "OPENAI_API_KEY missing" };

  // Google Translate — a tiny real translation verifies key + API enabled.
  if (env.GOOGLE_TRANSLATE_API_KEY) {
    services.googleTranslate = await ping("google", () => {
      const t = withTimeout();
      const params = new URLSearchParams({ key: process.env.GOOGLE_TRANSLATE_API_KEY });
      const body = new URLSearchParams({ q: "test", source: "en", target: "ru", format: "text" });
      return fetch(`https://translation.googleapis.com/language/translate/v2?${params}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: t.signal,
      }).finally(t.done);
    });
  } else services.googleTranslate = { ok: false, status: 0, detail: "GOOGLE_TRANSLATE_API_KEY missing" };

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
