import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const state: {
  requests: Array<Record<string, unknown>>
  queue: Array<{ content: string; finish: string }>
} = { requests: [], queue: [] }

const settings = {
  defaultModel: { providerId: 'mock-budget', modelId: 'mock-budget-model' },
  providers: [{
    id: 'mock-budget',
    kind: 'openai-compat',
    name: '预算测试模型',
    baseUrl: '',
    models: [{
      id: 'mock-budget-model',
      label: '预算测试模型',
      contextWindow: 64_000,
      maxOutput: 20_000,
      supportsTools: true
    }],
    apiKeyStored: true,
    enabled: true
  }]
}

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP ?? 'C:/Windows/Temp', getVersion: () => '0.2.0', isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => Buffer.from(v).toString() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

vi.mock('../../src/main/settings', () => ({
  getSettingsStore: () => ({
    get: () => settings,
    getApiKey: () => 'test-key'
  })
}))

import { completeCreativeText } from '../../src/main/studio'

let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      try {
        state.requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        state.requests.push({})
      }
      const next = state.queue.shift() ?? { content: 'ok', finish: 'stop' }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: next.content }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: next.finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}/v1`
  settings.providers[0].baseUrl = baseUrl
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  state.requests = []
  state.queue = []
})

describe('创作台输出预算', () => {
  it('默认按模型官方 maxOutput 请求，不再私设 8000 上限', async () => {
    const result = await completeCreativeText({ system: '系统', prompt: '写一段' })
    expect(result.text).toContain('ok')
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0].max_tokens).toBe(20_000)
  })

  it('显式预算只在下调时生效，不会超过官方上限', async () => {
    await completeCreativeText({ system: '系统', prompt: '写一段', maxTokens: 1200 })
    expect(state.requests[0].max_tokens).toBe(1200)
    state.requests = []
    await completeCreativeText({ system: '系统', prompt: '写一段', maxTokens: 999_999 })
    expect(state.requests[0].max_tokens).toBe(20_000)
  })

  it('结构化任务触达长度上限时明确报错，不返回半截 JSON', async () => {
    state.queue = [{ content: '{"units":[{"index":1,', finish: 'length' }]
    await expect(completeCreativeText({ system: '系统', prompt: '输出 JSON', structured: true })).rejects.toThrow(/官方上限/)
  })

  it('普通文本被截断时自动续写而不是静默截断', async () => {
    state.queue = [
      { content: '前半段。', finish: 'length' },
      { content: '后半段。', finish: 'stop' }
    ]
    const result = await completeCreativeText({ system: '系统', prompt: '写一段', continueOnTruncate: true })
    expect(result.text).toContain('前半段')
    expect(result.text).toContain('后半段')
    expect(state.requests).toHaveLength(2)
    expect(result.truncated).toBeFalsy()
  })
})
