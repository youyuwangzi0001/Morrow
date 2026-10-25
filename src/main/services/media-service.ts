/**
 * 本地多媒体服务：把本机 ComfyUI（图片/视频）与 ffmpeg（剪辑）接到 Agent 工具上。
 * Morrow 不内置推理引擎或权重；这里只负责检测、启动、调用、落盘与预览元数据。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { BrowserWindow } from 'electron'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { closeSync, openSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { isLocalServiceUrl } from '../../shared/models'
import type {
  ChatImage,
  ChatMessage,
  MediaEngineModelStatus,
  MediaEngineSettings,
  MediaEngineStatus,
  MediaKind,
  Settings
} from '../../shared/types'
import type {
  MediaArtifactResult,
  MediaDescribeInput,
  MediaDescribeResult,
  MediaEditInput,
  MediaFilmResult,
  MediaGenerateFilmInput,
  MediaGenerateImageInput,
  MediaGenerateVideoInput,
  MediaCatalogHandler,
  MediaProbeResult,
  MediaRenderAnimationInput,
  MediaRunWorkflowInput,
  MediaToolHandler
} from '../../core/types'
import { createProvider } from '../../core/providers'
import { newId } from '../../core/util'
import { getSettingsStore } from './settings-store'
import { log } from './logger'

/**
 * 用户可能在新数据目录里没有保存安装目录，但 ComfyUI 和模型早已在本机。
 * 显式配置优先；为空时才在常见位置和环境变量里只读探测 main.py。
 */
export function locateComfyui(settings: Pick<MediaEngineSettings, 'comfyuiDir'>): string | null {
  const configured = settings.comfyuiDir?.trim()
  if (configured) return resolve(configured)
  const env = process.env.MORROW_COMFYUI_DIR?.trim()
  const local = process.env.LOCALAPPDATA || ''
  const candidates = [
    env,
    'C:/AI/MorrowMedia/ComfyUI',
    'C:/AI/ComfyUI',
    'D:/AI/ComfyUI',
    join(homedir(), 'ComfyUI'),
    local ? join(local, 'ComfyUI') : null,
    local ? join(local, 'Programs', 'ComfyUI') : null
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (existsSync(join(candidate, 'main.py'))) return resolve(candidate)
  }
  return null
}

const QWEN_SIGMAS = '1.0,0.978453,0.95418,0.926626,0.89508,0.845148,0.704534,0.414568,0.0'
const IMAGE_MODEL_LABEL = 'Qwen-Image-2.1 Turbo'
const VIDEO_MODEL_LABEL = 'MiniMax-H3 16G HiFi'
const REF2VA_MODEL_LABEL = 'MiniMax-H3 Ref2VA 16G HiFi'
const FL2VA_MODEL_LABEL = 'MiniMax-H3 FL2VA 16G HiFi'
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'mov'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'])
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024
const MAX_IMAGE_DOWNLOAD = 120 * 1024 * 1024
const MAX_VIDEO_DOWNLOAD = 1024 * 1024 * 1024

interface FileSpec {
  label: string
  dir: string
  names: { name: string; bytes?: number; minBytes?: number }[]
  pattern?: RegExp
}

const IMAGE_SPECS: FileSpec[] = [
  {
    label: '扩散模型（GGUF）',
    dir: 'diffusion_models',
    pattern: /^qwen-image-2\.1-turbo.*\.gguf$/i,
    names: [
      { name: 'qwen-image-2.1-turbo-Q6_K.gguf', bytes: 6_271_551_296 },
      { name: 'qwen-image-2.1-turbo-Q6_K_XL.gguf', minBytes: 6_000_000_000 },
      { name: 'qwen-image-2.1-turbo-Q8_0.gguf', minBytes: 6_500_000_000 },
      { name: 'qwen-image-2.1-turbo-Q5_K_M.gguf', minBytes: 4_500_000_000 },
      { name: 'qwen-image-2.1-turbo-Q4_K_M.gguf', minBytes: 3_500_000_000 },
      { name: 'qwen-image-2.1-turbo-Q3_K_XL.gguf', minBytes: 3_000_000_000 }
    ]
  },
  {
    label: '文本编码器',
    dir: 'text_encoders',
    names: [{ name: 'qwen3vl_8b_bf16.safetensors', bytes: 17_534_334_616 }]
  },
  {
    label: 'VAE',
    dir: 'vae',
    names: [{ name: 'qwen_image_2.1_vae_bf16.safetensors', bytes: 675_509_688 }]
  }
]

const VIDEO_SPECS: FileSpec[] = [
  {
    label: '参考图生视频模型（Ref2VA）',
    dir: 'diffusion_models',
    names: [{ name: 'minimax_h3_ref2va_dit_16g.safetensors', bytes: 28_403_358_856 }]
  },
  {
    label: '文本/图像编码器',
    dir: 'text_encoders',
    names: [{ name: 'qwen3vl_text_encoder.safetensors', bytes: 30_552_489_265 }]
  },
  {
    label: '视频 VAE',
    dir: 'vae',
    names: [{ name: 'minimax_h3_video_vae_fp16.safetensors', bytes: 5_207_808_496 }]
  },
  {
    label: '音频 VAE',
    dir: 'vae',
    names: [{ name: 'minimax_h3_audio_vae_fp32.safetensors', bytes: 605_254_808 }]
  }
]

const VIDEO_FL2VA_SPEC: FileSpec = {
  label: '首尾帧模型（FL2VA）',
  dir: 'diffusion_models',
  names: [{ name: 'minimax_h3_fl2va_dit_16g.safetensors', bytes: 28_364_846_456 }]
}

interface ComfyLists {
  gguf: string[]
  unet: string[]
  clips: string[]
  vaes: string[]
  nodes: { gguf: boolean; minimaxH3: boolean }
}

interface HealthInfo {
  online: boolean
  version?: string
  gpu?: string
  vramTotalMb?: number
  vramFreeMb?: number
  error?: string
}

interface PromptOutputFile {
  filename: string
  subfolder: string
  type: string
}

interface RunPromptOptions {
  settings: MediaEngineSettings
  workspace: string
  graph: Record<string, unknown>
  kind: MediaKind
  modelLabel: string
  labels: Record<string, string>
  timeoutMs: number
  seed: number
  signal: AbortSignal
  onProgress: (update: { stage: string; percent?: number }) => void
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) ? number : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('ComfyUI 地址只支持 http:// 或 https://。')
  if (url.username || url.password) throw new Error('ComfyUI 地址不能包含用户名或密码。')
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}


