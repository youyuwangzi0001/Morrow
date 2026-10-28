// activity 功能域组件：由 8 个 TSX 文件扁平合并。
import './activity.css'
import { useEffect, useState, useRef, useMemo, useId } from 'react'
import { ExternalLink, Film, FolderOpen, Image as ImageIcon, Play, ChevronDown, ShieldAlert, ShieldCheck, ShieldQuestion, Check, ClipboardList, FileText, Pencil, RotateCcw, X, ListChecks, CornerDownLeft, MessageCircleQuestion, Activity, Square, Globe2, ChevronRight, Copy, Clapperboard, FileCode2, FilePen, FilePlus2, Globe, Search, Sparkles, Terminal, Undo2, Wrench } from 'lucide-react'
import type { MediaToolMeta, PermissionDecision, PermissionRequest, SessionPlan, TodoItem, AskUserRequest, WebSearchSource, SwarmTaskProgress, ToolUseBlock } from '@shared/types'
import { formatBytes } from '@shared/types'
import { previewFile } from './artifacts-core'
import { useAppStore } from '../store'
import { Kbd, hasOpenModal } from '../components'
import { CodeBlock } from '../components'
import { DiffView } from '../components'
import type { ToolVisual } from './activity-core'
import { permissionExplanation, toolPath, formatDuration, extractDiff, toolDuration, toolStatusLabel, toolSummary, toolVisual } from './activity-core'
import { todoMatchesPlanStep } from '@shared/types'
import { swarmTasksFromMeta } from '@shared/types'

export function readMediaMeta(value: unknown): MediaToolMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.path !== 'string' || !record.path) return null
  if (record.kind !== 'image' && record.kind !== 'video' && record.kind !== 'audio') return null
  return {
    kind: record.kind,
    path: record.path,
    title: typeof record.title === 'string' && record.title ? record.title : record.path.split(/[\\/]/).pop() ?? '媒体成品',
    model: typeof record.model === 'string' ? record.model : '',
    engine: typeof record.engine === 'string' ? record.engine : '',
    bytes: typeof record.bytes === 'number' ? record.bytes : 0,
    ...(typeof record.artifactId === 'string' ? { artifactId: record.artifactId } : {}),
    ...(typeof record.width === 'number' ? { width: record.width } : {}),
    ...(typeof record.height === 'number' ? { height: record.height } : {}),
    ...(typeof record.durationSec === 'number' ? { durationSec: record.durationSec } : {}),
    ...(typeof record.seed === 'number' ? { seed: record.seed } : {}),
    ...(typeof record.elapsedMs === 'number' ? { elapsedMs: record.elapsedMs } : {}),
    ...(typeof record.thumbnailDataUrl === 'string' ? { thumbnailDataUrl: record.thumbnailDataUrl } : {})
  }
}

