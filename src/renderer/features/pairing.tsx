import './pairing.css'

import { Copy, QrCode, RefreshCw, ShieldOff, Smartphone, Trash2, Unplug } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  PAIR_REQUEST_PREFIX,
  PAIR_TTL_MS,
  deviceLabel,
  deviceListPhase,
  formatPairedAt,
  pairPanelView,
  parsePairRequest,
  revokeConfirmText
} from '@shared/pair-panel'
import type { PairDeviceView, PairIssueResult, Result } from '@shared/types'
import { Badge, Button, IconButton, Switch, TextArea } from '../components'
import { errorText } from '../components'
import { useAppStore } from '../store'

/**
 * 设置 → 手机配对。
 *
 * ## 这个面板解决的是「链路根本走不通」
 *
 * E2c 之后票据里已经有了证书指纹，但桌面 `issueTicket` **没有任何生产调用方**，
 * 也没有配对入口 —— 用户无法从电脑上生成配对码，真机链路仍然跑不起来。
 * 这个面板就是那个缺失的入口。
 *
 * ## 为什么先要「配对请求」
 *
 * 票据里的 `pubKey` 必须是**手机自己的公钥**（手机侧会校验归属），
 * 六位码也是用「手机公钥 + 桌面私钥」算出来的。所以桌面不能凭空签票：
 * 必须先拿到手机的公钥。手机端把 `MORROWPAIR1.<base64url>` 复制出来，
 * 用户粘到这里，桌面才能签发一张真正能配上的票。
 *
 * 这一段在报告里必须写清楚 —— 「手动粘贴」不是降级实现，
 * 而是「没有相机扫码时，两段数据仍要走完同一条协议」的最小可行形态。
 *
 * ## 四种状态要分开
 *
 * 未开启远程通道 / 还没请求 / 有票据倒计时中 / 已过期。
 * 合并任意两种，用户都会对着一个不存在的入口反复点。
 */
