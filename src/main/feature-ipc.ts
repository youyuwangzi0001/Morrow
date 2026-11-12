// R10 功能扩展的窄 IPC 注册中心。
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Result } from '../shared/types'

export type FeatureHandler = (
  payload: unknown,
  event: IpcMainInvokeEvent
) => unknown | Promise<unknown>

const handlers = new Map<string, FeatureHandler>()

/**
 * 只读档必须拦住的写通道。
 *
 * 逐个 handler 手写 `assertWritable()` 会漏：只读档承诺「不能修改文件」，而
 * `feature:git:discard`（内部 `rmSync`）、`feature:git:checkout`（改写工作树）、
 * `feature:terminal:start-task`（起任意后台进程）此前都没有门禁。
 *
 * 这里按通道登记的**写动作白名单**判定：新增通道必须显式列进来才会被拦，
 * 而不是默认放行后被忘掉。
 *
 * 故意**不**列入的两类，见 PR 说明：
 * - `feature:studio:action`：同一个通道混合了只读的 get 与写盘的 action，按通道无法二分，
 *   需要先拆分通道才能安全拦截；
 * - `feature:browser:*`：只影响内置浏览器的会话状态，不改用户文件。
 */
const WRITE_ACTIONS = new RegExp(
  '^feature:(?:' +
    [
      // files：工作区写盘
      'files:(?:write|create|delete|rename|move)',
      // git：会改工作树、索引或对象库
      'git:(?:init|stage|unstage|discard|commit|checkout|create-branch|set-identity)',
      // terminal：会起进程或向运行中的 shell 写输入
      'terminal:(?:create|start-task|write|input|restart|remove)',
      // 历史/检查点恢复会覆盖工作区文件
      'history:restore',
      // 媒体生成会调用外部引擎并把产物写进作品目录
      'media:start',
      // 定时任务会周期性触发 agent 动作
      'schedules:(?:create|update|remove|run-now|set-enabled)',
      // 权限规则是门禁自身的状态，只读档下不应被改写
      'permissions:(?:add-rule|remove-rule)',
      // 数据目录迁移/重置会搬动本地数据
      'studio:(?:change-data-dir|reset-data-dir)'
    ].join('|') +
    ')$'
)

/** 只读档拒绝时使用的错误码，渲染层按语义分支处理而不是匹配文案。 */
export class ReadOnlyModeError extends Error {
  readonly code = 'READ_ONLY'
  readonly hint = '把权限切换为「询问」或「完全访问」后再试。'
  constructor(message = '当前是只读模式，不能执行这个操作。') {
    super(message)
    this.name = 'ReadOnlyModeError'
  }
}

/**
 * 由主进程注入，避免 ipc 层直接依赖设置存储的单例（测试里也更好替换）。
 * 返回 true 表示当前是只读档。
 */
let readOnlyProbe: () => boolean = () => false

export function setReadOnlyProbe(probe: () => boolean): void {
  readOnlyProbe = probe
}

/** 该通道在只读档下是否必须拒绝。 */
export function isWriteChannel(channel: string): boolean {
  return WRITE_ACTIONS.test(channel)
}

function guardChannel(channel: string): void {
  if (!isWriteChannel(channel)) return
  let readOnly = false
  try {
    readOnly = readOnlyProbe()
  } catch {
    // 探针自身异常时按「非只读」处理，与 files:* 既有的 assertWritable 行为一致
    readOnly = false
  }
  if (readOnly) throw new ReadOnlyModeError()
}

export function registerFeatureHandler(channel: string, handler: FeatureHandler): void {
  if (!channel.startsWith('feature:')) {
    throw new Error(`feature channel 必须以 feature: 开头：${channel}`)
  }
  if (handlers.has(channel)) throw new Error(`feature channel 重复注册：${channel}`)
  handlers.set(channel, handler)
}

/**
 * 带领域错误码的异常（如 WorkspaceFileError 的 NOT_FOUND）保留自己的 code，
 * 渲染层才能按语义分支处理，而不是去匹配中文文案。
 */
function domainErrorCode(err: unknown): { code: string; hint?: string } | null {
  if (!err || typeof err !== 'object') return null
  const raw = (err as { code?: unknown }).code
  if (typeof raw !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(raw)) return null
  const hint = (err as { hint?: unknown }).hint
  return typeof hint === 'string' && hint ? { code: raw, hint } : { code: raw }
}

function featureError(err: unknown): Result<never> {
  const message = err instanceof Error ? err.message : String(err)
  const domain = domainErrorCode(err)
  if (domain) return { ok: false, error: { code: domain.code, message, ...(domain.hint ? { hint: domain.hint } : {}) } }
  return { ok: false, error: { code: 'FEATURE_ERROR', message } }
}

/** 在 app ready 后调用；会先 import 所有功能模块（副作用注册），再挂 IPC。 */
export function installFeatureIpc(): void {
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (event, payload): Promise<Result<unknown>> => {
      try {
        guardChannel(channel)
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
    guardChannel(channel)
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
