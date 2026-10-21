# Morrow 模型与上下文调研（截至 2026-10-20，第三轮）

> 目的：保持设置里的模型清单与上下文窗口为近期版本。以下信息来自官方文档 / 官方 API / 权威模型库；
> 模型迭代很快，设置页提供「刷新可用模型」在运行时校准（DeepSeek 的 `/models` 已验证提供精确元数据）。

## 一、各家当前旗舰（2026-10-20）

| 提供方 | 模型 ID | 名称 | 上下文 | 最大输出 | 发布/核验 |
|---|---|---|---|---|---|
| DeepSeek | `deepseek-flash` | DeepSeek V4.1 Flash | 1,048,576 | 393,216 | 官方 `/v1/models` 实测（2026-10-19），名称 `DeepSeek-V4.1-Flash` |
| DeepSeek | `deepseek-v4-pro` | DeepSeek V4 Pro | 1,048,576 | 393,216 | 官方 `/v1/models` 实测（2026-10-19） |
| OpenAI | `gpt-6.1-sol` | GPT-6.1 Sol | 1,050,000 | 128,000 | 官方模型页（默认旗舰）；2026-10-09 发布 |
| OpenAI | `gpt-6-astra` | GPT-6 Astra | 1,050,000 | 128,000 | 官方模型页；2026-09-04 发布，复杂推理旗舰 |
| OpenAI | `gpt-6-sol` / `gpt-6-luna` | GPT-6 Sol / Luna | 1,050,000 | 128,000 | 2026-10-09 发布 |
| Anthropic | `claude-fable-5-1` | Claude Fable 5.1 | 1,000,000 | 128,000 | 2026-09-01 发布；长程编程与复杂任务，自适应思考默认开启 |
| Anthropic | `claude-opus-5-5` | Claude Opus 5.5 | 1,000,000 | 128,000 | 2026-09-22 发布（当前正式版） |
| Anthropic | `claude-sonnet-5-5` | Claude Sonnet 5.5 | 1,000,000 | 128,000 | 2026-09-28 |
| Anthropic | `claude-haiku-5-5` | Claude Haiku 5.5 | 1,000,000 | 128,000 | 2026-10-07 |
| Google | `gemini-4-argon` | Gemini 4 Argon | 1,048,576 | 65,536 | 2026-09-30 发布 / 2026-10-13 上线；1M 输入，API 默认 65K 输出（长解码可到 1M） |
| Google | `gemini-3.8-flash` | Gemini 3.8 Flash | 1,048,576 | 65,536 | 2026-10 最新 Flash；官方迁移文档目标模型串 `gemini-3.8-flash` |
| 智谱 | `glm-5.3` | GLM-5.3 | 1,000,000 | 128,000 | 官方文档 2026-10-15：1M 上下文 / 128K 输出，始终思考 |
| 智谱 | `glm-5.3-flash` | GLM-5.3 Flash | 1,000,000 | 128,000 | 2026-10-15 发布，原生多模态（320B / 18B 激活） |
| xAI | `grok-4.7` | Grok 4.7 | 500,000 | 65,536 | 2026-09-21 发布；官方未列输出上限，按 64K 估算 |
| xAI | `grok-4.1-fast` | Grok 4.1 Fast | 2,000,000 | 65,536 | 上一代长上下文档位 |
| Kimi | `kimi-k3` | Kimi K3 | 1,000,000 | 65,536 | 2026-07-16 发布，2.8T MoE，原生视觉 |
| Kimi | `kimi-k2.7-code` / `kimi-k2.6` | Kimi K2.7 Code / K2.6 | 262,144 | 65,536 | 2026 稳定版本 |
| 通义千问 | `qwen3.8-max` | Qwen3.8 Max | 1,000,000 | 65,536 | 2026 年最新旗舰（阿里云百炼） |
| 通义千问 | `qwen3.8-flash-next` | Qwen3.8 Flash Next | 1,000,000 | 65,536 | 2026-08-26 开源；Qwen4 同源架构，高性价比 |
| 小米 MiMo | `mimo-v2.6-pro` | MiMo V2.6 Pro | 1,048,576 | 131,072 | 2026-09-22 发布；官方模型页标注 1M / 128K |
| 小米 MiMo | `mimo-v2.6-flash` | MiMo V2.6 Flash | 1,048,576 | 131,072 | 2026-09-22 发布；官方模型页标注 1M / 128K |
| Meta | `muse-spark-1.3` | Muse Spark 1.3 | 1,048,576 | 131,072 | 2026-09-02 发布；Meta Model API（OpenAI 兼容），1M 上下文 |
| MiniMax | `MiniMax-M3` | MiniMax M3 | 1,000,000 | 512,000 | 2026-06 发布；1M 上下文 / 长输出，擅长代码与 Agent 任务 |
| MiniMax | `MiniMax-M3.1-Flash` | MiniMax M3.1 Flash | 1,000,000 | 65,536 | 2026-09/10 最新轻量版；1M 上下文 |

## 二、接口地址（OpenAI 兼容优先）

