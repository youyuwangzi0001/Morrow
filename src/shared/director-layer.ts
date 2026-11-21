// 导演层：镜头设计约束 + 时长规划。
//
// 分镜「怎么切」与「给多久」是同一件事的两面，合并后同域一处维护：
//   · 镜头设计：景别链、首镜禁空镜、动作-反应镜配对；
//   · 时长规划：段数 = 台词句数 ÷ 3，按情绪四节拍分配，全等长视为催眠效应。
//
// 这里只有**有数据来源**的判定。「导演四问」与「由剧本直建分镜表」曾一并放在
// 本文件，但作品数据里既没有四问字段/UI，分镜也只允许走模型生成，
// 接线等于接一个永远为空的判据，故连同登记项一并删除（详见 analysis §10.1 的复盘）。

// ==========================================================================
// 原 shared/director-layer.ts
// ==========================================================================

// BATCH 2 导演层（纯逻辑层）。
//
// 解决的真实问题（方案出处 28·一）：缺少导演层，镜头没意义。
// 核心观念：「剧本是发生了什麼，分镜是观众怎么看它发生」。
// 同一个剧本，运镜不同，观感差一个量级。
//
// 这一层把三套内嵌方法里的描述性要求，落成可机器判定的检查：
//   导演四问 → 没想清就切分镜＝机器分镜
//   景别链   → 每段走 WS→CU→MS→MCU，禁连续 2 镜同景别（治「相邻镜景别相同像 PPT」）
//   前 5 秒  → 段 1 镜 1 禁静开场/空镜开场
//   动作-反应 → 每段尾镜建议为反应镜（剪掉反应镜，信息就断了）
//
// 为什么景别链不能靠随机：随机打散能过「禁连续同景别」的字面检查，但会丢掉
// 创作意图——反应镜本来就该用近景。所以景别由「段落节拍 + 是否反应镜」推导。

/** 景别等级（由远到近），用于判断「景别差 ≥1 级」。 */
export const SHOT_SIZE_ORDER = ['EWS', 'WS', 'MS', 'MCU', 'CU', 'ECU'] as const

/** 景别类型。 */
export type ShotSize = (typeof SHOT_SIZE_ORDER)[number]

/** 景别的中文名，用于给用户看的说明。 */
export const SHOT_SIZE_LABELS: Record<ShotSize, string> = {
  EWS: '大远景',
  WS: '全景',
  MS: '中景',
  MCU: '中近景',
  CU: '特写',
  ECU: '大特写'
}

/**
 * 景别枚举 → 中文名。
 *
 * 作品里 `shot.shotSize` 存的是给用户看的人话，导演层用的是离散枚举，
 * 两者必须严格互逆（`directorShotSize(shotSizeLabel(size)) === size`）。
 * 这个映射此前在 `main/studio.ts` 里内联复制过一份，改一处忘另一处就会出现
 * 「界面写大远景、审核按全景判」的错位，所以只留这一份。
 */
export function shotSizeLabel(size: ShotSize): string {
  return SHOT_SIZE_LABELS[size]
}

/**
 * 中文景别 → 景别枚举（`shotSizeLabel` 的反向）。
 *
 * 只认能确定的前缀，认不出来返回 null —— 调用方据此跳过该镜，
 * 而不是猜一个景别让审计给出假结论。
 *
 * 判定顺序不能调换：先 `中近景` 再 `中景`、先 `大远景` 再 `远景`，
 * 否则子串匹配会把「中近景」误判成中景、「大远景」误判成全景，
 * 景别差一级就等于把「像 PPT」的结论判反。
 */
export function directorShotSize(raw: string): ShotSize | null {
  const text = raw.trim()
  if (!text) return null
  if (text.includes('大远景')) return 'EWS'
  if (text.includes('大特写')) return 'ECU'
  if (text.includes('中近景')) return 'MCU'
  if (text.includes('特写')) return 'CU'
  if (text.includes('远景') || text.includes('全景')) return 'WS'
  if (text.includes('中景')) return 'MS'
  return null
}

