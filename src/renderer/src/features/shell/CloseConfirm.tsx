import { useEffect, useState } from 'react'
import { Minus, Power } from 'lucide-react'
import { Button, Modal } from '../../ui'
import './CloseConfirm.css'

type Choice = 'minimize' | 'quit'

/**
 * 关闭询问：标题栏关闭按钮、Alt+F4 与灵动岛“关闭 Morrow…”共用同一选择。
 * 选定后由主进程记住 closeAction，后续直接执行、不再询问。
 */
export function CloseConfirm(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<Choice | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () =>
      window.morrow.window.onCloseRequested(() => {
        setBusy(null)
        setError(null)
        setOpen(true)
      }),
    []
  )

  const choose = async (action: Choice): Promise<void> => {
    if (busy) return
    setBusy(action)
    setError(null)
    const result = await window.morrow.window.resolveClose(action)
    if (!result.ok) {
      setBusy(null)
      setError(result.error.message)
      return
    }
    // 最小化时主进程会保留窗口；退出时进程结束，这个弹窗无需再手动收起。
    setOpen(false)
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) setOpen(false)
      }}
      title="要关闭 Morrow 吗？"
      description="选定一次后会记住，可在 设置 → 外观 随时修改。"
      width={520}
      ariaLabel="关闭 Morrow 的方式"
      footer={
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
          取消
        </Button>
      }
    >
      <div className="close-choice-grid">
        <button
          type="button"
          className="close-choice"
          disabled={busy !== null}
          onClick={() => void choose('minimize')}
        >
          <span className="close-choice-icon" aria-hidden>
            <Minus size={18} strokeWidth={1.7} />
          </span>
          <span className="close-choice-copy">
            <strong>最小化到任务栏</strong>
            <span>Morrow 留在后台继续运行，正在执行的任务不会中断。</span>
          </span>
        </button>
        <button
          type="button"
          className="close-choice is-danger"
          disabled={busy !== null}
          onClick={() => void choose('quit')}
        >
          <span className="close-choice-icon" aria-hidden>
            <Power size={18} strokeWidth={1.7} />
          </span>
          <span className="close-choice-copy">
            <strong>完全退出</strong>
            <span>结束后台任务，关闭 Morrow 的所有窗口与进程。</span>
          </span>
        </button>
      </div>
      {error ? (
        <p className="close-choice-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  )
}
