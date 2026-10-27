// DOCX 类工具：read_docx / edit_docx。
import { existsSync, readFileSync, statSync } from 'node:fs'
import JSZip from 'jszip'
import type { ToolResult } from '../../shared/types'
import type { ToolContext } from '../types'
import { formatBytes, sha256, truncateText } from '../util'
import { getBoolean, getNumber, getString } from './args'
import { ToolExecutionError, ToolInputError } from './types'
import { atomicWriteFileSync, snapshotFile, recordRestoreManifest } from './fs-tools'
import { displayPath, resolveWorkspacePath } from './paths'
import { errResult, okResult, oneLineInput, type ToolImpl } from './types'

const MAX_DOCX_BYTES = 100 * 1024 * 1024
const MAX_XML_CHARS = 32 * 1024 * 1024
const DEFAULT_MAX_CHARS = 60_000
const MAX_CHARS_LIMIT = 200_000
const MAX_REPLACEMENTS = 50
const MAX_PLACEHOLDERS = 100
const DOCX_PARTS_WITH_TEXT = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/

export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
        if (entity.startsWith('#') && entity.length <= 8) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
        return _match
    }
  })
}

export function encodeXmlText(text: string): string {
  // XML 1.0 不允许的控制字符会让 Word 打不开文档；替换文本时直接剔除
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 收集一段 XML 里所有 <w:t> 的文字（按出现顺序拼接；换行/制表符保留为分隔） */
export function collectWordText(xml: string): string {
  let output = ''
  const regex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:br\b[^>]*\/?>|<w:tab\b[^>]*\/?>/g
  for (let match = regex.exec(xml); match; match = regex.exec(xml)) {
    if (match[1] !== undefined) output += decodeXmlText(match[1])
    else if (match[0].startsWith('<w:br')) output += '\n'
    else output += '\t'
  }
  return output
}

async function loadDocxZip(resolvedReal: string, display: string): Promise<JSZip> {
  let buffer: Buffer
  try {
    buffer = readFileSync(resolvedReal)
  } catch (err) {
    throw new ToolExecutionError(`读取文件失败：${display}`, err instanceof Error ? err.message : undefined)
  }
  return loadDocxZipFromBuffer(buffer, display)
}

async function loadDocxZipFromBuffer(buffer: Buffer, display: string): Promise<JSZip> {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new ToolInputError(
      `「${display}」不是有效的 .docx 文件（不是 ZIP 容器，可能是 .doc 旧格式或文件损坏）。`,
      '请确认文件是 Word 2007+ 的 .docx；旧版 .doc 需要先另存为 .docx。'
    )
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw new ToolInputError(
      `「${display}」的 DOCX 包已损坏，无法解压。`,
      '文件可能下载不完整或被加密；请让用户提供可正常打开的 .docx。'
    )
  }
  const main = zip.file('word/document.xml')
  if (!main) {
    throw new ToolInputError(
      `「${display}」里没有 word/document.xml，不是 Word 文档。`,
      '这个文件可能是 Excel/PPT 改后缀，或加密/受保护的文档。请确认格式。'
    )
  }
  return zip
}

async function readZipText(zip: JSZip, entryName: string): Promise<string> {
  const entry = zip.file(entryName)
  if (!entry) return ''
  const text = await entry.async('string')
  if (text.length > MAX_XML_CHARS) {
    throw new ToolExecutionError(`文档部件 ${entryName} 过大（${formatBytes(text.length)}），无法安全解析。`, '请拆分文档或改用文本格式。')
  }
  return text
}

interface ParagraphRender {
  line: string
  style: string
}

function renderParagraph(paragraphXml: string): ParagraphRender | null {
  const text = collectWordText(paragraphXml)
  if (!text.trim()) return null
  const styleMatch = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(paragraphXml)
  const style = styleMatch?.[1] ?? ''
  let prefix = ''
  const heading = /^Heading([1-6])$/i.exec(style)
  if (heading) prefix = `${'#'.repeat(Math.min(Number(heading[1]), 4))} `
  else if (/^Title$/i.test(style)) prefix = '# '
  else if (/<w:numPr\b/.test(paragraphXml)) prefix = '- '
  // 软换行 w:br 在文本节点之间，collectWordText 不保留；这里统一压成一行，避免输出歧义
  return { line: `${prefix}${text.replace(/\s*\n\s*/g, ' ')}`, style }
}

