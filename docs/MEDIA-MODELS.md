# 多媒体与本地模型

Morrow 的多媒体层不是固定绑定 Qwen/MiniMax，而是“引擎 + 模型目录 + 工具”的开放结构。你可以使用内置预设、ComfyUI 工作流、llama.cpp GGUF、Ollama、LM Studio 或自定义 Provider。

## 1. 设计边界

- 生成/编辑/审看都必须使用真实引擎或模型；未就绪时如实报错，不伪造结果。
- 输入与输出必须位于工作区内；媒体产物写入 `media/images|videos|audio|edited|films|code`。
- 高影响操作（安装引擎、下载/拉取/卸载模型、启动/停止服务）受权限与审批约束。
- 本地模型的能力以 Provider 配置和模型清单为准；未知能力不猜测。

## 2. 引擎

| 引擎 | 启动/连接 | 说明 |
|---|---|---|
| ComfyUI | 填安装目录；`python main.py --listen 127.0.0.1 --port 8188 --reserve-vram 2.5` | 120 秒健康检查；支持原生节点与 API 工作流 |
| llama.cpp | 自动补 `-m/--host/--port/--alias` | 180 秒超时；只停止自己启动的进程；视觉需 `--mmproj` |
| Ollama | 本机 HTTP；支持安装、`pull/rm` | 不杀其他服务的模型 |
| LM Studio | 本机 HTTP；支持安装、`lms get/rm` | 同上 |

设置 → 多媒体可以检测引擎、显示版本/显卡/显存、安装目录、模型目录、ffmpeg 与超时。ComfyUI 目录为空时会探测常见安装位置；显式填写的目录优先。

## 3. 模型目录

内置预设：

| 模型 | 引擎 | 类型 | 能力 |
|---|---|---|---|
| Qwen-Image 2.1 Turbo | ComfyUI | 图片 | 文生图、图片编辑 |
| MiniMax-H3 16G HiFi | ComfyUI | 视频 | 文生视频、首尾帧、参考图 |
| Qwen3.8-27B-Coder390（视觉） | llama.cpp | 多模态 | 图片/视频帧审看、代码任务 |

模型清单字段包括：`id`、`label`、`engine`、`kind`、`capabilities`、`description`、`homepage`、`license`、`install`、`comfy`。用户清单保存在 `<dataDir>/media-models.json`，引擎配置在 `<dataDir>/media-engines.json`。

### 3.1 安装类型

- `files`：按 URL 下载到引擎模型目录，支持 `.part` + Range 续传、大小 ±1MB、SHA-256 校验、原子改名。
- `ollama`：`ollama pull/rm`。
- `lmstudio`：`lms get/rm`。
- `provider`：只登记已有 Provider 模型，不下载文件。
- `comfy`：ComfyUI API 工作流；可指定输出节点、输出类型、提示词节点。

路径必须是引擎模型目录内的安全相对路径，禁止 `..`、绝对路径和符号链接逃逸。卸载只删除清单声明且未被其他模型引用的文件。

### 3.2 应用内注册

设置 → 多媒体 → 添加本机模型：

- ComfyUI：粘贴 API 工作流 JSON，填写输出节点/输出类型/可选提示词节点；
- llama.cpp/Ollama/LM Studio：填写名称、模型 ID、上下文、输出、能力；
- 也可以导入 JSON 清单。

## 4. 生成工具

| 工具 | 能力 | 关键限制 |
|---|---|---|
| `generate_image` | 5 种尺寸；参考图改图（`<image1>`） | 图片 64–2048；默认超时 600s |
| `generate_video` | 16:9/9:16/1:1；fast/balanced/high；5–15s；首尾帧 | 视频默认超时 3600s |
| `generate_film` | 2–6 镜；Qwen 首帧 + MiniMax 视频 + 尾帧续接 + ffmpeg 拼接 | 每镜 5–10s |
| `render_animation` | 自包含 HTML + `window.renderAt(t)` 逐帧渲染 | 0.5–60s、8–30fps |
| `edit_media` | trim/crop/resize/rotate/flip/speed/mute/volume/extract_audio/extract_frame/gif/convert/concat | 先 inspect 再编辑 |
| `inspect_media` | ffprobe 宽高、时长、帧率、编码 | 只读 |
| `describe_media` | 图片/视频抽 1–4 帧审看 | 当前模型优先；本地需视觉能力 |

生成画面要具体写主体、动作、场景、光线、构图、风格；改图必须写清哪些部分保持不变；视频生成可能耗时数分钟，期间不要重复提交。

## 5. 审看优先级

![多媒体模型](guide/screens/08-media-models-dark.png)

`describe_media` 的顺序：

1. **当前对话模型**声明 `supportsVision`：直接用它；视觉请求关闭思考（DeepSeek off→none）并给 2048 输出预算；180 秒超时；
2. 当前模型不支持或失败：回退到声明视觉能力的本地模型；优先 Coder390 预设；
3. 两边都不可用：返回真实组合错误，并提示换支持图片的模型或启用带 `--mmproj` 的本地视觉模型。

不会用生图模型或纯文本模型冒充视觉审看；工具结果会标注是否 fallback。失败时 Agent 应如实说明，不得编造“看到了”。

## 6. ffmpeg

Morrow 不内置 ffmpeg。设置 → 多媒体可填 ffmpeg 路径；否则从 PATH 查找，ffprobe 取同目录。用于：

- 视频缩略图、抽帧；
- `edit_media` 的裁剪/拼接/转码/提取音频/GIF；
- `generate_film` 的尾帧续接与成片拼接；
- `inspect_media` 元数据。

ffmpeg 不可用时，图片/视频生成本身仍可能工作，但剪辑/拼接会明确报错。

## 7. 下载、显存与超时

- 模型下载先写 `.part`，完成后校验大小与 SHA-256；下载失败保留可续传片段。
- 16GB 显存下代码模型与视频模型通常需要分阶段执行；ComfyUI 启动参数保留 `--reserve-vram 2.5`。
- 图片默认 600 秒、视频默认 3600 秒超时；可在设置里调整。
- 引擎/模型安装、启动、下载与卸载属于高影响操作，必须走审批。

## 8. 安全与限制

- 引擎安装命令由清单显式声明，UI/工具会展示来源并要求确认。
- 模型文件路径限制在引擎目录内；媒体输入/输出限制在工作区内。
- 参考图上传 ≤40MB、回传图片 ≤120MB、视频 ≤1GB。
- 本机模型能否使用取决于硬件、显存、启动参数与 mmproj；未就绪时以真实错误为准。
- 具体模型许可见模型主页；Morrow 不改变第三方模型许可。

## 9. 相关文档

- [用户指南 · 多媒体](USER-GUIDE.md#10-多媒体与本地模型)
- [模型与思考档位](MODELS.md)
- [安全与隐私](SECURITY-PRIVACY.md)
- [排障指南](TROUBLESHOOTING.md)
