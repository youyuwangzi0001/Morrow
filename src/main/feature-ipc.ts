// R10 功能扩展的窄 IPC 注册中心。
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Result } from '../shared/types'

export type FeatureHandler = (
  payload: unknown,
  event: IpcMainInvokeEvent
) => unknown | Promise<unknown>

const handlers = new Map<string, FeatureHandler>()

export function registerFeatureHandler(channel: string, handler: FeatureHandler): void {
  if (!channel.startsWith('feature:')) {
    throw new Error(`feature channel 必须以 feature: 开头：${channel}`)
  }
  if (handlers.has(channel)) throw new Error(`feature channel 重复注册：${channel}`)
  handlers.set(channel, handler)
}

function featureError(err: unknown): Result<never> {
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, error: { code: 'FEATURE_ERROR', message } }
}

/** 在 app ready 后调用；会先 import 所有功能模块（副作用注册），再挂 IPC。 */
export function installFeatureIpc(): void {
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (event, payload): Promise<Result<unknown>> => {
      try {
        return { ok: true, data: await handler(payload, event) }
      } catch (err) {
        return featureError(err)
      }
    })
  }
}

/** 供单元测试直接调用（不经过 Electron ipcMain）。 */
export async function invokeFeatureForTest<T = unknown>(
  channel: string,
  payload?: unknown
): Promise<Result<T>> {
  const handler = handlers.get(channel)
  if (!handler) return { ok: false, error: { code: 'FEATURE_CHANNEL', message: `未注册的 feature channel：${channel}` } }
  try {
    return { ok: true, data: (await handler(payload, {} as IpcMainInvokeEvent)) as T }
  } catch (err) {
    return featureError(err)
  }
}

/** 向所有窗口广播 feature 事件（频道必须 feature: 开头）。 */
export function sendFeatureEvent(channel: string, payload: unknown): void {
  if (!channel.startsWith('feature:')) return
  // 延迟 import 避免在测试/非 Electron 环境加载 Electron 窗口 API
  try {
    const { BrowserWindow } = require('electron') as typeof import('electron')
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  } catch {
    // 测试环境没有 BrowserWindow，忽略
  }
}
