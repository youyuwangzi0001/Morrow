// 视频提示词：v4 骨架 + 中文适配层。
//
// 骨架结构来自方案第 06 章，顺序不可乱——顺序错了模型就抓不住重点：
//   段标题 → [SPATIAL LOCK] → [ENTRY STATE] → 四镜（时间码）→ [EXIT STATE] → 音频三行
//
// 为什么适配层也在这一文件（每条都是踩过的坑）：
//   · 中文裸奔：模型会把 <d> 之外的中文当台词念出来，成片里会突然冒出没人写过的中文念白；
//   · 写风格词：资产图已经定了风格，提示词里再说一遍只会打架，导致风格平均化；
//   · 写 Camera: locked：模型会照做，画面全死——「不要静止」只能靠每镜真的给一个带速度词的运镜；
//   · 不写音频三行：视频模型会自己配一段假语言人声。
//
// shot 的 action / camera / shotSize 是面向用户的中文编辑字段，进提示词前必须经适配层映射，
// 所以骨架与适配器放同一处维护：改骨架不会漏改适配层。
//
// 提示词基座（固定句、音频三行、英文术语与兜底句）内嵌在 prompt-kit.generated.ts。

import { loadPromptKit } from './prompt-kit'

// ==========================================================================
// 原 shared/prompt-v4.ts
// ==========================================================================

// 上面那段说明同时覆盖这两部分：骨架来自方案第 06 章，适配层是踩坑记录。
// 合并时原本各有一份，现在只保留文件头那一份，避免两处描述漂移。

/** 一个镜头的输入。 */
export interface PromptShot {
  /** 景别，英文（如 Medium Close-Up） */
  shotSize: string
  /** 带速度词的运镜，英文（如 slow push in） */
  cameraMove: string
  /** 画面与动作，英文 */
  action: string
  /** 台词（中文原文）；有台词时会被包进 <d>[Chinese]…</d> */
  dialogue?: string
  /** 说话人，英文名（如 The Man） */
  speaker?: string
  /** 台词前的语气描述，英文（如 low and level） */
  tone?: string
}

/** 一段（4 镜 / 10 秒）的输入。 */
export interface PromptSegment {
  /** 段序号，从 1 开始 */
  index: number
  /** 总段数 */
  total: number
  /** 英文段标题（如 The Half-Dismantled Canopy） */
  title: string
  /** 空间关系：角色站位（英文），全剧一字不改 */
  spatialLock: Array<{ name: string; side: 'LEFT' | 'RIGHT'; facing: 'LEFT' | 'RIGHT' }>
  /** 段落中间的道具（英文），可选 */
  centreProp?: string
  /** 上一段的 EXIT STATE 原句（逐字） */
  entryState: string
  /** 最多 4 镜 */
  shots: PromptShot[]
  /** 本段结束时的状态（英文一句话） */
  exitState: string
  /** 环境音清单（英文） */
  soundscape: string
}

/** 音频三行固定结尾。内容来自内嵌提示词基座，源码里不保留明文。 */
export const AUDIO_LINES = loadPromptKit().v4.audioLines as {
  soundscapeSuffix: string
  music: string
  noSubtitles: string
}

/** 提示词骨架里的固定句（段标题、空间锁、切镜、台词包装），含 {占位符}。 */
export const PROMPT_LINES = loadPromptKit().v4.lines

/** 镜头切换时间码：4 镜 / 10 秒，第 1 镜从 0 开始，之后 2.5s 切一次。 */
export const SHOT_CUT_SECONDS = [0, 2.5, 5, 7.5] as const

/** 把秒数格式化成 00:02.500。 */
export function formatTimecode(seconds: number): string {
  const whole = Math.floor(seconds)
  const ms = Math.round((seconds - whole) * 1000)
  const minutes = Math.floor(whole / 60)
  const secs = whole % 60
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** 各角色的默认朝向：站在左边就朝右看，反之亦然。 */
function facingFor(side: 'LEFT' | 'RIGHT'): 'LEFT' | 'RIGHT' {
  return side === 'LEFT' ? 'RIGHT' : 'LEFT'
}

/** 用 {name} 占位符填充内嵌模板。 */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match
  )
}

