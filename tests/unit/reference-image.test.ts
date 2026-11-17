import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { coverFilter, needsNormalization, normalizeTargetSize, resolveBatchSize, snapToMultiple } from '../../src/shared/reference-image'
import { MediaService } from '../../src/main/media'

const settingsState = vi.hoisted(() => ({
  settings: {
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
    providers: []
  }
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: (name: string) => join(process.env.TEMP ?? 'C:/Windows/Temp', name)
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

vi.mock('../../src/main/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/settings')>()
  return { ...actual, getSettingsStore: (() => ({ get: () => settingsState.settings })) as unknown as typeof actual.getSettingsStore }
})

function makeImage(file: string, width: number, height: number): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const result = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:duration=1:rate=1`, '-frames:v', '1', file], { windowsHide: true })
  expect(result.status, `生成 ${width}×${height} 测试图失败：${result.stderr}`).toBe(0)
}

function dimensionsOf(file: string): { width: number; height: number } {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true })
  const [width, height] = result.stdout.trim().split(',').map(Number)
  return { width, height }
}

describe('C-02 参考图归一化', () => {
  let dir = ''

  beforeEach(() => {
    dir = join(process.env.TEMP ?? 'C:/Windows/Temp', `morrow-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('@core:studio-media 参考图归一化：目标尺寸 32 对齐、异常尺寸被统一、已合格图零处理、cover 不拉伸', async () => {
    // 纯逻辑：目标尺寸 32 对齐 + 是否需要归一化
    expect(snapToMultiple(768)).toBe(768)
    expect(snapToMultiple(770)).toBe(768)
    expect(snapToMultiple(0)).toBe(32)
    expect(snapToMultiple(Number.NaN)).toBe(32)
    expect(normalizeTargetSize(770, 1350)).toEqual({ width: 768, height: 1344 })
    // 请求 768×1344 时，一批里混进 1152×2048 也必须按 768×1344 归一，绝不放大整批。
    const target = resolveBatchSize({ requestWidth: 768, requestHeight: 1344 })
    expect(target).toEqual({ width: 768, height: 1344 })
    expect(needsNormalization({ width: 1152, height: 2048 }, target)).toBe(true)
    expect(needsNormalization({ width: 768, height: 1024 }, target)).toBe(true)
    expect(needsNormalization({ width: 768, height: 1344 }, target)).toBe(false)
    expect(needsNormalization(null, target)).toBe(true)
    // cover：等比铺满 + 居中裁切，不能直接拉扁。
    const filter = coverFilter(target)
    expect(filter).toContain('force_original_aspect_ratio=increase')
    expect(filter).toContain('crop=768:1344')
    expect(filter).not.toContain('setsar')
  })

  it('@core:studio-media 参考图归一化执行：混入 1152×2048 时被统一为同尺寸，已合格图与单图不重复处理', async () => {
    const service = new MediaService()
    const normal = join(dir, 'normal-768x1344.png')
    const oversized = join(dir, 'oversized-1152x2048.png')
    makeImage(normal, 768, 1344)
    makeImage(oversized, 1152, 2048)
    expect(dimensionsOf(normal)).toEqual({ width: 768, height: 1344 })
    expect(dimensionsOf(oversized)).toEqual({ width: 1152, height: 2048 })

    // 单张已合格：不复制、不重编码，原样返回同一个路径。
    const single = await service.normalizeReferenceImages({
      settings: settingsState.settings.mediaEngine,
      paths: [normal],
      width: 768,
      height: 1344,
      workDir: join(dir, 'work-single')
    })
    expect(single.normalized).toBe(0)
    expect(single.paths).toEqual([normal])
    expect(single.target).toEqual({ width: 768, height: 1344 })

    // 混入异常尺寸：两张都必须变成 768×1344，且额外只处理那一张。
    const mixed = await service.normalizeReferenceImages({
      settings: settingsState.settings.mediaEngine,
      paths: [normal, oversized],
      width: 768,
      height: 1344,
      workDir: join(dir, 'work-mixed')
    })
    expect(mixed.normalized).toBe(1)
    expect(mixed.paths).toHaveLength(2)
    expect(mixed.paths[0]).toBe(normal)
    expect(mixed.paths[1]).not.toBe(oversized)
    expect(existsSync(mixed.paths[1])).toBe(true)
    expect(dimensionsOf(mixed.paths[1])).toEqual({ width: 768, height: 1344 })
    // 原文件不能被覆盖（归一化产物写到工作目录）。
    expect(statSync(oversized).size).toBeGreaterThan(0)
    expect(dimensionsOf(oversized)).toEqual({ width: 1152, height: 2048 })
  }, 120_000)
})