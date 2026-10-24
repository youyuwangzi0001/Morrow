/**
 * A2 定时任务面板：新建 / 编辑 / 暂停 / 立即运行 / 查看上次结果。
 * 所有执行由主进程 ScheduleRuntime 真实完成；这里只做配置与状态展示。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlarmClock,
  Check,
  Clock3,
  FolderKanban,
  History,
  LoaderCircle,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import {
  WEEKDAY_LABELS,
  describeNextRun,
  describeSchedule,
  describeLastStatus,
  validateScheduleSpec,
  type ScheduledPermission,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskStatus,
  type ScheduleKind,
  type ScheduleSpec
} from '@shared/schedules'
import { useAppStore } from '../../store'
import { Button, IconButton, Modal, Segmented, Spinner, Switch, TextArea, TextInput } from '../../ui'
import { errorText } from '../../lib'
import './schedules.css'

/* ── feature:schedules:* 客户端 ───────────────────────────────── */

interface ScheduleState {
  tasks: ScheduledTask[]
  runningTaskIds: string[]
}

interface ScheduleMutation extends ScheduleState {
  task: ScheduledTask
}

const SCHEDULES_PREFIX = 'feature:schedules:'

async function invokeSchedules<T>(action: string, payload?: unknown): Promise<T> {
  const result = await window.morrow.features.invoke<T>(`${SCHEDULES_PREFIX}${action}`, payload)
  if (!result.ok) throw new Error(result.error.message || '定时任务操作失败')
  return result.data
}

const schedulesApi = {
  list: (): Promise<ScheduleState> => invokeSchedules('list'),
  create: (input: ScheduledTaskInput): Promise<ScheduleMutation> => invokeSchedules('create', input),
  update: (id: string, input: ScheduledTaskInput): Promise<ScheduleMutation> =>
    invokeSchedules('update', { id, ...input }),
  remove: (id: string): Promise<ScheduleState> => invokeSchedules('remove', { id }),
  setEnabled: (id: string, enabled: boolean): Promise<ScheduleMutation> =>
    invokeSchedules('set-enabled', { id, enabled }),
  runNow: (id: string): Promise<ScheduleState> => invokeSchedules('run-now', { id }),
  onChanged: (listener: (state: ScheduleState) => void): (() => void) => {
    return window.morrow.features.on('feature:schedules:changed', (payload) => {
      if (!payload || typeof payload !== 'object') return
      const state = payload as ScheduleState
      if (Array.isArray(state.tasks) && Array.isArray(state.runningTaskIds)) listener(state)
    })
  }
}

