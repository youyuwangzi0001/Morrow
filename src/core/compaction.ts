import type { ChatMessage } from '../shared/types'
import { truncateText } from './util'

/**
 * 压缩账本：把路径、命令、数字、用户硬约束等「模型改写容易丢」的事实
 * 从原文中确定性抽取出来，作为下一次压缩也不会被重写的锚点。
 * 这不是摘要模型的替代品，而是摘要之外的防漂移层。
 */

const SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|密码|令牌)\s*[:=]\s*[^\s，。；;]+)/i

const CONSTRAINT_PATTERN =
  /(必须|务必|禁止|不要|不得|只能|仅限|保持|保留|沿用|不改|别动|采用|定稿|决定|约束|预算|上限|截止|验收|兼容|不能|记得|默认|优先|最后|结尾|结局)/

const EVIDENCE_PATTERN =
  /(失败|错误|报错|异常|通过|成功|passed|failed|error|exception|timeout|端口|版本|依赖|根因|修复|测试|回归|性能|coverage|覆盖率|audit|审计|并发)/i

const STORY_PATTERN =
  /(第[一二三四五六七八九十百\d]+章|人物|角色|主角|配角|关系|设定|世界观|伏笔|悬念|线索|时间线|结局|反转|场景|章节)/

const DECISION_PATTERN = /(决定|采用|改为|结论|根因|修复|验证|确认|定稿|方案)/

const COMMAND_PATTERN =
  /^\s*(?:\$|>)\s+\S+|^(?:npm|pnpm|yarn|npx|node|bun|deno|git|python|python3|pip|pytest|uv|cargo|go|dotnet|java|mvn|gradle|docker|kubectl|curl|wget|rg|grep|ls|cat|sed|awk|find|powershell|pwsh)\b/i

