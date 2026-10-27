// PDF 类工具：read_pdf。
import { readFileSync, statSync } from 'node:fs'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import type { ToolResult } from '../../shared/types'
import type { ToolContext } from '../types'
import { formatBytes, truncateText } from '../util'
import { getNumber, getString } from './args'
import { ToolExecutionError, ToolInputError } from './types'
import { displayPath, resolveWorkspacePath } from './paths'
import { okResult, oneLineInput, type ToolImpl } from './types'

const MAX_PDF_BYTES = 100 * 1024 * 1024 // 100MB：正常文档远小于此，避免恶意/超大文件拖垮主进程
const DEFAULT_MAX_CHARS = 60_000
const MAX_CHARS_LIMIT = 200_000
/** 单次最多选择/读取的页数：避免 1-10000 这类选择把页码与说明撑爆 */
const MAX_SELECTED_PAGES = 500
/** 每次 read_pdf 最多 OCR 的扫描页数：渲染+识别耗时随页数线性增长 */
const MAX_OCR_PAGES = 12

/** 解析 pages 参数："1" / "1-3" / "1,3,5" / "1-2,5"；返回去重后的 1-based 页码数组（null = 全部） */
export function parsePageSelection(raw: string): number[] | null {
  const text = raw.trim()
  if (!text) return null
  const pages = new Set<number>()
  for (const part of text.split(/[,，]/)) {
    const token = part.trim()
    if (!token) continue
    const range = /^(\d+)\s*[-–~]\s*(\d+)$/.exec(token)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start < 1 || end < start || end > 10_000) {
        throw new ToolInputError(`pages 范围不合法：「${token}」。`, '请使用 1 起始的页码，例如 "1-3" 或 "1,3"。')
      }
      for (let page = start; page <= end; page += 1) pages.add(page)
      continue
    }
    if (!/^\d+$/.test(token)) {
      throw new ToolInputError(`pages 参数不合法：「${token}」。`, '请使用页码，例如 "1"、"1-3" 或 "1,3,5"。')
    }
    const page = Number(token)
    if (page < 1) throw new ToolInputError('页码从 1 开始。', '请传入 1 起始的页码。')
    pages.add(page)
  }
  if (pages.size > MAX_SELECTED_PAGES) {
    throw new ToolInputError(
      `一次最多读取 ${MAX_SELECTED_PAGES} 页（当前选择了 ${pages.size} 页）。`,
      '请缩小 pages 范围，分几次读取。'
    )
  }
  return pages.size > 0 ? [...pages].sort((a, b) => a - b) : null
}

function splitPages(text: string): string[] {
  return text.split('\f')
}

