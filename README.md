# Church Live Translator (Netlify)

Real-time spoken-language translation for a church service, running **entirely on
Netlify** — a static operator page plus three serverless Netlify Functions. No VM,
no GPU, no servers to keep alive.

```
Operator browser (mic, 3s segments)
        │  multipart audio
        ▼
  /api/transcribe ──► OpenAI Whisper        → English / Arabic text
        │
        ▼
  /api/translate  ──► Google Translate v2   → Russian text
        │
        ▼
  /api/speak      ──► ElevenLabs Flash v2.5 → Russian MP3
        │  audio/mpeg
        ▼
Operator browser plays it out the selected output device
(headphone jack → FM transmitter)
```

All three API keys live **only** in Netlify environment variables and are used
server-side inside the functions, so nothing secret is ever sent to the browser.

## Features

- **Operator page** (`/`): Start/Stop button, English⇄Arabic input toggle, live
  source transcript, live Russian translation, status indicators, volume control,
  and **output-device selection** (route audio to the headphone jack feeding the
  transmitter).
- **Chunked pipeline**: mic audio is captured in complete 3-second segments and
  run through transcribe → translate → speak. Segments are processed in order, and
  Russian audio clips are played back-to-back (never overlapping). If the pipeline
  falls behind, the oldest queued segment is dropped to catch up (shown in status).

## Project layout

```
church-translator-netlify/
├── netlify.toml                 # build + /api/* routing
├── package.json
├── .env.example
├── smoke-test.sh                # one-command health check against a deployed site
├── public/
│   ├── index.html               # operator UI
│   ├── app.js                   # mic capture + pipeline client
│   └── sample-en.mp3            # spoken sample used by the Test Pipeline button
└── netlify/functions/
    ├── transcribe.mjs           # POST /api/transcribe  (OpenAI Whisper)
    ├── translate.mjs            # POST /api/translate   (Google Translate v2)
    ├── speak.mjs                # POST /api/speak        (ElevenLabs Flash v2.5)
    └── health.mjs               # GET  /api/health       (verify keys/providers)
```

## Verify before a service

Two built-in ways to confirm everything works **before** going live:

- **`GET /api/health`** — checks that all four env vars are present *and* that each
  provider accepts the key (OpenAI, Google Translate, and the configured ElevenLabs
  voice). Returns `{ ok, env, services }`; HTTP 200 when healthy, 503 otherwise. It
  never returns key values. Add `?quick=1` to only check env-var presence (no
  upstream calls). The operator page runs the quick check automatically on load.
- **🔎 Test Pipeline button** (on the operator page) — after the health check, it
  runs the bundled `public/sample-en.mp3` spoken clip through the **full chain**:
  `/api/transcribe` (real Whisper transcription) → `/api/translate` → `/api/speak`,
  then plays the Russian audio out the selected output device. This exercises all
  three providers and the transmitter audio path in one click. (If the sample or the
  Whisper step is unavailable it falls back to a written sample phrase so translate +
  speak can still be verified.)

### Smoke test script

`./smoke-test.sh` curls the deployed `/api/health` and prints a per-service
pass/fail summary. Exit code is `0` when healthy, `1` otherwise — handy as a
pre-service check.

```bash
./smoke-test.sh                                    # https://church-translator.netlify.app
./smoke-test.sh https://church-translator.netlify.app
./smoke-test.sh http://localhost:8888              # against `netlify dev`
```

## Environment variables

Add these in the Netlify dashboard at **Site configuration → Environment variables**
(or in a local `.env` file for `netlify dev`):

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | OpenAI key for the Whisper transcription API. |
| `GOOGLE_TRANSLATE_API_KEY` | ✅ | Google Cloud API key with the **Cloud Translation API** enabled. |
| `ELEVENLABS_API_KEY` | ✅ | ElevenLabs API key. |
| `ELEVENLABS_VOICE_ID` | ✅ | ElevenLabs voice ID to speak the Russian audio. |
| `ELEVENLABS_MODEL` | optional | Defaults to `eleven_flash_v2_5`. |
| `ELEVENLABS_OUTPUT_FORMAT` | optional | Defaults to `mp3_44100_128`. |
| `WHISPER_MODEL` | optional | Defaults to `whisper-1`. |
| `TARGET_LANG` | optional | Defaults to `ru`. |

## Deploy to Netlify

This deploys to a **new** Netlify site named **`church-translator`**.

### One-time setup

```bash
cd ~/church-translator-netlify

# 1. Authenticate the Netlify CLI (opens a browser)
netlify login

# 2. Create AND link a brand new site named "church-translator".
#    Site names are globally unique; if it's taken, pick another name
#    (e.g. church-translator-<yourorg>) and use that everywhere below.
netlify sites:create --name church-translator

# 3. Add the environment variables (or paste them in the dashboard)
netlify env:set OPENAI_API_KEY           "sk-..."
netlify env:set GOOGLE_TRANSLATE_API_KEY "AIza..."
netlify env:set ELEVENLABS_API_KEY       "..."
netlify env:set ELEVENLABS_VOICE_ID      "..."
```

### Deploy

```bash
netlify deploy --build --prod
```

The site will be live at **https://church-translator.netlify.app**
(or `https://<the-name-you-chose>.netlify.app` if `church-translator` was taken).

### Local development

`netlify dev` serves the static page and the functions together with the same
`/api/*` routing as production, reading keys from a local `.env` file:

```bash
cp .env.example .env   # fill in your 4 keys
netlify dev            # http://localhost:8888  (Ctrl-C to stop)
```

Then open http://localhost:8888 and click **🔎 Test Pipeline**, or check the
backend directly:

```bash
curl http://localhost:8888/api/health           # full provider check
curl http://localhost:8888/api/health?quick=1   # env-presence only
```

`localhost` is a secure context, so microphone capture works without HTTPS.
Output-device selection (`setSinkId`) and mic capture still require **Chrome**.

## Browser notes

- Use **Google Chrome** (desktop or Android). The app relies on `MediaRecorder`
  (WebM/Opus) and `HTMLMediaElement.setSinkId` for output-device routing.
- **iOS Safari** does not support `setSinkId` (output stays on the default device)
  and has limited `MediaRecorder` support — Chrome is recommended for the operator.
- Microphone capture and output-device selection require a **secure context**
  (HTTPS) — Netlify provides this automatically; for local use, `localhost` counts.

## How the audio segmentation works

A single `MediaRecorder` started with a timeslice only produces a valid, decodable
file for its *first* chunk. To keep every 3-second segment independently
transcribable, the client records one complete segment at a time (`start()` →
`stop()` after 3s → send → start the next). This trades a few milliseconds of gap
at each boundary for reliable transcription of each clip.
