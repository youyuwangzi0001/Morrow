// 合并自 tests/unit/shared/connector-catalog.test.ts、tests/unit/shared/file-types.test.ts、tests/unit/shared/message.test.ts、tests/unit/shared/plan.test.ts、tests/unit/shared/models-cost.test.ts、tests/unit/shared/models.test.ts、tests/unit/shared/research.test.ts、tests/unit/shared/schedules.test.ts、tests/unit/shared/usage.test.ts、tests/unit/shared/tool-protocol.test.ts
// 每个原文件整体包裹在独立 describe 中，保留原有 hooks 与用例。

import { describe, expect, it } from 'vitest'
import { CONNECTOR_CATALOG, findCatalogEntry } from '../../src/shared/contracts'
import { buildLocalNpxInvocation, quoteCmdToken } from '../../src/shared/contracts'
import {
  isImageFileName,
  isPreviewImageFileName,
  isTableFileName,
  mimeTypeForFileName,
  previewKindForFileName,
} from '../../src/shared/contracts'
import type { ChatMessage, ModelInfo, SessionPlan, TodoItem, Artifact } from '../../src/shared/types'
import { messagePlainText, replaceUserMessageText, userMessageDisplayText } from '../../src/shared/types'
import { planStepKey, planStepsCompleted, todoMatchesPlanStep, todosFromPlan } from '../../src/shared/types'
import { swarmTasksFromMeta } from '../../src/shared/types'
import { estimateUsageCost } from '../../src/shared/types'
import { builtinProviders, isLocalServiceUrl, isPrivateNetworkHost, pricingForModel } from '../../src/shared/contracts'
import { MORROW_SCROLLBAR_RULES, withMorrowScrollbar } from '../../src/shared/types'
import { buildOpenAIRequestBody } from '../../src/core/providers'
import { buildAnthropicRequestBody } from '../../src/core/providers'
import type { ProviderStreamRequest } from '../../src/core/types'
import {
  isReasoningEffort,
  modelReasoningEfforts,
  normalizeReasoningEffortForModel,
  REASONING_EFFORTS,
  reasoningEffortsForModel,
  reasoningRequestFor
} from '../../src/shared/contracts'
import {
  RESEARCH_DEPTHS,
  buildResearchPlanPrompt,
  buildResearchPromptSection,
  collectResearchSources,
  createResearchState,
  decideResearchNextStep,
  hasResearchReport,
} from '../../src/shared/contracts'
import {
  computeNextRun,
  describeNextRun,
  describeSchedule,
  validateScheduleSpec,
  type ScheduleSpec,
} from '../../src/shared/contracts'
import { buildMonthLabels } from '../../src/shared/types'
import {
  ToolProtocolStreamFilter,
  parseTextToolCalls,
  stripToolProtocol,
} from '../../src/shared/types'
import { isTextFilePath, parseFilePath } from '../../src/shared/types'

