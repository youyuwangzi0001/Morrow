/**
 * R9.1 新增能力题 M40–M49（子代理全权限 + 真实并行）。
 *
 * 用户明确纠正：子代理必须与主代理权限完全一致，不能只读/串行。
 * 本文件复用 R9 的 M40/M41/M42/M48/M49，重写 M43–M47 的题面/checker/支持声明；
 * M47 的“重启恢复”按实际能力判：若产品无子任务级持久恢复，运行后如实记 UNSUPPORTED/INVALID，不提前缩分母。
 */
import type { ChatMessage } from '../../../src/shared/types'
import { matchFields, readJsonFile, readTextFile, sha256File } from '../r8/specs'
import {
  QUESTIONS as R9_QUESTIONS,
  type R9CheckContext,
  type R9CheckResult,
  type R9QuestionSpec
} from '../r9/specs'

export type { R9CheckContext, R9CheckResult, R9QuestionSpec }

function toolUses(messages: ChatMessage[]): Array<{
  id: string
  name: string
  input: Record<string, unknown>
  result?: unknown
  startedAt?: number
  finishedAt?: number
}> {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message) =>
    message.content
      .filter((block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        name: block.name,
        input: block.input,
        result: block.result,
        startedAt: block.startedAt,
        finishedAt: block.finishedAt
      }))
  )
}

function progressNotes(ctx: R9CheckContext): Array<{ toolUseId?: string; note: string }> {
  return ctx.events
    .filter((event) => event.type === 'tool_progress')
    .map((event) => {
      const payload = event as unknown as { toolUseId?: string; note?: string }
      return { toolUseId: payload.toolUseId, note: String(payload.note ?? '') }
    })
}

function taskCalls(ctx: R9CheckContext): ReturnType<typeof toolUses> {
  return ctx.sessions.flatMap((messages) => toolUses(messages)).filter((call) => call.name === 'task')
}

function taskResultsOk(tasks: ReturnType<typeof toolUses>): boolean {
  return tasks.every((task) => (task.result as { ok?: boolean } | undefined)?.ok === true)
}

function workspaceFile(ctx: R9CheckContext, path: string): Record<string, unknown> | null {
  try {
    return readJsonFile(ctx.workspace, path) as Record<string, unknown>
  } catch {
    return null
  }
}

function m43Checker(ctx: R9CheckContext): R9CheckResult {
  const tasks = taskCalls(ctx)
  const notes = progressNotes(ctx)
  const aNotes = notes.filter((note) => note.note.includes('out/a.json') || note.note.includes('in/a.json'))
  const bNotes = notes.filter((note) => note.note.includes('out/b.json') || note.note.includes('in/b.json'))
  const intervals = tasks
    .map((task) => ({ id: task.id, start: task.startedAt ?? 0, end: task.finishedAt ?? 0 }))
    .filter((item) => item.start > 0 && item.end >= item.start)
  const overlap =
    intervals.length >= 2 &&
    intervals.some((a, i) => intervals.some((b, j) => i !== j && a.start < b.end && b.start < a.end))
  const parentWrites = ctx.sessions
    .flatMap((messages) => toolUses(messages))
    .filter(
      (call) =>
        (call.name === 'write_file' || call.name === 'edit_file') &&
        /out\/(a|b)\.json/.test(String((call.input as Record<string, unknown>).path ?? ''))
    )
  const aFile = workspaceFile(ctx, 'out/a.json')
  const bFile = workspaceFile(ctx, 'out/b.json')
  const result = workspaceFile(ctx, 'out/result.json')
  const resultOk = result ? matchFields(result, { total: 30 }) : '缺少 out/result.json'
  const records = result && Array.isArray(result.records) ? (result.records as Array<Record<string, unknown>>) : []
  const sortedRecords =
    records.length === 2 &&
    String(records[0]?.id) === 'A' &&
    Number(records[0]?.value) === 11 &&
    String(records[1]?.id) === 'B' &&
    Number(records[1]?.value) === 19
  const details: string[] = []
  if (tasks.length < 2) details.push(`真实 task 调用数 ${tasks.length} < 2`)
  if (!taskResultsOk(tasks)) details.push('存在失败的 task 调用')
  if (!overlap) details.push(`任务时间线未重叠：${JSON.stringify(intervals)}`)
  if (!aNotes.length) details.push('缺少 A 子任务读取/写 out/a.json 的进度证据')
  if (!bNotes.length) details.push('缺少 B 子任务读取/写 out/b.json 的进度证据')
  if (parentWrites.length > 0) details.push('父任务直接写了子任务专属文件')
  if (!aFile || aFile.id !== 'A' || Number(aFile.value) !== 11) details.push(`out/a.json 不符：${JSON.stringify(aFile)}`)
  if (!bFile || bFile.id !== 'B' || Number(bFile.value) !== 19) details.push(`out/b.json 不符：${JSON.stringify(bFile)}`)
  if (typeof resultOk === 'string') details.push(resultOk)
  if (!sortedRecords) details.push(`records 不符：${JSON.stringify(records)}`)
  return {
    ok: details.length === 0,
    detail: details.length ? details.join('；') : '两个真实子任务并行（时间线重叠），各自只写 out/a.json / out/b.json；父任务写最终 result（total=30）',
    actual: { tasks: tasks.length, overlap, intervals, aNotes: aNotes.length, bNotes: bNotes.length, parentWrites: parentWrites.length, records }
  }
}

