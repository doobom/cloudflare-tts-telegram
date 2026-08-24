---
name: cloudflare-tts-telegram
description: Deploy a Cloudflare Worker that generates text via Workers AI and Chinese male-voice audio via Microsoft Edge TTS, then pushes both to Telegram on a Cron schedule (Beijing time) with manual trigger via Telegram /story command and an HTTP /test endpoint. Use this skill when the user wants a Cloudflare-hosted bot that periodically generates and pushes text + audio (daily stories, bedtime readings, narration, voice alerts) to one or more Telegram chats.
agent_created: true
---

# Cloudflare Worker → TTS → Telegram

Build and deploy a single Cloudflare Worker that, on a schedule or on demand,
generates a piece of text, synthesizes it to Chinese male-voice audio (free,
no API key), and pushes text + audio to Telegram.

## When to use

- User wants a daily/periodic story, reading, narration, or voice message pushed to Telegram.
- User wants "deploy to Cloudflare Workers + use Cloudflare AI + send to Telegram".
- User wants a schedule expressed in Beijing time (20:00) with a manual "send now" trigger.

## Workflow

1. **Scaffold** the Worker from `assets/worker-template.js` and `assets/wrangler-template.toml`.
2. **Configure** `wrangler.toml`: set `TELEGRAM_CHAT_IDS` (comma-separated, supports multiple) and the TTS voice.
3. **Provision** the KV namespace (`wrangler kv namespace create STORY_KV`) and paste its id into `wrangler.toml`.
4. **Set secrets**: `wrangler secret put TELEGRAM_BOT_TOKEN`, and optionally `TG_WEBHOOK_SECRET`.
5. **Deploy**: `wrangler deploy` (Cron `0 12 * * *` == Beijing 20:00, since Workers Cron is UTC and China has no DST).
6. **Register the webhook** for `/story` manual trigger:
   `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/webhook&secret_token=<TG_WEBHOOK_SECRET>"`
7. **Verify** with `GET /test` (force-send, bypasses dedup) and `GET /latest`.

## Critical gotchas (read before coding)

- **Workers `fetch` does NOT support `wss://`** — it throws `Fetch API cannot load: wss://…`.
  Use `https://` + `Upgrade: websocket` header; the runtime performs the WS handshake and returns `resp.webSocket`. See `references/cloudflare-pitfalls.md`.
- **Chinese male voice is NOT available on Cloudflare Workers AI** (Kokoro absent, MeloTTS returns HTTP 500, Deepgram Aura is English-only). Use **Microsoft Edge TTS** with `zh-CN-YunxiaNeural` (云夏, boy). Full protocol in `references/edge-tts-protocol.md`.
- **Edge TTS handshake only needs a browser `User-Agent`** (`Upgrade: websocket` + `User-Agent`; Origin/Cookie are optional). Without the UA it returns 403.
- **Workers AI text output shape is unstable** — `env.AI.run` sometimes returns `{response: "…"}` and sometimes OpenAI-style `{choices:[{message:{content}}]}`. Normalize with `extractContent()` (already in the template).
- **Wrangler deploy may fail with `EPERM: operation not permitted, open 'node_modules/.cache/wrangler/wrangler-account.json'`** when the sandbox locks that file. Workaround: before each deploy run `mv node_modules/.cache "node_modules/.cache_x$(date +%H%M%S)"`.
- **Telegram**: send the MP3 via `sendAudio` (FormData + `File`) and the story via `sendMessage`; use `audio/mpeg` MIME, not `audio/wav`.

## Resources

- `assets/worker-template.js` — complete, working Worker (story gen + Edge TTS + Telegram + cron/webhook).
- `assets/wrangler-template.toml` — deployment config with AI/KV/vars/Cron bindings.
- `references/edge-tts-protocol.md` — exact Edge TTS token algorithm, WebSocket messages, and audio-frame parsing.
- `references/cloudflare-pitfalls.md` — the Cloudflare-specific traps and their fixes.
