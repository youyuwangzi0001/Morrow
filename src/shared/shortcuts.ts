/**
 * 可自定义快捷键：统一存储为 Electron/跨平台形式（CommandOrControl+Shift+M）。
 * 界面显示与按键匹配都在这里归一化，避免设置页、全局监听和主进程各写一套。
 */

export const SHORTCUT_ACTIONS = [
  {
    id: 'palette',
    label: '打开命令面板',
    description: '在 Morrow 窗口内唤起命令面板。',
    defaultBinding: 'CommandOrControl+K',
    scope: 'window'
  },
  {
    id: 'sidebar',
    label: '收起或展开侧栏',
    description: '切换左侧会话与文件栏。',
    defaultBinding: 'CommandOrControl+B',
    scope: 'window'
  },
  {
    id: 'new-session',
    label: '新建对话',
    description: '立即开一个空白对话。',
    defaultBinding: 'CommandOrControl+N',
    scope: 'window'
  },
  {
    id: 'settings',
    label: '打开设置',
    description: '打开设置面板。',
    defaultBinding: 'CommandOrControl+,',
    scope: 'window'
  },
  {
    id: 'terminal',
    label: '打开或收起终端',
    description: '在窗口底部切换集成终端。',
    defaultBinding: 'CommandOrControl+`',
    scope: 'window'
  },
  {
    id: 'island',
    label: '显示或隐藏桌面伙伴',
    description: 'Morrow 在后台时也生效；需先在设置中开启桌面伙伴。',
    defaultBinding: 'CommandOrControl+Shift+M',
    scope: 'global'
  }
] as const

export type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number]['id']

export type ShortcutMap = Record<ShortcutActionId, string>

export const DEFAULT_SHORTCUTS: ShortcutMap = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, action.defaultBinding])
) as ShortcutMap

export interface ParsedShortcut {
  /** CommandOrControl：Windows/Linux 匹配 Ctrl，macOS 匹配 ⌘ */
  mod: boolean
  alt: boolean
  shift: boolean
  key: string
}

export interface ShortcutKeyEvent {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
}

const MODIFIER_TOKENS = new Set([
  'commandorcontrol',
  'cmdorctrl',
  'control',
  'ctrl',
  'command',
  'cmd',
  'alt',
  'option',
  'shift',
  'super',
  'meta'
])

const NAMED_KEYS: Record<string, string> = {
  escape: 'Escape',
  esc: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight'
}

const PUNCTUATION: Record<string, string> = {
  '`': '`',
  ',': ',',
  '.': '.',
  '/': '/',
  ';': ';',
  "'": "'",
  '[': '[',
  ']': ']',
  '\\': '\\',
  '-': '-',
  '=': '='
}

const CODE_KEYS: Record<string, string> = {
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight'
}

/** 系统或输入框高频组合：不允许被自定义快捷键占用。 */
const RESERVED_KEYS = new Set(['C', 'V', 'X', 'Z', 'Y', 'A', 'S', 'F', 'P', 'R', 'W', 'Q', 'Tab'])
const RESERVED_SHIFT_KEYS = new Set(['I', 'J', 'C'])
const RESERVED_KEYS_ALWAYS = new Set(['Escape', 'Enter', 'Tab', 'Space', 'Backspace'])

function normalizeKeyToken(token: string): string | null {
  const trimmed = token.trim()
  if (!trimmed) return null
  if (/^[a-z]$/i.test(trimmed)) return trimmed.toUpperCase()
  if (/^[0-9]$/.test(trimmed)) return trimmed
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(trimmed)) return trimmed.toUpperCase()
  const named = NAMED_KEYS[trimmed.toLowerCase()]
  if (named) return named
  if (PUNCTUATION[trimmed]) return PUNCTUATION[trimmed]
  return null
}

export function parseShortcutBinding(binding: string): ParsedShortcut | null {
  if (typeof binding !== 'string') return null
  const trimmed = binding.trim()
  if (!trimmed || trimmed.length > 80) return null
  const tokens = trimmed.split('+').map((token) => token.trim())
  if (tokens.some((token) => !token)) return null
  let mod = false
  let alt = false
  let shift = false
  let key: string | null = null
  for (const token of tokens) {
    if (MODIFIER_TOKENS.has(token.toLowerCase())) {
      const lower = token.toLowerCase()
      if (lower === 'commandorcontrol' || lower === 'cmdorctrl' || lower === 'control' || lower === 'ctrl' || lower === 'command' || lower === 'cmd' || lower === 'super' || lower === 'meta') {
        mod = true
      } else if (lower === 'alt' || lower === 'option') {
        alt = true
      } else if (lower === 'shift') {
        shift = true
      }
      continue
    }
    if (key) return null
    key = normalizeKeyToken(token)
    if (!key) return null
  }
  if (!key) return null
  return { mod, alt, shift, key }
}

/** 自定义快捷键必须带 Ctrl/⌘ 或 Alt，避免单键/Shift+键抢走正常输入。 */
export function canonicalizeShortcut(binding: string): string | null {
  const parsed = parseShortcutBinding(binding)
  if (!parsed) return null
  if (!parsed.mod && !parsed.alt) return null
  const parts: string[] = []
  if (parsed.mod) parts.push('CommandOrControl')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(parsed.key)
  return parts.join('+')
}

export function isReservedShortcut(binding: string): boolean {
  const parsed = parseShortcutBinding(binding)
  if (!parsed) return true
  if (RESERVED_KEYS_ALWAYS.has(parsed.key)) return true
  if (parsed.key === 'F4' && parsed.alt) return true
  if (parsed.mod && parsed.alt && parsed.key === 'Delete') return true
  if (parsed.mod && !parsed.alt && RESERVED_KEYS.has(parsed.key)) return true
  if (parsed.mod && parsed.shift && !parsed.alt && RESERVED_SHIFT_KEYS.has(parsed.key)) return true
  return false
}