function m44Checker(ctx: R9CheckContext): R9CheckResult {
  const extra = (ctx.extra.m44 ?? {}) as Record<string, unknown>
  const after = (extra.waitCallsAfterT0 ?? {}) as Record<string, number>
  const newAfterT0 = Number(after.within10s ?? 0) + Number(after.after30s ?? 0)
  const childStatus = String(extra.child44Status ?? ctx.mock.state?.child44Status ?? 'unknown')
  const runStatus = String(extra.runStatus ?? 'unknown')
  const details: string[] = []
  if (extra.t0Observed !== true) details.push('考官未在子任务 running 后取得 t0')
  if (newAfterT0 > 0) details.push(`t0 后仍有 ${newAfterT0} 次 child44_wait 调用（孤儿/继续轮询）`)
  if (!['cancelled', 'cancelled-after-t0'].includes(childStatus)) details.push(`子任务状态不是 cancelled：${childStatus}`)
  if (['completed', 'success'].includes(runStatus)) details.push('父任务被标成功完成')
  if (extra.parentCompleted === true) details.push('父任务/Goal 标记完成')
  return {
    ok: details.length === 0,
    detail: details.length ? details.join('；') : 't0 后 10s/30s 无新 child44_wait；子任务 cancelled；父任务未标完成，无孤儿',
    actual: extra
  }
}

function m45Checker(ctx: R9CheckContext): R9CheckResult {
  const result = workspaceFile(ctx, 'out/result.json')
  const calls = ((ctx.extra.m45Calls ?? []) as Array<Record<string, unknown>>)
  const bCalls = calls.filter((call) => String(call.label ?? '') === 'B')
  const aCalls = calls.filter((call) => String(call.label ?? '') === 'A')
  const mismatch = result
    ? matchFields(result, { status: 'partial', a_value: 7, b_value: null, total: null })
    : '缺少 out/result.json'
  const details: string[] = []
  if (typeof mismatch === 'string') details.push(mismatch)
  if (result?.failed_children && !(Array.isArray(result.failed_children) && (result.failed_children as unknown[]).includes('B'))) {
    details.push('failed_children 未包含 B')
  }
  if (bCalls.length > 1) details.push(`B 被重复调用 ${bCalls.length} 次（应只 1 次、不重试）`)
  if (aCalls.length < 1) details.push('A 没有真实成功读取')
  if (result && (result.b_value === 0 || result.total === 0)) details.push('把缺失 B 补成了 0')
  return {
    ok: details.length === 0,
    detail: details.length ? details.join('；') : 'A=7 成功、B 真实 timeout 且未重试；父结果 partial、b=null、total=null',
    actual: { result, aCalls: aCalls.length, bCalls: bCalls.length }
  }
}

