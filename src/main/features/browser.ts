/**
 * R10-C 浏览器功能模块：`feature:browser:*` IPC handlers + core 浏览器自动化 bridge 注入。
 *
 * Lead 只需要在 `src/main/features/index.ts` 里 `import './browser'`（本模块被 import 即完成
 * 服务初始化、bridge 注入与 IPC 注册；不要改 central ipc/preload/feature-ipc）。
 *
 * 频道清单（渲染层用 window.morrow.features.invoke/on）：
 *   feature:browser:get-state        → BrowserState
 *   feature:browser:open             { url, bounds? } → BrowserState
 *   feature:browser:open-preview     { url } → BrowserState（画布 HTML 成品，仅接受 morrow-artifact 预览地址）
 *   feature:browser:navigate         { url } → BrowserState
 *   feature:browser:set-bounds       { x,y,width,height } → BrowserBounds | null
 *   feature:browser:set-visible      { visible } → BrowserState
 *   feature:browser:back             → BrowserState
 *   feature:browser:forward          → BrowserState
 *   feature:browser:reload           → BrowserState
 *   feature:browser:stop             → BrowserState
 *   feature:browser:close            → BrowserState
 *   feature:browser:decide-download  { id, allow } → { decided: true }
 *   feature:browser:reveal-download  { path } → { revealed: true }（只允许 downloads 内的真实文件）
 *   feature:browser:debug-info       → 调试信息（仅 --test-mode 下可用，E2E 用）
 * 事件：
 *   feature:browser:state              BrowserState
 *   feature:browser:present            Agent 打开网页，渲染层展开浏览器面板
 *   feature:browser:closed             Agent 关闭网页，渲染层收起面板
 *   feature:browser:download           BrowserDownloadRequest（需用户批准）
 *   feature:browser:download-resolved  { id, allow }
 */
import { app } from 'electron'
import { registerFeatureHandler } from '../feature-ipc'
import { BrowserService, browserService } from '../services/browser-service'
import { setBrowserBridge, type BrowserBridge } from '../../core/browser-bridge'
import { log } from '../services/logger'

function asRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') throw new Error('参数格式错误：需要一个对象。')
  return payload as Record<string, unknown>
}

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`参数 ${key} 必须是非空字符串。`)
  return value
}

/** 自动化 bridge 实现（core 工具只依赖接口，主进程在这里落到 BrowserService） */
export const browserAutomationBridge: BrowserBridge = {
  open: (url, ctx) => browserService.automationOpen(url, ctx),
  click: (target, ctx) => browserService.automationClick(target, ctx),
  type: (target, text, ctx) => browserService.automationType(target, text, ctx),
  read: (ctx) => browserService.automationRead(ctx),
  screenshot: (ctx) => browserService.automationScreenshot(ctx),
  back: (ctx) => browserService.automationBack(ctx),
  forward: (ctx) => browserService.automationForward(ctx),
  reload: (ctx) => browserService.automationReload(ctx),
  scroll: (ctx, deltaY) => browserService.automationScroll(ctx, deltaY),
  closeAutomation: () => browserService.closeAutomation()
}

let featureInstalled = false

/**
 * 一次性初始化：注册 IPC、注入 core bridge，并在 app ready 后配置安全 session。
 *
 * 注意：electron-vite 会把 `require('./features')` 内联成静态 import，模块副作用可能在
 * app ready 之前执行；`session.fromPartition` 在 ready 前会抛
 * "Session can only be received when app is ready"。因此 handler 注册与 bridge 注入
 * 保持同步（安全），BrowserService.initialize() 延迟到 app ready。
 */
export function installBrowserFeature(service: BrowserService = browserService): void {
  if (featureInstalled) return
  featureInstalled = true
  setBrowserBridge(browserAutomationBridge)
  const initService = (): void => {
    try {
      service.initialize()
    } catch (err) {
      log.error('browser feature initialize failed', String(err))
    }
  }
  if (app.isReady()) initService()
  else void app.whenReady().then(initService)

  registerFeatureHandler('feature:browser:get-state', () => service.getState())
  registerFeatureHandler('feature:browser:open', (payload, event) => {
    const data = asRecord(payload)
    return service.openSurface(readString(data, 'url'), event, data.bounds)
  })
  registerFeatureHandler('feature:browser:open-preview', (payload, event) => {
    const data = asRecord(payload)
    return service.openPreview(readString(data, 'url'), event, data.bounds)
  })
  registerFeatureHandler('feature:browser:navigate', (payload) => {
    const data = asRecord(payload)
    return service.navigate(readString(data, 'url'))
  })
  registerFeatureHandler('feature:browser:set-bounds', (payload) => {
    const data = asRecord(payload)
    return service.setBounds(data)
  })
  registerFeatureHandler('feature:browser:set-visible', (payload) => {
    const data = asRecord(payload)
    service.setVisible(data.visible === true)
    return service.getState()
  })
  registerFeatureHandler('feature:browser:back', () => service.back())
  registerFeatureHandler('feature:browser:forward', () => service.forward())
  registerFeatureHandler('feature:browser:reload', () => service.reload())
  registerFeatureHandler('feature:browser:stop', () => service.stop())
  registerFeatureHandler('feature:browser:close', () => {
    service.closeSurface()
    return service.getState()
  })
  registerFeatureHandler('feature:browser:decide-download', (payload) => {
    const data = asRecord(payload)
    const id = readString(data, 'id')
    service.decideDownload(id, data.allow === true)
    return { decided: true, allow: data.allow === true }
  })
  registerFeatureHandler('feature:browser:reveal-download', async (payload) => {
    const data = asRecord(payload)
    await service.revealDownload(readString(data, 'path'))
    return { revealed: true }
  })
  registerFeatureHandler('feature:browser:debug-info', () => {
    const testMode = process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')
    if (!testMode) throw new Error('debug 信息仅在测试模式可用。')
    return service.debugInfo()
  })

  log.info('browser feature installed', { channels: 14 })
}

// 由 Lead 的 features/index.ts 在 app ready 后调用 registerFeatureModules()，
// 避免在 Electron app ready 前创建 session。
export function registerBrowserFeature(): void {
  installBrowserFeature()
}

export { browserService }
export type { BrowserState } from '../../core/browser-bridge'
