import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CloudMediaCapability, CloudMediaProvider } from '../shared/media-cloud'
import { CLOUD_MEDIA_PRESETS } from '../shared/media-cloud'
import { getSettingsStore } from './settings'

export interface CloudMediaSelection {
  provider: CloudMediaProvider
  apiKey: string
}

export function cloudMediaFor(capability: CloudMediaCapability): CloudMediaSelection | null {
  const settings = getSettingsStore().get()
  const preferred = settings.mediaDefaults[capability]
  const candidates = settings.mediaProviders.filter(
    (provider) => provider.capability === capability && provider.enabled
  )
  const provider =
    candidates.find((item) => item.id === preferred) ??
    candidates.find((item) => item.apiKeyStored) ??
    candidates[0]
  if (!provider) return null
  const apiKey = getSettingsStore().getCloudMediaApiKey(provider.id) ?? ''
  return { provider, apiKey }
}

export function cloudMediaConfigured(capability: CloudMediaCapability): boolean {
  const selected = cloudMediaFor(capability)
  return Boolean(selected?.provider.apiKeyStored)
}

/** 一句话说明创作台现在会走哪条云端链路，用于媒体就绪检查。 */
export function cloudMediaLabel(provider: CloudMediaProvider): string {
  return `${provider.name} · ${provider.model}`
}

interface CloudRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

