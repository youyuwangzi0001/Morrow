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

let child: ChildProcess | null = null
let serverPort = 0
let serverToken = ''
let starting: Promise<{ port: number; token: string }> | null = null

function ttsHome(): string {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || app.getPath('userData')
  return process.env.MORROW_TTS_HOME || join(base, 'Morrow', 'local-tts')
}

function serverScript(): string | null {
  const candidates = [
    process.env.MORROW_TTS_SCRIPT,
    process.resourcesPath ? join(process.resourcesPath, 'tts', 'qwen_tts_server.py') : '',
    join(app.getAppPath(), 'resources', 'tts', 'qwen_tts_server.py'),
    join(process.cwd(), 'resources', 'tts', 'qwen_tts_server.py')
  ].filter((item): item is string => Boolean(item))
  return candidates.find((item) => existsSync(item)) ?? null
}

function pythonPath(): string | null {
  const home = ttsHome()
  const candidates = [
    process.env.MORROW_TTS_PYTHON,
    join(home, 'venv', 'Scripts', 'python.exe'),
    join(home, 'venv', 'bin', 'python')
  ].filter((item): item is string => Boolean(item))
  return candidates.find((item) => existsSync(item)) ?? null
}

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
  if (bytes.length < 100) throw new Error('本地 Qwen3-TTS 返回了空音频。')
  mkdirSync(dirname(input.outputPath), { recursive: true })
  writeFileSync(input.outputPath, bytes)
  return { model: `Qwen3-TTS · ${speaker}` }
}

export function stopLocalTts(): void {
  void stopServer()
}
