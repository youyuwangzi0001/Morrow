import type { StudioStageId } from './studio'

export interface AssistantContextState {
  view: string
  focusedStage: StudioStageId | null
  selectedClipId: string | null
  selectedChapterId: string | null
  selectedShotId: string | null
}

export interface AssistantContext {
  view: string
  selection?: { kind: 'chapter' | 'shot' | 'clip'; id: string }
}

/** 协作者必须知道用户此刻在哪一步；只带当前步骤真正可用的选中项，避免旧选中项串台。 */
export function assistantContextFor(state: AssistantContextState): AssistantContext {
  const view = state.focusedStage ?? state.view
  const stage = state.focusedStage
  if (stage === 'blueprint') return { view }
  if (stage === 'outline' || stage === 'writing') {
    return state.selectedChapterId ? { view, selection: { kind: 'chapter', id: state.selectedChapterId } } : { view }
  }
  if (stage === 'storyboard' || stage === 'visuals') {
    return state.selectedShotId ? { view, selection: { kind: 'shot', id: state.selectedShotId } } : { view }
  }
  if (stage === 'voice' || stage === 'music' || stage === 'timeline') {
    if (state.selectedClipId) return { view, selection: { kind: 'clip', id: state.selectedClipId } }
    return state.selectedShotId ? { view, selection: { kind: 'shot', id: state.selectedShotId } } : { view }
  }
  if (stage === 'review' || stage === 'delivery') {
    if (state.selectedClipId) return { view, selection: { kind: 'clip', id: state.selectedClipId } }
    if (state.selectedChapterId) return { view, selection: { kind: 'chapter', id: state.selectedChapterId } }
    return state.selectedShotId ? { view, selection: { kind: 'shot', id: state.selectedShotId } } : { view }
  }
  if (state.view === 'timeline' && state.selectedClipId) return { view, selection: { kind: 'clip', id: state.selectedClipId } }
  if (state.view === 'writing' && state.selectedChapterId) return { view, selection: { kind: 'chapter', id: state.selectedChapterId } }
  if (state.view === 'storyboard' && state.selectedShotId) return { view, selection: { kind: 'shot', id: state.selectedShotId } }
  return { view }
}
