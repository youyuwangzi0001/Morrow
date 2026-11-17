// R10 功能扩展的窄 IPC 注册中心。
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Result } from '../shared/types'

export type FeatureHandler = (
  payload: unknown,
  event: IpcMainInvokeEvent
) => unknown | Promise<unknown>

const handlers = new Map<string, FeatureHandler>()

/* ── 只读档的通道级门禁 ───────────────────────────────────────── */

/**
 * 只读档「允许放行」的读动作，按功能域分组。
 *
 * 判定方向是**反过来的**：这些功能域里的通道只有登记在表里才算读，其余一律按写动作处理。
 * 这样新增一个 `feature:git:*` 写通道时不需要记得来加门禁——它默认被拦；
 * 新增读通道则必须在上表登记（否则只读档会拒绝它），代价是可见的、可以补的一行。
 *
 * 只读档的承诺见 `docs/ARCHITECTURE.md`：「拒绝写文件、命令、记忆与外部副作用动作」。
 * 此前 `assertWritable()` 只挂在 5 个 `feature:files:*` handler 上，git / terminal /
 * history / schedules 等写通道完全没有门禁，只读档点「放弃改动」照样会 `rmSync` 删文件。
 */
const READ_ACTIONS: Record<string, ReadonlySet<string>> = {
  // 读：目录/文件内容、预览、定位；写：写入、新建、删除、重命名、移动
  files: new Set(['archive-list', 'document-preview', 'docx-html', 'inspect', 'list', 'pptx-preview', 'preview', 'read', 'reveal', 'stat', 'startdrag']),
  // 写：init / stage / unstage / discard / commit / checkout / create-branch / set-identity
  git: new Set(['branches', 'diff', 'log', 'show', 'status']),
  // 写：create / start-task / write / input / restart / remove / stop；resize 只是窗口尺寸通知
  terminal: new Set(['list', 'profiles', 'read', 'resize']),
  // 写：record（落一份检查点到磁盘）/ restore（覆盖工作区文件）
  history: new Set(['diff', 'list']),
  // 写：start（调用外部引擎并把产物写进作品目录）/ catalog-action（安装、卸载模型文件）
  media: new Set(['catalog', 'open-model-dir', 'pick', 'pick-files', 'pick-manifest', 'resolve-model-files', 'status']),
  // 写：add-rule / remove-rule（改的是门禁自身的规则）
  permissions: new Set(['list-log', 'list-rules']),
  // 写：create / update / remove / run-now / set-enabled
  schedules: new Set(['list']),
  // 写：change-data-dir / reset-data-dir；action 是混合通道，按 payload.type 判定
  studio: new Set([
    'data-dir-info',
    'open-data-dir',
    'open-path',
    'open-project-dir',
    'pick-import',
    'pick-package',
    'reveal',
    // @core 创作台混合通道：读类动作放行，写类动作（保存、生成、导出、删除…）在只读档拒绝
    'action:get',
    'action:list',
    'action:list-jobs',
    'action:list-trash',
    'action:list-versions',
    'action:status',
    'action:export-preflight',
    'action:text-routes',
    'action:asset-proxy',
    'action:asset-waveform',
    'action:cover',
    'action:noop'
  ]),
  // 写：action（登录、导入凭据等都会改本地订阅状态）
  subscriptions: new Set(['status', 'login-url', 'pick-codex-auth']),
  // 内置浏览器的会话状态不算用户文件；decide-download 会把下载结果落盘，按写处理
  browser: new Set([
    'back',
    'close',
    'debug-info',
    'forward',
    'get-state',
    'navigate',
    'open',
    'open-preview',
    'reload',
    'reveal-download',
    'set-bounds',
    'set-visible',
    'stop',
    'tab-activate',
    'tab-close',
    'tab-new'
  ])
}

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

/** 混合通道的动作类型放在 payload 里（`feature:studio:action` 用 `type`）。 */
function payloadActionType(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const type = (payload as { type?: unknown }).type
  return typeof type === 'string' ? type.toLowerCase() : ''
}

/** 该通道在当前 payload 下是否属于「会写文件 / 起进程 / 改外部状态」的动作。 */
export function isWriteChannel(channel: string, payload?: unknown): boolean {
  const match = /^feature:([a-z0-9-]+):([a-z0-9-]+)$/i.exec(channel)
  if (!match) return false
  const family = match[1].toLowerCase()
  const readActions = READ_ACTIONS[family]
  // 不在表里的功能域（agents / commands / rules / search / sidechat / tools）不参与门禁
  if (!readActions) return false
  const action = match[2].toLowerCase()
  if (action === 'action') return !readActions.has(`action:${payloadActionType(payload)}`)
  return !readActions.has(action)
}

function guardChannel(channel: string, payload: unknown): void {
  if (!isWriteChannel(channel, payload)) return
  let readOnly = true
  try {
    readOnly = readOnlyProbe()
  } catch {
    // 探针异常按只读处理：门禁判不出来时宁可拒绝，也不要静默放行写操作
    readOnly = true
  }
  if (readOnly) throw new ReadOnlyModeError()
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

export function registerFeatureHandler(channel: string, handler: FeatureHandler): void {
  if (!channel.startsWith('feature:')) {
    throw new Error(`feature channel 必须以 feature: 开头：${channel}`)
  }
  if (handlers.has(channel)) throw new Error(`feature channel 重复注册：${channel}`)
  handlers.set(channel, handler)
}

/** 在 app ready 后调用；会先 import 所有功能模块（副作用注册），再挂 IPC。 */
export function installFeatureIpc(): void {
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (event, payload): Promise<Result<unknown>> => {
      try {
        guardChannel(channel, payload)
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
    guardChannel(channel, payload)
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
