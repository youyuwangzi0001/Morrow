/**
 * 桌面作品库（`StudioProjectSummary`）→ 手机作品页数据。
 *
 * ## 为什么只传摘要
 *
 * 完整 `StudioProject` 包含分镜、章节、时间线与全部素材，动辄几 MB；
 * 手机作品页只展示「做到哪一步、多少字/镜头、更新时间」。成片预览
 * 属于后续能力，届时应按需下载而不是塞进状态帧。
 *
 * 字段名对手机用 `updatedAtMillis` / `stage` / `progress` 这些直白名字，
 * 避免把桌面的 `updatedAt`/`StudioStageId` 类型直接泄漏到 Kotlin 侧。
 */
import type { StudioProjectSummary } from '../shared/studio'

export interface PhoneWork {
  id: string
  title: string
  /** 'short' | 'novel' | 'drama'（与手机 StudioKind 对齐） */
  kind: string
  logline: string
  updatedAtMillis: number
  /** 当前阶段 id（blueprint/outline/...，手机按 StageCatalog 查名字） */
  stage: string
  /** 当前阶段完成度 0–100 */
  progress: number
  chapters: number
  shots: number
  assets: number
  words: number
}

const MAX_WORKS = 40

/** 按最近更新倒序；最多 40 个（手机是旁观端，不是归档器）。 */
export function phoneWorks(projects: StudioProjectSummary[]): PhoneWork[] {
  return [...projects]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_WORKS)
    .map((project) => ({
      id: project.id,
      title: project.title,
      kind: project.kind,
      logline: project.logline,
      updatedAtMillis: project.updatedAt,
      stage: project.stage,
      progress: Number.isFinite(project.progress) ? Math.max(0, Math.min(100, Math.round(project.progress))) : 0,
      chapters: project.chapters,
      shots: project.shots,
      assets: project.assets,
      words: project.words
    }))
}