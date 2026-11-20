/**
 * Relay 通道白名单。
 *
 * 这是整条远程通道的**信任边界**：手机端能做什么，完全由这张表决定。
 * 蓝图 B1 要求「对外只监听白名单；非白名单返回 CHANNEL_DENIED」，并且
 * 「默认关闭，需用户在设置里显式开启」。
 *
 * 三条设计原则（每条都能解释为什么某条通道不在表里）：
 *
 * 1. **只放「看 + 决策」，不放「改环境」**。
 *    手机能发指令、能审批、能停止，但不能改模型 Key、不能改数据目录、不能开外部程序。
 *
 * 2. **不放任何涉及本机执行面或凭据的通道**。
 *    `app:open-external`、`app:change-data-dir`、`app:reset-data-dir`、`settings:save-provider`
 *    这些一旦被远程调用，等于把桌面机器的控制权交出去。
 *
 * 3. **只放只读或幂等的通道，写操作必须是「用户意图明确」的那几个**。
 *    例如 `session:delete`、`session:clear-all` 不放 —— 手机上误触一次就毁掉会话历史，
 *    这类操作必须回到桌面上做。
 */

/** 白名单条目：通道 + 放行理由（理由不是注释摆设，会进审计日志的静态元数据） */
interface AllowEntry {
  readonly channel: string
  readonly why: string
}

/**
 * 逐条白名单。按用途分五组，与蓝图「五个页面」的职责一一对应：
 * 工位（看状态）、对话（发指令）、成员（干预）、审批（决策）、作品（审阅）。
 */
const ENTRIES: readonly AllowEntry[] = [
  // ── 启动与状态：手机冷启动后第一件事就是取全量快照 ──
  { channel: 'app:bootstrap', why: '冷启动取全量状态，工位页首屏依赖它' },

  // ── 会话：只放「读 + 发消息 + 停止」，不放删除/清空/改模型 ──
  { channel: 'session:list', why: '工位页会话列表（只读）' },
  { channel: 'session:load', why: '对话页加载单个会话（只读）' },
  { channel: 'session:rename', why: '会话重命名：可从标题识别，误操作可改回' },

  // ── 对话：发指令与打断，是手机端存在的理由 ──
  { channel: 'chat:send', why: '手机发新指令（核心能力）' },
  { channel: 'chat:cancel', why: '停止正在运行的回合，避免失控消耗' },
  { channel: 'chat:regenerate', why: '重新生成上一条回答（蓝图白名单原文）' },

  // ── 审批与提问：手机端最重要的决策入口 ──
  { channel: 'permission:respond', why: '审批通过/拒绝（蓝图称手机端最重要功能）' },
  { channel: 'question:respond', why: '回答 Agent 的提问，否则任务会一直等' },

  // ── 成员协作：跟盯协作任务，可干预但不重配 ──
  { channel: 'collaboration:projection', why: '成员卡与总目标卡的数据来源（只读）' },
  { channel: 'collaboration:send-message', why: '给某个成员补充要求，继续跑' },
  { channel: 'collaboration:stop-task', why: '停掉某个跑偏的任务' },
  { channel: 'collaboration:retry-task', why: '重试失败任务' },
  { channel: 'collaboration:reactivate', why: '重新激活已结束的成员（蓝图白名单中风险写）' },

  // ── 作品：只读与导出，不做剪辑 ──
  { channel: 'artifact:read', why: '作品页读成品内容（只读）' },
  { channel: 'artifact:versions', why: '版本列表（只读）' },
  { channel: 'artifact:export', why: '导出工程包：蓝图 J3 旅程明确要求' },

  // ── 计划：手机上可以批准/打回计划，但不能改执行模式 ──
  { channel: 'plan:approve', why: '批准执行计划：手机上可做这个决策' },
  { channel: 'plan:reject', why: '打回计划并说明原因，避免桌面空等' },
  { channel: 'plan:revise', why: '要求修改计划（蓝图白名单低风险写）' },
  { channel: 'goal:pause', why: '暂停长任务，避免无人看管时持续消耗' },
  { channel: 'goal:resume', why: '恢复被暂停的任务' },
  { channel: 'goal:stop', why: '终止长任务，停止消耗' },
  { channel: 'session:create', why: '手机上新建会话（蓝图低风险写，无需审批）' },
  { channel: 'session:set-mode', why: '切换会话模式（蓝图低风险写）' },
  { channel: 'session:set-permission-mode', why: '切换权限档位（蓝图列低风险写；每次执行仍需桌面审批）' },
  { channel: 'feature:studio:action', why: '创作台只读子集：payload.type 仅允许 read / preview（蓝图原文限制）' },
  // ── 桌面跳转：暂不放行（见下方说明） ──
  // 蓝图要求 app:open-external「限深链 scheme，只能唤起桌面，不能唤起浏览器」。
  // 但核对了桌面真实实现（src/main/ipc.ts:413）：它只接受 http(s) 并用系统浏览器打开，
  // 全仓也没有 morrow: 深链处理器。
  //
  // 也就是说，现在放行它 = 给手机一个「让桌面开浏览器」的通道，正是蓝图明令禁止的。
  // 所以先不放行，等桌面侧实现 morrow: 深链后再启用；
  // checkPayload() 里的深链校验已经写好了（见 ALLOWED_EXTERNAL_SCHEMES），届时直接生效。
]

