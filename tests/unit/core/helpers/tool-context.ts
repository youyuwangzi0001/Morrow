/**
 * 测试辅助：构造 ToolContext（文档类工具测试用）。
 * 与 tools.test.ts 里的 makeCtx 保持一致；单独抽出来供新测试复用，不改旧测试。
 */
import type { Artifact, SessionPlan, TodoItem } from '../../../../src/shared/types'
import type { ToolContext } from '../../../../src/core/types'
import type { TempWorkspace } from './workspace'

export interface ToolContextState {
  todos: TodoItem[]
  artifacts: Artifact[]
  progressNotes: string[]
}

export function makeToolContext(
  ws: TempWorkspace,
  overrides: Partial<ToolContext> = {},
  state: ToolContextState = { todos: [], artifacts: [], progressNotes: [] }
): ToolContext {
  let plan: SessionPlan | null = null
  return {
    sessionId: 'session_docs',
    runId: 'run_docs',
    messageId: 'msg_docs',
    toolUseId: 'call_docs',
    workspace: ws.root,
    permissionMode: 'auto',
    snapshotDir: ws.snapshotDir,
    signal: new AbortController().signal,
    depth: 0,
    readOnly: false,
    escapeApproved: false,
    demo: false,
    goal: null,
    planMode: false,
    getPlan: () => plan,
    proposePlan: (next) => {
      plan = next
      return next
    },
    emit: () => undefined,
    updateGoal: () => null,
    getTodos: () => state.todos,
    setTodos: (todos) => {
      state.todos = todos
    },
    getArtifacts: () => state.artifacts,
    addArtifact: (artifact) => {
      state.artifacts.push(artifact)
    },
    askUser: async () => ({ value: 'A', label: '方案 A' }),
    progress: (note) => {
      state.progressNotes.push(note)
    },
    runSwarmMember: async () => ({ status: 'completed', summary: '集群成员已完成', steps: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    ...overrides
  }
}