export function formatShortcutBinding(binding: string, platform?: string): string {
  const parsed = parseShortcutBinding(binding)
  if (!parsed) return binding
  const isMac = platform === 'darwin'
  const parts: string[] = []
  if (parsed.mod) parts.push(isMac ? '⌘' : 'Ctrl')
  if (parsed.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (parsed.shift) parts.push(isMac ? '⇧' : 'Shift')
  const keyLabel: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Escape: 'Esc',
    Space: 'Space'
  }
  parts.push(keyLabel[parsed.key] ?? parsed.key)
  return parts.join('+')
}

function keyFromEvent(event: ShortcutKeyEvent): string | null {
  const code = event.code ?? ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  if (CODE_KEYS[code]) return CODE_KEYS[code]
  if (event.key.length === 1) {
    const upper = event.key.toUpperCase()
    if (/^[A-Z0-9]$/.test(upper)) return upper
    if (PUNCTUATION[event.key]) return PUNCTUATION[event.key]
  }
  const named = NAMED_KEYS[event.key.toLowerCase()]
  return named ?? null
}

/** 设置页录制：返回 null 表示还在按修饰键；error 表示不能保存的组合。 */
export function shortcutFromKeyboardEvent(event: ShortcutKeyEvent): { binding: string | null; error?: string } {
  const key = keyFromEvent(event)
  if (!key) return { binding: null }
  const mod = Boolean(event.ctrlKey || event.metaKey)
  const alt = Boolean(event.altKey)
  const shift = Boolean(event.shiftKey)
  if (!mod && !alt) {
    return { binding: null, error: '快捷键至少需要 Ctrl / ⌘ / Alt 之一。' }
  }
  const parts: string[] = []
  if (mod) parts.push('CommandOrControl')
  if (alt) parts.push('Alt')
  if (shift) parts.push('Shift')
  parts.push(key)
  const binding = parts.join('+')
  if (isReservedShortcut(binding)) {
    return { binding: null, error: `${formatShortcutBinding(binding)} 是系统或输入框保留组合，换一个。` }
  }
  return { binding }
}

export function findShortcutConflict(
  binding: string,
  actionId: ShortcutActionId,
  shortcuts: ShortcutMap
): ShortcutActionId | null {
  const canonical = canonicalizeShortcut(binding)
  if (!canonical) return null
  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === actionId) continue
    if (canonicalizeShortcut(shortcuts[action.id] ?? '') === canonical) return action.id
  }
  return null
}

export function matchesShortcut(event: ShortcutKeyEvent, binding: string, platform?: string): boolean {
  if (event.repeat) return false
  const parsed = parseShortcutBinding(binding)
  if (!parsed) return false
  const key = keyFromEvent(event)
  if (!key || key !== parsed.key) return false
  const isMac = platform === 'darwin'
  const modPressed = isMac ? Boolean(event.metaKey) : Boolean(event.ctrlKey)
  if (parsed.mod !== modPressed) return false
  if (parsed.alt !== Boolean(event.altKey)) return false
  if (parsed.shift !== Boolean(event.shiftKey)) return false
  return true
}

/** 从磁盘读取时容错：无效/冲突/保留组合回落到对应默认值。 */
export function normalizeShortcutMap(input: unknown): ShortcutMap {
  const result = { ...DEFAULT_SHORTCUTS }
  const owners = new Map<string, ShortcutActionId>(
    SHORTCUT_ACTIONS.map((action) => [result[action.id], action.id])
  )
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result
  const record = input as Record<string, unknown>
  for (const action of SHORTCUT_ACTIONS) {
    const raw = record[action.id]
    const binding = typeof raw === 'string' ? canonicalizeShortcut(raw) : null
    if (!binding || isReservedShortcut(binding)) continue
    const owner = owners.get(binding)
    if (owner && owner !== action.id) continue
    if (result[action.id] !== binding) {
      owners.delete(result[action.id])
      result[action.id] = binding
      owners.set(binding, action.id)
    }
  }
  return result
}

/** 主进程保存前校验完整映射：必须六个动作齐全、无保留组合、无重复。 */
export function validateShortcutMap(input: unknown): ShortcutMap {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('快捷键设置格式不正确。')
  const record = input as Record<string, unknown>
  const seen = new Map<string, ShortcutActionId>()
  const result = {} as ShortcutMap
  for (const action of SHORTCUT_ACTIONS) {
    const raw = record[action.id]
    if (typeof raw !== 'string') throw new Error(`「${action.label}」缺少快捷键。`)
    const binding = canonicalizeShortcut(raw)
    if (!binding) throw new Error(`「${action.label}」的快捷键无效，至少需要 Ctrl / ⌘ / Alt 之一。`)
    if (isReservedShortcut(binding)) {
      throw new Error(`「${action.label}」不能使用系统保留的 ${formatShortcutBinding(binding)}。`)
    }
    const otherId = seen.get(binding)
    if (otherId) {
      const other = SHORTCUT_ACTIONS.find((item) => item.id === otherId)
      throw new Error(`「${action.label}」和「${other?.label ?? otherId}」使用了同一个组合。`)
    }
    seen.set(binding, action.id)
    result[action.id] = binding
  }
  return result
}

/** Electron globalShortcut 接受 CommandOrControl；这里显式转换一次，便于单测。 */
export function toElectronAccelerator(binding: string): string {
  return canonicalizeShortcut(binding) ?? binding
}
