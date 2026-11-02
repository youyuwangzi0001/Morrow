import { describe, expect, it } from 'vitest'
import {
  antigravityRuntime,
  buildAntigravityRequest,
  parseAntigravityFrame,
  parseAntigravityQuota,
  sanitizeGeminiSchema
} from '../../../src/main/services/antigravity-protocol'
import {
  CLINE_MODELS,
  parseClineQuota,
  rewriteClineBody,
  unwrapClineJson
} from '../../../src/main/services/cline-protocol'
import {
  parseCommandCodeAccount,
  parseCommandCodeCatalog,
  parseCommandCodeQuota,
  rewriteCommandCodeAnthropic,
  rewriteCommandCodeChat
} from '../../../src/main/services/command-code-protocol'
import {
  GLM_KEY_NAME,
  parseCustomerScope,
  parseGlmQuota,
  pickGlmApiKey,
  rewriteGlmBody
} from '../../../src/main/services/glm-protocol'
import { parseKimiQuota, rewriteKimiBody } from '../../../src/main/services/kimi-protocol'
import {
  parseMinimaxLocalAuth,
  parseMinimaxQuota,
  rewriteMinimaxBody
} from '../../../src/main/services/minimax-protocol'
import { parseOpencodeAuth, parseOpencodeModels, rewriteOpencodeBody } from '../../../src/main/services/opencode-protocol'
import {
  STEP_PROFILES,
  parseStepLocalAuth,
  parseStepModels,
  rewriteStepBody
} from '../../../src/main/services/step-protocol'

describe('Antigravity 协议', () => {
  it('按模型与思考档位选择运行时 ID', () => {
    expect(antigravityRuntime('gemini-3.1-pro', 'high')).toBe('gemini-pro-agent')
    expect(antigravityRuntime('gemini-3.1-pro', 'low')).toBe('gemini-3.1-pro-low')
    expect(antigravityRuntime('gemini-3.8-flash', 'max')).toBe('gemini-3.8-flash-tiered')
    expect(antigravityRuntime('claude-opus-5-5', 'medium')).toBe('claude-opus-5-5-medium')
    expect(antigravityRuntime('unknown-model', 'high')).toBe('unknown-model')
  })

  it('把 OpenAI 消息与工具调用翻译成 Gemini contents', () => {
    const { envelope, runtime } = buildAntigravityRequest(JSON.stringify({
      model: 'gemini-3.1-pro',
      reasoning_effort: 'high',
      max_tokens: 4096,
      temperature: 0.3,
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '读文件' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]
        },
        { role: 'tool', tool_call_id: 'call_1', content: '内容' }
      ],
      tools: [{
        type: 'function',
        function: { name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
      }]
    }), 'project-1')

    expect(runtime).toBe('gemini-pro-agent')
    expect(envelope.project).toBe('project-1')
    expect(envelope.requestType).toBe('agent')
    const request = envelope.request as Record<string, unknown>
    const contents = request.contents as Array<Record<string, unknown>>
    expect(contents[0]).toMatchObject({ role: 'user' })
    expect(contents[1]).toMatchObject({ role: 'model' })
    expect((contents[1].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      functionCall: { name: 'read_file', args: { path: 'a.txt' } },
      thoughtSignature: 'skip_thought_signature_validator'
    })
    expect((contents[2].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      functionResponse: { name: 'read_file', response: { result: '内容' } }
    })
    const system = request.systemInstruction as Record<string, unknown>
    expect(JSON.stringify(system)).toContain('你是助手')
    const generation = request.generationConfig as Record<string, unknown>
    expect(generation.maxOutputTokens).toBe(4096)
    expect(generation.thinkingConfig).toEqual({ includeThoughts: true })
    const tools = request.tools as Array<Record<string, unknown>>
    expect(JSON.stringify(tools)).toContain('read_file')
    expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } })
  })

  it('清洗 Gemini 不接受的 JSON Schema 关键字', () => {
    const schema = sanitizeGeminiSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: ['string', 'null'], description: '路径' },
        mode: { oneOf: [{ const: 'read' }, { const: 'write' }] }
      },
      required: ['path']
    }) as Record<string, any>
    expect(schema.$schema).toBeUndefined()
    expect(schema.additionalProperties).toBeUndefined()
    expect(schema.properties.path).toMatchObject({ type: 'string', nullable: true, description: '路径' })
    expect(schema.properties.mode.anyOf).toEqual([{ enum: ['read'] }, { enum: ['write'] }])
  })

  it('解析 SSE 响应中的文本、思考、工具与用量', () => {
    const events = parseAntigravityFrame({
      response: {
        candidates: [{
          content: {
            parts: [
              { text: '思考中', thought: true },
              { text: '答案' },
              { functionCall: { name: 'list_files', args: { path: '.' } } }
            ]
          },
          finishReason: 'STOP'
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 3 }
      }
    })
    expect(events).toContainEqual({ type: 'thought', text: '思考中' })
    expect(events).toContainEqual({ type: 'text', text: '答案' })
    expect(events).toContainEqual({ type: 'tool', name: 'list_files', args: '{"path":"."}' })
    expect(events).toContainEqual({ type: 'finish', reason: 'STOP' })
    expect(events).toContainEqual({ type: 'usage', input: 10, output: 7, cached: 3 })
  })

  it('解析额度桶：剩余比例换算成已用百分比', () => {
    const quota = parseAntigravityQuota({
      groups: [{
        displayName: 'Gemini',
        buckets: [
          { bucketId: 'g1', displayName: '每日', remainingFraction: 0.75, resetTime: '2026-10-25T00:00:00Z' },
          { bucketId: 'g2', displayName: '无数据' }
        ]
      }]
    }, 5)
    expect(quota.fetchedAt).toBe(5)
    expect(quota.windows).toHaveLength(1)
    expect(quota.windows[0]).toMatchObject({ id: 'Gemini-每日', usedPercent: 25 })
    expect(quota.windows[0].resetAt).toBe(Date.parse('2026-10-25T00:00:00Z'))
  })
})

