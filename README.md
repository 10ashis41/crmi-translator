# CRMI Live Translator (Netlify)

Real-time English-to-Russian interpretation for a live church service, running
**entirely on Netlify** — a static operator page plus four serverless Netlify
Functions. No VM, no GPU, no servers to keep alive.

```
Operator browser (mic, continuous WebM/Opus stream)
        │  100 ms audio chunks over WebSocket
        ▼
  wss://api.deepgram.com/v1/listen (Nova-3, language=en)
        │  final English transcript (speech_final or VAD boundary)
        ▼
  /api/translate  ──► Google Gemini 2.5 Flash-Lite  → Russian text
        │
        ▼
  /api/speak      ──► ElevenLabs Flash v2.5          → Russian MP3  (1.3× speed)
        │  audio/mpeg
        ▼
Operator browser plays it out the selected output device
(headphone jack → FM transmitter → congregation earpieces)
```

All API keys live **only** in Netlify environment variables and are never sent to
the browser. The browser uses a short-lived Deepgram token (minted by
`/api/deepgram-token`) for the WebSocket handshake.

## Features

- **Start / Stop** — one click to begin or end a live session.
- **Mute** — pauses audio to Deepgram while holding the WebSocket open; resume
  is instant. Useful when worship music starts and transcription is not needed.
- **Download Transcript** — available at any point during or after a session.
  Saves a timestamped `.txt` file with every English phrase paired with its
  Russian translation (`crmi-transcript-YYYY-MM-DD-HH-MM.txt`).
- **Input / output device selection** — choose the mic and the output route
  (e.g. headphone jack feeding an FM transmitter).
- **Volume control** — adjusts playback level of Russian audio.
- **Status indicators** — three dots show Microphone / Processing / Audio-out state.
- **Auto-reconnect** — recovers silently from dropped WebSocket connections,
  buffering up to 60 s of audio so no words are lost.
- **Proactive refresh** — reconnects the socket at 55 min to avoid Deepgram's
  60-minute hard limit.
- **KeepAlive frames** — sent every 5 s so the socket stays open while muted.

## Gemini translation quality

The `translate.mjs` function uses **Gemini 2.5 Flash-Lite** with a curated
church-service system prompt that enforces:

- Formal plural address (`вы/вас/вам`) for congregation-directed speech.
- Idiomatic Russian equivalents for English figures of speech (no literal
  translations).
- Standard Russian religious terminology (`Святой Дух`, `благодать`,
  `покаяние`, `воздеть руки`, etc.).
- Canonical Synodal Bible phrasing for well-known scripture passages.
- Consistent place-name transliteration (Голгофа, Гефсимания, Вифлеем …).

## Project layout

```
crmi-translator-netlify/
├── netlify.toml                 # build + /api/* routing
├── package.json
├── smoke-test.sh                # one-command health check against a deployed site
├── public/
│   ├── index.html               # operator UI
│   └── app.js                   # mic capture + Deepgram WebSocket + pipeline client
└── netlify/functions/
    ├── deepgram-token.mjs       # POST /api/deepgram-token  (mints short-lived Deepgram key)
    ├── translate.mjs            # POST /api/translate       (Gemini 2.5 Flash-Lite)
    ├── speak.mjs                # POST /api/speak           (ElevenLabs Flash v2.5)
    └── health.mjs               # GET  /api/health          (verify keys/providers)
```

## Verify before a service

- **`GET /api/health`** — checks that all env vars are present and that each
  provider accepts the key. Returns `{ ok, env, services }`; HTTP 200 when
  healthy, 503 otherwise. Add `?quick=1` to only check env-var presence (no
  upstream calls). The operator page runs the quick check automatically on load.

### Smoke test script

```bash
./smoke-test.sh                                    # https://crmi-translator.netlify.app
./smoke-test.sh https://crmi-translator.netlify.app
./smoke-test.sh http://localhost:8888              # against `netlify dev`
```

## Environment variables

Add these in the Netlify dashboard at **Site configuration → Environment variables**
(or in a local `.env` file for `netlify dev`):

| Variable | Required | Description |
|---|---|---|
| `DEEPGRAM_API_KEY` | ✅ | Deepgram API key for Nova-3 streaming STT. Get one free at **console.deepgram.com** → *Create API Key*. |
| `GEMINI_API_KEY` | ✅ | Google Cloud API key with the **Generative Language API** enabled. |
| `ELEVENLABS_API_KEY` | ✅ | ElevenLabs API key. |
| `ELEVENLABS_VOICE_ID` | ✅ | ElevenLabs voice ID for the Russian audio. |
| `DEEPGRAM_PROJECT_ID` | optional | Your Deepgram project UUID. Skips the project-lookup call on every Start click (~100 ms saved). Find it in **console.deepgram.com** → *Settings*. |
| `GEMINI_MODEL` | optional | Defaults to `gemini-2.5-flash-lite`. |
| `ELEVENLABS_MODEL` | optional | Defaults to `eleven_flash_v2_5`. |
| `ELEVENLABS_OUTPUT_FORMAT` | optional | Defaults to `mp3_44100_128`. |
| `TARGET_LANG` | optional | Defaults to `ru`. |

## Deploy

```bash
cd ~/crmi-translator-netlify
npx netlify-cli deploy --prod
```

The site is live at **https://crmi-translator.netlify.app**

### Local development

```bash
cp .env.example .env   # fill in your keys
npx netlify-cli dev    # http://localhost:8888  (Ctrl-C to stop)
```

`localhost` is a secure context, so microphone capture and WebSocket work
without HTTPS.

## Browser notes

- Use **Google Chrome** (desktop or Android). The app relies on `MediaRecorder`
  (WebM/Opus) and `HTMLMediaElement.setSinkId` for output-device routing.
- **iOS Safari** does not support `setSinkId` and has limited `MediaRecorder`
  support — Chrome is recommended.
- Microphone capture and output-device selection require a **secure context**
  (HTTPS or `localhost`).
