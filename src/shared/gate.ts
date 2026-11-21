// BATCH 3 门禁层（纯逻辑）。
//
// 方案出口条件：**ERROR > 0 阻断出包**。这是整条产线最后一道闸门，
// 也是把前面各张卡的检查（帧数契约、内画音分离、内嵌字幕、接缝静帧、
// 配乐人声、导演景别链、时长全等长…）收成一个统一判定的地方。
//
// 为什么门禁不能只是「再跑一遍 runChecks」：
// runChecks 的结果是给人看的提示清单（info / warn / error 混排，允许忽略）；
// 门禁要回答的是一个二值问题——**这批东西能不能出包**。
// 所以它必须给出一份明确的、可复跑的判定，并把「无法判定」也算作不放行。

/** 门禁项的严重级别。 */
export type GateLevel = 'error' | 'warn' | 'info'

/** 一条门禁记录（来自任意检查器的单条结论）。 */
export interface GateItem {
  /** 检查项 id（同名可重复，代表同一类问题的多条记录） */
  code: string
  level: GateLevel
  /** 人可读说明 */
  message: string
}

/** 门禁报告：出包判定的唯一依据。 */
export interface GateReport {
  /** 是否放行出包 */
  passed: boolean
  /** error 数 */
  errors: number
  /** warn 数 */
  warns: number
  /** info 数 */
  infos: number
  /** 阻断原因（passed=false 时非空） */
  blockers: string[]
  /** 一行结论，直接展示给用户 */
  summary: string
}

/**
 * 把若干检查结果汇总成门禁报告。
 *
 * 判定规则只有一条，但必须如实实现到位：
 *   errors > 0 → 不放行。
 * 不能因为 warn 很多就「折中放行」，也不能因为只有一条 error 就忽视它。
 */
export function evaluateGate(items: GateItem[]): GateReport {
  const errors = items.filter((item) => item.level === 'error')
  const warns = items.filter((item) => item.level === 'warn')
  const infos = items.filter((item) => item.level === 'info')

  // 同样的 code 只报一次，避免 20 镜同一问题刷屏；但计数仍如实
  const uniqueBlockers: string[] = []
  const seen = new Set<string>()
  for (const item of errors) {
    if (seen.has(item.code)) continue
    seen.add(item.code)
    uniqueBlockers.push(item.message)
  }

  const passed = errors.length === 0
  return {
    passed,
    errors: errors.length,
    warns: warns.length,
    infos: infos.length,
    blockers: uniqueBlockers,
    summary: passed
      ? `门禁通过：0 error / ${warns.length} warn / ${infos.length} info，可以出包`
      : `出包被阻断：${errors.length} 个 error（${uniqueBlockers.length} 类问题）。修掉 error 后才能出包；warn 不影响出包但建议处理。`
  }
}

/** 出包前置断言：不放行就抛出，异常信息必须是用户能看懂并可直接行动的。 */
export function assertGatePassed(report: GateReport): void {
  if (report.passed) return
  const lines = [
    `出包被阻断：还有 ${report.errors} 个 error。`,
    ...report.blockers.slice(0, 6).map((message) => `· ${message}`)
  ]
  if (report.blockers.length > 6) lines.push(`· 还有 ${report.blockers.length - 6} 类问题未列出`)
  lines.push('这不是可以忽略的警告：修掉上面每一项再出包，或者先把那一镜从时间线移除。')
  throw new Error(lines.join('\n'))
}

/**
 * 门禁清单：把散落各处的检查项登记成一张表。
 *
 * 这张表的价值是**可核对性**——用户能看到「门禁到底查了什么」，
 * 而不是只得到一个「通过」。方案要求把 14 项 ERROR/WARN 做成自动检查，
 * 这里逐条登记来源模块，任何一项缺失都能立刻发现。
 */
export interface GateCheckSpec {
  /** 检查项代码 */
  code: string
  /** 人类可读的名字 */
  label: string
  /** 来自哪张开发卡 / 哪个模块 */
  source: string
  /** 不通过时的级别 */
  level: GateLevel
}

