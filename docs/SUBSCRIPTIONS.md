# 模型订阅

> 设置 → 订阅。把已经在用的官方 Agent 账号或第三方 coding plan 接入 Morrow，按订阅额度调用；登录态只保存在本机，不经过 Morrow 服务器。

## 1. 支持范围

| 渠道 | 登录 / 导入 | 上游协议 | 额度 | 当前验证 |
|---|---|---|---|---|
| ChatGPT / Codex | 本机 `~/.codex/auth.json` 只读导入、浏览器 OAuth | Responses（本地代理转换为 Chat Completions） | `/backend-api/wham/usage` | 真实账号验证（登录、额度、Agent 工具调用、重启恢复） |
| Qoder | PAT、浏览器设备流、本机 qodercli 导入 | Qoder COSY 专用信封 | `/api/v2/quota/usage` | 协议单测 + UI；本机无 Qoder 账号 |
| Kimi Code | RFC 8628 设备码（中国站 / 全球区） | OpenAI Chat Completions | `/coding/v1/usages` | 协议单测 + UI；本机无 Kimi 账号 |
| GLM Coding Plan | ZCode 浏览器轮询登录 → 兑换 Coding Plan Key | Anthropic Messages | `/api/monitor/usage/quota/limit` | 协议单测 + UI；本机无 GLM 账号 |
| MiniMax Code | 设备码 + PKCE、本机 `~/.minimax/auth/.../auth.json` 导入 | Anthropic Messages | `/v1/api/openplatform/coding_plan/remains` | 协议单测 + UI；本机无 MiniMax 账号 |
| Step Plan | 云端轮询登录、静态 API Key、本机 StepCode 导入 | OpenAI Chat Completions | 需要平台网页会话（Oasis Token），本版只展示账号与模型 | 协议单测 + UI；本机无 Step 账号 |
| Command Code | 浏览器领取长期 Key、手动粘贴 Key | Claude → Anthropic Messages；其余 → OpenAI Chat Completions | `/alpha/whoami` + `/alpha/billing/credits` | 协议单测 + UI；本机无 Command Code 账号 |
| Cline Pass | WorkOS 设备码、静态 API Key | OpenAI Chat Completions | `/users/me/plan/usage-limits` | 协议单测 + UI；本机无 Cline 账号 |
| Google Antigravity | Google OAuth（PKCE + 本机回调） | Gemini `streamGenerateContent` 专用信封 | `retrieveUserQuotaSummary` | 协议单测 + UI；本机无 Google 账号 |
| OpenCode | 本机 `auth.json` 导入、Zen API Key | OpenAI Chat Completions | Zen 没有公开额度接口，页面如实说明 | 协议单测 + UI；本机无 OpenCode 账号 |
| 第三方 coding plan | 名称 + 协议 + baseUrl + token + 模型 ID | OpenAI / Anthropic 兼容 | 不做统一抓取 | 已实现并运行 |

> 「未实机验证」指本机没有对应账号，只完成了真实端点实现、协议单测与 UI 验证；没有把未连接显示成已连接，也没有编造额度。首次登录成功与否以服务商真实响应为准。

## 2. 每条链路的共同结构

1. **登录 / 导入**：设备码、浏览器 OAuth、浏览器轮询、静态 Key 或本机凭据导入。
2. **加密存储**：Electron `safeStorage`（Windows DPAPI）加密后写入数据目录；渲染层只拿到脱敏账号信息。
3. **刷新**：有 refresh token 的渠道做单飞刷新并先落盘轮换后的 refresh token；静态 Key 渠道（GLM / Step / Command Code / OpenCode）不伪造刷新。
4. **本地 Provider**：在 `127.0.0.1` 起回环代理，注册为 `openai-compat` 或 `anthropic` Provider，随机本地 token 鉴权。
5. **真实请求**：文本、流式、工具调用都走上游真实端点；协议不兼容的渠道写专用代理。
6. **额度 / 账号状态**：能读到的显示真实窗口；读不到就显示原因，不发明数字。
7. **重启恢复**：应用启动时从加密凭据恢复代理与 Provider；删除订阅会同时删除凭据和 Provider。

## 3. 各渠道接入方式

### 3.1 ChatGPT / Codex

- 导入本机 Codex CLI 登录（只读 `~/.codex/auth.json` 或 `$CODEX_HOME/auth.json`），或浏览器 OAuth（`localhost:1455`）。
- `codex-proxy.ts` 把 OpenAI Chat Completions 请求转换为 Codex Responses，流式与工具调用原样回放。
- 额度显示套餐、5 小时 / 每周窗口与重置时间。

### 3.2 Qoder

- 三种入口：PAT 兑换、全球区浏览器设备流、本机 qodercli 登录只读导入。
- `qoder-proxy.ts` 处理 COSY 1.1.72 头签名、请求体 alphabet 编码、`RemoteChatAsk` 信封与信封 SSE。
- 区域必须与账号一致；中国站与全球区端点不同。

