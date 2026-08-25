// 004-少年夜话 — Cloudflare Worker
// 每日北京 20:00（Cron）或 Telegram 手动 /story（中文）/ /story-en（英文）触发：
// 生成「男孩第一人称」~300 字/词故事 + 男声音频（Edge TTS），推送到一个或多个 Telegram chat。
//
// 绑定：AI（Workers AI 文本生成）、STORY_KV（KV 防重发/历史）
// 变量：TELEGRAM_CHAT_IDS（逗号分隔多 chat）、TEXT_MODEL、TTS_VOICE（中文）、TTS_VOICE_EN（英文）
// 密钥：TELEGRAM_BOT_TOKEN、TG_WEBHOOK_SECRET（可选）、ADMIN_TOKEN（/test 鉴权，可选）

// ---------- 风格池 / 男孩名字池 ----------
const STORY_STYLES = [
  "温馨家庭", "童话寓言", "科幻奇遇", "校园趣事",
  "自然科普", "冒险探索", "友情故事", "奇幻想象",
  "动物伙伴", "成长小记",
];
const BOY_NAMES = ["小宇", "小天", "阿豆", "小树", "阳阳", "小满", "石头", "小野"];

// 英文故事：风格池 / 男孩名字池
const EN_STORY_STYLES = [
  "warm family", "fairy tale", "sci-fi adventure", "school life",
  "nature & science", "outdoor adventure", "friendship", "fantasy",
  "animal friends", "growing up",
];
const EN_BOY_NAMES = ["Leo", "Max", "Tom", "Alex", "Ethan", "Sam", "Oliver", "Noah"];

// ---------- Edge TTS 常量 ----------
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR = CHROMIUM_VERSION.split(".")[0];
// 注意：Workers 的 fetch 不识别 wss://，需用 https:// + Upgrade 头做 WebSocket 握手
const EDGE_WSS = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;

// ---------- 通用工具 ----------
function beijingDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function getChatIds(env) {
  return String(env.TELEGRAM_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^-?\d+$/.test(s) ? Number(s) : s));
}
function isAuthorized(env, chatId) {
  return getChatIds(env).some((id) => String(id) === String(chatId));
}
// /test 鉴权：需要 ADMIN_TOKEN（secret）。未配置则视为禁用（安全默认）。
// 支持 ?token= 查询参数 或 X-Admin-Token / Authorization: Bearer 请求头。
function isAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const q = new URL(request.url).searchParams.get("token") || "";
  const h =
    request.headers.get("X-Admin-Token") ||
    (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const got = q || h || "";
  return got.length === expected.length && got === expected;
}
function uuidHex() {
  return crypto.randomUUID().replace(/-/g, "");
}
async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Edge TTS Sec-MS-GEC 令牌（用 BigInt 避免精度丢失）
async function secMsGec() {
  const unixSec = BigInt(Math.floor(Date.now() / 1000));
  let ticks = unixSec + 11644473600n;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  return (await sha256Hex(ticks.toString() + TRUSTED_CLIENT_TOKEN)).toUpperCase();
}
function dateToString() {
  return new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
}
function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function mkssml(text, voice, xmlLang = "zh-CN") {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + xmlLang + "'>" +
    `<voice name='${voice}'>` +
    `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody>` +
    "</voice></speak>"
  );
}

