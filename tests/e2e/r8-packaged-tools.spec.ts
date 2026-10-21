/** 打包版 asar 冒烟：确认 pdf-parse/jszip 在资源包内可用，read_pdf/read_docx 真实执行。 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root } from './launch'
import { getPackagedAppExe } from './packaged-runtime'
import { configureMockProvider, dismissOnboarding, installEventCollector, readStore, waitForRunFinished, waitForStoreReady } from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'

test('打包版文档工具（asar 内 pdf-parse / jszip）', async () => {
  test.setTimeout(180_000)
  const appExe = await getPackagedAppExe()
  if (!appExe) {
    test.skip(true, '需要先构建单文件便携包（npm run dist）再跑打包冒烟')
    return
  }
  const mock = await startMockLLM({
    scripts: [
      {
        text: '',
        toolCalls: [
          { name: 'read_pdf', arguments: { path: 'in/invoice.pdf' } },
          { name: 'read_docx', arguments: { path: 'in/template.docx' } }
        ]
      },
      { text: '两个文档都已读取。' }
    ]
  })
  const workspace = join(root, 'tmp', `r8-pkg-tools-${Date.now()}`)
  mkdirSync(join(workspace, 'in'), { recursive: true })
  copyFileSync(join(root, 'tests', 'unit', 'core', 'fixtures', 'documents', 'invoice.pdf'), join(workspace, 'in', 'invoice.pdf'))
  copyFileSync(join(root, 'tests', 'unit', 'core', 'fixtures', 'documents', 'template.docx'), join(workspace, 'in', 'template.docx'))
  const morrow = await launchMorrow({ name: 'r8-pkg-tools', executablePath: appExe, waitForSelector: '.sidebar', extraArgs: ['--data-dir=' + join(workspace, 'data')] })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await installEventCollector(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (arg: { ws: string; providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const created = await window.morrow.session.create({
        workspace: arg.ws,
        model: { providerId: arg.providerId, modelId: arg.modelId },
        permissionMode: 'auto',
        title: '打包文档冒烟'
      })
      if (!created.ok) throw new Error('session.create 失败')
      await store.getState().selectSession(created.data.id)
      await store.getState().sendMessage('请分别用 read_pdf 与 read_docx 读取 in/invoice.pdf 和 in/template.docx，然后总结。')
    }, { ws: workspace, providerId: provider.providerId, modelId: provider.modelId })
    await waitForRunFinished(page, 90_000)
    const events = await page.evaluate(() => (window as unknown as { __morrowEvents?: Array<any> }).__morrowEvents ?? [])
    const state = await readStore(page)
    expect(state.run).toBeNull()
    const toolEvents = events.filter((e) => e.type === 'tool_finished')
    console.log('TOOLS', JSON.stringify(toolEvents.map((e) => ({ name: e.result?.name, ok: e.result?.ok }))))
    // 如果没有安装事件收集器，fallback 从会话工具块读
    const session = await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { session: Record<string, any> } }
    }).__morrowStore.getState().session)
    const blocks = (session.messages as Array<{ content: Array<Record<string, any>> }>)
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_use')
    const pdf = blocks.find((b) => b.name === 'read_pdf')
    const docx = blocks.find((b) => b.name === 'read_docx')
    console.log('STATUS', pdf?.status, docx?.status, JSON.stringify(pdf?.result ?? '').slice(0, 300))
    expect(pdf?.status).toBe('success')
    expect(docx?.status).toBe('success')
    const pdfText = JSON.stringify(pdf?.result ?? '')
    const docxText = JSON.stringify(docx?.result ?? '')
    expect(pdfText).toContain('INV-0042')
    expect(docxText).toContain('Pilot Letter')
    console.log('PDF_OK', pdfText.slice(0, 160))
    console.log('DOCX_OK', docxText.slice(0, 160))
  } finally {
    await morrow.close()
    await mock.close()
  }
})
