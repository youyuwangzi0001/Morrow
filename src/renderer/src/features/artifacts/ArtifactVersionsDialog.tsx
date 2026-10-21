import { useCallback, useEffect, useState } from 'react'
import { Clock, RotateCcw, TriangleAlert } from 'lucide-react'
import type { ArtifactVersionInfo } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Button, Modal, Spinner } from '../../ui'
import './ArtifactDialogs.css'

const SOURCE_LABEL: Record<ArtifactVersionInfo['source'], string> = {
  baseline: '初始版本',
  agent: 'Morrow 修改',
  restore: '恢复记录',
  manual: '手动保存'
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  if (date.toDateString() === now.toDateString()) return time
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function ArtifactVersionsDialog({
  open,
  onClose,
  sessionId,
  artifactId,
  artifactTitle
}: {
  open: boolean
  onClose: () => void
  sessionId: string
  artifactId: string
  artifactTitle: string
}): React.JSX.Element {
  const loadArtifactVersions = useAppStore((s) => s.loadArtifactVersions)
  const readArtifactVersion = useAppStore((s) => s.readArtifactVersion)
  const restoreArtifactVersion = useAppStore((s) => s.restoreArtifactVersion)
  const [versions, setVersions] = useState<ArtifactVersionInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const list = await loadArtifactVersions(sessionId, artifactId)
      setVersions(list)
      setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : list[0]?.id ?? null))
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取版本历史失败')
      setVersions([])
    } finally {
      setLoading(false)
    }
  }, [artifactId, loadArtifactVersions, sessionId])

  useEffect(() => {
    if (!open) return
    setSelectedId(null)
    setPreview(null)
    setConfirming(false)
    void load()
  }, [open, artifactId, load])

  useEffect(() => {
    if (!open || !selectedId) {
      setPreview(null)
      return undefined
    }
    let cancelled = false
    setPreviewLoading(true)
    setConfirming(false)
    readArtifactVersion(sessionId, artifactId, selectedId)
      .then((result) => {
        if (!cancelled) setPreview(result.content)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取版本内容失败')
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [artifactId, open, readArtifactVersion, selectedId, sessionId])

  const selected = versions.find((item) => item.id === selectedId) ?? null
  const isCurrent = Boolean(selected && versions[0] && selected.id === versions[0].id)

  const restore = async (): Promise<void> => {
    if (!selected || restoring) return
    setRestoring(true)
    setError(null)
    try {
      await restoreArtifactVersion(sessionId, artifactId, selected.id)
      setConfirming(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复版本失败')
    } finally {
      setRestoring(false)
    }
  }

  const footer = (
    <div className="artifact-dialog-foot">
      <span className="artifact-dialog-note mono">
        {versions.length > 0
          ? `${versions.length} 个版本 · 最多保留 30 个${isCurrent ? ' · 当前是最新版本' : ''}`
          : '版本只保存在本机'}
      </span>
      <div className="artifact-dialog-actions">
        {confirming ? (
          <>
            <span className="artifact-restore-ask">恢复会覆盖当前内容，但当前版本会保留。</span>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={restoring}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void restore()} disabled={restoring}>
              {restoring ? '恢复中…' : '确认恢复'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            {!isCurrent ? (
              <Button
                variant="primary"
                onClick={() => setConfirming(true)}
                disabled={!selected || loading || previewLoading}
              >
                <RotateCcw size={13} strokeWidth={1.7} aria-hidden />
                恢复此版本
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="版本历史"
      description={`${artifactTitle} · 每次内容变化都会留下一份快照；恢复会覆盖当前内容，也会记录成新版本。`}
      width={780}
      footer={footer}
    >
      <div className="artifact-versions-body">
        {loading ? (
          <div className="artifact-versions-status">
            <Spinner size={14} label="正在读取版本历史" />
            <span className="mono">正在读取版本…</span>
          </div>
        ) : error && versions.length === 0 ? (
          <div className="artifact-versions-status is-error">
            <TriangleAlert size={16} strokeWidth={1.6} aria-hidden />
            <p>{error}</p>
            <button type="button" className="artifact-text-btn" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : versions.length === 0 ? (
          <div className="artifact-versions-status">
            <Clock size={17} strokeWidth={1.5} aria-hidden />
            <p>还没有版本记录。</p>
            <p className="artifact-versions-hint">二进制文件不做版本快照；让 Morrow 修改成品或重新打开历史后，这里会出现记录。</p>
          </div>
        ) : (
          <>
            <div className="artifact-versions-list" role="listbox" aria-label="成品版本列表">
              <div className="artifact-versions-list-head mono">
                <span>版本</span>
                <span>{versions.length} 个</span>
              </div>
              {versions.map((version, index) => (
                <button
                  key={version.id}
                  type="button"
                  role="option"
                  aria-selected={version.id === selectedId}
                  className={['artifact-version-item', version.id === selectedId ? 'is-active' : ''].filter(Boolean).join(' ')}
                  onClick={() => setSelectedId(version.id)}
                >
                  <span className="artifact-version-main">
                    <span className="artifact-version-time mono">{formatTime(version.createdAt)}</span>
                    {index === 0 ? <span className="artifact-version-current mono">当前</span> : null}
                  </span>
                  <span className="artifact-version-meta">
                    <span className={`artifact-version-source mono is-${version.source}`}>
                      {SOURCE_LABEL[version.source] ?? version.source}
                    </span>
                    <span className="artifact-version-size mono">{formatSize(version.size)}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="artifact-version-detail">
              <div className="artifact-version-detail-head mono">
                <span>{selected ? `${formatTime(selected.createdAt)} · ${SOURCE_LABEL[selected.source]}` : ''}</span>
                <span>{isCurrent ? '当前内容' : '历史快照'}</span>
              </div>
              <div className="artifact-version-preview">
                {previewLoading ? (
                  <div className="artifact-versions-status">
                    <Spinner size={13} label="正在读取版本内容" />
                    <span className="mono">正在读取…</span>
                  </div>
                ) : (
                  <pre className="artifact-version-pre mono selectable">
                    {preview !== null && preview.length > 0 ? preview.slice(0, 500_000) : '这个版本没有可预览的文本。'}
                  </pre>
                )}
              </div>
              {error ? <p className="artifact-version-error">{error}</p> : null}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
