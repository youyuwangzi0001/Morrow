// 大白话改片：把中文修改要求翻译成可预览、可撤销的动作。
import type {
  StudioChatMessage,
  StudioClip,
  StudioEditAction,
  StudioEditPlan,
  StudioMessageSource,
  StudioProject,
  StudioShot
} from '../../shared/studio'
import { countWords } from '../../shared/studio'
import { localChapterDraft, localRewrite } from './local-creative'
import { nowMs, studioId } from './store'

interface IntentContext {
  selection?: { kind: 'chapter' | 'shot' | 'clip'; id: string }
}

interface DraftPlan {
  title: string
  summary: string
  actions: StudioEditAction[]
  effects: string[]
  seconds: number
  cost: number | null
  note?: string
}

function shotNumberFromText(text: string): number | null {
  const match = /(?:第\s*)?(?:镜|镜头|shot)\s*0?(\d{1,3})/i.exec(text)
  return match ? Number(match[1]) : null
}

function percentFrom(text: string): number | null {
  const match = /(\d{1,3})\s*%/.exec(text)
  return match ? Number(match[1]) : null
}

function targetShot(project: StudioProject, text: string, ctx: IntentContext): StudioShot | null {
  if (ctx.selection?.kind === 'shot') {
    const shot = project.shots.find((item) => item.id === ctx.selection?.id)
    if (shot) return shot
  }
  if (ctx.selection?.kind === 'clip') {
    const clip = project.timeline.clips.find((item) => item.id === ctx.selection?.id)
    if (clip?.shotId) {
      const shot = project.shots.find((item) => item.id === clip.shotId)
      if (shot) return shot
    }
  }
  const number = shotNumberFromText(text)
  if (number !== null) return project.shots.find((shot) => shot.number === number) ?? null
  return null
}

function clipsForShot(project: StudioProject, shotId: string): StudioClip[] {
  return project.timeline.clips.filter((clip) => clip.shotId === shotId)
}

function chapterTarget(project: StudioProject, text: string, ctx: IntentContext): { chapterId: string; instruction: string } | null {
  if (ctx.selection?.kind === 'chapter') {
    if (project.chapters.some((chapter) => chapter.id === ctx.selection?.id)) {
      return { chapterId: ctx.selection.id, instruction: text }
    }
  }
  const numberMatch = /第\s*(\d{1,3})\s*章/.exec(text)
  if (numberMatch) {
    const chapter = project.chapters.find((item) => item.number === Number(numberMatch[1]))
    if (chapter) return { chapterId: chapter.id, instruction: text }
  }
  if (/这章|本章|这一章|当前章|全文|润色|改写|重写|克制|温柔一点|紧张一点|精简/.test(text) && project.chapters.length) {
    const active = project.chapters[0]
    return active ? { chapterId: active.id, instruction: text } : null
  }
  return null
}

