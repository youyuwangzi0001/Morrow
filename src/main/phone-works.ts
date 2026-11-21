/**
 * 桌面作品库（`StudioProjectSummary` / `StudioDelivery`）→ 手机作品页数据。
 *
 * ## 为什么摘要里带「产物清单」但不带文件
 *
 * 完整 `StudioProject` 包含分镜、章节、时间线与全部素材，动辄几 MB；
 * 手机作品页只展示「做到哪一步、多少字/镜头/更新时间」。成片清单只是
 * 每条几十字节的元数据，放进摘要让作品页能直接列出可预览的成片；
 * **文件本体**由 `works.preview` 按需取，且受 4 MiB 上限约束
 * （中继单帧上限 8 MiB，base64 膨胀 4/3，留足余量）。
 */
import type { StudioDelivery, StudioProjectSummary } from '../shared/studio'

/** 手机端产物：只有元数据，没有文件内容。 */
export interface PhoneWorkProduct {
  id: string
  label: string
  /** `StudioDelivery['kind']`：mp4/comic/pdf/png/... */
  kind: string
  bytes: number
  createdAtMillis: number
}

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
  /** 成片/成书/工程包清单（新的在前），手机据此显示可预览行 */
  products: PhoneWorkProduct[]
}

const MAX_WORKS = 40

/**
 * 手机一次能安全取回的预览字节数。
 *
 * 中继单帧上限 8 MiB（桌面 `maxPayload` / 手机 `MAX_MESSAGE_BYTES` 对齐），
 * base64 后膨胀 4/3，4 MiB 原文 ≈ 5.3 MiB 帧，仍在限内。
 */
export const MAX_PHONE_PREVIEW_BYTES = 4 * 1024 * 1024

/** `works.preview` 的回包：要么带 base64，要么明确告诉手机「太大」。 */
export type PhoneDeliveryPreview =
  | { tooLarge: true; bytes: number; mime: string; label: string; kind: string }
  | { tooLarge: false; bytes: number; mime: string; label: string; kind: string; dataBase64: string }

/** 交付类型 → MIME。手机按它决定用哪种预览器。 */
export function deliveryMime(kind: string): string {
  switch (kind) {
    case 'png':
      return 'image/png'
    case 'cover':
      return 'image/jpeg'
    case 'pdf':
      return 'application/pdf'
    case 'mp4':
      return 'video/mp4'
    case 'mov':
      return 'video/quicktime'
    case 'mkv':
      return 'video/x-matroska'
    case 'webm':
      return 'video/webm'
    case 'wav':
      return 'audio/wav'
    case 'mp3':
      return 'audio/mpeg'
    case 'm4a':
      return 'audio/mp4'
    case 'flac':
      return 'audio/flac'
    case 'srt':
      return 'application/x-subrip'
    case 'ass':
      return 'text/x-ssa'
    case 'epub':
      return 'application/epub+zip'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'txt':
      return 'text/plain; charset=utf-8'
    case 'md':
      return 'text/markdown; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

/** 产物清单：按创建时间倒序，字段改成手机直白命名。 */
export function phoneProducts(deliveries: StudioDelivery[]): PhoneWorkProduct[] {
  return [...deliveries]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((delivery) => ({
      id: delivery.id,
      label: delivery.label || delivery.kind,
      kind: delivery.kind,
      bytes: Number.isFinite(delivery.bytes) ? Math.max(0, Math.round(delivery.bytes)) : 0,
      createdAtMillis: delivery.createdAt
    }))
}

/**
 * 按最近更新倒序；最多 40 个（手机是旁观端，不是归档器）。
 *
 * `productsFor` 允许调用方按需读每个工程的产物清单；纯函数测试传默认值
 * 即得到空清单，不会因为「没有产物」把作品本身丢掉。
 */
export function phoneWorks(
  projects: StudioProjectSummary[],
  productsFor: (projectId: string) => PhoneWorkProduct[] = () => []
): PhoneWork[] {
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
      words: project.words,
      products: productsFor(project.id)
    }))
}