# Cloudflare-specific pitfalls and fixes

## 1. Workers `fetch` rejects `wss://`

Symptom: `TypeError: Fetch API cannot load: wss://…` (error code 1101 in the Worker).

Fix: use `https://` + `Upgrade: websocket` header. The Workers runtime performs the WebSocket
upgrade and exposes the client socket as `resp.webSocket`; then call `ws.accept()`.

```js
const resp = await fetch(url, { headers: { "Upgrade": "websocket", "User-Agent": UA } });
if (!resp.webSocket) throw new Error(`handshake failed (${resp.status})`);
const ws = resp.webSocket;
ws.accept();
ws.send("...");
ws.addEventListener("message", (evt) => { /* evt.data: string | ArrayBuffer */ });
```

## 2. No Chinese male TTS on Workers AI

Account model check (REST): `GET /client/v4/accounts/<acc>/ai/models/search?search=<term>`.

Observed on a real account:
- `@cf/hexgrad/kokoro-82m` — **not present** (the only model with Chinese male voices).
- `@cf/myshell-ai/melotts` — present but returns HTTP 500 for every request (Cloudflare-side
  outage), and its Chinese voice is female only.
- `@cf/deepgram/aura-2-en` / `aura-1` — English/Spanish only.

Conclusion: for Chinese male voice, use Edge TTS (see `edge-tts-protocol.md`).

## 3. Workers AI text response shape is unstable

`env.AI.run(model, { messages, response_format: { type: "json_object" } })` may return:
- `{ response: "{\"title\":…,\"story\":…}" }` (string), or
- OpenAI-style `{ choices: [{ message: { content: "…" } }] }`.

Normalize with a helper:

```js
function extractContent(res) {
  if (!res) return "";
  if (typeof res === "string") return res;
  const cand = [res.response, res.result, res.output, res.text, res.content];
  for (const c of cand) if (typeof c === "string" && c.trim()) return c.trim();
  const choices = res.choices || res.response?.choices || res.result?.choices;
  if (Array.isArray(choices) && choices[0]) {
    const c = choices[0].message?.content ?? choices[0].text;
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  for (const c of cand) if (c && typeof c === "object") { const cc = extractContent(c); if (cc) return cc; }
  return "";
}
```

Also defensively parse the returned text: accept `title`/`story` (or `Title`/`Story`/`content`/`text`,
or `标题`/`正文` markers), and coerce `story` to a string (it may be an object/array).

## 4. Wrangler deploy EPERM on the account cache

Symptom: `X [ERROR] EPERM: operation not permitted, open '…\node_modules\.cache\wrangler\wrangler-account.json'`.

This file gets locked (sandbox safe-delete / file protection) after a deploy. Workaround: rename the
parent dir before each deploy so a fresh cache is created:

```bash
if [ -d node_modules/.cache ]; then mv node_modules/.cache "node_modules/.cache_x$(date +%H%M%S)"; fi
npx wrangler deploy
```

## 5. Cron runs in UTC

Cloudflare Cron Triggers are UTC-only with no timezone setting. Beijing (UTC+8, no DST) 20:00 ==
`0 12 * * *`. Compute the dedup "today" in Beijing time: `new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10)`.

## 6. Telegram

- `sendAudio` accepts MP3 (`audio/mpeg`) via FormData; caption carries title + style. Send the
  full story text as a separate `sendMessage` to stay under the caption length limit.
- Multiple targets: env var with comma-separated chat ids, parsed into an array.
- Webhook manual trigger: `setWebhook?url=<worker>/webhook&secret_token=<TG_WEBHOOK_SECRET>`;
  validate the `X-Telegram-Bot-Api-Secret-Token` header server-side.
