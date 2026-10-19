/**
 * R10-E Projects 面板（独立受控组件，Lead 挂载：<ProjectsPanel open={...} onClose={...} />）。
 *
 * - 左侧项目列表（置顶/启用/工作区丢失提示），右侧编辑：名称、描述、项目指令、知识文件、启用/置顶；
 * - 新建项目默认使用当前会话工作区；知识文件支持「工作区内相对路径」或系统文件选择器，保存前逐个校验；
 * - 「上下文预览」展示会注入 Agent 的「项目指令 + 知识摘要 + 记忆中心」原文与 token 估算；
 * - 所有数据通过 window.morrow.features.invoke('feature:projects:*') 走真实主进程。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Eye,
  FileText,
  FolderSearch,
  Layers,
  Pin,
  PinOff,
  Plus,
  Save,
  Trash2
} from 'lucide-react'
import { useAppStore } from '../../state/store'
import {
  Badge,
  Button,
  EmptyHint,
  ErrorNote,
  IconButton,
  Modal,
  Spinner,
  Switch,
  TextArea,
  TextInput
} from '../../ui'
import {
  formatFileSize,
  formatProjectTime,
  projectsApi,
  workspaceName,
  type ProjectContext,
  type ProjectKnowledgeInfo,
  type ProjectSummary
} from './projects-api'
import './ProjectsPanel.css'

export interface ProjectsPanelProps {
  open: boolean
  onClose: () => void
  /** 可选：覆盖当前工作区；不传时自动取当前会话工作区 / 最近工作区 */
  workspace?: string | null
}

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

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
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