/**
 * 方案规定的景别链模板：每段走 WS→CU→MS→MCU。
 *
 * 这个顺序不是随手排的：从全景建立空间，切到特写抓情绪，
 * 再用中景交代关系，最后中近景落在反应上。四镜正好覆盖一段 10 秒。
 */
export const SHOT_SIZE_CHAIN: ShotSize[] = ['WS', 'CU', 'MS', 'MCU']

/** 一镜的导演设计。 */
export interface DirectedShot {
  /** 镜序号，从 1 开始 */
  number: number
  /** 景别 */
  shotSize: ShotSize
  /** 带速度词的运镜（英文） */
  cameraMove: string
  /** 这一镜演什么（动作） */
  action: string
  /** 是否为反应镜（对上一条动作的情绪反应） */
  reaction: boolean
}

/** 一段的导演设计。 */
export interface DirectedSegment {
  /** 段序号 */
  index: number
  /** 段落节拍 */
  beat: 'bun' | 'fan' | 'bao' | 'shuang'
  /** 本段镜头 */
  shots: DirectedShot[]
}

/** 一条导演层问题。 */
export interface DirectorIssue {
  level: 'error' | 'warn'
  /** 问题代码，便于测试锁定 */
  code: string
  /** 说明，必须能定位到段/镜 */
  message: string
}


/** 两个景别相差几级。 */
export function shotSizeDistance(a: ShotSize, b: ShotSize): number {
  return Math.abs(SHOT_SIZE_ORDER.indexOf(a) - SHOT_SIZE_ORDER.indexOf(b))
}

/**
 * 生成一段的景别链。
 * 规则：
 * 1. 按 [SHOT_SIZE_CHAIN] 模板循环取（WS→CU→MS→MCU，从全景建立空间、
 *    切特写抓情绪，不是随手排的）；
 * 2. **反应镜至少中近景** —— 全景/远景看不清脸，反应镜放远景等于没有反应；
 * 3. **禁止连续同景别** —— 撞上时往后推一档（[SHOT_SIZE_ORDER] 里 +1），
 *    这是「别像 PPT」在执行层的唯一保障。
 */
export function buildShotSizeChain(count: number, options: { reactionIndices?: number[] } = {}): ShotSize[] {
  const total = Math.max(1, Math.min(6, count))
  const reactions = new Set((options.reactionIndices ?? []).map((index) => index))
  const chain: ShotSize[] = []
  for (let index = 0; index < total; index += 1) {
    let candidate = SHOT_SIZE_CHAIN[index % SHOT_SIZE_CHAIN.length]
    // 反应镜至少中近景：全景/远景看不清脸部反应
    if (reactions.has(index) && (candidate === 'WS' || candidate === 'EWS')) candidate = 'MCU'
    // 禁连续同景别
    if (index > 0 && candidate === chain[index - 1]) {
      const nextIndex = Math.min(SHOT_SIZE_ORDER.length - 1, SHOT_SIZE_ORDER.indexOf(candidate) + 1)
      candidate = SHOT_SIZE_ORDER[nextIndex]
    }
    chain.push(candidate)
  }
  return chain
}

/**
 * 审计景别链。
 *
 * 核心一条：**连续 2 镜同景别报 WARN**（方案原话「同景别相邻即 WARN」），
 * 因为那正是「像 PPT」的成因。
 */
export function auditShotSizeChain(shots: DirectedShot[]): DirectorIssue[] {
  const issues: DirectorIssue[] = []
  for (let index = 1; index < shots.length; index += 1) {
    const previous = shots[index - 1]
    const current = shots[index]
    if (previous.shotSize === current.shotSize) {
      issues.push({
        level: 'warn',
        code: 'adjacent-same-size',
        message: `第 ${previous.number} 镜与第 ${current.number} 镜都是${SHOT_SIZE_LABELS[current.shotSize]}（${current.shotSize}），相邻景别相同会像 PPT`
      })
      continue
    }
    // 三十度原则：机位差 ≥30° 或景别差 ≥1 级。景别已不同，这里只提示「景别差为 0 级」的反面
    if (shotSizeDistance(previous.shotSize, current.shotSize) === 0) {
      issues.push({
        level: 'warn',
        code: 'no-size-difference',
        message: `第 ${previous.number} 镜与第 ${current.number} 镜景别差 0 级，不满足三十度原则`
      })
    }
  }
  return issues
}

