# 订阅接入

Morrow 可以把已有的官方 Agent 账号或 coding plan 接到本机，用订阅额度驱动 Agent。所有登录态只保存在本机；Morrow 不代充、不共享账号、不绕过限流。

## 1. 支持范围

| 渠道 | 登录方式 | 模型目录 | 额度/状态 | 备注 |
|---|---|---|---|---|
| ChatGPT / Codex | 本机 `~/.codex/auth.json` 只读导入；内置浏览器 OAuth | 内置 10 个（384K/272K） | `/backend-api/wham/usage` 5h/周/credits | 回调 `localhost:1455`，应用退出后代理关闭 |
| Qoder | PAT、全球区设备流 PKCE、本机 qodercli 只读导入 | 账号 `/algo/api/v2/model/list`，实测 15 个 chat 模型 | `/api/v2/quota/usage` | 区域必须匹配；`max_tokens` 硬顶 32768 |
| Kimi Code | RFC 8628 设备码（中国/国际区） | 6 个，1M/256K | `/coding/v1/usages` 5h/周/月 | 强制思考，补 reasoning_content |
| GLM Coding Plan | ZCode 浏览器轮询 → 专用 Key | 3 个，1M/200K | `/api/monitor/usage/quota/limit` | Anthropic Messages 双鉴权；Key 长期 |
| MiniMax Code | 设备码 + PKCE；本机 auth 导入 | 4 个，1M/200K | `coding_plan/remains` | M3/M3.1 思考方式不同 |
| Step Plan | 云端轮询、粘贴 Key、本机 auth | `/v1/models` 实时 | 仅账号/模型 | 额度需 Oasis 网页会话，无数字 |
| Command Code | 浏览器回调或手贴 Key | `/provider/v1/models`，失败回退预设 | `/alpha/billing/credits` | Claude 走 Messages，其余 OpenAI |
| Cline Pass | WorkOS 设备码或静态 Key | 14 个预设 | `/users/me/plan/usage-limits` | 非流式 `{success,data}` 解包 |
| Google Antigravity | Google OAuth PKCE + 本机回调 | 9 个 | `retrieveUserQuotaSummary` | 不内置 OAuth secret；需环境变量 |
| OpenCode | 本机 auth 只读导入或手贴 Key | 实时 `/models`，回退 5 个 | Zen 无公开额度接口 | 只取 `type:"api"` 的 Zen Key |
| 第三方 coding plan | 名称/协议/Base URL/Key/模型 ID | 自定义 | 按服务商 | 只注册 Provider，不统一抓额度 |

## 2. 共同结构

每条订阅链路大致相同：

```text
登录/导入 → 凭据加密落盘 → 账号/额度校验 → 模型目录 → 本地回环代理 → Provider
```

- 凭据使用 Electron safeStorage（Windows DPAPI）加密；渲染层只看到账号与“已保存”，不接触明文。
- 模型请求走 `127.0.0.1` 随机端口的本地代理；代理要求随机本地 Bearer，上游 token 与本地 token 分离。
- 401/403 只刷新一次后重试；刷新先落盘再使用。
- 登录窗口是 Morrow 内置 BrowserWindow；登录 session 有自己的导航白名单，避免误把登录页交给系统 Edge。
- 官方接口失败时明确提示，不把“未连接”显示成“已连接”，也不编造额度。

## 3. 各渠道说明

### 3.1 ChatGPT / Codex

- 入口：设置 → 订阅 → ChatGPT/Codex。
- 方式一：只读导入本机 `~/.codex/auth.json` 或 `$CODEX_HOME/auth.json`；不修改官方文件。
- 方式二：内置浏览器 OAuth，回调固定 `localhost:1455`；重复点击会复用同一个登录 Promise，不会重复占用端口。
- 代理把 OpenAI Chat Completions 转成 Codex Responses；assistant 历史内容必须用 `output_text`，失败会转成明确错误。
- 额度接口显示套餐、5 小时/每周窗口与 credits。
- 代理随应用退出；本机 1455 被占用时会提示。

### 3.2 Qoder

- 三种入口：PAT 兑换、全球区浏览器设备流（PKCE + challenge）、本机 qodercli 登录只读导入（`~/.qoder/.auth/user` + `machine_id`）。
- 区域必须与账号一致；中国站与全球区端点不同。
- 模型目录实时读账号接口，不维护静态表；`context_config` 提供 200K/400K/1M，`thinking_config` 提供真实档位。
- COSY 1.1.72 头签名、请求体 alphabet 编码、RSA/AES runtime auth、`RemoteChatAsk` 信封与 SSE。
- 输出硬顶 32768；代理会再次截断 `max_tokens`。
- 设置页可逐模型调整上下文档位；会话中的上下文选择通过 `x-morrow-context-window` 生效。
- 额度读 `/api/v2/quota/usage`。

### 3.3 Kimi Code

- 设备码登录（`auth.kimi.com` / `auth.kimi.ai`），区域决定后续所有端点。
- 上游是 `api.kimi.com/coding` 的 OpenAI Chat Completions；请求强制 `max_completion_tokens`、开启思考、补齐 `reasoning_content`。
- 模型 K3/K3.1 Pro/K2.8/for Coding/256K/高速变体；上下文 1,048,576 或 262,144。
- 额度读 `usages` 的 5 小时/每周/每月窗口。
- 单飞刷新：并发请求只触发一次刷新。

