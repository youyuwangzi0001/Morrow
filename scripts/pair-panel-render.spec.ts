import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, root, type MorrowApp } from '../tests/e2e/helpers'

/**
 * E2d 的**界面证据**：设置 → 手机配对 三个状态各截一张。
 *
 * ## 为什么需要它
 *
 * 本卡交付的是「用户能不能在电脑上生成配对码」，而此前所有断言都在
 * 逻辑层（`pair-api` 19 项、`pair-panel` 31 项）。逻辑正确 ≠ 界面画得对：
 * 布局塌了、文案被裁、倒计时没渲染，逻辑测试一条都不会红。
 *
 * 这里跑真实的 Electron（不是 jsdom），截三张图：
 * 1. 没配对的空态（含「远程通道现在是关的」这个闸门）
 * 2. 打开通道后还没生成票据
 * 3. 生成票据后的倒计时 + 六位码 + 配对码文本
 *
 * ## 为什么用 store 驱动而不是点 UI
 *
 * 「打开远程通道」会真的起 relay 监听（`applyRelaySettings`），
 * 在 CI/本机会占用端口并被防火墙弹窗打断。所以用 `updateSettings`
 * 直接改设置 —— 那张图的目的是「看布局」，不是「测开关」。
 * 开关本身由 verify 第 32 组的结构检查 + `settingsUpdate` 的接线守着。
 *
 * 生成票据则走**真实按钮点击**：那是本卡新增的主交互，必须真点。
 */
const OUT = join(root, 'docs', 'screens')
mkdirSync(OUT, { recursive: true })

async function openPairingTab(app: MorrowApp): Promise<void> {
  const { page } = app
  await app.app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((c) => !c.webContents.getURL().includes('#island'))
    if (!win) throw new Error('找不到主窗口')
    win.show()
    win.focus()
    win.setPosition(0, 0)
    win.moveTop()
  })
  await page.waitForTimeout(400)
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.waitFor({ state: 'visible', timeout: 20_000 })
  await settings.getByRole('tab', { name: '手机配对' }).click()
  await page.waitForTimeout(300)
}

async function shot(app: MorrowApp, name: string): Promise<void> {
  const file = join(OUT, name)
  rmSync(file, { force: true })
  await app.page.waitForTimeout(350)
  await app.page.screenshot({ path: file })
  const buf = readFileSync(file)
  expect(buf.length, `${name} 不应为空`).toBeGreaterThan(5000)
  expect(buf.subarray(0, 8).toString('hex'), `${name} 必须是 PNG`).toBe('89504e470d0a1a0a')
}