/** 一个按段落组织的分镜表。 */
export interface StoryboardTable {
  segments: DirectedSegment[]
}

/**
 * 审计整张分镜表。
 *
 * 覆盖方案里四条可判定标准：
 *   ① 首镜不得为 ELS/EWS 空镜（前 5 秒定生死）；
 *   ② 连续 2 镜同景别 → WARN；
 *   ③ 每段应含反应镜（动作-反应单元，剪掉反应信息就断了）；
 *   ④ 出彩镜占比 25–35%（运镜不能全是常规）。
 */
export function auditStoryboard(table: StoryboardTable): DirectorIssue[] {
  const issues: DirectorIssue[] = []

  const firstShot = table.segments[0]?.shots[0]
  if (!firstShot) {
    issues.push({ level: 'error', code: 'empty-table', message: '分镜表是空的，无法审核' })
    return issues
  }
  // ① 前 5 秒定生死：首镜不能是远景空镜
  if (firstShot.shotSize === 'EWS' || firstShot.shotSize === 'WS') {
    issues.push({
      level: 'error',
      code: 'weak-opening',
      message: `首镜是${SHOT_SIZE_LABELS[firstShot.shotSize]}（${firstShot.shotSize}），属于静开场/空镜开场。前 5 秒定生死，首镜必须是强冲突或大动势，换近一点的景别或加主体动作。`
    })
  }

  // ② 景别链
  for (const segment of table.segments) {
    const chainIssues = auditShotSizeChain(segment.shots)
    issues.push(...chainIssues.map((issue) => ({ ...issue, message: `段 ${segment.index}：${issue.message}` })))

    // ③ 每段应含反应镜
    if (!segment.shots.some((shot) => shot.reaction)) {
      issues.push({
        level: 'warn',
        code: 'no-reaction-shot',
        message: `段 ${segment.index} 没有反应镜。动作-反应单元必须成对出现：只有动作，观众不知道该有什么感受。建议把尾镜改成反应镜。`
      })
    }
  }

  // ④ 出彩镜占比：方案要求 25–35%
  const all = table.segments.flatMap((segment) => segment.shots)
  if (all.length >= 4) {
    const showy = all.filter((shot) => isShowyMove(shot.cameraMove)).length
    const ratio = showy / all.length
    if (ratio < 0.25) {
      issues.push({
        level: 'warn',
        code: 'few-showy-shots',
        message: `出彩镜只有 ${showy}/${all.length}（${Math.round(ratio * 100)}%），低于 25%。全是常规运镜会显得平，需要几镜更有想法的运动。`
      })
    } else if (ratio > 0.35) {
      issues.push({
        level: 'warn',
        code: 'too-many-showy-shots',
        message: `出彩镜 ${showy}/${all.length}（${Math.round(ratio * 100)}%），超过 35%。出彩镜需要标准镜反衬，全是花活反而没有重点。`
      })
    }
  }

  return issues
}

/** 出彩运镜的判定：这些是「有想法」的运动，区别于普通推拉摇移。 */
const SHOWY_MOVES = /whip|crash zoom|dolly zoom|orbit|handheld|rack focus|crane|sweeping|arc shot|vertigo/i

/** 判断一个运镜是否属于「出彩镜」。 */
export function isShowyMove(cameraMove: string): boolean {
  return SHOWY_MOVES.test(cameraMove)
}

/**
 * 标记反应镜。
 */
