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
import { minimaxVideoParams } from '../../src/main/media-cloud'
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

  it('@core:media 模型选择要能真正存下来，否则保存后又会退回内置预设', () => {
    mediaState.dataDir = mkdtempSync(join(tmpdir(), 'morrow-media-models-'))
    try {
      const store = new SettingsStore()
      const next = store.update({
        mediaEngine: {
          ...store.get().mediaEngine,
          imageModelId: 'my-sdxl',
          videoModelId: 'my-wan',
          musicModelId: 'my-music'
        }
      })
      expect(next.mediaEngine).toMatchObject({
        imageModelId: 'my-sdxl',
        videoModelId: 'my-wan',
        musicModelId: 'my-music'
      })
      // 清空选择回到内置预设
      const cleared = store.update({
        mediaEngine: { ...store.get().mediaEngine, imageModelId: null, videoModelId: null, musicModelId: null }
      })
      expect(cleared.mediaEngine.imageModelId).toBeNull()
      expect(cleared.mediaEngine.videoModelId).toBeNull()
      expect(cleared.mediaEngine.musicModelId).toBeNull()
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

  it('@core:media 模型没有 off 档时，视觉审看用最低档而不是留空交给服务端默认档', async () => {
    const service = new MediaService()
    const workspace = mkdtempSync(join(tmpdir(), 'morrow-media-vision-ladder-'))
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
      yield { type: 'text_delta', text: '画面干净。' }
    })
    try {
      await service.describeMedia({
        workspace,
        path: image,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        visionProvider: {
          provider: { stream } as never,
          model: {
            id: 'deepseek-v4.1-flash-1017',
            label: 'deepseek-v4.1-flash-1017',
            contextWindow: 400_000,
            supportsTools: true,
            supportsVision: true,
            supportsReasoning: true,
            reasoningStyle: 'effort',
            reasoningEfforts: ['low', 'high', 'max']
          }
        }
      })
      expect(request?.reasoning).toEqual({ effort: 'low', style: 'effort' })
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    }
  })

  it('@core:media 只返回思考时用更大预算重试，而不是直接判失败', async () => {
    const service = new MediaService()
    const workspace = mkdtempSync(join(tmpdir(), 'morrow-media-vision-retry-'))
    const image = join(workspace, 'sample.png')
    writeFileSync(image, Buffer.alloc(16))
    vi.spyOn(service as unknown as { readSettings: () => ReturnType<typeof defaultSettings> }, 'readSettings').mockReturnValue(defaultSettings())
    vi.spyOn(service as unknown as { probeFile: () => Promise<unknown> }, 'probeFile').mockResolvedValue({ kind: 'image', bytes: 16 })
    vi.spyOn(service as unknown as { visionFrames: () => Promise<unknown> }, 'visionFrames').mockResolvedValue([
      { mediaType: 'image/png', dataBase64: 'AA==', name: 'sample.png' }
    ])
    const budgets: Array<number | undefined> = []
    const stream = vi.fn(async function* (req: Record<string, unknown>): AsyncGenerator<{ type: string; text?: string }> {
      budgets.push(req.maxTokens as number | undefined)
      if (budgets.length === 1) {
        yield { type: 'thinking_delta', text: '先想一下构图……' }
        return
      }
      yield { type: 'text_delta', text: '第二张没有手，合格。' }
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
            id: 'deepseek-v4.1-flash-1017',
            label: 'deepseek-v4.1-flash-1017',
            contextWindow: 400_000,
            supportsTools: true,
            supportsVision: true,
            supportsReasoning: true,
            reasoningStyle: 'effort',
            reasoningEfforts: ['low', 'high', 'max']
          }
        }
      })
      expect(result.text).toBe('第二张没有手，合格。')
      expect(budgets.length).toBe(2)
      expect(budgets[1]).toBeGreaterThan(budgets[0] ?? 0)
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    }
  })

  it('@core:media 重试后仍只有思考时，报错说明是思考占满预算而不是含糊的空返回', async () => {
    const service = new MediaService()
    const workspace = mkdtempSync(join(tmpdir(), 'morrow-media-vision-thinking-'))
    const image = join(workspace, 'sample.png')
    writeFileSync(image, Buffer.alloc(16))
    vi.spyOn(service as unknown as { readSettings: () => ReturnType<typeof defaultSettings> }, 'readSettings').mockReturnValue(defaultSettings())
    vi.spyOn(service as unknown as { probeFile: () => Promise<unknown> }, 'probeFile').mockResolvedValue({ kind: 'image', bytes: 16 })
    vi.spyOn(service as unknown as { visionFrames: () => Promise<unknown> }, 'visionFrames').mockResolvedValue([
      { mediaType: 'image/png', dataBase64: 'AA==', name: 'sample.png' }
    ])
    const stream = vi.fn(async function* (): AsyncGenerator<{ type: string; text?: string }> {
      yield { type: 'thinking_delta', text: '反复思考……' }
    })
    try {
      await expect(
        service.describeMedia({
          workspace,
          path: image,
          signal: new AbortController().signal,
          onProgress: () => undefined,
          visionProvider: {
            provider: { stream } as never,
            model: {
              id: 'deepseek-v4.1-flash-1017',
              label: 'deepseek-v4.1-flash-1017',
              contextWindow: 400_000,
              supportsTools: true,
              supportsVision: true,
              supportsReasoning: true,
              reasoningStyle: 'effort',
              reasoningEfforts: ['low', 'high', 'max']
            }
          }
        })
      ).rejects.toThrow('思考')
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    }
  })

  it('@core:media 模型已声明视觉能力时，回退失败不再误报「没有被标记为支持图片输入」', async () => {
    const service = new MediaService()
    const workspace = mkdtempSync(join(tmpdir(), 'morrow-media-vision-msg-'))
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
    const stream = vi.fn(async function* (): AsyncGenerator<{ type: string; text?: string }> {
      yield { type: 'thinking_delta', text: '想了很久……' }
    })
    try {
      const err = await service
        .describeMedia({
          workspace,
          path: image,
          signal: new AbortController().signal,
          onProgress: () => undefined,
          visionProvider: {
            provider: { stream } as never,
            model: {
              id: 'deepseek-v4.1-flash-1017',
              label: 'deepseek-v4.1-flash-1017',
              contextWindow: 400_000,
              supportsTools: true,
              supportsVision: true,
              supportsReasoning: true,
              reasoningStyle: 'effort',
              reasoningEfforts: ['low', 'high', 'max']
            }
          }
        })
        .catch((error: Error) => error)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('只输出了思考')
      expect((err as Error).message).not.toContain('没有被标记为支持图片输入')
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

  it('@core:media 当前模型只是没被标成能看图时，报错指向模型能力而不是让用户去配本地视觉模型', async () => {
    const service = new MediaService()
    const workspace = mkdtempSync(join(tmpdir(), 'morrow-media-vision-unmarked-'))
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
          onProgress: () => undefined,
          visionProvider: {
            provider: { stream: async function* () {} } as never,
            model: { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', contextWindow: 128_000, supportsTools: true }
          }
        })
      ).rejects.toThrow('没有被标记为支持图片输入')
    } finally {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    }
  })
})