export function draftEditPlan(project: StudioProject, text: string, ctx: IntentContext = {}): DraftPlan {
  const actions: StudioEditAction[] = []
  const effects: string[] = []
  let seconds = 0
  let cost: number | null = 0
  const noteLines: string[] = []
  const shot = targetShot(project, text, ctx)
  const wantsRewrite =
    /润色|改写|重写|克制|收一点|温柔|紧张|精简|扩写|换一种|语气|文风|结尾|开头|对话/.test(text) &&
    !/镜头|画面|视频|字幕|音量|速度|配音/.test(text)
  const chapter = wantsRewrite ? chapterTarget(project, text, ctx) : null
  if (chapter) {
    actions.push({ type: 'rewrite-chapter', chapterId: chapter.chapterId, instruction: chapter.instruction, text })
    effects.push('生成一版候选稿；采用前不改动正文，旧版本自动留档')
    seconds = 35
    cost = project.runtime.textModelNote && project.runtime.textModelNote !== '本地结构稿' ? null : 0
  }

  // 重新生成类：只排队，确认后执行。
  if (shot) {
    if (/重新生成|重做|再画|换个画面|换一张/.test(text) && /画面|分镜|图/.test(text)) {
      actions.push({ type: 'regenerate-shot-image', shotId: shot.id, instruction: text })
      effects.push(`重做第 ${shot.number} 镜画面，保留旧候选`)
      seconds += 60
      cost = null
    }
    if (/重新生成|重做|升级|生成/.test(text) && /视频|动态/.test(text)) {
      actions.push({ type: 'regenerate-shot-video', shotId: shot.id, instruction: text })
      effects.push(`把第 ${shot.number} 镜升级为视频，保留分镜图`)
      seconds += 120
      cost = null
    }
    if (/重新配音|重配|换.*声音|换.*声线/.test(text)) {
      actions.push({ type: 'regenerate-voice', shotId: shot.id, instruction: text })
      effects.push(`重新生成第 ${shot.number} 镜的配音`)
      seconds += 10
      cost = 0
    }
  }

  // 时间线类修改：只动具体片段。
  const timelineActionable = shot || ctx.selection?.kind === 'clip' || /镜\s*0?\d+|字幕|雨声|音乐|配乐|音量|速度|慢|快/.test(text)
  if (timelineActionable) {
    const clips = shot ? clipsForShot(project, shot.id) : []
    if (ctx.selection?.kind === 'clip') {
      const selected = project.timeline.clips.find((clip) => clip.id === ctx.selection?.id)
      if (selected && !clips.some((clip) => clip.id === selected.id)) clips.push(selected)
    }
    const speedPercent = percentFrom(text)
    if (/\d+\s*%|慢|快|加速|减速|速度/.test(text) && (shot || ctx.selection?.kind === 'clip')) {
      const slow = /慢|减速/.test(text)
      const fast = /快|加速/.test(text)
      const factor = speedPercent !== null ? (slow ? 1 - speedPercent / 100 : fast ? 1 + speedPercent / 100 : 1) : /一半/.test(text) ? 0.5 : slow ? 0.8 : fast ? 1.2 : 1
      const speed = Math.max(0.25, Math.min(4, Number(factor.toFixed(2))))
      if (speed !== 1) {
        for (const clip of clips.filter((item) => item.kind === 'video' || item.kind === 'dialogue')) {
          actions.push({ type: 'set-clip-speed', clipId: clip.id, value: speed })
        }
        if (!clips.length && shot) {
          // 尚未装配时间线时，先记到镜头时长上更符合直觉
          const nextDuration = Math.max(1, Number((shot.durationSec / speed).toFixed(1)))
          actions.push({ type: 'set-clip-duration', shotId: shot.id, value: nextDuration })
          effects.push(`第 ${shot.number} 镜时长调整为 ${nextDuration} 秒（按 ${speed}× 速度换算）`)
        } else {
          effects.push(`${shot ? `第 ${shot.number} 镜` : '所选片段'}速度 ${speed}×`)
        }
        seconds += 8
      }
    }
    const volumeIntent = /压低|降低|小一点|轻一点|调大|大一点|响一点|音量|声音/.test(text)
    if (volumeIntent) {
      const down = /压低|降低|小一点|轻一点|降/.test(text)
      const up = /调大|大一点|响一点|提高|升/.test(text)
      const factor = down ? 0.7 : up ? 1.25 : 1
      const wantsSfx = /雨声|音效|环境声|伞骨|心跳/.test(text)
      const wantsMusic = /音乐|配乐|钢琴|BGM/.test(text)
      const wantsVoice = /配音|对白|人声|台词/.test(text)
      const kindFor = (clip: StudioClip): boolean => {
        if (wantsSfx) return clip.kind === 'sfx'
        if (wantsMusic) return clip.kind === 'music'
        if (wantsVoice) return clip.kind === 'dialogue'
        return clip.kind === 'dialogue' || clip.kind === 'music' || clip.kind === 'sfx'
      }
      let targets = clips.filter(kindFor)
      if (!targets.length) {
        targets = project.timeline.clips.filter(kindFor)
      }
      // “雨声”只动雨声轨里带“雨”的片段，不连带伞骨和心跳。
      if (wantsSfx && /雨/.test(text)) {
        const rain = targets.filter((clip) => `${clip.label} ${project.assets.find((asset) => asset.id === clip.assetId)?.title ?? ''}`.includes('雨'))
        if (rain.length) targets = rain
      }
      for (const clip of targets) {
        actions.push({ type: 'set-clip-volume', clipId: clip.id, value: Number((clip.volume * factor).toFixed(2)) })
      }
      if (targets.length) effects.push(`${wantsSfx ? '音效' : wantsMusic ? '音乐' : wantsVoice ? '对白' : '音频'}音量${down ? '降低' : up ? '提高' : '调整'}`)
      else if (/雨声|音乐|音效|配音/.test(text)) noteLines.push('当前时间线里还没有对应的音频片段，无法直接调音量。')
      seconds += 5
    }
    if (/字幕/.test(text) && /上|高|下|低|挪|移/.test(text)) {
      const up = /上|高/.test(text)
      const subtitleClips = clips.filter((clip) => clip.kind === 'subtitle')
      for (const clip of subtitleClips) {
        const current = clip.style?.yPercent ?? 86
        actions.push({ type: 'set-subtitle-position', clipId: clip.id, value: Math.max(4, Math.min(94, current + (up ? -6 : 6))) })
      }
      if (subtitleClips.length) effects.push(`字幕${up ? '上移' : '下移'} 6%`)
      else noteLines.push('这一镜还没有字幕片段。')
      seconds += 4
    }
    if (/转场|淡入|淡出|硬切/.test(text)) {
      const transition = /硬切|不要转场|直接切/.test(text) ? 'cut' : /淡出/.test(text) ? 'fade-out' : /淡入/.test(text) ? 'fade-in' : 'fade-both'
      for (const clip of clips.filter((item) => item.kind === 'video')) {
        actions.push({ type: 'set-transition', clipId: clip.id, value: 0, text: transition })
      }
      if (clips.some((clip) => clip.kind === 'video')) effects.push(`画面转场改为${transition === 'cut' ? '硬切' : '淡入淡出'}`)
      seconds += 3
    }
    if (/时长|缩短|延长|短一点|长一点/.test(text) && shot) {
      const secondsMatch = /(\d+(?:\.\d+)?)\s*秒/.exec(text)
      const delta = secondsMatch ? Number(secondsMatch[1]) : 2
      const next = Math.max(1, shot.durationSec + (/延长|长/.test(text) ? delta : -delta))
      actions.push({ type: 'set-clip-duration', shotId: shot.id, value: next })
      effects.push(`第 ${shot.number} 镜时长改为 ${next} 秒`)
      seconds += 4
    }
  }

  if (/不要改脸|不改脸|脸不变|保持.*脸/.test(text) || /雨.*方向.*不|保持.*雨向/.test(text)) {
    actions.push({ type: 'lock-reference', ...(shot ? { shotId: shot.id } : {}), target: shot ? shot.id : 'shot', note: '保持角色脸与雨向，不修改参考' })
    effects.push('锁定角色面部与雨向，不纳入本次改动')
    noteLines.push('已把“不改脸 / 保持雨向”记为约束，重做时会写入提示词。')
  }

  if (actions.length === 0) {
    const help = project.kind === 'drama'
      ? '可以直接说：镜 03 慢 20%、雨声压低一点、字幕上移、重做镜 07 的画面、或“结尾更克制”。'
      : '可以直接说：第 3 章更克制一点、精简这一章、给第 5 章补一个细节，或者告诉我你想要的整体语气。'
    return {
      title: '还没有找到可执行的修改',
      summary: help,
      actions: [],
      effects: [],
      seconds: 0,
      cost: 0,
      note: help
    }
  }
  const uniqueActions = actions.filter((action, index, list) => {
    const key = `${action.type}:${action.clipId ?? action.chapterId ?? action.shotId ?? action.target}:${action.value ?? action.text ?? ''}`
    return list.findIndex((item) => `${item.type}:${item.clipId ?? item.chapterId ?? item.shotId ?? item.target}:${item.value ?? item.text ?? ''}` === key) === index
  })
  const uniqueEffects = [...new Set([...effects, ...noteLines])]
  const title = uniqueActions.some((action) => action.type === 'rewrite-chapter')
    ? '正文改写计划'
    : uniqueActions.some((action) => action.type === 'regenerate-shot-image' || action.type === 'regenerate-shot-video')
      ? '镜头重做计划'
      : '时间线修改计划'
  return {
    title,
    summary: uniqueEffects.join('；'),
    actions: uniqueActions,
    effects: uniqueEffects,
    seconds,
    cost,
    ...(noteLines.length ? { note: noteLines.join(' ') } : {})
  }
}

