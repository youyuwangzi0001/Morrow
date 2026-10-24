/**
 * 常见文档的只读预览转换（P0 文件预览扩展）：
 * - XLSX/XLSM：OOXML → 工作表二维表格（限制行列数）
 * - PPTX/PPTM：幻灯片 XML → 标题 + 文本行
 * - RTF / ODT / ODS / ODP / EPUB：提取可读内容并转成安全 HTML（只输出转义文本）
 * - ZIP/JAR/WHL/VSIX：读取中央目录列出文件，不解压写盘
 *
 * 所有内容都在主进程按工作区边界读取；输出有硬上限，避免超大文件拖垮渲染层。
 */
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import {
  ARCHIVE_PREVIEW_MAX_BYTES,
  DOCX_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_MAX_BYTES,
  type ArchiveEntryPreview,
  type ArchivePreviewResult,
  type DocumentPreviewResult,
  type PptxPreviewResult,
  type PptxSlidePreview,
  type XlsxPreviewResult,
  type XlsxSheetPreview
} from '../../shared/file-types'
import { formatBytes } from '../../shared/usage'
import { statWorkspaceFile } from './workspace-files'

const MAX_XML_TEXT_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT_HTML_BYTES = 6 * 1024 * 1024
const MAX_SHEETS = 10
const MAX_ROWS = 200
const MAX_COLS = 30
const MAX_CELL_CHARS = 400
const MAX_SLIDES = 80
const MAX_LINES_PER_SLIDE = 40
const MAX_DOC_PARAGRAPHS = 3000
const MAX_ARCHIVE_ENTRIES = 2000

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

function stripTags(xml: string): string {
  return decodeXml(xml.replace(/<[^>]*>/g, ''))
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const regex = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (let match = regex.exec(tag); match; match = regex.exec(tag)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '')
  }
  return attributes
}

function assertFile(workspace: string, inputPath: string, extensions: string[]): {
  absolutePath: string
  size: number
  mtimeMs: number
  name: string
} {
  const stat = statWorkspaceFile(workspace, inputPath)
  if (stat.kind !== 'file') throw new Error('这是一个文件夹，不能预览。')
  const ext = extname(stat.absolutePath).slice(1).toLowerCase()
  if (!extensions.includes(ext)) {
    throw new Error(`不支持的文件类型：.${ext || '未知'}。`)
  }
  if (stat.size > OFFICE_PREVIEW_MAX_BYTES) {
    throw new Error(
      `文件有 ${formatBytes(stat.size)}，超过 ${formatBytes(OFFICE_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
    )
  }
  return {
    absolutePath: stat.absolutePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    name: basename(stat.absolutePath)
  }
}

async function loadZip(absolutePath: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(readFileSync(absolutePath))
  } catch {
    throw new Error('文件不是有效的 ZIP/OOXML 包，可能已损坏。')
  }
}

async function readZipText(zip: JSZip, entry: string): Promise<string | null> {
  const file = zip.file(entry)
  if (!file) return null
  const text = await file.async('string')
  return text.length > MAX_XML_TEXT_BYTES ? text.slice(0, MAX_XML_TEXT_BYTES) : text
}

/* ── XLSX ─────────────────────────────────────────────────────── */

function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/i.exec(ref)?.[1] ?? ''
  let index = 0
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64)
  return Math.max(0, index - 1)
}

function normalizeZipTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  if (target.startsWith('xl/')) return target
  return `xl/${target.replace(/^\.\//, '')}`
}

async function parseSheetRows(xml: string, shared: string[]): Promise<{ rows: string[][]; truncated: boolean }> {
  const rows: string[][] = []
  let truncated = false
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  for (let rowMatch = rowRegex.exec(xml); rowMatch; rowMatch = rowRegex.exec(xml)) {
    if (rows.length >= MAX_ROWS) {
      truncated = true
      break
    }
    const cells: string[] = []
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    for (let cellMatch = cellRegex.exec(rowMatch[1]); cellMatch; cellMatch = cellRegex.exec(rowMatch[1])) {
      const attrs = parseAttributes(cellMatch[1])
      const body = cellMatch[2] ?? ''
      const col = attrs.r ? columnIndex(attrs.r) : cells.length
      if (col >= MAX_COLS) {
        truncated = true
        continue
      }
      while (cells.length < col) cells.push('')
      const type = attrs.t ?? ''
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''
      let text = ''
      if (type === 's') {
        text = shared[Number(value)] ?? ''
      } else if (type === 'inlineStr') {
        text = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1])).join('')
      } else if (type === 'b') {
        text = value === '1' ? 'TRUE' : 'FALSE'
      } else if (type === 'e') {
        text = '#ERROR'
      } else {
        text = decodeXml(value)
      }
      text = text.replace(/\r\n/g, '\n').slice(0, MAX_CELL_CHARS)
      if (cells.length > MAX_COLS) {
        truncated = true
        break
      }
      cells[col] = text
    }
    rows.push(cells)
  }
  return { rows, truncated }
}

export async function convertXlsxToPreview(workspace: string, inputPath: string): Promise<XlsxPreviewResult> {
  const file = assertFile(workspace, inputPath, ['xlsx', 'xlsm', 'xltx', 'xltm'])
  const zip = await loadZip(file.absolutePath)
  const workbook = (await readZipText(zip, 'xl/workbook.xml')) ?? ''
  const relsXml = (await readZipText(zip, 'xl/_rels/workbook.xml.rels')) ?? ''
  const rels = new Map<string, string>()
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const attrs = parseAttributes(match[0])
    if (attrs.Id && attrs.Target) rels.set(attrs.Id, normalizeZipTarget(attrs.Target.replace(/\\/g, '/')))
  }
  const sheetDefs: Array<{ name: string; target: string }> = []
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const attrs = parseAttributes(match[0])
    if (!attrs.name) continue
    const rid = attrs['r:id'] ?? attrs.id ?? ''
    const target = rels.get(rid) ?? `xl/worksheets/sheet${sheetDefs.length + 1}.xml`
    sheetDefs.push({ name: attrs.name, target })
  }
  if (sheetDefs.length === 0) sheetDefs.push({ name: 'Sheet1', target: 'xl/worksheets/sheet1.xml' })

  const sharedXml = (await readZipText(zip, 'xl/sharedStrings.xml')) ?? ''
  const shared: string[] = []
  for (const match of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push([...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1])).join(''))
    if (shared.length > 20_000) break
  }

  const warnings: string[] = []
  const sheets: XlsxSheetPreview[] = []
  for (const definition of sheetDefs.slice(0, MAX_SHEETS)) {
    const xml = await readZipText(zip, definition.target)
    if (!xml) {
      warnings.push(`工作表「${definition.name}」读取失败，已跳过。`)
      continue
    }
    const parsed = await parseSheetRows(xml, shared)
    sheets.push({ name: definition.name, rows: parsed.rows, truncated: parsed.truncated })
  }
  if (sheetDefs.length > MAX_SHEETS) warnings.push(`工作簿包含 ${sheetDefs.length} 个工作表，仅显示前 ${MAX_SHEETS} 个。`)
  if (sheets.length === 0) warnings.push('没有解析到可显示的工作表。')
  return { sheets, warnings, size: file.size, mtimeMs: file.mtimeMs }
}