async function request(
  url: string,
  init: RequestInit,
  options: CloudRequestOptions = {}
): Promise<Response> {
  if (!/^https?:\/\//i.test(url)) throw new Error('多媒体服务地址不合法。')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 180_000)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (controller.signal.aborted) throw new Error('多媒体请求超时或被取消。')
    throw err
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

async function jsonOrThrow(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${label}失败（HTTP ${response.status}）：${text.trim().slice(0, 400) || response.statusText}`)
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`${label}返回的不是 JSON。`)
  }
}

async function binaryOrThrow(response: Response, label: string, maxBytes = 120 * 1024 * 1024): Promise<Buffer> {
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 400)
    throw new Error(`${label}失败（HTTP ${response.status}）：${detail || response.statusText}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) throw new Error(`${label}返回了空文件。`)
  if (buffer.length > maxBytes) throw new Error(`${label}返回的文件超过大小上限。`)
  return buffer
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function authBearer(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

function googleHeaders(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(apiKey ? { 'x-goog-api-key': apiKey } : {}) }
}

function imageShape(aspect: string): 'square' | 'vertical' | 'portrait43' | 'landscape43' | 'wide' {
  if (aspect === '1:1') return 'square'
  if (aspect === '3:4' || aspect === '2:3') return 'portrait43'
  if (aspect === '4:3') return 'landscape43'
  if (aspect === '9:16' || aspect === '3:4') return 'vertical'
  return 'wide'
}

function imageSizeFor(aspect: string, capability: 'openai' | 'stability' | 'ark' | 'dashscope'): string {
  const shape = imageShape(aspect)
  if (capability === 'openai') {
    return shape === 'square' ? '1024x1024' : shape === 'vertical' || shape === 'portrait43' ? '1024x1536' : '1536x1024'
  }
  if (capability === 'stability') {
    return shape === 'square' ? '1:1' : shape === 'vertical' ? '9:16' : shape === 'portrait43' ? '3:4' : shape === 'landscape43' ? '4:3' : '16:9'
  }
  if (capability === 'ark') {
    if (shape === 'square') return '2048x2048'
    if (shape === 'vertical') return '1152x2048'
    if (shape === 'portrait43') return '1536x2048'
    if (shape === 'landscape43') return '2048x1536'
    return '2048x1152'
  }
  if (shape === 'square') return '2048*2048'
  if (shape === 'vertical') return '1152*2048'
  if (shape === 'portrait43') return '1536*2048'
  if (shape === 'landscape43') return '2048*1536'
  return '2048*1152'
}

function geminiAspectRatio(aspect: string): string {
  if (aspect === '1:1' || aspect === '9:16' || aspect === '16:9' || aspect === '3:4' || aspect === '4:3') return aspect
  if (aspect === '2:3') return '3:4'
  return '16:9'
}

function videoAspectRatio(aspect: string): string {
  if (aspect === '9:16') return '9:16'
  if (aspect === '1:1') return '1:1'
  return '16:9'
}

function imageDimensions(aspect: string): [number, number] {
  const shape = imageShape(aspect)
  if (shape === 'square') return [1024, 1024]
  if (shape === 'vertical') return [1024, 1536]
  if (shape === 'portrait43') return [1152, 1536]
  if (shape === 'landscape43') return [1536, 1152]
  return [1536, 1024]
}

function extensionForMime(mime: string, fallback = 'bin'): string {
  if (mime.includes('jpeg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('png')) return 'png'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('flac')) return 'flac'
  return fallback
}

async function imageDataUri(path: string, mime: string): Promise<string> {
  const bytes = await import('node:fs/promises').then((fs) => fs.readFile(path))
  if (bytes.length > 40 * 1024 * 1024) throw new Error('首帧图片超过服务商请求上限。')
  return `data:${mime || 'image/png'};base64,${bytes.toString('base64')}`
}

async function downloadOrThrow(
  url: string,
  label: string,
  options: { signal?: AbortSignal; headers?: Record<string, string>; maxBytes?: number } = {}
): Promise<{ bytes: Buffer; mime: string }> {
  const response = await request(url, { method: 'GET', headers: options.headers }, { signal: options.signal, timeoutMs: 300_000 })
  const bytes = await binaryOrThrow(response, label, options.maxBytes)
  return { bytes, mime: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream' }
}

function base64OrThrow(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}没有返回图片数据。`)
  return Buffer.from(value, 'base64')
}

export async function generateCloudImage(input: {
  provider: CloudMediaProvider
  apiKey: string
  prompt: string
  aspect: string
  workDir: string
  signal?: AbortSignal
}): Promise<{ path: string; model: string; width: number; height: number; mime: string }> {
  mkdirSync(input.workDir, { recursive: true })
  const labels: Record<string, string> = {
    'openai-image': 'OpenAI 图片生成',
    'google-gemini-image': 'Gemini 图片生成',
    'stability-image': 'Stability 图片生成',
    'ark-image': 'Seedream 图片生成',
    'dashscope-image': 'Qwen-Image 图片生成'
  }
  const label = labels[input.provider.protocol] ?? '云端图片生成'
  let bytes: Buffer
  let mime = 'image/png'
  if (input.provider.protocol === 'openai-image') {
    const response = await request(joinUrl(input.provider.baseUrl, 'images/generations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authBearer(input.apiKey) },
      body: JSON.stringify({
        model: input.provider.model,
        prompt: input.prompt,
        n: 1,
        size: imageSizeFor(input.aspect, 'openai')
      })
    }, { signal: input.signal, timeoutMs: 240_000 })
    const data = (await jsonOrThrow(response, label)).data as Array<Record<string, unknown>> | undefined
    const first = data?.[0]
    if (first?.b64_json) {
      bytes = base64OrThrow(first.b64_json, label)
    } else if (typeof first?.url === 'string') {
      const download = await downloadOrThrow(first.url, label, { signal: input.signal })
      bytes = download.bytes
      mime = download.mime
    } else {
      throw new Error(`${label}没有返回图片数据。`)
    }
  } else if (input.provider.protocol === 'google-gemini-image') {
    const response = await request(joinUrl(input.provider.baseUrl, `models/${encodeURIComponent(input.provider.model)}:generateContent`), {
      method: 'POST',
      headers: googleHeaders(input.apiKey),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: geminiAspectRatio(input.aspect) }
        }
      })
    }, { signal: input.signal, timeoutMs: 240_000 })
    const root = await jsonOrThrow(response, label)
    const candidates = root.candidates as Array<Record<string, unknown>> | undefined
    const parts = ((candidates?.[0]?.content as Record<string, unknown> | undefined)?.parts ?? []) as Array<Record<string, unknown>>
    const inline = parts.find((part) => typeof (part.inlineData as Record<string, unknown> | undefined)?.data === 'string')
      ?.inlineData as Record<string, unknown> | undefined
    if (!inline) throw new Error(`${label}没有返回图片数据。`)
    bytes = base64OrThrow(inline.data, label)
    mime = typeof inline.mimeType === 'string' ? inline.mimeType : 'image/png'
  } else if (input.provider.protocol === 'stability-image') {
    const form = new FormData()
    form.append('prompt', input.prompt)
    form.append('model', input.provider.model)
    form.append('aspect_ratio', imageSizeFor(input.aspect, 'stability'))
    form.append('output_format', 'png')
    const response = await request(joinUrl(input.provider.baseUrl, 'v2beta/stable-image/generate/sd3'), {
      method: 'POST',
      headers: { Accept: 'image/*', ...authBearer(input.apiKey) },
      body: form
    }, { signal: input.signal, timeoutMs: 240_000 })
    bytes = await binaryOrThrow(response, label)
    mime = response.headers.get('content-type')?.split(';')[0] || 'image/png'
  } else if (input.provider.protocol === 'ark-image') {
    const response = await request(joinUrl(input.provider.baseUrl, 'images/generations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authBearer(input.apiKey) },
      body: JSON.stringify({
        model: input.provider.model,
        prompt: input.prompt,
        size: imageSizeFor(input.aspect, 'ark'),
        response_format: 'url',
        watermark: false
      })
    }, { signal: input.signal, timeoutMs: 240_000 })
    const root = await jsonOrThrow(response, label)
    const data = root.data as Array<Record<string, unknown>> | undefined
    const first = data?.[0]
    if (first?.b64_json) {
      bytes = base64OrThrow(first.b64_json, label)
    } else if (typeof first?.url === 'string') {
      const download = await downloadOrThrow(first.url, label, { signal: input.signal })
      bytes = download.bytes
      mime = download.mime
    } else {
      throw new Error(`${label}没有返回图片数据。`)
    }
  } else if (input.provider.protocol === 'dashscope-image') {
    const response = await request(joinUrl(input.provider.baseUrl, 'services/aigc/multimodal-generation/generation'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authBearer(input.apiKey) },
      body: JSON.stringify({
        model: input.provider.model,
        input: { messages: [{ role: 'user', content: [{ text: input.prompt }] }] },
        parameters: { size: imageSizeFor(input.aspect, 'dashscope'), n: 1, prompt_extend: true, watermark: false }
      })
    }, { signal: input.signal, timeoutMs: 240_000 })
    const root = await jsonOrThrow(response, label)
    const output = (root.output ?? {}) as Record<string, unknown>
    const choices = output.choices as Array<Record<string, unknown>> | undefined
    const content = ((choices?.[0]?.message as Record<string, unknown> | undefined)?.content ?? []) as Array<Record<string, unknown>>
    const resultUrl = content.find((item) => typeof item.image === 'string')?.image
      ?? (output.results as Array<Record<string, unknown>> | undefined)?.find((item) => typeof item.url === 'string')?.url
    if (typeof resultUrl !== 'string') throw new Error(`${label}没有返回图片地址。`)
    const download = await downloadOrThrow(resultUrl, label, { signal: input.signal })
    bytes = download.bytes
    mime = download.mime
  } else {
    throw new Error('这个多媒体服务不支持图片生成。')
  }
  const extension = extensionForMime(mime, 'png')
  const path = join(input.workDir, `cloud-image-${Date.now().toString(36)}.${extension}`)
  writeFileSync(path, bytes)
  const [width, height] = imageDimensions(input.aspect)
  return { path, model: input.provider.model, width, height, mime }
}

export async function generateCloudSpeech(input: {
  provider: CloudMediaProvider
  apiKey: string
  text: string
  instructions?: string
  voice?: string
  workDir: string
  signal?: AbortSignal
}): Promise<{ path: string; model: string; mime: string }> {
  mkdirSync(input.workDir, { recursive: true })
  const labels: Record<string, string> = {
    'openai-speech': 'OpenAI 配音',
    'elevenlabs-speech': 'ElevenLabs 配音',
    'dashscope-speech': 'Qwen3-TTS 配音',
    'minimax-speech': 'MiniMax 配音'
  }
  const label = labels[input.provider.protocol] ?? '云端配音'
  let bytes: Buffer
  let mime = 'audio/mpeg'
  if (input.provider.protocol === 'openai-speech') {
    const response = await request(joinUrl(input.provider.baseUrl, 'audio/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authBearer(input.apiKey) },
      body: JSON.stringify({
        model: input.provider.model,
        input: input.text,
        voice: input.voice || input.provider.voice || 'alloy',
        response_format: 'mp3',
        ...(input.instructions ? { instructions: input.instructions } : {})
      })
    }, { signal: input.signal, timeoutMs: 180_000 })
    bytes = await binaryOrThrow(response, label, 60 * 1024 * 1024)
    mime = response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg'
  } else if (input.provider.protocol === 'elevenlabs-speech') {
    const voice = input.voice || input.provider.voice || ''
    if (!voice) throw new Error('ElevenLabs 配音需要先填写 Voice ID。')
    const response = await request(
      joinUrl(input.provider.baseUrl, `text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': input.apiKey },
        body: JSON.stringify({ text: input.text, model_id: input.provider.model })
      },
      { signal: input.signal, timeoutMs: 180_000 }
    )
    bytes = await binaryOrThrow(response, label, 60 * 1024 * 1024)
    mime = response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg'
  } else if (input.provider.protocol === 'dashscope-speech') {
    if (input.text.length > 600) throw new Error('Qwen3-TTS 单次最多 600 字，请缩短台词后再生成。')
    const response = await request(joinUrl(input.provider.baseUrl, 'services/aigc/multimodal-generation/generation'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authBearer(input.apiKey) },
      body: JSON.stringify({
        model: input.provider.model,
        input: {
          text: input.text,
          voice: input.voice || input.provider.voice || 'Cherry',
          language_type: 'Auto'
        }
      })
    }, { signal: input.signal, timeoutMs: 180_000 })
    const root = await jsonOrThrow(response, label)
    const output = (root.output ?? {}) as Record<string, unknown>
    const audio = (output.audio ?? {}) as Record<string, unknown>
    const url = typeof audio.url === 'string' ? audio.url : ''
    if (!url) throw new Error(`${label}没有返回音频地址。`)
    const download = await downloadOrThrow(url, label, { signal: input.signal, maxBytes: 60 * 1024 * 1024 })
    bytes = download.bytes
    mime = download.mime
  } else if (input.provider.protocol === 'minimax-speech') {
    if (input.text.length > 10_000) throw new Error('MiniMax 配音单次最多 10000 字，请缩短台词后再生成。')
    const voice = input.voice || input.provider.voice || 'female-shaonv'
    const response = await request(joinUrl(input.provider.baseUrl, 'v1/t2a_v2'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authBearer(input.apiKey) },
      body: JSON.stringify({
        model: input.provider.model,
        text: input.text,
        stream: false,
        output_format: 'hex',
        voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 }
      })
    }, { signal: input.signal, timeoutMs: 180_000 })
    const root = await jsonOrThrow(response, label)
    const baseResp = (root.base_resp ?? {}) as Record<string, unknown>
    if (typeof baseResp.status_code === 'number' && baseResp.status_code !== 0) {
      throw new Error(`${label}失败：${String(baseResp.status_msg ?? baseResp.status_code)}`)
    }
    const data = (root.data ?? {}) as Record<string, unknown>
    const audio = typeof data.audio === 'string' ? data.audio : ''
    if (!audio) throw new Error(`${label}没有返回音频数据。`)
    if (/^https?:\/\//i.test(audio)) {
      const download = await downloadOrThrow(audio, label, { signal: input.signal, maxBytes: 60 * 1024 * 1024 })
      bytes = download.bytes
      mime = download.mime
    } else {
      bytes = Buffer.from(audio, 'hex')
      mime = 'audio/mpeg'
    }
  } else {
    throw new Error('这个多媒体服务不支持配音生成。')
  }
  const extension = extensionForMime(mime, 'mp3')
  const output = join(input.workDir, `cloud-speech-${Date.now().toString(36)}.${extension}`)
  writeFileSync(output, bytes)
  return { path: output, model: input.provider.model, mime }
}

