// C-08 配乐校验（纯逻辑层）。
//
// 要解决的真实问题（方案通病三 / R-04）：配乐模型一旦生成人声，会输出不属于
// 任何语言的音节。配乐贯穿全片，破坏力远大于单镜。所以配乐必须**纯器乐**。
//
// 声明句与乐器编制属于提示词基座，内嵌在 prompt-kit.generated.ts。

import { loadPromptKit } from './prompt-kit'
//
// 两道防线（方案 FIX-13 + 频段检测）：
//   1. 声明层：不用「无人声」这种否定式，改为**正向描述乐器编制**
//      （felt piano / cello drone / brushed ride），并在结尾加
//      `strictly instrumental, no vocals of any kind`。正向描写比否定约束更有效。
//   2. 检测层：生成后比「语音频段 vs 全频段」的响度差。
//
// 关于阈值的规格矛盾（已实测确认，如实登记）：
//   方案正文写「语音频段与全频段差 <2dB 判有人声」，
//   但同一段实测记录写「三集配乐差 1.1dB，通过」。两句无法同时成立：
//   1.1 < 2，按判据应判有人声，按记录却是通过。
//   本实现以台账验收口径为准——**差 > 2dB 才放行**，因为它是明确的出口条件。
//   代价是方案的实测样本（1.1dB）按本判据会被拦下。
//   这个代价是可接受的：频段检测本身只能筛「明显有人声」（方案原话），
//   器乐里的中频（弦乐、钢琴）同样会抬高语音频段，实测钢琴式器乐只有 0.3dB。
//   所以这道门禁宁可误拦、交人核对，也不放行一条真的带人声的全片配乐。

/** 语音频段下限：人声基频与低次共振峰的起点。 */
export const VOICE_BAND_LOW_HZ = 300

/** 语音频段上限：高于此频段基本是人声的齿音与泛音，能量不集中。 */
export const VOICE_BAND_HIGH_HZ = 3400

/**
 * 放行阈值：全频段与语音频段的响度差必须 > 2dB。
 *
 * 直观理解：人声能量集中在 300–3400Hz，所以带人声的素材在语音频段
 * 掉得很少（差值小）；低频为主的纯器乐会掉很多（差值大）。
 */
export const VOCAL_DIFF_THRESHOLD_DB = 2

/** 配乐必须显式声明的英文约束句（正向 + 明确排除人声）。内容来自内嵌提示词基座。 */
export const INSTRUMENTAL_DECLARATION = loadPromptKit().music.declaration

/**
 * 乐器编制词表：正向描述用。
 * 这些是方案点名的例子（felt piano / cello drone / brushed ride），
 * 加上同一类气质的具体乐器，便于按情绪拼装。内容来自内嵌提示词基座。
 */
export const INSTRUMENT_PALETTE: Record<string, string[]> = loadPromptKit().music.palette

/** 判定结果。 */
export interface VocalBandVerdict {
  /** 全频段 mean_volume（dB） */
  fullDb: number | null
  /** 语音频段 mean_volume（dB） */
  bandDb: number | null
  /** 全频 − 语音（dB）；正值表示语音频段衰减得更多 */
  diffDb: number | null
  /** 判定：vocal = 疑似有人声，instrumental = 通过，unknown = 测不出 */
  verdict: 'vocal' | 'instrumental' | 'unknown'
  /** 人可读说明，带实测数值 */
  reason: string
}

/**
 * 由两段响度判定是否疑似有人声。
 *
 * 全频 − 语音 > 2dB → 通过；≤ 2dB → 疑似有人声。
 * 「测不出」独立成 unknown，绝不与「通过」混为一谈——
 * 把无法检测报成通过会让人以为配乐已经过关。
 */
export function judgeVocalBand(fullDb: number | null, bandDb: number | null): VocalBandVerdict {
  if (fullDb === null || bandDb === null || !Number.isFinite(fullDb) || !Number.isFinite(bandDb)) {
    return { fullDb, bandDb, diffDb: null, verdict: 'unknown', reason: '读不到响度，无法判定配乐里有没有人声' }
  }
  const diff = Math.round((fullDb - bandDb) * 10) / 10
  if (diff > VOCAL_DIFF_THRESHOLD_DB) {
    return {
      fullDb,
      bandDb,
      diffDb: diff,
      verdict: 'instrumental',
      reason: `全频 ${fullDb}dB / 语音频段 ${bandDb}dB，差 ${diff}dB > ${VOCAL_DIFF_THRESHOLD_DB}dB，判为纯器乐`
    }
  }
  return {
    fullDb,
    bandDb,
    diffDb: diff,
    verdict: 'vocal',
    reason: `全频 ${fullDb}dB / 语音频段 ${bandDb}dB，差 ${diff}dB ≤ ${VOCAL_DIFF_THRESHOLD_DB}dB，疑似有人声（配乐里出现人声会变成假语言）`
  }
}

