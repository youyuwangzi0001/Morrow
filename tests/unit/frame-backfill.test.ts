import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { StudioStore, buildTimelineFromProject } from '../../src/main/studio'
import { tempStore, makeDramaProject } from './studio-fixtures'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.TEMP ?? 'C:/Windows/Temp',
    getVersion: () => '0.2.0',
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => Buffer.from(value).toString('utf8')
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

const REAL_CLIP = join(process.cwd(), 'tests', 'fixtures', 'studio-demo', 'short', 'short-90f.mp4')

describe('C-01 存量素材补齐实测帧数', () => {
  let store: StudioStore
  let dir = ''

  beforeEach(() => {
    const created = tempStore()
    store = created.store
    dir = created.dir
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('@core:studio-timeline 老项目的视频缺帧数时补测写入，已有值不被覆盖', () => {
    expect(existsSync(REAL_CLIP), `缺少测试样本 ${REAL_CLIP}`).toBe(true)
    const project = makeDramaProject(store)
    // 模拟旧版本数据：素材入库时只记时长，没有 frames/fps。
    const legacy = store.addAsset(project, {
      bytes: Buffer.from('legacy-placeholder'),
      title: '老项目视频',
      mime: 'video/mp4',
      kindHint: 'video',
      metadata: { width: 768, height: 1344, durationSec: 3.75 }
    })
    const absolute = store.assetAbsolute(project, legacy)
    copyFileSync(REAL_CLIP, absolute)
    expect(legacy.frames).toBeUndefined()

    const filled = store.backfillFrameData(project)
    expect(filled).toBe(1)
    expect(legacy.frames).toBe(90)
    expect(legacy.fps).toBe(24)
    expect(legacy.durationSec).toBeCloseTo(3.75, 2)
    // 补齐后应能参与帧数契约：余下多次调用不再重复计数。
    expect(store.backfillFrameData(project)).toBe(0)

    // 已有实测值的素材不会被改写。
    legacy.frames = 999
    store.backfillFrameData(project)
    expect(legacy.frames).toBe(999)

    // 补齐后的实测值直接进入时间线：计划 8s 的一镜按 3.75s 排。
    legacy.frames = 90
    project.shots[0].durationSec = 8
    project.shots[0].videoAssetId = legacy.id
    const timeline = buildTimelineFromProject(project)
    expect(timeline.clips.find((clip) => clip.kind === 'video' && clip.shotId === project.shots[0].id)?.duration).toBeCloseTo(3.75, 2)
    expect(statSync(absolute).isFile()).toBe(true)
  })

  it('@core:studio-timeline 文件缺失时补齐不报错，也不写入假数据', () => {
    const project = makeDramaProject(store)
    const ghost = store.addAsset(project, {
      bytes: Buffer.from('ghost-video'),
      title: '缺文件视频',
      mime: 'video/mp4',
      kindHint: 'video'
    })
    rmSync(store.assetAbsolute(project, ghost), { force: true })
    expect(store.backfillFrameData(project)).toBe(0)
    expect(ghost.frames).toBeUndefined()
  })
})