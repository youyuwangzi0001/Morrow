/**
 * 本机声音：Windows SAPI 配音 + 程序化配乐/音效。
 * 不依赖版权曲库，也不冒充云端音乐模型；生成结果显示为“本地器乐草稿”。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { StudioVoice } from '../../shared/studio'

export interface VoiceSynthesisInput {
  text: string
  voice: string
  rate?: number
  volume?: number
  outputPath: string
  workDir: string
}

const SAMPLE_RATE = 44_100

let voiceCache: { at: number; voices: StudioVoice[]; error?: string } | null = null

function runPowerShell(script: string, args: string[], timeoutMs = 60_000): { code: number; stdout: string; stderr: string } {
  const file = join(tmpdir(), `morrow-studio-${randomUUID()}.ps1`)
  // Windows PowerShell 5 需要 BOM 才能稳定识别 UTF-8 源文件里的中文
  writeFileSync(file, `\uFEFF${script}`, 'utf8')
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs }
    )
    return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } finally {
    try {
      rmSync(file, { force: true })
    } catch {
    }
  }
}

function runPowerShellAsync(script: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const file = join(tmpdir(), `morrow-studio-${randomUUID()}.ps1`)
    writeFileSync(file, `\uFEFF${script}`, 'utf8')
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
      }
      try {
        rmSync(file, { force: true })
      } catch {
      }
      reject(new Error('系统配音超时（60 秒）；请缩短台词后重试。'))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        rmSync(file, { force: true })
      } catch {
      }
      reject(new Error(`无法启动系统配音：${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        rmSync(file, { force: true })
      } catch {
      }
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Windows 10/11 的现代语音 API：支持多角色中文声线，且不依赖 System.Speech 的桌面安全上下文。 */
const WINRT_VOICE_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime]
$rows = @()
foreach ($voice in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
  $rows += [PSCustomObject]@{ name = $voice.DisplayName; culture = $voice.Language; gender = $voice.Gender.ToString() }
}
$rows | ConvertTo-Json -Compress
`

const WINRT_SPEAK_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$VoiceName,
  [Parameter(Mandatory=$true)][string]$OutputFile,
  [Parameter(Mandatory=$true)][string]$TextFile,
  [int]$Rate = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime]
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { throw '配音文本为空。' }
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$chosen = $null
if ($VoiceName) {
  $chosen = $voices | Where-Object { $_.DisplayName -eq $VoiceName } | Select-Object -First 1
  if (-not $chosen) {
    $short = $VoiceName -replace '\s+Desktop$', ''
    $chosen = $voices | Where-Object { $_.DisplayName -eq $short } | Select-Object -First 1
  }
}
if (-not $chosen) {
  $chosen = $voices | Where-Object { $_.Language -like 'zh*' } | Select-Object -First 1
}
if (-not $chosen) { throw '系统上没有可用的中文声线。' }
$synth.Voice = $chosen
$stream = $null
if ($Rate -ne 0) {
  $rateName = if ($Rate -le -7) { 'x-slow' } elseif ($Rate -le -3) { 'slow' } elseif ($Rate -ge 7) { 'x-fast' } elseif ($Rate -ge 3) { 'fast' } else { 'medium' }
  $escaped = [System.Security.SecurityElement]::Escape($text)
  $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/Synthesis' xml:lang='zh-CN'><prosody rate='$rateName'>$escaped</prosody></speak>"
  $stream = Await ($synth.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
} else {
  $stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
}
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
$size = [uint32]$stream.Size
Await ($reader.LoadAsync($size)) ([uint32]) | Out-Null
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes($OutputFile, $bytes)
$reader.Dispose()
$synth.Dispose()
Write-Output ("OK " + $chosen.DisplayName)
`

