// 画面勘验：接缝/静帧审计 + 内嵌字幕检测。
//
// 两者都从抽帧算起，输入同一批像素，合并后同域一处维护：
//   · 接缝审计：每镜抽首/中/末帧算 MD5 + PSNR，相邻镜比对，判静帧与接缝重复；
//   · 内嵌字幕：三帧投票判画面下部是否有高对比文字带（烧进画面的字幕无法外挂替换）。

// ==========================================================================
// 原 shared/seam-audit.ts
// ==========================================================================

// C-06 接缝与静帧审计器（纯逻辑层）。
//
// 为什么需要机器判定：接缝重复与静帧此前靠人工逐帧看，30 镜的片子看不完，
// 用户的真实反馈是「有几镜像剧照」，但具体哪一镜、哪一秒说不清。
//
// 判据来自方案：
//   · 每镜抽首/中/末帧，算 MD5 + PSNR；
//   · 相邻镜「上镜末帧 ↔ 下镜首帧」比对 —— 这是接缝；
//   · PSNR > 30dB 判近似静帧/重复（方案实测 30 镜首末帧 PSNR 全部 < 30dB，
//     区间 8.4–18.1dB，所以 30dB 是经过真实样本校准的线，不是拍脑袋定的）。

/** 抽帧位置（相对镜时长比例）。方案要求首/中/末。 */
export const SAMPLE_POSITIONS = [0, 0.5, 1] as const

/** PSNR 判重阈值：超过即判近似静帧/重复。 */
export const PSNR_DUPLICATE_THRESHOLD = 30

/** 一个镜头的三帧采样结果。 */
export interface ShotFrameSample {
  /** 帧序号位置：start / middle / end */
  position: 'start' | 'middle' | 'end'
  /** 该帧时间点（秒，相对整片） */
  atSeconds: number
  /** 像素数据 MD5；抽帧失败时为 null */
  md5: string | null
  /** 灰度像素（用于算 PSNR）；抽帧失败时为空 */
  pixels?: Uint8Array
  /** 图像宽高 */
  width?: number
  height?: number
}

/** 一镜的审计输入。 */
export interface ShotSampleSet {
  /** 镜号（面向用户，通常从 1 开始） */
  number: number
  /** 素材标识（文件名或 assetId） */
  assetId: string
  /** 该镜在时间线上的起点（秒），用于把时间点报成整片时间 */
  startSeconds: number
  /** 该镜时长（秒） */
  durationSeconds: number
  /** 三帧采样 */
  samples: ShotFrameSample[]
}

/** 一条问题记录。 */
export interface SeamIssue {
  /** 类型 */
  kind: 'still' | 'duplicate-frame' | 'seam-repeat' | 'sample-missing'
  /** error 会在出片前阻断，warn 只提示 */
  level: 'error' | 'warn'
  /** 人可读说明，必须带镜号与时间点 */
  message: string
  /** 涉及镜号 */
  shots: number[]
  /** 首个相关时间点（秒，整片时间） */
  atSeconds: number
  /** PSNR 值（能算出来时） */
  psnr?: number
}

/**
 * 计算两张同尺寸灰度图的 PSNR（dB）。
 *
 * 公式：PSNR = 10 * log10(MAX² / MSE)，MAX = 255。
 * 完全相同时 MSE = 0，PSNR 为无穷大——这里返回 Infinity，
 * 由调用方判成「完全重复」而不是让 NaN 漏过去。
 */
export function computePsnr(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 || a.length !== b.length) return Number.NaN
  let sum = 0
  for (let index = 0; index < a.length; index += 1) {
    const diff = a[index] - b[index]
    sum += diff * diff
  }
  const mse = sum / a.length
  if (mse === 0) return Number.POSITIVE_INFINITY
  return 10 * Math.log10((255 * 255) / mse)
}

/** 把 PSNR 统一成可比较的数：完全相同时按上限 99 处理。 */
export function normalizePsnr(value: number): number {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? Number.NaN : 99
  return Math.min(99, value)
}