export interface ApplyPlanResult {
  project: StudioProject
  regenerate: Array<{ kind: 'image' | 'video' | 'voice'; shotId: string; instruction: string }>
  timelineChanged: boolean
  chapterCandidates: number
}

export function applyEditPlan(project: StudioProject, plan: StudioEditPlan): ApplyPlanResult {
  let timelineChanged = false
  let chapterCandidates = 0
  const regenerate: ApplyPlanResult['regenerate'] = []
  const snapshot = {
    id: studioId('tl'),
    createdAt: nowMs(),
    reason: `应用修改计划：${plan.title}`,
    tracks: project.timeline.tracks.map((track) => ({ ...track })),
    clips: project.timeline.clips.map((clip) => ({ ...clip, style: clip.style ? { ...clip.style } : undefined }))
  }
  const mutateClip = (clipId: string, mutate: (clip: StudioClip) => void): void => {
    const clip = project.timeline.clips.find((item) => item.id === clipId)
    if (!clip) return
    mutate(clip)
    timelineChanged = true
  }
  const lockNotes = (shotId: string): string[] =>
    plan.actions
      .filter((item) => item.type === 'lock-reference' && item.note && (!item.shotId || item.shotId === shotId))
      .map((item) => item.note as string)
  const withLockNotes = (shotId: string, instruction?: string): string =>
    [instruction?.trim(), ...lockNotes(shotId)].filter(Boolean).join('；')
  for (const action of plan.actions) {
    switch (action.type) {
      case 'set-clip-speed':
        if (action.clipId && typeof action.value === 'number') mutateClip(action.clipId, (clip) => { clip.speed = action.value as number })
        break
      case 'set-clip-volume':
        if (action.clipId && typeof action.value === 'number') mutateClip(action.clipId, (clip) => { clip.volume = action.value as number })
        break
      case 'set-subtitle-position':
        if (action.clipId && typeof action.value === 'number') mutateClip(action.clipId, (clip) => { clip.style = { ...(clip.style ?? {}), yPercent: action.value as number } })
        break
      case 'set-transition':
        if (action.clipId && action.text) {
          mutateClip(action.clipId, (clip) => {
            clip.transition = action.text === 'fade-in' || action.text === 'fade-out' || action.text === 'fade-both' ? action.text : 'cut'
          })
        }
        break
      case 'set-clip-duration':
        if (action.shotId && typeof action.value === 'number') {
          const shot = project.shots.find((item) => item.id === action.shotId)
          if (shot) {
            const previous = shot.durationSec
            shot.durationSec = action.value
            shot.updatedAt = nowMs()
            const delta = action.value - previous
            for (const clip of project.timeline.clips.filter((item) => item.shotId === shot.id)) {
              clip.duration = Math.max(0.1, clip.duration + delta)
            }
            // 后续镜头整体顺延，避免重叠
            if (action.shotId) {
              for (const other of project.timeline.clips) {
                if (other.start > (project.timeline.clips.find((item) => item.shotId === action.shotId)?.start ?? 0)) other.start = Math.max(0, other.start + delta)
              }
            }
            timelineChanged = true
          }
        }
        break
      case 'set-track-volume':
        if (action.trackId && typeof action.value === 'number') {
          const track = project.timeline.tracks.find((item) => item.id === action.trackId)
          if (track) {
            track.volume = action.value
            timelineChanged = true
          }
        }
        break
      case 'rewrite-chapter': {
        if (!action.chapterId) break
        const chapter = project.chapters.find((item) => item.id === action.chapterId)
        if (!chapter) break
        const base = chapter.content.trim() ? localRewrite(chapter.content, action.instruction ?? '') : localChapterDraft(project, chapter, action.instruction)
        const wordCount = countWords(base)
        chapter.candidates.unshift({
          id: studioId('cand'),
          content: base,
          label: '本地改写 · 待采用',
          source: 'local',
          note: action.instruction,
          createdAt: nowMs(),
          wordCount
        })
        chapter.candidates = chapter.candidates.slice(0, 8)
        chapter.updatedAt = nowMs()
        project.stages.writing = {
          status: 'review',
          updatedAt: nowMs(),
          message: `第 ${chapter.number} 章有 1 个候选待采用`,
          progress: 100
        }
        chapterCandidates += 1
        break
      }
      case 'regenerate-shot-image':
        if (action.shotId) regenerate.push({ kind: 'image', shotId: action.shotId, instruction: withLockNotes(action.shotId, action.instruction) })
        break
      case 'regenerate-shot-video':
        if (action.shotId) regenerate.push({ kind: 'video', shotId: action.shotId, instruction: withLockNotes(action.shotId, action.instruction) })
        break
      case 'regenerate-voice':
        if (action.shotId) regenerate.push({ kind: 'voice', shotId: action.shotId, instruction: withLockNotes(action.shotId, action.instruction) })
        break
      case 'lock-reference': {
        const shot = action.shotId ? project.shots.find((item) => item.id === action.shotId) : undefined
        if (shot) {
          shot.lockedReference = true
          const note = action.note?.trim()
          if (note && !shot.continuity.includes(note)) {
            shot.continuity = [shot.continuity, note].filter(Boolean).join('；')
          }
          shot.updatedAt = nowMs()
        }
        break
      }
      case 'noop':
        break
    }
  }
  if (timelineChanged) {
    project.timeline.snapshots = [...project.timeline.snapshots.slice(-19), snapshot]
    project.timeline.version += 1
    project.timeline.updatedAt = nowMs()
    project.timeline.durationSec = project.timeline.clips.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0)
    project.stages.timeline = { status: 'ready', updatedAt: nowMs(), message: '修改待预览/重合成', progress: 100 }
  }
  plan.status = 'applied'
  plan.appliedAt = nowMs()
  return { project, regenerate, timelineChanged, chapterCandidates }
}

