import type {
  PairDeviceView,
  PairIssueResult,
  Result
} from '../shared/types'
import { PairingError, TICKET_TTL_MS, type PairingService } from './pairing'

/**
 * 设置页「手机配对」的后端逻辑。
 *
 * ## 为什么单独一层，而不是直接写在 IPC handler 里
 *
 * `ipcMain.handle` 的回调必须拿 `electron` 的环境，单元测试里既起不来也断言不了。
 * 把逻辑抽到这里之后，测试可以对着**真实的 PairingService** 跑，
 * IPC 那层只剩「转发 + 把异常翻成 Result」，不再承载任何判断。
 *
 * ## 为什么每个函数都接受 `PairingService | null`
 *
 * 远程通道默认关闭（`relayEnabled: false`）。关着的时候，配对服务**不存在** ——
 * 这时候「生成配对码」必须明确报错，而不是：
 * - 临时 new 一个（会生成新的桌面密钥，所有已配对手机立即失效）；
 * - 返回一个空票据（用户扫了必然失败，且提示指向别处）。
 *
 * 所以错误码单列一个 `RELAY_DISABLED`，界面据此提示「先打开远程通道」。
 */

export const RELAY_DISABLED = 'RELAY_DISABLED'

/** 把内部异常翻成界面上能用的错误码，不把栈信息丢给渲染进程 */
function toResultError(err: unknown): { code: string; message: string } {
  if (err instanceof PairingError) {
    return { code: err.code, message: err.message }
  }
  return { code: 'PAIR_FAILED', message: err instanceof Error ? err.message : '配对操作失败' }
}

/**
 * 签发票据。
 *
 * 调用方要给 `phonePubKey` —— 票据里的 `pubKey` 必须**是手机自己的公钥**
 * （手机侧会校验归属，见 `EcdhPairing` 的 §4.5）。所以桌面不能凭空生成一张票，
 * 必须先拿到手机侧的配对请求。
 *
 * 这也是当前「手动粘贴」方案的真实代价：没有相机扫码时，
 * 手机侧要把 deviceId + 公钥给到桌面一次。报告里如实记着这一点。
 */
export function issuePairTicket(
  pairing: PairingService | null,
  input: { deviceId: string; phonePubKey: string; relayHint?: string }
): Result<PairIssueResult> {
  if (!pairing) {
    return {
      ok: false,
      error: { code: RELAY_DISABLED, message: '远程通道没有开启。先在「远程通道」里打开它，再生成配对码。' }
    }
  }
  try {
    const { ticket, code, qr } = pairing.issueTicket(input.deviceId, input.phonePubKey, input.relayHint)
    return {
      ok: true,
      data: {
        qr,
        code,
        // 用票据里的 exp，不是「现在 + TTL」—— 那样界面倒计时会与票据真实寿命差几毫秒
        expiresAt: ticket.exp,
        nonce: ticket.nonce,
        // 指纹缺失时手机侧会拒绝完成配对，界面必须当场提示而不是让用户白扫
        hasFingerprint: typeof ticket.fingerprint === 'string' && ticket.fingerprint.length > 0
      }
    }
  } catch (err) {
    return { ok: false, error: toResultError(err) }
  }
}

/** 已配对设备。不返回 sessionKey（界面上不需要，泄露了也没用，但没必要送出去）。 */
export function listPairDevices(pairing: PairingService | null): Result<PairDeviceView[]> {
  if (!pairing) {
    return {
      ok: false,
      error: { code: RELAY_DISABLED, message: '远程通道没有开启。' }
    }
  }
  try {
    return { ok: true, data: pairing.listDevices() }
  } catch (err) {
    return { ok: false, error: toResultError(err) }
  }
}

/**
 * 撤销设备。
 *
 * `PairingService.revokeDevice` 每次都查内存表、且撤销后立即落盘，
 * 所以撤销之后**下一次** `requirePaired` 就会抛 `DEVICE_REVOKED` —— 同一请求内生效。
 * 这里把「不存在的设备」与「撤销成功」区分开：前者返回 `revoked: false`，
 * 让界面能提示「这台设备已经不在了」而不是假装成功。
 */
export function revokePairDevice(
  pairing: PairingService | null,
  deviceId: string
): Result<{ revoked: boolean }> {
  if (!pairing) {
    return {
      ok: false,
      error: { code: RELAY_DISABLED, message: '远程通道没有开启。' }
    }
  }
  if (!deviceId || typeof deviceId !== 'string') {
    return { ok: false, error: { code: 'INVALID_DEVICE_ID', message: '设备标识为空' } }
  }
  try {
    return { ok: true, data: { revoked: pairing.revokeDevice(deviceId) } }
  } catch (err) {
    return { ok: false, error: toResultError(err) }
  }
}

/**
 * 票据剩余毫秒数。界面倒计时用它，**不用自己减** ——
 * 渲染进程与主进程的时钟可能有偏差，而 `exp` 是主进程算的。
 */
export function remainingMs(expiresAt: number, now = Date.now()): number {
  return Math.max(0, expiresAt - now)
}

/** 票据是否已过期。界面据此把「扫这里」换成「已过期，重新生成」。 */
export function isExpired(expiresAt: number, now = Date.now()): boolean {
  return now > expiresAt
}

/** 供界面显示的票据 TTL（秒），避免渲染进程里写死 90 */
export const PAIR_TTL_SECONDS = Math.round(TICKET_TTL_MS / 1000)
