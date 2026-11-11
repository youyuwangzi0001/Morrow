import { describe, expect, it, afterEach, vi } from 'vitest'
import { replaceUserMessageText, planStepsCompleted, swarmTasksFromMeta, estimateUsageCost, ToolProtocolStreamFilter, parseTextToolCalls, stripToolProtocol, parseFilePath, type ChatMessage, type SessionPlan, type SuperAgentState, type TodoItem } from '../../src/shared/types'
import { buildOpenAIRequestBody, buildAnthropicRequestBody } from '../../src/core/providers'
import { ProviderStreamRequest } from '../../src/core/types'
import { buildResearchPlanPrompt, buildResearchPromptSection, collaborationAttemptId, collaborationProjectId, collaborationTaskId, collectResearchSources, createResearchState, decideResearchNextStep, normalizeSuperAgentCollaboration, reconcileSuperAgentAfterRestart, recordCollaborationStatus, shouldApplySuperAgentState, computeNextRun, validateScheduleSpec, type ScheduleSpec } from '../../src/shared/contracts'
import { contextTiersFor, withModelContextChoice, isSubscriptionManagedProvider, modelMaxOutputOptions, knownModelSpec, normalizeProviderRetry, DEFAULT_PROVIDER_RETRY, PROVIDER_RETRY_BOUNDS } from '../../src/shared/contracts'
import { preferredScrollBehavior } from '../../src/shared/motion'
import { DEFAULT_SHORTCUTS, canonicalizeShortcut, findShortcutConflict, formatShortcutBinding, matchesShortcut, normalizeShortcutMap, shortcutFromKeyboardEvent, validateShortcutMap, type ShortcutKeyEvent } from '../../src/shared/shortcuts'
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

describe('context-tiers.test.ts', () => {
/**
 * 上下文档位：仿 Qoder 的 3 档（完整窗口 + 2 个低档），供订阅与 API 模型在设置里调整。
 */

  it('@core:settings 1M 模型按 Qoder 档位给出 200K / 400K / 1M', () => {
    expect(contextTiersFor(1_000_000)).toEqual([200_000, 400_000, 1_000_000])
    expect(contextTiersFor(1_048_576)).toEqual([200_000, 400_000, 1_048_576])
  })

  it('@core:settings 其他窗口按 25% / 50% / 完整并吸附常用档位', () => {
    expect(contextTiersFor(128_000)).toEqual([32_768, 65_536, 128_000])
    expect(contextTiersFor(200_000)).toEqual([65_536, 100_000, 200_000])
    expect(contextTiersFor(262_144)).toEqual([65_536, 128_000, 262_144])
    expect(contextTiersFor(384_000)).toEqual([100_000, 200_000, 384_000])
    expect(contextTiersFor(32_768)).toEqual([8_192, 16_384, 32_768])
  })

  it('@core:settings 选择档位写入默认值与可选档位，选择完整窗口时清除', () => {
    const model = { id: 'm1', label: 'M1', contextWindow: 200_000, maxOutput: 32_768, supportsTools: true }
    const lowered = withModelContextChoice(model, 100_000)
    expect(lowered).toMatchObject({
      contextWindow: 200_000,
      defaultContextWindow: 100_000,
      contextEdited: true
    })
    expect(lowered.contextOptions).toEqual([65_536, 100_000, 200_000])

    const cleared = withModelContextChoice(lowered, 200_000)
    expect(cleared.contextWindow).toBe(200_000)
    expect(cleared.defaultContextWindow).toBeUndefined()
    expect(cleared.contextOptions).toBeUndefined()
    expect(cleared.contextEdited).toBe(true)
  })

  it('@core:settings 订阅 Provider 只在订阅页管理', () => {
    expect(isSubscriptionManagedProvider({ id: 'opendesign-subscription', managedBySubscription: true })).toBe(true)
    expect(isSubscriptionManagedProvider({ id: 'codex-subscription' })).toBe(true)
    expect(isSubscriptionManagedProvider({ id: 'subscription-custom-1' })).toBe(true)
    expect(isSubscriptionManagedProvider({ id: 'openai' })).toBe(false)
    expect(isSubscriptionManagedProvider({ id: 'custom-api' })).toBe(false)
  })

  it('@core:settings 最大输出档位从 32K 起，1M 上下文模型追加 256K', () => {
    expect(modelMaxOutputOptions({ id: 'm', label: 'M', contextWindow: 1_000_000, maxOutput: 32_768, supportsTools: true }))
      .toEqual([32_768, 65_536, 131_072, 262_144])
    expect(modelMaxOutputOptions({ id: 'm', label: 'M', contextWindow: 200_000, maxOutput: 32_768, supportsTools: true }))
      .toEqual([32_768, 65_536, 131_072])
    expect(modelMaxOutputOptions({ id: 'm', label: 'M', contextWindow: 128_000, maxOutput: 32_768, supportsTools: true }))
      .toEqual([32_768, 65_536, 128_000])
    expect(modelMaxOutputOptions({ id: 'm', label: 'M', contextWindow: 32_768, maxOutput: 32_768, supportsTools: true }))
      .toEqual([32_768])
    expect(modelMaxOutputOptions({ id: 'm', label: 'M', contextWindow: 256_000, maxOutput: 262_144, supportsTools: true }))
      .toContain(262_144)
    const safe = modelMaxOutputOptions({ id: 'm', label: 'M', contextWindow: 200_000, supportsTools: true })
    expect(safe).toEqual([32_768, 65_536, 131_072])
    expect(safe.every((value) => value <= 200_000)).toBe(true)
  })
})

