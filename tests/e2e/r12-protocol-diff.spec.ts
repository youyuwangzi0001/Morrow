/**
 * R12 模型兼容 + diff 摘要：
 * - 模型把工具调用写成正文（DSML/Kimi 等文本协议）时，Morrow 应解析执行、界面无协议乱码；
 * - 文件改动后在消息末尾显示 +X / −Y 的 diff 摘要，双主题可读。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  sendMessageViaStore,
  setThemeViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

const DSML_CALL = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="edit_file">
<｜｜DSML｜｜ parameter name="path" string="true">dsml-note.txt</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="old_string" string="true">old line</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="new_string" string="true">new line</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

test('文本工具协议被解析执行，消息后显示 diff 增删行摘要（双主题）', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r12-protocol-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const target = join(workspace, 'dsml-note.txt')
  writeFileSync(target, 'old line\n', 'utf8')

  const mock = await startMockLLM({
    scripts: [{ text: DSML_CALL }, { text: '改好了，已经替换成新的一行。' }]
  })
  const morrow = await launchMorrow({ name: 'r12-protocol', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '协议与 diff 测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '把 dsml-note.txt 里的 old line 改成 new line。')
    await waitForRunFinished(page, 60_000)

    // 文本协议被识别成真实工具调用，文件真实修改
    expect(readFileSync(target, 'utf8')).toBe('new line\n')

    // 正文不出现 DSML / parameter 等协议标记
    const transcript = page.locator('.message-assistant').last()
    await expect(transcript).toContainText('改好了')
    await expect(transcript).not.toContainText('DSML')
    await expect(transcript).not.toContainText('parameter')

    // 消息末尾的 diff 摘要：1 个文件，+1 / −1
    const summary = page.locator('.message-diff-summary')
    await expect(summary).toBeVisible()
    await expect(summary).toContainText('本次改动 1 个文件')
    await expect(summary).toContainText('+1')
    await expect(summary).toContainText('−1')
    await expect(summary).toContainText('dsml-note.txt')
    await page.waitForTimeout(400)
    await transcript.scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshotPath('r12-protocol-diff-dark.png') })

    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(summary).toBeVisible()
    await page.screenshot({ path: screenshotPath('r12-protocol-diff-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