/** 拼装 v4 提示词。 */
export function buildV4Prompt(segment: PromptSegment): string {
  const L = PROMPT_LINES
  const lines: string[] = []
  lines.push(fill(L.segmentHeader, { index: segment.index, total: segment.total, title: segment.title }))
  lines.push(L.spatialLock)
  for (const actor of segment.spatialLock) {
    const facing = actor.facing ?? facingFor(actor.side)
    lines.push(fill(L.actorLock, { name: actor.name, side: actor.side, facing }))
  }
  if (segment.centreProp) lines.push(fill(L.centreProp, { prop: segment.centreProp }))
  lines.push(L.eyeLine)
  lines.push(L.entryState)
  lines.push(segment.entryState)

  const shots = segment.shots.slice(0, 4)
  shots.forEach((shot, index) => {
    const head =
      index === 0
        ? L.shotHead
        : fill(L.cut, {
            timecode: formatTimecode(SHOT_CUT_SECONDS[index] ?? index * 2.5),
            shotSize: shot.shotSize,
            cameraMove: shot.cameraMove
          })
    if (index === 0) {
      lines.push(`${head} ${fill(L.shotBodyFirst, { shotSize: shot.shotSize, cameraMove: shot.cameraMove, action: shot.action })}`)
    } else {
      lines.push(`${head} ${shot.action}`)
    }
    if (shot.dialogue?.trim()) {
      const speaker = shot.speaker ?? L.defaultSpeaker
      const tone = shot.tone ? `, ${shot.tone}` : ''
      lines.push(fill(L.dialogue, { speaker, tone, text: shot.dialogue.trim() }))
    }
  })

  lines.push(L.exitState)
  lines.push(segment.exitState)
  lines.push(fill(L.soundscape, { soundscape: segment.soundscape, suffix: AUDIO_LINES.soundscapeSuffix }))
  lines.push(AUDIO_LINES.music)
  lines.push(AUDIO_LINES.noSubtitles)
  return lines.join('\n')
}

/** 一项验收结果。 */
export interface PromptCheck {
  /** 检查项 id */
  id: string
  /** 级别：error 会阻断，warn 只提示 */
  level: 'error' | 'warn'
  /** 是否通过 */
  ok: boolean
  /** 不通过时的说明 */
  detail: string
}

/**
 * 中文边界扫描：找出 `<d>[Chinese]…</d>` 之外的所有中文。
 *
 * 这是最关键的一道检查。模型会把 <d> 之外的中文当台词念出来，
 * 所以任何一个漏在外面的汉字都会变成成片里突然出现的中文念白。
 * 返回每一处违规的位置与片段，便于定位修改。
 */
export function scanChineseBoundary(prompt: string): Array<{ index: number; text: string; context: string }> {
  const violations: Array<{ index: number; text: string; context: string }> = []
  // 先把合法的 <d>[Chinese]…</d> 区间整体挖掉，剩下的中文就是裸奔
  const masked = prompt.replace(/<d>\[Chinese\][\s\S]*?<\/d>/g, (match) => ' '.repeat(match.length))
  const chinese = /[\u4e00-\u9fff]+/g
  let match: RegExpExecArray | null
  while ((match = chinese.exec(masked)) !== null) {
    const index = match.index
    violations.push({
      index,
      text: match[0],
      context: prompt.slice(Math.max(0, index - 30), Math.min(prompt.length, index + match[0].length + 30)).replace(/\n/g, '⏎')
    })
  }
  return violations
}

