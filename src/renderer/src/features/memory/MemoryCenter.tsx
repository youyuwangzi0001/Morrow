/**
 * R10-D 记忆中心面板（独立受控组件，Lead 挂载：<MemoryCenter open={...} onClose={...} />）。
 *
 * - 项目记忆（跟随当前工作区，存在 <workspace>/.morrow/memories.json）与全局记忆（应用数据目录）分组；
 * - 搜索、添加、编辑、启用/停用、删除、清空（二次确认）、导出 Markdown/JSON；
 * - 显示旧 MEMORY.md 迁移数量、启用条目 token 估算、以及「会注入系统提示的原文」预览；
 * - 所有数据都通过 window.morrow.features.invoke('feature:memory:*') 走真实主进程。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Brain,
  Check,
  Download,
  Eye,
  Folder,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { useAppStore } from '../../state/store'
import { Badge, Button, EmptyHint, ErrorNote, IconButton, Modal, Segmented, Spinner, TextArea, TextInput } from '../../ui'
import {
  MEMORY_SOURCE_LABEL,
  downloadTextFile,
  formatMemoryTime,
  memoryApi,
  type MemoryEntry,
  type MemoryInjection,
  type MemoryListResult,
  type MemoryScope
} from './memory-api'
import './MemoryCenter.css'

export interface MemoryCenterProps {
  open: boolean
  onClose: () => void
  /** 可选：覆盖当前工作区；不传时自动取当前会话工作区 / 最近工作区 */
  workspace?: string | null
}

const SCOPE_OPTIONS: { value: MemoryScope; label: string; description: string }[] = [
  { value: 'project', label: '项目记忆', description: '跟随当前工作区，只在当前项目里生效' },
  { value: 'global', label: '全局记忆', description: '跨项目生效，例如「始终用简体中文回答」' }
]

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