const SAPI_VOICE_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$rows = @()
foreach ($v in $s.GetInstalledVoices()) {
  if (-not $v.Enabled) { continue }
  $info = $v.VoiceInfo
  $rows += [PSCustomObject]@{ name = $info.Name; culture = $info.Culture.Name; gender = $info.Gender.ToString() }
}
$rows | ConvertTo-Json -Compress
$s.Dispose()
`

const SAPI_SPEAK_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$VoiceName,
  [Parameter(Mandatory=$true)][string]$OutputFile,
  [Parameter(Mandatory=$true)][string]$TextFile,
  [int]$Rate = 0,
  [int]$Volume = 100
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { throw '配音文本为空。' }
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$installed = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
$selected = $false
if ($VoiceName) {
  try { $s.SelectVoice($VoiceName); $selected = $true } catch { $selected = $false }
}
if (-not $selected) {
  foreach ($name in $installed) {
    try { $s.SelectVoice($name); $selected = $true; break } catch { $selected = $false }
  }
}
$s.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$s.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
$s.SetOutputToWaveFile($OutputFile)
$s.Speak($text)
$s.Dispose()
Write-Output 'OK'
`

function parseVoices(stdout: string): StudioVoice[] {
  const text = stdout.trim() || '[]'
  const parsed = JSON.parse(text) as Array<{ name?: string; culture?: string; gender?: string }> | { name?: string; culture?: string; gender?: string }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .filter((row) => typeof row.name === 'string' && row.name.trim())
    .map((row) => ({
      name: row.name as string,
      culture: row.culture ?? '',
      ...(row.gender ? { gender: row.gender } : {})
    }))
}

export function listSystemVoices(force = false): { voices: StudioVoice[]; error?: string } {
  if (process.platform !== 'win32') {
    return { voices: [], error: '系统配音目前仅支持 Windows。可以改为导入录音，或稍后接入云端声线。' }
  }
  if (!force && voiceCache && Date.now() - voiceCache.at < 5 * 60_000) return voiceCache
  const winrt = runPowerShell(WINRT_VOICE_SCRIPT, [], 20_000)
  if (winrt.code === 0) {
    try {
      const voices = parseVoices(winrt.stdout)
      if (voices.length) {
        voiceCache = { at: Date.now(), voices }
        return voiceCache
      }
    } catch {
      // 回退到 SAPI
    }
  }
  const result = runPowerShell(SAPI_VOICE_SCRIPT, [], 20_000)
  if (result.code !== 0) {
    const error = (result.stderr || result.stdout || '无法读取系统声线').trim().slice(0, 300)
    voiceCache = { at: Date.now(), voices: [], error }
    return voiceCache
  }
  try {
    const voices = parseVoices(result.stdout)
    voiceCache = { at: Date.now(), voices }
    return voiceCache
  } catch (err) {
    const error = `系统声线列表不是合法 JSON：${err instanceof Error ? err.message : String(err)}`
    voiceCache = { at: Date.now(), voices: [], error }
    return voiceCache
  }
}

export async function synthesizeSpeech(input: VoiceSynthesisInput): Promise<void> {  if (process.platform !== 'win32') throw new Error('系统配音目前仅支持 Windows。')
  if (!input.text.trim()) throw new Error('没有可配音的台词。')
  mkdirSync(input.workDir, { recursive: true })
  const textFile = join(input.workDir, `tts-${randomUUID()}.txt`)
  writeFileSync(textFile, input.text, 'utf8')
  try {
    try {
      const result = await runPowerShellAsync(WINRT_SPEAK_SCRIPT, [
        '-VoiceName',
        input.voice || '',
        '-OutputFile',
        input.outputPath,
        '-TextFile',
        textFile,
        '-Rate',
        String(input.rate ?? 0)
      ], 60_000)
      if (result.code === 0 && existsSync(input.outputPath)) return
      throw new Error((result.stderr || result.stdout || 'Windows 语音合成失败').trim().slice(0, 400))
    } catch (winrtError) {
      // 老系统或 WinRT 不可用时回退 SAPI；两边的错误都给用户看。
      const result = await runPowerShellAsync(SAPI_SPEAK_SCRIPT, [
        '-VoiceName',
        input.voice || '',
        '-OutputFile',
        input.outputPath,
        '-TextFile',
        textFile,
        '-Rate',
        String(input.rate ?? 0),
        '-Volume',
        String(input.volume ?? 100)
      ], 60_000)
      if (result.code !== 0 || !existsSync(input.outputPath)) {
        const sapiError = (result.stderr || result.stdout || '系统配音失败').trim().slice(0, 400)
        throw new Error(`系统配音失败。现代语音：${winrtError instanceof Error ? winrtError.message : String(winrtError)}；SAPI：${sapiError}`)
      }
    }
  } finally {
    try {
      rmSync(textFile, { force: true })
    } catch {
    }
  }
}