export const readPdfTool: ToolImpl = {
  definition: {
    name: 'read_pdf',
    description:
      '读取工作区内 PDF 的文本内容（按页返回）。用于阅读发票、合同、报告等 PDF。' +
      '有文字的页面直接抽取；扫描页会自动用本机 OCR 识别（不联网，每次最多 12 页）。' +
      '数字核对类任务（例如发票合计）必须以抽出的文字为依据，不要臆测。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PDF 文件路径，相对工作区根目录' },
        pages: {
          type: 'string',
          description: '可选：要读取的页码，例如 "1"、"1-3"、"1,3,5"；默认读取全部页'
        },
        max_chars: {
          type: 'number',
          description: `可选：最多返回多少字符（默认 ${DEFAULT_MAX_CHARS}，上限 ${MAX_CHARS_LIMIT}）`
        }
      },
      required: ['path']
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `读取 PDF ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true,
      allowedExternalFiles: ctx.attachedFiles
    })
    if (resolved.isDirectory) {
      throw new ToolInputError(`「${rawPath}」是一个文件夹，不是 PDF 文件。`, '请指定具体的 .pdf 文件。')
    }
    const stat = statSync(resolved.real)
    if (!stat.isFile()) throw new ToolInputError(`「${rawPath}」不是普通文件。`, '请指定具体的 .pdf 文件。')
    if (stat.size > MAX_PDF_BYTES) {
      throw new ToolInputError(
        `PDF 过大（${formatBytes(stat.size)}，上限 ${formatBytes(MAX_PDF_BYTES)}）。`,
        '可以先用其他工具拆分页，或让用户提供精简版。'
      )
    }
    const rawBuffer = readFileSync(resolved.real)
    // 传给 pdf.js 前复制成独立的 Uint8Array：避免 Buffer 视图/底层 ArrayBuffer 在 Electron 打包环境下被复用或偏移
    const buffer = Uint8Array.from(rawBuffer)
    // PDF 规范允许 %PDF- 出现在前 1024 字节内（部分导出器会在前面加 BOM/空行）
    const head = Buffer.from(buffer.subarray(0, 1024)).toString('latin1')
    if (!head.includes('%PDF-')) {
      throw new ToolInputError(
        `「${rawPath}」不是有效的 PDF 文件（缺少 %PDF- 文件头）。`,
        '请确认文件没有损坏、没有改错后缀；如果是 Word/文本文件，请用 read_docx / read_file 读取。'
      )
    }

    let parsed: Awaited<ReturnType<typeof pdfParse>>
    try {
      parsed = await pdfParse(buffer)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/password|encrypt/i.test(message)) {
        throw new ToolExecutionError(
          '这个 PDF 有密码保护或加密，无法直接读取文字。',
          '请让用户提供无密码版本，或把需要的内容复制成文本再处理。'
        )
      }
      throw new ToolExecutionError(
        `解析 PDF 失败：${oneLineInput({ message }, 'message', 200)}`,
        '文件可能已损坏/加密，也可能是扫描件或空文档（没有可提取的文字）。可以先用系统工具确认它能正常打开；不要编造 PDF 内容。'
      )
    }

    const allPages = splitPages(parsed.text)
    const selection = parsePageSelection(getString(input, 'pages', { defaultValue: '' }))
    const maxChars = Math.min(
      Math.max(1, Math.round(getNumber(input, 'max_chars', { defaultValue: DEFAULT_MAX_CHARS, min: 1 }))),
      MAX_CHARS_LIMIT
    )
    const pageNumbers = selection ?? allPages.map((_, index) => index + 1)
    const outOfRange = pageNumbers.filter((page) => page > allPages.length)
    const selected = pageNumbers.filter((page) => page <= allPages.length)

    // 扫描页：本机 OCR（主进程注入）。只识别选中的、确实没有文字的页。
    const ocrTexts = new Map<number, string>()
    const ocrErrors = new Map<number, string>()
    const scannedPages = selected.filter((page) => !(allPages[page - 1] ?? '').trim())
    const ocrTargets = scannedPages.slice(0, MAX_OCR_PAGES)
    let ocrLanguage = ''
    let ocrFailure: string | null = null
    const totalTextBeforeOcr = parsed.text.replace(/\f/g, '').trim()
    if (ocrTargets.length > 0) {
      if (ctx.ocrPdf) {
        ctx.progress(`扫描页：正在用本机 OCR 识别 ${ocrTargets.length} 页…`)
        try {
          const ocr = await ctx.ocrPdf({ path: resolved.real, pages: ocrTargets, signal: ctx.signal })
          ocrLanguage = ocr.language
          for (const page of ocr.pages) {
            if (page.text.trim()) ocrTexts.set(page.page, page.text)
            if (page.error) ocrErrors.set(page.page, page.error)
          }
        } catch (err) {
          ocrFailure = err instanceof Error ? err.message : String(err)
        }
      } else {
        ocrFailure = '当前环境没有可用的本机 OCR'
      }
    }

    if (!totalTextBeforeOcr && ocrTexts.size === 0) {
      const reason = ocrFailure
        ? `本机 OCR 没有完成：${oneLineInput({ value: ocrFailure }, 'value', 220)}`
        : '本机 OCR 未识别到可用文字'
      throw new ToolExecutionError(
        `PDF「${rawPath}」没有可提取的文字（共 ${parsed.numpages} 页）；${reason}。`,
        '请确认这是清晰的正向扫描件，并安装 Windows 中文 OCR 语言包后重试；也可以只读取部分页（pages），或把关键页面截图发给我。不要根据文件名猜内容。'
      )
    }

    const blocks: string[] = []
    let usedChars = 0
    let truncated = false
    for (const page of selected) {
      const pageText = allPages[page - 1] ?? ''
      const ocrText = ocrTexts.get(page) ?? ''
      const remaining = maxChars - usedChars
      if (remaining <= 0) {
        truncated = true
        break
      }
      const source = pageText.trim() || ocrText
      const body = source
        ? truncateText(source.trim(), remaining, '本页内容已截断')
        : scannedPages.includes(page) && !ocrTargets.includes(page)
          ? `（扫描页未识别：本次最多 OCR ${MAX_OCR_PAGES} 页，请缩小 pages 范围）`
          : ocrErrors.has(page)
            ? `（本机 OCR 未能识别本页：${oneLineInput({ value: ocrErrors.get(page) ?? '' }, 'value', 160)}）`
            : '（本页没有可提取文字）'
      const row = `── 第 ${page} 页 ──\n${body}`
      blocks.push(row)
      usedChars += row.length
      if (source && body.length < source.trim().length) truncated = true
    }

    const header =
      `PDF：${displayPath(resolved.absolute, ctx.workspace)}（共 ${parsed.numpages} 页，${formatBytes(stat.size)}）` +
      (ocrTexts.size > 0 ? ` · 本机 OCR 已识别 ${ocrTexts.size} 个扫描页` : '')
    const notes: string[] = []
    if (outOfRange.length > 0) {
      const preview = outOfRange.slice(0, 20).join('、')
      notes.push(
        `页码 ${preview}${outOfRange.length > 20 ? ` 等 ${outOfRange.length} 页` : ''} 超出范围（共 ${parsed.numpages} 页），已忽略`
      )
    }
    if (parsed.info?.Title) notes.push(`文档标题：${oneLineInput(parsed.info, 'Title', 120)}`)
    if (ocrTexts.size > 0) notes.push(`OCR：Windows 本机识别（${ocrLanguage || '系统语言'}），不联网；识别结果可能有错字，关键数字请对照原页复核`)
    if (scannedPages.length > ocrTargets.length) {
      notes.push(
        `还有 ${scannedPages.length - ocrTargets.length} 个扫描页未识别（每次最多 ${MAX_OCR_PAGES} 页）；可以用 pages 分批读取`
      )
    }
    if (ocrFailure && totalTextBeforeOcr) notes.push(`部分扫描页 OCR 失败：${oneLineInput({ value: ocrFailure }, 'value', 180)}`)
    if (truncated) notes.push(`输出已按 max_chars=${maxChars} 截断；可以缩小 pages 范围分段读取`)
    const output = [header, '', ...blocks, ...(notes.length > 0 ? ['', ...notes] : [])].join('\n')
    const meta = {
      path: displayPath(resolved.absolute, ctx.workspace),
      absolutePath: resolved.absolute,
      pages: parsed.numpages,
      pagesRead: selected,
      chars: totalTextBeforeOcr.length + [...ocrTexts.values()].reduce((sum, text) => sum + text.length, 0),
      ...(ocrTexts.size > 0 ? { ocr: true, ocrPages: [...ocrTexts.keys()], ocrLanguage } : {}),
      truncated,
      size: stat.size
    }
    return okResult(output, meta)
  }
}

export const pdfTools: ToolImpl[] = [readPdfTool]
