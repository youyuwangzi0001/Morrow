/**
 * 厂商无关的工具调用文本协议层。
 *
 * OpenAI 兼容接口正常应把工具调用放在结构化 tool_calls 里；但不同模型/网关
 * 在兼容性不佳时会把各自的“文本工具协议”写进正文。已知形态包括：
 *
 * - DeepSeek：`<｜｜DSML｜｜ calls>…` / `<|DSML|tool_calls>…`
 * - Kimi K2/K3：`<|tool_calls_section_begin|>` + `<|tool_call_begin|>functions.foo:0`
 * - MiniMax M2/M3：`<minimax:tool_call><invoke name="foo"><parameter …>`
 * - Qwen：`<tool_call>{"name":…,"arguments":…}</tool_call>` 或 `<function=foo><parameter=…>`
 * - GLM：`<tool_call>foo<arg_key>…</arg_key><arg_value>…</arg_value></tool_call>`
 * - Hermes / 通用：`<tool_call>` / `<function_call>` / `<invoke>`
 * - Mistral：`[TOOL_CALLS] [{"name":…}]`
 * - Llama：`<|python_tag|>{"name":…,"parameters":…}` 或 `[foo(x=1)]`
 *
 * 该模块负责：流式剔除协议文本、把可识别的调用还原成 {name,input}。
 */

const PIPE = '[|｜]{1,2}'
const DSML_MARK = `<${PIPE}\\s*DSML\\s*${PIPE}`

export interface TextToolCall {
  name: string
  input: Record<string, unknown>
}

/* ── 通用工具 ─────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function attr(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attributes)
  if (!match) return null
  return match[1] ?? match[2] ?? match[3] ?? null
}

function decodeValue(raw: string, stringAttr: string | null): unknown {
  if (stringAttr === 'true') return raw
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  if (stringAttr === 'false') {
    try {
      return JSON.parse(trimmed)
    } catch {
      return raw
    }
  }
  if (/^(?:[{[0-9-]|true$|false$|null$)/.test(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return raw
    }
  }
  return raw
}

function coerceInput(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw
  if (Array.isArray(raw)) return { value: raw }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    try {
      const parsed = JSON.parse(trimmed)
      if (isRecord(parsed)) return parsed
      return { value: parsed }
    } catch {
      return {}
    }
  }
  return {}
}

function normalizeCall(value: unknown): TextToolCall | null {
  if (!isRecord(value)) return null
  const fn = isRecord(value.function) ? value.function : isRecord(value.tool) ? value.tool : value
  const name =
    (typeof fn.name === 'string' && fn.name.trim()) ||
    (typeof value.name === 'string' && value.name.trim()) ||
    (typeof value.tool_name === 'string' && value.tool_name.trim()) ||
    (typeof value.function_name === 'string' && value.function_name.trim()) ||
    (typeof value.tool === 'string' && value.tool.trim()) ||
    ''
  if (!name) return null
  const args =
    fn.arguments ?? fn.parameters ?? fn.input ?? value.arguments ?? value.parameters ?? value.input ?? value.args ?? {}
  return { name, input: coerceInput(args) }
}

function collectCalls(value: unknown): TextToolCall[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCalls(item))
  }
  if (isRecord(value) && Array.isArray(value.tool_calls)) {
    return value.tool_calls.flatMap((item) => collectCalls(item))
  }
  const call = normalizeCall(value)
  return call ? [call] : []
}

/** 扫描文本里所有完整的 JSON 对象/数组（忽略字符串内的括号）。 */
function jsonSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char !== '{' && char !== '[') {
      index += 1
      continue
    }
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const current = text[cursor]
      if (inString) {
        if (escaped) escaped = false
        else if (current === '\\') escaped = true
        else if (current === '"') inString = false
        continue
      }
      if (current === '"') {
        inString = true
        continue
      }
      if (current === '{' || current === '[') depth += 1
      else if (current === '}' || current === ']') {
        depth -= 1
        if (depth === 0) {
          end = cursor + 1
          break
        }
      }
    }
    if (end > index) {
      spans.push({ start: index, end })
      index = end
    } else {
      index += 1
    }
  }
  return spans
}