function m46Checker(ctx: R9CheckContext): R9CheckResult {
  const result = workspaceFile(ctx, 'out/result.json')
  const calls = ((ctx.extra.m46Calls ?? []) as Array<Record<string, unknown>>)
  const reads = calls.filter((call) => call.tool === 'child46_read')
  const mismatch = result ? matchFields(result, { status: 'failed', record_count: 0, reason: 'validation_error' }) : '缺少 out/result.json'
  const details: string[] = []
  if (typeof mismatch === 'string') details.push(mismatch)
  if (reads.length !== 1) details.push(`child46_read 调用 ${reads.length} 次（应 1 次、不重试）`)
  if (reads.some((call) => call.isError !== true)) details.push('child46_read 的真实 isError 未被保留')
  if (callHasRetry(ctx)) details.push('失败后另换工具/参数重试')
  return {
    ok: details.length === 0,
    detail: details.length ? details.join('；') : '子代理保留 child46_read 的真实 isError；父结果 failed/0/validation_error，无重试',
    actual: { result, calls: calls.length }
  }
}

function callHasRetry(ctx: R9CheckContext): boolean {
  const calls = ((ctx.extra.m46Calls ?? []) as Array<Record<string, unknown>>)
  const ids = calls.filter((call) => call.tool === 'child46_read').map((call) => JSON.stringify(call.arguments ?? {}))
  return new Set(ids).size > 1
}

function m47Checker(ctx: R9CheckContext): R9CheckResult {
  const extra = (ctx.extra.m47 ?? {}) as Record<string, unknown>
  const result = workspaceFile(ctx, 'out/result.json')
  const records = ((extra.records ?? ctx.mock.state?.child47 ?? []) as Array<Record<string, unknown>>)
  const ids = records.map((record) => String(record.id)).sort()
  const duplicates = records.length - new Set(records.map((record) => String(record.key))).size
  const details: string[] = []
  if (extra.restarted !== true) details.push('没有实际中断/重开应用并恢复原任务的证据')
  if (extra.recovered === false) details.push('重开后未恢复原任务/进度')
  if (ids.length !== 2 || ids[0] !== 'A' || ids[1] !== 'B') details.push(`登记记录不是 A/B 两条：${JSON.stringify(ids)}`)
  if (duplicates > 0) details.push(`存在重复登记：${duplicates}`)
  if (extra.replayedA === true) details.push('恢复了已完成 A 的重复提交')
  if (!result || !Array.isArray(result.ids) || !(result.ids as unknown[]).includes('A') || !(result.ids as unknown[]).includes('B') || Number(result.count) !== 2) {
    details.push(`out/result.json 不符：${JSON.stringify(result)}`)
  }
  return {
    ok: details.length === 0,
    detail: details.length ? details.join('；') : '真实中断并重开恢复原任务；先查询后只登记 A/B 两条，无重复提交；result ids/count 正确',
    actual: extra
  }
}

const base = new Map(R9_QUESTIONS.map((spec) => [spec.id, spec]))

const M43: R9QuestionSpec = {
  ...base.get('M43')!,
  declaredSupport: 'supported',
  supportNote: 'R9.1 子代理与主代理同权限 + 同消息多 task 并发；本题要求真实并行、子任务各自写 out 文件、父任务写最终 result',
  kind: 'single',
  requires: ['subagent'],
  workspaceFiles: { 'in/a.json': '{"id":"A","value":11}\n', 'in/b.json': '{"id":"B","value":19}\n' },
  prompt:
    '请并行安排两个真实子任务，分别读取 in/a.json 和 in/b.json。A 只能写 out/a.json，B 只能写 out/b.json，格式分别是 id、value。两个子任务都不得写 out/result.json。你等两份有效结果齐了再写最终文件，records 按 id 排序，并给出 total。不要让子任务竞争覆盖同一个文件。',
  checker: m43Checker
}

const M44: R9QuestionSpec = {
  ...base.get('M44')!,
  declaredSupport: 'supported',
  supportNote: 'R9.1 子代理全权限可调用 MCP；父取消必须向在途子任务/工具传播。本题按题库要求只测一个正在运行的真实子任务（产品支持多个时再补 B）',
  kind: 'single',
  requires: ['subagent', 'mcp'],
  prompt:
    '先说：请建立一个真实子任务，调用本地 child44_wait，label 为 A，等待真正完成后再汇总；只操作本地假服务，不要自行假定成功。若当前没有真实子任务或 MCP 能力，明确说不支持。',
  checker: m44Checker
}