export function ProjectsPanel({ open, onClose, workspace: workspaceProp }: ProjectsPanelProps): React.JSX.Element {
  const storeWorkspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace)
  const workspace = workspaceProp !== undefined ? workspaceProp : storeWorkspace

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<ProjectForm>(EMPTY_FORM)
  const [formWorkspace, setFormWorkspace] = useState<string>('')
  const [knowledgeInput, setKnowledgeInput] = useState('')
  const [knowledgeInfo, setKnowledgeInfo] = useState<Record<string, ProjectKnowledgeInfo>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [preview, setPreview] = useState<ProjectContext | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)

  const selectedRef = useRef<string | null>(null)
  const creatingRef = useRef(false)
  selectedRef.current = selectedId
  creatingRef.current = creating

  const selected = useMemo(() => projects.find((project) => project.id === selectedId) ?? null, [projects, selectedId])
  const currentWorkspaceProject = useMemo(
    () => (workspace ? projects.find((project) => sameWorkspace(project.workspace, workspace)) ?? null : null),
    [projects, workspace]
  )

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
    // 知识文件校验 effect 会按当前 form.knowledgePaths 重新填充/覆盖。
    setPreview(null)
    setPreviewOpen(false)
    setConfirmDelete(false)
    setError(null)
    setNotice(null)
  }, [])

  const load = useCallback(
    async (preferId?: string | null): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const result = await projectsApi.list()
        setProjects(result.projects)
        const current = selectedRef.current
        const target =
          (preferId ? result.projects.find((project) => project.id === preferId) : null) ??
          (current ? result.projects.find((project) => project.id === current) : null) ??
          (workspace ? result.projects.find((project) => sameWorkspace(project.workspace, workspace)) : null) ??
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
    void load()
  }, [open, load])

  /* 知识文件逐个重新校验（大小/存在/边界），失效文件在保存前就能看到 */
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

  const startCreate = (): void => {
    setCreating(true)
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
      setError('先选择一个工作区，再创建项目。')
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
        await load(created.id)
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
      setNotice('项目已删除（工作区文件不受影响）')
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
      setNotice(next ? '项目已启用：上下文会注入 Agent' : '项目已停用：不再注入 Agent')
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
      setError('先选择工作区，再添加知识文件。')
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
      setError(errorText(err, '知识文件校验失败'))
    }
  }

  const pickKnowledge = async (): Promise<void> => {
    if (!formWorkspace) {
      setError('先选择工作区，再选择知识文件。')
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
      setError(errorText(err, '选择知识文件失败'))
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
      setError(errorText(err, '生成上下文预览失败'))
    } finally {
      setPreviewLoading(false)
    }
  }

  const editing = creating || !!selected
  const canCreateHere = !!workspace && !currentWorkspaceProject && !creating

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="项目"
      description="每个工作区可以有一个项目：写下说明和常用资料，Morrow 做任务时会参考。只有启用的项目才生效；资料必须放在当前工作区内。"
      width={940}
      ariaLabel="项目管理"
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
            <span className="pp-side-title">
              <Layers size={13} strokeWidth={1.6} aria-hidden /> 项目
            </span>
            <Badge tone="neutral">{projects.length}</Badge>
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
          ) : projects.length === 0 ? (
            <EmptyHint>还没有项目。为当前工作区建一个项目，写下这个项目的规矩和常用资料。</EmptyHint>
          ) : (
            <ul className="pp-project-list">
              {projects.map((project) => {
                const isCurrent = workspace ? sameWorkspace(project.workspace, workspace) : false
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
                        {project.active ? <Badge tone="gold">启用</Badge> : <Badge tone="neutral">停用</Badge>}
                        {isCurrent ? <Badge tone="success">当前工作区</Badge> : null}
                        {!project.workspaceExists ? (
                          <Badge tone="danger">
                            <AlertTriangle size={9} strokeWidth={2} aria-hidden /> 工作区丢失
                          </Badge>
                        ) : null}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {!workspace ? <p className="pp-side-note">当前会话还没有工作区：先选择一个文件夹才能建项目。</p> : null}
        </aside>

        <section className="pp-detail" aria-label="项目详情">
          {!editing ? (
            <div className="pp-empty">
              <EmptyHint>
                从左侧选择一个项目，或为当前工作区新建项目。项目知识只读取工作区内的文本文件，且不会发送到网络。
              </EmptyHint>
              <Button variant="gold" onClick={startCreate} icon={<Plus size={14} strokeWidth={1.8} aria-hidden />}>
                新建项目
              </Button>
            </div>
          ) : (
            <>
              <div className="pp-form-head">
                <div>
                  <h3 className="pp-form-title">{creating ? '新建项目' : form.name || selected?.name || '项目'}</h3>
                  <p className="pp-form-sub mono" title={formWorkspace}>
                    {formWorkspace ? shortenPath(formWorkspace) : '（未选择工作区）'}
                  </p>
                </div>
                {!creating && selected ? (
                  <span className="pp-form-updated mono">更新于 {formatProjectTime(selected.updatedAt)}</span>
                ) : null}
              </div>

              {notice ? (
                <p className="pp-notice" role="status">
                  <Check size={12} strokeWidth={2} aria-hidden /> {notice}
                </p>
              ) : null}
              {error ? <ErrorNote title="操作失败" detail={error} /> : null}

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
                  label="项目指令（会注入 Agent 的系统提示）"
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
                  description="启用后项目指令、知识摘要与记忆会注入 Agent；停用则不注入"
                />
                <Switch
                  checked={form.pinned}
                  onChange={(next) => void togglePinned(next)}
                  label="置顶"
                  description="在项目列表最前面显示"
                />
              </div>

              <section className="pp-knowledge" aria-label="项目知识文件">
                <header className="pp-knowledge-head">
                  <FileText size={13} strokeWidth={1.6} aria-hidden />
                  <span>知识文件</span>
                  <span className="pp-knowledge-count mono">
                    {form.knowledgePaths.length}/20 · 单文件 ≤512KB · 仅工作区内文本文件
                  </span>
                </header>

                {form.knowledgePaths.length === 0 ? (
                  <EmptyHint>还没有知识文件。可以添加工作区内的 md / txt / csv / json 等文本资料。</EmptyHint>
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
                          <IconButton label={`移除知识文件 ${relativePath}`} size={24} onClick={() => removeKnowledge(relativePath)}>
                            <Trash2 size={11} strokeWidth={1.6} aria-hidden />
                          </IconButton>
                        </li>
                      )
                    })}
                  </ul>
                )}

                <div className="pp-knowledge-add">
                  <TextInput
                    aria-label="知识文件相对路径"
                    placeholder="工作区内相对路径，例如 docs/brief.md"
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
                <section className="pp-preview" aria-label="上下文预览">
                  <header className="pp-preview-head">
                    <Eye size={13} strokeWidth={1.6} aria-hidden />
                    <span>会注入的上下文</span>
                    <span className="mono">
                      {preview.usedTokens}/{preview.limitTokens} tokens · 知识 {preview.knowledge.length} 个 · 记忆{' '}
                      {preview.memory?.included ?? 0} 条{preview.truncated ? ' · 已截断' : ''}
                    </span>
                  </header>
                  {preview.staleKnowledge.length > 0 ? (
                    <p className="pp-preview-warn">
                      <AlertTriangle size={11} strokeWidth={1.8} aria-hidden /> 已跳过失效知识文件：
                      {preview.staleKnowledge.map((item) => item.path).join('、')}
                    </p>
                  ) : null}
                  <pre className="pp-preview-text">{preview.text || '（项目还没有可注入的内容）'}</pre>
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
                  {previewOpen ? '收起预览' : '上下文预览'}
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
                  <span>确定删除项目「{selected.name}」吗？只删除项目配置，不会动工作区里的任何文件。</span>
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
        </section>
      </div>

      {canCreateHere ? (
        <div className="pp-cta">
          <span>当前工作区还没有项目。</span>
          <Button variant="gold" size="sm" onClick={startCreate}>
            为「{workspace ? workspaceName(workspace) : ''}」新建项目
          </Button>
        </div>
      ) : null}
    </Modal>
  )
}