describe('Cline Pass 协议', () => {
  it('模型 ID 自动补 cline-pass/ 前缀并开启流式用量', () => {
    const body = JSON.parse(rewriteClineBody(JSON.stringify({
      model: 'kimi-k3',
      stream: false
    }))) as Record<string, unknown>
    expect(body.model).toBe('cline-pass/kimi-k3')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.max_tokens).toBe(64_000)
    expect(CLINE_MODELS).toHaveLength(14)
    expect(CLINE_MODELS.every((model) => model.id.startsWith('cline-pass/'))).toBe(true)
  })

  it('解包 {success,data} 的非流式响应', () => {
    const unwrapped = JSON.parse(unwrapClineJson(JSON.stringify({
      success: true,
      data: { choices: [{ message: { content: 'ok' } }] }
    }))) as Record<string, unknown>
    expect(unwrapped.choices).toBeDefined()
    expect(unwrapClineJson('{"choices":[]}')).toBe('{"choices":[]}')
    expect(unwrapClineJson('not json')).toBe('not json')
  })

  it('解析五小时 / 每周 / 每月额度', () => {
    const quota = parseClineQuota({
      success: true,
      data: {
        limits: [
          { type: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-24T12:00:00Z' },
          { type: 'weekly', percentUsed: 40 },
          { type: 'monthly', percentUsed: 80 }
        ]
      }
    }, 3)
    expect(quota.fetchedAt).toBe(3)
    expect(quota.windows.map((window) => window.label)).toEqual(['5 小时', '每周', '每月'])
    expect(quota.windows[0].usedPercent).toBe(12.5)
    expect(quota.windows[0].resetAt).toBe(Date.parse('2026-10-24T12:00:00Z'))
  })
})