function parseJsonCalls(text: string): TextToolCall[] {
  const calls: TextToolCall[] = []
  for (const span of jsonSpans(text)) {
    const raw = text.slice(span.start, span.end)
    try {
      calls.push(...collectCalls(JSON.parse(raw)))
    } catch {
      // 非 JSON，留给其它协议解析
    }
  }
  return calls
}

function normalizeDsmlTags(text: string): string {
  return text
    .replace(new RegExp(`</${PIPE}\\s*DSML\\s*${PIPE}\\s*`, 'gi'), '</')
    .replace(new RegExp(`<${PIPE}\\s*DSML\\s*${PIPE}\\s*`, 'gi'), '<')
}

function parseXmlParameters(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  const normalized = normalizeDsmlTags(body)
  // Qwen / MiniMax / DSML：<parameter name="x" string="true">v</parameter>
  const named = new RegExp(
    `<parameter\\b([^>]*)>([\\s\\S]*?)</parameter>`,
    'gi'
  )
  for (const match of normalized.matchAll(named)) {
    const attributes = match[1] ?? ''
    const name = attr(attributes, 'name')
    if (!name) continue
    input[name] = decodeValue(match[2] ?? '', attr(attributes, 'string'))
  }
  // Qwen3：<parameter=x>v</parameter>
  for (const match of normalized.matchAll(/<parameter=([A-Za-z_][\w.-]*)\s*>([\s\S]*?)<\/parameter>/gi)) {
    const name = match[1]
    if (name) input[name] = decodeValue(match[2] ?? '', null)
  }
  // GLM：<arg_key>k</arg_key><arg_value>v</arg_value>
  for (const match of normalized.matchAll(/<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi)) {
    const name = (match[1] ?? '').trim()
    if (name) input[name] = decodeValue(match[2] ?? '', null)
  }
  return input
}

function parseInvokeBlocks(body: string): TextToolCall[] {
  const calls: TextToolCall[] = []
  for (const match of body.matchAll(/<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi)) {
    const name = attr(match[1] ?? '', 'name')
    if (!name) continue
    let input = parseXmlParameters(match[2] ?? '')
    if (Object.keys(input).length === 0) {
      const json = parseJsonCalls(match[2] ?? '')
      if (json.length === 1) input = json[0].input
    }
    calls.push({ name, input })
  }
  return calls
}

function looksLikeToolName(value: string): boolean {
  const trimmed = value.trim()
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(trimmed)
}