function parseTags(input: string): string[] {
  return input
    .split(/[,，\s#]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8)
}

function shortenPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

export function MemoryCenter({ open, onClose, workspace: workspaceProp }: MemoryCenterProps): React.JSX.Element {
  const storeWorkspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace)
  const workspace = workspaceProp !== undefined ? workspaceProp : storeWorkspace

  const [scope, setScope] = useState<MemoryScope>('project')
  const [data, setData] = useState<MemoryListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [draftTags, setDraftTags] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editTags, setEditTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'delete' | 'clear'; id?: string } | null>(null)
  const [injection, setInjection] = useState<MemoryInjection | null>(null)
  const [showInjection, setShowInjection] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!open) return
    if (scope === 'project' && !workspace) {
      setData(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await memoryApi.list({
        scope,
        workspace: scope === 'project' ? workspace : null,
        includeDisabled: true
      })
      setData(result)
    } catch (err) {
      setError(errorText(err, '读取记忆失败'))
    } finally {
      setLoading(false)
    }
  }, [open, scope, workspace])

  const loadInjection = useCallback(async (): Promise<void> => {
    try {
      const result = await memoryApi.injection({ workspace: workspace ?? null, maxTokens: 600 })
      setInjection(result)
    } catch {
      setInjection(null)
    }
  }, [workspace])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!open) return
    void loadInjection()
  }, [open, loadInjection, data])

  const entries = useMemo(() => {
    const all = data?.entries ?? []
    const keyword = query.trim().toLowerCase()
    if (!keyword) return all
    return all.filter(
      (entry) =>
        entry.text.toLowerCase().includes(keyword) || entry.tags.some((tag) => tag.toLowerCase().includes(keyword))
    )
  }, [data, query])

  const scopeLabel = scope === 'project' ? '项目记忆' : '全局记忆'
  const stats = data?.stats ?? null
  const canWrite = scope === 'global' || !!workspace

  const resetDraft = (): void => {
    setAdding(false)
    setDraftText('')
    setDraftTags('')
    setNotice(null)
  }

  const submitAdd = async (): Promise<void> => {
    if (!canWrite) return
    const text = draftText.trim()
    if (!text) {
      setError('先写点什么再保存。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await memoryApi.add({
        scope,
        workspace: scope === 'project' ? workspace : null,
        text,
        tags: parseTags(draftTags)
      })
      resetDraft()
      setNotice('已保存这条记忆')
      await load()
      await loadInjection()
    } catch (err) {
      setError(errorText(err, '保存记忆失败'))
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (entry: MemoryEntry): void => {
    setEditingId(entry.id)
    setEditText(entry.text)
    setEditTags(entry.tags.join('，'))
    setError(null)
  }

  const submitEdit = async (entry: MemoryEntry): Promise<void> => {
    setBusyId(entry.id)
    setError(null)
    try {
      await memoryApi.update({
        scope,
        workspace: scope === 'project' ? workspace : null,
        id: entry.id,
        text: editText,
        tags: parseTags(editTags)
      })
      setEditingId(null)
      await load()
      await loadInjection()
    } catch (err) {
      setError(errorText(err, '保存修改失败'))
    } finally {
      setBusyId(null)
    }
  }

  const toggleEntry = async (entry: MemoryEntry): Promise<void> => {
    setBusyId(entry.id)
    setError(null)
    try {
      await memoryApi.toggle({
        scope,
        workspace: scope === 'project' ? workspace : null,
        id: entry.id,
        enabled: !entry.enabled
      })
      await load()
      await loadInjection()
    } catch (err) {
      setError(errorText(err, '切换启用状态失败'))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!confirm) return
    setBusy(true)
    setError(null)
    try {
      if (confirm.kind === 'delete' && confirm.id) {
        await memoryApi.remove({ scope, workspace: scope === 'project' ? workspace : null, id: confirm.id })
        setNotice('已删除这条记忆')
      } else if (confirm.kind === 'clear') {
        const result = await memoryApi.clear({ scope, workspace: scope === 'project' ? workspace : null })
        setNotice(`已清空 ${result.removed} 条${scopeLabel}`)
      }
      setConfirm(null)
      await load()
      await loadInjection()
    } catch (err) {
      setError(errorText(err, '操作失败'))
    } finally {
      setBusy(false)
    }
  }

  const exportMemory = async (format: 'markdown' | 'json'): Promise<void> => {
    setError(null)
    try {
      const result = await memoryApi.exportMemory({ scope, workspace: scope === 'project' ? workspace : null })
      if (format === 'markdown') {
        downloadTextFile(result.fileName, result.markdown)
      } else {
        downloadTextFile(result.fileName.replace(/\.md$/, '.json'), result.json, 'application/json;charset=utf-8')
      }
      setNotice(`已导出 ${result.count} 条${scopeLabel}`)
    } catch (err) {
      setError(errorText(err, '导出失败'))
    }
  }

  const togglePreview = async (): Promise<void> => {
    const next = !showInjection
    setShowInjection(next)
    if (next) await loadInjection()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="记忆中心"
      description="记忆是 Morrow 的参考笔记。启用的条目会在需要时参考；不会当作指令，也不会授权操作。"
      width={860}
      ariaLabel="记忆中心"
      footer={
        <footer className="mc-foot">
          <span className="mc-foot-note">
            <X size={11} strokeWidth={1.8} aria-hidden /> 记忆属于参考背景，不是指令，也不会授权任何操作。
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </footer>
      }
    >
      <div className="mc-root">
        <div className="mc-top">
          <Segmented ariaLabel="记忆范围" value={scope} options={SCOPE_OPTIONS} onChange={setScope} />
          {scope === 'project' ? (
            <span className="mc-workspace mono" title={workspace ?? '未选择工作区'}>
              <Folder size={12} strokeWidth={1.5} aria-hidden />
              {workspace ? shortenPath(workspace) : '未选择工作区'}
            </span>
          ) : (
            <span className="mc-workspace mono">
              <Globe size={12} strokeWidth={1.5} aria-hidden />
              跨项目
            </span>
          )}
          <div className="mc-top-spacer" />
          <div className="mc-search">
            <Search size={13} strokeWidth={1.5} aria-hidden />
            <TextInput
              aria-label="搜索记忆"
              placeholder="搜索记忆内容或标签…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Button
            variant="gold"
            size="sm"
            icon={<Plus size={13} strokeWidth={1.8} aria-hidden />}
            disabled={!canWrite}
            onClick={() => (adding ? resetDraft() : setAdding(true))}
          >
            {adding ? '收起' : '添加记忆'}
          </Button>
        </div>

        {!canWrite ? (
          <ErrorNote
            title="还没有选择工作区"
            detail="项目记忆跟随工作文件夹。先在左侧选择一个工作区，或切到「全局记忆」。"
            action={
              <Button variant="ghost" size="sm" onClick={() => setScope('global')}>
                去全局记忆
              </Button>
            }
          />
        ) : null}

        {stats ? (
          <div className="mc-stats" role="status" aria-label="记忆统计">
            <Badge tone="neutral">共 {stats.total} 条</Badge>
            <Badge tone="success">启用 {stats.enabled}</Badge>
            {stats.disabled > 0 ? <Badge tone="neutral">停用 {stats.disabled}</Badge> : null}
            <Badge tone="gold">
              预计使用 {stats.enabledTokens} / {stats.limitTokens} 字
            </Badge>
            {stats.migratedTotal > 0 ? <Badge tone="mauve">旧记忆迁移 {stats.migratedTotal}</Badge> : null}
            {stats.legacyFileDetected ? (
              <span className="mc-legacy-hint">检测到 .morrow/MEMORY.md，新写入会继续自动迁移</span>
            ) : null}
          </div>
        ) : null}

        <div className="mc-actions">
          <Button
            variant="ghost"
            size="sm"
            icon={<Eye size={13} strokeWidth={1.6} aria-hidden />}
            aria-label="注入预览"
            aria-pressed={showInjection}
            onClick={() => void togglePreview()}
          >
            {showInjection ? '收起会用到哪些记忆' : '查看会用到哪些记忆'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Download size={13} strokeWidth={1.6} aria-hidden />}
            onClick={() => void exportMemory('markdown')}
          >
            导出 Markdown
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void exportMemory('json')}>
            导出 JSON
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={13} strokeWidth={1.6} aria-hidden />}
            onClick={() => void load()}
          >
            刷新
          </Button>
          <div className="mc-actions-spacer" />
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={13} strokeWidth={1.6} aria-hidden />}
            disabled={!stats || stats.total === 0}
            onClick={() => setConfirm({ kind: 'clear' })}
          >
            清空{scopeLabel}
          </Button>
        </div>

        {notice ? (
          <p className="mc-notice" role="status">
            <Check size={12} strokeWidth={2} aria-hidden /> {notice}
          </p>
        ) : null}
        {error ? <ErrorNote title="操作失败" detail={error} action={<Button variant="ghost" size="sm" onClick={() => void load()}>重试</Button>} /> : null}

        {showInjection && injection ? (
          <section className="mc-injection" aria-label="注入预览">
            <header className="mc-injection-head">
              <Brain size={13} strokeWidth={1.6} aria-hidden />
              <span>会参考的内容</span>
              <span className="mono">
                {injection.included}/{injection.totalEnabled} 条 · 预计 {injection.usedTokens}/{injection.limitTokens} 字
                {injection.omitted > 0 ? ` · ${injection.omitted} 条因篇幅未使用` : ''}
              </span>
            </header>
            <pre className="mc-injection-text">{injection.text || '（当前没有已启用的记忆，不会参考任何内容）'}</pre>
          </section>
        ) : null}

        {adding ? (
          <form
            className="mc-add"
            onSubmit={(event) => {
              event.preventDefault()
              void submitAdd()
            }}
          >
            <TextArea
              label={scope === 'project' ? '新的项目记忆' : '新的全局记忆'}
              placeholder="例：周报按季度口径汇总；数字保留两位小数。"
              rows={3}
              value={draftText}
              maxLength={4000}
              onChange={(event) => setDraftText(event.target.value)}
              autoFocus
            />
            <div className="mc-add-row">
              <TextInput
                label="标签（可选，逗号分隔，最多 8 个）"
                placeholder="报表, 口径"
                value={draftTags}
                onChange={(event) => setDraftTags(event.target.value)}
              />
              <div className="mc-add-actions">
                <Button variant="ghost" type="button" onClick={resetDraft}>
                  取消
                </Button>
                <Button variant="gold" type="submit" loading={busy} disabled={!draftText.trim()}>
                  保存记忆
                </Button>
              </div>
            </div>
          </form>
        ) : null}

        {confirm ? (
          <div className="mc-confirm" role="alertdialog" aria-label="确认操作">
            <span>
              {confirm.kind === 'clear'
                ? `确定清空全部${scopeLabel}吗？清空后旧 MEMORY.md 里已迁移过的内容不会自动回来。`
                : '确定删除这条记忆吗？'}
            </span>
            <div className="mc-confirm-actions">
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                取消
              </Button>
              <Button variant="danger" size="sm" loading={busy} onClick={() => void confirmDelete()}>
                {confirm.kind === 'clear' ? '确认清空' : '确认删除'}
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="mc-loading">
            <Spinner label="读取记忆" /> 读取中…
          </div>
        ) : entries.length === 0 ? (
          <EmptyHint>
            {query.trim()
              ? `没有匹配「${query.trim()}」的记忆。`
              : scope === 'project'
                ? '这个项目还没有记忆。Morrow 记录的内容，或你自己添加的内容，都会出现在这里。'
                : '还没有全局记忆。可以记录跨项目都适用的偏好，例如输出语言、格式要求。'}
          </EmptyHint>
        ) : (
          <ul className="mc-list" aria-label={`${scopeLabel}列表`}>
            {entries.map((entry) => (
              <li key={entry.id} className={['mc-entry', entry.enabled ? '' : 'is-disabled'].filter(Boolean).join(' ')}>
                <div className="mc-entry-main">
                  {editingId === entry.id ? (
                    <div className="mc-entry-editor">
                      <TextArea
                        label="记忆内容"
                        rows={3}
                        value={editText}
                        maxLength={4000}
                        onChange={(event) => setEditText(event.target.value)}
                        autoFocus
                      />
                      <TextInput
                        label="标签（逗号分隔）"
                        value={editTags}
                        onChange={(event) => setEditTags(event.target.value)}
                      />
                      <div className="mc-entry-editor-actions">
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                          取消
                        </Button>
                        <Button
                          variant="gold"
                          size="sm"
                          loading={busyId === entry.id}
                          disabled={!editText.trim()}
                          onClick={() => void submitEdit(entry)}
                        >
                          保存修改
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mc-entry-text">{entry.text}</p>
                      <div className="mc-entry-meta">
                        <span className={`mc-source is-${entry.source}`}>{MEMORY_SOURCE_LABEL[entry.source]}</span>
                        <span className="mc-dot" aria-hidden>
                          ·
                        </span>
                        <time dateTime={new Date(entry.createdAt).toISOString()}>{formatMemoryTime(entry.createdAt)}</time>
                        {entry.tags.map((tag) => (
                          <span key={tag} className="mc-tag">
                            #{tag}
                          </span>
                        ))}
                        {!entry.enabled ? <span className="mc-disabled-note">已停用，不注入</span> : null}
                      </div>
                    </>
                  )}
                </div>
                <div className="mc-entry-actions">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={entry.enabled}
                    aria-label={entry.enabled ? '停用这条记忆' : '启用这条记忆'}
                    title={entry.enabled ? '停用后不会参考' : '启用后会在相关任务中参考'}
                    className={['mc-toggle', entry.enabled ? 'is-on' : ''].filter(Boolean).join(' ')}
                    disabled={busyId === entry.id}
                    onClick={() => void toggleEntry(entry)}
                  >
                    <span className="mc-toggle-thumb" />
                  </button>
                  <IconButton label="编辑这条记忆" size={26} onClick={() => startEdit(entry)}>
                    <Pencil size={12} strokeWidth={1.6} aria-hidden />
                  </IconButton>
                  <IconButton label="删除这条记忆" size={26} tone="danger" onClick={() => setConfirm({ kind: 'delete', id: entry.id })}>
                    <Trash2 size={12} strokeWidth={1.6} aria-hidden />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
