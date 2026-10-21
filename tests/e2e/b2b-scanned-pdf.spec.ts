/**
 * B2b：扫描版 PDF 由本机 Windows OCR 真实识别，文字进入模型上下文，不再要求用户截图。
 * 夹具 scanned-zh.pdf 是只有一张图片、没有任何文字层的 PDF。
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screensDir, type MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  sendMessageViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

test.describe('扫描版 PDF 图像识别', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('无文字层的 PDF 自动走本机 OCR，并把识别文字交给模型', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      scripts: [
        {
          text: '',
          toolCalls: [{ name: 'read_pdf', arguments: { path: 'scan.pdf' } }]
        },
        { text: '扫描件已读取。' }
      ]
    })
    const workspace = join(root, 'tmp', `e2e-b2b-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    copyFileSync(
      join(root, 'tests', 'unit', 'core', 'fixtures', 'documents', 'scanned-zh.pdf'),
      join(workspace, 'scan.pdf')
    )

    // 最终验收时可用 MORROW_PACKAGED_APP 指向打包产物，验证 asar 外的 OCR 脚本能被找到
    const packagedApp = process.env.MORROW_PACKAGED_APP
    morrow = await launchMorrow({
      name: 'b2b-scanned-pdf',
      timeoutMs: 90_000,
      ...(packagedApp ? { executablePath: packagedApp } : {})
    })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '扫描件识别测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '读取 scan.pdf，告诉我合计。')
    await waitForRunFinished(page, 90_000)
    await expect(page.getByText('扫描件已读取。')).toBeVisible({ timeout: 20_000 })

    // 第二次模型请求里必须带上 OCR 识别结果，而不是「请发截图」的错误提示
    const bodies = mock.requests.map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
    const withToolResult = bodies.find((body: string) => body.includes('本机 OCR 已识别'))
    expect(withToolResult).toBeTruthy()
    expect(withToolResult).toContain('扫描发票')
    expect(withToolResult).toContain('9821.50')
    expect(withToolResult).toContain('关键数字请对照原页复核')
    expect(bodies.some((body: string) => body.includes('请把需要阅读的页面截图'))).toBe(false)

    await page.locator('.spine-item').filter({ hasText: '读取 PDF scan.pdf' }).click()
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'b2b-scanned-pdf.png') })
  })
})