/** 四条禁令：写进提示词会直接坏事的东西。 */
const FORBIDDEN_PATTERNS: Array<{ id: string; pattern: RegExp; detail: string; level: 'error' | 'warn' }> = [
  {
    id: 'no-style-lock',
    pattern: /STYLE\s*LOCK|CHARACTER\s*LOCK|REFERENCE\s*MATERIALS/i,
    detail: '提示词里出现 STYLE LOCK / CHARACTER LOCK / REFERENCE MATERIALS：与资产图打架，会导致风格平均化',
    level: 'error'
  },
  {
    id: 'no-picture-tag',
    pattern: /@图片\d+|<Picture\s*\d+>/i,
    detail: '提示词里出现 @图片N 或 <Picture N>：模型不解析这类引用，只会当成文字',
    level: 'error'
  },
  {
    id: 'no-camera-locked',
    pattern: /Camera:\s*locked|No\s+pan,?\s*no\s+orbit|static\s+camera\s+throughout/i,
    detail: '提示词里写 Camera: locked / No pan, no orbit：模型会照做，画面全死。要用带速度词的运镜表达「不要静止」',
    level: 'error'
  }
]

/**
 * 14 项验收：把 v4 结构、四必写、四条禁令、中文边界做成可机器判定的检查。
 *
 * 编号对应方案第 06 章的硬要求；error 级别的不通过即视为提示词不合格。
 */
export function validateV4Prompt(prompt: string): PromptCheck[] {
  const checks: PromptCheck[] = []
  const push = (id: string, level: 'error' | 'warn', ok: boolean, detail: string): void => {
    checks.push({ id, level, ok, detail: ok ? '' : detail })
  }

  // ---- 结构：顺序不可乱 ----
  const order = ['# Segment', '[SPATIAL LOCK]', '[ENTRY STATE]', '[Shot 1]', '[EXIT STATE]', 'overall_soundscape:']
  const positions = order.map((token) => prompt.indexOf(token))
  push('E01-segment-title', 'error', positions[0] >= 0, '缺少英文段标题（# Segment N/M - Title）')
  push('E02-spatial-lock', 'error', positions[1] >= 0, '缺少 [SPATIAL LOCK] 段')
  push('E03-entry-state', 'error', positions[2] >= 0, '缺少 [ENTRY STATE] 段（必须是上一段 EXIT 的逐字原文）')
  push('E04-first-shot', 'error', positions[3] >= 0, '缺少 [Shot 1]')
  push('E05-exit-state', 'error', positions[4] >= 0, '缺少 [EXIT STATE] 段')
  push('E06-audio-soundscape', 'error', positions[5] >= 0, '缺少 overall_soundscape 音频行')
  const ordered = positions.every((value, index) => index === 0 || value > positions[index - 1])
  push('E07-structure-order', 'error', positions.every((value) => value >= 0) && ordered, '段落顺序不符合 v4 骨架：标题 → SPATIAL LOCK → ENTRY STATE → Shot → EXIT STATE → 音频')

  // ---- 四镜 + 时间码 ----
  const cutCount = (prompt.match(/At \d{2}:\d{2}\.\d{3}, the camera cuts to a /g) ?? []).length
  push('E08-four-shots', 'error', cutCount === 3, `应有 3 个切镜时间码（4 镜 / 10 秒），实际 ${cutCount} 个`)
  const timecodes = [...prompt.matchAll(/At (\d{2}:\d{2}\.\d{3})/g)].map((match) => match[1])
  const expected = SHOT_CUT_SECONDS.slice(1).map((seconds) => formatTimecode(seconds))
  const timecodesOk = timecodes.length === 3 && timecodes.every((value, index) => value === expected[index])
  push('E09-timecode-exact', 'error', timecodesOk, `时间码必须是 ${expected.join(' / ')}，实际 ${timecodes.join(' / ') || '无'}`)

  // ---- 四必写：音频三行 ----
  push('E10-audio-three-lines', 'error', prompt.includes(AUDIO_LINES.music) && prompt.includes(AUDIO_LINES.noSubtitles) && prompt.includes(AUDIO_LINES.soundscapeSuffix), '音频三行不完整：需要 overall_soundscape、non_diegetic_music: N/A、No subtitles 三行齐全')

  // ---- 中文边界 ----
  const violations = scanChineseBoundary(prompt)
  push(
    'E11-chinese-boundary',
    'error',
    violations.length === 0,
    `有 ${violations.length} 处中文在 <d>[Chinese]</d> 之外（会被模型当台词念出来）：${violations.slice(0, 3).map((item) => `「${item.text}」`).join('、')}`
  )

  // ---- 四条禁令 ----
  for (const rule of FORBIDDEN_PATTERNS) {
    push(rule.id, rule.level, !rule.pattern.test(prompt), rule.detail)
  }

  // ---- 运镜必须带速度词（warn：不阻断，但要求改） ----
  const speedWord = /slow|fast|rapid|gentle|steady|quick|deliberate|glacial|sudden|smooth/i
  push('W12-camera-speed-word', 'warn', speedWord.test(prompt), '运镜缺少速度词（slow / fast / rapid 等）：没有速度词的运镜容易变成静帧')

  // ---- 空间锁必须写明不换位 ----
  push('W13-spatial-lock-complete', 'warn', /Eye-line never swaps/i.test(prompt) && /ALWAYS on the (LEFT|RIGHT)/i.test(prompt), 'SPATIAL LOCK 缺少「站位/视线不互换」的固定句')

  // ---- EXIT STATE 必须是一句话（不能空） ----
  const exitAt = prompt.indexOf('[EXIT STATE]')
  const afterExit = exitAt >= 0 ? prompt.slice(exitAt + '[EXIT STATE]'.length, prompt.indexOf('overall_soundscape:', exitAt)).trim() : ''
  push('W14-exit-state-filled', 'warn', afterExit.length > 0, '[EXIT STATE] 是空的：下一段的 ENTRY STATE 需要逐字复用它')

  return checks
}

