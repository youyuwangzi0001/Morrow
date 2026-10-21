import { describe, expect, it } from 'vitest'
import type { Artifact, ChatMessage } from '../../../src/shared/types'
import {
  RESEARCH_DEPTHS,
  buildResearchPlanPrompt,
  buildResearchPromptSection,
  collectResearchSources,
  createResearchState,
  decideResearchNextStep,
  hasResearchReport
} from '../../../src/shared/research'

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
