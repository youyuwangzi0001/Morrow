import { useEffect, useId, useRef, useState } from 'react'
import {
  Bot,
  ChevronRight,
  Copy,
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
import type { ToolUseBlock } from '@shared/types'
import { useAppStore } from '../../state/store'
import { CodeBlock } from '../../components/markdown/CodeBlock'
import { DiffView } from '../../components/diff/DiffView'
import { formatDuration, extractDiff, toolDuration, toolStatusLabel, toolSummary, toolVisual, type ToolVisual } from './tool-meta'

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
  subagent: <Bot size={14} strokeWidth={1.5} aria-hidden />,
  artifact: <FileCode2 size={14} strokeWidth={1.5} aria-hidden />,
  web: <Globe size={14} strokeWidth={1.5} aria-hidden />,
  memory: <Sparkles size={14} strokeWidth={1.5} aria-hidden />,
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
  subagent: '交给子代理',
  artifact: '生成产物',
  web: '查询网络',
  memory: '记下要点',
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
 * 行动轨迹中的一行：菱形节点 + 工具图标 + 人话标题 + mono 摘要 + 耗时。
 * 展开后是参数、结果、diff、子代理摘要。这是产品的签名元素，刻意不用卡片堆叠。
 */
export function ToolRow({ block, last = false }: ToolRowProps): React.JSX.Element {
  const copyText = useAppStore((s) => s.copyText)
  const undoFileChange = useAppStore((s) => s.undoFileChange)
  const [open, setOpen] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [undone, setUndone] = useState(false)
  const userToggled = useRef(false)
  const detailId = useId()
  const visual = toolVisual(block)
  const running = block.status === 'running'
  const elapsed = useElapsed(block.startedAt, running)
  const duration = running ? formatDuration(elapsed) : toolDuration(block)
  const statusLabel = toolStatusLabel(block.status)
  const summary = toolSummary(block)
  const diff = extractDiff(block.result, block)
  const failed = block.status === 'error' || block.status === 'denied'
  const subagent = block.subagent

  /* 撤销文件修改：主进程在写文件前做了快照（meta.snapshotPath） */
  const resultMeta = block.result?.meta ?? {}
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
    (block.name === 'write_file' || block.name === 'edit_file') &&
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

  useEffect(() => {
    if (failed && !userToggled.current) setOpen(true)
  }, [failed])

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
        last ? 'is-last' : '',
        subagent ? 'is-subagent' : ''
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
          {subagent ? <span className="spine-tag mono">子代理</span> : null}
          {statusLabel ? <span className={`spine-status mono is-${block.status}`}>{statusLabel}</span> : null}
          {summary ? <span className="spine-summary mono" title={summary}>{summary}</span> : null}
          {duration ? <span className="spine-duration mono">{duration}</span> : null}
          <ChevronRight className="spine-chevron" size={13} strokeWidth={1.6} aria-hidden />
        </button>

        {open ? (
          <div className="spine-detail" id={detailId}>
            {failed && block.result ? (
              <div className="spine-error" role="note">
                <p className="spine-error-title">{block.result.error || (block.status === 'denied' ? '这个操作被拒绝了。' : '这一步没有成功。')}</p>
                {block.result.hint ? <p className="spine-error-hint">{block.result.hint}</p> : null}
              </div>
            ) : null}

            {subagent ? (
              <div className="spine-subagent">
                <Bot size={13} strokeWidth={1.5} aria-hidden />
                <span>子代理：{subagent.label}</span>
                {typeof subagent.stepCount === 'number' ? <span className="mono">{subagent.stepCount} 步</span> : null}
              </div>
            ) : null}

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

            {block.result && (block.result.output || !failed) ? (
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
            ) : running ? (
              <p className="spine-empty">正在执行，结果出来后会显示在这里。</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
