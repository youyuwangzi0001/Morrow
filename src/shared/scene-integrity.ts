// 画面完整性：帧数契约 + 任务归属核对。
//
// 两块都是「这一镜取回的东西能不能用」的判定，合并后同域一处维护：
//   · 帧数契约（C-01）：剪辑只能以实测帧数为时长来源，不足缩短、禁止补帧或放慢；
//   · 任务归属（C-09 / D-11）：按内容特征核对取回素材是否属于该镜，不符就暂停挂载。

// ==========================================================================
// 原 shared/frame-contract.ts
// ==========================================================================

// 帧数契约（C-01）：视频模型会按 latent 长度截断输出，请求 124 帧实出 90 帧是常态。
// 因此剪辑只能以实测帧数为时长来源；计划值仅作参考，不足时缩短计划，禁止补帧或放慢。

/** 实测帧数与帧率折算出的可用时长；缺数据时返回 undefined，调用方回退到计划值。 */
export function actualClipSeconds(frames?: number, fps?: number): number | undefined {
  if (!frames || !Number.isFinite(frames) || frames <= 0) return undefined
  if (!fps || !Number.isFinite(fps) || fps <= 0) return undefined
  return frames / fps
}

export interface FrameContract {
  /** 计划时长（秒）。 */
  plannedSec: number
  /** 实测可用时长（秒）；undefined 表示还没拿到真实帧数。 */
  actualSec?: number
  /** 剪辑应采用时长：有实测值取实测，没有则取计划值。 */
  usedSec: number
  /** 请求帧数；只在有请求记录时有值。 */
  requestedFrames?: number
  /** 实测帧数。 */
  frames?: number
  fps?: number
  /** 实测比计划短的秒数；为 0 表示不缺。 */
  shortfallSec: number
  /** 是否帧数不足，需要按实测缩短而不是补帧。 */
  truncated: boolean
  /** 超额时长（实测比计划长）；剪辑不会用超过计划的部分。 */
  surplusSec: number
}

/**
 * 计算一镜的帧数契约。
 * - 有实测帧数：usedSec 取 min(实测, 计划)，不足就缩短，超出就截断到计划时长。
 * - 无实测帧数：usedSec 取计划时长，且不判为 truncated（还没有证据，不能凭空报警）。
 */
export function resolveFrameContract(input: {
  plannedSec: number
  frames?: number
  fps?: number
  requestedFrames?: number
}): FrameContract {
  const plannedSec = Math.max(0, Number.isFinite(input.plannedSec) ? input.plannedSec : 0)
  const actualSec = actualClipSeconds(input.frames, input.fps)
  const base: FrameContract = {
    plannedSec,
    usedSec: plannedSec,
    shortfallSec: 0,
    truncated: false,
    surplusSec: 0,
    ...(actualSec !== undefined ? { actualSec } : {}),
    ...(input.requestedFrames ? { requestedFrames: input.requestedFrames } : {}),
    ...(input.frames ? { frames: input.frames } : {}),
    ...(input.fps ? { fps: input.fps } : {})
  }
  if (actualSec === undefined) return base
  const usedSec = Math.min(actualSec, plannedSec)
  const shortfallSec = Math.max(0, plannedSec - actualSec)
  return {
    ...base,
    usedSec,
    shortfallSec: Math.round(shortfallSec * 1000) / 1000,
    truncated: shortfallSec > 0.02,
    surplusSec: Math.round(Math.max(0, actualSec - plannedSec) * 1000) / 1000
  }
}

/** 把「秒」换算成时间线上安全的时长：保留三位小数，且不低于 0.1s。 */
export function safeClipSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0.1
  return Math.max(0.1, Math.round(seconds * 1000) / 1000)
}

// ==========================================================================
// 原 shared/shot-attribution.ts
// ==========================================================================

// 任务归属核对（C-09 / 缺陷 D-11）。
//
// 为什么不能靠编号：ComfyUI 的 filename_prefix 是固定的（morrow/video/morrow），
// 引擎只在后面追加全局递增序号 `_00009_`——这个序号是引擎的产出计数，
// 和我们的镜号毫无关系。落盘时 downloadOutput 又会用随机名重命名，
// 原始序号信息到这一步就丢了。所以「v_00009_ 被取回为 V08」这类错配是必然的，
// 不是偶然的手滑。
//
// 方案给的解法是「按内容核对归属」。能核对的特征都写在请求里或能从文件实测出来：
//   · 请求尺寸（width/height）vs 实测尺寸；
//   · 请求时长（video 的 seconds）vs 实测时长 / 帧数；
//   · 素材类型（video/image）vs 实测类型。
// 只要有一项明显不符，就不能把它静默挂到那一镜上——必须报出镜号与差异，让人决定。

/** 一次取回的期望特征（来自提交任务时的请求参数）。 */
export interface AttributionExpectation {
  /** 这一镜的编号，用于报错时指认 */
  shotNumber: number
  kind: 'image' | 'video'
  /** 请求的宽高（像素）；未知则不比对 */
  width?: number
  height?: number
  /** 请求时长（秒）；只有视频有 */
  seconds?: number
}

