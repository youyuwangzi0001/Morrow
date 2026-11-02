import { useEffect, useId, useRef, useState } from 'react'
import {
  ChevronRight,
  Copy,
  Clapperboard,
  ExternalLink,
  FileCode2,
  FilePen,
  FilePlus2,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  MessageCircleQuestion,
  Search,
  Sparkles,
  Terminal,
  Undo2,
  Wrench
} from 'lucide-react'
import type { SwarmTaskProgress, ToolUseBlock } from '@shared/types'
import { swarmTasksFromMeta } from '@shared/swarm'
import { useAppStore } from '../../store'
import { CodeBlock } from '../../components/CodeBlock'
import { DiffView } from '../../components/DiffView'
import { formatDuration, extractDiff, toolDuration, toolStatusLabel, toolSummary, toolVisual, type ToolVisual } from './tool-meta'
import { MediaResultCard, readMediaMeta } from './MediaResultCard'
import './activity.css'

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
