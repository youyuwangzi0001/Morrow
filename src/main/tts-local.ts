/**
 * 本地 Qwen3-TTS：把 Python 推理服务当子进程管起来。
 *
 * ## 为什么要另起一个进程，而不是在 Node 里做
 *
 * 语音合成依赖 PyTorch + 模型权重，Node 里没有可用的推理栈。唯一现实的
 * 做法是把 Python 服务作为子进程拉起，通过本机 HTTP 调用。
 *
 * 代价是生命周期管理变复杂：进程可能没装、可能崩、可能卡在加载模型上
 * 好几分钟。这个模块的绝大部分代码就是在处理这些情况 —— 而不是在调用 TTS。
 *
 * ## 未安装时必须优雅降级
 *
 * `localTtsVoices()` 在未就绪时返回空数组，界面据此不显示本地声线选项。
 * 绝不能抛错：用户没装本地声线是**常态**，不是故障。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { StudioVoice } from '../shared/studio'

const VOICE_DEFS: Array<{ id: string; label: string; gender: string; description: string }> = [
  { id: 'vivian', label: 'Vivian · 明亮年轻女声', gender: 'Female', description: '明亮、略带锋利的年轻女声' },
  { id: 'serena', label: 'Serena · 温柔年轻女声', gender: 'Female', description: '温暖、柔和的年轻女声' },
  { id: 'uncle_fu', label: 'Uncle Fu · 低沉成熟男声', gender: 'Male', description: '低沉醇厚的成熟男声' },
  { id: 'dylan', label: 'Dylan · 北京年轻男声', gender: 'Male', description: '清晰自然的北京年轻男声' },
  { id: 'eric', label: 'Eric · 成都清亮男声', gender: 'Male', description: '略带沙哑清亮的成都男声' }
]

export const QWEN_DEFAULT_VOICE = 'qwen:vivian'

// 进程内单例。`starting` 存的是**进行中的启动 Promise**，不是结果 ——
// 多个并发请求同时要合成时，必须共用同一次启动，否则会拉起好几个 Python。
let child: ChildProcess | null = null
let serverPort = 0
let serverToken = ''
let starting: Promise<{ port: number; token: string }> | null = null

/** 模型 / venv / 日志都放这里。可用 MORROW_TTS_HOME 覆盖（测试与便携版需要）。 */
function ttsHome(): string {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || app.getPath('userData')
  return process.env.MORROW_TTS_HOME || join(base, 'Morrow', 'local-tts')
}

/** 按优先级找启动脚本：环境变量 → 打包资源目录 → 应用目录 → 当前工作目录。 */
function serverScript(): string | null {
  const candidates = [
    process.env.MORROW_TTS_SCRIPT,
    process.resourcesPath ? join(process.resourcesPath, 'tts', 'qwen_tts_server.py') : '',
    join(app.getAppPath(), 'resources', 'tts', 'qwen_tts_server.py'),
    join(process.cwd(), 'resources', 'tts', 'qwen_tts_server.py')
  ].filter((item): item is string => Boolean(item))
  return candidates.find((item) => existsSync(item)) ?? null
}

/** 只认自带的 venv。用系统 Python 会缺依赖，装出来的是「能启动但一合成就报 ImportError」，比明确说「没装」更难排查。 */
function pythonPath(): string | null {
  const home = ttsHome()
  const candidates = [
    process.env.MORROW_TTS_PYTHON,
    join(home, 'venv', 'Scripts', 'python.exe'),
    join(home, 'venv', 'bin', 'python')
  ].filter((item): item is string => Boolean(item))
  return candidates.find((item) => existsSync(item)) ?? null
}

/** sox 用于音频后处理。从 WinGet 包目录里找，找不到就跳过（不阻断合成）。 */
function soxDirectory(): string | null {
  const packages = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages')
  if (!existsSync(packages)) return null
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/sox/i.test(entry.name)) continue
    const base = join(packages, entry.name)
    for (const child of readdirSync(base, { withFileTypes: true })) {
      if (!child.isDirectory()) continue
      const dir = join(base, child.name)
      if (existsSync(join(dir, 'sox.exe'))) return dir
    }
  }
  return null
}

