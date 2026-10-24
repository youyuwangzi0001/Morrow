/**
 * 通用模型/引擎清单。
 *
 * 设计原则：代码只认识“能力 + 生命周期”，不认识具体模型名。
 * Qwen / MiniMax / coder390 只是内置预设；用户或 Agent 可以注册任意
 * ComfyUI 工作流、llama.cpp GGUF、Ollama/LM Studio 模型，甚至自定义引擎。
 */

export type MediaEngineKind = 'comfyui' | 'llamacpp' | 'ollama' | 'lmstudio' | 'openai-compat' | 'custom'

export type MediaModelKind = 'image' | 'video' | 'audio' | 'multimodal'

export type MediaCapability =
  | 'text-to-image'
  | 'image-edit'
  | 'text-to-video'
  | 'image-to-video'
  | 'first-last-video'
  | 'text-to-speech'
  | 'speech-to-text'
  | 'vision'
  | 'chat'

export interface MediaEngineCommand {
  command: string
  args?: string[]
  /** 启动服务后不等待退出（常驻进程） */
  detached?: boolean
  timeoutMs?: number
}

export interface MediaEngineManifest {
  id: string
  label: string
  kind: MediaEngineKind
  description?: string
  homepage?: string
  capabilities: MediaCapability[]
  source: 'builtin' | 'user'
  /** 检测命令/固定路径/健康检查；任一命中即视为已安装 */
  detect?: {
    command?: string
    args?: string[]
    paths?: string[]
    healthUrl?: string
  }
  install?: {
    kind: 'winget' | 'download' | 'command'
    wingetId?: string
    url?: string
    archive?: 'zip' | 'none'
    dest?: string
    command?: string
    args?: string[]
    note?: string
  }
  service?: {
    start?: MediaEngineCommand
    stop?: MediaEngineCommand
    healthUrl?: string
    port?: number
  }
  /** 模型文件根目录；未配置时由检测结果推断 */
  modelDir?: string
}

export interface MediaModelFile {
  /** 下载地址；没有时表示用户手动放置 */
  url?: string
  /** 相对模型根目录的路径，例如 diffusion_models/flux1-dev.safetensors */
  dest: string
  bytes?: number
  sha256?: string
  optional?: boolean
}

export interface MediaWorkflowBinding {
  node: string
  input: string
}

export interface MediaWorkflowSpec {
  /** ComfyUI API 格式工作流；占位符由 bindings 写入 */
  graph: Record<string, unknown>
  bindings: {
    prompt?: MediaWorkflowBinding
    negativePrompt?: MediaWorkflowBinding
    width?: MediaWorkflowBinding
    height?: MediaWorkflowBinding
    seed?: MediaWorkflowBinding
    image?: MediaWorkflowBinding
    lastImage?: MediaWorkflowBinding
    seconds?: MediaWorkflowBinding
    fps?: MediaWorkflowBinding
  }
  outputNode: string
  outputKind: 'image' | 'video' | 'audio'
  /** 输出文件名前缀（ComfyUI 节点里已经写死时忽略） */
  filenamePrefix?: string
}

export interface MediaModelInstall {
  /** files = ComfyUI/llama.cpp 文件下载；ollama/lmstudio = 引擎拉取；provider = 已有模型提供方 */
  type: 'files' | 'ollama' | 'lmstudio' | 'provider'
  files?: MediaModelFile[]
  /** ollama: qwen2.5vl:7b；lmstudio: 模型 key；provider: 模型 ID */
  target?: string
  /** 引擎启动时的模型路径（相对引擎 modelDir）或额外参数 */
  modelPath?: string
  args?: string[]
  contextWindow?: number
  alias?: string
  providerId?: string
}

export interface MediaModelManifest {
  id: string
  label: string
  engine: string
  kind: MediaModelKind
  capabilities: MediaCapability[]
  description?: string
  homepage?: string
  license?: string
  source: 'builtin' | 'user'
  install: MediaModelInstall
  /** ComfyUI 自定义工作流；内置 Qwen/MiniMax 可以省略，走原生适配器 */
  comfy?: {
    requiredNodes?: string[]
    workflow?: MediaWorkflowSpec
    /** 内置原生工作流标识；自定义模型不要填 */
    native?: 'qwen-image' | 'minimax-video'
  }
  /** 需要启停的本地服务端口/健康检查 */
  healthUrl?: string
}

export interface MediaEngineInfo {
  id: string
  label: string
  kind: MediaEngineKind
  capabilities: MediaCapability[]
  source: 'builtin' | 'user'
  homepage?: string
  detected: boolean
  running: boolean
  binary?: string
  version?: string
  healthUrl?: string
  modelDir?: string
  installable: boolean
  canStart: boolean
  canStop: boolean
  message: string
}

export interface MediaModelInfo {
  id: string
  label: string
  engine: string
  kind: MediaModelKind
  capabilities: MediaCapability[]
  source: 'builtin' | 'user'
  installType: 'files' | 'ollama' | 'lmstudio' | 'provider'
  homepage?: string
  license?: string
  installed: boolean
  verified: boolean
  missing: string[]
  installedFiles: string[]
  running: boolean
  message: string
}

export interface MediaCatalogStatus {
  engines: MediaEngineInfo[]
  models: MediaModelInfo[]
  modal: 'running' | 'idle' | 'installing'
}

export interface MediaCatalogAction {
  action:
    | 'install-model'
    | 'uninstall-model'
    | 'start-engine'
    | 'stop-engine'
    | 'install-engine'
    | 'register-model'
    | 'remove-model'
    | 'register-engine'
    | 'remove-engine'
  id?: string
  /** 启动 llama.cpp 时指定模型；不填则用第一个已安装模型 */
  modelId?: string
  manifest?: Record<string, unknown>
}

export interface MediaCatalogProgress {
  stage: string
  percent?: number
}