/** 是否有阻断级问题。 */
export function promptHasErrors(checks: PromptCheck[]): boolean {
  return checks.some((check) => !check.ok && check.level === 'error')
}

// ==========================================================================
// 原 shared/prompt-v4-adapter.ts
// ==========================================================================

// shot → v4 段落适配层（BATCH 1 的一部分）。
//
// 为什么需要它：项目里 shot 的 action / camera / shotSize 是**中文**（面向用户的编辑字段），
// 而 v4 骨架要求视频提示词正文用英文、中文只能出现在 <d>[Chinese]</d> 内。
// 直接把中文塞进去会立刻触发中文裸奔（成片里冒出没人写过的中文念白），
// 所以必须在这一层做映射，而不是在拼装处拼字符串。

// 英文术语与兜底句属于提示词基座，内嵌在 prompt-kit.generated.ts；
// 这里只保留「怎么识别中文」的部分（正则），术语按同序从内嵌包取。
const KIT = loadPromptKit()

/** 景别中英映射。中文是项目里实际在用的写法，英文是模型能稳定识别的术语。 */
const SHOT_SIZE_MAP: Array<{ pattern: RegExp; en: string }> = [
  /大特写|extremely close/i,
  /特写|close[- ]?up|CU/i,
  /中近景|medium close/i,
  /中景|medium shot|MS/i,
  /中全景|medium wide/i,
  /全景|wide shot|WS/i,
  /远景|大远景|extreme wide|long shot/i,
  /过肩|over[- ]?the[- ]?shoulder|OTS/i
].map((pattern, index) => ({ pattern, en: KIT.adapter.shotSizes[index] }))

/** 运镜中英映射；每条都带速度词，因为 v4 要求「不要静止」靠速度词表达。 */
const CAMERA_MOVE_MAP: Array<{ pattern: RegExp; en: string }> = [
  /推近|推|push[- ]?in/i,
  /拉开|拉远|拉|pull[- ]?back|pull[- ]?out/i,
  /摇镜|横摇|摇|pan/i,
  /升降|crane|升降台/i,
  /跟拍|跟随|track|tracking/i,
  /手持|晃动|handheld|shake/i,
  /环绕|orbit/i,
  /固定|静止|static|locked/i
].map((pattern, index) => ({ pattern, en: KIT.adapter.cameraMoves[index] }))

