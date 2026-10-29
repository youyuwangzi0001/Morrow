// 共享 UI 与内容组件：由 ui/ 与 components/ 扁平合并。
import './components.css'
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, ForwardedRef, ComponentPropsWithoutRef } from 'react'
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useMemo, forwardRef, useImperativeHandle, memo } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2, Copy, ChevronRight, FileDiff, FileText, FolderOpen, Link2, ExternalLink, ImageOff } from 'lucide-react'
import { useAppStore } from './store'
import darkMark from './assets/brand-mark-dark.png'
import lightMark from './assets/brand-mark-light.png'
import type { ThemeRegistration, BundledLanguage, Highlighter } from 'shiki'
import { bundledLanguages, createHighlighter } from 'shiki'
import type { LanguageSupport } from '@codemirror/language'
import { HighlightStyle, syntaxHighlighting, bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { structuredPatch } from 'diff'
import type { ParsedFilePath } from '@shared/types'
import { isAbsoluteFilePath, isTextFilePath, parseFilePath } from '@shared/types'
import { dispatchOpenFile } from './features/files-core'
import { joinWorkspacePath, normalizeRelativePath, relativeToWorkspace } from './features/artifacts-core'
import type { Components, UrlTransform } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold'

type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  iconRight?: ReactNode
  block?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconRight,
  block,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={['btn', `btn-${variant}`, `btn-${size}`, block ? 'btn-block' : '', className ?? ''].filter(Boolean).join(' ')}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="btn-spinner" size={size === 'sm' ? 13 : 15} aria-hidden /> : icon ? <span className="btn-icon">{icon}</span> : null}
      {children ? <span className="btn-label">{children}</span> : null}
      {iconRight ? <span className="btn-icon">{iconRight}</span> : null}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: number
  active?: boolean
  tone?: 'default' | 'danger'
}

