/**
 * 最小 ComfyUI API fixture：供 E2E 验证“设置 → 生成 → 画布/聊天预览”全链路。
 * 只实现 Morrow 用到的端点；返回 tests/fixtures/media 里的真实图片和视频。
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mediaDir = join(process.cwd(), 'tests', 'fixtures', 'media')

const OBJECT_INFO = {
  UnetLoaderGGUF: {
    input: { required: { unet_name: [['qwen-image-2.1-turbo-Q6_K.gguf'], {}] } }
  },
  UNETLoader: {
    input: { required: { unet_name: [['minimax_h3_ref2va_dit_16g.safetensors', 'minimax_h3_fl2va_dit_16g.safetensors'], {}] } }
  },
  CLIPLoader: {
    input: {
      required: {
        clip_name: [['qwen3vl_8b_bf16.safetensors', 'qwen3vl_text_encoder.safetensors'], {}],
        type: [['qwen_image', 'minimax'], {}]
      }
    }
  },
  VAELoader: {
    input: {
      required: {
        vae_name: [
          ['qwen_image_2.1_vae_bf16.safetensors', 'minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_audio_vae_fp32.safetensors'],
          {}
        ]
      }
    }
  },
  MiniMaxH3MemoryEfficientSolAttentionPatch: { input: { required: {} } },
  TextEncodeQwenImage21: { input: { required: {} } },
  MiniMaxH3ReferenceToVideo: { input: { required: {} } }
}

function json(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function isVideoGraph(graph) {
  return Object.values(graph ?? {}).some((node) => node && node.class_type === 'SaveVideo')
}

export async function startMockComfyUI(options = {}) {
  const delayMs = options.delayMs ?? 500
  const requests = []
  const graphs = []
  const jobs = new Map()
  const sockets = new Set()
  let sequence = 0

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), at: Date.now() })

    if (url.pathname === '/system_stats') {
      json(response, 200, {
        system: { os: 'win32', comfyui_version: '0.42.1-mock' },
        devices: [{ name: 'Mock GPU', vram_total: 16 * 1024 * 1024 * 1024, vram_free: 12 * 1024 * 1024 * 1024 }]
      })
      return
    }
    if (url.pathname === '/queue') {
      json(response, 200, { queue_running: [], queue_pending: [] })
      return
    }
    if (url.pathname === '/interrupt') {
      json(response, 200, {})
      return
    }
    if (url.pathname === '/upload/image') {
      await readBody(request)
      json(response, 200, { name: 'mock-reference.png', subfolder: '', type: 'input' })
      return
    }
    if (url.pathname.startsWith('/object_info/')) {
      const name = decodeURIComponent(url.pathname.slice('/object_info/'.length))
      json(response, 200, OBJECT_INFO[name] ? { [name]: OBJECT_INFO[name] } : {})
      return
    }
    if (url.pathname === '/prompt' && request.method === 'POST') {
      const body = await readBody(request)
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        json(response, 400, { error: 'invalid json' })
        return
      }
      sequence += 1
      const promptId = `mock-prompt-${sequence}`
      graphs.push(parsed.prompt ?? {})
      jobs.set(promptId, { video: isVideoGraph(parsed.prompt), submittedAt: Date.now() })
      json(response, 200, { prompt_id: promptId, number: sequence - 1, node_errors: {} })
      return
    }
    if (url.pathname.startsWith('/history/')) {
      const promptId = decodeURIComponent(url.pathname.slice('/history/'.length))
      const job = jobs.get(promptId)
      if (!job) {
        json(response, 200, {})
        return
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      const filename = job.video ? 'mock-video.mp4' : 'mock-image.png'
      json(response, 200, {
        [promptId]: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: {
            save: {
              images: [
                {
                  filename,
                  subfolder: 'morrow',
                  type: 'output',
                  metadata: job.video
                    ? { kind: 'video', width: 320, height: 180, duration: 1, fps: 24, frame_count: 24 }
                    : { kind: 'image', width: 320, height: 180 }
                }
              ]
            }
          }
        }
      })
      return
    }
    if (url.pathname === '/view') {
      const filename = url.searchParams.get('filename') ?? 'mock-image.png'
      const video = filename.toLowerCase().endsWith('.mp4')
      const buffer = readFileSync(join(mediaDir, video ? 'sample.mp4' : 'sample.png'))
      response.writeHead(200, {
        'Content-Type': video ? 'video/mp4' : 'image/png',
        'Content-Length': buffer.length
      })
      response.end(buffer)
      return
    }
    if (url.pathname === '/ws') {
      response.writeHead(400)
      response.end('websocket not supported by mock')
      return
    }
    json(response, 404, { error: `not found: ${url.pathname}` })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    graphs,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