/** 模型目录：认 `config.json` 存在，且目录名含 tts —— 用户可能把权重解压成
 *  `Qwen3-TTS-0.6B` 这类名字，硬编码一个名字会在升级模型版本时失效。 */
function modelPath(): string | null {
  const home = ttsHome()
  if (process.env.MORROW_TTS_MODEL && existsSync(process.env.MORROW_TTS_MODEL)) return process.env.MORROW_TTS_MODEL
  const direct = join(home, 'model')
  if (existsSync(join(direct, 'config.json'))) return direct
  if (existsSync(home)) {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(home, entry.name)
      if (existsSync(join(candidate, 'config.json')) && /tts/i.test(entry.name)) return candidate
    }
  }
  return null
}

export interface LocalTtsStatus {
  installed: boolean
  modelReady: boolean
  running: boolean
  message: string
  home: string
  modelPath?: string
}

/**
 * 当前可用状态。界面用它决定显不显示本地声线、以及显示哪句提示。
 *
 * 就绪判定要求四件事同时成立：venv、脚本、模型目录、以及**权重确实下完了**。
 * 最后一条要单独查，因为「目录建好了但只下了 50MB」是最常见的半成品状态 ——
 * 此时若无脑判就绪，用户点合成会拿到一个难懂的错误。
 */
export function localTtsStatus(): LocalTtsStatus {
  const home = ttsHome()
  const python = pythonPath()
  const script = serverScript()
  const model = modelPath()
  let weightsReady = false
  if (model) {
    try {
      const total = readdirSync(model)
        .filter((name) => name.endsWith('.safetensors'))
        .reduce((sum, name) => sum + statSync(join(model, name)).size, 0)
      // 0.6B 的 fp16 权重约 1.2GB。512MB 是个保守下限：低于它的必然没下完。
      weightsReady = total > 512 * 1024 * 1024
    } catch {
      weightsReady = false
    }
  }
  const modelReady = Boolean(python && script && model && weightsReady)
  return {
    installed: modelReady,
    modelReady,
    running: Boolean(child && !child.killed && serverPort),
    message: modelReady
      ? '本地 Qwen3-TTS 已就绪'
      : !python
        ? `本地声线未安装：缺少 ${join(home, 'venv')}`
        : !script
          ? '本地声线脚本缺失'
          : `本地声线模型未下载完成：${join(home, 'model')}`,
    home,
    ...(model ? { modelPath: model } : {})
  }
}

export function localTtsVoices(): StudioVoice[] {
  if (!localTtsStatus().modelReady) return []
  return VOICE_DEFS.map((voice) => ({
    id: `qwen:${voice.id}`,
    name: `qwen:${voice.id}`,
    label: `${voice.label}（本地 AI）`,
    culture: 'zh-CN',
    gender: voice.gender,
    kind: 'local'
  }))
}

export function isLocalTtsVoice(voice: string | undefined | null): boolean {
  return Boolean(voice && voice.startsWith('qwen:'))
}

function localSpeaker(voice: string | undefined): string {
  const raw = (voice ?? '').replace(/^qwen:/, '').trim()
  return VOICE_DEFS.some((item) => item.id === raw) ? raw : 'vivian'
}

async function stopServer(): Promise<void> {
  starting = null
  serverPort = 0
  serverToken = ''
  if (!child) return
  const current = child
  child = null
  try {
    current.kill()
  } catch {
  }
}

/**
 * 起服务（幂等）。已在跑就直接返回；正在启动就复用同一个 Promise。
 *
 * 端口不写死：让 Python 侧自己选空闲端口，再用 stdout 的
 * `MORROW_TTS_PORT=<n>` 标记报回来。写死端口会在用户同时开两个实例时撞车。
 */