/** 允许远程调用的深链 scheme（蓝图：「只能唤起桌面，不能唤起浏览器」） */
const ALLOWED_EXTERNAL_SCHEMES = ['morrow:']

/**
 * 通道级参数校验：部分通道「放行」不等于「参数随便传」。
 *
 * 蓝图对两个通道有明确的子集限制，这里做成校验而不是只写注释 ——
 * 注释不会阻止攻击，校验会。
 *
 * - `app:open-external`：只允许 morrow: 深链。不限的话这就是个
 *   「让桌面打开任意 URL / 本地文件」的通道。
 * - `feature:studio:action`：只允许 read / preview。创作台的 action 里
 *   还有写操作，全放行等于把创作台交出去。
 */
export function checkPayload(channel: string, payload: unknown): { ok: true } | { ok: false; message: string } {
  const p = (payload ?? {}) as Record<string, unknown>

  if (channel === 'app:open-external') {
    const url = typeof p.url === 'string' ? p.url : ''
    if (!url) return { ok: false, message: 'app:open-external 需要 url' }

    // 控制字符必须先拒绝。
    // 只校验 scheme 前缀会被换行/null 注入绕过：
    //   "morrow://x\nhttps://evil.com"、"morrow://x\0https://evil.com"
    // 这两种输入的前缀都是合法的 morrow:，但下游若按行或按 null 截断解析，
    // 就可能打开后半截那个恶意地址。审查探针实测这两种都被放行过。
    if (/[\u0000-\u001f\u007f]/.test(url)) {
      return { ok: false, message: 'app:open-external 的 url 不允许包含控制字符' }
    }

    const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase()
    if (!ALLOWED_EXTERNAL_SCHEMES.includes(scheme)) {
      return { ok: false, message: `app:open-external 只允许 ${ALLOWED_EXTERNAL_SCHEMES.join('/')} 深链` }
    }
    // 长度上限：深链带参数也不会超过这个数，超长输入更像攻击而非正常使用
    if (url.length > 2048) {
      return { ok: false, message: 'app:open-external 的 url 过长' }
    }
    return { ok: true }
  }

  if (channel === 'feature:studio:action') {
    const type = typeof p.type === 'string' ? p.type : ''
    if (type !== 'read' && type !== 'preview') {
      return { ok: false, message: '创作台只允许 read / preview 两种 type' }
    }
    return { ok: true }
  }

  return { ok: true }
}

/** 白名单集合，供 O(1) 判定 */
const ALLOWED = new Map<string, string>(ENTRIES.map((e) => [e.channel, e.why]))

/** 非白名单通道统一返回的错误码（蓝图原文要求） */
export const CHANNEL_DENIED = 'CHANNEL_DENIED'

export interface DeniedResult {
  ok: false
  error: { code: typeof CHANNEL_DENIED; message: string }
}

export type AllowDecision = { allowed: true; why: string } | { allowed: false; result: DeniedResult }

/**
 * 判定一个通道是否放行。
 *
 * 注意判定的严格性：
 * - 只做**精确匹配**，不做前缀匹配。`session:*` 这种通配会让新增通道自动获得授权，
 *   等于白名单失效 —— 这正是这类设计最常见的漏洞。
 * - 空/非字符串一律拒绝，不给「undefined 恰好能通过」留缝隙。
 */
export function checkChannel(channel: unknown): AllowDecision {
  if (typeof channel !== 'string' || channel.length === 0) {
    return {
      allowed: false,
      result: {
        ok: false,
        error: { code: CHANNEL_DENIED, message: '通道名必须是非空字符串' }
      }
    }
  }
  const why = ALLOWED.get(channel)
  if (why === undefined) {
    return {
      allowed: false,
      result: {
        ok: false,
        error: { code: CHANNEL_DENIED, message: `非白名单通道：${channel}` }
      }
    }
  }
  return { allowed: true, why }
}

/** 列出全部白名单通道（供设置页展示与测试比对） */
export function allowedChannels(): readonly string[] {
  return ENTRIES.map((e) => e.channel)
}

/** 供测试断言「白名单里没有危险通道」 */
export function allowReason(channel: string): string | undefined {
  return ALLOWED.get(channel)
}