export function PairingTab(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const notify = useAppStore((s) => s.notify)
  const copyText = useAppStore((s) => s.copyText)

  const [request, setRequest] = useState('')
  const [ticket, setTicket] = useState<PairIssueResult | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [issueError, setIssueError] = useState<string | null>(null)

  const [devices, setDevices] = useState<PairDeviceView[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  // 每秒重算一次，让倒计时与「已过期」真的会变。
  // 用 setInterval 而不是 CSS 动画：文案要换（「扫这里」→「已过期，重新生成」），
  // 而 CSS 只能改外观。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticket) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticket])

  const loadDevices = useCallback(async (): Promise<void> => {
    setListLoading(true)
    setListError(null)
    try {
      const result = (await window.morrow.relayPair.list()) as Result<PairDeviceView[]>
      if (!result.ok) {
        setListError(result.error.message)
        setDevices([])
        return
      }
      setDevices(result.data)
    } catch (err) {
      setListError(errorText(err, '读取已配对设备失败。'))
      setDevices([])
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDevices()
  }, [loadDevices])

  // 开关从关变开时**必须重读设备列表**。
  // 关着的时候 `currentPairing()` 是 null，列表拿到 `RELAY_DISABLED`，
  // 界面显示「远程通道没有开启」。打开开关后若不重读，那句话会一直留着 ——
  // 用户刚打开开关就看到「没有开启」，会以为开关坏了。
  // （真实渲染截图抓到的：switch 是 checked，列表却还说没开启。）
  useEffect(() => {
    if (settings.relayEnabled) void loadDevices()
  }, [settings.relayEnabled, loadDevices])

  const view = useMemo(() => pairPanelView(ticket, now), [ticket, now])
  const requestParse = useMemo(() => (request.trim() ? parsePairRequest(request) : null), [request])
  const listPhase = deviceListPhase({ loading: listLoading, error: listError, devices })

  const toggleRelay = async (next: boolean): Promise<void> => {
    try {
      await updateSettings({ relayEnabled: next })
    } catch (err) {
      // 设置已落盘但通道没起来时，主进程会返回 RELAY_START_FAILED。
      // store 里已经 notify 过一次，这里不再重复弹。
      void err
    }
  }

  const issue = async (): Promise<void> => {
    setIssueError(null)
    const parsed = parsePairRequest(request)
    if (!parsed.ok) {
      setIssueError(parsed.reason)
      return
    }
    setIssuing(true)
    try {
      const result = (await window.morrow.relayPair.issue({
        deviceId: parsed.deviceId ?? `phone-${Date.now().toString(36)}`,
        phonePubKey: parsed.pubKey
      })) as Result<PairIssueResult>
      if (!result.ok) {
        setIssueError(result.error.message)
        return
      }
      setTicket(result.data)
      setNow(Date.now())
    } catch (err) {
      setIssueError(errorText(err, '生成配对码失败。'))
    } finally {
      setIssuing(false)
    }
  }

  const revoke = async (device: PairDeviceView): Promise<void> => {
    if (!window.confirm(revokeConfirmText(device))) return
    setRevokingId(device.deviceId)
    try {
      const result = (await window.morrow.relayPair.revoke(device.deviceId)) as Result<{ revoked: boolean }>
      if (!result.ok) {
        notify('error', result.error.message)
        return
      }
      if (!result.data.revoked) {
        // 撤销一台本来就不在表里的设备：如实说，不要显示「撤销成功」
        notify('warning', '这台设备已经不在配对列表里了，刷新一下就好。')
      } else {
        notify('success', `已撤销「${deviceLabel(device)}」`)
      }
      await loadDevices()
    } catch (err) {
      notify('error', errorText(err, '撤销失败。'))
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div className="st-pair">
      <p className="st-hint">
        手机装好 Morrow 安卓版后，用这里的配对码连上这台电脑。之后手机上能实时看到进度、也能派任务过来。
      </p>

      {/* ① 远程通道开关：不打开的话下面什么都做不了，所以放最前面 */}
      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">远程通道</span>
          <span className="st-setting-desc">
            打开后这台电脑才会接受手机连接。默认关闭；关掉时端口不会保留。
          </span>
        </div>
        <Switch
          checked={settings.relayEnabled}
          onChange={(next) => void toggleRelay(next)}
          label="远程通道"
        />
      </div>

      {!settings.relayEnabled ? (
        <div className="st-pair-gate">
          <Unplug size={18} strokeWidth={1.5} aria-hidden />
          <div>
            <p className="st-pair-gate-title">远程通道现在是关的</p>
            <p className="st-pair-gate-desc">
              打开上面的开关再回来。关着的时候生成配对码会失败 —— 那不是电脑坏了。
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* ② 第一步：粘贴手机上的配对请求 */}
          <h3 className="st-section-title st-pair-step">第一步 · 从手机拿到配对请求</h3>
          <p className="st-hint">
            在手机上打开「设置 → 配对」，点「复制配对请求」，把那串以 {PAIR_REQUEST_PREFIX} 开头的内容粘到这里。
          </p>
          <TextArea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={3}
            className="st-pair-request"
            placeholder={`${PAIR_REQUEST_PREFIX}eyJkZXZpY2VJZCI6...`}
            aria-label="手机配对请求"
          />
          {requestParse && !requestParse.ok ? <p className="st-pair-error">{requestParse.reason}</p> : null}
          <div className="st-pair-actions">
            <Button
              variant="gold"
              icon={<QrCode size={13} strokeWidth={1.5} />}
              loading={issuing}
              disabled={!request.trim() || (requestParse !== null && !requestParse.ok)}
              onClick={() => void issue()}
            >
              生成配对码
            </Button>
          </div>
          {issueError ? <p className="st-pair-error">{issueError}</p> : null}

          {/* ③ 第二步：把配对码交给手机 */}
          {ticket ? (
            <>
              <h3 className="st-section-title st-pair-step">
                第二步 · 把配对码交给手机
                {view.phase === 'expired' ? <Badge tone="danger">已过期</Badge> : null}
                {view.phase === 'live' && view.urgent ? <Badge tone="warning">快没时间了</Badge> : null}
              </h3>

              {view.hint ? (
                <p className={view.phase === 'expired' ? 'st-pair-warn' : 'st-pair-error'}>{view.hint}</p>
              ) : null}

              {view.phase === 'live' ? (
                <>
                  <div className="st-pair-countdown" aria-live="polite">
                    <div className="st-pair-countdown-bar">
                      <span
                        className={view.urgent ? 'is-urgent' : ''}
                        style={{ width: `${Math.round(view.remainingRatio * 100)}%` }}
                      />
                    </div>
                    <span className={`st-pair-countdown-num mono ${view.urgent ? 'is-urgent' : ''}`}>
                      剩余 {view.remainingSeconds} 秒
                    </span>
                  </div>

                  <div className="st-pair-code-row">
                    <span className="st-pair-code mono">{ticket.code}</span>
                    <span className="st-pair-code-label">
                      电脑上显示这六位；手机输入后两边核对。
                    </span>
                  </div>

                  <div className="st-pair-qr-box">
                    <span className="st-pair-qr-label">
                      配对码文本 · {ticket.qr.length} 字符（整段复制）
                    </span>
                    <code className="mono selectable st-pair-qr-text">{ticket.qr}</code>
                    <IconButton label="复制配对码" size={26} onClick={() => void copyText(ticket.qr)}>
                      <Copy size={12} strokeWidth={1.5} aria-hidden />
                    </IconButton>
                  </div>
                </>
              ) : (
                // 过期后必须把配对码**藏起来**：继续显示会让用户拿一张废票去扫，
                // 而手机上只会说「配对码已过期」，锅看起来在手机那边。
                <div className="st-pair-expired">
                  <ShieldOff size={18} strokeWidth={1.5} aria-hidden />
                  <div>
                    <p className="st-pair-gate-title">这张配对码已经失效</p>
                    <p className="st-pair-gate-desc">配对码只有 {Math.round(PAIR_TTL_MS / 1000)} 秒有效期。重新生成一张，手机上用新的那张。</p>
                  </div>
                </div>
              )}

              <div className="st-pair-actions">
                <Button
                  variant={view.phase === 'expired' ? 'gold' : 'secondary'}
                  icon={<RefreshCw size={13} strokeWidth={1.5} />}
                  loading={issuing}
                  disabled={requestParse !== null && !requestParse.ok}
                  onClick={() => void issue()}
                >
                  {view.phase === 'expired' ? '重新生成' : '换一张'}
                </Button>
              </div>
            </>
          ) : (
            <p className="st-hint">还没生成配对码。上面粘好请求后点「生成配对码」。</p>
          )}
        </>
      )}

      {/* ④ 已配对设备 */}
      <h3 className="st-section-title st-pair-step">已配对的手机</h3>
      {listPhase === 'loading' ? (
        // 「读取中」不能说成「还没有」—— 那会让用户以为设备被清掉了
        <p className="st-hint">正在读取…</p>
      ) : listPhase === 'error' ? (
        <p className="st-pair-error">{listError}</p>
      ) : listPhase === 'empty' ? (
        <p className="st-hint">还没有配对的手机。配对成功后，这里会列出来，随时可以撤销。</p>
      ) : (
        <ul className="st-pair-devices">
          {devices.map((d) => (
            <li key={d.deviceId} className="st-pair-device">
              <Smartphone size={15} strokeWidth={1.5} aria-hidden />
              <div className="st-pair-device-copy">
                <span className="st-pair-device-name">{deviceLabel(d)}</span>
                <span className="st-pair-device-meta mono">{formatPairedAt(d.pairedAt)}</span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={12} strokeWidth={1.5} />}
                loading={revokingId === d.deviceId}
                onClick={() => void revoke(d)}
              >
                撤销
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="st-hint st-pair-foot">
        撤销后，那台手机下一次请求会立刻被拒绝，需要重新配对。手机丢了或被借走时，第一件事就是来这里撤销。
      </p>
    </div>
  )
}
