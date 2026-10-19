/**
 * 工具实现的公共类型与结果构造器。
 * 工具统一返回 ToolResult（成功 ok:true / 失败 ok:false），失败也要回灌给模型自修复。
 */
import type { ToolResult } from '../../shared/types'
import type { ToolContext, ToolDefinition } from '../types'

export interface ToolImpl {
  definition: ToolDefinition
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export function okResult(output: string, meta?: Record<string, unknown>, durationMs?: number): ToolResult {
  return { ok: true, output, ...(meta ? { meta } : {}), ...(typeof durationMs === 'number' ? { durationMs } : {}) }
}

export function errResult(error: string, hint?: string, meta?: Record<string, unknown>): ToolResult {
  return { ok: false, output: '', error, ...(hint ? { hint } : {}), ...(meta ? { meta } : {}) }
}

/** 标题/摘要里安全地展示用户输入（压成一行、限长） */
export function oneLineInput(input: Record<string, unknown>, key: string, max = 80): string {
  const raw = input[key]
  const text = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw)
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}
