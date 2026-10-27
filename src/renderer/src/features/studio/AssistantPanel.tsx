import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  Loader2,
  Settings2,
  Sparkles,
  WandSparkles,
  X
} from 'lucide-react'
import type { StudioChatMessage, StudioEditPlan, StudioMessageSource, StudioProject } from '@shared/studio'
import { studioStages } from '@shared/studio'
import { useStudioStore } from './studio-store'
import { Money } from './components'
import { StudioMark } from './StudioMark'

function PlanCard({ plan }: { plan: StudioEditPlan }): React.JSX.Element {
  const applyPlan = useStudioStore((state) => state.applyPlan)
  const cancelPlan = useStudioStore((state) => state.cancelPlan)
  const run = useStudioStore((state) => state.run)
  const assistantBusy = useStudioStore((state) => state.assistantBusy)
  const status = plan.status
  return (
    <div className={`studio-plan-card is-${status}`}>
      <header>
        <span className="studio-plan-icon"><WandSparkles size={13} /></span>
        <div><b>{plan.title}</b><span>{plan.actions.length} 步修改 · 先预览，确认后执行</span></div>
        <span className={`studio-plan-status is-${status}`}>{status === 'pending' ? '待确认' : status === 'applied' ? '已应用' : status === 'undone' ? '已撤销' : '已取消'}</span>
      </header>
      <div className="studio-plan-body">
        {plan.effects.map((effect) => <p key={effect}><Check size={10} /> {effect}</p>)}
        <div className="studio-plan-foot">
          <span>预计 {plan.estimate.seconds ? `${plan.estimate.seconds} 秒` : '即时'} · <Money value={plan.estimate.cost} /></span>
          {plan.estimate.note ? <em>{plan.estimate.note}</em> : null}
        </div>
      </div>
      {status === 'pending' ? (
        <footer>
          <button type="button" className="studio-plan-cancel" onClick={() => void cancelPlan(plan.id)} disabled={assistantBusy}>取消</button>
          <button type="button" className="studio-plan-apply" onClick={() => void applyPlan(plan.id)} disabled={assistantBusy}>
            {assistantBusy ? <Loader2 size={12} className="studio-spin" /> : <Check size={12} />} 用这套方案
          </button>
        </footer>
      ) : null}
      {status === 'applied' && plan.undoVersion ? (
        <footer>
          <span className="studio-plan-undo-note">用完后没再改，可以一次撤销</span>
          <button type="button" className="studio-plan-undo" onClick={() => void run('undo-plan', { planId: plan.id })}>撤销这次修改</button>
        </footer>
      ) : null}
    </div>
  )
}

