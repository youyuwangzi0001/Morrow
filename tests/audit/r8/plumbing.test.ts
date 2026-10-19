/**
 * R8 阶段 B 管路自检（本地 mock OpenAI SSE 服务；零真实 DeepSeek 请求）。
 *
 * 目的：在不花真实预算的前提下验证 live-runner 的端到端接线：
 * AgentService.send → 真实产品工具执行 → 事件/会话落盘 → checker 判分 → 结果 JSON 写入。
 *
 * 运行：MORROW_R8_PLUMBING=1 npx vitest run --config tests/audit/vitest.config.ts tests/audit/r8/plumbing.test.ts
 * 注意：这不是 39 题成绩；仅验证 runner 管道，走本机 127.0.0.1 mock，不访问 api.deepseek.com。
 */
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from './specs'

const ENABLED = process.env.MORROW_R8_PLUMBING === '1'

interface MockReply {
  text?: string
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>
}

function startMockModel(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let body: { messages?: Array<{ role?: string }> } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        body = {}
      }
      const messages = body.messages ?? []
      const last = messages[messages.length - 1]
      let reply: MockReply
      if (last?.role === 'tool') {
        reply = { text: '已完成并写出结果。' }
      } else {
        reply = {
          toolCalls: [
            {
              name: 'write_file',
              input: {
                path: 'out/result.json',
                content: JSON.stringify({ start: '2026-04-10T09:30:00+08:00', end: '2026-04-10T10:00:00+08:00', timezone: 'Asia/Shanghai' })
              }
            }
          ]
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      send({ id: 'plumbing', object: 'chat.completion.chunk', created: Date.now(), model: 'plumbing-mock', choices: [{ index: 0, delta: {}, finish_reason: null }] })
      if (reply.toolCalls?.length) {
        reply.toolCalls.forEach((call, index) => {
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index, id: `call_plumbing_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }
                  ]
                },
                finish_reason: null
              }
            ]
          })
        })
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        send({ choices: [{ index: 0, delta: { content: reply.text ?? '完成。' }, finish_reason: 'stop' }] })
      }
      send({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}

describe.skipIf(!ENABLED)('R8 live-runner 管路自检（本地 mock，零真实请求）', () => {
  it('单题 M16：AgentService → 产品工具 → checker → 结果 JSON 全链路', async () => {
    const mock = await startMockModel()
    const dir = join(PROJECT_ROOT, 'tmp', 'audit', 'r8', 'plumbing')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const resultsPath = join(dir, 'results.json')
    process.env.MORROW_R8_PLUMBING = '1'
    process.env.MORROW_R8_LIVE = '1'
    process.env.MORROW_R8_LIVE_CONFIRM = 'ONE_PASS_39'
    process.env.MORROW_R8_LIVE_IDS = 'M16'
    process.env.MORROW_R8_MAX_REQUESTS = '4'
    process.env.MORROW_R8_RESULTS = resultsPath
    process.env.MORROW_R8_BASE_URL = mock.baseUrl
    process.env.DEEPSEEK_API_KEY = 'sk-plumbing-local-mock'
    try {
      const { runLiveFullSuite } = await import('./live-runner')
      const outcome = await runLiveFullSuite()
      expect(outcome.results).toHaveLength(1)
      const record = outcome.results[0]
      expect(record.id).toBe('M16')
      expect(record.status, record.detail).toBe('PASS')
      expect(record.requests).toBeGreaterThanOrEqual(2)
      const written = JSON.parse(readFileSync(resultsPath, 'utf8')) as { results: Array<{ id: string; status: string }>; budget: { used: number } }
      expect(written.results[0].id).toBe('M16')
      expect(written.results[0].status).toBe('PASS')
      expect(written.budget.used).toBe(record.requests)
    } finally {
      await mock.close()
    }
  }, 300_000)
})