export function markReactionShots(
  segment: { index: number; beat: DirectedSegment['beat']; shots: Array<Omit<DirectedShot, 'reaction' | 'number'> & { dialogue?: string }> },
  focus: string
): DirectedSegment {
  const shots: DirectedShot[] = segment.shots.map((shot, index) => ({
    number: index + 1,
    shotSize: shot.shotSize,
    cameraMove: shot.cameraMove,
    action: shot.action,
    reaction: false
  }))

  let marked = false
  for (let index = 0; index < segment.shots.length; index += 1) {
    const hasDialogue = Boolean(segment.shots[index].dialogue?.trim())
    const next = index + 1
    if (hasDialogue && next < shots.length && !segment.shots[next].dialogue?.trim() && !shots[next].reaction) {
      shots[next].reaction = true
      marked = true
    }
  }
  // 没有可配对的反应镜时，用尾镜作情绪落点
  if (!marked && shots.length) {
    shots[shots.length - 1].reaction = true
  }
  void focus
  return { index: segment.index, beat: segment.beat, shots }
}

/** 从情绪节拍推导运镜池：文戏与动作戏分开，这是方案要求的「运镜池分两池」。 */
export function cameraMovesForBeat(beat: DirectedSegment['beat']): { standard: string[]; showy: string[] } {
  switch (beat) {
    case 'bao':
      // 爆发：动作池为主
      return {
        standard: ['slow push in', 'steady lateral track', 'quick pan'],
        showy: ['whip pan', 'crash zoom', 'handheld with impact shake']
      }
    case 'fan':
      // 反转：需要认知冲击
      return {
        standard: ['slow pull back', 'steady hold with slight drift'],
        showy: ['dolly zoom', 'rack focus']
      }
    case 'shuang':
      // 爽：兑现，稳一点但要有力
      return {
        standard: ['slow push in', 'steady crane down'],
        showy: ['slow orbit']
      }
    default:
      // 憋：铺垫，文戏池
      return {
        standard: ['slow push in', 'gentle lateral track', 'steady hold with slight drift'],
        showy: ['slow orbit', 'rack focus']
      }
  }
}

// ==========================================================================
// 原 shared/duration-planner.ts
// ==========================================================================

// C-07 时长规划器（纯逻辑层）。
//
// 要解决的真实问题：所有分镜时长一致＝催眠效应。方案原话是
// 「段长不齐是禁区：全等长 = 催眠效应 = 观众划走」，这是行业样本量出来的结论。
//
// 为什么不能靠随机抖动凑「非等长」：那只是数字上不相等，观众照样被固定的
// 节奏催眠。真正的非等长必须来自**内容本身**——
//   · 台词句数决定这一段要承载多少信息（段数 = 句数 ÷ 3）；
//   · 情绪节拍决定节奏密度（憋要慢、爆发要快）。
// 两者相乘才是可信的时长分布，这也是本模块全部计算的依据。

/** 情绪四节拍。顺序不可颠倒：憋 → 反转 → 爆发 → 爽。 */
export type Beat = 'bun' | 'fan' | 'bao' | 'shuang'

/**
 * 各节拍的时长系数：慢铺垫要长，爆发要短。
 * 这些倍数不是为了「凑出差异」而编的——憋（铺垫）本就该给足呼吸，
 * 爆发（顶点）本就该短促，反过来会让节奏垮掉。
 */
export const BEAT_PACING: Record<Beat, number> = {
  bun: 1.25,
  fan: 0.85,
  bao: 0.7,
  shuang: 0.95
}

/** 台词单句字数上限：超过 20 字配音塞不进 2.5 秒。 */
export const MAX_LINE_CHARS = 20

/** 行业基线：台词均长 8.7 字（中位，区间 7–11）。 */
export const BASELINE_AVG_CHARS = 8.7

/** 每段承载的台词句数：方案公式「段数 = 台词句数 ÷ 3」。 */
export const LINES_PER_SEGMENT = 3

/** 单镜时长上下界（与项目里 StudioShot.durationSec 的约束一致）。 */
export const MIN_SHOT_SECONDS = 2.5
export const MAX_SHOT_SECONDS = 12

