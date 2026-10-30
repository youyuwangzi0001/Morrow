// 合并自 tests/unit/shared/connector-catalog.test.ts、tests/unit/shared/file-types.test.ts、tests/unit/shared/message.test.ts、tests/unit/shared/plan.test.ts、tests/unit/shared/models-cost.test.ts、tests/unit/shared/models.test.ts、tests/unit/shared/research.test.ts、tests/unit/shared/schedules.test.ts、tests/unit/shared/usage.test.ts、tests/unit/shared/tool-protocol.test.ts
// 每个原文件整体包裹在独立 describe 中，保留原有 hooks 与用例。

import { describe, expect, it } from 'vitest'
import type { ChatMessage, SessionPlan, TodoItem } from '../../src/shared/types'
import { replaceUserMessageText } from '../../src/shared/types'
import { planStepsCompleted } from '../../src/shared/types'
import { swarmTasksFromMeta } from '../../src/shared/types'
import { estimateUsageCost } from '../../src/shared/types'
import { buildOpenAIRequestBody } from '../../src/core/providers'
import { buildAnthropicRequestBody } from '../../src/core/providers'
import type { ProviderStreamRequest } from '../../src/core/types'
import {
  buildResearchPlanPrompt,
  buildResearchPromptSection,
  collectResearchSources,
  createResearchState,
  decideResearchNextStep
} from '../../src/shared/contracts'
import {
  computeNextRun, validateScheduleSpec,
  type ScheduleSpec
} from '../../src/shared/contracts'
import {
  ToolProtocolStreamFilter,
  parseTextToolCalls,
  stripToolProtocol,
} from '../../src/shared/types'
import { parseFilePath } from '../../src/shared/types'

describe('message.test.ts', () => {
  function message(patch: Partial<ChatMessage>): ChatMessage {
    return {
      id: 'msg_test',
      role: 'user',
      content: [],
      createdAt: 0,
      ...patch
    }
  }

  describe('replaceUserMessageText', () => {
    it('@core:attachments 只替换用户输入，保留附件内容与元数据', () => {
      const item = message({
        displayText: '用户输入',
        attachments: [{ name: '内部资料.md', size: 12, kind: 'text' }],
        content: [{ type: 'text', text: '用户输入\n\n[附件] 内部资料.md：机密正文' }]
      })
      const next = replaceUserMessageText(item, '新输入')
      expect(next.displayText).toBe('新输入')
      expect(next.content[0]).toMatchObject({ type: 'text', text: '新输入\n\n[附件] 内部资料.md：机密正文' })
      expect(next.attachments).toEqual(item.attachments)
    })
  })
})

describe('plan.test.ts', () => {
  function makePlan(steps: string[]): SessionPlan {
    const now = Date.now()
    return {
      id: 'plan_test',
      title: '测试计划',
      summary: '测试',
      steps: steps.map((text, index) => ({ id: `step_${index}`, text })),
      status: 'executing',
      createdAt: now,
      updatedAt: now
    }
  }

  function todo(text: string, status: TodoItem['status']): TodoItem {
    return { id: `todo_${text}`, text, status }
  }

  describe('plan progress helpers', () => {
    it('@core:modes requires every plan step to have a completed todo', () => {
      const plan = makePlan(['读取数据', '生成报告', '校验结果'])
      expect(planStepsCompleted(plan, [todo('读取数据', 'completed')])).toBe(false)
      expect(
        planStepsCompleted(plan, [
          todo('读取数据', 'completed'),
          todo('生成报告', 'in_progress'),
          todo('校验结果', 'completed')
        ])
      ).toBe(false)
      expect(
        planStepsCompleted(plan, [
          todo('读取数据', 'completed'),
          todo('生成报告', 'completed'),
          todo('校验结果', 'completed')
        ])
      ).toBe(true)
    })
  })
})

