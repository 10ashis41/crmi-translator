// POST /api/speak
// Body: { text: string }
// Returns: audio/mpeg stream (MP3) from ElevenLabs Flash v2.5
//
// ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID stay server-side.

const MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey) return json({ error: "ELEVENLABS_API_KEY is not configured on the server" }, 500);
  if (!voiceId) return json({ error: "ELEVENLABS_VOICE_ID is not configured on the server" }, 500);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Expected JSON body" }, 400);
  }

  const text = (payload.text || "").toString().trim();
  if (!text) return json({ error: "Missing 'text'" }, 400);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        speed: 1.3,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
  } catch (err) {
    return json({ error: `Could not reach ElevenLabs: ${err.message}` }, 502);
  }

  if (!resp.ok) {
    const detail = await resp.text();
    return json({ error: "ElevenLabs API error", status: resp.status, detail }, resp.status);
  }

  // Stream the MP3 straight back to the browser.
  return new Response(resp.body, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
    },
  });
};
