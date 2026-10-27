import { useEffect, useState } from 'react'
import { FileClock, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '../../ui'
import { useStudioStore } from './studio-store'
import { studioApi } from './api'

interface VersionRow {
  id: string
  createdAt: number
  reason: string
  revision: number
}

export function VersionHistoryPanel({ onClose }: { onClose?: () => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    studioApi.action<{ versions: VersionRow[] }>('list-versions', { projectId: active.id })
      .then((result) => {
        if (!cancelled) setVersions(result.versions)
      })
      .catch((err) => {
        if (!cancelled) notify('error', err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [active, notify])

  if (!active) return <p className="studio-hint">打开一部作品后可以查看历史版本。</p>

  const restore = async (version: VersionRow): Promise<void> => {
    setRestoring(version.id)
    try {
      await run('restore-version', { versionId: version.id })
      notify('success', '已经回到这一版；回来前的状态也留了一份。')
      onClose?.()
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className="studio-version-dialog">
      <div className="studio-version-dialog-head">
        <span><FileClock size={13} /> {active.title}</span>
        <b className="mono">现在是第 {active.revision} 版</b>
      </div>
      {loading ? (
        <div className="studio-version-loading"><Loader2 size={15} className="studio-spin" /> 正在读取历史版本…</div>
      ) : versions.length === 0 ? (
        <p className="studio-hint">还没有历史版本。确认蓝图、用候选或合成之后会自动出现。</p>
      ) : (
        <div className="studio-version-list">
          {versions.map((version) => (
            <div key={version.id} className="studio-version-row">
              <span className="studio-version-time mono">{new Date(version.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <div>
                <b>{version.reason}</b>
                              </div>
              <span className="mono">第 {version.revision} 版</span>
              <Button variant="ghost" size="sm" icon={restoring === version.id ? <Loader2 size={11} className="studio-spin" /> : <RotateCcw size={11} />} loading={restoring === version.id} onClick={() => void restore(version)}>
                回到这一版
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="studio-hint">历史版本存在这部作品里；回到旧版不会删除素材或任务记录。</p>
    </div>
  )
}
