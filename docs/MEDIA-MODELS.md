# 通用模型与引擎清单

> 目标：Morrow 不把 Qwen / MiniMax 写成唯一答案。图片、视频、音频、多模态模型，以及 ComfyUI、llama.cpp、Ollama、LM Studio 和自建引擎，都通过**可注册清单 + 统一生命周期**接入。

## 1. 设计边界

- **Morrow 不内置权重和推理引擎**，只负责检测、安装、启动/停止、下载/拉取、调用和卸载。
- **代码只认识能力与协议，不认识模型名**：
  - 图片/视频/音频模型：`comfyui`（文件 + 工作流）或原生媒体引擎；
  - GGUF：`llamacpp`（文件 + 启动参数）；
  - Ollama / LM Studio：`ollama` / `lmstudio`（CLI 拉取/删除 + OpenAI 兼容接口）；
  - 已有模型提供方：`provider`（不重复下载，交给设置 → 模型）。
- **内置预设**（Qwen-Image、MiniMax-H3、coder390 视觉）只是可编辑/可替换的起点，不是限制。
- **高影响操作必须审批**：安装引擎、下载/拉取模型、卸载文件、启动/停止服务均走当前权限档位；路径限制在引擎模型目录内。

## 2. 数据位置

| 内容 | 位置 |
|---|---|
| 用户模型清单 | `<userData>/media-models.json` |
| 用户引擎清单 | `<userData>/media-engines.json` |
| ComfyUI 模型 | `<ComfyUI>/models/...`（清单 `dest` 相对这个目录） |
| llama.cpp 模型 | `%LOCALAPPDATA%\Morrow\local-models\...` |
| Ollama / LM Studio | 由各自 CLI 管理，Morrow 不直接搬文件 |

内置预设不可删除；可以卸载文件，或注册同能力的新模型。自定义清单可移除，不影响已下载文件。

## 3. 引擎清单

```json
{
  "id": "my-engine",
  "label": "我的本地引擎",
  "kind": "custom",
  "capabilities": ["vision", "chat"],
  "detect": {
    "command": "my-engine",
    "args": ["--version"],
    "paths": ["C:/AI/my-engine/server.exe"],
    "healthUrl": "http://127.0.0.1:9999/health"
  },
  "install": {
    "kind": "winget",
    "wingetId": "Vendor.MyEngine",
    "note": "安装可能需要系统权限"
  },
  "service": {
    "start": { "command": "my-engine", "args": ["serve"], "detached": true },
    "stop": { "command": "my-engine", "args": ["stop"] },
    "healthUrl": "http://127.0.0.1:9999/health",
    "port": 9999
  },
  "modelDir": "C:/AI/models"
}
```

`install.kind` 支持：

| 类型 | 行为 |
|---|---|
| `winget` | 执行 `winget install --id <wingetId> -e --silent` |
| `download` | 下载 `url` 到 `<userData>/engines/<id>/`；`archive:"zip"` 时用 PowerShell 解压 |
| `command` | 执行清单中的 `command`/`args`（必须由用户/Agent 明确填写并审批） |

`kind` 决定适配范围：`comfyui`、`llamacpp`、`ollama`、`lmstudio`、`openai-compat`、`custom`。`healthUrl` 用于运行状态，检测命令/固定路径任一命中视为已安装。

## 4. 模型清单

```json
{
  "id": "flux1-dev",
  "label": "FLUX.1 dev",
  "engine": "comfyui",
  "kind": "image",
  "capabilities": ["text-to-image"],
  "description": "自定义 ComfyUI 工作流",
  "homepage": "https://huggingface.co/black-forest-labs/FLUX.1-dev",
  "license": "非商用",
  "install": {
    "type": "files",
    "files": [
      {
        "url": "https://example.com/flux1-dev.safetensors",
        "dest": "diffusion_models/flux1-dev.safetensors",
        "bytes": 23802900736,
        "sha256": "可选：64 位 SHA-256"
      }
    ]
  },
  "comfy": {
    "requiredNodes": ["UNETLoader", "DualCLIPLoader", "VAELoader", "CLIPTextEncode", "KSampler", "VAEDecode", "SaveImage"],
    "workflow": {
      "graph": {
        "unet": { "class_type": "UNETLoader", "inputs": { "unet_name": "flux1-dev.safetensors", "weight_dtype": "default" } },
        "save": { "class_type": "SaveImage", "inputs": { "images": ["decode", 0], "filename_prefix": "morrow/custom" } }
      },
      "bindings": {
        "prompt": { "node": "positive", "input": "text" },
        "negativePrompt": { "node": "negative", "input": "text" },
        "width": { "node": "latent", "input": "width" },
        "height": { "node": "latent", "input": "height" },
        "seed": { "node": "sampler", "input": "seed" },
        "image": { "node": "load_image", "input": "image" },
        "lastImage": { "node": "load_last", "input": "image" },
        "seconds": { "node": "video", "input": "length" },
        "fps": { "node": "video", "input": "fps" }
      },
      "outputNode": "save",
      "outputKind": "image"
    }
  }
}
```

### 4.1 安装类型

| `install.type` | 适用 | 必需字段 |
|---|---|---|
| `files` | ComfyUI / llama.cpp | `files[].dest`；`url` 可选（已有文件可手动放置） |
| `ollama` | Ollama | `target`，例如 `qwen2.5vl:7b` |
| `lmstudio` | LM Studio | `target`，模型 key |
| `provider` | 已有模型提供方 | `providerId`、`target`（模型 ID） |