/** 时间点格式化，报错里要能直接定位。 */
export function formatAt(seconds: number): string {
  const safe = Math.max(0, seconds)
  const whole = Math.floor(safe)
  const ms = Math.round((safe - whole) * 1000)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/**
 * 审计一个镜头内部：首/中/末三帧是否近似静止。
 *
 * 判据：末帧与首帧 PSNR > 30dB → 整镜几乎没动，就是「剧照」。
 * 注意只看首末，不看中间：中间帧可以有变化但首末回到原样（如来回摇），
 * 那不算静帧，算「动作匹配」，不该误杀。
 */
export function auditShotStillness(shot: ShotSampleSet): SeamIssue[] {
  const issues: SeamIssue[] = []
  const start = shot.samples.find((sample) => sample.position === 'start')
  const end = shot.samples.find((sample) => sample.position === 'end')
  const middle = shot.samples.find((sample) => sample.position === 'middle')

  if (!start || !end) {
    issues.push({
      kind: 'sample-missing',
      level: 'warn',
      message: `镜 ${shot.number}（${formatAt(shot.startSeconds)}）缺少首帧或末帧，无法判定静帧`,
      shots: [shot.number],
      atSeconds: shot.startSeconds
    })
    return issues
  }

  // 完全相同的帧：MD5 一致，直接判重复且明确说明「逐像素完全一致」
  if (start.md5 && end.md5 && start.md5 === end.md5) {
    issues.push({
      kind: 'still',
      level: 'error',
      message: `镜 ${shot.number}（${formatAt(shot.startSeconds)}）首帧与末帧完全相同，整镜没有画面变化（静帧）`,
      shots: [shot.number],
      atSeconds: start.atSeconds,
      psnr: 99
    })
    return issues
  }

  if (!start.pixels || !end.pixels) {
    // 没有像素时退回 MD5 判据，不算静帧（不能凭「不知道」判错）
    if (middle?.md5 && start.md5 && middle.md5 === start.md5) {
      issues.push({
        kind: 'sample-missing',
        level: 'warn',
        message: `镜 ${shot.number}（${formatAt(shot.startSeconds)}）首帧与中帧 MD5 相同，疑似静止但缺少像素数据无法确认`,
        shots: [shot.number],
        atSeconds: middle.atSeconds
      })
    }
    return issues
  }

  const psnr = normalizePsnr(computePsnr(start.pixels, end.pixels))
  if (Number.isFinite(psnr) && psnr > PSNR_DUPLICATE_THRESHOLD) {
    issues.push({
      kind: 'still',
      level: 'error',
      message: `镜 ${shot.number}（${formatAt(shot.startSeconds)}）首末帧 PSNR ${psnr.toFixed(1)}dB > ${PSNR_DUPLICATE_THRESHOLD}dB，整镜近似静止（像剧照）`,
      shots: [shot.number],
      atSeconds: start.atSeconds,
      psnr
    })
  }
  return issues
}

/**
 * 审计相邻镜接缝：上镜末帧 ↔ 下镜首帧。
 *
 * PSNR > 30dB 说明两个镜头开头/结尾画面几乎一样，
 * 剪辑上会出现「顿一下」或者「重复了一个镜头」的观感。
 * 这是方案里点名的「接缝重复」问题，也是三十度原则要治的。
 */
export function auditSeams(shots: ShotSampleSet[]): SeamIssue[] {
  const issues: SeamIssue[] = []
  for (let index = 0; index < shots.length - 1; index += 1) {
    const current = shots[index]
    const next = shots[index + 1]
    const currentEnd = current.samples.find((sample) => sample.position === 'end')
    const nextStart = next.samples.find((sample) => sample.position === 'start')
    if (!currentEnd || !nextStart) continue

    const seamAt = nextStart.atSeconds
    if (currentEnd.md5 && nextStart.md5 && currentEnd.md5 === nextStart.md5) {
      issues.push({
        kind: 'seam-repeat',
        level: 'error',
        message: `镜 ${current.number} 末帧与镜 ${next.number} 首帧完全相同（接缝 ${formatAt(seamAt)}），两镜画面重复`,
        shots: [current.number, next.number],
        atSeconds: seamAt,
        psnr: 99
      })
      continue
    }

    if (!currentEnd.pixels || !nextStart.pixels) continue
    const psnr = normalizePsnr(computePsnr(currentEnd.pixels, nextStart.pixels))
    if (Number.isFinite(psnr) && psnr > PSNR_DUPLICATE_THRESHOLD) {
      issues.push({
        kind: 'seam-repeat',
        level: 'error',
        message: `镜 ${current.number} 末帧与镜 ${next.number} 首帧 PSNR ${psnr.toFixed(1)}dB > ${PSNR_DUPLICATE_THRESHOLD}dB（接缝 ${formatAt(seamAt)}），接缝近似重复`,
        shots: [current.number, next.number],
        atSeconds: seamAt,
        psnr
      })
    }
  }
  return issues
}

/** 同一镜内三帧是否出现两帧完全相同（模型卡住/重复帧）。 */
export function auditIntraShotDuplicates(shot: ShotSampleSet): SeamIssue[] {
  const issues: SeamIssue[] = []
  const seen = new Map<string, ShotFrameSample>()
  for (const sample of shot.samples) {
    if (!sample.md5) continue
    const first = seen.get(sample.md5)
    if (first && first.position !== sample.position) {
      issues.push({
        kind: 'duplicate-frame',
        level: 'warn',
        message: `镜 ${shot.number} 的 ${first.position} 帧与 ${sample.position} 帧逐像素相同（${formatAt(sample.atSeconds)}），该处可能是重复帧`,
        shots: [shot.number],
        atSeconds: sample.atSeconds
      })
      continue
    }
    seen.set(sample.md5, sample)
  }
  return issues
}

/** 全量审计：镜内静帧 + 镜内重复 + 相邻接缝。 */
export function auditSeamsAndStills(shots: ShotSampleSet[]): SeamIssue[] {
  const issues: SeamIssue[] = []
  for (const shot of shots) {
    issues.push(...auditShotStillness(shot))
    issues.push(...auditIntraShotDuplicates(shot))
  }
  issues.push(...auditSeams(shots))
  return issues.sort((a, b) => a.atSeconds - b.atSeconds)
}

/** 汇总成一行结论，用于 runChecks 与出片前报告。 */
export function summarizeSeamAudit(shots: ShotSampleSet[], issues: SeamIssue[]): string {
  const stills = issues.filter((issue) => issue.kind === 'still')
  const seams = issues.filter((issue) => issue.kind === 'seam-repeat')
  const duplicates = issues.filter((issue) => issue.kind === 'duplicate-frame')
  const missing = issues.filter((issue) => issue.kind === 'sample-missing')
  if (!issues.length) {
    return `${shots.length} 镜接缝审计通过：静帧 0 / 接缝重复 0 / 重复帧 0`
  }
  const parts = [
    `静帧 ${stills.length}`,
    `接缝重复 ${seams.length}`,
    `重复帧 ${duplicates.length}`
  ]
  if (missing.length) parts.push(`采样不全 ${missing.length}`)
  const first = issues[0]
  return `${shots.length} 镜接缝审计：${parts.join(' / ')}；首个问题在 ${formatAt(first.atSeconds)}（${first.shots.map((n) => `镜 ${n}`).join('、')}）`
}

// ==========================================================================
// 原 shared/hardsub.ts
// ==========================================================================

// 内嵌字幕（烧死的字）检测：C-03 / 方案硬规则 HR-01 L2 检测层。
//
// 为什么需要它：模型偶尔会在画面里自带一行字幕。它比伪文字更危险——外挂 SRT 也落在同一位置，
// 两层字叠在一起谁都看不清；内容是伪语言，不可控；而且已经烧进像素，只能重做整镜。
// 所以检测的意义是把「偶发」变成「不可能流到成片」。
//
// 判定方法（文字行带 + 多帧投票）：
//   1. 只取画面下部 38%：字幕几乎总在底部，避开上部场景结构；
//   2. 逐行找「文字行」：该行同时满足
//      · 亮像素（≥200）占比够高 —— 字幕是亮字；
//      · 亮像素分成多个短段 —— 文字是若干字块，不是一整条长条；
//      · 最长连续亮段不能占满整行 —— 排除天空、墙面、水面这类整片亮区；
//   3. 连续的文字行合成行带，段高 6–70px 才算候选（太薄是噪点，太厚是场景结构）；
//   4. 多帧投票：命中帧数超过半数才判定，单帧命中不算（压缩噪点会造成单帧误报）。
//
// 阈值用真实样本校准，不是拍脑袋：把一行中文字幕烧进真实镜头后，
// 命中行的亮占比约 0.50、亮段 6 段左右、最长段约 0.30；
// 同一批干净镜头的可疑行亮占比约 0.20、最长段约 0.05（几乎连续的亮区）。
// 判定线取亮占比 ≥0.34 且最长段 <0.55，两侧都留出余量。

/** 检测参数；导出给测试与工具复用，避免阈值散落在多处。 */
export const HARDSUB_DETECT = {
  /** 只分析画面下部这一比例的区域 */
  bottomRatio: 0.38,
  /** 分析分辨率宽度（再大对判定没有帮助，只是变慢） */
  analysisWidth: 480,
  /** 相邻像素亮度差达到它算强边缘（0–255 灰度） */
  edgeDelta: 32,
  /** 一行里强边缘像素占比达到它算「有纹理」，用于排除纯色背景 */
  edgeRatio: 0.012,
  /** 一行里亮像素占比达到它才算候选文字行 */
  brightRatio: 0.34,
  /** 亮像素至少分成这么多段（文字由多个字块组成；连笔与压缩会让段数偏少，取 2） */
  minSegments: 2,
  /** 最长连续亮段占行宽的上限；超过说明是整片亮区而不是文字 */
  maxRunRatio: 0.60,
  /** 行带最小高度（像素） */
  minBandHeight: 6,
  /** 行带最大高度（像素）：实测单行字幕约 7–9px，反光/结构通常 15px 以上，取 12 分隔 */
  maxBandHeight: 12,
  /** 亮像素判定下限（0–255） */
  brightLevel: 200,
  /** 暗像素判定上限（0–255）：字幕是黑底白字，同一行必须有足够深的描边 */
  darkLevel: 60,
  /** 一行里暗像素占比下限；水面反光、金属高光缺这一项，容易被误判成字幕 */
  minDarkRatio: 0.10,
  /** 采样帧数 */
  frameSamples: 3,
  /** 超过这个比例的采样帧命中，才判定为内嵌字幕 */
  voteRatio: 0.5
} as const

export interface HardsubFrameResult {
  /** 该帧是第几帧（从 1 开始） */
  frame: number
  /** 该帧是否命中 */
  hit: boolean
  /** 命中行带的亮像素占比；没有候选行带时为 0 */
  coverage: number
  /** 命中行带的强边缘占比 */
  edgeRatio: number
  /** 命中行带的段高（像素） */
  bandHeight: number
}

export interface HardsubDetection {
  /** 最终判定：true = 画面里有内嵌字幕 */
  detected: boolean
  /** 命中帧数 / 采样帧数 */
  hits: number
  samples: number
  frames: HardsubFrameResult[]
  /** 判定依据的可读说明 */
  reason: string
}

/** 灰度图（宽、高、逐像素亮度 0–255）。 */
export interface GrayImage {
  width: number
  height: number
  /** 逐行连续存放的亮度字节；Node 的 Buffer 也是 Uint8Array 的子类，可直接传入。 */
  data: Uint8Array
}

/**
 * 分析单帧灰度图，返回最可疑的文字行带。
 * 纯函数：不碰文件、不碰 ffmpeg，方便用构造数据做边界测试。
 */
export function analyzeGrayFrame(image: GrayImage, options: Partial<typeof HARDSUB_DETECT> = {}): {
  hit: boolean
  coverage: number
  edgeRatio: number
  bandHeight: number
} {
  const config = { ...HARDSUB_DETECT, ...options }
  const { width, height, data } = image
  const empty = { hit: false, coverage: 0, edgeRatio: 0, bandHeight: 0 }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 8) return empty
  if (data.length < width * height) return empty

  // 逐行判断是不是「文字行」：亮像素多、分成多段、且没有占满整行的长亮条。
  // 亮度阈值按本帧自适应：字幕是相对整帧的「局部极亮」，固定 200 在暗场或缩图后会漏检。
  let sum = 0
  let peak = 0
  for (let index = 0; index < width * height; index++) {
    const value = data[index]
    sum += value
    if (value > peak) peak = value
  }
  const mean = sum / (width * height)
  // 取「均值与峰值的中点」但至少高于均值 12：既能跟上整体亮度，又不会在低对比画面上乱判。
  const brightLevel = Math.min(
    config.brightLevel,
    Math.max(mean + 12, Math.round(mean + (peak - mean) * 0.55))
  )
  const rows: Array<{ text: boolean; bright: number; edge: number; dark: number }> = []
  for (let y = 0; y < height; y++) {
    const offset = y * width
    let bright = 0
    let dark = 0
    let edges = 0
    let segments = 0
    let longestRun = 0
    let run = 0
    for (let x = 1; x < width; x++) {
      if (Math.abs(data[offset + x] - data[offset + x - 1]) >= config.edgeDelta) edges += 1
    }
    for (let x = 0; x < width; x++) {
      const value = data[offset + x]
      if (value >= brightLevel) {
        bright += 1
        run += 1
      } else {
        if (value <= config.darkLevel) dark += 1
        if (run > 0) {
          segments += 1
          if (run > longestRun) longestRun = run
        }
        run = 0
      }
    }
    if (run > 0) {
      segments += 1
      if (run > longestRun) longestRun = run
    }
    const brightRatio = bright / width
    const darkRatio = dark / width
    const edgeRatio = edges / width
    // 字幕是黑底白字：同一行既要有多段亮笔画，也要有足够深的描边/底色。
    // 只加「亮」这一条会把水面反光、金属高光当成字幕（实测成片 40s 处就会被误判）。
    const isText =
      brightRatio >= config.brightRatio &&
      darkRatio >= config.minDarkRatio &&
      edgeRatio >= config.edgeRatio &&
      segments >= config.minSegments &&
      longestRun / width <= config.maxRunRatio
    rows.push({ text: isText, bright: brightRatio, edge: edgeRatio, dark: darkRatio })
  }

  // 连续文字行合成行带，只保留段高在允许区间内的
  let best = { coverage: 0, edgeRatio: 0, bandHeight: 0 }
  let start = -1
  const flush = (end: number): void => {
    if (start < 0) return
    const bandHeight = end - start + 1
    start = -1
    if (bandHeight < config.minBandHeight || bandHeight > config.maxBandHeight) return
    let brightSum = 0
    let edgeMax = 0
    for (let y = end - bandHeight + 1; y <= end; y++) {
      brightSum += rows[y].bright
      if (rows[y].edge > edgeMax) edgeMax = rows[y].edge
    }
    const coverage = brightSum / bandHeight
    if (coverage > best.coverage) best = { coverage, edgeRatio: edgeMax, bandHeight }
  }
  for (let y = 0; y < rows.length; y++) {
    if (rows[y].text) {
      if (start < 0) start = y
    } else {
      flush(y - 1)
    }
  }
  flush(rows.length - 1)

  return { hit: best.coverage >= config.brightRatio, ...best }
}

