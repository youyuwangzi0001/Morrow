# 模型与思考档位

Morrow 把“模型是什么、能看什么、能想多深、能吃多长上下文”当作运行时元数据，而不是 UI 常量。本文说明内置目录、Qoder 账号目录、同步规则与常见边界。

## 1. 选择顺序

一次请求的模型由三处决定：

1. 会话的 `ModelRef`（Provider + Model）；
2. Provider/模型的能力元数据（视觉、思考档位、上下文档位、最大输出）；
3. 会话级上下文覆盖（如果用户选择了上下文档位）。

模型选择器只显示已启用且已保存 Key/登录态的 Provider；显示原始模型名称，不加“限免/订阅/上下文”等营销后缀。

## 2. 内置 API 预设

当前内置目录（`src/shared/models.ts`）：

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

说明：

- **DeepSeek** 官方使用 `none` 表示关闭思考；Morrow UI 统一显示 `off`。直接 DeepSeek Provider 会把 `off` 映射为 `none`；Qoder 代理仍按自己的 `off` 处理。
- **GLM-5.2** 不在官方 API 模型列表内，Morrow 不提供该型号。
- **未知模型**只显示“自动”，不猜测档位；旧设置中的非法档位在请求前回退 `auto`。
- 价格表只用于成本估算，不是账单依据。

## 3. Qoder 账号驱动目录

Qoder 订阅没有静态模型表。登录/恢复后读取账号接口：

```text
GET /algo/api/v2/model/list?Encode=1
```

解析：

- 场景 `chat` → `assistant` → `app`；跳过 `enable:false`；
- `key` 作为模型 ID，`display_name` 作为显示名；
- `is_vl` → 视觉能力；`is_reasoning` / `thinking_config` → 思考能力；
- `context_config.*` 的 `token_count` 与 `is_default` → 上下文档位与默认值；
- `available_context_windows`、`max_input_tokens`、`default_context_window` 作为补充；
- 没有档位时回退 200K。

实测账号返回 15 个 chat 模型，上下文档位为 **200K / 400K / 1M**，默认 200K。设置页可逐模型调整默认上下文；会话中再选择覆盖值时，请求通过 `x-morrow-context-window` 传给 Qoder 代理，代理夹到模型上限并写入 `model_config.max_input_tokens`。Qoder 的 `max_tokens` 硬顶为 32768。

## 4. 模型同步

对支持的 Provider，设置页可“从服务商同步模型列表”：

- 请求 `/models`（最多 200 个）；
- 读取 `context_window/context_length`、`max_output_tokens`、`reasoning_efforts`、`reasoning_effort_support_list`、视觉标记等；
- 上下文夹在 1,024–10,000,000，输出夹在 1–2,000,000；
- Provider 没有返回的字段保留本地值；
- 名称去重，无效条目计数并如实提示。

Step、Command Code、OpenCode、自定义 OpenAI 兼容网关等都会优先使用真实 `/models` 元数据；失败时回退内置预设。

## 5. 思考档位如何生效

| Provider 类型 | 请求字段 | 说明 |
|---|---|---|
| OpenAI 兼容（effort） | `reasoning_effort` | 只发送模型声明的档位；DeepSeek 直接 Provider 的 off→none |
| Anthropic（thinking） | `thinking.budget_tokens` | low 1024 / medium 4096 / high 8192 / xhigh 16384 / max 32768；off 不发送 thinking；temperature=1 |
| 未知/不支持 | 不发送 | UI 只显示“自动”或“不支持思考” |

模型请求前会做安全收敛：如果历史会话保存了当前模型不支持的档位（例如在 DeepSeek 上保存了 medium），自动回退到 `auto`，避免上游 400。

## 6. 上下文与输出

- 会话级 `contextWindow` 只能夹在 1,024 与模型上限之间。
- 上下文环、设置页和请求使用同一个有效值：`ModelRef.contextWindow ?? ModelInfo.defaultContextWindow ?? ModelInfo.contextWindow`。
- 自动压缩默认在 80% 触发；模型上下文越大，不代表应该塞满；压缩仍按完整消息边界执行。
- 最大输出只影响请求预算，不代表服务端一定允许；例如 Qoder 固定 32768，Anthropic 思考会额外预留 budget。

## 7. 本机模型

- **llama.cpp**：模型 ID 必须与 `--alias` 一致；Coder390 视觉审看需 `--mmproj`；默认 64K 上下文、16K 输出。
- **Ollama / LM Studio**：默认模型 ID 是占位符，需要改成真实加载的模型 ID；本机服务允许空 Key。
- 本地模型的能力以 Provider 配置里的 `supportsVision` / `supportsReasoning` / `reasoningEfforts` 为准；未知模型只显示“自动”。
- 媒体审看只选声明视觉能力的本地模型或 Coder390 预设，不会拿任意文本模型冒充视觉模型。

## 8. 常见问题

**为什么模型下拉是空的？** Provider 未启用、没有 Key/登录态，或模型 ID 为空。先保存 Key 并测试连接。

**为什么选不了 medium？** 当前模型没有 medium 档；这是真实能力，不是 UI 缺失。Morrow 不会把不支持的档位发给上游。

**为什么上下文上限不可调？** 该模型没有声明可调档位。Qoder 账号目录和部分 `/models` 返回档位的 Provider 才开放。

**为什么 Qoder 模型名变了？** Qoder 目录来自账号接口，可能随账号/服务端更新；Morrow 不硬编码名称。

**为什么 DeepSeek 选 off 没有报错？** 请求层会把 off 映射为 `none`；这是官方关闭思考的写法。Qoder 代理则继续使用 off。

## 9. 相关文档

- [订阅接入](SUBSCRIPTIONS.md)
- [多媒体与本地模型](MEDIA-MODELS.md)
- [模型能力调研与修正](verification/VERIFICATION.md#43-模型能力调研与修正)