describe('known-model-spec.test.ts', () => {
/**
 * 第三方网关不声明上下文元数据时的兜底：按模型家族给出真实长度，
 * 未知家族不猜测（仍回落到调用方的保守默认）。
 */

  it('@core:settings 已知家族取内置预设长度，未知与本地模型不猜测', () => {
    // DeepSeek V4 家族：1M 上下文 / 393216 输出（官方写作 384K）；大小写与点号写法都要认
    expect(knownModelSpec('deepseek-v4.1-flash-1017')).toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 393_216,
      supportsVision: true
    })
    expect(knownModelSpec('DeepSeek-V4.1-Flash')).toMatchObject({ contextWindow: 1_000_000 })
    expect(knownModelSpec('deepseek-v4-pro')).toMatchObject({ contextWindow: 1_000_000, maxOutput: 393_216 })
    // 其余家族与内置预设一致
    expect(knownModelSpec('kimi-k3.1-pro')).toMatchObject({ contextWindow: 1_048_576, maxOutput: 65_536 })
    expect(knownModelSpec('claude-opus-5-5')).toMatchObject({ contextWindow: 1_000_000, maxOutput: 128_000 })
    expect(knownModelSpec('gemini-3.8-flash')).toMatchObject({ contextWindow: 1_048_576 })
    expect(knownModelSpec('qwen3.8-max')).toMatchObject({ contextWindow: 1_000_000 })
    expect(knownModelSpec('minimax-m3.1-flash')).toMatchObject({ contextWindow: 1_000_000, maxOutput: 65_536 })
    expect(knownModelSpec('grok-4.7')).toMatchObject({ contextWindow: 500_000 })
    // 小模型与私有网关不能沾边：qwen2.5:7b 是本地模型名，不应被当成 1M
    expect(knownModelSpec('qwen2.5:7b')).toBeUndefined()
    expect(knownModelSpec('my-own-gateway-1')).toBeUndefined()
    expect(knownModelSpec('')).toBeUndefined()
    expect(knownModelSpec(null)).toBeUndefined()
  })
})