const PATH_PATTERN =
  /(?:[A-Za-z]:[\\/][^\s"'<>，。；;]+|(?:\.{0,2}[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|css|scss|html|htm|sql|yml|yaml|toml|ini|txt|csv|tsv|xlsx|docx|pdf|pptx|zip|png|jpe?g|webp|mp4|mov|wav|mp3))(?::\d+)?/g

const URL_PATTERN = /https?:\/\/[^\s"'<>，。；;]+/g

const NUMBER_PATTERN =
  /\b\d+(?:\.\d+)?(?:\s*(?:ms|s|秒|分钟|小时|%|元|次|条|行|章|字|tokens?|KB|MB|GB|px))?\b/g

interface LedgerBucket {
  constraints: string[]
  story: string[]
  evidence: string[]
  files: string[]
  commands: string[]
  urls: string[]
  numbers: string[]
}

function cleanLine(raw: string, max = 260): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^[-•*]\s*/, '')
    .trim()
    .slice(0, max)
}

function addUnique(target: string[], value: string, seen: Set<string>, max: number): void {
  const line = cleanLine(value)
  if (!line || line.length < 3 || seen.has(line) || target.length >= max) return
  if (SECRET_PATTERN.test(line)) return
  seen.add(line)
  target.push(line)
}

/**
 * 从被裁掉的历史里抽取可原文复用的关键事实。
 * 只收集短行/结构化片段，避免把整段工具输出或小说正文塞回上下文。
 */
export function extractCompactionLedger(messages: ChatMessage[], maxChars = 6000): string {
  const buckets: LedgerBucket = {
    constraints: [],
    story: [],
    evidence: [],
    files: [],
    commands: [],
    urls: [],
    numbers: []
  }
  const seen = new Set<string>()
  const add = (bucket: keyof LedgerBucket, value: string, max: number): void => {
    addUnique(buckets[bucket], value, seen, max)
  }

  for (const message of messages) {
    // 旧摘要/旧账本由 compose 负责，不从摘要里二次抽取，避免摘要漂移被放大。
    if (message.role === 'system') continue
    for (const block of message.content) {
      let text = ''
      if (block.type === 'text') text = block.text
      else if (block.type === 'tool_use') {
        text = [block.result?.output ?? '', block.result?.error ?? ''].filter(Boolean).join('\n')
        if (block.input) {
          try {
            const input = JSON.stringify(block.input)
            if (input.length < 4000) text += `\n${input}`
          } catch {
            // 不可序列化的工具入参不进入账本
          }
        }
      } else {
        continue
      }
      if (!text.trim()) continue
      for (const rawLine of text.split(/\n|(?<=[。；;])/)) {
        const line = cleanLine(rawLine)
        if (line.length < 4) continue
        if (SECRET_PATTERN.test(line)) continue
        if (message.role === 'user' && CONSTRAINT_PATTERN.test(line)) {
          add('constraints', line, 16)
        }
        if (STORY_PATTERN.test(line)) {
          add('story', line, 16)
        }
        if (message.role !== 'user' && DECISION_PATTERN.test(line) && line.length <= 240) {
          add('evidence', line, 20)
        }
        for (const metric of rawLine.match(/[0-9]+(?:[.][0-9]+)?%|[0-9]+\s*(?:passed|failed)/gi) ?? []) add('numbers', metric, 14)
        if (EVIDENCE_PATTERN.test(line) && line.length <= 240) {
          add('evidence', line, 14)
          // 覆盖率/通过数/迁移号等关键指标优先于普通数字，避免被更早的端口/日期挤掉。
          for (const metric of rawLine.match(/[0-9]+(?:[.][0-9]+)?%|[0-9]+\s*(?:passed|failed)/gi) ?? []) {
            add('numbers', metric, 14)
          }
          for (const number of rawLine.match(/[0-9]+(?:[.][0-9]+)?/g) ?? []) add('numbers', number, 14)
        }
        for (const path of rawLine.match(PATH_PATTERN) ?? []) add('files', path, 14)
        for (const url of rawLine.match(URL_PATTERN) ?? []) add('urls', url, 8)
        if (COMMAND_PATTERN.test(rawLine)) add('commands', rawLine, 8)
        // 只收集带单位/上下文语义的数字，避免把每个行号都塞进账本
        for (const number of rawLine.match(NUMBER_PATTERN) ?? []) {
          if (/[%元秒分钟小时次条行章字tokens?]|ms\b|\bs\b/i.test(number)) add('numbers', number, 14)
        }
      }
    }
  }

  const sections: string[] = []
  const push = (title: string, values: string[]): void => {
    if (values.length > 0) sections.push(`${title}\n${values.map((value) => `- ${value}`).join('\n')}`)
  }
  push('### 关键数据', [...buckets.urls, ...buckets.numbers])
  push('### 用户约束与决定', buckets.constraints)
  push('### 故事/研究事实', buckets.story)
  push('### 错误、证据与结论', buckets.evidence)
  push('### 文件与路径', buckets.files)
  push('### 命令与测试', buckets.commands)
  const text = sections.join('\n\n')
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/** 只移除指定的一节（到下一个二级标题为止），不误删它后面的历史摘要。 */
function stripSummarySection(summary: string, heading: RegExp): string {
  const match = heading.exec(summary)
  if (!match || match.index === undefined) return summary.trim()
  const start = match.index
  // 从本节标题所在行的下一行开始找下一个二级标题；否则会把本节自己的标题当成“下一节”。
  const lineEnd = summary.indexOf('\n', start + match[0].length)
  const bodyStart = lineEnd >= 0 ? lineEnd : summary.length
  const next = summary.slice(bodyStart).search(/\n##\s/)
  const end = next >= 0 ? bodyStart + next : summary.length
  return `${summary.slice(0, start)}${summary.slice(end)}`.trim()
}

/** 去掉旧摘要里由系统生成的账本段，避免重复累积。 */
function stripLedger(summary: string): string {
  return stripSummarySection(summary, /\n*## 关键信息账本/)
}

/** 去掉上一次压缩写入的运行状态；每次压缩都从当前真实状态重新生成。 */
function stripRuntimeCheckpoint(summary: string): string {
  return stripSummarySection(summary, /\n*## 运行状态（系统记录/)
}

export interface RuntimeCheckpointInput {
  goal?: {
    objective?: string
    status?: string
    round?: number
    maxRounds?: number
    nextStep?: string
    blockedReason?: string
  } | null
  plan?: {
    title?: string
    status?: string
    steps?: Array<{ text?: string }>
  } | null
  todos?: Array<{ text: string; status: string }>
  artifacts?: Array<{ title: string; kind?: string; path?: string }>
  /** 完整对话；用于自动取最近一条用户指令，避免调用方各自实现。 */
  messages?: ChatMessage[]
  lastUserText?: string
}

const PLAN_STATUS_TEXT: Record<string, string> = {
  pending: '待批准',
  executing: '执行中',
  completed: '已完成',
  rejected: '已驳回'
}

const TODO_STATUS_MARK: Record<string, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]'
}

const TODO_STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2
}

function lastUserMessageText(messages: ChatMessage[] | undefined): string {
  if (!messages) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = message.content
      .filter((block): block is Extract<ChatMessage['content'][number], { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * 压缩检查点的「系统运行状态」。
 */
export function buildRuntimeCheckpoint(input: RuntimeCheckpointInput, maxChars = 2400): string {
  const lines: string[] = []
  const safe = (value: string | undefined, max: number): string => {
    const line = cleanLine(value ?? '', max)
    if (!line || SECRET_PATTERN.test(line)) return ''
    return line
  }
  const push = (label: string, value: string | undefined, max = 280): void => {
    const line = safe(value, max)
    if (line) lines.push(`- ${label}：${line}`)
  }

  if (input.goal?.objective) {
    const round = input.goal.round
    const maxRounds = input.goal.maxRounds
    const progress = round ? `（第 ${round}${maxRounds ? `/${maxRounds}` : ''} 轮）` : ''
    push('当前目标', `${input.goal.objective}${progress}`, 360)
    if (input.goal.nextStep) push('目标下一步', input.goal.nextStep, 260)
    if (input.goal.blockedReason) push('阻塞原因', input.goal.blockedReason, 220)
  }

  if (input.plan?.title) {
    const status = PLAN_STATUS_TEXT[input.plan.status ?? ''] ?? input.plan.status ?? ''
    push('当前计划', `${input.plan.title}${status ? `（${status}）` : ''}`, 240)
    const steps = (input.plan.steps ?? []).map((step) => safe(step.text, 140)).filter(Boolean).slice(0, 6)
    for (const step of steps) lines.push(`  - ${step}`)
    if ((input.plan.steps?.length ?? 0) > steps.length) {
      lines.push(`  - …还有 ${(input.plan.steps?.length ?? 0) - steps.length} 步未列出`)
    }
  }

  if (input.todos && input.todos.length > 0) {
    lines.push('- 当前待办：')
    const sorted = [...input.todos].sort(
      (a, b) => (TODO_STATUS_ORDER[a.status] ?? 9) - (TODO_STATUS_ORDER[b.status] ?? 9)
    )
    const shown = sorted.slice(0, 12)
    for (const todo of shown) {
      const text = safe(todo.text, 140)
      if (text) lines.push(`  - ${TODO_STATUS_MARK[todo.status] ?? '[ ]'} ${text}`)
    }
    if (sorted.length > shown.length) lines.push(`  - …还有 ${sorted.length - shown.length} 项未列出`)
  }

  const lastUser = input.lastUserText ?? lastUserMessageText(input.messages)
  if (lastUser) push('最近用户指令', lastUser, 420)

  if (input.artifacts && input.artifacts.length > 0) {
    const names = input.artifacts
      .slice(-5)
      .map((artifact) => safe(`${artifact.title}${artifact.path ? `（${artifact.path}）` : ''}`, 160))
      .filter(Boolean)
    if (names.length > 0) push('最近产物', names.join('、'), 360)
  }

  return lines.join('\n').slice(0, maxChars)
}

/** 头尾保留的中间折叠：比只截头部多留下工具输出的最终结论、测试结果和错误尾行。 */
export function pruneMiddle(text: string, maxChars: number, note = '内容已折叠'): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  if (maxChars < 120) return truncateText(text, maxChars, note)
  let marker = `\n…（${note}）…\n`
  let room = maxChars - marker.length
  for (let round = 0; round < 2; round += 1) {
    if (room < 60) return truncateText(text, maxChars, note)
    const omitted = Math.max(0, text.length - room)
    marker = `\n…（${note}：中间省略 ${omitted} 字符，共 ${text.length} 字符）…\n`
    room = maxChars - marker.length
  }
  if (room < 40) return truncateText(text, maxChars, note)
  const head = Math.max(1, Math.floor(room * 0.72))
  const tail = Math.max(1, room - head)
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`
}

export interface ToolPruneConfig {
  thresholdChars: number
  headChars: number
  tailChars: number
}

/** 与 DSH 的 tool-result-pruner 对齐：只在超大时保留头尾，完整原文仍在会话记录里。 */
export const DEFAULT_TOOL_RESULT_PRUNE: ToolPruneConfig = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024
}

export interface ToolPruneResult {
  messages: ChatMessage[]
  prunedCount: number
  savedChars: number
}

function pruneToolText(text: string, config: ToolPruneConfig): string {
  if (text.length <= config.thresholdChars) return text
  const head = Math.max(1, config.headChars)
  const tail = Math.max(1, config.tailChars)
  const omitted = Math.max(0, text.length - head - tail)
  const marker = `\n\n…（工具输出中段已修剪：省略 ${omitted} 字符；完整原文保留在会话日志）…\n\n`
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`
}

/** 压缩触发后先对模型侧做一次确定性修剪；不改完整记录，也不发起模型调用。 */
export function pruneToolOutputsForModel(
  messages: ChatMessage[],
  config: ToolPruneConfig = DEFAULT_TOOL_RESULT_PRUNE,
  keepRecent = 0
): ToolPruneResult {
  let prunedCount = 0
  let savedChars = 0
  // 最近几条消息往往是「当前正在处理的结果」，保留原文；
  // 只修剪较早的大日志，避免为了省 token 把刚读到的关键行折掉。
  const protectedFrom = keepRecent > 0 ? Math.max(0, messages.length - keepRecent) : messages.length
  const next = messages.map((message, index) => {
    if (index >= protectedFrom) return message
    if (isCompactionSummaryMessage(message)) return message
    let changed = false
    const content = message.content.map((block) => {
      if (block.type !== 'tool_use' || !block.result) return block
      const output = block.result.output ?? ''
      const error = block.result.error ?? ''
      const nextOutput = pruneToolText(output, config)
      const nextError = pruneToolText(error, config)
      if (nextOutput === output && nextError === error) return block
      changed = true
      prunedCount += (nextOutput !== output ? 1 : 0) + (nextError !== error ? 1 : 0)
      savedChars += output.length - nextOutput.length + (error.length - nextError.length)
      return {
        ...block,
        result: { ...block.result, output: nextOutput, error: nextError }
      }
    })
    return changed ? { ...message, content } : message
  })
  return { messages: next, prunedCount, savedChars }
}

/**
 * 组合压缩摘要：账本放最前（即使后续截断也先保留），旧摘要原文保留，
 * 只追加本次「新增历史」的摘要，避免摘要改写摘要造成的累积漂移。
 */
export function composeCompactionSummary(
  previousSummary: string | undefined,
  newSummary: string,
  ledger: string,
  maxChars = 16_000,
  runtimeCheckpoint = ''
): string {
  const previous = stripLedger(stripRuntimeCheckpoint(previousSummary ?? ''))
  const ledgerPart = ledger.trim() ? `## 关键信息账本（系统原文保留，不参与重写）\n${ledger.trim()}` : ''
  const runtimePart = runtimeCheckpoint.trim()
    ? `## 运行状态（系统记录，压缩时刷新）\n${runtimeCheckpoint.trim()}`
    : ''
  const previousPart = previous ? `## 历史交接摘要（原文保留）\n${previous}` : ''
  const newPart = newSummary.trim() ? `## 新增历史摘要\n${newSummary.trim()}` : ''
  const fixedPart = [ledgerPart, runtimePart].filter(Boolean).join('\n\n')
  if (!fixedPart) {
    return [previousPart, newPart].filter(Boolean).join('\n\n').slice(0, maxChars)
  }
  const previousRoom = Math.max(0, maxChars - fixedPart.length - newPart.length - 32)
  const trimmedPrevious = previousPart.slice(0, previousRoom)
  return [fixedPart, trimmedPrevious, newPart].filter(Boolean).join('\n\n').slice(0, maxChars)
}

/**
 * 按记录里的截断预算收紧模型侧内容：只截工具输出与普通文本，摘要标记保持完整。
 * 与 agent.ts 的 shrinkToolOutputs 同义，但不能反向依赖它（core/index 已经双向引用）。
 */
function shrinkForModelView(messages: ChatMessage[], trimChars: number): ChatMessage[] {
  return messages.map((message) => {
    if (isCompactionSummaryMessage(message)) return message
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === 'tool_use' && block.result) {
          return {
            ...block,
            result: {
              ...block.result,
              output: pruneMiddle(block.result.output ?? '', trimChars, '工具输出已折叠'),
              error: pruneMiddle(block.result.error ?? '', trimChars, '工具错误已折叠')
            }
          }
        }
        if (block.type === 'text') return { ...block, text: pruneMiddle(block.text, Math.max(1200, trimChars * 3)) }
        return block
      })
    }
  })
}

