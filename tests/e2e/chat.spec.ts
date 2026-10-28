// chat 领域 E2E：由 3 个原 spec 合并；每个原文件保留独立 describe 作用域。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import type { MorrowApp } from './launch'
import { launchMorrow, root, screenshotPath, screensDir } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { clearEvents, clickPermissionCard, configureMockProvider, createSession, dismissOnboarding, getEvents, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForPermission, waitForRunFinished, waitForRunStarted, waitForStoreReady, waitUntil, createUiSession } from './store'
import { DEFAULT_MODEL, defaultSettings } from '../../src/shared/contracts'



test.describe("02-chat", () => {
// ── 原文件：chat-transcript.spec.ts ──────────────────────────────────────────────
test.describe('chat-transcript.spec.ts', () => {
/**
 * 对话转录渲染回归：
 * - GFM 结构（标题/列表/表格）与 Shiki 高亮；
 * - 流式代码块保持纯文本，结束后再高亮（避免每个分片重复高亮+闪烁）；
 * - 超长链接换行，不撑破转录区；
 * - 远程图片不渲染破图，改为带域名的安全入口；
 * - 回看历史时发送新消息自动跟到最新。
 */

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
      '[相对链接](note)',
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
      // 品牌徽记与首段正文同一行，不再单独占一行高度
      const lead = assistant.locator('.stream-text.has-lead').first()
      const mark = lead.locator('.message-agent-mark')
      await expect(mark).toBeVisible()
      expect(await assistant.locator('.message-agent-mark').count()).toBe(1)
      const markBox = await mark.boundingBox()
      const textBox = await lead.locator('.md > :first-child').first().boundingBox()
      expect(markBox && textBox).toBeTruthy()
      expect(Math.abs(markBox!.y - textBox!.y)).toBeLessThan(8)
      expect(textBox!.x).toBeGreaterThanOrEqual(markBox!.x + markBox!.width)
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

  test('交付文件路径可点击打开，右键可复制内容/路径', async () => {
    test.setTimeout(180_000)
    const workspace = join(root, 'tmp', `e2e-file-link-${Date.now()}`)
    mkdirSync(join(workspace, 'deliver'), { recursive: true })
    writeFileSync(join(workspace, 'deliver', 'report.md'), '# 报告\n\n内容\n', 'utf8')
    const mock = await startMockLLM({ scripts: [{ text: '已完成，产物在 `deliver/report.md`。' }] })
    const morrow = await launchMorrow({ name: 'chat-file-link', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '路径链接测试' })
      await installEventCollector(page)
      await sendMessageViaStore(page, '交付报告')
      await waitForRunFinished(page, 120_000)

      const assistant = page.locator('.message-assistant').last()
      const link = assistant.locator('.md-file-link').filter({ hasText: 'deliver/report.md' })
      await expect(link).toBeVisible()

      await page.evaluate(() => {
        const target = window as unknown as { __copied: string[] }
        target.__copied = []
        const original = navigator.clipboard.writeText.bind(navigator.clipboard)
        navigator.clipboard.writeText = async (text: string) => {
          target.__copied.push(text)
          return original(text)
        }
      })

      await link.click({ button: 'right' })
      const menu = page.getByRole('menu', { name: '文件操作' })
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: '在资源管理器中打开' })).toBeVisible()
      await menu.getByRole('menuitem', { name: '复制内容' }).click()
      await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.join('\n---\n'))).toContain('# 报告\n\n内容')

      await link.click({ button: 'right' })
      await page.getByRole('menu', { name: '文件操作' }).getByRole('menuitem', { name: '复制路径', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.join('\n---\n')))
        .toContain(join(workspace, 'deliver', 'report.md'))

      await link.click()
      await expect(page.locator('.canvas-root')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.canvas-tab-title').filter({ hasText: 'report.md' })).toHaveCount(1)
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

})
// ── 原文件：chat-attachments.spec.ts ──────────────────────────────────────────────
test.describe('chat-attachments.spec.ts', () => {
/**
 * 对话附件链路回归：图片进入模型多模态输入、对话内可见；
 * 附件正文只进入模型上下文，不出现在用户气泡；附件元数据持久化。
 */

const imagePath = join(root, 'build', 'icon.png')
const imageBase64 = readFileSync(imagePath).toString('base64')
const imageSize = statSync(imagePath).size

/** 生成一张 24 位 BMP，用于验证拖入的非视觉友好格式会被本地转成 PNG。 */
function makeBmp(width: number, height: number): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixels = rowSize * height
  const buffer = Buffer.alloc(54 + pixels)
  buffer.write('BM', 0)
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(pixels, 34)
  buffer.writeInt32LE(2835, 38)
  buffer.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * rowSize + x * 3
      buffer[offset] = Math.round((x / width) * 180)
      buffer[offset + 1] = Math.round((y / height) * 180)
      buffer[offset + 2] = 210
    }
  }
  return buffer
}

