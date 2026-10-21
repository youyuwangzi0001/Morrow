/**
 * 模型列表同步：
 * - 本地回环服务允许无 Key；
 * - 裸域名 / /v1 / 完整 /chat/completions 都能正确归一到 /models；
 * - 远程服务仍要求 Key，且按协议携带认证头。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderConfig } from '../../../src/shared/types'
import { syncProviderModels } from '../../../src/main/services/model-sync'

let server: Server | null = null
const seen: Array<{ url: string; authorization?: string; apiKey?: string }> = []

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'local-test',
    kind: 'openai-compat',
    name: 'Local Test',
    baseUrl: 'http://127.0.0.1:1/v1',
    models: [],
    apiKeyStored: false,
    enabled: true,
    category: 'local',
    ...overrides
  }
}

async function startModelsServer(): Promise<string> {
  seen.length = 0
  server = createServer((request, response) => {
    seen.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
      apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined
    })
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'local-model-e2e', context_length: 8192, max_output_tokens: 2048 }] }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return `http://127.0.0.1:${port}`
}

async function startJsonServer(body: string, contentType = 'application/json'): Promise<string> {
  seen.length = 0
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': contentType })
    response.end(body)
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  if (!server) return
  const current = server
  server = null
  current.closeAllConnections?.()
  await new Promise<void>((resolve) => current.close(() => resolve()))
})

describe('syncProviderModels', () => {
  it('本地服务无 Key 也能同步', async () => {
    const base = await startModelsServer()
    const outcome = await syncProviderModels(config({ baseUrl: `${base}/v1` }), null)
    expect(outcome.total).toBe(1)
    expect(outcome.models[0]).toMatchObject({
      id: 'local-model-e2e',
      contextWindow: 8192,
      maxOutput: 2048,
      reasoningStyle: 'effort'
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('/v1/models')
    expect(seen[0].authorization).toBeUndefined()
  })

  it('粘贴完整推理地址时仍请求 /v1/models', async () => {
    const base = await startModelsServer()
    const outcome = await syncProviderModels(config({ baseUrl: `${base}/v1/chat/completions` }), null)
    expect(outcome.total).toBe(1)
    expect(seen[0].url).toBe('/v1/models')
  })

  it('Anthropic 本地服务无 Key 也能同步到 /v1/models', async () => {
    const base = await startModelsServer()
    const outcome = await syncProviderModels(config({ kind: 'anthropic', baseUrl: `${base}/v1` }), null)
    expect(seen[0].url).toBe('/v1/models')
    expect(seen[0].apiKey).toBeUndefined()
    expect(outcome.models[0]?.reasoningStyle).toBe('thinking')
  })

  it('远程服务缺少 Key 时拒绝同步', async () => {
    await expect(syncProviderModels(config({ category: 'custom', baseUrl: 'https://api.example.com/v1' }), null)).rejects.toThrow(
      /API Key/
    )
  })

  it('兼容字符串形式的 context_length / max_output_tokens', async () => {
    const base = await startJsonServer(
      JSON.stringify({ data: [{ id: 'string-meta', context_length: '64000', max_output_tokens: '4096' }] })
    )
    const outcome = await syncProviderModels(config({ baseUrl: `${base}/v1` }), null)
    expect(outcome.models[0]).toMatchObject({ id: 'string-meta', contextWindow: 64_000, maxOutput: 4_096 })
  })

  it('模型过多时截断到上限，无效/重复条目计数并如实提示', async () => {
    const data: unknown[] = [null, ...Array.from({ length: 201 }, (_, index) => ({ id: `model-${index}` }))]
    const base = await startJsonServer(JSON.stringify({ data }))
    const outcome = await syncProviderModels(config({ baseUrl: `${base}/v1` }), null)
    expect(outcome.total).toBe(200)
    expect(outcome.truncated).toBe(true)
    expect(outcome.skipped).toBe(1)
    expect(outcome.message).toContain('200')
    expect(outcome.message).toContain('跳过 1 个')
    expect(outcome.models.some((model) => model.id === 'model-201')).toBe(false)
  })

  it('200 返回网页而不是 JSON 时给出可读错误', async () => {
    const base = await startJsonServer('<html><body>login</body></html>', 'text/html')
    await expect(syncProviderModels(config({ baseUrl: `${base}/v1` }), null)).rejects.toThrow(/不是 JSON/)
  })
})
