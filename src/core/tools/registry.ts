/**
 * 工具注册表：唯一工具清单（顺序固定，便于 provider 端 prompt cache 命中）。
 * 同时提供「给模型的定义」「给 UI/权限的元信息」「真实执行」三个视图。
 */
import type { ToolCategory, ToolResult, ToolRisk } from '../../shared/types'
import type { ToolContext, ToolDefinition } from '../types'
import { detectDangerousCommand, isResearchModeToolAllowed } from '../permissions'
import { errorMessage, isAbortError } from '../util'
import { runCommandTool } from './command-tool'
import { docxTools } from './docx-tools'
import { ToolExecutionError, ToolInputError, WorkspaceEscapeError } from './types'
import { fsTools } from './fs-tools'
import { mcpCallTool, mcpListTool, mcpPromptTool, mcpResourcesTool } from './mcp-tools'
import { metaTools, updateGoalTool } from './meta-tools'
import { planTools, submitPlanTool } from './plan-tools'
import { pdfTools } from './pdf-tools'
import { pptxTools } from './pptx-tools'
import { searchTools } from './search-tools'
import { webSearchTool } from './search-web'
import { terminalTool } from './terminal-tool'
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
 * 文档工具（PDF/DOCX/XLSX/PPTX）与技能工具（list_skills/read_skill）为 R8/R11 新增：
 * 都走工作区沙箱；用户显式附加的工作区外文档走只读附件白名单。
 * 外部工具（web_fetch / mcp_list / mcp_call）追加在末尾（R8 #6）：
 * web_fetch / mcp_list / mcp_call 都是外部动作（category=exec，read-only 拒绝，ask/auto 逐次审批）。
 */
const BASE_TOOLS: ToolImpl[] = [
  ...fsTools,
  ...pdfTools,
  ...docxTools,
  ...xlsxTools,
  ...pptxTools,
  ...searchTools,
  runCommandTool,
  ...skillTools,
  ...metaTools,
  // R8 #6 外部工具：追加在末尾，保持既有工具顺序稳定（prompt cache）
  webSearchTool,
  webFetchTool,
  terminalTool,
  mcpListTool,
  mcpCallTool,
  mcpResourcesTool,
  mcpPromptTool,
  // R10-K1 浏览器自动化：外部动作逐次审批
  ...browserTools,
  // R10-K3 受控 computer-use：仅在用户逐次审批后执行
  ...computerTools
]
// P0-2 计划模式工具：不进入普通会话工具清单，只由 toolDefinitionsForRun(planMode=true) 注入
const PLAN_TOOLS: ToolImpl[] = [...planTools]
const ALL_TOOLS: ToolImpl[] = [...BASE_TOOLS, ...PLAN_TOOLS, updateGoalTool]
const TOOL_BY_NAME = new Map<string, ToolImpl>(ALL_TOOLS.map((tool) => [tool.definition.name, tool]))

export const TOOL_DEFINITIONS: ToolDefinition[] = BASE_TOOLS.map((tool) => tool.definition)

/** Goal 模式专用工具定义（仅 active 目标时注入） */
export const GOAL_TOOL_DEFINITION: ToolDefinition = updateGoalTool.definition

/** 计划模式专用工具定义 */
export const PLAN_TOOL_DEFINITION: ToolDefinition = submitPlanTool.definition

/**
 * 计划模式工具集：只读工具 + 计划/提问/任务面板。
 * 不包含写入、执行、记忆、子代理、外发与目标工具，权限层同时固定只读。
 */
export const PLAN_MODE_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...TOOL_DEFINITIONS.filter(
    (definition) =>
      definition.category === 'read' ||
      definition.name === 'ask_user' ||
      definition.name === 'todo_write'
  ),
  PLAN_TOOL_DEFINITION
]
const PLAN_MODE_TOOL_NAMES = new Set(PLAN_MODE_TOOL_DEFINITIONS.map((definition) => definition.name))

/** 按运行模式返回本次暴露给模型的工具列表（web_search 仅在已配置搜索服务时暴露） */
export function toolDefinitionsForRun(
  goalMode: boolean,
  planMode = false,
  webSearchAvailable = false,
  researchMode = false,
  temporaryMode = false,
  researchPlanning = false
): ToolDefinition[] {
  if (researchPlanning) return []
  if (planMode) return PLAN_MODE_TOOL_DEFINITIONS
  let base = webSearchAvailable
    ? TOOL_DEFINITIONS
    : TOOL_DEFINITIONS.filter((tool) => tool.name !== 'web_search')
  // 临时对话不写长期项目记忆：不向模型暴露 remember。
  if (temporaryMode) base = base.filter((tool) => tool.name !== 'remember')
  if (researchMode) {
    return base.filter((tool) => isResearchModeToolAllowed(tool.name, tool.category))
  }
  return goalMode ? [...base, GOAL_TOOL_DEFINITION] : base
}

/** 只读类工具清单：聊天模式过滤与审计参考（子代理与主代理共用完整工具集） */
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
  if (name === 'terminal') {
    if (input.action === 'write') return 'high'
    if (input.action === 'run' || input.action === 'start') {
      const command = typeof input.command === 'string' ? input.command : ''
      if (detectDangerousCommand(command)) return 'high'
    }
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
  // 计划模式白名单兜底：未暴露的 meta 工具（task/swarm/update_goal 等）也不能被模型偷偷调用
  if (ctx.planMode && !PLAN_MODE_TOOL_NAMES.has(name)) {
    return errResult(
      '计划模式只能使用只读工具、ask_user、todo_write 和 submit_plan。',
      '请先提交计划并等待用户批准；批准后系统会切到工作模式并提供完整工具。'
    )
  }
  // 工具层只读兜底：即使调用方绕过权限层，也只允许只读工具
  if (ctx.readOnly && tool.definition.category !== 'read') {
    return errResult('当前是只读上下文，只能使用只读工具。', '请改用只读工具收集信息，或切换到有权限的工作模式。')
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
