# 模型、订阅与多媒体

本文写清“Morrow 能用哪些模型、怎么选、订阅现在到底通没通、媒体引擎缺什么会怎样”。模型名称会随服务商更新；以设置页拉到的真实目录为准。

## 1. 选择顺序

Morrow 的文本模型选择顺序：

1. 当前对话/任务明确指定的模型；
2. 当前 Provider 的默认模型；
3. 设置里的“先用哪个模型”；
4. 本机服务（Ollama / llama.cpp / LM Studio）已配置的模型。

模型选择器只显示原始模型名；不把“快速/标准/深入”当成模型名。思考强度只列模型真实支持的档位；不支持时显示“不支持思考”；未知模型只保留“自动”。

## 2. 内置 Provider

| Provider | 协议 | 默认地址 | 说明 |
|---|---|---|---|
| DeepSeek | OpenAI 兼容 | `https://api.deepseek.com/v1` | 支持关闭思考（请求层映射 `none`） |
| Kimi（月之暗面） | OpenAI 兼容 | `https://api.moonshot.cn/v1` | K3/K3.1/K2.8 等 |
| Qwen（阿里云百炼） | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Qwen3.8 系列 |
| 智谱 GLM（Z.AI） | OpenAI 兼容 | `https://open.bigmodel.cn/api/paas/v4` | GLM-5.3 系列 |
| MiniMax | OpenAI 兼容 | `https://api.minimax.io/v1` | M3/M3.1 |
| MiMo（小米） | OpenAI 兼容 | `https://api.xiaomimimo.com/v1` | V2.6 系列 |
| Anthropic | 原生 Messages | `https://api.anthropic.com` | Claude 系列；不提供 Claude 登录订阅 |
| OpenAI | OpenAI 兼容 | `https://api.openai.com/v1` | GPT 系列 |
| Gemini | OpenAI 兼容 | `https://generativelanguage.googleapis.com/v1beta/openai/` | Gemini 系列 |
| xAI | OpenAI 兼容 | `https://api.x.ai/v1` | Grok 系列 |
| Meta | OpenAI 兼容 | `https://api.meta.ai/v1` | Muse 系列 |
| Ollama | OpenAI 兼容 | `http://127.0.0.1:11434/v1` | 本机；模型 ID 自己填 |
| llama.cpp | OpenAI 兼容 | `http://127.0.0.1:8000/v1` | 本机；需启用 server |
| LM Studio | OpenAI 兼容 | `http://127.0.0.1:1234/v1` | 本机；需启用 server |
| demo | 本地 | `local://demo` | 只用于演示/测试，不冒充真实模型 |

任意 OpenAI 兼容网关都可以通过“自定义 Provider”接入；Base URL 需要是 `/v1` 兼容地址。

![模型设置](guide/screens/05-settings-models-dark.png)

## 3. 思考档位

- OpenAI 兼容：`reasoning_effort`（模型支持时）。
- Anthropic：`thinking.budget_tokens`，1024–32768，`temperature=1`。
- DeepSeek：关闭思考在请求层映射官方 `none`；Qoder 代理保持自己的 `off`。
- 模型不支持思考时不显示档位；不要给所有模型硬塞“高/中/低”。

## 4. 上下文与输出

- 上下文窗口以模型元信息/服务商返回为准；Morrow 不维护一份永远正确的静态表。
- 接近窗口时先摘要压缩，再折叠大工具输出，最后紧急裁剪；保留用户任务锚点。
- 输出上限以模型官方 `maxOutput` 为准；结构化任务触达上限时报错，不返回半截 JSON。
- Qoder：登录后读取 `/algo/api/v2/model/list` 的模型、200K/400K/1M 档位与思考能力；Morrow 不维护 Qoder 静态模型表。

## 5. 本机模型

- **Ollama**：先 `ollama serve`，再在设置里填模型 ID（如 `qwen3:8b`）。
- **llama.cpp**：启动 `llama-server`，填 `http://127.0.0.1:8000/v1` 与模型 ID。
- **LM Studio**：开启 Local Server，填 `http://127.0.0.1:1234/v1`。
- 本机模型适合隐私/离线；能力、上下文与速度取决于你的显存和量化。
- 本机视觉模型用于媒体审看的回退；当前对话模型支持看图时优先当前模型。

## 6. 订阅

### 6.1 支持范围

ChatGPT/Codex、Qoder、Kimi Code、GLM Coding Plan、MiniMax Code、Step Plan、Command Code、Cline Pass、Google Antigravity、OpenCode，以及第三方 coding plan。**不提供 Claude 登录。**