### 3.3 Kimi Code

- 设备码登录（`auth.kimi.com` / `auth.kimi.ai`），client_id 为官方 CLI 公共客户端；区域决定后续所有端点。
- 上游是 `api.kimi.com/coding` 的 OpenAI Chat Completions；请求会强制 `max_completion_tokens`、思考开启，并给 assistant 消息补齐 `reasoning_content`。
- 额度读取 `usages` 的 5 小时 / 每周 / 每月窗口。

### 3.4 GLM Coding Plan（ZCode）

- 浏览器轮询登录（`zcode.z.ai/api/v1/oauth/cli/init` + `poll`），拿到 OAuth access token 后兑换 Coding Plan Key：
  1. 国际区先 `POST /api/auth/z/login` 换业务 token；中国区直接用 OAuth token；
  2. `getCustomerInfo` 定位默认机构 / 项目；
  3. 找或创建本线路专属 Key（`morrow-glm-coding-plan`），取 `secretKey`，拼成 `{id}.{secret}`；
  4. 用配额接口验证后才落盘。
- 模型面走 Anthropic Messages（`/api/anthropic/v1/messages`），同时发送 `x-api-key` 与 `Authorization: Bearer`；思考开关发 `thinking:{type:'enabled'}`，深度用顶层 `reasoning_effort`（GLM-5.3 为 low/high/max，GLM-5.2 为 high/max，Turbo 不发）；额度接口用裸 Key（不加 Bearer）。
- GLM 没有 refresh 交换接口；Coding Plan Key 是长期凭据，失效时重新登录。中国区兑换链在上游文档中不如国际区明确，失败会显示服务商原因。

### 3.5 MiniMax Code

- 设备码 + PKCE（`account.minimax.cn` / `account.minimax.io`），Bearer access token；到期前单飞刷新。
- 也可只读导入本机 `~/.minimax/auth/prod/<region>/mcode-public/auth.json`。
- 推理走 `agent.minimax.cn/mavis/api/v1/llm/v1/messages`（Anthropic Messages）；思考深度用顶层 `output_config.effort`，M3 用 `thinking:{type:'adaptive'}` 选择思考通道，M3.1 不发 thinking 对象；额度走 `api.minimax.cn` 的 `coding_plan/remains`（国际区为 `.io`）。

### 3.6 Step Plan

- 云端轮询登录（`platform.stepfun.com` / `.ai`），或直接粘贴 Step API Key，或导入本机 `~/.stepcode/auth.json`。
- 凭据是静态 API Key，不刷新；登录时读取 `/v1/models` 建立 Provider 模型目录，并把思考档位吸附到模型支持列表。
- 推理走 OpenAI Chat Completions（`api.stepfun.com/step_plan/v1/...` 或开放平台 `/v1/...`）；开放平台 base 在拼接前会去掉重复的 `/v1`。
- Step Plan 的额度接口需要平台网页会话（Oasis Token）；本版不伪造额度，页面会明确说明。

### 3.7 Command Code

- 浏览器领取长期 Key：本地回调从 `127.0.0.1:5959` 起探测 1024 个端口，校验 `state` 后接收 `apiKey`；也支持手动粘贴。
- 保存前用 `GET /alpha/whoami` 校验；额度读 `/alpha/billing/credits`。
- 模型目录来自公开的 `/provider/v1/models`；`claude-*` 走 Anthropic Messages，其余走 OpenAI Chat Completions，两个 Provider 共用一个回环代理。
- 仅支持 `/chat/completions` 或 `/messages` 的模型会被列出；只支持 Responses 的模型不会伪装成可用。

### 3.8 Cline Pass

- WorkOS 设备码登录，`register` 换取 Cline 会话；推理用 `Bearer workos:<access>`。
- 刷新会轮换 refresh token，先落盘再使用；也支持静态 Cline API Key。
- 上游是 OpenAI Chat Completions；非流式 `{success,data}` 外壳会被解包，模型 ID 自动补 `cline-pass/` 前缀。

### 3.9 Google Antigravity

- Google OAuth（PKCE + 本机回调，默认 51121 起探测），换取 access/refresh token；新账号会尝试免费档 onboarding 取得 project。
- `antigravity-subscription.ts` 在本地完成 OpenAI Chat Completions ↔ Gemini `streamGenerateContent` 翻译：
  - 消息、系统提示、图片与工具调用转换为 Gemini `contents` / `functionCall` / `functionResponse`；
  - 按模型和思考档位选择运行时 ID；Claude/gpt-oss 的工具调用带 `id` 与 `thoughtSignature` 回放标记；
  - SSE 的文本、思考、工具调用与 usage 再转回 OpenAI chunk。
