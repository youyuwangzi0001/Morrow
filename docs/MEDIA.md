# 多媒体与引擎

> 本文为中文文档；英文概览见 [README.md](../README.md)。

Morrow 的图片、视频、配音与配乐有两条链路：云端服务与本地引擎。云端需要你自己的 API Key，本地需要自行安装 ComfyUI、FFmpeg 或 TTS。两条链路都不会用占位图或假音频冒充结果。

## 设置里的两条链路

![设置 · 本地与多媒体](screens/guide-settings-media.png)

- **模型页只接云端**：文本模型与“云端多媒体生成”的图片、视频、配音、配乐四类页签。
- **本地页集中所有本地能力**：Ollama、llama.cpp、LM Studio、ComfyUI、FFmpeg、本地 TTS 与本地配乐草稿。
- 没有保存 Key 的云端服务不会显示为可用，也不会被创作台调用。
- 每张服务卡片标注“国内”或“海外”，方便选择可直连的服务。

![模型页中的国内与海外多媒体服务](screens/settings-cloud-media.png)

![本地模型与本地媒体引擎](screens/settings-local.png)

## 云端服务

只接入有公开官方文档、能实际调用的接口；未验证的平台不会以“可选”形式出现。

| 类型 | 地区 | 服务 | 默认模型 |
|---|---|---|---|
| 图片 | 国内 | 火山方舟 Seedream 5.0 Pro | `doubao-seedream-5-0-pro-260628` |
| 图片 | 国内 | 火山方舟 Seedream 5.0 Flash | `doubao-seedream-5-0-flash-260915` |
| 图片 | 国内 | 阿里云百炼 Qwen-Image 2.1 Pro | `qwen-image-2.1-pro` |
| 图片 | 海外 | OpenAI Images 2.6 Sunburst | `gpt-image-2.6-sunburst` |
| 图片 | 海外 | OpenAI Images 2.6 Flare | `gpt-image-2.6-flare` |
| 图片 | 海外 | Gemini Nano Banana 2.1 | `gemini-nano-banana-2.1` |
| 图片 | 海外 | Stability SD3.5 | `sd3.5-large` |
| 视频 | 国内 | 火山方舟 Seedance 2.5 | `doubao-seedance-2-5-260628` |
| 视频 | 国内 | 火山方舟 Seedance 2.0 | `doubao-seedance-2-0-260128` |
| 视频 | 国内 | MiniMax H3 | `MiniMax-H3` |
| 视频 | 海外 | Google Veo 3.1 | `veo-3.1-generate-001` |
| 配音 | 国内 | 阿里云百炼 Qwen3-TTS-Flash | `qwen3-tts-flash` |
| 配音 | 国内 | MiniMax Speech 2.8 HD | `speech-2.8-hd` |
| 配音 | 海外 | OpenAI TTS | `gpt-4o-mini-tts` |
| 配音 | 海外 | ElevenLabs TTS | `eleven_v4` |
| 配乐 | 国内 | 昆仑万维 Mureka V9.5 | `auto` |
| 配乐 | 海外 | ElevenLabs Music | `music_v2_5` |

已保存的旧默认模型（`gpt-image-1`、`veo-3.1-generate-preview`、`eleven_multilingual_v2`、`music_v2`）会在读取设置时迁移到当前默认值；你自己填过的其他模型 ID 不会被覆盖。

官方音色已写入声线选择器：OpenAI TTS 13 个、Qwen3-TTS-Flash 48 个、MiniMax Speech 2.8 327 个。ElevenLabs 的音色属于账号私有资源，需要填 Voice ID。

## 本地引擎

| 能力 | 引擎 | 说明 |
|---|---|---|
| 图片、视频、章节配图 | ComfyUI | 需要工作流与模型；未连接时真实失败 |
| 本机视觉审看 | llama.cpp / Ollama / LM Studio | 优先当前对话模型，失败才回退本地视觉模型 |
| 配音 | Qwen3-TTS 本机 / Windows SAPI | 声线取决于本机安装 |
| 配乐 | ComfyUI ACE-Step | `local` 只生成草稿并明确标注 |
| 剪辑、转码、封面、波形 | 本机 FFmpeg | 不随包内置，许可证由用户选择 |

Ollama、llama.cpp、LM Studio 也可以直接作为文本对话模型，见 [MODELS.md](MODELS.md#本机模型)。

## 创作台怎么用

- **图片**：有已保存 Key 的云端图片服务时，分镜图片优先走云端，其次才是 ComfyUI；产物记为 `origin.source = cloud-image`，临时链接会立即下载为本地素材。
- **视频**：Seedance 与 MiniMax H3 会把当前分镜图作为首帧；Seedance 默认 `generate_audio=false`，避免与后续配音、配乐重复。Veo 使用 4 / 6 / 8 秒档位，Seedance 与 MiniMax 限制在 4–15 秒。
- **配音**：有云端配音服务时优先使用；Qwen3-TTS 默认 Cherry 音色，ElevenLabs 需要 Voice ID。本地声线 ID 不会传给云端。
- **配乐**：有 ElevenLabs Music 时优先于 ComfyUI ACE-Step；否则保持本地配乐流程。
- 没有云端 Key 就不会发起云端请求；云端已配置时，离线引擎不会阻塞云端链路。

## 计费、Key 与边界

- 云端费用属于你自己的服务商账号；Morrow 只显示服务与模型，不估算具体价格。
- Key 走本地加密存储，不写入渲染层状态或项目文件。
- 图片目前只做文生图；云端参考图编辑尚未接入，参考图工作流仍使用本地 ComfyUI。
- 云端服务是经过核对的官方列表，不是全量市场；实际可用性、额度与商用授权以你的账号为准。

官方参考：

- Seedream / Seedance：<https://www.volcengine.com/docs/82379/1541523>
- Qwen-Image / Qwen3-TTS：<https://help.aliyun.com/zh/model-studio/qwen-image-api>
- MiniMax H3 / Speech：<https://platform.minimax.cn/docs/guides/video-generation>
- Mureka：<https://platform.mureka.cn/docs/cn/quickstart.html>
- OpenAI Images / TTS：<https://platform.openai.com/docs/guides/image-generation>
- Gemini / Veo：<https://ai.google.dev/gemini-api/docs/image-generation>
- Stability：<https://platform.stability.ai/docs/api-reference>
- ElevenLabs：<https://elevenlabs.io/docs/api-reference/text-to-speech/convert>