### 6.2 当前真实状态

| 渠道 | 状态 |
|---|---|
| ChatGPT/Codex | 本机导入/OAuth 与用量接口可用 |
| Qoder | 账号模型目录/额度/代理与 UI 已实现；本机未完成登录实测，不声称已连通 |
| Kimi Code / GLM / MiniMax / Step / Command Code / Cline Pass / Antigravity / OpenCode | 登录页与协议实现完成；本机无可用账号，未验证已连通；不伪造额度 |
| 第三方 coding plan | 走自定义 Provider/兼容网关，取决于对方接口 |

Morrow 的原则：**没验证过的连通状态不显示“已连接”，不知道的额度写未知。** 订阅服务端接口可能变化；失败时给出可读错误，不偷偷切到别的渠道。

![订阅](guide/screens/06-subscriptions-dark.png)

### 6.3 Antigravity

不内置 OAuth secret。使用前设置 `MORROW_ANTIGRAVITY_CLIENT_SECRET`；没有配置时明确提示。

## 7. 多媒体与本地模型

### 7.1 设计边界

- 图片/视频/章节配图：ComfyUI；未就绪明确失败，不生成占位图。
- 配乐：ComfyUI ACE-Step；`local` 只生成草稿并明确标注，不算完成音乐阶段。
- 音效：本机合成雨声/伞骨/心跳/街声。
- 配音：云端 `/audio/speech`、Qwen3-TTS 本机声线、Windows SAPI；失败可导入配音。
- 合成：FFmpeg；不随包内置，许可证由用户选择。
- 审看：优先当前对话模型；不支持或失败才回退到声明视觉能力的本地模型；都没有时记录“未检查”，不冒充通过。

### 7.2 引擎

| 引擎 | 用途 | 配置 |
|---|---|---|
| ComfyUI | 图片、视频、章节配图、ACE-Step 配乐 | 地址/端口/模型/超时 |
| llama.cpp | 本机视觉审看 | server 地址与模型 |
| Ollama | 本机文本/视觉 | 地址与模型 |
| LM Studio | 本机文本/视觉 | 地址与模型 |
| Qwen3-TTS | 本机中文声线（5 个） | 模型/venv/Sox 就绪状态 |
| Windows SAPI | 系统声线兜底 | 系统语音 |
| FFmpeg | 合成/转码/抽帧 | 本机路径 |

### 7.3 媒体工具

- 图片生成/编辑、视频生成、抽帧、拼接、封面、章节配图。
- 时间线合成、字幕烧录、音轨导出、四格漫画、工程包。
- 媒体审看会把当前模型/本地视觉模型与结论写进检查项。

![多媒体设置](guide/screens/08-media-models-dark.png)

![人物语气与波形](guide/screens/26-studio-voice-audit-dark.png)

## 8. 联网搜索

- 通过当前模型服务或内置网页读取工具工作；网页内容按不可信数据处理。
- 研究模式保留来源；网页读取拒绝内网/本机地址（SSRF 防护），只允许 http(s)。
- 搜索结果不自动变成“事实”；报告里区分来源、推断与未知。

## 9. 密钥与安全

- API Key 用系统加密（DPAPI/safeStorage）保存；加密不可用时拒绝保存。
- 渲染层只看到“已保存”，拿不到明文。
- 订阅凭据与模型 Key 分开管理；清除后需要重新填写。
- 不要把 Key 写进提示词、日志或截图；反馈问题时先脱敏。

## 10. 常见问题

**Q：模型列表是空的？** 先填 Base URL 与 Key，点“测试连接/同步模型”；本机服务确认已启动。

**Q：为什么没有思考档位？** 该模型不支持，或服务商没有返回能力；未知模型只保留“自动”。

**Q：Qoder 为什么没有模型？** Qoder 需要账号登录后的模型目录；未完成登录实测时不显示假目录。

**Q：订阅显示未连接？** 以真实登录/额度接口为准；不要用共享 token 冒充已连接。

**Q：图片/视频失败？** 检查 ComfyUI 地址、端口、模型、显存；端口被占用时按提示回退。

**Q：配音失败？** 本机 Qwen3-TTS 未安装/模型未下载/受限令牌都会失败；可导入配音或改用云端 TTS。

**Q：FFmpeg 在哪？** 不随包内置；安装后到设置里配置路径。许可证由你选择的构建决定。
