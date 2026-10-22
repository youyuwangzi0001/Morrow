/**
 * 本地预览服务启动竞态：terminal(start) 后端口稍后才监听时，
 * browser_open 应短暂重试，而不是立即报 ERR_CONNECTION_REFUSED。
 */
import { createServer, type Server } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  getEvents,
  installEventCollector,
  sendMessageViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

function listenLater(server: Server, port: number, delayMs: number): void {
  setTimeout(() => {
    try {
      server.listen(port, '127.0.0.1')
    } catch {
      // 测试结束时可能已关闭
    }
  }, delayMs)
}

test('本地预览端口稍后监听时 browser_open 会自动重试成功', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-browser-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>preview-ok</title></head><body>ok</body></html>')
  })
  const port = await new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const chosen = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(chosen))
    })
  })
  // 模拟 terminal(start) 已返回，但 Python http.server 还没真正 listen。
  listenLater(server, port, 700)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '打开本地预览。',
        toolCalls: [{ name: 'browser_open', arguments: { url: `http://127.0.0.1:${port}/` } }]
      },
      { text: '打开了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-browser-retry', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '本地预览重试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '打开本地预览页面。')
    await waitForRunFinished(page, 90_000)
    const event = (await getEvents(page))
      .filter((entry) => entry.type === 'tool_finished')
      .at(-1) as { result?: { ok?: boolean; output?: string } } | undefined
    expect(event?.result?.ok, event?.result?.output).toBe(true)
    expect(String(event?.result?.output ?? '')).toContain('已在 Morrow 浏览器打开')
  } finally {
    await morrow.close()
    await mock.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
