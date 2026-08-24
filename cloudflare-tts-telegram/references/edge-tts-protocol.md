# Microsoft Edge TTS — WebSocket protocol (verbatim)

Free, no API key, works from Cloudflare Workers. Use `https://` URL + `Upgrade: websocket`.

## Constants

```
TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
CHROMIUM_VERSION = "143.0.3650.75"        # used as: Sec-MS-GEC-Version = 1-<ver>
CHROMIUM_MAJOR   = "143"
EDGE_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
```

## Sec-MS-GEC token (SHA-256, BigInt to avoid float precision loss)

```js
async function secMsGec() {
  const unixSec = BigInt(Math.floor(Date.now() / 1000));
  let ticks = unixSec + 11644473600n;      // Windows file-time epoch offset
  ticks -= ticks % 300n;                    // round DOWN to nearest 5 minutes
  ticks *= 10000000n;                       // to 100-ns intervals (1e7)
  const s = ticks.toString() + "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  return (await sha256Hex(s)).toUpperCase();
}
```

## WebSocket URL (query params)

```
<EDGE_URL>?TrustedClientToken=<TOKEN>&Sec-MS-GEC=<gec>&Sec-MS-GEC-Version=1-<CHROMIUM_VERSION>&ConnectionId=<uuid-no-dashes>
```

## Handshake headers (fetch with `Upgrade: websocket`)

```
Upgrade: websocket        # required
User-Agent: <USER_AGENT>  # required — server returns 403 without a browser UA
Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold   # optional
Cookie: muid=<32-hex-uppercase>;                              # optional
```

## Messages to send (in order)

### 1. speech.config (text frame)

```
X-Timestamp:<dateToString()>\r\n
Content-Type:application/json; charset=utf-8\r\n
Path:speech.config\r\n\r\n
{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n
```

### 2. SSML (text frame)

```
X-RequestId:<uuid>\r\n
Content-Type:application/ssml+xml\r\n
X-Timestamp:<dateToString()>Z\r\n      # trailing Z is intentional (Edge quirk)
Path:ssml\r\n\r\n
<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='zh-CN-YunxiaNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>ESCAPED_TEXT</prosody></voice></speak>
```

`dateToString()` = JS-style date string `"Mon Aug 24 2026 08:40:00 GMT+0000 (Coordinated Universal Time)"`
(equivalent to `new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)")`).

## Reading the response

- Text frames: `Path: turn.start` → `Path: response` → `Path: audio.metadata` → `Path: turn.end`.
  Done when `Path: turn.end` arrives (or the socket closes).
- Binary frames carry the MP3 audio:
  - `bytes[0:2]` = header length `hl` (big-endian uint16)
  - `bytes[2 : 2+hl]` = header text (e.g. `Path:audio\r\nContent-Type:audio/mpeg\r\n`)
  - `bytes[2+hl :]` = audio payload (MP3)
  - Concatenate all audio payloads; that is the final MP3.

## Chinese voices (Azure neural, available via Edge TTS)

- `zh-CN-YunxiaNeural` 云夏 — boy / child (recommended for "男孩" voice)
- `zh-CN-YunxiNeural` 云希 — young male
- `zh-CN-YunjianNeural` 云健 / `zh-CN-YunyangNeural` 云扬 — male
- `zh-CN-XiaoxiaoNeural` 晓晓 — female (for reference)

## Notes

- `escaped_text`: XML-escape `& < > " '` before inserting into SSML.
- Output format `audio-24khz-48kbitrate-mono-mp3` → 48 kbps CBR MP3 (~small files).
- This is a **non-official** free endpoint; Microsoft may change it. Provide a fallback TTS plan.