describe('connector-catalog.test.ts', () => {
  describe('连接器目录', () => {
    it('条目 id/名称唯一，本机与远程字段完整', () => {
      expect(CONNECTOR_CATALOG.length).toBeGreaterThanOrEqual(6)
      expect(new Set(CONNECTOR_CATALOG.map((entry) => entry.id)).size).toBe(CONNECTOR_CATALOG.length)
      expect(new Set(CONNECTOR_CATALOG.map((entry) => entry.name)).size).toBe(CONNECTOR_CATALOG.length)
      for (const entry of CONNECTOR_CATALOG) {
        expect(entry.name, entry.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
        expect(entry.docsUrl, entry.id).toMatch(/^https:\/\//)
        expect(entry.timeoutMs).toBeGreaterThanOrEqual(5_000)
        if (entry.category === 'remote') {
          expect(entry.url, entry.id).toMatch(/^https:\/\//)
          expect(entry.transport).toBe('http')
          expect(entry.requiresNpx).toBe(false)
        } else {
          expect(entry.transport).toBe('stdio')
          expect(entry.packageArgs?.length, entry.id).toBeGreaterThan(0)
          expect(entry.requiresNpx).toBe(true)
        }
        if (entry.requiresToken) {
          expect(entry.tokenLabel, entry.id).toBeTruthy()
        }
      }
      expect(findCatalogEntry('github-remote')?.name).toBe('github')
      expect(findCatalogEntry('missing')).toBeNull()
    })

    it('Windows 下通过 cmd.exe 启动 npx，并对含空格的目录加引号', () => {
      const invocation = buildLocalNpxInvocation(
        ['@modelcontextprotocol/server-filesystem'],
        'C:\\My Projects\\A&B',
        'win32',
        'C:\\Windows\\System32\\cmd.exe'
      )
      expect(invocation.command).toBe('C:\\Windows\\System32\\cmd.exe')
      expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
      expect(invocation.args[3]).toContain('npx -y @modelcontextprotocol/server-filesystem')
      expect(invocation.args[3]).toContain('"C:\\My Projects\\A&B"')
      expect(quoteCmdToken('plain')).toBe('plain')
      expect(quoteCmdToken('has space')).toBe('"has space"')
    })

    it('非 Windows 直接启动 npx', () => {
      const invocation = buildLocalNpxInvocation(['@modelcontextprotocol/server-memory'], null, 'linux')
      expect(invocation.command).toBe('npx')
      expect(invocation.args).toEqual(['-y', '@modelcontextprotocol/server-memory'])
    })
  })
})

describe('file-types.test.ts', () => {
  describe('file preview type classification', () => {
    it('keeps chat attachments raster-only while preview accepts more image formats', () => {
      expect(isImageFileName('photo.webp')).toBe(true)
      expect(isImageFileName('diagram.svg')).toBe(false)
      expect(isImageFileName('photo.heic')).toBe(false)
      expect(isPreviewImageFileName('diagram.svg')).toBe(true)
      expect(isPreviewImageFileName('photo.heic')).toBe(true)
      expect(isPreviewImageFileName('scan.tiff')).toBe(true)
      // SVG 仍然走可编辑文本 + 图形预览，而不是二进制图片预览
      expect(previewKindForFileName('diagram.svg')).toBe('text')
      expect(mimeTypeForFileName('photo.heic')).toBe('image/heic')
    })

    it('classifies office, document, archive and table formats', () => {
      expect(previewKindForFileName('book.xlsx')).toBe('xlsx')
      expect(previewKindForFileName('deck.pptx')).toBe('pptx')
      expect(previewKindForFileName('note.rtf')).toBe('document')
      expect(previewKindForFileName('book.epub')).toBe('document')
      expect(previewKindForFileName('bundle.zip')).toBe('archive')
      expect(previewKindForFileName('legacy.doc')).toBe('unsupported')
      expect(previewKindForFileName('data.csv')).toBe('text')
      expect(isTableFileName('data.tsv')).toBe(true)
      expect(previewKindForFileName('main.ts')).toBe('text')
    })
  })
})

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

  describe('userMessageDisplayText', () => {
    it('优先使用 displayText', () => {
      const item = message({
        displayText: '用户输入',
        content: [{ type: 'text', text: '用户输入\n\n[附件] 内部资料.md：机密正文' }]
      })
      expect(userMessageDisplayText(item)).toBe('用户输入')
    })

    it('旧消息回退到附件块之前的文本', () => {
      const item = message({
        content: [{ type: 'text', text: '用户输入\n\n[附件] 内部资料.md（12 KB，路径：C:\\a.md）：正文' }]
      })
      expect(userMessageDisplayText(item)).toBe('用户输入')
    })

    it('普通文本保持原样', () => {
      const item = message({ content: [{ type: 'text', text: '没有附件' }] })
      expect(userMessageDisplayText(item)).toBe('没有附件')
      expect(messagePlainText(item)).toBe('没有附件')
    })
  })

  describe('replaceUserMessageText', () => {
    it('只替换用户输入，保留附件内容与元数据', () => {
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

    it('仅附件的旧消息也能在补充文字后保留附件', () => {
      const item = message({ content: [{ type: 'text', text: '[附件] data.csv：a,b' }] })
      const next = replaceUserMessageText(item, '看看这个')
      expect(String(next.content[0]?.type === 'text' ? next.content[0].text : '')).toContain('看看这个')
      expect(String(next.content[0]?.type === 'text' ? next.content[0].text : '')).toContain('data.csv')
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
    it('requires every plan step to have a completed todo', () => {
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

    it('ignores unrelated completed todos and whitespace differences', () => {
      const plan = makePlan(['读取数据', '生成报告'])
      expect(
        planStepsCompleted(plan, [
          todo('读取数据', 'completed'),
          todo('生成报告', 'completed'),
          todo('与计划无关的额外事项', 'completed')
        ])
      ).toBe(true)
      const spaced = makePlan(['读取  数据', '生成报告'])
      expect(
        planStepsCompleted(spaced, [todo('读取 数据', 'completed'), todo('生成报告', 'completed')])
      ).toBe(true)
    })

    it('matches long step text using the todo_write 200-character limit', () => {
      const longStep = `${'很长的步骤说明'.repeat(40)}结尾甲`
      const truncated = longStep.slice(0, 200)
      expect(planStepKey(longStep)).toBe(truncated)
      expect(todoMatchesPlanStep(todo(truncated, 'completed'), longStep)).toBe(true)
    })

    it('builds a fresh pending todo list from plan steps', () => {
      const plan = makePlan(['读取数据', '生成报告'])
      const todos = todosFromPlan(plan)
      expect(todos).toEqual([
        { id: 'todo_step_0', text: '读取数据', status: 'pending' },
        { id: 'todo_step_1', text: '生成报告', status: 'pending' }
      ])
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
    it('maps effort style to reasoning_effort for OpenAI-compatible requests', () => {
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

    it('maps thinking style to Anthropic thinking budget with valid max_tokens/temperature', () => {
      const body = buildAnthropicRequestBody(
        request({ reasoning: { effort: 'medium', style: 'thinking' }, maxTokens: 2000 }),
        'claude-opus-5.5'
      )
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
      expect(body.temperature).toBe(1)
      expect(Number(body.max_tokens)).toBeGreaterThan(4096)
    })

    it('supports xhigh and max thinking budgets', () => {
      const xhigh = buildAnthropicRequestBody(
        request({ reasoning: { effort: 'xhigh', style: 'thinking' }, maxTokens: 2000 }),
        'claude-fable-5-1'
      )
      expect(xhigh.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 })
      expect(Number(xhigh.max_tokens)).toBeGreaterThan(16384)

      const max = buildAnthropicRequestBody(
        request({ reasoning: { effort: 'max', style: 'thinking' }, maxTokens: 2000 }),
        'claude-fable-5-1'
      )
      expect(max.thinking).toEqual({ type: 'enabled', budget_tokens: 32768 })
      expect(Number(max.max_tokens)).toBeGreaterThan(32768)
    })

    it('marks reasoning styles and reference pricing on built-in models', () => {
      const providers = builtinProviders()
      const claude = providers.find((p) => p.id === 'anthropic')?.models[0]
      const openai = providers.find((p) => p.id === 'openai')?.models[0]
      const deepseek = providers.find((p) => p.id === 'deepseek')?.models[0]
      expect(claude?.reasoningStyle).toBe('thinking')
      expect(openai?.reasoningStyle).toBe('effort')
      expect(deepseek?.reasoningStyle).toBe('effort')
      expect(deepseek?.pricing?.inputPerMTok).toBeGreaterThan(0)
      for (const provider of providers) {
        for (const model of provider.models) {
          if (model.supportsReasoning) expect(model.reasoningStyle, `${provider.id}/${model.id}`).toBeTruthy()
        }
      }
      expect(pricingForModel('unknown-model')).toBeUndefined()
    })

    it('exposes Meta Muse Wonder with frontier context, vision and pricing', () => {
      const meta = builtinProviders().find((provider) => provider.id === 'meta')
      const model = meta?.models.find((item) => item.id === 'muse-wonder-1.0')
      expect(model?.label).toBe('Muse Wonder 1.0')
      expect(model?.contextWindow).toBe(1_048_576)
      expect(model?.supportsVision).toBe(true)
      expect(model?.supportsTools).toBe(true)
      expect(model?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
      expect(model?.pricing).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 })
      expect(pricingForModel('muse-wonder-1.0')).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 })
    })

    it('classifies loopback and private LAN services without treating public hosts as local', () => {
      expect(isLocalServiceUrl('http://127.0.0.1:11434/v1')).toBe(true)
      expect(isLocalServiceUrl('http://localhost:1234/v1')).toBe(true)
      expect(isLocalServiceUrl('http://[::1]:8188')).toBe(true)
      expect(isLocalServiceUrl('http://192.168.1.20:11434/v1', { allowPrivate: true })).toBe(true)
      expect(isLocalServiceUrl('http://192.168.1.20:11434/v1')).toBe(false)
      expect(isLocalServiceUrl('http://10.0.0.8:1234/v1', { allowPrivate: true })).toBe(true)
      expect(isLocalServiceUrl('http://172.16.4.2:1234/v1', { allowPrivate: true })).toBe(true)
      expect(isLocalServiceUrl('http://172.32.4.2:1234/v1', { allowPrivate: true })).toBe(false)
      expect(isLocalServiceUrl('https://api.example.com/v1', { allowPrivate: true })).toBe(false)
      expect(isLocalServiceUrl('not a url', { allowPrivate: true })).toBe(false)
      expect(isPrivateNetworkHost('ollama.local')).toBe(true)
      expect(isPrivateNetworkHost('fd00::1')).toBe(true)
      expect(isPrivateNetworkHost('8.8.8.8')).toBe(false)
    })
  })

  describe('cost estimation', () => {
    it('estimates input/output/cache cost and returns undefined without pricing', () => {
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

describe('reasoning.test.ts', () => {
  describe('推理强度白名单', () => {
    it('包含 auto/off 与真实档位', () => {
      expect(REASONING_EFFORTS).toEqual(['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'])
      for (const effort of REASONING_EFFORTS) expect(isReasoningEffort(effort)).toBe(true)
    })

    it('拒绝大小写变体、空值与旧档位', () => {
      for (const value of ['HIGH', 'XHIGH', '', 'minimal', 'none', null, undefined, 1, {}, []]) {
        expect(isReasoningEffort(value)).toBe(false)
      }
    })
  })

  describe('模型真实档位', () => {
    const unknown = {
      id: 'unknown-model',
      label: 'Unknown',
      contextWindow: 128_000,
      supportsTools: true,
      supportsReasoning: true,
      reasoningStyle: 'effort'
    } satisfies ModelInfo

    it('DeepSeek V4.1 Flash 只暴露 off/low/high/max，medium 会退回自动', () => {
      const deepseek = builtinProviders()
        .find((provider) => provider.id === 'deepseek')!
        .models.find((model) => model.id === 'deepseek-flash')!
      expect(modelReasoningEfforts(deepseek)).toEqual(['auto', 'off', 'low', 'high', 'max'])
      expect(normalizeReasoningEffortForModel(deepseek, 'medium')).toBe('auto')
      expect(normalizeReasoningEffortForModel(deepseek, 'off')).toBe('off')
      expect(reasoningRequestFor(deepseek, 'off')).toEqual({ effort: 'off', style: 'effort' })
    })

    it('通过 API Key 接入的 DeepSeek 也识别同一组官方档位', () => {
      expect(reasoningEffortsForModel('deepseek-v4.1-flash', true)).toEqual(['off', 'low', 'high', 'max'])
      expect(reasoningEffortsForModel('deepseek-v4.1-flash', false)).toBeUndefined()
    })

    it('没有元数据的模型只给自动；不支持思考的模型为空', () => {
      expect(modelReasoningEfforts(unknown)).toEqual(['auto'])
      expect(normalizeReasoningEffortForModel(unknown, 'high')).toBe('auto')
      expect(modelReasoningEfforts({ ...unknown, supportsReasoning: false })).toEqual([])
      expect(reasoningRequestFor(unknown, 'high')).toBeUndefined()
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
    it('深度配置与初始状态', () => {
      expect(RESEARCH_DEPTHS.quick).toMatchObject({ maxRounds: 2, minSources: 4 })
      expect(RESEARCH_DEPTHS.standard).toMatchObject({ maxRounds: 4, minSources: 10 })
      expect(RESEARCH_DEPTHS.deep).toMatchObject({ maxRounds: 6, minSources: 20 })
      const state = createResearchState('  某主题  ', 'standard', at(0))
      expect(state).toMatchObject({
        topic: '某主题',
        depth: 'standard',
        status: 'searching',
        round: 1,
        maxRounds: 4,
        minSources: 10,
        sourceCount: 0
      })
      const planning = createResearchState('某主题', 'quick', at(0), { status: 'planning' })
      expect(planning.status).toBe('planning')
      expect(planning.plan).toBeUndefined()
    })

    it('计划阶段只输出计划；确认后研究提示包含计划', () => {
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

    it('统计搜索与网页读取的成功来源，按归一化 URL 去重并过滤旧来源', () => {
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

    it('报告正文带来源章节与两个链接也算报告，来源标题支持加粗/英文', () => {
      const state = createResearchState('主题', 'quick', at(0))
      const artifact: Artifact = {
        id: 'art-2',
        title: '英伟达季度分析',
        kind: 'markdown',
        content: '# 结论\n\n**参考来源**\n[1] https://a.example/1\n[2] https://b.example/2',
        createdAt: at(10),
        updatedAt: at(10)
      }
      expect(hasResearchReport([], [artifact], state.startedAt)).toEqual({ present: true, artifactId: 'art-2' })
      const english = textMessage('## Sources\n[1] https://a.example/1\n[2] https://b.example/2', at(20))
      expect(hasResearchReport([english], [], state.startedAt).present).toBe(true)
    })

    it('报告成品或带来源章节的回复都算报告', () => {
      const state = createResearchState('主题', 'quick', at(0))
      const artifact: Artifact = {
        id: 'art-1',
        title: '主题研究报告',
        kind: 'markdown',
        content: '# 报告',
        createdAt: at(10),
        updatedAt: at(10)
      }
      expect(hasResearchReport([], [artifact], state.startedAt)).toEqual({ present: true, artifactId: 'art-1' })

      const text = textMessage(
        '## 关键结论\n- 结论一 [1]\n\n## 参考来源\n[1] https://a.example/1\n[2] https://b.example/2',
        at(20)
      )
      expect(hasResearchReport([text], [], state.startedAt).present).toBe(true)
      expect(hasResearchReport([textMessage('没有来源的总结', at(20))], [], state.startedAt).present).toBe(false)
    })

    it('来源和报告都达标才完成；不足则给下一轮补查指令；到上限则如实停止', () => {
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

    it('每天：今天已过则排到明天，未到则排今天', () => {
      const later = computeNextRun({ kind: 'daily', time: '18:00' }, base)
      expect(later).toBe(at(2026, 10, 20, 18))
      const earlier = computeNextRun({ kind: 'daily', time: '09:00' }, base)
      expect(earlier).toBe(at(2026, 10, 21, 9))
    })

    it('每周：按星期几排到下一次；同一天已过则顺延一周', () => {
      const Tuesday = new Date(base).getDay()
      const sameFuture = computeNextRun({ kind: 'weekly', time: '18:00', weekday: Tuesday }, base)
      expect(sameFuture).toBe(at(2026, 10, 20, 18))
      const samePast = computeNextRun({ kind: 'weekly', time: '09:00', weekday: Tuesday }, base)
      expect(samePast).toBe(at(2026, 10, 27, 9))
      const twoDays = computeNextRun({ kind: 'weekly', time: '08:15', weekday: (Tuesday + 2) % 7 }, base)
      expect(twoDays).toBe(at(2026, 10, 22, 8, 15))
    })

    it('一次：使用本地日期+时间，过去时间由校验拒绝', () => {
      const future: ScheduleSpec = { kind: 'once', time: '08:00', date: '2026-10-22' }
      expect(computeNextRun(future, base)).toBe(at(2026, 10, 22, 8))
      expect(() => validateScheduleSpec(future, base)).not.toThrow()
      expect(() => validateScheduleSpec({ kind: 'once', time: '08:00', date: '2026-10-19' }, base)).toThrow(
        '晚于现在'
      )
      expect(() => validateScheduleSpec({ kind: 'once', time: '08:00', date: '2026-02-30' }, base)).toThrow('有效日期')
    })

    it('时间/星期校验与中文描述', () => {
      expect(() => validateScheduleSpec({ kind: 'daily', time: '25:00' }, base)).toThrow('时间格式')
      expect(() => validateScheduleSpec({ kind: 'weekly', time: '09:00', weekday: 9 }, base)).toThrow('星期')
      expect(describeSchedule({ kind: 'daily', time: '09:00' })).toBe('每天 09:00')
      expect(describeSchedule({ kind: 'weekly', time: '09:00', weekday: 1 })).toBe('每周一 09:00')
      expect(describeSchedule({ kind: 'once', time: '09:00', date: '2026-12-01' })).toBe('12月1日 09:00 · 一次')
    })

    it('下一次执行的中文提示', () => {
      expect(describeNextRun(null, base)).toBe('未安排')
      expect(describeNextRun(base - 1000, base)).toBe('即将执行')
      expect(describeNextRun(at(2026, 10, 20, 18), base)).toBe('今天 18:00')
      expect(describeNextRun(at(2026, 10, 21, 9), base)).toBe('明天 09:00')
      expect(describeNextRun(at(2026, 10, 25, 9), base)).toBe('5 天后 09:00')
      expect(describeNextRun(at(2026, 11, 2, 9), base)).toBe('11月2日 09:00')
    })

    it('每周日文案不重复“周”', () => {
      expect(describeSchedule({ kind: 'weekly', time: '09:00', weekday: 0 })).toBe('每周日 09:00')
    })
  })
})

describe('token-heatmap.test.ts', () => {
  function columns(labels: ReturnType<typeof buildMonthLabels>): number[] {
    return labels.map((label) => label.column)
  }

  describe('buildMonthLabels', () => {
    it('起始月剩余不足 3 周时不标起始月，月份标签不重叠', () => {
      const labels = buildMonthLabels(new Date(2025, 9, 22), new Date(2026, 9, 21))
      expect(labels.map((label) => label.label)).toEqual([
        '11月',
        '12月',
        '1月',
        '2月',
        '3月',
        '4月',
        '5月',
        '6月',
        '7月',
        '8月',
        '9月',
        '10月'
      ])
      expect(columns(labels)).toEqual([1, 6, 10, 14, 18, 23, 27, 32, 36, 40, 45, 49])
      for (let index = 1; index < labels.length; index += 1) {
        expect(labels[index].column - labels[index - 1].column).toBeGreaterThanOrEqual(3)
      }
    })

    it('起始月剩余满 3 周时保留起始月标签', () => {
      const labels = buildMonthLabels(new Date(2025, 9, 11), new Date(2025, 11, 31))
      expect(labels.map((label) => label.label)).toEqual(['10月', '11月', '12月'])
      expect(columns(labels)).toEqual([0, 3, 8])
    })

    it('起始月只剩 20 天时不标起始月，避免和紧邻的下月标签挤在一起', () => {
      const labels = buildMonthLabels(new Date(2025, 9, 12), new Date(2025, 11, 31))
      expect(labels.map((label) => label.label)).toEqual(['11月', '12月'])
      expect(columns(labels)).toEqual([3, 8])
    })

    it('标签列严格递增且间距不小于 3 列', () => {
      const ranges: Array<[Date, Date]> = [
        [new Date(2024, 1, 1), new Date(2025, 0, 31)],
        [new Date(2025, 0, 30), new Date(2025, 11, 31)],
        [new Date(2026, 1, 27), new Date(2027, 2, 5)]
      ]
      for (const [start, end] of ranges) {
        const labels = buildMonthLabels(start, end)
        expect(labels.length).toBeGreaterThan(1)
        for (let index = 1; index < labels.length; index += 1) {
          expect(labels[index].column).toBeGreaterThanOrEqual(labels[index - 1].column + 3)
        }
      }
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
    it('DeepSeek DSML（全角）', () => {
      const text = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="edit_file">
<｜｜DSML｜｜ parameter name="path" string="true">tetris-soviet/index.html</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
      expect(parseTextToolCalls(text)).toEqual([CALL])
      expect(stripToolProtocol(`先改文件。\n${text}\n改完了。`)).toBe('先改文件。\n\n改完了。')
    })

    it('Kimi K2/K3 特殊 token', () => {
      const text = `<|tool_calls_section_begin|>
<|tool_call_begin|>functions.edit_file:0<|tool_call_argument_begin|>{"path":"tetris-soviet/index.html"}<|tool_call_end|>
<|tool_calls_section_end|>`
      expect(parseTextToolCalls(text)).toEqual([CALL])
      expect(stripToolProtocol(text)).toBe('')
      const result = stream(text, 13)
      expect(result.visible).toBe('')
      expect(result.calls).toEqual([CALL])
    })

    it('MiniMax M2/M3 XML', () => {
      const text = `<minimax:tool_call>
<invoke name="edit_file">
<parameter name="path">tetris-soviet/index.html</parameter>
</invoke>
</minimax:tool_call>`
      expect(parseTextToolCalls(text)).toEqual([CALL])
      expect(stripToolProtocol(text)).toBe('')
      expect(stream(text, 7).calls).toEqual([CALL])
    })

    it('Qwen JSON 与参数标签两种形态', () => {
      const json = `<tool_call>{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}</tool_call>`
      const tags = `<tool_call><function=edit_file><parameter=path>tetris-soviet/index.html</parameter></function></tool_call>`
      expect(parseTextToolCalls(json)).toEqual([CALL])
      expect(parseTextToolCalls(tags)).toEqual([CALL])
      expect(stripToolProtocol(`改一下：\n${json}\n好了`)).toBe('改一下：\n\n好了')
    })

    it('GLM arg_key / arg_value', () => {
      const text = `<tool_call>edit_file
<arg_key>path</arg_key><arg_value>tetris-soviet/index.html</arg_value>
</tool_call>`
      expect(parseTextToolCalls(text)).toEqual([CALL])
      expect(stripToolProtocol(text)).toBe('')
    })

    it('Mistral [TOOL_CALLS] 与 JSON 后的正文', () => {
      const text = `[TOOL_CALLS] [{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}] 已经改好了。`
      expect(parseTextToolCalls(text)).toEqual([CALL])
      expect(stripToolProtocol(text)).toContain('已经改好了。')
      expect(stream(text, 9).visible).toContain('已经改好了。')
    })

    it('Llama python_tag 与 pythonic 调用', () => {
      const json = `<|python_tag|>{"name":"edit_file","parameters":{"path":"tetris-soviet/index.html"}}`
      const pythonic = '<|python_tag|>[edit_file(path="tetris-soviet/index.html")]'
      expect(parseTextToolCalls(json)).toEqual([CALL])
      expect(parseTextToolCalls(pythonic)).toEqual([CALL])
    })

    it('通用 tool_call / function_call / invoke', () => {
      const cases = [
        '<tool_call>{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}</tool_call>',
        '<function_call>{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}</function_call>',
        '<invoke name="edit_file"><parameter name="path">tetris-soviet/index.html</parameter></invoke>'
      ]
      for (const text of cases) expect(parseTextToolCalls(text)).toEqual([CALL])
    })

    it('流式分片不会把协议标记漏进正文', () => {
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

    it('代码围栏里的协议示例按普通代码保留', () => {
      const example = '```html\n<tool_call>{"name":"edit_file","arguments":{"path":"a.html"}}</tool_call>\n```\n这只是示例。'
      const result = stream(example, 7)
      expect(result.visible).toBe(example)
      expect(result.calls).toEqual([])
      expect(stripToolProtocol(example)).toBe(example)
    })

    it('历史消息中的未闭合协议被截断，不显示成乱码', () => {
      const text = `答案在这里：\n<tool_call>{"name":"edit_file","arguments":{"path":"a.html"}}`
      expect(stripToolProtocol(text)).toBe('答案在这里：')
    })
  })
})

describe('file-path.test.ts', () => {
  describe('file-path：对话里的文件路径识别', () => {
    it('识别工作区相对路径、Windows 绝对路径与行号', () => {
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

    it('不把命令、URL、版本号、目录或不支持的字符串变成文件链接', () => {
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

    it('区分文本与二进制文件，供复制内容使用', () => {
      expect(isTextFilePath('report.md')).toBe(true)
      expect(isTextFilePath('src/main/ipc.ts')).toBe(true)
      expect(isTextFilePath('Morrow-0.1.0-portable.exe')).toBe(false)
      expect(isTextFilePath('assets/logo.png')).toBe(false)
      expect(isTextFilePath('report.pdf')).toBe(false)
    })
  })
})

describe('iframe / 内置浏览器滚动条', () => {
  it('与宿主一致：8px 轨道、6px 实色滑块、全圆角、无渐变', () => {
    expect(MORROW_SCROLLBAR_RULES).toContain('width: 8px')
    expect(MORROW_SCROLLBAR_RULES).toContain('border: 1px solid transparent')
    expect(MORROW_SCROLLBAR_RULES).toContain('border-radius: 999px')
    expect(MORROW_SCROLLBAR_RULES).toContain('background: #8a6f42')
    expect(MORROW_SCROLLBAR_RULES).toContain('background-clip: content-box')
    expect(MORROW_SCROLLBAR_RULES).not.toContain('linear-gradient')
    const html = withMorrowScrollbar('<html><head></head><body>预览</body></html>')
    expect(html).toContain('data-morrow-scrollbar')
    expect(withMorrowScrollbar(html)).toBe(html)
  })
})

describe('swarm 任务操作回放', () => {
  it('成员操作不再截断到 30 条，重新加载会话也能全部展开', () => {
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
