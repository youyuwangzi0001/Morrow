import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
  X
} from 'lucide-react'
import type {
  GitBranch as GitBranchInfo,
  GitCommit,
  GitCommitDetail,
  GitCommitResult,
  GitDiff,
  GitFileStatus,
  GitStatus,
  Result
} from '@shared/types'
import { Button, ErrorNote, IconButton, Modal } from '../../ui'
import { useAppStore } from '../../state/store'
import './git.css'

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await window.morrow.features.invoke(channel, payload)) as Result<T>
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

function formatWhen(ts: number | null): string {
  if (!ts) return '—'
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

interface FileTone {
  letter: string
  tone: 'mod' | 'new' | 'del' | 'move' | 'conflict' | 'untracked'
  label: string
}

function fileTone(file: GitFileStatus, section: 'staged' | 'worktree'): FileTone {
  if (file.conflicted) return { letter: '!', tone: 'conflict', label: '冲突' }
  if (section === 'worktree' && file.untracked) return { letter: '?', tone: 'untracked', label: '未跟踪' }
  const code = section === 'staged' ? file.indexStatus : file.worktreeStatus
  switch (code) {
    case 'A':
      return { letter: 'A', tone: 'new', label: '新增' }
    case 'D':
      return { letter: 'D', tone: 'del', label: '删除' }
    case 'R':
    case 'C':
      return { letter: 'R', tone: 'move', label: code === 'R' ? '重命名' : '复制' }
    case 'U':
      return { letter: '!', tone: 'conflict', label: '冲突' }
    default:
      return { letter: 'M', tone: 'mod', label: '修改' }
  }
}

function DiffBody({ diff, truncated, binary }: { diff: string; truncated: boolean; binary: boolean }): React.JSX.Element {
  const lines = useMemo(() => diff.replace(/\r\n/g, '\n').split('\n'), [diff])
  if (!diff.trim()) {
    return (
      <div className="git-diff-empty">
        <FileDiff size={22} strokeWidth={1.3} aria-hidden />
        <p>{binary ? '二进制文件，无法显示文本差异。' : '没有可显示的文本差异。'}</p>
      </div>
    )
  }
  return (
    <div className="git-diff-scroll">
      {binary ? <p className="git-binary-note">二进制文件：以下为 Git 的摘要输出。</p> : null}
      <div className="git-diff mono" aria-label="文件差异">
        {lines.slice(0, 6000).map((line, index) => {
          let kind = 'ctx'
          if (line.startsWith('+++') || line.startsWith('---')) kind = 'file'
          else if (line.startsWith('@@')) kind = 'hunk'
          else if (line.startsWith('diff --git') || line.startsWith('index ')) kind = 'meta'
          else if (line.startsWith('+')) kind = 'add'
          else if (line.startsWith('-')) kind = 'del'
          return (
            <div key={index} className={`git-diff-line is-${kind}`}>
              {line || '\u00a0'}
            </div>
          )
        })}
      </div>
      {truncated ? <p className="git-truncated">差异过大，已截断。完整内容请在编辑器或终端查看。</p> : null}
      {lines.length > 6000 ? <p className="git-truncated">界面仅渲染前 6000 行。</p> : null}
    </div>
  )
}

export function GitPanel({
  open,
  onClose,
  workspace
}: {
  open: boolean
  onClose: () => void
  workspace: string | null
}): React.JSX.Element {
  const notify = useAppStore((s) => s.notify)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [tab, setTab] = useState<'changes' | 'history'>('changes')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selection, setSelection] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [message, setMessage] = useState('')
  const [stageAll, setStageAll] = useState(false)
  const [discardTarget, setDiscardTarget] = useState<GitFileStatus | null>(null)
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [branchMenu, setBranchMenu] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [commits, setCommits] = useState<GitCommit[] | null>(null)
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  const branchRef = useRef<HTMLDivElement>(null)
  const diffRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const historyRequestRef = useRef(0)

  const staged = useMemo(() => status?.files.filter((file) => file.staged) ?? [], [status])
  const changed = useMemo(() => status?.files.filter((file) => file.unstaged) ?? [], [status])
  const canCommit = Boolean(message.trim()) && (stageAll || (status?.stagedCount ?? 0) > 0) && !busy

  const refresh = useCallback(
    async (silent = false): Promise<void> => {
      if (!workspace) return
      try {
        const next = await call<GitStatus>('feature:git:status', { workspace })
        setStatus(next)
        if (!silent) setError(null)
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : '读取 Git 状态失败')
      }
    },
    [workspace]
  )

  const refreshBranches = useCallback(async (): Promise<void> => {
    if (!workspace) return
    try {
      setBranches(await call<GitBranchInfo[]>('feature:git:branches', { workspace }))
    } catch {
      setBranches([])
    }
  }, [workspace])

  useEffect(() => {
    if (!open) return
    diffRequestRef.current += 1
    detailRequestRef.current += 1
    historyRequestRef.current += 1
    setStatus(null)
    setTab('changes')
    setSelection(null)
    setDiff(null)
    setError(null)
    setMessage('')
    setStageAll(false)
    setDiscardTarget(null)
    setBranchMenu(false)
    setCommits(null)
    setDetail(null)
    void refresh()
    void refreshBranches()
  }, [open, workspace, refresh, refreshBranches])

  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) void refresh(true)
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [open, busy, refresh])

  useEffect(() => {
    if (!branchMenu) return
    const onPointer = (event: PointerEvent): void => {
      if (branchRef.current && !branchRef.current.contains(event.target as Node)) setBranchMenu(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setBranchMenu(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [branchMenu])

  const loadDiff = useCallback(
    async (path: string, stagedMode: boolean): Promise<void> => {
      if (!workspace) return
      const request = diffRequestRef.current + 1
      diffRequestRef.current = request
      setSelection({ path, staged: stagedMode })
      setDiff(null)
      try {
        const next = await call<GitDiff>('feature:git:diff', { workspace, path, staged: stagedMode })
        if (diffRequestRef.current === request) setDiff(next)
      } catch (err) {
        if (diffRequestRef.current !== request) return
        setError(err instanceof Error ? err.message : '读取差异失败')
        setSelection(null)
      }
    },
    [workspace]
  )

  const run = async <T,>(task: () => Promise<T>, after: (value: T) => void, failure: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      after(await task())
    } catch (err) {
      setError(err instanceof Error ? err.message : failure)
      void refresh(true)
    } finally {
      setBusy(false)
    }
  }

  const stage = (path?: string): Promise<void> =>
    run(
      () => call<GitStatus>('feature:git:stage', { workspace, ...(path ? { path } : {}) }),
      (next) => {
        setStatus(next)
        setDiscardTarget(null)
        if (path) {
          const entry = next.files.find((file) => file.path === path)
          if (entry?.staged) void loadDiff(path, true)
        } else {
          setSelection(null)
          setDiff(null)
        }
      },
      '暂存失败'
    )

  const unstage = (path?: string): Promise<void> =>
    run(
      () => call<GitStatus>('feature:git:unstage', { workspace, ...(path ? { path } : {}) }),
      (next) => {
        setStatus(next)
        if (path) {
          const entry = next.files.find((file) => file.path === path)
          if (entry) void loadDiff(path, false)
          else {
            setSelection(null)
            setDiff(null)
          }
        } else {
          setSelection(null)
          setDiff(null)
        }
      },
      '取消暂存失败'
    )

  const discard = (file: GitFileStatus): Promise<void> =>
    run(
      () => call<GitStatus>('feature:git:discard', { workspace, path: file.path }),
      (next) => {
        setStatus(next)
        setDiscardTarget(null)
        if (selection?.path === file.path) {
          setSelection(null)
          setDiff(null)
        }
        notify('info', `已放弃 ${file.path} 的改动`)
      },
      '放弃改动失败'
    )

  const invalidateHistory = (): void => {
    setCommits(null)
    setDetail(null)
    if (tab === 'history') void loadHistory()
  }

  const commit = (): Promise<void> =>
    run(
      () => call<GitCommitResult>('feature:git:commit', { workspace, message, stageAll }),
      (result) => {
        setStatus(result.status)
        setMessage('')
        setStageAll(false)
        setSelection(null)
        setDiff(null)
        invalidateHistory()
        notify('success', `已提交 ${result.commitHash ?? ''}：${result.summary}`)
      },
      '提交失败'
    )

  const init = (): Promise<void> =>
    run(
      () => call<GitStatus>('feature:git:init', { workspace }),
      (next) => {
        setStatus(next)
        void refreshBranches()
        notify('success', '已初始化 Git 仓库')
      },
      '初始化失败'
    )

  const switchBranch = async (name: string): Promise<void> => {
    setBranchMenu(false)
    await run(
      () => call<GitStatus>('feature:git:checkout', { workspace, branch: name }),
      (next) => {
        setStatus(next)
        setSelection(null)
        setDiff(null)
        invalidateHistory()
        void refreshBranches()
        notify('success', `已切换到分支 ${name}`)
      },
      '切换分支失败'
    )
  }

  const createBranch = async (): Promise<void> => {
    const name = newBranch.trim()
    if (!name) return
    await run(
      () => call<GitStatus>('feature:git:create-branch', { workspace, name }),
      (next) => {
        setStatus(next)
        setNewBranch('')
        setBranchMenu(false)
        setSelection(null)
        setDiff(null)
        invalidateHistory()
        void refreshBranches()
        notify('success', `已创建并切换到分支 ${name}`)
      },
      '创建分支失败'
    )
  }

  const loadHistory = async (): Promise<void> => {
    if (!workspace) return
    const request = historyRequestRef.current + 1
    historyRequestRef.current = request
    setHistoryBusy(true)
    setError(null)
    try {
      const list = await call<GitCommit[]>('feature:git:log', { workspace })
      if (historyRequestRef.current !== request) return
      setCommits(list)
      if (list[0]) await openCommit(list[0].hash)
      else setDetail(null)
    } catch (err) {
      if (historyRequestRef.current === request) {
        setError(err instanceof Error ? err.message : '读取提交历史失败')
      }
    } finally {
      if (historyRequestRef.current === request) setHistoryBusy(false)
    }
  }

  const openCommit = async (hash: string): Promise<void> => {
    if (!workspace) return
    const request = detailRequestRef.current + 1
    detailRequestRef.current = request
    setHistoryBusy(true)
    try {
      const next = await call<GitCommitDetail>('feature:git:show', { workspace, hash })
      if (detailRequestRef.current === request) setDetail(next)
    } catch (err) {
      if (detailRequestRef.current === request) {
        setError(err instanceof Error ? err.message : '读取提交详情失败')
      }
    } finally {
      if (detailRequestRef.current === request) setHistoryBusy(false)
    }
  }

  const openHistory = (): void => {
    setTab('history')
    if (commits === null && status?.isRepo && !historyBusy) void loadHistory()
  }

  const refreshCurrent = (): void => {
    void refresh()
    if (tab === 'history' && status?.isRepo) void loadHistory()
  }

  const clearError = (): void => setError(null)

  const body = (): React.JSX.Element => {
    if (!workspace) {
      return (
        <div className="git-empty">
          <FolderGit2 size={28} strokeWidth={1.3} aria-hidden />
          <p className="git-empty-title">还没有文件夹</p>
          <p className="git-empty-hint">选择文件夹后，这里会显示 Git 状态、差异与提交历史。</p>
        </div>
      )
    }
    if (!status) {
      if (error) {
        return (
          <div className="git-empty">
            <AlertTriangle size={26} strokeWidth={1.4} aria-hidden />
            <p className="git-empty-title">无法读取 Git 状态</p>
            <p className="git-empty-hint">{error}</p>
            <Button variant="ghost" onClick={() => void refresh()} disabled={busy}>
              <RefreshCw size={13} strokeWidth={1.7} aria-hidden />
              重试
            </Button>
          </div>
        )
      }
      return (
        <div className="git-empty">
          <RefreshCw size={22} strokeWidth={1.4} className="git-spin" aria-hidden />
          <p className="git-empty-title">正在读取 Git 状态…</p>
        </div>
      )
    }
    if (!status.isRepo || !status.root) {
      return (
        <div className="git-empty">
          <FolderGit2 size={28} strokeWidth={1.3} aria-hidden />
          <p className="git-empty-title">这里还不是 Git 仓库</p>
          <p className="git-empty-hint">
            初始化后可以在这里查看改动、暂存、提交和浏览历史；也可以在终端执行 git init。
          </p>
          <Button variant="gold" onClick={() => void init()} disabled={busy}>
            <GitBranchPlus size={13} strokeWidth={1.7} aria-hidden />
            初始化 Git 仓库
          </Button>
        </div>
      )
    }
    if (tab === 'history') {
      return (
        <div className="git-history">
          <aside className="git-side" aria-label="提交历史">
            <div className="git-side-head">
              <span>最近提交</span>
              <span className="mono">{commits?.length ?? 0}</span>
            </div>
            <div className="git-file-scroll">
              {historyBusy && commits === null ? <p className="git-list-empty">正在读取历史…</p> : null}
              {commits && commits.length === 0 ? <p className="git-list-empty">还没有提交。切换到「变更」创建第一次提交。</p> : null}
              {commits?.map((item) => (
                <button
                  key={item.hash}
                  type="button"
                  className={['git-commit-item', detail?.commit.hash === item.hash ? 'is-active' : ''].filter(Boolean).join(' ')}
                  onClick={() => void openCommit(item.hash)}
                >
                  <span className="git-commit-subject truncate">{item.subject || '（无标题）'}</span>
                  <span className="git-commit-meta mono">
                    {item.shortHash} · {item.author} · {formatWhen(item.date)}
                  </span>
                </button>
              ))}
            </div>
          </aside>
          <section className="git-main">
            {detail ? (
              <>
                <div className="git-detail-head">
                  <div className="git-detail-title">
                    <span>{detail.commit.subject || '（无标题）'}</span>
                    <span className="mono">{detail.commit.shortHash}</span>
                  </div>
                  <div className="git-detail-meta mono">
                    {detail.commit.author} · {formatWhen(detail.commit.date)}
                  </div>
                  {detail.body ? <pre className="git-detail-body selectable">{detail.body}</pre> : null}
                </div>
                <DiffBody diff={detail.diff} truncated={detail.truncated} binary={false} />
              </>
            ) : (
              <div className="git-empty-main">
                <GitCommitHorizontal size={24} strokeWidth={1.3} aria-hidden />
                <p>{historyBusy ? '正在读取提交…' : '选择一个提交查看详情。'}</p>
              </div>
            )}
          </section>
        </div>
      )
    }
    return (
      <div className="git-changes">
        <aside className="git-side" aria-label="Git 变更">
          <div className="git-commit-box">
            <textarea
              className="git-commit-input"
              rows={3}
              maxLength={5000}
              value={message}
              placeholder="这次改了什么？"
              aria-label="提交信息"
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  if (canCommit) void commit()
                }
              }}
            />
            <div className="git-commit-row">
              <label className="git-check">
                <input type="checkbox" checked={stageAll} onChange={(event) => setStageAll(event.target.checked)} />
                先暂存全部改动
              </label>
              <Button variant="gold" onClick={() => void commit()} disabled={!canCommit}>
                <GitCommitHorizontal size={13} strokeWidth={1.7} aria-hidden />
                提交
              </Button>
            </div>
          </div>

          <div className="git-file-scroll">
            {staged.length > 0 ? (
              <section className="git-section" aria-label="已暂存的改动">
                <div className="git-section-head">
                  <span>已暂存</span>
                  <span className="git-section-tools">
                    <span className="mono">{staged.length}</span>
                    <button type="button" className="git-mini" disabled={busy} onClick={() => void unstage()}>
                      全部取消暂存
                    </button>
                  </span>
                </div>
                {staged.map((file) => (
                  <FileRow
                    key={`staged-${file.path}`}
                    file={file}
                    section="staged"
                    active={selection?.path === file.path && selection.staged}
                    disabled={busy}
                    onOpen={() => void loadDiff(file.path, true)}
                    onStage={() => void stage(file.path)}
                    onUnstage={() => void unstage(file.path)}
                    onDiscard={() => setDiscardTarget(file)}
                  />
                ))}
              </section>
            ) : null}

            {changed.length > 0 ? (
              <section className="git-section" aria-label="未暂存的改动">
                <div className="git-section-head">
                  <span>更改</span>
                  <span className="git-section-tools">
                    <span className="mono">{changed.length}</span>
                    <button type="button" className="git-mini" disabled={busy} onClick={() => void stage()}>
                      暂存全部
                    </button>
                  </span>
                </div>
                {changed.map((file) => (
                  <FileRow
                    key={`worktree-${file.path}`}
                    file={file}
                    section="worktree"
                    active={selection?.path === file.path && !selection.staged}
                    disabled={busy}
                    onOpen={() => void loadDiff(file.path, false)}
                    onStage={() => void stage(file.path)}
                    onUnstage={() => void unstage(file.path)}
                    onDiscard={() => setDiscardTarget(file)}
                  />
                ))}
              </section>
            ) : null}

            {staged.length === 0 && changed.length === 0 ? (
              <div className="git-clean">
                <Check size={20} strokeWidth={1.6} aria-hidden />
                <p className="git-empty-title">文件夹干净</p>
                <p className="git-empty-hint">没有未提交的改动。</p>
              </div>
            ) : null}
          </div>

          {discardTarget ? (
            <div className="git-discard-bar" role="alertdialog" aria-label="放弃改动确认">
              <AlertTriangle size={13} strokeWidth={1.6} aria-hidden />
              <span className="git-discard-text">
                放弃「{discardTarget.path}」{discardTarget.staged ? '未暂存的改动' : '的改动'}？
              </span>
              <button type="button" className="git-mini" onClick={() => setDiscardTarget(null)}>
                取消
              </button>
              <button type="button" className="git-mini is-danger" onClick={() => void discard(discardTarget)}>
                放弃
              </button>
            </div>
          ) : null}
        </aside>

        <section className="git-main">
          {selection ? (
            <>
              <div className="git-main-head">
                <FileDiff size={13} strokeWidth={1.6} aria-hidden />
                <span className="git-main-path mono truncate" title={selection.path}>
                  {selection.path}
                </span>
                <span className={['git-tag', selection.staged ? 'is-staged' : 'is-worktree'].join(' ')}>
                  {selection.staged ? '已暂存' : '未暂存'}
                </span>
              </div>
              {diff ? (
                <DiffBody diff={diff.diff} truncated={diff.truncated} binary={diff.binary} />
              ) : (
                <div className="git-empty-main">
                  <RefreshCw size={20} strokeWidth={1.4} className="git-spin" aria-hidden />
                  <p>正在读取差异…</p>
                </div>
              )}
            </>
          ) : (
            <div className="git-empty-main">
              <FileDiff size={24} strokeWidth={1.3} aria-hidden />
              <p>{staged.length + changed.length > 0 ? '选择一个文件查看差异。' : '选择一个文件查看差异，或直接提交已暂存的改动。'}</p>
            </div>
          )}
        </section>
      </div>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="版本历史"
      description="查看文件改动、保存版本记录与浏览历史。只操作当前文件夹里的项目。"
      width={1060}
    >
      <div className="git-panel">
        <div className="git-topbar">
          <div className="git-branch-wrap" ref={branchRef}>
            <button
              type="button"
              className="git-branch-btn"
              aria-label="切换或新建分支"
              aria-expanded={branchMenu}
              disabled={!status?.isRepo}
              onClick={() => {
                setBranchMenu((value) => !value)
                if (!branchMenu) void refreshBranches()
              }}
            >
              <GitBranch size={13} strokeWidth={1.6} aria-hidden />
              <span className="truncate">{status?.detached ? '未在分支上' : status?.branch ?? '分支'}</span>
              <ChevronDown size={12} strokeWidth={1.6} aria-hidden />
            </button>
            {branchMenu && status?.isRepo ? (
              <div className="git-branch-menu" role="menu" aria-label="本地分支">
                <div className="git-branch-menu-head mono">本地分支</div>
                <div className="git-branch-list">
                  {branches.map((branch) => (
                    <button
                      key={branch.name}
                      type="button"
                      role="menuitem"
                      className={['git-branch-item', branch.current ? 'is-current' : ''].filter(Boolean).join(' ')}
                      onClick={() => void switchBranch(branch.name)}
                    >
                      <span className="git-branch-check" aria-hidden>
                        {branch.current ? <Check size={12} strokeWidth={1.8} /> : null}
                      </span>
                      <span className="git-branch-name truncate">{branch.name}</span>
                      <span className="git-branch-meta mono truncate">
                        {branch.upstream ?? formatWhen(branch.lastCommitAt)}
                      </span>
                    </button>
                  ))}
                  {branches.length === 0 ? <p className="git-list-empty">还没有分支。</p> : null}
                </div>
                <div className="git-branch-create">
                  <input
                    className="git-branch-input"
                    value={newBranch}
                    maxLength={200}
                    placeholder="新分支名"
                    aria-label="新分支名"
                    onChange={(event) => setNewBranch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void createBranch()
                      }
                    }}
                  />
                  <IconButton
                    label="创建并切换到新分支"
                    size={26}
                    disabled={busy || !newBranch.trim()}
                    onClick={() => void createBranch()}
                  >
                    <Plus size={13} strokeWidth={1.7} aria-hidden />
                  </IconButton>
                </div>
              </div>
            ) : null}
          </div>

          {status?.ahead || status?.behind ? (
            <span className="git-sync mono" title={`领先 ${status.ahead} 个提交，落后 ${status.behind} 个提交`}>
              {status.ahead ? `↑${status.ahead}` : ''}
              {status.ahead && status.behind ? ' ' : ''}
              {status.behind ? `↓${status.behind}` : ''}
            </span>
          ) : null}

          <span className="git-root mono truncate" title={status?.root ?? undefined}>
            {status?.isRepo && status.root ? compactPath(status.root) : ''}
          </span>
          <IconButton label="刷新 Git 状态" size={28} disabled={busy || historyBusy} onClick={refreshCurrent}>
            <RefreshCw
              size={13}
              strokeWidth={1.6}
              className={busy || historyBusy ? 'git-spin' : undefined}
              aria-hidden
            />
          </IconButton>
        </div>

        {error && status ? (
          <ErrorNote
            title={error}
            action={
              <IconButton label="收起错误提示" size={24} onClick={clearError}>
                <X size={12} strokeWidth={1.8} aria-hidden />
              </IconButton>
            }
          />
        ) : null}

        {status?.isRepo ? (
          <div className="git-tabs" role="tablist" aria-label="Git 视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'changes'}
              className={['git-tab', tab === 'changes' ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={() => setTab('changes')}
            >
              变更
              {status.files.length > 0 ? <span className="git-tab-count mono">{status.files.length}</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              className={['git-tab', tab === 'history' ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={openHistory}
            >
              历史
            </button>
          </div>
        ) : null}

        {body()}

        <p className="git-foot">
          只处理当前文件夹里的版本记录。推送、拉取和账号操作请在命令窗口完成。
        </p>
      </div>
    </Modal>
  )
}

function FileRow({
  file,
  section,
  active,
  disabled,
  onOpen,
  onStage,
  onUnstage,
  onDiscard
}: {
  file: GitFileStatus
  section: 'staged' | 'worktree'
  active: boolean
  disabled: boolean
  onOpen: () => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
}): React.JSX.Element {
  const tone = fileTone(file, section)
  const label = file.origPath ? `${file.origPath} → ${file.path}` : file.path
  const discardable = section === 'worktree' && !file.conflicted && !file.origPath
  const discardLabel = file.staged ? `放弃 ${file.path} 未暂存的改动` : `放弃 ${file.path} 的改动`
  return (
    <div className={['git-file-row', active ? 'is-active' : ''].filter(Boolean).join(' ')}>
      <button type="button" className="git-file-main" onClick={onOpen} title={label}>
        <span className={`git-file-chip is-${tone.tone}`} title={tone.label} aria-label={tone.label}>
          {tone.letter}
        </span>
        <span className="git-file-label truncate">{file.path}</span>
        {file.conflicted ? <span className="git-file-flag">冲突</span> : null}
      </button>
      <span className="git-file-actions">
        {section === 'staged' ? (
          <IconButton label={`取消暂存 ${file.path}`} size={20} disabled={disabled} onClick={onUnstage}>
            <Minus size={11} strokeWidth={1.8} aria-hidden />
          </IconButton>
        ) : (
          <>
            <IconButton
              label={file.conflicted ? `标记冲突已解决 ${file.path}` : `暂存 ${file.path}`}
              size={20}
              disabled={disabled}
              onClick={onStage}
            >
              <Plus size={11} strokeWidth={1.8} aria-hidden />
            </IconButton>
            {discardable ? (
              <IconButton label={discardLabel} size={20} tone="danger" disabled={disabled} onClick={onDiscard}>
                <Undo2 size={11} strokeWidth={1.8} aria-hidden />
              </IconButton>
            ) : null}
          </>
        )}
      </span>
    </div>
  )
}