const M45: R9QuestionSpec = {
  ...base.get('M45')!,
  declaredSupport: 'supported',
  supportNote: '部分支持：子代理可调用 MCP child45_read，B 在 30s 后返回标准 timeout；产品只有工具级 timeout，没有子任务级 2min/20 次预算（题面预算未实现，报告中注明）',
  kind: 'single',
  requires: ['subagent', 'mcp'],
  prompt:
    '建立两个真实子任务，分别从本地 child45_read 读取 A 和 B。B 若超时不要重试，保留 A 的有效结果并明确未完成。只在两者都有真实数值时计算总和。将 status、a_value、b_value、total、failed_children 写入 out/result.json，缺失数值用 null，不要补0。',
  checker: m45Checker
}

const M46: R9QuestionSpec = {
  ...base.get('M46')!,
  declaredSupport: 'supported',
  supportNote: 'R9.1 子代理可调用 MCP；child46_read 返回传输成功但 isError=true（validation_error），父子链必须保留真实错误、不重试、不换参数',
  kind: 'single',
  requires: ['subagent', 'mcp'],
  prompt:
    '让一个真实子任务通过本地只读 child46_read 查询 C46；如果工具报告错误，不要重试，也不要把它当成功。再用 child46_get 核对实际状态。最终 out/result.json 写 status、record_count、reason；读取失败时明确写 failed、0、validation_error。',
  checker: m46Checker
}

const M47: R9QuestionSpec = {
  ...base.get('M47')!,
  declaredSupport: 'supported',
  supportNote:
    'R9.1 子代理全权限可写 + 可调 MCP；但 engine 已明确子代理运行态不落库（无子任务级持久恢复）。运行后按实际证据记 UNSUPPORTED，不提前缩分母；可另测会话级恢复/幂等查询作为证据，不等同题面中断恢复。',
  kind: 'single',
  requires: ['subagent', 'mcp'],
  prompt:
    '用两个真实子任务登记 A、B，分别使用 case47-A 和 case47-B。只操作本地假服务。每次确认进度后保存 checkpoint。中断恢复后先查询已有记录，不重复登记已经完成的项。最终查询核实后在 out/result.json 写 ids、count。',
  checker: m47Checker
}

export const QUESTIONS: R9QuestionSpec[] = R9_QUESTIONS.map((spec) => {
  if (spec.id === 'M43') return M43
  if (spec.id === 'M44') return M44
  if (spec.id === 'M45') return M45
  if (spec.id === 'M46') return M46
  if (spec.id === 'M47') return M47
  if (spec.id === 'M40') {
    return {
      ...spec,
      declaredSupport: 'supported' as const,
      supportNote:
        'R9.1 子代理与主代理同工具集/权限/审批链；本题由真实子任务读取各自输入，父任务只做汇总写 result；子任务身份以父 task 调用 ID+结果/进度事件归属（产品不单独暴露独立子任务 ID/session）'
    }
  }
  if (spec.id === 'M41') {
    return {
      ...spec,
      declaredSupport: 'supported' as const,
      supportNote: '父会话设为只读时，R9.1 子代理权限不得高于父（只读传播）；本题全程无写文件/命令/记忆/MCP'
    }
  }
  if (spec.id === 'M42') {
    return {
      ...spec,
      declaredSupport: 'supported' as const,
      supportNote:
        '两个独立会话/工作根；R9.1 子代理与主代理同权限但不得跨会话注入上下文。产品无独立“上下文审计”事件，隔离结论以产物/会话/事件无 B 标记 + 代码路径核查为证据'
    }
  }
  return { ...spec, declaredSupport: 'supported' as const }
})

export const R91_EXPECTED_IDS = R9_QUESTIONS.map((spec) => spec.id)

export function r91SpecById(id: string): R9QuestionSpec | undefined {
  return QUESTIONS.find((spec) => spec.id === id)
}