describe('reasoning-cost.test.ts', () => {
  function request(overrides: Partial<ProviderStreamRequest> = {}): ProviderStreamRequest {
    return {
      system: '你是测试助手。',
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], createdAt: 1 }],
      tools: [],
      signal: new AbortController().signal,
      ...overrides
    }
  }

  describe('reasoning effort mapping', () => {
    it('@core:providers maps effort style to reasoning_effort for OpenAI-compatible requests', () => {
      const body = buildOpenAIRequestBody(
        request({ reasoning: { effort: 'high', style: 'effort' } }),
        'gpt-6'
      )
      expect(body.reasoning_effort).toBe('high')
      expect(buildOpenAIRequestBody(request(), 'gpt-6').reasoning_effort).toBeUndefined()
      const deepseekOff = buildOpenAIRequestBody(
        request({ reasoning: { effort: 'off', style: 'effort' } }),
        'deepseek-flash',
        'deepseek'
      )
      expect(deepseekOff.reasoning_effort).toBe('none')
      const qoderOff = buildOpenAIRequestBody(
        request({ reasoning: { effort: 'off', style: 'effort' } }),
        'deepseek-v4.1-flash',
        'qoder-subscription'
      )
      expect(qoderOff.reasoning_effort).toBe('off')
    })

    it('@core:providers maps thinking style to Anthropic thinking budget with valid max_tokens/temperature', () => {
      const body = buildAnthropicRequestBody(
        request({ reasoning: { effort: 'medium', style: 'thinking' }, maxTokens: 2000 }),
        'claude-opus-5.5'
      )
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
      expect(body.temperature).toBe(1)
      expect(Number(body.max_tokens)).toBeGreaterThan(4096)
    })
  })

  describe('cost estimation', () => {
    it('@core:providers estimates input/output/cache cost and returns undefined without pricing', () => {
      expect(estimateUsageCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, { inputPerMTok: 2, outputPerMTok: 8 })).toBe(6)
      expect(
        estimateUsageCost(
          { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 500_000 },
          { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 }
        )
      ).toBe(1.25)
      expect(estimateUsageCost({ inputTokens: 10, outputTokens: 10 }, undefined)).toBeUndefined()
    })
  })
})

