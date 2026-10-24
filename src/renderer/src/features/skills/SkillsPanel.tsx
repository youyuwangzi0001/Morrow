/**
 * R10-H 技能库面板。
 *
 * 独立受控组件（Lead 挂载）：`<SkillsPanel open={open} onClose={onClose} />`
 * - 列出「文件夹自带技能」与「我的技能」；搜索 / 启用状态筛选 / 排序；
 * - 详情：描述、来源、路径、文件清单、SKILL.md 原文；
 * - 启用 / 禁用（Agent 的 list_skills / read_skill / 系统提示只看到已启用技能）；
 * - 从本地文件夹或 .zip 安装到我的技能（主进程做 zip-slip/大小/白名单校验）；
 * - 删除用户技能、打开目录、重新扫描、错误态。
 *
 * 不联网、不接市场；所有操作都走 `feature:skills:*` IPC。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Copy,
  FileText,
  FolderOpen,
  Library,
  Package,
  Power,
  RefreshCw,
  Search,
  Trash2,
  Upload
} from 'lucide-react'
import { useAppStore } from '../../store'
import { formatBytes } from '@shared/usage'
import { Badge, Button, ErrorNote, IconButton, Modal, Segmented, Spinner } from '../../ui'
import { skillsApi } from './skills-client'
import type { SkillDetail, SkillFilter, SkillsSnapshot, SkillSort, SkillView } from './skills-client'
import { errorText } from '../../lib'
import './SkillsPanel.css'

export interface SkillsPanelProps {
  open: boolean
  onClose: () => void
}

const FILTER_OPTIONS: Array<{ value: SkillFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '已启用' },
  { value: 'disabled', label: '已禁用' }
]

const SORT_OPTIONS: Array<{ value: SkillSort; label: string }> = [
  { value: 'name', label: '按名称' },
  { value: 'updated', label: '按更新时间' }
]



function formatTime(timestamp: number | null): string {
  if (!timestamp) return '未知'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '未知'
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay) {
    return `今天 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return `昨天 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function sourceLabel(skill: Pick<SkillView, 'source' | 'builtin'>): string {
  if (skill.builtin) return '内置技能'
  return skill.source === 'user' ? '我的技能' : '当前文件夹'
}

function shortenPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 3 ? path : `…/${parts.slice(-2).join('/')}`
}

export function SkillsPanel({ open, onClose }: SkillsPanelProps): React.JSX.Element {
  const workspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace ?? null)
  const notify = useAppStore((s) => s.notify)
  const copyText = useAppStore((s) => s.copyText)

  const [snapshot, setSnapshot] = useState<SkillsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SkillFilter>('all')
  const [sort, setSort] = useState<SkillSort>('name')

  const [installOpen, setInstallOpen] = useState(false)
  const [installPath, setInstallPath] = useState('')
  const [installBusy, setInstallBusy] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [pickBusy, setPickBusy] = useState<'zip' | 'folder' | null>(null)
  const [dragging, setDragging] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SkillView | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const loadSeq = useRef(0)

  const load = useCallback(
    async (options: { selectId?: string | null; silent?: boolean } = {}): Promise<void> => {
      const seq = ++loadSeq.current
      if (!options.silent) setLoading(true)
      setLoadError(null)
      try {
        const next = await skillsApi.list(workspace)
        if (seq !== loadSeq.current) return
        setSnapshot(next)
        setSelectedId((prev) => {
          const wanted = options.selectId !== undefined ? options.selectId : prev
          if (wanted && next.skills.some((skill) => skill.id === wanted)) return wanted
          return next.skills[0]?.id ?? null
        })
      } catch (err) {
        if (seq === loadSeq.current) setLoadError(errorText(err))
      } finally {
        if (seq === loadSeq.current) setLoading(false)
      }
    },
    [workspace]
  )

  // 面板打开时加载列表；文件夹切换时重新加载
  useEffect(() => {
    if (!open) return
    setActionError(null)
    setQuery('')
    setFilter('all')
    void load()
  }, [open, load])

  // 选中技能 → 读取详情；列表刷新（启停/安装）后同步刷新详情
  useEffect(() => {
    if (!open || !selectedId) {
      setDetail(null)
      setDetailError(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    skillsApi
      .read(selectedId, workspace)
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .catch((err) => {
        if (!cancelled) setDetailError(errorText(err))
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, selectedId, workspace, snapshot?.scannedAt])

  const skills = snapshot?.skills ?? []
  const enabledCount = skills.filter((skill) => skill.enabled).length
  const builtinCount = skills.filter((skill) => skill.builtin).length
  const mineCount = skills.filter((skill) => !skill.builtin && skill.source === 'user').length
  const folderCount = skills.filter((skill) => !skill.builtin && skill.source !== 'user').length

  const visibleSkills = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const filtered = skills.filter((skill) => {
      if (filter === 'enabled' && !skill.enabled) return false
      if (filter === 'disabled' && skill.enabled) return false
      if (!keyword) return true
      return `${skill.name} ${skill.description} ${skill.declaredName ?? ''}`.toLowerCase().includes(keyword)
    })
    return filtered.sort((a, b) => {
      if (sort === 'updated') return b.updatedAt - a.updatedAt
      return a.name.localeCompare(b.name, 'zh-CN')
    })
  }, [skills, filter, query, sort])

  const toggleSkill = async (skill: SkillView): Promise<void> => {
    if (busyId) return
    setBusyId(skill.id)
    setActionError(null)
    try {
      const next = await skillsApi.setEnabled(skill.id, !skill.enabled, workspace)
      setSnapshot(next)
      notify('success', `已${skill.enabled ? '禁用' : '启用'}技能「${skill.name}」`)
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setBusyId(null)
    }
  }

  const rescan = async (): Promise<void> => {
    if (loading) return
    setLoading(true)
    setActionError(null)
    try {
      const next = await skillsApi.rescan(workspace)
      setSnapshot(next)
      notify('success', `重新扫描完成：${next.skills.length} 个技能`)
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  const reveal = async (skill: SkillView): Promise<void> => {
    setActionError(null)
    try {
      await skillsApi.reveal(skill.id, workspace)
    } catch (err) {
      setActionError(errorText(err))
    }
  }

  const openUserDir = async (): Promise<void> => {
    setActionError(null)
    try {
      await skillsApi.openUserDir()
    } catch (err) {
      setActionError(errorText(err))
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const next = await skillsApi.remove(deleteTarget.id, workspace)
      setSnapshot(next)
      setSelectedId(next.skills[0]?.id ?? null)
      notify('success', `已删除技能「${deleteTarget.name}」`)
      setDeleteTarget(null)
    } catch (err) {
      setDeleteError(errorText(err))
    } finally {
      setDeleteBusy(false)
    }
  }

  const openInstall = (): void => {
    setInstallPath('')
    setInstallError(null)
    setInstallBusy(false)
    setInstallOpen(true)
  }

  const pickSource = async (kind: 'zip' | 'folder'): Promise<void> => {
    if (pickBusy || installBusy) return
    setPickBusy(kind)
    setInstallError(null)
    try {
      const picked = kind === 'zip' ? await skillsApi.pickZip() : await skillsApi.pickFolder()
      if (picked.path) setInstallPath(picked.path)
    } catch (err) {
      setInstallError(errorText(err))
    } finally {
      setPickBusy(null)
    }
  }

  const runInstall = async (): Promise<void> => {
    if (installBusy) return
    const source = installPath.trim()
    if (!source) {
      setInstallError('先选择或粘贴一个技能文件夹 / .zip 的绝对路径。')
      return
    }
    setInstallBusy(true)
    setInstallError(null)
    try {
      const result = await skillsApi.install(source, workspace)
      setSnapshot(result.snapshot)
      setSelectedId(result.installed.id)
      setInstallOpen(false)
      const skipped = result.skipped?.length ?? 0
      notify(
        'success',
        skipped > 0
          ? `已安装技能「${result.installed.name}」，跳过 ${skipped} 个脚本/不支持文件（不会执行）`
          : `已安装技能「${result.installed.name}」`
      )
    } catch (err) {
      setInstallError(errorText(err))
    } finally {
      setInstallBusy(false)
    }
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (!file) return
    try {
      const path = window.morrow.files.getPathForFile(file)
      if (path) {
        setInstallPath(path)
        setInstallError(null)
      } else {
        setInstallError('无法读取拖入文件的本地路径。请改用「选择 .zip」或粘贴路径。')
      }
    } catch (err) {
      setInstallError(errorText(err))
    }
  }

  const copySkillPath = (skill: SkillView): void => {
    void copyText(skill.skillPath)
    notify('success', '已复制技能路径')
  }

  const current = detail ?? skills.find((skill) => skill.id === selectedId) ?? null

  return (
    <Modal
      open={open}
      onClose={() => {
        // 安装/删除确认框打开时，Esc 只关最上层，不直接退出技能库
        if (installOpen || deleteTarget) return
        onClose()
      }}
      title="技能"
      description="技能是给 Morrow 的任务说明。启用后，做相关任务时会参考；只从本地安装，不上网、不执行代码。"
      width={980}
      layer="overlay"
      ariaLabel="技能"
    >
      <div className="skills-panel" data-testid="skills-panel">
        <div className="skills-toolbar">
          <div className="skills-search">
            <Search size={14} aria-hidden />
            <input
              className="skills-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索技能名称或说明…"
              aria-label="搜索技能"
              spellCheck={false}
            />
          </div>
          <Segmented
            value={filter}
            options={FILTER_OPTIONS}
            onChange={(next) => setFilter(next)}
            ariaLabel="按启用状态筛选技能"
          />
          <label className="skills-sort">
            <span className="skills-sort-label">排序</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SkillSort)}
              aria-label="技能排序方式"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Button variant="gold" size="sm" icon={<Upload size={14} />} onClick={openInstall}>
            安装技能
          </Button>
        </div>

        <p className="skills-summary">
          共 {skills.length} 个 · 内置 {builtinCount} · 我的 {mineCount}
          {folderCount > 0 ? ` · 当前文件夹 ${folderCount}` : ''} · 已启用 {enabledCount}
          {snapshot?.workspace ? null : ' · 还没有选择文件夹'}
        </p>

        {loadError ? <ErrorNote title={loadError} /> : null}
        {actionError ? (
          <div className="skills-inline-error" role="alert">
            <AlertTriangle size={14} aria-hidden />
            <span>{actionError}</span>
            <button type="button" className="skills-inline-dismiss" onClick={() => setActionError(null)}>
              知道了
            </button>
          </div>
        ) : null}
        {snapshot && snapshot.errors.length > 0 ? (
          <details className="skills-scan-errors">
            <summary>
              <AlertTriangle size={13} aria-hidden /> 发现 {snapshot.errors.length} 个问题（不影响其他技能使用）
            </summary>
            <ul>
              {snapshot.errors.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="skills-body">
          <div className="skills-list" role="listbox" aria-label="技能列表">
            {loading && skills.length === 0 ? (
              <div className="skills-list-loading">
                <Spinner size={16} label="正在读取技能" />
                <span>正在读取技能…</span>
              </div>
            ) : visibleSkills.length === 0 ? (
              <div className="skills-list-empty">
                <BookOpen size={22} aria-hidden />
                <p>
                  {skills.length === 0
                    ? '还没有技能。可以从本地文件夹或 .zip 安装一个技能包。'
                    : '没有匹配的技能。试试清空搜索或切换筛选条件。'}
                </p>
                <Button variant="secondary" size="sm" icon={<Upload size={14} />} onClick={openInstall}>
                  安装技能
                </Button>
              </div>
            ) : (
              visibleSkills.map((skill) => {
                const active = skill.id === selectedId
                return (
                  <button
                    key={skill.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={['skills-card', active ? 'is-active' : '', skill.enabled ? '' : 'is-disabled'].filter(Boolean).join(' ')}
                    onClick={() => setSelectedId(skill.id)}
                  >
                    <span className="skills-card-main">
                      <span className="skills-card-title">
                        <span className="skills-card-name">{skill.name}</span>
                        <Badge tone={skill.source === 'user' ? 'gold' : 'neutral'}>{sourceLabel(skill)}</Badge>
                        {skill.shadowed ? (
                          <Badge tone="warning" mono>
                            被文件夹覆盖
                          </Badge>
                        ) : null}
                        {!skill.enabled ? <Badge tone="neutral">已禁用</Badge> : null}
                        {!skill.valid ? <Badge tone="danger">不完整</Badge> : null}
                      </span>
                      <span className="skills-card-desc">{skill.description}</span>
                      <span className="skills-card-meta">
                        {skill.fileCount} 个文件 · {formatBytes(skill.sizeBytes)} · 更新于 {formatTime(skill.updatedAt)}
                        {skill.declaredName && skill.declaredName !== skill.name ? ` · 别名 ${skill.declaredName}` : ''}
                      </span>
                    </span>
                    <span
                      className={['skills-mini-switch', skill.enabled ? 'is-on' : ''].join(' ')}
                      role="switch"
                      aria-checked={skill.enabled}
                      aria-label={`${skill.enabled ? '禁用' : '启用'}技能 ${skill.name}`}
                      title={skill.enabled ? '已启用（点击禁用）' : '已禁用（点击启用）'}
                      onClick={(event) => {
                        event.stopPropagation()
                        void toggleSkill(skill)
                      }}
                    >
                      <span className="skills-mini-switch-thumb" />
                    </span>
                  </button>
                )
              })
            )}
          </div>

          <section className="skills-detail" aria-label="技能详情">
            {detailLoading && !detail ? (
              <div className="skills-detail-empty">
                <Spinner size={16} label="正在读取技能详情" />
              </div>
            ) : detailError ? (
              <div className="skills-detail-empty">
                <ErrorNote title={detailError} />
                {selectedId ? (
                  <Button variant="secondary" size="sm" onClick={() => setSelectedId(selectedId)}>
                    重试
                  </Button>
                ) : null}
              </div>
            ) : !current ? (
              <div className="skills-detail-empty">
                <Library size={26} aria-hidden />
                <h3>选择一个技能</h3>
                <p>从左侧选择技能，查看说明和文件；可以启用、停用或删除自己安装的技能。</p>
              </div>
            ) : (
              <>
                <header className="skills-detail-head">
                  <div className="skills-detail-title">
                    <h3>{current.name}</h3>
                    <div className="skills-detail-badges">
                      <Badge tone={current.source === 'user' ? 'gold' : 'neutral'}>{sourceLabel(current)}</Badge>
                      <Badge tone={current.enabled ? 'success' : 'neutral'}>{current.enabled ? '已启用' : '已禁用'}</Badge>
                      {current.shadowed ? (
                        <Badge tone="warning">同名文件夹技能优先</Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="skills-detail-actions">
                    <Button
                      variant={current.enabled ? 'secondary' : 'gold'}
                      size="sm"
                      icon={<Power size={13} />}
                      loading={busyId === current.id}
                      onClick={() => void toggleSkill(current)}
                    >
                      {current.enabled ? '禁用' : '启用'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<FolderOpen size={13} />}
                      onClick={() => void reveal(current)}
                    >
                      打开目录
                    </Button>
                    {current.source === 'user' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Trash2 size={13} />}
                        onClick={() => {
                          setDeleteError(null)
                          setDeleteTarget(current)
                        }}
                      >
                        删除
                      </Button>
                    ) : null}
                  </div>
                </header>

                <p className="skills-detail-desc">{current.description}</p>
                <div className="skills-path-row">
                  <code className="skills-path" title={current.skillPath}>
                    {shortenPath(current.skillPath)}
                  </code>
                  <IconButton label="复制技能路径" onClick={() => copySkillPath(current)}>
                    <Copy size={13} aria-hidden />
                  </IconButton>
                </div>
                <p className="skills-hint">
                  {current.enabled
                    ? '已启用：Morrow 在做相关任务时会参考它。'
                    : '已禁用：Morrow 暂时不会参考它。'}
                  {current.shadowed ? ' 当前文件夹有同名技能，实际会使用文件夹里的那份。' : ''}
                </p>

                <div className="skills-detail-scroll">
                  <section className="skills-section">
                    <h4>
                      <FileText size={13} aria-hidden /> 技能说明（SKILL.md）
                      <span className="skills-section-note">
                        {detail?.rawTruncated ? '（文件过大，仅显示前 256KB）' : ''}
                      </span>
                    </h4>
                    <pre className="skills-md">{detail?.raw?.trim() ? detail.raw : '（技能说明为空）'}</pre>
                  </section>
                  <section className="skills-section">
                    <h4>
                      <Package size={13} aria-hidden /> 文件（{detail?.files.length ?? current.fileCount}）
                    </h4>
                    {detail && detail.files.length > 0 ? (
                      <ul className="skills-files">
                        {detail.files.map((file) => (
                          <li key={file.path}>
                            <span className="skills-file-path">{file.path}</span>
                            <span className="skills-file-size">{formatBytes(file.size)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="skills-section-empty">除技能说明外没有其他文件。</p>
                    )}
                  </section>
                </div>
              </>
            )}
          </section>
        </div>
      </div>

      <Modal
        open={installOpen}
        onClose={() => (installBusy ? undefined : setInstallOpen(false))}
        title="安装技能"
        description="从本地文件夹或 .zip 技能包安装到我的技能。安装只复制 Markdown 与资源文件，不执行任何代码；可执行/脚本文件会被拒绝。"
        width={620}
        layer="modal"
        ariaLabel="安装技能"
        footer={
          <>
            <Button variant="ghost" onClick={() => setInstallOpen(false)} disabled={installBusy}>
              取消
            </Button>
            <Button variant="gold" icon={<CheckCircle2 size={14} />} loading={installBusy} onClick={() => void runInstall()}>
              安装
            </Button>
          </>
        }
      >
        <div className="skills-install">
          <div className="skills-install-picks">
            <Button
              variant="secondary"
              size="sm"
              icon={<Package size={14} />}
              loading={pickBusy === 'zip'}
              disabled={installBusy}
              onClick={() => void pickSource('zip')}
            >
              选择 .zip 技能包
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<FolderOpen size={14} />}
              loading={pickBusy === 'folder'}
              disabled={installBusy}
              onClick={() => void pickSource('folder')}
            >
              选择技能文件夹
            </Button>
          </div>

          <label className="skills-install-label" htmlFor="skills-install-path">
            技能文件夹或 .zip 的绝对路径
          </label>
          <input
            id="skills-install-path"
            className="skills-install-input"
            value={installPath}
            onChange={(event) => {
              setInstallPath(event.target.value)
              setInstallError(null)
            }}
            placeholder="例如 C:\Users\me\Downloads\release-skill.zip"
            spellCheck={false}
            disabled={installBusy}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void runInstall()
              }
            }}
          />

          <div
            className={['skills-drop-zone', dragging ? 'is-dragging' : ''].join(' ')}
            role="button"
            tabIndex={0}
            onClick={() => void pickSource('zip')}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                void pickSource('zip')
              }
            }}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <Upload size={18} aria-hidden />
            <p>把 .zip 技能包拖到这里，或点击选择</p>
            <span>文件夹请用「选择技能文件夹」或粘贴绝对路径</span>
          </div>

          {installError ? <ErrorNote title={installError} /> : null}
          <p className="skills-install-hint">
            安装要求：技能根目录必须有 <code>SKILL.md</code>；单个文件 ≤5MB、总计 ≤20MB、文件数 ≤300。
            脚本与可执行文件会被跳过并在安装后提示，Morrow 不会执行它们；已存在同名技能时会拒绝安装（可先删除）。
          </p>
        </div>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => (deleteBusy ? undefined : setDeleteTarget(null))}
        title="删除技能"
        description={deleteTarget ? `确定删除用户技能「${deleteTarget.name}」吗？会删除我的技能里的整个技能目录，无法撤销。` : ''}
        width={460}
        layer="modal"
        ariaLabel="删除技能"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
              取消
            </Button>
            <Button variant="danger" icon={<Trash2 size={14} />} loading={deleteBusy} onClick={() => void confirmDelete()}>
              删除
            </Button>
          </>
        }
      >
        {deleteError ? <ErrorNote title={deleteError} /> : null}
        {deleteTarget ? (
          <div className="skills-delete-body">
            <p>技能目录：</p>
            <code className="skills-path">{deleteTarget.dir}</code>
            <p className="skills-install-hint">
              文件夹自带的技能不在这里删除；如果只想暂时停用，请用「禁用」。
            </p>
          </div>
        ) : null}
      </Modal>

      <div className="skills-footnote">
        <span className="skills-footnote-path" title={snapshot?.userDir ?? ''}>
          我的技能：{snapshot?.userDir ? shortenPath(snapshot.userDir) : '（加载中…）'}
        </span>
        <span className="skills-footnote-actions">
          <Button variant="ghost" size="sm" icon={<FolderOpen size={13} />} onClick={() => void openUserDir()}>
            打开技能文件夹
          </Button>
          <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} loading={loading} onClick={() => void rescan()}>
            重新扫描
          </Button>
        </span>
      </div>
    </Modal>
  )
}
