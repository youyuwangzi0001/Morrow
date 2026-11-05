import type { ChatMessage } from '../shared/types'

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

/** 去掉旧摘要里由系统生成的账本段，避免重复累积。 */
function stripLedger(summary: string): string {
  const marker = summary.search(/\n*## 关键信息账本/)
  return (marker >= 0 ? summary.slice(0, marker) : summary).trim()
}

/**
 * 组合压缩摘要：账本放最前（即使后续截断也先保留），旧摘要原文保留，
 * 只追加本次「新增历史」的摘要，避免摘要改写摘要造成的累积漂移。
 */
export function composeCompactionSummary(
  previousSummary: string | undefined,
  newSummary: string,
  ledger: string,
  maxChars = 16_000
): string {
  const previous = stripLedger(previousSummary ?? '')
  const ledgerPart = ledger.trim() ? `## 关键信息账本（系统原文保留，不参与重写）\n${ledger.trim()}` : ''
  const previousPart = previous ? `## 历史交接摘要（原文保留）\n${previous}` : ''
  const newPart = newSummary.trim() ? `## 新增历史摘要\n${newSummary.trim()}` : ''
  if (!ledgerPart) {
    return [previousPart, newPart].filter(Boolean).join('\n\n').slice(0, maxChars)
  }
  const headerBudget = ledgerPart.length + newPart.length + 64
  const previousRoom = Math.max(0, maxChars - headerBudget)
  const trimmedPrevious = previousPart.slice(0, previousRoom)
  return [ledgerPart, trimmedPrevious, newPart].filter(Boolean).join('\n\n').slice(0, maxChars)
}

/** 判断一条消息是否是压缩摘要，供摘要输入过滤。 */
export function isCompactionSummaryMessage(message: ChatMessage): boolean {
  if (message.role !== 'system') return false
  return message.content.some((block) => block.type === 'text' && /^\[历史对话摘要/.test(block.text.trim()))
}
