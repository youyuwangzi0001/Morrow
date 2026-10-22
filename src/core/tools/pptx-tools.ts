/**
 * PPTX 读取：用 jszip 解析 OOXML，按演示顺序提取每页文本与演讲者备注。
 *
 * 限制：只提取文字，不做图片 OCR；图片版幻灯片会明确返回“没有可提取文字”。
 * 路径：工作区内文件，或用户在本会话消息中显式附加的文件（只读）。
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import JSZip from 'jszip'
import type { ToolResult } from '../../shared/types'
import type { ToolContext } from '../types'
import { formatBytes, truncateText } from '../util'
import { getBoolean, getNumber, getString } from './args'
import { decodeXmlText } from './docx-tools'
import { ToolInputError } from './types'
import { displayPath, resolveWorkspacePath } from './paths'
import { errResult, okResult, oneLineInput, type ToolImpl } from './types'

const MAX_PPTX_BYTES = 50 * 1024 * 1024
const MAX_PART_BYTES = 24 * 1024 * 1024
const DEFAULT_MAX_CHARS = 30_000
const MAX_CHARS_LIMIT = 120_000
const MAX_SLIDES = 200

interface Relationship {
  id: string
  target: string
  type: string
}

function readText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path)
  if (!file) return Promise.resolve('')
  // 防止压缩炸弹：先看解压后大小，再决定是否读取
  const rawSize = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
  if (typeof rawSize === 'number' && rawSize > MAX_PART_BYTES) {
    throw new ToolInputError(`PPTX 内部的 ${path} 解压后过大，已拒绝读取。`, '请用 PowerPoint 另存为精简版后再试。')
  }
  return file.async('text')
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const regex = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (let match = regex.exec(tag); match; match = regex.exec(tag)) {
    out[match[1]] = decodeXmlText(match[2] ?? match[3] ?? '')
  }
  return out
}

function parseRelationships(xml: string): Relationship[] {
  const out: Relationship[] = []
  const regex = /<Relationship\b([^>]*)\/?>/g
  for (let match = regex.exec(xml); match; match = regex.exec(xml)) {
    const attrs = attributes(match[1])
    if (!attrs.Id || !attrs.Target) continue
    out.push({ id: attrs.Id, target: attrs.Target, type: attrs.Type ?? '' })
  }
  return out
}

function normalizePart(baseDir: string, target: string): string {
  const raw = target.replace(/\\/g, '/')
  if (raw.startsWith('/')) return raw.slice(1)
  const parts = `${baseDir}/${raw}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

function relsPath(part: string): string {
  const dir = dirname(part).replace(/\\/g, '/')
  return `${dir}/_rels/${basename(part)}.rels`
}

/** 把幻灯片 XML 转成可读文本：段落换行、表格单元格以制表符分隔。 */
function extractSlideText(xml: string): string {
  const withBreaks = xml
    .replace(/<a:br\b[^>]*\/>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<\/a:tr>/g, '\n')
    .replace(/<\/a:tc>/g, '\t')
    .replace(/<\/p:sp>/g, '\n')
    .replace(/<\/p:graphicFrame>/g, '\n')
  const plain = decodeXmlText(withBreaks.replace(/<[^>]+>/g, ''))
  return plain
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').trim())
    .filter(Boolean)
    .join('\n')
}

async function slidePartsInOrder(zip: JSZip): Promise<string[]> {
  const presentation = await readText(zip, 'ppt/presentation.xml')
  const rels = parseRelationships(await readText(zip, 'ppt/_rels/presentation.xml.rels'))
  const byId = new Map(rels.map((rel) => [rel.id, rel]))
  const ordered: string[] = []
  const regex = /<p:sldId\b([^>]*)\/?>/g
  for (let match = regex.exec(presentation); match; match = regex.exec(presentation)) {
    const attrs = attributes(match[1])
    const rel = attrs['r:id'] ? byId.get(attrs['r:id']) : undefined
    if (rel) ordered.push(normalizePart('ppt', rel.target))
  }
  if (ordered.length > 0) return ordered
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const left = Number(a.match(/slide(\d+)\.xml$/i)?.[1] ?? 0)
      const right = Number(b.match(/slide(\d+)\.xml$/i)?.[1] ?? 0)
      return left - right
    })
}

function parseSlideSelection(raw: string, total: number): Set<number> | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const wanted = new Set<number>()
  for (const token of trimmed.split(',')) {
    const part = token.trim()
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start < 1 || end < start) {
        throw new ToolInputError(`页码范围不合法：「${part}」。`, '示例："1-3"、"1,3,5"。')
      }
      if (start > total) {
        throw new ToolInputError(`页码范围超出范围：「${part}」（共 ${total} 页）。`, `请使用 1-${total} 之间的页码。`)
      }
      for (let page = start; page <= Math.min(end, total); page += 1) wanted.add(page)
      continue
    }
    if (!/^\d+$/.test(part)) {
      throw new ToolInputError(`页码不合法：「${part}」。`, '示例："1-3"、"1,3,5"。')
    }
    const page = Number(part)
    if (page < 1 || page > total) {
      throw new ToolInputError(`页码超出范围：「${part}」（共 ${total} 页）。`, `请使用 1-${total} 之间的页码。`)
    }
    wanted.add(page)
  }
  return wanted.size > 0 ? wanted : null
}