- 额度读 `retrieveUserQuotaSummary`，把剩余比例换算成已用百分比。
- 开源源码不内置 Google OAuth client secret：从源码构建时需设置环境变量 `MORROW_ANTIGRAVITY_CLIENT_SECRET`；官方安装包已内置该配置，无需设置。

### 3.10 OpenCode

- 只读导入本机 `~/.local/share/opencode/auth.json`（或 `XDG_DATA_HOME/opencode/auth.json`）里的 `type:"api"` 密钥，优先 OpenCode Zen 的键；不会冒用 Copilot / Codex 的 OAuth 记录。
- 也可手动粘贴 OpenCode Zen API Key（`oc_sk_...`）。保存前用模型目录或一次最小真实请求校验，401/403 直接拒绝。
- 推理走 `https://opencode.ai/zen/v1` 的 OpenAI Chat Completions。
- Zen 没有公开额度接口；页面如实说明余额以控制台为准。

### 3.11 第三方 coding plan

- 添加名称、协议（OpenAI Chat Completions / Anthropic Messages）、接口地址、token、模型 ID。
- 自动注册为自定义 Provider，可测试、启停、删除。适合尚未内置或自建网关的兼容服务。

## 4. 安全与边界

- 所有 token 使用系统凭据加密（Windows DPAPI）落盘；不写入日志、Provider 配置或渲染层 store。
- 回环代理只绑定 `127.0.0.1`，要求随机本地 Bearer token；本地 token 与上游 token 分离。
- 本机凭据导入一律只读，不改写官方客户端文件；官方客户端轮换凭据后需要重新导入。
- 浏览器回调都校验 `state`；Command Code 回调限制来源与请求体大小。
- 不做 Claude 登录；不代充、不共享账号、不绕过服务商限流。
- 订阅登录与第三方客户端使用仍受服务商条款约束，风险由用户自行确认。

## 5. 架构

```
设置 → 订阅 (SubscriptionTab)
        │ feature:subscriptions:status / action
        ▼
SubscriptionService（Codex / Qoder / 第三方）
  └─ Agent 注册表 agent-subscriptions.ts
       ├─ kimi-subscription      → subscription-relay（OpenAI）
       ├─ glm-subscription       → subscription-relay（Anthropic）
       ├─ minimax-subscription   → subscription-relay（Anthropic）
       ├─ step-subscription      → subscription-relay（OpenAI）
       ├─ command-code-subscription → subscription-relay（双 wire）
       ├─ cline-subscription     → subscription-relay（OpenAI + JSON 解包）
       ├─ antigravity-subscription → 专用 Gemini 翻译代理
       └─ opencode-subscription  → subscription-relay（OpenAI）
        │
        ▼
SettingsStore.saveProvider / removeProvider
        │
        ▼
现有 Provider / Agent 循环（模型选择器、工具、压缩、权限全部复用）
```

关键文件：

| 文件 | 作用 |
|---|---|
| `src/shared/subscriptions.ts` | 订阅状态、额度、账号、IPC 动作类型 |
| `src/main/services/agent-subscriptions.ts` | 8 个 Agent 渠道的统一注册表与动作分派 |
| `src/main/services/agent-subscription-common.ts` | 加密凭据、Provider 注册、测活、本机文件工具 |
| `src/main/services/agent-protocol-utils.ts` | 协议层纯函数（可独立单测） |
| `src/main/services/subscription-relay.ts` | 回环转发器：鉴权注入、401 刷新、请求/JSON 响应改写 |
| `src/main/services/subscriptions.ts` | Codex / Qoder / 第三方订阅与总状态 |
| `src/main/services/codex-proxy.ts` / `qoder-proxy.ts` | 两套专用协议转换 |
| `src/renderer/src/features/settings/SubscriptionTab.tsx` | 订阅卡片、详情、登录/导入/额度 UI |

## 6. 使用

1. 设置 → 订阅，选择要连接的渠道。
2. 按渠道选择浏览器登录、设备码、粘贴 Key 或本机导入；首次连接会校验凭据真实性。
3. 连接后查看账号、额度与模型；可测试连接、启停、重新登录或移除。
4. 在对话模型选择器选择「渠道名（订阅）」及其模型。
5. 额度读不到时会显示原因；以服务商控制台为准。

## 7. 已知限制

- 除 ChatGPT/Codex 外，其余渠道在本机没有真实账号，未做 live 调用；已完成真实端点实现、协议单测和 UI 验证。
- Step Plan 额度需要 Oasis 网页会话，本版只展示账号与模型，不显示额度数字。
- OpenCode Zen 没有公开额度接口，只展示账号与模型。
- GLM 中国区兑换链依赖上游未公开接口，失败时会给出明确原因。
- 单账号；暂不提供多账号池、轮换或粘性调度。
- 本地代理只在 Morrow 运行时存在；对话期间需要保持 Morrow 运行。
