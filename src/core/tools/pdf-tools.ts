/**
 * PDF 类工具：read_pdf。
 *
 * 解析用 pdf-parse（pdf.js 的 Node 封装，纯 JS）。可靠性优先：
 * - 先校验 %PDF- 文件头与大小上限，损坏/加密文件给可读错误，不把底层异常抛给 Agent；
 * - 保留分页（pdf.js 用 \f 分页），支持 pages 选择；
 * - 抽不出文本时明确告知「可能是扫描件/图片型 PDF」，让模型去要文字版，而不是猜内容。
 */
import { readFileSync, statSync } from 'node:fs'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import type { ToolResult } from '../../shared/types'
import type { ToolContext } from '../types'
import { formatBytes, truncateText } from '../util'
import { getNumber, getString } from './args'
import { ToolExecutionError, ToolInputError } from './errors'
import { displayPath, resolveWorkspacePath } from './paths'
import { okResult, oneLineInput, type ToolImpl } from './types'

const MAX_PDF_BYTES = 100 * 1024 * 1024 // 100MB：正常文档远小于此，避免恶意/超大文件拖垮主进程
const DEFAULT_MAX_CHARS = 60_000
const MAX_CHARS_LIMIT = 200_000

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
      '只抽取文字，不做 OCR：扫描件/纯图片 PDF 可能没有文字，会明确报错而不是猜测内容。' +
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
      requireExist: true
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
    const pdfHeader = Buffer.from(buffer.subarray(0, 5)).toString('latin1')
    if (pdfHeader !== '%PDF-') {
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
    const totalText = parsed.text.replace(/\f/g, '')
    if (!totalText.trim()) {
      throw new ToolExecutionError(
        `PDF「${rawPath}」没有可提取的文字（共 ${parsed.numpages} 页）。`,
        '这很可能是扫描件/图片型 PDF，需要 OCR 或让用户提供文字版；不要根据文件名猜内容。'
      )
    }

    const selection = parsePageSelection(getString(input, 'pages', { defaultValue: '' }))
    const maxChars = Math.min(
      Math.max(1, Math.round(getNumber(input, 'max_chars', { defaultValue: DEFAULT_MAX_CHARS, min: 1 }))),
      MAX_CHARS_LIMIT
    )
    const pageNumbers = selection ?? allPages.map((_, index) => index + 1)
    const outOfRange = pageNumbers.filter((page) => page > allPages.length)
    const selected = pageNumbers.filter((page) => page <= allPages.length)

    const blocks: string[] = []
    let usedChars = 0
    let truncated = false
    for (const page of selected) {
      const pageText = allPages[page - 1] ?? ''
      const remaining = maxChars - usedChars
      if (remaining <= 0) {
        truncated = true
        break
      }
      const body = truncateText(pageText.trim(), remaining, '本页内容已截断')
      const row = `── 第 ${page} 页 ──\n${body || '（本页没有文字）'}`
      blocks.push(row)
      usedChars += row.length
      if (body.length < pageText.trim().length) truncated = true
    }

    const header = `PDF：${displayPath(resolved.absolute, ctx.workspace)}（共 ${parsed.numpages} 页，${formatBytes(stat.size)}）`
    const notes: string[] = []
    if (outOfRange.length > 0) notes.push(`页码 ${outOfRange.join('、')} 超出范围（共 ${parsed.numpages} 页），已忽略`)
    if (parsed.info?.Title) notes.push(`文档标题：${oneLineInput(parsed.info, 'Title', 120)}`)
    if (truncated) notes.push(`输出已按 max_chars=${maxChars} 截断；可以缩小 pages 范围分段读取`)
    const output = [header, '', ...blocks, ...(notes.length > 0 ? ['', ...notes] : [])].join('\n')
    const meta = {
      path: displayPath(resolved.absolute, ctx.workspace),
      absolutePath: resolved.absolute,
      pages: parsed.numpages,
      pagesRead: selected,
      chars: totalText.length,
      truncated,
      size: stat.size
    }
    return okResult(output, meta)
  }
}

export const pdfTools: ToolImpl[] = [readPdfTool]
