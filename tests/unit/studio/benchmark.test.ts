import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StudioStore, nowMs, studioId } from '../../../src/main/studio/store'
import { buildTimelineFromProject } from '../../../src/main/studio/timeline'
import { makeDramaProject } from './fixtures'
import type { StudioAsset, StudioChapter, StudioShot } from '../../../src/shared/studio'

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

describe('创作台容量基准', () => {
  let store: StudioStore
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'morrow-studio-bench-'))
    store = new StudioStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('100 章 / 300 素材的保存与读取在预算内', () => {
    const project = store.newProject({ kind: 'novel', title: '百章基准', logline: '雨夜修伞。' })
    const paragraph = '雨沿着伞骨落下来，她把灯移到窗边，听见楼下有人走过。'
    project.chapters = Array.from({ length: 100 }, (_, index): StudioChapter => ({
      id: studioId('ch'),
      volumeId: null,
      number: index + 1,
      title: `第 ${index + 1} 章 · 雨`,
      synopsis: `第 ${index + 1} 章梗概`,
      beats: ['雨夜', '修伞'],
      content: `${paragraph}\n\n${paragraph}\n\n第 ${index + 1} 次敲门声。`,
      wordTarget: 2500,
      status: 'done',
      revision: 1,
      candidates: [],
      versions: [],
      illustrations: [],
      locked: true,
      updatedAt: nowMs()
    }))
    project.assets = Array.from({ length: 300 }, (_, index): StudioAsset => ({
      id: studioId('asset'),
      kind: 'image',
      mime: 'image/png',
      bytes: 1024 + index,
      sha256: `sha-${index}`,
      path: `assets/bench-${index}.png`,
      title: `素材 ${index}`,
      tags: ['bench'],
      createdAt: nowMs()
    }))
    const startedSave = performance.now()
    store.save(project, '容量基准保存', { snapshot: false })
    const saveMs = performance.now() - startedSave
    const startedRead = performance.now()
    const read = store.readProject(project.id)
    const readMs = performance.now() - startedRead
    console.log(`[benchmark] 100 章 + 300 素材：save ${saveMs.toFixed(0)}ms，read ${readMs.toFixed(0)}ms`)
    expect(read.chapters).toHaveLength(100)
    expect(read.assets).toHaveLength(300)
    expect(read.chapters[99].content).toContain('第 100 次敲门声')
    expect(saveMs).toBeLessThan(5_000)
    expect(readMs).toBeLessThan(5_000)
  })

  it('100 镜装配时间线在预算内', () => {
    const project = makeDramaProject(store)
    const base = project.shots[0]
    project.shots = Array.from({ length: 100 }, (_, index): StudioShot => ({
      ...base,
      id: studioId('shot'),
      number: index + 1,
      title: `基准镜 ${index + 1}`,
      durationSec: 3,
      dialogue: index % 3 === 0 ? `角色：第 ${index + 1} 句台词。` : '',
      voiceAssetId: index % 3 === 0 ? base.voiceAssetId : null,
      imageAssetId: index % 2 === 0 ? base.imageAssetId : null,
      updatedAt: nowMs()
    }))
    const started = performance.now()
    const timeline = buildTimelineFromProject(project)
    const elapsed = performance.now() - started
    console.log(`[benchmark] 100 镜装配：${elapsed.toFixed(0)}ms，${timeline.clips.length} 个片段`)
    expect(timeline.clips.length).toBeGreaterThan(100)
    expect(timeline.durationSec).toBeGreaterThan(290)
    expect(elapsed).toBeLessThan(2_000)
  })
})