describe('research.test.ts', () => {
  function at(offset: number): number {
    return 1_792_500_000_000 + offset
  }

  function searchMessage(id: string, createdAt: number, urls: string[]): ChatMessage {
    return {
      id,
      role: 'assistant',
      createdAt,
      content: [
        {
          type: 'tool_use',
          id: `tool-${id}`,
          name: 'web_search',
          title: '联网搜索',
          category: 'exec',
          input: { query: 'q' },
          status: 'success',
          result: {
            ok: true,
            output: 'ok',
            meta: {
              query: 'q',
              provider: 'mock',
              sources: urls.map((url, index) => ({ rank: index + 1, title: url, url, snippet: '' }))
            }
          }
        }
      ]
    }
  }

  function fetchMessage(id: string, createdAt: number, url: string, title = ''): ChatMessage {
    return {
      id,
      role: 'assistant',
      createdAt,
      content: [
        {
          type: 'tool_use',
          id: `tool-${id}`,
          name: 'web_fetch',
          title: '读取网页',
          category: 'read',
          input: { url },
          status: 'success',
          result: {
            ok: true,
            output: 'ok',
            meta: { requestedUrl: url, finalUrl: url, title, status: 200 }
          }
        }
      ]
    }
  }

  function textMessage(text: string, createdAt: number): ChatMessage {
    return { id: `msg-${createdAt}`, role: 'assistant', createdAt, content: [{ type: 'text', text }] }
  }

  describe('深度研究规则', () => {

    it('@core:research 计划阶段只输出计划；确认后研究提示包含计划', () => {
      const planning = createResearchState('Morrow 研究能力', 'quick', at(0), { status: 'planning' })
      const planPrompt = buildResearchPlanPrompt(planning)
      expect(planPrompt).toContain('不要调用任何工具')
      expect(planPrompt).toContain('## 子问题')
      expect(planPrompt).toContain('## 需要确认')

      const ready = { ...planning, status: 'ready' as const, plan: '# 研究计划：Morrow\n## 子问题\n1. 能力边界' }
      const researchPrompt = buildResearchPromptSection(ready)
      expect(researchPrompt).toContain('已确认的研究计划')
      expect(researchPrompt).toContain('能力边界')
      expect(researchPrompt).toContain('严格遵守已确认的研究计划')
    })

    it('@core:research 统计搜索与网页读取的成功来源，按归一化 URL 去重并过滤旧来源', () => {
      const messages = [
        searchMessage('old', at(-1000), ['https://old.example/a']),
        searchMessage('a', at(10), [
          'https://a.example/1',
          'https://A.example/2#section',
          'https://a.example/1?utm_source=test'
        ]),
        searchMessage('b', at(20), ['https://b.example/3']),
        fetchMessage('fetch-a', at(30), 'https://a.example/2', 'A 页面'),
        fetchMessage('fetch-c', at(40), 'https://c.example/4', 'C 页面')
      ]
      expect(collectResearchSources(messages).map((source) => source.url)).toEqual([
        'https://old.example/a',
        'https://a.example/1',
        'https://A.example/2#section',
        'https://b.example/3',
        'https://c.example/4'
      ])
      expect(collectResearchSources(messages, at(0)).map((source) => source.url)).toEqual([
        'https://a.example/1',
        'https://A.example/2#section',
        'https://b.example/3',
        'https://c.example/4'
      ])
    })

    it('@core:research 来源和报告都达标才完成；不足则给下一轮补查指令；到上限则如实停止', () => {
      const state = createResearchState('主题', 'quick', at(0))
      const messages = [
        searchMessage('a', at(10), ['https://a.example/1', 'https://a.example/2']),
        textMessage('初步总结', at(20))
      ]
      const next = decideResearchNextStep(state, messages, [])
      expect(next.status).toBe('searching')
      expect(next.sourceCount).toBe(2)
      expect(next.gap).toContain('独立来源 2/4')
      expect(next.followUpPrompt).toContain('第 2/2 轮')

      const steered = decideResearchNextStep({ ...state, steer: '只看官方文档与 2026 年资料' }, messages, [])
      expect(steered.followUpPrompt).toContain('只看官方文档与 2026 年资料')
      expect(steered.followUpPrompt).toContain('必须纳入')

      const enoughMessages = [
        ...messages,
        searchMessage('b', at(30), ['https://b.example/3', 'https://c.example/4']),
        textMessage('## 参考来源\n[1] https://a.example/1\n[2] https://b.example/3', at(40))
      ]
      const done = decideResearchNextStep(state, enoughMessages, [])
      expect(done).toMatchObject({ status: 'completed', sourceCount: 4 })

      const maxed = decideResearchNextStep({ ...state, round: state.maxRounds }, messages, [])
      expect(maxed.status).toBe('stopped')
      expect(maxed.gap).toContain('已到研究轮次上限')
    })
  })
})

describe('schedules.test.ts', () => {
  function at(year: number, month: number, day: number, hour: number, minute = 0): number {
    return new Date(year, month - 1, day, hour, minute).getTime()
  }

  describe('定时规则', () => {
    const base = at(2026, 10, 20, 10, 30) // 周二 10:30

    it('@core:schedules 每天：今天已过则排到明天，未到则排今天', () => {
      const later = computeNextRun({ kind: 'daily', time: '18:00' }, base)
      expect(later).toBe(at(2026, 10, 20, 18))
      const earlier = computeNextRun({ kind: 'daily', time: '09:00' }, base)
      expect(earlier).toBe(at(2026, 10, 21, 9))
    })

    it('@core:schedules 每周：按星期几排到下一次；同一天已过则顺延一周', () => {
      const Tuesday = new Date(base).getDay()
      const sameFuture = computeNextRun({ kind: 'weekly', time: '18:00', weekday: Tuesday }, base)
      expect(sameFuture).toBe(at(2026, 10, 20, 18))
      const samePast = computeNextRun({ kind: 'weekly', time: '09:00', weekday: Tuesday }, base)
      expect(samePast).toBe(at(2026, 10, 27, 9))
      const twoDays = computeNextRun({ kind: 'weekly', time: '08:15', weekday: (Tuesday + 2) % 7 }, base)
      expect(twoDays).toBe(at(2026, 10, 22, 8, 15))
    })

    it('@core:schedules 一次：使用本地日期+时间，过去时间由校验拒绝', () => {
      const future: ScheduleSpec = { kind: 'once', time: '08:00', date: '2026-10-22' }
      expect(computeNextRun(future, base)).toBe(at(2026, 10, 22, 8))
      expect(() => validateScheduleSpec(future, base)).not.toThrow()
      expect(() => validateScheduleSpec({ kind: 'once', time: '08:00', date: '2026-10-19' }, base)).toThrow(
        '晚于现在'
      )
      expect(() => validateScheduleSpec({ kind: 'once', time: '08:00', date: '2026-02-30' }, base)).toThrow('有效日期')
    })
  })
})