describe('Command Code 协议', () => {
  it('GPT 系列使用 max_completion_tokens，其余用 max_tokens', () => {
    const gpt = JSON.parse(rewriteCommandCodeChat(JSON.stringify({
      model: 'gpt-6-astra',
      max_tokens: 4096,
      reasoning_effort: 'none',
      stream: false
    }))) as Record<string, unknown>
    expect(gpt.max_tokens).toBeUndefined()
    expect(gpt.max_completion_tokens).toBe(4096)
    expect(gpt.reasoning_effort).toBeUndefined()
    expect(gpt.stream).toBe(true)

    const deepseek = JSON.parse(rewriteCommandCodeChat(JSON.stringify({
      model: 'deepseek/deepseek-v4-pro',
      max_completion_tokens: 2048
    }))) as Record<string, unknown>
    expect(deepseek.max_tokens).toBe(2048)
    expect(deepseek.max_completion_tokens).toBeUndefined()
  })

  it('Anthropic wire 强制流式并保留工具结构', () => {
    const body = JSON.parse(rewriteCommandCodeAnthropic(JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      temperature: 0.5,
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }]
    }))) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.temperature).toBeUndefined()
    expect(Array.isArray(body.tools)).toBe(true)
  })

  it('按 supported_endpoints 分流模型，跳过仅 Responses 的条目', () => {
    const catalog = parseCommandCodeCatalog({
      data: [
        { id: 'claude-sonnet-5-5', supported_endpoints: ['/provider/v1/messages'] },
        { id: 'deepseek/deepseek-v4-pro', supported_endpoints: ['/provider/v1/chat/completions'], context_length: 384000 },
        { id: 'gpt-6-astra', supported_endpoints: ['/provider/v1/responses'] },
        { id: 'first-endpoint-wins', supported_endpoints: ['/provider/v1/responses', '/provider/v1/chat/completions'] }
      ]
    })
    expect(catalog.claude.map((model) => model.id)).toEqual(['claude-sonnet-5-5'])
    expect(catalog.chat.map((model) => model.id)).toEqual(['deepseek/deepseek-v4-pro'])
    expect(catalog.chat[0]?.contextWindow).toBe(384_000)
  })

  it('解析 whoami 与额度窗口', () => {
    expect(parseCommandCodeAccount({
      data: { user: { email: 'a@b.c', userName: 'A', id: 'u1' }, subscription: { name: 'Pro' } }
    })).toMatchObject({ email: 'a@b.c', name: 'A', uid: 'u1', plan: 'Pro' })

    const quota = parseCommandCodeQuota({
      data: {
        windowLimits: {
          fiveHour: { used: 20, cap: 100, resetAt: 1760000000000 },
          weekly: { used: 5, cap: 0 }
        },
        credits: { monthlyCredits: 42 }
      }
    }, 7)
    expect(quota.fetchedAt).toBe(7)
    expect(quota.windows[0]).toMatchObject({ id: 'fiveHour', usedPercent: 20 })
    expect(quota.windows.some((window) => window.id === 'monthly-credits' && window.remaining === 42)).toBe(true)
  })
})

