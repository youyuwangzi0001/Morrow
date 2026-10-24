import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import './ui.css'

/* ── Button ───────────────────────────────────────────────────── */

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

/* ── Kbd / Badge ──────────────────────────────────────────────── */

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

/* ── Spinner / Loader ─────────────────────────────────────────── */

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

/* ── Input / Field ────────────────────────────────────────────── */

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

/* ── Select（自绘、键盘可达的 listbox） ───────────────────────── */

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

/* ── Dropdown（菜单） ─────────────────────────────────────────── */

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

/* ── Modal ────────────────────────────────────────────────────── */

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

/* ── Tooltip（轻量 CSS 实现，适合图标按钮） ──────────────────── */

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

/* ── 空状态 / 错误状态的小型通用结构 ────────────────────────── */

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


/* ── ResizeHandle：侧栏 / 画布通用拖拽调宽手柄 ───────────────── */

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
  const start = useRef({ x: 0, value })
  const latest = useRef(value)

  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent): void => {
      const delta = event.clientX - start.current.x
      const next = clampResize(edge === 'right' ? start.current.value + delta : start.current.value - delta, min, max)
      latest.current = next
      onChange(next)
    }
    const onUp = (): void => {
      setDragging(false)
      document.body.classList.remove('is-resizing-panel')
      onCommit(latest.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('is-resizing-panel')
    }
  }, [dragging, edge, min, max, onChange, onCommit])

  useEffect(() => {
    if (!dragging) latest.current = value
  }, [value, dragging])

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    start.current = { x: event.clientX, value }
    latest.current = value
    setDragging(true)
    document.body.classList.add('is-resizing-panel')
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
        className={['resize-handle', edge === 'left' ? 'is-left' : 'is-right', dragging ? 'is-dragging' : '', className]
          .filter(Boolean)
          .join(' ')}
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
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
