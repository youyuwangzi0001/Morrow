import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { useAppStore } from '../../state/store'
import { highlightToHtml, resolveLanguage } from './shiki'
import './CodeBlock.css'

export interface CodeBlockProps {
  code: string
  language?: string | null
  /** 覆盖自动判断：是否显示行号 */
  lineNumbers?: boolean
  /** 折叠阈值（行）：超过则默认折叠 */
  foldAfter?: number
  /** 自定义标题（画布/工具结果用） */
  title?: string
  /** 紧凑模式：不显示头部工具栏（嵌在别处时用） */
  bare?: boolean
  /** 流式生成中：跳过语法高亮，避免每个分片重复高亮并造成纯文本/高亮闪烁 */
  streaming?: boolean
}

const LANGUAGE_LABEL: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  jsx: 'JSX',
  tsx: 'TSX',
  python: 'Python',
  json: 'JSON',
  shellscript: 'Shell',
  css: 'CSS',
  html: 'HTML',
  xml: 'XML',
  yaml: 'YAML',
  markdown: 'Markdown',
  sql: 'SQL',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  csharp: 'C#',
  cpp: 'C++',
  powershell: 'PowerShell',
  bat: 'Batch',
  diff: 'Diff'
}

function labelFor(language?: string | null): string {
  const id = resolveLanguage(language)
  if (!id) return language ? language : '文本'
  return LANGUAGE_LABEL[id] ?? id
}

/** 估算行数（供折叠/行号判断，不用于渲染） */
function countLines(text: string): number {
  if (!text) return 0
  let count = 1
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1
  return count
}

/**
 * 代码块：Shiki 异步高亮 + 复制 + 行号 + 长代码折叠。
 * 高亮结果到达前先渲染纯文本，避免布局抖动与白屏。
 */
export function CodeBlock({
  code,
  language,
  lineNumbers,
  foldAfter = 24,
  title,
  bare = false,
  streaming = false
}: CodeBlockProps): React.JSX.Element {
  const copyText = useAppStore((s) => s.copyText)
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const copiedTimer = useRef<number | null>(null)
  const id = useId()

  const lineCount = useMemo(() => countLines(code), [code])
  const showLineNumbers = lineNumbers ?? lineCount >= 8
  const collapsible = !bare && lineCount > foldAfter
  const collapsed = collapsible && !expanded
  const trimmed = useMemo(() => code.replace(/\n$/, ''), [code])

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    // 流式期间代码还会变化：先渲染纯文本，结束后再一次性高亮
    if (streaming || !language || trimmed.length === 0) return undefined
    // 进入视口后再高亮，减少长对话里的无效计算
    const run = (): void => {
      void highlightToHtml(trimmed, language).then((result) => {
        if (!cancelled) setHtml(result)
      })
    }
    if (containerRef.current && 'IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer.disconnect()
            run()
          }
        },
        { rootMargin: '240px 0px' }
      )
      observer.observe(containerRef.current)
      return () => {
        cancelled = true
        observer.disconnect()
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [trimmed, language, streaming])

  useEffect(() => () => {
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
  }, [])

  const onCopy = (): void => {
    void copyText(code)
    setCopied(true)
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1_600)
  }

  const resolved = resolveLanguage(language)

  return (
    <div
      ref={containerRef}
      className={['code-block', `code-lang-${resolved ?? 'none'}`, collapsed ? 'is-collapsed' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {bare ? null : (
        <div className="code-head">
          <span className="code-dot" aria-hidden />
          <span className="code-lang mono">{title ?? labelFor(language)}</span>
          <span className="code-meta mono">{lineCount} 行</span>
          <button
            type="button"
            className="code-copy"
            onClick={onCopy}
            aria-label={copied ? '已复制代码' : '复制代码'}
            title={copied ? '已复制' : '复制代码'}
          >
            {copied ? <Check size={12} strokeWidth={1.7} aria-hidden /> : <Copy size={12} strokeWidth={1.6} aria-hidden />}
          </button>
        </div>
      )}
      <div className="code-scroll" id={id}>
        {html ? (
          <div
            className={['code-highlight', showLineNumbers ? 'with-lines' : ''].join(' ')}
            // Shiki 输出的是可信的静态高亮 HTML（原始代码已转义）
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className={['code-plain', showLineNumbers ? 'with-lines' : ''].join(' ')}>
            <code>{trimmed}</code>
          </pre>
        )}
      </div>
      {collapsible ? (
        <button
          type="button"
          className="code-fold"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown size={13} strokeWidth={1.6} aria-hidden />
          <span>{expanded ? '收起代码' : `展开全部 ${lineCount} 行`}</span>
        </button>
      ) : null}
    </div>
  )
}
