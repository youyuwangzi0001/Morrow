import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import {
  generateCloudImage,
  generateCloudMusic,
  generateCloudSpeech,
  generateCloudVideo
} from '../../src/main/media-cloud'
import { CLOUD_MEDIA_PRESETS, normalizeCloudMediaProviders, normalizeMediaDefaults } from '../../src/shared/media-cloud'
import type { CloudMediaCapability, CloudMediaProvider } from '../../src/shared/media-cloud'

vi.mock('../../src/main/settings', () => ({
  getSettingsStore: () => ({ get: () => ({ mediaProviders: [], mediaDefaults: {} }), getCloudMediaApiKey: () => null })
}))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const MP3 = Buffer.from('ID3mock-mp3-audio')
const WAV = Buffer.from('RIFFmock-wav-audio')

interface Received {
  url: string
  method: string
  headers: IncomingMessage['headers']
  body: string
}

async function withServer(
  handler: (request: Received, response: ServerResponse) => void,
  run: (baseUrl: string, requests: Received[]) => Promise<void>
): Promise<void> {
  const requests: Received[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const received = { url: req.url ?? '', method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(received)
      handler(received, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    await run(`http://127.0.0.1:${port}`, requests)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const workDir = (): string => mkdtempSync(join(tmpdir(), 'morrow-media-cloud-'))

function capabilityFor(protocol: CloudMediaProvider['protocol']): CloudMediaCapability {
  if (protocol.endsWith('-image')) return 'image'
  if (protocol === 'google-veo' || protocol === 'ark-video' || protocol === 'minimax-video') return 'video'
  if (protocol === 'elevenlabs-music' || protocol === 'mureka-music') return 'music'
  return 'speech'
}

function provider(protocol: CloudMediaProvider['protocol'], baseUrl: string, model: string): CloudMediaProvider {
  return {
    id: protocol,
    capability: capabilityFor(protocol),
    protocol,
    name: protocol,
    baseUrl,
    model,
    enabled: true,
    apiKeyStored: true
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('云端多媒体 HTTP 接入', () => {
  it('@core:media OpenAI 图片解析 b64 并写入文件', async () => {
    const dir = workDir()
    try {
      await withServer(
        (_request, response) => {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
        },
        async (baseUrl, requests) => {
          const result = await generateCloudImage({
            provider: provider('openai-image', baseUrl, 'gpt-image-2.6-sunburst'),
            apiKey: 'sk-test',
            prompt: '一只纸伞',
            aspect: '16:9',
            workDir: dir
          })
          expect(readFileSync(result.path).equals(PNG)).toBe(true)
          expect(requests[0].url).toBe('/images/generations')
          expect(requests[0].headers.authorization).toBe('Bearer sk-test')
          expect(JSON.parse(requests[0].body)).toMatchObject({ model: 'gpt-image-2.6-sunburst', prompt: '一只纸伞', size: '1536x1024' })
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media Gemini Nano Banana 使用 generateContent 并解析 inlineData', async () => {
    const dir = workDir()
    try {
      await withServer(
        (_request, response) => {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] }))
        },
        async (baseUrl, requests) => {
          const result = await generateCloudImage({
            provider: provider('google-gemini-image', `${baseUrl}/v1beta`, 'gemini-nano-banana-2.1'),
            apiKey: 'google-key',
            prompt: '雨巷',
            aspect: '9:16',
            workDir: dir
          })
          expect(readFileSync(result.path).equals(PNG)).toBe(true)
          expect(requests[0].url).toBe('/v1beta/models/gemini-nano-banana-2.1:generateContent')
          expect(requests[0].headers['x-goog-api-key']).toBe('google-key')
          expect(JSON.parse(requests[0].body)).toMatchObject({
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '9:16' } }
          })
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media Stability 图片使用官方 SD3 端点并接收二进制', async () => {
    const dir = workDir()
    try {
      await withServer(
        (request, response) => {
          expect(request.body).toContain('name="prompt"')
          expect(request.body).toContain('sd3.5-large')
          response.setHeader('content-type', 'image/png')
          response.end(PNG)
        },
        async (baseUrl) => {
          const result = await generateCloudImage({
            provider: provider('stability-image', baseUrl, 'sd3.5-large'),
            apiKey: 'stability-key',
            prompt: '旧城雨夜',
            aspect: '1:1',
            workDir: dir
          })
          expect(readFileSync(result.path).equals(PNG)).toBe(true)
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media Seedream 使用方舟图片接口并下载外链', async () => {
    const dir = workDir()
    try {
      await withServer(
        (request, response) => {
          if (request.method === 'POST' && request.url === '/api/v3/images/generations') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ data: [{ url: `http://${request.headers.host}/seedream.png` }] }))
            return
          }
          if (request.method === 'GET' && request.url === '/seedream.png') {
            response.setHeader('content-type', 'image/png')
            response.end(PNG)
            return
          }
          response.statusCode = 404
          response.end('missing')
        },
        async (baseUrl, requests) => {
          const result = await generateCloudImage({
            provider: provider('ark-image', `${baseUrl}/api/v3`, 'doubao-seedream-5-0-pro-260628'),
            apiKey: 'ark-key',
            prompt: '纸伞与雨巷',
            aspect: '16:9',
            workDir: dir
          })
          expect(readFileSync(result.path).equals(PNG)).toBe(true)
          expect(requests[0].headers.authorization).toBe('Bearer ark-key')
          expect(JSON.parse(requests[0].body)).toMatchObject({
            model: 'doubao-seedream-5-0-pro-260628',
            size: '2048x1152',
            response_format: 'url'
          })
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media Qwen-Image 使用百炼多模态接口并下载图片', async () => {
    const dir = workDir()
    try {
      await withServer(
        (request, response) => {
          if (request.method === 'POST' && request.url === '/api/v1/services/aigc/multimodal-generation/generation') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ output: { choices: [{ message: { content: [{ image: `http://${request.headers.host}/qwen.png` }] } }] } }))
            return
          }
          if (request.method === 'GET' && request.url === '/qwen.png') {
            response.setHeader('content-type', 'image/png')
            response.end(PNG)
            return
          }
          response.statusCode = 404
          response.end('missing')
        },
        async (baseUrl, requests) => {
          const result = await generateCloudImage({
            provider: provider('dashscope-image', `${baseUrl}/api/v1`, 'qwen-image-2.1-pro'),
            apiKey: 'dashscope-key',
            prompt: '水墨纸伞',
            aspect: '1:1',
            workDir: dir
          })
          expect(readFileSync(result.path).equals(PNG)).toBe(true)
          expect(JSON.parse(requests[0].body)).toMatchObject({
            model: 'qwen-image-2.1-pro',
            input: { messages: [{ role: 'user', content: [{ text: '水墨纸伞' }] }] },
            parameters: { size: '2048*2048', n: 1 }
          })
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media ElevenLabs 配音拼接 Voice ID 并返回 mp3', async () => {
    const dir = workDir()
    try {
      await withServer(
        (_request, response) => {
          response.setHeader('content-type', 'audio/mpeg')
          response.end(MP3)
        },
        async (baseUrl, requests) => {
          const result = await generateCloudSpeech({
            provider: { ...provider('elevenlabs-speech', `${baseUrl}/v1`, 'eleven_v4'), voice: 'voice-123' },
            apiKey: 'xi-key',
            text: '雨停了。',
            workDir: dir
          })
          expect(readFileSync(result.path).equals(MP3)).toBe(true)
          expect(requests[0].url).toContain('/v1/text-to-speech/voice-123')
          expect(requests[0].headers['xi-api-key']).toBe('xi-key')
          expect(JSON.parse(requests[0].body)).toMatchObject({ text: '雨停了。', model_id: 'eleven_v4' })
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media Qwen3-TTS 使用百炼接口并下载 wav', async () => {
    const dir = workDir()
    try {
      await withServer(
        (request, response) => {
          if (request.method === 'POST' && request.url === '/api/v1/services/aigc/multimodal-generation/generation') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ output: { audio: { url: `http://${request.headers.host}/qwen.wav` } } }))
            return
          }
          if (request.method === 'GET' && request.url === '/qwen.wav') {
            response.setHeader('content-type', 'audio/wav')
            response.end(WAV)
            return
          }
          response.statusCode = 404
          response.end('missing')
        },
        async (baseUrl, requests) => {
          const result = await generateCloudSpeech({
            provider: provider('dashscope-speech', `${baseUrl}/api/v1`, 'qwen3-tts-flash'),
            apiKey: 'dashscope-key',
            text: '雨停了。',
            workDir: dir
          })
          expect(readFileSync(result.path).equals(WAV)).toBe(true)
          expect(result.path.endsWith('.wav')).toBe(true)
          expect(result.mime).toBe('audio/wav')
          expect(JSON.parse(requests[0].body)).toMatchObject({
            model: 'qwen3-tts-flash',
            input: { text: '雨停了。', voice: 'Cherry', language_type: 'Auto' }
          })
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media MiniMax Speech 使用 T2A v2 并解码 hex 音频', async () => {
    const dir = workDir()
    try {
      await withServer(
        (request, response) => {
          expect(request.url).toBe('/v1/t2a_v2')
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ data: { audio: MP3.toString('hex') }, base_resp: { status_code: 0 } }))
        },
        async (baseUrl, requests) => {
          const result = await generateCloudSpeech({
            provider: provider('minimax-speech', baseUrl, 'speech-2.8-hd'),
            apiKey: 'mm-key',
            text: '伞下的雨声。',
            workDir: dir
          })
          expect(readFileSync(result.path).equals(MP3)).toBe(true)
          expect(result.mime).toBe('audio/mpeg')
          expect(JSON.parse(requests[0].body)).toMatchObject({
            model: 'speech-2.8-hd',
            text: '伞下的雨声。',
            voice_setting: { voice_id: 'female-shaonv' }
          })
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media Veo 轮询任务、下载视频并返回时长', async () => {
    const dir = workDir()
    try {
      await withServer(
        (request, response) => {
          if (request.url.includes(':predictLongRunning')) {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ name: 'operations/veo-1' }))
            return
          }
          if (request.url.startsWith('/v1beta/operations/veo-1')) {
            response.setHeader('content-type', 'application/json')
            response.end(
              JSON.stringify({
                done: true,
                response: {
                  generateVideoResponse: { generatedSamples: [{ video: { uri: `http://${request.headers.host}/video.mp4` } }] }
                }
              })
            )
            return
          }
          if (request.url === '/video.mp4') {
            response.setHeader('content-type', 'video/mp4')
            response.end(Buffer.from('mock-mp4'))
            return
          }
          response.statusCode = 404
          response.end('missing')
        },
        async (baseUrl) => {
          const result = await generateCloudVideo({
            provider: provider('google-veo', `${baseUrl}/v1beta`, 'veo-3.1-generate-001'),
            apiKey: 'google-key',
            prompt: '雨中走过街口',
            aspect: '16:9',
            seconds: 8,
            workDir: dir
          })
          expect(readFileSync(result.path).toString()).toBe('mock-mp4')
          expect(result.durationSec).toBe(8)
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media Seedance 提交首帧任务、轮询并下载视频', async () => {
    const dir = workDir()
    const firstFrame = join(dir, 'first.png')
    writeFileSync(firstFrame, PNG)
    try {
      await withServer(
        (request, response) => {
          if (request.method === 'POST' && request.url === '/api/v3/contents/generations/tasks') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ id: 'seedance-1' }))
            return
          }
          if (request.method === 'GET' && request.url === '/api/v3/contents/generations/tasks/seedance-1') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ status: 'succeeded', content: { video_url: `http://${request.headers.host}/seedance.mp4` } }))
            return
          }
          if (request.method === 'GET' && request.url === '/seedance.mp4') {
            response.setHeader('content-type', 'video/mp4')
            response.end(Buffer.from('seedance-mp4'))
            return
          }
          response.statusCode = 404
          response.end('missing')
        },
        async (baseUrl, requests) => {
          const result = await generateCloudVideo({
            provider: provider('ark-video', `${baseUrl}/api/v3`, 'doubao-seedance-2-5-260628'),
            apiKey: 'ark-key',
            prompt: '纸伞在雨里旋转',
            aspect: '16:9',
            seconds: 6,
            referencePath: firstFrame,
            referenceMime: 'image/png',
            workDir: dir
          })
          expect(readFileSync(result.path).toString()).toBe('seedance-mp4')
          expect(result.durationSec).toBe(6)
          const body = JSON.parse(requests[0].body)
          expect(body).toMatchObject({ model: 'doubao-seedance-2-5-260628', ratio: '16:9', duration: 6, resolution: '720p', generate_audio: false })
          expect(body.content[1]).toMatchObject({ type: 'image_url', role: 'first_frame' })
          expect(body.content[1].image_url.url.startsWith('data:image/png;base64,')).toBe(true)
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media MiniMax H3 提交任务、轮询并下载视频', async () => {
    const dir = workDir()
    try {
      await withServer(
        (request, response) => {
          if (request.method === 'POST' && request.url === '/v2/video_generation') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ task_id: 'h3-1', base_resp: { status_code: 0 } }))
            return
          }
          if (request.method === 'GET' && request.url === '/v2/query/video_generation/h3-1') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ task: { status: 'succeeded', content: { url: `http://${request.headers.host}/h3.mp4` } } }))
            return
          }
          if (request.method === 'GET' && request.url === '/h3.mp4') {
            response.setHeader('content-type', 'video/mp4')
            response.end(Buffer.from('h3-mp4'))
            return
          }
          response.statusCode = 404
          response.end('missing')
        },
        async (baseUrl, requests) => {
          const result = await generateCloudVideo({
            provider: provider('minimax-video', baseUrl, 'MiniMax-H3'),
            apiKey: 'mm-key',
            prompt: '雨巷里的纸伞',
            aspect: '16:9',
            seconds: 3,
            workDir: dir
          })
          expect(readFileSync(result.path).toString()).toBe('h3-mp4')
          expect(result.durationSec).toBe(4)
          expect(JSON.parse(requests[0].body)).toMatchObject({ model: 'MiniMax-H3', resolution: '768P', duration: 4, ratio: '16:9' })
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media ElevenLabs 配乐按秒请求并写入 mp3', async () => {
    const dir = workDir()
    try {
      await withServer(
        (_request, response) => {
          response.setHeader('content-type', 'audio/mpeg')
          response.end(MP3)
        },
        async (baseUrl, requests) => {
          const result = await generateCloudMusic({
            provider: provider('elevenlabs-music', `${baseUrl}/v1`, 'music_v2_5'),
            apiKey: 'xi-key',
            prompt: '克制的钢琴',
            seconds: 30,
            workDir: dir
          })
          expect(readFileSync(result.path).equals(MP3)).toBe(true)
          expect(requests[0].url).toContain('/v1/music')
          expect(JSON.parse(requests[0].body)).toMatchObject({ prompt: '克制的钢琴', music_length_ms: 30_000, model_id: 'music_v2_5' })
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media Mureka 纯音乐提交任务、轮询并下载', async () => {
    const dir = workDir()
    try {
      await withServer(
        (request, response) => {
          if (request.method === 'POST' && request.url === '/v1/instrumental/generate') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ id: 'mureka-1', status: 'preparing', model: 'mureka-9.5' }))
            return
          }
          if (request.method === 'GET' && request.url === '/v1/instrumental/query/mureka-1') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({
              id: 'mureka-1',
              status: 'succeeded',
              model: 'mureka-9.5',
              choices: [{ id: 'track-1', url: `http://${request.headers.host}/mureka.mp3`, duration: 195300 }]
            }))
            return
          }
          if (request.method === 'GET' && request.url === '/mureka.mp3') {
            response.setHeader('content-type', 'audio/mpeg')
            response.end(MP3)
            return
          }
          response.statusCode = 404
          response.end('missing')
        },
        async (baseUrl, requests) => {
          const result = await generateCloudMusic({
            provider: provider('mureka-music', baseUrl, 'auto'),
            apiKey: 'mureka-key',
            prompt: '克制的钢琴与雨声',
            seconds: 30,
            workDir: dir
          })
          expect(readFileSync(result.path).equals(MP3)).toBe(true)
          expect(result.model).toBe('mureka-9.5')
          expect(result.durationSec).toBe(195)
          expect(JSON.parse(requests[0].body)).toMatchObject({ prompt: '克制的钢琴与雨声', model: 'auto', n: 1, stream: false })
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:media 官方配音预设包含完整系统音色', () => {
    const byId = (id: string) => CLOUD_MEDIA_PRESETS.find((preset) => preset.id === id)
    const qwen = byId('qwen3-tts')
    const openai = byId('openai-speech')
    const minimax = byId('minimax-speech-2-8')
    expect(qwen?.voices?.length).toBe(48)
    expect(qwen?.voices?.some((voice) => voice.id === 'Cherry')).toBe(true)
    expect(openai?.voices?.length).toBe(13)
    expect(openai?.voices?.some((voice) => voice.id === 'marin')).toBe(true)
    expect(openai?.voices?.some((voice) => voice.id === 'cedar')).toBe(true)
    expect(minimax?.voices?.length).toBe(327)
    expect(minimax?.voices?.some((voice) => voice.id === 'female-shaonv')).toBe(true)
    expect(byId('qwen-image-2-pro')?.model).toBe('qwen-image-2.1-pro')
  })

  it('@core:media 多媒体配置归一化会丢弃未知服务和错误默认项', () => {
    const providers = normalizeCloudMediaProviders([
      { id: 'seedream-5-pro', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-pro-260628', enabled: true },
      { id: 'google-imagen', baseUrl: 'https://x.example', model: 'imagen-4.0-generate-001' },
      { id: 'google-veo', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'veo-3.1-generate-preview' },
      { id: 'seedream-5-pro', baseUrl: 'https://dup.example', model: 'x' }
    ])
    expect(providers.map((item) => item.id)).toEqual(['seedream-5-pro', 'google-veo'])
    expect(providers[1].model).toBe('veo-3.1-generate-001')
    expect(normalizeMediaDefaults({ image: 'seedream-5-pro', video: 'seedream-5-pro' }, providers)).toEqual({ image: 'seedream-5-pro' })
  })
})