test.describe('对话附件链路', () => {
  test('图片可见、附件元数据可见、内部正文不进入气泡', async () => {
    test.setTimeout(180_000)
    const workspace = join(root, 'tmp', `e2e-attachments-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({ scripts: [{ text: '我已收到并查看了附件。' }] })
    const morrow = await launchMorrow({ name: 'chat-attachments', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '附件测试' })
      await installEventCollector(page)

      await page.evaluate(
        async (arg: { imageBase64: string; imagePath: string; imageSize: number }) => {
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          await store.getState().sendMessage('请看附件里的资料', [
            {
              id: 'att_image',
              name: 'quarterly-chart.png',
              path: arg.imagePath,
              size: arg.imageSize,
              kind: 'image',
              mediaType: 'image/png',
              content: `data:image/png;base64,${arg.imageBase64}`
            },
            {
              id: 'att_text',
              name: 'internal-notes.md',
              path: 'C:\\tmp\\internal-notes.md',
              size: 42,
              kind: 'text',
              content: '内部资料正文-不应出现在气泡',
              truncated: true,
              note: '内容过长，仅发送前 120,000 字符'
            }
          ])
        },
        { imageBase64, imagePath, imageSize }
      )
      await waitForRunFinished(page, 90_000)

      const bubble = page.locator('.message-user-bubble').last()
      await expect(bubble).toContainText('请看附件里的资料')
      await expect(bubble).not.toContainText('[附件]')
      await expect(bubble).not.toContainText('内部资料正文')
      await expect(bubble).not.toContainText('图片已作为视觉输入')
      await expect(page.locator('.message-user-image').last()).toBeVisible()
      await expect(page.locator('.message-user-attachment')).toHaveCount(1)
      await expect(page.locator('.message-user-attachment').last()).toContainText('internal-notes.md')
      await expect(page.locator('.message-user-attachment.is-warn')).toHaveCount(1)

      const persisted = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const current = store.getState().session
        const loaded = await window.morrow.session.load(current.id)
        if (!loaded.ok) throw new Error(loaded.error.message)
        const user = [...loaded.data.messages].reverse().find((message) => message.role === 'user')
        return {
          displayText: user?.displayText,
          imageCount: user?.images?.length ?? 0,
          imageName: user?.images?.[0]?.name,
          attachmentNames: (user?.attachments ?? []).map((attachment) => attachment.name)
        }
      })
      expect(persisted.displayText).toBe('请看附件里的资料')
      expect(persisted.imageCount).toBe(1)
      expect(persisted.imageName).toBe('quarterly-chart.png')
      expect(persisted.attachmentNames).toEqual(['quarterly-chart.png', 'internal-notes.md'])

      const first = mock.requests[0] as { body?: { messages?: Array<{ role: string; content: unknown }> } }
      const modelUser = first?.body?.messages?.find((message) => message.role === 'user')
      expect(JSON.stringify(modelUser?.content)).toContain('image_url')
      expect(JSON.stringify(modelUser?.content)).toContain('内部资料正文')
      expect(JSON.stringify(modelUser?.content)).toContain('图片已作为视觉输入')

      const state = await readStore(page)
      expect(state.run).toBeNull()
      await expect(page.getByText('我已收到并查看了附件。')).toBeVisible()
      await page.locator('[aria-label="收起通知"]').last().click().catch(() => undefined)
      await page.evaluate(() => {
        const scroller = document.querySelector('.transcript-scroll') as HTMLElement | null
        if (scroller) scroller.scrollTop = scroller.scrollHeight
      })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(700)
      await page.screenshot({ path: screenshotPath('quality-chat-attachments-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(700)
      await page.screenshot({ path: screenshotPath('quality-chat-attachments-dark.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('拖入 BMP 与 GBK 文本：图片转 PNG、中文不乱码，模型收到可用输入', async () => {
    test.setTimeout(180_000)
    const workspace = join(root, 'tmp', `e2e-attachments-mixed-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({ scripts: [{ text: '已收到图片和中文资料。' }] })
    const morrow = await launchMorrow({ name: 'chat-attachments-mixed', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '新对话' })
      await installEventCollector(page)

      // 1800px 宽、约 4.9MB：验证 BMP 转 PNG 的同时缩到视觉接口友好的最长边
      const bmp = makeBmp(1800, 900).toString('base64')
      // "中文资料 42" 的 GBK 字节；UTF-8 解码会失败，必须回退 GB18030
      const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xca, 0xc1, 0xcf, 0x20, 0x34, 0x32]).toString('base64')
      await page.evaluate(
        ({ bmpBase64, gbkBase64 }) => {
          const bytesOf = (base64: string): Uint8Array => {
            const binary = atob(base64)
            const bytes = new Uint8Array(binary.length)
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
            return bytes
          }
          const transfer = new DataTransfer()
          transfer.items.add(new File([bytesOf(bmpBase64)], 'wide-chart.bmp', { type: 'image/bmp' }))
          transfer.items.add(new File([bytesOf(gbkBase64)], 'legacy-gbk.txt', { type: 'text/plain' }))
          const target = document.querySelector('.composer-shell')
          if (!target) throw new Error('composer shell missing')
          target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
          target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
        },
        { bmpBase64: bmp, gbkBase64: gbk }
      )
      await expect(page.locator('.composer-file')).toHaveCount(2, { timeout: 15_000 })
      await expect(page.locator('.composer-file', { hasText: 'wide-chart.bmp' })).toBeVisible()
      await expect(page.locator('.composer-file', { hasText: 'legacy-gbk.txt' })).toBeVisible()
      await page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
      })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(450)
      await page.screenshot({ path: screenshotPath('quality-chat-attachments-drop-light.png') })

      // 不输入任何文字，直接发送附件：应能发送，并用第一个附件名给新会话命名
      await page.locator('.composer-input').press('Enter')
      await waitForRunFinished(page, 90_000)
      const afterSend = await readStore(page)
      expect(afterSend.session?.title).toBe('wide-chart')

      const persisted = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const current = store.getState().session
        const loaded = await window.morrow.session.load(current.id)
        if (!loaded.ok) throw new Error(loaded.error.message)
        const user = [...loaded.data.messages].reverse().find((message) => message.role === 'user')
        return {
          content: (user?.content ?? []).filter((block: { type: string }) => block.type === 'text').map((block: { text?: string }) => block.text ?? '').join(''),
          images: user?.images ?? [],
          attachmentNames: (user?.attachments ?? []).map((attachment: { name: string }) => attachment.name)
        }
      })
      expect(persisted.content).toContain('中文资料 42')
      expect(persisted.content).not.toContain('\uFFFD')
      expect(persisted.images).toHaveLength(1)
      expect(persisted.images[0].mediaType).toBe('image/png')
      expect(persisted.attachmentNames).toEqual(expect.arrayContaining(['wide-chart.bmp', 'legacy-gbk.txt']))

      const normalizedSize = await page.evaluate(async (dataUrl: string) => {
        const image = new Image()
        image.src = dataUrl
        await image.decode()
        return { width: image.naturalWidth, height: image.naturalHeight }
      }, `data:${persisted.images[0].mediaType};base64,${persisted.images[0].dataBase64}`)
      expect(normalizedSize.width).toBe(1568)
      expect(normalizedSize.height).toBe(784)

      const body = JSON.stringify((mock.requests[0] as { body?: unknown })?.body ?? {})
      expect(body).toContain('中文资料 42')
      expect(body).toContain('image/png')
      expect(body).not.toContain('image/bmp')
      expect(body).not.toContain('\uFFFD')

      await expect(page.locator('.message-user-image').last()).toBeVisible()
      await expect(page.locator('.message-user-attachment').last()).toContainText('legacy-gbk.txt')
      await page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
      })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(500)
      await page.screenshot({ path: screenshotPath('quality-chat-attachments-bmp-dark.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(500)
      await page.screenshot({ path: screenshotPath('quality-chat-attachments-bmp-light.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('显式附加的工作区外文件会被 Agent 真正读取', async () => {
    test.setTimeout(120_000)
    const workspace = join(root, 'tmp', `e2e-attach-read-ws-${Date.now()}`)
    const outside = join(root, 'tmp', `e2e-attach-read-outside-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const external = join(outside, '外部资料.txt')
    writeFileSync(external, '外部附件内容 42\n第二行\n', 'utf8')
    const mock = await startMockLLM({
      scripts: [
        { text: '我读一下附件。', toolCalls: [{ name: 'read_file', arguments: { path: external } }] },
        { text: '读完了：外部附件内容 42。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'attach-read-external', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '外部附件读取' })
      await installEventCollector(page)

      await page.evaluate(
        async (arg: { path: string; size: number }) => {
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          await store.getState().sendMessage('请读一下附加的外部资料，告诉我第二行是什么。', [
            {
              id: 'att_external',
              name: '外部资料.txt',
              path: arg.path,
              size: arg.size,
              kind: 'file',
              content: null
            }
          ])
        },
        { path: external, size: statSync(external).size }
      )
      await waitForRunFinished(page, 90_000)

      const toolFinished = (await getEvents(page)).filter((event) => event.type === 'tool_finished')
      expect(toolFinished).toHaveLength(1)
      expect(toolFinished[0].result).toMatchObject({ ok: true })
      expect(String(toolFinished[0].result?.output ?? '')).toContain('外部附件内容 42')
      const secondRequestBody = JSON.stringify((mock.requests[1] as { body?: unknown })?.body ?? {})
      expect(secondRequestBody).toContain('外部附件内容 42')
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

})
// ── 原文件：attachment-paste.spec.ts ──────────────────────────────────────────────
test.describe('attachment-paste.spec.ts', () => {
/**
 * P1-11 粘贴附件：剪贴板图片直接进入 Composer，发送后图片在历史消息中可见。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('粘贴图片到输入框并在历史中显示', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({ scripts: [{ text: '收到图片附件。' }] })
  const morrow = await launchMorrow({ name: 'attachment-paste', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-paste'),
      ...provider,
      permissionMode: 'auto',
      title: '粘贴附件测试'
    })

    await page.evaluate(async () => {
      // 用足够大的生成图，确保历史截图能真实展示附件可见性
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 100
      const context = canvas.getContext('2d')!
      const gradient = context.createLinearGradient(0, 0, 160, 100)
      gradient.addColorStop(0, '#1a1d22')
      gradient.addColorStop(0.55, '#3a2f1e')
      gradient.addColorStop(1, '#c8a35a')
      context.fillStyle = gradient
      context.fillRect(0, 0, 160, 100)
      context.fillStyle = '#f0e6d2'
      context.font = '600 28px serif'
      context.fillText('M', 68, 60)
      const blob = await new Promise<Blob | null>((resolveBlob) => canvas.toBlob(resolveBlob, 'image/png'))
      if (!blob) throw new Error('无法生成测试图片')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const file = new File([bytes], 'pasted.png', { type: 'image/png' })
      // 同名同尺寸的两张剪贴板图片不能被去重逻辑误删
      const second = new File([bytes], 'pasted.png', { type: 'image/png' })
      const data = new DataTransfer()
      data.items.add(file)
      data.items.add(second)
      const input = document.querySelector('.composer-input') as HTMLTextAreaElement
      input.focus()
      input.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      )
    })

    await expect(page.locator('.composer-file-name')).toHaveCount(2)
    await expect(page.locator('.composer-file-name').first()).toContainText('pasted.png')
    await page.locator('.composer-input').fill('看看这两张图')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('收到图片附件。')).toBeVisible({ timeout: 45_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '粘贴消息完成')

    await expect(page.locator('.message-user-image')).toHaveCount(2)
    await expect(page.locator('.composer-file-name')).toHaveCount(0)
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('attachment-paste-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('attachment-paste-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：sidechat.spec.ts ──────────────────────────────────────────────
test.describe('sidechat.spec.ts', () => {
/**
 * 侧边聊天 E2E：/btw 打开右侧抽屉 → 只读回答 → 主对话消息不变 → 关闭。
 * mock LLM 按系统提示区分主对话与侧边聊天。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('侧边聊天：只读回答，不写入主对话', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('侧边聊天')) {
        return { text: '侧边回答：入口在 `src/auth/login.ts`，主对话没有受到影响。', chunkDelayMs: 4 }
      }
      return { text: '主对话回答。' }
    }
  })
  const workspace = workspaceAt('e2e-sidechat')
  const morrow = await launchMorrow({ name: 'sidechat', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '侧边聊天测试'
    })

    await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } } })
        .__morrowStore.getState().sendMessage('主对话：登录逻辑在哪？')
    })
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '主对话结束')
    const before = await readStore(page)
    expect(before.session?.messages).toHaveLength(2)

    const input = page.locator('.composer-input')
    await input.fill('/btw 侧边问题：入口文件是哪个？')
    await page.keyboard.press('Enter')

    const drawer = page.getByRole('complementary', { name: '侧边聊天' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('侧边回答：入口在')).toBeVisible({ timeout: 30_000 })
    await expect(drawer.getByText('主对话没有受到影响')).toBeVisible()
    const sideFonts = await page.evaluate(() => ({
      title: getComputedStyle(document.querySelector('.sidechat-title') as HTMLElement).fontSize,
      meta: getComputedStyle(document.querySelector('.sidechat-sub') as HTMLElement).fontSize,
      body: getComputedStyle(document.querySelector('.sidechat-text') as HTMLElement).fontSize
    }))
    expect(sideFonts).toEqual({ title: '15px', meta: '11.5px', body: '13.5px' })

    // 侧边聊天与 Agent 主聊天框共用流金边框，聚焦时 1px 金线展开。
    const sideComposer = page.locator('.sidechat-composer')
    await expect(sideComposer).toHaveClass(/chat-gold-frame/)
    await expect(page.locator('.composer-shell')).toHaveClass(/chat-gold-frame/)
    const sideBase = await sideComposer.evaluate((element) => ({
      radius: getComputedStyle(element).borderRadius,
      border: Number.parseFloat(getComputedStyle(element).borderTopWidth),
      color: getComputedStyle(element).borderTopColor
    }))
    const agentBorder = await page
      .locator('.composer-shell')
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).borderTopWidth))
    expect(sideBase.radius).toBe('9px')
    expect(sideBase.border).toBeGreaterThan(0.5)
    expect(sideBase.border).toBeLessThanOrEqual(1.01)
    expect(sideBase.border).toBe(agentBorder)
    await sideComposer.locator('.sidechat-input').focus()
    await page.waitForTimeout(520)
    const sideFocus = await sideComposer.evaluate((element) => ({
      color: getComputedStyle(element).borderTopColor,
      horizon: Number(getComputedStyle(element, '::before').opacity)
    }))
    expect(sideFocus.color).not.toBe(sideBase.color)
    expect(sideFocus.horizon).toBeGreaterThan(0.8)
    // 右侧栏分隔线：悬浮单线高亮；按住并移开指针仍保持；松开移开即熄灭。
    const resizer = page.locator('.sidechat-resizer')
    const rail = page.locator('.sidechat-rail')
    await expect(resizer).toBeVisible()
    const box = await resizer.boundingBox()
    expect(box).not.toBeNull()
    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2
    const railBorder = (): Promise<string> => rail.evaluate((element) => getComputedStyle(element).borderLeftColor)
    const lineOpacity = (): Promise<string> => resizer.evaluate((element) => getComputedStyle(element, '::after').opacity)
    await page.mouse.move(400, 300)
    await page.waitForTimeout(120)
    await page.mouse.move(cx, cy)
    await page.waitForTimeout(220)
    expect(await lineOpacity()).toBe('1')
    expect(await railBorder()).toBe('rgba(0, 0, 0, 0)')
    await page.mouse.down()
    await page.mouse.move(cx - 24, cy, { steps: 4 })
    await page.waitForTimeout(220)
    expect(await lineOpacity()).toBe('1')
    await page.mouse.move(cx - 24, cy + 240)
    await page.waitForTimeout(220)
    expect(await lineOpacity()).toBe('1')
    expect(await railBorder()).toBe('rgba(0, 0, 0, 0)')
    await page.mouse.up()
    await page.mouse.move(cx - 160, cy + 240)
    await page.waitForTimeout(220)
    expect(await lineOpacity()).toBe('0')
    expect(await railBorder()).not.toBe('rgba(0, 0, 0, 0)')

    await page.locator('.sidechat-title').click()
    await page.waitForTimeout(320)

    // 主对话没有新增消息；侧边聊天请求带上主对话上下文且没有工具
    const after = await readStore(page)
    expect(after.session?.messages).toHaveLength(2)
    const sideBodies = mock.requests
      .map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
      .filter((body: string) => body.includes('侧边聊天'))
    expect(sideBodies.length).toBeGreaterThanOrEqual(1)
    expect(sideBodies[0]).toContain('主对话：登录逻辑在哪？')

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('sidechat-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    const sideLightFrame = await sideComposer.evaluate((element) => ({
      radius: getComputedStyle(element).borderRadius,
      border: Number.parseFloat(getComputedStyle(element).borderTopWidth)
    }))
    expect(sideLightFrame.radius).toBe('9px')
    expect(sideLightFrame.border).toBeGreaterThan(0.5)
    expect(sideLightFrame.border).toBeLessThanOrEqual(1.01)
    await page.screenshot({ path: screenshotPath('sidechat-light.png') })

    await drawer.getByRole('button', { name: '关闭侧边聊天' }).click()
    await expect(drawer).toBeHidden()

    // 输入框旁的按钮可重新打开；关闭不清空本次侧边对话
    await page.getByRole('button', { name: '侧边聊天（/btw）' }).click()
    await expect(page.getByRole('complementary', { name: '侧边聊天' })).toBeVisible()
    await expect(page.getByText('侧边回答：入口在')).toBeVisible()
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('侧边聊天：停止后保留部分回答并标记已停止，不写入主对话', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('侧边聊天')) {
        return { text: '这是一段用于测试停止的较长回答。'.repeat(20), chunkDelayMs: 80, textChunkSize: 4 }
      }
      return { text: '主对话回答。' }
    }
  })
  const workspace = workspaceAt('e2e-sidechat-stop')
  const morrow = await launchMorrow({ name: 'sidechat-stop', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '侧边聊天停止测试'
    })

    const input = page.locator('.composer-input')
    await input.fill('/btw 请写一段长回答')
    await page.keyboard.press('Enter')
    const drawer = page.getByRole('complementary', { name: '侧边聊天' })
    await expect(drawer).toBeVisible()
    const answer = drawer.locator('.sidechat-msg.is-assistant .sidechat-text')
    await expect(answer).toContainText('这是一段', { timeout: 30_000 })
    await drawer.getByRole('button', { name: '停止' }).click()
    await expect(drawer.locator('.sidechat-stopped')).toBeVisible({ timeout: 10_000 })

    const stoppedText = await answer.innerText()
    await page.waitForTimeout(600)
    expect(await answer.innerText()).toBe(stoppedText)
    expect((await readStore(page)).session?.messages).toHaveLength(0)

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('sidechat-stopped-dark.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('侧边聊天：输出被截断时显示服务商提示', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('侧边聊天')) {
        return { text: '被截断的回答。', stopReason: 'max_tokens' }
      }
      return { text: '主对话回答。' }
    }
  })
  const workspace = workspaceAt('e2e-sidechat-notice')
  const morrow = await launchMorrow({ name: 'sidechat-notice', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '侧边聊天截断测试'
    })

    const input = page.locator('.composer-input')
    await input.fill('/btw 给我一段长回答')
    await page.keyboard.press('Enter')
    const drawer = page.getByRole('complementary', { name: '侧边聊天' })
    await expect(drawer.getByText('被截断的回答。')).toBeVisible({ timeout: 30_000 })
    await expect(drawer.locator('.sidechat-notice')).toContainText('输出长度上限')
    expect((await readStore(page)).session?.messages).toHaveLength(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：message-queue.spec.ts ──────────────────────────────────────────────
test.describe('message-queue.spec.ts', () => {
/**
 * P0-5 运行中排队与引导：
 * - 运行中输入 Enter 进入队列；
 * - 队列可编辑/删除；
 * - 本轮正常结束后自动发送队首消息；
 * - 「打断并发送」立即停止当前运行并发新消息。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

function userTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { session: { messages: Array<Record<string, any>> } | null } }
    }).__morrowStore
    const session = store.getState().session
    return (session?.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => String(message.displayText ?? message.content?.find((block: any) => block.type === 'text')?.text ?? ''))
  })
}

test('运行中排队：编辑、删除、本轮结束后自动发送', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一轮完成。', delayMs: 12_000 },
      { text: '排队消息已处理。' },
      { text: '队列清空。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'message-queue', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-queue'),
      ...provider,
      permissionMode: 'auto',
      title: '排队测试'
    })

    await page.locator('.composer-input').fill('第一条任务')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-input')).toHaveAttribute('placeholder', /正在处理/)
    await expect(page.locator('.composer-send.is-stop')).toBeVisible()
    // 空输入时闪电仍在原位（禁用），与「点闪电插话」引导一致
    const zap = page.locator('.composer-send.is-interrupt')
    await expect(zap).toBeVisible()
    await expect(zap).toBeDisabled()
    await expect(page.locator('.composer-input')).toHaveAttribute('placeholder', /点闪电插话/)

    await page.locator('.composer-input').fill('第二条消息')
    await expect(zap).toBeEnabled()
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.queue-tray')).toBeVisible()
    await expect(page.locator('.queue-tray')).toContainText('第二条消息')

    await page.locator('.composer-input').fill('第三条消息')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.queue-item')).toHaveCount(2)

    // 编辑第二条
    await page.locator('.queue-item').nth(1).getByLabel('编辑这条排队消息').click()
    await page.locator('.queue-input').fill('第三条消息（已修改）')
    await page.locator('.queue-edit-actions').getByRole('button', { name: '保存' }).click()
    await expect(page.locator('.queue-tray')).toContainText('第三条消息（已修改）')

    // 删除第一条
    await page.locator('.queue-item').first().getByLabel('删除这条排队消息').click()
    await expect(page.locator('.queue-item')).toHaveCount(1)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('queue-tray-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('queue-tray-light.png') })
    await setThemeViaStore(page, 'dark')

    // 第一轮完成 → 自动发送剩下的排队消息
    await expect(page.getByText('排队消息已处理。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '排队消息运行结束')
    await expect(page.locator('.queue-tray')).toHaveCount(0)
    const texts = await userTexts(page)
    expect(texts).toContain('第一条任务')
    expect(texts).toContain('第三条消息（已修改）')
    expect(texts).not.toContain('第二条消息')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('打断并发送立即停止当前运行并发新消息', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '慢任务开始。', delayMs: 8_000 },
      { text: '新消息已处理。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'message-interrupt', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-interrupt'),
      ...provider,
      permissionMode: 'auto',
      title: '打断发送测试'
    })

    await page.locator('.composer-input').fill('慢任务')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-send.is-stop')).toBeVisible()

    await page.locator('.composer-input').fill('打断后立即发送这条')
    const interruptButton = page.getByRole('button', { name: '打断当前任务并立即发送' })
    await expect(interruptButton).toBeVisible()
    await interruptButton.click()

    await expect(page.getByText('新消息已处理。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '打断后运行结束')
    const texts = await userTexts(page)
    expect(texts).toContain('慢任务')
    expect(texts).toContain('打断后立即发送这条')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('运行中发送方式设为插话后，Enter 会停止当前任务并立即引导', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '慢任务开始。', delayMs: 8_000 },
      { text: '插话消息已处理。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'message-steer', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-steer'),
      ...provider,
      permissionMode: 'auto',
      title: '插话发送测试'
    })

    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } })
        .__morrowStore.getState().openSettings()
    })
    await page.getByRole('tab', { name: '回答' }).click()
    await page.getByRole('radiogroup', { name: '运行中发送方式' }).getByRole('radio', { name: '插话' }).click()
    await page.getByRole('button', { name: '完成' }).click()

    await page.locator('.composer-input').fill('慢任务')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-send.is-stop')).toBeVisible()
    await expect(page.locator('.composer-input')).toHaveAttribute('placeholder', /插话/)

    await page.locator('.composer-input').fill('插话后立即发送这条')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('插话消息已处理。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '插话后运行结束')
    const texts = await userTexts(page)
    expect(texts).toContain('慢任务')
    expect(texts).toContain('插话后立即发送这条')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：cross-session-run.spec.ts ──────────────────────────────────────────────
test.describe('cross-session-run.spec.ts', () => {
/**
 * 跨会话运行态回归：A 在等待审批时切到 B，审批不丢；
 * B 显示后台运行/待确认提示与会话行标记，返回 A 后可继续批准并完成。
 */

test.describe('跨会话运行态', () => {
  test('A 等待审批时切到 B：提示保留、返回可批准、完成后后台状态清理', async () => {
    test.setTimeout(90_000)
    const workspace = join(root, 'tmp', `e2e-cross-session-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '我先写一个文件。',
          toolCalls: [{ name: 'write_file', arguments: { path: '../cross.md', content: 'from session A' } }]
        },
        { text: '写好了。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'cross-session-run', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      const sessionA = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '跨会话 A'
      })
      const sessionB = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '跨会话 B'
      })
      await page.evaluate(async (id: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().selectSession(id)
      }, sessionA)

      await sendMessageViaStore(page, '请在 A 会话里写 cross.md。')
      await waitForRunStarted(page, 30_000)
      const permission = await waitForPermission(page, 30_000)
      expect(permission.toolName).toBe('write_file')

      // 通过真实侧栏切到 B（A 仍在等待审批）
      const rowB = page.locator('.sb-session').filter({ hasText: '跨会话 B' }).locator('.sb-session-main')
      await rowB.click()
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionB, 10_000, '切换到会话 B')

      const background = page.locator('.composer-background')
      await expect(background).toBeVisible({ timeout: 10_000 })
      await expect(background).toContainText('跨会话 A')
      await expect(background).toContainText('等待你的确认')
      await expect(page.locator('.sb-session').filter({ hasText: '跨会话 A' }).locator('.sb-session-flag.is-attention')).toBeVisible()
      await expect(page.locator('.permission-card')).toHaveCount(0)
      await expect(background.getByRole('button', { name: '返回处理' })).toBeVisible()
      await expect(background.getByRole('button', { name: '停止' })).toBeVisible()
      await page.locator('[aria-label="收起通知"]').last().click().catch(() => undefined)
      await page.waitForTimeout(250)

      await page.screenshot({ path: screenshotPath('cross-session-waiting-dark.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(350)
      await page.screenshot({ path: screenshotPath('cross-session-waiting-light.png') })
      await setThemeViaStore(page, 'dark')

      await background.getByRole('button', { name: '返回处理' }).click()
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionA, 10_000, '返回会话 A')
      await expect(page.locator('.permission-card')).toBeVisible({ timeout: 10_000 })
      await clickPermissionCard(page, 'once')
      await waitForRunFinished(page, 30_000)

      expect(existsSync(join(workspace, '..', 'cross.md'))).toBe(true)
      const pending = await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const state = store.getState()
        return {
          permissions: Object.keys(state.pendingPermissions ?? {}),
          questions: Object.keys(state.pendingQuestions ?? {}),
          run: state.run
        }
      })
      expect(pending.permissions).toEqual([])
      expect(pending.questions).toEqual([])
      expect(pending.run).toBeNull()

      // 回到 B：后台提示与运行标记应消失
      const rowBAfter = page.locator('.sb-session').filter({ hasText: '跨会话 B' }).locator('.sb-session-main')
      await rowBAfter.click()
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionB, 10_000, '切回会话 B')
      await expect(page.locator('.composer-background')).toHaveCount(0)
      await expect(page.locator('.sb-session').filter({ hasText: '跨会话 A' }).locator('.sb-session-flag')).toHaveCount(0)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('新建对话不会继承上一个会话的审批卡，返回后仍可批准', async () => {
    test.setTimeout(90_000)
    const workspace = join(root, 'tmp', `e2e-cross-new-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '等待批准再写。',
          toolCalls: [{ name: 'write_file', arguments: { path: '../new-session.md', content: 'ok' } }]
        },
        { text: '写好了。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'cross-session-new', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      const sessionA = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '待审批 A'
      })
      await sendMessageViaStore(page, '请写 new-session.md。')
      await waitForPermission(page, 30_000)
      await expect(page.locator('.permission-card')).toBeVisible()

      await page.evaluate(async () => {
        await (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .newSession()
      })
      await waitUntil(async () => (await readStore(page)).activeSessionId !== sessionA, 10_000, '新建对话')
      await expect(page.locator('.permission-card')).toHaveCount(0)

      await page.evaluate(async (id) => {
        await (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .selectSession(id)
      }, sessionA)
      await expect(page.locator('.permission-card')).toBeVisible({ timeout: 10_000 })
      await clickPermissionCard(page, 'once')
      await waitForRunFinished(page, 30_000)
      expect(existsSync(join(workspace, '..', 'new-session.md'))).toBe(true)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('在 B 时后台 A 才请求审批：toast 提醒并可一键回到 A 处理', async () => {
    test.setTimeout(90_000)
    const workspace = join(root, 'tmp', `e2e-cross-toast-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          delayMs: 1_200,
          text: '我先写一个文件。',
          toolCalls: [{ name: 'write_file', arguments: { path: '../cross-toast.md', content: 'from A' } }]
        },
        { text: '写好了。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'cross-session-toast', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      const sessionA = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '后台审批 A'
      })
      const sessionB = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '后台审批 B'
      })
      await page.evaluate(async (id: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().selectSession(id)
      }, sessionA)
      await sendMessageViaStore(page, '请在 A 里写 cross-toast.md。')
      await waitForRunStarted(page, 30_000)
      // 抢在模型返回工具调用前切到 B
      await page.evaluate(async (id: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().selectSession(id)
      }, sessionB)
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionB, 10_000, '切换到 B')

      const toast = page.locator('.toast-item').filter({ hasText: '后台审批 A' }).filter({ hasText: '需要你的确认' })
      await expect(toast).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.run-center-item.is-waiting')).toContainText('等待确认')
      await expect(toast.getByRole('button', { name: '去处理' })).toBeVisible()
      await toast.getByRole('button', { name: '去处理' }).click()
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionA, 10_000, '通过 toast 回到 A')
      await expect(page.locator('.permission-card')).toBeVisible({ timeout: 10_000 })
      await clickPermissionCard(page, 'once')
      await waitForRunFinished(page, 30_000)
      expect(existsSync(join(workspace, '..', 'cross-toast.md'))).toBe(true)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

})
// ── 原文件：chat-turn-nav.spec.ts（R20 长对话轮次跳转）──────────────────────────
test.describe('chat-turn-nav.spec.ts', () => {
test('长对话出现右侧轮次导航，点击分段跳到对应轮次', async () => {
  test.setTimeout(180_000)
  const workspace = join(root, 'tmp', `e2e-turn-nav-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const answer = (round: number): string =>
    [`## 第 ${round} 轮回答`, '', ...Array.from({ length: 24 }, (_, index) => `- 第 ${round} 轮要点 ${index + 1}：确认滚动定位与轮次导航。`)].join('\n')
  const mock = await startMockLLM({
    scripts: [1, 2, 3, 4].map((round) => ({ text: answer(round) }))
  })
  const morrow = await launchMorrow({ name: 'chat-turn-nav', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '轮次导航测试'
    })
    await installEventCollector(page)

    for (const round of [1, 2]) {
      await sendMessageViaStore(page, `第 ${round} 轮问题：整理一段较长的说明。`)
      await waitForRunFinished(page, 60_000)
    }
    // 两轮虽然已经超出一屏，但还不算长对话：不出现导航，避免短会话被刻度打扰。
    await expect(page.locator('.transcript-turn-nav')).toHaveCount(0)

    for (const round of [3, 4]) {
      await sendMessageViaStore(page, `第 ${round} 轮问题：继续补充并核对结论。`)
      await waitForRunFinished(page, 60_000)
    }

    const nav = page.locator('.transcript-turn-nav')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    await expect(nav.locator('.transcript-turn')).toHaveCount(4)

    const second = page.getByRole('button', { name: /跳到第 2 轮/ })
    await second.hover()
    const tip = page.locator('.transcript-turn-tip')
    await expect(tip).toBeVisible()
    await expect(tip).toContainText('第 2 轮问题')
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('r20-turn-nav-dark.png') })

    await second.click()
    await expect(second).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('[data-turn-index="1"]')).toHaveClass(/is-turn-hit/)
    await page.waitForTimeout(900)
    const offset = await page.evaluate(() => {
      const scroller = document.querySelector('.transcript-scroll') as HTMLElement
      const target = document.querySelector('[data-turn-index="1"]') as HTMLElement
      return target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    })
    expect(offset).toBeGreaterThanOrEqual(-4)
    expect(offset).toBeLessThan(80)

    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r20-turn-nav-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
})
})