function renderTable(tableXml: string, index: number): string[] {
  const rows: string[][] = []
  const rowRegex = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g
  for (let rowMatch = rowRegex.exec(tableXml); rowMatch; rowMatch = rowRegex.exec(tableXml)) {
    const cells: string[] = []
    const cellRegex = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g
    for (let cellMatch = cellRegex.exec(rowMatch[0]); cellMatch; cellMatch = cellRegex.exec(rowMatch[0])) {
      cells.push(collectWordText(cellMatch[0]).replace(/\s+/g, ' ').trim())
    }
    rows.push(cells)
  }
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const lines = [`[表格 ${index}] ${rows.length} 行 × ${columns} 列`]
  for (const row of rows) lines.push(`| ${row.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`)
  return lines
}

interface DocxBody {
  body: string
  paragraphCount: number
  tableCount: number
}

function extractBody(documentXml: string): DocxBody {
  const bodyMatch = /<w:body(?:\s[^>]*)?>([\s\S]*)<\/w:body>/.exec(documentXml)
  const body = bodyMatch?.[1] ?? documentXml
  const blocks: string[] = []
  let paragraphCount = 0
  let tableCount = 0
  const blockRegex = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p(?:\s[^>]*)?\/>/g
  for (let match = blockRegex.exec(body); match; match = blockRegex.exec(body)) {
    const xml = match[0]
    if (xml.startsWith('<w:tbl')) {
      tableCount += 1
      blocks.push(renderTable(xml, tableCount).join('\n'))
      continue
    }
    const paragraph = renderParagraph(xml)
    if (paragraph) {
      paragraphCount += 1
      blocks.push(paragraph.line)
    }
  }
  return { body: blocks.join('\n'), paragraphCount, tableCount }
}

function uniquePlaceholders(text: string): string[] {
  const found = new Set<string>()
  const regex = /\{\{[^{}\n]{1,120}\}\}/g
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    found.add(match[0])
    if (found.size >= MAX_PLACEHOLDERS) break
  }
  return [...found]
}

