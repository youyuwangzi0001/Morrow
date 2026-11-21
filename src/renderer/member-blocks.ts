/**
 * 成员块归属判定：这条 tool_use 是不是「当前协作成员」发起的那一条。
 *
 * 主对话（`activity.tsx`）与协作看板（`superagent.tsx`）都要用同一判定，
 * 放进任一侧都会让另一侧反向依赖整页组件。判定只读 `SuperAgentState`，
 * 不碰 React，所以单独成文件成本最低。
 */
import type { SuperAgentState, ToolUseBlock } from '@shared/types'

export function isCurrentMemberBlock(state: SuperAgentState | null, block: ToolUseBlock): boolean {
  if (!state) return false
  if (state.toolUseId) return state.toolUseId === block.id
  if (block.status === 'running' || block.status === 'waiting') {
    return state.createdAt >= (block.startedAt ?? 0) - 2000
  }
  const meta = block.result?.meta
  const snapshot =
    meta && typeof meta.superAgent === 'object' && meta.superAgent
      ? (meta.superAgent as SuperAgentState)
      : null
  if (!snapshot) return false
  return snapshot.runId === state.runId ||
    (Boolean(snapshot.projectId) &&
      snapshot.projectId === state.projectId &&
      snapshot.createdAt === state.createdAt)
}
