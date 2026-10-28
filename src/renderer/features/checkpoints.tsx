// checkpoints 功能域组件：由 1 个 TSX 文件扁平合并。
import './checkpoints.css'
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, History, RotateCcw, ShieldAlert } from 'lucide-react'
import type { RewindPreview, TurnCheckpoint } from '@shared/types'
import { useAppStore } from '../store'
import { Modal } from '../components'



const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})


/** 显示文件夹相对路径，避免一长串 C:\... 干扰确认。 */
function displayPath(path: string, workspace: string | null | undefined): string {
  if (!workspace) return path
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = normalize(workspace)
  const candidate = normalize(path)
  if (candidate.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return candidate.slice(root.length + 1)
  }
  return path
}


/**
 * 回退确认：入口在回答末尾的操作栏，这里只负责“确认一次”。
 * 确认后固定同时回退对话进度与这一轮改过的文件，不再提供分散的范围面板。
 */
export function RewindConfirm(): React.JSX.Element | null {
  const open = useAppStore((s) => s.rewindOpen)
  const targetMessageId = useAppStore((s) => s.rewindTargetMessageId)
  const close = useAppStore((s) => s.closeRewind)
  const rewindTo = useAppStore((s) => s.rewindTo)
  const session = useAppStore((s) => s.session)
  const running = useAppStore((s) => s.run?.sessionId === s.session?.id)

  const [checkpoint, setCheckpoint] = useState<TurnCheckpoint | null>(null)
  const [preview, setPreview] = useState<RewindPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!open) return
    const sessionId = session?.id
    if (!sessionId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setCheckpoint(null)
    setPreview(null)
    void (async () => {
      const list = await window.morrow.checkpoints.list(sessionId)
      if (!list.ok) throw new Error(list.error.message)
      const found = targetMessageId
        ? (list.data.find((item) => item.id === targetMessageId || item.messageId === targetMessageId) ?? null)
        : (list.data[0] ?? null)
      if (!found) {
        throw new Error(
          targetMessageId ? '这个阶段没有可回退的记录，可能还没有产生文件或对话变更。' : '还没有可回退的轮次。'
        )
      }
      if (cancelled) return
      setCheckpoint(found)
      const result = await window.morrow.checkpoints.preview(sessionId, found.id)
      if (!result.ok) throw new Error(result.error.message)
      if (!cancelled) setPreview(result.data)
    })()
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取回退信息失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, session?.id, targetMessageId, nonce])

  const goalBlocked = Boolean(session?.goal && !['completed', 'cancelled'].includes(session.goal.status))
  const blockedReason = running
    ? '对话还在运行：先停止，再回退。'
    : goalBlocked
      ? '先结束或清除当前目标，再回退。'
      : null
  const conflicts = preview?.conflicts ?? []
  const canConfirm = Boolean(
    preview && !loading && !busy && !blockedReason && conflicts.length === 0 && preview.messageFound
  )

  const summary = useMemo(() => {
    if (!preview) return ''
    const stage = checkpoint?.kind === 'stage'
    const filePart =
      preview.fileCount > 0
        ? stage
          ? `把 ${preview.fileCount} 个文件恢复到该阶段完成时`
          : `恢复 ${preview.fileCount} 个文件`
        : stage
          ? '文件保持该阶段完成时的状态'
          : '这一轮没有文件改动'
    const chatPart = preview.messageFound
      ? stage
        ? `保留这个阶段，移除其后的 ${preview.removableMessages} 条对话`
        : `移除从这一轮开始的 ${preview.removableMessages} 条对话`
      : '对话无法回退'
    return `将${filePart}，并${chatPart}。`
  }, [preview, checkpoint?.kind])

  const confirm = async (): Promise<void> => {
    if (!checkpoint || !canConfirm) return
    setBusy(true)
    const result = await rewindTo(checkpoint.id, 'both')
    setBusy(false)
    if (result.ok) {
      close()
      return
    }
    setError(result.error ?? '回退失败')
    setNonce((value) => value + 1)
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="确认回退？"
      description={
        checkpoint?.kind === 'stage'
          ? '对话和文件会一起回到这个阶段完成时。这一步不能撤销。'
          : '对话和文件会一起回到这一轮开始前。这一步不能撤销。'
      }
      width={520}
      ariaLabel="确认回退"
      footer={
        <>
          <button type="button" className="rewind-btn" onClick={close} disabled={busy}>
            取消
          </button>
          <button type="button" className="rewind-btn is-primary" disabled={!canConfirm} onClick={() => void confirm()}>
            <RotateCcw size={13} strokeWidth={1.6} aria-hidden />
            {busy ? '正在回退…' : '确认回退'}
          </button>
        </>
      }
    >
      <div className="rewind-confirm">
        {loading ? <p className="rewind-confirm-note">正在检查文件和对话…</p> : null}

        {checkpoint ? (
          <div className="rewind-confirm-turn">
            <History size={13} strokeWidth={1.6} aria-hidden />
            <span className="rewind-confirm-time mono">
              {checkpoint.createdAt ? TIME_FORMAT.format(new Date(checkpoint.createdAt)) : ''}
            </span>
            <span className="rewind-confirm-label">{checkpoint.label}</span>
          </div>
        ) : null}

        {preview ? (
          <>
            <p className="rewind-confirm-summary">{summary}</p>
            {preview.files.length > 0 ? (
              <ul className="rewind-confirm-files" aria-label="会处理的文件">
                {preview.files.map((file) => (
                  <li key={file.path} className={file.conflict ? 'is-conflict' : ''}>
                    <span className="mono rewind-confirm-path" title={file.path}>
                      {displayPath(file.path, session?.workspace)}
                    </span>
                    <span className="rewind-confirm-action">
                      {file.existed ? '恢复旧内容' : '删除新文件'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}

        {conflicts.length > 0 ? (
          <div className="rewind-confirm-conflicts" role="alert">
            <p className="rewind-confirm-conflicts-head">
              <ShieldAlert size={13} strokeWidth={1.6} aria-hidden />
              有 {conflicts.length} 个文件被改过，暂时不能恢复
            </p>
            <ul>
              {conflicts.map((conflict) => (
                <li key={conflict.path}>
                  <span className="mono" title={conflict.path}>
                    {displayPath(conflict.path, session?.workspace)}
                  </span>
                  <span>{conflict.reason}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="rewind-confirm-recheck"
              onClick={() => {
                setError(null)
                setNonce((value) => value + 1)
              }}
            >
              重新检查
            </button>
          </div>
        ) : null}

        {!preview?.messageFound && preview ? (
          <p className="rewind-confirm-warning">
            <AlertTriangle size={13} strokeWidth={1.6} aria-hidden />
            这一轮对话已被压缩，无法回退对话进度。
          </p>
        ) : null}

        {blockedReason ? (
          <p className="rewind-confirm-warning">
            <AlertTriangle size={13} strokeWidth={1.6} aria-hidden />
            {blockedReason}
          </p>
        ) : null}

        {error ? (
          <p className="rewind-confirm-error" role="alert">
            {error}
          </p>
        ) : null}

        <p className="rewind-confirm-note">
          只会处理 Morrow 通过写文件工具改过的文件；你后来手动改过的文件不会被强行覆盖。
        </p>
      </div>
    </Modal>
  )
}