describe('GLM Coding Plan 协议', () => {
  it('强制流式与思考，Turbo 不发送思考字段', () => {
    const standard = JSON.parse(rewriteGlmBody(JSON.stringify({
      model: 'GLM-5.3',
      stream: false,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }]
    }))) as Record<string, unknown>
    expect(standard.stream).toBe(true)
    expect(standard.thinking).toEqual({ type: 'enabled' })
    expect(standard.reasoning_effort).toBe('high')
    expect(standard.max_tokens).toBe(8192)

    const turbo = JSON.parse(rewriteGlmBody(JSON.stringify({
      model: 'GLM-5-Turbo',
      thinking: { type: 'enabled' },
      max_tokens: 4096
    }))) as Record<string, unknown>
    expect(turbo.thinking).toBeUndefined()
    expect(turbo.reasoning_effort).toBeUndefined()
    expect(turbo.max_tokens).toBe(4096)
  })

  it('解析 TOKENS_LIMIT / CREDIT_LIMIT，丢弃未知单位与 TIME_LIMIT', () => {
    const quota = parseGlmQuota({
      success: true,
      data: {
        level: 'pro',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, percentage: 25, nextResetTime: 1760000000000 },
          { type: 'CREDIT_LIMIT', unit: 5, currentValue: 20, usage: 100 },
          { type: 'TIME_LIMIT', unit: 6, percentage: 90 },
          { type: 'TOKENS_LIMIT', unit: 99, percentage: 10 }
        ]
      }
    }, 123)
    expect(quota.fetchedAt).toBe(123)
    expect(quota.windows.map((window) => window.id)).toEqual(['five-hour', 'monthly'])
    expect(quota.windows[0]).toMatchObject({ usedPercent: 25, resetAt: 1760000000000 })
    expect(quota.windows[1].usedPercent).toBe(20)
  })

  it('业务失败时给出说明而不是伪造 0%', () => {
    const quota = parseGlmQuota({ success: false })
    expect(quota.windows).toEqual([])
    expect(quota.message).toContain('成功')
  })

  it('定位默认机构与默认项目', () => {
    const scope = parseCustomerScope({
      data: {
        organizations: [
          { organizationId: 'org-1', organizationName: '普通机构', projects: [{ projectId: 'p0' }] },
          { organizationId: 'org-2', organizationName: '默认机构', projects: [
            { projectId: 'p1', projectName: '测试项目' },
            { projectId: 'p2', projectName: '默认项目' }
          ] }
        ]
      }
    })
    expect(scope).toMatchObject({ organizationId: 'org-2', projectId: 'p2' })
  })

  it('只复用本线路创建的同名 Key', () => {
    const key = pickGlmApiKey({
      data: [
        { id: 'other', name: 'zcode-api-key' },
        { id: 'mine', name: GLM_KEY_NAME }
      ]
    })
    expect(key?.id).toBe('mine')
    expect(pickGlmApiKey({ data: [] })).toBeNull()
  })
})

describe('Kimi Code 协议', () => {
  it('把 Chat Completions 请求改写成 Kimi 编码规则', () => {
    const rewritten = JSON.parse(rewriteKimiBody(JSON.stringify({
      model: 'k3',
      stream: true,
      max_tokens: 4096,
      temperature: 0.7,
      top_p: 0.9,
      messages: [
        { role: 'system', content: '系统' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '调用工具', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '内容' }
      ],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }]
    }))) as Record<string, any>

    expect(rewritten.max_tokens).toBeUndefined()
    expect(rewritten.temperature).toBeUndefined()
    expect(rewritten.top_p).toBeUndefined()
    expect(rewritten.max_completion_tokens).toBe(4096)
    expect(rewritten.stream).toBe(true)
    expect(rewritten.stream_options).toEqual({ include_usage: true })
    expect(rewritten.reasoning_effort).toBe('high')
    expect(rewritten.thinking).toEqual({ type: 'enabled', effort: 'high', keep: 'all' })
    expect(rewritten.tool_choice).toBe('auto')
    expect(rewritten.messages[0]).toEqual({ role: 'system', content: '系统' })
    expect(rewritten.messages[2].reasoning_content).toBe('')
    expect(rewritten.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '内容' })
  })

  it('保留已有的 reasoning_content，并限制最大输出', () => {
    const rewritten = JSON.parse(rewriteKimiBody(JSON.stringify({
      model: 'k3',
      max_tokens: 999_999,
      messages: [{ role: 'assistant', content: 'x', reasoning_content: '已有推理' }]
    }))) as Record<string, any>
    expect(rewritten.max_completion_tokens).toBe(262_144)
    expect(rewritten.messages[0].reasoning_content).toBe('已有推理')
  })

  it('解析官方 usages 额度窗口', () => {
    const quota = parseKimiQuota({
      usages: {
        limit_5h: { limit: 100, used: 25, remaining: 75, used_ratio: 0.25, reset_time: 1760000000 },
        limit_7d: { limit: 200, used: 50, remaining: 150, usedRatio: 0.25 },
        limit_month_total: { limit: 1000, used: 200, remaining: 800 },
        limit_month_code: { limit: 500, used: 100, remaining: 400, reset_time: '2026-11-01T00:00:00Z' }
      }
    }, 123)
    expect(quota.fetchedAt).toBe(123)
    expect(quota.windows.map((entry) => entry.id)).toEqual(['5h', '7d', 'month-total', 'month-code'])
    expect(quota.windows[0]).toMatchObject({ label: '5 小时', usedPercent: 25, resetAt: 1760000000000 })
    expect(quota.windows[1]).toMatchObject({ usedPercent: 25 })
    expect(quota.windows[2]).toMatchObject({ usedPercent: 20 })
    expect(quota.windows[3].resetAt).toBe(Date.parse('2026-11-01T00:00:00Z'))
  })

  it('兼容顶层 usage 与 limits[] 的额度形状', () => {
    const top = parseKimiQuota({ usage: { limit: 100, remaining: 80 } })
    expect(top.windows[0]).toMatchObject({ id: '7d', usedPercent: 20 })

    const limits = parseKimiQuota({
      limits: [
        { detail: { limit: 100, used: 10 }, window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' } },
        { detail: { limit: 200, used: 50 }, window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' } }
      ]
    })
    expect(limits.windows.map((window) => window.id)).toEqual(['5h', 'limit-2'])
    expect(limits.windows[0].usedPercent).toBe(10)
  })

  it('无法识别的额度载荷给出明确说明', () => {
    const quota = parseKimiQuota({ usages: {} })
    expect(quota.windows).toEqual([])
    expect(quota.message).toContain('没有返回')
  })
})