/**
 * 汇总多帧结果做投票。命中帧数超过 voteRatio 才算真有内嵌字幕。
 * 单帧命中一律不判定——压缩噪点、镜头里的高对比道具都会造成单帧误报。
 */
export function voteHardsub(frames: HardsubFrameResult[], options: Partial<typeof HARDSUB_DETECT> = {}): HardsubDetection {
  const config = { ...HARDSUB_DETECT, ...options }
  const samples = frames.length
  const hits = frames.filter((frame) => frame.hit).length
  if (!samples) {
    return { detected: false, hits: 0, samples: 0, frames, reason: '没有可用采样帧' }
  }
  const detected = hits / samples > config.voteRatio
  const peak = Math.max(...frames.map((frame) => frame.coverage))
  const reason = detected
    ? `${hits}/${samples} 帧在画面下部检出高对比文字行带（最高覆盖率 ${peak.toFixed(2)}），判定为内嵌字幕`
    : `${hits}/${samples} 帧命中，未达判定线（需超过半数帧），最高覆盖率 ${peak.toFixed(2)}`
  return { detected, hits, samples, frames, reason }
}

/** 从字节区间解出 ASCII 文本（PGM 头部只含数字与空白）。 */
function decodeAscii(buffer: Uint8Array, start: number, end: number): string {
  let text = ''
  for (let index = start; index < end; index += 1) text += String.fromCharCode(buffer[index])
  return text
}