export async function generateCloudVideo(input: {
  provider: CloudMediaProvider
  apiKey: string
  prompt: string
  aspect: string
  seconds: number
  referencePath?: string
  referenceMime?: string
  workDir: string
  signal?: AbortSignal
  onProgress?: (message: string, percent?: number) => void
}): Promise<{ path: string; model: string; durationSec: number; width: number; height: number }> {
  const protocol = input.provider.protocol
  if (protocol !== 'google-veo' && protocol !== 'ark-video' && protocol !== 'minimax-video') {
    throw new Error('这个多媒体服务不支持视频生成。')
  }
  mkdirSync(input.workDir, { recursive: true })
  const aspectRatio = videoAspectRatio(input.aspect)
  const requestedSeconds = Math.round(input.seconds)
  const seconds = protocol === 'google-veo'
    ? requestedSeconds <= 5 ? 4 : requestedSeconds <= 7 ? 6 : 8
    : Math.max(4, Math.min(15, requestedSeconds))
  let bytes: Buffer
  let mime = 'video/mp4'
  if (protocol === 'google-veo') {
    const instances: Array<Record<string, unknown>> = [{ prompt: input.prompt }]
    if (input.referencePath) {
      const image = await import('node:fs/promises').then((fs) => fs.readFile(input.referencePath!))
      instances[0].image = {
        bytesBase64Encoded: image.toString('base64'),
        mimeType: input.referenceMime || 'image/png'
      }
    }
    input.onProgress?.('提交视频任务', 8)
    const start = await request(joinUrl(input.provider.baseUrl, `models/${encodeURIComponent(input.provider.model)}:predictLongRunning`), {
      method: 'POST',
      headers: googleHeaders(input.apiKey),
      body: JSON.stringify({
        instances,
        parameters: { aspectRatio, durationSeconds: seconds, resolution: '720p' }
      })
    }, { signal: input.signal, timeoutMs: 120_000 })
    const operation = await jsonOrThrow(start, 'Veo 视频任务')
    const name = typeof operation.name === 'string' ? operation.name : ''
    if (!name) throw new Error('Veo 没有返回任务 ID。')
    let done: Record<string, unknown> | null = null
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (input.signal?.aborted) throw new Error('视频生成已取消。')
      input.onProgress?.('等待 Veo 渲染', Math.min(90, 10 + attempt))
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      const pollUrl = /^https?:\/\//i.test(name)
        ? name
        : /^\/?v1beta\//.test(name)
          ? new URL(name.replace(/^\/?/, '/'), input.provider.baseUrl).toString()
          : joinUrl(input.provider.baseUrl, name)
      const poll = await request(pollUrl, { method: 'GET', headers: googleHeaders(input.apiKey) }, { signal: input.signal, timeoutMs: 60_000 })
      const status = await jsonOrThrow(poll, 'Veo 任务状态')
      if (status.error) throw new Error(`Veo 失败：${String((status.error as Record<string, unknown>).message ?? '未知错误')}`)
      if (status.done === true) {
        done = status
        break
      }
    }
    if (!done) throw new Error('Veo 视频生成超时，任务可能仍在服务商侧运行。')
    const response = (done.response ?? {}) as Record<string, unknown>
    const generated = response.generateVideoResponse as Record<string, unknown> | undefined
    const samples = (generated?.generatedSamples ?? response.generatedVideos ?? response.videos) as Array<Record<string, unknown>> | undefined
    const first = samples?.[0]
    const video = (first?.video ?? first) as Record<string, unknown> | undefined
    const uri = typeof video?.uri === 'string' ? video.uri : typeof video?.gcsUri === 'string' ? video.gcsUri : ''
    const inline = typeof video?.bytesBase64Encoded === 'string' ? video.bytesBase64Encoded : ''
    if (inline) {
      bytes = Buffer.from(inline, 'base64')
    } else if (uri) {
      const download = await downloadOrThrow(uri, 'Veo 视频下载', {
        signal: input.signal,
        headers: uri.startsWith(input.provider.baseUrl) || uri.includes('generativelanguage.googleapis.com') ? googleHeaders(input.apiKey) : {}
      })
      bytes = download.bytes
      mime = download.mime.includes('video') ? download.mime : 'video/mp4'
    } else {
      throw new Error('Veo 完成了，但没有返回可下载的视频。')
    }
  } else if (protocol === 'ark-video') {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }]
    if (input.referencePath) {
      content.push({
        type: 'image_url',
        image_url: { url: await imageDataUri(input.referencePath, input.referenceMime || 'image/png') },
        role: 'first_frame'
      })
    }
    input.onProgress?.('提交 Seedance 任务', 8)
    const start = await request(joinUrl(input.provider.baseUrl, 'contents/generations/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authBearer(input.apiKey) },
      body: JSON.stringify({
        model: input.provider.model,
        content,
        ratio: aspectRatio,
        duration: seconds,
        resolution: '720p',
        generate_audio: false,
        watermark: false
      })
    }, { signal: input.signal, timeoutMs: 120_000 })
    const created = await jsonOrThrow(start, 'Seedance 视频任务')
    const taskId = typeof created.id === 'string' ? created.id : ''
    if (!taskId) throw new Error('Seedance 没有返回任务 ID。')
    let videoUrl = ''
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (input.signal?.aborted) throw new Error('视频生成已取消。')
      input.onProgress?.('等待 Seedance 渲染', Math.min(90, 10 + attempt))
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      const poll = await request(joinUrl(input.provider.baseUrl, `contents/generations/tasks/${encodeURIComponent(taskId)}`), {
        method: 'GET',
        headers: authBearer(input.apiKey)
      }, { signal: input.signal, timeoutMs: 60_000 })
      const status = await jsonOrThrow(poll, 'Seedance 任务状态')
      const state = typeof status.status === 'string' ? status.status : ''
      if (state === 'failed' || state === 'cancelled') {
        const error = status.error as Record<string, unknown> | undefined
        throw new Error(`Seedance 失败：${String(error?.message ?? state)}`)
      }
      if (state === 'succeeded') {
        const result = (status.content ?? {}) as Record<string, unknown>
        videoUrl = typeof result.video_url === 'string'
          ? result.video_url
          : typeof result.url === 'string'
            ? result.url
            : typeof status.video_url === 'string'
              ? status.video_url
              : ''
        break
      }
    }
    if (!videoUrl) throw new Error('Seedance 视频生成超时，任务可能仍在服务商侧运行。')
    const download = await downloadOrThrow(videoUrl, 'Seedance 视频下载', { signal: input.signal, maxBytes: 240 * 1024 * 1024 })
    bytes = download.bytes
    mime = download.mime.includes('video') ? download.mime : 'video/mp4'
  } else {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }]
    if (input.referencePath) {
      content.push({
        type: 'image_url',
        image_url: { url: await imageDataUri(input.referencePath, input.referenceMime || 'image/png') },
        role: 'first_frame'
      })
    }
    input.onProgress?.('提交 MiniMax H3 任务', 8)
    const start = await request(joinUrl(input.provider.baseUrl, 'v2/video_generation'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authBearer(input.apiKey) },
      body: JSON.stringify({
        model: input.provider.model,
        content,
        resolution: '768P',
        duration: seconds,
        ratio: aspectRatio
      })
    }, { signal: input.signal, timeoutMs: 120_000 })
    const created = await jsonOrThrow(start, 'MiniMax 视频任务')
    const baseResp = (created.base_resp ?? {}) as Record<string, unknown>
    if (typeof baseResp.status_code === 'number' && baseResp.status_code !== 0) {
      throw new Error(`MiniMax 视频任务失败：${String(baseResp.status_msg ?? baseResp.status_code)}`)
    }
    const task = (created.task ?? {}) as Record<string, unknown>
    const taskId = typeof created.task_id === 'string' ? created.task_id : typeof task.id === 'string' ? task.id : ''
    if (!taskId) throw new Error('MiniMax 没有返回任务 ID。')
    let videoUrl = ''
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (input.signal?.aborted) throw new Error('视频生成已取消。')
      input.onProgress?.('等待 MiniMax H3 渲染', Math.min(90, 10 + attempt))
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      const poll = await request(joinUrl(input.provider.baseUrl, `v2/query/video_generation/${encodeURIComponent(taskId)}`), {
        method: 'GET',
        headers: authBearer(input.apiKey)
      }, { signal: input.signal, timeoutMs: 60_000 })
      const status = await jsonOrThrow(poll, 'MiniMax 任务状态')
      const taskState = (status.task ?? status) as Record<string, unknown>
      const state = typeof taskState.status === 'string' ? taskState.status : ''
      if (state === 'failed' || state === 'cancelled') {
        const error = taskState.error as Record<string, unknown> | undefined
        throw new Error(`MiniMax 视频失败：${String(error?.message ?? state)}`)
      }
      if (state === 'succeeded') {
        const result = (taskState.content ?? {}) as Record<string, unknown>
        videoUrl = typeof result.url === 'string'
          ? result.url
          : typeof result.video_url === 'string'
            ? result.video_url
            : ''
        break
      }
    }
    if (!videoUrl) throw new Error('MiniMax 视频生成超时，任务可能仍在服务商侧运行。')
    const download = await downloadOrThrow(videoUrl, 'MiniMax 视频下载', { signal: input.signal, maxBytes: 240 * 1024 * 1024 })
    bytes = download.bytes
    mime = download.mime.includes('video') ? download.mime : 'video/mp4'
  }
  const extension = extensionForMime(mime, 'mp4')
  const path = join(input.workDir, `cloud-video-${Date.now().toString(36)}.${extension}`)
  writeFileSync(path, bytes)
  return {
    path,
    model: input.provider.model,
    durationSec: seconds,
    width: aspectRatio === '9:16' ? 720 : 1280,
    height: aspectRatio === '9:16' ? 1280 : 720
  }
}