async function notesForSlide(zip: JSZip, slidePart: string): Promise<string> {
  const rels = parseRelationships(await readText(zip, relsPath(slidePart)))
  const notes = rels.find((rel) => /\/notesSlide$/i.test(rel.type))
  if (!notes) return ''
  const part = normalizePart(dirname(slidePart).replace(/\\/g, '/'), notes.target)
  return extractSlideText(await readText(zip, part))
}

export const readPptxTool: ToolImpl = {
  definition: {
    name: 'read_pptx',
    description:
      '读取工作区内或本条消息显式附加的 PowerPoint（.pptx）文字内容，按演示顺序返回每页文本与备注。' +
      '只提取文字，不做图片 OCR：图片版/扫描版幻灯片会明确提示没有可提取文字。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PPTX 文件路径（相对工作区，或附件信息里的完整路径）' },
        slides: { type: 'string', description: '可选：要读取的页码，例如 "1-3"、"1,3,5"；默认读取全部页' },
        include_notes: { type: 'boolean', description: '是否包含演讲者备注（默认 true）' },
        max_chars: {
          type: 'number',
          description: `可选：最多返回多少字符（默认 ${DEFAULT_MAX_CHARS}，上限 ${MAX_CHARS_LIMIT}）`
        }
      },
      required: ['path']
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `读取演示文稿 ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true,
      allowedExternalFiles: ctx.attachedFiles
    })
    if (resolved.isDirectory) throw new ToolInputError(`「${rawPath}」是一个文件夹，不是 PPTX 文件。`, '请指定具体的 .pptx 文件。')
    const stat = statSync(resolved.real)
    if (!stat.isFile()) throw new ToolInputError(`「${rawPath}」不是普通文件。`, '请指定具体的 .pptx 文件。')
    if (!/\.pptx$/i.test(resolved.absolute)) {
      throw new ToolInputError('只支持 .pptx 格式。', '旧版 .ppt 请先另存为 .pptx；也可以导出为 PDF 后再读取。')
    }
    if (stat.size > MAX_PPTX_BYTES) {
      throw new ToolInputError(
        `PPTX 过大（${formatBytes(stat.size)}，上限 ${formatBytes(MAX_PPTX_BYTES)}）。`,
        '请拆分演示文稿后重试。'
      )
    }

    let zip: JSZip
    try {
      zip = await JSZip.loadAsync(readFileSync(resolved.real))
    } catch {
      throw new ToolInputError('这个 PPTX 无法解析，文件可能已损坏或不是真正的 PowerPoint 文件。', '请用 PowerPoint 重新另存为 .pptx。')
    }
    const allParts = await slidePartsInOrder(zip)
    if (allParts.length === 0) {
      throw new ToolInputError('这个 PPTX 里没有找到幻灯片。', '请确认文件完整后重试。')
    }
    const parts = allParts.slice(0, MAX_SLIDES)
    const selection = parseSlideSelection(getString(input, 'slides', { defaultValue: '' }), allParts.length)
    const includeNotes = getBoolean(input, 'include_notes', true)
    const targets = parts
      .map((part, index) => ({ part, page: index + 1 }))
      .filter((item) => !selection || selection.has(item.page))

    const display = displayPath(resolved.absolute, ctx.workspace)
    const maxChars = Math.min(
      Math.max(2_000, Math.round(getNumber(input, 'max_chars', { defaultValue: DEFAULT_MAX_CHARS, min: 2_000 }))),
      MAX_CHARS_LIMIT
    )
    const sections: string[] = []
    let usedChars = 0
    let readPages = 0
    for (const { part, page } of targets) {
      // 超出字符预算后不再读取后续幻灯片/备注，避免为了截断而解析整份大文档
      if (usedChars >= maxChars) break
      const text = extractSlideText(await readText(zip, part))
      const notes = includeNotes ? await notesForSlide(zip, part) : ''
      const section = `--- 第 ${page} 页 ---\n${text || '（这一页没有可提取的文字）'}`
      sections.push(section)
      if (notes) sections.push(`备注：\n${notes}`)
      usedChars += section.length + (notes ? notes.length + 4 : 0) + 2
      readPages += 1
    }

    const fullBody = sections.join('\n\n')
    const body = truncateText(fullBody, maxChars)
    const capped = allParts.length > parts.length ? `，仅读取前 ${parts.length} 页` : ''
    const truncated = readPages < targets.length || body.length < fullBody.length
    const header = `PPTX：${display}（共 ${allParts.length} 页${capped}，读取 ${readPages} 页，${formatBytes(stat.size)}）`
    const warning =
      sections.length > 0 && sections.every((section) => section.includes('没有可提取的文字'))
        ? '\n\n提示：整份演示文稿都没有可提取文字，可能是图片版幻灯片。可以把关键页截图发给我，或提供导出的 PDF/文字版。'
        : ''
    const truncationNote = truncated ? `\n\n（输出已按 max_chars=${maxChars} 截断；可用 slides 缩小页码范围。）` : ''
    const unreadable = selection
      ? [...selection].filter((page) => page > parts.length && page <= allParts.length)
      : []
    const unreadableNote =
      unreadable.length > 0
        ? `\n\n（第 ${unreadable.slice(0, 5).join('、')}${unreadable.length > 5 ? ' 等' : ''} 页超出单次可读范围：最多读取前 ${MAX_SLIDES} 页。）`
        : ''
    return okResult(`${header}\n\n${body}${warning}${truncationNote}${unreadableNote}`, {
      path: display,
      absolutePath: resolved.absolute,
      slides: allParts.length,
      slidesRead: readPages,
      includeNotes,
      truncated
    })
  }
}

export const pptxTools: ToolImpl[] = [readPptxTool]
