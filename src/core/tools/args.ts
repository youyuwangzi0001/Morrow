// 工具参数读取与校验。模型输出的参数不可信（类型、缺失、超长都要兜住），
import { ToolInputError } from './types'

export function getString(
  input: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; defaultValue?: string; trim?: boolean; maxLength?: number } = {}
): string {
  const raw = input[key]
  if (raw === undefined || raw === null) {
    if (opts.required) throw new ToolInputError(`缺少必填参数「${key}」。`, `请补上参数 ${key} 后重试。`)
    return opts.defaultValue ?? ''
  }
  if (typeof raw !== 'string') {
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
    throw new ToolInputError(`参数「${key}」应该是字符串。`, `请以字符串形式提供 ${key}。`)
  }
  let value = opts.trim === false ? raw : raw.trim()
  const maxLength = opts.maxLength
  if (maxLength && value.length > maxLength) {
    throw new ToolInputError(`参数「${key}」过长（${value.length} 字符，上限 ${maxLength}）。`, '请缩短后重试，或拆分成多次调用。')
  }
  if (!value && opts.required) {
    throw new ToolInputError(`参数「${key}」不能为空。`, `请补上参数 ${key} 后重试。`)
  }
  return value
}

export function getNumber(
  input: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; defaultValue?: number; min?: number; max?: number } = {}
): number {
  const raw = input[key]
  if (raw === undefined || raw === null || raw === '') {
    if (opts.required) throw new ToolInputError(`缺少必填参数「${key}」。`, `请补上数字参数 ${key}。`)
    return opts.defaultValue ?? 0
  }
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) {
    throw new ToolInputError(`参数「${key}」应该是数字。`, `请以数字形式提供 ${key}。`)
  }
  const min = opts.min ?? Number.NEGATIVE_INFINITY
  const max = opts.max ?? Number.POSITIVE_INFINITY
  if (value < min || value > max) {
    throw new ToolInputError(`参数「${key}」超出范围（${value}，允许 ${min}~${max}）。`, '请调整后重试。')
  }
  return value
}

export function getBoolean(input: Record<string, unknown>, key: string, defaultValue = false): boolean {
  const raw = input[key]
  if (raw === undefined || raw === null) return defaultValue
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', '是'].includes(lower)) return true
    if (['false', '0', 'no', 'n', '否'].includes(lower)) return false
  }
  if (typeof raw === 'number') return raw !== 0
  return defaultValue
}

/** 字符串数组（用于 options/todos 等）；也接受 [{label}] / [{text}] 这类对象数组 */
export function getStringArray(
  input: Record<string, unknown>,
  key: string,
  opts: { maxItems?: number } = {}
): string[] {
  const raw = input[key]
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new ToolInputError(`参数「${key}」应该是数组。`, `请提供字符串数组，例如 ${key}: ["a", "b"]。`)
  }
  const max = opts.maxItems ?? 100
  if (raw.length > max) {
    throw new ToolInputError(`参数「${key}」元素过多（${raw.length}，上限 ${max}）。`, '请减少数量后重试。')
  }
  return raw.map((item) => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const value = obj.label ?? obj.text ?? obj.value ?? obj.name
      if (typeof value === 'string') return value
    }
    return String(item)
  })
}

/** 对象数组，过滤掉非对象项 */
export function getObjectArray(input: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const raw = input[key]
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new ToolInputError(`参数「${key}」应该是数组。`, `请提供对象数组后重试。`)
  }
  return raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
}
