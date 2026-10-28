import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type { StudioStore } from '../../src/main/studio'
import { tempStore, makeDramaProject, makeNovelProject } from './studio-fixtures'
import { applyEditPlan, assistantMessage, assistantSources, createPlanFromDraft, draftEditPlan, localAssistantReply } from '../../src/main/studio'

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

  it('把慢速、雨声音量与不改脸翻译成可预览动作', () => {
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

  it('重做画面把用户原话与锁定约束写进任务指令', () => {
    const project = makeDramaProject(store)
    const draft = draftEditPlan(project, '重做镜 01 的画面，不要改脸。')
    const plan = createPlanFromDraft(project.id, draft)
    const applied = applyEditPlan(project, plan)
    const image = applied.regenerate.find((item) => item.kind === 'image')
    expect(image?.instruction).toContain('重做镜 01 的画面')
    expect(image?.instruction).toContain('保持角色面部')
  })

  it('字幕上移只改字幕片段样式', () => {
    const project = makeDramaProject(store)
    const subtitle = project.timeline.clips.find((clip) => clip.kind === 'subtitle')!
    const before = subtitle.style?.yPercent ?? 86
    const plan = createPlanFromDraft(project.id, draftEditPlan(project, '字幕往上挪一点', { selection: { kind: 'clip', id: subtitle.id } }))
    applyEditPlan(project, plan)
    const after = project.timeline.clips.find((clip) => clip.id === subtitle.id)
    expect(after?.style?.yPercent).toBeLessThan(before)
  })

  it('助手回答记录实际使用的章节、镜头与事实来源', () => {
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

  it('章节改写不再生成本地假候选，必须走写作台的模型润色', () => {
    const project = makeNovelProject(store)
    const original = project.chapters[0].content
    const draft = draftEditPlan(project, '把第 1 章的结尾收得更克制。', { selection: { kind: 'chapter', id: project.chapters[0].id } })
    expect(draft.actions.some((action) => action.type === 'rewrite-chapter')).toBe(false)
    const plan = createPlanFromDraft(project.id, draft)
    const applied = applyEditPlan(project, plan)
    expect(applied.chapterCandidates).toBe(0)
    expect(project.chapters[0].content).toBe(original)
    expect(project.chapters[0].candidates).toHaveLength(0)
  })

  it('无法理解的请求明确说明，不假装修改', () => {
    const project = makeNovelProject(store)
    const draft = draftEditPlan(project, '随便来点什么')
    expect(draft.actions).toHaveLength(0)
    const plan = createPlanFromDraft(project.id, draft)
    const reply = localAssistantReply(project, '随便来点什么', plan)
    expect(reply.text).toContain('也可以')
    expect(plan.actions).toHaveLength(0)
  })
})