async function startServer(): Promise<{ port: number; token: string }> {
  if (child && serverPort) return { port: serverPort, token: serverToken }
  if (starting) return starting
  starting = new Promise((resolvePromise, reject) => {
    const home = ttsHome()
    const python = pythonPath()
    const script = serverScript()
    const model = modelPath()
    if (!python || !script || !model) {
      starting = null
      reject(new Error(localTtsStatus().message))
      return
    }
    // 每次启动生成新 token：本机 HTTP 端口对同机任何进程都可见，
    // 没有 token 就等于让别人的程序也能驱动你的声卡。
    const token = randomUUID()
    mkdirSync(home, { recursive: true })
    const debugLog = join(home, 'server.log')
    const debug = (message: string): void => {
      try { appendFileSync(debugLog, `[${new Date().toISOString()}] ${message}\n`, 'utf8') } catch {}
    }
    debug(`spawn ${python} ${script} --model ${model}`)
    const sox = soxDirectory()
    const tmpDir = join(home, 'tmp')
    mkdirSync(tmpDir, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      TEMP: tmpDir,
      TMP: tmpDir,
      TMPDIR: tmpDir,
      NUMBA_CACHE_DIR: join(home, 'numba-cache')
    }
    if (sox) env.PATH = `${sox};${env.PATH ?? ''}`
    const proc = spawn(python, ['-u', script, '--model', model, '--token', token], {
      cwd: home,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    })
    child = proc
    let settled = false
    let stderr = ''
    // 180 秒：首次启动要加载模型权重，机械硬盘上可能要一到两分钟。
    // 超时后把 stderr 尾部拼进错误里 —— 那通常是 Python 的 ImportError，最有价值。
    const timer = setTimeout(() => finish(new Error(`本地 TTS 启动超时。${stderr.slice(-500)}`)), 180_000)
    const finish = (error?: Error, value?: { port: number; token: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        starting = null
        child = null
        try { proc.kill() } catch {}
        reject(error)
      } else if (value) {
        serverPort = value.port
        serverToken = value.token
        resolvePromise(value)
      }
    }
    let buffer = ''
    // 用 stdout 里的标记行发现端口。只累积不重置 buffer：
    // 标记可能被 TCP 分段切在两个 chunk 之间。
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const match = /MORROW_TTS_PORT=(\d+)/.exec(buffer)
      if (match) finish(undefined, { port: Number(match[1]), token })
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000)
      debug(`stderr ${chunk.toString('utf8').trim().slice(0, 500)}`)
    })
    proc.on('error', (error) => { debug(`error ${error.message}`); finish(error) })
    proc.on('exit', (code) => {
      debug(`exit ${code}`)
      if (!settled) finish(new Error(`本地 TTS 启动失败（退出码 ${code}）。${stderr.slice(-800)}`))
      else {
        child = null
        serverPort = 0
        serverToken = ''
        starting = null
      }
    })
  })
  return starting
}

export interface LocalSpeechInput {
  text: string
  voice: string
  instruct?: string
  outputPath: string
}

/**
 * 合成一段语音并写到 `outputPath`。
 *
 * 文本截到 1200 字：再长的话单次推理会吃掉几个 GB 显存并退化成噪声，
 * 分镜台词本来也不该有整段念白。
 */
export async function synthesizeLocalSpeech(input: LocalSpeechInput): Promise<{ model: string }> {
  if (!input.text.trim()) throw new Error('没有可配音的台词。')
  const { port, token } = await startServer()
  const speaker = localSpeaker(input.voice)
  const response = await fetch(`http://127.0.0.1:${port}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: input.text.slice(0, 1200), speaker, instruct: input.instruct ?? '' }),
    signal: AbortSignal.timeout(180_000)
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`本地 Qwen3-TTS 合成失败（HTTP ${response.status}）。${detail.slice(0, 500)}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  // 100 字节下限：模型加载失败时服务仍可能回 200 + 一个空 body，
  // 那种 wav 写出去后会在时间线上表现为「这一镜没声音」，很难反查。
  if (bytes.length < 100) throw new Error('本地 Qwen3-TTS 返回了空音频。')
  mkdirSync(dirname(input.outputPath), { recursive: true })
  writeFileSync(input.outputPath, bytes)
  return { model: `Qwen3-TTS · ${speaker}` }
}

/** 应用退出时调用。不 await：退出流程不该被一个可能挂住的进程等待拖住。 */
export function stopLocalTts(): void {
  void stopServer()
}