test.describe("03-context", () => {
// ── 原文件：context-compaction.spec.ts ──────────────────────────────────────────────
test.describe('context-compaction.spec.ts', () => {
/**
 * 手动上下文压缩：
 * - 压缩期间禁止发送/再次压缩（主进程 + 渲染层双重拦截），不会丢新消息；
 * - 摘要收敛为「上下文已压缩」系统标记，按需展开，不再伪装成助手长回复；
 * - 压缩后旧消息按安全切点折叠，原始用户约束保留。
 */

test('手动压缩：锁住发送、摘要折叠展示、旧消息安全折叠', async () => {
  test.setTimeout(240_000)
  const normalScripts = Array.from({ length: 6 }, (_, index) => ({
    text: `第 ${index + 1} 轮核对完成。${'资料内容与结论'.repeat(60)}`
  }))
  const summaryText = '摘要：用户连续进行了六轮资料核对，前四轮已完成；保留目标、文件路径与未完成事项。'
  const mock = await startMockLLM({
    scripts: [...normalScripts, { text: summaryText, delayMs: 2_500 }]
  })
  const workspace = join(root, 'tmp', `e2e-compaction-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'context-compaction', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '压缩测试'
    })
    await installEventCollector(page)

    for (let round = 1; round <= 6; round += 1) {
      await clearEvents(page)
      await sendMessageViaStore(page, `第 ${round} 轮：请核对这一批资料并给出结论。${'补充说明'.repeat(12)}`)
      await waitForRunFinished(page, 60_000)
    }
    expect(mock.requests.length).toBe(6)
    await expect(page.locator('.message-user-bubble')).toHaveCount(6)
    await expect(page.locator('.message-assistant')).toHaveCount(6)

    // 输入 /compact 走真实命令面板；摘要请求会故意慢 2.5s，留出并发检查窗口
    await page.locator('.composer-input').fill('/compact')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.transcript-compacting')).toBeVisible({ timeout: 10_000 })

    const directSend = await page.evaluate(
      async (id) =>
        (window as unknown as {
          morrow: { chat: { send: (input: unknown) => Promise<{ ok: boolean; error?: { message: string } }> } }
        }).morrow.chat.send({ sessionId: id, text: '压缩期间直接发送' }),
      sessionId
    )
    expect(directSend.ok).toBe(false)
    expect(directSend.error?.message ?? '').toContain('正在压缩上下文')

    const directCompact = await page.evaluate(
      async (id) =>
        (window as unknown as {
          morrow: { chat: { compact: (id: string) => Promise<{ ok: boolean; error?: { message: string } }> } }
        }).morrow.chat.compact(id),
      sessionId
    )
    expect(directCompact.ok).toBe(false)
    expect(directCompact.error?.message ?? '').toContain('正在压缩上下文')

    await page.locator('.composer-input').fill('压缩结束前不要丢这条')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-input')).toHaveValue('压缩结束前不要丢这条')
    await expect(page.getByText('正在压缩上下文，完成后再发送。')).toBeVisible()
    // 6 次正常请求 + 1 次摘要请求；被拦下的发送不应产生第 8 次请求
    expect(mock.requests.length).toBe(7)

    await expect(page.locator('.message-compaction')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.message-compaction .compaction-head')).toContainText('上下文已压缩')
    await expect(page.locator('.message-compaction .compaction-head')).toContainText('任务继续')
    await expect(page.locator('.compaction-body')).toHaveCount(0)
    await expect(page.locator('.message-user-bubble')).toHaveCount(5)
    await expect(page.locator('.message-assistant')).toHaveCount(4)
    expect(mock.requests.length).toBe(7)

    await page.locator('.composer-input').fill('')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(500)
    await page.locator('.message-compaction').scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('context-compaction-collapsed-light.png') })

    await page.locator('.message-compaction .compaction-head').click()
    await expect(page.locator('.compaction-body')).toBeVisible()
    await expect(page.locator('.compaction-body')).toContainText('六轮资料核对')
    await page.screenshot({ path: screenshotPath('context-compaction-expanded-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('context-compaction-expanded-dark.png') })

    // 摘要已落盘：重新加载仍是折叠的系统标记
    const persisted = await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const current = store.getState().session
      const loaded = await window.morrow.session.load(current.id)
      if (!loaded.ok) throw new Error(loaded.error.message)
      return loaded.data.messages.map((message) => message.role)
    })
    expect(persisted[0]).toBe('system')
    expect(persisted.filter((role: string) => role === 'assistant')).toHaveLength(4)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('自动压缩：运行结束时把压缩后的历史同步回当前视图', async () => {
  test.setTimeout(240_000)
  const longReply = (index: number): string => `第 ${index} 次响应。${'长内容与核对结论'.repeat(90)}`
  const mock = await startMockLLM({
    scripts: Array.from({ length: 24 }, (_, index) => ({ text: longReply(index + 1) }))
  })
  const workspace = join(root, 'tmp', `e2e-auto-compaction-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'auto-compaction', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    // 小窗口 + 50% 阈值，让多轮对话在结束前触发自动压缩
    const provider = await configureMockProvider(page, mock.openaiBaseUrl, 'mock-e2e', 12_000)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ autoCompact: true, compactThreshold: 0.5 })
    })
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '自动压缩测试'
    })
    await installEventCollector(page)

    let rounds = 0
    for (let round = 1; round <= 8; round += 1) {
      await clearEvents(page)
      await sendMessageViaStore(page, `第 ${round} 轮：继续核对资料。${'这是本轮的具体要求。'.repeat(10)}`)
      await waitForRunFinished(page, 60_000)
      rounds = round
      if ((await page.locator('.message-compaction').count()) > 0) break
    }

    await expect(page.locator('.message-compaction').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.message-compaction .compaction-head').first()).toContainText('上下文已压缩')
    await expect(page.locator('.compaction-body')).toHaveCount(0)
    // 最早的助手回合已被折叠进摘要（用户约束消息会被保留，所以看助手消息数）
    expect(await page.locator('.message-assistant').count()).toBeLessThan(rounds)

    const persisted = await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const current = store.getState().session
      const loaded = await window.morrow.session.load(current.id)
      if (!loaded.ok) throw new Error(loaded.error.message)
      return { first: loaded.data.messages[0]?.role, count: loaded.data.messages.length }
    })
    expect(persisted.first).toBe('system')
    expect(persisted.count).toBeGreaterThan(0)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.locator('.message-compaction').first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('context-compaction-auto-dark.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：checkpoint-rewind.spec.ts ──────────────────────────────────────────────
test.describe('checkpoint-rewind.spec.ts', () => {
/**
 * P0-3 检查点回退 E2E：
 * - 两轮真实写文件 → 自动生成检查点；
 * - 消息「回退」按钮 + /rewind 命令打开面板；
 * - 外部修改触发冲突并禁用确认；
 * - 恢复预期内容后回退 both：notes 回到 v1、新建文件删除、对话清空。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('检查点回退：冲突检测 → 恢复文件与对话', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我来修改文件。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'notes.md', content: 'v2\n' } },
          { name: 'write_file', arguments: { path: 'new.md', content: 'new\n' } }
        ]
      },
      { text: '第一轮完成。' },
      { text: '继续修改。', toolCalls: [{ name: 'write_file', arguments: { path: 'notes.md', content: 'v3\n' } }] },
      { text: '第二轮完成。' }
    ]
  })
  const workspace = workspaceAt('e2e-checkpoint')
  writeFileSync(join(workspace, 'notes.md'), 'v1\n', 'utf8')
  const morrow = await launchMorrow({ name: 'checkpoint', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '检查点测试'
    })

    await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } } })
        .__morrowStore.getState().sendMessage('把 notes.md 改成 v2，并新建 new.md。')
    })
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第一轮完成')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v2\n')

    await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } } })
        .__morrowStore.getState().sendMessage('再把 notes.md 改成 v3。')
    })
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第二轮完成')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v3\n')

    // 主进程检查点已落盘（两轮）
    await waitUntil(
      async () =>
        page.evaluate(async (id) => {
          const result = await window.morrow.checkpoints.list(id)
          return result.ok && result.data.length === 2 ? result.data.length : null
        }, sessionId),
      20_000,
      '两个检查点'
    )

    // 外部修改一个已登记文件 → 从回答末尾「回退」打开唯一的确认弹窗
    writeFileSync(join(workspace, 'notes.md'), 'external\n', 'utf8')
    await page.getByRole('button', { name: '回退这一轮' }).first().click()
    await expect(page.getByRole('dialog', { name: '确认回退' })).toBeVisible()
    await expect(page.locator('.rewind-confirm-list')).toHaveCount(0)
    await expect(page.getByText(/有 1 个文件被改过/)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.rewind-confirm-files')).toContainText('notes.md')
    await expect(page.locator('.rewind-confirm-files li.is-conflict')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '确认回退' })).toBeDisabled()
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('rewind-conflict-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('rewind-conflict-light.png') })
    await setThemeViaStore(page, 'dark')

    // 修好文件后，在同一个确认弹窗里「重新检查」即可解除冲突
    writeFileSync(join(workspace, 'notes.md'), 'v3\n', 'utf8')
    await page.getByRole('button', { name: '重新检查' }).click()
    await expect(page.getByText(/有 1 个文件被改过/)).toHaveCount(0)
    await expect(page.locator('.rewind-confirm-files')).toContainText('notes.md')
    await expect(page.locator('.rewind-confirm-files')).toContainText('new.md')
    await expect(page.locator('.rewind-confirm-files')).toContainText('删除新文件')
    await expect(page.getByRole('button', { name: '确认回退' })).toBeEnabled()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('rewind-ready-dark.png') })

    await page.getByRole('button', { name: '确认回退' }).click()
    await expect(page.getByText(/已回到这一轮之前/)).toBeVisible({ timeout: 10_000 })
    await waitUntil(async () => (await readStore(page)).session?.messages.length === 0, 20_000, '对话已回退')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v1\n')
    expect(() => readFileSync(join(workspace, 'new.md'), 'utf8')).toThrow()

    const loaded = await page.evaluate(async (id) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, sessionId)
    expect(loaded?.messages).toHaveLength(0)
    const remaining = await page.evaluate(async (id) => {
      const result = await window.morrow.checkpoints.list(id)
      return result.ok ? result.data.length : -1
    }, sessionId)
    expect(remaining).toBe(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：a6-temp-clear.spec.ts ──────────────────────────────────────────────
test.describe('a6-temp-clear.spec.ts', () => {
/**
 * A6：临时对话与全量清除。
 * - 临时对话不写会话文件、不进入侧栏持久历史/搜索、不记 token 账本；
 * - 清除全部对话会删除会话文件、快照、检查点、成品版本、审批日志与用量，但不动工作区文件。
 */

test.describe('临时对话与清除全部', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('临时对话不落盘，清除全部只删对话派生数据', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      scripts: [
        { text: '临时回答已生成。', delayMs: 50 },
        { text: '普通回答已生成。', delayMs: 50 },
        { text: '定时任务完成。', delayMs: 50 }
      ]
    })
    const workspace = join(root, 'tmp', `e2e-a6-${Date.now()}`)
    mkdirSync(join(workspace, '.morrow'), { recursive: true })
    writeFileSync(join(workspace, 'keep-me.txt'), '工作区文件必须保留', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'MEMORY.md'), '秘密项目记忆XYZ：只应在普通对话出现。', 'utf8')
    morrow = await launchMorrow({ name: 'a6-temp-clear', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ defaultModel: { providerId: model.providerId, modelId: model.modelId } })
    }, provider)
    await page.evaluate(async (path: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ lastWorkspace: path })
    }, workspace)

    const tokenBefore = await page.evaluate(async () => window.morrow.tokenActivity.get())

    // 1. 从侧栏创建临时对话
    await page.locator('.sb-temp').click()
    await expect(page.locator('.tb-temp-badge')).toBeVisible()
    await expect(page.getByRole('heading', { name: '临时 · 不保存' })).toBeVisible()
    const tempId = (await readStore(page)).activeSessionId
    expect(tempId).toBeTruthy()
    const tempFile = join(morrow.dataDir, 'sessions', `${tempId}.json`)
    expect(existsSync(tempFile)).toBe(false)

    await page.evaluate(
      async (arg: { id: string; provider: { providerId: string; modelId: string } }) => {
        const result = await window.morrow.session.setModel(arg.id, {
          providerId: arg.provider.providerId,
          modelId: arg.provider.modelId
        })
        if (!result.ok) throw new Error(result.error.message)
      },
      { id: tempId!, provider }
    )

    // 2. 真实跑一轮：保存走内存，不产生会话文件
    await page.locator('.composer-input').fill('这是一次临时任务')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('临时回答已生成。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '临时对话运行结束')
    expect(existsSync(tempFile)).toBe(false)
    const loadedTemp = await page.evaluate(async (id: string) => window.morrow.session.load(id), tempId!)
    expect(loadedTemp.ok).toBe(true)
    if (loadedTemp.ok) expect(loadedTemp.data.messages.length).toBeGreaterThan(1)

    const listed = await page.evaluate(async () => window.morrow.session.list())
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.data.some((item) => item.id === tempId)).toBe(false)

    const search = await page.evaluate(async () =>
      window.morrow.features.invoke<{ groups: { sessions: unknown[] } }>('feature:search:query', { q: '临时回答' })
    )
    expect(search.ok).toBe(true)
    if (search.ok) expect(search.data.groups.sessions).toHaveLength(0)

    const tokenAfterTemp = await page.evaluate(async () => window.morrow.tokenActivity.get())
    expect(tokenAfterTemp.ok && tokenBefore.ok ? tokenAfterTemp.data.total : 0).toBe(
      tokenBefore.ok ? tokenBefore.data.total : 0
    )

    // 临时对话不注入项目记忆，也不向模型暴露 remember 工具
    const systemText = (body: Record<string, any> | undefined): string => {
      if (!body) return ''
      if (typeof body.system === 'string') return body.system
      return (Array.isArray(body.messages) ? body.messages : [])
        .filter((message: { role?: string }) => message.role === 'system')
        .map((message: { content?: unknown }) => (typeof message.content === 'string' ? message.content : ''))
        .join('\n')
    }
    const tempRequest = mock.requests[0]
    const tempSystem = systemText(tempRequest?.body)
    const tempTools = Array.isArray(tempRequest?.body?.tools)
      ? tempRequest.body.tools.map((tool: { function?: { name?: string }; name?: string }) => tool.function?.name ?? tool.name)
      : []
    expect(tempSystem).not.toContain('秘密项目记忆XYZ')
    expect(tempTools).not.toContain('remember')

    await page.waitForTimeout(280)
    await page.screenshot({ path: join(screensDir, 'a6-temp-chat.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'a6-temp-chat-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 3. 普通对话会落盘，用来验证全量清除
    const normalId = await page.evaluate(async (providerArg: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const created = await store.getState().newSession()
      if (!created) throw new Error('普通对话创建失败')
      const result = await window.morrow.session.setModel(created.id, {
        providerId: providerArg.providerId,
        modelId: providerArg.modelId
      })
      if (!result.ok) throw new Error(result.error.message)
      return created.id as string
    }, provider)
    await page.locator('.composer-input').fill('这是一次普通任务')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('普通回答已生成。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '普通对话运行结束')
    const normalFile = join(morrow.dataDir, 'sessions', `${normalId}.json`)
    expect(existsSync(normalFile)).toBe(true)
    const normalRequest = mock.requests[mock.requests.length - 1]
    const normalSystem = systemText(normalRequest?.body)
    const normalTools = Array.isArray(normalRequest?.body?.tools)
      ? normalRequest.body.tools.map((tool: { function?: { name?: string }; name?: string }) => tool.function?.name ?? tool.name)
      : []
    expect(normalSystem).toContain('秘密项目记忆XYZ')
    expect(normalTools).toContain('remember')

    // 定时任务运行后会引用自己的会话；清除全部对话时这些引用与运行历史也要一起清掉
    const scheduledTask = await page.evaluate(async (workspacePath: string) => {
      const created = await window.morrow.features.invoke<{ task: { id: string } }>('feature:schedules:create', {
        title: '清除测试定时任务',
        prompt: '给出一个简短的完成确认。',
        schedule: { kind: 'daily', time: '23:59' },
        workspace: workspacePath,
        permissionMode: 'read-only',
        enabled: true
      })
      if (!created.ok) throw new Error(created.error.message)
      const ran = await window.morrow.features.invoke('feature:schedules:run-now', { id: created.data.task.id })
      if (!ran.ok) throw new Error(ran.error.message)
      return created.data.task
    }, workspace)
    const tasksFile = join(morrow.dataDir, 'schedules', 'tasks.json')
    await waitUntil(async () => {
      const raw = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
        tasks: Array<{ id: string; lastStatus: string; lastSessionId?: string }>
      }
      const task = raw.tasks.find((item) => item.id === scheduledTask.id)
      return task?.lastStatus === 'success' && task.lastSessionId ? task : null
    }, 30_000, '定时任务运行完成')

    // 4. 制造需要随对话一起清除的派生数据
    const checkpointDir = join(morrow.dataDir, 'checkpoints', normalId)
    const snapshotDir = join(morrow.dataDir, 'snapshots', normalId)
    const versionDir = join(morrow.dataDir, 'artifact-versions', normalId, 'a1')
    mkdirSync(checkpointDir, { recursive: true })
    mkdirSync(snapshotDir, { recursive: true })
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(join(checkpointDir, 'c1.json'), '{}', 'utf8')
    writeFileSync(join(snapshotDir, 's1.txt'), 'snapshot', 'utf8')
    writeFileSync(join(versionDir, 'v1.json'), '{}', 'utf8')
    mkdirSync(join(morrow.dataDir, 'permissions'), { recursive: true })
    writeFileSync(join(morrow.dataDir, 'permissions', 'approval-log.jsonl'), '{"toolName":"x"}\n', 'utf8')

    // 5. 设置 → 归档 → 清除全部对话
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .openSettings()
    })
    await page.locator('#st-tab-archive').click()
    await page.locator('.st-danger-zone').getByRole('button', { name: '清除全部' }).click()
    await expect(page.getByRole('heading', { name: '清除全部对话？' })).toBeVisible()
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(screensDir, 'a6-clear-confirm.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'a6-clear-confirm-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    await page.getByRole('button', { name: '确认清除' }).click()

    await waitUntil(async () => (await readStore(page)).sessions.length === 0, 30_000, '对话列表清空')
    await expect(page.locator('.welcome')).toBeVisible({ timeout: 15_000 })
    expect(readdirSync(join(morrow.dataDir, 'sessions'))).toEqual([])
    expect(existsSync(checkpointDir)).toBe(false)
    expect(existsSync(snapshotDir)).toBe(false)
    expect(existsSync(join(morrow.dataDir, 'artifact-versions', normalId))).toBe(false)
    expect(existsSync(join(morrow.dataDir, 'permissions', 'approval-log.jsonl'))).toBe(false)

    const tokenAfterClear = await page.evaluate(async () => window.morrow.tokenActivity.get())
    expect(tokenAfterClear.ok).toBe(true)
    if (tokenAfterClear.ok) expect(tokenAfterClear.data.total).toBe(0)

    const oldSession = await page.evaluate(async (id: string) => window.morrow.session.load(id), normalId)
    expect(oldSession.ok).toBe(false)
    const searchAfterClear = await page.evaluate(async () =>
      window.morrow.features.invoke<{ groups: { sessions: unknown[] } }>('feature:search:query', { q: '普通回答' })
    )
    expect(searchAfterClear.ok).toBe(true)
    if (searchAfterClear.ok) expect(searchAfterClear.data.groups.sessions).toHaveLength(0)

    const schedulesAfter = await page.evaluate(async () =>
      window.morrow.features.invoke<{
        tasks: Array<{ id: string; lastStatus: string; lastSessionId?: string; lastRunAt: number | null; nextRunAt: number | null }>
      }>('feature:schedules:list')
    )
    expect(schedulesAfter.ok).toBe(true)
    if (schedulesAfter.ok) {
      const task = schedulesAfter.data.tasks.find((item) => item.id === scheduledTask.id)
      expect(task).toBeTruthy()
      expect(task?.lastSessionId).toBeUndefined()
      expect(task?.lastStatus).toBe('never')
      expect(task?.lastRunAt).toBeNull()
      expect(task?.nextRunAt).toBeGreaterThan(Date.now())
    }

    expect(existsSync(join(workspace, 'keep-me.txt'))).toBe(true)
    expect(existsSync(join(workspace, '.morrow', 'MEMORY.md'))).toBe(true)
    expect(readdirSync(workspace)).toContain('keep-me.txt')
    const settingsAfter = await page.evaluate(async () => window.morrow.settings.get())
    expect(settingsAfter.ok).toBe(true)
    if (settingsAfter.ok) expect(settingsAfter.data.lastWorkspace).toBe(workspace)
    await expect(page.locator('.tb-temp-badge')).toHaveCount(0)
  })

  test('关闭应用后临时对话消失，启动时清理遗留的临时快照目录', async () => {
    test.setTimeout(120_000)
    const dataDir = join(root, 'tmp', `e2e-a6-restart-${Date.now()}`)
    const workspace = join(root, 'tmp', `e2e-a6-restart-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })

    const first = await launchMorrow({ name: 'a6-restart-1', dataDir, timeoutMs: 90_000 })
    let tempId = ''
    try {
      await waitForStoreReady(first.page)
      await dismissOnboarding(first.page)
      await first.page.evaluate(async (path: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().updateSettings({ lastWorkspace: path })
      }, workspace)
      await first.page.locator('.sb-temp').click()
      await expect(first.page.locator('.tb-temp-badge')).toBeVisible()
      tempId = (await readStore(first.page)).activeSessionId ?? ''
      expect(tempId.startsWith('tmp_')).toBe(true)

      // 模拟崩溃遗留：临时目录与无主 tmp 目录
      for (const name of ['snapshots', 'checkpoints', 'artifact-versions']) {
        const dir = join(dataDir, name, 'tmp_orphan')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'leftover.txt'), 'should be cleaned', 'utf8')
      }
    } finally {
      await first.close()
    }
    expect(existsSync(join(dataDir, 'sessions', `${tempId}.json`))).toBe(false)

    morrow = await launchMorrow({ name: 'a6-restart-2', dataDir, timeoutMs: 90_000 })
    await waitForStoreReady(morrow.page)
    const listed = await morrow.page.evaluate(async () => window.morrow.session.list())
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.data).toHaveLength(0)
    expect(readdirSync(join(morrow.dataDir, 'sessions'))).toEqual([])
    for (const name of ['snapshots', 'checkpoints', 'artifact-versions']) {
      expect(existsSync(join(morrow.dataDir, name, 'tmp_orphan'))).toBe(false)
    }
    await expect(morrow.page.locator('.tb-temp-badge')).toHaveCount(0)
  })

  test('运行中清除全部：先停止任务，运行收尾不会把会话写回来', async () => {
    test.setTimeout(120_000)
    const mock = await startMockLLM({
      scripts: [{ text: '这一轮会被清除。', delayMs: 4_000 }]
    })
    const workspace = join(root, 'tmp', `e2e-a6-running-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    morrow = await launchMorrow({ name: 'a6-clear-running', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await page.evaluate(async (providerArg: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const created = await store.getState().newSession()
      if (!created) throw new Error('新建对话失败')
      const result = await window.morrow.session.setModel(created.id, {
        providerId: providerArg.providerId,
        modelId: providerArg.modelId
      })
      if (!result.ok) throw new Error(result.error.message)
      return created.id as string
    }, provider)
    await page.locator('.composer-input').fill('先跑起来再清除')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => (await readStore(page)).run !== null, 30_000, '运行开始')

    const deleted = await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().clearAllSessions()
    })
    expect(deleted).toBeGreaterThan(0)
    await expect(page.locator('.welcome')).toBeVisible({ timeout: 15_000 })

    // 等过原运行时长，确认收尾不会重建会话文件
    await page.waitForTimeout(4_800)
    expect(existsSync(join(morrow.dataDir, 'sessions', `${sessionId}.json`))).toBe(false)
    expect(readdirSync(join(morrow.dataDir, 'sessions'))).toEqual([])
    const state = await readStore(page)
    expect(state.sessions).toHaveLength(0)
    expect(state.run).toBeNull()
  })
})

})
// ── 原文件：demo-isolation.spec.ts ──────────────────────────────────────────────
test.describe('demo-isolation.spec.ts', () => {
/**
 * 演示隔离回归：演示模型不能污染默认模型，也不能在真实文件夹里播放剧本。
 * 运行：npx playwright test tests/e2e/demo-isolation.spec.ts
 */

const DEMO_MODEL = { providerId: 'demo', modelId: 'morrow-demo' }

function workspaceAt(name: string): string {
  const dir = join(root, 'tmp', `demo-isolation-${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test.describe('演示隔离', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('演示不写入默认模型；普通会话不能用演示模型；旧数据自动修复', async () => {
    test.setTimeout(180_000)
    morrow = await launchMorrow({
      name: 'demo-isolation',
      env: { MORROW_DEMO_SPEED: '0.1' },
      timeoutMs: 90_000,
      waitForSelector: '.onb-skip'
    })
    const { page } = morrow
    await waitForStoreReady(page)
    await installEventCollector(page)

    await page.locator('.onb-skip').click()
    const demoState = await waitUntil(
      async () =>
        page.evaluate(() => {
          const state = (window as unknown as {
            __morrowStore: { getState: () => Record<string, any> }
          }).__morrowStore.getState()
          if (state.session?.demo !== true) return null
          return {
            defaultModel: state.settings.defaultModel as { providerId: string; modelId: string },
            session: {
              id: String(state.session.id),
              model: state.session.model as { providerId: string; modelId: string },
              demo: state.session.demo === true,
              workspace: state.session.workspace as string | null
            }
          }
        }),
      30_000,
      '演示会话建立'
    )
    await waitForRunStarted(page)
    await waitForRunFinished(page, 90_000)

    expect(demoState.defaultModel).toEqual(DEFAULT_MODEL)
    expect(demoState.session.model.providerId).toBe('demo')
    expect(demoState.session.demo).toBe(true)
    expect(demoState.session.workspace).toContain('demo-workspace')
    await page.screenshot({ path: screenshotPath('demo-isolation.png') })

    const afterDemo = await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const created = await store.getState().newSession()
      return {
        model: created.model as { providerId: string },
        demo: created.demo === true,
        defaultModel: store.getState().settings.defaultModel as { providerId: string }
      }
    })
    expect(afterDemo.defaultModel).toEqual(DEFAULT_MODEL)
    expect(afterDemo.model).toEqual(DEFAULT_MODEL)
    expect(afterDemo.demo).toBe(false)

    const realWorkspace = workspaceAt('real')
    const rejectedCreate = await page.evaluate(
      async (arg: { workspace: string; model: { providerId: string; modelId: string } }) =>
        window.morrow.session.create({ workspace: arg.workspace, model: arg.model }),
      { workspace: realWorkspace, model: DEMO_MODEL }
    )
    expect(rejectedCreate.ok).toBe(false)
    if (!rejectedCreate.ok) expect(rejectedCreate.error.message).toContain('演示模型只能在')

    const rejectedDefault = await page.evaluate(
      async (model: { providerId: string; modelId: string }) => window.morrow.settings.update({ defaultModel: model }),
      DEMO_MODEL
    )
    expect(rejectedDefault.ok).toBe(false)

    const realModel = await page.evaluate(
      () => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().settings.defaultModel
    )
    const created = await page.evaluate(
      async (arg: { workspace: string; model: { providerId: string; modelId: string } }) =>
        window.morrow.session.create({ workspace: arg.workspace, model: arg.model, title: '旧演示会话' }),
      { workspace: realWorkspace, model: realModel }
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const file = join(morrow.dataDir, 'sessions', `${created.data.id}.json`)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    raw.model = DEMO_MODEL
    raw.workspace = realWorkspace
    delete raw.demo
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')

    const repaired = await page.evaluate(async (sessionId: string) => window.morrow.session.load(sessionId), created.data.id)
    expect(repaired.ok).toBe(true)
    if (repaired.ok) {
      expect(repaired.data.model.providerId).not.toBe('demo')
      expect(repaired.data.demo).not.toBe(true)
    }
    const repairedFile = JSON.parse(readFileSync(file, 'utf8')) as { model: { providerId: string } }
    expect(repairedFile.model.providerId).not.toBe('demo')
  })
})

})
// ── 原文件：background-runs.spec.ts ──────────────────────────────────────────────
test.describe('background-runs.spec.ts', () => {
/**
 * P0-6 后台运行与运行中心：
 * - 会话 A 运行中可切换到会话 B 并启动第二个运行；
 * - 运行中心列出两个任务，可切换/停止；
 * - 关闭窗口默认隐藏到托盘，应用不退出。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('多会话后台运行、运行中心与关闭到托盘', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '后台 A 完成。', delayMs: 6_000 },
      { text: '当前 B 完成。', delayMs: 6_000 }
    ]
  })
  const workspace = workspaceAt('e2e-background')
  const morrow = await launchMorrow({ name: 'background-runs', timeoutMs: 90_000 })
  try {
    const { page, app } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)

    const sessionA = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '后台会话 A'
    })
    await page.locator('.composer-input').fill('任务 A')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => (await readStore(page)).runs.length === 1, 30_000, 'A 开始运行')

    const sessionB = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '当前会话 B'
    })
    await page.locator('.composer-input').fill('任务 B')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => (await readStore(page)).runs.length === 2, 30_000, '两个会话并行运行')

    await expect(page.locator('.run-center')).toBeVisible()
    await expect(page.locator('.run-center-item')).toHaveCount(2)
    await expect(page.locator('.run-center')).toContainText('后台会话 A')
    // 后台会话在侧栏也应显示运行标记，而不是只有当前会话显示
    await expect(
      page.locator('.sb-session').filter({ hasText: '后台会话 A' }).locator('.sb-session-flag.is-running')
    ).toHaveCount(1)
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('run-center-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('run-center-light.png') })
    await setThemeViaStore(page, 'dark')

    // 运行中心切回 A
    await page.locator('.run-center-main').filter({ hasText: '后台会话 A' }).click()
    await waitUntil(async () => (await readStore(page)).activeSessionId === sessionA, 15_000, '切回会话 A')
    await expect(page.getByText('后台 A 完成。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).runs.length === 0, 60_000, '两个运行结束')

    // B 的回复仍在磁盘/会话里
    await page.evaluate(async (id) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().selectSession(id)
    }, sessionB)
    await expect(page.getByText('当前 B 完成。')).toBeVisible({ timeout: 30_000 })

    // 关闭窗口 → 首次询问；选择最小化到任务栏，应用仍在运行
    const closeState = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.close()
      return {
        count: BrowserWindow.getAllWindows().length,
        destroyed: win ? win.isDestroyed() : true
      }
    })
    expect(closeState.count).toBe(1)
    expect(closeState.destroyed).toBe(false)
    await expect(page.getByText('要关闭 Morrow 吗？')).toBeVisible()
    await page.getByRole('button', { name: /最小化到任务栏/ }).click()
    await expect
      .poll(async () =>
        app.evaluate(async ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          return { minimized: win ? win.isMinimized() : false, destroyed: win ? win.isDestroyed() : true }
        })
      )
      .toMatchObject({ minimized: true, destroyed: false })

    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.restore()
      win?.show()
      win?.focus()
    })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：reasoning-default.spec.ts ──────────────────────────────────────────────
test.describe('reasoning-default.spec.ts', () => {
/**
 * P1-13 回归：默认内置 DeepSeek 模型必须暴露推理强度选项。
 * 之前的元数据只给 openai/anthropic 推断 reasoningStyle，DeepSeek 等
 * OpenAI 兼容内置模型被标记 supportsReasoning 却没有 style，导致选择器被隐藏。
 */

test('默认 DeepSeek 模型可选择推理强度', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({
    name: 'reasoning-default',
    waitForSelector: '.composer',
    timeoutMs: 90_000
  })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)

    const trigger = page.getByRole('button', { name: '推理强度' })
    await expect(trigger).toBeVisible()
    await expect(trigger).toContainText('auto')
    // 模型选择在左、思考强度在右，符合「先选模型，再调强度」的阅读顺序。
    const modelTrigger = page.getByRole('button', { name: /^选择模型/ })
    await expect(modelTrigger).toBeVisible()
    const [modelBox, effortBox] = await Promise.all([modelTrigger.boundingBox(), trigger.boundingBox()])
    expect(modelBox && effortBox).toBeTruthy()
    expect(modelBox!.x).toBeLessThan(effortBox!.x)
    await trigger.click()
    // DeepSeek 官方只支持 off/low/high/max；不能再把 medium/xhigh 塞进请求。
    await expect(page.getByRole('option', { name: /^off/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^low/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^high/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^max/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^medium/ })).toHaveCount(0)
    await expect(page.getByRole('option', { name: /^xhigh/ })).toHaveCount(0)
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('reasoning-menu-dark.png') })

    await page.getByRole('option', { name: /^high/ }).click()
    await expect(trigger).toContainText('high')
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await trigger.click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('reasoning-menu-light.png') })
  } finally {
    await morrow.close()
  }
})

/**
 * 旧版本同步过模型元数据、但没有 reasoningStyle 的真实升级路径：
 * 设置合并不能让模型「支持推理」却隐藏思考强度选择。
 */
test('旧版同步模型缺少 reasoningStyle 时仍显示思考强度', async () => {
  test.setTimeout(120_000)
  const dataDir = join(root, 'tmp', `reasoning-legacy-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  const settings = defaultSettings()
  settings.onboardingDone = true
  settings.providers = settings.providers.map((provider) =>
    provider.id === 'deepseek'
      ? {
          ...provider,
          modelsSyncedAt: 1_700_000_000_000,
          models: [
            {
              id: 'deepseek-flash',
              label: 'DeepSeek V4.1 Flash',
              contextWindow: 1_048_576,
              maxOutput: 393_216,
              supportsTools: true,
              supportsReasoning: true,
              reasoningEfforts: ['low', 'high']
            }
          ]
        }
      : provider
  )
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings), 'utf8')

  const morrow = await launchMorrow({
    name: 'reasoning-legacy',
    dataDir,
    waitForSelector: '.composer',
    timeoutMs: 90_000
  })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const model = await page.evaluate(() => {
      const state = (window as unknown as { __morrowStore: { getState: () => { settings: { providers: Array<{ id: string; models: Array<{ id: string; reasoningStyle?: string }> }> } } } }).__morrowStore.getState()
      return state.settings.providers.find((provider) => provider.id === 'deepseek')?.models[0]
    })
    expect(model?.reasoningStyle).toBe('effort')
    const trigger = page.getByRole('button', { name: '推理强度' })
    await expect(trigger).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('reasoning-legacy-model-dark.png') })
    await trigger.click()
    await expect(page.getByRole('option', { name: /^high/ })).toBeVisible()
    await page.getByRole('option', { name: /^high/ }).click()
    await expect(trigger).toContainText('high')
  } finally {
    await morrow.close()
  }
})

})
// ── 原文件：reasoning-cost.spec.ts ──────────────────────────────────────────────
test.describe('reasoning-cost.spec.ts', () => {
/**
 * P1-13 推理强度与费用：
 * - 模型支持推理时输入区出现推理强度选择；
 * - 选择「高」后 provider 请求带 reasoning_effort；
 * - 会话累计费用 > 0，/usage 打开上下文用量页。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('推理强度映射与费用累计', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一轮回答。' },
      { text: '第二轮回答。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'reasoning-cost', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-reasoning'),
      ...provider,
      permissionMode: 'auto',
      title: '推理与费用测试'
    })

    await expect(page.getByRole('button', { name: '推理强度' })).toBeVisible()
    await page.getByRole('button', { name: '推理强度' }).click()
    await page.getByRole('option', { name: /^high/ }).click()
    await expect(page.getByRole('button', { name: '推理强度' })).toContainText('high')

    await page.locator('.composer-input').fill('第一次提问')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('第一轮回答。')).toBeVisible({ timeout: 30_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第一轮完成')
    expect(mock.requests[0].body.reasoning_effort).toBe('high')

    // 真实运行结束后继续切换 xhigh / max：两档都必须被 IPC 接受，不能出现「推理强度无效」
    const effortNow = (): Promise<string | undefined> =>
      page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const state = store.getState()
        return state.session?.reasoningEffort ?? state.settings.reasoningEffort
      })
    const trigger = page.getByRole('button', { name: '推理强度' })
    await trigger.click()
    await page.getByRole('option', { name: /^xhigh/ }).click()
    await expect(trigger).toContainText('xhigh')
    await expect.poll(effortNow, { timeout: 10_000 }).toBe('xhigh')
    await expect(page.locator('.toast-item.toast-error').filter({ hasText: '推理强度无效' })).toHaveCount(0)

    await trigger.click()
    await page.getByRole('option', { name: /^max/ }).click()
    await expect(trigger).toContainText('max')
    await expect.poll(effortNow, { timeout: 10_000 }).toBe('max')
    await expect(page.locator('.toast-item.toast-error').filter({ hasText: '推理强度无效' })).toHaveCount(0)

    await trigger.click()
    await page.getByRole('option', { name: /^high/ }).click()
    await expect(trigger).toContainText('high')
    await expect.poll(effortNow, { timeout: 10_000 }).toBe('high')

    await page.locator('.composer-input').fill('第二次提问')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('第二轮回答。')).toBeVisible({ timeout: 30_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第二轮完成')

    const usage = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().session?.usage ?? null
    })
    expect(usage?.costUsd).toBeGreaterThan(0)
    expect(usage?.inputTokens).toBeGreaterThan(0)

    await page.locator('.composer-input').fill('/usage')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByRole('tab', { name: '上下文' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.st-context')).toContainText('估算费用')
    await expect(page.locator('.st-context')).toContainText('参考价')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    // 打开上下文页时焦点不应落在阈值滑杆上：方向键会误改值，主题切换也会把面板滚走
    await expect(page.locator('.st-range')).not.toBeFocused()
    const cardOffset = (): Promise<number> =>
      page.locator('.st-ctx-card').evaluate((card) => {
        const panel = card.closest('.st-panel') as HTMLElement
        return Math.round(card.getBoundingClientRect().top - panel.getBoundingClientRect().top)
      })
    // 截图聚焦上下文占用与费用卡片，而不是滚动到下方的压缩设置
    await page.locator('.st-panel').evaluate((element) => {
      element.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      ;(element.closest('.modal-body') as HTMLElement | null)?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    })
    await expect.poll(cardOffset, { message: '费用卡片应位于页面标题下方顶部' }).toBeLessThan(140)
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await expect.poll(cardOffset, { message: '切换主题后面板不应滚动' }).toBeLessThan(140)
    await page.screenshot({ path: screenshotPath('reasoning-cost-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await expect.poll(cardOffset, { message: '切换主题后面板不应滚动' }).toBeLessThan(140)
    await page.screenshot({ path: screenshotPath('reasoning-cost-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：token-activity.spec.ts ──────────────────────────────────────────────
test.describe('token-activity.spec.ts', () => {
/**
 * Token 活动：真实 usage 落账 → 马赛克热力图 → 日/周/累计切换与悬浮详情。
 */

function makeDir(prefix: string): string {
  return join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
}

function nextDay(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

test.describe('Token 活动', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('真实 usage 入账，马赛克视图可切换并显示悬浮详情', async () => {
    test.setTimeout(120_000)
    const workspace = makeDir('token-activity-ws')
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({ scripts: [{ text: '收到了，这是 Token 统计测试回复。' }] })
    morrow = await launchMorrow({ name: 'token-activity', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'auto',
        title: 'Token 活动测试'
      })
      await installEventCollector(page)
      await sendMessageViaStore(page, '请回复一句用于 Token 统计的话。')
      await waitForRunFinished(page, 60_000)

      const ledger = join(morrow.dataDir, 'usage', 'token-activity.json')
      await waitUntil(async () => existsSync(ledger), 10_000, 'Token 账本落盘')
      const summary = await waitUntil(
        async () => {
          const result = await page.evaluate(async () => window.morrow.tokenActivity.get())
          return result.ok && result.data.total > 0 ? result.data : null
        },
        10_000,
        'Token 活动有真实记录'
      )
      expect(summary.total).toBeGreaterThan(0)
      expect(summary.today).toBeGreaterThan(0)

      await page.keyboard.press('Control+,')
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ state: 'visible' })
      await settings.getByRole('tab', { name: '用量' }).click()
      await expect(settings.locator('.st-page-title')).toHaveText('Token 活动')
      // 切换控件与应用其它 Segmented 保持一致，不再使用自定义胶囊样式
      await expect(settings.locator('.token-activity .segmented')).toBeVisible()
      await expect(settings.locator('.token-mode-tabs')).toHaveCount(0)

      const mosaic = page.locator('.token-mosaic')
      const dailyCells = page.locator('.token-mosaic .token-cell')
      await expect(page.locator('.token-mosaic .token-cell:not(.is-outside)').first()).toBeVisible({ timeout: 10_000 })
      await expect(mosaic).toHaveAttribute('data-mode', 'day')
      expect(await dailyCells.count()).toBeGreaterThanOrEqual(365)
      // 每列一周：同一列从上到下必须是连续日期，且方块行号与星期几严格对应
      await expect(page.locator('.token-weekday')).toHaveText(['一', '二', '三', '四', '五', '六', '日'])
      const layout = await page.$$eval('.token-mosaic .token-cell:not(.is-outside)', (cells) =>
        cells.map((cell) => {
          const element = cell as HTMLElement
          return {
            date: element.dataset.date ?? '',
            weekday: Number(element.dataset.weekday),
            column: Number(element.style.gridColumn),
            row: Number(element.style.gridRow)
          }
        })
      )
      expect(layout.length).toBe(summary.days.length)
      expect(layout.length).toBe(365)
      const byColumn = new Map<number, typeof layout>()
      for (const cell of layout) {
        byColumn.set(cell.column, [...(byColumn.get(cell.column) ?? []), cell])
      }
      const columnKeys = [...byColumn.keys()].sort((a, b) => a - b)
      expect(columnKeys[0]).toBe(2)
      for (let index = 1; index < columnKeys.length; index += 1) {
        expect(columnKeys[index]).toBe(columnKeys[index - 1] + 1)
      }
      for (const items of byColumn.values()) {
        const sorted = [...items].sort((a, b) => a.row - b.row)
        for (let index = 0; index < sorted.length; index += 1) {
          const cell = sorted[index]
          const jsDay = new Date(`${cell.date}T00:00:00`).getDay()
          const expectedWeekday = jsDay === 0 ? 7 : jsDay
          expect(cell.weekday).toBe(expectedWeekday)
          expect(cell.row).toBe(expectedWeekday)
          if (index > 0) {
            expect(cell.row).toBe(sorted[index - 1].row + 1)
            expect(cell.date).toBe(nextDay(sorted[index - 1].date))
          }
        }
      }
      expect(new Date(`${layout[0].date}T00:00:00`).getTime()).toBeLessThan(
        new Date(`${layout[layout.length - 1].date}T00:00:00`).getTime()
      )

      // 月份标签：钉在「该月 1 日所在的那一列」，文字不重叠，且至少间隔 3 列
      const labels = await page.$$eval('.token-month-label', (nodes) =>
        nodes.map((node) => {
          const element = node as HTMLElement
          const column = Number(element.style.gridColumn)
          const rect = element.getBoundingClientRect()
          const cell = [...document.querySelectorAll('.token-mosaic .token-cell')].find(
            (candidate) => Number((candidate as HTMLElement).style.gridColumn) === column
          ) as HTMLElement | undefined
          return {
            text: element.textContent ?? '',
            column,
            left: rect.left,
            right: rect.right,
            columnLeft: cell?.getBoundingClientRect().left ?? null
          }
        })
      )
      expect(labels.length).toBeGreaterThanOrEqual(11)
      const firstDay = new Date(`${layout[0].date}T00:00:00`)
      for (let index = 0; index < labels.length; index += 1) {
        const label = labels[index]
        const month = Number(label.text.replace('月', ''))
        const isStartLabel = index === 0 && label.column === 2 && month === firstDay.getMonth() + 1
        if (!isStartLabel) {
          const week = layout.filter((cell) => cell.column === label.column)
          const anchored = week.some((cell) => {
            const date = new Date(`${cell.date}T00:00:00`)
            return date.getDate() === 1 && date.getMonth() + 1 === month
          })
          expect(anchored, `${label.text} 应锚定在包含该月 1 日的那一列`).toBe(true)
        }
        if (index > 0) {
          expect(label.column).toBeGreaterThanOrEqual(labels[index - 1].column + 3)
          expect(label.left).toBeGreaterThan(labels[index - 1].right + 2)
        }
        if (label.column !== columnKeys[columnKeys.length - 1]) {
          expect(label.columnLeft).not.toBeNull()
          expect(Math.abs(label.left - (label.columnLeft ?? 0))).toBeLessThanOrEqual(1)
        }
      }
      await expect(page.locator('.token-activity-stats')).toContainText('今天')
      await expect(page.locator('.token-mode-note')).toContainText('每列一周（周一→周日）')
      await page.mouse.move(0, 0)
      await page.waitForTimeout(120)
      await page.locator('.token-activity').screenshot({ path: screenshotPath('token-activity-heatmap-dark.png') })

      const dailyCell = page.locator('.token-mosaic .token-cell:not(.is-outside):not(.level-0)').first()
      await expect(dailyCell).toBeVisible()
      await dailyCell.hover()
      await page.waitForTimeout(120)
      await dailyCell.hover()
      await expect(page.locator('.token-tooltip')).toBeVisible()
      await expect(page.locator('.token-tooltip')).toContainText('tokens')
      await page.screenshot({ path: screenshotPath('token-activity-daily.png') })
      await page.evaluate(() => {
        const store = (window as unknown as {
          __morrowStore: { getState: () => { setTheme: (value: string) => void } }
        }).__morrowStore
        store.getState().setTheme('light')
      })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await page.waitForTimeout(260)
      await page.screenshot({ path: screenshotPath('token-activity-daily-light.png') })
      await page.evaluate(() => {
        const store = (window as unknown as {
          __morrowStore: { getState: () => { setTheme: (value: string) => void } }
        }).__morrowStore
        store.getState().setTheme('dark')
      })

      // 每周：仍然是 365 个日格，格子与悬浮显示所在周合计
      await settings.getByRole('radio', { name: '每周' }).click()
      await expect(mosaic).toHaveAttribute('data-mode', 'week')
      expect(await page.locator('.token-mosaic .token-cell').count()).toBeGreaterThanOrEqual(365)
      await expect(page.locator('.token-month-label').first()).toBeVisible()
      await expect(page.locator('.token-mode-note')).toContainText('所在自然周的合计')
      const weekCell = page.locator('.token-mosaic .token-cell:not(.is-outside):not(.level-0)').first()
      await expect(weekCell).toBeVisible()
      await weekCell.hover()
      await expect(page.locator('.token-tooltip')).toContainText('该周合计')
      await page.screenshot({ path: screenshotPath('token-activity-weekly.png') })

      // 累计：仍然是 365 个日格，格子与悬浮显示截至当天的历史累计
      await settings.getByRole('radio', { name: '累计总量' }).click()
      await expect(mosaic).toHaveAttribute('data-mode', 'total')
      expect(await page.locator('.token-mosaic .token-cell').count()).toBeGreaterThanOrEqual(365)
      await expect(page.locator('.token-mode-note')).toContainText('截至当天的历史累计')
      const totalCell = page.locator('.token-mosaic .token-cell:not(.is-outside):not(.level-0)').last()
      await expect(totalCell).toBeVisible()
      await totalCell.hover()
      await expect(page.locator('.token-tooltip')).toContainText('累计用量')
      await page.screenshot({ path: screenshotPath('token-activity-total.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

})
// ── 原文件：model-metadata.spec.ts ──────────────────────────────────────────────
test.describe('model-metadata.spec.ts', () => {
/**
 * 订阅/API 模型的上下文上限来自模型元数据，且选择后必须真实传给支持该参数的代理，
 * 不能只在 UI 上改数字。
 */
test('上下文上限可选并真实传给代理', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({ scripts: [{ text: '上下文已调整。' }] })
  const morrow = await launchMorrow({ name: 'model-context', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(
      page,
      mock.openaiBaseUrl,
      'mock-context',
      128_000,
      false,
      [32_000, 64_000, 128_000],
      ['low', 'high']
    )
    const workspace = join(root, 'tmp', `e2e-model-context-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '上下文档位测试' })

    const trigger = page.getByRole('button', { name: '上下文上限' })
    await expect(trigger).toBeVisible()
    await trigger.click()
    await page.getByRole('option', { name: '64K' }).click()
    await expect(trigger).toContainText('64K')

    const selected = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().session?.model as Record<string, unknown> | null
    })
    expect(selected?.contextWindow).toBe(64_000)

    await sendMessageViaStore(page, '测试上下文上限')
    await waitUntil(async () => mock.requests.length > 0, 30_000, 'mock 收到请求')
    expect(mock.requests[0]?.headers['x-morrow-context-window']).toBe('64000')
    await expect(page.getByText('上下文已调整。')).toBeVisible({ timeout: 30_000 })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
})
})


test.describe("10-rounds", () => {
// ── 原文件：r12-close.spec.ts ──────────────────────────────────────────────
test.describe('r12-close.spec.ts', () => {
/**
 * R12 关闭流程：关闭按钮询问 → 记住选择 → 最小化到任务栏 / 完全退出。
 */

async function mainWindowState(app: MorrowApp): Promise<{ minimized: boolean; visible: boolean } | null> {
  return app.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Morrow')
    if (!win || win.isDestroyed()) return null
    return { minimized: win.isMinimized(), visible: win.isVisible() }
  })
}

test('关闭按钮先询问；选择后记住并最小化到任务栏；改为退出后不再询问', async () => {
  test.setTimeout(120_000)
  test.skip(process.platform !== 'win32', 'Windows 窗口行为测试')
  const morrow = await launchMorrow({ name: 'r12-close', timeoutMs: 90_000 })
  let closed = false
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    // 第一次关闭：必须弹出询问弹窗，而不是直接隐藏/退出
    await page.locator('.tb-win-close').click()
    const dialog = page.getByRole('dialog', { name: '要关闭 Morrow 吗？' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('最小化到任务栏')
    await expect(dialog).toContainText('完全退出')
    await page.screenshot({ path: 'docs/verification/screens/r12-close-ask.png' })

    await dialog.getByRole('button', { name: /最小化到任务栏/ }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => (await mainWindowState(morrow))?.minimized, { timeout: 10_000 })
      .toBe(true)
    const minimizedState = await mainWindowState(morrow)
    expect(minimizedState?.minimized).toBe(true)
    const settings = await page.evaluate(async () => {
      const result = await window.morrow.settings.get()
      return result.ok ? result.data.closeAction : null
    })
    expect(settings).toBe('minimize')

    // 恢复窗口后再关闭：已记住选择，不再弹窗，直接最小化
    await morrow.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Morrow')
      win?.restore()
      win?.show()
      win?.focus()
    })
    await expect.poll(async () => (await mainWindowState(morrow))?.minimized, { timeout: 10_000 }).toBe(false)
    await page.locator('.tb-win-close').click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await mainWindowState(morrow))?.minimized, { timeout: 10_000 }).toBe(true)

    // 改为“退出”：下一次关闭直接结束进程，不再询问
    await morrow.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Morrow')
      win?.restore()
      win?.show()
      win?.focus()
    })
    const saved = await page.evaluate(async () => {
      const result = await window.morrow.settings.update({ closeAction: 'quit' })
      return result.ok
    })
    expect(saved).toBe(true)
    const closePromise = morrow.app.waitForEvent('close', { timeout: 20_000 })
    await page.locator('.tb-win-close').click()
    await closePromise
    closed = true
  } finally {
    if (!closed) await morrow.close()
  }
})

})
// ── 原文件：r12-delete-diff.spec.ts ──────────────────────────────────────────────
test.describe('r12-delete-diff.spec.ts', () => {
/**
 * R12 删除 diff：
 * - 删除文件生成 −N 的 diff 摘要；
 * - 同一轮里新建后又删除的文件净变化为零，不显示任何 diff；
 * - 检查点不把净零临时文件带入回退列表。
 */

test('删除文件显示 diff，新建后删除不显示 diff', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r12-delete-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'old.txt'), '旧文件一\n旧文件二\n旧文件三\n', 'utf8')
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先建一个临时文件再删掉。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'temp.txt', content: '临时内容\n' } },
          { name: 'delete_file', arguments: { path: 'temp.txt' } }
        ]
      },
      {
        text: '删除旧文件。',
        toolCalls: [{ name: 'delete_file', arguments: { path: 'old.txt' } }]
      },
      { text: '清理完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r12-delete', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '删除 diff 测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '先建一个临时文件再删除，然后把 old.txt 也删除。')
    await waitForRunFinished(page, 90_000)

    // 新建后删除的 temp.txt 没有净变化；只有 old.txt 留下 −3。
    const diffs = page.locator('.message-diff-summary')
    await expect(diffs).toHaveCount(1)
    await expect(diffs.first()).toContainText('old.txt')
    await expect(diffs.first()).toContainText('−3')
    await expect(diffs.first()).not.toContainText('temp.txt')

    const checkpoints = await page.evaluate(async (id) => {
      const result = await window.morrow.checkpoints.list(id)
      return result.ok ? result.data : []
    }, sessionId)
    const files = checkpoints.flatMap((checkpoint) => checkpoint.files.map((file) => file.path))
    expect(files.some((path) => path.endsWith('old.txt'))).toBe(true)
    expect(files.some((path) => path.endsWith('temp.txt'))).toBe(false)

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r12-delete-diff-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r12-delete-diff-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r12-plan-sync.spec.ts ──────────────────────────────────────────────
test.describe('r12-plan-sync.spec.ts', () => {
/**
 * R12 计划同步：
 * 模型做完后直接收尾、忘记更新 todo 时，内核会在结束前提醒它同步计划；
 * 界面上的计划托盘必须从 0/2 变成 2/2，系统提醒本身不进入可见对话。
 */

const twoSteps = (first: string, second: string) => [
  { text: '搭骨架', status: first },
  { text: '补细节', status: second }
]

test('模型漏更新计划时自动提醒同步，托盘显示完成', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r12-plan-sync-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先列两步计划。',
        toolCalls: [
          { name: 'todo_write', arguments: { todos: twoSteps('in_progress', 'pending') } },
          { name: 'write_file', arguments: { path: 'note.txt', content: 'ok\n' } }
        ]
      },
      { text: '已经全部做好了。' },
      {
        toolCalls: [{ name: 'todo_write', arguments: { todos: twoSteps('completed', 'completed') } }]
      },
      { text: '计划已同步，全部完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r12-plan-sync', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '计划同步测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '分两步做一个文件。')
    await waitForRunFinished(page, 90_000)

    const state = await readStore(page)
    expect(state.session?.todos.map((todo) => todo.status)).toEqual(['completed', 'completed'])
    await expect(page.locator('.plan-tray .plan-progress')).toHaveText('2/2')
    await expect(page.locator('.plan-tray .plan-title')).toHaveText('计划完成')
    await expect(page.locator('.transcript-inner')).not.toContainText('[系统检查]')
    await page.screenshot({ path: screenshotPath('r12-plan-sync.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r12-protocol-diff.spec.ts ──────────────────────────────────────────────
test.describe('r12-protocol-diff.spec.ts', () => {
/**
 * R12 模型兼容 + diff 摘要：
 * - 模型把工具调用写成正文（DSML/Kimi 等文本协议）时，Morrow 应解析执行、界面无协议乱码；
 * - 文件改动后在消息末尾显示 +X / −Y 的 diff 摘要，双主题可读。
 */

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

    // 轮末的改动卡：1 个文件，+1 / −1
    const summary = page.locator('.message-diff-summary')
    await expect(summary).toBeVisible()
    await expect(summary).toContainText('本轮改动 1 个文件')
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

})
// ── 原文件：r12-stages.spec.ts ──────────────────────────────────────────────
test.describe('r12-stages.spec.ts', () => {
/**
 * R12 阶段式分叉/回退：
 * - 每完成一个计划步骤只出现一个阶段节点，中间模型步骤不显示分叉/回退；
 * - 新建文件也显示 diff 增删行；
 * - 回退到阶段节点：保留该阶段对话，撤销其后的文件改动与对话。
 */

const todos = (first: string, second: string) => [
  { text: '搭骨架', status: first },
  { text: '补细节', status: second }
]

test('阶段节点只在计划步骤完成时出现，回退保留阶段边界', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r12-stages-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先拆成两步。',
        toolCalls: [{ name: 'todo_write', arguments: { todos: todos('in_progress', 'pending') } }]
      },
      {
        text: '第一步完成。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'plan.html', content: '<h1>计划</h1>\n<p>骨架</p>\n' } },
          { name: 'todo_write', arguments: { todos: todos('completed', 'in_progress') } }
        ]
      },
      {
        text: '第二步完成。',
        toolCalls: [
          { name: 'edit_file', arguments: { path: 'plan.html', old_string: '骨架', new_string: '完整骨架' } },
          { name: 'todo_write', arguments: { todos: todos('completed', 'completed') } }
        ]
      },
      { text: '两步都完成了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r12-stages', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '阶段节点测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '按两步做一个计划页面。')
    await waitForRunFinished(page, 90_000)

    // 两个计划步骤各一个阶段节点；中间那条只有 todo_write 的模型步骤没有操作行
    await expect(page.locator('.message-stage-node')).toHaveCount(2)
    await expect(page.locator('.message-stage-node').first()).toContainText('完成：搭骨架')
    // 长阶段标题只能让标题自己换行/截断，不能把“阶段完成”压成竖排
    await expect(page.locator('.message-stage-label').first()).toHaveCSS('white-space', 'nowrap')
    const firstStep = page.locator('.message-assistant').filter({ hasText: '先拆成两步。' })
    await expect(firstStep.locator('.message-meta')).toHaveCount(0)

    // 整轮只保留一张改动卡：新建 + 后续编辑汇总为 +3 −1
    const diffs = page.locator('.message-diff-summary')
    await expect(diffs).toHaveCount(1)
    await expect(diffs.first()).toContainText('本轮改动 1 个文件')
    await expect(diffs.first()).toContainText('+3')
    await expect(diffs.first()).toContainText('−1')
    await expect(diffs.first()).toContainText('plan.html')
    await diffs.first().click()
    const fileRow = page.locator('.message-diff-file-head').first()
    await expect(fileRow).toContainText('+3')
    await expect(fileRow).toContainText('−1')
    await fileRow.click()
    await expect(page.locator('.message-diff-change')).toHaveCount(2)
    await expect(page.locator('.message-diff-change-note')).toContainText('2 次')
    await page.screenshot({ path: screenshotPath('r18-turn-diff-multi-change.png') })
    await fileRow.click()
    await diffs.first().click()

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.locator('.message-stage-node').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshotPath('r12-stages-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r12-stages-light.png') })
    await setThemeViaStore(page, 'dark')

    // 回退到第一个阶段：保留边界消息，文件回到该阶段完成时的内容
    const firstStage = page
      .locator('.message-assistant')
      .filter({ has: page.locator('.message-stage-node') })
      .first()
    await firstStage.getByRole('button', { name: '回退到这个阶段完成时' }).click()
    await expect(page.getByRole('dialog', { name: '确认回退' })).toBeVisible()
    await expect(page.getByText('对话和文件会一起回到这个阶段完成时。这一步不能撤销。')).toBeVisible()
    await expect(page.getByText(/保留这个阶段，移除其后的 2 条对话/)).toBeVisible()
    await page.getByRole('button', { name: '确认回退' }).click()
    await expect(page.getByText(/已回到这个阶段完成时/)).toBeVisible({ timeout: 15_000 })

    expect(readFileSync(join(workspace, 'plan.html'), 'utf8')).toBe('<h1>计划</h1>\n<p>骨架</p>\n')
    await waitUntil(
      async () => {
        const state = await readStore(page)
        return state.session?.messages.length === 3 &&
          state.session.todos?.length === 2 &&
          state.session.todos[0].status === 'completed' &&
          state.session.todos[1].status === 'in_progress'
          ? true
          : null
      },
      20_000,
      '阶段对话与计划已恢复'
    )
    await expect(page.locator('.message-stage-node')).toHaveCount(1)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r12-terminal-shell.spec.ts ──────────────────────────────────────────────
test.describe('r12-terminal-shell.spec.ts', () => {
/**
 * R12 终端一致性：
 * Git Bash 是默认终端；设置里选中的 Shell 必须真正用于 Agent 的 run_command。
 * 系统自带 Windows PowerShell 5.1 与 cmd 选项已移除。
 */

// Git Bash 在当前 DSH 受限令牌下无法创建 MSYS 共享内存（0xC0000022），
// 其一次性命令与后台任务由 tests/unit/main/terminal.test.ts 在真实 Node 进程中覆盖。
const cases = [
  { id: 'pwsh', command: '$PSVersionTable.PSVersion.Major', expected: '7' }
]

test('Agent run_command 使用设置里选中的 Shell，且默认是 Git Bash', async () => {
  test.setTimeout(240_000)
  const workspace = join(root, 'tmp', `e2e-r12-shell-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({ scripts: [{ text: '完成。' }] })
  const morrow = await launchMorrow({ name: 'r12-shell', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const profiles = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:terminal:profiles')
      return result.ok
        ? {
            ids: (result.data as { profiles: Array<{ id: string }> }).profiles.map((item) => item.id),
            defaultShell: (result.data as { defaultShell: string }).defaultShell
          }
        : { ids: [] as string[], defaultShell: '' }
    })
    if (profiles.ids.includes('gitbash')) expect(profiles.defaultShell).toBe('gitbash')
    expect(profiles.ids).not.toContain('powershell')
    // cmd 是受限令牌环境下其它 Shell 起不来时的最后兜底，保留在列表中。
    expect(profiles.ids).toContain('cmd')
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '终端一致性测试'
    })

    for (const item of cases) {
      if (!profiles.ids.includes(item.id)) continue
      await page.evaluate(async (shell) => {
        await window.morrow.settings.update({ terminalShell: shell })
      }, item.id)
      mock.reset([
        { text: `检查 ${item.id}`, toolCalls: [{ name: 'run_command', arguments: { command: item.command } }] },
        { text: '完成。' }
      ])
      await installEventCollector(page)
      await sendMessageViaStore(page, `只运行这一条终端检查：${item.command}`)
      await waitForRunFinished(page, 60_000)
      const event = (await getEvents(page))
        .filter((entry) => entry.type === 'tool_finished')
        .at(-1) as
        | { toolUseId?: string; result?: { ok?: boolean; output?: string; meta?: Record<string, unknown> } }
        | undefined
      if (!event?.result?.ok) console.log('SHELL FAIL', item.id, event?.result?.output)
      expect(event?.result?.ok, `${item.id} 命令失败`).toBe(true)
      expect(String(event?.result?.output ?? '')).toContain(item.expected)
      expect(event?.result?.meta).toMatchObject({ shellId: item.id })
    }
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r13-canvas-tabs.spec.ts ──────────────────────────────────────────────
test.describe('r13-canvas-tabs.spec.ts', () => {
/** 画布页签：成品页签可关闭、可拖动排序。 */

test('画布成品页签支持关闭和拖动排序', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-tabs-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '打开三个成品。',
        toolCalls: [
          { name: 'open_artifact', arguments: { kind: 'html', title: '成品 A', content: '<html><body>A</body></html>' } },
          { name: 'open_artifact', arguments: { kind: 'html', title: '成品 B', content: '<html><body>B</body></html>' } },
          { name: 'open_artifact', arguments: { kind: 'html', title: '成品 C', content: '<html><body>C</body></html>' } }
        ]
      },
      { text: '都打开了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-tabs', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '画布页签测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '打开三个成品。')
    await waitForRunFinished(page, 60_000)

    const titles = page.locator('.canvas-tab-title')
    await expect(titles).toHaveCount(3)
    // 画布页签与终端/浏览器同款：24px 高、5px 微圆角、金色选中边框
    const activeCanvasTab = page.locator('.canvas-doc-tab.is-active').first()
    await expect(activeCanvasTab).toHaveCSS('height', '24px')
    await expect(activeCanvasTab).toHaveCSS('border-radius', '5px')
    await expect(activeCanvasTab).toHaveCSS('border-top-color', 'rgba(200, 174, 125, 0.32)')
    const tabA = page.locator('.canvas-doc-tab').filter({ hasText: '成品 A' })
    await tabA.locator('.canvas-tab-close').click()
    await expect(page.locator('.canvas-doc-tab').filter({ hasText: '成品 A' })).toHaveCount(0)
    await expect(page.locator('.canvas-tab-title')).toHaveCount(2)

    const tabB = page.locator('.canvas-doc-tab').filter({ hasText: '成品 B' })
    const tabC = page.locator('.canvas-doc-tab').filter({ hasText: '成品 C' })
    await tabC.dragTo(tabB)
    await expect(page.locator('.canvas-tab-title').first()).toHaveText('成品 C')
    await page.screenshot({ path: screenshotPath('r13-canvas-tabs.png') })

    // 关闭最后一个页签：画布保留为空态，页签不会在重新打开时复活
    await page.locator('.canvas-doc-tab').filter({ hasText: '成品 B' }).locator('.canvas-tab-close').click()
    await page.locator('.canvas-doc-tab').filter({ hasText: '成品 C' }).locator('.canvas-tab-close').click()
    await expect(page.locator('.canvas-tab-title')).toHaveCount(0)
    await expect(page.locator('.canvas-root')).toBeVisible()
    await expect(page.locator('.canvas-empty')).toBeVisible()
    await page.screenshot({ path: screenshotPath('r13-canvas-tabs-empty.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r13-context-meter.spec.ts ──────────────────────────────────────────────
test.describe('r13-context-meter.spec.ts', () => {
/** 输入框上下文环：顶栏入口已移除、实时 token 详情、双主题。 */

test('上下文入口在输入框内，顶栏已移除，点击后展示上下文与 token 详情', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-context-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({ scripts: [{ text: '这是用于产生 token 用量的回答。' }] })
  const morrow = await launchMorrow({ name: 'r13-context', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '上下文详情测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '简单回答一句。')
    await waitForRunFinished(page, 60_000)
    await expect(page.locator('.tb-ctx')).toHaveCount(0)
    await expect(page.locator('.composer-bar .composer-ctx')).toHaveCount(1)
    const meter = page.locator('.composer-ctx-ring')
    await expect(meter).toBeVisible()
    const meterBox = await meter.boundingBox()
    const inputBox = await page.locator('.composer-input').boundingBox()
    expect(meterBox).not.toBeNull()
    expect(inputBox).not.toBeNull()
    expect(meterBox!.y).toBeGreaterThan(inputBox!.y)
    await meter.click()
    const popover = page.getByRole('dialog', { name: '上下文与 Token 使用' })
    await expect(popover).toBeVisible()
    const popBox = await popover.boundingBox()
    expect(popBox).not.toBeNull()
    // 弹窗紧贴圆环按钮上沿，并覆盖在输入框上方，而不是固定到输入框顶部。
    expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(meterBox!.y + 4)
    expect(popBox!.y + popBox!.height).toBeGreaterThanOrEqual(meterBox!.y - 20)
    expect(popBox!.y).toBeLessThan(inputBox!.y + inputBox!.height)
    expect(Math.abs(popBox!.x - meterBox!.x)).toBeLessThanOrEqual(16)
    const topmost = await page.evaluate(() => {
      const el = document.querySelector('.composer-ctx-pop')
      if (!el) return null
      const rect = el.getBoundingClientRect()
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { inside: top ? el.contains(top) : false, topClass: top?.className ?? '' }
    })
    expect(topmost?.inside, JSON.stringify(topmost)).toBe(true)
    await expect(popover).toContainText('上下文')
    await expect(popover).toContainText('输入')
    await expect(popover).toContainText('其中缓存')
    await expect(popover).toContainText('缓存命中率')
    await expect(popover).toContainText('输出')
    await page.waitForTimeout(220)
    await page.screenshot({ path: screenshotPath('r13-context-meter-dark.png') })
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(350)
    await expect(popover).toBeVisible()
    await page.screenshot({ path: screenshotPath('r13-context-meter-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r13-diff-card.spec.ts ──────────────────────────────────────────────
test.describe('r13-diff-card.spec.ts', () => {
/**
 * R13 改动卡：运行中只显示统计；任务结束后才能展开查看逐文件 diff。
 */

test('改动卡运行中不可展开，结束后可展开查看详细 diff', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r13-diff-card-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先写一版。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'draft.txt', content: '第一行\n第二行\n' } }
        ]
      },
      { text: '写好了。', delayMs: 2_500 }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-diff-card', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '改动卡测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '写一个草稿文件。')

    // 运行中：整轮只有一张统计，没有展开入口
    const summary = page.locator('.message-diff-summary')
    await expect(summary).toHaveCount(1, { timeout: 30_000 })
    await expect(summary).toContainText('draft.txt')
    await expect(summary).not.toHaveClass(/is-expandable/)
    await expect(page.locator('.message-diff-detail')).toHaveCount(0)
    await page.screenshot({ path: screenshotPath('r13-diff-card-collapsed.png') })

    await waitForRunFinished(page, 60_000)
    const expandable = page.locator('.message-diff-summary.is-expandable')
    await expect(expandable).toHaveCount(1)
    await expect(page.locator('.message-diff-detail')).toHaveCount(0)

    // 展开后先看到文件列表，逐行 diff 默认收起
    await expandable.click()
    await expect(expandable).toHaveAttribute('aria-expanded', 'true')
    const detail = page.locator('.message-diff-detail')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('draft.txt')
    await expect(page.locator('.message-diff-file .diff-view')).toHaveCount(0)

    const fileRow = page.locator('.message-diff-file-head', { hasText: 'draft.txt' })
    await expect(fileRow).toHaveAttribute('aria-expanded', 'false')
    await fileRow.click()
    await expect(fileRow).toHaveAttribute('aria-expanded', 'true')
    const fileDiff = page.locator('.message-diff-file .diff-view')
    await expect(fileDiff).toContainText('+第一行')
    await expect(fileDiff).toContainText('+第二行')
    const typography = await fileDiff.evaluate((root) => {
      const gutter = getComputedStyle(root.querySelector('.diff-gutter') as HTMLElement)
      const code = getComputedStyle(root.querySelector('.diff-code') as HTMLElement)
      return {
        gutterWeight: gutter.fontWeight,
        codeWeight: code.fontWeight,
        gutterSize: gutter.fontSize,
        codeSize: code.fontSize,
        gutterSpacing: gutter.letterSpacing,
        codeSpacing: code.letterSpacing
      }
    })
    expect(typography.gutterWeight).toBe('400')
    expect(typography.codeWeight).toBe('400')
    expect(typography.gutterSize).toBe(typography.codeSize)
    expect(['normal', '0px']).toContain(typography.gutterSpacing)
    expect(['normal', '0px']).toContain(typography.codeSpacing)
    const statTypography = await page.locator('.message-diff-file-head .message-diff-add').first().evaluate((element) => {
      const style = getComputedStyle(element)
      return { weight: style.fontWeight, size: style.fontSize, spacing: style.letterSpacing }
    })
    expect(statTypography.weight).toBe('400')
    expect(statTypography.size).toBe(typography.codeSize)
    expect(['normal', '0px']).toContain(statTypography.spacing)
    await page.screenshot({ path: screenshotPath('r13-diff-card-expanded.png') })
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('r13-diff-card-expanded-light.png') })

    await expandable.click()
    await expect(page.locator('.message-diff-detail')).toHaveCount(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('超长文件路径不会把展开箭头挤到第二行', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-diff-long-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const longPath =
    'very-long-directory-name/another-very-long-directory/third-long-directory/ultra-long-file-name-for-diff-card-layout-check-with-many-words.ts'
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先写一版。',
        toolCalls: [{ name: 'write_file', arguments: { path: longPath, content: 'export const value = 1\n' } }]
      },
      { text: '写好了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-diff-long', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '超长路径改动卡'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '写一个层级很深的文件。')
    await waitForRunFinished(page, 60_000)
    const summary = page.locator('.message-diff-summary').first()
    await expect(summary).toContainText('ultra-long-file-name')
    const boxes = await page.evaluate(() => {
      const summaryEl = document.querySelector('.message-diff-summary')
      const chevron = document.querySelector('.message-diff-summary .message-diff-chevron')
      if (!summaryEl || !chevron) return null
      return {
        summary: summaryEl.getBoundingClientRect().toJSON(),
        chevron: chevron.getBoundingClientRect().toJSON()
      }
    })
    expect(boxes).not.toBeNull()
    expect(boxes!.summary.height).toBeLessThan(44)
    expect(boxes!.chevron.y).toBeLessThan(boxes!.summary.y + 26)
    expect(boxes!.chevron.x).toBeGreaterThan(boxes!.summary.x + boxes!.summary.width / 2)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r13-execution-group.spec.ts ──────────────────────────────────────────────
test.describe('r13-execution-group.spec.ts', () => {
/**
 * R13 执行过程分组：
 * 同一轮的多步工具调用默认合并成一条「执行工具 N 次」；展开后保留每一步轨迹，
 * 再次点击可收起，最终回答始终在组外可见。
 */

test('多步执行默认合并，展开与收起保留真实工具轨迹', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r13-execution-group-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const files = Array.from({ length: 8 }, (_, index) => `note-${index + 1}.txt`)
  for (const [index, name] of files.entries()) {
    writeFileSync(join(workspace, name), `第 ${index + 1} 份记录\n`, 'utf8')
  }
  const mock = await startMockLLM({
    scripts: [
      ...files.map((name) => ({
        toolCalls: [{ name: 'read_file', arguments: { path: name } }]
      })),
      { text: '八份记录都检查完了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-execution-group', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '执行分组测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '把八份记录都检查一遍。')
    await waitForRunFinished(page, 90_000)

    const group = page.locator('.exec-group')
    await expect(group).toHaveCount(1)
    const head = group.locator('.exec-group-head')
    await expect(head).toContainText('执行工具 8 次')
    // 简要视图只显示工具次数，不再显示“N 步”
    await expect(head.locator('.exec-group-meta')).toHaveCount(0)
    await expect(head).not.toContainText('步')
    await expect(head).toHaveAttribute('aria-expanded', 'false')
    await expect(group.locator('.exec-group-body')).toHaveCount(0)
    await expect(page.locator('.message-assistant').last()).toContainText('八份记录都检查完了。')
    await page.waitForTimeout(220)
    await page.screenshot({ path: screenshotPath('r13-execution-group-dark.png') })

    await head.click()
    await expect(head).toHaveAttribute('aria-expanded', 'true')
    await expect(group.locator('.exec-group-body')).toBeVisible()
    await expect(group.locator('.exec-group-body .spine-item')).toHaveCount(8)

    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(320)
    await expect(head).toHaveAttribute('aria-expanded', 'true')
    await page.screenshot({ path: screenshotPath('r13-execution-group-light.png') })

    await head.click()
    await expect(head).toHaveAttribute('aria-expanded', 'false')
    await expect(group.locator('.exec-group-body')).toHaveCount(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r13-large-diff.spec.ts ──────────────────────────────────────────────
test.describe('r13-large-diff.spec.ts', () => {
/** 大文件局部修改：diff 摘要必须显示真实增删行，不能退化为 +0/-0。 */

test('超过 1000 行的 diff 在文件详情里给出截断提示', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-large-diff-cap-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const beforeLines = Array.from({ length: 1_100 }, (_, index) => `line ${index}`)
  const afterLines = Array.from({ length: 1_100 }, (_, index) => `changed ${index}`)
  writeFileSync(join(workspace, 'long.txt'), `${beforeLines.join('\n')}\n`, 'utf8')
  const mock = await startMockLLM({
    scripts: [
      {
        text: '重写这个文件。',
        toolCalls: [
          {
            name: 'write_file',
            arguments: { path: 'long.txt', content: `${afterLines.join('\n')}\n` }
          }
        ]
      },
      { text: '重写完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-large-diff-cap', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '大 diff 截断' })
    await installEventCollector(page)
    await sendMessageViaStore(page, '把 long.txt 的每一行都改掉。')
    await waitForRunFinished(page, 60_000)

    const summary = page.locator('.message-diff-summary')
    await expect(summary).toContainText('+1100')
    await expect(summary).toContainText('−1100')
    await summary.click()
    await page.locator('.message-diff-file-head', { hasText: 'long.txt' }).click()
    await expect(page.locator('.diff-note')).toContainText('仅显示前 1000 行')
    await page.screenshot({ path: screenshotPath('r18-large-diff-notice.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('大文件局部 edit 显示真实增删行而不是“内容没有变化”', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-large-diff-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const lines = Array.from({ length: 2490 }, (_, index) => `line ${index}`)
  lines[1200] = '.theme-toggle { background: #20261a; }'
  writeFileSync(join(workspace, 'big.css'), `${lines.join('\n')}\n`, 'utf8')
  const mock = await startMockLLM({
    scripts: [
      {
        text: '修改这一行。',
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'big.css',
              old_string: '.theme-toggle { background: #20261a; }',
              new_string: '.theme-toggle { background: #3a4630; }\ntransition: background .2s ease;'
            }
          }
        ]
      },
      { text: '修改完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-large-diff', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'ask', title: '大文件 diff' })
    await installEventCollector(page)
    await sendMessageViaStore(page, '修改 big.css 里的主题切换颜色。')
    await waitForRunFinished(page, 60_000)

    const summary = page.locator('.message-diff-summary')
    await expect(summary).toHaveCount(1)
    await expect(summary).toContainText('+2')
    await expect(summary).toContainText('−1')
    const assistant = page.locator('.message-assistant').first()
    await assistant.locator('.spine-item').first().click()
    await expect(assistant).not.toContainText('内容没有变化')
    await expect(assistant).toContainText('3a4630')
    await page.screenshot({ path: screenshotPath('r13-large-diff.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r13-long-error.spec.ts ──────────────────────────────────────────────
test.describe('r13-long-error.spec.ts', () => {

})
// ── 原文件：r13-plan-finishing.spec.ts ──────────────────────────────────────────────
test.describe('r13-plan-finishing.spec.ts', () => {
/**
 * R13 真实进度：
 * 计划已全部标完成、模型却继续改文件时，托盘不能继续显示「计划完成」；
 * 内核会追加真实的「收尾完善」步骤，界面进度与实际工作保持一致。
 */

test('计划完成后继续打磨时追加收尾步骤，不虚报全部完成', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r13-plan-finishing-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        toolCalls: [
          {
            name: 'todo_write',
            arguments: { todos: [{ text: '交付页面', status: 'completed' }] }
          }
        ]
      },
      {
        toolCalls: [{ name: 'write_file', arguments: { path: 'page.html', content: '<h1>v1</h1>\n' } }]
      },
      { delayMs: 1800, text: '继续打磨视觉细节。' },
      { text: '收尾工作尚未结束。' },
      { text: '本轮先到这里。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-plan-finishing', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '收尾进度测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '把页面继续完善好。')

    await expect(page.locator('.plan-tray')).toContainText('收尾完善', { timeout: 60_000 })
    await expect(page.locator('.plan-tray .plan-progress')).toHaveText('1/2')
    await expect(page.locator('.plan-tray .plan-title')).toHaveText('计划')
    await expect(page.locator('.plan-tray .plan-title')).not.toHaveText('计划完成')

    await waitForRunFinished(page, 90_000)
    const state = await readStore(page)
    expect(state.session?.todos.map((todo) => [todo.text, todo.status])).toEqual([
      ['交付页面', 'completed'],
      ['收尾完善', 'in_progress']
    ])
    await expect(page.locator('.plan-tray .plan-progress')).toHaveText('1/2')
    await expect(page.locator('.plan-tray .plan-title')).toHaveText('计划')
    await expect(page.locator('.plan-tray .plan-item-state')).toHaveText('未完成')
    expect(readFileSync(join(workspace, 'page.html'), 'utf8')).toContain('v1')
    await page.screenshot({ path: screenshotPath('r13-plan-finishing.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r16-ui.spec.ts ──────────────────────────────────────────────
test.describe('r16-ui.spec.ts', () => {
/**
 * R16 界面收口：顶栏字标/对话标题、首页文案单行、输入框拖动高度。
 */

test('顶栏不显示 Morrow 字样、首页文案不换行、输入框可拖高并持久化', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r16-ui-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'r16-ui' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    // 顶栏不再显示品牌字样；品牌只保留在关于页
    await expect(page.locator('.tb-wordmark')).toHaveCount(0)
    const dragRegion = await page.locator('.tb-left').evaluate((el) =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region')
    )
    expect(dragRegion).toBe('drag')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r16-titlebar-empty.png') })

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '关于' }).click()
    await expect(settings.locator('.st-about-name')).toHaveText('Morrow')
    await settings.getByRole('button', { name: '完成' }).click()

    // 拖动输入框上沿：高度增加，并写入 settings
    const composer = page.locator('.composer-shell')
    const handle = page.locator('.composer-resize')
    const before = await composer.boundingBox()
    const grip = await handle.boundingBox()
    expect(before && grip).toBeTruthy()
    await page.mouse.move((grip?.x ?? 0) + (grip?.width ?? 0) / 2, (grip?.y ?? 0) + 5)
    await page.mouse.down()
    await page.mouse.move((grip?.x ?? 0) + (grip?.width ?? 0) / 2, (grip?.y ?? 0) - 80, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(async () => {
        const settings = await page.evaluate(() => window.morrow.settings.get())
        return settings.ok ? settings.data.composerHeight : 0
      })
      .toBeGreaterThanOrEqual(80)
    const after = await composer.boundingBox()
    expect(after?.height ?? 0).toBeGreaterThan((before?.height ?? 0) + 40)
    await page.screenshot({ path: screenshotPath('r16-composer-height.png') })

    // 新建对话后：顶栏显示对话标题，品牌字样仍不出现，空对话页显示首页说明
    await createUiSession(page, { workspace, permissionMode: 'auto', title: '顶栏标题测试' })
    await expect(page.locator('.tb-wordmark')).toHaveCount(0)
    await expect(page.locator('.tb-title')).toContainText('顶栏标题测试')
    const desc = page.locator('.transcript-empty-desc')
    await expect(desc).toBeVisible()
    const overflow = await desc.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(overflow.scroll, '首页说明不应产生第二行').toBeLessThanOrEqual(overflow.client + 1)
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('r16-titlebar-title.png') })
  } finally {
    await morrow.close()
  }
})

})
})