/** 解析 PGM(P5) 灰度图。ffmpeg 输出格式稳定，这里只处理它会给的头部。 */
export function parsePgm(buffer: Uint8Array): GrayImage | null {
  if (buffer.length < 16 || buffer[0] !== 0x50 || buffer[1] !== 0x35) return null
  // P5 头部接下来是三个数值：宽、高、最大值，然后是单个空白与像素数据。
  let pos = 2
  const tokens: string[] = []
  while (tokens.length < 3) {
    while (pos < buffer.length && [0x20, 0x0a, 0x0d, 0x09].includes(buffer[pos])) pos += 1
    if (pos >= buffer.length) return null
    if (buffer[pos] === 0x23) {
      while (pos < buffer.length && buffer[pos] !== 0x0a) pos += 1
      continue
    }
    const start = pos
    while (pos < buffer.length && ![0x20, 0x0a, 0x0d, 0x09].includes(buffer[pos])) pos += 1
    if (start === pos) return null
    tokens.push(decodeAscii(buffer, start, pos))
  }
  // 头部与像素之间恰好一个空白字符，必须跳过它，否则首字节会被当成像素。
  pos += 1
  const [rawWidth, rawHeight, rawMax] = tokens
  const width = Number(rawWidth)
  const height = Number(rawHeight)
  const maxValue = Number(rawMax)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  if (!Number.isFinite(maxValue) || maxValue <= 0 || maxValue > 255) return null
  const expected = width * height
  if (buffer.length - pos < expected) return null
  return { width, height, data: buffer.subarray(pos, pos + expected) }
}