function contextLabel(value?: number): string {
  if (!value) return ''
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M 上下文`
  if (value >= 1000) return `${Math.round(value / 1000)}k 上下文`
  return `${value} 上下文`
}

function sourceAlive(active: StudioProject, source: StudioMessageSource): boolean {
  if (source.kind === 'facts') return active.facts.length > 0
  if (source.kind === 'chapter') return active.chapters.some((chapter) => chapter.id === source.id)
  if (source.kind === 'shot') return active.shots.some((shot) => shot.id === source.id)
  return active.timeline.clips.some((clip) => clip.id === source.id)
}

function Message({ message }: { message: StudioChatMessage }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const selectChapter = useStudioStore((state) => state.selectChapter)
  const selectShot = useStudioStore((state) => state.selectShot)
  const selectClip = useStudioStore((state) => state.selectClip)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const setFactsOpen = useStudioStore((state) => state.setFactsOpen)
  if (message.role === 'system') return <div className="studio-assistant-system">{message.text}</div>
  const isUser = message.role === 'user'
  const openSource = (source: StudioMessageSource): void => {
    if (source.kind === 'chapter') selectChapter(source.id)
    else if (source.kind === 'shot') {
      selectShot(source.id)
      navigateStage('storyboard')
    } else if (source.kind === 'clip') {
      selectClip(source.id)
      navigateStage('timeline')
    } else setFactsOpen(true)
  }
  return (
    <div className={`studio-assistant-message ${isUser ? 'is-user' : 'is-assistant'}`}>
      {!isUser ? <span className="studio-assistant-avatar"><StudioMark size={22} /></span> : null}
      <div className="studio-assistant-bubble">
        <p>{message.text}</p>
        {message.plan ? <PlanCard plan={message.plan} /> : null}
        {!isUser && message.sources?.length && active ? (
          <div className="studio-assistant-sources">
            <span>这次参考了</span>
            {message.sources.map((source) => {
              const alive = sourceAlive(active, source)
              return (
                <button
                  key={`${source.kind}:${source.id}`}
                  type="button"
                  className={alive ? '' : 'is-dangling'}
                  title={alive ? '打开来源' : '来源已被删除或替换'}
                  onClick={() => openSource(source)}
                >
                  {source.label}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function AssistantPanel(): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const view = useStudioStore((state) => state.view)
  const selectedChapterId = useStudioStore((state) => state.selectedChapterId)
  const selectedShotId = useStudioStore((state) => state.selectedShotId)
  const selectedClipId = useStudioStore((state) => state.selectedClipId)
  const assistantBusy = useStudioStore((state) => state.assistantBusy)
  const sendAssistant = useStudioStore((state) => state.sendAssistant)
  const setSettingsOpen = useStudioStore((state) => state.setSettingsOpen)
  const setAssistantOpen = useStudioStore((state) => state.setAssistantOpen)
  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messages = active?.messages ?? []
  const stageLabel = active ? studioStages(active.kind).find((stage) => stage.id === active.stage)?.label ?? active.stage : ''
  const scrollKey = messages.length + ':' + messages[messages.length - 1]?.text?.length
  useEffect(() => {
    const host = scrollRef.current
    if (!host) return
    host.scrollTo({ top: host.scrollHeight, behavior: 'smooth' })
  }, [scrollKey])
  if (!active) return null
  const chapter = active.chapters.find((item) => item.id === selectedChapterId)
  const shot = active.shots.find((item) => item.id === selectedShotId)
  const clip = active.timeline.clips.find((item) => item.id === selectedClipId)
  const selectionLabel = view === 'writing' && chapter
    ? `第 ${chapter.number} 章 · ${chapter.title}`
    : shot
      ? `镜 ${String(shot.number).padStart(2, '0')} · ${shot.title}`
      : clip
        ? `片段 · ${clip.label}`
        : ''
  const suggestions = useMemo(() => {
    if (active.kind === 'drama') {
      return [
        shot ? `把镜 ${String(shot.number).padStart(2, '0')} 慢 20%，雨声压低一点，不要改脸。` : '把雨丝方向统一，不要改脸。',
        '配乐压低一点，让雨声更近。',
        '字幕往上挪一点，别挡住伞。',
        '检查一遍连续性，特别是角色脸和雨向。'
      ]
    }
    if (chapter) {
      return [
        `把第 ${chapter.number} 章的结尾收得更克制。`,
        '精简这一章的对话，保留动作。',
        '检查人物与事实，看看有没有前后矛盾。',
        '给这一章补一个具体的细节，不要解释。'
      ]
    }
    return ['检查人物与事实，看看有没有前后矛盾。', '把最近一章的结尾改得更克制。']
  }, [active.kind, shot, chapter])
  const send = async (value?: string): Promise<void> => {
    const content = (value ?? text).trim()
    if (!content || assistantBusy) return
    setText('')
    await sendAssistant(content).catch(() => undefined)
  }
  const modelLabel = engine?.text.configured ? engine.text.modelLabel ?? '文本模型' : '本机生成'
  const currentRoute = engine?.text.routes?.find((route) => route.providerId === engine.text.providerId && route.modelId === engine.text.modelId)
  const capabilities = engine?.text.configured
    ? [
        contextLabel(engine.text.contextWindow),
        engine.text.supportsVision ? '可看图' : '纯文本',
        engine.text.supportsTools ? '会用工具' : ''
      ].filter(Boolean)
    : []
  const capabilityTitle = engine?.text.configured
    ? [
        engine.text.providerLabel,
        engine.text.modelLabel,
        engine.text.contextWindow ? `上下文 ${engine.text.contextWindow.toLocaleString('zh-CN')}` : '',
        engine.text.maxOutput ? `最大输出 ${engine.text.maxOutput.toLocaleString('zh-CN')}` : '',
        engine.text.supportsVision ? '支持图片' : '不支持图片',
        engine.text.supportsTools ? '会用工具' : '不会用工具',
        engine.text.supportsReasoning ? '支持思考' : ''
      ].filter(Boolean).join(' · ')
    : engine?.text.message
  return (
    <aside className="studio-assistant" aria-label="协作者">
      <header className="studio-assistant-head">
        <span className="studio-assistant-mark"><StudioMark size={30} /></span>
        <div>
          <b>协作者</b>
          <span title={capabilityTitle}><i className={engine?.text.configured ? 'is-on' : ''} /> {modelLabel} · 知道当前作品与预算</span>
        </div>
        <div className="studio-assistant-head-actions">
          <button type="button" onClick={() => setSettingsOpen(true)} title="模型与预算"><Settings2 size={13} /></button>
          <button type="button" onClick={() => setAssistantOpen(false)} title="收起协作者"><X size={13} /></button>
        </div>
      </header>

      <div className="studio-assistant-context">
        <span className="studio-assistant-context-label">这次会参考</span>
        {selectionLabel ? <span className="studio-assistant-context-chip">{selectionLabel}</span> : null}
        <span className="studio-assistant-context-chip is-quiet">{stageLabel}</span>
        <span className="studio-assistant-context-chip is-quiet">{active.kind === 'drama' ? `${active.shots.length} 镜` : `${active.chapters.length} 章`}</span>
        <span className="studio-assistant-context-chip is-quiet">预算 ¥{active.runtime.budget.spent.toFixed(2)} / {active.runtime.budget.limit ? `¥${active.runtime.budget.limit}` : '不限'}</span>
        {currentRoute ? <span className="studio-assistant-context-chip is-quiet">{currentRoute.local ? '本机' : '云端'}</span> : null}
        {capabilities.map((label) => <span key={label} className="studio-assistant-context-chip is-quiet" title={capabilityTitle}>{label}</span>)}
      </div>

      <div className="studio-assistant-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="studio-assistant-intro">
            <span className="studio-assistant-intro-mark"><Sparkles size={18} strokeWidth={1.3} /></span>
            <h2>先看，再决定。</h2>
            <p>我会先给方案，再改作品。候选稿不会自动覆盖你写的正文，花钱前会先停一下确认。</p>
            <div className="studio-assistant-rules">
              <span><i /> 点到哪一段都能回到原处</span>
              <span><i /> 先说清楚会改哪些地方</span>
              <span><i /> 用错了还能撤销</span>
            </div>
          </div>
        ) : null}
        {messages.map((message) => <Message key={message.id} message={message} />)}
        {assistantBusy ? (
          <div className="studio-assistant-thinking">
            <span className="studio-thinking-dots"><i /><i /><i /></span>
            正在整理可执行的动作…
          </div>
        ) : null}
      </div>

      <div className="studio-assistant-suggestions">
        {suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => void send(suggestion)} disabled={assistantBusy}>{suggestion}</button>)}
      </div>

      <div className="studio-assistant-composer chat-gold-frame">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={active.kind === 'drama' ? '说人话改片，例如：镜 03 慢 20%，雨声压低…' : '说说想怎么改，例如：第 3 章更克制一点…'}
          rows={3}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          aria-label="给协作者的消息"
        />
        <div className="studio-assistant-composer-foot">
          <span>{selectionLabel ? `引用 ${selectionLabel}` : 'Enter 发送 · Shift+Enter 换行'}</span>
          <button type="button" onClick={() => void send()} disabled={!text.trim() || assistantBusy} aria-label="发送">
            {assistantBusy ? <Loader2 size={14} className="studio-spin" /> : <ArrowUp size={14} />}
          </button>
        </div>
      </div>
    </aside>
  )
}
