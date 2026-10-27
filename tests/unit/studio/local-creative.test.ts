import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { StudioStore } from '../../../src/main/studio/store'
import { tempStore } from './fixtures'
import {
  applyBlueprintToProject,
  localBlueprint,
  localChapterDraft,
  localRewrite,
  readSeeds
} from '../../../src/main/studio/local-creative'
import { countWords } from '../../../src/shared/studio'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP ?? 'C:/Windows/Temp', getVersion: () => '0.2.0', isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => Buffer.from(v).toString() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

describe('本地创作引擎', () => {
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

  it('从一句话读出人物、地点、物件与主题', () => {
    const seeds = readSeeds('一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。', '逆行的伞')
    expect(seeds.protagonist.length).toBeGreaterThan(0)
    expect(seeds.place.length).toBeGreaterThan(0)
    expect(seeds.object).toBe('伞')
    expect(seeds.power).toContain('时间')
    expect(seeds.title).toBe('逆行的伞')
    expect(seeds.female).toBe(true)
  })

  it('短篇蓝图固定至少 12 章，并给出真实估算与警告', () => {
    const project = store.newProject({ kind: 'short', title: '测试短篇', logline: '一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。', brief: { targetWords: 18000 } })
    const blueprint = localBlueprint(project, { imagesReady: false, textConfigured: false })
    expect(blueprint.units.length).toBeGreaterThanOrEqual(12)
    expect(blueprint.units.every((unit) => unit.wordTarget && unit.wordTarget >= 1200)).toBe(true)
    expect(blueprint.estimate.costMin).toBe(0)
    expect(blueprint.warnings.some((warning) => warning.includes('文本模型'))).toBe(true)
    expect(blueprint.warnings.some((warning) => warning.includes('画面引擎'))).toBe(true)
    expect(blueprint.source).toBe('local')
  })

  it('漫剧蓝图落地为场景、镜头与总时长', () => {
    const project = store.newProject({
      kind: 'drama',
      title: '测试漫剧',
      logline: '一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。',
      brief: { targetSeconds: 96, aspect: '16:9' }
    })
    const blueprint = { ...localBlueprint(project, { imagesReady: true, textConfigured: false }), approved: true, approvedAt: Date.now() }
    applyBlueprintToProject(project, blueprint)
    expect(project.shots.length).toBe(12)
    expect(project.scenes.length).toBe(3)
    expect(project.episodes.length).toBe(1)
    expect(project.shots.reduce((sum, shot) => sum + shot.durationSec, 0)).toBeGreaterThanOrEqual(90)
    expect(project.shots.every((shot) => shot.prompt.length > 20)).toBe(true)
  })

  it('长篇蓝图落地为卷与章节', () => {
    const project = store.newProject({
      kind: 'novel',
      title: '测试长篇',
      logline: '一个修伞的女孩继承外婆的伞铺，每周三都会有一个失忆的少年，来修同一把黑伞。',
      brief: { targetWords: 120000 }
    })
    const blueprint = { ...localBlueprint(project, { imagesReady: false, textConfigured: false }), approved: true, approvedAt: Date.now() }
    applyBlueprintToProject(project, blueprint)
    expect(project.chapters.length).toBeGreaterThanOrEqual(36)
    expect(project.volumes.length).toBe(3)
    expect(project.facts.length).toBeGreaterThan(0)
  })

  it('本地章节初稿没有未替换占位符，且可再改写', () => {
    const project = store.newProject({ kind: 'short', title: '测试短篇', logline: '一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。' })
    const chapter = store.addChapter(project, { title: '第一把伞', synopsis: '林晚捡到伞', wordTarget: 1600 })
    const draft = localChapterDraft(project, chapter)
    expect(draft.length).toBeGreaterThan(300)
    expect(draft).not.toContain('{seeds')
    expect(draft).not.toContain('{object}')
    expect(countWords(draft)).toBeGreaterThan(300)
    const rewritten = localRewrite(draft, '更克制一点，删掉解释')
    expect(rewritten).not.toBe(draft)
    expect(rewritten.length).toBeGreaterThan(100)
  })
})
