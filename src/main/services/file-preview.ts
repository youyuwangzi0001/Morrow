/**
 * 本地文件预览：安全的令牌 URL + Range 流式响应。
 *
 * 渲染层永远拿不到任意 file:// 访问能力；预览 URL 只由主进程在校验工作区路径后签发，
 * 令牌只映射到一个已确认的绝对路径，并按需支持图片/音频/视频/PDF 的 Range 请求。
 */
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import type { FilePreviewKind, FilePreviewMeta } from '../../shared/file-types'
import {
  ARCHIVE_PREVIEW_MAX_BYTES,
  DOCX_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_MAX_BYTES,
  PDF_PREVIEW_MAX_BYTES,
  binaryPreviewKindForFileName,
  isLegacyOfficeFileName,
  isTextFileName,
  mimeTypeForFileName
} from '../../shared/file-types'
import { formatBytes } from '../../shared/usage'
import { statWorkspaceFile } from './workspace-files'

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000
const MAX_TOKENS = 1000
const PREVIEW_ORIGIN = 'morrow-file://preview'
const IMAGE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024

interface PreviewEntry {
  workspace: string
  filePath: string
  mime: string
  expiresAt: number
}

const previewTokens = new Map<string, PreviewEntry>()

function pruneExpired(now = Date.now()): void {
  for (const [token, entry] of previewTokens) {
    if (entry.expiresAt <= now) previewTokens.delete(token)
  }
}

export function createPreviewUrl(workspace: string, filePath: string, mime: string): string {
  pruneExpired()
  while (previewTokens.size >= MAX_TOKENS) {
    const oldest = previewTokens.keys().next().value
    if (!oldest) break
    previewTokens.delete(oldest)
  }
  const token = randomBytes(18).toString('base64url')
  previewTokens.set(token, { workspace, filePath, mime, expiresAt: Date.now() + TOKEN_TTL_MS })
  return `${PREVIEW_ORIGIN}/${token}`
}

export function resolvePreviewToken(token: string): PreviewEntry | null {
  const entry = previewTokens.get(token)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    previewTokens.delete(token)
    return null
  }
  return entry
}

export function resetPreviewTokensForTest(): void {
  previewTokens.clear()
}

export function describeFilePreview(workspace: string, inputPath: string): FilePreviewMeta {
  const stat = statWorkspaceFile(workspace, inputPath)
  if (stat.kind !== 'file') throw new Error('这是一个文件夹，不能预览。')

  const name = basename(stat.absolutePath)
  const detected = binaryPreviewKindForFileName(name)
  let kind: FilePreviewKind = detected ?? 'unsupported'
  let note: string | undefined

  if (kind === 'image' && stat.size > IMAGE_PREVIEW_MAX_BYTES) {
    kind = 'unsupported'
    note = `图片有 ${formatBytes(stat.size)}，超过 ${formatBytes(IMAGE_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
  } else if (kind === 'pdf' && stat.size > PDF_PREVIEW_MAX_BYTES) {
    kind = 'unsupported'
    note = `PDF 有 ${formatBytes(stat.size)}，超过 ${formatBytes(PDF_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
  } else if (kind === 'docx' && stat.size > DOCX_PREVIEW_MAX_BYTES) {
    kind = 'unsupported'
    note = `Word 文档有 ${formatBytes(stat.size)}，超过 ${formatBytes(DOCX_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
  } else if ((kind === 'xlsx' || kind === 'pptx' || kind === 'document') && stat.size > OFFICE_PREVIEW_MAX_BYTES) {
    const label = kind === 'xlsx' ? 'Excel 表格' : kind === 'pptx' ? 'PowerPoint 演示文稿' : '文档'
    kind = 'unsupported'
    note = `${label}有 ${formatBytes(stat.size)}，超过 ${formatBytes(OFFICE_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
  } else if (kind === 'archive' && stat.size > ARCHIVE_PREVIEW_MAX_BYTES) {
    kind = 'unsupported'
    note = `压缩包有 ${formatBytes(stat.size)}，超过 ${formatBytes(ARCHIVE_PREVIEW_MAX_BYTES)} 的列表上限。请用系统应用打开。`
  } else if (kind === 'unsupported') {
    if (isTextFileName(name)) {
      note = '文本文件请用编辑器打开。'
    } else if (isLegacyOfficeFileName(name)) {
      note = '旧版 Office 二进制格式（.doc/.xls/.ppt）无法内联解析；请用系统应用打开，或另存为 docx/xlsx/pptx。'
    } else if (/^(?:7z|rar|tar|gz|bz2|xz|tgz)$/i.test(name.split('.').pop() ?? '')) {
      note = '这种压缩格式暂不支持在线列表；请用系统应用打开。ZIP/JAR 可直接预览。'
    } else if (/^\.(?:psd|ai|sketch|fig|dwg|indd|epub)$/i.test(name)) {
      note = '这种专业设计/电子书格式暂不支持在线预览；请用系统应用打开。'
    } else {
      note = '这种文件格式暂不支持在 Morrow 内预览，可以用系统应用打开。'
    }
  }

  const mime = mimeTypeForFileName(name)
  const url =
    mime && (kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video')
      ? createPreviewUrl(workspace, stat.absolutePath, mime)
      : undefined

  return {
    path: stat.path,
    absolutePath: stat.absolutePath,
    kind,
    mime,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ...(url ? { url } : {}),
    ...(note ? { note } : {})
  }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Cross-Origin-Resource-Policy': 'cross-origin'
}

function errorResponse(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: {
      ...CORS_HEADERS,
      ...extra,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

interface ByteRange {
  start: number
  end: number
}

function parseRange(value: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null
  let start: number
  let end: number
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
    if (start < 0 || start >= size || end < start) return null
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

export async function handlePreviewProtocol(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, '只允许读取预览文件。', { Allow: 'GET, HEAD, OPTIONS' })
  }

  let parsed: URL
  try {
    parsed = new URL(request.url)
  } catch {
    return errorResponse(400, '预览地址不合法。')
  }
  if (parsed.protocol !== 'morrow-file:' || parsed.hostname !== 'preview') {
    return errorResponse(404, '预览不存在。')
  }
  const token = parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
  const entry = resolvePreviewToken(token)
  if (!entry) return errorResponse(404, '预览链接已过期，请重新打开文件。')

  let stat
  try {
    // 每次请求都重新校验工作区边界，防止令牌签发后文件被替换为指向外部的链接。
    stat = statWorkspaceFile(entry.workspace, entry.filePath)
  } catch {
    return errorResponse(404, '文件已经不存在或不再允许预览。')
  }
  if (stat.kind !== 'file') return errorResponse(404, '这不是一个可预览的文件。')
  const filePath = stat.absolutePath

  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    'Content-Type': entry.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }

  const rangeHeader = request.headers.get('range')
  if (!rangeHeader) {
    headers['Content-Length'] = String(stat.size)
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    const stream = createReadStream(filePath)
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers })
  }

  const range = parseRange(rangeHeader, stat.size)
  if (!range) {
    return errorResponse(416, '请求的文件范围不合法。', { 'Content-Range': `bytes */${stat.size}` })
  }
  const length = range.end - range.start + 1
  headers['Content-Length'] = String(length)
  headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
  if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
  const stream = createReadStream(filePath, { start: range.start, end: range.end })
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 206, headers })
}