export function IconButton({ label, size = 30, active, tone = 'default', className, children, ...rest }: IconButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={['icon-btn', active ? 'is-active' : '', tone === 'danger' ? 'is-danger' : '', className ?? ''].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return <kbd className="kbd">{children}</kbd>
}

export function Badge({
  children,
  tone = 'neutral',
  mono
}: {
  children: ReactNode
  tone?: 'neutral' | 'gold' | 'success' | 'danger' | 'warning' | 'mauve'
  mono?: boolean
}): React.JSX.Element {
  return <span className={['badge', `badge-${tone}`, mono ? 'mono' : ''].join(' ')}>{children}</span>
}

export function Spinner({ size = 14, label }: { size?: number; label?: string }): React.JSX.Element {
  return (
    <span className="spinner" role="status" aria-label={label ?? '加载中'}>
      <Loader2 size={size} className="spinner-icon" aria-hidden />
    </span>
  )
}

export function HorizonLoader({ active = true }: { active?: boolean }): React.JSX.Element {
  return (
    <div className={['horizon-loader', active ? 'is-active' : ''].join(' ')} aria-hidden>
      <span className="horizon-loader-bar" />
    </div>
  )
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string
  mono?: boolean
}

export function TextInput({ label, hint, error, mono, className, id, ...rest }: TextInputProps): React.JSX.Element {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <div className={['field', className ?? ''].join(' ')}>
      {label ? (
        <label className="field-label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input id={inputId} className={['text-input', mono ? 'mono' : '', error ? 'is-error' : ''].join(' ')} {...rest} />
      {error ? <p className="field-error">{error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  )
}

export function TextArea({
  label,
  hint,
  rows = 3,
  className,
  ...rest
}: {
  label?: string
  hint?: string
  rows?: number
  className?: string
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  const autoId = useId()
  return (
    <div className={['field', className ?? ''].join(' ')}>
      {label ? (
        <label className="field-label" htmlFor={autoId}>
          {label}
        </label>
      ) : null}
      <textarea id={autoId} rows={rows} className="text-area" {...rest} />
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className={['switch-row', disabled ? 'is-disabled' : ''].join(' ')}>
      <span className="switch-copy">
        <span className="switch-label">{label}</span>
        {description ? <span className="switch-desc">{description}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={['switch', checked ? 'is-on' : ''].join(' ')}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
    </label>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  description?: string
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (next: T) => void
  ariaLabel: string
}): React.JSX.Element {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={['segmented-item', value === option.value ? 'is-active' : ''].join(' ')}
          onClick={() => onChange(option.value)}
          title={option.description}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export interface SelectOption<T extends string> {
  value: T
  label: string
  description?: string
  disabled?: boolean
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = '请选择',
  width
}: {
  value: T | null
  options: SelectOption<T>[]
  onChange: (next: T) => void
  ariaLabel: string
  placeholder?: string
  width?: number | string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value) ?? null

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (open) {
      const index = options.findIndex((o) => o.value === value)
      setActiveIndex(index >= 0 ? index : 0)
    }
  }, [open, options, value])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  const choose = (index: number): void => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!open && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown')) {
      event.preventDefault()
      setOpen(true)
      return
    }
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => Math.min(options.length - 1, i + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(activeIndex)
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="select-root" ref={rootRef} style={{ width }}>
      <button
        type="button"
        className={['select-trigger', open ? 'is-open' : ''].join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span className={selected ? 'select-value' : 'select-placeholder'}>{selected?.label ?? placeholder}</span>
        <ChevronDown size={14} className="select-chevron" aria-hidden />
      </button>
      {open ? (
        <div className="select-popup" role="listbox" aria-label={ariaLabel} ref={listRef}>
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              data-index={index}
              disabled={option.disabled}
              className={['select-option', option.value === value ? 'is-selected' : '', index === activeIndex ? 'is-active' : ''].filter(Boolean).join(' ')}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span className="select-option-main">
                <span className="select-option-label">{option.label}</span>
                {option.description ? <span className="select-option-desc">{option.description}</span> : null}
              </span>
              {option.value === value ? <Check size={13} aria-hidden /> : null}
            </button>
          ))}
          {options.length === 0 ? <div className="select-empty">暂无可选项</div> : null}
        </div>
      ) : null}
    </div>
  )
}

export interface DropdownItem {
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  separatorBefore?: boolean
  onSelect: () => void
}

export function Dropdown({
  trigger,
  items,
  align = 'start',
  ariaLabel
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode
  items: DropdownItem[]
  align?: 'start' | 'end'
  ariaLabel: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const width = menuRef.current?.offsetWidth ?? 220
    const left = align === 'end' ? rect.right - width : rect.left
    const top = rect.bottom + 6
    setPosition({ top: Math.min(top, window.innerHeight - 320), left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent): void => {
      const target = event.target as Node
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span className="dropdown-root" ref={anchorRef}>
      {trigger({ onClick: () => setOpen((v) => !v), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && position
        ? createPortal(
            <div
              className="dropdown-menu"
              role="menu"
              aria-label={ariaLabel}
              ref={menuRef}
              style={{ top: position.top, left: position.left }}
            >
              {items.map((item) => (
                <div key={item.id}>
                  {item.separatorBefore ? <div className="dropdown-separator" /> : null}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    className={['dropdown-item', item.danger ? 'is-danger' : ''].join(' ')}
                    onClick={() => {
                      if (item.disabled) return
                      setOpen(false)
                      item.onSelect()
                    }}
                  >
                    {item.icon ? <span className="dropdown-icon">{item.icon}</span> : null}
                    <span className="dropdown-label">{item.label}</span>
                    {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
                  </button>
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </span>
  )
}

const ModalStackContext = createContext<{ depth: number }>({ depth: 0 })

/**
 * 全局弹窗栈：只有最上层响应 Esc / Tab，避免设置 + 命令面板同时打开时一起关闭或抢焦点。
 * App 的「Esc 停止运行」也用它判断当前是否有弹窗。
 */
const openModals: symbol[] = []

export function hasOpenModal(): boolean {
  return openModals.length > 0
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 560,
  layer = 'modal',
  closeOnBackdrop = true,
  ariaLabel
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  width?: number
  layer?: 'modal' | 'overlay' | 'palette'
  closeOnBackdrop?: boolean
  ariaLabel?: string
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const stack = useContext(ModalStackContext)
  const titleId = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closeOnBackdropRef = useRef(closeOnBackdrop)
  closeOnBackdropRef.current = closeOnBackdrop
  const modalIdRef = useRef<symbol | null>(null)
  if (!modalIdRef.current) modalIdRef.current = Symbol('modal')

  useEffect(() => {
    if (!open) return
    const modalId = modalIdRef.current as symbol
    openModals.push(modalId)
    const isTopModal = (): boolean => openModals[openModals.length - 1] === modalId
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent): void => {
      if (!isTopModal()) return
      if (event.key === 'Escape') {
        if (event.isComposing) return
        event.preventDefault()
        event.stopPropagation()
        if (closeOnBackdropRef.current) onCloseRef.current()
        return
      }
      if (event.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (!panelRef.current.contains(document.activeElement)) {
          event.preventDefault()
          first.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    const timer = window.setTimeout(() => {
      const panel = panelRef.current
      if (!panel) return
      const visible = (element: HTMLElement): boolean => element.getClientRects().length > 0
      const preferred = panel.querySelector<HTMLElement>('[data-autofocus]')
      // 只自动聚焦文本输入：range/checkbox 等被聚焦后方向键会误改值，
      // 且主题或布局变化时浏览器会把焦点控件滚回视野，导致设置面板跳动。
      const fields = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'input:not([disabled]):not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea:not([disabled]), select:not([disabled])'
        )
      ).find(visible)
      // 没有明确的首焦点时把焦点放在对话框本身，避免默认落到「关闭」按钮上
      const target = preferred && visible(preferred) ? preferred : (fields ?? panel)
      target.focus()
    }, 40)
    return () => {
      document.removeEventListener('keydown', onKey)
      const index = openModals.lastIndexOf(modalId)
      if (index >= 0) openModals.splice(index, 1)
      window.clearTimeout(timer)
      previous?.focus?.()
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <ModalStackContext.Provider value={{ depth: stack.depth + 1 }}>
      <div
        className={['overlay', `overlay-${layer}`].join(' ')}
        role="presentation"
        onMouseDown={(event) => {
          if (closeOnBackdrop && event.target === event.currentTarget) onClose()
        }}
      >
        <div
          className={['modal-panel', `modal-${layer}`].join(' ')}
          style={{ width, '--modal-depth': stack.depth } as CSSProperties}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          aria-labelledby={title ? titleId : undefined}
          tabIndex={-1}
          ref={panelRef}
        >
          {title ? (
            <header className="modal-head">
              <div>
                <h2 className="modal-title" id={titleId}>
                  {title}
                </h2>
                {description ? <p className="modal-desc">{description}</p> : null}
              </div>
              <IconButton
                label="关闭"
                onClick={onClose}
                className="modal-close"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                  <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </IconButton>
            </header>
          ) : null}
          <div className="modal-body">{children}</div>
          {footer ? <footer className="modal-foot">{footer}</footer> : null}
        </div>
      </div>
    </ModalStackContext.Provider>,
    document.body
  )
}

export function WithTooltip({
  label,
  children,
  side = 'top'
}: {
  label: string
  children: ReactNode
  side?: 'top' | 'right' | 'bottom'
}): React.JSX.Element {
  return (
    <span className={`tip tip-${side}`} data-tip={label}>
      {children}
    </span>
  )
}

export function EmptyHint({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="empty-hint">{children}</p>
}

export function ErrorNote({
  title,
  detail,
  action
}: {
  title: string
  detail?: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="error-note" role="alert">
      <div className="error-note-text">
        <p className="error-note-title">{title}</p>
        {detail ? <p className="error-note-detail">{detail}</p> : null}
      </div>
      {action}
    </div>
  )
}

/** 简单键盘提示列表（设置/命令面板用） */
export function Shortcut({ keys, label }: { keys: string; label: string }): React.JSX.Element {
  return (
    <div className="shortcut-row" role="group" aria-label={`${label}：${keys}`}>
      <span className="shortcut-label">{label}</span>
      <span className="shortcut-keys">
        {keys.split('+').map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
    </div>
  )
}

/** 让父级知道点击发生在外部（轻量场景使用） */
export function useClickOutside(onOutside: () => void, enabled = true): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const handler = useCallback(
    (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside()
    },
    [onOutside]
  )
  useEffect(() => {
    if (!enabled) return
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [enabled, handler])
  return ref
}

export interface ResizeHandleProps {
  value: number
  min: number
  max: number
  /** 手柄位于被调整面板的哪条边：right = 面板右缘（左侧栏），left = 面板左缘（右侧画布） */
  edge: 'left' | 'right'
  label: string
  /** 拖动过程中实时回调（通常只更新 UI，不落盘） */
  onChange: (value: number) => void
  /** 松手后回调（落盘） */
  onCommit: (value: number) => void
  /** 双击恢复默认宽度 */
  onReset?: () => void
  className?: string
}

const clampResize = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)))

/**
 * 拖拽调宽手柄：拖动时在落点显示 1px 香槟金渐变线 + px 读数，
 * 松手后由调用方持久化。侧栏与画布共用，保证提示特效完全一致。
 */
export function ResizeHandle({
  value,
  min,
  max,
  edge,
  label,
  onChange,
  onCommit,
  onReset,
  className
}: ResizeHandleProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  const start = useRef({ x: 0, value })
  const latest = useRef(value)
  const changeRef = useRef(onChange)
  const commitRef = useRef(onCommit)
  changeRef.current = onChange
  commitRef.current = onCommit

  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent): void => {
      const delta = event.clientX - start.current.x
      const next = clampResize(edge === 'right' ? start.current.value + delta : start.current.value - delta, min, max)
      latest.current = next
      changeRef.current(next)
    }
    const finish = (): void => {
      setDragging(false)
      document.body.classList.remove('is-resizing-panel')
      delete document.body.dataset.resizeTarget
      commitRef.current(latest.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
    window.addEventListener('blur', finish, { once: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
    }
  }, [dragging, edge, min, max])

  useEffect(() => {
    if (!dragging) latest.current = value
  }, [value, dragging])

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    start.current = { x: event.clientX, value }
    latest.current = value
    setDragging(true)
    setHovered(true)
    document.body.classList.add('is-resizing-panel')
    document.body.dataset.resizeTarget = className ?? (edge === 'left' ? 'resize-left' : 'resize-right')
  }

  const pointer = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 32 : 16
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const next = clampResize(value + (edge === 'right' ? direction : -direction) * step, min, max)
    onChange(next)
    onCommit(next)
  }

  const lineX = edge === 'right' ? value : window.innerWidth - value

  return (
    <>
      <div
        className={['resize-handle', edge === 'left' ? 'is-left' : 'is-right', dragging ? 'is-dragging' : '', hovered ? 'is-hovered' : '', className]
          .filter(Boolean)
          .join(' ')}
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={beginDrag}
        onDoubleClick={() => onReset?.()}
        onKeyDown={pointer}
      />
      {dragging ? (
        <div className={`resize-line ${edge === 'left' ? 'is-left' : ''}`} style={{ left: lineX }} aria-hidden>
          <span className="mono">{Math.round(value)}px</span>
        </div>
      ) : null}
    </>
  )
}

/** 双主题品牌徽记：日常会话、演示入口与工作状态共用同一套图标资产。 */
export function BrandMark({
  size = 16,
  className = ''
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  const theme = useAppStore((s) => s.settings.theme)
  return (
    <img
      className={['brand-mark', className].filter(Boolean).join(' ')}
      src={theme === 'light' ? lightMark : darkMark}
      width={size}
      height={size}
      alt=""
      draggable={false}
      aria-hidden
    />
  )
}

interface TokenColor {
  scope: string[]
  settings: { foreground?: string; fontStyle?: string }
}

/** 两套主题共用的 token 作用域映射（颜色分开） */
function tokenColors(p: {
  comment: string
  keyword: string
  string: string
  number: string
  func: string
  type: string
  variable: string
  tag: string
  operator: string
  regexp: string
  invalid: string
  inserted: string
  deleted: string
}): TokenColor[] {
  return [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: p.comment, fontStyle: 'italic' } },
    {
      scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.operator.new'],
      settings: { foreground: p.keyword }
    },
    { scope: ['string', 'string.quoted', 'string.template', 'constant.other.symbol'], settings: { foreground: p.string } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character', 'support.constant'], settings: { foreground: p.number } },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call', 'entity.name.method'],
      settings: { foreground: p.func }
    },
    {
      scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class'],
      settings: { foreground: p.type }
    },
    {
      scope: ['variable', 'variable.other', 'variable.parameter', 'meta.object-literal.key', 'support.variable', 'variable.language'],
      settings: { foreground: p.variable }
    },
    { scope: ['entity.name.tag', 'meta.tag', 'support.type.property-name'], settings: { foreground: p.tag } },
    {
      scope: ['keyword.operator', 'punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator'],
      settings: { foreground: p.operator }
    },
    { scope: ['string.regexp', 'constant.character.escape', 'string.escape'], settings: { foreground: p.regexp } },
    { scope: ['invalid', 'invalid.illegal'], settings: { foreground: p.invalid } },
    { scope: ['markup.inserted', 'punctuation.definition.inserted'], settings: { foreground: p.inserted } },
    { scope: ['markup.deleted', 'punctuation.definition.deleted'], settings: { foreground: p.deleted } },
    { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: p.func, fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.underline.link'], settings: { foreground: p.string } }
  ]
}

export const morrowDark: ThemeRegistration = {
  name: 'morrow-dark',
  type: 'dark',
  colors: {
    'editor.background': '#0D1117',
    'editor.foreground': '#DCD6C8'
  },
  tokenColors: tokenColors({
    comment: '#6B675F',
    keyword: '#C8AE7D',
    string: '#A9BFAF',
    number: '#C6A764',
    func: '#E4CE9E',
    type: '#BDB39E',
    variable: '#C9C3B6',
    tag: '#C8AE7D',
    operator: '#8C867A',
    regexp: '#C2795F',
    invalid: '#C2795F',
    inserted: '#7FA292',
    deleted: '#C2795F'
  })
}

export const morrowLight: ThemeRegistration = {
  name: 'morrow-light',
  type: 'light',
  colors: {
    'editor.background': '#ECE6D8',
    'editor.foreground': '#2B2925'
  },
  tokenColors: tokenColors({
    comment: '#8C867A',
    keyword: '#8A6A3C',
    string: '#4F7263',
    number: '#8F7018',
    func: '#6E5227',
    type: '#6B614F',
    variable: '#3B3831',
    tag: '#8A6A3C',
    operator: '#7C766A',
    regexp: '#A2543F',
    invalid: '#A2543F',
    inserted: '#4F7263',
    deleted: '#A2543F'
  })
}

/** 常见的别名 → shiki 语言 id */
const ALIAS: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  text: 'text',
  plaintext: 'text',
  txt: 'text',
  vue: 'vue',
  rs: 'rust',
  kt: 'kotlin',
  golang: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  objc: 'objective-c',
  ps1: 'powershell',
  bat: 'bat',
  cmd: 'bat'
}

const MAX_HIGHLIGHT_CHARS = 120_000

const MAX_HIGHLIGHT_LINES = 2_000

let highlighterPromise: Promise<Highlighter> | null = null

const languageLoads = new Map<string, Promise<void>>()

/** 语言 id 归一化；不支持的语言返回 null（渲染为纯文本） */
export function resolveLanguage(language?: string | null): string | null {
  if (!language) return null
  const raw = language.trim().toLowerCase().replace(/^language-/, '')
  if (!raw) return null
  const id = ALIAS[raw] ?? raw
  if (id === 'text' || id === 'plaintext') return 'text'
  if (id in bundledLanguages) return id
  return null
}

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [morrowDark, morrowLight],
      langs: []
    })
  }
  return highlighterPromise
}

function loadLanguage(highlighter: Highlighter, id: string): Promise<void> {
  const existing = languageLoads.get(id)
  if (existing) return existing
  const loading = highlighter
    .loadLanguage(id as BundledLanguage)
    .then(() => undefined)
    .catch((error: unknown) => {
      // 加载失败时移除缓存，下次可重试；调用方降级为纯文本
      languageLoads.delete(id)
      throw error
    })
  languageLoads.set(id, loading)
  return loading
}

/**
 * 高亮一段代码，返回 Shiki 的 `<pre>` HTML。
 * 不支持/过大/加载失败时返回 null，由调用方回退到纯文本 `<pre>`。
 */
export async function highlightToHtml(code: string, language?: string | null): Promise<string | null> {
  const id = resolveLanguage(language)
  if (!id || id === 'text') return null
  if (code.length > MAX_HIGHLIGHT_CHARS) return null
  if (code.length > 4_000 && code.split('\n').length > MAX_HIGHLIGHT_LINES) return null
  try {
    const highlighter = await getHighlighter()
    await loadLanguage(highlighter, id)
    return highlighter.codeToHtml(code, {
      lang: id as BundledLanguage,
      themes: { dark: morrowDark.name, light: morrowLight.name },
      defaultColor: false
    })
  } catch {
    return null
  }
}

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

const CodeBlockLANGUAGE_LABEL: Record<string, string> = {
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
  return CodeBlockLANGUAGE_LABEL[id] ?? id
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

export type EditorLanguage =
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'html'
  | 'css'
  | 'markdown'
  | 'python'
  | 'xml'
  | 'text'

const EXT_LANGUAGE: Record<string, EditorLanguage> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  pyw: 'python',
  xml: 'xml',
  svg: 'xml',
  txt: 'text',
  log: 'text',
  csv: 'text',
  yml: 'text',
  yaml: 'text',
  sh: 'text',
  ps1: 'text',
  bat: 'text'
}

const languagesLANGUAGE_LABEL: Record<EditorLanguage, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  markdown: 'Markdown',
  python: 'Python',
  xml: 'XML',
  text: '纯文本'
}

export function languageForPath(path: string | null | undefined): EditorLanguage {
  if (!path) return 'text'
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'text'
  return EXT_LANGUAGE[base.slice(dot + 1).toLowerCase()] ?? 'text'
}

export function languageLabel(language: EditorLanguage): string {
  return languagesLANGUAGE_LABEL[language] ?? '纯文本'
}

type Loader = () => Promise<LanguageSupport>

const LOADERS: Record<Exclude<EditorLanguage, 'text'>, Loader> = {
  javascript: () => import('@codemirror/lang-javascript').then((mod) => mod.javascript({ jsx: true })),
  typescript: () => import('@codemirror/lang-javascript').then((mod) => mod.javascript({ jsx: true, typescript: true })),
  json: () => import('@codemirror/lang-json').then((mod) => mod.json()),
  html: () => import('@codemirror/lang-html').then((mod) => mod.html()),
  css: () => import('@codemirror/lang-css').then((mod) => mod.css()),
  markdown: () => import('@codemirror/lang-markdown').then((mod) => mod.markdown()),
  python: () => import('@codemirror/lang-python').then((mod) => mod.python()),
  xml: () => import('@codemirror/lang-xml').then((mod) => mod.xml())
}

const languageCache = new Map<EditorLanguage, LanguageSupport>()

/** 异步加载语言支持；失败/纯文本返回 null（编辑器退化为纯文本） */
export async function loadLanguageExtension(language: EditorLanguage): Promise<LanguageSupport | null> {
  if (language === 'text') return null
  const cached = languageCache.get(language)
  if (cached) return cached
  try {
    const support = await LOADERS[language]()
    languageCache.set(language, support)
    return support
  } catch {
    return null
  }
}

/** 与 shiki 主题同源的 CM 语法配色（颜色经由 tokens.css 的 CSS 变量） */
const highlightColors = {
  keyword: 'var(--syntax-keyword)',
  string: 'var(--syntax-string)',
  number: 'var(--syntax-number)',
  function: 'var(--syntax-function)',
  type: 'var(--syntax-type)',
  variable: 'var(--syntax-variable)',
  comment: 'var(--syntax-comment)',
  operator: 'var(--syntax-operator)',
  invalid: 'var(--syntax-invalid)'
}

const morrowHighlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: highlightColors.comment, fontStyle: 'italic' },
  {
    tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.self, t.null, t.atom],
    color: highlightColors.keyword
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: highlightColors.string },
  { tag: [t.number, t.bool, t.null], color: highlightColors.number },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: highlightColors.function },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: highlightColors.type },
  { tag: [t.variableName, t.propertyName, t.attributeName, t.labelName], color: highlightColors.variable },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: highlightColors.operator },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: highlightColors.function, fontWeight: '600' },
  { tag: [t.link, t.url], color: highlightColors.string },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.invalid], color: highlightColors.invalid }
])