describe('MiniMax Code 协议', () => {
  it('M3 保留思考，M2.7 删除思考并补足 max_tokens', () => {
    const m3 = JSON.parse(rewriteMinimaxBody(JSON.stringify({
      model: 'MiniMax-M3',
      thinking: { type: 'enabled' },
      stream: false
    }))) as Record<string, unknown>
    expect(m3.stream).toBe(true)
    expect(m3.thinking).toEqual({ type: 'adaptive' })
    expect(m3.output_config).toEqual({ effort: 'high' })

    const m31 = JSON.parse(rewriteMinimaxBody(JSON.stringify({
      model: 'MiniMax-M3.1-Flash',
      thinking: { type: 'enabled', budget_tokens: 16384 },
      temperature: 0.4
    }))) as Record<string, unknown>
    expect(m31.thinking).toBeUndefined()
    expect(m31.output_config).toEqual({ effort: 'xhigh' })
    expect(m31.temperature).toBeUndefined()

    const m27 = JSON.parse(rewriteMinimaxBody(JSON.stringify({
      model: 'MiniMax-M2.7',
      thinking: { type: 'enabled' }
    }))) as Record<string, unknown>
    expect(m27.thinking).toBeUndefined()
    expect(m27.output_config).toBeUndefined()
    expect(m27.max_tokens).toBe(32_768)
  })

  it('按模型解析 5 小时与每周剩余比例', () => {
    const quota = parseMinimaxQuota({
      model_remains: [
        {
          model_name: 'MiniMax-M3',
          current_interval_total_count: 100,
          current_interval_usage_count: 20,
          current_interval_remaining_percent: 80,
          current_weekly_total_count: 500,
          current_weekly_remaining_percent: 50,
          end_time: 1760000000000
        },
        {
          model_name: 'unused',
          current_interval_total_count: 0,
          current_weekly_total_count: 0,
          current_interval_status: 3,
          current_weekly_status: 3
        }
      ]
    }, 9)
    expect(quota.fetchedAt).toBe(9)
    expect(quota.windows).toHaveLength(2)
    expect(quota.windows[0]).toMatchObject({ id: 'MiniMax-M3-5 小时', usedPercent: 20 })
    expect(quota.windows[1]).toMatchObject({ usedPercent: 50 })
    expect(quota.windows[0].resetAt).toBe(1760000000000)
  })

  it('兼容本机 records 形 auth.json', () => {
    const parsed = parseMinimaxLocalAuth({
      records: {
        'mcode-public/cn/x': {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAtMs: 12345
        }
      }
    })
    expect(parsed).toMatchObject({ accessToken: 'a', refreshToken: 'r', expiresAt: 12345 })
    expect(parseMinimaxLocalAuth({ records: {} })).toBeNull()
  })
})

