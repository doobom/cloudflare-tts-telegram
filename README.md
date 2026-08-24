# 004-少年夜话

一个部署在 **Cloudflare Workers** 上的定时任务：每天 **北京时间 20:00** 自动生成一段
「男孩第一人称」视角的 ~300 字故事，用 **中文男声 TTS（云夏，男孩音色）** 合成音频，
连同文本一起推送到 **Telegram**（支持多个 Chat）。

> 维护人：沐弦 ｜ 创建：2026-08-24 ｜ 状态：🟢 已上线
> Worker：`https://story-boy-cast.xxxxxx.workers.dev` ｜ Cron：`0 12 * * *`（UTC = 北京 20:00）

---

## 功能要点

| 需求 | 实现 |
|------|------|
| 部署到 Cloudflare Worker | 单 Worker，`wrangler deploy` |
| 用 Cloudflare AI | Workers AI 生成故事文本（`@cf/meta/llama-3.3-70b-instruct-fp8-fast`） |
| 中文男声 TTS | Microsoft Edge TTS（免费、无需 key），男声 `zh-CN-YunxiaNeural`（云夏，男孩音） |
| 推送到 Telegram | Bot API `sendAudio`（MP3）+ `sendMessage`，支持多 Chat ID |
| 每天定时 300 字故事 + 音频 | `scheduled()` + Cron `0 12 * * *`（= 北京 20:00，中国无夏令时） |
| 风格随机、排除恐怖 | 10 种温暖风格池，system 指令禁止恐怖/血腥/惊悚/暴力/灵异 |
| 男孩的语音 | 文本用男孩第一人称口吻写 + 男声（云夏）朗读 |
| 标题+风格标签 | 音频 caption 带「标题 + 风格」 |
| Telegram 手动触发 | 给机器人发 `/story` 或 `/start` 立即生成推送（webhook） |
| HTTP 手动触发 | `GET /test?token=<ADMIN_TOKEN>` 立即试发（强制，绕过防重发；需 token 鉴权） |
| KV 存档防重发 | KV 记录「最近发送日期」，同一天 Cron 只发一次；`/latest` 查最近一期 |

---

## 目录结构

```
004-少年夜话/
├── src/index.js        # Worker 主逻辑（故事生成 + Edge TTS + Telegram）
├── wrangler.toml       # 部署配置（AI/KV/变量/Cron）
├── package.json
├── .gitignore
├── .dev.vars.example   # 本地变量模板
├── docs/设计说明.md     # 设计细节与可调整项
└── output/             # 预留产出目录
```

---

## 一、准备凭证

### 1) Telegram Bot
- 找 `@BotFather` → `/newbot` 创建机器人，拿到 **Bot Token**。
- 拿 **Chat ID**（个人用 `@userinfobot`；群/频道先加机器人发一条，再用
  `https://api.telegram.org/bot<TOKEN>/getUpdates` 查 `chat.id`）。

### 2) Cloudflare 账号
- 注册/登录 Cloudflare，进入 **Workers & Pages**，记下 **Account ID**。
- 创建 API Token：My Profile → API Tokens → `Edit Cloudflare Workers` 模板。
- 本地登录：`npx wrangler login`（或设 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）。
- Workers AI 需绑定支付方式（免费额度内）。

---

## 二、配置与部署

```bash
cd 004-少年夜话
npm install                # 安装 wrangler

# 1. 创建 KV 命名空间，把 id 填进 wrangler.toml 的 STORY_KV.id
npx wrangler kv namespace create STORY_KV

# 2. 写入 Telegram Bot Token（secret）
npx wrangler secret put TELEGRAM_BOT_TOKEN
# 3. 写入 /test 鉴权 token（secret，可选：不配置则 /test 禁用）
npx wrangler secret put ADMIN_TOKEN
# 4. 在 wrangler.toml [vars] 里配置 TELEGRAM_CHAT_IDS（逗号分隔，支持多个）

# 5. 部署
npx wrangler deploy
```

部署后 Cron 自动生效。**注册 Telegram webhook**（`/story` 手动触发用）：

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/webhook&secret_token=<TG_WEBHOOK_SECRET>"
```

---

## 三、本地调试

```bash
cp .dev.vars.example .dev.vars   # 填入真实 token / chat ids / ADMIN_TOKEN
npx wrangler dev
curl "http://localhost:8787/test?token=<ADMIN_TOKEN>"   # 立即触发一次（需 token）
curl http://localhost:8787/latest                       # 最近一期
```

---

## 四、可调整项（见 docs/设计说明.md）

- **文本模型** `TEXT_MODEL`：默认 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`；
  未开放则改 `@cf/meta/llama-3.1-8b-instruct`。
- **男声音色** `TTS_VOICE`：默认 `zh-CN-YunxiaNeural`（云夏，男孩）；
  也可改 `zh-CN-YunxiNeural`（云希，青年男）等 Edge TTS 中文男声。
- **风格池 / 男孩名字池**：`src/index.js` 顶部 `STORY_STYLES` / `BOY_NAMES`。
- **故事长度 / 推送时间**：改 prompt 中的字数、`wrangler.toml` 的 `crons`（仍按 UTC 写）。

---

## 五、已知限制

- **Edge TTS 属非官方免费接口**：无 key、无需注册，但微软可能调整协议；若失效，
  需替换 TTS（或用回 Cloudflare AI 的中文 TTS）。
- **Workers 外连 WebSocket**：需用 `https://` + `Upgrade: websocket`（`wss://` 会被 fetch 拒绝）。
- 音频为 MP3（48kbps mono），一期约 100–300KB，Telegram `sendAudio` 直接播放。
