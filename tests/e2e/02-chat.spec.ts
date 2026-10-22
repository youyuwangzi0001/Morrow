/**
 * 合并自 7 个 E2E spec：chat-transcript.spec.ts、chat-attachments.spec.ts、attachment-paste.spec.ts、sidechat.spec.ts、message-queue.spec.ts、cross-session-run.spec.ts、subagent-ui.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { clearEvents, clickPermissionCard, configureMockProvider, createSession, dismissOnboarding, getEvents, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForPermission, waitForRunFinished, waitForRunStarted, waitForStoreReady, waitUntil } from './store'

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

// ── 原文件：subagent-ui.spec.ts ──────────────────────────────────────────────
test.describe('subagent-ui.spec.ts', () => {
/**
 * 并行子代理 UI：活动条展示任务、审批卡一次只出现一张、两个子代理都能完成。
 */

test('并行子代理：审批卡串行、活动条可见、两个子任务真实落盘', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我并行安排两个子任务。',
        toolCalls: [
          { name: 'task', arguments: { description: '写入 A', prompt: '请在上一级目录创建 alpha.txt，内容为 A。' } },
          { name: 'task', arguments: { description: '写入 B', prompt: '请在上一级目录创建 beta.txt，内容为 B。' } }
        ]
      },
      { text: '开始写文件。', toolCalls: [{ name: 'write_file', arguments: { path: '../alpha.txt', content: 'A' } }] },
      { text: '开始写文件。', toolCalls: [{ name: 'write_file', arguments: { path: '../beta.txt', content: 'B' } }] },
      { text: '子任务 A 完成。' },
      { text: '子任务 B 完成。' },
      { text: '两个子任务都完成了。' }
    ]
  })
  const workspace = join(root, 'tmp', `e2e-subagent-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'subagent-ui', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'ask', title: '并行子代理测试' })
    await installEventCollector(page)

    await sendMessageViaStore(page, '并行创建两个文件。')
    await waitForRunStarted(page, 30_000)
    const first = await waitForPermission(page, 30_000)
    expect(first.toolName).toBe('write_file')
    await expect(page.locator('.permission-card')).toHaveCount(1)
    await clickPermissionCard(page, 'once')

    // 第一张审批卡结束后才出现第二张，不能同时叠两张
    const second = await waitUntil(
      async () => {
        const state = await readStore(page)
        return state.pendingPermission && state.pendingPermission.id !== first.id ? state.pendingPermission : null
      },
      30_000,
      '第二张审批卡'
    )
    expect(second.toolName).toBe('write_file')
    await expect(page.locator('.permission-card')).toHaveCount(1)
    await clickPermissionCard(page, 'once')

    await waitForRunFinished(page, 90_000)
    await expect(page.getByText('两个子任务都完成了。')).toBeVisible()
    expect(existsSync(join(workspace, '..', 'alpha.txt'))).toBe(true)
    expect(existsSync(join(workspace, '..', 'beta.txt'))).toBe(true)

    const rows = page.locator('.spine-row.is-subagent')
    await expect(rows).toHaveCount(2)
    await expect(rows.locator('.spine-tag')).toHaveCount(2)
    await expect(page.locator('.permission-card')).toHaveCount(0)

    await rows.first().locator('.spine-item').click()
    await expect(rows.first().locator('.spine-subagent')).toContainText('小助手')
    await expect(rows.first().locator('.spine-subagent .mono')).toContainText('步')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(500)
    await rows.first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshotPath('subagent-parallel-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('subagent-parallel-dark.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