describe('OpenCode 协议', () => {
  it('优先选择 OpenCode Zen 的 api 密钥，跳过 OAuth 记录', () => {
    const parsed = parseOpencodeAuth({
      'github-copilot': { type: 'oauth', refresh: 'r', access: 'a' },
      openai: { type: 'api', key: 'sk-other' },
      opencode: { type: 'api', key: 'oc_sk_zen' }
    })
    expect(parsed).toMatchObject({ key: 'oc_sk_zen', provider: 'opencode', type: 'api' })
    expect(parseOpencodeAuth({ 'github-copilot': { type: 'oauth', refresh: 'r' } })).toBeNull()
  })

  it('解析 Zen 在线模型目录', () => {
    const models = parseOpencodeModels({
      data: [
        { id: 'oc-model', name: 'OC Model', context_length: 100_000, max_output_tokens: 8_000 },
        { id: 'oc-model' }
      ]
    })
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: 'oc-model', label: 'OC Model', contextWindow: 100_000, maxOutput: 8_000 })
  })

  it('补齐流式与 max_tokens', () => {
    const body = JSON.parse(rewriteOpencodeBody(JSON.stringify({
      model: 'big-pickle',
      stream: false,
      messages: []
    }))) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.max_tokens).toBe(32_768)
  })
})

describe('Step Plan 协议', () => {
  it('把 max_completion_tokens 改回 max_tokens 并开启流式用量', () => {
    const body = JSON.parse(rewriteStepBody(JSON.stringify({
      model: 'step-3',
      max_completion_tokens: 2048,
      reasoning_effort: 'high'
    }), { 'step-3': ['low', 'medium'] })) as Record<string, unknown>
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.max_tokens).toBe(2048)
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.reasoning_effort).toBe('medium')
  })

  it('模型不支持思考时不发送 reasoning_effort', () => {
    const body = JSON.parse(rewriteStepBody(JSON.stringify({
      model: 'plain',
      max_tokens: 100,
      reasoning_effort: 'high'
    }), {})) as Record<string, unknown>
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('解析 /v1/models 的上下文与思考档位', () => {
    const parsed = parseStepModels({
      data: [
        {
          id: 'step-3',
          name: 'Step 3',
          model_type: '大语言模型',
          max_input_tokens: 262144,
          enable_reason: true,
          reasoning_effort_support_list: ['off', 'low', 'high']
        },
        { id: 'embed-model', model_type: '向量模型', max_input_tokens: 8000 },
        { id: 'step-vision', model_type: '大语言模型', max_input_tokens: 128000, enable_reason: false, enable_vision_input: true }
      ]
    }, 'step_plan')
    expect(parsed.models).toHaveLength(2)
    expect(parsed.models.some((model) => model.id === 'embed-model')).toBe(false)
    expect(parsed.models[0]).toMatchObject({
      id: 'step-3',
      contextWindow: 262_144,
      supportsReasoning: true,
      reasoningEfforts: ['off', 'low', 'high']
    })
    expect(parsed.efforts['step-3']).toEqual(['off', 'low', 'high'])
    expect(parsed.models[1].supportsReasoning).toBeUndefined()
    expect(parsed.models[0].note).toContain('Step Plan')
  })

  it('开放平台 profile 的 base 不带重复的 /v1', () => {
    expect(STEP_PROFILES.platform_cn.api).toBe('https://api.stepfun.com')
    expect(STEP_PROFILES.platform_oversea.api).toBe('https://api.stepfun.ai')
  })

  it('兼容本机 StepCode 的扁平与 step 嵌套凭据', () => {
    expect(parseStepLocalAuth({ apiKey: 'sk-1', profile: 'step_plan', uid: 'u1' }))
      .toMatchObject({ apiKey: 'sk-1', profile: 'step_plan', uid: 'u1' })
    expect(parseStepLocalAuth({ step: { type: 'oauth', access: 'sk-2', profile: 'step_plan_oversea' } }))
      .toMatchObject({ apiKey: 'sk-2', profile: 'step_plan_oversea' })
    expect(parseStepLocalAuth({})).toBeNull()
  })
})