/** 判断一条消息是否是压缩摘要，供摘要输入过滤。 */
export function isCompactionSummaryMessage(message: ChatMessage): boolean {
  if (message.role !== 'system') return false
  return message.content.some((block) => block.type === 'text' && /^\[历史对话摘要/.test(block.text.trim()))
}

/**
 * 从完整记录里取出发给模型的上下文（模型侧视图）。
 *
 * 压缩只在记录的真实切点插入一条摘要标记（role=system + preservedMessageIds），
 * **不删除任何原始消息**。记录始终是完整原文，这里只是挑出「发给模型的那一份」：
 * 摘要 + 被标记为保留的那些消息。这样压缩是可逆的 —— 用户随时能看到原文，
 * 而不是被一段摘要永久顶替。
 */
export function modelMessagesFrom(
  messages: ChatMessage[],
  options: { mapPreserved?: (message: ChatMessage) => ChatMessage } = {}
): ChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const marker = messages[index]!
    if (!isCompactionSummaryMessage(marker)) continue
    const preservedIds = new Set(marker.preservedMessageIds ?? [])
    // 保留消息在记录里位于标记之前；按记录顺序取出，保持时间线。
    // mapPreserved 用于「模型侧做长度上限」——只影响发给模型的那份副本，记录仍是原文。
    const preserved: ChatMessage[] = []
    for (const message of messages) {
      if (message === marker) break
      if (!preservedIds.has(message.id)) continue
      preserved.push(options.mapPreserved ? options.mapPreserved(message) : message)
    }
    const view = [marker, ...preserved, ...messages.slice(index + 1)]
    // 压缩时按预算收紧过工具输出，预算记在标记上；重建必须复现同样的收紧，
    // 否则「压缩→下一轮请求」之间会退回原文，压缩率当场失效。
    // 只收到 modelTrimThroughId（压缩当时的最新消息）：之后新追加的内容保持原文。
    const trimChars = marker.modelTrimChars ?? 0
    if (trimChars <= 0) return view
    const throughId = marker.modelTrimThroughId
    let boundary = throughId ? view.findIndex((message) => message.id === throughId) : -1
    if (boundary < 0) boundary = view.length - 1
    return [...shrinkForModelView(view.slice(0, boundary + 1), trimChars), ...view.slice(boundary + 1)]
  }
  // 总是返回新数组：调用方会往模型侧追加消息，共享引用会让完整记录被连带改写
  return options.mapPreserved ? messages.map((message) => options.mapPreserved!(message)) : [...messages]
}

