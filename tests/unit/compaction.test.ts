/**
 * 上下文压缩域：目标规划、检查点存档与二次压缩。
 *
 * 三组用例守的是同一件事：压缩只能作用于模型侧消息，完整记录一条不删。
 * 分开写时容易只改一侧阈值而在另一侧留下旧断言，合并后同一文件即可对照。
 */
import { describe, expect, it } from 'vitest'
import {
  applyModelCompaction,
  compactSession,
  estimateMessagesTokens,
  hasDanglingToolUse,
  messagesToPreserve,
  planCompaction
} from '../../src/core/agent'
import {
  buildRuntimeCheckpoint,
  composeCompactionSummary,
  extractCompactionLedger,
  isCompactionSummaryMessage,
  modelMessagesFrom,
  pruneMiddle,
  pruneToolOutputsForModel
} from '../../src/core/compaction'
import type { ChatMessage, ModelInfo, ToolUseBlock } from '../../src/shared/types'
import { positionCompactionNotices } from '../../src/shared/types'
import type { Provider } from '../../src/core/types'

// ── 原 compaction-target.test.ts ──

let idc = 0
const nextId = (p: string): string => `${p}-${(idc += 1)}`

function userMessage(text: string): ChatMessage {
  return { id: nextId('u'), role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
}

function toolTurn(value: number, padding: number): ChatMessage {
  const block: ToolUseBlock = {
    type: 'tool_use',
    id: nextId('call'),
    name: 'read_file',
    title: `读取第 ${value} 组材料`,
    category: 'read',
    input: { path: `in/m${value}.txt` },
    status: 'success',
    result: { ok: true, output: `value=${value}\n${'材料内容 '.repeat(padding)}` }
  }
  return {
    id: nextId('a'),
    role: 'assistant',
    content: [{ type: 'text', text: `已读取第 ${value} 组材料。` }, block],
    createdAt: Date.now()
  }
}

/** 一条超大工具结果夹在中间：切到它之后能压得很小，但会丢掉近期历史 */
function withHugeMiddleTurn(): ChatMessage[] {
  return [
    userMessage('读大文件并总结；不要外发。'),
    toolTurn(1, 100),
    toolTurn(2, 50_000),
    toolTurn(3, 100),
    toolTurn(4, 100)
  ]
}

function pct(tokens: number, limit: number): number {
  return (tokens / limit) * 100
}

describe('压缩目标只是偏好，不是硬门槛', () => {
  it('@core:context 历史里有超大消息时可以压到 10% 以下，不被下限拦住', () => {
    const limit = 400_000
    const messages = withHugeMiddleTurn()
    const before = estimateMessagesTokens(messages, '')
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    expect(plan.shouldCompact).toBe(true)
    // 能压得很小就压得很小：远低于 MIN_TARGET_RATIO(10%)
    expect(plan.afterTokens).toBeDefined()
    expect(pct(plan.afterTokens!, limit)).toBeLessThan(10)
    expect(plan.afterTokens!).toBeLessThan(before)
  })

  it('@core:context 历史消息过多压不到目标时，仍按能压到的最优值压缩，不放弃', () => {
    const limit = 200_000
    // 每条 ~12k tokens × 40 条 ≈ 480k，远超窗口；近期预算本身也很大
    const messages: ChatMessage[] = [
      userMessage('逐段处理并汇总；不要外发。'),
      ...Array.from({ length: 40 }, (_, i) => toolTurn(i + 1, 6_000))
    ]
    const before = estimateMessagesTokens(messages, '')
    expect(before).toBeGreaterThan(limit)
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    expect(plan.shouldCompact).toBe(true)
    // 没有被「必须落进 15%」卡住：压后明显变小，且仍保留可接续的近期历史
    expect(plan.afterTokens!).toBeLessThan(before * 0.3)
    expect(plan.keepCount).toBeGreaterThan(1)
  })

  it('@core:context 压到很小也不会清空当前窗口：摘要 + 用户锚点 + 近期消息都在', () => {
    const limit = 400_000
    const messages = withHugeMiddleTurn()
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    const outcome = applyModelCompaction(messages, messages, plan, '摘要正文。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })
    const view = outcome.modelMessages
    // 第一条是摘要标记
    expect(view[0]?.role).toBe('system')
    // 至少一条原文保留的用户约束消息，且内容未被摘要替换
    const users = view.filter((message) => message.role === 'user')
    expect(users.length).toBeGreaterThanOrEqual(1)
    expect(
      users.some((message) =>
        message.content.some((block) => block.type === 'text' && block.text.includes('不要外发'))
      )
    ).toBe(true)
    // 不是「只剩一条摘要」
    expect(view.length).toBeGreaterThan(1)
  })

  it('@core:context 压不到目标时保留近期历史优先于「压得更小」', () => {
    const limit = 200_000
    const messages: ChatMessage[] = [
      userMessage('逐段处理并汇总；不要外发。'),
      ...Array.from({ length: 40 }, (_, i) => toolTurn(i + 1, 6_000))
    ]
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    const outcome = applyModelCompaction(messages, messages, plan, '摘要。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })
    // 近期历史（最后几条工具结果）仍在模型侧，当前任务可以接续
    const keptOutputs = outcome.modelMessages
      .flatMap((message) => message.content)
      .filter((block): block is ToolUseBlock => block.type === 'tool_use')
      .map((block) => block.result?.output ?? '')
    expect(keptOutputs.length).toBeGreaterThan(0)
    // 压缩后仍显著小于压缩前
    expect(estimateMessagesTokens(outcome.modelMessages, '')).toBeLessThan(
      estimateMessagesTokens(messages, '') * 0.3
    )
  })

  it('@core:context 压完仍高于 20% 也照常压缩，不被目标区间卡住', () => {
    // 40 条 × ~12k tokens，窗口 200k：即使切到最近几轮，模型侧仍在 20% 以上。
    // 旧行为会因为「进不了 15% 目标」而退到最保守的切点，几乎不省；
    // 现在按「保住近期历史前提下能压到的最小值」执行，收益真实存在即可。
    const limit = 200_000
    const messages: ChatMessage[] = [
      userMessage('逐段处理并汇总；不要外发。'),
      ...Array.from({ length: 40 }, (_, i) => toolTurn(i + 1, 6_000))
    ]
    const before = estimateMessagesTokens(messages, '')
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    expect(plan.shouldCompact).toBe(true)
    const afterPct = pct(plan.afterTokens!, limit)
    // 关键：允许超出 20%——只要确实压小了就继续
    expect(afterPct).toBeGreaterThan(20)
    expect(plan.afterTokens!).toBeLessThan(before * 0.1)
  })

  it('@core:context 切点会落到超大消息之前时，不允许把上下文压得更大', () => {
    // 一条 ~85k tokens 的消息夹在中间：切到它之前会让「保留段 + 摘要」反而更大。
    // 这种切点必须被拒绝，否则压缩会把上下文推向上限。
    const limit = 120_000
    const messages: ChatMessage[] = [
      userMessage('读大文件并总结；不要外发。'),
      toolTurn(1, 20_000), // ≈ 80k tokens，单条就占窗口 2/3
      toolTurn(2, 20),
      toolTurn(3, 20),
      toolTurn(4, 20)
    ]
    const before = estimateMessagesTokens(messages, '')
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    if (!plan.shouldCompact) return
    // 压缩结果必须小于压缩前，不能越压越大
    expect(plan.afterTokens!).toBeLessThan(before)
  })

  it('@core:context 压缩后不会超过窗口本身（几条超大消息时也不能越压越大）', () => {
    // 8 条各 ~28k tokens、窗口 200k：最右切点会留下全部巨幅消息，
    // 修复前它会算出「压缩后 220k > 200k 窗口」——压缩把上下文推过了上限。
    const limit = 200_000
    const messages: ChatMessage[] = [
      userMessage('逐段处理并汇总；不要外发。'),
      ...Array.from({ length: 8 }, (_, i) => toolTurn(i + 1, 12_000))
    ]
    const before = estimateMessagesTokens(messages, '')
    expect(before).toBeGreaterThan(limit * 0.9)
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    expect(plan.shouldCompact).toBe(true)
    // 关键：压完必须真的更小，且不能超过窗口
    expect(plan.afterTokens!).toBeLessThan(before)
    expect(plan.afterTokens!).toBeLessThan(limit)
  })

  it('@core:context 单条超大消息在中间时可以压到 10% 以下', () => {
    // 巨型消息之后还有几条小消息：切到它之后能压到 1% 左右（远低于目标区间）
    const limit = 400_000
    const messages: ChatMessage[] = [
      userMessage('读大文件并总结；不要外发。'),
      toolTurn(1, 100),
      toolTurn(2, 50_000),
      toolTurn(3, 100),
      toolTurn(4, 100)
    ]
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    expect(plan.shouldCompact).toBe(true)
    expect(pct(plan.afterTokens!, limit)).toBeLessThan(10)
    expect(plan.afterTokens!).toBeLessThan(estimateMessagesTokens(messages, '') * 0.1)
  })
})

// ── 原 compaction-checkpoint.test.ts ──

function message(role: 'user' | 'assistant' | 'system', text: string, id: string): ChatMessage {
  return { id, role, content: [{ type: 'text', text }], createdAt: Date.now() }
}

function toolMessage(output: string, id = 'tool-1'): ChatMessage {
  const assistant = message('assistant', '工具执行完成。', id)
  assistant.content.push({
    type: 'tool_use',
    id: `call-${id}`,
    name: 'run_command',
    title: '运行命令',
    category: 'exec',
    status: 'success',
    input: { command: 'npm test' },
    result: { ok: true, output }
  })
  return assistant
}

function summaryProvider(summary: string): Provider {
  return {
    id: 'test',
    stream: async function* () {
      yield { type: 'text_delta', text: summary }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
    }
  } as unknown as Provider
}

const model: ModelInfo = {
  id: 'deepseek-flash',
  label: 'DeepSeek Flash',
  contextWindow: 3_000,
  supportsTools: true
}

describe('压缩检查点：运行状态与权威待办', () => {
  it('@core:context 把目标、计划、待办、最近指令和产物写成系统状态，进行中的待办排在最前', () => {
    const runtime = buildRuntimeCheckpoint({
      goal: {
        objective: '完成需求 4：提升压缩质量',
        status: 'active',
        round: 2,
        maxRounds: 5,
        nextStep: '跑压缩单测'
      },
      plan: {
        title: '压缩质量改造',
        status: 'executing',
        steps: [{ text: '先修剪工具输出' }, { text: '再写入运行状态' }]
      },
      todos: [
        { text: '已完成项', status: 'completed' },
        { text: '正在做', status: 'in_progress' },
        { text: '待做', status: 'pending' }
      ],
      artifacts: [{ title: '方案.md', kind: 'markdown', path: 'docs/plan.md' }],
      messages: [message('user', '旧要求', 'u1'), message('user', '最新要求：保留文件路径', 'u2')]
    })

    expect(runtime).toContain('当前目标：完成需求 4：提升压缩质量（第 2/5 轮）')
    expect(runtime).toContain('目标下一步：跑压缩单测')
    expect(runtime).toContain('当前计划：压缩质量改造（执行中）')
    expect(runtime).toContain('先修剪工具输出')
    expect(runtime).toContain('[~] 正在做')
    expect(runtime.indexOf('[~] 正在做')).toBeLessThan(runtime.indexOf('[ ] 待做'))
    expect(runtime).toContain('最近用户指令：最新要求：保留文件路径')
    expect(runtime).toContain('docs/plan.md')
  })

  it('@core:context 运行状态过滤密钥，不把敏感值写进模型可见检查点', () => {
    const runtime = buildRuntimeCheckpoint({
      lastUserText: 'API Key: sk-test-abcdefghijklmnop，不能写入摘要。'
    })
    expect(runtime).not.toContain('sk-test')
  })

  it('@core:context 旧运行状态被替换而不是累积，账本仍在历史摘要之前', () => {
    const previous = [
      '## 运行状态（系统记录，压缩时刷新）',
      '- 旧目标：已经过时',
      '## 历史交接摘要（原文保留）',
      '旧事实：保留 expires_in',
      '## 关键信息账本（系统原文保留，不参与重写）',
      '- 旧账本：audit_rotation'
    ].join('\n')
    const combined = composeCompactionSummary(
      previous,
      '新增历史：完成 50 并发测试。',
      '### 文件与路径\n- src/auth/rotate.ts',
      16_000,
      '- 当前目标：新目标'
    )

    expect(combined).toContain('旧事实：保留 expires_in')
    expect(combined).toContain('新增历史：完成 50 并发测试')
    expect(combined).toContain('src/auth/rotate.ts')
    expect(combined).toContain('新目标')
    expect(combined).not.toContain('已经过时')
    expect(combined.match(/运行状态/g)).toHaveLength(1)
    expect(combined.indexOf('关键信息账本')).toBeLessThan(combined.indexOf('历史交接摘要'))
  })

  it('@core:context 第二次压缩保留第一次的摘要，但旧账本与旧运行状态被替换', () => {
    const first = composeCompactionSummary(
      undefined,
      '第一次摘要：完成认证轮换。',
      '### 文件与路径\n- src/auth/rotate.ts',
      16_000,
      '- 当前目标：第一次目标'
    )
    const second = composeCompactionSummary(
      first,
      '第二次摘要：补完 50 并发测试。',
      '### 文件与路径\n- src/auth/session.ts',
      16_000,
      '- 当前目标：第二次目标'
    )

    expect(second).toContain('第一次摘要：完成认证轮换')
    expect(second).toContain('第二次摘要：补完 50 并发测试')
    expect(second).toContain('src/auth/session.ts')
    expect(second).toContain('第二次目标')
    expect(second).not.toContain('第一次目标')
    expect(second).not.toContain('src/auth/rotate.ts')
    expect(second.match(/运行状态/g)).toHaveLength(1)
    expect(second.match(/关键信息账本/g)).toHaveLength(1)
  })

  it('@core:context 手动 /compact 会把运行状态写进压缩标记', async () => {
    const history: ChatMessage[] = []
    for (let index = 0; index < 8; index += 1) {
      history.push(message('user', `第 ${index} 轮要求：保留路径和命令。`, `u${index}`))
      history.push(message('assistant', `第 ${index} 轮完成。`.repeat(20), `a${index}`))
    }
    const result = await compactSession({
      provider: summaryProvider('## 目标与验收\n继续实现。'),
      model,
      systemPrompt: '',
      messages: history,
      signal: new AbortController().signal,
      force: true,
      runtimeCheckpoint: '- 当前目标：继续实现压缩质量'
    })

    expect(result.compacted).toBe(true)
    const text = result.messages
      .flatMap((item) => item.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    expect(text).toContain('## 运行状态（系统记录，压缩时刷新）')
    expect(text).toContain('当前目标：继续实现压缩质量')
  }, 10_000)

  it('@core:context 摘要模型看到的是修剪后的工具输出，仍保留头尾', async () => {
    let captured = ''
    const provider = {
      id: 'test',
      stream: async function* (options: { messages: ChatMessage[] }) {
        captured = options.messages
          .flatMap((item) => item.content)
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        yield { type: 'text_delta', text: '## 目标与验收\n继续实现。' }
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      }
    } as unknown as Provider
    const history: ChatMessage[] = [toolMessage(`HEAD-${'X'.repeat(9_000)}-TAIL`, 'huge')]
    for (let index = 0; index < 8; index += 1) {
      history.push(message('user', `第 ${index} 轮要求：继续。`, `u${index}`))
      history.push(message('assistant', `第 ${index} 轮完成。`.repeat(30), `a${index}`))
    }

    const bigModel: ModelInfo = { ...model, contextWindow: 32_000 }
    const result = await compactSession({
      provider,
      model: bigModel,
      systemPrompt: '',
      messages: history,
      signal: new AbortController().signal,
      force: true
    })

    expect(result.compacted).toBe(true)
    expect(captured).toContain('HEAD-')
    expect(captured).toContain('-TAIL')
    expect(captured).toContain('工具输出已折叠')
    expect(captured).not.toContain('X'.repeat(5_000))
  }, 10_000)
})

describe('压缩检查点：先修剪工具输出，再做摘要', () => {
  it('@core:context 超大工具输出只保留头尾，完整原文不被修改', () => {
    const output = `HEAD-${'M'.repeat(9_000)}-TAIL`
    const original = toolMessage(output)
    const result = pruneToolOutputsForModel([original])

    expect(result.prunedCount).toBe(1)
    expect(result.savedChars).toBeGreaterThan(3_000)
    const block = result.messages[0]!.content.find((item) => item.type === 'tool_use')
    const pruned = block && block.type === 'tool_use' ? block.result?.output ?? '' : ''
    expect(pruned.startsWith('HEAD-')).toBe(true)
    expect(pruned.endsWith('-TAIL')).toBe(true)
    expect(pruned).toContain('工具输出中段已修剪')
    expect(pruned.length).toBeLessThan(output.length)

    // 完整记录仍是原文：修剪只作用于模型侧副本
    const originalBlock = original.content.find((item) => item.type === 'tool_use')
    const untouched = originalBlock && originalBlock.type === 'tool_use' ? originalBlock.result?.output : ''
    expect(untouched).toBe(output)
  })

  it('@core:context 最近几条消息保持原文，只修剪较早的大输出', () => {
    const recentOutput = `NEW-${'B'.repeat(9_000)}-NEW`
    const old = toolMessage(`OLD-${'A'.repeat(9_000)}-OLD`, 'old')
    const recent = toolMessage(recentOutput, 'recent')
    const result = pruneToolOutputsForModel([old, recent], undefined, 1)

    expect(result.prunedCount).toBe(1)
    const oldBlock = result.messages[0]!.content.find((item) => item.type === 'tool_use')
    const recentBlock = result.messages[1]!.content.find((item) => item.type === 'tool_use')
    expect(oldBlock && oldBlock.type === 'tool_use' ? oldBlock.result?.output : '').toContain('工具输出中段已修剪')
    expect(recentBlock && recentBlock.type === 'tool_use' ? recentBlock.result?.output : '').toBe(recentOutput)
  })

  it('@core:context 短输出与摘要标记不会被修剪', () => {
    const short = toolMessage('短结果')
    const summary = message('system', '[历史对话摘要 · 第 1 次压缩]\n摘要', 'summary')
    const result = pruneToolOutputsForModel([short, summary])
    expect(result.prunedCount).toBe(0)
    expect(result.messages[0]).toBe(short)
    expect(result.messages[1]).toBe(summary)
  })

  it('@core:context 修剪后估算值明显下降，足以跳过摘要', () => {
    const limit = 12_000
    const messages: ChatMessage[] = []
    messages.push(toolMessage(`HEAD-${'日志'.repeat(8_000)}-TAIL`, 'huge'))
    for (let index = 0; index < 8; index += 1) {
      messages.push(message('user', `继续第 ${index} 步。`, `u${index}`))
      messages.push(message('assistant', `第 ${index} 步完成。`, `a${index}`))
    }

    const before = planCompaction(messages, '', limit, { threshold: 0.8 })
    expect(before.shouldCompact).toBe(true)
    const pruned = pruneToolOutputsForModel(messages)
    const after = planCompaction(pruned.messages, '', limit, { threshold: 0.8 })
    expect(pruned.prunedCount).toBe(1)
    expect(after.estimatedTokens).toBeLessThan(before.estimatedTokens)
    expect(after.shouldCompact).toBe(false)
  })

  it('@core:context 头尾折叠保留结尾结论，且总长度不超过预算', () => {
    const text = `开头约束\n${'中间过程\n'.repeat(200)}最终测试通过，0 失败`
    const pruned = pruneMiddle(text, 500, '输出已折叠')
    expect(pruned.length).toBeLessThanOrEqual(500)
    expect(pruned.startsWith('开头约束')).toBe(true)
    expect(pruned.endsWith('最终测试通过，0 失败')).toBe(true)
    expect(pruned).toContain('中间省略')
  })

  it('@core:context 从记录重建模型视图时仍保留工具输出尾部的结论', () => {
    const output = `HEAD-${'M'.repeat(4_000)}-TAIL`
    const assistant = toolMessage(output, 'a1')
    const marker: ChatMessage = {
      id: 'marker',
      role: 'system',
      createdAt: Date.now(),
      content: [
        {
          type: 'text',
          text: '[历史对话摘要 · 第 1 次压缩 · 节省 100 tokens，任务继续]\n摘要'
        }
      ],
      preservedMessageIds: ['a1'],
      modelTrimChars: 1_200,
      modelTrimThroughId: 'a1'
    }
    const rebuilt = modelMessagesFrom([assistant, marker])
    const block = rebuilt
      .flatMap((item) => item.content)
      .find((item) => item.type === 'tool_use')
    const text = block && block.type === 'tool_use' ? block.result?.output ?? '' : ''
    expect(text.startsWith('HEAD-')).toBe(true)
    expect(text.endsWith('-TAIL')).toBe(true)
    expect(text).toContain('工具输出已折叠')
    expect(text.length).toBeLessThanOrEqual(1_200)
  })

  it('@core:context 修剪不会破坏工具配对（tool_use 仍有结果）', () => {
    const original = toolMessage(`HEAD-${'X'.repeat(10_000)}-TAIL`)
    const pruned = pruneToolOutputsForModel([original])
    const calls = pruned.messages.flatMap((item) =>
      item.content.filter((block) => block.type === 'tool_use')
    )
    expect(calls).toHaveLength(1)
    expect(calls[0] && calls[0].type === 'tool_use' ? calls[0].result?.ok : undefined).toBe(true)
    expect(estimateMessagesTokens(pruned.messages, '')).toBeGreaterThan(0)
  })
})

// ── 原 compaction-v2.test.ts ──

const engineering: ChatMessage[] = [
  message('user', '修复认证轮换缺陷：/api/v1/login 必须保留 expires_in；不要改 src/auth/session.ts 的公开导出；不新增 npm 依赖；本地端口 4317；截止 2026-11-05。', 'u1'),
  message('assistant', '读取 src/auth/session.ts 与 src/auth/rotate.ts，发现并发轮换会抛 SQLITE_BUSY: database is locked。', 'a1'),
  message('user', '移动端 refresh token 不轮换，只有桌面端轮换；v1 客户端继续返回 expires_in。', 'u2'),
  message('assistant', '决定使用 BEGIN IMMEDIATE 包住轮换，失败重试一次；拒绝引入 Redis，避免新增依赖。', 'a2'),
  message('assistant', '【测试】npm test -- auth：14 passed，2 failed；失败原因是并发竞争与移动端分支。', 'a3'),
  message('assistant', '修改 src/auth/rotate.ts；新增 migrations/0042_audit.sql；audit_rotation 一次成功轮换恰好一行，只存 token_hash 和 client_type。', 'a4'),
  message('assistant', '【测试】npm test -- auth：18 passed；coverage 87.1%；移动端连续 3 次 refresh 值不变。', 'a5'),
  message('user', '最终验收必须包含 50 并发、无 SQLITE_BUSY、audit 行数等于成功轮换数；不要把覆盖率改成估算。', 'u3'),
  message('assistant', '【并发测试】50 并发全部成功，0 次 SQLITE_BUSY；audit_rotation 新增 50 行；p95 38ms。', 'a6'),
  message('assistant', '回滚方案：撤销 rotate.ts 事务，保留 migration 0042；不改 package.json，不触碰 session.ts 导出。', 'a7')
]

const literature: ChatMessage[] = [
  message('user', '写民国悬疑长篇：第一人称林晚；不要重生、不要系统；共 8 章，每章约 3000 字；关键人物沈砚（钟表匠）、周鹤（巡捕）；第 6 章发现信纸夹层，结局揭示沈川。', 'l1'),
  message('assistant', '第 1 章：林晚在报社校样发现蓝铅笔字“七天后，钟楼会停”；钟表铺的沈砚在修一只停在四点十七分的怀表。', 'l2'),
  message('user', '沈砚的哥哥沈川失踪；红蜡封上有“鹤”字；林晚不会武功；周鹤不是纯反派。', 'l3'),
  message('assistant', '第 2 章：林晚在钟楼夹层找到鹤字蜡封信，信上写着“不要相信周鹤”；她把信藏进校样夹。', 'l4'),
  message('assistant', '第 3 章：周鹤调查沈川失踪案；沈砚说哥哥去了香港，但摸左腕表带时在说谎。', 'l5'),
  message('user', '第 6 章必须发现信纸夹层里的钟楼地下平面图；不要提前揭示沈川结局；结尾章才让他活着出现。', 'l6'),
  message('assistant', '第 4 章：旧档显示周鹤经手三年前钟楼失火案；沈川的失踪记录被蓝铅笔划掉。', 'l7'),
  message('assistant', '第 5 章：钟楼连续两晚在四点十七分停摆；沈砚修好后故意让齿轮卡住。', 'l8'),
  message('assistant', '第 6 章：信纸受潮分层，夹层是钟楼地下平面图；图纸背面有沈川缩写 S.C.。', 'l9'),
  message('user', '第 7 章林晚用报社通行证支开守门人，不要让她会武功；周鹤封锁钟楼但不要开枪。', 'l10'),
  message('assistant', '第 7 章：林晚用“报社夜间校样”通行证进入钟楼；守门人认识她；周鹤封锁正门。', 'l11'),
  message('user', '结局沈川活着出现，不写获救过程；不点明林晚和沈砚是否在一起；最后一句保留钟声。', 'l12'),
  message('assistant', '第 8 章：沈川被从地下带出，沈砚承认伪造香港来信保护弟弟；结尾林晚烧掉校样，钟声响起。', 'l13')
]

describe('压缩 v2：真实任务事实保留', () => {
  it('@core:context 账本从工程/叙事历史中抽取可核对事实，并过滤密钥', () => {
    const engineeringLedger = extractCompactionLedger(engineering, 3000)
    expect(engineeringLedger).toContain('expires_in')
    expect(engineeringLedger).toContain('87.1')
    expect(engineeringLedger).toContain('audit_rotation')
    expect(engineeringLedger).toContain('src/auth/rotate.ts')
    expect(engineeringLedger).toContain('4317')

    const literatureLedger = extractCompactionLedger(literature, 3000)
    expect(literatureLedger).toContain('林晚')
    expect(literatureLedger).toContain('平面图')
    expect(literatureLedger).toContain('钟声')

    const withSecret = [message('assistant', 'API Key: sk-test-abcdefghijklmnop，不能写入摘要。', 'secret')]
    expect(extractCompactionLedger(withSecret)).not.toContain('sk-test')
  })

  it('@core:context 旧摘要与账本原文保留，新摘要只追加，不反复改写', () => {
    const previous = '## 历史交接摘要（原文保留）\n用户要求保留 expires_in。\n\n## 关键信息账本（系统原文保留，不参与重写）\n- 已存在账本'
    const ledger = '### 用户约束与决定\n- audit_rotation 一行\n### 文件与路径\n- src/auth/rotate.ts'
    const combined = composeCompactionSummary(previous, '新增历史：完成 50 并发测试。', ledger)
    expect(combined).toContain('用户要求保留 expires_in')
    expect(combined).toContain('新增历史：完成 50 并发测试')
    expect(combined).toContain('audit_rotation 一行')
    expect(combined.indexOf('关键信息账本')).toBeLessThan(combined.indexOf('历史交接摘要'))
    expect(combined.match(/关键信息账本/g)).toHaveLength(1)
  })

  it('@core:context 压缩保留最近用户消息和账本事实，且不把完整历史带回来', async () => {
    const result = await compactSession({
      provider: summaryProvider('## 目标与验收\n修复认证轮换；桌面轮换，移动端不轮换。\n## 已完成与关键决策\nBEGIN IMMEDIATE。'),
      model,
      systemPrompt: '',
      messages: engineering,
      signal: new AbortController().signal,
      force: true,
      keepRecent: 4
    })
    expect(result.compacted).toBe(true)
    const text = result.messages.map((item) => item.content.map((block) => (block.type === 'text' ? block.text : '')).join('')).join('\n')
    expect(text).toContain('expires_in')
    expect(text).toContain('audit_rotation')
    expect(text).toContain('87.1')
  }, 10_000)

  it('@core:context 计划记录最近用户消息预算，叙事任务同样可压缩', () => {
    const plan = planCompaction(literature, '', 3_000, { keepRecent: 4, force: true })
    expect(plan.shouldCompact).toBe(true)
    expect(plan.preserveUserTokens).toBeGreaterThan(0)
    const preserved = messagesToPreserve(literature, plan.cutIndex, plan.preserveUserTokens ?? 0)
    expect(preserved.some((item) => item.content.some((block) => block.type === 'text' && block.text.includes('第 6 章必须发现信纸夹层')))).toBe(true)
    const outcome = applyModelCompaction(literature, literature, plan, '摘要：林晚第一人称，第 6 章夹层平面图，结局沈川活着，钟声结尾。', {
      systemPrompt: '',
      contextLimit: 3_000
    })
    const text = outcome.modelMessages
      .map((item) => item.content.map((block) => (block.type === 'text' ? block.text : '')).join(''))
      .join('\n')
    expect(text).toContain('沈川')
    expect(text).toContain('钟声')
  })

  it('@core:context 压缩摘要记录原文保留的消息，展示标记落在真实切点', () => {
    const plan = planCompaction(literature, '', 3_000, { keepRecent: 4, force: true })
    const outcome = applyModelCompaction(literature, literature, plan, '摘要：林晚第一人称，第 6 章夹层平面图。', {
      systemPrompt: '',
      contextLimit: 3_000
    })
    const summary = outcome.marker
    const preservedIds = summary.preservedMessageIds ?? []
    expect(summary.role).toBe('system')
    expect(preservedIds.length).toBeGreaterThan(0)

    // 分层契约：完整记录一条不少，标记插在真实切点（其后紧跟被保留的第一段历史）
    expect(outcome.messages.length).toBe(literature.length + 1)
    const markerIndex = outcome.messages.findIndex((message) => message.id === summary.id)
    expect(markerIndex).toBeGreaterThan(0)
    expect(outcome.messages[markerIndex + 1]?.id).toBe(literature[plan.cutIndex]?.id)
    // 模型侧：摘要 + 原文保留的消息 + 切点之后的近期历史
    expect(outcome.modelMessages[0]?.id).toBe(summary.id)
    expect(outcome.modelMessages.slice(1, 1 + preservedIds.length).map((message) => message.id)).toEqual(preservedIds)

    // 新格式标记已在真实切点，展示顺序原样返回
    const positioned = positionCompactionNotices(outcome.messages)
    expect(positioned.map((message) => message.id)).toEqual(outcome.messages.map((message) => message.id))
  })

  it('@core:context 没有原文保留消息时摘要仍在开头', () => {
    const summary: ChatMessage = {
      id: 'summary-no-preserve',
      role: 'system',
      createdAt: Date.now(),
      content: [{ type: 'text', text: '[历史对话摘要 · 已压缩]\n摘要正文' }]
    }
    const kept = message('assistant', '继续执行。', 'a-kept')
    const original = [summary, kept]
    expect(positionCompactionNotices(original)).toBe(original)
    expect(positionCompactionNotices([{ ...summary, preservedMessageIds: ['u-none'] }, kept])[0]?.id).toBe('summary-no-preserve')
  })
})

/**
 * 回归：压缩触发必须与服务商真实用量同口径。
 * 历史上触发判定只看本地字符估算（CJK 1 字≈1 token），对中文/工具输出系统性偏低，
 * 于是出现「设置里已显示 430.8k / 400k（100%）却始终不自动压缩」。
 */
describe('压缩触发口径：真实 usage 优先于本地估算', () => {
  const limit = 400_000
  const threshold = 0.8
  // 一段确实很长、也确实可压缩的历史：本地估算约 200k，而服务商实测 430.8k。
  // 这正是问题场景——历史够长（能切），只是本地估算没到阈值。
  const longHistory: ChatMessage[] = Array.from({ length: 20 }, (_, index) =>
    message(
      index % 2 === 0 ? 'user' : 'assistant',
      '这是一段足够长的中文内容，用来把本地估算推到阈值附近。'.repeat(400),
      `m${index}`
    )
  )

  it('@core:context 本地估算未到阈值时，服务商已报 430.8k 仍应触发压缩', () => {
    const estimateOnly = planCompaction(longHistory, '', limit, { threshold })
    // 前提：本地估算确实低于阈值，否则这条用例没有覆盖到问题
    expect(estimateOnly.estimatedTokens).toBeLessThan(limit * threshold)
    expect(estimateOnly.shouldCompact).toBe(false)

    const measured = planCompaction(longHistory, '', limit, { threshold, measuredTokens: 430_783 })
    expect(measured.shouldCompact).toBe(true)
    expect(measured.measuredTokens).toBe(430_783)
    // estimatedTokens 仍保留本地估算语义，供下游计算节省量
    expect(measured.estimatedTokens).toBe(estimateOnly.estimatedTokens)
  }, 20_000)

  it('@core:context 实测值未到阈值时不应误触发', () => {
    const plan = planCompaction(longHistory, '', limit, { threshold, measuredTokens: 200_000 })
    expect(plan.shouldCompact).toBe(false)
    expect(plan.reason).toBe('below-threshold')
  })

  it('@core:context 没有真实 usage 时退回本地估算，行为与之前一致', () => {
    const tall = Array.from({ length: 40 }, (_, index) =>
      message(
        index % 2 === 0 ? 'user' : 'assistant',
        '这是一段足够长的中文内容，用来把估算值推过阈值。'.repeat(400),
        `t${index}`
      )
    )
    const withoutUsage = planCompaction(tall, '', limit, { threshold })
    expect(withoutUsage.shouldCompact).toBe(true)
    expect(withoutUsage.estimatedTokens).toBeGreaterThan(0)

    // 0 视为「没有可用实测」，不能因为传了 0 就永远不压缩
    const withZero = planCompaction(tall, '', limit, { threshold, measuredTokens: 0 })
    expect(withZero.shouldCompact).toBe(true)
  }, 20_000)

  it('@core:context 阈值仍然按模型窗口比例计算，与实测值同乘同一套阈值', () => {
    const plan = planCompaction(longHistory, '', limit, { threshold, measuredTokens: 430_783 })
    expect(plan.thresholdTokens).toBe(Math.floor(limit * threshold))
  })

  it('@core:context 实测值低于本地估算时取较大者，不被过时的 usage 拉低', () => {
    // usage 只代表「上一次请求」；此后新增的历史只能由估算覆盖。
    const tall = Array.from({ length: 40 }, (_, index) =>
      message(
        index % 2 === 0 ? 'user' : 'assistant',
        '这是一段足够长的中文内容，用来把估算值推过阈值。'.repeat(400),
        `g${index}`
      )
    )
    const noUsage = planCompaction(tall, '', limit, { threshold })
    expect(noUsage.shouldCompact).toBe(true)

    const staleUsage = planCompaction(tall, '', limit, { threshold, measuredTokens: 1_000 })
    expect(staleUsage.shouldCompact).toBe(true)
    expect(staleUsage.measuredTokens).toBe(1_000)
  }, 20_000)
})

/**
 * 回归：压缩后当前窗口必须留下足够多的近期历史。
 * 旧实现只按「条数」（keepRecent）保留，长消息两三条就撑满，
 * 于是一次压缩把几十轮开发过程削成「摘要 + 首条用户消息」，
 * 用户反馈「只剩我的原始消息，不便于追溯开发过程」。
 */
describe('压缩后保留近期历史（可追溯性）', () => {
  const limit = 12_000
  const threshold = 0.8
  const conversation: ChatMessage[] = []
  for (let index = 0; index < 200; index += 1) {
    conversation.push(message('user', `请继续第 ${index} 步：实现功能 ${index}。`, `u${index}`))
    conversation.push(
      message(
        'assistant',
        `第 ${index} 步完成。修改了 src/module-${index}.ts，运行测试通过，继续下一步。`,
        `a${index}`
      )
    )
  }

  it('@core:context 压缩后保留多轮近期对话，而不是只剩首条用户消息', () => {
    const plan = planCompaction(conversation, '', limit, { threshold, keepRecent: 8 })
    expect(plan.shouldCompact).toBe(true)
    const outcome = applyModelCompaction(conversation, conversation, plan, '摘要：持续实现功能。', {
      systemPrompt: '',
      contextLimit: limit
    })
    const compacted = outcome.modelMessages

    const keptRecent = compacted.slice(1)
    expect(keptRecent.length).toBeGreaterThan(10)
    // 保留段里要有成对的 user/assistant，才能追溯「哪一轮做了什么」
    expect(keptRecent.filter((item) => item.role === 'assistant').length).toBeGreaterThan(3)
    expect(keptRecent.filter((item) => item.role === 'user').length).toBeGreaterThan(3)
  }, 20_000)

  it('@core:context 压缩后不会因为略高于理想目标就再触发深度折叠', () => {
    const plan = planCompaction(conversation, '', limit, { threshold, keepRecent: 8 })
    // 保住近期历史可能让 afterTokens 高于 targetRatio，但仍在阈值以内就不该深度折叠
    expect(plan.afterTokens).toBeDefined()
    expect(plan.afterTokens!).toBeLessThan(plan.thresholdTokens)
    expect(plan.overTarget).toBe(false)
  }, 20_000)
})

/**
 * 回归：同一轮里多次压缩时，轮次必须能追溯。
 * 旧实现每次压缩都新写一条摘要消息，而旧摘要会被切进被压缩段，
 * 界面上就只剩一条「已压缩」，看不出已经是第几次。
 */
describe('多次压缩的轮次记录', () => {
  const limit = 12_000
  const threshold = 0.8

  function buildHistory(): ChatMessage[] {
    const list: ChatMessage[] = []
    for (let index = 0; index < 200; index += 1) {
      list.push(message('user', `第 ${index} 轮需求：继续实现，保持既有测试通过。`.repeat(8), `u${index}`))
      list.push(message('assistant', `第 ${index} 轮完成，改动若干文件并通过测试。`.repeat(12), `a${index}`))
    }
    return list
  }

  it('@core:context 第一次压缩标记为第 1 次，并写明节省量', () => {
    const history = buildHistory()
    const plan = planCompaction(history, '', limit, { threshold })
    expect(plan.compactionRound).toBe(1)
    const outcome = applyModelCompaction(history, history, plan, '摘要正文', {
      systemPrompt: '',
      contextLimit: limit
    })
    const header = outcome.modelMessages[0]!.content[0]
    expect(header.type).toBe('text')
    if (header.type === 'text') {
      expect(header.text).toContain('第 1 次压缩')
      expect(header.text).toMatch(/节省\s*[\d,]+\s*tokens/)
    }
  }, 20_000)

  it('@core:context 第二次压缩接着记第 2 次，不会退回第 1 次', () => {
    const history = buildHistory()
    const first = planCompaction(history, '', limit, { threshold })
    const once = applyModelCompaction(history, history, first, '第一段摘要', {
      systemPrompt: '',
      contextLimit: limit
    })
    // 继续累积历史，直到再次达到阈值（记录与模型侧同步增长）
    const grownRecord = [...once.messages]
    const grownModel = [...once.modelMessages]
    for (let index = 0; index < 120; index += 1) {
      const user = message('user', `后续需求 ${index}：继续保持。`.repeat(8), `nu${index}`)
      const assistant = message('assistant', `后续完成 ${index}，测试通过。`.repeat(12), `na${index}`)
      grownRecord.push(user, assistant)
      grownModel.push(user, assistant)
    }
    // 分层后，压缩规划必须基于模型侧视图；记录只增不减，拿它规划会重复触发
    const second = planCompaction(grownModel, '', limit, { threshold })
    expect(second.shouldCompact).toBe(true)
    expect(second.compactionRound).toBe(2)
    const twice = applyModelCompaction(grownRecord, grownModel, second, '第二段摘要', {
      systemPrompt: '',
      contextLimit: limit
    })
    const header = twice.modelMessages[0]!.content[0]
    if (header.type === 'text') expect(header.text).toContain('第 2 次压缩')
  }, 30_000)
})

/**
 * 分层压缩：模型侧与会话记录分离。
 *
 * 这些用例锁住交接文档要求的核心性质——压缩只作用于「发给模型的那份」，
 * 完整记录（界面、落盘、导出、搜索）永远一条不少。
 */
describe('分层压缩：模型侧与完整记录分离', () => {
  const limit = 12_000

  function toolHistory(count: number): ChatMessage[] {
    const list: ChatMessage[] = []
    for (let index = 0; index < count; index += 1) {
      list.push(message('user', `第 ${index} 轮：读取文件并继续。`.repeat(4), `u${index}`))
      const assistant: ChatMessage = message('assistant', `第 ${index} 轮完成。`.repeat(4), `a${index}`)
      assistant.content.push({
        type: 'tool_use',
        id: `tool-${index}`,
        name: 'read_file',
        title: `读取 module-${index}.ts`,
        category: 'read',
        status: 'success',
        input: { path: `src/module-${index}.ts` },
        result: { ok: true, output: `第 ${index} 个模块源码。`.repeat(120) }
      })
      list.push(assistant)
    }
    return list
  }

  it('@core:context 压缩只插入标记且模型侧落进 10%–20% 预算', () => {
    const record = toolHistory(12)
    const modelView = modelMessagesFrom(record)
    const before = estimateMessagesTokens(modelView, '')
    const plan = planCompaction(modelView, '', limit, { threshold: 0.8, keepRecent: 4 })
    expect(plan.shouldCompact).toBe(true)

    const outcome = applyModelCompaction(record, modelView, plan, '## 目标\n继续实现。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })

    // 记录 = 原文 + 1 条摘要标记，顺序与 id 都不变（界面/落盘/导出据此一条不少）
    expect(outcome.messages.length).toBe(record.length + 1)
    const kept = outcome.messages.filter((item) => !isCompactionSummaryMessage(item))
    expect(kept.map((item) => item.id)).toEqual(record.map((item) => item.id))
    expect(outcome.marker.preservedMessageIds?.length).toBeGreaterThan(0)
    // 模型侧显著变短，且落进目标区间
    expect(outcome.afterTokens).toBeLessThan(before)
    expect(outcome.afterTokens / limit).toBeLessThanOrEqual(0.2)
    expect(outcome.modelMessages.length).toBeLessThan(modelView.length)
  }, 20_000)

  it('@core:context 折叠预算写进标记，旧会话单数组也原样重建', () => {
    const record = toolHistory(12)
    const modelView = modelMessagesFrom(record)
    const plan = planCompaction(modelView, '', limit, { threshold: 0.8, keepRecent: 4 })
    const outcome = applyModelCompaction(record, modelView, plan, '## 目标\n继续实现。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })

    expect(outcome.marker.modelTrimChars).toBeGreaterThan(0)
    // 仅凭记录重建，必须复现同样的折叠结果（否则下一轮请求会退回全文）
    const rebuilt = modelMessagesFrom(outcome.messages)
    expect(estimateMessagesTokens(rebuilt, '')).toBe(outcome.afterTokens)
    // 旧会话（没有任何摘要标记）就是完整历史，无需迁移
    expect(modelMessagesFrom(record).map((item) => item.id)).toEqual(record.map((item) => item.id))
  }, 20_000)

  it('@core:context 重建后的模型视图不再触发压缩', () => {
    const record = toolHistory(12)
    const modelView = modelMessagesFrom(record)
    const plan = planCompaction(modelView, '', limit, { threshold: 0.8, keepRecent: 4 })
    const outcome = applyModelCompaction(record, modelView, plan, '## 目标\n继续实现。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })

    // 回归：修复前规划读的是完整记录（只增不减），压缩后估算值继续上涨，
    // 于是每一步都重复压缩，最终把模型视图清到只剩摘要。
    // 重建视图必须稳定低于阈值，下一次规划应明确返回「不需要压缩」。
    const rebuilt = modelMessagesFrom(outcome.messages)
    const again = planCompaction(rebuilt, '', limit, { threshold: 0.8, keepRecent: 4 })
    expect(again.shouldCompact).toBe(false)
    expect(again.estimatedTokens).toBeLessThan(again.thresholdTokens)
    expect(outcome.afterTokens / limit).toBeLessThanOrEqual(0.2)
  }, 20_000)

  it('@core:context 压缩后新增的消息在重建时保持原文', () => {
    const record = toolHistory(12)
    const modelView = modelMessagesFrom(record)
    const plan = planCompaction(modelView, '', limit, { threshold: 0.8, keepRecent: 4 })
    const outcome = applyModelCompaction(record, modelView, plan, '## 目标\n继续实现。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })

    // 模拟压缩之后又发生了新一轮大工具结果
    const later = message('assistant', '压缩后新增的工作。', 'later')
    later.content.push({
      type: 'tool_use',
      id: 'tool-later',
      name: 'read_file',
      title: '读取 later.ts',
      category: 'read',
      status: 'success',
      input: { path: 'src/later.ts' },
      result: { ok: true, output: '压缩后读到的原文。'.repeat(100) }
    })
    const rebuilt = modelMessagesFrom([...outcome.messages, later])
    const tail = rebuilt[rebuilt.length - 1]!
    const block = tail.content.find((item) => item.type === 'tool_use')
    expect(block && block.type === 'tool_use' ? block.result?.output : '').toContain('压缩后读到的原文。'.repeat(10))
  }, 20_000)

})

describe('残留悬空工具调用不再阻断压缩（线上 400k/90% 事故回归）', () => {
  function chain(turns: number, padding: number): ChatMessage[] {
    const user = message(
      'user',
      '逐步生成素材并汇总；不要外发，不要改动原模型文件。',
      'u-anchor'
    )
    const turnsList: ChatMessage[] = [user]
    for (let index = 1; index <= turns; index += 1) {
      const dangling = index === turns
      const turn = message('assistant', `第 ${index} 步完成。`, `a-${index}`)
      turn.content.push({
        type: 'tool_use',
        id: `call-${index}`,
        name: 'run_command',
        title: `运行第 ${index} 条命令`,
        category: 'exec',
        status: dangling ? 'running' : 'success',
        input: { command: `node gen-${index}.mjs` },
        ...(dangling ? {} : { result: { ok: true, output: `value=${index}
${'生成日志内容 '.repeat(padding)}` } })
      })
      turnsList.push(turn)
    }
    return turnsList
  }

  it('@core:context 上一轮被停止留下的悬空调用会被当作已中断，压缩照常触发', () => {
    const messages = chain(44, 400)
    const system = 'x'.repeat(6_000)
    expect(hasDanglingToolUse(messages)).toBe(true)
    const limit = 100_000
    expect(estimateMessagesTokens(messages, system)).toBeGreaterThan(limit * 0.9)

    const plan = planCompaction(messages, system, limit, { threshold: 0.9 })
    expect(plan.shouldCompact).toBe(true)
    expect(plan.reason).toBeUndefined()

    const outcome = applyModelCompaction(messages, messages, plan, '## 目标: 继续生成。', {
      systemPrompt: system,
      contextLimit: limit,
      trimToThreshold: plan.thresholdTokens,
      targetRatio: 0.15
    })
    // 压缩结果与记录里都不再残留悬空调用
    expect(hasDanglingToolUse(outcome.modelMessages)).toBe(false)
    expect(hasDanglingToolUse(outcome.messages)).toBe(false)
    expect(outcome.afterTokens).toBeLessThan(plan.thresholdTokens)
    // 压缩后不会立刻再次触发（不 thrashing），当前窗口仍有内容
    expect(planCompaction(outcome.modelMessages, system, limit, { threshold: 0.9 }).shouldCompact).toBe(false)
    expect(outcome.modelMessages.length).toBeGreaterThan(1)
  })

  it('@core:context 残留悬空调用被补成中断结果，模型知道该调用没有完成', () => {
    const messages = chain(6, 20)
    const plan = planCompaction(messages, '', 2_000, { threshold: 0.5 })
    if (!plan.shouldCompact) return
    const outcome = applyModelCompaction(messages, messages, plan, '摘要。', {
      systemPrompt: '',
      contextLimit: 2_000
    })
    const calls = outcome.messages
      .flatMap((item) => item.content)
      .filter((block) => block.type === 'tool_use' && block.id === 'call-6')
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call && call.type === 'tool_use' ? call.result?.ok : undefined).toBe(false)
    expect(call && call.type === 'tool_use' ? call.status : undefined).toBe('interrupted')
  })
})