/** 一条声明检查结果。 */
export interface DeclarationCheck {
  ok: boolean
  /** 缺什么 / 有什么问题 */
  missing: string[]
  /** 说明 */
  reason: string
}

/**
 * 检查配乐 caption 的纯器乐声明。
 *
 * 三件事都要有：
 *   1. 明确的英文收尾句 `strictly instrumental, no vocals of any kind`；
 *   2. 至少一个**正向**乐器编制描述（felt piano / cello drone 之类）；
 *   3. 不能只靠否定式（「无人声」「no voice」）——方案明确指出正向描写更有效。
 */
export function checkInstrumentalDeclaration(caption: string): DeclarationCheck {
  const text = caption.trim()
  const missing: string[] = []

  if (!text) {
    return { ok: false, missing: ['整段 caption 为空'], reason: '配乐提示词是空的，必须写明乐器编制与纯器乐声明' }
  }

  const hasDeclaration = /strictly instrumental/i.test(text) && /no vocals/i.test(text)
  if (!hasDeclaration) missing.push(`缺少声明句「${INSTRUMENTAL_DECLARATION}」`)

  const lower = text.toLowerCase()
  const instruments = Object.values(INSTRUMENT_PALETTE).flat()
  const hasInstrument = instruments.some((name) => lower.includes(name.toLowerCase()))
  if (!hasInstrument) missing.push('缺少正向乐器编制描述（如 felt piano / cello drone / brushed ride）')

  // 只写否定式不够：这类提示词没有告诉模型「要什么」，只有「不要什么」
  const onlyNegative = /无人声|no\s+vocals?/i.test(text) && !hasInstrument
  if (onlyNegative) missing.push('只有否定式约束，没有正向描述乐器编制')

  const ok = missing.length === 0
  return {
    ok,
    missing,
    reason: ok ? '纯器乐声明完整：有正向乐器编制与英文收尾句' : `纯器乐声明不完整：${missing.join('；')}`
  }
}

/**
 * 拼装配乐 caption：正向乐器编制 + 固定英文收尾句。
 *
 * 方案 FIX-13 的做法是「不用无人声这种否定式，改为正向描述乐器编制」，
 * 所以这里按情绪给出具体乐器，再追加统一声明句。
 */
export function buildInstrumentalCaption(mood: string, extra?: string): string {
  const palette = INSTRUMENT_PALETTE[mood] ?? INSTRUMENT_PALETTE.warm
  const lead = palette.slice(0, 3).join(', ')
  const tail = palette.slice(3).join(', ')
  const body = `Sparse ${lead}${tail ? `, with ${tail}` : ''}`
  const custom = extra?.trim() ? ` ${extra.trim()}` : ''
  return `${body}.${custom} ${INSTRUMENTAL_DECLARATION}.`
}

/** 配乐审计总结果。 */
export interface MusicAudit {
  /** 声明检查 */
  declaration: DeclarationCheck
  /** 频段判定 */
  band: VocalBandVerdict
  /** 是否放行：声明完整且频段判定不是 vocal */
  passed: boolean
  /** 说明 */
  reason: string
}

/** 综合审计：声明层 + 检测层。 */
export function auditMusicTrack(caption: string, fullDb: number | null, bandDb: number | null): MusicAudit {
  const declaration = checkInstrumentalDeclaration(caption)
  const band = judgeVocalBand(fullDb, bandDb)
  // 声明不完整也拦：没有正向描述的配乐，模型更容易往里加人声
  const passed = declaration.ok && band.verdict === 'instrumental'
  const problems: string[] = []
  if (!declaration.ok) problems.push(declaration.reason)
  if (band.verdict === 'vocal') problems.push(band.reason)
  if (band.verdict === 'unknown') problems.push(band.reason)
  return {
    declaration,
    band,
    passed,
    reason: passed
      ? `配乐通过：${declaration.reason}；${band.reason}`
      : problems.join('；')
  }
}