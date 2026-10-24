/**
 * 通用模型/引擎目录：检测、安装、启停、下载、注册、卸载。
 *
 * 具体模型不应写死在 UI 或生成代码里；这里把模型描述成 manifest，
 * 用同一套生命周期操作 ComfyUI 文件、llama.cpp GGUF、Ollama/LM Studio 模型。
 * 内置 Qwen/MiniMax/coder390 只是预设，用户和 Agent 可以注册任意模型。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type {
  MediaCatalogProgress,
  MediaCatalogStatus,
  MediaEngineInfo,
  MediaEngineManifest,
  MediaModelFile,
  MediaModelInfo,
  MediaModelManifest
} from '../../shared/media-models'
import { dataPath } from './paths'
import { getMediaService, locateComfyui } from './media-service'
import { getSettingsStore } from './settings-store'
import { log } from './logger'

const LOCAL = process.env.LOCALAPPDATA || process.env.APPDATA || process.env.HOME || ''
const LLAMA_MODEL_DIR = join(LOCAL, 'Morrow', 'local-models')
const LLAMA_BIN_DIR = join(LOCAL, 'Morrow', 'local-llama')

const BUILTIN_ENGINES: MediaEngineManifest[] = [
  {
    id: 'comfyui',
    label: 'ComfyUI',
    kind: 'comfyui',
    description: '图片/视频/音频工作流引擎；模型以 ComfyUI 目录下的文件形式管理。',
    homepage: 'https://github.com/comfyanonymous/ComfyUI',
    capabilities: ['text-to-image', 'image-edit', 'text-to-video', 'image-to-video', 'first-last-video', 'text-to-speech', 'speech-to-text'],
    source: 'builtin'
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    kind: 'llamacpp',
    description: '本地 GGUF 推理；Morrow 可启动 llama-server、下载/卸载模型。',
    homepage: 'https://github.com/ggml-org/llama.cpp',
    capabilities: ['vision', 'chat'],
    source: 'builtin',
    detect: { command: 'llama-server', paths: [join(LLAMA_BIN_DIR, 'cuda-b9637-cu12', 'llama-server.exe'), join(LLAMA_BIN_DIR, 'llama-server.exe')] },
    service: { healthUrl: 'http://127.0.0.1:8000/health' },
    modelDir: LLAMA_MODEL_DIR
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'ollama',
    description: '本地模型服务；支持 pull/rm 与 OpenAI 兼容接口。',
    homepage: 'https://ollama.com',
    capabilities: ['vision', 'chat'],
    source: 'builtin',
    detect: { command: 'ollama', healthUrl: 'http://127.0.0.1:11434/api/tags' },
    install: {
      kind: 'winget',
      wingetId: 'Ollama.Ollama',
      note: '通过 winget 安装 Ollama；安装器可能需要系统权限。'
    },
    service: { start: { command: 'ollama', args: ['serve'], detached: true }, healthUrl: 'http://127.0.0.1:11434/api/tags' }
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'lmstudio',
    description: '本地模型服务；通过 lms CLI 管理模型与本地服务器。',
    homepage: 'https://lmstudio.ai',
    capabilities: ['vision', 'chat'],
    source: 'builtin',
    detect: { command: 'lms', healthUrl: 'http://127.0.0.1:1234/v1/models' },
    install: {
      kind: 'winget',
      wingetId: 'ElementLabs.LMStudio',
      note: '通过 winget 安装 LM Studio；首次启动仍需在应用内同意许可。'
    },
    service: {
      start: { command: 'lms', args: ['server', 'start'] },
      stop: { command: 'lms', args: ['server', 'stop'] },
      healthUrl: 'http://127.0.0.1:1234/v1/models'
    }
  }
]

const QWEN_FILES: MediaModelFile[] = [
  { url: 'https://www.modelscope.cn/models/unsloth/Qwen-Image-2.1-Turbo-GGUF/resolve/master/qwen-image-2.1-turbo-Q6_K.gguf', dest: 'diffusion_models/qwen-image-2.1-turbo-Q6_K.gguf', bytes: 6_271_551_296 },
  { url: 'https://www.modelscope.cn/models/Comfy-Org/Qwen-Image-2.1/resolve/master/text_encoders/qwen3vl_8b_bf16.safetensors', dest: 'text_encoders/qwen3vl_8b_bf16.safetensors', bytes: 17_534_334_616 },
  { url: 'https://www.modelscope.cn/models/Comfy-Org/Qwen-Image-2.1/resolve/master/vae/qwen_image_2.1_vae_bf16.safetensors', dest: 'vae/qwen_image_2.1_vae_bf16.safetensors', bytes: 675_509_688 }
]

const MINIMAX_FILES: MediaModelFile[] = [
  { url: 'https://www.modelscope.cn/models/l1ngzi/MiniMax-H3-16G-HiFi/resolve/master/diffusion_models/minimax_h3_ref2va_dit_16g.safetensors', dest: 'diffusion_models/minimax_h3_ref2va_dit_16g.safetensors', bytes: 28_403_358_856 },
  { url: 'https://www.modelscope.cn/models/l1ngzi/MiniMax-H3-16G-HiFi/resolve/master/diffusion_models/minimax_h3_fl2va_dit_16g.safetensors', dest: 'diffusion_models/minimax_h3_fl2va_dit_16g.safetensors', bytes: 28_364_846_456 },
  { url: 'https://www.modelscope.cn/models/l1ngzi/MiniMax-H3-16G-HiFi/resolve/master/text_encoders/qwen3vl_text_encoder.safetensors', dest: 'text_encoders/qwen3vl_text_encoder.safetensors', bytes: 30_552_489_265 },
  { url: 'https://www.modelscope.cn/models/l1ngzi/MiniMax-H3-16G-HiFi/resolve/master/vae/minimax_h3_video_vae_fp16.safetensors', dest: 'vae/minimax_h3_video_vae_fp16.safetensors', bytes: 5_207_808_496 },
  { url: 'https://www.modelscope.cn/models/l1ngzi/MiniMax-H3-16G-HiFi/resolve/master/vae/minimax_h3_audio_vae_fp32.safetensors', dest: 'vae/minimax_h3_audio_vae_fp32.safetensors', bytes: 605_254_808 }
]

const BUILTIN_MODELS: MediaModelManifest[] = [
  {
    id: 'qwen-image-2.1-turbo',
    label: 'Qwen-Image 2.1 Turbo',
    engine: 'comfyui',
    kind: 'image',
    capabilities: ['text-to-image', 'image-edit'],
    description: '内置预设：Qwen-Image 2.1 Turbo GGUF，适合中文/英文图像生成与编辑。',
    homepage: 'https://huggingface.co/unsloth/Qwen-Image-2.1-Turbo-GGUF',
    license: 'Apache-2.0',
    source: 'builtin',
    install: { type: 'files', files: QWEN_FILES },
    comfy: { native: 'qwen-image' }
  },
  {
    id: 'minimax-h3',
    label: 'MiniMax-H3 16G HiFi',
    engine: 'comfyui',
    kind: 'video',
    capabilities: ['image-to-video', 'first-last-video', 'text-to-video'],
    description: '内置预设：MiniMax-H3 Ref2VA + FL2VA，含同步环境声。',
    homepage: 'https://huggingface.co/MiniMaxAI/MiniMax-H3',
    license: '见模型主页',
    source: 'builtin',
    install: { type: 'files', files: MINIMAX_FILES },
    comfy: { native: 'minimax-video' }
  },
  {
    id: 'coder390-vision',
    label: 'Qwen3.8-27B-Coder390（视觉）',
    engine: 'llamacpp',
    kind: 'multimodal',
    capabilities: ['vision', 'chat'],
    description: '内置预设：现有本地 coder390 + mmproj，用于图片/视频帧审看与聚焦代码任务。',
    license: 'Apache-2.0',
    source: 'builtin',
    install: {
      type: 'files',
      files: [{ dest: 'qwen38-27b/Qwen3.8-27B-Coder390-Q3LynnStyle16G-MTP.gguf' }],
      modelPath: 'qwen38-27b/Qwen3.8-27B-Coder390-Q3LynnStyle16G-MTP.gguf',
      alias: 'Qwen3.8-27B-Coder390',
      contextWindow: 65_536,
      args: ['-ngl', '99', '-fa', 'on', '-c', '65536', '--cache-type-k', 'q4_0', '--cache-type-v', 'q4_0', '-b', '4096', '-ub', '1024', '-t', '14', '--jinja', '--reasoning-format', 'deepseek', '--reasoning-budget', '4096', '--temp', '1.0', '--top-p', '0.95', '--top-k', '20', '--presence-penalty', '1.5', '--parallel', '1', '--mmproj', 'qwen38-27b/mmproj-Qwen3.8-27B-Q8_0.gguf']
    }
  }
]

interface EngineCache {
  info: MediaEngineInfo
  manifest: MediaEngineManifest
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function now(): number {
  return Date.now()
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function safeId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{1,63}$/i.test(value)
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as T
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function within(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

function safeRelativePath(value: string): boolean {
  if (!value || isAbsolute(value)) return false
  const normalized = normalize(value)
  return !normalized.startsWith('..') && !normalized.includes(`..${sep}`)
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
}

function commandExists(command: string): string | null {
  if (isAbsolute(command)) return existsSync(command) ? command : null
  const where = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(where, [command], { encoding: 'utf8', windowsHide: true, timeout: 5_000 })
  if (result.status !== 0) return null
  const line = result.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean)
  return line || null
}

async function runCommand(command: string, args: string[], options: { timeoutMs?: number; detached?: boolean; signal?: AbortSignal; onOutput?: (text: string) => void } = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: options.detached === true,
      env: { ...process.env, ...(process.platform === 'win32' ? { TEMP: process.env.TEMP || join(LOCAL, 'Temp'), TMP: process.env.TMP || join(LOCAL, 'Temp') } : {}) }
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => { timedOut = true; child.kill() }, options.timeoutMs)
      : null
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      if (target === 'stdout') stdout += text
      else stderr += text
      if (options.onOutput && text) options.onOutput(text)
      if (stdout.length + stderr.length > 4 * 1024 * 1024) {
        stdout = stdout.slice(-2 * 1024 * 1024)
        stderr = stderr.slice(-2 * 1024 * 1024)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    if (options.detached) {
      child.once('spawn', () => resolvePromise({ code: 0, stdout, stderr }))
    } else {
      child.on('exit', (code) => {
        if (timer) clearTimeout(timer)
        if (timedOut) reject(new Error(`命令超时：${basename(command)}`))
        else resolvePromise({ code: code ?? 0, stdout, stderr })
      })
    }
    options.signal?.addEventListener('abort', () => {
      if (timer) clearTimeout(timer)
      child.kill()
      reject(new Error('操作已取消。'))
    }, { once: true })
  })
}

async function health(url: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

async function fetchJson(url: string, timeoutMs = 5_000): Promise<unknown | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/** 单文件断点下载；先写 .part，校验完成后再原子重命名。 */
async function downloadFile(
  file: MediaModelFile,
  root: string,
  signal: AbortSignal,
  onProgress: (percent: number) => void
): Promise<void> {
  const dest = resolve(root, file.dest)
  if (!within(root, dest)) throw new Error(`模型文件路径越界：${file.dest}`)
  if (!file.url) throw new Error(`缺少下载地址，请手动放置到 ${file.dest}。`)
  if (!isUrl(file.url)) throw new Error(`下载地址不是 http(s)：${file.url}`)
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  let start = existsSync(part) ? statSync(part).size : 0
  if (existsSync(dest)) {
    const size = statSync(dest).size
    if ((!file.bytes || Math.abs(size - file.bytes) <= 1_048_576) && (!file.sha256 || (await hashFile(dest)).toLowerCase() === file.sha256.toLowerCase())) {
      onProgress(100)
      return
    }
    rmSync(dest, { force: true })
  }
  const response = await fetch(file.url, {
    signal,
    headers: start > 0 ? { Range: `bytes=${start}-` } : undefined
  })
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）：${file.url}`)
  if (start > 0 && response.status !== 206) {
    start = 0
    rmSync(part, { force: true })
  }
  const total = file.bytes ?? Number(response.headers.get('content-length') ?? 0) + start
  const output = createWriteStream(part, { flags: start > 0 ? 'a' : 'w' })
  let received = start
  try {
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (signal.aborted) throw new Error('下载已取消。')
        if (!output.write(Buffer.from(chunk))) await once(output, 'drain')
        received += chunk.length
        if (total > 0) onProgress(Math.min(99, Math.round((received / total) * 100)))
      }
    }
  } finally {
    output.end()
  }
  await new Promise<void>((resolvePromise, reject) => {
    output.on('finish', () => resolvePromise())
    output.on('error', reject)
  })
  const size = statSync(part).size
  if (file.bytes && Math.abs(size - file.bytes) > 1_048_576) {
    throw new Error(`文件大小不符：期望 ${file.bytes}，实际 ${size}。可重试续传或删除 .part。`)
  }
  if (file.sha256 && (await hashFile(part)).toLowerCase() !== file.sha256.toLowerCase()) {
    rmSync(part, { force: true })
    throw new Error(`SHA-256 校验失败：${file.dest}`)
  }
  renameSync(part, dest)
  onProgress(100)
}

export class MediaCatalog {
  private userEngines: MediaEngineManifest[]
  private userModels: MediaModelManifest[]
  private engineCache: EngineCache[] = []
  private child: ChildProcess | null = null
  private installing = false

  constructor() {
    const engines = readJsonFile<MediaEngineManifest[]>(dataPath('media-engines.json'), [])
    const models = readJsonFile<MediaModelManifest[]>(dataPath('media-models.json'), [])
    this.userEngines = Array.isArray(engines) ? engines.filter((item) => item?.source === 'user') : []
    this.userModels = Array.isArray(models) ? models.filter((item) => item?.source === 'user') : []
  }

  private engines(): MediaEngineManifest[] {
    return [...BUILTIN_ENGINES, ...this.userEngines]
  }

  private models(): MediaModelManifest[] {
    return [...BUILTIN_MODELS, ...this.userModels]
  }

  private engineManifest(id: string): MediaEngineManifest {
    const manifest = this.engines().find((item) => item.id === id)
    if (!manifest) throw new Error(`没有名为「${id}」的引擎。请先注册引擎清单。`)
    return manifest
  }

  private modelManifest(id: string): MediaModelManifest {
    const manifest = this.models().find((item) => item.id === id)
    if (!manifest) throw new Error(`没有名为「${id}」的模型。请先注册模型清单。`)
    return manifest
  }

  private settings() {
    return getSettingsStore().get()
  }

  private modelRoot(engine: MediaEngineManifest): string | null {
    if (engine.kind === 'comfyui') {
      const settings = this.settings().mediaEngine
      const dir = locateComfyui(settings)
      return dir ? join(dir, 'models') : null
    }
    return engine.modelDir ?? null
  }

  private resolveEngine(engine: MediaEngineManifest): { binary: string | null; healthUrl: string | null; running: boolean; version?: string } {
    if (engine.kind === 'comfyui') {
      const settings = this.settings().mediaEngine
      const dir = locateComfyui(settings)
      return {
        binary: dir,
        healthUrl: `${settings.comfyuiUrl.replace(/\/+$/, '')}/system_stats`,
        running: false
      }
    }
    let binary: string | null = null
    for (const path of engine.detect?.paths ?? []) {
      if (existsSync(path)) { binary = path; break }
    }
    if (!binary && engine.detect?.command) binary = commandExists(engine.detect.command)
    const healthUrl = engine.detect?.healthUrl ?? engine.service?.healthUrl ?? null
    return { binary, healthUrl, running: false }
  }

  private async inspectEngine(engine: MediaEngineManifest): Promise<EngineCache> {
    const resolved = this.resolveEngine(engine)
    const running = resolved.healthUrl ? await health(resolved.healthUrl) : false
    let version = resolved.version
    if (resolved.binary && engine.kind !== 'comfyui') {
      const versionArgs = engine.detect?.args ?? ['--version']
      try {
        const result = await runCommand(resolved.binary, versionArgs, { timeoutMs: 4_000 })
        version = firstLine(result.stdout) || firstLine(result.stderr) || undefined
      } catch {
        // 版本不是必需能力
      }
    }
    if (engine.kind === 'comfyui' && running) {
      const stats = await fetchJson(`${this.settings().mediaEngine.comfyuiUrl.replace(/\/+$/, '')}/system_stats`)
      const comfy = (stats as { system?: { comfyui_version?: string } } | null)?.system?.comfyui_version
      version = comfy ? `ComfyUI ${comfy}` : 'ComfyUI'
    }
    const info: MediaEngineInfo = {
      id: engine.id,
      label: engine.label,
      kind: engine.kind,
      capabilities: engine.capabilities,
      source: engine.source,
      ...(engine.homepage ? { homepage: engine.homepage } : {}),
      detected: Boolean(resolved.binary),
      running,
      ...(resolved.binary ? { binary: resolved.binary } : {}),
      ...(version ? { version } : {}),
      ...(resolved.healthUrl ? { healthUrl: resolved.healthUrl } : {}),
      ...(this.modelRoot(engine) ? { modelDir: this.modelRoot(engine)! } : {}),
      installable: Boolean(engine.install) || engine.kind === 'comfyui',
      canStart: Boolean(resolved.binary) && (engine.kind === 'llamacpp' || Boolean(engine.service?.start)),
      canStop: running && (engine.kind === 'llamacpp' || Boolean(engine.service?.stop)),
      message: running
        ? '运行中'
        : resolved.binary
          ? '已安装，未运行'
          : engine.kind === 'comfyui'
            ? '请填写 ComfyUI 安装目录'
            : '未检测到引擎'
    }
    return { info, manifest: engine }
  }

  async status(): Promise<MediaCatalogStatus> {
    const engines = await Promise.all(this.engines().map((engine) => this.inspectEngine(engine)))
    this.engineCache = engines
    const models = await Promise.all(this.models().map((model) => this.inspectModel(model, engines)))
    return {
      engines: engines.map((item) => item.info),
      models,
      modal: this.installing ? 'installing' : engines.some((item) => item.info.running) ? 'running' : 'idle'
    }
  }

  private async inspectModel(model: MediaModelManifest, engines: EngineCache[]): Promise<MediaModelInfo> {
    const engine = engines.find((item) => item.manifest.id === model.engine)
    const base: MediaModelInfo = {
      id: model.id,
      label: model.label,
      engine: model.engine,
      kind: model.kind,
      capabilities: model.capabilities,
      source: model.source,
      installType: model.install.type,
      ...(model.homepage ? { homepage: model.homepage } : {}),
      ...(model.license ? { license: model.license } : {}),
      installed: false,
      verified: false,
      missing: [],
      installedFiles: [],
      running: false,
      message: '未检测'
    }
    if (!engine) return { ...base, message: `引擎 ${model.engine} 未注册` }

    if (model.install.type === 'files') {
      const root = this.modelRoot(engine.manifest)
      if (!root) return { ...base, message: '未配置模型目录' }
      const files = model.install.files ?? []
      const missing: string[] = []
      const installed: string[] = []
      for (const file of files) {
        const full = resolve(root, file.dest)
        const exists = within(root, full) && existsSync(full)
        const sizeOk = !exists || !file.bytes || Math.abs(statSync(full).size - file.bytes) <= 1_048_576
        if (exists && sizeOk) installed.push(file.dest)
        else if (!file.optional) missing.push(file.dest)
      }
      const installedOk = missing.length === 0
      return {
        ...base,
        installed: installedOk,
        verified: true,
        missing,
        installedFiles: installed,
        running: engine.info.running,
        message: installedOk ? (engine.info.running ? '已安装，引擎运行中' : '已安装') : `缺少 ${missing.length} 个文件`
      }
    }

    if (model.install.type === 'ollama' || model.install.type === 'lmstudio') {
      const running = engine.info.running
      const target = model.install.target ?? ''
      let names: string[] = []
      if (running) {
        const url = model.install.type === 'ollama'
          ? 'http://127.0.0.1:11434/api/tags'
          : 'http://127.0.0.1:1234/v1/models'
        const payload = await fetchJson(url)
        if (model.install.type === 'ollama') {
          names = ((payload as { models?: Array<{ name?: string }> } | null)?.models ?? []).map((item) => item.name ?? '')
        } else {
          names = ((payload as { data?: Array<{ id?: string }> } | null)?.data ?? []).map((item) => item.id ?? '')
        }
      }
      const installed = Boolean(target && names.some((name) => name === target || name.startsWith(`${target}:`)))
      return {
        ...base,
        installed,
        verified: running,
        missing: installed || !target ? [] : [target],
        running: installed && running,
        message: installed ? '已安装并可由引擎调用' : running ? '尚未拉取到本机' : '引擎未运行，无法核对'
      }
    }

    if (model.install.type === 'provider') {
      const provider = this.settings().providers.find((item) => item.id === model.install.providerId)
      const installed = Boolean(provider?.models.some((item) => item.id === model.install.target))
      return {
        ...base,
        installed,
        verified: true,
        running: installed && Boolean(provider?.enabled),
        message: installed ? (provider?.enabled ? '已配置并启用' : '已配置，未启用') : '模型提供方中未找到该模型'
      }
    }

    return base
  }

  async manifest(id: string): Promise<MediaModelManifest> {
    return JSON.parse(JSON.stringify(this.modelManifest(id))) as MediaModelManifest
  }

  async installModel(id: string, onProgress: (update: MediaCatalogProgress) => void, signal: AbortSignal): Promise<MediaCatalogStatus> {
    const model = this.modelManifest(id)
    const engine = this.engineManifest(model.engine)
    this.installing = true
    try {
      if (model.install.type === 'files') {
        const root = this.modelRoot(engine)
        if (!root) throw new Error('请先在设置里填写该引擎的模型目录。')
        mkdirSync(root, { recursive: true })
        const files = model.install.files ?? []
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]
          const label = `下载 ${index + 1}/${files.length}：${basename(file.dest)}`
          onProgress({ stage: label, percent: Math.round((index / files.length) * 100) })
          await downloadFile(file, root, signal, (percent) => {
            onProgress({ stage: label, percent: Math.round(((index + percent / 100) / files.length) * 100) })
          })
        }
      } else if (model.install.type === 'ollama') {
        const target = model.install.target
        if (!target) throw new Error('Ollama 模型清单缺少 target。')
        onProgress({ stage: `ollama pull ${target}` })
        const result = await runCommand('ollama', ['pull', target], { timeoutMs: 2 * 60 * 60 * 1000, signal, onOutput: (text) => {
          const line = firstLine(text)
          if (line) onProgress({ stage: line })
        } })
        if (result.code !== 0) throw new Error(result.stderr || `ollama pull 失败（${result.code}）`)
      } else if (model.install.type === 'lmstudio') {
        const target = model.install.target
        if (!target) throw new Error('LM Studio 模型清单缺少 target。')
        onProgress({ stage: `lms get ${target}` })
        const result = await runCommand('lms', ['get', target, '--yes'], { timeoutMs: 2 * 60 * 60 * 1000, signal })
        if (result.code !== 0) throw new Error(result.stderr || `lms get 失败（${result.code}）`)
      } else {
        throw new Error('这个模型属于已有模型提供方，请在设置 → 模型里配置；Morrow 不会重复下载。')
      }
      onProgress({ stage: '安装完成', percent: 100 })
      log.info('media model installed', { id })
      return this.status()
    } finally {
      this.installing = false
    }
  }

  async uninstallModel(id: string): Promise<MediaCatalogStatus> {
    const model = this.modelManifest(id)
    const engine = this.engineManifest(model.engine)
    if (model.install.type === 'files') {
      const root = this.modelRoot(engine)
      if (!root) throw new Error('未配置模型目录。')
      const referenced = new Set(
        this.models()
          .filter((item) => item.id !== id && item.install.type === 'files')
          .flatMap((item) => item.install.files ?? [])
          .map((file) => `files:${file.dest}`)
      )
      for (const file of model.install.files ?? []) {
        if (referenced.has(`files:${file.dest}`)) continue
        const full = resolve(root, file.dest)
        if (!within(root, full) || !existsSync(full)) continue
        rmSync(full, { force: true })
      }
    } else if (model.install.type === 'ollama') {
      const target = model.install.target
      if (!target) throw new Error('缺少 target。')
      const result = await runCommand('ollama', ['rm', target], { timeoutMs: 120_000 })
      if (result.code !== 0) throw new Error(result.stderr || `ollama rm 失败（${result.code}）`)
    } else if (model.install.type === 'lmstudio') {
      const target = model.install.target
      if (!target) throw new Error('缺少 target。')
      const result = await runCommand('lms', ['rm', target], { timeoutMs: 120_000 })
      if (result.code !== 0) throw new Error(result.stderr || `lms rm 失败（${result.code}）`)
    } else {
      throw new Error('这个模型由模型提供方管理，请在设置 → 模型中删除。')
    }
    log.info('media model uninstalled', { id })
    return this.status()
  }

  async installEngine(id: string): Promise<MediaCatalogStatus> {
    const engine = this.engineManifest(id)
    if (engine.kind === 'comfyui') throw new Error('ComfyUI 通过“选择安装目录”接入，不需要安装器；请先下载 ComfyUI 并填写目录。')
    const install = engine.install
    if (!install) throw new Error(`引擎「${engine.label}」没有安装清单，请注册带 install 的引擎。`)
    if (install.kind === 'winget') {
      if (!install.wingetId) throw new Error('缺少 wingetId。')
      const result = await runCommand('winget', ['install', '--id', install.wingetId, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { timeoutMs: 15 * 60 * 1000 })
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).slice(-1_200) || `winget 安装失败（${result.code}）`)
    } else if (install.kind === 'download') {
      if (!install.url) throw new Error('缺少安装包地址。')
      const dest = dataPath('engines', id)
      mkdirSync(dest, { recursive: true })
      const fileName = install.dest ? basename(install.dest) : basename(new URL(install.url).pathname)
      const file = join(dest, fileName || `${id}.zip`)
      await downloadFile({ url: install.url, dest: fileName }, dest, new AbortController().signal, () => undefined)
      if (install.archive === 'zip') {
        const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`], { timeoutMs: 10 * 60 * 1000 })
        if (result.code !== 0) throw new Error(result.stderr || '解压失败')
      }
    } else {
      if (!install.command) throw new Error('缺少安装命令。')
      const result = await runCommand(install.command, install.args ?? [], { timeoutMs: 15 * 60 * 1000 })
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).slice(-1_200) || `安装失败（${result.code}）`)
    }
    log.info('media engine installed', { id })
    return this.status()
  }

  async startEngine(id: string, modelId?: string): Promise<MediaCatalogStatus> {
    const engine = this.engineManifest(id)
    if (engine.kind === 'comfyui') {
      await getMediaService().startEngine()
      return this.status()
    }
    const preflightUrl = engine.service?.healthUrl ?? engine.detect?.healthUrl
    if (preflightUrl && await health(preflightUrl)) return this.status()
    if (engine.id === 'llamacpp') {
      if (this.child && !this.child.killed) return this.status()
      const candidates = this.models().filter((item) => item.engine === 'llamacpp' && item.install.type === 'files')
      const model = modelId ? candidates.find((item) => item.id === modelId) : candidates[0]
      if (!model) throw new Error(modelId ? `llama.cpp 下没有模型：${modelId}` : 'llama.cpp 下没有已注册模型。')
      const root = this.modelRoot(engine)
      if (!root) throw new Error('llama.cpp 没有模型目录。')
      const modelPath = model.install.modelPath ?? model.install.files?.[0]?.dest
      if (!modelPath) throw new Error('模型清单缺少 modelPath。')
      const resolved = resolve(root, modelPath)
      if (!within(root, resolved) || !existsSync(resolved)) throw new Error(`模型文件不存在：${modelPath}`)
      const detected = await this.inspectEngine(engine)
      const binary = detected.info.binary
      if (!binary) throw new Error('没有检测到 llama-server，请先安装或注册引擎路径。')
      const args = [
        '-m', resolved,
        '--host', '127.0.0.1', '--port', String(engine.service?.port ?? 8000),
        ...(model.install.alias ? ['--alias', model.install.alias] : []),
        ...(model.install.args ?? [])
      ]
      const child = spawn(binary, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], detached: false })
      this.child = child
      child.on('exit', () => { if (this.child === child) this.child = null })
      const healthUrl = engine.service?.healthUrl ?? 'http://127.0.0.1:8000/health'
      const deadline = now() + 180_000
      while (now() < deadline) {
        await new Promise((r) => setTimeout(r, 1_500))
        if (await health(healthUrl)) return this.status()
        if (child.exitCode !== null) break
      }
      throw new Error('llama-server 启动超时，请检查模型文件与显卡。')
    }
    if (!engine.service?.start) throw new Error(`引擎「${engine.label}」没有启动命令；请先在系统里启动。`)
    const start = engine.service.start
    await runCommand(start.command, start.args ?? [], { detached: start.detached, timeoutMs: start.timeoutMs })
    const healthUrl = engine.service.healthUrl
    if (healthUrl) {
      const deadline = now() + 60_000
      while (now() < deadline) {
        if (await health(healthUrl)) return this.status()
        await new Promise((r) => setTimeout(r, 1_000))
      }
      throw new Error(`${engine.label} 已执行启动命令，但健康检查未通过。`)
    }
    return this.status()
  }

  async stopEngine(id: string): Promise<MediaCatalogStatus> {
    const engine = this.engineManifest(id)
    if (engine.kind === 'comfyui') {
      await getMediaService().stopEngine()
      return this.status()
    }
    if (engine.id === 'llamacpp') {
      if (!this.child || this.child.killed) throw new Error('llama-server 不是由 Morrow 启动的，无法安全停止；请在终端结束对应进程。')
      const child = this.child
      this.child = null
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill()
      return this.status()
    }
    if (!engine.service?.stop) throw new Error(`引擎「${engine.label}」由系统服务管理，Morrow 不直接结束其他进程。`)
    const stop = engine.service.stop
    const result = await runCommand(stop.command, stop.args ?? [], { timeoutMs: 60_000 })
    if (result.code !== 0) throw new Error(result.stderr || `停止失败（${result.code}）`)
    return this.status()
  }

  async registerModel(raw: Record<string, unknown>): Promise<MediaCatalogStatus> {
    const manifest = raw as unknown as MediaModelManifest
    if (!safeId(manifest.id)) throw new Error('模型 id 必须为 2–64 位字母/数字/点/下划线/连字符。')
    if (!manifest.label?.trim()) throw new Error('模型需要 label。')
    if (!this.engines().some((engine) => engine.id === manifest.engine)) throw new Error(`未知引擎：${manifest.engine}`)
    if (!['image', 'video', 'audio', 'multimodal'].includes(manifest.kind)) throw new Error('kind 必须是 image/video/audio/multimodal。')
    if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) throw new Error('至少声明一种能力。')
    if (!manifest.install || !['files', 'ollama', 'lmstudio', 'provider'].includes(manifest.install.type)) throw new Error('install.type 不受支持。')
    if (manifest.install.type === 'files') {
      for (const file of manifest.install.files ?? []) {
        if (!safeRelativePath(file.dest)) throw new Error(`模型文件路径不安全：${file.dest}`)
        if (file.url && !isUrl(file.url)) throw new Error(`模型文件 URL 必须是 http(s)：${file.url}`)
        if (file.sha256 && !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error('sha256 必须是 64 位十六进制。')
      }
    }
    if (this.models().some((item) => item.id === manifest.id)) throw new Error(`模型 id 已存在：${manifest.id}`)
    const engine = this.engines().find((item) => item.id === manifest.engine)
    if (engine?.kind === 'llamacpp' && manifest.install.type === 'files' && !manifest.install.alias?.trim()) {
      manifest.install.alias = manifest.id
    }
    this.userModels.push({ ...manifest, source: 'user' })
    writeJsonFile(dataPath('media-models.json'), this.userModels)
    this.syncProviderModel(manifest, engine)
    return this.status()
  }

  /** 把可对话的本地模型同步到模型选择器；失败不阻断目录注册。 */
  private syncProviderModel(manifest: MediaModelManifest, engine: MediaEngineManifest | undefined): void {
    if (!engine || !['llamacpp', 'ollama', 'lmstudio'].includes(engine.kind)) return
    const modelId = manifest.install.type === 'files'
      ? manifest.install.alias ?? manifest.id
      : manifest.install.type === 'ollama' || manifest.install.type === 'lmstudio' ? manifest.install.target : undefined
    if (!modelId) return
    try {
      const store = getSettingsStore()
      const provider = store.get().providers.find((item) => item.id === engine.id)
      if (!provider || provider.models.some((item) => item.id === modelId)) return
      const contextWindow = manifest.install.contextWindow ?? (engine.kind === 'llamacpp' ? 65_536 : 32_768)
      store.saveProvider({
        ...provider,
        models: [
          ...provider.models,
          {
            id: modelId,
            label: manifest.label,
            contextWindow,
            supportsTools: true,
            ...(manifest.capabilities.includes('vision') ? { note: '本地多模态' } : {})
          }
        ]
      })
    } catch (err) {
      log.warn('sync local model to provider failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  async removeModel(id: string): Promise<MediaCatalogStatus> {
    const model = this.modelManifest(id)
    if (model.source === 'builtin') throw new Error('内置预设不能删除；可以卸载文件，或注册同能力的新模型。')
    this.userModels = this.userModels.filter((item) => item.id !== id)
    writeJsonFile(dataPath('media-models.json'), this.userModels)
    return this.status()
  }

  async registerEngine(raw: Record<string, unknown>): Promise<MediaCatalogStatus> {
    const manifest = raw as unknown as MediaEngineManifest
    if (!safeId(manifest.id)) throw new Error('引擎 id 必须为 2–64 位字母/数字/点/下划线/连字符。')
    if (!manifest.label?.trim()) throw new Error('引擎需要 label。')
    if (!['comfyui', 'llamacpp', 'ollama', 'lmstudio', 'openai-compat', 'custom'].includes(manifest.kind)) throw new Error('kind 不受支持。')
    if (manifest.install && manifest.install.kind === 'download' && manifest.install.url && !isUrl(manifest.install.url)) throw new Error('安装包 URL 必须是 http(s)。')
    if (this.engines().some((item) => item.id === manifest.id)) throw new Error(`引擎 id 已存在：${manifest.id}`)
    this.userEngines.push({ ...manifest, source: 'user' })
    writeJsonFile(dataPath('media-engines.json'), this.userEngines)
    return this.status()
  }

  async removeEngine(id: string): Promise<MediaCatalogStatus> {
    const engine = this.engineManifest(id)
    if (engine.source === 'builtin') throw new Error('内置引擎不能删除。')
    this.userEngines = this.userEngines.filter((item) => item.id !== id)
    writeJsonFile(dataPath('media-engines.json'), this.userEngines)
    return this.status()
  }
}

let instance: MediaCatalog | null = null

export function getMediaCatalog(): MediaCatalog {
  if (!instance) instance = new MediaCatalog()
  return instance
}
