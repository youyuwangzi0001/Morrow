/**
 * 创作台域：模型路由、编辑动作与作品存储。
 *
 * 三者共用同一份 electron 替身：路由决定用哪个模型、编辑决定改哪些字段、
 * 存储决定怎么落盘。放在一处才能确认「改了字段却没有落盘」这类断链。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo, ProviderConfig } from '../../src/shared/types'
import type { StudioStore } from '../../src/main/studio'
import { buildTimelineFromProject, currentTimelineVideo, ensureDemoProjects, rankTextCandidates, studioId } from '../../src/main/studio'
import {
  applyEditPlan,
  assistantMessage,
  assistantSources,
  createPlanFromDraft,
  draftEditPlan,
  sanitizeTimeline,
  StudioService,
  syncDramaOutline,
  toAss,
  toSrt
} from '../../src/main/studio'
import { assistantContextFor } from '../../src/shared/studio-assistant'
import { timelineDuration } from '../../src/shared/studio'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addShot, tempStore, TINY_PNG, makeDramaProject, makeNovelProject } from './studio-fixtures'

// ── 原 studio-routing.test.ts ──

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP ?? 'C:/Windows/Temp', getVersion: () => '0.2.0', isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

const model = (id: string): ModelInfo => ({ id, label: id, contextWindow: 128_000, supportsTools: true })
const provider = (id: string, baseUrl: string): ProviderConfig => ({
  id,
  kind: 'openai-compat',
  name: id,
  baseUrl,
  models: [model(`${id}-model`)],
  apiKeyStored: true,
  enabled: true
})

const providers = [
  provider('local', 'http://127.0.0.1:11434/v1'),
  provider('cloud', 'https://api.example.com/v1')
]
const defaultModel = { providerId: 'cloud', modelId: 'cloud-model' }

describe('文本路由', () => {

  it('@core:studio-models 只本地与只云端严格过滤', () => {
    expect(rankTextCandidates({ providers, defaultModel }, () => 'key', 'local-only').every((item) => item.local)).toBe(true)
    expect(rankTextCandidates({ providers, defaultModel }, () => 'key', 'cloud-only').every((item) => !item.local)).toBe(true)
  })

  it('@core:studio-models 缺 Key 的云端路由仍可见，但排在可用路由之后', () => {
    const ranked = rankTextCandidates(
      { providers, defaultModel },
      (providerId) => providerId === 'local' ? 'local-key' : null,
      'cloud-first'
    )
    expect(ranked[0].config.id).toBe('local')
    expect(ranked.find((item) => item.config.id === 'cloud')?.apiKey).toBeNull()
  })
})

// ── 原 studio-edit.test.ts ──

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP ?? 'C:/Windows/Temp', getVersion: () => '0.2.0', isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => Buffer.from(v).toString() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

describe('大白话改片', () => {
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

  it('@core:studio-assistant 把慢速、雨声音量与不改脸翻译成可预览动作', () => {
    const project = makeDramaProject(store)
    const draft = draftEditPlan(project, '镜 01 慢 20%，雨声压低一点，不要改脸。')
    expect(draft.actions.some((action) => action.type === 'set-clip-speed' && action.value === 0.8)).toBe(true)
    expect(draft.actions.some((action) => action.type === 'set-clip-volume')).toBe(true)
    expect(draft.actions.some((action) => action.type === 'lock-reference')).toBe(true)
    expect(draft.effects.join(' ')).toContain('音效')
    const plan = createPlanFromDraft(project.id, draft)
    const applied = applyEditPlan(project, plan)
    const video = project.timeline.clips.find((clip) => clip.kind === 'video' && clip.shotId === project.shots[0].id)
    expect(video?.speed).toBe(0.8)
    const rain = project.timeline.clips.find((clip) => clip.kind === 'sfx')
    expect(rain?.volume).toBeLessThan(0.55)
    expect(applied.timelineChanged).toBe(true)
    expect(plan.status).toBe('applied')
    expect(project.shots[0].lockedReference).toBe(true)
    expect(project.shots[0].continuity).toContain('保持角色面部')
  })

  it('@core:studio-assistant 字幕上移只改字幕片段样式', () => {
    const project = makeDramaProject(store)
    const subtitle = project.timeline.clips.find((clip) => clip.kind === 'subtitle')!
    const before = subtitle.style?.yPercent ?? 86
    const plan = createPlanFromDraft(project.id, draftEditPlan(project, '字幕往上挪一点', { selection: { kind: 'clip', id: subtitle.id } }))
    applyEditPlan(project, plan)
    const after = project.timeline.clips.find((clip) => clip.id === subtitle.id)
    expect(after?.style?.yPercent).toBeLessThan(before)
  })

  it('@core:studio-assistant 助手回答记录实际使用的章节、镜头与事实来源', () => {
    const project = makeDramaProject(store)
    const shot = project.shots[0]
    const subtitle = project.timeline.clips.find((clip) => clip.kind === 'subtitle')!
    const shotSources = assistantSources(project, { kind: 'shot', id: shot.id })
    expect(shotSources.some((source) => source.kind === 'shot' && source.id === shot.id)).toBe(true)
    expect(shotSources.some((source) => source.kind === 'facts')).toBe(project.facts.length > 0)
    const clipSources = assistantSources(project, { kind: 'clip', id: subtitle.id })
    expect(clipSources.some((source) => source.kind === 'clip' && source.id === subtitle.id)).toBe(true)
    const message = assistantMessage('assistant', '镜头建议', undefined, shotSources)
    expect(message.sources).toEqual(shotSources)
    expect(assistantMessage('assistant', '没有来源').sources).toBeUndefined()
  })

  it('@core:studio-assistant 章节改写不再生成本地假候选，必须走写作台的模型润色', () => {
    const project = makeNovelProject(store)
    const original = project.chapters[0].content
    const draft = draftEditPlan(project, '把第 1 章的结尾收得更克制。', { selection: { kind: 'chapter', id: project.chapters[0].id } })
    expect(draft.actions.some((action) => action.type === 'rewrite-chapter')).toBe(false)
    const plan = createPlanFromDraft(project.id, draft)
    expect(() => applyEditPlan(project, plan)).toThrow('没有可执行的修改')
    expect(project.chapters[0].content).toBe(original)
    expect(project.chapters[0].candidates).toHaveLength(0)
  })

  it('@core:studio-assistant 空计划不能伪装成已应用', () => {
    const project = makeNovelProject(store)
    const plan = createPlanFromDraft(project.id, draftEditPlan(project, '随便来点什么'))
    expect(() => applyEditPlan(project, plan)).toThrow('没有可执行的修改')
    expect(plan.status).toBe('pending')
  })

  it('@core:studio-assistant 重新生成大纲会更新有素材镜头的文字并新增场景镜头', () => {
    const project = makeDramaProject(store)
    const blueprint = {
      approved: true,
      source: 'model' as const,
      storyCore: '雨夜修伞',
      emotion: '克制',
      audience: '短片观众',
      pitch: '修伞',
      structure: '三幕',
      styleBible: { look: '冷色', palette: [], camera: '固定', sound: '雨', negative: ['文字'] },
      characters: project.characters,
      places: project.places,
      units: [
        { index: 1, title: '新第一镜', summary: '林晚在门口停住', seconds: 9, dialogue: '新台词', speaker: '林晚' },
        { index: 2, title: '新第二镜', summary: '伞骨倒转', seconds: 7 },
        { index: 3, title: '新第三镜', summary: '纸城升起', seconds: 8 }
      ],
      scenes: [
        { title: '雨夜', synopsis: '新伞铺', location: '老街', timeOfDay: '夜', characters: ['林晚'], unitStart: 1, unitEnd: 2 },
        { title: '纸城', synopsis: '第二空间', location: '纸城', timeOfDay: '晨', characters: ['林晚'], unitStart: 3, unitEnd: 3 }
      ],
      estimate: { minutesMin: 1, minutesMax: 2, costMin: 0, costMax: 0, currency: 'CNY' as const, lines: [], basis: 'local' as const },
      warnings: [],
      createdAt: Date.now()
    }
    project.blueprint = blueprint
    syncDramaOutline(project, blueprint)
    const first = project.shots.find((shot) => shot.number === 1)!
    expect(first.title).toBe('新第一镜')
    expect(first.imageAssetId).toBeTruthy()
    expect(first.status).toBe('stale')
    expect(first.voiceAssetId).toBeNull()
    expect(project.shots.find((shot) => shot.number === 3)?.sceneId).toBe(project.scenes[1].id)
    expect(project.scenes[1].title).toBe('纸城')
    expect(project.blueprint?.scenes?.[1]).toMatchObject({ unitStart: 3, unitEnd: 3 })
  })

  it('@core:studio-assistant 补全分镜会创建缺失场景并同步蓝图范围', () => {
    const project = makeDramaProject(store)
    project.blueprint = {
      approved: true,
      source: 'model',
      storyCore: '雨夜修伞',
      emotion: '克制',
      audience: '短片观众',
      pitch: '修伞',
      structure: '三幕',
      styleBible: { look: '冷色', palette: [], camera: '固定', sound: '雨', negative: ['文字'] },
      characters: project.characters,
      places: project.places,
      units: [
        { index: 1, title: '镜一', summary: '动作一' },
        { index: 2, title: '镜二', summary: '动作二' }
      ],
      scenes: [
        { title: '雨夜', synopsis: '起点', location: '老街', timeOfDay: '夜', characters: ['林晚'], unitStart: 1, unitEnd: 2 },
        { title: '纸城', synopsis: '新空间', location: '纸城', timeOfDay: '晨', characters: ['林晚'], unitStart: 3, unitEnd: 8 }
      ],
      estimate: { minutesMin: 1, minutesMax: 2, costMin: 0, costMax: 0, currency: 'CNY', lines: [], basis: 'local' },
      warnings: [],
      createdAt: Date.now()
    }
    const seed = {
      number: 3,
      sceneIndex: 2,
      title: '纸城坠落',
      action: '林晚跌进纸城',
      camera: '俯拍',
      shotSize: '大全景',
      durationSec: 8,
      dialogue: '这里是哪？',
      speaker: '林晚',
      continuity: '承接镜二',
      prompt: '纸城坠落',
      negative: '文字'
    }
    const plan = createPlanFromDraft(project.id, {
      title: '补全分镜计划',
      summary: '补全第 3 镜',
      actions: [{ type: 'append-shots', shots: [seed] }],
      effects: ['第 3 镜 · 纸城坠落'],
      seconds: 8,
      cost: 0
    })
    const applied = applyEditPlan(project, plan)
    expect(applied.storyboardChanged).toBe(true)
    expect(project.scenes.find((scene) => scene.number === 2)?.title).toBe('纸城')
    const shot = project.shots.find((item) => item.number === 3)!
    expect(shot.sceneId).toBe(project.scenes.find((scene) => scene.number === 2)?.id)
    expect(project.blueprint?.units.some((unit) => unit.index === 3)).toBe(true)
    expect(project.blueprint?.scenes?.[1]).toMatchObject({ unitStart: 3, unitEnd: 3 })
    expect(project.stages.storyboard.status).toBe('done')
    expect(project.stage).toBe('storyboard')
  })

  it('@core:studio-assistant 协作者可以更新蓝图并把人物事实同步到项目与下游', () => {
    const project = makeNovelProject(store)
    project.blueprint = novelBlueprint(project)
    const plan = createPlanFromDraft(project.id, {
      title: '协作者修改计划',
      summary: '更新蓝图',
      actions: [{
        type: 'update-blueprint',
        blueprint: {
          title: '伞铺的新名字',
          tone: '更冷、更克制',
          storyCore: '林晚必须在一周内修好一把会倒着走的伞。',
          characters: [
            { id: 'char-1', name: '林晚', role: '主角', look: '短黑发，深色围裙', desire: '保住伞铺', fear: '失去外婆', relationships: [], refAssetIds: [] },
            { id: 'char-2', name: '外婆', role: '已故亲人', look: '旧照片里的蓝布衫', relationships: [{ target: '林晚', label: '外孙女' }], refAssetIds: [] }
          ]
        }
      }],
      effects: ['更新蓝图'],
      seconds: 0,
      cost: 0
    })
    applyEditPlan(project, plan)
    expect(project.title).toBe('伞铺的新名字')
    expect(project.titleSource).toBe('user')
    expect(project.brief.tone).toBe('更冷、更克制')
    expect(project.blueprint?.storyCore).toContain('倒着走的伞')
    expect(project.characters.map((character) => character.name)).toEqual(['林晚', '外婆'])
    expect(project.facts.some((fact) => fact.subject === '林晚' && fact.object === '保住伞铺')).toBe(true)
    expect(project.stages.outline.status).toBe('ready')
    expect(project.stage).toBe('blueprint')
  })

  it('@core:studio-assistant 协作者可以替换章节正文并自动留档', () => {
    const project = makeNovelProject(store)
    project.blueprint = novelBlueprint(project)
    const before = project.chapters[0].content
    const plan = createPlanFromDraft(project.id, {
      title: '协作者修改计划',
      summary: '替换第 1 章正文',
      actions: [{ type: 'update-chapter', chapterNumber: 1, chapter: { number: 1, content: '雨停之后，她把黑伞倒挂在门后。\n\n少年没有再来。' } }],
      effects: ['更新第 1 章正文'],
      seconds: 0,
      cost: 0
    })
    applyEditPlan(project, plan)
    expect(project.chapters[0].content).toContain('少年没有再来')
    expect(project.chapters[0].content).not.toBe(before)
    expect(project.chapters[0].versions[0].content).toBe(before)
    expect(project.chapters[0].revision).toBe(2)
    expect(project.stage).toBe('writing')
  })

  it('@core:studio-assistant 协作者可以替换大纲并新增章节，同时保留已有正文', () => {
    const project = makeNovelProject(store)
    project.blueprint = novelBlueprint(project)
    const original = project.chapters[0].content
    const plan = createPlanFromDraft(project.id, {
      title: '协作者修改计划',
      summary: '调整章纲',
      actions: [{
        type: 'replace-outline',
        outline: {
          units: [
            { index: 1, title: '修伞的人（修订）', summary: '林晚在雨夜捡到黑伞，少年第一次出现。', beats: ['黑伞出现', '少年出现'] },
            { index: 2, title: '倒着走的钟', summary: '伞骨第一次倒转，林晚看见昨天的雨。', beats: ['钟倒转'] }
          ]
        }
      }],
      effects: ['更新 2 个大纲单元'],
      seconds: 0,
      cost: 0
    })
    applyEditPlan(project, plan)
    expect(project.blueprint?.units[0].title).toBe('修伞的人（修订）')
    expect(project.chapters).toHaveLength(2)
    expect(project.chapters[0].content).toBe(original)
    expect(project.chapters[1].synopsis).toContain('倒转')
    expect(project.stages.writing.status).toBe('stale')
    expect(project.stage).toBe('outline')
  })

  it('@core:studio-assistant 协作者可以更新单镜文字并同步蓝图与下游状态', () => {
    const project = makeDramaProject(store)
    project.blueprint = {
      approved: true,
      source: 'model',
      storyCore: '雨夜修伞',
      emotion: '克制',
      audience: '短片观众',
      pitch: '修伞',
      structure: '三幕',
      styleBible: { look: '冷色', palette: [], camera: '固定', sound: '雨', negative: ['文字'] },
      characters: project.characters,
      places: project.places,
      units: [
        { index: 1, title: '雨夜捡伞', summary: '旧动作', seconds: 8, dialogue: '旧台词', speaker: '林晚' },
        { index: 2, title: '伞骨倒转', summary: '动作二', seconds: 8 }
      ],
      scenes: [{ title: '雨夜', synopsis: '起点', location: '老街', timeOfDay: '夜', characters: ['林晚'], unitStart: 1, unitEnd: 2 }],
      estimate: { minutesMin: 1, minutesMax: 2, costMin: 0, costMax: 0, currency: 'CNY', lines: [], basis: 'local' },
      warnings: [],
      createdAt: Date.now()
    }
    expect(project.shots[0].voiceAssetId).toBeTruthy()
    const plan = createPlanFromDraft(project.id, {
      title: '协作者修改计划',
      summary: '更新第 1 镜',
      actions: [{ type: 'update-shot', shotNumber: 1, shot: { number: 1, dialogue: '伞还能修吗？', action: '林晚把伞递过去', camera: '近景跟拍' } }],
      effects: ['更新第 1 镜'],
      seconds: 0,
      cost: 0
    })
    applyEditPlan(project, plan)
    expect(project.shots[0].dialogue).toBe('伞还能修吗？')
    expect(project.shots[0].action).toBe('林晚把伞递过去')
    expect(project.shots[0].voiceAssetId).toBeNull()
    expect(project.blueprint?.units[0]).toMatchObject({ summary: '林晚把伞递过去', dialogue: '伞还能修吗？', camera: '近景跟拍' })
    expect(project.stage).toBe('storyboard')
    expect(project.stages.visuals.status).toBe('stale')
  })

  it('@core:studio-assistant 协作者可以人物改名并同步正文、大纲与事实', () => {
    const project = makeNovelProject(store)
    project.blueprint = novelBlueprint(project)
    const plan = createPlanFromDraft(project.id, {
      title: '协作者修改计划',
      summary: '人物改名',
      actions: [{ type: 'rename-entity', rename: { target: 'character', from: '林晚', to: '林小晚' } }],
      effects: ['人物「林晚」改名为「林小晚」'],
      seconds: 0,
      cost: 0
    })
    applyEditPlan(project, plan)
    expect(project.characters[0].name).toBe('林小晚')
    expect(project.chapters[0].content).toContain('林小晚')
    expect(project.blueprint?.storyCore).toContain('林小晚')
    expect(project.facts.some((fact) => fact.subject === '林小晚')).toBe(true)
    expect(project.blueprint?.units[0].summary).not.toContain('林晚')
    expect(project.stage).toBe('writing')
  })

  it('@core:studio-assistant 声音页的需求会落到音效与配乐任务', () => {
    const project = makeDramaProject(store)
    const sfxDraft = draftEditPlan(project, '加一段雨声，铺在开头。')
    expect(sfxDraft.actions.some((action) => action.type === 'generate-sfx' && action.sfx?.kind === 'rain')).toBe(true)
    const musicDraft = draftEditPlan(project, '换一段更紧张的配乐。')
    expect(musicDraft.actions.some((action) => action.type === 'generate-music')).toBe(true)
    const plan = createPlanFromDraft(project.id, sfxDraft)
    const applied = applyEditPlan(project, plan)
    expect(applied.regenerate.some((item) => item.kind === 'sfx' && item.sfxKind === 'rain')).toBe(true)
    expect(applied.stage).toBe('music')
    const removeDraft = draftEditPlan(project, '把雨声去掉。')
    expect(removeDraft.actions.some((action) => action.type === 'remove-sfx' && action.sfx?.kind === 'rain')).toBe(true)
    const beforeClips = project.timeline.clips.filter((clip) => clip.kind === 'sfx').length
    applyEditPlan(project, createPlanFromDraft(project.id, removeDraft))
    expect(project.timeline.clips.filter((clip) => clip.kind === 'sfx').length).toBeLessThan(beforeClips)
  })

  it('@core:studio-assistant 协作者的整章重写会排队真实模型任务', () => {
    const project = makeNovelProject(store)
    project.blueprint = novelBlueprint(project)
    const plan = createPlanFromDraft(project.id, {
      title: '协作者修改计划',
      summary: '重写第 1 章',
      actions: [{ type: 'rewrite-chapter', chapterId: project.chapters[0].id, instruction: '把结尾改得更克制' }],
      effects: ['按计划重写第 1 章正文'],
      seconds: 0,
      cost: 0
    })
    const applied = applyEditPlan(project, plan)
    expect(applied.regenerate).toContainEqual({ kind: 'chapter', chapterId: project.chapters[0].id, instruction: '把结尾改得更克制' })
    expect(project.stage).toBe('writing')
  })
})

describe('协作者全步骤上下文与顺序修改', () => {
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

  it('@core:studio-assistant 每个创作步骤都把当前步骤和对应选中项交给协作者', () => {
    const base = {
      selectedClipId: 'clip-1',
      selectedChapterId: 'ch-1',
      selectedShotId: 'shot-1'
    }
    expect(assistantContextFor({ ...base, view: 'storyboard', focusedStage: 'voice' })).toEqual({
      view: 'voice',
      selection: { kind: 'clip', id: 'clip-1' }
    })
    expect(assistantContextFor({ ...base, view: 'timeline', focusedStage: 'music' })).toEqual({
      view: 'music',
      selection: { kind: 'clip', id: 'clip-1' }
    })
    expect(assistantContextFor({ ...base, view: 'storyboard', focusedStage: 'storyboard' })).toEqual({
      view: 'storyboard',
      selection: { kind: 'shot', id: 'shot-1' }
    })
    expect(assistantContextFor({ ...base, view: 'writing', focusedStage: 'writing' })).toEqual({
      view: 'writing',
      selection: { kind: 'chapter', id: 'ch-1' }
    })
    expect(assistantContextFor({ ...base, view: 'writing', focusedStage: 'outline' })).toEqual({
      view: 'outline',
      selection: { kind: 'chapter', id: 'ch-1' }
    })
    expect(assistantContextFor({ ...base, view: 'blueprint', focusedStage: 'blueprint' })).toEqual({ view: 'blueprint' })
    expect(assistantContextFor({ ...base, view: 'storyboard', focusedStage: 'visuals' })).toEqual({
      view: 'visuals',
      selection: { kind: 'shot', id: 'shot-1' }
    })
  })

  it('@core:studio-assistant 把第 3 章移到第 1 章前面，正文随章节一起重排', () => {
    const project = makeNovelProject(store)
    project.blueprint = novelBlueprint(project)
    const seed = project.chapters[0]
    project.chapters = [
      { ...seed, id: 'ch-1', number: 1, title: '第一章', content: '第一章正文' },
      { ...seed, id: 'ch-2', number: 2, title: '第二章', content: '第二章正文' },
      { ...seed, id: 'ch-3', number: 3, title: '第三章', content: '第三章正文' }
    ]
    const draft = draftEditPlan(project, '把第3章移到第1章前面')
    expect(draft.actions).toEqual([expect.objectContaining({ type: 'move-chapter', to: 1 })])
    const applied = applyEditPlan(project, createPlanFromDraft(project.id, draft))
    expect(project.chapters.map((chapter) => chapter.id)).toEqual(['ch-3', 'ch-1', 'ch-2'])
    expect(project.chapters.map((chapter) => chapter.number)).toEqual([1, 2, 3])
    expect(project.chapters[0].content).toBe('第三章正文')
    expect(project.blueprint?.units.map((unit) => unit.index)).toEqual([1, 2, 3])
    expect(applied.stage).toBe('writing')
  })

  it('@core:studio-assistant 改台词会自动清空旧配音并排队重配', () => {
    const project = makeDramaProject(store)
    const plan = createPlanFromDraft(project.id, {
      title: '改台词',
      summary: '第 1 镜换台词',
      actions: [{ type: 'update-shot', shotNumber: 1, shot: { number: 1, dialogue: '新的台词' } }],
      effects: ['更新第 1 镜台词'],
      seconds: 0,
      cost: 0
    })
    const applied = applyEditPlan(project, plan)
    expect(project.shots[0].dialogue).toBe('新的台词')
    expect(project.shots[0].voiceAssetId).toBeNull()
    expect(applied.regenerate).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'voice', shotId: project.shots[0].id })
    ]))
  })

  it('@core:studio-assistant 把第 3 镜移到第 1 镜前面，分镜与蓝图单元一起重排', () => {
    const project = makeDramaProject(store)
    addShot(project, 3, { title: '第三镜', action: '第三镜动作', dialogue: '第三句', speaker: '林晚' })
    const draft = draftEditPlan(project, '把第3镜移到第1镜前面')
    expect(draft.actions).toEqual([expect.objectContaining({ type: 'move-shot', to: 1 })])
    const applied = applyEditPlan(project, createPlanFromDraft(project.id, draft))
    expect(project.shots.map((shot) => shot.title)).toEqual(['第三镜', '雨夜捡伞', '伞骨倒转'])
    expect(project.shots.map((shot) => shot.number)).toEqual([1, 2, 3])
    expect(applied.stage).toBe('storyboard')
  })

  it('@core:studio-assistant 大纲只改梗概时保留原标题与未提到的字段', () => {
    const project = makeNovelProject(store)
    project.blueprint = novelBlueprint(project)
    const plan = createPlanFromDraft(project.id, {
      title: '改大纲',
      summary: '只改梗概',
      actions: [{ type: 'replace-outline', outline: { units: [{ index: 1, summary: '新的章纲梗概' }] } }],
      effects: ['更新 1 个大纲单元'],
      seconds: 0,
      cost: 0
    })
    applyEditPlan(project, plan)
    expect(project.blueprint?.units[0].title).toBe('修伞的人')
    expect(project.blueprint?.units[0].summary).toBe('新的章纲梗概')
    expect(project.chapters[0].content).toContain('雨是从傍晚开始下的')
  })

  it('@core:studio-assistant 改人物声线会同步到所有该人物的镜头并排队重配', () => {
    const project = makeDramaProject(store)
    const plan = createPlanFromDraft(project.id, {
      title: '改声线',
      summary: '林晚换声线',
      actions: [{ type: 'update-character', character: { name: '林晚', voiceId: 'qwen:serena' } }],
      effects: ['更新人物「林晚」：声线「qwen:serena」'],
      seconds: 0,
      cost: 0
    })
    const applied = applyEditPlan(project, plan)
    expect(project.characters[0].voiceId).toBe('qwen:serena')
    expect(project.shots[0].voiceId).toBe('qwen:serena')
    expect(project.shots[0].voiceAssetId).toBeNull()
    expect(applied.regenerate).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'voice', voiceId: 'qwen:serena', shotIds: [project.shots[0].id] })
    ]))
  })

  it('@core:studio-assistant 单镜改声线会清空旧配音并排队重配', () => {
    const project = makeDramaProject(store)
    const plan = createPlanFromDraft(project.id, {
      title: '改这一镜声线',
      summary: '第 1 镜换声线',
      actions: [{ type: 'update-shot', shotNumber: 1, shot: { number: 1, voiceId: 'qwen:serena' } }],
      effects: ['更新第 1 镜声线'],
      seconds: 0,
      cost: 0
    })
    const applied = applyEditPlan(project, plan)
    expect(project.shots[0].voiceId).toBe('qwen:serena')
    expect(project.shots[0].voiceAssetId).toBeNull()
    expect(applied.regenerate).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'voice', shotId: project.shots[0].id, voiceId: 'qwen:serena' })
    ]))
  })

  it('@core:studio-assistant 全片重配只包含有台词的镜头', () => {
    const project = makeDramaProject(store)
    const plan = createPlanFromDraft(project.id, {
      title: '全片重配',
      summary: '全片配音更冷',
      actions: [{ type: 'regenerate-voice', scope: 'all', instruction: '全片更冷' }],
      effects: ['全片重配配音'],
      seconds: 0,
      cost: 0
    })
    const applied = applyEditPlan(project, plan)
    expect(applied.regenerate).toEqual([
      expect.objectContaining({ kind: 'voice', shotIds: [project.shots[0].id], instruction: '全片更冷' })
    ])
  })

  it('@core:studio-assistant 模型计划会把局部大纲、重排、人物声线和全片重配规范化', () => {
    const project = makeNovelProject(store)
    project.blueprint = novelBlueprint(project)
    const service = new StudioService({ store })
    const actions = (service as any).normalizeRevisionActions(project, [
      { type: 'replace-outline', outline: { units: [{ index: 1, summary: '只改梗概' }] } },
      { type: 'move-chapter', chapterNumber: 1, to: 1 },
      { type: 'update-character', character: { name: '林晚', voiceId: 'qwen:serena' } },
      { type: 'update-shot', shot: { number: 1, voiceId: 'qwen:serena' } },
      { type: 'regenerate-voice', scope: 'all', instruction: '全片更冷' }
    ]) as Array<Record<string, any>>
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'replace-outline' }),
      expect.objectContaining({ type: 'move-chapter', to: 1 }),
      expect.objectContaining({ type: 'update-character' }),
      expect.objectContaining({ type: 'update-shot' }),
      expect.objectContaining({ type: 'regenerate-voice', scope: 'all' })
    ]))
    expect(actions.find((action) => action.type === 'replace-outline')?.outline?.units[0]).toMatchObject({ index: 1, summary: '只改梗概' })
    expect(actions.find((action) => action.type === 'update-shot')?.shot?.voiceId).toBe('qwen:serena')
    expect(actions.find((action) => action.type === 'regenerate-voice')?.scope).toBe('all')
  })
})

function novelBlueprint(project: ReturnType<typeof makeNovelProject>) {
  return {
    approved: true,
    source: 'model' as const,
    storyCore: '林晚继承外婆的伞铺，每周三都有人来修同一把黑伞。',
    emotion: '克制',
    audience: '长篇读者',
    pitch: '修伞铺与失忆少年。',
    structure: '三幕',
    styleBible: { look: '雨与旧木', palette: [], camera: '中近景', sound: '雨', negative: ['文字'] },
    characters: project.characters,
    places: project.places,
    units: [
      { index: 1, title: '修伞的人', summary: '林晚在雨夜捡到一把黑伞。', wordTarget: 2000, beats: ['异常出现'] }
    ],
    scenes: [],
    estimate: { minutesMin: 3, minutesMax: 10, costMin: 0, costMax: 0, currency: 'CNY' as const, lines: [], basis: 'local' as const },
    warnings: [],
    createdAt: Date.now()
  }
}

describe('剪辑表计算', () => {
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

  it('@core:studio-timeline 按镜头顺序装配画面、对白、音效与字幕', () => {
    const project = makeDramaProject(store)
    const timeline = buildTimelineFromProject(project)
    expect(timeline.durationSec).toBe(16)
    expect(timelineDuration(timeline)).toBe(16)
    const video = timeline.clips.filter((clip) => clip.kind === 'video')
    const dialogue = timeline.clips.filter((clip) => clip.kind === 'dialogue')
    const subtitles = timeline.clips.filter((clip) => clip.kind === 'subtitle')
    const sfx = timeline.clips.filter((clip) => clip.kind === 'sfx')
    expect(video).toHaveLength(2)
    expect(dialogue).toHaveLength(1)
    expect(subtitles).toHaveLength(1)
    expect(sfx.length).toBeGreaterThan(0)
    expect(video[1].start).toBe(8)
    expect(subtitles[0].text).toContain('还能修好吗')
  })

  it('@core:studio-timeline 重新装配时保留同一镜的逐句字幕', () => {
    const project = makeDramaProject(store)
    project.shots[0].dialogue = '第一句。第二句。'
    const first = buildTimelineFromProject(project)
    const old = first.clips.filter((clip) => clip.kind === 'subtitle' && clip.shotId === project.shots[0].id)
    expect(old).toHaveLength(1)
    first.clips = first.clips.filter((clip) => clip.kind !== 'subtitle')
    first.clips.push(
      { ...old[0], id: 'sub-a', text: '第一句。', start: 0, duration: 2 },
      { ...old[0], id: 'sub-b', text: '第二句。', start: 2, duration: 2 }
    )
    project.timeline = first
    const rebuilt = buildTimelineFromProject(project)
    const subtitles = rebuilt.clips.filter((clip) => clip.kind === 'subtitle' && clip.shotId === project.shots[0].id)
    expect(subtitles.map((clip) => clip.text)).toEqual(['第一句。', '第二句。'])
    expect(subtitles.map((clip) => clip.start)).toEqual([0, 2])
  })

  it('@core:studio-timeline 重新装配时优先使用正式配乐，而不是更早的草稿或样例配乐', () => {
    const project = makeDramaProject(store)
    project.assets = project.assets.filter((asset) => !asset.tags.includes('music'))
    const draft = store.addAsset(project, {
      bytes: Buffer.from('RIFF0000WAVEfmt draft'),
      title: '配乐草稿 · 雨',
      mime: 'audio/wav',
      kindHint: 'audio',
      tags: ['music', 'draft'],
      origin: { source: 'local' },
      metadata: { durationSec: 4 }
    })
    const demo = store.addAsset(project, {
      bytes: Buffer.from('RIFF0000WAVEfmt demo'),
      title: '样例配乐',
      mime: 'audio/wav',
      kindHint: 'audio',
      tags: ['music', 'demo'],
      origin: { source: 'demo' },
      metadata: { durationSec: 4 }
    })
    const formal = store.addAsset(project, {
      bytes: Buffer.from('RIFF0000WAVEfmt formal'),
      title: 'ACE-Step 正式配乐',
      mime: 'audio/mpeg',
      kindHint: 'audio',
      tags: ['music', 'model'],
      origin: { source: 'comfyui', model: 'ACE-Step 1.5' },
      metadata: { durationSec: 4 }
    })
    const timeline = buildTimelineFromProject(project)
    const clip = timeline.clips.find((item) => item.kind === 'music')
    expect(clip?.assetId).toBe(formal.id)
    expect(clip?.assetId).not.toBe(draft.id)
    expect(clip?.assetId).not.toBe(demo.id)
    project.musicAssetId = draft.id
    expect(buildTimelineFromProject(project).clips.find((item) => item.kind === 'music')?.assetId).toBe(draft.id)
  })

  it('@core:studio-timeline SRT 与 ASS 时间码和文本正确', () => {
    const project = makeDramaProject(store)
    const timeline = buildTimelineFromProject(project)
    const srt = toSrt(timeline)
    expect(srt).toContain('00:00:00,000 --> 00:00:08,000')
    expect(srt).toContain('还能修好吗？')
    const ass = toAss(timeline)
    expect(ass).toContain('[V4+ Styles]')
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:08.00')
    expect(ass).toContain('还能修好吗？')
  })

  it('@core:studio-timeline ASS 逐条导出字幕字号、颜色与底板', () => {
    const project = makeDramaProject(store)
    const timeline = buildTimelineFromProject(project)
    const subtitle = timeline.clips.find((clip) => clip.kind === 'subtitle')!
    subtitle.style = { yPercent: 80, size: 60, color: '#ff0000', background: true }
    const boxed = toAss(timeline)
    expect(boxed).toContain('Style: MorrowBox')
    expect(boxed).toContain('\\fs60')
    expect(boxed).toContain('\\c&H000000FF&')
    expect(boxed).toContain(',MorrowBox,,0,0,')

    subtitle.style = { yPercent: 80, size: 42, color: '#00ff00', background: false }
    const plain = toAss(timeline)
    expect(plain).toContain('\\fs42')
    expect(plain).toContain('\\c&H0000FF00&')
    expect(plain).toContain(',Morrow,,0,0,')

    const sanitized = sanitizeTimeline(project, {
      tracks: timeline.tracks.map((track) => ({ ...track })),
      clips: [{ ...subtitle, style: { yPercent: 80, size: 42, color: '#00ff00', background: false } }]
    })
    expect(sanitized.clips[0].style?.background).toBe(false)
  })

  it('@core:studio-timeline 校验时间线：拒绝不存在的轨道和负时长，保留合法片段', () => {
    const project = makeDramaProject(store)
    const raw = {
      tracks: project.timeline.tracks.map((track) => ({ ...track })),
      clips: [
        { id: 'ok', trackId: 'track-video', kind: 'video', label: '合法片段', start: 0, duration: 5, srcIn: 0, speed: 1, volume: 1, transition: 'cut' },
        { id: 'bad-track', trackId: 'track-unknown', kind: 'video', label: '坏轨道', start: 0, duration: 5 },
        { id: 'bad-duration', trackId: 'track-video', kind: 'video', label: '负时长', start: -4, duration: -2 },
        { id: 'bad-volume', trackId: 'track-music', kind: 'music', label: '音量', start: 1, duration: 4, volume: 99, speed: 0.1 }
      ]
    }
    const timeline = sanitizeTimeline(project, raw)
    expect(timeline.clips.some((clip) => clip.id === 'bad-track')).toBe(false)
    expect(timeline.clips.find((clip) => clip.id === 'bad-duration')?.start).toBe(0)
    expect(timeline.clips.find((clip) => clip.id === 'bad-duration')?.duration).toBeGreaterThan(0)
    expect(timeline.clips.find((clip) => clip.id === 'bad-volume')?.volume).toBe(2)
    expect(timeline.clips.find((clip) => clip.id === 'bad-volume')?.speed).toBe(0.25)
    expect(timeline.version).toBeGreaterThan(project.timeline.version)
    expect(timeline.snapshots.length).toBeGreaterThan(0)
  })

  it('@core:studio-timeline 轨道静音与可见片段保持独立', () => {
    const project = makeDramaProject(store)
    const timeline = buildTimelineFromProject(project)
    const muted = {
      tracks: timeline.tracks.map((track) => (track.id === 'track-video' ? { ...track, muted: true } : track)),
      clips: timeline.clips
    }
    const next = sanitizeTimeline({ ...project, timeline }, muted)
    expect(next.tracks.find((track) => track.id === 'track-video')?.muted).toBe(true)
    expect(next.clips.length).toBe(timeline.clips.length)
  })
})

// ── 原 studio-store.test.ts ──

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

describe('创作台作品仓库', () => {
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

  it('@core:studio-storage 新建作品：保存一次再读取，内容不丢不变', () => {
    const project = store.newProject({
      kind: 'short',
      title: '测试短篇',
      logline: '一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。',
      brief: { aspect: '9:16', targetWords: 18000 }
    })
    const read = store.readProject(project.id)
    expect(read.title).toBe('测试短篇')
    expect(read.kind).toBe('short')
    expect(read.brief.aspect).toBe('9:16')
    expect(read.timeline.aspect).toBe('9:16')
    expect(read.revision).toBe(project.revision)
    expect(store.summaries().map((item) => item.id)).toContain(project.id)
  })

  it('@core:studio-storage 素材按 SHA-256 去重并安全写入作品目录', () => {
    const project = store.newProject({ kind: 'short', title: '素材测试', logline: '一句话' })
    const first = store.addAsset(project, { bytes: TINY_PNG, title: '画面', kindHint: 'image', mime: 'image/png' })
    const second = store.addAsset(project, { bytes: TINY_PNG, title: '同一张画面', kindHint: 'image', mime: 'image/png' })
    expect(second.id).toBe(first.id)
    expect(project.assets.filter((asset) => asset.sha256 === first.sha256)).toHaveLength(1)
    expect(existsSync(store.assetAbsolute(project, first))).toBe(true)
    expect(first.width).toBe(1)
    expect(first.height).toBe(1)
  })

  it('@core:studio-storage 章节候选不覆盖正文，手改前自动留档', () => {
    const project = makeNovelProject(store)
    const chapter = project.chapters[0]
    const original = chapter.content
    store.addChapterVersion(chapter, original, '手改前')
    chapter.content = `${original}\n\n她把灯关了。`
    chapter.candidates.unshift({ id: studioId('cand'), content: '另一版本', label: '候选', source: 'local', createdAt: Date.now(), wordCount: 4 })
    store.save(project, '保存章节')
    const read = store.readProject(project.id)
    expect(read.chapters[0].content).toContain('她把灯关了')
    expect(read.chapters[0].candidates).toHaveLength(1)
    expect(read.chapters[0].versions[0].content).toContain('雨是从傍晚开始下的')
  })

  it('@core:studio-storage 项目版本可列表并完整恢复，恢复前自动留档', () => {
    const project = makeNovelProject(store)
    const original = project.chapters[0].content
    store.writeVersion(project, '第一版留档')
    const versions = store.listVersionFiles(project.id)
    expect(versions.some((version) => version.reason === '第一版留档')).toBe(true)
    const version = versions.find((item) => item.reason === '第一版留档')
    expect(version).toBeTruthy()
    project.chapters[0].content = `${original}\n\n第二版新增的一行。`
    store.save(project, '第二版')
    const restored = store.restoreProjectVersion(project.id, version!.name)
    expect(restored.chapters[0].content).toBe(original)
    const after = store.listVersionFiles(project.id)
    expect(after.some((item) => item.reason === '恢复历史版本前自动留档')).toBe(true)
  })

  it('@core:studio-storage 作品文件损坏时从最近版本恢复', () => {
    const project = makeDramaProject(store)
    store.writeVersion(store.readProject(project.id), '损坏前版本')
    writeFileSync(store.projectFile(project.id), '{broken json', 'utf8')
    const read = store.readProject(project.id)
    expect(read.id).toBe(project.id)
    expect(read.title).toBe('测试漫剧')
    expect(read.shots).toHaveLength(2)
  })

  it('@core:studio-storage 拒绝非法作品 id 和越界素材路径', () => {
    expect(() => store.readProject('../escape')).toThrow('作品 id')
    const project = store.newProject({ kind: 'short', title: '安全测试', logline: '一句话' })
    expect(() => store.assetAbsolute(project, { path: '../../outside.bin' })).toThrow('作品目录')
  })

  it('@core:studio-storage 项目版本最多保留 60 个，任务记录裁剪到上限', () => {
    const project = makeNovelProject(store)
    for (let index = 0; index < 65; index += 1) store.writeVersion(project, `版本 ${index}`)
    expect(store.listVersionFiles(project.id).length).toBeLessThanOrEqual(60)
    project.jobs = Array.from({ length: 130 }, (_, index) => ({
      id: `job-${index}`,
      requestId: `req-${index}`,
      projectId: project.id,
      kind: 'text' as const,
      label: `任务 ${index}`,
      stage: 'writing' as const,
      status: 'done' as const,
      progress: 100,
      message: '完成',
      inputHash: String(index),
      attempts: 1,
      cost: 0,
      outputs: [],
      createdAt: index,
      updatedAt: index
    }))
    store.trimJobs(project)
    expect(project.jobs.length).toBeLessThanOrEqual(120)
  })

  it('@core:studio-storage 5 万字章节分片落盘，读取时还原完整正文', () => {
    const project = makeNovelProject(store)
    const chapter = project.chapters[0]
    const content = Array.from({ length: 3000 }, (_, index) => `第 ${index + 1} 段，雨沿着伞骨落下来。`).join('\n')
    expect(content.length).toBeGreaterThan(50_000)
    chapter.content = content
    store.save(project, '保存超长章节')
    expect(chapter.contentRef?.chunks).toBeGreaterThanOrEqual(4)
    const disk = JSON.parse(readFileSync(store.projectFile(project.id), 'utf8')) as { chapters: Array<{ content: string; contentRef?: { path: string; chunks: number } }> }
    expect(disk.chapters[0].content).toBe('')
    expect(disk.chapters[0].contentRef?.path).toContain('chunks/')
    const dir = join(store.projectDir(project.id), disk.chapters[0].contentRef!.path)
    expect(readdirSync(dir).filter((name) => name.endsWith('.txt')).length).toBe(chapter.contentRef?.chunks)
    const read = store.readProject(project.id)
    expect(read.chapters[0].content).toBe(content)
    expect(read.chapters[0].locked).toBe(true)
  })

  it('@core:studio-storage 分片缺失或哈希不符时不显示残缺正文，并从最近版本恢复', () => {
    const project = makeNovelProject(store)
    const content = '完整正文。'.repeat(12_000)
    project.chapters[0].content = content
    store.save(project, '保存分片正文')
    store.writeVersion(store.readProject(project.id), '完整分片快照')
    const chunkPath = project.chapters[0].contentRef!.path
    const chunkDir = join(store.projectDir(project.id), chunkPath)
    const files = readdirSync(chunkDir).filter((name) => /^part-\d+\.txt$/.test(name)).sort()
    expect(files.length).toBeGreaterThan(2)
    rmSync(join(chunkDir, files[1]), { force: true })
    const recovered = store.readProject(project.id)
    expect(recovered.chapters[0].content).toBe(content)
    expect(recovered.checks.some((check) => check.title.includes('正文分片不完整'))).toBe(true)
    const quarantine = readdirSync(store.projectDir(project.id)).find((name) => name.startsWith('corrupt-'))
    expect(quarantine).toBeTruthy()
    expect(existsSync(join(store.projectDir(project.id), quarantine!, 'project.json'))).toBe(true)
  })

  it('@core:studio-storage project.json 写入失败时旧分片与旧 JSON 一起保持有效', () => {
    const project = makeNovelProject(store)
    const oldContent = '旧稿内容。'.repeat(4_000)
    project.chapters[0].content = oldContent
    store.save(project, '保存旧稿')
    const before = JSON.parse(readFileSync(store.projectFile(project.id), 'utf8')) as { chapters: Array<{ contentRef?: { path: string } }> }
    const oldRef = before.chapters[0].contentRef!.path
    expect(existsSync(join(store.projectDir(project.id), oldRef))).toBe(true)

    project.chapters[0].content = '新稿内容。'.repeat(4_000)
    const original = (store as any).writeProjectPayload.bind(store)
    ;(store as any).writeProjectPayload = () => { throw new Error('模拟磁盘写入失败') }
    expect(() => store.save(project, '保存新稿')).toThrow('模拟磁盘写入失败')
    ;(store as any).writeProjectPayload = original

    const onDisk = JSON.parse(readFileSync(store.projectFile(project.id), 'utf8')) as { chapters: Array<{ contentRef?: { path: string } }> }
    expect(onDisk.chapters[0].contentRef?.path).toBe(oldRef)
    expect(existsSync(join(store.projectDir(project.id), oldRef))).toBe(true)
    expect(store.readProject(project.id).chapters[0].content).toBe(oldContent)

    store.save(project, '重试保存新稿')
    expect(store.readProject(project.id).chapters[0].content).toBe('新稿内容。'.repeat(4_000))
    expect(existsSync(join(store.projectDir(project.id), oldRef))).toBe(false)
  })

  it('@core:studio-storage 只恢复损坏章节，完整章节保留最近保存的新内容', () => {
    const project = makeNovelProject(store)
    const oldFirst = '第一章旧稿。'.repeat(3_000)
    const oldSecond = '第二章旧稿。'.repeat(3_000)
    project.chapters[0].content = oldFirst
    project.chapters.push({
      ...JSON.parse(JSON.stringify(project.chapters[0])),
      id: 'ch-2',
      number: 2,
      title: '第二章',
      content: oldSecond
    })
    store.save(project, '保存两章旧稿')
    store.writeVersion(store.readProject(project.id), '两章旧稿快照')

    const newSecond = '第二章新稿，刚保存但还没有新快照。'.repeat(2_000)
    const current = store.readProject(project.id)
    current.chapters[1].content = newSecond
    store.save(current, '只保存第二章新稿')

    const firstRef = current.chapters[0].contentRef!.path
    const firstDir = join(store.projectDir(project.id), firstRef)
    const parts = readdirSync(firstDir).filter((name) => /^part-\d+\.txt$/.test(name)).sort()
    rmSync(join(firstDir, parts[0]), { force: true })

    const recovered = store.readProject(project.id)
    expect(recovered.chapters[0].content).toBe(oldFirst)
    expect(recovered.chapters[1].content).toBe(newSecond)
    const check = recovered.checks.find((item) => item.title.includes('部分章节正文分片不完整'))
    expect(check?.detail).toContain('已恢复：修伞的人')
    expect(check?.detail).toContain('其余 1 章保持当前版本')
  })

  it('@core:studio-storage 断电恢复演练：损坏作品可从版本恢复超长章节与外部任务号', () => {
    const project = makeNovelProject(store)
    const content = '恢复演练。'.repeat(12_000)
    project.chapters[0].content = content
    project.jobs.push({
      id: 'job-remote',
      requestId: 'req-remote',
      projectId: project.id,
      kind: 'image',
      label: '外部画面',
      stage: 'visuals',
      status: 'review',
      progress: 42,
      message: '应用退出时外部任务已提交；启动后会自动核对结果。',
      inputHash: 'remote',
      attempts: 1,
      remoteId: 'prompt-123',
      remoteTargets: [{ remoteId: 'prompt-123', kind: 'image', shotId: 'shot-1' }],
      cost: null,
      outputs: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    store.save(project, '保存恢复演练数据')
    store.writeVersion(store.readProject(project.id), '恢复演练快照')
    writeFileSync(store.projectFile(project.id), '{broken', 'utf8')
    const recovered = store.readProject(project.id)
    expect(recovered.chapters[0].content).toBe(content)
    expect(recovered.jobs.find((job) => job.id === 'job-remote')?.remoteId).toBe('prompt-123')
    expect(recovered.jobs.find((job) => job.id === 'job-remote')?.remoteTargets?.[0]?.shotId).toBe('shot-1')
    expect(existsSync(join(store.projectDir(project.id), recovered.chapters[0].contentRef!.path))).toBe(true)
  })

  it('@core:studio-storage 目标字数与目标时长在保存读回后不丢失', () => {
    const project = store.newProject({
      kind: 'novel',
      title: '目标保留',
      logline: '一个修伞的人',
      brief: { targetWords: 50_000, targetSeconds: 96 }
    })
    store.save(project, '保存目标')
    const read = store.readProject(project.id)
    expect(read.brief.targetWords).toBe(50_000)
    expect(read.brief.targetSeconds).toBe(96)
  })

  it('@core:studio-storage 超长章节可写入版本并完整恢复', () => {
    const project = makeNovelProject(store)
    const chapter = project.chapters[0]
    const first = '第一版。'.repeat(6000)
    chapter.content = first
    store.writeVersion(project, '超长第一版')
    const version = store.listVersionFiles(project.id).find((item) => item.reason === '超长第一版')
    chapter.content = '第二版。'.repeat(6000)
    store.save(project, '超长第二版')
    const restored = store.restoreProjectVersion(project.id, version!.name)
    expect(restored.chapters[0].content).toBe(first)
    expect(store.readProject(project.id).chapters[0].content).toBe(first)
  })
  it('@core:studio-storage 旧内置漫剧升级为动态镜头与 1080p 成片，时间线仍可编辑', () => {
    const project = makeDramaProject(store)
    project.title = '逆行的伞'
    project.demo = true
    const base = project.shots[0]
    project.shots = Array.from({ length: 12 }, (_, index) => ({
      ...(JSON.parse(JSON.stringify(base)) as typeof base),
      id: `shot-${index + 1}`,
      number: index + 1,
      title: `镜 ${index + 1}`,
      durationSec: 8,
      dialogue: '',
      speaker: '',
      voiceAssetId: null,
      videoAssetId: null,
      imageCandidates: [],
      videoCandidates: []
    }))
    project.timeline = buildTimelineFromProject(project)
    project.timeline.version = 4
    project.timeline.durationSec = 96
    project.episodes = [{
      id: 'ep-1',
      number: 1,
      title: '逆行的伞',
      synopsis: '',
      sceneIds: project.scenes.map((scene) => scene.id),
      durationSec: 96,
      updatedAt: Date.now()
    }]
    store.save(project, '旧内置样例')
    writeFileSync(join(store.root, '.demo-seeded-v1'), '{}\n', 'utf8')
    ensureDemoProjects(store)
    const upgraded = store.readProject(project.id)
    expect(upgraded.timeline.version).toBe(6)
    expect(upgraded.shots.every((shot) => Boolean(shot.videoAssetId))).toBe(true)
    const videoIds = new Set(upgraded.assets.filter((asset) => asset.kind === 'video').map((asset) => asset.id))
    expect(upgraded.shots.every((shot) => videoIds.has(shot.videoAssetId!))).toBe(true)
    expect(upgraded.timeline.clips.filter((clip) => clip.kind === 'video').every((clip) => videoIds.has(clip.assetId!))).toBe(true)
    const final = upgraded.deliveries.find((delivery) => delivery.label.includes('1080p'))
    expect(final).toBeTruthy()
    expect(currentTimelineVideo(upgraded, store)?.id).toBe(final!.id)
  })

})