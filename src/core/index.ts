/**
 * Morrow Agent 内核公共出口。
 *
 * 主进程集成方式：
 * ```ts
 * import {
 *   runAgent, createProvider, testProviderConnection, buildSystemPrompt,
 *   TOOL_DEFINITIONS, estimateTokens
 * } from '@core/index'
 * ```
 * 本模块只依赖 Node 内置能力与 src/shared 契约，不依赖 electron / react / DOM。
 */

export {
  runAgent,
  compactSession,
  estimateContextUsage,
  getSessionPermissionGrants,
  clearSessionPermissionGrants,
  resetAllPermissionGrants,
  type RunAgentOptions,
  type RunAgentResult,
  type CompactSessionOptions,
  type CompactSessionResult
} from './agent'

export {
  createProvider,
  testProviderConnection,
  DemoProvider,
  collectDemoMetrics,
  renderDemoReportHtml,
  AnthropicProvider,
  OpenAICompatProvider,
  ProviderError,
  DEFAULT_RETRY,
  resolveChatCompletionsUrl,
  resolveAnthropicMessagesUrl,
  toOpenAIMessages,
  toAnthropicMessages,
  type RetryPolicy,
  type SSEFrame,
  SSEParser,
  iterateSSE,
  iterateSSEData,
  type DemoMetrics
} from './providers'
export type { ConnectionTestOptions } from './types'

export {
  TOOL_DEFINITIONS,
  READ_ONLY_TOOL_DEFINITIONS,
  GOAL_TOOL_DEFINITION,
  PLAN_TOOL_DEFINITION,
  PLAN_MODE_TOOL_DEFINITIONS,
  toolDefinitionsForRun,
  executeTool,
  getToolDefinition,
  isKnownTool,
  isReadOnlyTool,
  toolCategory,
  toolRiskFor,
  toolTitleFor
} from './tools'
export { WorkspaceEscapeError, ToolInputError, ToolExecutionError } from './tools'
export { inspectWorkspacePath, resolveWorkspacePath, displayPath, normalizeWorkspace } from './tools'
export { createUnifiedDiff, diffSummary } from './tools'

export {
  evaluatePermission,
  detectDangerousCommand,
  detectOutsidePathInCommand,
  permissionSignature,
  deniedMessage,
  type PermissionGate,
  type PermissionPolicyContext,
  type PermissionTarget,
  type DangerousCommandInfo
} from './agent'

export { buildSystemPrompt, buildGoalPromptSection, buildPlanModePromptSection } from './agent'
export {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  planCompaction,
  applyCompaction,
  serializeMessagesForSummary,
  hasDanglingToolUse,
  type CompactionPlan
} from './agent'

export type {
  Artifact,
  AskUserAnswer,
  AskUserRequest,
  ChatMessage,
  Goal,
  GoalPatch,
  GoalStatus,
  ModelInfo,
  ModelRef,
  PermissionDecision,
  PermissionMode,
  PermissionPreview,
  PermissionRequest,
  ProviderConfig,
  ProviderKind,
  ProviderTestResult,
  ResultError,
  RunFinishReason,
  RuntimeEvent,
  TodoItem,
  ToolCategory,
  ToolDefinition,
  ToolResult,
  ToolRisk,
  ToolStatus,
  Usage
} from './types'
export type {
  Provider,
  ProviderStreamEvent,
  ProviderStreamRequest,
  RuntimeEventPayload,
  ToolContext,
  SwarmMemberRequest,
  TerminalToolHandler,
  TerminalToolInput,
  TerminalToolResponse
} from './types'
