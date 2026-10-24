import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { userMessageDisplayText } from '@shared/message'
import { useAppStore } from '../../store'
import { Kbd, HorizonLoader } from '../../ui'
import { EXECUTION_GROUP_MIN_STEPS, ExecutionGroup } from './ExecutionGroup'
import { MessageItem } from './MessageItem'
import { DiffSummaryCard } from './DiffSummaryCard'
import type { DiffSummarySource } from './DiffSummaryCard'
import { parseGoalContinuation } from './GoalContinuation'
import { parsePlanMessage } from '../activity/PlanCard'
import { fileDiffEvents } from '../activity/tool-meta'
import { PermissionCard } from '../activity/PermissionCard'
import { QuestionCard } from '../activity/QuestionCard'
import './Transcript.css'

const EMPTY_MESSAGES: ChatMessage[] = []
/** 距底部小于该值视为「在跟随最新」 */
const FOLLOW_THRESHOLD = 96

type TranscriptUnit =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'execution'; key: string; messages: ChatMessage[] }
  | { kind: 'turn-diff'; key: string; sources: DiffSummarySource[] }

interface TurnSegment {
  key: string
  /** 整轮全部消息（含隐藏步骤），用于汇总改动 */
  all: ChatMessage[]
  /** 对话流真正渲染的消息 */
  visible: ChatMessage[]
}

interface TurnNavItem {
  id: string
  index: number
  title: string
}

/** 计划续跑、目标续跑等控制消息不切分「本轮」；用户真正发来的新消息才另起一张改动卡。 */
function startsTurn(message: ChatMessage): boolean {
  if (message.role !== 'user' || message.hidden) return false
  const text = userMessageDisplayText(message)
  return !parseGoalContinuation(text) && !parsePlanMessage(text)
}

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight
}

/**
 * 对话流：滚动容器 + 自动跟随 + 「回到最新」。
 * 消息渲染在 MessageItem；权限卡/提问卡永远出现在流末尾。
 */