### 3.4 GLM Coding Plan（ZCode）

- 浏览器轮询登录（`zcode.z.ai/api/v1/oauth/cli/init` + `poll`）。
- 国际区先用 `POST /api/auth/z/login` 换业务 token；中国区直接用 OAuth token。
- `getCustomerInfo` 定位默认机构/项目，找或创建专用 Key `morrow-glm-coding-plan`，取 `secretKey`，拼成 `{id}.{secret}`，配额校验后落盘。
- 模型面走 Anthropic Messages（`/api/anthropic/v1/messages`），同时发送 `x-api-key` 与 `Authorization: Bearer`。
- GLM-5.3 思考 low/high/max；不支持思考的 Turbo 不发；GLM-5.2 不在官方 API 列表，Morrow 不提供。
- 额度接口用裸 Key（不加 Bearer）。
- Key 长期有效，无 refresh；中国区兑换链依赖未公开接口。

### 3.5 MiniMax Code

- 设备码 + PKCE，或导入 `~/.minimax/auth/prod/<region>/mcode-public/auth.json`。
- 按区域选择 Messages 前缀；代理转发。
- M3 使用 `thinking:adaptive`；M3.1 只发 `output_config.effort`；M2.7 不发思考。
- 额度读 `coding_plan/remains`。

### 3.6 Step Plan

- 云端轮询、粘贴 Key、导入 `~/.stepcode/auth.json` 等三路径。
- 模型实时读 `/v1/models`，读取 `max_input_tokens` 与 `reasoning_effort_support_list`；失败复用上次目录。
- 额度需 Oasis 网页会话，只显示账号/模型，不给数字。

### 3.7 Command Code

- 浏览器领取长期 Key，回调从 `127.0.0.1:5959` 探测 1024 端口并校验 `state`；也可手贴 Key。
- `/alpha/whoami` 校验；目录 `/provider/v1/models`，失败回退预设。
- `claude-*` 走 Anthropic Messages，其余走 OpenAI Chat Completions，两个 Provider 共用一个回环代理。
- 仅 Responses 的模型跳过；额度 `/alpha/billing/credits`。

### 3.8 Cline Pass

- WorkOS 设备码 → `/auth/register` 换取会话；`Bearer workos:`；refresh 先落盘再使用。
- 也支持静态 Key，并以 `/users/me/plan/usage-limits` 校验。
- OpenAI 兼容；模型补 `cline-pass/` 前缀；非流式 `{success,data}` 解包。
- 预置 14 个模型，未声明思考档位，UI 只有 auto；额度读 usage-limits。

### 3.9 Google Antigravity

- Google OAuth PKCE + 本机回调，从 51121 起探测端口；新账号 `onboardUser` 免费档取 project。
- 专用代理完成 Chat Completions ↔ Gemini `streamGenerateContent` 翻译，工具调用带 `id/thoughtSignature` 回放。
- 9 个模型；按模型 + effort 选 runtime ID。
- **不内置 Google OAuth client secret**：源码/构建需设置 `MORROW_ANTIGRAVITY_CLIENT_SECRET`，否则登录入口直接提示缺少配置。
- 额度 `/v1internal:retrieveUserQuotaSummary`，剩余比例换算已用。

### 3.10 OpenCode

- 只读导入 `~/.local/share/opencode/auth.json`（或 `XDG_DATA_HOME`），仅取 `type:"api"`，优先 Zen Key。
- 手贴 Key 先用 `/models` 或一次最小真实请求校验；401/403 拒绝。
- `https://opencode.ai/zen/v1` OpenAI 兼容；模型可实时拉取，失败回退 5 个预设。
- Zen 无公开额度接口，页面如实说明。

### 3.11 第三方 coding plan

设置 → 订阅 → 第三方，填写名称、协议、Base URL、token、模型 ID，注册为自定义 Provider；可测试、启停、删除。Morrow 不统一抓取额度。

## 4. 安全边界

- 所有订阅凭据加密保存；日志与渲染层不出现明文 token。
- 回环代理只监听 `127.0.0.1`，要求本地随机 Bearer。
- 回调校验 `state`；Command Code 还限制 CORS 与请求体大小。
- 本机导入只读，不改写官方客户端文件。
- Antigravity secret 永不写入源码或发布包。
- 订阅请求仍受模型服务自身的条款与限流约束；Morrow 不绕过。

## 5. 已知限制

- 本机没有可用账号的渠道（Kimi、GLM、MiniMax、Step、Command Code、Cline、Antigravity、OpenCode）只完成协议单测、登录页与真实端点实现，未伪造额度。
- 官方接口可能变化；失败时以设置页/日志中的真实错误为准。
- 部分服务不提供公开额度接口（Step、OpenCode），页面不会显示数字。
- ChatGPT/Codex 的 1455 端口、Qoder/Step/GLM 的轮询流程都依赖本机环境；被防火墙/代理拦截时需先排查网络。

## 6. 相关文档

- [模型与思考档位](MODELS.md)
- [多媒体与本地模型](MEDIA-MODELS.md)
- [安全与隐私](SECURITY-PRIVACY.md)
- [排障指南](TROUBLESHOOTING.md)
