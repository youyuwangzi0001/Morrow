import { describe, expect, it } from 'vitest'
import { compactSession, estimateMessagesTokens, planCompaction } from '../../src/core/agent'
import {
  buildRuntimeCheckpoint,
  composeCompactionSummary,
  modelMessagesFrom,
  pruneMiddle,
  pruneToolOutputsForModel
} from '../../src/core/compaction'
import type { ChatMessage, ModelInfo } from '../../src/shared/types'
import type { Provider } from '../../src/core/types'

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