export function Transcript(): React.JSX.Element {
  const session = useAppStore((s) => s.session)
  const pendingPermission = useAppStore((s) => s.pendingPermission)
  const pendingQuestion = useAppStore((s) => s.pendingQuestion)
  const streaming = useAppStore((s) => s.streaming)
  const focusMessageId = useAppStore((s) => s.focusMessageId)
  const clearFocusMessage = useAppStore((s) => s.clearFocusMessage)
  const loadingSession = useAppStore((s) => s.loadingSession)
  const compacting = useAppStore(
    (s) => s.compacting && (!s.compactingSessionId || s.compactingSessionId === s.session?.id)
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const followRef = useRef(true)
  const jumpingRef = useRef(false)
  const lastMessageIdRef = useRef<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [hasNew, setHasNew] = useState(false)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [activeTurn, setActiveTurn] = useState(0)
  const [turnTip, setTurnTip] = useState<{ index: number; top: number } | null>(null)

  const messages = session?.messages ?? EMPTY_MESSAGES
  const visibleMessages = useMemo(() => messages.filter((message) => !message.hidden), [messages])
  // 每轮用户消息之后的最后一条 assistant 是「轮末回答」：只有它显示分叉/回退，
  // 中间的模型步骤保持连续、不产生操作节点。
  const turnFinals = useMemo(() => {
    const finals = new Map<string, string>()
    let userId = ''
    for (const message of messages) {
      if (message.role === 'user') {
        userId = message.id
        continue
      }
      if (message.role !== 'assistant') {
        userId = ''
        continue
      }
      if (userId) finals.set(message.id, userId)
    }
    for (let index = 0; index < messages.length - 1; index += 1) {
      if (messages[index].role === 'assistant' && messages[index + 1].role === 'assistant') {
        finals.delete(messages[index].id)
      }
    }
    return finals
  }, [messages])
  // 按用户真正发来的消息划分「本轮」：计划批准、目标续跑等控制消息仍属于同一轮。
  const turnSegments = useMemo(() => {
    const segments: TurnSegment[] = []
    let current: TurnSegment | null = null
    for (const message of messages) {
      if (!current || startsTurn(message)) {
        if (current && current.all.length > 0) segments.push(current)
        current = { key: message.id, all: [], visible: [] }
      }
      current.all.push(message)
      if (!message.hidden) current.visible.push(message)
    }
    if (current && current.all.length > 0) segments.push(current)
    return segments
  }, [messages])
  // 右侧轮次导航只取用户真正发起的轮次；计划批准、目标续跑等控制消息不单独成段。
  const turnNav = useMemo(() => {
    const items: TurnNavItem[] = []
    for (const segment of turnSegments) {
      const user = segment.visible.find((message) => message.role === 'user' && startsTurn(message))
      if (!user) continue
      const text = userMessageDisplayText(user).replace(/\s+/g, ' ').trim()
      const clipped = text.length > 80 ? `${text.slice(0, 80)}…` : text
      items.push({ id: user.id, index: items.length, title: clipped || '附件消息' })
    }
    return items
  }, [turnSegments])
  const turnIndexById = useMemo(
    () => new Map(turnNav.map((item) => [item.id, item.index] as const)),
    [turnNav]
  )
  // 新建后又删除的文件在这一轮净变化为零：所有相关消息都不再显示 +N/−N。
  const diffSuppression = useMemo(() => {
    const map = new Map<string, ReadonlySet<string>>()
    for (const segment of turnSegments) {
      const created = new Set<string>()
      const lastDeleted = new Map<string, boolean>()
      for (const message of segment.all) {
        for (const event of fileDiffEvents(message)) {
          if (event.created) created.add(event.path)
          lastDeleted.set(event.path, event.deleted)
        }
      }
      const suppressed = new Set([...created].filter((path) => lastDeleted.get(path) === true))
      if (suppressed.size > 0) {
        for (const message of segment.all) map.set(message.id, suppressed)
      }
    }
    return map
  }, [turnSegments])
  // 同一轮里的多步执行合并成一条摘要；整轮只在最后保留一张改动卡。
  const renderUnits = useMemo(() => {
    const units: TranscriptUnit[] = []
    for (const segment of turnSegments) {
      let batch: ChatMessage[] = []
      const flush = (): void => {
        if (batch.length === 0) return
        if (batch.length >= EXECUTION_GROUP_MIN_STEPS) {
          units.push({ kind: 'execution', key: `exec-${batch[0].id}`, messages: batch })
        } else {
          for (const message of batch) units.push({ kind: 'message', key: message.id, message })
        }
        batch = []
      }
      for (const message of segment.visible) {
        const foldable =
          message.role === 'assistant' &&
          !turnFinals.has(message.id) &&
          !message.stageBoundary
        if (!foldable) {
          flush()
          units.push({ kind: 'message', key: message.id, message })
          continue
        }
        batch.push(message)
      }
      flush()
      if (segment.visible.length > 0) {
        units.push({
          kind: 'turn-diff',
          key: `diff-${segment.key}`,
          sources: segment.all.map((message) => ({
            message,
            suppressed: diffSuppression.get(message.id) ?? null
          }))
        })
      }
    }
    return units
  }, [turnSegments, turnFinals, diffSuppression])
  const lastMessage = messages[messages.length - 1]
  const lastContentSize = lastMessage
    ? lastMessage.content.reduce((size, block) => {
        if (block.type === 'text' || block.type === 'thinking') return size + block.text.length
        return size + 1
      }, 0)
    : 0
  const streamingSize = (streaming?.text.length ?? 0) + (streaming?.thinking.length ?? 0)
  const sessionId = session?.id ?? null

  /* 切换对话：直接定位到最新 */
  useLayoutEffect(() => {
    followRef.current = true
    jumpingRef.current = false
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    setShowJump(false)
    setHasNew(false)
    setActiveTurn(0)
    setTurnTip(null)
  }, [sessionId])

  /* 只有内容明显超过一屏时才出现右侧轮次导航，短对话不增加视觉噪音。 */
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return undefined
    const measure = (): void => setHasOverflow(scroller.scrollHeight > scroller.clientHeight + 160)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [sessionId, messages.length])

  /* 全局搜索命中：等消息渲染后滚到原消息并短暂金色高亮 */
  useEffect(() => {
    if (!focusMessageId || !session) return undefined
    let cancelled = false
    let attempts = 0
    let frame = 0
    const tryScroll = (): void => {
      if (cancelled) return
      const container = contentRef.current
      const target = container?.querySelector<HTMLElement>(`[data-message-id="${focusMessageId}"]`)
      if (target && scrollRef.current) {
        followRef.current = false
        jumpingRef.current = true
        setShowJump(true)
        setHasNew(false)
        target.scrollIntoView({ block: 'center', behavior: 'auto' })
        target.classList.add('is-search-hit')
        window.setTimeout(() => target.classList.remove('is-search-hit'), 2_800)
        window.setTimeout(() => {
          jumpingRef.current = false
        }, 700)
        clearFocusMessage()
        return
      }
      attempts += 1
      if (attempts < 24) frame = requestAnimationFrame(tryScroll)
      else clearFocusMessage()
    }
    frame = requestAnimationFrame(tryScroll)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [focusMessageId, session?.id, messages.length, clearFocusMessage, session])

  /* 内容增长：跟随中则贴底，否则记录未读 */
  useLayoutEffect(() => {
    if (!session) return
    if (followRef.current) {
      const element = scrollRef.current
      if (element) element.scrollTop = element.scrollHeight
    } else {
      setHasNew(true)
    }
  }, [session, messages.length, lastContentSize, streamingSize])

  /* 用户刚发出新消息：即使正在回看历史，也跟到最新（目标续跑不打断阅读） */
  useLayoutEffect(() => {
    if (!lastMessage || lastMessage.id === lastMessageIdRef.current) return
    lastMessageIdRef.current = lastMessage.id
    if (lastMessage.role !== 'user') return
    if (parseGoalContinuation(userMessageDisplayText(lastMessage))) return
    followRef.current = true
    jumpingRef.current = false
    setShowJump(false)
    setHasNew(false)
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [lastMessage?.id, lastMessage?.role])

  /* 权限卡/提问卡出现时必须被看到 */
  useLayoutEffect(() => {
    if (pendingPermission || pendingQuestion) {
      followRef.current = true
      const element = scrollRef.current
      if (element) element.scrollTop = element.scrollHeight
      setShowJump(false)
      setHasNew(false)
    }
  }, [pendingPermission, pendingQuestion])

  /* 内容尺寸变化（图片/代码高亮/折叠开关）时保持贴底 */
  useEffect(() => {
    const element = contentRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (!followRef.current || jumpingRef.current) return
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const scroll = scrollRef.current
        if (scroll) scroll.scrollTop = scroll.scrollHeight
      })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [sessionId])

  const updateActiveTurn = useCallback((): void => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content) return
    const nodes = content.querySelectorAll<HTMLElement>('[data-turn-index]')
    if (nodes.length === 0) return
    const scrollerTop = scroller.getBoundingClientRect().top
    let next = Number(nodes[0]?.dataset.turnIndex ?? 0)
    nodes.forEach((node) => {
      if (node.getBoundingClientRect().top - scrollerTop <= 140) {
        next = Number(node.dataset.turnIndex ?? next)
      }
    })
    setActiveTurn((previous) => (previous === next ? previous : next))
  }, [])

  useLayoutEffect(() => {
    if (!hasOverflow) return
    updateActiveTurn()
  }, [hasOverflow, turnNav.length, messages.length, updateActiveTurn])

  /* 轮次过多时导航在固定高度内滚动；初始把可视窗口对准中间，保持上下对称扩散。 */
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    nav.scrollTop = Math.max(0, (nav.scrollHeight - nav.clientHeight) / 2)
  }, [turnNav.length, hasOverflow])

  const showTurnTip = useCallback((turn: TurnNavItem, element: HTMLElement): void => {
    const root = element.closest('.transcript-root')
    if (!root) return
    const rect = element.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    setTurnTip({ index: turn.index, top: rect.top + rect.height / 2 - rootRect.top })
  }, [])

  const onScroll = (): void => {
    if (jumpingRef.current) return
    const element = scrollRef.current
    if (!element) return
    const distance = distanceFromBottom(element)
    const following = distance < FOLLOW_THRESHOLD
    followRef.current = following
    setShowJump(!following)
    setHasNew((previous) => (following ? false : previous))
    updateActiveTurn()
  }

  const jumpToLatest = useCallback((): void => {
    const element = scrollRef.current
    if (!element) return
    jumpingRef.current = true
    followRef.current = true
    setShowJump(false)
    setHasNew(false)
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    window.setTimeout(() => {
      jumpingRef.current = false
      const scroll = scrollRef.current
      if (scroll && distanceFromBottom(scroll) < FOLLOW_THRESHOLD) followRef.current = true
    }, 700)
  }, [])

  const jumpToTurn = useCallback((turn: TurnNavItem): void => {
    const scroller = scrollRef.current
    const target = contentRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${turn.id}"]`
    )
    if (!scroller || !target) return
    jumpingRef.current = true
    followRef.current = false
    setShowJump(true)
    setHasNew(false)
    setActiveTurn(turn.index)
    const top =
      scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 18
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    target.classList.add('is-turn-hit')
    window.setTimeout(() => target.classList.remove('is-turn-hit'), 1_800)
    window.setTimeout(() => {
      jumpingRef.current = false
    }, 700)
  }, [])

  if (!session) {
    return (
      <div className="transcript-root">
        <div className="transcript-loading">
          {loadingSession ? <HorizonLoader active /> : null}
        </div>
      </div>
    )
  }

  const streamingMessageId = streaming?.messageId ?? null
  const isEmpty = visibleMessages.length === 0 && !streaming
  const showTurnNav = hasOverflow && turnNav.length >= 3

  return (
    <div className="transcript-root">
      <div
        className="transcript-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={-1}
        role="log"
        aria-label="对话内容"
        aria-live="off"
      >
        <div className="transcript-inner" ref={contentRef}>
          {compacting ? (
            <div className="transcript-compacting" role="status" aria-live="polite">
              <span className="transcript-compacting-line" aria-hidden />
              <span className="mono">正在整理较早的对话，稍等片刻</span>
            </div>
          ) : null}
          {isEmpty ? (
            <div className="transcript-empty">
              <p className="transcript-empty-title">说清想要的结果，过程我来想办法。</p>
              <p className="transcript-empty-desc">
                比如「把文件夹里的文件整理成一份清单」——Morrow 会读文件、写脚本、把成品交给你。
              </p>
              <p className="transcript-empty-hint">
                按 <Kbd>Ctrl</Kbd>
                <span className="transcript-empty-plus">+</span>
                <Kbd>K</Kbd> 打开命令，或用 <Kbd>/</Kbd> 选择常见任务。
              </p>
            </div>
          ) : (
            renderUnits.map((unit) =>
              unit.kind === 'execution' ? (
                <ExecutionGroup
                  key={unit.key}
                  messages={unit.messages}
                  streamingMessageId={streamingMessageId}
                  revealMessageId={focusMessageId}
                />
              ) : unit.kind === 'turn-diff' ? (
                <DiffSummaryCard key={unit.key} sources={unit.sources} className="message-diff-turn" />
              ) : (
                <MessageItem
                  key={unit.key}
                  message={unit.message}
                  streaming={streamingMessageId === unit.message.id}
                  isLastAssistant={
                    unit.message.role === 'assistant' &&
                    unit.message.id === visibleMessages[visibleMessages.length - 1]?.id
                  }
                  isTurnFinal={turnFinals.has(unit.message.id)}
                  rewindTargetUserMessageId={turnFinals.get(unit.message.id) ?? null}
                  turnIndex={turnIndexById.get(unit.message.id)}
                />
              )
            )
          )}

          {pendingPermission ? <PermissionCard request={pendingPermission} /> : null}
          {pendingQuestion ? <QuestionCard request={pendingQuestion} /> : null}

          {!isEmpty ? <div className="transcript-tail" aria-hidden /> : null}
        </div>
      </div>

      {showTurnNav ? (
        <nav ref={navRef} className="transcript-turn-nav" aria-label="轮次跳转">
          {turnNav.map((turn) => (
            <button
              key={turn.id}
              type="button"
              className={`transcript-turn${activeTurn === turn.index ? ' is-active' : ''}`}
              aria-label={`跳到第 ${turn.index + 1} 轮：${turn.title}`}
              aria-current={activeTurn === turn.index ? 'true' : undefined}
              onClick={() => jumpToTurn(turn)}
              onMouseEnter={(event) => showTurnTip(turn, event.currentTarget)}
              onFocus={(event) => showTurnTip(turn, event.currentTarget)}
              onMouseLeave={() => setTurnTip(null)}
              onBlur={() => setTurnTip(null)}
            >
              <span className="transcript-turn-tick" aria-hidden />
            </button>
          ))}
        </nav>
      ) : null}

      {turnTip && showTurnNav ? (
        <div className="transcript-turn-tip" style={{ top: turnTip.top }} aria-hidden>
          <span className="mono transcript-turn-no">
            {String(turnTip.index + 1).padStart(2, '0')}
          </span>
          <span className="transcript-turn-title">{turnNav[turnTip.index]?.title}</span>
        </div>
      ) : null}

      {showJump ? (
        <div className="transcript-jump-bar">
          <button type="button" className="transcript-jump" onClick={jumpToLatest} aria-label="回到最新消息">
            <ArrowDown size={13} strokeWidth={1.7} aria-hidden />
            <span>回到最新</span>
            {hasNew ? <span className="transcript-jump-dot" aria-hidden /> : null}
          </button>
        </div>
      ) : null}
    </div>
  )
}
