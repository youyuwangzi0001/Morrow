/** 发送给模型的单张图片上限（压缩/缩放后）；主流视觉接口都按此量级限制。 */
export const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** 单条用户消息里所有图片的合计上限，避免一次请求塞入几十 MB 视觉输入 */
export const ATTACHMENT_TOTAL_IMAGE_MAX_BYTES = 20 * 1024 * 1024
/** 允许读取并交给渲染层缩放的原始图片上限；超过则只保留元数据。 */
export const ATTACHMENT_IMAGE_SOURCE_MAX_BYTES = 24 * 1024 * 1024
export const ATTACHMENT_TEXT_MAX_BYTES = 512 * 1024
export const ATTACHMENT_TEXT_MAX_CHARS = 120_000
/** 单条用户消息里所有文本附件的合计上限（含多个附件时从前往后分配） */
export const ATTACHMENT_TOTAL_TEXT_MAX_CHARS = 80_000
export const ATTACHMENT_MAX_COUNT = 8

/** 文本编辑器/预览单次最多读入的字节数；超过时只读展示开头并标记截断。 */
export const TEXT_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
export const PDF_PREVIEW_MAX_BYTES = 200 * 1024 * 1024
export const DOCX_PREVIEW_MAX_BYTES = 50 * 1024 * 1024
/** XLSX/PPTX/ODF/EPUB/RTF 内联转换上限 */
export const OFFICE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024
/** ZIP/JAR 列表上限（不解压，仅读中央目录） */
export const ARCHIVE_PREVIEW_MAX_BYTES = 100 * 1024 * 1024

export type FilePreviewKind =
  | 'image'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'document'
  | 'archive'
  | 'audio'
  | 'video'
  | 'unsupported'

export interface FilePreviewMeta {
  path: string
  absolutePath: string
  kind: FilePreviewKind
  mime: string | null
  size: number
  mtimeMs: number
  /** 媒体/PDF 的带权限令牌地址；Office/文档/压缩包没有 */
  url?: string
  note?: string
}

/* ── 文档预览数据（主进程转换 → 渲染层展示） ─────────────────── */

export interface XlsxSheetPreview {
  name: string
  rows: string[][]
  truncated: boolean
}

export interface XlsxPreviewResult {
  sheets: XlsxSheetPreview[]
  warnings: string[]
  size: number
  mtimeMs: number
}

export interface PptxSlidePreview {
  index: number
  title: string
  lines: string[]
}

export interface PptxPreviewResult {
  slides: PptxSlidePreview[]
  warnings: string[]
  size: number
  mtimeMs: number
}

export interface DocumentPreviewResult {
  html: string
  format: string
  warnings: string[]
  size: number
  mtimeMs: number
}

export interface ArchiveEntryPreview {
  name: string
  dir: boolean
  size: number
  compressedSize: number
  date: string | null
}

export interface ArchivePreviewResult {
  entries: ArchiveEntryPreview[]
  total: number
  truncated: boolean
  size: number
  mtimeMs: number
}

/** 可作为聊天图片附件（视觉模型 + Canvas 可稳定解码）的格式 */
const ATTACHMENT_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])

/** 文件预览可尝试渲染的图片格式；解码失败时 UI 会降级为系统应用打开 */
const PREVIEW_IMAGE_EXTENSIONS = new Set([
  ...ATTACHMENT_IMAGE_EXTENSIONS,
  'jfif', 'apng', 'svg', 'ico', 'avif', 'tif', 'tiff', 'heic', 'heif'
])

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'm4b', 'aac', 'flac', 'opus',
  'aif', 'aiff', 'aifc', 'amr', 'wma'
])

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi',
  'mpg', 'mpeg', '3gp', '3g2', 'wmv', 'flv', 'ts', 'm2ts'
])

const XLSX_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xltx', 'xltm'])

const PPTX_EXTENSIONS = new Set(['pptx', 'pptm', 'ppsx', 'potx'])

const DOCUMENT_EXTENSIONS = new Set(['rtf', 'odt', 'ods', 'odp', 'epub'])

const ARCHIVE_EXTENSIONS = new Set(['zip', 'jar', 'whl', 'vsix'])

const TABLE_EXTENSIONS = new Set(['csv', 'tsv'])

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  jar: 'application/java-archive',
  whl: 'application/zip',
  vsix: 'application/zip',
  jfif: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  ico: 'image/x-icon',
  apng: 'image/apng',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  aifc: 'audio/aiff',
  m4b: 'audio/mp4',
  amr: 'audio/amr',
  wma: 'audio/x-ms-wma',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  srt: 'text/plain',
  vtt: 'text/vtt',
  ass: 'text/plain',
  ics: 'text/calendar',
  diff: 'text/x-diff',
  patch: 'text/x-diff'
}

const EXTENSIONLESS_TEXT_NAMES = new Set([
  'readme', 'license', 'licence', 'notice', 'copying', 'authors', 'changelog',
  'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile', 'justfile', 'todo'
])