/** 解析 `<tool_call>…</tool_call>` 内部（JSON / Qwen / GLM / invoke 多种形态）。 */
function parseToolCallBody(body: string): TextToolCall[] {
  const trimmed = body.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = parseJsonCalls(trimmed)
    if (json.length > 0) return json
  }
  const invokes = parseInvokeBlocks(trimmed)
  if (invokes.length > 0) return invokes

  // Qwen3：<function=foo><parameter=x>v</parameter></function>
  for (const match of trimmed.matchAll(/<function(?:=|\s+name=)["']?([A-Za-z_][\w.-]*)["']?\s*>([\s\S]*?)<\/function>/gi)) {
    const name = match[1]
    if (!name) continue
    return [{ name, input: parseXmlParameters(match[2] ?? '') }]
  }

  // GLM：foo\n<arg_key>…</arg_key><arg_value>…</arg_value>
  if (/<arg_key>/i.test(trimmed)) {
    const firstTag = trimmed.search(/<arg_key>/i)
    const name = trimmed.slice(0, firstTag).replace(/<[^>]+>/g, ' ').trim().split(/\s+/)[0] ?? ''
    if (looksLikeToolName(name)) return [{ name, input: parseXmlParameters(trimmed) }]
  }

  // 通用：首行是工具名，其余是 JSON 参数
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (looksLikeToolName(firstLine)) {
    const rest = trimmed.slice(firstLine.length).trim()
    const json = rest ? parseJsonCalls(rest) : []
    if (json.length === 1) return [{ name: firstLine, input: json[0].input }]
    return [{ name: firstLine, input: parseXmlParameters(trimmed) }]
  }
  return []
}

function parseTagBlocks(text: string, tag: 'tool_call' | 'tool_calls' | 'function_call'): TextToolCall[] {
  const calls: TextToolCall[] = []
  const matcher = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
  for (const match of text.matchAll(matcher)) {
    const body = match[1] ?? ''
    if (tag === 'function_call') {
      const json = parseJsonCalls(body)
      if (json.length > 0) calls.push(...json)
      else calls.push(...parseToolCallBody(body))
      continue
    }
    // 外层 <tool_calls> 可能包着多个 <tool_call>
    if (tag === 'tool_calls' && /<tool_call\b/i.test(body)) {
      calls.push(...parseTagBlocks(body, 'tool_call'))
      continue
    }
    calls.push(...parseToolCallBody(body))
  }
  return calls
}

function parseKimi(text: string): TextToolCall[] {
  if (!text.includes('tool_call_begin')) return []
  const calls: TextToolCall[] = []
  const matcher = /<\|tool_call_begin\|>\s*([\s\S]*?)<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/gi
  for (const match of text.matchAll(matcher)) {
    const header = (match[1] ?? '').trim().split(/\r?\n/)[0] ?? ''
    let name = header.replace(/^(?:functions?|tools?)\./i, '').replace(/:\d+$/, '').trim()
    if (!looksLikeToolName(name) || /^call_[A-Za-z0-9]+$/i.test(name)) name = ''
    let input: Record<string, unknown> = {}
    let embedded: TextToolCall | null = null
    try {
      const parsed = JSON.parse((match[2] ?? '').trim())
      embedded = normalizeCall(parsed)
      input = coerceInput(parsed)
    } catch {
      // 参数不是合法 JSON：保留空参数，由 Agent 生成可自修复错误
    }
    if (name) {
      calls.push({ name, input: embedded ? embedded.input : input })
    } else if (embedded) {
      calls.push(embedded)
    } else if (input && typeof input.name === 'string') {
      calls.push({ name: input.name, input })
    }
  }
  return calls
}

function parseSpecialToolTags(text: string): TextToolCall[] {
  const calls: TextToolCall[] = []
  for (const match of text.matchAll(/<\|tool_call\|>([\s\S]*?)(?:<\|tool_call_end\|>|<\|<\/tool_call\|>)/gi)) {
    calls.push(...parseToolCallBody(match[1] ?? ''))
  }
  return calls
}

function parsePythonic(text: string): TextToolCall[] {
  const trimmed = text.trim().replace(/^\[/, '').replace(/\]$/, '')
  const match = /^([A-Za-z_][\w.]*)\s*\(([\s\S]*)\)$/.exec(trimmed)
  if (!match) return []
  const name = match[1]
  const input: Record<string, unknown> = {}
  const args = match[2] ?? ''
  for (const part of args.split(/,\s*(?=[A-Za-z_][\w]*\s*=)/)) {
    const pair = /^([A-Za-z_][\w]*)\s*=\s*([\s\S]+)$/.exec(part.trim())
    if (!pair) continue
    let value = pair[2].trim()
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    input[pair[1]] = decodeValue(value, null)
  }
  return [{ name, input }]
}

function parsePrefixPayloads(text: string): TextToolCall[] {
  const calls: TextToolCall[] = []
  const mistral = /\[TOOL_CALLS\]/gi
  for (const match of text.matchAll(mistral)) {
    const rest = text.slice((match.index ?? 0) + match[0].length)
    const json = parseJsonCalls(rest)
    calls.push(...(json.length > 0 ? json : parsePythonic(rest)))
    break
  }
  const pythonTag = /<\|python_tag\|>/gi
  for (const match of text.matchAll(pythonTag)) {
    const rest = text.slice((match.index ?? 0) + match[0].length)
    const json = parseJsonCalls(rest)
    calls.push(...(json.length > 0 ? json : parsePythonic(rest)))
    break
  }
  return calls
}

function parseDsml(text: string): TextToolCall[] {
  if (!text.includes('DSML')) return []
  const calls: TextToolCall[] = []
  const invoke = new RegExp(`${DSML_MARK}\\s*invoke\\b([^>]*)>([\\s\\S]*?)</${PIPE}\\s*DSML\\s*${PIPE}\\s*invoke\\s*>`, 'gi')
  for (const match of text.matchAll(invoke)) {
    const name = attr(match[1] ?? '', 'name')
    if (!name) continue
    let input = parseXmlParameters(match[2] ?? '')
    if (Object.keys(input).length === 0) {
      const json = parseJsonCalls(match[2] ?? '')
      if (json.length === 1) input = json[0].input
    }
    calls.push({ name, input })
  }
  if (calls.length === 0) {
    const callsBlock = new RegExp(`${DSML_MARK}\\s*(?:calls|tool_calls)\\s*>([\\s\\S]*?)</${PIPE}\\s*DSML\\s*${PIPE}\\s*(?:calls|tool_calls)\\s*>`, 'i').exec(text)
    if (callsBlock) calls.push(...parseJsonCalls(callsBlock[1] ?? ''))
  }
  return calls
}

function dedupeCalls(calls: TextToolCall[]): TextToolCall[] {
  const seen = new Set<string>()
  const output: TextToolCall[] = []
  for (const call of calls) {
    const key = `${call.name}\u0000${JSON.stringify(call.input)}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(call)
  }
  return output
}

/** 从任意文本中解析出所有可识别的工具调用。 */
export function parseTextToolCalls(text: string): TextToolCall[] {
  if (!text) return []
  const calls: TextToolCall[] = []
  calls.push(...parseDsml(text))
  calls.push(...parseTagBlocks(text, 'tool_call'))
  calls.push(...parseTagBlocks(text, 'tool_calls'))
  calls.push(...parseTagBlocks(text, 'function_call'))
  calls.push(...parseInvokeBlocks(text))
  calls.push(...parseKimi(text))
  calls.push(...parseSpecialToolTags(text))
  calls.push(...parsePrefixPayloads(text))
  for (const match of text.matchAll(/```(?:tool_calls?|function_call)\s*\n?([\s\S]*?)```/gi)) {
    calls.push(...parseJsonCalls(match[1] ?? ''))
  }
  return dedupeCalls(calls)
}

/** 从文本中剔除所有已知的文本工具协议，保留正常回答；Markdown 代码围栏内的示例原样保留。 */
export function stripToolProtocol(text: string): string {
  if (!text) return text
  if (!/DSML|tool_call|tool_calls|function_call|python_tag|TOOL_CALLS|minimax|invoke|arg_key/i.test(text)) return text
  // 围栏内的内容可能是用户在看的示例代码，不能当成协议删除。
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g)
  return parts.map((part) => (part.startsWith('```') ? part : stripPlainProtocol(part))).join('').trimEnd()
}

function stripPlainProtocol(text: string): string {
  let output = text
  const patterns: RegExp[] = [
    new RegExp(`${DSML_MARK}\\s*(?:calls|tool_calls)\\s*>[\\s\\S]*?</${PIPE}\\s*DSML\\s*${PIPE}\\s*(?:calls|tool_calls)\\s*>`, 'gi'),
    new RegExp(`${DSML_MARK}\\s*invoke\\b[^>]*>[\\s\\S]*?</${PIPE}\\s*DSML\\s*${PIPE}\\s*invoke\\s*>`, 'gi'),
    /<minimax:tool_call\b[^>]*>[\s\S]*?<\/minimax:tool_call>/gi,
    /<tool_calls?\b[^>]*>[\s\S]*?<\/tool_calls?>/gi,
    /<function_call\b[^>]*>[\s\S]*?<\/function_call>/gi,
    /<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi,
    /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/gi,
    /<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi,
    /<\|tool_call\|>[\s\S]*?(?:<\|tool_call_end\|>|<\|<\/tool_call\|>)/gi,
    /```(?:tool_calls?|function_call)\s*[\s\S]*?```/gi
  ]
  for (const pattern of patterns) output = output.replace(pattern, '')
  // Mistral / Llama 这种前缀后直接跟 JSON 的：去掉前缀和完整 JSON，保留 JSON 之后的正文
  output = output.replace(/\[TOOL_CALLS\]\s*([\s\S]*)$/i, (_all, rest: string) => {
    const spans = jsonSpans(rest)
    return spans.length > 0 ? rest.slice(spans[spans.length - 1].end) : ''
  })
  output = output.replace(/<\|python_tag\|>\s*([\s\S]*)$/i, (_all, rest: string) => {
    const spans = jsonSpans(rest)
    return spans.length > 0 ? rest.slice(spans[spans.length - 1].end) : ''
  })
  // 未闭合的协议：从第一个标记起截断，避免把参数正文当回答
  const open = /(?:<\|tool_call_begin\|>|<\|tool_calls_section_begin\|>|<\|tool_call\|>|\[TOOL_CALLS\]|<\|python_tag\|>|<tool_call\b[^>]*>|<tool_calls\b[^>]*>|<minimax:tool_call\b[^>]*>|<function_call\b[^>]*>|<invoke\b[^>]*>)/i.exec(output)
  if (open) output = output.slice(0, open.index)
  const dsmlOpen = new RegExp(`${DSML_MARK}\\s*[^>]*>`, 'i').exec(output)
  if (dsmlOpen) output = output.slice(0, dsmlOpen.index)
  // 残留的特殊 token / 空标签
  output = output.replace(/<\|[^>|]*(?:tool_call|tool_calls_section|python_tag)[^>|]*\|>/gi, '')
  output = output.replace(/<\/?(?:tool_calls?|function_calls?|invoke|parameter|minimax:tool_call)\b[^>]*>/gi, '')
  return output.replace(/\n{3,}/g, '\n\n')
}

/* ── 流式过滤 ─────────────────────────────────────────────────── */

interface StartMatch {
  index: number
  length: number
  kind: string
  end: RegExp | null
  holdRest: boolean
}

function findStart(buffer: string): StartMatch | null {
  const candidates: StartMatch[] = []
  const push = (regex: RegExp, kind: string, end: RegExp | null, holdRest = false): void => {
    const match = regex.exec(buffer)
    if (match) candidates.push({ index: match.index, length: match[0].length, kind, end, holdRest })
  }
  push(/<\|tool_calls_section_begin\|>/i, 'kimi-section', /<\|tool_calls_section_end\|>/i)
  push(/<\|tool_call_begin\|>/i, 'kimi-call', /<\|tool_call_end\|>/i)
  push(new RegExp(`${DSML_MARK}\\s*(?:calls|tool_calls)\\s*>`, 'i'), 'dsml-calls', new RegExp(`</${PIPE}\\s*DSML\\s*${PIPE}\\s*(?:calls|tool_calls)\\s*>`, 'i'))
  push(new RegExp(`${DSML_MARK}\\s*invoke\\b[^>]*>`, 'i'), 'dsml-invoke', new RegExp(`</${PIPE}\\s*DSML\\s*${PIPE}\\s*invoke\\s*>`, 'i'))
  push(/<minimax:tool_call\b[^>]*>/i, 'minimax', /<\/minimax:tool_call>/i)
  const toolCall = /<(tool_calls?)\b[^>]*>/i.exec(buffer)
  if (toolCall) {
    const tag = toolCall[1]
    candidates.push({
      index: toolCall.index,
      length: toolCall[0].length,
      kind: 'tool-call',
      end: new RegExp(`</${tag}>`, 'i'),
      holdRest: false
    })
  }
  push(/<function_call\b[^>]*>/i, 'function-call', /<\/function_call>/i)
  push(/<invoke\b[^>]*>/i, 'invoke', /<\/invoke>/i)
  push(/<\|tool_call\|>/i, 'special-call', /(?:<\|tool_call_end\|>|<\|<\/tool_call\|>)/i)
  push(/\[TOOL_CALLS\]/i, 'mistral', null, true)
  push(/<\|python_tag\|>/i, 'python-tag', null, true)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.index - b.index || b.length - a.length)
  return candidates[0]
}

/**
 * 流式过滤器：正文按分片放行；协议块缓冲到闭合后交给解析器。
 * feed() 返回可立即展示的安全文本，finish() 返回尾部文本与完整协议块。
 */
export class ToolProtocolStreamFilter {
  private buffer = ''
  private protocol = false
  private end: RegExp | null = null
  private holdRest = false
  private blocks: string[] = []
  /** Markdown 代码围栏内的内容按普通文本放行，避免把示例代码里的 <invoke> 当成真实工具调用 */
  private inFence = false

  feed(chunk: string): string {
    if (!chunk) return ''
    this.buffer += chunk
    let output = ''
    for (;;) {
      if (!this.protocol) {
        const start = findStart(this.buffer)
        const fence = this.buffer.indexOf('```')
        if (this.inFence) {
          if (fence < 0) {
            const hold = Math.min(2, this.buffer.length)
            output += this.buffer.slice(0, this.buffer.length - hold)
            this.buffer = hold > 0 ? this.buffer.slice(-hold) : ''
            return output
          }
          output += this.buffer.slice(0, fence + 3)
          this.buffer = this.buffer.slice(fence + 3)
          this.inFence = false
          continue
        }
        if (fence >= 0 && (!start || fence < start.index)) {
          output += this.buffer.slice(0, fence + 3)
          this.buffer = this.buffer.slice(fence + 3)
          this.inFence = true
          continue
        }
        if (start) {
          output += this.buffer.slice(0, start.index)
          // 保留起始标签/前缀，闭合后整块交给解析器；Mistral 等无闭合协议在 finish 时再切正文。
          this.buffer = this.buffer.slice(start.index)
          this.protocol = true
          this.end = start.end
          this.holdRest = start.holdRest
          continue
        }
        // 末尾可能是被拆开的标记：最多保留 64 个字符，等下一片再判断。
        const lastLt = Math.max(this.buffer.lastIndexOf('<'), this.buffer.lastIndexOf('['), this.buffer.lastIndexOf('`'))
        const hold = lastLt >= 0 && this.buffer.length - lastLt <= 64 ? this.buffer.length - lastLt : 0
        output += this.buffer.slice(0, this.buffer.length - hold)
        this.buffer = this.buffer.slice(this.buffer.length - hold)
        return output
      }
      if (this.holdRest) return output
      const end = this.end?.exec(this.buffer)
      if (!end || !this.end) return output
      this.blocks.push(this.buffer.slice(0, end.index + end[0].length))
      const rest = this.buffer.slice(end.index + end[0].length)
      this.buffer = rest
      this.protocol = false
      this.end = null
    }
  }

  finish(): { text: string; blocks: string[] } {
    let text = ''
    if (this.protocol) {
      if (this.holdRest) {
        const split = splitPrefixBlock(this.buffer)
        if (split.protocol) this.blocks.push(split.protocol)
        text = split.trailing
      } else {
        // 未闭合的协议块不能展示成正文；保留原始块供诊断/解析。
        this.blocks.push(this.buffer)
      }
      this.buffer = ''
      this.protocol = false
      this.end = null
      this.holdRest = false
    }
    text += this.buffer
    this.buffer = ''
    this.inFence = false
    const blocks = this.blocks
    this.blocks = []
    return { text, blocks }
  }
}

/** Mistral / Llama 前缀协议没有闭合标记：在 finish 时把 JSON 之后的正文还回去。 */
function splitPrefixBlock(block: string): { protocol: string; trailing: string } {
  const match = /^(?:\[TOOL_CALLS\]|<\|python_tag\|>)\s*/i.exec(block)
  if (!match) return { protocol: block, trailing: '' }
  const rest = block.slice(match[0].length)
  const spans = jsonSpans(rest)
  if (spans.length === 0) return { protocol: block, trailing: '' }
  const last = spans[spans.length - 1]
  return {
    protocol: match[0] + rest.slice(0, last.end),
    trailing: rest.slice(last.end)
  }
}