// 从 Workers AI 的多种返回形状中提取纯文本
function extractContent(res) {
  if (!res) return "";
  if (typeof res === "string") return res;
  const cand = [res.response, res.result, res.output, res.text, res.content];
  for (const c of cand) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const choices = res.choices || res.response?.choices || res.result?.choices;
  if (Array.isArray(choices) && choices[0]) {
    const c = choices[0].message?.content ?? choices[0].text;
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  for (const c of cand) {
    if (c && typeof c === "object") {
      const cc = extractContent(c);
      if (cc) return cc;
    }
  }
  return "";
}

// ---------- 1) 文本生成（Workers AI） ----------
async function generateStory(env, lang = "zh") {
  const isEn = lang === "en";
  const style = pick(isEn ? EN_STORY_STYLES : STORY_STYLES);
  const name = pick(isEn ? EN_BOY_NAMES : BOY_NAMES);
  const model = env.TEXT_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  const system = isEn
    ? `You are a warm older brother telling stories in the first person as a boy named "${name}". Rules:
1. Write a story of about 300 words in English, warm, positive, full of imagination, suitable for children and teens.
2. Absolutely no horror, gore, thriller, violence, supernatural, or dark content.
3. Today's tone is "${style}".
4. Output only this JSON, nothing else: {"title": "a title of 3-10 words", "story": "the story text"}`
    : `你是一位用男孩口吻讲故事的温柔哥哥。请始终以第一人称"我"（一个名叫"${name}"的男孩）的视角来讲述。
要求：
1. 故事约 300 字（中文），温暖、积极、充满想象力，适合少年与小朋友阅读。
2. 绝对禁止恐怖、血腥、惊悚、暴力、灵异、阴暗内容。
3. 今天的风格基调是「${style}」。
4. 只输出如下 JSON，不要任何额外解释文字：{"title": "8-15字标题", "story": "故事正文"}`;

  const userMsg = isEn ? "Please begin today's story." : "请开始今天的故事。";

  const res = await env.AI.run(model, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
    response_format: { type: "json_object" },
    temperature: 0.9,
    max_tokens: 1024,
  });

  const raw = extractContent(res);
  const text = String(raw || "").trim();

  let title = "";
  let story = "";

  // 1) 完整 JSON（兼容 story 为字符串/对象/数组等结构）
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") {
      for (const k of ["title", "Title", "标题"]) {
        if (typeof j[k] === "string" && j[k].trim()) { title = j[k].trim(); break; }
      }
      let s = j.story ?? j.Story ?? j.content ?? j.text ?? j.正文;
      if (s && typeof s === "object" && !Array.isArray(s)) s = s.text ?? s.story ?? s.content ?? "";
      if (Array.isArray(s)) s = s.join("\n");
      if (typeof s === "string") story = s.trim();
    }
  } catch {}

  // 2) 兜底：从「残缺/被截断的 JSON」里正则抠出 title / story
  if (!title) {
    const m = text.match(/"title"\s*:\s*"([^"]*)"/);
    if (m) title = m[1].trim();
  }
  if (!story) {
    const m = text.match(/"story"\s*:\s*"([\s\S]*)/);
    if (m) story = m[1].replace(/["}\s]+$/, "").trim();
  }

  // 3) 兜底：中文「标题/正文」标记
  if (!title) {
    const m = text.match(/标题[：:]\s*([^\n]{2,30})/);
    if (m) title = m[1].trim();
  }
  if (!story) {
    const m = text.match(/正文[：:]\s*([\s\S]+)/);
    if (m) story = m[1].trim();
  }

  // 4) 最后兜底：去掉可能的 JSON 包装头尾，只留正文
  if (!story) {
    story = text
      .replace(/^\s*\{?\s*"title"\s*:\s*"[^"]*"\s*,\s*"story"\s*:\s*"/, "")
      .replace(/["}\s]+$/, "")
      .trim();
  }
  if (!title) title = isEn ? `${name}'s ${style}` : `${name}的${style}`;

  return { title: title.trim(), story: story.trim(), style, name, lang };
}

// ---------- 2) TTS（Microsoft Edge TTS，免费） ----------
// 返回 MP3 字节（Uint8Array）；lang: "zh" | "en"
async function edgeTts(text, voice, lang = "zh") {
  const xmlLang = lang === "en" ? "en-US" : "zh-CN";
  const gec = await secMsGec();
  const wsUrl =
    `${EDGE_WSS}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}` +
    `&ConnectionId=${uuidHex()}`;

  const headers = {
    "Upgrade": "websocket",
    "User-Agent": EDGE_UA,
    "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "Cookie": `muid=${uuidHex().toUpperCase()};`,
    "Accept-Language": "en-US,en;q=0.9",
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
  };

  const resp = await fetch(wsUrl, { headers });
  if (!resp.webSocket) {
    throw new Error(`Edge TTS 握手失败 (HTTP ${resp.status})`);
  }
  const ws = resp.webSocket;
  ws.accept();

  // 发送 speech.config + SSML
  ws.send(
    `X-Timestamp:${dateToString()}\r\n` +
      "Content-Type:application/json; charset=utf-8\r\n" +
      "Path:speech.config\r\n\r\n" +
      '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
      '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
      '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
  );
  ws.send(
    `X-RequestId:${uuidHex()}\r\n` +
      "Content-Type:application/ssml+xml\r\n" +
      `X-Timestamp:${dateToString()}Z\r\n` +
      "Path:ssml\r\n\r\n" +
      mkssml(text, voice, xmlLang)
  );

  const chunks = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Edge TTS 超时")), 40000);
    ws.addEventListener("message", (evt) => {
      if (typeof evt.data === "string") {
        const m = /^Path:\s*(\S+)/m.exec(evt.data);
        if (m && m[1] === "turn.end") {
          clearTimeout(timer);
          resolve();
        }
        return;
      }
      // 二进制音频帧：前 2 字节头长，头 [2, 2+hl]，音频 [2+hl, ...]
      const bytes = new Uint8Array(evt.data);
      if (bytes.length < 2) return;
      const hl = (bytes[0] << 8) | bytes[1];
      const audio = bytes.slice(2 + hl);
      if (audio.length) chunks.push(audio);
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Edge TTS WebSocket 错误"));
    });
  });

  const total = chunks.reduce((s, c) => s + c.length, 0);
  if (total === 0) throw new Error("Edge TTS 未返回音频");
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out; // MP3 字节
}

// ---------- 3) Telegram 推送 ----------
async function sendText(env, chatId, text) {
  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const r = await fetch(`${base}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!r.ok) throw new Error(`sendMessage(${chatId}) failed: ${await r.text()}`);
  return r;
}
async function sendAudio(env, chatId, caption, mp3Bytes) {
  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("audio", new File([mp3Bytes], "story.mp3", { type: "audio/mpeg" }));
  const r = await fetch(`${base}/sendAudio`, { method: "POST", body: form });
  if (!r.ok) throw new Error(`sendAudio(${chatId}) failed: ${await r.text()}`);
  return r;
}

// ---------- 主流程 ----------
async function runOnce(env, { force = false, chatIds = null, lang = "zh" } = {}) {
  const today = beijingDate();
  const targets = chatIds && chatIds.length ? chatIds : getChatIds(env);

  if (!targets.length) return { error: "TELEGRAM_CHAT_IDS 未配置", date: today };

  if (!force) {
    const last = await env.STORY_KV.get("last_date");
    if (last === today) return { skipped: true, reason: "already sent today", date: today };
  }

  const isEn = lang === "en";
  const meta = await generateStory(env, lang);
  const voice = isEn
    ? (env.TTS_VOICE_EN || "en-US-GuyNeural")        // 英文男声（Guy，年轻男声）
    : (env.TTS_VOICE || "zh-CN-YunxiaNeural");       // 中文男孩声（云夏）
  const caption = isEn
    ? `🎧 ${meta.title}\n【Style: ${meta.style}】`
    : `🎧 ${meta.title}\n【风格：${meta.style}】`;

  // 音频失败时降级为纯文本，保证推送不中断
  let audioOk = false;
  let audioError = null;
  try {
    const mp3 = await edgeTts(meta.story, voice, lang);
    for (const id of targets) {
      await sendAudio(env, id, caption, mp3);
      await sendText(env, id, meta.story);
    }
    audioOk = true;
  } catch (e) {
    audioError = e?.message || String(e);
    console.error("[tts] Edge TTS 失败，降级为纯文本：", audioError);
    const note = isEn ? "\n\n(Audio generation failed, text only)" : "\n\n（音频生成失败，仅发送文本）";
    for (const id of targets) {
      await sendText(env, id, `${caption}\n\n${meta.story}${note}`);
    }
  }

  await env.STORY_KV.put("last_date", today);
  await env.STORY_KV.put("latest", JSON.stringify({ ...meta, date: today, audioOk }));

  return {
    ok: true,
    date: today,
    lang,
    style: meta.style,
    title: meta.title,
    chars: meta.story.length,
    audio: audioOk,
    audioError,
    voice,
    sentTo: targets,
  };
}

// ---------- Telegram webhook ----------
async function handleWebhook(env, body) {
  const msg = body?.message || body?.edited_message;
  if (!msg?.text || msg.chat?.id == null) return { ignored: true, reason: "no text" };
  const chatId = msg.chat.id;
  // 去掉可能携带的 @botusername 后缀
  const cmd = msg.text.trim().split("@")[0].trim();

  let lang = null;
  if (cmd === "/story-en" || cmd === "/en" || cmd === "/enstory") lang = "en";
  else if (cmd === "/story" || cmd === "/start") lang = "zh";
  if (!lang) return { ignored: true, reason: "not a trigger command" };

  if (!isAuthorized(env, chatId)) {
    await sendText(env, chatId, "抱歉，你没有权限触发故事～");
    return { denied: true, chatId };
  }
  const reply = lang === "en"
    ? "Got it! Writing today's English story, one moment…"
    : "收到，正在为你写今天的故事，稍等…";
  await sendText(env, chatId, reply);
  return { triggered: true, chatId, lang };
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runOnce(env).catch((e) => console.error("[scheduled]", e)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/test") {
      if (!isAdmin(request, env)) {
        return new Response(
          JSON.stringify({ error: "未授权：/test 需要 token（未配置 ADMIN_TOKEN 或 token 错误）。日常请用 Telegram /story 触发。" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      try {
        const lang = url.searchParams.get("lang") === "en" ? "en" : "zh";
        const r = await runOnce(env, { force: true, lang });
        return new Response(JSON.stringify(r, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e?.message || String(e), stack: e?.stack }, null, 2),
          { headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (path === "/latest") {
      const v = await env.STORY_KV.get("latest");
      return new Response(v || "{}", { headers: { "Content-Type": "application/json" } });
    }

    if (path === "/webhook" && request.method === "POST") {
      const secret = env.TG_WEBHOOK_SECRET;
      if (secret) {
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (got !== secret) return new Response("unauthorized", { status: 401 });
      }
      const body = await request.json();
      const ack = await handleWebhook(env, body);
      if (ack.triggered) {
        ctx.waitUntil(
          runOnce(env, { force: true, chatIds: [ack.chatId], lang: ack.lang }).catch((e) =>
            console.error("[webhook]", e)
          )
        );
      }
      return new Response(JSON.stringify({ ok: true, ...ack }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("004-少年夜话 Worker is running.", { status: 200 });
  },
};
