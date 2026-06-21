# CRMI Live Translator — Project Notes
_Newest first. Auto-maintained by Claude Code._

---

## 2026-06-21

### Translation pipeline
- **Current stack**: Deepgram Nova-3 (streaming STT via WebSocket) → Google Translate v2 → ElevenLabs Flash v2.5
- Deepgram key is never exposed to the browser — `/api/deepgram-token` mints a 10-second scoped key per session.
- Pipeline fires on `speech_final` (natural sentence boundary) OR `is_final` (300 ms VAD silence), whichever comes first. Exact-text dedup prevents double-processing when both arrive with the same transcript.
- Input: English or Arabic (toggle live). Output: always Russian.
- ElevenLabs plays at 1.3× speed. Sequential playback — clips never overlap; oldest queued segment dropped if pipeline falls behind.
- `autoGainControl` enabled on mic constraints (last commit: `e09edf2`).

### Netlify deploy state
- **Live at**: https://crmi-translator.netlify.app — HEALTHY
- **Deploy command**: `npx netlify-cli deploy --build --prod` (run from `~/crmi-translator-netlify`)
- **Site**: `crmi-translator` (NOT `unrivaled-druid-5185ca` — that's a stale alias, do not use)
- No git remote configured on this repo — deploy is CLI-only (not git-push-triggered).

### VM / GPU
- The VM-based pipeline (`~/church-translator` — faster-whisper + Google Translate + ElevenLabs) is the **old approach**. Current production is Netlify-only; no VM needed.
- VM systemd service: `church-translator.service` managed by `deploy/install-service.sh`.
- Cloud Scheduler jobs start/stop the GCP VM at 17:45 / 20:30 Israel time (Mon/Wed/Fri). DST-aware (`Asia/Jerusalem`). Managed via `deploy/scheduler-setup.sh`.
- Last working GPU create command (from README):
  ```bash
  gcloud compute instances create church-gpu \
    --zone=us-central1-a --machine-type=g2-standard-4 \
    --accelerator=type=nvidia-l4,count=1 \
    --maintenance-policy=TERMINATE \
    --image-family=common-cu123 --image-project=deeplearning-platform-release \
    --boot-disk-size=100GB
  ```

### ProPresenter song builder
- **`~/build-pro.py`** — generates `.pro` files (ProPresenter 7.19 format) from slide data using the Proto 19beta protobuf schema (`~/proto19_py/`).
- Each slide has 4 optional text layers: `arabic`, `russian`, `english`, `phonetic`.
- Output: serialized `.pro` binary + base64 to stdout.
- Usage: `python3 ~/build-pro.py` (runs built-in 1-slide test → `test-output.pro`).
- Proto compiled files: `~/proto19_py/` (from `~/ProPresenter7-Proto/Proto 19beta/`).
- No known open issues with `.pro` generation as of this date.

### Env key locations (names only — no values)
| Key | Where stored |
|---|---|
| `DEEPGRAM_API_KEY` | Netlify env vars (site dashboard) |
| `DEEPGRAM_PROJECT_ID` | Netlify env vars (optional — skips project lookup) |
| `GOOGLE_TRANSLATE_API_KEY` | Netlify env vars |
| `ELEVENLABS_API_KEY` | Netlify env vars |
| `ELEVENLABS_VOICE_ID` | Netlify env vars |
| `OPENAI_API_KEY` | Netlify env vars (used by `realtime-token.mjs` — not main pipeline) |
| VM `.env` file | `~/church-translator/.env` (old VM pipeline only) |

### Current state
- Netlify site HEALTHY — all 4 env vars present, Deepgram + Google Translate + ElevenLabs all accepting keys.
- `speech_final` + `is_final` dedup pipeline working — no double-firing.
- ProPresenter builder functional — `.pro` generation tested.

### Open items / what's next
- Confirm `DEEPGRAM_PROJECT_ID` is set in Netlify env vars (saves ~100 ms round-trip on every Start click).
- VM / Cloud Scheduler: verify jobs are still scheduled and paused/active as needed for service schedule.
- ProPresenter: no `.pptx` export yet — `build-pro.py` only outputs `.pro`. If `.pptx` is needed, that's a separate task.
- Smoke test before each service: `./smoke-test.sh` from `~/crmi-translator-netlify`.
