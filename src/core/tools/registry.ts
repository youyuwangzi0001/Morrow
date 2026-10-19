/**
 * 工具注册表：唯一工具清单（顺序固定，便于 provider 端 prompt cache 命中）。
 * 同时提供「给模型的定义」「给 UI/权限的元信息」「真实执行」三个视图。
 */
import type { ToolCategory, ToolResult, ToolRisk } from '../../shared/types'
import type { ToolContext, ToolDefinition } from '../types'
import { detectDangerousCommand } from '../permissions'
import { errorMessage, isAbortError } from '../util'
import { runCommandTool } from './command-tool'
import { docxTools } from './docx-tools'
import { ToolExecutionError, ToolInputError, WorkspaceEscapeError } from './errors'
import { fsTools } from './fs-tools'
import { mcpCallTool, mcpListTool } from './mcp-tools'
import { metaTools, updateGoalTool } from './meta-tools'
import { pdfTools } from './pdf-tools'
import { searchTools } from './search-tools'
import { skillTools } from './skills-tools'
import { webFetchTool } from './web-tools'
import { browserTools } from './browser-tools'
import { computerTools } from './computer-tools'
import { xlsxTools } from './xlsx-tools'
import { errResult, type ToolImpl } from './types'

/**
 * 顺序即暴露给模型的顺序（保持稳定，帮助 prompt cache）。
 * `TOOL_DEFINITIONS` 保持 v1 的基础工具；`update_goal` 只在 Goal 模式注入，
 * 避免普通会话的工具列表/契约被 Goal 功能污染。
 * 文档工具（PDF/DOCX/XLSX）与技能工具（list_skills/read_skill）为 R8 新增：
 * 都走工作区沙箱，只读工具进入 READ_ONLY_TOOL_DEFINITIONS（子代理/聊天模式可用）。
 * 外部工具（web_fetch / mcp_list / mcp_call）追加在末尾（R8 #6）：
 * web_fetch 与 mcp_call 是外部动作（category=exec，需审批），mcp_list 只读取工具清单（meta）。
 */
const BASE_TOOLS: ToolImpl[] = [
  ...fsTools,
  ...pdfTools,
  ...docxTools,
  ...xlsxTools,
  ...searchTools,
  runCommandTool,
  ...skillTools,
  ...metaTools,
  // R8 #6 外部工具：追加在末尾，保持既有工具顺序稳定（prompt cache）
  webFetchTool,
  mcpListTool,
  mcpCallTool,
  // R10-K1 浏览器自动化：外部动作逐次审批
  ...browserTools,
  // R10-K3 受控 computer-use：仅在用户逐次审批后执行
  ...computerTools
]
const ALL_TOOLS: ToolImpl[] = [...BASE_TOOLS, updateGoalTool]
const TOOL_BY_NAME = new Map<string, ToolImpl>(ALL_TOOLS.map((tool) => [tool.definition.name, tool]))

export const TOOL_DEFINITIONS: ToolDefinition[] = BASE_TOOLS.map((tool) => tool.definition)

/** Goal 模式专用工具定义（仅 active 目标时注入） */
export const GOAL_TOOL_DEFINITION: ToolDefinition = updateGoalTool.definition

/** 按运行模式返回本次暴露给模型的工具列表 */
export function toolDefinitionsForRun(goalMode: boolean): ToolDefinition[] {
  return goalMode ? [...TOOL_DEFINITIONS, GOAL_TOOL_DEFINITION] : TOOL_DEFINITIONS
}

/** 子代理可用工具：仅只读工具（架构：子代理只读优先） */
export const READ_ONLY_TOOL_DEFINITIONS: ToolDefinition[] = TOOL_DEFINITIONS.filter((definition) => definition.category === 'read')

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_BY_NAME.get(name)?.definition
}

export function isKnownTool(name: string): boolean {
  return TOOL_BY_NAME.has(name)
}

export function isReadOnlyTool(name: string): boolean {
  return TOOL_BY_NAME.get(name)?.definition.category === 'read'
}

export function toolTitleFor(name: string, input: Record<string, unknown> = {}): string {
  const tool = TOOL_BY_NAME.get(name)
  if (!tool) return `调用 ${name}`
  try {
    return tool.definition.titleFor(input)
  } catch {
    return `调用 ${name}`
  }
}

export function toolCategory(name: string): ToolCategory {
  return TOOL_BY_NAME.get(name)?.definition.category ?? 'meta'
}

/** 基础风险 + 按输入提升（危险命令 → high） */
export function toolRiskFor(name: string, input: Record<string, unknown> = {}): ToolRisk {
  const base = TOOL_BY_NAME.get(name)?.definition.risk ?? 'low'
  if (name === 'run_command') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (detectDangerousCommand(command)) return 'high'
  }
  return base
}

/**
 * 执行工具：所有异常都转成 ToolResult（绝不把异常抛给 Agent 循环，
 * 否则一次工具崩溃会终止整轮对话；模型需要看到失败原因来自修复）。
 */
export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOL_BY_NAME.get(name)
  if (!tool) {
    const available = [...TOOL_BY_NAME.keys()].join('、')
    return errResult(`没有名为「${name}」的工具。`, `本次可用工具：${available}。请使用正确的工具名。`)
  }
  // 防御：子代理即使被模型要求写文件/跑命令，也在这里拦下
  if (ctx.readOnly && tool.definition.category !== 'read') {
    return errResult('子代理只能使用只读工具，不能修改文件或运行命令。', '请改用只读工具收集信息，把结论返回给主代理。')
  }
  try {
    return await tool.execute(input ?? {}, ctx)
  } catch (err) {
    if (err instanceof WorkspaceEscapeError) {
      return errResult(
        `路径超出了工作区：${err.attemptedPath}`,
        '如果要访问工作区外，需要用户在审批卡里允许；也可以把文件复制到工作区内再操作。'
      )
    }
    if (err instanceof ToolInputError) {
      return errResult(err.message, err.hint)
    }
    if (err instanceof ToolExecutionError) {
      return errResult(err.message, err.hint)
    }
    if (isAbortError(err)) {
      return errResult('执行已中断（用户停止了本轮运行）。', undefined, { interrupted: true })
    }
    return errResult(`工具执行出错：${errorMessage(err)}`, '这是工具内部错误。可以换一种方式重试，或向用户说明这一步失败了。')
  }
}
