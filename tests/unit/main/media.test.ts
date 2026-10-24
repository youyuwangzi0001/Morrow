/**
 * 合并后的 media 组：通用模型目录、本地多媒体引擎真实集成（默认跳过）、多媒体设置。
 * 每个原文件整体包在 describe('<原文件名>') 中；hooks/常量随原文件进入 wrapper。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mediaState = vi.hoisted(() => {
  const createSettings = () => ({
    mediaEngine: {
      enabled: true,
      comfyuiUrl: 'http://127.0.0.1:8188',
      comfyuiDir: null as string | null,
      ffmpegPath: null as string | null,
      autoStart: false,
      imageTimeoutSec: 120,
      videoTimeoutSec: 300,
      outputDir: 'media'
    },
    providers: [] as Array<Record<string, unknown>>
  })
  return {
    dataDir: '',
    settings: createSettings(),
    safeStorage: { available: false },
    createSettings
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: (name: string) => (name === 'userData' ? mediaState.dataDir : join(mediaState.dataDir, name))
  },
  safeStorage: {
    isEncryptionAvailable: () => mediaState.safeStorage.available,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = Buffer.from(value).toString('utf8')
      return text.startsWith('enc:') ? text.slice(4) : text
    }
  },
  dialog: {},
  shell: {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

vi.mock('../../../src/main/services/settings-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/services/settings-store')>()
  return {
    ...actual,
    // 目录用例只读取当前设置；设置用例仍使用真实 SettingsStore 类。
    getSettingsStore: (() => ({ get: () => mediaState.settings })) as unknown as typeof actual.getSettingsStore
  }
})

vi.mock('../../../src/main/services/media-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/services/media-service')>()
  return {
    ...actual,
    // 目录用例只需要引擎启停替身；集成用例直接 new MediaService，走真实实现。
    getMediaService: (() => ({
      startEngine: async () => undefined,
      stopEngine: async () => undefined
    })) as unknown as typeof actual.getMediaService
  }
})

import { defaultSettings } from '../../../src/shared/models'
import { MediaCatalog } from '../../../src/main/services/media-catalog'
import { MediaService, locateComfyui } from '../../../src/main/services/media-service'
import { SettingsStore } from '../../../src/main/services/settings-store'

function resetMediaState(): void {
  mediaState.dataDir = ''
  mediaState.settings = mediaState.createSettings()
  mediaState.safeStorage.available = false
}

describe('media-catalog.test.ts', () => {
  const baseModel = {
    id: 'custom-model',
    label: 'Custom Model',
    engine: 'comfyui',
    kind: 'image',
    capabilities: ['text-to-image'],
    source: 'user',
    install: {
      type: 'files',
      files: [{ url: 'https://example.com/model.safetensors', dest: 'diffusion_models/model.safetensors' }]
    }
  }

  let catalogDataDir = ''

  beforeEach(() => {
    resetMediaState()
    catalogDataDir = mkdtempSync(join(tmpdir(), 'morrow-catalog-'))
    mediaState.dataDir = catalogDataDir
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (catalogDataDir) rmSync(catalogDataDir, { recursive: true, force: true })
    catalogDataDir = ''
    resetMediaState()
  })

  describe('通用模型目录', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('offline')
      }))
    })

    it('注册自定义模型并持久化，重复 id 被拒绝', async () => {
      const catalog = new MediaCatalog()
      const status = await catalog.registerModel(baseModel)
      expect(status.models.some((model) => model.id === 'custom-model')).toBe(true)
      expect(existsSync(join(mediaState.dataDir, 'media-models.json'))).toBe(true)
      await expect(catalog.registerModel(baseModel)).rejects.toThrow('id 已存在')
    })

    it('拒绝越界文件路径与非 http(s) 下载地址', async () => {
      const catalog = new MediaCatalog()
      await expect(catalog.registerModel({
        ...baseModel,
        id: 'bad-path',
        install: { type: 'files', files: [{ url: 'https://example.com/a', dest: '../escape.bin' }] }
      })).rejects.toThrow('路径不安全')
      await expect(catalog.registerModel({
        ...baseModel,
        id: 'bad-url',
        install: { type: 'files', files: [{ url: 'file:///etc/passwd', dest: 'x.bin' }] }
      })).rejects.toThrow('URL')
    })

    it('注册自定义引擎并只允许移除用户清单', async () => {
      const catalog = new MediaCatalog()
      const status = await catalog.registerEngine({
        id: 'my-engine',
        label: 'My Engine',
        kind: 'custom',
        capabilities: ['vision'],
        source: 'user',
        detect: { command: 'my-engine' }
      })
      expect(status.engines.some((engine) => engine.id === 'my-engine')).toBe(true)
      await expect(catalog.removeEngine('llamacpp')).rejects.toThrow('内置引擎')
      const next = await catalog.removeEngine('my-engine')
      expect(next.engines.some((engine) => engine.id === 'my-engine')).toBe(false)
    })

    it('卸载模型只删除清单声明的文件，并跳过其他模型共用的文件', async () => {
      const root = mkdtempSync(join(tmpdir(), 'morrow-models-'))
      mediaState.settings.mediaEngine.comfyuiDir = join(root, 'ComfyUI')
      const modelFile = join(mediaState.settings.mediaEngine.comfyuiDir, 'models', 'diffusion_models', 'model.safetensors')
      mkdirSync(dirname(modelFile), { recursive: true })
      writeFileSync(modelFile, 'weights')
      try {
        const catalog = new MediaCatalog()
        await catalog.registerModel({ ...baseModel, id: 'owned', install: { type: 'files', files: [{ dest: 'diffusion_models/model.safetensors' }] } })
        await catalog.registerModel({ ...baseModel, id: 'shared', install: { type: 'files', files: [{ dest: 'diffusion_models/model.safetensors' }] } })
        await catalog.uninstallModel('shared')
        expect(existsSync(modelFile)).toBe(true)
        await catalog.removeModel('shared')
        await catalog.uninstallModel('owned')
        expect(existsSync(modelFile)).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('模型清单必须声明已知引擎与能力', async () => {
      const catalog = new MediaCatalog()
      await expect(catalog.registerModel({ ...baseModel, id: 'bad-engine', engine: 'nope' })).rejects.toThrow('未知引擎')
      await expect(catalog.registerModel({ ...baseModel, id: 'no-caps', capabilities: [] })).rejects.toThrow('能力')
    })
  })

  it('按清单下载模型：进度、大小与 SHA-256 校验，卸载只删声明文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'morrow-download-'))
    mediaState.settings.mediaEngine.comfyuiDir = join(root, 'ComfyUI')
    const payload = Buffer.from('morrow-media-model-fixture')
    const sha256 = createHash('sha256').update(payload).digest('hex')
    const server = createServer((request, response) => {
      if (request.url !== '/model.bin') {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length })
      response.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const catalog = new MediaCatalog()
      await catalog.registerModel({
        ...baseModel,
        id: 'download-fixture',
        install: {
          type: 'files',
          files: [{ url: `http://127.0.0.1:${port}/model.bin`, dest: 'diffusion_models/model.bin', bytes: payload.length, sha256 }]
        }
      })
      const progress: number[] = []
      await catalog.installModel('download-fixture', (update) => {
        if (typeof update.percent === 'number') progress.push(update.percent)
      }, new AbortController().signal)
      const downloaded = join(mediaState.settings.mediaEngine.comfyuiDir, 'models', 'diffusion_models', 'model.bin')
      expect(readFileSync(downloaded)).toEqual(payload)
      expect(progress.at(-1)).toBe(100)
      await catalog.uninstallModel('download-fixture')
      expect(existsSync(downloaded)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  const engineEnabled = process.env.MORROW_ENGINE_INTEGRATION === '1'

  describe.skipIf(!engineEnabled)('真实 llama.cpp 生命周期', () => {
    it('通过目录启动、健康检查并停止 llama-server', async () => {
      const catalog = new MediaCatalog()
      try {
        const started = await catalog.startEngine('llamacpp')
        expect(started.engines.find((engine) => engine.id === 'llamacpp')?.running).toBe(true)
        const health = await fetch('http://127.0.0.1:8000/health')
        expect(health.ok).toBe(true)
        const stopped = await catalog.stopEngine('llamacpp')
        expect(stopped.engines.find((engine) => engine.id === 'llamacpp')?.running).toBe(false)
      } finally {
        try {
          await catalog.stopEngine('llamacpp')
        } catch {
          // 已经停止或不是本轮启动
        }
      }
    }, 300_000)
  })

  describe('ComfyUI 目录探测', () => {
    it('从环境变量/常见位置识别 main.py，并优先使用有效配置', () => {
      const dir = mkdtempSync(join(tmpdir(), 'morrow-comfy-locate-'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'main.py'), '# main', 'utf8')
      const previous = process.env.MORROW_COMFYUI_DIR
      try {
        process.env.MORROW_COMFYUI_DIR = dir
        expect(locateComfyui({ comfyuiDir: null })).toBe(resolve(dir))
        expect(locateComfyui({ comfyuiDir: dir })).toBe(resolve(dir))
        expect(locateComfyui({ comfyuiDir: join(dir, 'missing') })).toBe(resolve(join(dir, 'missing')))
      } finally {
        if (previous === undefined) delete process.env.MORROW_COMFYUI_DIR
        else process.env.MORROW_COMFYUI_DIR = previous
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

describe('media-service.integration.test.ts', () => {
  const enabled = process.env.MORROW_MEDIA_INTEGRATION === '1'

  beforeEach(() => {
    resetMediaState()
  })

  afterEach(() => {
    resetMediaState()
  })

  describe.skipIf(!enabled)('本地多媒体引擎（真实集成）', () => {
    it(
      '状态 → 文生图 → 图像编辑 → 参考图生视频 → 剪辑/提取音频',
      async () => {
        mediaState.dataDir = mkdtempSync(join(tmpdir(), 'morrow-media-data-'))
        const workspace = mkdtempSync(join(tmpdir(), 'morrow-media-ws-'))
        const settings = defaultSettings()
        settings.mediaEngine = {
          enabled: true,
          comfyuiUrl: process.env.MORROW_COMFYUI_URL ?? 'http://127.0.0.1:8188',
          comfyuiDir: process.env.MORROW_COMFYUI_DIR ?? 'C:/AI/MorrowMedia/ComfyUI',
          ffmpegPath: null,
          autoStart: false,
          imageTimeoutSec: 600,
          videoTimeoutSec: 3600,
          outputDir: 'media'
        }
        const service = new MediaService(() => settings)
        try {
          const status = await service.status()
          expect(status.engine.online).toBe(true)
          expect(status.models.find((model) => model.id === 'image')?.ready).toBe(true)
          expect(status.models.find((model) => model.id === 'video')?.ready).toBe(true)
          expect(status.nodes).toEqual({ gguf: true, minimaxH3: true })
          expect(status.ffmpeg.available).toBe(true)

          const progress: number[] = []
          const image = await service.generateImage({
            workspace,
            prompt: 'Cinematic close-up of a red fox in a snowy pine forest at dawn, soft rim light, detailed fur, shallow depth of field',
            width: 960,
            height: 544,
            seed: 20261024,
            signal: new AbortController().signal,
            onProgress: (update) => {
              if (typeof update.percent === 'number') progress.push(update.percent)
            }
          })
          expect(existsSync(image.path)).toBe(true)
          expect(statSync(image.path).size).toBeGreaterThan(10_000)
          expect(image.path.startsWith(workspace)).toBe(true)
          expect(image.width).toBe(960)
          expect(image.height).toBe(544)
          expect(image.thumbnailDataUrl).toMatch(/^data:image\/jpeg;base64,/)
          expect(progress.length).toBeGreaterThan(0)

          const edited = await service.generateImage({
            workspace,
            prompt: '只给 <image1> 里的狐狸加一顶蓝色针织帽，保持它的脸、红色围巾、雪林背景、构图和光线不变，其他什么都不要改。',
            referencePath: image.path,
            width: 960,
            height: 544,
            seed: 7,
            signal: new AbortController().signal,
            onProgress: () => undefined
          })
          expect(existsSync(edited.path)).toBe(true)
          expect(edited.path).not.toBe(image.path)
          expect(edited.bytes).toBeGreaterThan(10_000)
          // 参考图必须真正进入编辑节点：输出保持原图尺寸，而不是退化成 resolution 方形
          expect(edited.width).toBe(960)
          expect(edited.height).toBe(544)

          const videoProgress: number[] = []
          const video = await service.generateVideo({
            workspace,
            prompt:
              '<Picture 1> 是主体与外观参考。狐狸轻轻眨眼、耳朵转动，镜头缓慢推近；雪粒飘落，晨光从左侧掠过毛发；环境声是轻微的风声和远处的鸟鸣。',
            referencePaths: [image.path],
            width: 960,
            height: 544,
            seconds: 5,
            seed: 20261024,
            signal: new AbortController().signal,
            onProgress: (update) => {
              if (typeof update.percent === 'number') videoProgress.push(update.percent)
            }
          })
          expect(existsSync(video.path)).toBe(true)
          expect(video.path.startsWith(workspace)).toBe(true)
          expect(video.mediaKind).toBe('video')
          expect(video.durationSec).toBeGreaterThan(4.5)
          expect(video.durationSec).toBeLessThan(6.5)
          expect(video.width).toBe(960)
          expect(video.height).toBe(544)
          expect(videoProgress.length).toBeGreaterThan(3)

          const trim = await service.editMedia({
            workspace,
            inputPath: video.path,
            operation: 'trim',
            startSeconds: 0.5,
            endSeconds: 2.5,
            signal: new AbortController().signal,
            onProgress: () => undefined
          })
          expect(existsSync(trim.path)).toBe(true)
          expect(trim.mediaKind).toBe('video')
          expect(trim.durationSec).toBeGreaterThan(1.5)
          expect(trim.durationSec).toBeLessThan(3)

          const audio = await service.editMedia({
            workspace,
            inputPath: video.path,
            operation: 'extract_audio',
            format: 'mp3',
            signal: new AbortController().signal,
            onProgress: () => undefined
          })
          expect(existsSync(audio.path)).toBe(true)
          expect(audio.mediaKind).toBe('audio')
          expect(audio.durationSec).toBeGreaterThan(4.5)

          const resized = await service.editMedia({
            workspace,
            inputPath: image.path,
            operation: 'resize',
            width: 480,
            signal: new AbortController().signal,
            onProgress: () => undefined
          })
          expect(existsSync(resized.path)).toBe(true)
          expect(resized.mediaKind).toBe('image')
          expect(resized.width).toBe(480)
          expect(resized.height).toBe(272)

          const outside = join(tmpdir(), 'morrow-outside.mp4')
          await expect(
            service.editMedia({
              workspace,
              inputPath: video.path,
              outputPath: outside,
              operation: 'trim',
              signal: new AbortController().signal,
              onProgress: () => undefined
            })
          ).rejects.toThrow(/工作区/)

          const probe = await service.probeMedia({ workspace, path: video.path })
          expect(probe.kind).toBe('video')
          expect(probe.hasAudio).toBe(true)
          expect(probe.fps).toBeCloseTo(24, 0)
        } finally {
          rmSync(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
          rmSync(mediaState.dataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
        }
      },
      900_000
    )
  })
})

describe('media-settings.test.ts', () => {
  beforeEach(() => {
    resetMediaState()
  })

  afterEach(() => {
    resetMediaState()
  })

  it('保存本机引擎配置，并把非法值收敛到安全范围', () => {
    mediaState.dataDir = mkdtempSync(join(tmpdir(), 'morrow-media-settings-'))
    try {
      const store = new SettingsStore()
      const next = store.update({
        mediaEngine: {
          enabled: false,
          comfyuiUrl: 'http://127.0.0.1:8188',
          comfyuiDir: 'C:\\AI\\ComfyUI',
          ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
          autoStart: false,
          imageTimeoutSec: 99_999,
          videoTimeoutSec: 10,
          outputDir: '../escape'
        }
      })
      expect(next.mediaEngine).toMatchObject({
        enabled: false,
        comfyuiUrl: 'http://127.0.0.1:8188',
        comfyuiDir: 'C:\\AI\\ComfyUI',
        ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
        autoStart: false,
        imageTimeoutSec: 3_600,
        videoTimeoutSec: 120,
        outputDir: 'media'
      })
      expect(store.get().mediaEngine.enabled).toBe(false)
    } finally {
      rmSync(mediaState.dataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    }
  })

  it('拒绝 file:// 等非 HTTP 引擎地址，保留原值', () => {
    mediaState.dataDir = mkdtempSync(join(tmpdir(), 'morrow-media-settings-'))
    try {
      const store = new SettingsStore()
      const before = store.get().mediaEngine.comfyuiUrl
      const next = store.update({
        mediaEngine: {
          ...store.get().mediaEngine,
          comfyuiUrl: 'file:///C:/ComfyUI'
        }
      })
      expect(next.mediaEngine.comfyuiUrl).toBe(before)
    } finally {
      rmSync(mediaState.dataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    }
  })
})

describe('media-describe-routing.test.ts', () => {
  beforeEach(() => {
    resetMediaState()
  })

  afterEach(() => {
    resetMediaState()
  })

  it('当前对话模型声明视觉能力时优先用它审看，而不是直接调用本机视觉模型', async () => {
    const service = new MediaService()
    const workspace = mkdtempSync(join(tmpdir(), 'morrow-media-vision-'))
    const image = join(workspace, 'sample.png')
    writeFileSync(image, Buffer.alloc(16))
    vi.spyOn(service as unknown as { readSettings: () => ReturnType<typeof defaultSettings> }, 'readSettings').mockReturnValue(defaultSettings())
    vi.spyOn(service as unknown as { probeFile: () => Promise<unknown> }, 'probeFile').mockResolvedValue({ kind: 'image', bytes: 16 })
    vi.spyOn(service as unknown as { visionFrames: () => Promise<unknown> }, 'visionFrames').mockResolvedValue([
      { mediaType: 'image/png', dataBase64: 'AA==', name: 'sample.png' }
    ])
    const stream = vi.fn(async function* (): AsyncGenerator<{ type: string; text?: string }> {
      yield { type: 'text_delta', text: '看到一只赤狐，构图稳定。' }
    })
    try {
      const result = await service.describeMedia({
        workspace,
        path: image,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        visionProvider: {
          provider: { stream } as never,
          model: {
            id: 'deepseek-flash',
            label: 'DeepSeek V4.1 Flash',
            contextWindow: 1_048_576,
            supportsTools: true,
            supportsVision: true
          }
        }
      })
      expect(result).toMatchObject({ model: 'DeepSeek V4.1 Flash', text: '看到一只赤狐，构图稳定。' })
      expect(result.fallback).toBeUndefined()
      expect(stream).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    }
  })
})