export const readDocxTool: ToolImpl = {
  definition: {
    name: 'read_docx',
    description:
      '读取工作区内 Word（.docx）文档的正文文本：按顺序输出标题、段落、列表和表格内容，并列出文档中的 {{占位符}}。' +
      '只支持 .docx（Word 2007+），不支持旧版 .doc、加密文档和扫描件。需要替换占位符时用 edit_docx。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'DOCX 文件路径，相对工作区根目录' },
        include_headers: { type: 'boolean', description: '是否同时输出页眉/页脚文字（默认 false）' },
        max_chars: {
          type: 'number',
          description: `可选：最多返回多少字符（默认 ${DEFAULT_MAX_CHARS}，上限 ${MAX_CHARS_LIMIT}）`
        }
      },
      required: ['path']
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `读取 Word ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true,
      allowedExternalFiles: ctx.attachedFiles
    })
    if (resolved.isDirectory) throw new ToolInputError(`「${rawPath}」是一个文件夹，不是 Word 文件。`, '请指定具体的 .docx 文件。')
    const stat = statSync(resolved.real)
    if (!stat.isFile()) throw new ToolInputError(`「${rawPath}」不是普通文件。`, '请指定具体的 .docx 文件。')
    if (stat.size > MAX_DOCX_BYTES) {
      throw new ToolInputError(`DOCX 过大（${formatBytes(stat.size)}，上限 ${formatBytes(MAX_DOCX_BYTES)}）。`, '请拆分文档后重试。')
    }
    const display = displayPath(resolved.absolute, ctx.workspace)
    const zip = await loadDocxZip(resolved.real, display)
    const documentXml = await readZipText(zip, 'word/document.xml')
    const extracted = extractBody(documentXml)

    const maxChars = Math.min(
      Math.max(1, Math.round(getNumber(input, 'max_chars', { defaultValue: DEFAULT_MAX_CHARS, min: 1 }))),
      MAX_CHARS_LIMIT
    )
    const sections: string[] = [`Word 文档：${display}（正文 ${extracted.paragraphCount} 段、${extracted.tableCount} 个表格，${formatBytes(stat.size)}）`]
    // 先按调用方的 max_chars 截断正文；否则默认 60k 会先把 max_chars>60k 的内容砍掉
    const bodyText = truncateText(extracted.body || '（正文没有可读取的文字）', maxChars)
    sections.push(bodyText)

    if (getBoolean(input, 'include_headers', false)) {
      const headerParts: string[] = []
      const names = Object.keys(zip.files)
        .filter((name) => /^word\/(header|footer)\d*\.xml$/.test(name))
        .sort()
      for (const name of names) {
        const xml = await readZipText(zip, name)
        const text = collectWordText(xml).trim()
        if (text) headerParts.push(`${name.includes('header') ? '页眉' : '页脚'}：${text.replace(/\s+/g, ' ')}`)
      }
      if (headerParts.length > 0) sections.push(headerParts.join('\n'))
    }

    const placeholders = uniquePlaceholders(extracted.body)
    if (placeholders.length > 0) {
      sections.push(`发现的占位符（${placeholders.length}）：${placeholders.join('、')}`)
    }
    const output = truncateText(sections.join('\n\n'), maxChars)
    return okResult(output, {
      path: display,
      absolutePath: resolved.absolute,
      paragraphs: extracted.paragraphCount,
      tables: extracted.tableCount,
      placeholders,
      chars: extracted.body.length,
      size: stat.size
    })
  }
}

export interface DocxReplacement {
  find: string
  replace: string
}

export function parseDocxReplacements(raw: unknown): DocxReplacement[] {
  const items: DocxReplacement[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        throw new ToolInputError('replacements 的每一项都必须是 {find, replace} 对象。', '例如：replacements: [{"find": "{{NAME}}", "replace": "林宁"}]')
      }
      const record = item as Record<string, unknown>
      const find = typeof record.find === 'string' ? record.find : typeof record.old === 'string' ? record.old : ''
      const replace = typeof record.replace === 'string' ? record.replace : typeof record.new === 'string' ? record.new : ''
      if (!find) throw new ToolInputError('replacements 里缺少非空的 find（要替换的原文）。', '例如：{"find": "{{NAME}}", "replace": "林宁"}')
      if (find.length > 500) throw new ToolInputError('replacements 里的 find 过长（上限 500 字符）。', '请缩短要匹配的原文。')
      items.push({ find, replace })
    }
  } else if (raw && typeof raw === 'object') {
    // 兼容 {"{{NAME}}": "林宁"} 这种对象写法
    for (const [find, replace] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof replace !== 'string') continue
      if (!find) continue
      items.push({ find, replace })
    }
  }
  if (items.length === 0) {
    throw new ToolInputError(
      '缺少要替换的内容：replacements 至少需要一项 {find, replace}。',
      '例如把 {{NAME}} 替换为林宁：replacements: [{"find": "{{NAME}}", "replace": "林宁"}]'
    )
  }
  if (items.length > MAX_REPLACEMENTS) {
    throw new ToolInputError(`替换项过多（${items.length}，上限 ${MAX_REPLACEMENTS}）。`, '可以合并相同模式的替换后重试。')
  }
  return items
}

interface WordTextNode {
  openStart: number
  openEnd: number
  contentStart: number
  contentEnd: number
  raw: string
  attrs: string
  text: string
}

function collectWordTextNodes(xml: string): WordTextNode[] {
  const nodes: WordTextNode[] = []
  const regex = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g
  for (let match = regex.exec(xml); match; match = regex.exec(xml)) {
    const attrs = match[1] ?? ''
    const openLength = '<w:t'.length + attrs.length + 1
    const contentStart = match.index + openLength
    nodes.push({
      openStart: match.index,
      openEnd: match.index + openLength,
      contentStart,
      contentEnd: contentStart + match[2].length,
      raw: match[2],
      attrs,
      text: decodeXmlText(match[2])
    })
  }
  return nodes
}

interface ParagraphReplaceResult {
  xml: string
  counts: number[]
  changed: boolean
}

/** 在一个段落 XML 内做跨 run 替换（保留未被改动的 XML 字节） */
export function replaceInParagraphXml(
  paragraphXml: string,
  replacements: DocxReplacement[],
  replaceAll: boolean,
  /** replace_all=false 时跨段落共享的「已替换」状态，保证全文档只替换第一处 */
  firstOnlyDone?: boolean[]
): ParagraphReplaceResult {
  const normalized = paragraphXml.replace(/<w:t(\s[^>]*?)?\/>/g, (_match, attrs: string | undefined) => `<w:t${attrs ?? ''}></w:t>`)
  const nodes = collectWordTextNodes(normalized)
  const counts = replacements.map(() => 0)
  if (nodes.length === 0) return { xml: paragraphXml, counts, changed: false }

  const texts = nodes.map((node) => node.text)
  const locate = (offset: number): { node: number; offset: number } => {
    let cumulative = 0
    for (let index = 0; index < texts.length; index += 1) {
      const length = texts[index].length
      if (offset <= cumulative + length) return { node: index, offset: offset - cumulative }
      cumulative += length
    }
    return { node: texts.length - 1, offset: texts[texts.length - 1].length }
  }

  let changed = false
  for (let replacementIndex = 0; replacementIndex < replacements.length; replacementIndex += 1) {
    const replacement = replacements[replacementIndex]
    if (!replacement.find) continue
    if (!replaceAll && firstOnlyDone?.[replacementIndex]) continue
    const joined = texts.join('')
    const positions: number[] = []
    let from = 0
    for (;;) {
      const at = joined.indexOf(replacement.find, from)
      if (at < 0) break
      positions.push(at)
      if (!replaceAll) break
      from = at + replacement.find.length
    }
    if (positions.length === 0) continue
    counts[replacementIndex] = positions.length
    if (!replaceAll && firstOnlyDone) firstOnlyDone[replacementIndex] = true
    for (const position of [...positions].reverse()) {
      const start = locate(position)
      const end = locate(position + replacement.find.length)
      if (start.node === end.node) {
        texts[start.node] =
          texts[start.node].slice(0, start.offset) + replacement.replace + texts[start.node].slice(end.offset)
      } else {
        texts[start.node] = texts[start.node].slice(0, start.offset) + replacement.replace
        for (let index = start.node + 1; index < end.node; index += 1) texts[index] = ''
        texts[end.node] = texts[end.node].slice(end.offset)
      }
      changed = true
    }
  }
  if (!changed) return { xml: paragraphXml, counts, changed: false }

  let rebuilt = normalized
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (texts[index] === node.text) continue
    const encoded = encodeXmlText(texts[index])
    rebuilt = rebuilt.slice(0, node.contentStart) + encoded + rebuilt.slice(node.contentEnd)
    const needsPreserve = /^\s|\s$/.test(texts[index]) && !/xml:space\s*=/.test(node.attrs)
    if (needsPreserve) {
      const open = normalized.slice(node.openStart, node.openEnd)
      const patchedOpen = open.replace(/^<w:t\b/, '<w:t xml:space="preserve"')
      rebuilt = rebuilt.slice(0, node.openStart) + patchedOpen + rebuilt.slice(node.openEnd)
    }
  }
  return { xml: rebuilt, counts, changed: true }
}

interface XmlFileReplaceResult {
  xml: string
  counts: number[]
  changed: boolean
}

/** 在一个 word/*.xml 里替换所有段落中的文字（标题/表格/页眉都是 w:p） */
export function replaceInDocxXmlFile(
  xml: string,
  replacements: DocxReplacement[],
  replaceAll: boolean,
  firstOnlyDone?: boolean[]
): XmlFileReplaceResult {
  const counts = replacements.map(() => 0)
  const done = firstOnlyDone ?? replacements.map(() => false)
  let changed = false
  const nextXml = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraphXml) => {
    const result = replaceInParagraphXml(paragraphXml, replacements, replaceAll, done)
    result.counts.forEach((count, index) => {
      counts[index] += count
    })
    if (result.changed) changed = true
    return result.xml
  })
  return { xml: nextXml, counts, changed }
}

/**
 * 轻量 XML 良构校验（替换后的安全网：宁可报错也不写坏文档）。
 * 只做标签配对/闭合检查——对 OOXML 足够发现「正则按段落切分遇到嵌套段落（文本框）」
 * 这类结构性问题；不实现命名空间/实体校验。
 */
export function checkXmlWellFormed(xml: string): { ok: boolean; error?: string } {
  const cleaned = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
  const tagRegex = /<(\/?)([A-Za-z_][A-Za-z0-9_.:-]*)((?:\s+(?:"[^"]*"|'[^']*'|[^>"'])*?)?)(\/?)>/g
  const stack: string[] = []
  for (let match = tagRegex.exec(cleaned); match; match = tagRegex.exec(cleaned)) {
    const closing = match[1] === '/'
    const name = match[2]
    const selfClosing = match[4] === '/'
    if (closing) {
      const top = stack.pop()
      if (top !== name) return { ok: false, error: `</${name}> 与 <${top ?? '（无）'}> 不匹配` }
    } else if (!selfClosing) {
      stack.push(name)
    }
  }
  if (stack.length > 0) return { ok: false, error: `标签未闭合：${stack.slice(-3).join('、')}` }
  return { ok: true }
}

function assertWellFormedXml(xml: string, part: string): void {
  const result = checkXmlWellFormed(xml)
  if (result.ok) return
  throw new ToolExecutionError(
    `替换后的 ${part} 结构校验未通过（${result.error ?? '未知原因'}），文档可能包含文本框/复杂嵌套，为避免写坏文件已停止。`,
    '可以换一种方式：先 read_docx 确认结构，或让用户把文档另存为简单格式；不要重试同一操作。'
  )
}

export const editDocxTool: ToolImpl = {
  definition: {
    name: 'edit_docx',
    description:
      '复制一份 Word（.docx）到新文件，并替换其中的文字/占位符（例如 {{NAME}}、{{DATE}}）。' +
      '只改文字节点，标题样式、表格、保密条款、图片等其余内容按原样保留；输入文件绝不修改，输出必须写到不同路径。' +
      '支持被 Word 拆分到多个 run 的占位符；找不到任何匹配时不会写输出文件并返回错误。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输入的 .docx 路径（相对工作区，保持只读）' },
        output_path: { type: 'string', description: '输出的 .docx 路径（相对工作区，不能与输入相同）' },
        replacements: {
          type: 'array',
          description: '替换列表，按顺序执行；每项 {find, replace}',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: '要替换的原文（可跨 run，例如 "{{NAME}}"）' },
              replace: { type: 'string', description: '替换后的文字（可为空字符串，表示删除）' }
            },
            required: ['find', 'replace']
          }
        },
        replace_all: { type: 'boolean', description: '是否替换所有出现（默认 true）；false 时每个 find 只替换第一处' }
      },
      required: ['path', 'output_path', 'replacements']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `替换 Word 占位符 → ${oneLineInput(input, 'output_path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const rawOutput = getString(input, 'output_path', { required: true })
    const replacements = parseDocxReplacements(input.replacements)
    const replaceAll = input.replace_all !== false
    if (rawOutput.trim() === rawPath.trim()) {
      throw new ToolInputError(
        'output_path 不能与输入文件相同：这个工具要求保留原文件，只把结果写到新文件。',
        '请把 output_path 写成别的路径（例如 out/letter.docx）。'
      )
    }
    const resolvedInput = resolveWorkspacePath(rawPath, ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true
    })
    if (resolvedInput.isDirectory) throw new ToolInputError(`「${rawPath}」是一个文件夹，不是 Word 文件。`, '请指定具体的 .docx 文件。')
    const inputStat = statSync(resolvedInput.real)
    if (!inputStat.isFile()) throw new ToolInputError(`「${rawPath}」不是普通文件。`, '请指定具体的 .docx 文件。')
    if (inputStat.size > MAX_DOCX_BYTES) {
      throw new ToolInputError(`DOCX 过大（${formatBytes(inputStat.size)}）。`, '请拆分文档后重试。')
    }
    const resolvedOutput = resolveWorkspacePath(rawOutput, ctx.workspace, { escapeApproved: ctx.escapeApproved })
    if (resolvedOutput.isDirectory) {
      throw new ToolInputError(`输出路径「${rawOutput}」是一个文件夹。`, '请指定输出文件名，例如 out/letter.docx。')
    }
    if (!/\.docx$/i.test(resolvedOutput.absolute)) {
      throw new ToolInputError('output_path 必须以 .docx 结尾。', '例如 out/letter.docx（避免生成无法打开的伪 Word 文件）。')
    }
    const inputReal = resolvedInput.real
    const outputReal = resolvedOutput.real
    const samePath =
      process.platform === 'win32' ? inputReal.toLowerCase() === outputReal.toLowerCase() : inputReal === outputReal
    if (samePath) {
      throw new ToolInputError('输出路径解析后与输入文件是同一个文件，会改动原文件。', '请换一个输出路径。')
    }

    const displayInput = displayPath(resolvedInput.absolute, ctx.workspace)
    const displayOutput = displayPath(resolvedOutput.absolute, ctx.workspace)
    const sourceBuffer = readFileSync(inputReal)
    const inputHashBefore = sha256(sourceBuffer)
    // 用刚读到的 buffer 解析，避免两次读盘之间文件被改导致哈希与内容不一致
    const zip = await loadDocxZipFromBuffer(sourceBuffer, displayInput)

    const partNames = Object.keys(zip.files).filter((name) => DOCX_PARTS_WITH_TEXT.test(name))
    if (partNames.length === 0) throw new ToolInputError('文档里没有可替换的正文部件。', '请确认文件是正常的 .docx。')
    partNames.sort((a, b) => (a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b)))

    const counts = replacements.map(() => 0)
    const changedParts: string[] = []
    // replace_all=false 的「只替换第一处」必须跨 document/header/footer 等部件生效
    const firstOnlyDone = replacements.map(() => false)
    for (const partName of partNames) {
      const xml = await readZipText(zip, partName)
      if (!xml) continue
      const result = replaceInDocxXmlFile(xml, replacements, replaceAll, firstOnlyDone)
      result.counts.forEach((count, index) => {
        counts[index] += count
      })
      if (!result.changed) continue
      assertWellFormedXml(result.xml, partName)
      zip.file(partName, result.xml)
      changedParts.push(partName)
    }

    const total = counts.reduce((sum, count) => sum + count, 0)
    const perReplacement = replacements.map((replacement, index) => ({ find: replacement.find, count: counts[index] }))
    if (total === 0) {
      return errResult(
        `没有在「${displayInput}」里找到要替换的内容（${replacements.map((item) => item.find).join('、')}），未写出输出文件。`,
        '请先 read_docx 查看文档正文，确认占位符原文（大小写、空格、花括号）完全一致后重试；不要换工具绕过。',
        { inputPath: displayInput, perReplacement }
      )
    }

    const outputBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    })
    const snapshot = existsSync(outputReal) ? snapshotFile(outputReal, ctx) : null
    atomicWriteFileSync(outputReal, outputBuffer)
    const afterHash = sha256(outputBuffer)
    recordRestoreManifest(ctx, outputReal, snapshot?.beforeHash ?? null, afterHash)

    // 证据：输入文件字节不变；输出可重新解包、文字里不再残留需要替换的原文
    const inputHashAfter = sha256(readFileSync(inputReal))
    const inputUnchanged = inputHashBefore === inputHashAfter
    let remaining: string[] = []
    let outputParagraphs = 0
    try {
      const outputZip = await JSZip.loadAsync(outputBuffer)
      const outputXml = await readZipText(outputZip, 'word/document.xml')
      const extracted = extractBody(outputXml)
      outputParagraphs = extracted.paragraphCount
      const plain = collectWordText(outputXml)
      remaining = replacements
        .filter((replacement) => !replacement.replace.includes(replacement.find))
        .map((replacement) => replacement.find)
        .filter((find) => plain.includes(find))
    } catch {
      remaining = []
    }

    const describe = replacements
      .map((replacement, index) => `${replacement.find}→${replacement.replace || '（删除）'}${counts[index]} 处`)
      .join('；')
    const lines = [
      `已生成 ${displayOutput}（替换 ${total} 处：${describe}）`,
      `输入文件 ${displayInput} 未改动（sha256 ${inputHashBefore.slice(0, 12)}…），标题/表格/其余文字按原样保留。`,
      `输出校验：Word 文档可重新打开，正文 ${outputParagraphs} 段；替换后占位符${remaining.length > 0 ? `仍有残留：${remaining.join('、')}` : '已全部清除'}。`,
      snapshot ? '输出位置的旧文件已备份，可撤销。' : ''
    ].filter(Boolean)
    return okResult(lines.join('\n'), {
      path: displayOutput,
      absolutePath: outputReal,
      inputPath: displayInput,
      replacements: total,
      perReplacement,
      changedParts,
      bytes: outputBuffer.length,
      created: !snapshot,
      snapshotId: snapshot?.snapshotId ?? null,
      snapshotPath: snapshot?.snapshotPath ?? null,
      beforeHash: snapshot?.beforeHash ?? null,
      afterHash,
      inputHashBefore,
      inputHashAfter,
      inputUnchanged,
      remaining
    })
  }
}

export const docxTools: ToolImpl[] = [readDocxTool, editDocxTool]
