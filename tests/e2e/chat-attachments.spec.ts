/**
 * 对话附件链路回归：图片进入模型多模态输入、对话内可见；
 * 附件正文只进入模型上下文，不出现在用户气泡；附件元数据持久化。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  getEvents,
  installEventCollector,
  readStore,
  setThemeViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

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
