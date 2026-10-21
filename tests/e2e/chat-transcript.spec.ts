/**
 * 对话转录渲染回归：
 * - GFM 结构（标题/列表/表格）与 Shiki 高亮；
 * - 流式代码块保持纯文本，结束后再高亮（避免每个分片重复高亮+闪烁）；
 * - 超长链接换行，不撑破转录区；
 * - 远程图片不渲染破图，改为带域名的安全入口；
 * - 回看历史时发送新消息自动跟到最新。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  clearEvents,
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  sendMessageViaStore,
  setThemeViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

const TINY_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

async function prepare(page: Page, mockBaseUrl: string, title: string): Promise<void> {
  await waitForStoreReady(page)
  await dismissOnboarding(page)
  const provider = await configureMockProvider(page, mockBaseUrl)
  const workspace = join(root, 'tmp', `e2e-transcript-ws-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  await createSession(page, { workspace, ...provider, permissionMode: 'auto', title })
  await installEventCollector(page)
}

test.describe('聊天转录渲染', () => {
  test('Markdown/代码高亮/长链接/远程图片在真实界面正确降级', async () => {
    test.setTimeout(180_000)
    const longUrl = `https://example.com/${'a'.repeat(220)}`
    const codeLines = Array.from({ length: 10 }, (_, index) => `const value${index + 1} = ${index + 1} // 渲染测试`).join('\n')
    const markdown = [
      '## 渲染检查',
      '',
      '下面是流式代码块，结束后才高亮：',
      '',
      '```ts',
      codeLines,
      '```',
      '',
      '- 列表项甲',
      '- 列表项乙',
      '',
      '| 列 | 值 |',
      '| --- | --- |',
      '| 甲 | 1 |',
      '',
      `裸链接：[${longUrl}](${longUrl})`,
      '',
      '[相对链接](note.txt)',
      '',
      '![远程图](https://example.com/pic.png)',
      '',
      `![内联图](${TINY_GIF})`
    ].join('\n')
    const mock = await startMockLLM({
      scripts: [{ reasoning: '先整理渲染要点，再给示例。', text: markdown, textChunkSize: 8, chunkDelayMs: 80 }]
    })
    const morrow = await launchMorrow({ name: 'chat-transcript', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await prepare(page, mock.openaiBaseUrl, '转录渲染测试')
      await sendMessageViaStore(page, '请展示 Markdown 渲染能力')

      // 代码块出现后仍在流式：应保持纯文本，不能出现 Shiki 高亮
      await expect(page.locator('.code-block').last()).toBeVisible({ timeout: 30_000 })
      for (let sample = 0; sample < 5; sample += 1) {
        await page.waitForTimeout(160)
        expect(await page.locator('.code-block .code-highlight').count()).toBe(0)
      }
      expect(await page.locator('.message-assistant.is-streaming').count()).toBeGreaterThan(0)

      await waitForRunFinished(page, 120_000)
      const assistant = page.locator('.message-assistant').last()
      await expect(assistant.locator('.md-h2')).toContainText('渲染检查')
      await expect(assistant.locator('.md-li')).toHaveCount(2)
      await expect(assistant.locator('.md-table')).toBeVisible()
      // 思考结束后仍保留耗时文案，而不是退回「思考过程」
      await expect(assistant.locator('.thinking-label')).toContainText('思考了')

      // 远程图片不渲染 <img>，data 图片正常显示
      await expect(assistant.locator('.md-image-unavailable').filter({ hasText: 'example.com' })).toBeVisible()
      await expect(assistant.locator('img.md-image')).toHaveCount(1)

      // 相对链接点击不能在应用窗口内导航（否则 file:// 会把整个应用替换掉）
      const beforeUrl = page.url()
      await assistant.getByText('相对链接', { exact: true }).click()
      await page.waitForTimeout(300)
      expect(page.url()).toBe(beforeUrl)
      await expect(assistant.locator('.md-h2')).toBeVisible()

      // 长链接必须换行，不能把转录区撑出横向滚动
      const overflow = await page.evaluate(() => {
        const scroll = document.querySelector('.transcript-scroll') as HTMLElement | null
        return scroll ? scroll.scrollWidth - scroll.clientWidth : -1
      })
      expect(overflow).toBeGreaterThanOrEqual(0)
      expect(overflow).toBeLessThanOrEqual(2)

      // 流式结束 + 滚入视口后，代码应一次性高亮
      await assistant.locator('.code-block').scrollIntoViewIfNeeded()
      await expect(assistant.locator('.code-block .code-highlight')).toBeVisible({ timeout: 20_000 })

      await assistant.locator('.md-h2').scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await page.screenshot({ path: screenshotPath('chat-transcript-dark.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(600)
      await page.screenshot({ path: screenshotPath('chat-transcript-light.png') })
      await assistant.locator('.md-image-unavailable').last().scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      await page.screenshot({ path: screenshotPath('chat-transcript-media-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(600)
      await page.screenshot({ path: screenshotPath('chat-transcript-media-dark.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('短消息气泡按内容收缩，不会几个字就换行', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      scripts: [{ text: '好的。' }, { text: '收到。' }, { text: '明白。' }]
    })
    const morrow = await launchMorrow({ name: 'chat-bubble-wrap', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await prepare(page, mock.openaiBaseUrl, '气泡换行测试')

      for (const text of ['继续。', '把这件事拆成两步计划。', '帮我读一下工作区里的资料，然后整理成一段清楚的结论。']) {
        await clearEvents(page)
        await page.locator('.composer-input').fill(text)
        await page.locator('.composer-input').press('Enter')
        await waitForRunFinished(page, 90_000)
      }

      const bubbles = await page.evaluate(() => {
        return [...document.querySelectorAll('.message-user-bubble')].map((bubble) => {
          const text = bubble.querySelector('.message-user-text')
          if (!text) return { content: '', lines: 0, width: 0 }
          const range = document.createRange()
          range.selectNodeContents(text)
          const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)))
          return {
            content: text.textContent ?? '',
            lines: tops.size,
            width: Math.round(bubble.getBoundingClientRect().width)
          }
        })
      })
      expect(bubbles.map((bubble) => bubble.content)).toEqual([
        '继续。',
        '把这件事拆成两步计划。',
        '帮我读一下工作区里的资料，然后整理成一段清楚的结论。'
      ])
      expect(bubbles.every((bubble) => bubble.lines === 1)).toBe(true)
      expect(bubbles[0].width).toBeLessThan(bubbles[1].width)
      expect(bubbles[1].width).toBeLessThan(bubbles[2].width)

      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(500)
      await page.screenshot({ path: screenshotPath('chat-bubble-wrap-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(500)
      await page.screenshot({ path: screenshotPath('chat-bubble-wrap-dark.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('回看历史时发送新消息会自动跟到最新', async () => {
    test.setTimeout(180_000)
    const longText = Array.from(
      { length: 30 },
      (_, index) => `### 段落 ${index + 1}\n\n这是用于撑高转录区域的第 ${index + 1} 段内容，用来模拟回看历史消息的场景。`
    ).join('\n\n')
    const mock = await startMockLLM({
      scripts: [{ text: longText, textChunkSize: 40 }, { text: '收到，这是最新回复。' }]
    })
    const morrow = await launchMorrow({ name: 'chat-scroll', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await prepare(page, mock.openaiBaseUrl, '转录滚动测试')
      await sendMessageViaStore(page, '先给我一段长内容')
      await waitForRunFinished(page, 90_000)

      // 滚回顶部 -> 出现「回到最新」
      await page.evaluate(() => {
        const scroll = document.querySelector('.transcript-scroll') as HTMLElement | null
        if (scroll) scroll.scrollTop = 0
      })
      await expect(page.locator('.transcript-jump')).toBeVisible({ timeout: 10_000 })
      await page.screenshot({ path: screenshotPath('chat-transcript-jump-dark.png') })

      await clearEvents(page)
      await sendMessageViaStore(page, '继续')
      await waitForRunFinished(page, 90_000)

      // 发送后应自动贴底：跳转按钮消失、最后一条用户消息在视口内
      await expect(page.locator('.transcript-jump')).toHaveCount(0, { timeout: 10_000 })
      const bottom = await page.evaluate(() => {
        const scroll = document.querySelector('.transcript-scroll') as HTMLElement | null
        if (!scroll) return { found: false, remaining: Number.POSITIVE_INFINITY }
        return { found: true, remaining: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight }
      })
      expect(bottom.found).toBe(true)
      expect(bottom.remaining).toBeLessThan(96)
      expect(bottom.remaining).toBeGreaterThan(-3)
      await expect(page.locator('.message-user').last()).toBeInViewport()
      await expect(page.getByText('收到，这是最新回复。')).toBeVisible()
      // 只允许转录区自己滚动，避免出现嵌套滚动条
      const outerRemaining = await page.evaluate(() => {
        const outer = document.querySelector('.app-scroll') as HTMLElement | null
        return outer ? outer.scrollHeight - outer.clientHeight : -1
      })
      expect(outerRemaining).toBeLessThanOrEqual(1)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})