export function morrowSyntaxHighlighting(): Extension {
  return syntaxHighlighting(morrowHighlightStyle)
}

export interface CodeEditorHandle {
  focus: () => void
  openSearch: () => void
  getValue: () => string
  setValue: (value: string) => void
}

export interface CodeEditorProps {
  value: string
  /** 文件/文档身份：切换时重置撤销历史，不同文件不共享 undo 栈 */
  documentKey?: string
  language: EditorLanguage
  readOnly?: boolean
  theme: 'dark' | 'light'
  lineWrapping?: boolean
  ariaLabel?: string
  autoFocus?: boolean
  onChange?: (value: string) => void
  onSave?: () => void
  onCursor?: (line: number, column: number) => void
}

const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--fs-code, 12px)',
    color: 'var(--text)'
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    fontWeight: 'var(--code-font-weight, 400)',
    lineHeight: '1.7',
    overflow: 'auto'
  },
  '.cm-content': {
    caretColor: 'var(--gold)',
    padding: '8px 0 24px'
  },
  '.cm-line': {
    padding: '0 12px'
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--gold)',
    borderLeftWidth: '1.5px'
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--gold-dim) !important'
  },
  '.cm-gutters': {
    border: 'none',
    paddingLeft: '4px'
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--text-2)'
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 6px 0 8px',
    minWidth: '28px'
  },
  '.cm-foldGutter .cm-gutterElement': {
    padding: '0 4px',
    color: 'var(--text-3)'
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--line)',
    color: 'var(--text-3)',
    borderRadius: '4px',
    padding: '0 4px'
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--gold-dim)',
    color: 'var(--gold-bright) !important',
    outline: '1px solid var(--line-gold)'
  },
  '.cm-tooltip': {
    border: '1px solid var(--line-strong)',
    backgroundColor: 'var(--bg-elev)',
    color: 'var(--text)',
    borderRadius: 'var(--r-xs)',
    boxShadow: 'var(--shadow-soft)'
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-elev)',
    color: 'var(--text)',
    borderTop: '1px solid var(--line)',
    borderBottom: '1px solid var(--line)'
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-search': {
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--fs-base)',
    padding: '6px 8px',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    alignItems: 'center'
  },
  '.cm-search label': { color: 'var(--text-2)', fontSize: 'var(--fs-sm-plus)' },
  '.cm-search .cm-textfield': {
    backgroundColor: 'var(--surface-inset)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--r-xs)',
    color: 'var(--text)',
    padding: '3px 7px',
    fontSize: 'var(--fs-base)',
    outline: 'none'
  },
  '.cm-search .cm-textfield:focus': { borderColor: 'var(--line-gold)' },
  '.cm-search .cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--r-xs)',
    color: 'var(--text-2)',
    fontSize: 'var(--fs-sm-plus)',
    padding: '3px 9px'
  },
  '.cm-search .cm-button:hover': { backgroundColor: 'var(--surface-hover)', color: 'var(--text)' },
  '.cm-search button[name="close"]': { color: 'var(--text-3)' },
  '.cm-searchMatch': {
    backgroundColor: 'var(--gold-dim)',
    outline: '1px solid var(--line-gold)'
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--gold) 30%, transparent)'
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--patina) 16%, transparent)' },
  '.cm-placeholder': { color: 'var(--text-3)' }
})

const darkEditorTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--code-bg)' },
    '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-3)' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--surface) 42%, transparent)' }
  },
  { dark: true }
)

const lightEditorTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--code-bg)' },
    '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-3)' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, #000 4%, transparent)' }
  },
  { dark: false }
)

/**
 * CodeMirror 6 编辑器封装：行号、折叠、括号匹配、查找替换、撤销重做、自动缩进、
 * Ctrl+S 保存、主题与语言热切换；语言包按需动态加载。
 */
export const CodeEditor = forwardRef(function CodeEditor(
  {
    value,
    documentKey,
    language,
    readOnly = false,
    theme,
    lineWrapping = true,
    ariaLabel,
    autoFocus = false,
    onChange,
    onSave,
    onCursor
  }: CodeEditorProps,
  ref: ForwardedRef<CodeEditorHandle>
): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const extensionsRef = useRef<Extension[]>([])
  const documentKeyRef = useRef(documentKey)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onCursorRef = useRef(onCursor)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onCursorRef.current = onCursor

  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const themeCompartment = useRef(new Compartment())
  const wrapCompartment = useRef(new Compartment())
  const loadToken = useRef(0)

  /* 创建编辑器（只一次） */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of('  '),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      rectangularSelection(),
      crosshairCursor(),
      search({ top: true }),
      morrowSyntaxHighlighting(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current?.()
            return true
          }
        }
      ]),
      baseTheme,
      readOnlyCompartment.current.of([]),
      themeCompartment.current.of(theme === 'dark' ? darkEditorTheme : lightEditorTheme),
      wrapCompartment.current.of(lineWrapping ? EditorView.lineWrapping : []),
      languageCompartment.current.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head
          const line = update.state.doc.lineAt(head)
          onCursorRef.current?.(line.number, head - line.from + 1)
        }
      }),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? '代码编辑器', spellcheck: 'false' })
    ]
    extensionsRef.current = extensions
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host
    })
    viewRef.current = view
    if (autoFocus) view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 初始化只跑一次；后续通过 compartments 更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 切换文件：重建 state，彻底隔离撤销历史 */
  useEffect(() => {
    const view = viewRef.current
    if (!view || documentKeyRef.current === documentKey) return
    documentKeyRef.current = documentKey
    view.setState(EditorState.create({ doc: value, extensions: extensionsRef.current }))
    if (autoFocus) view.focus()
    // 只在文档身份变化时重置；value 变化走下面的非历史同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey])

  /* 外部 value 同步（历史恢复 / 预览切换 / 重新加载）：不得进入撤销栈 */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    const selection = view.state.selection.main
    const head = Math.min(selection.head, value.length)
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: head },
      annotations: Transaction.addToHistory.of(false)
    })
  }, [value])

  /* 只读 */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
      )
    })
  }, [readOnly])

  /* 主题 */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(theme === 'dark' ? darkEditorTheme : lightEditorTheme)
    })
  }, [theme])

  /* 换行 */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: wrapCompartment.current.reconfigure(lineWrapping ? EditorView.lineWrapping : [])
    })
  }, [lineWrapping])

  /* 语言（按需异步加载） */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const token = ++loadToken.current
    void loadLanguageExtension(language).then((support) => {
      const currentView = viewRef.current
      if (!currentView || token !== loadToken.current) return
      currentView.dispatch({
        effects: languageCompartment.current.reconfigure(support ?? [])
      })
    })
  }, [language])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      openSearch: () => {
        const view = viewRef.current
        if (view) openSearchPanel(view)
      },
      getValue: () => viewRef.current?.state.doc.toString() ?? '',
      setValue: (next: string) => {
        const view = viewRef.current
        if (!view) return
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
      }
    }),
    []
  )

  return <div className="code-editor-host" ref={hostRef} data-language={language} />
})