export function createPlanFromDraft(projectId: string, draft: DraftPlan): StudioEditPlan {
  void projectId
  return {
    id: studioId('plan'),
    title: draft.title,
    summary: draft.summary,
    actions: draft.actions,
    effects: draft.effects,
    estimate: { seconds: draft.seconds, cost: draft.cost, ...(draft.note ? { note: draft.note } : {}) },
    status: 'pending',
    createdAt: nowMs()
  }
}

export function localAssistantReply(project: StudioProject, userText: string, plan: StudioEditPlan): { text: string; plan: StudioEditPlan } {
  if (!plan.actions.length) {
    return {
      text: `${plan.summary}\n\n${project.kind === 'drama' ? '也可以让我先检查一次连续性，或直接重做某一镜。' : '也可以让我先检查人物与事实，再决定改哪里。'}`,
      plan
    }
  }
  const lines = [
    `我把「${userText.replace(/\s+/g, ' ').slice(0, 60)}」整理成了 ${plan.actions.length} 个改动，先给你看计划，还没有改任何东西。`,
    ...plan.effects.map((effect) => `· ${effect}`),
    plan.estimate.cost === null ? '预计有模型费用，实际账单会记录在任务里。' : plan.estimate.cost > 0 ? `预计费用约 ¥${plan.estimate.cost}，以实际账单为准。` : '这一步只在本机执行，不产生模型费用。',
    '确认后再应用；应用后仍可撤销。'
  ]
  return { text: lines.join('\n'), plan }
}

