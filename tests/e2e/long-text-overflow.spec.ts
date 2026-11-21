// 长文字 / 长文件名挤压验证：在真实 Electron 渲染进程里注入真实 DOM，
// 用 getClientRects() 判断尾部标签是否被压成多行（竖排），并截图留证。
//
// 运行：npx playright test tests/e2e/long-text-overflow.spec.ts
import { test, expect } from '@playwright/test'
import { launchMorrow, screenshotPath } from './helpers'

/** 判断元素内容是否被拆成多行（每个 client rect 的 top 不同） */
const measureLines = (selector: string): {
  found: boolean
  rectCount: number
  lineCount: number
  text: string
  width: number
  whiteSpace: string
  flexShrink: string
} => {
  const node = document.querySelector(selector)
  if (!node) return { found: false, rectCount: 0, lineCount: 0, text: '', width: 0, whiteSpace: '', flexShrink: '' }
  const rects = [...node.getClientRects()]
  const tops = new Set(rects.map((rect) => Math.round(rect.top)))
  const style = getComputedStyle(node)
  return {
    found: true,
    rectCount: rects.length,
    lineCount: tops.size,
    text: node.textContent ?? '',
    width: rects.length ? Math.round(rects[0].width) : 0,
    whiteSpace: style.whiteSpace,
    flexShrink: style.flexShrink
  }
}

test.describe('长文字不挤压尾部标签', () => {
  test('@core:typography 超长待办 + 附件文件名不会让尾部标签竖排换行', async () => {
    const morrow = await launchMorrow({ name: 'long-text', waitForSelector: '.sidebar' })
    const { page } = morrow
    try {
      // 注入一个受控容器，用真实样式类复现 UI 里的行结构
      await page.evaluate(() => {
        const host = document.createElement('div')
        host.id = 'long-text-probe'
        host.style.cssText = 'position:fixed;left:0;top:0;width:320px;z-index:99999;background:#111;padding:10px;font-size:15px;'
        host.innerHTML = `
          <ul class="super-worker-todos">
            <li class="is-completed">
              <svg width="11" height="11"></svg>
              <span>读取 research/raw 全部一手素材，提取可引用行号并补抓 UE 官方文档（Nanite、Lumen、MegaLights、World Partition、Asset Management、Cooking、Blueprint、Module、Plugin）</span>
              <em>完成</em>
            </li>
          </ul>
          <div class="composer-files" style="display:flex;flex-wrap:wrap;gap:6px">
            <span class="composer-file">
              <svg width="12" height="12"></svg>
              <span class="composer-file-name truncate">8b715667568b495e816cb608f9a08a73banner-very-long-file-name-with-many-words.png</span>
              <span class="composer-file-size mono">549 KB</span>
            </span>
          </div>
          <div class="message-user-attachments">
            <span class="message-user-attachment">
              <svg width="12" height="12"></svg>
              <span class="message-user-attachment-name truncate">another-extremely-long-attachment-file-name-for-testing-overflow.png</span>
              <span class="message-user-attachment-size mono">1.2 MB</span>
            </span>
          </div>
        `
        document.body.appendChild(host)
      })

      const statusLabel = await page.evaluate(measureLines, '#long-text-probe .super-worker-todos li em')
      const composerSize = await page.evaluate(measureLines, '#long-text-probe .composer-file-size')
      const messageSize = await page.evaluate(measureLines, '#long-text-probe .message-user-attachment-size')

      console.log('成员待办状态标签:', JSON.stringify(statusLabel))
      console.log('输入框附件大小:', JSON.stringify(composerSize))
      console.log('消息附件大小:', JSON.stringify(messageSize))

      // 尾部标签必须在同一行（lineCount === 1）
      expect(statusLabel.found).toBe(true)
      expect(statusLabel.lineCount, `「完成」被压成 ${statusLabel.lineCount} 行`).toBe(1)
      expect(composerSize.lineCount).toBe(1)
      expect(messageSize.lineCount).toBe(1)
      // 标签本身不参与收缩
      expect(composerSize.flexShrink).toBe('0')

      await page.screenshot({ path: screenshotPath('long-text-tail-labels.png') })
      // 局部放大截图：给视觉核对用，整屏截图里这些标签太小看不清
      const probe = page.locator('#long-text-probe')
      await probe.screenshot({ path: screenshotPath('long-text-tail-labels-closeup.png') })
    } finally {
      await morrow.close()
    }
  })
})