/** 动作要素线索：中文关键词 → 可进提示词的英文句子（只描述「怎么动」，不改剧情）。 */
const ACTION_CUES: Array<{ pattern: RegExp; en: string }> = [
  /反着|反向|倒着|逆转|倒流/,
  /水珠|雨|滴水|流水/,
  /灯|光|反光|泛出/,
  /拆开|拆|解开|分开/,
  /张开|撑开|展开|打开/,
  /收拢|收起|合上|收/,
  /站|立|靠在/,
  /转身|回头|看向|望向/,
  /走向|走近|靠近|上前/,
  /停|悬|静止|定格/,
  /滴落|落下|坠/,
  /颤动|抖|震/
].map((pattern, index) => ({ pattern, en: KIT.adapter.cues[index] }))

/**
 * 英文兜底句：中文描述无法安全搬运时用它们，保证提示词结构不缺口。
 * 集中在一处，避免散落在函数体里各写一份。
 */
const FALLBACKS = KIT.adapter.fallbacks as {
  shotSize: string
  cameraMove: string
  action: string
  entryState: string
  exitState: string
  soundscape: string
  speaker: string
  tone: string
}

/** 找到景别的英文术语；认不出时给一个安全的中景（不要返回空，否则提示词结构会破）。 */
export function mapShotSize(chinese: string): string {
  const text = chinese.trim()
  if (!text) return FALLBACKS.shotSize
  for (const entry of SHOT_SIZE_MAP) {
    if (entry.pattern.test(text)) return entry.en
  }
  return FALLBACKS.shotSize
}

/**
 * 找到运镜的英文表述。
 * 注意：「固定镜头」映射为 `steady hold with slight drift` 而不是 `static`——
 * v4 明确禁止 Camera: locked 这类写法（模型会照做，画面全死），
 * 但用户说「固定」时其实是想要稳定，所以给一个带轻微漂移的稳定运镜。
 */
export function mapCameraMove(chinese: string): string {
  const text = chinese.trim()
  if (!text) return FALLBACKS.cameraMove
  for (const entry of CAMERA_MOVE_MAP) {
    if (entry.pattern.test(text)) return entry.en
  }
  return FALLBACKS.cameraMove
}

/** 判断一段文本里是否含中文（用于决定是否需要翻译兜底）。 */
export function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

/**
 * 把中文动作描述转成可进提示词的英文。
 * 关键取舍：本项目没有内置翻译模型，不能凭空「翻译」用户的创作描述——
 * 所以这里只搬运**可安全搬运的成分**：数字、英文片段、以及从中文里识别出的
 * 结构化画面要素（运动方向、主体数量、状态变化），其余原样丢弃。
 * 宁可提示词朴素，也不要编一段用户没写过的剧情 —— 那会让画面偏离意图，
 * 而用户完全不知道是哪个环节加的戏。
 *
 * 认不出任何要素时返回 `fallback`（由调用方给一段通用但如实的描述），
 * 重要的是不能所有镜头都退化成同一句——那会让 4 个镜头描述完全一样，
 * 生成的画面也就一模一样，等于整段废掉。
 */
export function mapAction(chinese: string, fallback: string): string {
  const text = chinese.trim()
  if (!text) return fallback
  if (!hasChinese(text)) return text
  // 可安全搬运：数字、拉丁字母
  const latin = text.replace(/[\u4e00-\u9fff，。、；：！？「」『』（）]/g, ' ').replace(/\s+/g, ' ').trim()
  const detail = describeActionContent(text)
  const base = detail || fallback
  return latin ? `${base} ${latin}` : base
}