export default CodeEditor

type RowKind = 'add' | 'del' | 'ctx' | 'note'

interface DiffRow {
  kind: RowKind
  text: string
  oldNo: number | null
  newNo: number | null
  /** 在 hunk 内的下标 */
  index: number
}

interface DiffHunk {
  header: string
  oldStart: number
  newStart: number
  rows: DiffRow[]
}

interface ParsedDiffModel {
  hunks: DiffHunk[]
  added: number
  removed: number
  filePath: string | null
  /** 无法逐行展示时的说明（文件过大等） */
  note: string | null
}

export interface DiffViewProps {
  /** unified diff 文本（引擎 createUnifiedDiff 的 patch） */
  patch?: string
  /** 或直接给修改前/后文本，内部用 diff 包计算 */
  before?: string
  after?: string
  filePath?: string
  /** 折叠未改动上下文，默认 3 行 */
  contextLines?: number
  /** 隐藏文件头（嵌在工具卡里时由外层标题承担） */
  hideHeader?: boolean
  /** 最大高度，超出滚动 */
  maxHeight?: number | string
  className?: string
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/

function parseUnified(patch: string): ParsedDiffModel {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0
  let filePath: string | null = null
  let note: string | null = null
  let rowIndex = 0

  const push = (kind: RowKind, text: string, withNumbers = true): void => {
    if (!current) return
    current.rows.push({
      kind,
      text,
      oldNo: withNumbers && kind !== 'add' ? oldNo : null,
      newNo: withNumbers && kind !== 'del' ? newNo : null,
      index: rowIndex
    })
    rowIndex += 1
    if (kind === 'ctx') {
      oldNo += 1
      newNo += 1
    } else if (kind === 'del') {
      oldNo += 1
    } else if (kind === 'add') {
      newNo += 1
    }
  }

  for (const raw of lines) {
    const match = HUNK_HEADER.exec(raw)
    if (match) {
      oldNo = Number(match[1])
      newNo = Number(match[3])
      rowIndex = 0
      current = {
        header: raw,
        oldStart: oldNo,
        newStart: newNo,
        rows: []
      }
      hunks.push(current)
      continue
    }
    if (raw.startsWith('--- ')) {
      filePath = filePath ?? raw.slice(4).replace(/^[ab]\//, '')
      continue
    }
    if (raw.startsWith('+++ ')) {
      filePath = filePath ?? raw.slice(4).replace(/^[ab]\//, '')
      continue
    }
    if (raw.startsWith('\\ ')) continue
    if (raw.startsWith('…') || raw.startsWith('(内容较大')) {
      note = raw.replace(/^…/, '').trim()
      continue
    }
    if (!current) continue
    if (raw.startsWith('+')) {
      added += 1
      push('add', raw.slice(1))
    } else if (raw.startsWith('-')) {
      removed += 1
      push('del', raw.slice(1))
    } else if (raw.startsWith(' ')) {
      push('ctx', raw.slice(1))
    } else if (raw.length === 0) {
      push('ctx', '')
    } else {
      push('ctx', raw)
    }
  }

  return { hunks, added, removed, filePath, note }
}

function buildFromText(before: string, after: string, filePath: string, context: number): ParsedDiffModel {
  const parsed = structuredPatch(`a/${filePath}`, `b/${filePath}`, before, after, '', '', { context })
  const hunks: DiffHunk[] = []
  let added = 0
  let removed = 0
  for (const hunk of parsed.hunks) {
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    const rows: DiffRow[] = hunk.lines.map((line, index) => {
      const marker = line.slice(0, 1)
      const text = line.slice(1)
      if (marker === '+') {
        added += 1
        const row: DiffRow = { kind: 'add', text, oldNo: null, newNo, index }
        newNo += 1
        return row
      }
      if (marker === '-') {
        removed += 1
        const row: DiffRow = { kind: 'del', text, oldNo, newNo: null, index }
        oldNo += 1
        return row
      }
      const row: DiffRow = { kind: 'ctx', text, oldNo, newNo, index }
      oldNo += 1
      newNo += 1
      return row
    })
    hunks.push({
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      rows
    })
  }
  return { hunks, added, removed, filePath, note: null }
}

interface RenderBlock {
  kind: 'rows' | 'collapsed'
  rows: DiffRow[]
  hiddenCount: number
  start: number
}

/** 把 hunk 拆成「显示行」「折叠的未改动块」 */
function splitContext(rows: DiffRow[], contextLines: number): RenderBlock[] {
  const blocks: RenderBlock[] = []
  let buffer: DiffRow[] = []
  const flushBuffer = (): void => {
    if (buffer.length) {
      blocks.push({ kind: 'rows', rows: buffer, hiddenCount: 0, start: 0 })
      buffer = []
    }
  }
  let index = 0
  while (index < rows.length) {
    const row = rows[index]
    if (row.kind !== 'ctx') {
      buffer.push(row)
      index += 1
      continue
    }
    let end = index
    while (end < rows.length && rows[end].kind === 'ctx') end += 1
    const runLength = end - index
    const atStart = index === 0
    const atEnd = end === rows.length
    // 上下文块保留首尾 contextLines 行，中间折叠（文件开头/结尾的块直接折叠）
    const keepHead = atStart ? 0 : contextLines
    const keepTail = atEnd ? 0 : contextLines
    if (runLength > keepHead + keepTail) {
      flushBuffer()
      for (let i = 0; i < keepHead; i += 1) buffer.push(rows[index + i])
      flushBuffer()
      blocks.push({ kind: 'collapsed', rows: rows.slice(index + keepHead, end - keepTail), hiddenCount: runLength - keepHead - keepTail, start: index + keepHead })
      buffer = []
      for (let i = runLength - keepTail; i < runLength; i += 1) buffer.push(rows[index + i])
      flushBuffer()
    } else {
      for (let i = index; i < end; i += 1) buffer.push(rows[i])
    }
    index = end
  }
  flushBuffer()
  return blocks
}

function HunkView({
  hunk,
  contextLines,
  collapseContext
}: {
  hunk: DiffHunk
  contextLines: number
  collapseContext: boolean
}): React.JSX.Element {
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(() => new Set())
  const blocks = useMemo(
    () => (collapseContext ? splitContext(hunk.rows, contextLines) : [{ kind: 'rows' as const, rows: hunk.rows, hiddenCount: 0, start: 0 }]),
    [hunk.rows, contextLines, collapseContext]
  )

  return (
    <div className="diff-hunk">
      <div className="diff-hunk-head mono">{hunk.header}</div>
      {blocks.map((block, blockIndex) => {
        if (block.kind === 'collapsed' && !expandedRuns.has(block.start)) {
          return (
            <button
              key={`c-${blockIndex}`}
              type="button"
              className="diff-collapse mono"
              onClick={() =>
                setExpandedRuns((prev) => {
                  const next = new Set(prev)
                  next.add(block.start)
                  return next
                })
              }
              aria-label={`展开 ${block.hiddenCount} 行未改动内容`}
            >
              <ChevronRight size={12} strokeWidth={1.6} aria-hidden />
              <span>展开 {block.hiddenCount} 行未改动内容</span>
            </button>
          )
        }
        return (
          <div key={`r-${blockIndex}`} className="diff-rows">
            {block.rows.map((row) => (
              <div key={`${row.index}-${row.kind}`} className={`diff-line is-${row.kind}`}>
                <span className="diff-gutter mono" aria-hidden>
                  {row.oldNo ?? ''}
                </span>
                <span className="diff-gutter mono" aria-hidden>
                  {row.newNo ?? ''}
                </span>
                <span className="diff-sign mono" aria-hidden>
                  {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
                </span>
                <span className="diff-code">{row.text}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 差异视图：红绿低饱和、行号、上下文折叠。
 * 数据来源兼容两种：unified diff 文本（工具结果/审批预览）或修改前后文本。
 */
export function DiffView({
  patch,
  before,
  after,
  filePath,
  contextLines = 3,
  hideHeader = false,
  maxHeight,
  className
}: DiffViewProps): React.JSX.Element {
  const model = useMemo<ParsedDiffModel | null>(() => {
    if (typeof before === 'string' && typeof after === 'string') {
      if (before === after) return { hunks: [], added: 0, removed: 0, filePath: filePath ?? null, note: null }
      return buildFromText(before, after, filePath ?? 'file', contextLines)
    }
    if (patch && patch.trim()) return parseUnified(patch)
    return null
  }, [patch, before, after, filePath, contextLines])

  if (!model) {
    return <div className={['diff-view', 'is-empty', className].filter(Boolean).join(' ')}>没有可显示的改动</div>
  }

  if (model.hunks.length === 0) {
    return (
      <div className={['diff-view', 'is-empty', className].filter(Boolean).join(' ')}>
        {model.note ?? '内容没有变化'}
      </div>
    )
  }

  return (
    <div className={['diff-view', className].filter(Boolean).join(' ')}>
      {hideHeader ? null : (
        <div className="diff-head">
          <span className="diff-file mono">
            <FileDiff size={12} strokeWidth={1.6} aria-hidden />
            {filePath ?? model.filePath ?? '改动'}
          </span>
          <span className="diff-stats mono">
            <span className="diff-add-count">+{model.added}</span>
            <span className="diff-del-count">-{model.removed}</span>
          </span>
        </div>
      )}
      <div className="diff-body" style={maxHeight ? { maxHeight } : undefined}>
        {model.hunks.map((hunk, index) => (
          <HunkView key={`${hunk.header}-${index}`} hunk={hunk} contextLines={contextLines} collapseContext={model.hunks.length > 0} />
        ))}
        {model.note ? <div className="diff-note mono">{model.note}</div> : null}
      </div>
    </div>
  )
}

interface MenuState {
  x: number
  y: number
}

interface ResolvedPath {
  absolute: string | null
  relative: string | null
  workspace: string | null
}

function resolvePath(parsed: ParsedFilePath): ResolvedPath {
  const state = useAppStore.getState()
  const workspace = state.session?.workspace ?? state.settings.lastWorkspace ?? null
  if (isAbsoluteFilePath(parsed.path)) {
    return {
      absolute: parsed.path,
      relative: workspace ? relativeToWorkspace(workspace, parsed.path) : null,
      workspace
    }
  }
  if (!workspace) return { absolute: null, relative: normalizeRelativePath(parsed.path), workspace: null }
  return {
    absolute: joinWorkspacePath(workspace, parsed.path),
    relative: normalizeRelativePath(parsed.path),
    workspace
  }
}

function errorOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Markdown 中的文件路径：单击在画布/编辑器中打开，右键提供资源管理器、复制内容与路径。
 * 不是工作区内的文件时给出明确提示，避免静默失败。
 */
export function FilePathLink({
  raw,
  label,
  streaming = false,
  allowBare = false
}: {
  raw: string
  label?: string
  streaming?: boolean
  allowBare?: boolean
}) {
  const parsed = parseFilePath(raw, { allowBare })
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    // 菜单挂载瞬间可能伴随布局/窗口 resize 与滚动事件；短暂宽限避免刚打开就消失
    const openedAt = Date.now()
    const close = (event: Event): void => {
      if ((event.type === 'scroll' || event.type === 'resize') && Date.now() - openedAt < 350) return
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!parsed || streaming) return <code className="md-inline-code">{raw}</code>

  const notify = (kind: 'success' | 'warning' | 'error', message: string): void => {
    useAppStore.getState().notify(kind, message)
  }

  const openInApp = (): void => {
    setMenu(null)
    const target = resolvePath(parsed)
    if (!target.workspace) {
      notify('warning', '还没有选择工作文件夹，先选择工作文件夹再打开文件。')
      return
    }
    if (!target.absolute || target.relative === null) {
      notify('warning', '这个文件不在当前工作文件夹内，无法在画布中打开。')
      return
    }
    dispatchOpenFile({ path: target.relative, absolutePath: target.absolute })
  }

  const reveal = async (): Promise<void> => {
    setMenu(null)
    const target = resolvePath(parsed)
    if (!target.absolute) {
      notify('warning', '还没有选择工作文件夹，无法定位文件。')
      return
    }
    try {
      const result = await window.morrow.artifacts.reveal(target.absolute)
      if (!result.ok) notify('error', result.error.message)
    } catch (err) {
      notify('error', errorOf(err))
    }
  }

  const copyPath = async (absolute: boolean): Promise<void> => {
    setMenu(null)
    const target = resolvePath(parsed)
    const value = absolute ? target.absolute : target.relative
    if (!value) {
      notify('warning', absolute ? '还没有选择工作文件夹，无法复制绝对路径。' : '这个文件不在当前工作文件夹内。')
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      notify('success', absolute ? '已复制绝对路径' : '已复制相对路径')
    } catch {
      notify('error', '复制失败，请检查剪贴板权限。')
    }
  }

  const copyContent = async (): Promise<void> => {
    setMenu(null)
    const target = resolvePath(parsed)
    if (!target.absolute) {
      notify('warning', '还没有选择工作文件夹，无法读取文件内容。')
      return
    }
    if (!isTextFilePath(parsed.path)) {
      notify('warning', '这是二进制文件，无法复制为文本内容。')
      return
    }
    try {
      const result = await window.morrow.artifacts.read(target.absolute)
      if (!result.ok) {
        notify('error', result.error.message)
        return
      }
      await navigator.clipboard.writeText(result.data.content)
      notify(result.data.truncated ? 'warning' : 'success', result.data.truncated ? '文件较大，已复制可读取的部分内容' : '已复制文件内容')
    } catch (err) {
      notify('error', errorOf(err))
    }
  }

  const target = resolvePath(parsed)
  const canCopyContent = Boolean(target.absolute) && isTextFilePath(parsed.path)
  const canCopyRelative = Boolean(target.relative) && target.relative !== target.absolute
  const menuBox = menu
    ? {
        left: Math.max(8, Math.min(menu.x, window.innerWidth - 260)),
        top: Math.max(8, Math.min(menu.y, window.innerHeight - 232))
      }
    : null

  return (
    <>
      <button
        type="button"
        className="md-file-link"
        title={`点击在应用内打开${parsed.line ? `（第 ${parsed.line} 行）` : ''} · 右键更多操作`}
        aria-label={`打开文件 ${parsed.path}${parsed.line ? `，第 ${parsed.line} 行` : ''}`}
        onClick={openInApp}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        <FileText size={12} strokeWidth={1.6} aria-hidden />
        <span className="md-file-link-label mono">{label || parsed.display}</span>
      </button>
      {menu && menuBox
        ? createPortal(
            <div
              ref={menuRef}
              className="md-file-menu"
              role="menu"
              aria-label="文件操作"
              style={{ left: menuBox.left, top: menuBox.top }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <div className="md-file-menu-head mono truncate" title={target.absolute ?? parsed.path}>
                {parsed.display}
              </div>
              <button type="button" role="menuitem" className="md-file-menu-item" onClick={openInApp}>
                <FileText size={13} strokeWidth={1.6} aria-hidden /> 在应用内打开
              </button>
              <button type="button" role="menuitem" className="md-file-menu-item" onClick={() => void reveal()}>
                <FolderOpen size={13} strokeWidth={1.6} aria-hidden /> 在资源管理器中打开
              </button>
              <div className="md-file-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="md-file-menu-item"
                disabled={!canCopyContent}
                title={canCopyContent ? undefined : '二进制文件不支持复制文本内容'}
                onClick={() => void copyContent()}
              >
                <Copy size={13} strokeWidth={1.6} aria-hidden /> 复制内容
              </button>
              <button type="button" role="menuitem" className="md-file-menu-item" onClick={() => void copyPath(true)}>
                <Link2 size={13} strokeWidth={1.6} aria-hidden /> 复制路径
              </button>
              {canCopyRelative ? (
                <button type="button" role="menuitem" className="md-file-menu-item" onClick={() => void copyPath(false)}>
                  <Copy size={13} strokeWidth={1.6} aria-hidden /> 复制相对路径
                </button>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

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
    if (!streaming && typeof href === 'string') {
      let decoded = href
      try {
        decoded = decodeURIComponent(href)
      } catch {
        // 保留原始 href
      }
      const file = parseFilePath(decoded, { allowBare: true })
      if (file) return <FilePathLink raw={file.display} label={extractText(children) || undefined} allowBare />
    }
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
    if (!isBlock) {
      if (!streaming && parseFilePath(raw)) return <FilePathLink raw={raw} />
      return <code className="md-inline-code">{children}</code>
    }
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

// 渲染层通用小工具（原 lib.ts）
export function errorText(err: unknown, fallback = '操作失败，请重试。'): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err.trim()) return err
  return fallback
}

/** 历史/版本列表的时间：当天只显示时分，其它日期加上月日。 */
export function formatArtifactTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  if (date.toDateString() === now.toDateString()) return time
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`
}