const DOTFILE_TEXT_NAMES = new Set([
  '.env', '.gitignore', '.npmrc', '.editorconfig', '.dockerignore', '.prettierignore', '.eslintignore'
])

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm',
  'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'py', 'rb',
  'go', 'rs', 'java', 'kt', 'kts', 'swift', 'cs', 'php', 'c', 'h', 'cpp', 'hpp', 'cc', 'sql', 'sh', 'ps1',
  'bat', 'cmd', 'toml', 'ini', 'conf', 'properties', 'log', 'svg', 'env', 'r', 'lua', 'pl', 'ex', 'exs',
  'tex', 'srt', 'vtt', 'ass', 'ssa', 'ics', 'diff', 'patch', 'graphql', 'gql', 'proto', 'dart', 'scala',
  'groovy', 'gradle', 'cmake', 'mk', 'lock', 'editorconfig'
])

function baseName(nameOrPath: string): string {
  return nameOrPath.replace(/\\/g, '/').split('/').pop() ?? ''
}

export function fileExtension(nameOrPath: string): string {
  const name = baseName(nameOrPath)
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 聊天附件可用的图片格式（raster） */
export function isImageFileName(nameOrPath: string): boolean {
  return ATTACHMENT_IMAGE_EXTENSIONS.has(fileExtension(nameOrPath))
}

/** 文件预览可尝试的图片格式（包含 SVG/TIFF/HEIC 等） */
export function isPreviewImageFileName(nameOrPath: string): boolean {
  return PREVIEW_IMAGE_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isTextFileName(nameOrPath: string): boolean {
  const name = baseName(nameOrPath).toLowerCase()
  if (name.startsWith('.env')) return true
  if (DOTFILE_TEXT_NAMES.has(name)) return true
  if (!name.includes('.') && EXTENSIONLESS_TEXT_NAMES.has(name)) return true
  return TEXT_EXTENSIONS.has(fileExtension(name))
}

export function imageMediaTypeFor(nameOrPath: string): string | null {
  const ext = fileExtension(nameOrPath)
  if (!ATTACHMENT_IMAGE_EXTENSIONS.has(ext)) return null
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  return `image/${ext}`
}

export function isPdfFileName(nameOrPath: string): boolean {
  return fileExtension(nameOrPath) === 'pdf'
}

export function isDocxFileName(nameOrPath: string): boolean {
  return fileExtension(nameOrPath) === 'docx'
}

export function isAudioFileName(nameOrPath: string): boolean {
  return AUDIO_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isVideoFileName(nameOrPath: string): boolean {
  const ext = fileExtension(nameOrPath)
  // .ts 默认视为 TypeScript 文本；只有 .m2ts 走视频
  if (ext === 'ts') return false
  return VIDEO_EXTENSIONS.has(ext)
}

export function isXlsxFileName(nameOrPath: string): boolean {
  return XLSX_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isPptxFileName(nameOrPath: string): boolean {
  return PPTX_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isDocumentFileName(nameOrPath: string): boolean {
  return DOCUMENT_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isArchiveFileName(nameOrPath: string): boolean {
  return ARCHIVE_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isTableFileName(nameOrPath: string): boolean {
  return TABLE_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isLegacyOfficeFileName(nameOrPath: string): boolean {
  return /^(?:doc|xls|ppt)$/i.test(fileExtension(nameOrPath))
}

export function mimeTypeForFileName(nameOrPath: string): string | null {
  return imageMediaTypeFor(nameOrPath) ?? MIME_BY_EXTENSION[fileExtension(nameOrPath)] ?? null
}

/** 非文本文档的预览类型；文本文件由调用方先判断，不走这里。 */
export function binaryPreviewKindForFileName(nameOrPath: string): FilePreviewKind | null {
  // 文本优先：SVG/CSV/TS 等即使也能被浏览器当图片/视频，仍走可编辑文本路径
  if (isTextFileName(nameOrPath)) return null
  if (isPdfFileName(nameOrPath)) return 'pdf'
  if (isXlsxFileName(nameOrPath)) return 'xlsx'
  if (isPptxFileName(nameOrPath)) return 'pptx'
  if (isDocxFileName(nameOrPath)) return 'docx'
  if (isDocumentFileName(nameOrPath)) return 'document'
  if (isArchiveFileName(nameOrPath)) return 'archive'
  if (isPreviewImageFileName(nameOrPath)) return 'image'
  if (isAudioFileName(nameOrPath)) return 'audio'
  if (isVideoFileName(nameOrPath)) return 'video'
  return null
}

export function previewKindForFileName(nameOrPath: string): FilePreviewKind | 'text' {
  if (isTextFileName(nameOrPath)) return 'text'
  return binaryPreviewKindForFileName(nameOrPath) ?? 'unsupported'
}