function durationText(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return ''
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${seconds.toFixed(1)} 秒`
}

export function MediaResultCard({ media }: { media: MediaToolMeta }): React.JSX.Element {
  const openCanvas = useAppStore((s) => s.openCanvas)
  const openArtifactExternal = useAppStore((s) => s.openArtifactExternal)
  const revealArtifact = useAppStore((s) => s.revealArtifact)
  const workspace = useAppStore((s) => s.session?.workspace ?? null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)

  useEffect(() => {
    if (!workspace || media.kind === 'image') return undefined
    let alive = true
    void previewFile(workspace, media.path)
      .then((meta) => {
        if (!alive) return
        if (meta.url) setPreviewUrl(meta.url)
        else setPreviewFailed(true)
      })
      .catch(() => {
        if (alive) setPreviewFailed(true)
      })
    return () => {
      alive = false
    }
  }, [media.kind, media.path, workspace])

  const isVideo = media.kind === 'video'
  const isAudio = media.kind === 'audio'
  const dimensions = media.width && media.height ? `${media.width}×${media.height}` : ''
  const meta = [dimensions, durationText(media.durationSec), media.bytes ? formatBytes(media.bytes) : '', media.model]
    .filter(Boolean)
    .join(' · ')

  const openInCanvas = (): void => {
    if (media.artifactId) openCanvas(media.artifactId)
  }

  return (
    <div className="spine-media" data-testid="tool-media-card" data-media-kind={media.kind}>
      <div className="spine-media-frame">
        {isVideo && previewUrl && !previewFailed ? (
          <video
            className="spine-media-video"
            data-testid="tool-media-video"
            src={previewUrl}
            poster={media.thumbnailDataUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={media.title}
            onError={() => setPreviewFailed(true)}
          />
        ) : isAudio && previewUrl && !previewFailed ? (
          <div className="spine-media-audio">
            <span className="spine-media-audio-icon" aria-hidden>
              <Film size={22} strokeWidth={1.3} />
            </span>
            <audio src={previewUrl} controls preload="metadata" aria-label={media.title} onError={() => setPreviewFailed(true)} />
          </div>
        ) : (
          <button
            type="button"
            className="spine-media-poster"
            onClick={openInCanvas}
            disabled={!media.artifactId}
            aria-label={media.artifactId ? `在画布打开${media.title}` : media.title}
            title={media.artifactId ? '在画布打开' : media.title}
          >
            {media.thumbnailDataUrl ? (
              <img data-testid="tool-media-thumb" src={media.thumbnailDataUrl} alt={media.title} loading="lazy" />
            ) : (
              <span className="spine-media-placeholder" aria-hidden>
                {isVideo ? <Film size={24} strokeWidth={1.2} /> : <ImageIcon size={24} strokeWidth={1.2} />}
              </span>
            )}
            {isVideo ? (
              <span className="spine-media-play" aria-hidden>
                <Play size={14} fill="currentColor" strokeWidth={0} />
              </span>
            ) : null}
            {isVideo && media.durationSec !== undefined ? (
              <span className="spine-media-badge mono">{durationText(media.durationSec)}</span>
            ) : null}
          </button>
        )}
      </div>
      <div className="spine-media-copy">
        <span className="spine-media-title" title={media.title}>
          {media.title}
        </span>
        <span className="spine-media-meta mono">{meta}</span>
        <div className="spine-media-actions">
          {media.artifactId ? (
            <button type="button" onClick={openInCanvas}>
              在画布打开
            </button>
          ) : null}
          <button type="button" onClick={() => void openArtifactExternal(media.path)}>
            <ExternalLink size={11} strokeWidth={1.6} aria-hidden />
            系统打开
          </button>
          <button type="button" onClick={() => void revealArtifact(media.path)}>
            <FolderOpen size={11} strokeWidth={1.6} aria-hidden />
            所在文件夹
          </button>
        </div>
      </div>
    </div>
  )
}

const RISK_META: Record<PermissionRequest['risk'], { label: string; description: string }> = {
  low: { label: '低风险', description: '只看不改，或随时能撤回' },
  medium: { label: '中风险', description: '会修改文件夹里的内容' },
  high: { label: '高风险', description: '可能影响文件夹外或删除数据' }
}

const RISK_ICON: Record<PermissionRequest['risk'], React.JSX.Element> = {
  low: <ShieldCheck size={14} strokeWidth={1.5} aria-hidden />,
  medium: <ShieldQuestion size={14} strokeWidth={1.5} aria-hidden />,
  high: <ShieldAlert size={14} strokeWidth={1.5} aria-hidden />
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable
}

/**
 * 权限卡：出现在对话流末尾，明确告诉用户「Morrow 想做什么、会发生什么」。
 * Enter = 允许一次，Esc = 拒绝（仅在没有输入框焦点时响应）。
 */
export function PermissionCard({ request }: { request: PermissionRequest }): React.JSX.Element {
  const respondPermission = useAppStore((s) => s.respondPermission)
  const cardRef = useRef<HTMLDivElement>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [submitting, setSubmitting] = useState<PermissionDecision | null>(null)

  /* 审批卡出现时把焦点移到主按钮：Enter 即可允许，且不会误触输入框的发送快捷键 */
  useEffect(() => {
    cardRef.current?.querySelector<HTMLButtonElement>('.perm-btn-primary')?.focus({ preventScroll: true })
  }, [])

  const risk = RISK_META[request.risk]
  const explanation = permissionExplanation(request)
  const allowAlways = request.allowAlways !== false
  const preview = request.preview
  const isDiff = preview?.kind === 'diff'
  const previewLines = preview ? preview.content.split('\n').length : 0
  const collapsible = isDiff && previewLines > 14
  const targetPath = toolPath({ name: request.toolName, input: request.input })
  const isNewFile = Boolean(isDiff && preview && /^---\s+\/dev\/null/m.test(preview.content))
  const diffLabel = targetPath ? `${targetPath}${isNewFile ? ' · 新文件' : ''}` : undefined
  // 标题和说明已经点了文件名时，不再重复一行「写入文件：…」
  const showSummary =
    Boolean(request.summary) &&
    request.summary !== explanation &&
    !(targetPath && request.summary.includes(targetPath))

  const respond = (decision: PermissionDecision): void => {
    if (submitting) return
    setSubmitting(decision)
    void respondPermission(decision).finally(() => setSubmitting(null))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 有弹窗盖在上面时，Esc/Enter 属于弹窗，不能误拒绝审批
      if (hasOpenModal()) return
      if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return
      const active = document.activeElement as HTMLElement | null
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        // 焦点在卡片内的按钮上时交给浏览器原生行为，避免一次按键触发两次
        if (active && cardRef.current?.contains(active) && active.tagName === 'BUTTON') return
        event.preventDefault()
        respond('once')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        respond('deny')
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
    // respond 依赖 submitting/respondPermission，这里只需要注册一次事件；用 ref 保持最新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting])

  return (
    <div
      className="permission-card"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="permission-title"
      aria-describedby="permission-desc"
      ref={cardRef}
      data-risk={request.risk}
    >
      <div className="permission-head">
        <span className="permission-risk-icon" aria-hidden>
          {RISK_ICON[request.risk]}
        </span>
        <h3 className="permission-title" id="permission-title">
          {request.title || 'Morrow 需要你的确认'}
        </h3>
        <span className={`permission-risk mono is-${request.risk}`} title={risk.description}>
          {risk.label}
        </span>
      </div>

      <p className="permission-desc" id="permission-desc">
        {explanation}
      </p>
      {showSummary ? <p className="permission-summary">{request.summary}</p> : null}

      {preview ? (
        <div className="permission-preview">
          {isDiff ? (
            <>
              <button
                type="button"
                className="permission-preview-toggle"
                aria-expanded={!collapsible || previewOpen}
                onClick={() => setPreviewOpen((value) => !value)}
                disabled={!collapsible}
              >
                <ChevronDown size={13} strokeWidth={1.6} aria-hidden />
                <span>{collapsible ? (previewOpen ? '收起改动预览' : `查看改动预览（${previewLines} 行）`) : '改动预览'}</span>
              </button>
              {!collapsible || previewOpen ? (
                <DiffView patch={preview.content} contextLines={2} maxHeight={260} filePath={diffLabel} />
              ) : null}
            </>
          ) : preview.kind === 'command' ? (
            <div className="permission-command">
              <span className="permission-prompt mono" aria-hidden>
                $
              </span>
              <code className="permission-command-text mono">{preview.content}</code>
            </div>
          ) : preview.kind === 'json' ? (
            <CodeBlock code={preview.content} language="json" bare foldAfter={10} />
          ) : (
            <pre className="permission-text mono">{preview.content}</pre>
          )}
        </div>
      ) : null}

      <div className="permission-actions">
        <button
          type="button"
          className="perm-btn perm-btn-primary"
          onClick={() => respond('once')}
          disabled={submitting !== null}
        >
          <span>允许一次</span>
          <Kbd>Enter</Kbd>
        </button>
        {allowAlways ? (
          <button
            type="button"
            className="perm-btn"
            onClick={() => respond('always')}
            disabled={submitting !== null}
            title="以后这个文件夹里的同类操作不再询问；可在「设置 → 权限」里取消"
          >
            始终允许（本文件夹）
          </button>
        ) : (
          <span
            className="permission-once-note"
            title="高风险操作、外部动作和越界访问不提供「始终允许」，每次都会重新询问。"
          >
            高风险 / 外部动作 · 需逐次确认
          </span>
        )}
        <button
          type="button"
          className="perm-btn perm-btn-deny"
          onClick={() => respond('deny')}
          disabled={submitting !== null}
        >
          <span>拒绝</span>
          <Kbd>Esc</Kbd>
        </button>
      </div>
      <p className="permission-foot">
        拒绝后 Morrow 会换一种做法继续；你也可以随时在输入框里告诉它该怎么做。
      </p>
    </div>
  )
}

const PlanCardEMPTY_TODOS: TodoItem[] = []

type EditorMode = 'revise' | 'reject' | null

function statusLabel(plan: SessionPlan): string {
  if (plan.status === 'pending') return '待批准'
  if (plan.status === 'executing') return '执行中'
  if (plan.status === 'completed') return '已完成'
  return '已拒绝'
}

/**
 * 计划卡：计划模式的审批与执行入口。
 * 待批准时可执行 / 修改 / 拒绝；执行中展示步骤进度并可继续中断的执行；
 * 拒绝后保留反馈，允许重新规划。计划正文同时以 Markdown 成品进入画布。
 */
export function PlanCard(): React.JSX.Element | null {
  const plan = useAppStore((s) => s.session?.plan ?? null)
  const todos = useAppStore((s) => s.session?.todos ?? PlanCardEMPTY_TODOS)
  const running = useAppStore((s) => !!s.run && s.run.sessionId === s.session?.id)
  const approvePlan = useAppStore((s) => s.approvePlan)
  const revisePlan = useAppStore((s) => s.revisePlan)
  const rejectPlan = useAppStore((s) => s.rejectPlan)
  const openCanvas = useAppStore((s) => s.openCanvas)
  const [editor, setEditor] = useState<EditorMode>(null)
  const [feedback, setFeedback] = useState('')
  const [collapsed, setCollapsed] = useState(false)

  const progress = useMemo(() => {
    if (!plan) return { completed: 0, total: 0 }
    const completed = plan.steps.filter((step) =>
      todos.some((todo) => todo.status === 'completed' && todoMatchesPlanStep(todo, step.text))
    ).length
    return { completed, total: plan.steps.length }
  }, [plan, todos])

  if (!plan) return null

  const pending = plan.status === 'pending'
  const executing = plan.status === 'executing'
  const completed = plan.status === 'completed'
  const rejected = plan.status === 'rejected'
  const canResume = executing && !running && progress.completed < progress.total

  const submitEditor = (): void => {
    if (!editor) return
    const note = feedback.trim()
    if (editor === 'revise') {
      if (!note) return
      void revisePlan(note)
    } else {
      void rejectPlan(note || undefined)
    }
    setEditor(null)
    setFeedback('')
  }

  return (
    <section
      className={[
        'plan-card',
        pending ? 'is-pending' : '',
        executing ? 'is-executing' : '',
        completed ? 'is-complete' : '',
        rejected ? 'is-rejected' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label="执行计划"
    >
      <button type="button" className="plan-card-head" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        <ClipboardList size={14} strokeWidth={1.5} className="plan-card-icon" aria-hidden />
        <span className="plan-card-kicker mono">{statusLabel(plan)}</span>
        <span className="plan-card-title truncate">{plan.title}</span>
        <span className="plan-card-count mono">
          {executing || completed ? `${progress.completed}/${progress.total}` : `${plan.steps.length} 步`}
        </span>
      </button>

      {!collapsed ? (
        <div className="plan-card-body">
          <p className="plan-card-summary selectable">{plan.summary}</p>
          {pending ? (
            <p className="plan-card-hint">批准后 Morrow 会自动切到工作模式并按步骤执行。</p>
          ) : null}

          <ol className="plan-card-steps">
            {plan.steps.map((step) => {
              const match = todos.find((todo) => todoMatchesPlanStep(todo, step.text))
              const done = completed || match?.status === 'completed'
              const active = executing && !done && match?.status === 'in_progress'
              return (
                <li
                  key={step.id}
                  className={['plan-card-step', done ? 'is-done' : '', active ? 'is-active' : ''].filter(Boolean).join(' ')}
                >
                  <span className="plan-card-step-mark" aria-hidden>
                    {done ? <Check size={11} strokeWidth={2} /> : null}
                  </span>
                  <span className="plan-card-step-text selectable">{step.text}</span>
                </li>
              )
            })}
          </ol>

          {plan.risks?.trim() ? (
            <div className="plan-card-risks">
              <span className="plan-card-risks-label mono">风险与前提</span>
              <p className="selectable">{plan.risks.trim()}</p>
            </div>
          ) : null}

          {rejected && plan.feedback ? (
            <p className="plan-card-feedback">你的反馈：{plan.feedback}</p>
          ) : null}

          {editor ? (
            <div className="plan-card-editor">
              <textarea
                className="plan-card-input input"
                value={feedback}
                autoFocus
                rows={2}
                placeholder={editor === 'revise' ? '说明要改什么（例如：先保留原表，再单独输出一份摘要）' : '可选：说明拒绝原因，便于之后重新规划'}
                aria-label={editor === 'revise' ? '计划修改意见' : '拒绝计划的原因'}
                onChange={(event) => setFeedback(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditor(null)
                  }
                }}
              />
              <div className="plan-card-editor-actions">
                <button type="button" className="plan-card-btn is-ghost" onClick={() => setEditor(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="plan-card-btn is-primary"
                  disabled={editor === 'revise' && !feedback.trim()}
                  onClick={submitEditor}
                >
                  {editor === 'revise' ? '重新规划' : '确认拒绝'}
                </button>
              </div>
            </div>
          ) : (
            <div className="plan-card-actions">
              {pending ? (
                <>
                  <button type="button" className="plan-card-btn is-primary" onClick={() => void approvePlan()}>
                    <Play size={12} strokeWidth={1.8} aria-hidden />
                    执行计划
                  </button>
                  <button type="button" className="plan-card-btn" onClick={() => setEditor('revise')}>
                    <Pencil size={12} strokeWidth={1.6} aria-hidden />
                    修改
                  </button>
                  <button type="button" className="plan-card-btn is-quiet" onClick={() => setEditor('reject')}>
                    <X size={12} strokeWidth={1.7} aria-hidden />
                    拒绝
                  </button>
                </>
              ) : null}

              {canResume ? (
                <button type="button" className="plan-card-btn is-primary" onClick={() => void approvePlan()}>
                  <Play size={12} strokeWidth={1.8} aria-hidden />
                  继续执行
                </button>
              ) : null}

              {rejected ? (
                <button type="button" className="plan-card-btn is-primary" onClick={() => setEditor('revise')}>
                  <RotateCcw size={12} strokeWidth={1.6} aria-hidden />
                  重新规划
                </button>
              ) : null}

              {plan.artifactId ? (
                <button
                  type="button"
                  className="plan-card-btn is-quiet"
                  onClick={() => openCanvas(plan.artifactId)}
                  title="在画布中查看计划文档"
                >
                  <FileText size={12} strokeWidth={1.5} aria-hidden />
                  计划文档
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

export interface PlanNoticeInfo {
  kind: 'approved' | 'resume' | 'revise'
  title?: string
}

export function parsePlanMessage(text: string): PlanNoticeInfo | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('【计划已获批准】')) {
    const title = /计划：([^\n]+)/.exec(trimmed)?.[1]?.trim()
    return { kind: 'approved', ...(title ? { title } : {}) }
  }
  if (trimmed.startsWith('【计划执行 · 继续】')) {
    const title = /计划：([^\n]+)/.exec(trimmed)?.[1]?.trim()
    return { kind: 'resume', ...(title ? { title } : {}) }
  }
  if (trimmed.startsWith('【修改计划】')) return { kind: 'revise' }
  return null
}

export function PlanNotice({ info }: { info: PlanNoticeInfo }): React.JSX.Element {
  const label =
    info.kind === 'approved'
      ? '计划已获批准 · 开始执行'
      : info.kind === 'resume'
        ? '继续执行计划'
        : '按你的反馈修改计划'
  return (
    <div className="plan-notice" role="status">
      <ClipboardList size={12} strokeWidth={1.5} aria-hidden />
      <span className="plan-notice-label">{label}</span>
      {info.title ? <span className="plan-notice-title truncate">{info.title}</span> : null}
    </div>
  )
}

/** 模块级常量：selector 必须返回稳定引用，避免 zustand 无限重渲染 */
const PlanTrayEMPTY_TODOS: TodoItem[] = []

const STATUS_TEXT: Record<TodoItem['status'], string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成'
}

/**
 * 计划托盘：有 todo 时出现在 Composer 上方。
 * 细线进度 + 方块状态点；进行中金色脉冲，完成铜绿 + 删除线弱化。
 */
export function PlanTray(): React.JSX.Element | null {
  const todos = useAppStore((s) => s.session?.todos ?? PlanTrayEMPTY_TODOS)
  const plan = useAppStore((s) => s.session?.plan ?? null)
  const expanded = useAppStore((s) => s.planExpanded)
  const setExpanded = useAppStore((s) => s.setPlanExpanded)
  const running = useAppStore((s) => !!s.run && s.run.sessionId === s.session?.id)

  // 计划模式下由 PlanCard 展示同一组步骤与状态，避免出现两套计划列表
  if (plan || todos.length === 0) return null

  const completed = todos.filter((todo) => todo.status === 'completed').length
  const allDone = completed === todos.length
  const active = todos.find((todo) => todo.status === 'in_progress') ?? null
  // 计划全部完成但运行还没结束：说明模型仍在做最后打磨，不能显示成彻底收工。
  const finishing = allDone && running
  // 运行结束后仍有 in_progress：保留真实状态，但不要再像「正在推进」那样闪动
  const idle = !running && !allDone && active !== null

  return (
    <section
      className={[
        'plan-tray',
        expanded ? 'is-expanded' : '',
        allDone ? 'is-complete' : '',
        finishing ? 'is-finishing' : '',
        idle ? 'is-idle' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label="计划"
    >
      <button
        type="button"
        className="plan-head"
        aria-expanded={expanded}
        aria-controls="plan-todo-list"
        onClick={() => setExpanded(!expanded)}
      >
        <ListChecks size={14} strokeWidth={1.5} className="plan-icon" aria-hidden />
        <span className="plan-title">{finishing ? '计划完成 · 收尾中' : allDone ? '计划完成' : '计划'}</span>
        <span className="plan-progress mono">
          {completed}/{todos.length}
        </span>
        {!expanded && active ? <span className="plan-current">{active.text}</span> : null}
        {running && !allDone ? <span className="plan-running mono">进行中</span> : null}
        {finishing ? <span className="plan-running mono">收尾中</span> : null}
        <ChevronDown size={14} strokeWidth={1.6} className="plan-chevron" aria-hidden />
      </button>

      <div className="plan-collapse" aria-hidden={!expanded}>
        <div className="plan-collapse-inner">
          <ul className="plan-list" id="plan-todo-list">
            {todos.map((todo) => (
              <li key={todo.id} className={`plan-item is-${todo.status}`}>
                <span className="plan-dot" aria-hidden />
                <span className="plan-text">{todo.text}</span>
                {todo.status === 'in_progress' && idle ? <span className="plan-item-state mono">未完成</span> : null}
                <span className="sr-only">
                  {todo.status === 'in_progress' && idle ? '未完成，当前任务已停止' : STATUS_TEXT[todo.status]}
                </span>
              </li>
            ))}
          </ul>
          <div className="plan-rule" aria-hidden>
            <span style={{ width: `${Math.round((completed / todos.length) * 100)}%` }} />
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * 提问卡：Agent 需要用户做一个选择时出现。
 * 有预设选项时点选即可；允许自定义输入时给一个单行输入框。
 */
export function QuestionCard({ request }: { request: AskUserRequest }): React.JSX.Element {
  const respondQuestion = useAppStore((s) => s.respondQuestion)
  const [custom, setCustom] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  /* 提问卡出现时聚焦：有自定义输入就聚焦输入框，否则聚焦第一个选项 */
  useEffect(() => {
    const root = cardRef.current
    if (!root) return
    const target = root.querySelector<HTMLElement>('.question-input') ?? root.querySelector<HTMLElement>('.question-option')
    target?.focus({ preventScroll: true })
  }, [])

  const answer = (value: string, label: string, isCustom = false): void => {
    if (submitting) return
    setSubmitting(true)
    void respondQuestion({ value, label, custom: isCustom }).finally(() => setSubmitting(false))
  }

  const submitCustom = (): void => {
    const text = custom.trim()
    if (!text) return
    answer(text, text, true)
  }

  return (
    <div className="question-card" role="alertdialog" aria-modal="false" aria-labelledby="question-title" ref={cardRef}>
      <div className="question-head">
        <MessageCircleQuestion size={15} strokeWidth={1.5} aria-hidden className="question-icon" />
        <h3 className="question-title" id="question-title">
          {request.question}
        </h3>
      </div>

      {request.options.length > 0 ? (
        <div className="question-options">
          {request.options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              className="question-option"
              onClick={() => answer(option.value, option.label)}
              disabled={submitting}
            >
              <span className="question-option-index mono" aria-hidden>
                {index + 1}
              </span>
              <span className="question-option-body">
                <span className="question-option-label">{option.label}</span>
                {option.description ? <span className="question-option-desc">{option.description}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {request.allowCustom ? (
        <div className="question-custom">
          <input
            className="question-input"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submitCustom()
              }
            }}
            placeholder="或者直接写下你的回答"
            aria-label="自定义回答"
            disabled={submitting}
          />
          <button type="button" className="question-submit" onClick={submitCustom} disabled={!custom.trim() || submitting}>
            <CornerDownLeft size={13} strokeWidth={1.6} aria-hidden />
            <span>提交</span>
          </button>
        </div>
      ) : null}

      <p className="question-foot">
        {request.allowCustom ? (
          <>
            按 <Kbd>Enter</Kbd> 提交回答。写清楚一点，Morrow 就能少猜一步。
          </>
        ) : (
          '选一个就好，Morrow 会根据你的选择继续。'
        )}
      </p>
    </div>
  )
}

function elapsedLabel(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function RunElapsed({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <span className="run-center-elapsed mono">{elapsedLabel(startedAt)}</span>
}

/**
 * 运行中心：展示所有对话的活动运行，支持切换/停止。
 * 仅有一个当前对话任务时不显示（输入框已有停止按钮）。
 */
export function RunCenter(): React.JSX.Element | null {
  const runs = useAppStore((s) => s.runs)
  const sessions = useAppStore((s) => s.sessions)
  const pendingPermissions = useAppStore((s) => s.pendingPermissions)
  const pendingQuestions = useAppStore((s) => s.pendingQuestions)
  const queues = useAppStore((s) => s.queues)
  const currentSessionId = useAppStore((s) => s.session?.id ?? null)
  const selectSession = useAppStore((s) => s.selectSession)
  const stopRunById = useAppStore((s) => s.stopRunById)
  const [expanded, setExpanded] = useState(true)

  const list = Object.values(runs)
  if (list.length === 0) return null
  if (list.length === 1 && list[0].sessionId === currentSessionId) return null

  const titleOf = (sessionId: string): string =>
    sessions.find((item) => item.id === sessionId)?.title ?? '对话'

  return (
    <section className={['run-center', expanded ? 'is-expanded' : ''].filter(Boolean).join(' ')} aria-label="运行中心">
      <button type="button" className="run-center-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <Activity size={13} strokeWidth={1.5} className="run-center-icon" aria-hidden />
        <span className="run-center-title">运行中心</span>
        <span className="run-center-count mono">{list.length}</span>
        <span className="run-center-hint">后台任务继续运行</span>
        <ChevronDown size={13} strokeWidth={1.6} className="run-center-chevron" aria-hidden />
      </button>
      {expanded ? (
        <ul className="run-center-list">
          {list.map((run) => {
            const isCurrent = run.sessionId === currentSessionId
            const waiting = Boolean(pendingPermissions[run.sessionId] || pendingQuestions[run.sessionId])
            const queued = queues[run.sessionId]?.length ?? 0
            return (
              <li
                key={run.runId}
                className={['run-center-item', isCurrent ? 'is-current' : '', waiting ? 'is-waiting' : '']
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className="run-center-dot" aria-hidden />
                <button type="button" className="run-center-main" onClick={() => void selectSession(run.sessionId)}>
                  <span className="run-center-name truncate">{titleOf(run.sessionId)}</span>
                  <span className="run-center-meta mono">
                    {isCurrent ? '当前对话' : '后台'} · <RunElapsed startedAt={run.startedAt} />
                    {waiting ? ' · 等待确认' : ''}
                    {queued > 0 ? ` · 队列 ${queued}` : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className="run-center-stop"
                  aria-label={`停止任务：${titleOf(run.sessionId)}`}
                  title="停止这个任务"
                  onClick={() => void stopRunById(run.runId)}
                >
                  <Square size={10} strokeWidth={2} fill="currentColor" aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}

interface SessionSource extends WebSearchSource {
  query: string
  provider: string
}

interface SourceGroup {
  query: string
  provider: string
  sources: SessionSource[]
}

function collectSourceGroups(
  session: ReturnType<typeof useAppStore.getState>['session']
): SourceGroup[] {
  if (!session) return []
  const seen = new Set<string>()
  const groups = new Map<string, SourceGroup>()
  for (const message of session.messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== 'web_search' || block.status !== 'success') continue
      const meta = block.result?.meta
      if (!meta || !Array.isArray(meta.sources)) continue
      const query = typeof meta.query === 'string' ? meta.query : ''
      const provider = typeof meta.provider === 'string' ? meta.provider : ''
      const key = `${provider}\u0000${query}`
      let group = groups.get(key)
      if (!group) {
        group = { query, provider, sources: [] }
        groups.set(key, group)
      }
      for (const raw of meta.sources as Array<Record<string, unknown>>) {
        const url = typeof raw.url === 'string' ? raw.url : ''
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
        seen.add(url)
        group.sources.push({
          rank: typeof raw.rank === 'number' ? raw.rank : group.sources.length + 1,
          title: typeof raw.title === 'string' ? raw.title : url,
          url,
          snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
          ...(typeof raw.publishedAt === 'string' ? { publishedAt: raw.publishedAt } : {}),
          ...(typeof raw.engine === 'string' ? { engine: raw.engine } : {}),
          query,
          provider
        })
      }
    }
  }
  return [...groups.values()].filter((group) => group.sources.length > 0)
}

/** 对话级来源面板：汇总所有 web_search 结果，点击用系统浏览器打开。 */
export function SourcesTray(): React.JSX.Element | null {
  const session = useAppStore((s) => s.session)
  const openExternal = useAppStore((s) => s.openExternal)
  const [expanded, setExpanded] = useState(false)
  const groups = useMemo(() => collectSourceGroups(session), [session])
  const sources = useMemo(() => groups.flatMap((group) => group.sources), [groups])

  if (sources.length === 0) return null

  return (
    <section className={['sources-tray', expanded ? 'is-expanded' : ''].filter(Boolean).join(' ')} aria-label="来源">
      <button type="button" className="sources-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <Globe2 size={13} strokeWidth={1.5} className="sources-icon" aria-hidden />
        <span className="sources-title">来源</span>
        <span className="sources-count mono">{sources.length}</span>
        {!expanded ? <span className="sources-preview truncate">{sources[0]?.title}</span> : null}
        <span className="sources-hint mono">{expanded ? '收起' : '查看'}</span>
        <ChevronDown size={13} strokeWidth={1.6} className="sources-chevron" aria-hidden />
      </button>
      {expanded ? (
        <ul className="sources-list">
          {groups.map((group) => (
            <li key={`${group.provider}:${group.query}`} className="sources-group">
              {groups.length > 1 ? (
                <div className="sources-group-head">
                  <span className="sources-group-query truncate">{group.query || '搜索结果'}</span>
                  <span className="sources-group-provider mono">{group.provider}</span>
                </div>
              ) : null}
              <ol className="sources-group-list">
                {group.sources.map((source, index) => (
                  <li key={source.url} className="sources-item">
                    <span className="sources-rank mono">[{source.rank || index + 1}]</span>
                    <div className="sources-body">
                      <button type="button" className="sources-link" onClick={() => void openExternal(source.url)} title={source.url}>
                        <span className="sources-link-title">{source.title || source.url}</span>
                        <ExternalLink size={10} strokeWidth={1.6} aria-hidden />
                      </button>
                      {source.snippet ? <p className="sources-snippet">{source.snippet}</p> : null}
                      <span className="sources-url mono">{source.url}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

const SWARM_STATUS_LABEL: Record<SwarmTaskProgress['status'], string> = {
  queued: '等待',
  running: '进行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  exhausted: '未完成'
}

const ICONS: Record<ToolVisual, React.JSX.Element> = {
  read: <FileText size={14} strokeWidth={1.5} aria-hidden />,
  write: <FilePlus2 size={14} strokeWidth={1.5} aria-hidden />,
  edit: <FilePen size={14} strokeWidth={1.5} aria-hidden />,
  search: <Search size={14} strokeWidth={1.5} aria-hidden />,
  command: <Terminal size={14} strokeWidth={1.5} aria-hidden />,
  list: <FolderOpen size={14} strokeWidth={1.5} aria-hidden />,
  glob: <FolderOpen size={14} strokeWidth={1.5} aria-hidden />,
  todo: <ListChecks size={14} strokeWidth={1.5} aria-hidden />,
  ask: <MessageCircleQuestion size={14} strokeWidth={1.5} aria-hidden />,
  artifact: <FileCode2 size={14} strokeWidth={1.5} aria-hidden />,
  web: <Globe size={14} strokeWidth={1.5} aria-hidden />,
  memory: <Sparkles size={14} strokeWidth={1.5} aria-hidden />,
  media: <Clapperboard size={14} strokeWidth={1.5} aria-hidden />,
  other: <Wrench size={14} strokeWidth={1.5} aria-hidden />
}

/** 后端 title 缺失时的兜底（正常不该出现） */
const FALLBACK_TITLE: Record<ToolVisual, string> = {
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  search: '搜索内容',
  command: '运行命令',
  list: '查看目录',
  glob: '查找文件',
  todo: '更新计划',
  ask: '向你提问',
  artifact: '生成成品',
  web: '查询网络',
  memory: '记下要点',
  media: '处理多媒体',
  other: '执行操作'
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  json: 'json',
  md: 'markdown',
  html: 'html',
  css: 'css',
  csv: 'text',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash'
}

function inferLanguage(block: ToolUseBlock): string | null {
  const path = typeof block.input?.path === 'string' ? block.input.path : typeof block.input?.file_path === 'string' ? block.input.file_path : null
  if (!path) return null
  const ext = path.split('.').pop()?.toLowerCase()
  return ext ? EXT_LANG[ext] ?? null : null
}

/** 运行中的工具显示实时耗时 */
function useElapsed(startedAt: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [active])
  if (!startedAt) return 0
  return Math.max(0, now - startedAt)
}

interface ToolRowProps {
  block: ToolUseBlock
  /** 同一助手消息内是否最后一条（用于轨迹竖线收尾） */
  last?: boolean
}

/**
 * 执行过程中的一行：菱形节点 + 工具图标 + 人话标题 + mono 摘要 + 耗时。
 * 展开后是参数、结果、diff、集群成员摘要。这是产品的签名元素，刻意不用卡片堆叠。
 */
export function ToolRow({ block, last = false }: ToolRowProps): React.JSX.Element {
  const copyText = useAppStore((s) => s.copyText)
  const undoFileChange = useAppStore((s) => s.undoFileChange)
  const openExternal = useAppStore((s) => s.openExternal)
  const [open, setOpen] = useState(false)
  const [openTask, setOpenTask] = useState<number | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [undone, setUndone] = useState(false)
  const userToggled = useRef(false)
  const detailId = useId()
  const visual = toolVisual(block)
  const running = block.status === 'running'
  const elapsed = useElapsed(block.startedAt, running)
  const duration = running ? formatDuration(elapsed) : toolDuration(block)
  const statusLabel = toolStatusLabel(block.status)
  const diff = extractDiff(block.result, block)
  const failed = block.status === 'error' || block.status === 'denied'
  const isSwarm = block.name === 'swarm'

  /* 撤销文件修改：主进程在写文件前做了快照（meta.snapshotPath） */
  const resultMeta = block.result?.meta ?? {}
  const mediaMeta = readMediaMeta(resultMeta.media)
  const webSources =
    block.name === 'web_search' && Array.isArray(resultMeta.sources)
      ? (resultMeta.sources as Array<Record<string, unknown>>).filter(
          (source) => typeof source.url === 'string' && /^https?:\/\//i.test(source.url)
        )
      : []
  const searchQuery = block.name === 'web_search' && typeof block.input?.query === 'string' ? block.input.query : ''
  const searchAnswer =
    block.name === 'web_search' && typeof resultMeta.answer === 'string' ? resultMeta.answer.trim() : ''
  /* swarm：输入给出编排，实时事件给出进度，结果 meta 给出最终摘要。三者按 index 合并。 */
  const swarmInputTasks =
    block.name === 'swarm' && Array.isArray(block.input?.tasks)
      ? (block.input.tasks as unknown[]).flatMap((raw, position) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
          const task = raw as Record<string, unknown>
          return [
            {
              index: position,
              title: typeof task.title === 'string' && task.title.trim() ? task.title : `子任务 ${position + 1}`,
              agent: typeof task.agent === 'string' && task.agent.trim() ? task.agent.trim() : 'general'
            }
          ]
        })
      : []
  const swarmFinal = new Map(
    swarmTasksFromMeta(block.result?.meta).map((task) => [task.index, task] as const)
  )
  const swarmLive = new Map((block.swarmTasks ?? []).map((task) => [task.index, task] as const))
  const swarmFallback: SwarmTaskProgress['status'] =
    block.status === 'error' || block.status === 'denied' || block.status === 'interrupted' ? 'cancelled' : 'queued'
  const swarmTasks: SwarmTaskProgress[] = swarmInputTasks.map((plan) => {
    const finalTask = swarmFinal.get(plan.index)
    const liveTask = swarmLive.get(plan.index)
    return {
      index: plan.index,
      title: plan.title,
      agent: plan.agent,
      ...(finalTask?.agentTitle ?? liveTask?.agentTitle
        ? { agentTitle: finalTask?.agentTitle ?? liveTask?.agentTitle }
        : {}),
      status: finalTask?.status ?? liveTask?.status ?? swarmFallback,
      ...(finalTask?.stepCount !== undefined || liveTask?.stepCount !== undefined
        ? { stepCount: finalTask?.stepCount ?? liveTask?.stepCount }
        : {}),
      ...(liveTask?.note ? { note: liveTask.note } : {}),
      ...(finalTask?.summary ?? liveTask?.summary ? { summary: finalTask?.summary ?? liveTask?.summary } : {}),
      ...(finalTask?.error ?? liveTask?.error ? { error: finalTask?.error ?? liveTask?.error } : {}),
      ...(finalTask?.operations ?? liveTask?.operations
        ? { operations: finalTask?.operations ?? liveTask?.operations }
        : {})
    }
  })
  const swarmCompleted = swarmTasks.filter((task) => task.status === 'completed').length
  const swarmRunning = swarmTasks.filter((task) => task.status === 'running').length
  const swarmFailed = swarmTasks.filter((task) =>
    ['failed', 'cancelled', 'exhausted'].includes(task.status)
  ).length
  const swarmGoal = isSwarm && typeof block.input?.goal === 'string' ? block.input.goal.trim() : ''
  const baseSummary = block.name === 'web_search'
    ? [`${webSources.length} 个来源`, searchAnswer ? searchAnswer.replace(/\s+/g, ' ').slice(0, 72) : '']
        .filter(Boolean)
        .join(' · ')
    : isSwarm
    ? [
        `${swarmCompleted}/${swarmTasks.length} 完成`,
        swarmRunning > 0 ? `${swarmRunning} 个进行中` : '',
        swarmFailed > 0 ? `${swarmFailed} 个未完成` : ''
      ]
        .filter(Boolean)
        .join(' · ')
    : toolSummary(block)
  // 失败详情默认收起后，行内摘要直接显示错误原因，便于不展开也能定位。
  const summary = !isSwarm && failed && block.result?.error ? block.result.error : baseSummary
  const snapshotPath = typeof resultMeta.snapshotPath === 'string' && resultMeta.snapshotPath ? resultMeta.snapshotPath : null
  const undoTarget =
    typeof resultMeta.absolutePath === 'string'
      ? resultMeta.absolutePath
      : typeof resultMeta.path === 'string'
        ? resultMeta.path
        : null
  const canUndo =
    !undone &&
    !undoing &&
    (block.name === 'write_file' ||
      block.name === 'edit_file' ||
      block.name === 'write_xlsx' ||
      block.name === 'edit_docx') &&
    block.status === 'success' &&
    Boolean(snapshotPath && undoTarget)

  const onUndo = async (): Promise<void> => {
    if (!snapshotPath || !undoTarget || undoing) return
    setUndoing(true)
    try {
      await undoFileChange(snapshotPath, undoTarget)
      setUndone(true)
    } finally {
      setUndoing(false)
    }
  }

  // 集群任务重要的是过程可见：开始运行时自动展开，用户手动收起后不再打扰。
  useEffect(() => {
    if (isSwarm && (block.status === 'running' || block.status === 'waiting') && !userToggled.current) {
      setOpen(true)
    }
    if (block.name === 'web_search' && block.status === 'running' && !userToggled.current) {
      setOpen(true)
    }
  }, [isSwarm, block.name, block.status])

  const toggle = (): void => {
    userToggled.current = true
    setOpen((value) => !value)
  }

  return (
    <div
      className={[
        'spine-row',
        `is-${block.status}`,
        open ? 'is-open' : '',
        last ? 'is-last' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="spine-node" aria-hidden />
      <div className="spine-row-body">
        <button type="button" className="spine-item" aria-expanded={open} aria-controls={detailId} onClick={toggle}>
          <span className="spine-icon" aria-hidden>
            {ICONS[visual]}
          </span>
          <span className="spine-title">{block.title || FALLBACK_TITLE[visual]}</span>
          {isSwarm ? <span className="spine-tag mono">集群成员</span> : null}
          {statusLabel ? <span className={`spine-status mono is-${block.status}`}>{statusLabel}</span> : null}
          {summary ? <span className="spine-summary mono" title={summary}>{summary}</span> : null}
          {duration ? <span className="spine-duration mono">{duration}</span> : null}
          <ChevronRight className="spine-chevron" size={13} strokeWidth={1.6} aria-hidden />
        </button>
        {running && typeof block.progressPercent === 'number' ? (
          <div
            className="spine-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(block.progressPercent)}
            aria-label={`${block.title || '任务'}进度`}
          >
            <span style={{ width: `${Math.max(2, Math.min(100, block.progressPercent))}%` }} />
          </div>
        ) : null}
        {mediaMeta ? <MediaResultCard media={mediaMeta} /> : null}

        {open ? (
          <div className="spine-detail" id={detailId}>
            {failed && block.result ? (
              <div className="spine-error" role="note">
                <p className="spine-error-title">{block.result.error || (block.status === 'denied' ? '这个操作被拒绝了。' : '这一步没有成功。')}</p>
                {block.result.hint ? <p className="spine-error-hint">{block.result.hint}</p> : null}
              </div>
            ) : null}

            {isSwarm ? (
              <div className="spine-section">
                <div className="spine-section-head">
                  <span className="mono">集群任务</span>
                  <span className="mono spine-section-name">{swarmTasks.length} 个</span>
                  {block.result?.output ? (
                    <button
                      type="button"
                      className="spine-copy"
                      onClick={() => void copyText(block.result?.output ?? '')}
                      aria-label="复制集群结果"
                      title="复制集群结果"
                    >
                      <Copy size={12} strokeWidth={1.6} aria-hidden />
                    </button>
                  ) : null}
                </div>
                {swarmGoal ? (
                  <p className="spine-swarm-goal">
                    <span className="mono">总目标</span>
                    <span>{swarmGoal}</span>
                  </p>
                ) : null}
                <ul className="spine-swarm-tasks">
                  {swarmTasks.map((task) => (
                    <li
                      className={`spine-swarm-task is-${task.status}`}
                      key={`${task.index}-${task.title}`}
                    >
                      <span className="spine-swarm-index mono">{String(task.index + 1).padStart(2, '0')}</span>
                      <div className="spine-swarm-main">
                        <button
                          type="button"
                          className="spine-swarm-line spine-swarm-task-toggle"
                          aria-expanded={openTask === task.index}
                          onClick={() => setOpenTask((value) => (value === task.index ? null : task.index))}
                          title={task.operations?.length ? '展开成员实际操作' : task.title}
                        >
                          <span className="spine-swarm-title truncate">{task.title}</span>
                          <span className="spine-swarm-role mono">{task.agentTitle ?? task.agent}</span>
                          <span className={`spine-swarm-status mono is-${task.status}`}>
                            {SWARM_STATUS_LABEL[task.status]}
                          </span>
                          {task.stepCount ? (
                            <span className="spine-swarm-steps mono">{task.stepCount} 步</span>
                          ) : null}
                          {task.operations && task.operations.length > 0 ? (
                            <span className="spine-swarm-ops-count mono">{task.operations.length} 操作</span>
                          ) : null}
                          <ChevronRight
                            className={['spine-swarm-chevron', openTask === task.index ? 'is-open' : ''].filter(Boolean).join(' ')}
                            size={12}
                            strokeWidth={1.6}
                            aria-hidden
                          />
                        </button>
                        {task.status === 'running' && task.note ? (
                          <span className="spine-swarm-note">{task.note}</span>
                        ) : null}
                        {task.summary ? <span className="spine-swarm-summary">{task.summary}</span> : null}
                        {task.error ? <span className="spine-swarm-error">{task.error}</span> : null}
                        {openTask === task.index && task.operations && task.operations.length > 0 ? (
                          <div className="spine-swarm-ops">
                            {task.operations.map((operation) => (
                              <div className={`spine-swarm-op is-${operation.status}`} key={operation.id}>
                                <span className="spine-swarm-op-icon" aria-hidden>
                                  {operation.name === 'run_command' || operation.name === 'terminal' ? (
                                    <Terminal size={11} strokeWidth={1.5} />
                                  ) : operation.name === 'write_file' ? (
                                    <FilePlus2 size={11} strokeWidth={1.5} />
                                  ) : operation.name === 'edit_file' ? (
                                    <FilePen size={11} strokeWidth={1.5} />
                                  ) : operation.name.startsWith('web_') || operation.name === 'browser_open' ? (
                                    <Globe size={11} strokeWidth={1.5} />
                                  ) : (
                                    <Wrench size={11} strokeWidth={1.5} />
                                  )}
                                </span>
                                <span className="spine-swarm-op-main">
                                  <span className="spine-swarm-op-line">
                                    <span className="spine-swarm-op-title">{operation.title || operation.name}</span>
                                    <span className="mono spine-swarm-op-name">{operation.name}</span>
                                    {operation.startedAt && operation.finishedAt ? (
                                      <span className="mono spine-swarm-op-time">
                                        {formatDuration(operation.finishedAt - operation.startedAt)}
                                      </span>
                                    ) : null}
                                  </span>
                                  {operation.input ? (
                                    <span className="mono spine-swarm-op-param">{operation.input}</span>
                                  ) : null}
                                  {operation.output ? (
                                    <span className="spine-swarm-op-output">{operation.output}</span>
                                  ) : null}
                                  {operation.error ? (
                                    <span className="spine-swarm-op-error">{operation.error}</span>
                                  ) : null}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : block.name === 'web_search' ? null : (
              <div className="spine-section">
                <div className="spine-section-head">
                  <span className="mono">参数</span>
                  <span className="mono spine-section-name">{block.name}</span>
                  <button
                    type="button"
                    className="spine-copy"
                    onClick={() => void copyText(JSON.stringify(block.input, null, 2))}
                    aria-label="复制参数"
                    title="复制参数"
                  >
                    <Copy size={12} strokeWidth={1.6} aria-hidden />
                  </button>
                </div>
                <CodeBlock code={JSON.stringify(block.input ?? {}, null, 2)} language="json" bare foldAfter={8} />
              </div>
            )}

            {diff ? (
              <div className="spine-section">
                <div className="spine-section-head">
                  <span className="mono">改动</span>
                </div>
                <DiffView
                  patch={diff.patch}
                  before={diff.before}
                  after={diff.after}
                  filePath={diff.filePath}
                  contextLines={2}
                  maxHeight={260}
                />
              </div>
            ) : null}

            {block.result && block.name !== 'swarm' && block.name !== 'web_search' && (block.result.output || !failed) ? (
              <div className="spine-section">
                <div className="spine-section-head">
                  <span className="mono">结果</span>
                  {typeof block.result.durationMs === 'number' ? (
                    <span className="mono spine-section-name">{formatDuration(block.result.durationMs)}</span>
                  ) : null}
                  {block.result.output ? (
                    <button
                      type="button"
                      className="spine-copy"
                      onClick={() => void copyText(block.result?.output ?? '')}
                      aria-label="复制结果"
                      title="复制结果"
                    >
                      <Copy size={12} strokeWidth={1.6} aria-hidden />
                    </button>
                  ) : null}
                </div>
                {block.result.output ? (
                  <CodeBlock
                    code={block.result.output}
                    language={inferLanguage(block)}
                    bare
                    foldAfter={24}
                    lineNumbers={false}
                  />
                ) : (
                  <p className="spine-empty">这一步没有文本输出。</p>
                )}
                {canUndo || undone ? (
                  <div className="spine-undo-row">
                    <button
                      type="button"
                      className="spine-undo"
                      onClick={() => void onUndo()}
                      disabled={undoing || undone}
                      title="恢复到这次修改之前的内容"
                    >
                      <Undo2 size={11} strokeWidth={1.6} aria-hidden />
                      <span>{undone ? '已恢复' : undoing ? '正在恢复…' : '撤销这次修改'}</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : running && block.name !== 'swarm' ? (
              <p className="spine-empty">正在执行，结果出来后会显示在这里。</p>
            ) : null}

            {block.name === 'web_search' ? (
              <div className="spine-section spine-search">
                <div className="spine-section-head">
                  <span className="mono">搜索</span>
                  <span className="mono spine-section-name">{searchQuery || '联网搜索'}</span>
                </div>
                {searchAnswer ? <p className="spine-search-answer selectable">{searchAnswer}</p> : null}
                {webSources.length > 0 ? (
                  <div className="spine-search-chips">
                    {webSources.slice(0, 6).map((source, index) => {
                      const url = String(source.url)
                      const title = typeof source.title === 'string' && source.title ? source.title : url
                      return (
                        <button
                          type="button"
                          className="spine-search-chip"
                          key={`${url}-${index}`}
                          onClick={() => void openExternal(url)}
                          title={url}
                        >
                          <span className="mono">{index + 1}</span>
                          <span className="truncate">{title}</span>
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

            {webSources.length > 0 ? (
              <div className="spine-section">
                <div className="spine-section-head">
                  <span className="mono">来源</span>
                  <span className="mono spine-section-name">{webSources.length} 条</span>
                </div>
                <ul className="spine-sources">
                  {webSources.map((source, index) => {
                    const url = String(source.url)
                    const title = typeof source.title === 'string' && source.title ? source.title : url
                    return (
                      <li key={`${url}-${index}`}>
                        <button
                          type="button"
                          className="spine-source"
                          onClick={() => void openExternal(url)}
                          title={url}
                        >
                          <span className="spine-source-rank mono">[{index + 1}]</span>
                          <span className="spine-source-title">{title}</span>
                          <ExternalLink size={10} strokeWidth={1.6} aria-hidden />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 执行过程（Spine）：同一条助手消息内的工具调用按顺序串成一条竖线。 */
export function ActivitySpine({ blocks }: { blocks: ToolUseBlock[] }): React.JSX.Element | null {
  if (blocks.length === 0) return null
  return (
    <div className="spine" role="group" aria-label="执行过程">
      {blocks.map((block, index) => (
        <ToolRow key={block.id} block={block} last={index === blocks.length - 1} />
      ))}
    </div>
  )
}
