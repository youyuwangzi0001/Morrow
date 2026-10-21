import { memo, useMemo, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'
import { ExternalLink, ImageOff } from 'lucide-react'
import { useAppStore } from '../../state/store'
import { CodeBlock } from './CodeBlock'
import './Markdown.css'

export interface MarkdownProps {
  text: string
  /** 流式输出中：链接暂不渲染成可点击样式，减少误触 */
  streaming?: boolean
}

/* react-markdown v10 的组件 props 带 node，转发 DOM 前需要剔除 */
type DivProps = ComponentPropsWithoutRef<'div'> & { node?: unknown }

function extractText(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(extractText).join('')
  if (children && typeof children === 'object' && 'props' in children) {
    return extractText((children as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

/**
 * 渲染层只允许应用自身可信来源的图片：data:image、blob:、morrow-file:。
 * 远程 http(s) 图片在 CSP 里本就被拦截，直接渲染只会出现破图；
 * 这里改成带域名和「打开链接」的占位条，既避免破图，也不把 IP/Referer 发给第三方。
 */
const SAFE_IMAGE_SRC = /^(?:data:image\/|blob:|morrow-file:)/i

/**
 * react-markdown 默认会清空 data: 图片地址；这里显式放行应用可信图片协议。
 * 相对链接保留用于展示/复制，但点击一律不导航（见 a 组件），避免把整个应用导航到 file://。
 */
const markdownUrlTransform: UrlTransform = (url, _key, node) => {
  if (!url) return ''
  if (/^(?:https?:\/\/|mailto:)/i.test(url)) return url
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return url
  if (node.tagName === 'img' && SAFE_IMAGE_SRC.test(url)) return url
  return ''
}

function imageFallbackLabel(src: string, alt?: string): string {
  try {
    const url = new URL(src)
    if (url.protocol === 'http:' || url.protocol === 'https:') return `${alt || '远程图片'} · ${url.host}`
  } catch {
    // 非标准 URL：走通用文案
  }
  return alt || '图片无法显示'
}

function createComponents(streaming: boolean): Components {
  return {
  h1: ({ children }) => <h1 className="md-h1">{children}</h1>,
  h2: ({ children }) => <h2 className="md-h2">{children}</h2>,
  h3: ({ children }) => <h3 className="md-h3">{children}</h3>,
  h4: ({ children }) => <h4 className="md-h4">{children}</h4>,
  h5: ({ children }) => <h5 className="md-h5">{children}</h5>,
  h6: ({ children }) => <h6 className="md-h6">{children}</h6>,
  p: ({ children }) => <p className="md-p">{children}</p>,
  ul: ({ children, className }) => <ul className={className === 'contains-task-list' ? 'md-list md-task-list' : 'md-list md-ul'}>{children}</ul>,
  ol: ({ children }) => <ol className="md-list md-ol">{children}</ol>,
  li: ({ children, className }) => {
    const task = typeof className === 'string' && className.includes('task-list-item')
    return <li className={task ? 'md-li md-li-task' : 'md-li'}>{children}</li>
  },
  blockquote: ({ children }) => <blockquote className="md-quote">{children}</blockquote>,
  hr: () => <hr className="md-hr" />,
  strong: ({ children }) => <strong className="md-strong">{children}</strong>,
  em: ({ children }) => <em className="md-em">{children}</em>,
  del: ({ children }) => <del className="md-del">{children}</del>,
  a: ({ href, children, title, node: _node, ...rest }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) => {
    const external = typeof href === 'string' && /^https?:\/\//i.test(href)
    return (
      <a
        href={href}
        title={title}
        className={external ? 'md-link is-external' : 'md-link'}
        onClick={(event) => {
          // 任何链接都不在应用窗口内导航：外部链接交给系统浏览器，其余保持只读
          event.preventDefault()
          if (external && href) void useAppStore.getState().openExternal(href)
        }}
        {...rest}
      >
        {children}
        {external ? <ExternalLink className="md-link-icon" size={11} strokeWidth={1.6} aria-hidden /> : null}
      </a>
    )
  },
  img: ({ src, alt, title }) => {
    const raw = typeof src === 'string' ? src : ''
    if (!SAFE_IMAGE_SRC.test(raw)) {
      const external = /^https?:\/\//i.test(raw)
      return (
        <span className="md-image-unavailable" title={raw.length > 0 && raw.length <= 300 ? raw : undefined}>
          <ImageOff size={13} strokeWidth={1.5} aria-hidden />
          <span className="md-image-unavailable-label">{imageFallbackLabel(raw, alt ?? undefined)}</span>
          {external ? (
            <button
              type="button"
              className="md-image-unavailable-open"
              onClick={() => void useAppStore.getState().openExternal(raw)}
            >
              打开链接
            </button>
          ) : null}
        </span>
      )
    }
    return (
      <span className="md-image-wrap">
        <img
          className="md-image"
          src={raw}
          alt={alt ?? ''}
          title={title}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
        {alt ? <span className="md-image-caption">{alt}</span> : null}
      </span>
    )
  },
  table: ({ children, node: _node, ...rest }: DivProps) => (
    <div className="md-table-wrap">
      <table className="md-table" {...rest}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="md-thead">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children, style }) => (
    <th className="md-th" style={style}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="md-td" style={style}>
      {children}
    </td>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const language = /language-([\w+#.-]+)/.exec(className ?? '')?.[1]
    const raw = extractText(children)
    // 围栏代码块在 mdast 里以换行结尾；行内代码不含换行
    const isBlock = Boolean(language) || raw.includes('\n')
    if (!isBlock) return <code className="md-inline-code">{children}</code>
    return <CodeBlock code={raw.replace(/\n$/, '')} language={language ?? null} streaming={streaming} />
  },
  input: ({ type, checked, disabled, node: _node }) => {
    if (type !== 'checkbox') return null
    return (
      <span className="md-check" aria-hidden>
        {checked ? '✓' : ''}
      </span>
    )
  }
  }
}

/**
 * Markdown 渲染：react-markdown + GFM（表格/任务列表/删除线）。
 * 代码块交给 CodeBlock 异步高亮；流式时父组件控制重渲染频率。
 */
export const Markdown = memo(function Markdown({ text, streaming = false }: MarkdownProps): React.JSX.Element {
  const components = useMemo(() => createComponents(streaming), [streaming])
  return (
    <div className={['md', streaming ? 'is-streaming' : ''].join(' ')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkFriendly]}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
