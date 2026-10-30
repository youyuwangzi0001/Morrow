/**
 * 合并后的 media 组：通用模型目录、本地多媒体引擎真实集成（默认跳过）、多媒体设置。
 * 每个原文件整体包在 describe('<原文件名>') 中；hooks/常量随原文件进入 wrapper。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

vi.mock('../../src/main/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/settings')>()
  return {
    ...actual,
    // 目录用例只读取当前设置；设置用例仍使用真实 SettingsStore 类。
    getSettingsStore: (() => ({ get: () => mediaState.settings })) as unknown as typeof actual.getSettingsStore
  }
})

vi.mock('../../src/main/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/media')>()
  return {
    ...actual,
    // 目录用例只需要引擎启停替身；集成用例直接 new MediaService，走真实实现。
    getMediaService: (() => ({
      startEngine: async () => undefined,
      stopEngine: async () => undefined
    })) as unknown as typeof actual.getMediaService
  }
})

import { defaultSettings } from '../../src/shared/contracts'
import { MediaCatalog } from '../../src/main/media'
import { MediaService } from '../../src/main/media'
import { withVisualMusicOnlyRule } from '../../src/main/media'
import { SettingsStore } from '../../src/main/settings'

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

    it('@core:media 拒绝越界文件路径与非 http(s) 下载地址', async () => {
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
  })

  it('@core:media 按清单下载模型：进度、大小与 SHA-256 校验，卸载只删声明文件', async () => {
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
})

describe('media-settings.test.ts', () => {
  beforeEach(() => {
    resetMediaState()
  })

  afterEach(() => {
    resetMediaState()
  })

  it('@core:media 保存本机引擎配置，并把非法值收敛到安全范围', () => {
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
})

describe('media-describe-routing.test.ts', () => {
  beforeEach(() => {
    resetMediaState()
  })

  afterEach(() => {
    resetMediaState()
  })

  it('@core:media 当前对话模型声明视觉能力时优先用它审看，而不是直接调用本机视觉模型', async () => {
    const service = new MediaService()
    const workspace = mkdtempSync(join(tmpdir(), 'morrow-media-vision-'))
    const image = join(workspace, 'sample.png')
    writeFileSync(image, Buffer.alloc(16))
    vi.spyOn(service as unknown as { readSettings: () => ReturnType<typeof defaultSettings> }, 'readSettings').mockReturnValue(defaultSettings())
    vi.spyOn(service as unknown as { probeFile: () => Promise<unknown> }, 'probeFile').mockResolvedValue({ kind: 'image', bytes: 16 })
    vi.spyOn(service as unknown as { visionFrames: () => Promise<unknown> }, 'visionFrames').mockResolvedValue([
      { mediaType: 'image/png', dataBase64: 'AA==', name: 'sample.png' }
    ])
    let request: Record<string, unknown> | undefined
    const stream = vi.fn(async function* (req: Record<string, unknown>): AsyncGenerator<{ type: string; text?: string }> {
      request = req
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
            supportsVision: true,
            supportsReasoning: true,
            reasoningStyle: 'effort',
            reasoningEfforts: ['off', 'low', 'high', 'max']
          }
        }
      })
      expect(result).toMatchObject({ model: 'DeepSeek V4.1 Flash', text: '看到一只赤狐，构图稳定。' })
      expect(result.fallback).toBeUndefined()
      expect(stream).toHaveBeenCalledTimes(1)
      expect(request?.maxTokens).toBe(2_048)
      expect(request?.reasoning).toEqual({ effort: 'off', style: 'effort' })
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    }
  })

  it('@core:media 当前模型无视觉能力且本地没有视觉模型时，返回真实失败而不是随便挑一个本地文本模型', async () => {
    const service = new MediaService()
    const workspace = mkdtempSync(join(tmpdir(), 'morrow-media-vision-fallback-'))
    const image = join(workspace, 'sample.png')
    writeFileSync(image, Buffer.alloc(16))
    const settings = defaultSettings()
    settings.providers = settings.providers.map((provider) =>
      provider.id === 'llamacpp'
        ? { ...provider, models: [{ id: 'text-only', label: '文本模型', contextWindow: 32_768, supportsTools: true }] }
        : provider
    )
    vi.spyOn(service as unknown as { readSettings: () => ReturnType<typeof defaultSettings> }, 'readSettings').mockReturnValue(settings)
    vi.spyOn(service as unknown as { probeFile: () => Promise<unknown> }, 'probeFile').mockResolvedValue({ kind: 'image', bytes: 16 })
    vi.spyOn(service as unknown as { visionFrames: () => Promise<unknown> }, 'visionFrames').mockResolvedValue([
      { mediaType: 'image/png', dataBase64: 'AA==', name: 'sample.png' }
    ])
    try {
      await expect(
        service.describeMedia({
          workspace,
          path: image,
          signal: new AbortController().signal,
          onProgress: () => undefined
        })
      ).rejects.toThrow('没有可用的本地视觉模型')
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    }
  })
})

describe('video-sound-rule.test.ts', () => {
  it('@core:media 视频模型只出画面与纯器乐配乐，明确压制配音与字幕', () => {
    const prompt = withVisualMusicOnlyRule('雨夜老街，女孩撑伞走过。')
    expect(prompt).toContain('雨夜老街')
    expect(prompt).toContain('纯器乐')
    expect(prompt).toContain('不要生成人物配音')
    expect(prompt).toContain('字幕')
    expect(prompt).toContain('无歌词')
    expect(withVisualMusicOnlyRule(prompt)).toBe(prompt)
  })
})