export interface CloudSpeechInput {
  text: string
  baseUrl: string
  apiKey: string
  model: string
  voice: string
  outputPath: string
  workDir: string
  speed?: number
  signal?: AbortSignal
}

/** OpenAI 兼容的 /audio/speech；使用当前云端模型服务商，不另存密钥。 */
export async function synthesizeCloudSpeech(input: CloudSpeechInput): Promise<void> {
  if (!input.text.trim()) throw new Error('没有可配音的台词。')
  let base: URL
  try {
    base = new URL(input.baseUrl)
  } catch {
    throw new Error('云端配音的服务商地址不合法。')
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('云端配音只支持 http(s) 服务商。')
  const cleanPath = base.pathname.replace(/\/+$/, '')
  const endpoint = /\/audio\/speech$/.test(cleanPath)
    ? `${base.origin}${cleanPath}`
    : `${base.origin}${cleanPath}/audio/speech`
  mkdirSync(input.workDir, { recursive: true })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  const onAbort = (): void => controller.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: input.model,
        input: input.text,
        voice: input.voice,
        response_format: 'mp3',
        ...(input.speed && input.speed !== 1 ? { speed: input.speed } : {})
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 400)
      throw new Error(`云端配音失败（HTTP ${response.status}）：${detail || response.statusText}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 1024) throw new Error('云端配音返回的音频为空。')
    if (bytes.length > 60 * 1024 * 1024) throw new Error('云端配音返回的音频超过 60MB。')
    writeFileSync(input.outputPath, bytes)
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
}

function midi(note: number): number {
  return 440 * 2 ** ((note - 69) / 12)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function hashText(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function writeWavStereo(left: Float32Array, right: Float32Array): Buffer {
  const frames = Math.min(left.length, right.length)
  const dataSize = frames * 4
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(2, 22)
  buffer.writeUInt32LE(SAMPLE_RATE, 24)
  buffer.writeUInt32LE(SAMPLE_RATE * 4, 28)
  buffer.writeUInt16LE(4, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  let offset = 44
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(Math.round(clamp(left[index], -1, 1) * 32767), offset)
    buffer.writeInt16LE(Math.round(clamp(right[index], -1, 1) * 32767), offset + 2)
    offset += 4
  }
  return buffer
}

interface MusicMood {
  id: string
  label: string
  root: number
  chords: number[][]
  melody: number[]
  tempo: number
  rain: number
  brightness: number
}

const MOODS: Record<string, MusicMood> = {
  rain: {
    id: 'rain',
    label: '雨幕下的钢琴',
    root: 50,
    chords: [
      [50, 53, 57, 62],
      [46, 50, 53, 58],
      [43, 46, 50, 55],
      [45, 49, 52, 57]
    ],
    melody: [74, 72, 69, 67, 69, 72, 74, 77],
    tempo: 58,
    rain: 0.16,
    brightness: 0.55
  },
  wonder: {
    id: 'wonder',
    label: '倒流的雨',
    root: 52,
    chords: [
      [52, 55, 59, 64],
      [48, 52, 55, 60],
      [45, 48, 52, 57],
      [47, 50, 54, 59]
    ],
    melody: [76, 79, 81, 79, 76, 74, 72, 74],
    tempo: 72,
    rain: 0.22,
    brightness: 0.8
  },
  release: {
    id: 'release',
    label: '克制的告别',
    root: 48,
    chords: [
      [48, 51, 55, 60],
      [43, 48, 51, 55],
      [41, 45, 48, 53],
      [43, 47, 50, 55]
    ],
    melody: [72, 71, 67, 69, 67, 64, 67, 69],
    tempo: 52,
    rain: 0.1,
    brightness: 0.45
  },
  warm: {
    id: 'warm',
    label: '靠近',
    root: 53,
    chords: [
      [53, 57, 60, 65],
      [48, 52, 55, 60],
      [55, 58, 62, 67],
      [50, 53, 57, 62]
    ],
    melody: [72, 76, 77, 79, 77, 76, 72, 69],
    tempo: 66,
    rain: 0.06,
    brightness: 0.7
  },
  tension: {
    id: 'tension',
    label: '不安',
    root: 45,
    chords: [
      [45, 48, 52, 57],
      [46, 50, 53, 58],
      [45, 48, 51, 56],
      [44, 47, 50, 55]
    ],
    melody: [69, 70, 72, 70, 69, 65, 67, 64],
    tempo: 82,
    rain: 0.28,
    brightness: 0.35
  }
}

export function musicMood(mood: string | undefined): MusicMood {
  if (mood && MOODS[mood]) return MOODS[mood] as MusicMood
  if (mood && /雨|rain/i.test(mood)) return MOODS.rain as MusicMood
  if (mood && /紧|不安|危险|tension/i.test(mood)) return MOODS.tension as MusicMood
  if (mood && /告别|悲|sad|release/i.test(mood)) return MOODS.release as MusicMood
  if (mood && /暖|靠近|希望|warm/i.test(mood)) return MOODS.warm as MusicMood
  return MOODS.rain as MusicMood
}

/** 生成一段可循环的本地器乐草稿，返回 WAV 文件路径。 */
export function synthesizeMusic(input: { mood?: string; seconds?: number; seed?: number; outputPath: string; title?: string }): { path: string; mood: MusicMood; duration: number } {
  const mood = musicMood(input.mood)
  const seconds = clamp(input.seconds ?? 54, 8, 300)
  const frames = Math.ceil(seconds * SAMPLE_RATE)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const seed = input.seed ?? hashText(`${input.title ?? ''}:${mood.id}:${seconds}`)
  let random = seed || 1
  const rand = (): number => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    return random / 0xffffffff
  }
  const note = (bufferL: Float32Array, bufferR: Float32Array, startSec: number, durationSec: number, midiNote: number, velocity: number, pan = 0): void => {
    const freq = midi(midiNote)
    const start = Math.floor(startSec * SAMPLE_RATE)
    const length = Math.floor(durationSec * SAMPLE_RATE)
    const panL = Math.cos(((pan + 1) * Math.PI) / 4)
    const panR = Math.sin(((pan + 1) * Math.PI) / 4)
    for (let index = 0; index < length && start + index < frames; index += 1) {
      const t = index / SAMPLE_RATE
      const attack = Math.min(1, t / 0.012)
      const decay = Math.exp(-t * (1.8 + (60 / Math.max(1, midiNote))))
      const body =
        Math.sin(2 * Math.PI * freq * t) * 0.62 +
        Math.sin(2 * Math.PI * freq * 2 * t) * 0.2 * mood.brightness +
        Math.sin(2 * Math.PI * freq * 3 * t) * 0.09 * mood.brightness +
        Math.sin(2 * Math.PI * freq * 4 * t) * 0.035
      const value = body * attack * decay * velocity
      bufferL[start + index] += value * panL
      bufferR[start + index] += value * panR
    }
  }
  const pad = (startSec: number, durationSec: number, notes: number[], velocity: number): void => {
    const start = Math.floor(startSec * SAMPLE_RATE)
    const length = Math.floor(durationSec * SAMPLE_RATE)
    for (const midiNote of notes) {
      const freq = midi(midiNote)
      for (let index = 0; index < length && start + index < frames; index += 1) {
        const t = index / SAMPLE_RATE
        const env = Math.min(1, t / 1.4) * Math.min(1, (durationSec - t) / 1.6) * velocity
        const value = (Math.sin(2 * Math.PI * freq * t) + Math.sin(2 * Math.PI * freq * 1.005 * t) * 0.5) * env * 0.08
        left[start + index] += value * 0.7
        right[start + index] += value * 0.7
      }
    }
  }
  const barSeconds = (60 / mood.tempo) * 4
  let bar = 0
  for (let time = 0; time < seconds + barSeconds; time += barSeconds, bar += 1) {
    const chord = mood.chords[bar % mood.chords.length]
    pad(time, Math.min(barSeconds * 1.2, seconds - time + 1), chord, 0.9)
    // 低音根音
    note(left, right, time, Math.min(3.6, seconds - time), chord[0] - 12, 0.22, -0.2)
    // 分解和弦
    const pattern = [0, 2, 1, 3, 1, 2, 0, 2]
    for (let step = 0; step < pattern.length; step += 1) {
      const at = time + (barSeconds / pattern.length) * step
      if (at >= seconds) break
      note(left, right, at, 2.4, chord[pattern[step] % chord.length] + 12, 0.12 + rand() * 0.05, (rand() - 0.5) * 0.6)
    }
    // 稀疏旋律
    if (bar % 2 === 0) {
      const melodyNote = mood.melody[(bar / 2) % mood.melody.length]
      note(left, right, time + barSeconds * 0.5, 3.2, melodyNote, 0.16, 0.25)
      if (bar % 4 === 2) note(left, right, time + barSeconds * 0.75, 2.4, melodyNote - 3, 0.1, -0.3)
    }
  }
  // 雨声：低通白噪声 + 随机水滴
  let filtered = 0
  for (let index = 0; index < frames; index += 1) {
    const noise = rand() * 2 - 1
    filtered = filtered * 0.985 + noise * 0.015
    const rain = filtered * mood.rain
    left[index] += rain * (0.9 + rand() * 0.1)
    right[index] += rain * (0.9 + rand() * 0.1)
  }
  const drops = Math.floor(seconds * 1.4)
  for (let drop = 0; drop < drops; drop += 1) {
    const start = Math.floor(rand() * (frames - SAMPLE_RATE * 0.2))
    const freq = 900 + rand() * 2200
    const gain = 0.02 + rand() * 0.035
    const length = Math.floor(SAMPLE_RATE * (0.04 + rand() * 0.08))
    for (let index = 0; index < length; index += 1) {
      const t = index / SAMPLE_RATE
      const value = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 60) * gain
      left[start + index] += value
      right[start + index] += value * 0.85
    }
  }
  // 简易回声与淡入淡出
  const delay = Math.floor(SAMPLE_RATE * 0.23)
  for (let index = delay; index < frames; index += 1) {
    left[index] += left[index - delay] * 0.09
    right[index] += right[index - delay] * 0.11
  }
  const fade = Math.floor(SAMPLE_RATE * Math.min(2.5, seconds / 6))
  for (let index = 0; index < fade; index += 1) {
    const gain = index / fade
    left[index] *= gain
    right[index] *= gain
  }
  for (let index = 0; index < fade; index += 1) {
    const gain = index / fade
    left[frames - 1 - index] *= gain
    right[frames - 1 - index] *= gain
  }
  // 归一化
  let peak = 0
  for (let index = 0; index < frames; index += 1) peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]))
  const scale = peak > 0 ? 0.72 / peak : 1
  for (let index = 0; index < frames; index += 1) {
    left[index] *= scale
    right[index] *= scale
  }
  mkdirSync(join(input.outputPath, '..'), { recursive: true })
  writeFileSync(input.outputPath, writeWavStereo(left, right))
  return { path: input.outputPath, mood, duration: seconds }
}

/** 生成真实音效素材（雨声 / 伞骨 / 心跳 / 街声）。 */
export function synthesizeSfx(kind: 'rain' | 'umbrella' | 'heartbeat' | 'street', outputPath: string, seconds = 5): string {
  const frames = Math.ceil(seconds * SAMPLE_RATE)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  let random = hashText(`${kind}:${seconds}`) || 7
  const rand = (): number => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    return random / 0xffffffff
  }
  if (kind === 'rain' || kind === 'street') {
    let low = 0
    let hum = 0
    for (let index = 0; index < frames; index += 1) {
      const noise = rand() * 2 - 1
      low = low * (kind === 'rain' ? 0.985 : 0.996) + noise * (kind === 'rain' ? 0.015 : 0.004)
      hum = hum * 0.9995 + noise * 0.0005
      const value = kind === 'rain' ? low * 0.45 : low * 0.08 + Math.sin(2 * Math.PI * 60 * (index / SAMPLE_RATE)) * 0.006
      left[index] += value + hum * 0.2
      right[index] += value * 0.92 + hum * 0.18
    }
    if (kind === 'street') {
      // 远处一辆车经过
      const start = Math.floor(frames * 0.32)
      for (let index = 0; index < SAMPLE_RATE * 2 && start + index < frames; index += 1) {
        const t = index / SAMPLE_RATE
        const env = Math.sin((Math.PI * t) / 2) ** 2 * Math.exp(-t * 0.9)
        const value = Math.sin(2 * Math.PI * (180 + t * 30) * t) * 0.012 * env
        left[start + index] += value
        right[start + index] += value * 0.7
      }
    }
  } else if (kind === 'heartbeat') {
    for (let index = 0; index < frames; index += 1) {
      const t = index / SAMPLE_RATE
      const beat = t % 0.86
      const thump = (offset: number, gain: number): number => {
        const x = beat - offset
        if (x < 0 || x > 0.22) return 0
        return Math.sin(2 * Math.PI * 52 * x) * Math.exp(-x * 28) * gain
      }
      const value = thump(0, 0.5) + thump(0.22, 0.28)
      left[index] += value
      right[index] += value * 0.9
    }
  } else {
    // 伞骨：金属细响与开合
    for (let click = 0; click < 7; click += 1) {
      const start = Math.floor((0.18 + click * 0.48 + rand() * 0.1) * SAMPLE_RATE)
      const freq = 2600 + rand() * 1800
      for (let index = 0; index < SAMPLE_RATE * 0.08 && start + index < frames; index += 1) {
        const t = index / SAMPLE_RATE
        const value = (Math.sin(2 * Math.PI * freq * t) + rand() * 0.4) * Math.exp(-t * 45) * 0.09
        left[start + index] += value
        right[start + index] += value * 0.8
      }
    }
    for (let index = 0; index < frames; index += 1) {
      const t = index / SAMPLE_RATE
      const env = Math.min(1, t / 0.1) * Math.min(1, (seconds - t) / 0.4)
      const value = (rand() * 2 - 1) * 0.012 * env
      left[index] += value
      right[index] += value
    }
  }
  const fade = Math.floor(SAMPLE_RATE * 0.2)
  for (let index = 0; index < fade; index += 1) {
    const gain = index / fade
    left[index] *= gain
    right[index] *= gain
    left[frames - 1 - index] *= gain
    right[frames - 1 - index] *= gain
  }
  mkdirSync(join(outputPath, '..'), { recursive: true })
  writeFileSync(outputPath, writeWavStereo(left, right))
  return outputPath
}