function wsUrlFor(baseUrl: string, clientId: string): string {
  const url = new URL(normalizeBaseUrl(baseUrl))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`
  url.search = ''
  url.searchParams.set('clientId', clientId)
  return url.toString()
}

function modelListFromInfo(info: Record<string, unknown> | null, node: string, input: string): string[] {
  const entry = asRecord(info?.[node])
  const required = asRecord(asRecord(entry?.input)?.required)
  const value = required?.[input]
  if (Array.isArray(value) && Array.isArray(value[0])) {
    return value[0].filter((item): item is string => typeof item === 'string')
  }
  return []
}

function pickFromList(list: string[], spec: FileSpec): string | null {
  const set = new Set(list)
  for (const candidate of spec.names) {
    if (set.has(candidate.name)) return candidate.name
  }
  const pattern = spec.pattern
  if (pattern) return list.find((name) => pattern.test(name)) ?? null
  return null
}

function extOf(path: string): string {
  return extname(path).replace(/^\./, '').toLowerCase()
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    case 'mp4': return 'video/mp4'
    case 'webm': return 'video/webm'
    case 'mov': return 'video/quicktime'
    case 'mkv': return 'video/x-matroska'
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'm4a': return 'audio/mp4'
    case 'flac': return 'audio/flac'
    case 'ogg': return 'audio/ogg'
    default: return 'application/octet-stream'
  }
}

function kindForExt(ext: string): MediaKind | null {
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return null
}

function kindForFile(path: string, probe?: MediaProbeResult): MediaArtifactResult['mediaKind'] {
  if (probe?.kind && probe.kind !== 'unknown') return probe.kind
  return kindForExt(extOf(path)) ?? 'image'
}

function ensureInside(workspace: string, target: string): string {
  const root = resolve(workspace)
  const full = resolve(target)
  if (full !== root && !full.startsWith(`${root}${sep}`)) {
    throw new Error('媒体文件必须位于当前工作区内。')
  }
  return full
}

function normalizeOutputDir(raw: string): string {
  const value = (raw || 'media').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!value || value.startsWith('.') || value.includes('..') || /^[a-zA-Z]:/.test(value)) {
    throw new Error('多媒体的输出目录必须是工作区内的相对目录（例如 media）。')
  }
  return value
}

function uniqueFilePath(dir: string, base: string, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'
  let index = 1
  let candidate = join(dir, `${base}.${safeExt}`)
  while (existsSync(candidate)) {
    index += 1
    candidate = join(dir, `${base}-${index}.${safeExt}`)
  }
  return candidate
}

function abortErr(): Error {
  const error = new Error('已停止生成。')
  error.name = 'AbortError'
  return error
}

function timeoutSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

function ffmpegFps(value: string | undefined): number | undefined {
  if (!value) return undefined
  const [num, den] = value.split('/').map(Number)
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function imageDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length > 10 && buffer.toString('ascii', 0, 6) === 'GIF89a') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
  }
  return null
}

export class MediaService implements MediaToolHandler {
  /** 由主进程注入的通用模型/引擎目录；工具层通过它做生命周期操作。 */
  catalog?: MediaCatalogHandler
  private child: ChildProcess | null = null
  private starting: Promise<MediaEngineStatus> | null = null
  private lastStartError: string | null = null

  constructor(private readonly readSettings: () => Settings = () => getSettingsStore().get()) {}

  private settings(): MediaEngineSettings {
    const settings = this.readSettings().mediaEngine
    return { ...settings, comfyuiDir: locateComfyui(settings) ?? settings.comfyuiDir }
  }

  private async fetchJson<T>(
    url: string,
    init: RequestInit = {},
    timeoutMs = 8_000,
    signal?: AbortSignal
  ): Promise<T> {
    const composed = signal ? timeoutSignal(signal, timeoutMs) : AbortSignal.timeout(timeoutMs)
    const response = await fetch(url, { ...init, signal: composed })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`ComfyUI 返回 HTTP ${response.status}：${text.slice(0, 400)}`)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error('ComfyUI 返回的不是 JSON，请检查地址是否指向了 ComfyUI 服务。')
    }
  }

  private async health(settings = this.settings(), timeoutMs = 2_500): Promise<HealthInfo> {
    try {
      const stats = await this.fetchJson<Record<string, unknown>>(
        `${normalizeBaseUrl(settings.comfyuiUrl)}/system_stats`,
        {},
        timeoutMs
      )
      const system = asRecord(stats.system) ?? {}
      const devices = Array.isArray(stats.devices) ? stats.devices : []
      const device = asRecord(devices[0]) ?? {}
      const vramTotal = asNumber(device.vram_total)
      const vramFree = asNumber(device.vram_free)
      return {
        online: true,
        ...(asString(system.comfyui_version) ? { version: asString(system.comfyui_version) } : {}),
        ...(asString(device.name) ? { gpu: asString(device.name) } : {}),
        ...(vramTotal ? { vramTotalMb: Math.round(vramTotal / 1024 / 1024) } : {}),
        ...(vramFree ? { vramFreeMb: Math.round(vramFree / 1024 / 1024) } : {})
      }
    } catch (err) {
      return { online: false, error: err instanceof Error ? err.message : '无法连接 ComfyUI' }
    }
  }

  private async comfyLists(settings: MediaEngineSettings, signal?: AbortSignal): Promise<ComfyLists> {
    const base = normalizeBaseUrl(settings.comfyuiUrl)
    const names = [
      'UnetLoaderGGUF',
      'UNETLoader',
      'CLIPLoader',
      'VAELoader',
      'MiniMaxH3MemoryEfficientSolAttentionPatch',
      'TextEncodeQwenImage21',
      'MiniMaxH3ReferenceToVideo'
    ]
    const responses = await Promise.all(
      names.map(async (name) => {
        try {
          return await this.fetchJson<Record<string, unknown>>(`${base}/object_info/${encodeURIComponent(name)}`, {}, 6_000, signal)
        } catch {
          return null
        }
      })
    )
    const [ggufInfo, unetInfo, clipInfo, vaeInfo, solInfo, qwenTextInfo, minimaxCoreInfo] = responses
    return {
      gguf: modelListFromInfo(ggufInfo, 'UnetLoaderGGUF', 'unet_name'),
      unet: modelListFromInfo(unetInfo, 'UNETLoader', 'unet_name'),
      clips: modelListFromInfo(clipInfo, 'CLIPLoader', 'clip_name'),
      vaes: modelListFromInfo(vaeInfo, 'VAELoader', 'vae_name'),
      nodes: {
        gguf: Boolean(ggufInfo?.UnetLoaderGGUF) && Boolean(qwenTextInfo?.TextEncodeQwenImage21),
        minimaxH3:
          Boolean(solInfo?.MiniMaxH3MemoryEfficientSolAttentionPatch) &&
          Boolean(minimaxCoreInfo?.MiniMaxH3ReferenceToVideo)
      }
    }
  }

  private diskModels(settings: MediaEngineSettings, specs: FileSpec[]): MediaEngineModelStatus {
    const installed: string[] = []
    const missing: string[] = []
    for (const spec of specs) {
      let found: string | null = null
      let incomplete: string | null = null
      if (settings.comfyuiDir) {
        for (const candidate of spec.names) {
          const path = join(settings.comfyuiDir, 'models', spec.dir, candidate.name)
          if (!existsSync(path)) continue
          const size = statSync(path).size
          const expected = candidate.bytes
          const min = candidate.minBytes ?? 0
          if (size <= 0 || (expected && Math.abs(size - expected) > 1_048_576) || size < min) {
            incomplete = candidate.name
            continue
          }
          found = candidate.name
          break
        }
      }
      if (found) installed.push(found)
      else missing.push(`models/${spec.dir}/${spec.names[0].name}${incomplete ? '（文件不完整，请重新下载）' : ''}`)
    }
    return {
      id: specs === IMAGE_SPECS ? 'image' : 'video',
      label: specs === IMAGE_SPECS ? `图片 · ${IMAGE_MODEL_LABEL}` : `视频 · ${VIDEO_MODEL_LABEL}`,
      ready: missing.length === 0,
      verified: true,
      missing,
      installed
    }
  }

  private onlineModels(lists: ComfyLists, specs: FileSpec[]): MediaEngineModelStatus {
    const source = specs === IMAGE_SPECS ? lists.gguf : lists.unet
    const installed: string[] = []
    const missing: string[] = []
    for (const spec of specs) {
      const list =
        spec.dir === 'diffusion_models' ? source : spec.dir === 'text_encoders' ? lists.clips : lists.vaes
      const found = pickFromList(list, spec)
      if (found) installed.push(found)
      else missing.push(`models/${spec.dir}/${spec.names[0].name}`)
    }
    return {
      id: specs === IMAGE_SPECS ? 'image' : 'video',
      label: specs === IMAGE_SPECS ? `图片 · ${IMAGE_MODEL_LABEL}` : `视频 · ${VIDEO_MODEL_LABEL}`,
      ready: missing.length === 0,
      verified: true,
      missing,
      installed
    }
  }

  private resolveFfmpeg(settings = this.settings()): { binary: string; ffprobe: string; configured: boolean } {
    const configured = settings.ffmpegPath?.trim()
    if (configured) {
      const binary = statSync(configured, { throwIfNoEntry: false })?.isDirectory()
        ? join(configured, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
        : configured
      const probeCandidate = join(dirname(binary), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
      return {
        binary,
        ffprobe: existsSync(probeCandidate) ? probeCandidate : process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
        configured: true
      }
    }
    const finder = process.platform === 'win32' ? 'where.exe' : 'which'
    const result = spawnSync(finder, ['ffmpeg'], { encoding: 'utf8', windowsHide: true })
    const found = result.status === 0 ? (result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) : undefined
    return {
      binary: found ?? (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
      ffprobe: process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
      configured: false
    }
  }

  private async ffmpegInfo(settings: MediaEngineSettings): Promise<MediaEngineStatus['ffmpeg']> {
    let resolved: ReturnType<MediaService['resolveFfmpeg']>
    try {
      resolved = this.resolveFfmpeg(settings)
    } catch (err) {
      return { available: false, message: err instanceof Error ? err.message : 'ffmpeg 路径无效' }
    }
    try {
      const result = await this.runProcess(resolved.binary, ['-version'], { timeoutMs: 8_000 })
      const first = result.stdout.split(/\r?\n/).find(Boolean) ?? result.stderr.split(/\r?\n/).find(Boolean)
      if (result.code !== 0) {
        return { available: false, path: resolved.binary, message: first || 'ffmpeg 无法运行' }
      }
      return { available: true, path: resolved.binary, version: first?.slice(0, 160), message: '可用' }
    } catch (err) {
      return {
        available: false,
        path: resolved.configured ? resolved.binary : undefined,
        message: err instanceof Error ? err.message : '找不到 ffmpeg；剪辑与视频缩略图将不可用。'
      }
    }
  }

  private detectPython(dir: string | null): string | null {
    if (!dir) return null
    const candidates =
      process.platform === 'win32'
        ? [
            join(dir, '.venv', 'Scripts', 'python.exe'),
            join(dir, 'venv', 'Scripts', 'python.exe'),
            join(dir, 'python_embeded', 'python.exe'),
            join(dir, 'python_embedded', 'python.exe')
          ]
        : [join(dir, '.venv', 'bin', 'python'), join(dir, 'venv', 'bin', 'python'), join(dir, 'python_embeded', 'python')]
    return candidates.find((candidate) => existsSync(candidate)) ?? null
  }

  private canStart(settings: MediaEngineSettings): boolean {
    if (!settings.comfyuiDir || !isLocalServiceUrl(settings.comfyuiUrl)) return false
    return existsSync(join(settings.comfyuiDir, 'main.py')) && Boolean(this.detectPython(settings.comfyuiDir))
  }

  async status(): Promise<MediaEngineStatus> {
    const settings = this.settings()
    let health = await this.health(settings)
    let lists: ComfyLists | null = null
    if (health.online) {
      try {
        lists = await this.comfyLists(settings)
      } catch {
        // object_info 失败不把引擎判死；模型清单回退到本地目录
      }
    }
    const diskImage = settings.comfyuiDir ? this.diskModels(settings, IMAGE_SPECS) : null
    const diskVideo = settings.comfyuiDir ? this.diskModels(settings, VIDEO_SPECS) : null
    const videoModel: MediaEngineModelStatus =
      diskVideo ??
      (lists
        ? this.onlineModels(lists, VIDEO_SPECS)
        : {
            id: 'video' as const,
            label: `视频 · ${VIDEO_MODEL_LABEL}`,
            ready: false,
            verified: false,
            missing: [],
            installed: []
          })
    const ref2vaInstalled =
      videoModel.installed.includes('minimax_h3_ref2va_dit_16g.safetensors') ||
      Boolean(lists?.unet.includes('minimax_h3_ref2va_dit_16g.safetensors'))
    let fl2vaInstalled = false
    if (settings.comfyuiDir) {
      const path = join(settings.comfyuiDir, 'models', 'diffusion_models', 'minimax_h3_fl2va_dit_16g.safetensors')
      if (existsSync(path)) {
        const size = statSync(path).size
        fl2vaInstalled = Math.abs(size - 28_364_846_456) <= 1_048_576
      }
    }
    if (!fl2vaInstalled && lists) {
      fl2vaInstalled = lists.unet.includes('minimax_h3_fl2va_dit_16g.safetensors')
    }
    if (fl2vaInstalled && !videoModel.installed.includes('minimax_h3_fl2va_dit_16g.safetensors')) {
      videoModel.installed = [...videoModel.installed, 'minimax_h3_fl2va_dit_16g.safetensors']
    }
    videoModel.modes = { ref2va: ref2vaInstalled, fl2va: fl2vaInstalled }
    if (!ref2vaInstalled && fl2vaInstalled) {
      videoModel.missing = videoModel.missing.filter((path) => !path.includes('minimax_h3_ref2va'))
      videoModel.ready = videoModel.missing.length === 0
    } else if (videoModel.verified && !ref2vaInstalled && !fl2vaInstalled) {
      const fl2vaMissing = 'models/diffusion_models/minimax_h3_fl2va_dit_16g.safetensors'
      if (!videoModel.missing.includes(fl2vaMissing)) videoModel.missing = [...videoModel.missing, fl2vaMissing]
      videoModel.ready = false
    }
    const models = [
      diskImage ?? (lists ? this.onlineModels(lists, IMAGE_SPECS) : {
        id: 'image' as const, label: `图片 · ${IMAGE_MODEL_LABEL}`, ready: false, verified: false,
        missing: [], installed: []
      }),
      videoModel
    ]
    const nodes = lists?.nodes ?? { gguf: false, minimaxH3: false }
    let message = health.online
      ? '已连接 ComfyUI。'
      : this.lastStartError
        ? `ComfyUI 未连接：${this.lastStartError}`
        : this.canStart(settings)
          ? 'ComfyUI 尚未启动，可在设置里一键启动。'
          : 'ComfyUI 未连接；请先在设置里填写安装目录或手动启动。'
    if (health.online && !nodes.gguf) message += ' 图片模型缺少 ComfyUI-GGUF 节点。'
    if (health.online && !nodes.minimaxH3) message += ' 视频模型缺少 MiniMax H3 加速节点（sol-attn）。'
    return {
      engine: {
        online: health.online,
        url: settings.comfyuiUrl,
        message,
        ...(health.version ? { version: health.version } : {}),
        ...(health.gpu ? { gpu: health.gpu } : {}),
        ...(health.vramTotalMb ? { vramTotalMb: health.vramTotalMb } : {}),
        ...(health.vramFreeMb ? { vramFreeMb: health.vramFreeMb } : {})
      },
      models,
      nodes,
      ffmpeg: await this.ffmpegInfo(settings),
      comfyuiDir: settings.comfyuiDir,
      canStart: this.canStart(settings)
    }
  }

  async stopEngine(): Promise<void> {
    const child = this.child
    if (!child || child.killed) throw new Error('ComfyUI 不是由 Morrow 启动的，无法安全停止；请在终端结束对应进程。')
    this.child = null
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill()
    }
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(() => resolveWait(), 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveWait()
      })
    })
  }

  async startEngine(): Promise<MediaEngineStatus> {
    const settings = this.settings()
    const health = await this.health(settings)
    if (health.online) return this.status()
    if (!settings.comfyuiDir) throw new Error('还没有填写 ComfyUI 安装目录。')
    if (!isLocalServiceUrl(settings.comfyuiUrl)) throw new Error('只能启动本机（127.0.0.1 / localhost）的 ComfyUI。')
    if (!existsSync(join(settings.comfyuiDir, 'main.py'))) throw new Error('安装目录里找不到 main.py，请确认选择的是 ComfyUI 根目录。')
    const python = this.detectPython(settings.comfyuiDir)
    if (!python) throw new Error('找不到 ComfyUI 的 Python 环境（.venv / venv / python_embeded）。')
    if (this.starting) return this.starting
    this.starting = (async () => {
      const port = new URL(settings.comfyuiUrl).port || '8188'
      const logPath = join(settings.comfyuiDir!, 'morrow-comfyui.log')
      // 从 MSYS/Git Bash 等环境启动时 TEMP 可能是 /tmp，Windows 子进程不可用；
      // 固定到引擎目录下的真实可写临时目录，避免 torch 初始化时报“无可用临时目录”。
      const engineTemp = join(settings.comfyuiDir!, 'morrow-temp')
      mkdirSync(engineTemp, { recursive: true })
      const fd = openSync(logPath, 'a')
      this.lastStartError = null
      const child = spawn(
        python,
        ['main.py', '--listen', '127.0.0.1', '--port', port, '--reserve-vram', '2.5'],
        {
          cwd: settings.comfyuiDir!,
          windowsHide: true,
          detached: false,
          stdio: ['ignore', fd, fd],
          env: { ...process.env, TEMP: engineTemp, TMP: engineTemp }
        }
      )
      closeSync(fd)
      this.child = child
      const exitState: { value: { code: number | null; error?: string } | null } = { value: null }
      child.on('exit', (code) => { exitState.value = { code } })
      child.on('error', (err) => { exitState.value = { code: null, error: err.message } })
      try {
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1_500))
          if (exitState.value) break
          const check = await this.health(settings, 1_500)
          if (check.online) {
            log.info('media engine started', { port })
            return this.status()
          }
        }
        let tail = ''
        try {
          tail = readFileSync(logPath, 'utf8').slice(-2_000)
        } catch {
          // 日志读取失败不覆盖真实错误
        }
        const message =
          exitState.value?.error ??
          `启动超时${tail ? `：${tail.slice(-600)}` : '，请查看 morrow-comfyui.log'}`
        this.lastStartError = message
        throw new Error(message)
      } finally {
        if (exitState.value && this.child === child) this.child = null
        this.starting = null
      }
    })()
    return this.starting
  }

  private async ensureReady(
    kind: 'image' | 'video' | 'audio',
    onProgress: (update: { stage: string; percent?: number }) => void,
    signal: AbortSignal
  ): Promise<{ settings: MediaEngineSettings; lists: ComfyLists }> {
    const settings = this.settings()
    if (!settings.enabled) throw new Error('多媒体功能已在设置中关闭。')
    let health = await this.health(settings)
    if (!health.online && settings.autoStart && this.canStart(settings)) {
      onProgress({ stage: '正在启动 ComfyUI', percent: 1 })
      await this.startEngine()
      health = await this.health(settings)
    }
    if (!health.online) {
      throw new Error(
        this.canStart(settings)
          ? 'ComfyUI 没有启动。请在设置 → 多媒体里点「启动引擎」，或手动运行 ComfyUI。'
          : `连接不上 ComfyUI（${settings.comfyuiUrl}）。请在设置 → 多媒体里填写安装目录并启动，或先手动运行 ComfyUI。`
      )
    }
    if (signal.aborted) throw abortErr()
    const lists = await this.comfyLists(settings, signal)
    if (kind === 'image' && !lists.nodes.gguf) {
      throw new Error('ComfyUI 缺少 ComfyUI-GGUF 节点，无法加载 Qwen 的 GGUF 权重。请把它放到 custom_nodes 并重启。')
    }
    if (kind === 'video' && !lists.nodes.minimaxH3) {
      throw new Error('ComfyUI 缺少 MiniMax H3 加速节点（sol-attn）。请把 ComfyUI-sol-attn-main 放到 custom_nodes 并重启。')
    }
    return { settings, lists }
  }

  private resolveNames(
    kind: 'image' | 'video',
    lists: ComfyLists,
    videoMode: 'reference' | 'first-only' | 'first-last' = 'reference'
  ): Record<string, string> {
    if (kind === 'image') {
      const gguf = pickFromList(lists.gguf, IMAGE_SPECS[0])
      const clip = pickFromList(lists.clips, IMAGE_SPECS[1])
      const vae = pickFromList(lists.vaes, IMAGE_SPECS[2])
      if (!gguf || !clip || !vae) {
        const missing = [!gguf && IMAGE_SPECS[0], !clip && IMAGE_SPECS[1], !vae && IMAGE_SPECS[2]]
          .filter(Boolean)
          .map((spec) => `models/${(spec as FileSpec).dir}/${(spec as FileSpec).names[0].name}`)
        throw new Error(`ComfyUI 没有识别到图片模型：${missing.join('、')}。文件已下载的话，请重启 ComfyUI 刷新模型列表。`)
      }
      return { gguf, clip, vae }
    }
    const ditSpec = videoMode === 'reference' ? VIDEO_SPECS[0] : VIDEO_FL2VA_SPEC
    const unet = pickFromList(lists.unet, ditSpec)
    const clip = pickFromList(lists.clips, VIDEO_SPECS[1])
    const videoVae = pickFromList(lists.vaes, VIDEO_SPECS[2])
    const audioVae = pickFromList(lists.vaes, VIDEO_SPECS[3])
    if (!unet && videoMode !== 'reference') {
      throw new Error(
        '首尾帧模式需要 FL2VA 权重（minimax_h3_fl2va_dit_16g.safetensors）。请在设置 → 多媒体里补下载，并重启 ComfyUI 刷新模型列表。'
      )
    }
    if (!unet || !clip || !videoVae || !audioVae) {
      const missing = [!unet && ditSpec, !clip && VIDEO_SPECS[1], !videoVae && VIDEO_SPECS[2], !audioVae && VIDEO_SPECS[3]]
        .filter(Boolean)
        .map((spec) => `models/${(spec as FileSpec).dir}/${(spec as FileSpec).names[0].name}`)
      throw new Error(`ComfyUI 没有识别到视频模型：${missing.join('、')}。文件已下载的话，请重启 ComfyUI 刷新模型列表。`)
    }
    return { unet, clip, videoVae, audioVae }
  }

  private buildQwenT2I(names: Record<string, string>, prompt: string, width: number, height: number, seed: number): Record<string, unknown> {
    return {
      unet: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: names.gguf } },
      cache: { class_type: 'QwenImage21Cache', inputs: { model: ['unet', 0], device: 'auto', dtype: 'default' } },
      clip: { class_type: 'CLIPLoader', inputs: { clip_name: names.clip, type: 'qwen_image', device: 'default' } },
      vae: { class_type: 'VAELoader', inputs: { vae_name: names.vae } },
      text: {
        class_type: 'TextEncodeQwenImage21',
        inputs: { clip: ['clip', 0], prompt, negative_prompt: '', resolution: 1024 }
      },
      latent: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
      guider: { class_type: 'CFGGuider', inputs: { model: ['cache', 0], positive: ['text', 0], negative: ['text', 1], cfg: 1.0 } },
      noise: { class_type: 'RandomNoise', inputs: { noise_seed: seed, control_after_generate: 'fixed' } },
      sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
      sigmas: { class_type: 'ManualSigmas', inputs: { sigmas: QWEN_SIGMAS } },
      sample: {
        class_type: 'SamplerCustomAdvanced',
        inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['latent', 0] }
      },
      decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
      save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'morrow/image/morrow' } }
    }
  }

  private buildQwenEdit(
    names: Record<string, string>,
    prompt: string,
    imageName: string,
    seed: number
  ): Record<string, unknown> {
    // 0 = 保留参考图原始尺寸（仅对齐到 32 的倍数），避免编辑后画面被无故缩放
    const resolution = 0
    const directive = /<image1>/i.test(prompt)
      ? prompt
      : `<image1> is the edit target. Keep the subject, pose, composition, background and lighting unchanged unless the instruction explicitly asks to change them. ${prompt}`
    return {
      unet: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: names.gguf } },
      cache: { class_type: 'QwenImage21Cache', inputs: { model: ['unet', 0], device: 'auto', dtype: 'default' } },
      clip: { class_type: 'CLIPLoader', inputs: { clip_name: names.clip, type: 'qwen_image', device: 'default' } },
      vae: { class_type: 'VAELoader', inputs: { vae_name: names.vae } },
      image: { class_type: 'LoadImage', inputs: { image: imageName } },
      text: {
        class_type: 'TextEncodeQwenImage21',
        inputs: {
          clip: ['clip', 0],
          prompt: directive,
          negative_prompt: '',
          resolution,
          // ComfyUI 的 Autogrow 动态输入在 API 里是扁平键，不能嵌套成 images:{...}
          'images.image_1': ['image', 0],
          vae: ['vae', 0]
        }
      },
      guider: { class_type: 'CFGGuider', inputs: { model: ['cache', 0], positive: ['text', 0], negative: ['text', 1], cfg: 1.0 } },
      noise: { class_type: 'RandomNoise', inputs: { noise_seed: seed, control_after_generate: 'fixed' } },
      sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
      sigmas: { class_type: 'ManualSigmas', inputs: { sigmas: QWEN_SIGMAS } },
      sample: {
        class_type: 'SamplerCustomAdvanced',
        inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['text', 2] }
      },
      decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } },
      save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'morrow/image/morrow' } }
    }
  }

  private buildMiniMaxVideo(
    names: Record<string, string>,
    prompt: string,
    firstImageName: string,
    lastImageName: string | undefined,
    width: number,
    height: number,
    frames: number,
    seed: number,
    mode: 'reference' | 'first-only' | 'first-last'
  ): Record<string, unknown> {
    const refInputs: Record<string, unknown> = {}
    if (mode === 'reference') {
      // Autogrow 动态输入在 API 里是扁平键
      refInputs['ref_images.ref_image_0'] = ['ref0', 0]
      if (lastImageName) refInputs['ref_images.ref_image_1'] = ['ref1', 0]
    }
    const minimaxNode =
      mode === 'reference'
        ? {
            class_type: 'MiniMaxH3ReferenceToVideo',
            inputs: {
              clip: ['clip', 0], prompt, width, height, length: frames, ref_image_size: 'match',
              vae: ['videoVae', 0], audio_vae: ['audioVae', 0], ...refInputs
            }
          }
        : {
            class_type: 'MiniMaxH3ImageToVideo',
            inputs: {
              clip: ['clip', 0], prompt, width, height, length: frames,
              vae: ['videoVae', 0], first_frame: ['ref0', 0],
              ...(mode === 'first-last' && lastImageName ? { last_frame: ['ref1', 0] } : {})
            }
          }
    const graph: Record<string, unknown> = {
      unet: { class_type: 'UNETLoader', inputs: { unet_name: names.unet, weight_dtype: 'default' } },
      sol: {
        class_type: 'MiniMaxH3MemoryEfficientSolAttentionPatch',
        inputs: {
          model: ['unet', 0], enabled: true, tau: 1.0, min_tokens: 4096, strict: true,
          thresh_type: 'diag', int8_qk: false, int8_pv: false, sink_conditioning: 'exact_kv', dense_blocks: ''
        }
      },
      fused: { class_type: 'MiniMaxH3FusedModulation', inputs: { model: ['sol', 0], enabled: true } },
      chunk: {
        class_type: 'MiniMaxH3ChunkFeedForward',
        inputs: { model: ['fused', 0], enabled: true, chunks: 4, min_tokens: 8192 }
      },
      cache: {
        class_type: 'EasyCache',
        inputs: { model: ['chunk', 0], reuse_threshold: 0.1, start_percent: 0.15, end_percent: 0.85, verbose: false }
      },
      clip: { class_type: 'CLIPLoader', inputs: { clip_name: names.clip, type: 'minimax', device: 'default' } },
      videoVae: { class_type: 'VAELoader', inputs: { vae_name: names.videoVae } },
      audioVae: { class_type: 'VAELoader', inputs: { vae_name: names.audioVae } },
      guider: { class_type: 'BasicGuider', inputs: { model: ['cache', 0], conditioning: ['minimax', 0] } },
      sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
      scheduler: {
        class_type: 'BasicScheduler',
        inputs: { model: ['cache', 0], scheduler: 'simple', steps: 20, denoise: 1.0 }
      },
      noise: { class_type: 'RandomNoise', inputs: { noise_seed: seed, control_after_generate: 'fixed' } },
      minimax: minimaxNode,
      sample: {
        class_type: 'SamplerCustomAdvanced',
        inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['scheduler', 0], latent_image: ['minimax', 1] }
      },
      decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['videoVae', 0] } },
      audioDecode: { class_type: 'VAEDecodeAudio', inputs: { samples: ['sample', 0], vae: ['audioVae', 0] } },
      createVideo: { class_type: 'CreateVideo', inputs: { images: ['decode', 0], audio: ['audioDecode', 0], fps: 24 } },
      save: { class_type: 'SaveVideo', inputs: { video: ['createVideo', 0], filename_prefix: 'morrow/video/morrow', format: 'auto', codec: 'auto' } }
    }
    graph.ref0 = { class_type: 'LoadImage', inputs: { image: firstImageName } }
    if (lastImageName) graph.ref1 = { class_type: 'LoadImage', inputs: { image: lastImageName } }
    return graph
  }

  async runWorkflow(input: MediaRunWorkflowInput): Promise<MediaArtifactResult> {
    const kind = input.workflow.outputKind
    const { settings } = await this.ensureReady(kind, input.onProgress, input.signal)
    const workspace = ensureInside(input.workspace, input.workspace)
    const width = Math.max(64, Math.min(2048, Math.round(input.width / 32) * 32))
    const height = Math.max(64, Math.min(2048, Math.round(input.height / 32) * 32))
    const seed = input.seed ?? Math.floor(Math.random() * 4_294_967_295)
    const graph = JSON.parse(JSON.stringify(input.workflow.graph)) as Record<string, unknown>
    const set = (binding: { node: string; input: string } | undefined, value: unknown): void => {
      if (!binding || value === undefined) return
      const node = asRecord(graph[binding.node])
      const inputs = asRecord(node?.inputs)
      if (!node || !inputs) throw new Error(`工作流绑定指向不存在的节点/输入：${binding.node}.${binding.input}`)
      inputs[binding.input] = value
    }
    set(input.workflow.bindings.prompt, input.prompt)
    set(input.workflow.bindings.negativePrompt, input.negativePrompt ?? '')
    set(input.workflow.bindings.width, width)
    set(input.workflow.bindings.height, height)
    set(input.workflow.bindings.seed, seed)
    set(input.workflow.bindings.seconds, input.seconds)
    set(input.workflow.bindings.fps, 24)
    const images = input.referencePaths.slice(0, 2)
    for (let index = 0; index < images.length; index += 1) {
      ensureInside(workspace, images[index])
      const uploaded = await this.uploadImage(settings, images[index], input.signal)
      if (index === 0) set(input.workflow.bindings.image, uploaded)
      else set(input.workflow.bindings.lastImage, uploaded)
    }
    input.onProgress({ stage: `加载 ${input.modelLabel}`, percent: 2 })
    const result = await this.runPrompt({
      settings,
      workspace,
      graph,
      kind,
      modelLabel: input.modelLabel,
      labels: {},
      timeoutMs: (kind === 'image' ? Math.max(60, settings.imageTimeoutSec) : Math.max(60, settings.videoTimeoutSec)) * 1000,
      seed,
      signal: input.signal,
      onProgress: input.onProgress
    })
    return { ...result, model: input.modelLabel, engine: 'ComfyUI', seed }
  }

  async generateImage(input: MediaGenerateImageInput): Promise<MediaArtifactResult> {
    const { settings, lists } = await this.ensureReady('image', input.onProgress, input.signal)
    const names = this.resolveNames('image', lists)
    const workspace = ensureInside(input.workspace, input.workspace)
    const width = Math.max(64, Math.min(2048, Math.round(input.width / 32) * 32))
    const height = Math.max(64, Math.min(2048, Math.round(input.height / 32) * 32))
    const seed = input.seed ?? Math.floor(Math.random() * 4_294_967_295)
    input.onProgress({ stage: '加载 Qwen-Image 模型', percent: 2 })
    let graph: Record<string, unknown>
    if (input.referencePath) {
      ensureInside(workspace, input.referencePath)
      const imageName = await this.uploadImage(settings, input.referencePath, input.signal)
      graph = this.buildQwenEdit(names, input.prompt, imageName, seed)
    } else {
      graph = this.buildQwenT2I(names, input.prompt, width, height, seed)
    }
    return this.runPrompt({
      settings,
      workspace,
      graph,
      kind: 'image',
      modelLabel: IMAGE_MODEL_LABEL,
      labels: { decode: '解码图片', save: '保存图片' },
      timeoutMs: Math.max(60, settings.imageTimeoutSec) * 1000,
      seed,
      signal: input.signal,
      onProgress: input.onProgress
    })
  }

  async generateVideo(input: MediaGenerateVideoInput): Promise<MediaArtifactResult> {
    if (input.referencePaths.length === 0) throw new Error('视频生成至少需要一张首帧/参考图。')
    const mode: 'reference' | 'first-only' | 'first-last' = input.lastFramePath
      ? 'first-last'
      : input.mode ?? 'reference'
    if (mode === 'first-last' && !input.lastFramePath) throw new Error('首尾帧模式需要 last_frame_path。')
    const { settings, lists } = await this.ensureReady('video', input.onProgress, input.signal)
    const names = this.resolveNames('video', lists, mode)
    const workspace = ensureInside(input.workspace, input.workspace)
    const width = Math.max(64, Math.min(2048, Math.round(input.width / 32) * 32))
    const height = Math.max(64, Math.min(2048, Math.round(input.height / 32) * 32))
    const seconds = Math.max(5, Math.min(15, input.seconds))
    const base = Math.max(5, Math.round(seconds * 24))
    const frames = base + ((5 - (base % 17)) % 17)
    const seed = input.seed ?? Math.floor(Math.random() * 4_294_967_295)
    input.onProgress({ stage: '上传首帧/参考图', percent: 2 })
    const imageNames: string[] = []
    const firstPath = input.referencePaths[0]
    ensureInside(workspace, firstPath)
    imageNames.push(await this.uploadImage(settings, firstPath, input.signal))
    let lastName: string | undefined
    if (mode === 'first-last' && input.lastFramePath) {
      ensureInside(workspace, input.lastFramePath)
      lastName = await this.uploadImage(settings, input.lastFramePath, input.signal)
    } else if (mode === 'reference') {
      for (const path of input.referencePaths.slice(1, 2)) {
        ensureInside(workspace, path)
        imageNames.push(await this.uploadImage(settings, path, input.signal))
      }
      lastName = imageNames[1]
    }
    const graph = this.buildMiniMaxVideo(names, input.prompt, imageNames[0], lastName, width, height, frames, seed, mode)
    input.onProgress({ stage: '加载 MiniMax-H3 模型', percent: 3 })
    const result = await this.runPrompt({
      settings,
      workspace,
      graph,
      kind: 'video',
      modelLabel: mode === 'reference' ? REF2VA_MODEL_LABEL : FL2VA_MODEL_LABEL,
      labels: {
        decode: '解码画面',
        audioDecode: '解码声音',
        createVideo: '合成视频',
        save: '保存视频'
      },
      timeoutMs: Math.max(120, settings.videoTimeoutSec) * 1000,
      seed,
      signal: input.signal,
      onProgress: input.onProgress
    })
    return {
      ...result,
      width: result.width ?? width,
      height: result.height ?? height,
      durationSec: result.durationSec ?? frames / 24,
      referencePath: firstPath
    }
  }

  async generateFilm(input: MediaGenerateFilmInput): Promise<MediaFilmResult> {
    if (!input.shots.length || input.shots.length < 2) throw new Error('短片至少需要 2 个分镜。')
    if (input.shots.length > 6) throw new Error('一次最多 6 个分镜；更长的短片请分批生成。')
    const workspace = ensureInside(input.workspace, input.workspace)
    const settings = this.settings()
    const status = await this.status()
    const videoStatus = status.models.find((model) => model.id === 'video')
    const fl2va = videoStatus?.modes?.fl2va === true
    if (input.shots.some((shot) => shot.lastFramePath) && !fl2va) {
      throw new Error('有分镜指定了末帧，但 FL2VA 首尾帧模型还没有安装。请先在设置 → 多媒体补齐 FL2VA 权重。')
    }
    const width = Math.max(64, Math.min(2048, Math.round(input.width / 32) * 32))
    const height = Math.max(64, Math.min(2048, Math.round(input.height / 32) * 32))
    const total = input.shots.length
    const startedAt = Date.now()
    const baseSeed = input.seed ?? Math.floor(Math.random() * 4_294_967_295)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const filmDir = join(workspace, normalizeOutputDir(settings.outputDir), 'films')
    mkdirSync(filmDir, { recursive: true })
    const shotResults: MediaArtifactResult[] = []
    let previousLastFrame: string | undefined
    let coverPath: string | undefined
    const report = (shotIndex: number, stage: string, localPercent?: number): void => {
      const span = 90 / total
      const base = 2 + shotIndex * span
      const inside = typeof localPercent === 'number' ? Math.min(1, Math.max(0, localPercent / 100)) : 0
      input.onProgress({
        stage: `分镜 ${shotIndex + 1}/${total} · ${stage}`,
        percent: Math.min(94, Math.round(base + (localPercent !== undefined ? inside * span * 0.8 : 0)))
      })
    }
    const style = input.style.trim()
    const preFrames: Array<string | undefined> = new Array(total)
    // 先集中生成需要新首帧的镜头（Qwen 只加载一次），再统一跑 MiniMax，避免模型来回换入换出。
    for (let index = 0; index < total; index += 1) {
      if (input.signal.aborted) throw abortErr()
      const shot = input.shots[index]
      if (index !== 0 && shot.continuePrevious !== false) continue
      report(index, '生成首帧', 2)
      const imagePrompt = [
        shot.imagePrompt ?? shot.prompt,
        style ? `整体风格：${style}。` : '',
        `这是短片的第 ${index + 1} 个镜头首帧，画面完整，适合继续运动。`
      ]
        .filter(Boolean)
        .join(' ')
      const image = await this.generateImage({
        workspace,
        prompt: imagePrompt,
        width,
        height,
        seed: baseSeed + index,
        signal: input.signal,
        onProgress: (update) => report(index, '生成首帧', update.percent)
      })
      preFrames[index] = image.path
      shotResults.push(image)
      if (!coverPath) coverPath = image.path
    }
    for (let index = 0; index < total; index += 1) {
      if (input.signal.aborted) throw abortErr()
      const shot = input.shots[index]
      let firstFrame = preFrames[index] ?? (index > 0 ? previousLastFrame : undefined)
      if (!firstFrame) {
        // 兜底：上一镜没有尾帧时重新生成本镜首帧（正常流程不会走到这里）
        report(index, '补生成首帧', 2)
        const image = await this.generateImage({
          workspace,
          prompt: [
            shot.imagePrompt ?? shot.prompt,
            style ? `整体风格：${style}。` : '',
            `这是短片的第 ${index + 1} 个镜头首帧，画面完整，适合继续运动。`
          ]
            .filter(Boolean)
            .join(' '),
          width,
          height,
          seed: baseSeed + index,
          signal: input.signal,
          onProgress: (update) => report(index, '补生成首帧', update.percent)
        })
        firstFrame = image.path
        shotResults.push(image)
        if (!coverPath) coverPath = image.path
      }
      const lastFramePath = shot.lastFramePath ? ensureInside(workspace, shot.lastFramePath) : undefined
      const mode: 'reference' | 'first-only' | 'first-last' = lastFramePath
        ? 'first-last'
        : index > 0 && firstFrame === previousLastFrame && fl2va
          ? 'first-only'
          : 'reference'
      const videoPrompt = [
        mode === 'reference' ? 'Picture 1 是这一镜的身份与画面参考。' : '',
        mode === 'first-last' ? '让画面从首帧自然过渡到末帧。' : '',
        shot.prompt,
        style ? `整体风格：${style}。` : ''
      ]
        .filter(Boolean)
        .join(' ')
      report(index, '生成视频', 2)
      const video = await this.generateVideo({
        workspace,
        prompt: videoPrompt,
        referencePaths: [firstFrame],
        ...(lastFramePath ? { lastFramePath } : {}),
        mode,
        width,
        height,
        seconds: Math.max(5, Math.min(10, shot.seconds || 5)),
        seed: baseSeed + index * 17,
        signal: input.signal,
        onProgress: (update) => report(index, '生成视频', update.percent)
      })
      shotResults.push(video)
      report(index, '提取尾帧', 2)
      const lastFrame = uniqueFilePath(filmDir, `${stamp}-shot-${String(index + 1).padStart(2, '0')}-last`, 'png')
      const extracted = await this.editMedia({
        workspace,
        inputPath: video.path,
        operation: 'extract_frame',
        fromEnd: true,
        outputPath: lastFrame,
        signal: input.signal,
        onProgress: () => undefined
      })
      previousLastFrame = extracted.path
    }
    if (input.signal.aborted) throw abortErr()
    input.onProgress({ stage: '拼接全片', percent: 95 })
    const filmPath = uniqueFilePath(filmDir, `film-${stamp}-${Math.random().toString(36).slice(2, 6)}`, 'mp4')
    const clipPaths = shotResults.filter((item) => item.mediaKind === 'video').map((item) => item.path)
    const film = await this.concatClips({
      workspace,
      paths: clipPaths,
      outputPath: filmPath,
      signal: input.signal,
      onProgress: () => undefined
    })
    input.onProgress({ stage: '短片完成', percent: 100 })
    return {
      ...film,
      model: `${IMAGE_MODEL_LABEL} + ${fl2va ? FL2VA_MODEL_LABEL : REF2VA_MODEL_LABEL}`,
      engine: 'ComfyUI + ffmpeg',
      elapsedMs: Date.now() - startedAt,
      shots: shotResults.filter((item) => item.mediaKind === 'video'),
      ...(coverPath ? { coverPath } : {})
    }
  }

  private async uploadImage(settings: MediaEngineSettings, filePath: string, signal: AbortSignal): Promise<string> {
    const stat = statSync(filePath)
    if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`参考图超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB，请先压缩。`)
    const ext = extOf(filePath)
    if (!IMAGE_EXT.has(ext)) throw new Error('参考图只支持 PNG/JPG/WebP/GIF。')
    const data = readFileSync(filePath)
    const form = new FormData()
    const filename = `morrow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
    form.append('image', new Blob([data], { type: mimeForExt(ext) }), filename)
    form.append('overwrite', 'true')
    const base = normalizeBaseUrl(settings.comfyuiUrl)
    const response = await fetch(`${base}/upload/image`, {
      method: 'POST',
      body: form,
      signal: timeoutSignal(signal, 120_000)
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`上传参考图失败（HTTP ${response.status}）：${text.slice(0, 300)}`)
    let json: Record<string, unknown>
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new Error('ComfyUI 上传接口返回了无法解析的内容。')
    }
    const name = asString(json.name) ?? asString(json.filename)
    if (!name) throw new Error('ComfyUI 上传接口没有返回文件名。')
    const subfolder = asString(json.subfolder)
    return subfolder ? `${subfolder}/${name}` : name
  }

  private async runPrompt(options: RunPromptOptions): Promise<MediaArtifactResult> {
    const { settings, graph, kind, modelLabel, labels, timeoutMs, signal, onProgress } = options
    const base = normalizeBaseUrl(settings.comfyuiUrl)
    const clientId = randomUUID()
    const startedAt = Date.now()
    let lastError: string | null = null
    const progressSocket = this.connectProgress(settings, clientId, (message) => {
      if (message.type === 'progress') {
        const data = asRecord(message.data) ?? {}
        const value = asNumber(data.value)
        const max = asNumber(data.max)
        if (value !== undefined && max && max > 0) {
          onProgress({ stage: `采样 ${Math.min(value, max)}/${max}`, percent: 4 + (Math.min(value, max) / max) * 88 })
        }
      } else if (message.type === 'execution_error') {
        const data = asRecord(message.data) ?? {}
        lastError = asString(data.exception_message) ?? lastError
      } else if (message.type === 'executing') {
        const data = asRecord(message.data) ?? {}
        const node = asString(data.node)
        if (!node) return
        const label = labels[node]
        if (label) onProgress({ stage: label, percent: node === 'save' ? 94 : 90 })
      }
    })
    try {
      if (signal.aborted) throw abortErr()
      let submitted: Record<string, unknown>
      try {
        submitted = await this.fetchJson<Record<string, unknown>>(
          `${base}/prompt`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: clientId }) },
          30_000,
          signal
        )
      } catch (err) {
        throw new Error(this.describePromptError(err))
      }
      const promptError = submitted.error
      if (promptError) throw new Error(this.describeComfyError(promptError))
      const nodeErrors = asRecord(submitted.node_errors)
      if (nodeErrors && Object.keys(nodeErrors).length > 0) {
        const details = Object.entries(nodeErrors)
          .map(([node, value]) => `${node}: ${asString(asRecord(value)?.class_type) ?? ''} ${JSON.stringify(asRecord(value)?.errors ?? value).slice(0, 300)}`)
          .join('；')
        throw new Error(`ComfyUI 拒绝了工作流：${details}`)
      }
      const promptId = asString(submitted.prompt_id)
      if (!promptId) throw new Error('ComfyUI 没有返回任务 ID。')
      onProgress({ stage: '已提交，等待执行', percent: 3 })
      const files = await this.waitForPrompt({ base, promptId, timeoutMs, signal, onProgress, labels })
      onProgress({ stage: '下载成品', percent: 95 })
      const file = files.find((item) => kindForExt(extOf(item.filename)) === kind) ?? files[0]
      if (!file) throw new Error('ComfyUI 任务完成，但没有返回可下载的文件。')
      const dest = await this.downloadOutput(settings, options.workspace, file, kind, signal)
      onProgress({ stage: '读取媒体信息', percent: 97 })
      const probe = await this.probeFile(settings, dest).catch(() => null)
      const bytes = statSync(dest).size
      const thumbnail = await this.thumbnail(settings, dest, kind)
      onProgress({ stage: '完成', percent: 100 })
      return {
        path: dest,
        mediaKind: kind,
        bytes,
        model: modelLabel,
        engine: 'ComfyUI',
        elapsedMs: Date.now() - startedAt,
        ...(probe?.width ? { width: probe.width } : {}),
        ...(probe?.height ? { height: probe.height } : {}),
        ...(probe?.durationSec !== undefined ? { durationSec: probe.durationSec } : {}),
        seed: options.seed,
        ...(thumbnail ? { thumbnailDataUrl: thumbnail } : {})
      }
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        await this.cancelPrompt(base, null).catch(() => undefined)
        throw abortErr()
      }
      throw err
    } finally {
      progressSocket.close()
    }
  }

  private describePromptError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err)
    if (/HTTP 400/i.test(message)) return `ComfyUI 不接受这个工作流：${message}`
    if (/fetch failed|ECONNREFUSED|aborted|timeout/i.test(message)) return 'ComfyUI 连接中断；请确认引擎仍在运行。'
    return message
  }

  private describeComfyError(value: unknown): string {
    const record = asRecord(value)
    const message = asString(record?.message) ?? asString(record?.type) ?? JSON.stringify(value)
    const details = asString(record?.details)
    return `ComfyUI 工作流错误：${message.slice(0, 500)}${details ? `（${details.slice(0, 300)}）` : ''}`
  }

  private connectProgress(
    settings: MediaEngineSettings,
    clientId: string,
    onMessage: (message: Record<string, unknown>) => void
  ): { close: () => void } {
    const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => {
      onopen: (() => void) | null
      onmessage: ((event: { data: unknown }) => void) | null
      onerror: (() => void) | null
      close: () => void
    } }).WebSocket
    if (!Ctor) return { close: () => undefined }
    let socket: InstanceType<typeof Ctor> | null = null
    try {
      socket = new Ctor(wsUrlFor(settings.comfyuiUrl, clientId))
    } catch {
      return { close: () => undefined }
    }
    const current = socket
    if (!current) return { close: () => undefined }
    current.onmessage = (event) => {
      try {
        const text =
          typeof event.data === 'string'
            ? event.data
            : event.data instanceof ArrayBuffer
              ? new TextDecoder().decode(event.data)
              : String(event.data)
        const parsed = JSON.parse(text) as Record<string, unknown>
        onMessage(parsed)
      } catch {
        // 忽略非 JSON 心跳
      }
    }
    current.onerror = () => undefined
    return { close: () => current.close() }
  }

  private async waitForPrompt(options: {
    base: string
    promptId: string
    timeoutMs: number
    signal: AbortSignal
    onProgress: (update: { stage: string; percent?: number }) => void
    labels: Record<string, string>
  }): Promise<PromptOutputFile[]> {
    const { base, promptId, timeoutMs, signal, onProgress } = options
    const deadline = Date.now() + timeoutMs
    let announcedQueue = false
    while (Date.now() < deadline) {
      if (signal.aborted) {
        await this.cancelPrompt(base, promptId).catch(() => undefined)
        throw abortErr()
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 800))
      let history: Record<string, unknown>
      try {
        history = await this.fetchJson<Record<string, unknown>>(`${base}/history/${encodeURIComponent(promptId)}`, {}, 15_000, signal)
      } catch (err) {
        if (signal.aborted) throw abortErr()
        throw err
      }
      const item = asRecord(history[promptId])
      if (item) {
        const status = asRecord(item.status) ?? {}
        if (asString(status.status_str) === 'error') {
          const messages = Array.isArray(status.messages) ? status.messages : []
          const detail = messages
            .map((message) => {
              const entry = Array.isArray(message) ? message : []
              const body = asRecord(entry[1]) ?? {}
              return asString(body.exception_message) ?? asString(body.message) ?? ''
            })
            .filter(Boolean)
            .join('；')
          throw new Error(`ComfyUI 执行失败：${detail || '未知错误（请查看 ComfyUI 控制台）'}`)
        }
        return this.collectOutputFiles(item.outputs)
      }
      if (!announcedQueue) {
        try {
          const queue = await this.fetchJson<Record<string, unknown>>(`${base}/queue`, {}, 5_000, signal)
          const running = Array.isArray(queue.queue_running) ? queue.queue_running : []
          const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending : []
          if (!running.some((entry) => this.promptIdOf(entry) === promptId)) {
            onProgress({ stage: `排队中（前方 ${pending.length} 个任务）`, percent: 4 })
            announcedQueue = true
          }
        } catch {
          // 队列查询失败不影响主轮询
        }
      }
    }
    await this.cancelPrompt(base, promptId).catch(() => undefined)
    throw new Error(`生成超时（超过 ${Math.round(timeoutMs / 1000)} 秒）。可以调低分辨率/时长后重试，或提高设置里的超时时间。`)
  }

  private promptIdOf(entry: unknown): string | null {
    if (Array.isArray(entry)) return typeof entry[1] === 'string' ? entry[1] : null
    const record = asRecord(entry)
    return asString(record?.prompt_id) ?? null
  }

  private collectOutputFiles(outputs: unknown): PromptOutputFile[] {
    const files: PromptOutputFile[] = []
    const seen = new Set<string>()
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk)
        return
      }
      const record = asRecord(value)
      if (!record) return
      const filename = asString(record.filename)
      if (filename) {
        const key = `${record.subfolder ?? ''}/${filename}`
        if (!seen.has(key)) {
          seen.add(key)
          files.push({
            filename,
            subfolder: asString(record.subfolder) ?? '',
            type: asString(record.type) ?? 'output'
          })
        }
      }
      Object.values(record).forEach(walk)
    }
    walk(outputs)
    return files
  }

  private async downloadOutput(
    settings: MediaEngineSettings,
    workspace: string,
    file: PromptOutputFile,
    kind: MediaKind,
    signal: AbortSignal
  ): Promise<string> {
    const base = normalizeBaseUrl(settings.comfyuiUrl)
    const safeName = basename(file.filename)
    const ext = extOf(safeName)
    if (!ext || !kindForExt(ext)) throw new Error(`ComfyUI 返回了不支持的文件：${safeName}`)
    const limit = kind === 'video' ? MAX_VIDEO_DOWNLOAD : MAX_IMAGE_DOWNLOAD
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })
    const response = await fetch(`${base}/view?${query.toString()}`, { signal: timeoutSignal(signal, 180_000) })
    if (!response.ok) throw new Error(`下载生成结果失败（HTTP ${response.status}）。`)
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > limit) throw new Error('生成结果过大，已拒绝下载。')
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0) throw new Error('下载到的生成结果为空。')
    if (buffer.length > limit) throw new Error('生成结果过大，已拒绝保存。')
    const outputDir = normalizeOutputDir(settings.outputDir)
    const folder = join(workspace, outputDir, kind === 'video' ? 'videos' : kind === 'audio' ? 'audio' : 'images')
    mkdirSync(folder, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const dest = uniqueFilePath(folder, `${kind}-${stamp}-${Math.random().toString(36).slice(2, 7)}`, ext)
    writeFileSync(dest, buffer)
    return dest
  }

  private async cancelPrompt(base: string, promptId: string | null): Promise<void> {
    try {
      if (promptId) {
        await this.fetchJson(`${base}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: [promptId] })
        }, 5_000)
      }
      const queue = await this.fetchJson<Record<string, unknown>>(`${base}/queue`, {}, 5_000)
      const running = Array.isArray(queue.queue_running) ? queue.queue_running : []
      const isRunning = promptId
        ? running.some((entry) => this.promptIdOf(entry) === promptId)
        : running.length > 0
      if (isRunning) {
        await this.fetchJson(`${base}/interrupt`, { method: 'POST', body: '{}' }, 5_000)
      }
    } catch {
      // 取消是尽力而为；引擎可能已经结束或断开
    }
  }

  private async runProcess(
    binary: string,
    args: string[],
    options: {
      signal?: AbortSignal
      timeoutMs?: number
      cwd?: string
      onStdout?: (line: string) => void
    } = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      let child: ChildProcess
      try {
        child = spawn(binary, args, {
          cwd: options.cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (err) {
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const onAbort = (): void => {
        try { child.kill() } catch { /* 忽略 */ }
        finish(() => reject(abortErr()))
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 忽略 */ }
        finish(() => reject(new Error('媒体处理超时。')))
      }, options.timeoutMs ?? 10 * 60_000)
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout = (stdout + chunk).slice(-500_000)
        if (options.onStdout) {
          for (const line of chunk.split(/\r?\n/)) if (line.trim()) options.onStdout(line.trim())
        }
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-200_000)
      })
      child.on('error', (err) => finish(() => reject(new Error(`无法启动 ${binary}：${err.message}`))))
      child.on('close', (code) => finish(() => resolvePromise({ code: code ?? -1, stdout, stderr })))
    })
  }

  private async probeFile(settings: MediaEngineSettings, filePath: string): Promise<MediaProbeResult> {
    const bytes = statSync(filePath).size
    const ext = extOf(filePath)
    const ff = this.resolveFfmpeg(settings)
    try {
      const result = await this.runProcess(ff.ffprobe, [
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath
      ], { timeoutMs: 30_000 })
      if (result.code === 0) {
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>
        const streams = Array.isArray(parsed.streams)
          ? parsed.streams
              .map((item) => asRecord(item))
              .filter((item): item is Record<string, unknown> => Boolean(item))
          : []
        const format = asRecord(parsed.format) ?? {}
        const video = streams.find((stream) => stream.codec_type === 'video') ?? null
        const audio = streams.find((stream) => stream.codec_type === 'audio') ?? null
        const width = asNumber(video?.width)
        const height = asNumber(video?.height)
        const duration = asNumber(format.duration) ?? asNumber(video?.duration) ?? asNumber(audio?.duration)
        const isImage = IMAGE_EXT.has(ext)
        const isCover = Boolean(video && asRecord(video.disposition)?.attached_pic)
        const kind: MediaProbeResult['kind'] = isImage ? 'image' : video && !isCover ? 'video' : audio ? 'audio' : 'unknown'
        const fps = video ? ffmpegFps(asString(video.avg_frame_rate) ?? asString(video.r_frame_rate)) : undefined
        const codec = asString(video?.codec_name) ?? asString(audio?.codec_name)
        return {
          kind,
          ...(width ? { width } : {}),
          ...(height ? { height } : {}),
          ...(duration !== undefined && !isImage ? { durationSec: duration } : {}),
          ...(fps !== undefined && !isImage ? { fps } : {}),
          ...(codec ? { codec } : {}),
          hasVideo: !isImage && !isCover && Boolean(video),
          hasAudio: Boolean(audio),
          bytes
        }
      }
    } catch {
      // 回退到图片头解析
    }
    if (IMAGE_EXT.has(ext)) {
      const dims = imageDimensions(readFileSync(filePath))
      return {
        kind: 'image',
        bytes,
        ...(dims ?? {})
      }
    }
    return { kind: kindForExt(ext) ?? 'unknown', bytes }
  }

  async probeMedia(input: { workspace: string; path: string }): Promise<MediaProbeResult> {
    const filePath = ensureInside(input.workspace, input.path)
    if (!existsSync(filePath)) throw new Error('媒体文件不存在。')
    return this.probeFile(this.settings(), filePath)
  }

  async renderAnimation(input: MediaRenderAnimationInput): Promise<MediaArtifactResult> {
    if (!BrowserWindow) throw new Error('当前环境没有 Electron 渲染窗口，无法渲染 HTML 动画。')
    const settings = this.settings()
    if (!settings.enabled) throw new Error('多媒体功能已在设置中关闭。')
    const workspace = ensureInside(input.workspace, input.workspace)
    const htmlPath = ensureInside(workspace, input.htmlPath)
    if (!existsSync(htmlPath)) throw new Error('HTML 动画文件不存在。')
    const ff = this.resolveFfmpeg(settings)
    const version = await this.runProcess(ff.binary, ['-version'], { timeoutMs: 8_000 }).catch(() => null)
    if (!version || version.code !== 0) throw new Error('找不到 ffmpeg，无法把帧序列合成为视频。')
    const duration = Math.max(0.5, Math.min(60, input.durationSec))
    const fps = Math.max(8, Math.min(60, Math.round(input.fps)))
    const width = Math.max(64, Math.min(2048, Math.round(input.width / 2) * 2))
    const height = Math.max(64, Math.min(2048, Math.round(input.height / 2) * 2))
    const totalFrames = Math.max(1, Math.round(duration * fps))
    const outputDir = normalizeOutputDir(settings.outputDir)
    const folder = join(workspace, outputDir, 'code')
    mkdirSync(folder, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const dest = input.outputPath
      ? ensureInside(workspace, input.outputPath)
      : uniqueFilePath(folder, `code-${stamp}-${Math.random().toString(36).slice(2, 6)}`, 'mp4')
    if (input.outputPath && existsSync(dest)) throw new Error('输出文件已存在，请换一个文件名。')
    mkdirSync(dirname(dest), { recursive: true })
    const framesDir = mkdtempSync(join(tmpdir(), 'morrow-code-frames-'))
    let win: BrowserWindow | null = null
    const startedAt = Date.now()
    try {
      win = new BrowserWindow({
        show: false,
        width,
        height,
        useContentSize: true,
        webPreferences: {
          offscreen: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          webSecurity: true
        }
      })
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.setFrameRate(fps)
      await win.loadURL(pathToFileURL(htmlPath).toString())
      await win.webContents.executeJavaScript(
        'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true'
      )
      const hasRenderAt = await win.webContents.executeJavaScript('typeof window.renderAt === "function"')
      if (!hasRenderAt) {
        throw new Error('页面没有提供 window.renderAt(t)。代码动画必须在 renderAt(t) 中同步绘制第 t 秒画面。')
      }
      for (let index = 0; index < totalFrames; index += 1) {
        if (input.signal.aborted) throw abortErr()
        const seconds = index / fps
        const t = input.timeUnit === 'milliseconds' ? seconds * 1000 : seconds
        await win.webContents.executeJavaScript(`window.renderAt(${t}); true`)
        await win.webContents.executeJavaScript(
          'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'
        )
        const captured = await win.webContents.capturePage()
        if (captured.isEmpty()) throw new Error(`第 ${index + 1} 帧捕获为空。`)
        const capturedSize = captured.getSize()
        const image =
          capturedSize.width === width && capturedSize.height === height
            ? captured
            : captured.resize({ width, height, quality: 'best' })
        const framePath = join(framesDir, `frame-${String(index + 1).padStart(5, '0')}.png`)
        writeFileSync(framePath, image.toPNG())
        if (index % Math.max(1, Math.round(fps / 2)) === 0 || index === totalFrames - 1) {
          input.onProgress({
            stage: `渲染帧 ${index + 1}/${totalFrames}`,
            percent: Math.round(2 + ((index + 1) / totalFrames) * 68)
          })
        }
      }
      input.onProgress({ stage: '合成视频', percent: 72 })
      const firstFrame = join(framesDir, 'frame-00001.png')
      log.info('render animation frames', { totalFrames, width, height, fps, firstFrameSize: existsSync(firstFrame) ? statSync(firstFrame).size : 0 })
      const result = await this.runProcess(
        ff.binary,
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-framerate', String(fps), '-i', join(framesDir, 'frame-%05d.png'),
          '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
          '-vf', `scale=${width}:${height}:flags=lanczos`,
          '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dest
        ],
        { signal: input.signal, timeoutMs: Math.max(180_000, duration * 4_000 + 120_000) }
      )
      if (result.code !== 0) {
        log.error('render animation ffmpeg failed', { stderr: result.stderr.slice(-4000), stdout: result.stdout.slice(-1000) })
        throw new Error(`代码动画合成失败：${(result.stderr || result.stdout).slice(-800)}`)
      }
      input.onProgress({ stage: '读取成品', percent: 96 })
      const probe = await this.probeFile(settings, dest)
      const thumbnail = await this.thumbnail(settings, dest, 'video')
      input.onProgress({ stage: '完成', percent: 100 })
      return {
        path: dest,
        mediaKind: 'video',
        bytes: statSync(dest).size,
        model: 'HTML/Canvas 代码渲染',
        engine: 'Electron + ffmpeg',
        elapsedMs: Date.now() - startedAt,
        ...(probe.width ? { width: probe.width } : {}),
        ...(probe.height ? { height: probe.height } : {}),
        ...(probe.durationSec !== undefined ? { durationSec: probe.durationSec } : {}),
        ...(thumbnail ? { thumbnailDataUrl: thumbnail } : {})
      }
    } finally {
      if (win && !win.isDestroyed()) win.destroy()
      try { rmSync(framesDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }

  private async concatClips(input: {
    workspace: string
    paths: string[]
    outputPath?: string
    signal: AbortSignal
    onProgress: (update: { stage: string; percent?: number }) => void
  }): Promise<MediaArtifactResult> {
    if (input.paths.length < 2) throw new Error('拼接至少需要 2 段视频。')
    const settings = this.settings()
    const workspace = ensureInside(input.workspace, input.workspace)
    const paths = input.paths.map((path) => ensureInside(workspace, path))
    for (const path of paths) {
      if (!existsSync(path)) throw new Error(`要拼接的片段不存在：${path}`)
    }
    const ff = this.resolveFfmpeg(settings)
    const outputDir = normalizeOutputDir(settings.outputDir)
    const folder = join(workspace, outputDir, 'edited')
    mkdirSync(folder, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const dest = input.outputPath
      ? ensureInside(workspace, input.outputPath)
      : uniqueFilePath(folder, `concat-${stamp}-${Math.random().toString(36).slice(2, 6)}`, 'mp4')
    if (existsSync(dest)) throw new Error('输出文件已存在，请换一个文件名。')
    mkdirSync(dirname(dest), { recursive: true })
    const probes = await Promise.all(paths.map((path) => this.probeFile(settings, path)))
    if (probes.some((probe) => probe.kind !== 'video')) throw new Error('拼接只接受视频文件。')
    if (probes.some((probe) => probe.hasAudio === false)) {
      throw new Error('拼接的片段必须有音轨；先用 render_animation 或生成视频得到带音轨的文件。')
    }
    const width = probes[0].width ?? 960
    const height = probes[0].height ?? 544
    const fps = Math.round(probes[0].fps ?? 24)
    const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y']
    for (const path of paths) args.push('-i', path)
    const filters: string[] = []
    for (let index = 0; index < paths.length; index += 1) {
      filters.push(
        `[${index}:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${index}]`
      )
      filters.push(`[${index}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`)
    }
    filters.push(`${paths.map((_, index) => `[v${index}][a${index}]`).join('')}concat=n=${paths.length}:v=1:a=1[v][a]`)
    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', dest
    )
    const startedAt = Date.now()
    input.onProgress({ stage: '拼接视频', percent: 5 })
    const result = await this.runProcess(ff.binary, args, { signal: input.signal, timeoutMs: 30 * 60_000 })
    if (result.code !== 0) throw new Error(`拼接失败：${(result.stderr || result.stdout).slice(-800)}`)
    const probe = await this.probeFile(settings, dest)
    const thumb = await this.thumbnail(settings, dest, 'video')
    input.onProgress({ stage: '完成', percent: 100 })
    return {
      path: dest,
      mediaKind: 'video',
      bytes: statSync(dest).size,
      model: 'ffmpeg',
      engine: '本机 ffmpeg',
      elapsedMs: Date.now() - startedAt,
      ...(probe.width ? { width: probe.width } : {}),
      ...(probe.height ? { height: probe.height } : {}),
      ...(probe.durationSec !== undefined ? { durationSec: probe.durationSec } : {}),
      ...(thumb ? { thumbnailDataUrl: thumb } : {})
    }
  }

  async describeMedia(input: MediaDescribeInput): Promise<MediaDescribeResult> {
    const startedAt = Date.now()
    const settings = this.readSettings()
    const filePath = ensureInside(input.workspace, input.path)
    if (!existsSync(filePath)) throw new Error('要审看的媒体文件不存在。')
    const probe = await this.probeFile(settings.mediaEngine, filePath)
    const frameCount = Math.max(1, Math.min(4, Math.round(input.frames ?? 3)))
    input.onProgress({ stage: '读取画面帧', percent: 8 })
    const images = await this.visionFrames(settings.mediaEngine, filePath, probe.kind, frameCount)
    if (images.length === 0) throw new Error('没有可送给视觉模型的画面帧。')
    const question =
      input.question?.trim() ||
      '请审看这些画面：主体是否一致、构图和风格有什么问题？给出 1–3 条具体、可执行的修改建议。用中文回答，控制在 120 字内。'
    const message: ChatMessage = {
      id: newId('vision'),
      role: 'user',
      content: [{ type: 'text', text: question }],
      createdAt: Date.now(),
      images
    }

    const current = input.visionProvider
    if (current?.model.supportsVision) {
      input.onProgress({ stage: `${current.model.label || current.model.id} 审看`, percent: 30 })
      try {
        const text = await this.streamVisionText(current.provider, message, input.signal, {
          // 视觉审看只需要短结论；给足输出预算，并尽量关闭思考，
          // 避免推理解码占满 max_tokens 后只返回空 content。
          maxTokens: 2_048,
          reasoning: this.visionReasoningFor(current.model)
        })
        if (!text) throw new Error('当前对话模型没有返回审看文字。')
        return {
          text,
          model: current.model.label || current.model.id,
          frameCount: images.length,
          elapsedMs: Date.now() - startedAt
        }
      } catch (err) {
        const currentError = err instanceof Error ? err.message : String(err)
        log.warn('current model vision failed; fallback to local', { error: currentError })
        try {
          const local = await this.describeWithLocalVision(settings, message, images.length, input, startedAt)
          return { ...local, fallback: true }
        } catch (localErr) {
          throw new Error(
            `当前模型审看失败（${currentError}）；本机视觉模型也不可用（${localErr instanceof Error ? localErr.message : String(localErr)}）。`
          )
        }
      }
    }
    return this.describeWithLocalVision(settings, message, images.length, input, startedAt)
  }

  /** 视觉审看不传思考档位时，推理模型可能把全部预算花在 thinking 上。 */
  private visionReasoningFor(model: import('../../shared/types').ModelInfo): { effort: 'off'; style: 'effort' | 'thinking' } | undefined {
    if (model.reasoningStyle === 'thinking') return { effort: 'off', style: 'thinking' }
    if (model.reasoningStyle === 'effort' && model.reasoningEfforts?.includes('off')) {
      return { effort: 'off', style: 'effort' }
    }
    return undefined
  }

  private async streamVisionText(
    provider: import('../../core/types').Provider,
    message: ChatMessage,
    signal: AbortSignal,
    options: {
      maxTokens?: number
      reasoning?: { effort: 'off'; style: 'effort' | 'thinking' }
    } = {}
  ): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 180_000)
    let text = ''
    let thinking = ''
    try {
      for await (const event of provider.stream({
        system: '你是严谨的视觉审片助手。只描述你实际看到的画面，给出可执行的改进建议，不要编造不存在的细节。',
        messages: [message],
        tools: [],
        signal: AbortSignal.any([signal, controller.signal]),
        maxTokens: options.maxTokens ?? 2_048,
        ...(options.reasoning ? { reasoning: options.reasoning } : {})
      })) {
        if (event.type === 'text_delta' && event.text) text += event.text
        if (event.type === 'thinking_delta' && event.text) thinking += event.text
      }
    } finally {
      clearTimeout(timer)
    }
    if (!text.trim() && thinking.trim()) {
      log.warn('vision model returned thinking but no final text', { thinkingChars: thinking.length })
    }
    return text.trim()
  }

  private async describeWithLocalVision(
    settings: Settings,
    message: ChatMessage,
    frameCount: number,
    input: MediaDescribeInput,
    startedAt: number
  ): Promise<MediaDescribeResult> {
    const providerConfig =
      settings.providers.find((provider) => provider.id === 'llamacpp') ??
      settings.providers.find((provider) => provider.category === 'local' && /:8000(?:\/|$)/.test(provider.baseUrl))
    // 只选明确支持视觉的本地模型；不能拿目录里的任意文本模型冒充视觉模型。
    const candidates = (providerConfig?.models ?? []).filter(
      (item) => item.supportsVision === true || /coder390|qwen3\.8-27b/i.test(item.id)
    )
    const model = candidates.find((item) => item.id === 'Qwen3.8-27B-Coder390') ?? candidates[0]
    if (!providerConfig || !model) {
      throw new Error(
        '没有可用的本地视觉模型。请在设置 → 多媒体启用带 --mmproj 的 Qwen3.8-27B-Coder390，或换用支持图片输入的对话模型。'
      )
    }
    const base = providerConfig.baseUrl.replace(/\/v1\/?$/, '')
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch {
      throw new Error('本地视觉模型没有运行。请先执行 %LOCALAPPDATA%\\Morrow\\local-llama\\start-qwen38.cmd，并确认启动参数包含 --mmproj。')
    }
    input.onProgress({ stage: '本地视觉模型审看', percent: 30 })
    const provider = createProvider(providerConfig, null, model.id)
    const text = await this.streamVisionText(provider, message, input.signal)
    if (!text) {
      throw new Error('视觉模型没有返回文字。请确认 llama-server 启动时带上了 --mmproj，且模型支持视觉。')
    }
    return {
      text,
      model: model.label || model.id,
      frameCount,
      elapsedMs: Date.now() - startedAt
    }
  }

  private async visionFrames(
    settings: MediaEngineSettings,
    filePath: string,
    kind: MediaProbeResult['kind'],
    count: number
  ): Promise<ChatImage[]> {
    const images: ChatImage[] = []
    if (kind === 'image') {
      const thumb = await this.thumbnail(settings, filePath, 'image')
      if (thumb) {
        const match = /^data:([^;]+);base64,(.+)$/s.exec(thumb)
        if (match) images.push({ mediaType: match[1], dataBase64: match[2], name: basename(filePath) })
      }
      if (images.length === 0) {
        const ext = extOf(filePath)
        if (IMAGE_EXT.has(ext) && statSync(filePath).size <= 12 * 1024 * 1024) {
          images.push({ mediaType: mimeForExt(ext), dataBase64: readFileSync(filePath).toString('base64'), name: basename(filePath) })
        }
      }
      return images
    }
    if (kind !== 'video') throw new Error('媒体审看只支持图片或视频。')
    const ff = this.resolveFfmpeg(settings)
    const probe = await this.probeFile(settings, filePath)
    const duration = probe.durationSec ?? 0
    const dir = mkdtempSync(join(tmpdir(), 'morrow-vision-'))
    try {
      for (let index = 0; index < count; index += 1) {
        const ratio = count === 1 ? 0.5 : 0.08 + (index / (count - 1)) * 0.84
        const at = duration > 0 ? Math.min(Math.max(0.05, duration * ratio), Math.max(0.05, duration - 0.08)) : 0
        const out = join(dir, `frame-${index + 1}.jpg`)
        const result = await this.runProcess(ff.binary, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-ss', String(at), '-i', filePath,
          '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out
        ], { signal: undefined, timeoutMs: 30_000 })
        if (result.code === 0 && existsSync(out)) {
          images.push({ mediaType: 'image/jpeg', dataBase64: readFileSync(out).toString('base64'), name: `frame-${index + 1}` })
        }
      }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
    return images
  }

  private async thumbnail(settings: MediaEngineSettings, filePath: string, kind: MediaKind): Promise<string | undefined> {
    const ext = extOf(filePath)
    if (kind === 'audio') return undefined
    const ff = this.resolveFfmpeg(settings)
    let dir: string | null = null
    try {
      dir = mkdtempSync(join(tmpdir(), 'morrow-thumb-'))
      const out = join(dir, 'thumb.jpg')
      const args = ['-hide_banner', '-loglevel', 'error', '-y']
      if (kind === 'video') args.push('-ss', '0.3')
      args.push('-i', filePath, '-vf', 'scale=480:-2', '-frames:v', '1', '-q:v', '5', out)
      const result = await this.runProcess(ff.binary, args, { timeoutMs: 30_000 })
      if (result.code === 0 && existsSync(out)) {
        const data = readFileSync(out)
        if (data.length <= 400 * 1024) return `data:image/jpeg;base64,${data.toString('base64')}`
      }
    } catch {
      // 缩略图失败不影响成品
    } finally {
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
      }
    }
    if (kind === 'image' && (IMAGE_EXT.has(ext) || ext === 'jpeg')) {
      const stat = statSync(filePath)
      if (stat.size <= 1.5 * 1024 * 1024) {
        return `data:${mimeForExt(ext)};base64,${readFileSync(filePath).toString('base64')}`
      }
    }
    return undefined
  }

  async editMedia(input: MediaEditInput): Promise<MediaArtifactResult> {
    const settings = this.settings()
    if (!settings.enabled) throw new Error('多媒体功能已在设置中关闭。')
    if (input.operation === 'concat') {
      const paths = input.inputPaths ?? []
      if (paths.length < 2) throw new Error('拼接至少需要 2 段视频。')
      return this.concatClips({
        workspace: input.workspace,
        paths,
        ...(input.outputPath ? { outputPath: input.outputPath } : {}),
        signal: input.signal,
        onProgress: input.onProgress
      })
    }
    const ff = this.resolveFfmpeg(settings)
    const version = await this.runProcess(ff.binary, ['-version'], { timeoutMs: 8_000 }).catch(() => null)
    if (!version || version.code !== 0) throw new Error('找不到 ffmpeg。请在设置 → 多媒体里填写 ffmpeg 路径，或把它加入 PATH。')
    const inputPath = ensureInside(input.workspace, input.inputPath)
    if (!existsSync(inputPath)) throw new Error('输入文件不存在。')
    const probe = await this.probeFile(settings, inputPath)
    const startedAt = Date.now()
    const inputExt = extOf(inputPath)
    const outputDir = normalizeOutputDir(settings.outputDir)
    const baseDir = join(input.workspace, outputDir, 'edited')
    mkdirSync(baseDir, { recursive: true })
    const format = input.format?.toLowerCase().replace(/^\./, '')
    const stamp = Date.now().toString(36)
    const baseName = basename(inputPath, extname(inputPath)).replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 48) || 'media'
    let targetExt = inputExt
    if (input.operation === 'extract_frame') targetExt = 'png'
    else if (input.operation === 'extract_audio') targetExt = format ?? 'mp3'
    else if (input.operation === 'gif') targetExt = 'gif'
    else if (input.operation === 'convert') {
      if (!format) throw new Error('convert 操作需要 format，例如 mp4、png、mp3。')
      targetExt = format
    } else if (kindForExt(inputExt) === 'video') targetExt = 'mp4'
    if (!kindForExt(targetExt)) throw new Error(`不支持的输出格式：${targetExt}`)
    if (input.outputPath) {
      const resolved = ensureInside(input.workspace, input.outputPath)
      if (existsSync(resolved)) throw new Error('输出文件已存在，请换一个文件名。')
      mkdirSync(dirname(resolved), { recursive: true })
      targetExt = extOf(resolved)
      if (!kindForExt(targetExt)) throw new Error(`不支持的输出格式：${targetExt}`)
    }
    const dest = input.outputPath
      ? ensureInside(input.workspace, input.outputPath)
      : uniqueFilePath(baseDir, `${baseName}-${input.operation}-${stamp}`, targetExt)
    const duration = probe.durationSec
    const inputKind = probe.kind
    const visualOps = new Set(['crop', 'resize', 'rotate', 'flip'])
    if (visualOps.has(input.operation) && inputKind !== 'image' && inputKind !== 'video') {
      throw new Error('这个操作需要图片或视频画面；音频请用 trim、extract_audio、volume 或 speed。')
    }
    if (input.operation === 'mute' && inputKind === 'audio') {
      throw new Error('静音只适用于带音轨的视频；音频文件请用 volume=0。')
    }
    if (input.operation === 'convert' && targetExt === 'gif') {
      throw new Error('转 GIF 请使用 operation=gif，并可用 start_seconds/end_seconds 截取片段。')
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-y']
    let totalForProgress = duration
    const trimStart = input.operation === 'trim' ? input.startSeconds ?? 0 : undefined
    const trimEnd = input.operation === 'trim' ? input.endSeconds ?? duration : undefined
    if (input.operation === 'trim') {
      if (trimEnd !== undefined && trimStart !== undefined && trimEnd <= trimStart) throw new Error('结束时间必须大于开始时间。')
      if (inputKind === 'image') throw new Error('图片不能按时间剪辑；请用 resize/crop/convert。')
      if (trimStart !== undefined) args.push('-ss', String(trimStart))
      args.push('-i', inputPath)
      if (trimStart !== undefined && trimEnd !== undefined) {
        args.push('-t', String(trimEnd - trimStart))
        totalForProgress = trimEnd - trimStart
      }
    } else if (input.operation === 'extract_frame') {
      if (inputKind !== 'video') throw new Error('提取画面帧需要视频文件。')
      if (input.fromEnd) args.push('-sseof', '-0.15')
      else args.push('-ss', String(Math.max(0, input.atSeconds ?? 0)))
      args.push('-i', inputPath)
      totalForProgress = undefined
    } else {
      args.push('-i', inputPath)
    }
    const filters: string[] = []
    const outputKind = kindForExt(targetExt)
    const isImageOutput = outputKind === 'image'
    const isAudioOutput = outputKind === 'audio'
    const isGif = input.operation === 'gif'
    if (input.operation === 'crop') {
      const width = input.width
      const height = input.height
      if (!width || !height) throw new Error('crop 需要 width 和 height。')
      const x = input.x ?? 0
      const y = input.y ?? 0
      if (probe.width && probe.height && (x + width > probe.width || y + height > probe.height)) {
        throw new Error(`裁切范围超出画面（原图 ${probe.width}×${probe.height}）。`)
      }
      filters.push(`crop=${Math.round(width)}:${Math.round(height)}:${Math.round(x)}:${Math.round(y)}`)
    } else if (input.operation === 'resize') {
      if (!input.width && !input.height) throw new Error('resize 需要 width 或 height。')
      const width = input.width ? Math.round(input.width) : -2
      const height = input.height ? Math.round(input.height) : -2
      filters.push(`scale=${width}:${height}:flags=lanczos`)
    } else if (input.operation === 'rotate') {
      const angle = input.angle ?? 90
      if (![90, 180, 270].includes(angle)) throw new Error('rotate 只支持 90、180、270 度。')
      filters.push(angle === 90 ? 'transpose=1' : angle === 270 ? 'transpose=2' : 'hflip,vflip')
    } else if (input.operation === 'flip') {
      filters.push(input.flip === 'vertical' ? 'vflip' : 'hflip')
    } else if (input.operation === 'speed') {
      if (inputKind !== 'video' && inputKind !== 'audio') throw new Error('speed 只适用于视频或音频。')
      const speed = input.speed ?? 1
      if (!(speed >= 0.25 && speed <= 4)) throw new Error('speed 倍率必须在 0.25–4 之间。')
      if (inputKind === 'video') {
        filters.push(`setpts=PTS/${speed}`)
      }
    } else if (input.operation === 'volume') {
      if (!probe.hasAudio) throw new Error('这个文件没有音轨，不能调节音量。')
      // 音频滤镜在下面单独加
    } else if (input.operation === 'extract_audio') {
      if (!probe.hasAudio) throw new Error('这个文件没有音轨，不能提取音频。')
    } else if (input.operation === 'gif') {
      if (inputKind !== 'video') throw new Error('GIF 只能从视频生成。')
      const fps = input.fps ?? 12
      const width = input.width ? Math.round(input.width) : 480
      if (input.startSeconds !== undefined) {
        args.length = 0
        args.push('-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-y', '-ss', String(input.startSeconds), '-i', inputPath)
        if (input.endSeconds !== undefined) {
          args.push('-t', String(Math.max(0.1, input.endSeconds - input.startSeconds)))
          totalForProgress = Math.max(0.1, input.endSeconds - input.startSeconds)
        } else {
          totalForProgress = duration
        }
      }
      filters.push(`fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`)
    }
    if (input.operation === 'mute') {
      if (!probe.hasAudio) throw new Error('这个文件没有音轨。')
      args.push('-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p')
      if (targetExt === 'mp4' || targetExt === 'mov') args.push('-movflags', '+faststart')
    } else if (input.operation === 'volume') {
      const volume = input.volume ?? 1
      if (inputKind === 'video') {
        args.push('-c:v', 'copy', '-af', `volume=${volume}`, '-c:a', 'aac', '-b:a', '160k')
      } else {
        args.push('-af', `volume=${volume}`)
      }
    } else if (input.operation === 'speed' && inputKind === 'video' && probe.hasAudio) {
      // setpts 已在 filters 中；音频用 atempo 保持同步
      args.push('-filter:v', filters.join(','), '-filter:a', this.atempoChain(input.speed ?? 1))
      filters.length = 0
    } else if (input.operation === 'speed' && inputKind === 'audio') {
      args.push('-af', this.atempoChain(input.speed ?? 1))
    } else if (filters.length > 0 && !isAudioOutput) {
      args.push('-vf', filters.join(','))
    }
    if (isImageOutput && !isGif) {
      args.push('-frames:v', '1')
    }
    if (isAudioOutput) {
      args.push('-vn')
      const codec = this.audioCodec(targetExt)
      if (!codec) throw new Error(`不支持的音频格式：${targetExt}`)
      args.push('-c:a', codec)
      if (targetExt === 'mp3') args.push('-q:a', '2')
      if (targetExt === 'm4a') args.push('-b:a', '192k')
    } else if (isGif) {
      // palettegen 已在滤镜里完成
    } else if (isImageOutput) {
      if (targetExt === 'jpg' || targetExt === 'jpeg') args.push('-q:v', '2')
      else if (targetExt === 'webp') args.push('-c:v', 'libwebp', '-quality', '90')
      else args.push('-c:v', 'png')
    } else if (input.operation !== 'mute' && input.operation !== 'volume') {
      if (targetExt === 'webm') {
        args.push('-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0')
        if (probe.hasAudio) args.push('-c:a', 'libopus', '-b:a', '128k')
        else args.push('-an')
      } else {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p')
        if (probe.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k')
        else args.push('-an')
        if (targetExt === 'mp4' || targetExt === 'mov') args.push('-movflags', '+faststart')
      }
    }
    args.push(dest)
    const onProgress = input.onProgress
    onProgress({ stage: `ffmpeg ${input.operation}`, percent: 5 })
    const timeoutMs = Math.max(180_000, Math.min(1_800_000, ((totalForProgress ?? 60) * 4 + 120) * 1000))
    const result = await this.runProcess(ff.binary, args, {
      signal: input.signal,
      timeoutMs,
      onStdout: (line) => {
        const match = /^(out_time_us|out_time_ms|out_time)=(.+)$/.exec(line)
        if (!match || !totalForProgress || totalForProgress <= 0) return
        const raw = match[2].trim()
        let seconds = NaN
        if (match[1] === 'out_time_us' || match[1] === 'out_time_ms') seconds = Number(raw) / 1_000_000
        else {
          const parts = raw.split(':').map(Number)
          if (parts.length === 3 && parts.every(Number.isFinite)) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
        }
        if (Number.isFinite(seconds)) {
          onProgress({ stage: `处理中 ${Math.round((seconds / totalForProgress) * 100)}%`, percent: 10 + Math.min(85, (seconds / totalForProgress) * 85) })
        }
      }
    })
    if (result.code !== 0) {
      throw new Error(`ffmpeg 处理失败：${(result.stderr || result.stdout).slice(-800) || `退出码 ${result.code}`}`)
    }
    const info = await this.probeFile(settings, dest)
    const thumb = await this.thumbnail(settings, dest, info.kind === 'unknown' ? (kindForExt(targetExt) ?? 'image') : info.kind)
    onProgress({ stage: '完成', percent: 100 })
    return {
      path: dest,
      mediaKind: info.kind === 'unknown' ? (kindForExt(targetExt) ?? 'video') : info.kind,
      bytes: statSync(dest).size,
      model: 'ffmpeg',
      engine: '本机 ffmpeg',
      elapsedMs: Date.now() - startedAt,
      ...(info.width ? { width: info.width } : {}),
      ...(info.height ? { height: info.height } : {}),
      ...(info.durationSec !== undefined ? { durationSec: info.durationSec } : {}),
      ...(thumb ? { thumbnailDataUrl: thumb } : {})
    }
  }

  private atempoChain(speed: number): string {
    const parts: string[] = []
    let remaining = speed
    while (remaining > 2) { parts.push('atempo=2'); remaining /= 2 }
    while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5 }
    parts.push(`atempo=${remaining.toFixed(3)}`)
    return parts.join(',')
  }

  private audioCodec(ext: string): string | null {
    switch (ext) {
      case 'mp3': return 'libmp3lame'
      case 'wav': return 'pcm_s16le'
      case 'm4a': return 'aac'
      case 'aac': return 'aac'
      case 'flac': return 'flac'
      case 'ogg': return 'libvorbis'
      default: return null
    }
  }
}

let instance: MediaService | null = null

export function getMediaService(): MediaService {
  if (!instance) instance = new MediaService()
  return instance
}