/**
 * 从中文动作里识别可转成英文的画面要素。
 * 不做逐字翻译，只挑模型能用的结构性线索：运动方向、主体数量、状态变化。
 * 这些都是「怎么动」，不是「讲了什么」，所以即使映射得粗也不会歪曲剧情。
 */
function describeActionContent(text: string): string {
  const cues: string[] = []
  for (const entry of ACTION_CUES) {
    if (entry.pattern.test(text)) cues.push(entry.en)
  }
  if (!cues.length) return ''
  // 最多取 2 条，避免句子过长丢掉节奏
  return cues.slice(0, 2).map((cue) => `${cue.charAt(0).toUpperCase()}${cue.slice(1)}.`).join(' ')
}

/** 适配输入：一个镜头 + 它所属段的上下文。 */
export interface ShotLike {
  number: number
  action: string
  camera: string
  shotSize: string
  dialogue: string
  speaker: string
  continuity: string
}

export interface SegmentContext {
  index: number
  total: number
  title: string
  /** 角色站位；不传时按单一主角占左侧处理 */
  spatialLock?: Array<{ name: string; side: 'LEFT' | 'RIGHT' }>
  entryState?: string
  exitState?: string
  soundscape?: string
  centreProp?: string
}

/** 说话人名字转英文：中文名保留在台词里，提示词正文用中性称呼。 */
function speakerName(chinese: string, index: number): string {
  const text = chinese.trim()
  if (!text) return `${FALLBACKS.speaker} ${index + 1}`
  if (!hasChinese(text)) return text
  // 中文人名不进正文（会触发中文裸奔），用中性称呼 + 序号
  return `${FALLBACKS.speaker} ${index + 1}`
}

/**
 * 把一个镜头转换成 v4 的 PromptShot。
 * 台词原样放进 dialogue 字段，由 buildV4Prompt 包进 <d>[Chinese]</d>——
 * 这是全篇唯一允许出现中文的位置。
 */
export function toPromptShot(shot: ShotLike, index: number): PromptShot {
  return {
    shotSize: mapShotSize(shot.shotSize),
    cameraMove: mapCameraMove(shot.camera),
    action: mapAction(shot.action, FALLBACKS.action),
    ...(shot.dialogue.trim() ? { dialogue: shot.dialogue.trim() } : {}),
    ...(shot.dialogue.trim() ? { speaker: speakerName(shot.speaker, index) } : {}),
    ...(shot.dialogue.trim() ? { tone: FALLBACKS.tone } : {})
  }
}

/**
 * 把一组镜头（通常是同一场戏的连续几镜）拼成 v4 段落。
 * 段落结构要求「ENTRY STATE 必须是上一段 EXIT 的逐字原文」，
 * 关于镜头数：v4 骨架是「4 镜 / 10 秒」，但用户可能只有 1–3 镜。
 */
export function buildSegmentFromShots(shots: ShotLike[], context: SegmentContext): PromptSegment {
  const spatialLock = (context.spatialLock ?? [{ name: 'The Protagonist', side: 'LEFT' as const }]).map((actor) => ({
    name: actor.name,
    side: actor.side,
    facing: (actor.side === 'LEFT' ? 'RIGHT' : 'LEFT') as 'LEFT' | 'RIGHT'
  }))
  return {
    index: context.index,
    total: context.total,
    title: context.title,
    spatialLock,
    ...(context.centreProp ? { centreProp: context.centreProp } : {}),
    entryState: context.entryState ?? (shots[0]?.continuity.trim() || FALLBACKS.entryState),
    shots: shots.slice(0, 4).map((shot, index) => toPromptShot(shot, index)),
    exitState: context.exitState ?? FALLBACKS.exitState,
    soundscape: context.soundscape ?? FALLBACKS.soundscape
  }
}

/** 段落是否需要补足 4 镜（用于给用户明确提示，而不是偷偷糊弄）。 */
export function shotsNeededForV4(count: number): number {
  return Math.max(0, 4 - count)
}

