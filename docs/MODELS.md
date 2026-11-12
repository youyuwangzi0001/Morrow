# 模型与订阅

> 本文为中文文档；英文概览见 [README.md](../README.md)。

这页解决两件事：模型怎么接进来、它的思考档位与上下文为什么是这样；已有的官方 Agent 账号或 coding plan 怎么接到本机。它不教具体操作步骤，界面流程见 [用户指南](USER-GUIDE.md#输入框与运行中的操作)；本机媒体模型见 [多媒体](MEDIA.md)。

## 目录

- [一次请求用哪个模型](#一次请求用哪个模型)
- [内置模型目录](#内置模型目录)
- [思考档位如何生效](#思考档位如何生效)
- [上下文与输出预算](#上下文与输出预算)
- [从服务商同步模型](#从服务商同步模型)
- [本机模型](#本机模型)
- [订阅渠道](#订阅渠道)
- [订阅的安全与失败处理](#订阅的安全与失败处理)
- [常见问题](#常见问题)

## 一次请求用哪个模型

一次请求的模型由三处决定，后者依次收敛：

1. 会话的 `ModelRef`（Provider + Model）；
2. Provider / 模型的能力元数据（视觉、思考档位、上下文档位、最大输出）；
3. 会话级上下文覆盖（用户选择了上下文档位时）。

模型选择器只显示已启用且已保存 Key 或登录态的 Provider，并显示原始模型名，不加“限免 / 订阅 / 上下文”等后缀。

## 内置模型目录

目录维护在 `src/shared/models.ts`，数据截至 2026-10-26；设置页可以从服务商同步并覆盖上下文与输出上限。

| 家族 | 模型 | 上下文 | 最大输出 | 思考档位 |
|---|---|---:|---:|---|
| DeepSeek | V4.1 Flash | 1,000,000 | 393,216 | off / low / high / max |
| DeepSeek | V4 Pro | 1,000,000 | 393,216 | high / max |
| Kimi | K3.1 Pro / K3 / K2.8 Preview | 1,048,576 | 65,536 | low / high / max |
| Qwen | Qwen3.8 Max / Flash Next | 1,000,000 | 65,536 | low / medium / xhigh |
| Anthropic | Claude Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 | 1,000,000 | 128,000 | low / medium / high / xhigh / max |
| OpenAI | GPT-6.1 Sol / GPT-6 Astra / GPT-6 Sol / GPT-6 Luna | 1,050,000 | 128,000 | low / medium / high / xhigh / max |
| Google | Gemini 4 Argon / 3.8 Flash | 1,048,576 | 65,536 | low / medium / high |
| 智谱 | GLM-5.3 / GLM-5.3 Flash | 1,000,000 | 128,000 | low / high / max |
| MiniMax | M3.1 Flash / M3 | 1,000,000 | 65,536 / 512,000 | low / medium / high / xhigh / max |
| 小米 | MiMo V2.6 Pro / Flash | 1,048,576 | 131,072 | 仅自动（族规则未公开） |
| Meta | Muse Spark 1.3 | 1,048,576 | 131,072 | low / medium / high / xhigh |
| xAI | Grok 4.7 / 4.6 | 500,000 | 65,536 | low / medium / high / xhigh |

几点约定：

- **DeepSeek** 官方用 `none` 表示关闭思考，Morrow 统一显示 `off`。直接连接 DeepSeek 时请求层把 `off` 映射为 `none`；Qoder 代理保持自己的 `off`。
- **GLM-5.2** 不在官方 API 模型列表内，Morrow 不提供。
- **未知模型**只显示“自动”，不猜测档位；旧设置里的非法档位在请求前回退为 `auto`，避免上游 400。
- 价格表只用于成本估算，不是账单依据；服务商未返回用量时会标记为估算。

## 思考档位如何生效

| Provider 类型 | 请求字段 | 说明 |
|---|---|---|
| OpenAI 兼容（effort） | `reasoning_effort` | 只发送模型声明的档位；DeepSeek 直接 Provider 的 `off` → `none` |
| Anthropic（thinking） | `thinking.budget_tokens` | low 1024 / medium 4096 / high 8192 / xhigh 16384 / max 32768；`off` 不发送 thinking；强制 `temperature=1` |
| 未知或不支持 | 不发送 | UI 只显示“自动”或“不支持思考” |

模型请求前会做安全收敛：如果会话保存了当前模型不支持的档位（例如在 DeepSeek 上保存了 `medium`），自动回退到 `auto`。

## 上下文与输出预算

- 会话级 `contextWindow` 只能夹在 1,024 与模型上限之间。
- 上下文环、设置页与请求使用同一个有效值：`ModelRef.contextWindow ?? ModelInfo.defaultContextWindow ?? ModelInfo.contextWindow`。
- OpenAI 兼容网关通过 `x-morrow-context-window` 接收会话级覆盖；Anthropic 不使用该头。
- 自动压缩默认在 80% 触发；上下文更大不代表应该塞满。压缩只在完整消息边界执行，保留首条用户锚点与当前请求。
- 最大输出只影响请求预算，不代表服务端一定允许。例如 Qoder 固定 32768，Anthropic 的思考会额外占用 budget。
- 重试只针对 408 / 409 / 425 / 429 / 5xx 与网络错误，最多 3 次，退避 800 / 2000 / 5000ms；只有在尚未产出任何内容时重试，abort 立即停止。

## 从服务商同步模型

设置页可“从服务商同步模型列表”：

- 请求 `/models`，单次最多读取 200 个；
- 读取 `context_window` / `context_length`、`max_output_tokens`、`reasoning_efforts`、`reasoning_effort_support_list` 与视觉标记；
- 上下文夹在 1,024–10,000,000，输出夹在 1–2,000,000；
- 服务商没有返回的字段保留本地值，不用猜测值覆盖；
- 名称去重，无效条目会计数并如实提示。

Step、Command Code、OpenCode 与自定义 OpenAI 兼容网关优先使用真实 `/models` 元数据；失败时回退内置预设。

## 本机模型

- **llama.cpp**：模型 ID 必须与 `--alias` 一致；视觉审看需要 `--mmproj`；默认 64K 上下文、16K 输出。
- **Ollama / LM Studio**：默认模型 ID 只是示例，需要改成真实加载的模型 ID；本机服务允许空 Key。
- 能力以 Provider 配置中的 `supportsVision` / `supportsReasoning` / `reasoningEfforts` 为准；未知模型只显示“自动”。
- 媒体审看只选择声明视觉能力的本地模型或 Coder390 预设，不会拿任意文本模型冒充视觉模型。

## 订阅渠道

![设置 · 订阅：ChatGPT/Codex 与 Qoder 等官方账号接入](guide/screens/06-subscriptions-dark.png)

| 渠道 | 登录或导入 | 模型目录 | 额度 |
|---|---|---|---|
| ChatGPT / Codex | 本机 `~/.codex/auth.json` 只读导入；内置浏览器 OAuth（回调 `localhost:1455`） | 内置 10 个（384K / 272K） | `/backend-api/wham/usage` 的 5 小时、每周与 credits |
| Qoder | PAT、设备流 PKCE、本机 qodercli 只读导入 | 账号 `/model/list`，实测 15 个 chat 模型、200K / 400K / 1M | `/api/v2/quota/usage` |
| Kimi Code | RFC 8628 设备码（中国区 / 国际区） | 6 个，1M / 256K | `/coding/v1/usages` 的 5 小时、每周、每月 |
| GLM Coding Plan | ZCode 浏览器轮询 → 专用 Key | 3 个，1M / 200K | `/api/monitor/usage/quota/limit` |
| MiniMax Code | 设备码 + PKCE；本机 auth 导入 | 4 个，1M / 200K | `coding_plan/remains` |
| Step Plan | 云端轮询、粘贴 Key、本机 auth | `/v1/models` 实时 | 只有账号与模型，无数字额度 |
| Command Code | 浏览器回调或手贴 Key | `/provider/v1/models`，失败回退预设 | `/alpha/billing/credits` |
| Cline Pass | WorkOS 设备码或静态 Key | 14 个预设，无思考档位 | `/users/me/plan/usage-limits` |
| Google Antigravity | Google OAuth PKCE + 本机回调（需环境 secret） | 9 个 | `retrieveUserQuotaSummary` |
| OpenCode | 本机 auth 只读导入或手贴 Key | 实时 `/models`，失败回退 5 个 | Zen 无公开额度接口 |
| 第三方 coding plan | 名称、协议、Base URL、Key、模型 ID | 自定义 | 按服务商，不统一抓取 |

### Qoder 的账号驱动目录

Qoder 没有静态模型表。登录或恢复后读取 `GET /algo/api/v2/model/list?Encode=1`：

- 场景 `chat` → `assistant` → `app`，跳过 `enable:false`；
- `key` 作为模型 ID，`display_name` 作为显示名；
- `is_vl` 为视觉能力，`is_reasoning` / `thinking_config` 为思考能力；
- `context_config.*` 的 `token_count` 与 `is_default` 决定上下文档位与默认值；
- 没有档位时回退 200K；输出硬顶 32768。

实测账号返回 15 个 chat 模型，上下文档位为 200K / 400K / 1M，默认 200K。设置页可逐模型调整默认上下文；会话里再选覆盖值时，通过 `x-morrow-context-window` 传给 Qoder 代理，代理夹到模型上限并写入 `model_config.max_input_tokens`。

## 订阅的安全与失败处理

所有订阅链路大致相同：

```text
登录/导入 → 凭据加密落盘 → 账号/额度校验 → 模型目录 → 本地回环代理 → Provider
```

- 凭据使用 Electron `safeStorage`（Windows DPAPI）加密；渲染层只看到账号与“已保存”，不接触明文。
- 模型请求走 `127.0.0.1` 随机端口的本地代理，要求随机本地 Bearer；上游 token 与本地 token 分离。
- 401/403 只刷新一次后重试；刷新先落盘再使用。
- 登录窗口是内置 `BrowserWindow`，登录 session 有自己的导航白名单，不会把登录页交给系统浏览器。
- 官方接口失败时显示真实错误，不把“未连接”写成“已连接”，也不编造额度。
- Antigravity 不内置 Google OAuth client secret；未设置 `MORROW_ANTIGRAVITY_CLIENT_SECRET` 时登录入口直接提示缺少配置。
- 各渠道的端点、请求头签名、加密信封与刷新细节在 `src/main/services/*-protocol.ts`；本文只记录用户可见的登录方式、模型目录与额度来源。

**验证范围**：本机只有 Qoder 与 Codex 有可用真实账号，完成了登录、额度与真实对话调用；其余渠道验证了登录页、协议单测与端点实现，未完成本机账号登录实测，因此不宣称“支持全部额度显示”。

## 常见问题

**模型下拉是空的？** Provider 未启用、没有 Key 或登录态，或模型 ID 为空。先保存 Key 并测试连接。

**为什么选不了 medium？** 当前模型没有 medium 档，这是真实能力而不是 UI 缺失；Morrow 不会把不支持的档位发给上游。

**上下文上限为什么不可调？** 该模型没有声明可调档位。Qoder 账号目录和部分 `/models` 返回档位的 Provider 才开放。

**Qoder 模型名为什么变了？** 目录来自账号接口，可能随账号或服务端更新；Morrow 不硬编码名称。

**DeepSeek 选 off 为什么不报错？** 请求层把 `off` 映射为官方 `none`；Qoder 代理继续使用 `off`。

**订阅显示已登录但不能用？** 查看设置页的真实错误与额度。官方接口变化、端口被占用或区域不匹配都会返回具体原因，按 [排障指南](TROUBLESHOOTING.md#订阅) 处理。