/** 实际取回文件的可测特征。 */
export interface AttributionActual {
  kind: 'image' | 'video'
  width?: number
  height?: number
  durationSec?: number
  frames?: number
  fps?: number
}

export interface AttributionIssue {
  /** 哪一项不符 */
  field: 'kind' | 'width' | 'height' | 'duration'
  /** 期望值 */
  expected: string
  /** 实际值 */
  actual: string
  /** 人可读说明 */
  detail: string
}

export interface AttributionResult {
  /** 归属是否可信 */
  trusted: boolean
  /** 不符项；trusted=true 时为空 */
  issues: AttributionIssue[]
  /** 给用户看的结论；trusted=true 时为空串 */
  message: string
}

/**
 * 尺寸容差：视频模型偶尔按 32 对齐微调，但不该差出一个档位。
 * 允许 32px 的差（一个 latent 块），超过就认为不是同一批次。
 */
const SIZE_TOLERANCE = 32

/**
 * 时长容差：请求 5s 实际出 3.7s 是模型常态（帧数不足），
 * 但不能少一半——那说明取回的是别的镜头的更短片段。
 */
const DURATION_TOLERANCE_RATIO = 0.45
const DURATION_TOLERANCE_MIN = 0.8

/**
 * 核对一次取回的归属。
 *
 * 判定原则：只在「明显不符」时才判不可信。宁可放过模糊情况，
 * 也不要因为模型正常抖动就把正确的结果拦下来——误杀会让用户反复重做，成本更高。
 */
export function checkAttribution(expectation: AttributionExpectation, actual: AttributionActual): AttributionResult {
  const issues: AttributionIssue[] = []

  if (actual.kind !== expectation.kind) {
    issues.push({
      field: 'kind',
      expected: expectation.kind,
      actual: actual.kind,
      detail: `取回的是${actual.kind === 'video' ? '视频' : '图片'}，这一镜要的是${expectation.kind === 'video' ? '视频' : '图片'}`
    })
  }

  const checkSize = (field: 'width' | 'height'): void => {
    const expected = expectation[field]
    const got = actual[field]
    if (!expected || !got) return
    if (Math.abs(expected - got) <= SIZE_TOLERANCE) return
    issues.push({
      field,
      expected: String(expected),
      actual: String(got),
      detail: `${field === 'width' ? '宽' : '高'} ${got}px，请求是 ${expected}px（差 ${Math.abs(expected - got)}px，超过 ${SIZE_TOLERANCE}px 容差）`
    })
  }
  checkSize('width')
  checkSize('height')

  if (expectation.kind === 'video' && expectation.seconds && actual.durationSec && actual.durationSec > 0) {
    const tolerance = Math.max(DURATION_TOLERANCE_MIN, expectation.seconds * DURATION_TOLERANCE_RATIO)
    if (Math.abs(expectation.seconds - actual.durationSec) > tolerance) {
      issues.push({
        field: 'duration',
        expected: `${expectation.seconds}s`,
        actual: `${actual.durationSec.toFixed(2)}s`,
        detail: `时长 ${actual.durationSec.toFixed(2)}s，请求 ${expectation.seconds}s（差 ${Math.abs(expectation.seconds - actual.durationSec).toFixed(2)}s，超过 ${tolerance.toFixed(2)}s 容差）`
      })
    }
  }

  if (!issues.length) return { trusted: true, issues: [], message: '' }

  return {
    trusted: false,
    issues,
    message:
      `第 ${expectation.shotNumber} 镜取回的内容与请求不符，归属存疑：${issues.map((issue) => issue.detail).join('；')}。` +
      '已暂停挂载，请核对后手动确认，避免把别的镜头结果装到这一镜上。'
  }
}

/**
 * 从一组「按提交顺序记录的目标」里，为一次取回找到最可能的归属。
 *
 * 只在有多个候选时才需要它：如果只有一个目标，归属本来就确定（无需推算）。
 * 多个候选时，用实测特征去匹配每一个候选的期望，选唯一匹配的那个；
 * 全都匹配或全都不匹配时，返回 null 让调用方走「归属存疑」路径——
 * 宁可让人确认，也不猜。
 */
export function pickMatchingTarget<T extends AttributionExpectation>(
  candidates: T[],
  actual: AttributionActual
): { pick: T | null; reason: 'single' | 'unique' | 'ambiguous' | 'none' } {
  if (candidates.length === 0) return { pick: null, reason: 'none' }
  if (candidates.length === 1) {
    // 单候选时仍要核对内容；不符也返回它，但由调用方按 checkAttribution 判定可信度
    return { pick: candidates[0], reason: 'single' }
  }
  const matched = candidates.filter((candidate) => checkAttribution(candidate, actual).trusted)
  if (matched.length === 1) return { pick: matched[0], reason: 'unique' }
  if (matched.length === 0) return { pick: null, reason: 'none' }
  return { pick: null, reason: 'ambiguous' }
}
