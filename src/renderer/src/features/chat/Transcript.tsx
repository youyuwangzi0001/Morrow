import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Kbd, HorizonLoader } from '../../ui'
import { MessageItem } from './MessageItem'
import { PermissionCard } from '../activity/PermissionCard'
import { QuestionCard } from '../activity/QuestionCard'
import './Transcript.css'

const EMPTY_MESSAGES: ChatMessage[] = []
/** 距底部小于该值视为「在跟随最新」 */
const FOLLOW_THRESHOLD = 96

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
  const loadingSession = useAppStore((s) => s.loadingSession)
  const compacting = useAppStore((s) => s.compacting)

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const jumpingRef = useRef(false)
  const [showJump, setShowJump] = useState(false)
  const [hasNew, setHasNew] = useState(false)

  const messages = session?.messages ?? EMPTY_MESSAGES
  const lastMessage = messages[messages.length - 1]
  const lastContentSize = lastMessage
    ? lastMessage.content.reduce((size, block) => {
        if (block.type === 'text' || block.type === 'thinking') return size + block.text.length
        return size + 1
      }, 0)
    : 0
  const streamingSize = (streaming?.text.length ?? 0) + (streaming?.thinking.length ?? 0)
  const sessionId = session?.id ?? null

  /* 切换会话：直接定位到最新 */
  useLayoutEffect(() => {
    followRef.current = true
    jumpingRef.current = false
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    setShowJump(false)
    setHasNew(false)
  }, [sessionId])

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

  const onScroll = (): void => {
    if (jumpingRef.current) return
    const element = scrollRef.current
    if (!element) return
    const distance = distanceFromBottom(element)
    const following = distance < FOLLOW_THRESHOLD
    followRef.current = following
    setShowJump(!following)
    setHasNew((previous) => (following ? false : previous))
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
  const isEmpty = messages.length === 0 && !streaming

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
              <span className="mono">上下文有点长了，正在压缩，稍等片刻</span>
            </div>
          ) : null}
          {isEmpty ? (
            <div className="transcript-empty">
              <p className="transcript-empty-title">说清想要的结果，过程我来想办法。</p>
              <p className="transcript-empty-desc">
                比如「把工作区里的文件整理成一份清单」——Morrow 会自己读文件、写脚本、把成品放到你面前。
              </p>
              <p className="transcript-empty-hint">
                按 <Kbd>Ctrl</Kbd>
                <span className="transcript-empty-plus">+</span>
                <Kbd>K</Kbd> 打开命令，或用 <Kbd>/</Kbd> 选择常见任务。
              </p>
            </div>
          ) : (
            messages.map((message, index) => (
              <MessageItem
                key={message.id}
                message={message}
                streaming={streamingMessageId === message.id}
                isLast={index === messages.length - 1}
              />
            ))
          )}

          {pendingPermission ? <PermissionCard request={pendingPermission} /> : null}
          {pendingQuestion ? <QuestionCard request={pendingQuestion} /> : null}

          {!isEmpty ? <div className="transcript-tail" aria-hidden /> : null}
        </div>
      </div>

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
