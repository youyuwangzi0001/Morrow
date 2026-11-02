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

/**
 * 工具层错误类型：区分「用户可自修复的参数错误」与「越界访问」（需要审批）。
 */

/** 参数不合法 / 前置条件不满足：给模型自修复用，hint 是给模型的具体建议 */
export class ToolInputError extends Error {
  readonly hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'ToolInputError'
    this.hint = hint
  }
}

/** 目标路径 realpath 后不在工作区内：交给权限层审批，不直接当普通错误吞掉 */
export class WorkspaceEscapeError extends Error {
  readonly attemptedPath: string
  readonly workspace: string

  constructor(attemptedPath: string, workspace: string) {
    super(`路径超出了工作区范围：${attemptedPath}`)
    this.name = 'WorkspaceEscapeError'
    this.attemptedPath = attemptedPath
    this.workspace = workspace
  }
}

/** 工具内部可预期的失败（例如文件不存在），信息直接回灌给模型 */
export class ToolExecutionError extends Error {
  readonly hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'ToolExecutionError'
    this.hint = hint
  }
}