describe('tool-protocol.test.ts', () => {
  const CALL = { name: 'edit_file', input: { path: 'tetris-soviet/index.html' } }

  function stream(text: string, size: number): { visible: string; calls: ReturnType<typeof parseTextToolCalls> } {
    const filter = new ToolProtocolStreamFilter()
    let visible = ''
    for (let index = 0; index < text.length; index += size) {
      visible += filter.feed(text.slice(index, index + size))
    }
    const tail = filter.finish()
    visible += tail.text
    return { visible, calls: parseTextToolCalls(tail.blocks.join('\n')) }
  }

  describe('厂商无关的工具协议', () => {
    it('@core:providers DeepSeek DSML（全角）', () => {
      const text = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="edit_file">
<｜｜DSML｜｜ parameter name="path" string="true">tetris-soviet/index.html</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
      expect(parseTextToolCalls(text)).toEqual([CALL])
      expect(stripToolProtocol(`先改文件。\n${text}\n改完了。`)).toBe('先改文件。\n\n改完了。')
    })

    it('@core:providers Kimi K2/K3 特殊 token', () => {
      const text = `<|tool_calls_section_begin|>
<|tool_call_begin|>functions.edit_file:0<|tool_call_argument_begin|>{"path":"tetris-soviet/index.html"}<|tool_call_end|>
<|tool_calls_section_end|>`
      expect(parseTextToolCalls(text)).toEqual([CALL])
      expect(stripToolProtocol(text)).toBe('')
      const result = stream(text, 13)
      expect(result.visible).toBe('')
      expect(result.calls).toEqual([CALL])
    })

    it('@core:providers MiniMax M2/M3 XML', () => {
      const text = `<minimax:tool_call>
<invoke name="edit_file">
<parameter name="path">tetris-soviet/index.html</parameter>
</invoke>
</minimax:tool_call>`
      expect(parseTextToolCalls(text)).toEqual([CALL])
      expect(stripToolProtocol(text)).toBe('')
      expect(stream(text, 7).calls).toEqual([CALL])
    })

    it('@core:providers Qwen JSON 与参数标签两种形态', () => {
      const json = `<tool_call>{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}</tool_call>`
      const tags = `<tool_call><function=edit_file><parameter=path>tetris-soviet/index.html</parameter></function></tool_call>`
      expect(parseTextToolCalls(json)).toEqual([CALL])
      expect(parseTextToolCalls(tags)).toEqual([CALL])
      expect(stripToolProtocol(`改一下：\n${json}\n好了`)).toBe('改一下：\n\n好了')
    })

    it('@core:providers GLM arg_key / arg_value', () => {
      const text = `<tool_call>edit_file
<arg_key>path</arg_key><arg_value>tetris-soviet/index.html</arg_value>
</tool_call>`
      expect(parseTextToolCalls(text)).toEqual([CALL])
      expect(stripToolProtocol(text)).toBe('')
    })

    it('@core:providers Mistral [TOOL_CALLS] 与 JSON 后的正文', () => {
      const text = `[TOOL_CALLS] [{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}] 已经改好了。`
      expect(parseTextToolCalls(text)).toEqual([CALL])
      expect(stripToolProtocol(text)).toContain('已经改好了。')
      expect(stream(text, 9).visible).toContain('已经改好了。')
    })

    it('@core:providers Llama python_tag 与 pythonic 调用', () => {
      const json = `<|python_tag|>{"name":"edit_file","parameters":{"path":"tetris-soviet/index.html"}}`
      const pythonic = '<|python_tag|>[edit_file(path="tetris-soviet/index.html")]'
      expect(parseTextToolCalls(json)).toEqual([CALL])
      expect(parseTextToolCalls(pythonic)).toEqual([CALL])
    })

    it('@core:providers 通用 tool_call / function_call / invoke', () => {
      const cases = [
        '<tool_call>{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}</tool_call>',
        '<function_call>{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}</function_call>',
        '<invoke name="edit_file"><parameter name="path">tetris-soviet/index.html</parameter></invoke>'
      ]
      for (const text of cases) expect(parseTextToolCalls(text)).toEqual([CALL])
    })

    it('@core:providers 流式分片不会把协议标记漏进正文', () => {
      const samples = [
        `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="edit_file"><｜｜DSML｜｜ parameter name="path" string="true">tetris-soviet/index.html</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`,
        `<|tool_calls_section_begin|><|tool_call_begin|>functions.edit_file:0<|tool_call_argument_begin|>{"path":"tetris-soviet/index.html"}<|tool_call_end|><|tool_calls_section_end|>`,
        `<tool_call>{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}</tool_call>`,
        `<minimax:tool_call><invoke name="edit_file"><parameter name="path">tetris-soviet/index.html</parameter></invoke></minimax:tool_call>`
      ]
      for (const sample of samples) {
        for (const size of [5, 11, 29]) {
          const result = stream(`前文${sample}后文`, size)
          expect(result.visible).toBe('前文后文')
          expect(result.calls).toEqual([CALL])
        }
      }
    })

    it('@core:providers 代码围栏里的协议示例按普通代码保留', () => {
      const example = '```html\n<tool_call>{"name":"edit_file","arguments":{"path":"a.html"}}</tool_call>\n```\n这只是示例。'
      const result = stream(example, 7)
      expect(result.visible).toBe(example)
      expect(result.calls).toEqual([])
      expect(stripToolProtocol(example)).toBe(example)
    })
  })
})

