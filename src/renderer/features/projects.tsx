// projects 功能域组件：由 1 个 TSX 文件扁平合并。
import './projects.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, ArrowUpRight, Brain, Check, Eye, FileText, FolderSearch, Layers, LoaderCircle, MessageSquare, Pin, PinOff, Plus, Save, Sparkles, Trash2 } from 'lucide-react'
import type { SessionMeta } from '@shared/types'
import { useAppStore } from '../store'
import { Badge, Button, EmptyHint, ErrorNote, IconButton, Modal, Segmented, Spinner, Switch, TextArea, TextInput } from '../components'
import type { ProjectContext, ProjectKnowledgeInfo, ProjectSummary } from './projects-core'
import { formatFileSize, formatProjectTime, projectsApi, workspaceName } from './projects-core'
import { errorText } from '../components'

export interface ProjectsPanelProps {
  open: boolean
  onClose: () => void
  /** 可选：覆盖当前文件夹；不传时自动取当前对话文件夹 / 最近文件夹 */
  workspace?: string | null
  /** 打开时默认显示的视图：概览（项目主页）或说明与资料（编辑） */
  initialView?: ProjectsPanelView
}

export type ProjectsPanelView = 'home' | 'settings'

type ProjectScope = 'all' | 'current'

const PROJECT_SCOPE_OPTIONS: Array<{ value: ProjectScope; label: string; description: string }> = [
  { value: 'all', label: '全部项目', description: '显示所有文件夹的项目' },
  { value: 'current', label: '当前文件夹', description: '只显示当前文件夹的项目；没有时可新建' }
]

interface ProjectForm {
  name: string
  description: string
  instructions: string
  knowledgePaths: string[]
  pinned: boolean
  active: boolean
}

const EMPTY_FORM: ProjectForm = {
  name: '',
  description: '',
  instructions: '',
  knowledgePaths: [],
  pinned: false,
  active: true
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function sameWorkspace(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b)
}

function shortenPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

function shortTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const date = new Date(ts)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function ProjectsPanel({ open, onClose, workspace: workspaceProp, initialView = 'home' }: ProjectsPanelProps): React.JSX.Element {
  const storeWorkspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace)
  const workspace = workspaceProp !== undefined ? workspaceProp : storeWorkspace
  const sessions = useAppStore((s) => s.sessions)
  const runs = useAppStore((s) => s.runs)
  const pendingPermissions = useAppStore((s) => s.pendingPermissions)
  const pendingQuestions = useAppStore((s) => s.pendingQuestions)
  const sendKey = useAppStore((s) => s.settings.sendKey)
  const selectSession = useAppStore((s) => s.selectSession)

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [scope, setScope] = useState<ProjectScope>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [view, setView] = useState<ProjectsPanelView>(initialView)
  const [form, setForm] = useState<ProjectForm>(EMPTY_FORM)
  const [formWorkspace, setFormWorkspace] = useState<string>('')
  const [knowledgeInput, setKnowledgeInput] = useState('')
  const [knowledgeInfo, setKnowledgeInfo] = useState<Record<string, ProjectKnowledgeInfo>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [preview, setPreview] = useState<ProjectContext | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [homeContext, setHomeContext] = useState<ProjectContext | null>(null)
  const [homeContextLoading, setHomeContextLoading] = useState(false)
  const [draft, setDraft] = useState('')
  const [starting, setStarting] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  const selectedRef = useRef<string | null>(null)
  const creatingRef = useRef(false)
  const scopeRef = useRef<ProjectScope>('all')
  selectedRef.current = selectedId
  creatingRef.current = creating
  scopeRef.current = scope

  const selected = useMemo(() => projects.find((project) => project.id === selectedId) ?? null, [projects, selectedId])
  const currentWorkspaceProject = useMemo(
    () => (workspace ? projects.find((project) => sameWorkspace(project.workspace, workspace)) ?? null : null),
    [projects, workspace]
  )
  const visibleProjects = useMemo(
    () => (scope === 'current' && workspace
      ? projects.filter((project) => sameWorkspace(project.workspace, workspace))
      : projects),
    [projects, scope, workspace]
  )
  const projectSessions = useMemo(() => {
    if (!selected) return [] as SessionMeta[]
    return sessions
      .filter(
        (session) =>
          !session.temporary && session.workspace && sameWorkspace(session.workspace, selected.workspace)
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, selected])

  const applyProject = useCallback((project: ProjectSummary | null): void => {
    setSelectedId(project?.id ?? null)
    setCreating(false)
    setForm(
      project
        ? {
            name: project.name,
            description: project.description,
            instructions: project.instructions,
            knowledgePaths: project.knowledgePaths,
            pinned: project.pinned,
            active: project.active
          }
        : EMPTY_FORM
    )
    setFormWorkspace(project?.workspace ?? '')
    setKnowledgeInput('')
    // 不在这里清空 knowledgeInfo：切换/保存同一项目时保留已有大小信息，避免出现「校验中…」闪动；
    // 参考资料校验 effect 会按当前 form.knowledgePaths 重新填充/覆盖。
    setPreview(null)
    setPreviewOpen(false)
    setConfirmDelete(false)
    setError(null)
    setNotice(null)
    setDraft('')
    setSendError(null)
  }, [])

  const load = useCallback(
    async (preferId?: string | null): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const result = await projectsApi.list()
        setProjects(result.projects)
        const current = selectedRef.current
        const currentProject = workspace
          ? result.projects.find((project) => sameWorkspace(project.workspace, workspace)) ?? null
          : null
        const target = scopeRef.current === 'current'
          ? currentProject
          : (preferId ? result.projects.find((project) => project.id === preferId) : null) ??
            (current ? result.projects.find((project) => project.id === current) : null) ??
            currentProject ??
            result.projects[0] ??
            null
        if (!creatingRef.current) applyProject(target)
      } catch (err) {
        setError(errorText(err, '读取项目列表失败'))
      } finally {
        setLoading(false)
      }
    },
    [applyProject, workspace]
  )

  useEffect(() => {
    if (!open) return
    setView(initialView)
    setSendError(null)
    void load()
  }, [open, initialView, load])

  /* 概览视图：读取项目背景（说明 + 资料 + 记忆），用于项目主页展示 */
  useEffect(() => {
    if (!open || view !== 'home' || !selected || !selected.workspaceExists) {
      setHomeContext(null)
      return
    }
    let cancelled = false
    setHomeContextLoading(true)
    void projectsApi
      .context({ workspace: selected.workspace, maxTokens: 1600, ignoreActive: true })
      .then((result) => {
        if (!cancelled) setHomeContext(result)
      })
      .catch(() => {
        if (!cancelled) setHomeContext(null)
      })
      .finally(() => {
        if (!cancelled) setHomeContextLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, view, selected])

  useEffect(() => {
    if (!open || view !== 'home' || creating) return
    const timer = window.setTimeout(() => composerRef.current?.focus(), 200)
    return () => window.clearTimeout(timer)
  }, [open, view, creating, selectedId])

  /* 参考资料逐个重新校验（大小/存在/边界），失效文件在保存前就能看到 */
  const knowledgeKey = form.knowledgePaths.join('\u0000')
  useEffect(() => {
    if (!open || !formWorkspace) return
    let cancelled = false
    void (async () => {
      const next: Record<string, ProjectKnowledgeInfo> = {}
      for (const relativePath of form.knowledgePaths) {
        try {
          next[relativePath] = await projectsApi.validateKnowledge({ workspace: formWorkspace, path: relativePath })
        } catch (err) {
          next[relativePath] = {
            path: relativePath,
            name: relativePath.split(/[\\/]/).pop() ?? relativePath,
            size: 0,
            mtime: 0,
            error: errorText(err, '校验失败')
          }
        }
      }
      if (!cancelled) setKnowledgeInfo(next)
    })()
    return () => {
      cancelled = true
    }
  }, [open, formWorkspace, knowledgeKey])

  const changeScope = (next: ProjectScope): void => {
    if (next === scope) return
    setScope(next)
    setConfirmDelete(false)
    setNotice(null)
    setError(null)
    if (next === 'current') {
      if (currentWorkspaceProject) applyProject(currentWorkspaceProject)
      else applyProject(null)
    } else if (selectedId && !projects.some((project) => project.id === selectedId)) {
      applyProject(null)
    }
  }

  const startCreate = (): void => {
    setCreating(true)
    setView('settings')
    setSelectedId(null)
    setForm({ ...EMPTY_FORM, name: workspace ? workspaceName(workspace) : '' })
    setFormWorkspace(workspace ?? '')
    setKnowledgeInput('')
    setKnowledgeInfo({})
    setPreview(null)
    setPreviewOpen(false)
    setError(null)
    setNotice(null)
    setConfirmDelete(false)
  }

  const save = async (): Promise<void> => {
    if (!formWorkspace) {
      setError('先选择一个文件夹，再创建项目。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (creating) {
        const created = await projectsApi.create({
          workspace: formWorkspace,
          name: form.name,
          description: form.description,
          instructions: form.instructions,
          knowledgePaths: form.knowledgePaths,
          pinned: form.pinned,
          active: form.active
        })
        setCreating(false)
        creatingRef.current = false
        await load(created.id)
        setView('home')
        setNotice('项目已创建')
      } else if (selectedId) {
        const updated = await projectsApi.update({
          id: selectedId,
          name: form.name,
          description: form.description,
          instructions: form.instructions,
          knowledgePaths: form.knowledgePaths,
          pinned: form.pinned,
          active: form.active
        })
        const result = await projectsApi.list()
        setProjects(result.projects)
        const next = result.projects.find((project) => project.id === updated.id) ?? null
        if (next) applyProject(next)
        setNotice('项目已保存')
      }
    } catch (err) {
      setError(errorText(err, '保存项目失败'))
    } finally {
      setSaving(false)
    }
  }

  const removeProject = async (): Promise<void> => {
    if (!selectedId) return
    setSaving(true)
    setError(null)
    try {
      await projectsApi.remove({ id: selectedId })
      setConfirmDelete(false)
      await load(null)
      setNotice('项目已删除（文件夹文件不受影响）')
    } catch (err) {
      setError(errorText(err, '删除项目失败'))
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (next: boolean): Promise<void> => {
    if (!selectedId) {
      setForm((current) => ({ ...current, active: next }))
      return
    }
    try {
      await projectsApi.setActive({ id: selectedId, active: next })
      setForm((current) => ({ ...current, active: next }))
      const result = await projectsApi.list()
      setProjects(result.projects)
      setNotice(next ? '项目已启用：下次对话会带上这些内容' : '项目已停用：下次对话不再带上这些内容')
    } catch (err) {
      setError(errorText(err, '切换启用状态失败'))
    }
  }

  const togglePinned = async (next: boolean): Promise<void> => {
    if (!selectedId) {
      setForm((current) => ({ ...current, pinned: next }))
      return
    }
    try {
      await projectsApi.setPinned({ id: selectedId, pinned: next })
      setForm((current) => ({ ...current, pinned: next }))
      const result = await projectsApi.list()
      setProjects(result.projects)
    } catch (err) {
      setError(errorText(err, '切换置顶失败'))
    }
  }

  const addKnowledgeByPath = async (): Promise<void> => {
    const raw = knowledgeInput.trim()
    if (!raw) return
    if (!formWorkspace) {
      setError('先选择文件夹，再添加参考资料。')
      return
    }
    try {
      const info = await projectsApi.validateKnowledge({ workspace: formWorkspace, path: raw })
      setForm((current) =>
        current.knowledgePaths.includes(info.path)
          ? current
          : { ...current, knowledgePaths: [...current.knowledgePaths, info.path] }
      )
      setKnowledgeInfo((current) => ({ ...current, [info.path]: info }))
      setKnowledgeInput('')
      setError(null)
    } catch (err) {
      setError(errorText(err, '参考资料校验失败'))
    }
  }

  const pickProjectFolder = async (): Promise<void> => {
    setPickingWorkspace(true)
    setError(null)
    try {
      const result = await window.morrow.workspace.pick()
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      if (!result.data) return
      const existing = projects.find((project) => sameWorkspace(project.workspace, result.data!.path))
      if (existing) {
        setError(`这个文件夹已经是「${existing.name}」项目了，直接从左侧打开它。`)
        return
      }
      setFormWorkspace(result.data.path)
      setForm((current) => ({ ...current, name: current.name || result.data!.name }))
    } catch (err) {
      setError(errorText(err, '选择项目文件夹失败'))
    } finally {
      setPickingWorkspace(false)
    }
  }

  const pickKnowledge = async (): Promise<void> => {
    if (!formWorkspace) {
      setError('先选择文件夹，再选择参考资料。')
      return
    }
    setPicking(true)
    setError(null)
    try {
      const result = await projectsApi.pickKnowledge({ workspace: formWorkspace })
      if (result.errors.length > 0) {
        setError(result.errors.map((item) => `${item.path}：${item.error}`).join('；'))
      }
      if (result.files.length > 0) {
        setForm((current) => {
          const merged = [...current.knowledgePaths]
          for (const file of result.files) if (!merged.includes(file.path)) merged.push(file.path)
          return { ...current, knowledgePaths: merged }
        })
        setKnowledgeInfo((current) => {
          const next = { ...current }
          for (const file of result.files) next[file.path] = file
          return next
        })
      }
    } catch (err) {
      setError(errorText(err, '选择参考资料失败'))
    } finally {
      setPicking(false)
    }
  }

  const removeKnowledge = (relativePath: string): void => {
    setForm((current) => ({
      ...current,
      knowledgePaths: current.knowledgePaths.filter((path) => path !== relativePath)
    }))
  }

  const showPreview = async (): Promise<void> => {
    if (!selected) return
    if (previewOpen) {
      setPreviewOpen(false)
      return
    }
    setPreviewLoading(true)
    setError(null)
    try {
      const result = await projectsApi.context({
        workspace: selected.workspace,
        ignoreActive: true,
        memoryTokens: 400
      })
      setPreview(result)
      setPreviewOpen(true)
    } catch (err) {
      setError(errorText(err, '生成Morrow 会看到什么失败'))
    } finally {
      setPreviewLoading(false)
    }
  }

  const editing = creating || !!selected

  const startChat = async (): Promise<void> => {
    if (!selected || !selected.workspaceExists || starting) return
    const text = draft.trim()
    if (!text) return
    setStarting(true)
    setSendError(null)
    try {
      const state = useAppStore.getState()
      const created = await state.newSession({ workspace: selected.workspace })
      if (!created) {
        setSendError('新建对话失败，检查一下模型设置。')
        return
      }
      const sent = await state.sendMessage(text)
      if (!sent) {
        setSendError('消息没有发出去，检查一下模型连接后再试。')
        return
      }
      setDraft('')
      onClose()
    } finally {
      setStarting(false)
    }
  }

  const openBlankChat = async (): Promise<void> => {
    if (!selected || !selected.workspaceExists) return
    onClose()
    await useAppStore.getState().newSession({ workspace: selected.workspace })
  }

  const openProjectSession = (sessionId: string): void => {
    onClose()
    void selectSession(sessionId)
  }

  const onComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    const ctrlSend = sendKey === 'ctrl+enter'
    const sendNow = ctrlSend ? event.ctrlKey || event.metaKey : !event.shiftKey && !event.ctrlKey && !event.metaKey
    if (event.key === 'Enter' && sendNow) {
      event.preventDefault()
      void startChat()
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="项目"
      description="启用后的项目会把说明与资料带进新对话；记忆中心按自己的设置单独生效。"
      width={1040}
      ariaLabel="项目"
      footer={
        <footer className="pp-foot">
          <span className="pp-foot-note">
            <AlertTriangle size={11} strokeWidth={1.7} aria-hidden /> 项目资料只作为参考，不会被当成指令。
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </footer>
      }
    >
      <div className="pp-root">
        <aside className="pp-side" aria-label="项目列表">
          <div className="pp-side-head">
            <Segmented
              ariaLabel="项目范围"
              value={scope}
              options={PROJECT_SCOPE_OPTIONS}
              onChange={changeScope}
            />
            <div className="pp-side-spacer" />
            <Button
              variant="gold"
              size="sm"
              icon={<Plus size={13} strokeWidth={1.8} aria-hidden />}
              onClick={startCreate}
            >
              新建
            </Button>
          </div>

          {loading ? (
            <div className="pp-side-loading">
              <Spinner label="读取项目" /> 读取中…
            </div>
          ) : visibleProjects.length === 0 ? (
            <EmptyHint>
              {scope === 'current'
                ? workspace
                  ? '当前文件夹还没有项目。新建后，项目说明与资料只用于这个文件夹里的对话。'
                  : '先在顶栏选择一个文件夹，才能为当前文件夹建项目。'
                : '还没有项目。为当前文件夹建一个项目，写下这个项目的长期说明和常用资料。'}
            </EmptyHint>
          ) : (
            <ul className="pp-project-list">
              {visibleProjects.map((project) => {
                const isCurrent = workspace ? sameWorkspace(project.workspace, workspace) : false
                const conversationCount = sessions.filter(
                  (session) =>
                    !session.temporary && session.workspace && sameWorkspace(session.workspace, project.workspace)
                ).length
                return (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={[
                        'pp-project',
                        project.id === selectedId ? 'is-selected' : '',
                        isCurrent ? 'is-current' : ''
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-current={project.id === selectedId ? 'true' : undefined}
                      title={`${project.name}\n${project.workspace}`}
                      onClick={() => applyProject(project)}
                    >
                      <span className="pp-project-name">
                        {project.pinned ? <Pin size={11} strokeWidth={1.8} aria-hidden className="pp-pin" /> : null}
                        <span className="truncate">{project.name}</span>
                      </span>
                      <span className="pp-project-workspace mono">
                        <span className="truncate">{shortenPath(project.workspace)}</span>
                      </span>
                      <span className="pp-project-meta">
                        {project.active ? <Badge tone="gold">已启用</Badge> : <Badge tone="neutral">已停用</Badge>}
                        {isCurrent ? <Badge tone="success">当前文件夹</Badge> : null}
                        {!project.workspaceExists ? (
                          <Badge tone="danger">
                            <AlertTriangle size={9} strokeWidth={2} aria-hidden /> 文件夹丢失
                          </Badge>
                        ) : null}
                      </span>
                      <span className="pp-project-stats mono">
                        {conversationCount} 对话 · {project.knowledgeCount} 资料
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {!workspace ? <p className="pp-side-note">当前对话还没有文件夹：先选择一个文件夹才能建项目。</p> : null}
        </aside>

        <section className="pp-detail" aria-label="项目详情">
          {!editing ? (
            <div className="pp-empty">
              <EmptyHint>
                {scope === 'current' && workspace
                  ? `当前文件夹「${workspaceName(workspace)}」还没有项目。新建后，项目说明与资料只用于这个文件夹里的对话。`
                  : '从左侧选择一个项目，或为当前文件夹新建项目。项目说明与资料只用于这个文件夹里的对话。'}
              </EmptyHint>
              <Button variant="gold" onClick={startCreate} icon={<Plus size={14} strokeWidth={1.8} aria-hidden />}>
                新建项目
              </Button>
            </div>
          ) : (
            <>
              {!creating && selected ? (
                <div className="pp-tabs" role="tablist" aria-label="项目视图">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === 'home'}
                    className={view === 'home' ? 'is-active' : ''}
                    onClick={() => setView('home')}
                  >
                    概览
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === 'settings'}
                    className={view === 'settings' ? 'is-active' : ''}
                    onClick={() => setView('settings')}
                  >
                    说明与资料
                  </button>
                  <span className="pp-tabs-hint mono">只有启用的项目会参与对话</span>
                </div>
              ) : null}

              {notice ? (
                <p className="pp-notice" role="status">
                  <Check size={12} strokeWidth={2} aria-hidden /> {notice}
                </p>
              ) : null}
              {error ? <ErrorNote title="操作失败" detail={error} /> : null}

              {!creating && view === 'home' && selected ? (
                <div className="pp-home">
                  <header className="pp-home-head">
                    <div className="pp-home-state-row">
                      <span
                        className={[
                          'pp-home-state',
                          selected.workspaceExists ? (selected.active ? 'is-ok' : 'is-muted') : 'is-warn'
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <i />
                        {selected.workspaceExists ? (selected.active ? '已启用' : '已暂停') : '文件夹不在了'}
                      </span>
                      <IconButton
                        label={selected.pinned ? '取消置顶' : '置顶项目'}
                        size={24}
                        active={selected.pinned}
                        onClick={() => void togglePinned(!selected.pinned)}
                      >
                        {selected.pinned ? <PinOff size={12} strokeWidth={1.5} /> : <Pin size={12} strokeWidth={1.5} />}
                      </IconButton>
                    </div>
                    <h3 className="pp-home-title serif">{selected.name}</h3>
                    <p className="pp-home-desc">
                      {selected.description || '还没有项目描述，写一句让未来的自己知道这里在做什么。'}
                    </p>
                    <div className="pp-home-meta">
                      <span title={selected.workspace}>
                        <Layers size={11} strokeWidth={1.5} />
                        {shortenPath(selected.workspace)}
                      </span>
                      <span>
                        <MessageSquare size={11} strokeWidth={1.5} />
                        {projectSessions.length} 段对话
                      </span>
                      <span>
                        <FileText size={11} strokeWidth={1.5} />
                        {selected.knowledgeCount} 份资料
                      </span>
                      {homeContext?.memory && homeContext.memory.included > 0 ? (
                        <span>
                          <Brain size={11} strokeWidth={1.5} />
                          记忆 {homeContext.memory.included} 条
                        </span>
                      ) : null}
                    </div>
                    <div className="pp-home-actions">
                      <Button
                        variant="gold"
                        size="sm"
                        onClick={() => void openBlankChat()}
                        disabled={!selected.workspaceExists}
                        icon={<MessageSquare size={12} strokeWidth={1.7} />}
                      >
                        在项目中新建对话
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setView('settings')}
                        icon={<Save size={12} strokeWidth={1.6} />}
                      >
                        管理说明与资料
                      </Button>
                    </div>
                  </header>

                  {!selected.workspaceExists ? (
                    <div className="pp-home-warn">
                      <AlertTriangle size={13} strokeWidth={1.6} />
                      项目文件夹被移动或删除了。重新放回原路径，或在「说明与资料」里移除后重新创建项目。
                    </div>
                  ) : (
                    <section className="pp-home-start" aria-label="开始项目对话">
                      <div className="pp-home-start-head">
                        <p className="pp-home-start-label">开始对话</p>
                        <span className="pp-home-start-note">
                          <Sparkles size={10} strokeWidth={1.5} />
                          {selected.active ? '会自动带上项目说明与资料' : '项目已暂停：本次不会带上项目说明与资料'}
                        </span>
                      </div>
                      <div className="pp-home-composer">
                        <textarea
                          ref={composerRef}
                          rows={2}
                          value={draft}
                          spellCheck={false}
                          placeholder={`在「${selected.name}」里问点什么…`}
                          aria-label="项目内首条消息"
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={onComposerKeyDown}
                        />
                        <div className="pp-home-composer-foot">
                          <span className="mono">
                            {sendKey === 'ctrl+enter' ? 'Ctrl+Enter' : 'Enter'} 开始 · Shift+Enter 换行
                          </span>
                          <button
                            type="button"
                            className="pp-home-send"
                            aria-label="开始项目对话"
                            disabled={!draft.trim() || starting}
                            onClick={() => void startChat()}
                          >
                            {starting ? (
                              <LoaderCircle size={14} className="pp-home-spin" />
                            ) : (
                              <ArrowRight size={14} strokeWidth={1.8} />
                            )}
                          </button>
                        </div>
                      </div>
                      {sendError ? <p className="pp-home-error">{sendError}</p> : null}
                    </section>
                  )}

                  <div className="pp-home-cards">
                    <section className="pp-home-card">
                      <div className="pp-home-card-head">
                        <h4>项目说明</h4>
                        <button type="button" onClick={() => setView('settings')}>
                          编辑
                        </button>
                      </div>
                      {selected.instructions ? (
                        <p className="pp-home-instructions">{selected.instructions}</p>
                      ) : (
                        <p className="pp-home-empty">还没有长期说明。告诉 Morrow 这个项目是什么、你希望它怎么做。</p>
                      )}
                    </section>

                    <section className="pp-home-card">
                      <div className="pp-home-card-head">
                        <h4>
                          资料 <span className="mono">{selected.knowledgeCount}</span>
                        </h4>
                        <button type="button" onClick={() => setView('settings')}>
                          管理
                        </button>
                      </div>
                      {homeContextLoading ? (
                        <p className="pp-home-empty">正在读取资料…</p>
                      ) : (homeContext?.knowledge.length ?? 0) > 0 || (homeContext?.staleKnowledge.length ?? 0) > 0 ? (
                        <ul className="pp-home-knowledge">
                          {(homeContext?.knowledge ?? []).slice(0, 4).map((file) => (
                            <li key={file.path}>
                              <FileText size={11} strokeWidth={1.5} />
                              <span className="truncate">{file.path}</span>
                              <span className="mono pp-home-file-size">{formatFileSize(file.size)}</span>
                            </li>
                          ))}
                          {(homeContext?.staleKnowledge ?? []).slice(0, 2).map((file) => (
                            <li key={`stale-${file.path}`} className="is-stale" title={file.error}>
                              <AlertTriangle size={11} strokeWidth={1.5} />
                              <span className="truncate">{file.path}</span>
                              <span className="pp-home-file-size">失效</span>
                            </li>
                          ))}
                          {(homeContext?.knowledge.length ?? 0) > 4 ? (
                            <li className="pp-home-knowledge-more">还有 {(homeContext?.knowledge.length ?? 0) - 4} 份…</li>
                          ) : null}
                        </ul>
                      ) : (
                        <p className="pp-home-empty">还没有资料。把参考文档放进项目文件夹，再在管理里选进来。</p>
                      )}
                    </section>
                  </div>

                  <section className="pp-home-recent" aria-label="项目内对话">
                    <div className="pp-home-recent-head">
                      <h4>
                        项目内对话 <span className="mono">{projectSessions.length}</span>
                      </h4>
                      {projectSessions.length > 0 ? <span className="pp-home-recent-hint">继续之前的工作</span> : null}
                    </div>
                    {projectSessions.length === 0 ? (
                      <p className="pp-home-empty">这里还没有对话。从上面的输入框开始第一句。</p>
                    ) : (
                      <ul className="pp-home-sessions">
                        {projectSessions.slice(0, 6).map((session) => {
                          const attention = Boolean(pendingPermissions[session.id] || pendingQuestions[session.id])
                          const running = Boolean(runs[session.id])
                          return (
                            <li key={session.id}>
                              <button type="button" onClick={() => openProjectSession(session.id)}>
                                <span className="pp-home-session-icon" aria-hidden>
                                  {attention ? (
                                    <AlertTriangle size={12} strokeWidth={1.7} className="is-attention" />
                                  ) : running ? (
                                    <span className="pp-home-session-pulse" />
                                  ) : (
                                    <MessageSquare size={12} strokeWidth={1.5} />
                                  )}
                                </span>
                                <span className="pp-home-session-main">
                                  <span className="pp-home-session-title truncate">
                                    {session.title || '未命名对话'}
                                  </span>
                                  <span className="pp-home-session-preview truncate">
                                    {session.preview ||
                                      (attention ? '等待你的确认' : running ? '正在运行' : '还没有消息')}
                                  </span>
                                </span>
                                <span className="pp-home-session-time mono">{shortTime(session.updatedAt)}</span>
                                <ArrowUpRight size={12} strokeWidth={1.5} className="pp-home-session-open" />
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </section>
                </div>
              ) : (
                <>
              <div className="pp-form-head">
                <div>
                  <h3 className="pp-form-title">{creating ? '新建项目' : form.name || selected?.name || '项目'}</h3>
                  <p className="pp-form-sub mono" title={formWorkspace}>
                    {formWorkspace ? shortenPath(formWorkspace) : '（未选择文件夹）'}
                  </p>
                </div>
                {creating ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="pp-pick-folder"
                    loading={pickingWorkspace}
                    icon={<FolderSearch size={13} strokeWidth={1.6} aria-hidden />}
                    onClick={() => void pickProjectFolder()}
                  >
                    选择项目文件夹
                  </Button>
                ) : selected ? (
                  <span className="pp-form-updated mono">更新于 {formatProjectTime(selected.updatedAt)}</span>
                ) : null}
              </div>

              <div className="pp-fields">
                <TextInput
                  label="项目名称"
                  value={form.name}
                  maxLength={80}
                  placeholder="例：季度经营分析"
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                />
                <TextInput
                  label="一句话描述（可选）"
                  value={form.description}
                  maxLength={1000}
                  placeholder="例：面向管理层的季度数据分析与报告"
                  onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                />
                <TextArea
                  label="长期说明（Morrow 做任务时会参考）"
                  hint="写这个项目的背景、口径、规矩与禁止事项。例如：金额单位是元、报告必须用简体中文、不要改 in/ 下的原始数据。"
                  rows={7}
                  value={form.instructions}
                  maxLength={8000}
                  placeholder="例：\n- 本项目所有报表按季度口径汇总\n- 金额保留两位小数，单位：元\n- in/ 目录是原始数据，只能读不能改"
                  onChange={(event) => setForm((current) => ({ ...current, instructions: event.target.value }))}
                />
              </div>

              <div className="pp-switches">
                <Switch
                  checked={form.active}
                  onChange={(next) => void toggleActive(next)}
                  label="启用项目"
                  description="启用后长期说明与参考资料摘要会带给 Morrow；记忆中心按自己的设置单独注入"
                />
                <Switch
                  checked={form.pinned}
                  onChange={(next) => void togglePinned(next)}
                  label="置顶"
                  description="在项目列表最前面显示"
                />
              </div>

              <section className="pp-knowledge" aria-label="项目参考资料">
                <header className="pp-knowledge-head">
                  <FileText size={13} strokeWidth={1.6} aria-hidden />
                  <span>参考资料</span>
                  <span className="pp-knowledge-count mono">
                    {form.knowledgePaths.length}/20 · 单文件 ≤512KB · 仅文件夹内文本文件
                  </span>
                </header>

                {form.knowledgePaths.length === 0 ? (
                  <EmptyHint>还没有参考资料。可以添加文件夹内的 md / txt / csv / json 等文本资料。</EmptyHint>
                ) : (
                  <ul className="pp-knowledge-list">
                    {form.knowledgePaths.map((relativePath) => {
                      const info = knowledgeInfo[relativePath]
                      return (
                        <li key={relativePath} className={['pp-knowledge-item', info?.error ? 'is-invalid' : ''].join(' ')}>
                          <span className="pp-knowledge-path mono" title={relativePath}>
                            {relativePath}
                          </span>
                          {info?.error ? (
                            <span className="pp-knowledge-error">{info.error}</span>
                          ) : (
                            <span className="pp-knowledge-size mono">
                              {info ? `${formatFileSize(info.size)} · ${new Date(info.mtime).toLocaleDateString('zh-CN')}` : '校验中…'}
                            </span>
                          )}
                          <IconButton label={`移除参考资料 ${relativePath}`} size={24} onClick={() => removeKnowledge(relativePath)}>
                            <Trash2 size={11} strokeWidth={1.6} aria-hidden />
                          </IconButton>
                        </li>
                      )
                    })}
                  </ul>
                )}

                <div className="pp-knowledge-add">
                  <TextInput
                    aria-label="参考资料相对路径"
                    placeholder="文件夹内相对路径，例如 docs/brief.md"
                    value={knowledgeInput}
                    onChange={(event) => setKnowledgeInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void addKnowledgeByPath()
                      }
                    }}
                  />
                  <Button variant="secondary" size="sm" disabled={!knowledgeInput.trim()} onClick={() => void addKnowledgeByPath()}>
                    添加路径
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={picking}
                    icon={<FolderSearch size={13} strokeWidth={1.6} aria-hidden />}
                    onClick={() => void pickKnowledge()}
                  >
                    选择文件…
                  </Button>
                </div>
              </section>

              {previewOpen && preview ? (
                <section className="pp-preview" aria-label="Morrow 会看到什么">
                  <header className="pp-preview-head">
                    <Eye size={13} strokeWidth={1.6} aria-hidden />
                    <span>Morrow 会参考的内容</span>
                    <span className="mono">
                      项目内容 {preview.usedTokens}/{preview.limitTokens} tokens · 参考资料 {preview.knowledge.length} 个 · 记忆{' '}
                      {preview.memory?.included ?? 0} 条{preview.truncated ? ' · 已截断' : ''}
                    </span>
                  </header>
                  {preview.staleKnowledge.length > 0 ? (
                    <p className="pp-preview-warn">
                      <AlertTriangle size={11} strokeWidth={1.8} aria-hidden /> 已跳过失效的参考资料：
                      {preview.staleKnowledge.map((item) => item.path).join('、')}
                    </p>
                  ) : null}
                  <pre className="pp-preview-text">{preview.text || '（项目还没有可参考的内容）'}</pre>
                </section>
              ) : null}

              <div className="pp-actions">
                <Button
                  variant="gold"
                  icon={<Save size={14} strokeWidth={1.8} aria-hidden />}
                  loading={saving}
                  disabled={!formWorkspace || !form.name.trim()}
                  onClick={() => void save()}
                >
                  {creating ? '创建项目' : '保存项目'}
                </Button>
                <Button
                  variant="ghost"
                  icon={<Eye size={13} strokeWidth={1.6} aria-hidden />}
                  disabled={!selected || creating || previewLoading}
                  loading={previewLoading}
                  onClick={() => void showPreview()}
                >
                  {previewOpen ? '收起预览' : 'Morrow 会看到什么'}
                </Button>
                {!creating ? (
                  <Button
                    variant="ghost"
                    icon={form.pinned ? <PinOff size={13} strokeWidth={1.6} aria-hidden /> : <Pin size={13} strokeWidth={1.6} aria-hidden />}
                    onClick={() => void togglePinned(!form.pinned)}
                  >
                    {form.pinned ? '取消置顶' : '置顶'}
                  </Button>
                ) : null}
                <div className="pp-actions-spacer" />
                {creating ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setCreating(false)
                      const fallback = currentWorkspaceProject ?? projects[0] ?? null
                      applyProject(fallback)
                    }}
                  >
                    取消新建
                  </Button>
                ) : (
                  <Button variant="danger" icon={<Trash2 size={13} strokeWidth={1.6} aria-hidden />} onClick={() => setConfirmDelete(true)}>
                    删除项目
                  </Button>
                )}
              </div>

              {confirmDelete && selected ? (
                <div className="pp-confirm" role="alertdialog" aria-label="确认删除项目">
                  <span>确定删除项目「{selected.name}」吗？只删除项目配置，不会动文件夹里的任何文件。</span>
                  <div className="pp-confirm-actions">
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                      取消
                    </Button>
                    <Button variant="danger" size="sm" loading={saving} onClick={() => void removeProject()}>
                      确认删除
                    </Button>
                  </div>
                </div>
              ) : null}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </Modal>
  )
}
