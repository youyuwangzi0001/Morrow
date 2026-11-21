// 引擎启动护栏（C-03 / 缺陷 D-01）。
//
// 为什么需要它：`--use-split-cross-attention` 在 ComfyUI v0.45.x 上显存估算失真，
// 会把申请量算到模型体积的 13 倍——实测报错 `Requested: 210.48 GiB / Device limit: 15.89 GiB`。
// 这类错误在启动阶段只表现为「OOM」或「卡住」，用户很难自己联想到是某个参数造成的，
// 所以要在启动前就拦住，并直接告诉用户换成什么。
//
// 判定范围：只看显存与注意力实现相关的已知失真/不兼容开关。不做通用参数白名单——
// 那会把用户合理的自定义参数一起挡掉，属于过度限制。

export type EngineArgVerdict = 'unknown' | 'comfyui' | 'llama' | 'ollama' | 'lmstudio'

/** 一条危险参数的定义。 */
export interface EngineArgRule {
  /** 参数名（不含 `=` 与值；`--flag=value` 与 `--flag value` 都按名字匹配） */
  flag: string
  /** 适用引擎；不填表示所有引擎都要拦 */
  engines?: EngineArgVerdict[]
  /** 为什么危险（一句话，直接展示给用户） */
  reason: string
  /** 可执行的替代方案（必须能照做，不能只说「别用」） */
  alternative: string
}

/**
 * 已知会让显存估算失真或直接不兼容的启动参数。
 * 只收录有真实报错证据的项——宁缺毋滥，避免把正常参数误拦。
 */
export const DANGEROUS_ENGINE_ARGS: EngineArgRule[] = [
  {
    flag: '--use-split-cross-attention',
    engines: ['comfyui'],
    reason: '在此版本显存估算失真：实测申请量达模型体积 13 倍（Requested 210.48 GiB / Device limit 15.89 GiB），一启动就 OOM。',
    alternative: '去掉这个参数直接启动。Morrow 已默认加 --reserve-vram 2.5 给系统留余量；显存仍然紧张时改用 --lowvram，或把分辨率降到 768×1344。'
  },
  {
    flag: '--use-pytorch-cross-attention',
    engines: ['comfyui'],
    reason: '强制 pytorch 注意力实现会在部分显卡上把峰值显存抬高，与 --reserve-vram 的估算叠加后容易 OOM。',
    alternative: '去掉这个参数，让 ComfyUI 自己选注意力实现；确实需要时再单独测试，不要和其他显存参数一起用。'
  },
  {
    flag: '--highvram',
    engines: ['comfyui'],
    reason: '强制把模型常驻显存，会挤掉 Morrow 生成视频所需的余量，在 16GB 卡上极易 OOM。',
    alternative: '换成 --normalvram（默认）或 --lowvram；确实需要常驻时，先把 --reserve-vram 调到 3.5 以上再试。'
  }
]

const ENGINE_MARKERS: Array<{ engine: EngineArgVerdict; patterns: RegExp[] }> = [
  { engine: 'comfyui', patterns: [/main\.py$/i, /comfyui/i] },
  { engine: 'llama', patterns: [/llama-server/i, /llama\.cpp/i] },
  { engine: 'ollama', patterns: [/\bollama\b/i] },
  { engine: 'lmstudio', patterns: [/lm[\s-]?studio/i] }
]

/** 从可执行文件与参数猜引擎类型；猜不到返回 unknown（不因此放宽拦截）。 */
export function detectEngineKind(binary: string, args: string[] = []): EngineArgVerdict {
  const haystack = [binary, ...args].join(' ')
  for (const marker of ENGINE_MARKERS) {
    if (marker.patterns.some((pattern) => pattern.test(haystack))) return marker.engine
  }
  return 'unknown'
}

export interface EngineArgCheck {
  /** 是否允许启动 */
  ok: boolean
  /** 命中的危险参数及其说明 */
  blocked: Array<{ flag: string; reason: string; alternative: string }>
  /** 给用户看的完整提示；ok=true 时为空串 */
  message: string
}

/**
 * 校验一组启动参数。返回是否放行、命中了哪些危险参数、以及可读提示。
 *
 * 匹配规则：参数名精确比较，兼容 `--flag=value` 与 `--flag value` 两种写法；
 * 不做前缀匹配，避免把 `--highvram-x` 之类的无关参数误判。
 */
export function guardEngineArgs(input: {
  binary: string
  args: string[]
  engine?: EngineArgVerdict
}): EngineArgCheck {
  const engine = input.engine ?? detectEngineKind(input.binary, input.args)
  const names = input.args.map((arg) => {
    const at = arg.indexOf('=')
    return (at > 0 ? arg.slice(0, at) : arg).trim()
  })
  const blocked: EngineArgCheck['blocked'] = []
  for (const rule of DANGEROUS_ENGINE_ARGS) {
    if (rule.engines && engine !== 'unknown' && !rule.engines.includes(engine)) continue
    if (!names.includes(rule.flag)) continue
    blocked.push({ flag: rule.flag, reason: rule.reason, alternative: rule.alternative })
  }
  if (!blocked.length) return { ok: true, blocked: [], message: '' }

  const lines = blocked.map((item) => `· ${item.flag}：${item.reason}\n  改用：${item.alternative}`)
  return {
    ok: false,
    blocked,
    message: [
      `已阻止启动：参数里有 ${blocked.length} 个已知会让显存估算失真的开关。`,
      ...lines,
      '改完再点启动；Morrow 不会带着这些参数去启动引擎。'
    ].join('\n')
  }
}