describe('file-path.test.ts', () => {
  describe('file-path：对话里的文件路径识别', () => {
    it('@core:interface 识别工作区相对路径、Windows 绝对路径与行号', () => {
      expect(parseFilePath('deliver/Morrow-0.1.0-portable.exe')).toEqual({
        display: 'deliver/Morrow-0.1.0-portable.exe',
        path: 'deliver/Morrow-0.1.0-portable.exe'
      })
      expect(parseFilePath('src/main/ipc.ts:1369')).toEqual({
        display: 'src/main/ipc.ts:1369',
        path: 'src/main/ipc.ts',
        line: '1369'
      })
      expect(parseFilePath('C:\\交付成品\\Morrow\\deliver\\报告 1.html')).toMatchObject({
        path: 'C:\\交付成品\\Morrow\\deliver\\报告 1.html'
      })
      expect(parseFilePath('package.json', { allowBare: true })).toMatchObject({ path: 'package.json' })
      expect(parseFilePath('../out/report.html')).toMatchObject({ path: '../out/report.html' })
    })

    it('@core:interface 不把命令、URL、版本号、目录或不支持的字符串变成文件链接', () => {
      for (const value of [
        'npm run test:unit',
        'https://example.com/report.md',
        'morrow-file://artifact/index.html',
        '1.2.3',
        'src/main',
        'report',
        '--flag',
        'a/b',
        'README',
        'package.json',
        'console.log',
        "require('./a.js')"
      ]) {
        expect(parseFilePath(value), value).toBeNull()
      }
    })
  })
})

describe('swarm 任务操作回放', () => {
  it('@core:interface 成员操作不再截断到 30 条，重新加载会话也能全部展开', () => {
    const operations = Array.from({ length: 35 }, (_, index) => ({
      id: `op-${index}`,
      name: 'read_file',
      title: `读取第 ${index + 1} 个文件`,
      status: 'success'
    }))
    const tasks = swarmTasksFromMeta({
      tasks: [{ index: 0, title: '检查', agent: 'explore', status: 'completed', operations }]
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].operations).toHaveLength(35)
    expect(tasks[0].operations?.at(-1)?.title).toBe('读取第 35 个文件')
  })
})