export function contextForAssistant(project: StudioProject, selection?: IntentContext['selection']): string {
  const words = project.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0)
  const selectedChapter = selection?.kind === 'chapter' ? project.chapters.find((chapter) => chapter.id === selection.id) : undefined
  const selectedShot = selection?.kind === 'shot' ? project.shots.find((shot) => shot.id === selection.id) : undefined
  const selectedClip = selection?.kind === 'clip' ? project.timeline.clips.find((clip) => clip.id === selection.id) : undefined
  return [
    `作品：${project.title}（${project.kind}）`,
    `一句话：${project.logline}`,
    `阶段：${project.stage}；预算：¥${project.runtime.budget.spent} / ¥${project.runtime.budget.limit}`,
    project.kind === 'drama' ? `镜头：${project.shots.length}；已有画面：${project.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length}` : `章节：${project.chapters.length}；总字数：${words}`,
    selectedChapter ? `当前选中章节：第 ${selectedChapter.number} 章 ${selectedChapter.title}\n${selectedChapter.content.slice(-1200)}` : '',
    selectedShot ? `当前选中镜头：第 ${selectedShot.number} 镜 ${selectedShot.title}\n动作：${selectedShot.action}\n台词：${selectedShot.dialogue}` : '',
    selectedClip ? `当前选中片段：${selectedClip.label}（${selectedClip.start.toFixed(2)}s → ${(selectedClip.start + selectedClip.duration).toFixed(2)}s）` : '',
    `连续性事实：${project.facts.slice(0, 12).map((fact) => `${fact.subject}${fact.predicate}${fact.object}`).join('；')}`
  ]
    .filter(Boolean)
    .join('\n')
}