export async function generateCloudMusic(input: {
  provider: CloudMediaProvider
  apiKey: string
  prompt: string
  seconds: number
  workDir: string
  signal?: AbortSignal
}): Promise<{ path: string; model: string; durationSec: number; mime: string }> {
  if (input.provider.protocol !== 'elevenlabs-music') throw new Error('这个多媒体服务不支持配乐生成。')
  mkdirSync(input.workDir, { recursive: true })
  const seconds = Math.max(10, Math.min(300, Math.round(input.seconds)))
  const response = await request(
    joinUrl(input.provider.baseUrl, 'music?output_format=mp3_44100_128'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': input.apiKey },
      body: JSON.stringify({
        prompt: input.prompt,
        music_length_ms: seconds * 1000,
        model_id: input.provider.model
      })
    },
    { signal: input.signal, timeoutMs: 300_000 }
  )
  const path = join(input.workDir, `cloud-music-${Date.now().toString(36)}.mp3`)
  writeFileSync(path, await binaryOrThrow(response, 'ElevenLabs 配乐', 120 * 1024 * 1024))
  return { path, model: input.provider.model, durationSec: seconds, mime: 'audio/mpeg' }
}

export function cloudMediaPresetCount(): number {
  return CLOUD_MEDIA_PRESETS.length
}
