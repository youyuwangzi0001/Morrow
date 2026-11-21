/**
 * 把界面状态折算成「协作者该知道的最小上下文」。
 *
 * ## 为什么按阶段分别判断，而不是「有什么给什么」
 *
 * 用户在不同阶段能做的事不同：写大纲时选中一章是有意义的，配音阶段选中
 * 那一章就没意义了 —— 而界面上往往还留着上次的选中项。若一律把 `selected*`
 * 全带上，协作者会以为用户此刻在编辑那一章，于是回答偏向错误的对象。
 *
 * 所以每个阶段只暴露**当前步骤真正可用**的那一种选中项，其余一律丢掉。
 * 这也是「旧选中项串台」的直接解法：不是清理状态，而是不给它出口。
 *
 * ## 同类里取最具体的那个
 *
 * 音轨 / 复核 / 交付阶段可能同时有镜头与片段选中。片段比镜头具体
 * （一个镜头可以拆成多个片段），所以优先报片段。
 */
import type { StudioStageId } from './studio'

export interface AssistantContextState {
  /** 当前路由（`timeline` / `writing` / ...）。 */
  view: string
  /** 用户手动聚焦的阶段；null 表示跟随 `view`。 */
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
