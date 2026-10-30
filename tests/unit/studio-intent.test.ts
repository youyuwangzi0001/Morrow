import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type { StudioStore } from '../../src/main/studio'
import { tempStore, makeDramaProject, makeNovelProject, addShot } from './studio-fixtures'
import { applyEditPlan, assistantMessage, assistantSources, createPlanFromDraft, draftEditPlan, StudioService, syncDramaOutline } from '../../src/main/studio'
import { assistantContextFor } from '../../src/shared/studio-assistant'

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
