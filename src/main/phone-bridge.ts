/**
 * 桌面 → 手机的单向下行桥。
 *
 * ## 为什么单独一个模块
 *
 * `AgentService` 是产物链路上最热、最大的模块（6000+ 行）。如果它直接 import
 * `relay.ts`，就会把 Electron 的 `app`、`safeStorage`、TLS 栈一起拉进它的
 * 依赖图；而 `relay.ts` 又要在启动时反向拿 `AgentService` 的快照 —— 这就是
 * 一个环。用一个只有 setter/getter 的小模块打断它：
 *
 * - `agent.ts` 只管把事件交给 [publishPhoneEvent]；
 * - `relay.ts` 在启动时调用 [setPhonePublisher]，把事件接到当前 LAN 通道；
 * - `ipc.ts` 在注册 IPC 时调用 [setPhoneSnapshotProvider]，提供全量快照。
 *
 * 任何一侧没注册（relay 关闭、测试环境）时都是安全的 no-op —— 手机端会停在
 * 「未配对/未同步」而不是收到半份数据。
 */

/** 下行事件的最小形状。body 其余字段由 `phone-events.ts` 负责裁剪。 */
export interface PhoneEventPayload {
  type: string
  runId: string
  sessionId: string
  at: number
  [key: string]: unknown
}

type Publisher = (event: PhoneEventPayload) => void
type SnapshotProvider = () => unknown

let publisher: Publisher | null = null
let snapshotProvider: SnapshotProvider | null = null

/** 注册/替换发布器。传 null 表示断开（relay 关闭时调用）。 */
export function setPhonePublisher(next: Publisher | null): void {
  publisher = next
}

/** 注册/替换快照提供器。传 null 表示断开。 */
export function setPhoneSnapshotProvider(next: SnapshotProvider | null): void {
  snapshotProvider = next
}

/**
 * 发布一条事件。
 *
 * 发布失败**不能**影响桌面本身：`forward()` 是渲染进程与灵动岛的主链路，
 * 手机端只是旁观者。任何异常都在这里吞掉并计数，避免一个断开的 socket
 * 把桌面事件流整个打断。
 */
let droppedPublishes = 0
export function publishPhoneEvent(event: PhoneEventPayload): void {
  if (!publisher) return
  try {
    publisher(event)
  } catch {
    droppedPublishes += 1
  }
}

/** 取当前快照。没有提供器或提供器异常时返回 null（手机显示「正在同步」）。 */
export function buildPhoneSnapshot(): unknown | null {
  if (!snapshotProvider) return null
  try {
    return snapshotProvider()
  } catch {
    return null
  }
}

/** 诊断用：发布失败的次数（不暴露给界面） */
export function phoneBridgeStats(): { hasPublisher: boolean; hasSnapshot: boolean; droppedPublishes: number } {
  return { hasPublisher: publisher !== null, hasSnapshot: snapshotProvider !== null, droppedPublishes }
}