export const GATE_CHECKS: GateCheckSpec[] = [
  // ---- 画面（STAGE 1 不失真） ----
  { code: 'frame-shortfall', label: '帧数不足（时间线已按实测重算，禁止补帧）', source: 'C-01', level: 'warn' },
  { code: 'no-visual', label: '有镜头没有画面', source: 'C-01', level: 'error' },
  { code: 'hardsub', label: '画面里有内嵌字幕', source: 'HR-01', level: 'error' },
  { code: 'seam-repeat', label: '接缝重复 / 静帧', source: 'C-06', level: 'error' },
  // 静帧与接缝重复是两种不同的毛病（前者是画面不动，后者是首尾帧撞车），
  // 但共用同一段审计结果。此前只判定了 still-frame 却没登记，
  // 于是「按登记表核对覆盖」永远发现不了它。
  { code: 'still-frame', label: '镜头是静帧（画面不动）', source: 'C-06', level: 'error' },
  // ---- 声音（STAGE 1） ----
  { code: 'silent-film', label: '成片整段近乎无声', source: 'C-04', level: 'warn' },
  { code: 'music-vocal', label: '配乐疑似有人声', source: 'C-08', level: 'error' },
  { code: 'music-declaration', label: '配乐缺纯器乐声明', source: 'C-08', level: 'warn' },
  // ⚠ 这一项**当前无生产者**：判定要用 ffmpeg silencedetect 读成片真实电平，
  //    而门禁跑在渲染之前（成片还不存在，project 上也没有 outputPath）。
  //    静态替代也做不到 —— 时间线 clip 没有时长/起始字段。
  //    保留登记而不是删掉，是因为它确实是出片前该看的标准；
  //    将来若把门禁拆成「渲染前」+「渲染后」两段，它属于后一段。
  { code: 'long-silence', label: '成片出现长段静音', source: 'C-04', level: 'warn' },
  // ---- 结构（STAGE 3 观感） ----
  { code: 'uniform-duration', label: '全片时长等长（催眠效应）', source: 'C-07', level: 'error' },
  // 与全等长不同：段内已经长短不一，只是「上一场和下一场一样长」。
  // 这类撞车比全片等长轻得多，报 error 会把正常作品挡在门外，所以是 warn。
  { code: 'adjacent-same-duration', label: '相邻段时长相同（像节拍器）', source: 'C-07', level: 'warn' },
  { code: 'overlong-line', label: '台词单句超过 20 字（配音塞不进镜头）', source: 'C-07', level: 'warn' },
  { code: 'weak-opening', label: '首镜是远景空镜（前 5 秒定生死）', source: 'BATCH 2', level: 'error' },
  { code: 'adjacent-same-size', label: '相邻镜景别相同（像 PPT）', source: 'BATCH 2', level: 'warn' },
  { code: 'no-reaction-shot', label: '段落缺反应镜（动作-反应单元断裂）', source: 'BATCH 2', level: 'warn' },
  { code: 'subtitle-missing', label: '有对白但没有字幕', source: 'HR-01', level: 'warn' }
]

// 「导演四问」曾在这里登记为 director-questions（source: BATCH 2），
// 但作品数据里既没有四问字段，也没有任何 UI 入口，checkDirectorAnswers 永远
// 拿不到输入。登记一个判定不了的项只会让「按表核对覆盖」永远差一项，
// 所以连同判定函数一并删除；等真的补上数据链路时再一起加回来。

/** 按模板逐项核对门禁是否都登记了（防止以后新增检查项忘了接进门禁）。 */
export function missingGateChecks(present: string[]): GateCheckSpec[] {
  const set = new Set(present)
  return GATE_CHECKS.filter((spec) => !set.has(spec.code))
}

/** 门禁结果按级别分组，供界面分区展示。 */
export function groupGateItems(items: GateItem[]): { errors: GateItem[]; warns: GateItem[]; infos: GateItem[] } {
  return {
    errors: items.filter((item) => item.level === 'error'),
    warns: items.filter((item) => item.level === 'warn'),
    infos: items.filter((item) => item.level === 'info')
  }
}