test('手机配对面板：三种状态都有可读内容', async () => {
  const app = await launchMorrow({ name: 'pair-panel' })
  try {
    const { page } = app

    // onboarding 会盖住设置入口
    await app.app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((c) => !c.webContents.getURL().includes('#island'))
      win?.show()
    })
    await page.waitForTimeout(800)
    // 直接改 store：跳过引导页（引导本身已有 e2e 覆盖，与本次目的无关）。
    // 用 helpers 里的同一个写法 —— `__morrowStore` 由 main.tsx 挂上，
    // 只调 updateSettings 不够：引导层还开着（onboardingOpen），会盖住设置弹窗。
    await page.evaluate(async () => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => Record<string, unknown>; setState: (p: Record<string, unknown>) => void }
      }).__morrowStore
      await (store.getState().updateSettings as (p: object) => Promise<void>)({ onboardingDone: true })
      store.setState({ onboardingOpen: false })
    })
    await page.waitForTimeout(500)

    // ── 状态 1：通道关闭的闸门 ──
    await openPairingTab(app)
    await shot(app, 'pair-panel-gate.png')

    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog.getByText('远程通道现在是关的')).toBeVisible()
    // 闸门态**不能**出现「生成配对码」按钮（否则用户点了必然失败）
    await expect(dialog.getByRole('button', { name: '生成配对码' })).toHaveCount(0)

    // ── 打开通道（只改设置，不真起 relay） ──
    // 只改设置里那个布尔值，不走 UI 的开关：
    // 那会真的 `applyRelaySettings()` 起监听端口，被防火墙弹窗打断。
    // 这一张图的目的是「看布局」，开关本身的接线由 verify 第 32 组守着。
    await page.evaluate(async () => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => Record<string, unknown> }
      }).__morrowStore
      await (store.getState().updateSettings as (p: object) => Promise<void>)({ relayEnabled: true })
    })
    await page.waitForTimeout(800)
    await shot(app, 'pair-panel-empty.png')

    // 打开后：第一步的粘贴框 + 生成按钮都要在
    const request = dialog.getByLabel('手机配对请求')
    await expect(request).toBeVisible()
    await expect(dialog.getByText('MORROWPAIR1.', { exact: false })).toBeVisible()
    // 还没粘请求时按钮必须禁用（点了只会得到「先粘贴」）
    await expect(dialog.getByRole('button', { name: '生成配对码' })).toBeDisabled()

    // ── 状态 3：真粘一个请求、真点生成 ──
    // 公钥必须是**真实在 P-256 曲线上**的点：桌面要拿它做 ECDH。
    // 第一次写这条时手造了「65 字节、04 开头」的假点，界面如实报出
    // 英文 `Public key is not valid for specified curve` ——
    // 那次失败促成了 `isP256Point` 校验与中文提示（见报告 §5.9）。
    const requestText = await page.evaluate(() => {
      // 在渲染进程里没有 node:crypto，所以用 WebCrypto 生成 P-256 公钥
      return (async () => {
        const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
        let bin = ''
        for (const b of raw) bin += String.fromCharCode(b)
        const pub = btoa(bin)
        const json = JSON.stringify({ deviceId: 'phone-e2d-shot', pubKey: pub })
        const b64 = btoa(unescape(encodeURIComponent(json)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '')
        return `MORROWPAIR1.${b64}`
      })()
    })
    await request.fill(requestText)
    await page.waitForTimeout(200)
    const issueBtn = dialog.getByRole('button', { name: '生成配对码' })
    await expect(issueBtn).toBeEnabled()
    await issueBtn.click()
    await page.waitForTimeout(900)
    // 生成的票据在面板下方（第一步 + 第二步两步内容比弹窗高）。
    // 不滚动就截图，截到的是「第一步」——六位码与倒计时在折线以下，
    // 等于拿一张「看起来没成功」的图当交付证据。第一次就是这么错的。
    const step2 = dialog.getByText('第二步 · 把配对码交给手机')
    await step2.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await shot(app, 'pair-panel-live.png')
    // 另存一张**只含面板内容**的图：整窗 2100×1202 里面板只占右侧一块，
    // 审看/翻阅时目标元素太小（第一版整窗图我自己都看漏了六位码）。
    await page.locator('.st-pair').screenshot({ path: join(OUT, 'pair-panel-live-panel.png') })

    // 六位码 + 倒计时 + 配对码文本三者都要出现
    await expect(dialog.getByText(/剩余 \d+ 秒/)).toBeVisible()
    await expect(dialog.getByText('第二步 · 把配对码交给手机')).toBeVisible()
    // 配对码文本以 ey 开头（base64url 的 JSON）
    await expect(dialog.getByText(/^ey[A-Za-z0-9_-]{20,}/)).toBeVisible()

    // 六位码必须是**真在视口内**且字号够大（只是「存在于 DOM」不算数：
    // 滚出屏幕外它也是 visible）。用包围盒量，别靠肉眼。
    const codeBox = await dialog.locator('.st-pair-code').boundingBox()
    expect(codeBox, '.st-pair-code 必须有包围盒').not.toBeNull()
    const fontSize = await dialog.locator('.st-pair-code').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect(fontSize, '六位码字号应 ≥ 24px（它是一屏里唯一的重点）').toBeGreaterThanOrEqual(24)
    const viewport = page.viewportSize() ?? { width: 2100, height: 1202 }
    expect(codeBox!.y + codeBox!.height).toBeLessThan(viewport.height)
    expect(codeBox!.y).toBeGreaterThan(0)

    // 配对码文本必须**完整可读**：不许横向溢出、不许纵向裁切。
    // 第一版 CSS 有 `max-height: 4.6em; overflow: auto`，只剩两行 + 滚动条，
    // 用户会怀疑自己复制到的是半截。用度量断言守，不靠肉眼看截图。
    const qrMetrics = await dialog.locator('.st-pair-qr-text').evaluate((el) => {
      const cs = getComputedStyle(el)
      return {
        clientW: el.clientWidth,
        scrollW: el.scrollWidth,
        clientH: el.clientHeight,
        scrollH: el.scrollHeight,
        // 溢出裁切只看 scroll/client 会漏掉 `overflow: hidden` 的情况，
        // 所以把计算出的 overflow 也读出来一起断言。
        overflow: `${cs.overflowX}/${cs.overflowY}`,
        maxHeight: cs.maxHeight,
        text: el.textContent ?? ''
      }
    })
    expect(qrMetrics.scrollW, '配对码文本不该横向溢出（溢出会出现横向滚动条）').toBeLessThanOrEqual(qrMetrics.clientW + 1)
    expect(qrMetrics.scrollH, '配对码文本不该被纵向裁切（裁切会让用户以为拿到半截）').toBeLessThanOrEqual(qrMetrics.clientH + 1)
    expect(qrMetrics.overflow, 'overflow 必须是 visible（不是 auto/hidden）').toBe('visible/visible')
    expect(qrMetrics.maxHeight, '不该有 max-height 限制').toBe('none')
    expect(qrMetrics.text.length, '配对码本身应有足够长度').toBeGreaterThan(100)

    // 标签必须把「多少字符 + 整段复制」说出来 —— 用户看不到长度时，
    // 面对一长串字符会怀疑是否复制完整（这是本卡真实遇到的一处用户疑问）。
    // 用 DOM 断言而不是看截图：这类小字在图里 OCR 不可靠。
    await expect(dialog.getByText(new RegExp(`配对码文本 · ${qrMetrics.text.length} 字符（整段复制）`))).toBeVisible()
    expect(qrMetrics.text.startsWith('ey'), '配对码应以 ey 开头（base64url 的 JSON）').toBe(true)
    // 打出来供人工核对（跑测时能直接看到实际尺寸）
    console.log('[qr]', JSON.stringify({ ...qrMetrics, text: `${qrMetrics.text.length} 字符` }))

    // 「已配对设备」区块在没配对时必须是「还没有」而不是空白
    await expect(dialog.getByText('还没有配对的手机', { exact: false })).toBeVisible()
    // 滚到**空态那句**本身，而不是它的标题：
    // `scrollIntoViewIfNeeded` 只保证「元素可见」，标题滚到视口底边时，
    // 它下面的空态文案就落到折线以下 —— 拍出来的图是「区块空空如也」，
    // 与「有文案但被折掉」看起来完全一样。（第一版就是这么错的。）
    const emptyHint = dialog.getByText('还没有配对的手机', { exact: false })
    await emptyHint.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    // 空态文案的包围盒也断言一次：必须在视口内
    const hintBox = await emptyHint.boundingBox()
    expect(hintBox, '空态文案必须有包围盒').not.toBeNull()
    const vp = page.viewportSize() ?? { width: 2100, height: 1202 }
    expect(hintBox!.y).toBeGreaterThan(0)
    expect(hintBox!.y + hintBox!.height).toBeLessThanOrEqual(vp.height)
    await shot(app, 'pair-panel-devices.png')
  } finally {
    await app.close()
  }
})