/* ── PPTX ─────────────────────────────────────────────────────── */

function slideNumber(path: string): number {
  return Number(/slide(\d+)\.xml$/i.exec(path)?.[1] ?? 0)
}

export async function convertPptxToPreview(workspace: string, inputPath: string): Promise<PptxPreviewResult> {
  const file = assertFile(workspace, inputPath, ['pptx', 'pptm', 'ppsx', 'potx'])
  const zip = await loadZip(file.absolutePath)
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  const warnings: string[] = []
  const slides: PptxSlidePreview[] = []
  for (const path of slidePaths.slice(0, MAX_SLIDES)) {
    const xml = await readZipText(zip, path)
    if (!xml) continue
    const paragraphs: string[] = []
    for (const match of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
      const text = [...match[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((item) => decodeXml(item[1]))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) paragraphs.push(text)
    }
    if (paragraphs.length === 0) continue
    slides.push({
      index: slideNumber(path) || slides.length + 1,
      title: paragraphs[0].slice(0, 200),
      lines: paragraphs.slice(1, MAX_LINES_PER_SLIDE + 1).map((line) => line.slice(0, 500))
    })
  }
  if (slidePaths.length > MAX_SLIDES) warnings.push(`演示文稿包含 ${slidePaths.length} 页，仅显示前 ${MAX_SLIDES} 页。`)
  if (slides.length === 0) warnings.push('没有从幻灯片中提取到文本内容（可能全部是图片或形状）。')
  return { slides, warnings, size: file.size, mtimeMs: file.mtimeMs }
}

/* ── RTF / ODF / EPUB ─────────────────────────────────────────── */

function paragraphsToHtml(paragraphs: string[], title?: string): string {
  const body = paragraphs.slice(0, MAX_DOC_PARAGRAPHS).map((paragraph) => {
    const text = paragraph.trim()
    if (!text) return ''
    if (/^#{1,3}\s/.test(text)) return `<h2>${escapeHtml(text.replace(/^#{1,3}\s/, ''))}</h2>`
    return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`
  })
  return `${title ? `<h1>${escapeHtml(title)}</h1>` : ''}${body.join('\n')}`
}

function decodeRtf(raw: string): string {
  let text = raw
  // 丢弃字体/颜色/样式表、图片等声明组；不能吞掉整个 RTF 根组
  text = text.replace(/\{\\\*[^{}]*\}/g, '')
  text = text.replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|pict|object|header|footer)[^{}]*\}/g, '')
  text = text.replace(/\\u(-?\d+)\??/g, (_, code: string) => String.fromCharCode(((Number(code) % 65536) + 65536) % 65536))
  text = text.replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  text = text.replace(/\\par[d]?\b/g, '\n\n').replace(/\\line\b/g, '\n').replace(/\\tab\b/g, '\t')
  text = text.replace(/\\[a-z]+-?\d* ?/gi, '')
  text = text.replace(/[{}]/g, '')
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function odfParagraphs(xml: string): string[] {
  const paragraphs: string[] = []
  const regex = /<text:(p|h)\b[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g
  for (let match = regex.exec(xml); match; match = regex.exec(xml)) {
    const text = stripTags(match[2]).replace(/\s+\n/g, '\n').trim()
    if (text) paragraphs.push(match[1] === 'h' ? `## ${text}` : text)
  }
  return paragraphs
}

function odsTablesToHtml(xml: string): string {
  const tables: string[] = []
  for (const tableMatch of xml.matchAll(/<table:table\b[^>]*>([\s\S]*?)<\/table:table>/g)) {
    const rows: string[] = []
    for (const rowMatch of tableMatch[1].matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
      if (rows.length >= MAX_ROWS) break
      const cells: string[] = []
      for (const cellMatch of rowMatch[1].matchAll(/<table:table-cell\b[^>]*>([\s\S]*?)<\/table:table-cell>/g)) {
        if (cells.length >= MAX_COLS) break
        cells.push(escapeHtml(odfParagraphs(cellMatch[1]).join(' ')).slice(0, MAX_CELL_CHARS))
      }
      if (cells.length) rows.push(`<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    }
    if (rows.length) tables.push(`<table>${rows.join('')}</table>`)
  }
  return tables.join('\n')
}

async function epubHtml(zip: JSZip): Promise<{ html: string; warnings: string[] }> {
  const warnings: string[] = []
  const container = (await readZipText(zip, 'META-INF/container.xml')) ?? ''
  const rootPath = /full-path="([^"]+)"/i.exec(container)?.[1]
  if (!rootPath) return { html: '', warnings: ['没有找到 EPUB 的 container.xml，无法解析目录。'] }
  const opf = (await readZipText(zip, rootPath)) ?? ''
  const base = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/') + 1) : ''
  const manifest = new Map<string, string>()
  for (const match of opf.matchAll(/<item\b[^>]*>/g)) {
    const attrs = parseAttributes(match[0])
    if (attrs.id && attrs.href) manifest.set(attrs.id, attrs.href)
  }
  const spine: string[] = []
  for (const match of opf.matchAll(/<itemref\b[^>]*>/g)) {
    const attrs = parseAttributes(match[0])
    const href = attrs.idref ? manifest.get(attrs.idref) : undefined
    if (href) spine.push(href)
  }
  const sections: string[] = []
  for (const href of spine.slice(0, 40)) {
    const path = decodeURIComponent(href.startsWith('/') ? href.slice(1) : `${base}${href}`)
    const xhtml = await readZipText(zip, path)
    if (!xhtml) continue
    const blocks: string[] = []
    for (const match of xhtml.matchAll(/<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const text = stripTags(match[2]).replace(/\s+/g, ' ').trim()
      if (!text) continue
      if (match[1].toLowerCase().startsWith('h')) blocks.push(`<h2>${escapeHtml(text)}</h2>`)
      else if (match[1].toLowerCase() === 'li') blocks.push(`<p>• ${escapeHtml(text)}</p>`)
      else blocks.push(`<p>${escapeHtml(text)}</p>`)
    }
    if (blocks.length) sections.push(`<section>${blocks.join('\n')}</section>`)
  }
  if (spine.length > 40) warnings.push(`EPUB 包含 ${spine.length} 个章节，仅显示前 40 个。`)
  if (sections.length === 0) warnings.push('没有从 EPUB 中提取到可读正文。')
  return { html: sections.join('\n<hr>\n'), warnings }
}

export async function convertDocumentToPreview(workspace: string, inputPath: string): Promise<DocumentPreviewResult> {
  const file = assertFile(workspace, inputPath, ['rtf', 'odt', 'ods', 'odp', 'epub'])
  const ext = extname(file.name).slice(1).toLowerCase()
  const warnings: string[] = []
  let html = ''
  let format = ext.toUpperCase()
  if (ext === 'rtf') {
    const raw = readFileSync(file.absolutePath, 'utf8')
    html = paragraphsToHtml(decodeRtf(raw).split(/\n{2,}/))
    format = 'RTF'
  } else {
    const zip = await loadZip(file.absolutePath)
    if (ext === 'epub') {
      const result = await epubHtml(zip)
      html = result.html
      warnings.push(...result.warnings)
      format = 'EPUB'
    } else {
      const xml = (await readZipText(zip, 'content.xml')) ?? ''
      if (ext === 'ods') {
        html = odsTablesToHtml(xml)
        format = 'ODS'
      } else {
        const paragraphs = odfParagraphs(xml)
        html = paragraphsToHtml(paragraphs)
        format = ext === 'odt' ? 'ODT' : 'ODP'
      }
      if (!xml) warnings.push('没有找到 content.xml，文档可能已损坏。')
    }
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_OUTPUT_HTML_BYTES) {
    // 按 UTF-8 字节截断，而不是字符数（CJK 下字符数会放大到约 3 倍）
    let end = Math.min(html.length, MAX_OUTPUT_HTML_BYTES)
    while (end > 1024 && Buffer.byteLength(html.slice(0, end), 'utf8') > MAX_OUTPUT_HTML_BYTES) {
      end = Math.floor(end * 0.9)
    }
    html = `${html.slice(0, end)}<p>…（预览已截断）</p>`
    warnings.push('文档内容过长，预览已截断。')
  }
  if (!html.trim()) warnings.push('没有从文档中提取到可读正文。')
  return { html, format, warnings, size: file.size, mtimeMs: file.mtimeMs }
}

/* ── ZIP/JAR ──────────────────────────────────────────────────── */

export async function listArchive(workspace: string, inputPath: string): Promise<ArchivePreviewResult> {
  const stat = statWorkspaceFile(workspace, inputPath)
  if (stat.kind !== 'file') throw new Error('这是一个文件夹，不能预览。')
  const ext = extname(stat.absolutePath).slice(1).toLowerCase()
  if (!['zip', 'jar', 'whl', 'vsix'].includes(ext)) {
    throw new Error('目前支持在线列出 ZIP/JAR/WHL/VSIX；其他压缩格式请用系统应用打开。')
  }
  if (stat.size > ARCHIVE_PREVIEW_MAX_BYTES) {
    throw new Error(
      `压缩包有 ${formatBytes(stat.size)}，超过 ${formatBytes(ARCHIVE_PREVIEW_MAX_BYTES)} 的列表上限。请用系统应用打开。`
    )
  }
  const zip = await loadZip(stat.absolutePath)
  const all = Object.values(zip.files)
  const entries: ArchiveEntryPreview[] = []
  for (const entry of all.slice(0, MAX_ARCHIVE_ENTRIES)) {
    const data = (entry as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } })._data
    entries.push({
      name: entry.name,
      dir: entry.dir,
      size: typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : 0,
      compressedSize: typeof data?.compressedSize === 'number' ? data.compressedSize : 0,
      date: entry.date instanceof Date && !Number.isNaN(entry.date.getTime()) ? entry.date.toISOString() : null
    })
  }
  return {
    entries,
    total: all.length,
    truncated: all.length > MAX_ARCHIVE_ENTRIES,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  }
}

const MAX_DOCX_HTML_BYTES = 30 * 1024 * 1024

export interface DocxPreviewResult {
  html: string
  size: number
  mtimeMs: number
  warnings: string[]
}

/** DOCX → 只读 HTML；图片内联为 data URI，输出体量有上限。 */
export async function convertDocxToHtml(workspace: string, inputPath: string): Promise<DocxPreviewResult> {
  const stat = statWorkspaceFile(workspace, inputPath)
  if (stat.kind !== 'file') throw new Error('这是一个文件夹，不能预览。')
  if (extname(stat.absolutePath).toLowerCase() !== '.docx') throw new Error('只支持 .docx 文档预览。')
  if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
    throw new Error(
      `Word 文档有 ${formatBytes(stat.size)}，超过 ${formatBytes(DOCX_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
    )
  }

  const result = await mammoth.convertToHtml(
    { buffer: readFileSync(stat.absolutePath) },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const base64 = await image.readAsBase64String()
        return { src: `data:${image.contentType};base64,${base64}` }
      })
    }
  )
  if (Buffer.byteLength(result.value, 'utf8') > MAX_DOCX_HTML_BYTES) {
    throw new Error(
      `「${basename(stat.absolutePath)}」转换后的内容过大（超过 ${formatBytes(MAX_DOCX_HTML_BYTES)}），请用系统应用打开。`
    )
  }

  return {
    html: result.value,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    warnings: result.messages.filter((message) => message.type === 'warning').map((message) => message.message)
  }
}