/** 一句台词。 */
export interface DialogueLine {
  /** 说话人 */
  speaker: string
  /** 台词原文 */
  text: string
  /** 所属情绪节拍；不传时按出现顺序推断 */
  beat?: Beat
}

/**
 * 切句：把一段台词文本切成句子。
 *
 * 中文的句读比英文复杂：除了 。！？，还要处理「……」和引号内的句号。
 * 只按 。！？；切会把「他说：『走。』」切成两半，所以引号内的句读先保护起来。
 */
export function splitDialogueSentences(text: string): string[] {
  const source = text.trim()
  if (!source) return []
  const sentences: string[] = []
  let buffer = ''
  // 引号深度：在引号内的句读不切
  let depth = 0
  const openQuote = /[「『“"（(]/
  const closeQuote = /[」』”"）)]/
  const isStop = (char: string): boolean => /[。！？；;!?]/.test(char)
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    buffer += char
    if (openQuote.test(char)) depth += 1
    else if (closeQuote.test(char)) depth = Math.max(0, depth - 1)
    if (depth > 0 || !isStop(char)) continue
    // 连续句读（「？！」「……」）要一起吞掉，否则会切出只有一个标点的空句
    while (index + 1 < source.length && isStop(source[index + 1])) {
      index += 1
      buffer += source[index]
    }
    // 「……」这类省略号按单句收尾，不再额外切
    const trimmed = buffer.trim()
    if (trimmed) sentences.push(trimmed)
    buffer = ''
  }
  const tail = buffer.trim()
  if (tail) sentences.push(tail)
  return sentences
}

/** 统计台词句数（C-07 的核心输入）。 */
export function countDialogueSentences(lines: DialogueLine[]): number {
  return lines.reduce((total, line) => total + splitDialogueSentences(line.text).length, 0)
}

/** 单句平均字数。 */
export function averageLineChars(lines: DialogueLine[]): number {
  const sentences = lines.flatMap((line) => splitDialogueSentences(line.text))
  if (!sentences.length) return 0
  // 只数中文字符与字母数字，标点不计入「字数」
  const total = sentences.reduce((sum, sentence) => sum + sentence.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length, 0)
  return Math.round((total / sentences.length) * 100) / 100
}

/** 段落时长规划结果。 */
export interface SegmentPlan {
  /** 段序号，从 1 开始 */
  index: number
  /** 本段承载的台词句数 */
  lines: number
  /** 本段情绪节拍 */
  beat: Beat
  /** 本段总时长（秒） */
  durationSec: number
  /** 段内每镜时长（秒）；镜数按台词承载量决定，2–4 镜 */
  shotDurations: number[]
}

/** 时长规划总结果。 */
export interface DurationPlan {
  /** 段落列表 */
  segments: SegmentPlan[]
  /** 全片总时长（秒） */
  totalSec: number
  /** 各段时长是否非等长 */
  varied: boolean
  /** 单句平均字数 */
  averageChars: number
  /** 超过 20 字的句子数 */
  overlongLines: number
  /** 规划依据的可读说明 */
  reason: string
}

/**
 * 把候选节拍序列补齐成合法序列（憋→反转→爆发→爽，且爆发前 ≥2 次憋）。
 *
 * 默认补全的取舍：早期版本按 `['bun','bun','fan','bao','shuang']` 循环，
 * 结果前两段都是「憋」——节拍相同则时长必然相同，直接撞上「相邻段等长」的告警。
 * 现在改为按位置交错分配：先把「憋」铺在开头两段（满足爆发前 ≥2 次憋），
 * 之后依次给反转、爆发、爽，再循环。这样既能满足节拍铁律，也不会让相邻段撞车。
 */
export function normalizeBeats(beats: Beat[], segmentCount: number): Beat[] {
  const pattern: Beat[] = ['bun', 'bun', 'fan', 'bao', 'shuang', 'bun', 'fan', 'bao', 'shuang']
  const result: Beat[] = []
  for (let index = 0; index < segmentCount; index += 1) {
    const given = beats[index]
    result.push(given ?? pattern[index % pattern.length])
  }
  return result
}

/** 把秒数规整到 0.25 秒粒度，并夹在单镜上下界内。
 *
 * 为什么是 0.25 而不是 0.5：0.5 粒度会把同节拍相邻段之间的小幅递进
 * （几个百分点的时长差）全部抹平，导致「相邻段等长」——实测 12.5s 与 13.25s
 * 两段在 0.5 粒度下都会得到 2.5/3/3.5/4。0.25 是项目里既能被剪辑器表达、
 * 又足够细的档位。
 */
function roundShot(seconds: number): number {
  const clamped = Math.max(MIN_SHOT_SECONDS, Math.min(MAX_SHOT_SECONDS, seconds))
  return Math.round(clamped * 4) / 4
}

/**
 * 规划全片时长。
 * 1. 句数决定段落数（每段至多 [LINES_PER_SEGMENT] 句），末段吃余数；
 * 2. 段总时长 = 基准 × 节拍系数 × 句数承载量 × 位置递进；
 * 3. 段内 4 镜按节拍内部分配 —— 同一段里也不能四镜等长，
 * 否则段内仍然是 PPT。给一个由节拍决定的递减/递增分布；
 * 4. 兜底：若段内仍算出全等长（都撞到 0.5s 粒度下限），
 * 让后面的镜依次 +0.5s，保证至少有一处可感知的差异。
 *
 * 「位置递进」（段序号每段 +6%）解决的是一个真实问题：同一节拍连续两段
 * 且句数相同时，只按节拍算会得到一模一样的时长，直接撞上「相邻段等长」。
 * 铺垫本就该一段比一段更紧，所以按段序号给一个收敛系数。
 */
export function planDurations(lines: DialogueLine[], options: { beats?: Beat[]; shotSeconds?: number } = {}): DurationPlan {
  const sentences = countDialogueSentences(lines)
  const averageChars = averageLineChars(lines)
  const overlongLines = countOverlongLines(lines)

  const segmentCount = Math.max(1, Math.ceil(sentences / LINES_PER_SEGMENT))
  const beats = normalizeBeats(options.beats ?? [], segmentCount)
  const baseShot = options.shotSeconds ?? 2.5

  const segments: SegmentPlan[] = []
  let remaining = sentences
  for (let index = 0; index < segmentCount; index += 1) {
    const beat = beats[index]
    // 前段优先吃满 3 句，末段处理余数
    const slice = Math.min(LINES_PER_SEGMENT, Math.max(remaining, 0))
    const assignedLines = index === segmentCount - 1 ? Math.max(remaining, 1) : slice
    remaining -= assignedLines

    const pacing = BEAT_PACING[beat]
    // 段内镜数按台词承载量决定，不硬塞 4 镜：
    // 只承载 1 句台词的段落给 4 镜会导致每镜都撞到 2.5s 下限，
    // 段内反而变成全等长（正是要避免的 PPT 感）。
    const shotCount = assignedLines >= LINES_PER_SEGMENT ? 4 : assignedLines >= 2 ? 3 : 2
    // 段内按节拍给一个「不均匀」的权重分布。
    // 憋段逐步收紧（越来越慢），爆发段逐步加速，这样段内也不会像 PPT。
    const weights = (beat === 'bao' ? [1.15, 0.95, 0.8, 0.65] : beat === 'bun' ? [0.8, 0.95, 1.05, 1.2] : [1.1, 0.9, 1.0, 0.85]).slice(0, shotCount)
    const weightSum = weights.reduce((sum, value) => sum + value, 0)
    // 本段总时长 = 基准 × 节拍系数 × 句数承载量 × 位置递进
    // 位置递进解决一个真实问题：同节拍（如前两段都是「憋」）且句数相同时，
    // 只按节拍算会得到完全相同的时长，直接撞上「相邻段等长」。
    // 铺垫本就该一段比一段更紧（观众越来越难受），所以按段序号给一个收敛系数。
    const lineFactor = 0.7 + (assignedLines / LINES_PER_SEGMENT) * 0.3
    const drift = 1 + index * 0.06
    const segmentTotal = baseShot * shotCount * pacing * lineFactor * drift
    const shotDurations = weights.map((weight) => roundShot((segmentTotal * weight) / weightSum))
    // 段内有镜数 ≥2 时不能落到全等长：0.5 秒粒度下若全都撞到下限（或全都相同），
    // 就在上限允许范围内让后面的镜依次多 0.5s，保证至少有一个可感知的差异。
    if (shotDurations.length >= 2 && new Set(shotDurations.map((value) => value.toFixed(1))).size === 1) {
      for (let index = 1; index < shotDurations.length; index += 1) {
        shotDurations[index] = roundShot(shotDurations[index] + 0.5 * index)
      }
    }
    const total = Math.round(shotDurations.reduce((sum, value) => sum + value, 0) * 10) / 10

    segments.push({
      index: index + 1,
      lines: assignedLines,
      beat,
      durationSec: total,
      shotDurations
    })
  }

  const durations = segments.map((segment) => segment.durationSec)
  const unique = new Set(durations.map((value) => value.toFixed(1)))
  const varied = unique.size > 1 || segments.length === 1

  return {
    segments,
    totalSec: Math.round(durations.reduce((sum, value) => sum + value, 0) * 10) / 10,
    varied,
    averageChars,
    overlongLines,
    reason: buildReason(sentences, segmentCount, varied, durations)
  }
}

function buildReason(sentences: number, segmentCount: number, varied: boolean, durations: number[]): string {
  const range = durations.length ? `段长 ${Math.min(...durations).toFixed(1)}–${Math.max(...durations).toFixed(1)}s` : ''
  const spread = varied ? '非等长' : '等长（只有 1 段时视为正常）'
  return `${sentences} 句台词 → ${segmentCount} 段（${LINES_PER_SEGMENT} 句/段），${spread}${range ? '，' + range : ''}`
}

/** 一个问题记录。 */
export interface DurationIssue {
  level: 'error' | 'warn'
  /**
   * 问题代码，便于门禁与测试锁定。
   *
   * 加这个字段不是为了「统一命名」，而是因为门禁登记表按 code 核对覆盖：
   * 靠 message 正则匹配的接线一改文案就会静默失效，而失效时门禁显示「通过」。
   */
  code: string
  /** 说明，必须能定位到段号 */
  message: string
}

/**
 * 审计时长规划。
 *
 * 最重要的一条：**全等长必须报 error**——这是方案的「禁区」，
 * 不是审美偏好。观众会在固定节奏里失去注意力。
 *
 * 全等长要同时满足「段内有落差」与「段间全平」：只有 3 段以上的成片才可能
 * 让人感到节拍器，而段内已经长短不一时，段间撞车只是轻微重复。
 */
export function auditDurationPlan(plan: DurationPlan): DurationIssue[] {
  const issues: DurationIssue[] = []

  if (plan.segments.length >= 3 && !plan.varied) {
    issues.push({
      level: 'error',
      code: 'uniform-duration',
      message: `全片 ${plan.segments.length} 段时长都是 ${plan.segments[0]?.durationSec.toFixed(1)}s，属于「全等长＝催眠效应」，必须按情绪节拍重新分配`
    })
  }

  // 相邻段同样长：比全等长轻，但仍然像节拍器
  const adjacentSame: string[] = []
  for (let index = 1; index < plan.segments.length; index += 1) {
    const previous = plan.segments[index - 1]
    const current = plan.segments[index]
    if (Math.abs(previous.durationSec - current.durationSec) < 0.05) {
      adjacentSame.push(`段 ${previous.index} 与段 ${current.index} 都是 ${current.durationSec.toFixed(1)}s`)
    }
  }
  if (adjacentSame.length && adjacentSame.length < plan.segments.length) {
    issues.push({
      level: 'warn',
      code: 'adjacent-same-duration',
      message: `相邻段时长相同：${adjacentSame.slice(0, 3).join('；')}。换一个节拍或调一句台词就能拉开`
    })
  }

  if (plan.overlongLines > 0) {
    issues.push({
      level: 'warn',
      code: 'overlong-line',
      message: `${plan.overlongLines} 句台词超过 ${MAX_LINE_CHARS} 字，配音塞不进 2.5 秒的镜头，建议拆句或缩短`
    })
  }

  if (plan.averageChars > 0 && (plan.averageChars < 7 || plan.averageChars > 11)) {
    issues.push({
      level: 'warn',
      code: 'average-chars',
      message: `台词均长 ${plan.averageChars} 字，超出行业基线区间 7–11（中位 ${BASELINE_AVG_CHARS}）`
    })
  }

  return issues
}

/**
 * 由成片实际镜头时长构造 `DurationPlan`，供出包门禁审计。
 *
 * 为什么不直接调 `planDurations`：那会按台词重新「规划」一份时长，审的是
 * 规划器的计算，不是用户真正要出的这批东西。门禁要回答的是「这一版能不能出包」，
 * 所以必须拿 `shot.durationSec` 的实测值当依据，规划器只提供 judge 逻辑。
 *
 * 按场景分段（与导演层的「一段一个节拍」一致）：段内是同一场戏的连续镜头，
 * 段间才有「相邻段撞车」的意义。所有镜头都归进 `bun`——作品里没有情绪节拍
 * 字段，编不出来源就如实标成同一个节拍，让 `auditBeatSequence` 那类判定
 * 不会凭假设给出「顺序颠倒」的假结论（该判定已因此删除）。
 *
 * 认不出景别、`durationSec <= 0` 的镜头直接跳过：它们不参与时长审计，
 * 免得把「没填时长」误判成「等长」。
 */
export function durationPlanFromShots(
  shots: Array<{ sceneId?: string; durationSec: number; dialogue?: string }>
): DurationPlan {
  const usable = shots
    .map((shot) => ({ ...shot, durationSec: Math.round((shot.durationSec || 0) * 10) / 10 }))
    .filter((shot) => shot.durationSec > 0)

  const byScene = new Map<string, number[]>()
  for (const shot of usable) {
    const key = shot.sceneId || 'scene-0'
    const list = byScene.get(key)
    if (list) list.push(shot.durationSec)
    else byScene.set(key, [shot.durationSec])
  }

  const segments: SegmentPlan[] = []
  for (const durations of byScene.values()) {
    const total = Math.round(durations.reduce((sum, value) => sum + value, 0) * 10) / 10
    segments.push({
      index: segments.length + 1,
      lines: 0,
      beat: 'bun',
      durationSec: total,
      shotDurations: durations
    })
  }

  const totals = segments.map((segment) => segment.durationSec)
  const dialogues = usable.map((shot) => (shot.dialogue ?? '').trim()).filter(Boolean)
  const lines: DialogueLine[] = dialogues.map((text) => ({ speaker: '', text }))

  return {
    segments,
    totalSec: Math.round(totals.reduce((sum, value) => sum + value, 0) * 10) / 10,
    // 只有 1 段时不存在「段间等长」，与 planDurations 的口径保持一致
    varied: new Set(totals.map((value) => value.toFixed(1))).size > 1 || segments.length <= 1,
    averageChars: averageLineChars(lines),
    overlongLines: countOverlongLines(lines),
    reason: `按成片 ${usable.length} 镜实际时长分 ${segments.length} 段`
  }
}

/** 超过台词单句字数上限的句子数，与 `planDurations` 的统计口径一致。 */
function countOverlongLines(lines: DialogueLine[]): number {
  return lines.reduce(
    (total, line) =>
      total +
      splitDialogueSentences(line.text).filter(
        (sentence) => sentence.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length > MAX_LINE_CHARS
      ).length,
    0
  )
}

