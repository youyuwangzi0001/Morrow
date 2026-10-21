import { describe, expect, it } from 'vitest'
import { estimateUsageCost } from '../../../src/shared/cost'
import { builtinProviders, pricingForModel } from '../../../src/shared/models'
import { buildOpenAIRequestBody } from '../../../src/core/providers/openai-compat'
import { buildAnthropicRequestBody } from '../../../src/core/providers/anthropic'
import type { ProviderStreamRequest } from '../../../src/core/types'

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