`files` 下载先写 `.part`，支持 Range 续传；完成后校验大小与 SHA-256，再原子重命名。路径必须是相对引擎模型目录的安全相对路径，禁止 `..`、绝对路径和符号链接逃逸。

### 4.2 能力与类型

- `kind`：`image` / `video` / `audio` / `multimodal`
- `capabilities`：`text-to-image`、`image-edit`、`text-to-video`、`image-to-video`、`first-last-video`、`text-to-speech`、`speech-to-text`、`vision`、`chat`

`run_local_model` 按清单的工作流/原生适配器执行；Ollama/LM Studio/provider 类多模态模型用于理解（对话、`describe_media`），不伪造图片/视频生成。`describe_media` 优先使用当前对话模型自带的视觉能力，只有当前模型不支持或调用失败时才回退本机视觉模型，并在结果里明确标注。

### 4.3 示例：Ollama 多模态模型

```json
{
  "id": "qwen2.5vl-7b",
  "label": "Qwen2.5-VL 7B（Ollama）",
  "engine": "ollama",
  "kind": "multimodal",
  "capabilities": ["vision", "chat"],
  "install": { "type": "ollama", "target": "qwen2.5vl:7b" }
}
```

### 4.4 示例：llama.cpp GGUF

```json
{
  "id": "my-gguf",
  "label": "My GGUF",
  "engine": "llamacpp",
  "kind": "multimodal",
  "capabilities": ["vision", "chat"],
  "install": {
    "type": "files",
    "files": [{ "url": "https://example.com/my-model.gguf", "dest": "my-model/my-model.gguf", "bytes": 123456789 }],
    "modelPath": "my-model/my-model.gguf",
    "alias": "my-model",
    "contextWindow": 32768,
    "args": ["-ngl", "99", "-fa", "on", "-c", "32768"]
  }
}
```

`args` 中的相对路径以模型目录为工作目录解析；Morrow 自动补 `-m`、`--host`、`--port`。

## 5. 生命周期

| 操作 | 设置页 | Agent 工具 |
|---|---|---|
| 查看引擎/模型 | 多媒体 → 本机引擎/模型 | `list_local_models` |
| 应用内添加本机模型 | 多媒体 → 添加本机模型：llama.cpp / Ollama / LM Studio，以及 ComfyUI（粘贴 API 工作流 JSON） | 模型文件在引擎目录外时自动复制，重名自动加序号 |
| 注册自定义清单 | 导入模型 JSON / 导入引擎 | `manage_local_model action=register` / `manage_local_engine action=register` |
| 下载/拉取 | 下载并安装 / 拉取模型 | `manage_local_model action=install` |
| 切换 llama.cpp 模型 | 模型卡片 → 启动此模型 | — |
| 安装引擎 | 安装引擎（winget/清单命令） | `manage_local_engine action=install` |
| 启动/停止 | 启动 / 停止 | `manage_local_engine action=start|stop` |
| 卸载模型 | 卸载文件 | `manage_local_model action=uninstall` |
| 移除清单 | 移除清单 | `action=remove` |
| 调用 | 对话自然语言 | `run_local_model` |

内置引擎：

- **ComfyUI**：填写安装目录后由 `startEngine` 启动；模型文件与工作流可走清单，也可在「添加本机模型」里粘贴 API 格式工作流（输出节点/输出类型/可选提示词节点）直接注册；不自动下载 ComfyUI 本体。
- **llama.cpp**：检测 `llama-server`（PATH 或 `%LOCALAPPDATA%\Morrow\local-llama`），按模型清单启动，Morrow 可停止自己启动的进程。
- **Ollama**：检测 `ollama`，支持 winget 安装、`ollama serve`、`ollama pull/rm`；系统服务方式运行时不直接结束其他进程。
- **LM Studio**：检测 `lms`，支持 winget 安装、`lms get/rm`、`lms server start/stop`。

## 6. 与 Agent 的配合

用户说“部署/下载/安装/卸载/调用某个模型/引擎”时，Agent 的顺序：

1. `list_local_models` 查目录与已有能力；
2. 缺清单时 `manage_local_model/engine action=schema` 获取格式，注册；
3. 缺文件时 `action=install`（进度进入工具行，可取消）；
4. 需要服务时 `manage_local_engine action=start`；
5. 生成媒体时 `run_local_model`，模型 id 来自目录，不猜模型名；
6. 卸载时只删清单声明的文件，并在审批卡里展示影响。

如果模型仓库的下载地址、文件名或工作流不确定，Agent 应先联网核对官方模型页/仓库，再注册清单；不要把“找到一个同名文件”当成正确权重。

## 7. 安全与限制

- 下载/安装/卸载/启停均为高影响工具，按权限档位审批；只读模式不能调用。
- 模型文件路径限制在引擎模型目录；引擎安装命令由清单显式声明，UI/工具会展示命令/来源并要求确认。
- 不自动安装任意 `.exe` 或执行未知脚本；`download` 安装包只下载到 Morrow 数据目录，解压 zip；需要系统安装器时使用 winget 或用户确认的 `command`。
- ComfyUI 自定义节点不会静默 `git clone`；`requiredNodes` 只用于提示，节点安装由用户/Agent 通过终端明确完成。
- 当前内置预设的 Qwen/MiniMax 原生工作流仍是 ComfyUI 专用适配器；任意模型的通用路径是 `files + workflow` 清单，应用内表单与 JSON 导入等价。
- 首次真实验证覆盖：llama.cpp 启停、本地模型目录自然语言查询；Ollama/LM Studio 的安装/拉取适配已实现但本机未安装对应引擎，尚未做真实拉取验证。