describe('provider-retry.test.ts', () => {
/**
 * 重试策略：设置页与服务端共用同一套归一化，越界值不落库。
 */

  it('@core:settings 重试策略归一化：合法值保留、缺省退避补默认、越界直接拒绝', () => {
    expect(normalizeProviderRetry({ maxRetries: 0, delays: [100, 200] })).toEqual({ maxRetries: 0, delays: [100, 200] })
    expect(normalizeProviderRetry({ maxRetries: 5, delays: [] })).toEqual({
      maxRetries: 5,
      delays: [...DEFAULT_PROVIDER_RETRY.delays]
    })
    // 负数与超上限的退避被丢弃，小数取整
    expect(normalizeProviderRetry({ maxRetries: 2, delays: [300.6, -1, 99_999, 'x'] })).toEqual({
      maxRetries: 2,
      delays: [301]
    })
    // 次数非法时整条策略作废，回落到「未配置 = 内置默认」，不会把 999 写进设置
    expect(normalizeProviderRetry(undefined)).toBeUndefined()
    expect(normalizeProviderRetry(null)).toBeUndefined()
    expect(normalizeProviderRetry('3')).toBeUndefined()
    expect(normalizeProviderRetry({ maxRetries: -1 })).toBeUndefined()
    expect(normalizeProviderRetry({ maxRetries: 9 })).toBeUndefined()
    expect(normalizeProviderRetry({ maxRetries: 1.5 })).toBeUndefined()
    expect(PROVIDER_RETRY_BOUNDS.maxRetries).toEqual({ min: 0, max: 8 })
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

describe('collaboration-records.test.ts', () => {
  it('@core:sessions 协作编号稳定，旧会话补齐尝试/来源，重复通知与晚到旧尝试不覆盖', () => {
    const projectA = collaborationProjectId(String.raw`C:\Work\Login`, 's-one')
    const projectB = collaborationProjectId('c:/work/login/', 's-two')
    expect(projectB).toBe(projectA)
    expect(projectA).toMatch(/^project_[0-9a-f]{12}$/)

    const taskId = collaborationTaskId(projectA, 'super_run_1', 'a')
    expect(taskId).toMatch(/^task_[0-9a-f]{12}$/)
    expect(collaborationTaskId(projectA, 'super_run_1', 'a')).toBe(taskId)
    expect(collaborationTaskId(projectA, 'super_run_2', 'a')).not.toBe(taskId)
    expect(collaborationAttemptId(taskId, 1)).not.toBe(collaborationAttemptId(taskId, 2))

    const legacy: SuperAgentState = {
      runId: 'super_run_1',
      goal: '旧会话',
      status: 'partial',
      tasks: [
        {
          id: 'a',
          index: 0,
          title: 'A',
          prompt: '',
          role: 'general',
          status: 'completed',
          dependsOn: [],
          attempts: 2,
          startedAt: 100,
          finishedAt: 300,
          summary: '完成'
        }
      ],
      createdAt: 100,
      updatedAt: 300
    }
    const normalized = normalizeSuperAgentCollaboration(legacy, projectA)
    expect(normalized.projectId).toBe(projectA)
    const task = normalized.tasks[0]
    expect(task.taskId).toMatch(/^task_[0-9a-f]{12}$/)
    expect(task.currentAttemptId).toContain('_a2')
    expect(task.attemptHistory).toHaveLength(2)
    expect(task.attemptHistory?.at(-1)?.status).toBe('delivered')
    expect(task.attemptHistory?.every((attempt) => attempt.source === 'legacy')).toBe(true)
    expect(task.statusHistory?.[0]).toMatchObject({ source: 'legacy', to: 'delivered' })

    const attemptId = task.currentAttemptId!
    const verified = {
      id: `${attemptId}:verified`,
      taskId: task.taskId!,
      attemptId,
      from: 'delivered' as const,
      to: 'verified' as const,
      at: 400,
      source: 'verifier' as const
    }
    expect(recordCollaborationStatus(task, verified)).toBe(true)
    expect(recordCollaborationStatus(task, verified)).toBe(false)
    expect(
      recordCollaborationStatus(task, {
        ...verified,
        id: 'old-attempt:verified',
        attemptId: collaborationAttemptId(task.taskId!, 1)
      })
    ).toBe(false)

    const base = { ...normalized, revision: 2, updatedAt: 400 }
    expect(shouldApplySuperAgentState(normalized, base)).toBe(true)
    expect(shouldApplySuperAgentState(base, { ...base })).toBe(false)
    expect(shouldApplySuperAgentState(base, { ...base, revision: 1, updatedAt: 399 })).toBe(false)
    expect(
      shouldApplySuperAgentState(base, {
        ...base,
        runId: 'super_run_2',
        revision: 1,
        createdAt: 500,
        updatedAt: 500
      })
    ).toBe(true)
    expect(
      shouldApplySuperAgentState(base, {
        ...base,
        runId: 'super_run_0',
        revision: 99,
        createdAt: 50,
        updatedAt: 999
      })
    ).toBe(false)
  })

  it('@core:sessions 重启只恢复待办任务：完成项不重跑，执行中转待核对，等审批状态清除', () => {
    const at = 1_000
    const state: SuperAgentState = {
      runId: 'super_restart',
      projectId: 'project_restart01',
      revision: 3,
      goal: '恢复测试',
      status: 'running',
      createdAt: 100,
      updatedAt: 200,
      tasks: [
        {
          id: 'a',
          taskId: 'task_done00000001',
          index: 0,
          title: '已完成',
          prompt: 'a',
          role: 'general',
          status: 'completed',
          dependsOn: [],
          attempts: 1,
          currentAttemptId: 'attempt_done_a1',
          attemptHistory: [
            {
              id: 'attempt_done_a1',
              taskId: 'task_done00000001',
              attempt: 1,
              status: 'delivered',
              startedAt: 110,
              finishedAt: 150,
              source: 'router'
            }
          ],
          statusHistory: [
            {
              id: 'attempt_done_a1:delivered',
              taskId: 'task_done00000001',
              attemptId: 'attempt_done_a1',
              to: 'delivered',
              at: 150,
              source: 'worker'
            }
          ],
          summary: '成果已保留'
        },
        {
          id: 'b',
          taskId: 'task_run000000002',
          index: 1,
          title: '执行中',
          prompt: 'b',
          role: 'general',
          status: 'running',
          dependsOn: [],
          attempts: 1,
          currentAttemptId: 'attempt_run_a1',
          attemptHistory: [
            {
              id: 'attempt_run_a1',
              taskId: 'task_run000000002',
              attempt: 1,
              status: 'running',
              startedAt: 160,
              source: 'router'
            }
          ],
          statusHistory: [
            {
              id: 'attempt_run_a1:running',
              taskId: 'task_run000000002',
              attemptId: 'attempt_run_a1',
              to: 'running',
              at: 160,
              source: 'router'
            }
          ],
          waitingForApproval: true,
          waitingApprovalSince: 180
        },
        {
          id: 'c',
          taskId: 'task_wait00000003',
          index: 2,
          title: '排队待办',
          prompt: 'c',
          role: 'general',
          status: 'queued',
          dependsOn: [],
          attempts: 0,
          statusHistory: [
            {
              id: 'task_wait00000003:waiting',
              taskId: 'task_wait00000003',
              to: 'waiting',
              at: 170,
              source: 'router'
            }
          ]
        }
      ]
    }
    const result = reconcileSuperAgentAfterRestart(state, at)
    expect(result).toMatchObject({ changed: true, completed: 1, cancelled: 1, waiting: 1 })
    expect(state.status).toBe('partial')
    expect(state.tasks.map((task) => task.status)).toEqual(['completed', 'cancelled', 'queued'])
    expect(state.tasks[0].attempts).toBe(1)
    expect(state.tasks[0].attemptHistory).toHaveLength(1)
    expect(state.tasks[1].attemptHistory?.at(-1)).toMatchObject({ status: 'cancelled' })
    expect(state.tasks[1].waitingForApproval).toBeUndefined()
    expect(state.tasks[1].error).toContain('应用重启')
    expect(state.tasks[2].statusHistory?.at(-1)).toMatchObject({
      source: 'system',
      to: 'waiting',
      reason: '应用重启后待继续'
    })
    expect(state.tasks[2].note).toBe('应用重启后待继续')

    const revision = state.revision
    const again = reconcileSuperAgentAfterRestart(state, at + 100)
    expect(again.changed).toBe(false)
    expect(state.revision).toBe(revision)
  })
})

describe('motion', () => {
describe('减少动效', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('@core:accessibility 设置或系统偏好开启时，滚动改为即时完成', () => {
    const dataset: Record<string, string> = {}
    vi.stubGlobal('document', { documentElement: { dataset } })
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    expect(preferredScrollBehavior()).toBe('smooth')
    dataset.reduceMotion = 'true'
    expect(preferredScrollBehavior()).toBe('auto')
    dataset.reduceMotion = 'false'
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    expect(preferredScrollBehavior()).toBe('auto')
  })
})
})

describe('shortcuts', () => {
const key = (patch: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: 'k',
  code: 'KeyK',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...patch
})

describe('自定义快捷键', () => {
  it('@core:shortcuts 归一化组合键并按平台显示', () => {
    expect(canonicalizeShortcut('ctrl+shift+m')).toBe('CommandOrControl+Shift+M')
    expect(canonicalizeShortcut('CommandOrControl+`')).toBe('CommandOrControl+`')
    expect(canonicalizeShortcut('Shift+K')).toBeNull()
    expect(formatShortcutBinding('CommandOrControl+Shift+M', 'win32')).toBe('Ctrl+Shift+M')
    expect(formatShortcutBinding('CommandOrControl+Shift+M', 'darwin')).toBe('⌘+⇧+M')
  })

  it('@core:shortcuts 录制组合键并拒绝系统保留组合', () => {
    expect(shortcutFromKeyboardEvent(key({ ctrlKey: true, altKey: true }))).toEqual({
      binding: 'CommandOrControl+Alt+K'
    })
    expect(shortcutFromKeyboardEvent(key({})).error).toContain('至少需要')
    expect(shortcutFromKeyboardEvent(key({ ctrlKey: true, code: 'KeyC', key: 'c' })).error).toContain('保留')
    expect(shortcutFromKeyboardEvent(key({ ctrlKey: true, shiftKey: true, code: 'Backquote', key: '`' })).binding).toBe(
      'CommandOrControl+Shift+`'
    )
  })

  it('@core:shortcuts 按键匹配区分平台与多余修饰键', () => {
    const binding = 'CommandOrControl+K'
    expect(matchesShortcut(key({ ctrlKey: true }), binding, 'win32')).toBe(true)
    expect(matchesShortcut(key({ ctrlKey: true, shiftKey: true }), binding, 'win32')).toBe(false)
    expect(matchesShortcut(key({ ctrlKey: true }), binding, 'darwin')).toBe(false)
    expect(matchesShortcut(key({ metaKey: true }), binding, 'darwin')).toBe(true)
  })

  it('@core:shortcuts 冲突检测与完整映射校验', () => {
    const shortcuts = { ...DEFAULT_SHORTCUTS, 'new-session': 'CommandOrControl+Shift+U' }
    expect(findShortcutConflict('CommandOrControl+Alt+U', 'palette', shortcuts)).toBeNull()
    expect(findShortcutConflict('CommandOrControl+Shift+U', 'palette', shortcuts)).toBe('new-session')
    expect(findShortcutConflict('CommandOrControl+K', 'new-session', shortcuts)).toBe('palette')
    expect(() =>
      validateShortcutMap({ ...DEFAULT_SHORTCUTS, 'new-session': DEFAULT_SHORTCUTS.palette })
    ).toThrow('同一个组合')
    expect(validateShortcutMap(shortcuts)['new-session']).toBe('CommandOrControl+Shift+U')

    const normalized = normalizeShortcutMap({
      ...DEFAULT_SHORTCUTS,
      palette: 'Ctrl+Shift+U',
      'new-session': 'Ctrl+Shift+U',
      settings: 'not a key'
    })
    expect(normalized.palette).toBe('CommandOrControl+Shift+U')
    expect(normalized['new-session']).toBe(DEFAULT_SHORTCUTS['new-session'])
    expect(normalized.settings).toBe(DEFAULT_SHORTCUTS.settings)
    const stolenDefault = normalizeShortcutMap({ ...DEFAULT_SHORTCUTS, palette: 'Ctrl+B' })
    expect(stolenDefault.palette).toBe(DEFAULT_SHORTCUTS.palette)
    expect(stolenDefault.sidebar).toBe(DEFAULT_SHORTCUTS.sidebar)
  })
})
})
