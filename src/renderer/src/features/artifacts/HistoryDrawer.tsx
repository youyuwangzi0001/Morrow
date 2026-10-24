import { useCallback, useEffect, useState } from 'react'
import { Clock, History, RefreshCw, RotateCcw, TriangleAlert, X } from 'lucide-react'
import { formatBytes } from '@shared/usage'
import { DiffView } from '../../components/DiffView'
import { IconButton, Spinner } from '../../ui'
import { formatArtifactTime } from '../../lib'
import type { HistoryVersion } from './editor-api'
import type { EditorDocument, EditorHistorySelection } from './useEditorDocs'
import './editor.css'

export interface HistoryDrawerProps {
  doc: EditorDocument
  /** 当前会话/全局只读模式：查看历史可以，恢复写盘必须禁用 */
  readOnly?: boolean
  onClose: () => void
  loadVersions: (doc: EditorDocument) => Promise<HistoryVersion[]>
  loadDiff: (doc: EditorDocument, versionId: string) => Promise<EditorHistorySelection>
  onRestore: (doc: EditorDocument, versionId: string) => Promise<boolean>
}

const SOURCE_LABEL: Record<HistoryVersion['source'], string> = {
  user: '手动保存',
  agent: 'Morrow 修改',
  baseline: '打开时基线',
  restore: '版本恢复'
}

/**
 * 版本历史抽屉：右侧浮层，列出文件历史版本、与当前编辑器内容的 diff、恢复确认。
 * 数据全部来自主进程 feature:history:*；历史服务不可用时给出可读错误与重试。
 */
export function HistoryDrawer({
  doc,
  readOnly = false,
  onClose,
  loadVersions,
  loadDiff,
  onRestore
}: HistoryDrawerProps): React.JSX.Element {
  const [versions, setVersions] = useState<HistoryVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selection, setSelection] = useState<EditorHistorySelection | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await loadVersions(doc)
      setVersions(list)
      setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : list[0]?.id ?? null))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setVersions([])
    } finally {
      setLoading(false)
    }
  }, [doc, loadVersions])

  useEffect(() => {
    void load()
    // 保存后 mtime 变化 → 自动刷新版本列表（抽屉打开时也能看到新版本）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.absPath, doc.mtimeMs])

  useEffect(() => {
    if (!selectedId) {
      setSelection(null)
      return undefined
    }
    let cancelled = false
    setDiffLoading(true)
    setConfirming(false)
    loadDiff(doc, selectedId)
      .then((result) => {
        if (!cancelled) setSelection(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [doc, loadDiff, selectedId])

  const restore = async (): Promise<void> => {
    if (!selectedId || restoring) return
    setRestoring(true)
    try {
      const ok = await onRestore(doc, selectedId)
      if (ok) {
        setConfirming(false)
        await load()
      }
    } finally {
      setRestoring(false)
    }
  }

  return (
    <aside className="editor-history" aria-label="版本历史">
      <header className="editor-history-head">
        <span className="editor-history-icon" aria-hidden>
          <History size={14} strokeWidth={1.6} />
        </span>
        <div className="editor-history-copy">
          <span className="editor-history-title">版本历史</span>
          <span className="editor-history-sub mono" title={doc.relPath || doc.title}>
            {doc.relPath || doc.title}
          </span>
        </div>
        <IconButton label="刷新版本列表" size={24} onClick={() => void load()} disabled={loading}>
          <RefreshCw size={12} strokeWidth={1.6} />
        </IconButton>
        <IconButton label="关闭版本历史" size={24} onClick={onClose}>
          <X size={13} strokeWidth={1.6} />
        </IconButton>
      </header>

      <div className="editor-history-body">
        {loading ? (
          <div className="editor-history-status">
            <Spinner size={14} label="正在读取版本历史" />
            <span className="mono">正在读取版本…</span>
          </div>
        ) : error ? (
          <div className="editor-history-status is-error">
            <TriangleAlert size={15} strokeWidth={1.6} aria-hidden />
            <p>{error}</p>
            <button type="button" className="editor-text-btn" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : versions.length === 0 ? (
          <div className="editor-history-status">
            <Clock size={16} strokeWidth={1.5} aria-hidden />
            <p>还没有版本记录。</p>
            <p className="editor-history-hint">保存一次或让 Morrow 修改这个文件后，历史会出现在这里。</p>
          </div>
        ) : (
          <>
            <div className="editor-history-list" role="listbox" aria-label="历史版本列表">
              <div className="editor-history-list-head mono">
                <span>版本</span>
                <span>{versions.length} 个</span>
              </div>
              {versions.map((version) => (
                <button
                  key={version.id}
                  type="button"
                  role="option"
                  aria-selected={version.id === selectedId}
                  className={['editor-history-item', version.id === selectedId ? 'is-active' : ''].filter(Boolean).join(' ')}
                  onClick={() => setSelectedId(version.id)}
                >
                  <span className="editor-history-item-main">
                    <span className="editor-history-item-time mono">{formatArtifactTime(version.createdAt)}</span>
                    <span className={`editor-history-item-source mono is-${version.source}`}>
                      {SOURCE_LABEL[version.source] ?? version.source}
                    </span>
                  </span>
                  <span className="editor-history-item-meta mono">{formatBytes(version.size)}</span>
                </button>
              ))}
            </div>

            <div className="editor-history-detail">
              {diffLoading ? (
                <div className="editor-history-status">
                  <Spinner size={13} label="正在计算差异" />
                  <span className="mono">正在对比差异…</span>
                </div>
              ) : selection && selectedId ? (
                <>
                  <div className="editor-history-diff-head">
                    <span className="mono">
                      对比：{formatArtifactTime(selection.version.createdAt)} → {selection.targetLabel}
                    </span>
                    <span className="mono editor-history-diff-stats">
                      <span className="diff-add-count">+{selection.added}</span>
                      <span className="diff-del-count">-{selection.removed}</span>
                    </span>
                  </div>
                  <div className="editor-history-diff">
                    {selection.patch.trim() ? (
                      <DiffView patch={selection.patch} contextLines={2} maxHeight={340} />
                    ) : (
                      <p className="editor-history-hint">这个版本与当前内容没有差异。</p>
                    )}
                  </div>
                  <div className="editor-history-restore">
                    {confirming ? (
                      <div className="editor-history-confirm" role="alertdialog" aria-label="确认恢复版本">
                        <span>恢复后当前内容会被覆盖，并记录为一个新版本。</span>
                        {doc.dirty ? (
                          <span className="editor-history-dirty-warning">编辑器里还有未保存的修改，恢复后这些修改会丢失。</span>
                        ) : null}
                        <div className="editor-history-confirm-actions">
                          <button type="button" className="editor-text-btn" onClick={() => setConfirming(false)} disabled={restoring}>
                            取消
                          </button>
                          <button type="button" className="editor-text-btn is-danger" onClick={() => void restore()} disabled={restoring}>
                            {restoring ? '恢复中…' : '确认恢复'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="editor-text-btn"
                        onClick={() => setConfirming(true)}
                        disabled={readOnly || doc.readOnly}
                        title={readOnly ? '当前是只读模式，不能恢复版本' : undefined}
                      >
                        <RotateCcw size={12} strokeWidth={1.7} aria-hidden />
                        恢复到这个版本
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <p className="editor-history-hint">选择一个版本查看差异。</p>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