interface TaskForm {
  title: string
  prompt: string
  kind: ScheduleKind
  time: string
  date: string
  weekday: number
  workspace: string | null
  permissionMode: ScheduledPermission
  enabled: boolean
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function defaultForm(workspace: string | null): TaskForm {
  const target = new Date(Date.now() + 60 * 60 * 1000)
  target.setMinutes(0, 0, 0)
  return {
    title: '',
    prompt: '',
    kind: 'daily',
    time: `${pad(target.getHours())}:00`,
    date: `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`,
    weekday: target.getDay(),
    workspace,
    permissionMode: 'read-only',
    enabled: true
  }
}

function formOf(task: ScheduledTask): TaskForm {
  return {
    title: task.title,
    prompt: task.prompt,
    kind: task.schedule.kind,
    time: task.schedule.time,
    date: task.schedule.date ?? '',
    weekday: task.schedule.weekday ?? 0,
    workspace: task.workspace,
    permissionMode: task.permissionMode,
    enabled: task.enabled
  }
}

function buildSpec(form: TaskForm): ScheduleSpec {
  if (form.kind === 'once') return { kind: 'once', time: form.time, date: form.date }
  if (form.kind === 'weekly') return { kind: 'weekly', time: form.time, weekday: form.weekday }
  return { kind: 'daily', time: form.time }
}



function shortenPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

function lastRunText(task: ScheduledTask): string {
  if (!task.lastRunAt) return '还没运行过'
  const date = new Date(task.lastRunAt)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function statusTone(status: ScheduledTaskStatus): string {
  if (status === 'success') return 'is-ok'
  if (status === 'running') return 'is-running'
  if (status === 'error') return 'is-error'
  if (status === 'missed') return 'is-muted'
  return ''
}

export function ScheduledTasksPanel({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const currentWorkspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace ?? null)
  const selectSession = useAppStore((s) => s.selectSession)
  const sessions = useAppStore((s) => s.sessions)
  const [state, setState] = useState<ScheduleState>({ tasks: [], runningTaskIds: [] })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<TaskForm>(() => defaultForm(currentWorkspace))
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [runningBusy, setRunningBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  const selected = useMemo(
    () => state.tasks.find((task) => task.id === selectedId) ?? null,
    [state.tasks, selectedId]
  )
  const taskRunning = Boolean(selected && state.runningTaskIds.includes(selected.id))
  const lastSessionAvailable = Boolean(
    selected?.lastSessionId && sessions.some((session) => session.id === selected.lastSessionId)
  )
  const busy = saving || runningBusy || taskRunning || picking

  const applyTask = useCallback((task: ScheduledTask | null): void => {
    setSelectedId(task?.id ?? null)
    setCreating(false)
    setForm(task ? formOf(task) : defaultForm(currentWorkspace))
    setConfirmDelete(false)
    setError(null)
    setNotice(null)
  }, [currentWorkspace])

  const load = useCallback(async (preferId?: string | null): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const next = await schedulesApi.list()
      setState(next)
      const target =
        (preferId ? next.tasks.find((task) => task.id === preferId) : null) ??
        (selectedId ? next.tasks.find((task) => task.id === selectedId) : null) ??
        next.tasks[0] ??
        null
      if (target) applyTask(target)
      else {
        setSelectedId(null)
        setCreating(next.tasks.length === 0)
        setForm(defaultForm(currentWorkspace))
      }
    } catch (err) {
      setError(errorText(err, '读取定时任务失败'))
    } finally {
      setLoading(false)
    }
  }, [applyTask, currentWorkspace, selectedId])

  useEffect(() => {
    if (!open) return
    void load()
    const off = schedulesApi.onChanged((next) => setState(next))
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open || creating || !selectedId) return
    if (!state.tasks.some((task) => task.id === selectedId)) {
      const first = state.tasks[0] ?? null
      if (first) applyTask(first)
      else {
        setSelectedId(null)
        setCreating(true)
        setForm(defaultForm(currentWorkspace))
      }
    }
  }, [state.tasks, open, creating, selectedId, applyTask, currentWorkspace])

  // 自动运行可能把一次性任务停用；状态广播到达后同步开关，避免界面仍显示“启用”
  useEffect(() => {
    if (!open || creating || !selected) return
    setForm((current) =>
      current.enabled === selected.enabled ? current : { ...current, enabled: selected.enabled }
    )
  }, [open, creating, selected])

  const preview = useMemo(() => {
    try {
      const valid = validateScheduleSpec(buildSpec(form))
      return { text: describeNextRun(valid.nextRunAt, now), error: null as string | null }
    } catch (err) {
      return { text: null, error: errorText(err, '时间不合法') }
    }
  }, [form, now])

