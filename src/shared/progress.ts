// 进展浮窗的数据整理：来源与产出文件都从真实会话数据推导，不另造状态。
import type { ArtifactKind, Session, WebSearchSource } from '@shared/types'

export interface SessionSource extends WebSearchSource {
  query: string
  provider: string
}

export interface SourceGroup {
  query: string
  provider: string
  sources: SessionSource[]
}

export interface OutputFile {
  key: string
  title: string
  /** 工作区内的展示路径（相对或绝对） */
  path?: string
  /** 可定位的绝对路径；没有时点击不执行定位 */
  absolutePath?: string
  kind: 'artifact' | 'file'
  artifactId?: string
  artifactKind?: ArtifactKind
  at: number
}

/** 会产出文件的工具；只统计成功执行，避免把失败写入算成交付。 */
const OUTPUT_TOOLS = new Set(['write_file', 'edit_file', 'write_xlsx', 'edit_docx', 'edit_media'])

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function inputString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function basename(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return url
  }
}

/**
 * 汇总本会话所有 web_search 结果，按「查询 + 提供商」分组。
 * 同一 URL 只保留第一次出现，避免多次搜索把同一来源重复列出。
 */
export function collectSourceGroups(session: Session | null): SourceGroup[] {
  if (!session) return []
  const seen = new Set<string>()
  const groups = new Map<string, SourceGroup>()
  for (const message of session.messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== 'web_search' || block.status !== 'success') continue
      const meta = block.result?.meta
      if (!meta || !Array.isArray(meta.sources)) continue
      const query = typeof meta.query === 'string' ? meta.query : ''
      const provider = typeof meta.provider === 'string' ? meta.provider : ''
      const key = `${provider}\u0000${query}`
      let group = groups.get(key)
      if (!group) {
        group = { query, provider, sources: [] }
        groups.set(key, group)
      }
      for (const raw of meta.sources as Array<Record<string, unknown>>) {
        const url = typeof raw.url === 'string' ? raw.url : ''
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
        seen.add(url)
        group.sources.push({
          rank: typeof raw.rank === 'number' ? raw.rank : group.sources.length + 1,
          title: typeof raw.title === 'string' ? raw.title : url,
          url,
          snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
          ...(typeof raw.publishedAt === 'string' ? { publishedAt: raw.publishedAt } : {}),
          ...(typeof raw.engine === 'string' ? { engine: raw.engine } : {}),
          query,
          provider
        })
      }
    }
  }
  return [...groups.values()].filter((group) => group.sources.length > 0)
}

/**
 * 产出文件 = 会话成果（artifacts）+ 成功写入过的文件。
 * 同一路径只保留一条；成果优先，因为它带有可打开的画布 id。
 */
export function collectOutputFiles(session: Session | null, limit = 12): OutputFile[] {
  if (!session) return []
  const files = new Map<string, OutputFile>()

  for (const message of session.messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_use' || !OUTPUT_TOOLS.has(block.name) || block.status !== 'success') continue
      const meta = block.result?.meta
      const displayPath =
        metaString(meta, 'path') ?? inputString(block.input, 'path') ?? inputString(block.input, 'output_path')
      const absolutePath = metaString(meta, 'absolutePath')
      const key = (absolutePath ?? displayPath ?? '').toLowerCase()
      if (!key) continue
      const at = block.finishedAt ?? block.startedAt ?? message.createdAt
      const existing = files.get(key)
      if (existing && existing.at >= at) continue
      files.set(key, {
        key,
        title: basename(displayPath ?? absolutePath ?? ''),
        ...(displayPath ? { path: displayPath } : {}),
        ...(absolutePath ? { absolutePath } : {}),
        kind: 'file',
        at
      })
    }
  }

  for (const artifact of session.artifacts) {
    const key = (artifact.path ?? artifact.id).toLowerCase()
    files.set(key, {
      key,
      title: artifact.title,
      ...(artifact.path ? { path: artifact.path, absolutePath: artifact.path } : {}),
      kind: 'artifact',
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      at: artifact.updatedAt
    })
  }

  return [...files.values()].sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit))
}