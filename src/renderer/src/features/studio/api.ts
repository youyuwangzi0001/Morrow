import type { Result } from '@shared/types'
import type {
  StudioActionResult,
  StudioCreateInput,
  StudioEditPlan,
  StudioDataDirChangeResult,
  StudioDataDirInfo,
  StudioEngineStatus,
  StudioEvent,
  StudioExportInput,
  StudioJob,
  StudioListResult,
  StudioProject,
  StudioRenderInput
} from '@shared/studio'

type FeatureResult<T> = Result<T>

const invoke = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
  const response = (await window.morrow.features.invoke<T>('feature:studio:action', { type, ...payload })) as FeatureResult<T>
  if (!response.ok) throw new Error(response.error?.message || '操作失败。')
  return response.data as T
}

export const studioApi = {
  list(): Promise<StudioListResult> {
    return invoke<StudioListResult>('list')
  },
  status(): Promise<StudioEngineStatus> {
    return invoke<StudioEngineStatus>('status')
  },
  get(projectId: string): Promise<StudioActionResult> {
    return invoke<StudioActionResult>('get', { projectId })
  },
  create(input: StudioCreateInput): Promise<StudioActionResult> {
    return invoke<StudioActionResult>('create', input as unknown as Record<string, unknown>)
  },
  action<T = StudioActionResult>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    return invoke<T>(type, payload)
  },
  assistant(input: { projectId: string; text: string; selection?: { kind: 'chapter' | 'shot' | 'clip'; id: string } }): Promise<StudioActionResult & { plan: StudioEditPlan }> {
    return invoke<StudioActionResult & { plan: StudioEditPlan }>('assistant', input as unknown as Record<string, unknown>)
  },
  render(input: StudioRenderInput): Promise<StudioActionResult> {
    return invoke<StudioActionResult>('render', input as unknown as Record<string, unknown>)
  },
  exportProject(input: StudioExportInput): Promise<StudioActionResult> {
    return invoke<StudioActionResult>('export', input as unknown as Record<string, unknown>)
  },
  async pickImport(kind: 'image' | 'video' | 'audio' = 'image', options: { multiple?: boolean; title?: string } = {}): Promise<string[]> {
    const response = (await window.morrow.features.invoke<string[]>('feature:studio:pick-import', {
      kind,
      ...options
    })) as FeatureResult<string[]>
    if (!response.ok) throw new Error(response.error?.message || '无法打开文件选择器。')
    return response.data ?? []
  },
  async pickPackage(): Promise<string[]> {
    const response = (await window.morrow.features.invoke<string[]>('feature:studio:pick-package', {})) as FeatureResult<string[]>
    if (!response.ok) throw new Error(response.error?.message || '无法打开文件选择器。')
    return response.data ?? []
  },
  async reveal(projectId: string, path: string): Promise<void> {
    const response = (await window.morrow.features.invoke<boolean>('feature:studio:reveal', { projectId, path })) as FeatureResult<boolean>
    if (!response.ok) throw new Error(response.error?.message || '无法在文件夹中显示。')
  },
  async openPath(projectId: string, path: string): Promise<void> {
    const response = (await window.morrow.features.invoke<boolean>('feature:studio:open-path', { projectId, path })) as FeatureResult<boolean>
    if (!response.ok) throw new Error(response.error?.message || '无法打开文件。')
  },
  async dataDirInfo(): Promise<StudioDataDirInfo> {
    const response = (await window.morrow.features.invoke<StudioDataDirInfo>('feature:studio:data-dir-info', {})) as FeatureResult<StudioDataDirInfo>
    if (!response.ok) throw new Error(response.error?.message || '无法读取创作台数据目录。')
    return response.data
  },
  async changeDataDir(): Promise<StudioDataDirChangeResult> {
    const response = (await window.morrow.features.invoke<StudioDataDirChangeResult>('feature:studio:change-data-dir', {})) as FeatureResult<StudioDataDirChangeResult>
    if (!response.ok) throw new Error(response.error?.message || '无法更换创作台数据目录。')
    return response.data
  },
  async resetDataDir(): Promise<StudioDataDirChangeResult> {
    const response = (await window.morrow.features.invoke<StudioDataDirChangeResult>('feature:studio:reset-data-dir', {})) as FeatureResult<StudioDataDirChangeResult>
    if (!response.ok) throw new Error(response.error?.message || '无法恢复默认创作台数据目录。')
    return response.data
  },
  async openDataDir(): Promise<void> {
    const response = (await window.morrow.features.invoke<boolean>('feature:studio:open-data-dir', {})) as FeatureResult<boolean>
    if (!response.ok) throw new Error(response.error?.message || '无法打开作品目录。')
  },
  async openProjectDir(projectId: string): Promise<void> {
    const response = (await window.morrow.features.invoke<boolean>('feature:studio:open-project-dir', { projectId })) as FeatureResult<boolean>
    if (!response.ok) throw new Error(response.error?.message || '无法打开当前作品文件夹。')
  },
  onEvent(listener: (event: StudioEvent) => void): () => void {
    return window.morrow.features.on('feature:studio:event', (payload) => {
      if (!payload || typeof payload !== 'object') return
      const event = payload as StudioEvent
      if (event.type === 'job' || event.type === 'project') listener(event)
    })
  }
}

export function isJobActive(job: StudioJob): boolean {
  return job.status === 'queued' || job.status === 'running'
}

export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

export function shortHash(hash: string): string {
  return hash.slice(0, 10)
}

export function assetById(project: StudioProject, id: string | null | undefined) {
  return id ? project.assets.find((asset) => asset.id === id) : undefined
}
