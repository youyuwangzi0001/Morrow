// 深度研究进度条：显示轮次、独立来源数、当前阶段与最终报告入口。
import { useEffect, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, FileText, LoaderCircle, PencilLine, Play, Telescope, Square } from 'lucide-react'
import { RESEARCH_DEPTHS } from '@shared/research'
import type { ResearchStatus } from '@shared/types'
import { useAppStore } from '../../store'
import { Button } from '../../ui'
import './ResearchBar.css'

const STATUS_LABEL: Record<ResearchStatus, string> = {
  idle: '待开始',
  planning: '制定计划中',
  ready: '计划待确认',
  searching: '研究中',
  completed: '已完成',
  stopped: '已停止',
  error: '出错了'
}

function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes} 分 ${rest} 秒`
}

function SourceMeter({ value, target }: { value: number; target: number }): React.JSX.Element {
  const percent = Math.min(100, Math.round((value / Math.max(1, target)) * 100))
  return (
    <span className="research-meter" aria-hidden>
      <span className="research-meter-fill" style={{ width: `${percent}%` }} />
    </span>
  )
}

export function ResearchBar(): React.JSX.Element | null {
  const session = useAppStore((s) => s.session)
  const run = useAppStore((s) => s.run)
  const openCanvas = useAppStore((s) => s.openCanvas)
  const stopRun = useAppStore((s) => s.stopRun)
  const startResearch = useAppStore((s) => s.startResearch)
  const steerResearch = useAppStore((s) => s.steerResearch)
  const setSessionMode = useAppStore((s) => s.setSessionMode)
  const [expanded, setExpanded] = useState(false)
  const [planDraft, setPlanDraft] = useState('')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [steerDraft, setSteerDraft] = useState('')
  const [steering, setSteering] = useState(false)
  const [steerNotice, setSteerNotice] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const research = session?.research ?? null
  const researchStatus = research?.status

  useEffect(() => {
    setSteerDraft('')
    setSteerNotice(null)
    setSteering(false)
  }, [session?.id, researchStatus])

  useEffect(() => {
    if (researchStatus === 'ready') setExpanded(true)
  }, [researchStatus])

  useEffect(() => {
    setPlanDraft(research?.plan ?? '')
    setStartError(null)
    setStarting(false)
  }, [research?.plan, session?.id])

  useEffect(() => {
    if (researchStatus !== 'planning' && researchStatus !== 'searching') return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [researchStatus, research?.startedAt])

  if (!session || !research || research.status === 'idle' || session.mode === 'chat') return null
  const active = research.status === 'planning' || research.status === 'searching'
  const running = active && !!run && run.sessionId === session.id
  const depth = RESEARCH_DEPTHS[research.depth]
  const sourceReady = research.sourceCount >= research.minSources
  const artifactId = research.artifactId
  const artifact = artifactId ? session.artifacts.find((item) => item.id === artifactId) ?? null : null
  const elapsed = formatElapsed(research.startedAt, active ? now : research.updatedAt)
  const sub =
    research.status === 'planning'
      ? '正在拆解问题、制定可编辑计划…'
      : research.status === 'ready'
        ? '计划已生成 · 确认后开始检索'
        : `第 ${research.round}/${research.maxRounds} 轮 · 来源 ${research.sourceCount}/${research.minSources} · ${depth.label} · 用时 ${elapsed}`

  const start = async (): Promise<void> => {
    const plan = planDraft.trim()
    if (!plan || starting) return
    setStarting(true)
    setStartError(null)
    const ok = await startResearch(session.id, { plan })
    if (!ok) {
      setStarting(false)
      setStartError('没有开始研究，请检查模型连接或稍后重试。')
    }
  }

  const steer = async (): Promise<void> => {
    const text = steerDraft.trim()
    if (!text || steering) return
    setSteering(true)
    const ok = await steerResearch(session.id, text)
    setSteering(false)
    if (ok) {
      setSteerDraft('')
      setSteerNotice('已记录，会在下一轮检索时优先处理。')
      window.setTimeout(() => setSteerNotice(null), 4_000)
    }
  }

  return (
    <section className={['research-bar', `is-${research.status}`, expanded ? 'is-expanded' : ''].filter(Boolean).join(' ')} aria-label="深度研究进度">
      <div className="research-bar-head">
        <span className="research-bar-icon" aria-hidden>
          {research.status === 'completed' ? (
            <Check size={13} strokeWidth={2} />
          ) : research.status === 'error' ? (
            <AlertTriangle size={13} strokeWidth={1.7} />
          ) : research.status === 'ready' ? (
            <PencilLine size={13} strokeWidth={1.7} />
          ) : (
            <Telescope size={13} strokeWidth={1.6} />
          )}
        </span>
        <button
          type="button"
          className="research-bar-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? '收起研究详情' : '展开研究详情'}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="research-bar-copy">
            <span className="research-bar-title truncate">
              深度研究 · {research.topic}
              {running ? <LoaderCircle size={11} className="research-spin" aria-hidden /> : null}
            </span>
            <span className="research-bar-sub mono">{sub}</span>
          </span>
          {research.status === 'planning' || research.status === 'ready' ? null : (
            <span className="research-progress" aria-hidden>
              <SourceMeter value={research.sourceCount} target={research.minSources} />
            </span>
          )}
          <span className={['research-status', `is-${research.status}`].join(' ')}>{STATUS_LABEL[research.status]}</span>
          <ChevronDown size={13} strokeWidth={1.6} className="research-chevron" aria-hidden />
        </button>
        {running ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Square size={11} strokeWidth={2} />}
            onClick={() => void stopRun()}
            title="停止当前研究运行"
          >
            停止
          </Button>
        ) : null}
        {session?.mode === 'research' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void setSessionMode('work')}
            title="退出研究子流程，回到普通工作；报告仍保留"
          >
            退出研究
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div className="research-bar-body">
          <p className="research-depth-desc">{depth.description}</p>
          {research.status === 'planning' ? (
            <div className="research-planning" role="status">
              <LoaderCircle size={14} className="research-spin" aria-hidden />
              <span>Morrow 正在拆解研究目标、列出子问题与检索策略；计划生成后可先修改再开始。</span>
            </div>
          ) : research.status === 'ready' ? (
            <div className="research-plan-review">
              <div className="research-plan-head">
                <span>
                  <PencilLine size={12} strokeWidth={1.7} aria-hidden /> 研究计划
                </span>
                <span className="mono">可直接修改</span>
              </div>
              <textarea
                className="research-plan-editor"
                aria-label="研究计划"
                value={planDraft}
                rows={12}
                spellCheck={false}
                onChange={(event) => {
                  setPlanDraft(event.target.value)
                  setStartError(null)
                }}
              />
              <p className="research-plan-hint">
                开始后会按这份计划检索；「需要确认」里的内容可以直接删改或补充。研究过程中也可以随时停止。
              </p>
              {research.gap ? <p className="research-gap is-error">{research.gap}</p> : null}
              {startError ? <p className="research-gap is-error">{startError}</p> : null}
              <div className="research-bar-actions">
                <Button
                  variant="gold"
                  size="sm"
                  icon={starting ? <LoaderCircle size={12} className="research-spin" /> : <Play size={12} strokeWidth={1.8} />}
                  disabled={starting || !planDraft.trim()}
                  onClick={() => void start()}
                >
                  {starting ? '正在开始…' : '开始研究'}
                </Button>
                <span className="research-hint">只会读取资料与联网查证，不修改文件。</span>
              </div>
            </div>
          ) : (
            <>
              <div className="research-facts">
                <span>
                  <i className={sourceReady ? 'is-ok' : ''} />
                  独立来源 {research.sourceCount} / {research.minSources}
                  {sourceReady
                    ? '（已达标）'
                    : research.status === 'searching'
                      ? '（还会自动补查）'
                      : '（未达标）'}
                </span>
                <span>
                  <i className={research.status === 'completed' ? 'is-ok' : ''} />
                  轮次 {research.round} / {research.maxRounds}
                </span>
                <span>
                  <i />
                  用时 {elapsed}
                </span>
              </div>
              {research.gap ? (
                <p className={research.status === 'error' ? 'research-gap is-error' : 'research-gap'}>{research.gap}</p>
              ) : null}
              {research.plan ? (
                <details className="research-plan-details">
                  <summary>查看研究计划</summary>
                  <pre>{research.plan}</pre>
                </details>
              ) : null}
              {research.status === 'searching' ? (
                <div className="research-steer">
                  <input
                    className="research-steer-input"
                    aria-label="补充研究要求"
                    value={steerDraft}
                    maxLength={2_000}
                    placeholder="补充重点、时间范围或要排除的内容（下一轮优先处理）"
                    onChange={(event) => setSteerDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        void steer()
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={steering || !steerDraft.trim()}
                    onClick={() => void steer()}
                  >
                    {steering ? '记录中…' : '加入要求'}
                  </Button>
                </div>
              ) : null}
              {research.steer ? (
                <p className="research-steer-pending">已记录，下一轮优先处理：{research.steer}</p>
              ) : null}
              {steerNotice ? (
                <p className="research-steer-pending" role="status">
                  {steerNotice}
                </p>
              ) : null}
              <div className="research-bar-actions">
                {artifact ? (
                  <Button
                    variant="gold"
                    size="sm"
                    icon={<FileText size={12} strokeWidth={1.7} />}
                    onClick={() => openCanvas(artifact.id)}
                  >
                    打开研究报告
                  </Button>
                ) : research.status === 'completed' ? (
                  <span className="research-hint">研究报告已被删除或移动；用 /research 问题 重新研究。</span>
                ) : null}
                {research.status === 'stopped' || research.status === 'error' ? (
                  <span className="research-hint">用 /research 问题 重新研究；也可以继续普通工作。</span>
                ) : null}
                {research.status === 'searching' && !running ? (
                  <span className="research-hint">正在准备下一轮检索…</span>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}