| 提供方 | Base URL | 说明 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | 官方 OpenAI 兼容；`/models` 提供精确上下文/输出元数据 |
| Anthropic | `https://api.anthropic.com` | Morrow 使用原生 Messages 协议 |
| OpenAI | `https://api.openai.com/v1` | 官方 |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | 官方 OpenAI 兼容层 |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 阿里云百炼 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | 国内；国际 `https://api.z.ai/api/paas/v4` |
| Kimi | `https://api.moonshot.cn/v1` | 国内；国际 `https://api.moonshot.ai/v1` |
| MiniMax | `https://api.minimax.io/v1` | 官方 OpenAI 兼容 |
| 小米 MiMo | `https://api.xiaomimimo.com/v1` | 官方 OpenAI 兼容 |
| Meta | `https://api.meta.ai/v1` | Meta Model API（OpenAI 兼容） |
| xAI | `https://api.x.ai/v1` | 官方 OpenAI 兼容 |
| OpenRouter | `https://openrouter.ai/api/v1` | 聚合，模型 ID 用 `vendor/model` |
| Ollama | `http://127.0.0.1:11434/v1` | 本地，模型 ID 以 `ollama list` 为准 |
| LM Studio | `http://127.0.0.1:1234/v1` | 本地，模型 ID 以 LM Studio 加载为准 |

## 三、上下文与用量修正

- **上下文上限**：内置 provider 的 `models` 每次启动都以代码内最新数据为准（旧设置缓存会被覆盖）。
- **用量精度**：优先使用服务商返回的真实 `prompt_tokens + completion_tokens` 作为当前上下文占用；
  没有 usage 时才回退字符估算。标题栏、设置「上下文」页与 API 账单口径一致。
- **自动压缩可配置**：设置 → 上下文 支持自动压缩开关与阈值（默认 80%），并可手动 `/compact`。
- **同步模型列表**：设置 → 模型 → 「刷新可用模型」会读取 `/models` 的
  `context_window` / `max_output_tokens` 等字段覆盖本地预设；DeepSeek 已验证返回精确元数据。
- **本地模型**：Ollama / LM Studio 无需 API Key；模型 ID 可在设置里自定义。

## 四、主要来源

- DeepSeek V4 Preview 官方公告：<https://api-docs.deepseek.com/news/news260424>（并以 `/v1/models` 实测为准）
- OpenAI 模型页：<https://developers.openai.com/api/docs/models>；GPT-6.1 Sol：<https://developers.openai.com/api/docs/models/gpt-6.1-sol>；GPT-6 Astra：<https://developers.openai.com/api/docs/models/gpt-6-astra>
- Anthropic Claude 时间线：<https://github.com/jqueryscript/anthropic-claude-timeline>；Claude 5.5 迁移指南：<https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-5-5>
- Gemini 4 Argon 公告：<https://9to5google.com/2026/09/30/gemini-4-argon-announcement/>（API 限额参考 <https://docs.litellm.ai/blog/gemini-4-argon>）；Gemini 3.8 Flash 官方文档：<https://ai.google.dev/gemini-api/docs/latest-model>
- 智谱 GLM-5.3 官方文档：<https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3>；发布记录：<https://docs.bigmodel.cn/cn/update/new-releases>
- xAI Grok 4.7 文档：<https://docs.x.ai/docs/models/grok-4.7>（及 <https://apidog.com/blog/what-is-grok-4-7/>）
- Kimi 模型参数：<https://platform.kimi.com/docs/api/models-overview>
- 通义千问 Model Studio：<https://help.aliyun.com/en/model-studio/what-is-model-studio>
- MiniMax 文本生成 / Codex 文档：<https://platform.minimax.io/docs/guides/text-generation>、<https://platform.minimax.io/docs/m-plan/codex>
- 小米 MiMo V2.6：<https://mimo.mi.com/models/zh-CN/mimo-v2.6-flash>、<https://mimo.mi.com/models/en-US/mimo-v2.6-pro>、<https://mimo.mi.com/docs/en-US/price/pay-as-you-go>
- Meta Muse Spark 1.3：<https://dev.meta.ai/models/muse-spark>、<https://www.promptfoo.dev/docs/providers/meta/>
- Claude Fable 5.1：<https://platform.claude.com/docs/en/models/fable-5-1/overview>
- Qwen3.8 Flash Next：<https://www.alibabacloud.com/blog/qwen3-8-flash-next-a-new-architecture-towardsultimate-cost-efficiency_603501>

## 五、数据时效说明

- 更新时间：2026-10-20（第三轮：新增小米 MiMo V2.6 Pro/Flash、Meta Muse Spark 1.3、Claude Fable 5.1、MiniMax M3、Qwen3.8 Flash Next；移除已过时的 Qwen Plus 与 MiniMax M2.5）。
- 输出上限等未在官方公开页面明确给出的字段按保守值估算，并在设置页支持「刷新可用模型」以服务商返回为准。
- 未纳入官方正式版的灰度模型不写入预设，避免误导。