describe('media-custom-model.test.ts', () => {
  /**
   * 用户注册了自定义模型却用不上，是「换模型要改代码」的真正原因：
   * 清单里有 workflow，runWorkflow 也执行得了，但 generateImage/generateVideo
   * 过去从不查清单，永远走内置预设。
   */
  const workflow = {
    graph: { 3: { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } } },
    bindings: { prompt: { node: '3', input: 'text' }, seed: { node: '3', input: 'seed' } },
    outputNode: '9',
    outputKind: 'image'
  }

  function serviceWith(catalog: unknown): MediaService {
    const settings = mediaState.createSettings()
    const service = new MediaService(() => settings as never)
    ;(service as unknown as { catalog?: unknown }).catalog = catalog
    return service
  }

  it('@core:media 指定了带工作流的自定义图片模型时走它，而不是内置预设', async () => {
    const service = serviceWith({
      manifest: async (id: string) => ({
        id,
        label: 'My SDXL',
        engine: 'comfyui',
        kind: 'image',
        capabilities: ['text-to-image'],
        source: 'user',
        install: { type: 'files', files: [] },
        comfy: { workflow }
      })
    })
    const run = vi
      .spyOn(service as unknown as { runWorkflow: (input: unknown) => Promise<unknown> }, 'runWorkflow')
      .mockResolvedValue({ path: 'out.png', model: 'My SDXL', engine: 'ComfyUI', seed: 1 })
    const settings = service as unknown as { readSettings: () => { mediaEngine: Record<string, unknown> } }
    const original = settings.readSettings()
    ;(original.mediaEngine as Record<string, unknown>).imageModelId = 'my-sdxl'
    // 自定义工作流同样跑在 ComfyUI 上，这里只需绕过引擎在线检查（保留已设好的模型选择）
    vi.spyOn(service as unknown as { ensureReady: () => Promise<unknown> }, 'ensureReady').mockResolvedValue({
      settings: { ...(original.mediaEngine as Record<string, unknown>), comfyuiDir: null },
      lists: null
    })
    await service.generateImage({
      workspace: mkdtempSync(join(tmpdir(), 'morrow-custom-')),
      prompt: '雨夜',
      width: 1024,
      height: 1024,
      signal: new AbortController().signal,
      onProgress: () => undefined
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect((run.mock.calls[0]?.[0] as { modelLabel: string }).modelLabel).toBe('My SDXL')
  })

  it('@core:media 模型没有工作流或已卸载时回退内置预设，而不是直接失败', async () => {
    const service = serviceWith({
      manifest: async () => {
        throw new Error('模型不存在')
      }
    })
    const run = vi
      .spyOn(service as unknown as { runWorkflow: (input: unknown) => Promise<unknown> }, 'runWorkflow')
      .mockResolvedValue({})
    const settings = service as unknown as { readSettings: () => { mediaEngine: Record<string, unknown> } }
    ;(settings.readSettings().mediaEngine as Record<string, unknown>).imageModelId = 'gone-model'
    // 内置路径依赖 ComfyUI 在线，这里只断言「没有走自定义分支」
    await service.generateImage({
      workspace: mkdtempSync(join(tmpdir(), 'morrow-custom-')),
      prompt: '雨夜',
      width: 1024,
      height: 1024,
      signal: new AbortController().signal,
      onProgress: () => undefined
    }).catch(() => undefined)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('minimax-video-params.test.ts', () => {
  /**
   * 三个云端视频型号的分辨率与时长集合互不相同。过去统一写死 768P 并原样透传时长，
   * 换成 H3-Max 或 Hailuo 会被上游直接拒绝。
   */
  it('@core:media 按型号给出合法的分辨率与时长', () => {
    expect(minimaxVideoParams('MiniMax-H3', 4)).toEqual({ resolution: '768P', duration: 4 })
    expect(minimaxVideoParams('MiniMax-H3', 99)).toEqual({ resolution: '768P', duration: 15 })
    // H3-Max 起点是 5 秒，且不给 2K
    expect(minimaxVideoParams('MiniMax-H3-Max', 4)).toEqual({ resolution: '768P', duration: 5 })
    expect(minimaxVideoParams('MiniMax-H3-Max', 15)).toEqual({ resolution: '768P', duration: 15 })
    // Hailuo 只有 6 与 10 两档，就近吸附
    expect(minimaxVideoParams('MiniMax-Hailuo-2.3', 5)).toEqual({ resolution: '1080P', duration: 6 })
    expect(minimaxVideoParams('MiniMax-Hailuo-2.3', 9)).toEqual({ resolution: '1080P', duration: 10 })
    expect(minimaxVideoParams('MiniMax-Hailuo-2.3', 15)).toEqual({ resolution: '1080P', duration: 10 })
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