export function assistantSystemPrompt(kind: StudioProject['kind']): string {
  return [
    '你是 Morrow 创作台的协作者。你了解当前作品、当前阶段和预算。',
    '回答要具体、简短、可执行；不要编造作品里没有的设定。',
    kind === 'drama' ? '讨论镜头时使用镜号，尊重角色参考锁定、雨向与连续性。' : '讨论章节时使用章节号，尊重人物事实与手改稿。',
    '引用具体章节、镜头、人物或事实时写明“第 N 章 / 镜 NN / 人物名”，不要编造来源。',
    '如果用户要求修改，先说明会改什么、影响哪些下游；不要在未经确认时声称已经修改。',
    '不要使用 Markdown 表格。'
  ].join('\n')
}

/** 本次回答实际带上的作品上下文，用于界面展示与来源失效校验。 */
export function assistantSources(
  project: StudioProject,
  selection?: { kind: 'chapter' | 'shot' | 'clip'; id: string }
): StudioMessageSource[] {
  const sources: StudioMessageSource[] = []
  if (selection?.kind === 'chapter') {
    const chapter = project.chapters.find((item) => item.id === selection.id)
    if (chapter) sources.push({ kind: 'chapter', id: chapter.id, label: `第 ${chapter.number} 章 · ${chapter.title}` })
  }
  if (selection?.kind === 'shot') {
    const shot = project.shots.find((item) => item.id === selection.id)
    if (shot) sources.push({ kind: 'shot', id: shot.id, label: `镜 ${String(shot.number).padStart(2, '0')} · ${shot.title}` })
  }
  if (selection?.kind === 'clip') {
    const clip = project.timeline.clips.find((item) => item.id === selection.id)
    if (clip) sources.push({ kind: 'clip', id: clip.id, label: `片段 · ${clip.label}` })
  }
  if (project.facts.length) {
    sources.push({ kind: 'facts', id: 'facts', label: `连续性事实 ${project.facts.length} 条` })
  }
  return sources
}

export function assistantMessage(
  role: StudioChatMessage['role'],
  text: string,
  plan?: StudioEditPlan,
  sources?: StudioMessageSource[]
): StudioChatMessage {
  return {
    id: studioId('msg'),
    role,
    text,
    createdAt: nowMs(),
    ...(plan ? { plan } : {}),
    ...(sources?.length ? { sources } : {})
  }
}
