// POST /api/deepgram-token
//
// Mints a short-lived (10 s) Deepgram API key for the browser so the real
// DEEPGRAM_API_KEY never reaches the browser.  The browser uses the temporary
// key to open a WebSocket directly to Deepgram's streaming STT endpoint.
//
// Uses two Deepgram Management API calls:
//   GET  https://api.deepgram.com/v1/projects              – find project_id
//   POST https://api.deepgram.com/v1/projects/{id}/keys    – create temp key
//
// Set DEEPGRAM_PROJECT_ID in Netlify env vars to skip the project lookup on
// every request (saves one round-trip and is recommended for production).
//
// Returns to the browser: { key: "dg.xxxxxxxx..." }

const DG_API = "https://api.deepgram.com/v1";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "Use POST" }, 405);

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return json({ error: "DEEPGRAM_API_KEY is not configured on the server" }, 500);

  // Resolve project ID — use env var if set, otherwise look it up.
  let projectId = (process.env.DEEPGRAM_PROJECT_ID || "").trim();
  if (!projectId) {
    let pResp;
    try {
      pResp = await fetch(`${DG_API}/projects`, {
        headers: { Authorization: `Token ${apiKey}` },
      });
    } catch (err) {
      return json({ error: `Could not reach Deepgram: ${err.message}` }, 502);
    }
    if (!pResp.ok) {
      const raw = await pResp.text().catch(() => "");
      return json({ error: "Deepgram projects lookup failed", deepgram_status: pResp.status, detail: raw.slice(0, 500) }, 502);
    }
    const pData = await pResp.json();
    projectId = pData.projects?.[0]?.project_id;
    if (!projectId) return json({ error: "No Deepgram project found on this account" }, 502);
  }

  // Create a temporary key scoped to usage:write, expiring in 10 seconds —
  // just long enough for the browser to open the WebSocket.
  let kResp;
  try {
    kResp = await fetch(`${DG_API}/projects/${encodeURIComponent(projectId)}/keys`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        comment: "crmi-translator temp",
        scopes: ["usage:write"],
        time_to_live_in_seconds: 10,
      }),
    });
  } catch (err) {
    return json({ error: `Could not reach Deepgram: ${err.message}` }, 502);
  }

  if (!kResp.ok) {
    const raw = await kResp.text().catch(() => "");
    return json({ error: "Deepgram key creation failed", deepgram_status: kResp.status, detail: raw.slice(0, 500) }, kResp.status);
  }

  const kData = await kResp.json();
  const key = kData.key;
  if (!key) return json({ error: "No key field in Deepgram response", response: JSON.stringify(kData).slice(0, 500) }, 502);

  return json({ key });
};