  const setField = <K extends keyof TaskForm>(key: K, value: TaskForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }))
    setNotice(null)
  }

  const startCreate = (): void => {
    setCreating(true)
    setSelectedId(null)
    setForm(defaultForm(currentWorkspace))
    setConfirmDelete(false)
    setError(null)
    setNotice(null)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      validateScheduleSpec(buildSpec(form))
      const input: ScheduledTaskInput = {
        title: form.title,
        prompt: form.prompt,
        schedule: buildSpec(form),
        workspace: form.workspace,
        permissionMode: form.permissionMode,
        enabled: form.enabled
      }
      if (creating) {
        const result = await schedulesApi.create(input)
        setState(result)
        applyTask(result.task)
        setNotice('定时任务已创建')
      } else if (selectedId) {
        const result = await schedulesApi.update(selectedId, input)
        setState(result)
        applyTask(result.task)
        setNotice('定时任务已保存')
      }
    } catch (err) {
      setError(errorText(err, '保存定时任务失败'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!selectedId) return
    setSaving(true)
    setError(null)
    try {
      const next = await schedulesApi.remove(selectedId)
      setState(next)
      setConfirmDelete(false)
      const first = next.tasks[0] ?? null
      if (first) applyTask(first)
      else {
        setCreating(true)
        setSelectedId(null)
        setForm(defaultForm(currentWorkspace))
      }
      setNotice('定时任务已删除（历史对话保留）')
    } catch (err) {
      setError(errorText(err, '删除定时任务失败'))
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (enabled: boolean): Promise<void> => {
    if (creating) {
      setField('enabled', enabled)
      return
    }
    if (!selectedId || taskRunning) return
    try {
      const result = await schedulesApi.setEnabled(selectedId, enabled)
      setState(result)
      setForm((current) => ({ ...current, enabled }))
      setNotice(enabled ? '已启用：到点会自动运行' : '已暂停：不会自动运行')
    } catch (err) {
      setError(errorText(err, '切换启用状态失败'))
    }
  }

  const runNow = async (): Promise<void> => {
    if (!selectedId || taskRunning) return
    setRunningBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = await schedulesApi.runNow(selectedId)
      setState(next)
      setNotice('已开始运行，完成后这里会更新结果。')
    } catch (err) {
      setError(errorText(err, '立即运行失败'))
    } finally {
      setRunningBusy(false)
    }
  }

  const pickWorkspace = async (): Promise<void> => {
    setPicking(true)
    setError(null)
    try {
      const result = await window.morrow.workspace.pick()
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      if (result.data) setField('workspace', result.data.path)
    } catch (err) {
      setError(errorText(err, '选择文件夹失败'))
    } finally {
      setPicking(false)
    }
  }

  const openLastResult = (): void => {
    if (!selected?.lastSessionId) return
    const sessionId = selected.lastSessionId
    onClose()
    void selectSession(sessionId)
  }

  const editorVisible = creating || Boolean(selected)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="定时任务"
      description="到点自动在新对话里执行。Morrow 需要保持运行；关闭窗口时选择「最小化到任务栏」即可。"
      width={1040}
      ariaLabel="定时任务"
      footer={
        <footer className="sch-foot">
          <span className="sch-foot-note">
            <ShieldCheck size={11} strokeWidth={1.6} /> 无人值守执行：默认只读；需要审批的高风险操作会自动拒绝；运行超过 30 分钟会自动停止。
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </footer>
      }
    >
      <div className="sch-root">
        <aside className="sch-side" aria-label="定时任务列表">
          <div className="sch-side-head">
            <span className="sch-side-title">
              <AlarmClock size={13} strokeWidth={1.6} /> 定时任务
            </span>
            <span className="sch-count mono">{state.tasks.length}</span>
            <span className="sch-side-spacer" />
            <Button variant="gold" size="sm" icon={<Plus size={13} strokeWidth={1.8} />} onClick={startCreate}>
              新建
            </Button>
          </div>
          <p className="sch-side-hint">到点后 Morrow 会新建一段对话并开始工作。</p>

          {loading ? (
            <div className="sch-side-loading">
              <Spinner /> 读取中…
            </div>
          ) : state.tasks.length === 0 ? (
            <div className="sch-empty-side">
              <Clock3 size={20} strokeWidth={1.3} />
              <p>还没有定时任务</p>
              <button type="button" onClick={startCreate}>
                安排第一件事
              </button>
            </div>
          ) : (
            <ul className="sch-list">
              {state.tasks.map((task) => {
                const running = state.runningTaskIds.includes(task.id)
                return (
                  <li key={task.id}>
                    <button
                      type="button"
                      className={['sch-task', task.id === selectedId && !creating ? 'is-active' : '', !task.enabled ? 'is-paused' : '']
                        .filter(Boolean)
                        .join(' ')}
                      aria-current={task.id === selectedId && !creating ? 'true' : undefined}
                      onClick={() => applyTask(task)}
                    >
                      <span className="sch-task-top">
                        <span className="sch-task-name truncate">{task.title}</span>
                        {running ? <i className="sch-pulse" title="正在运行" /> : null}
                        {!running && !task.enabled ? <span className="sch-paused-tag mono">暂停</span> : null}
                      </span>
                      <span className="sch-task-schedule truncate">{describeSchedule(task.schedule)}</span>
                      <span className="sch-task-meta mono">
                        {running
                          ? '正在运行'
                          : task.enabled
                            ? describeNextRun(task.nextRunAt, now)
                            : '不会自动运行'}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <p className="sch-side-foot mono">错过 1 小时内会补跑一次</p>
        </aside>

        <section className="sch-main" aria-label="定时任务详情">
          {!editorVisible ? (
            <div className="sch-empty">
              <span className="sch-empty-orb" aria-hidden>
                <AlarmClock size={24} strokeWidth={1.2} />
              </span>
              <h3 className="sch-empty-title serif">让重要的事自己发生</h3>
              <p>每天整理资料、每周写一份进展、某个时刻提醒自己——把时间和要做的事交给 Morrow。</p>
              <Button variant="gold" onClick={startCreate} icon={<Plus size={13} strokeWidth={1.7} />}>
                新建定时任务
              </Button>
            </div>
          ) : (
            <>
              <div className="sch-scroll">
              <header className="sch-head">
                {!creating && selected ? (
                  <div className="sch-head-top">
                    <span className={`sch-status ${statusTone(selected.lastStatus)}`}>
                      <i />
                      {describeLastStatus(selected.lastStatus)}
                    </span>
                    {selected.enabled ? (
                      <span className="sch-next mono">下次运行 {describeNextRun(selected.nextRunAt, now)}</span>
                    ) : null}
                  </div>
                ) : null}
                <h3 className="sch-title serif">{creating ? '安排一件新事情' : form.title || selected?.title || '定时任务'}</h3>
                {!creating && selected ? (
                  <p className="sch-sub">
                    {selected.lastRunAt ? `上次运行 ${lastRunText(selected)}` : '还没运行过'}
                    {lastSessionAvailable ? (
                      <button type="button" className="sch-link" onClick={openLastResult}>
                        <History size={11} strokeWidth={1.6} /> 查看上次对话
                      </button>
                    ) : null}
                  </p>
                ) : (
                  <p className="sch-sub">写清楚时间和要做的事，Morrow 到点会自动开始。</p>
                )}
              </header>

              {notice ? (
                <p className="sch-notice" role="status">
                  <Check size={12} strokeWidth={2} /> {notice}
                </p>
              ) : null}
              {error ? (
                <p className="sch-error" role="alert">
                  {error}
                </p>
              ) : null}
              {!creating && selected?.lastError ? (
                <p className="sch-last-error">
                  <X size={11} strokeWidth={2} /> 上次问题：{selected.lastError}
                </p>
              ) : null}
              {taskRunning ? (
                <p className="sch-running-note" role="status">
                  <LoaderCircle size={12} className="sch-spin" /> 正在运行，完成后状态会自动更新。
                </p>
              ) : null}

              <div className="sch-form">
                <TextInput
                  label="任务名称"
                  value={form.title}
                  maxLength={80}
                  placeholder="例：每周一整理项目进展"
                  disabled={taskRunning}
                  onChange={(event) => setField('title', event.target.value)}
                />

                <TextArea
                  label="要做什么"
                  hint="像交代同事一样写清楚结果。Morrow 不会向你提问，信息不足时会做合理假设并说明。"
                  rows={5}
                  value={form.prompt}
                  maxLength={20_000}
                  placeholder="例：查看项目里本周新增的文件和改动，汇总完成情况、风险和下一步，写成一份简短的周报。"
                  disabled={taskRunning}
                  onChange={(event) => setField('prompt', event.target.value)}
                />

                <div className="sch-field">
                  <span className="sch-label">什么时候做</span>
                  <div className="sch-schedule-row">
                    <Segmented
                      ariaLabel="执行频率"
                      value={form.kind}
                      options={[
                        { value: 'once', label: '一次' },
                        { value: 'daily', label: '每天' },
                        { value: 'weekly', label: '每周' }
                      ]}
                      onChange={(next) => setField('kind', next)}
                    />
                    <input
                      type="time"
                      className="sch-input sch-time"
                      aria-label="执行时间"
                      value={form.time}
                      disabled={taskRunning}
                      onChange={(event) => setField('time', event.target.value)}
                    />
                    {form.kind === 'once' ? (
                      <input
                        type="date"
                        className="sch-input sch-date"
                        aria-label="执行日期"
                        value={form.date}
                        disabled={taskRunning}
                        onChange={(event) => setField('date', event.target.value)}
                      />
                    ) : null}
                    {form.kind === 'weekly' ? (
                      <select
                        className="sch-input sch-select"
                        aria-label="星期几"
                        value={form.weekday}
                        disabled={taskRunning}
                        onChange={(event) => setField('weekday', Number(event.target.value))}
                      >
                        {WEEKDAY_LABELS.map((label, index) => (
                          <option key={label} value={index}>
                            {label}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                  <p className={`sch-preview${preview.error ? ' is-error' : ''}`}>
                    {preview.error ? preview.error : `下一次：${preview.text}`}
                  </p>
                </div>

                <div className="sch-field">
                  <span className="sch-label">在哪个文件夹工作</span>
                  <div className="sch-workspace">
                    <FolderKanban size={14} strokeWidth={1.5} />
                    <span className="sch-workspace-path truncate" title={form.workspace ?? undefined}>
                      {form.workspace ? shortenPath(form.workspace) : '不绑定文件夹（适合提醒、搜索与问答）'}
                    </span>
                    <Button variant="ghost" size="sm" loading={picking} disabled={taskRunning} onClick={() => void pickWorkspace()}>
                      选择文件夹
                    </Button>
                    {form.workspace ? (
                      <IconButton label="清除文件夹" size={24} disabled={taskRunning} onClick={() => setField('workspace', null)}>
                        <X size={11} strokeWidth={1.7} />
                      </IconButton>
                    ) : null}
                  </div>
                </div>

                <div className="sch-field">
                  <span className="sch-label">允许它做什么</span>
                  <Segmented
                    ariaLabel="权限"
                    value={form.permissionMode}
                    options={[
                      { value: 'read-only', label: '只读', description: '只能读取与搜索，不修改任何文件' },
                      { value: 'auto', label: '可修改文件', description: '允许自动修改文件，运行前会做撤销快照' }
                    ]}
                    onChange={(next) => setField('permissionMode', next)}
                  />
                  <p className="sch-preview">
                    {form.permissionMode === 'read-only'
                      ? '只读：不会修改文件夹里的任何内容。'
                      : '可修改：允许自动写入文件；每轮仍会生成撤销快照。'}
                  </p>
                </div>

                <div className="sch-enable">
                  <Switch
                    checked={form.enabled}
                    onChange={(next) => void toggleEnabled(next)}
                    label="启用自动执行"
                    description={form.enabled ? '到点自动运行。' : '暂停后不会自动运行，仍可随时立即运行。'}
                    disabled={taskRunning}
                  />
                </div>
              </div>

              </div>

              <div className="sch-actions">
                <Button
                  variant="gold"
                  icon={<Check size={13} strokeWidth={1.8} />}
                  loading={saving}
                  disabled={busy || !form.title.trim() || !form.prompt.trim()}
                  onClick={() => void save()}
                >
                  {creating ? '保存定时任务' : '保存修改'}
                </Button>
                {!creating ? (
                  <Button
                    variant="ghost"
                    icon={runningBusy ? <LoaderCircle size={13} className="sch-spin" /> : <Play size={13} strokeWidth={1.7} />}
                    disabled={busy}
                    onClick={() => void runNow()}
                  >
                    立即运行
                  </Button>
                ) : null}
                {!creating && lastSessionAvailable ? (
                  <Button variant="ghost" icon={<History size={13} strokeWidth={1.6} />} onClick={openLastResult}>
                    查看上次结果
                  </Button>
                ) : null}
                <span className="sch-actions-spacer" />
                {creating ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const first = state.tasks[0] ?? null
                      if (first) applyTask(first)
                      else setCreating(false)
                    }}
                  >
                    取消
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    icon={<Trash2 size={13} strokeWidth={1.6} />}
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    删除
                  </Button>
                )}
              </div>

              {confirmDelete && selected ? (
                <div className="sch-confirm" role="alertdialog" aria-label="确认删除定时任务">
                  <span>删除「{selected.title}」的定时安排？已经运行产生的对话会保留。</span>
                  <div className="sch-confirm-actions">
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                      取消
                    </Button>
                    <Button variant="danger" size="sm" loading={saving} onClick={() => void remove()}>
                      确认删除
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </Modal>
  )
}
