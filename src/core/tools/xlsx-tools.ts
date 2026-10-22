/**
 * XLSX 类工具：read_xlsx / write_xlsx。
 *
 * 用 jszip 直接读写 OOXML 包（不依赖 ExcelJS，包体小、行为可控）：
 * - write_xlsx：二维 rows 写入工作表；字符串以 "=" 开头写成**真公式** `<f>`，并用内置求值器
 *   同时写入正确的缓存值 `<v>`（openpyxl data_only / 预览器无需重算也能读到结果）；
 *   `<calcPr fullCalcOnLoad="1"/>` 让 Excel/LibreOffice 打开时按公式重算。
 * - read_xlsx：解析 workbook / sharedStrings / sheet XML，输出表格与公式（含缓存值）；
 *   支持按工作表名或序号选择、A1 区域裁剪、行列上限。
 *
 * 限制（见 docs/DOCUMENT-TOOLS.md）：不解析富文本格式/图表/合并单元格样式；日期单元格按 Excel
 * 序列值输出；跨工作表引用不会被求值器计算缓存值（公式本身仍保真写入）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import JSZip from 'jszip'
import type { ToolResult } from '../../shared/types'
import type { ToolContext } from '../types'
import { formatBytes, sha256, truncateText } from '../util'
import { getBoolean, getNumber, getString } from './args'
import { ToolExecutionError, ToolInputError } from './types'
import { decodeXmlText } from './docx-tools'
import { atomicWriteFileSync, recordRestoreManifest, snapshotFile } from './fs-tools'
import { cellRefToCoord, coordToRef, evaluateSheet, type CellInput } from './xlsx-formula'
import { displayPath, resolveWorkspacePath } from './paths'
import { okResult, oneLineInput, type ToolImpl } from './types'

const MAX_XLSX_BYTES = 50 * 1024 * 1024
const MAX_XML_CHARS = 48 * 1024 * 1024
const MAX_WRITE_ROWS = 20_000
const MAX_WRITE_COLS = 500
const MAX_WRITE_SHEETS = 20
const DEFAULT_READ_ROWS = 200
const MAX_READ_ROWS = 5_000
const DEFAULT_READ_COLS = 50
const MAX_READ_COLS = 500
const MAX_CELL_DISPLAY = 120
const MAX_FORMULAS_LISTED = 300
/** Excel 单元格文本与公式的硬上限（超出后 Excel 会修复/拒绝打开） */
const MAX_CELL_CHARS = 32_767
const MAX_FORMULA_CHARS = 8_192

/* ── XML 小工具（XLSX 部件都是简单 XML，用轻量解析避免引入 DOM） ── */

function stripInvalidXml(text: string): string {
  // XML 1.0 不允许的控制字符：写进 xlsx 会让 Excel 打不开
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
}

function escapeXml(text: string): string {
  return stripInvalidXml(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeXmlAttribute(text: string): string {
  return escapeXml(text).replace(/"/g, '&quot;')
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const regex = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (let match = regex.exec(tag); match; match = regex.exec(tag)) {
    attributes[match[1]] = decodeXmlText(match[2] ?? match[3] ?? '')
  }
  return attributes
}

function collectInlineText(xml: string): string {
  let text = ''
  const regex = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g
  for (let match = regex.exec(xml); match; match = regex.exec(xml)) text += decodeXmlText(match[1])
  return text
}

function xmlText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml)
  return match ? decodeXmlText(match[1]) : null
}

function needsPreserve(text: string): boolean {
  return /^\s|\s$/.test(text) || text.includes('\n')
}

async function loadXlsxZip(resolvedReal: string, display: string): Promise<JSZip> {
  let buffer: Buffer
  try {
    buffer = readFileSync(resolvedReal)
  } catch (err) {
    throw new ToolExecutionError(`读取文件失败：${display}`, err instanceof Error ? err.message : undefined)
  }
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new ToolInputError(
      `「${display}」不是有效的 .xlsx 文件（不是 ZIP 容器，可能是 .xls 旧格式或文件损坏）。`,
      '请确认文件是 Excel 2007+ 的 .xlsx；旧版 .xls 需要先另存为 .xlsx。'
    )
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw new ToolInputError(`「${display}」的 XLSX 包已损坏，无法解压。`, '文件可能下载不完整或被加密；请让用户提供可正常打开的 .xlsx。')
  }
  if (!zip.file('xl/workbook.xml')) {
    throw new ToolInputError(`「${display}」里没有 xl/workbook.xml，不是 Excel 工作簿。`, '这个文件可能是 Word/PPT 改后缀，或加密文档。请确认格式。')
  }
  return zip
}

async function readZipXml(zip: JSZip, entryName: string): Promise<string> {
  const entry = zip.file(entryName)
  if (!entry) return ''
  const text = await entry.async('string')
  if (text.length > MAX_XML_CHARS) throw new ToolExecutionError(`工作簿部件 ${entryName} 过大，无法安全解析。`, '请拆分工作簿。')
  return text
}

function normalizePartTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  return `xl/${target}`
}

function cleanPathPart(part: string): string {
  const segments: string[] = []
  for (const segment of part.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/')
}

/* ── 工作簿结构解析 ───────────────────────────────────────────── */

export interface WorkbookSheetRef {
  name: string
  sheetId: string
  state: string
  part: string
}

interface WorkbookParts {
  sheets: WorkbookSheetRef[]
  sharedStrings: string[]
}

function parseWorkbookParts(workbookXml: string, relsXml: string): WorkbookParts {
  const rels = new Map<string, string>()
  const relRegex = /<Relationship\b([^>]*?)\/?>/g
  for (let match = relRegex.exec(relsXml); match; match = relRegex.exec(relsXml)) {
    const attrs = parseAttributes(match[1])
    if (attrs.Id && attrs.Target) rels.set(attrs.Id, cleanPathPart(normalizePartTarget(attrs.Target)))
  }
  const sheets: WorkbookSheetRef[] = []
  const sheetRegex = /<sheet\b([^>]*?)\/?>/g
  for (let match = sheetRegex.exec(workbookXml); match; match = sheetRegex.exec(workbookXml)) {
    const attrs = parseAttributes(match[1])
    const relId = attrs['r:id'] ?? ''
    const part = rels.get(relId)
    if (!attrs.name || !part) continue
    sheets.push({ name: attrs.name, sheetId: attrs.sheetId ?? String(sheets.length + 1), state: attrs.state ?? 'visible', part })
  }
  return { sheets, sharedStrings: [] }
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = []
  const siRegex = /<si\b(?:\s[^>]*)?>([\s\S]*?)<\/si>/g
  for (let match = siRegex.exec(xml); match; match = siRegex.exec(xml)) {
    strings.push(collectInlineText(match[1]))
    if (strings.length > 200_000) break
  }
  return strings
}

/* ── 单元格解析（读写校验共用） ───────────────────────────────── */

export interface ParsedCell {
  ref: string
  column: number
  row: number
  type: string
  formula?: string
  rawValue?: string
  inlineText?: string
  styleIndex?: number
}

function cellDisplay(cell: ParsedCell, sharedStrings: string[]): string {
  if (cell.formula) return `=${cell.formula}`
  const type = cell.type
  if (type === 's') {
    const index = Number(cell.rawValue)
    return Number.isInteger(index) ? (sharedStrings[index] ?? '') : ''
  }
  if (type === 'inlineStr') return cell.inlineText ?? ''
  if (type === 'str') return cell.rawValue ?? ''
  if (type === 'b') return cell.rawValue === '1' ? 'TRUE' : 'FALSE'
  if (type === 'e') return cell.rawValue ?? '#ERROR'
  return cell.rawValue ?? ''
}

interface ParsedSheetCells {
  cells: ParsedCell[]
  truncated: boolean
}

function parseSheetCells(sheetXml: string): ParsedSheetCells {
  const cells: ParsedCell[] = []
  const rowRegex = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
  let inferredRow = 0
  for (let rowMatch = rowRegex.exec(sheetXml); rowMatch; rowMatch = rowRegex.exec(sheetXml)) {
    const rowAttrs = parseAttributes(rowMatch[1])
    const rowNumber = rowAttrs.r ? Number(rowAttrs.r) : inferredRow + 1
    inferredRow = rowNumber
    const rowContent = rowMatch[2] ?? ''
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let inferredColumn = 0
    for (let cellMatch = cellRegex.exec(rowContent); cellMatch; cellMatch = cellRegex.exec(rowContent)) {
      const attrs = parseAttributes(cellMatch[1])
      const content = cellMatch[2] ?? ''
      let column = inferredColumn
      const ref = attrs.r
      if (ref) {
        const coord = cellRefToCoord(ref)
        if (coord) column = coord.column
      }
      inferredColumn = column + 1
      const formula = xmlText(content, 'f')
      const value = xmlText(content, 'v')
      const inlineMatch = /<is>([\s\S]*?)<\/is>/.exec(content)
      cells.push({
        ref: ref ?? coordToRef(column, Math.max(0, rowNumber - 1)),
        column,
        row: Math.max(0, rowNumber - 1),
        type: attrs.t ?? 'n',
        ...(formula !== null ? { formula } : {}),
        ...(value !== null ? { rawValue: value } : {}),
        ...(inlineMatch ? { inlineText: collectInlineText(inlineMatch[1]) } : {}),
        ...(attrs.s ? { styleIndex: Number(attrs.s) } : {})
      })
      if (cells.length >= 200_000) return { cells, truncated: true }
    }
  }
  return { cells, truncated: false }
}

/* ── read_xlsx ────────────────────────────────────────────────── */

interface ReadRange {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

function parseA1Range(range: string): ReadRange | null {
  const text = range.trim()
  if (!text) return null
  const simple = /^([A-Za-z]{1,3}\d{1,7})(?::([A-Za-z]{1,3}\d{1,7}))?$/.exec(text)
  if (!simple) throw new ToolInputError(`range 参数不合法：「${range}」。`, '请使用 A1 记法，例如 "A1:D10" 或单个单元格 "B2"。')
  const start = cellRefToCoord(simple[1])
  if (!start) throw new ToolInputError(`range 起点不合法：「${simple[1]}」。`, '请使用 A1 记法，例如 "A1:D10"。')
  const end = simple[2] ? cellRefToCoord(simple[2]) : cellRefToCoord(simple[1])
  if (!end) throw new ToolInputError(`range 终点不合法：「${simple[2]}」。`, '请使用 A1 记法，例如 "A1:D10"。')
  return {
    startRow: Math.min(start.row, end.row),
    startColumn: Math.min(start.column, end.column),
    endRow: Math.max(start.row, end.row),
    endColumn: Math.max(start.column, end.column)
  }
}

function markdownTable(matrix: string[][]): string[] {
  if (matrix.length === 0) return ['（空表）']
  const columns = matrix.reduce((max, row) => Math.max(max, row.length), 0)
  const escapeCell = (value: string): string => {
    const flat = value.replace(/\r?\n/g, '⏎').replace(/\|/g, '\\|')
    return flat.length > MAX_CELL_DISPLAY ? `${flat.slice(0, MAX_CELL_DISPLAY)}…` : flat
  }
  const lines = [`| ${Array.from({ length: columns }, (_, index) => `列${coordToRef(index, 0).replace(/\d+$/, '')}`).join(' | ')} |`]
  lines.push(`| ${Array.from({ length: columns }, () => '---').join(' | ')} |`)
  for (const row of matrix) {
    lines.push(`| ${Array.from({ length: columns }, (_, index) => escapeCell(row[index] ?? '')).join(' | ')} |`)
  }
  return lines
}

function resolveSheetSelection(sheets: WorkbookSheetRef[], raw: string): WorkbookSheetRef[] {
  if (!raw) return sheets
  const byName = sheets.find((sheet) => sheet.name === raw)
  if (byName) return [byName]
  if (/^\d+$/.test(raw)) {
    const byIndex = sheets[Number(raw) - 1]
    if (byIndex) return [byIndex]
    throw new ToolInputError(
      `工作表序号 ${raw} 超出范围（共 ${sheets.length} 个）。`,
      `可用工作表：${sheets.map((sheet, index) => `${index + 1}. ${sheet.name}`).join('、')}`
    )
  }
  throw new ToolInputError(
    `没有名为「${raw}」的工作表。`,
    `可用工作表：${sheets.map((sheet, index) => `${index + 1}. ${sheet.name}`).join('、')}`
  )
}

export const readXlsxTool: ToolImpl = {
  definition: {
    name: 'read_xlsx',
    description:
      '读取工作区内 Excel（.xlsx）工作簿：按工作表输出表格数据（含公式文本与缓存值）。' +
      '可用 sheet 选择工作表（名称或 1 起始序号）、range 裁剪 A1 区域；默认每个工作表最多读 200 行 × 50 列。' +
      '只支持 .xlsx；日期单元格按 Excel 序列数字显示，富文本/图表/合并样式不展开。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'XLSX 文件路径，相对工作区根目录' },
        sheet: { type: 'string', description: '可选：工作表名称或 1 起始序号（默认读取全部工作表）' },
        range: { type: 'string', description: '可选：A1 区域，例如 "A1:D10"（只对选中的工作表生效）' },
        max_rows: { type: 'number', description: `每个工作表最多显示行数（默认 ${DEFAULT_READ_ROWS}，上限 ${MAX_READ_ROWS}）` },
        max_cols: { type: 'number', description: `每个工作表最多显示列数（默认 ${DEFAULT_READ_COLS}，上限 ${MAX_READ_COLS}）` },
        include_formulas: { type: 'boolean', description: '是否在表格后列出公式清单（默认 true）' }
      },
      required: ['path']
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `读取 Excel ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true,
      allowedExternalFiles: ctx.attachedFiles
    })
    if (resolved.isDirectory) throw new ToolInputError(`「${rawPath}」是一个文件夹，不是 Excel 文件。`, '请指定具体的 .xlsx 文件。')
    const stat = statSync(resolved.real)
    if (!stat.isFile()) throw new ToolInputError(`「${rawPath}」不是普通文件。`, '请指定具体的 .xlsx 文件。')
    if (stat.size > MAX_XLSX_BYTES) {
      throw new ToolInputError(`XLSX 过大（${formatBytes(stat.size)}，上限 ${formatBytes(MAX_XLSX_BYTES)}）。`, '请拆分工作簿后重试。')
    }
    const display = displayPath(resolved.absolute, ctx.workspace)
    const zip = await loadXlsxZip(resolved.real, display)
    const workbookXml = await readZipXml(zip, 'xl/workbook.xml')
    const relsXml = await readZipXml(zip, 'xl/_rels/workbook.xml.rels')
    const parts = parseWorkbookParts(workbookXml, relsXml)
    if (parts.sheets.length === 0) throw new ToolExecutionError('工作簿里没有任何工作表。', '文件可能已损坏；请让用户提供正常文件。')
    const sharedStringsXml = await readZipXml(zip, 'xl/sharedStrings.xml')
    const sharedStrings = parseSharedStrings(sharedStringsXml)

    const selected = resolveSheetSelection(parts.sheets, getString(input, 'sheet', { defaultValue: '' }))
    const requestedRange = parseA1Range(getString(input, 'range', { defaultValue: '' }))
    const maxRows = Math.min(
      Math.max(1, Math.round(getNumber(input, 'max_rows', { defaultValue: DEFAULT_READ_ROWS, min: 1 }))),
      MAX_READ_ROWS
    )
    const maxCols = Math.min(
      Math.max(1, Math.round(getNumber(input, 'max_cols', { defaultValue: DEFAULT_READ_COLS, min: 1 }))),
      MAX_READ_COLS
    )
    const includeFormulas = getBoolean(input, 'include_formulas', true)

    const sections: string[] = [`Excel 工作簿：${display}（${parts.sheets.length} 个工作表，${formatBytes(stat.size)}）`]
    const sheetMeta: Array<Record<string, unknown>> = []
    let truncatedAny = false
    for (const sheet of selected) {
      const sheetXml = await readZipXml(zip, sheet.part)
      if (!sheetXml) {
        sections.push(`\n## 工作表：${sheet.name}\n（缺少工作表数据，文件可能损坏）`)
        continue
      }
      const parsedSheet = parseSheetCells(sheetXml)
      const cells = parsedSheet.cells
      const range = requestedRange ?? null
      const rowsMap = new Map<number, Map<number, ParsedCell>>()
      let maxRow = 0
      let maxColumn = 0
      for (const cell of cells) {
        if (range) {
          if (cell.row < range.startRow || cell.row > range.endRow) continue
          if (cell.column < range.startColumn || cell.column > range.endColumn) continue
        }
        maxRow = Math.max(maxRow, cell.row)
        maxColumn = Math.max(maxColumn, cell.column)
        const rowCells = rowsMap.get(cell.row) ?? new Map<number, ParsedCell>()
        rowCells.set(cell.column, cell)
        rowsMap.set(cell.row, rowCells)
      }
      const startRow = range?.startRow ?? 0
      const startColumn = range?.startColumn ?? 0
      const lastRow = Math.min(maxRow, startRow + maxRows - 1)
      const lastColumn = Math.min(maxColumn, startColumn + maxCols - 1)
      const truncated = maxRow > lastRow || maxColumn > lastColumn || parsedSheet.truncated
      if (truncated) truncatedAny = true
      const matrix: string[][] = []
      const formulas: string[] = []
      for (let row = startRow; row <= lastRow; row += 1) {
        const values: string[] = []
        for (let column = startColumn; column <= lastColumn; column += 1) {
          const cell = rowsMap.get(row)?.get(column)
          values.push(cell ? cellDisplay(cell, sharedStrings) : '')
          if (cell?.formula && includeFormulas && formulas.length < MAX_FORMULAS_LISTED) {
            const cached = cell.rawValue !== undefined && cell.rawValue !== '' ? `（缓存值：${cell.rawValue}）` : '（无缓存值）'
            formulas.push(`${cell.ref} = ${cell.formula}${cached}`)
          }
        }
        matrix.push(values)
      }
      const rangeLabel = matrix.length > 0 ? `${coordToRef(startColumn, startRow)}:${coordToRef(lastColumn, lastRow)}` : '（空）'
      const formulaCount = cells.filter((cell) => cell.formula).length
      const sheetLines = [
        `\n## 工作表：${sheet.name}${sheet.state !== 'visible' ? `（${sheet.state}）` : ''}`,
        `区域 ${rangeLabel}（${matrix.length} 行 × ${matrix[0]?.length ?? 0} 列${truncated ? '，已按上限截断' : ''}；公式 ${formulaCount} 个）`,
        '',
        ...markdownTable(matrix)
      ]
      if (includeFormulas && formulas.length > 0) {
        sheetLines.push('', '公式：', ...formulas.map((formula) => `- ${formula}`))
      }
      if (parsedSheet.truncated) {
        sheetLines.push('', '（工作表单元格超过 20 万个，只解析了前 20 万个；请用 range 缩小范围）')
      }
      sections.push(sheetLines.join('\n'))
      sheetMeta.push({
        name: sheet.name,
        state: sheet.state,
        range: rangeLabel,
        rows: matrix.length,
        columns: matrix[0]?.length ?? 0,
        formulas: formulaCount,
        truncated,
        cellsTruncated: parsedSheet.truncated
      })
    }
    if (truncatedAny) sections.push('\n（有工作表超出显示上限，可用 range / max_rows / max_cols 分段读取。）')
    const output = truncateText(sections.join('\n'), 120_000)
    return okResult(output, {
      path: display,
      absolutePath: resolved.absolute,
      sheets: sheetMeta,
      sharedStrings: sharedStrings.length,
      size: stat.size,
      truncated: truncatedAny
    })
  }
}

/* ── write_xlsx ───────────────────────────────────────────────── */

interface WriteSheetInput {
  name: string
  rows: CellInput[][]
}

function normalizeSheetName(raw: string, index: number, used: Set<string>): string {
  let name = (raw || '').trim() || `Sheet${index + 1}`
  name = name.replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '')
  if (name.length > 31) name = name.slice(0, 31)
  if (!name) name = `Sheet${index + 1}`
  let candidate = name
  let suffix = 2
  while (used.has(candidate.toLowerCase())) {
    const tail = `_${suffix}`
    candidate = `${name.slice(0, 31 - tail.length)}${tail}`
    suffix += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

export function parseWriteSheets(raw: unknown): WriteSheetInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolInputError(
      '缺少 sheets：write_xlsx 至少需要一个工作表。',
      '例如 sheets: [{"name": "Sales", "rows": [["Item","Qty"],["Pen",2]]}]'
    )
  }
  if (raw.length > MAX_WRITE_SHEETS) {
    throw new ToolInputError(`工作表过多（${raw.length}，上限 ${MAX_WRITE_SHEETS}）。`, '请合并工作表后重试。')
  }
  const used = new Set<string>()
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new ToolInputError('sheets 的每一项都必须是 {name, rows} 对象。', '例如 {"name": "Sales", "rows": [[...]]}')
    }
    const record = item as Record<string, unknown>
    const name = normalizeSheetName(typeof record.name === 'string' ? record.name : '', index, used)
    if (!Array.isArray(record.rows)) {
      throw new ToolInputError(`工作表「${name}」缺少 rows（二维数组）。`, 'rows 的例子：[["Item","Qty","Price"],["Pen",2,3]]')
    }
    if (record.rows.length > MAX_WRITE_ROWS) {
      throw new ToolInputError(`工作表「${name}」行数过多（${record.rows.length}，上限 ${MAX_WRITE_ROWS}）。`, '请拆分工作簿。')
    }
    const rows: CellInput[][] = record.rows.map((row, rowIndex) => {
      if (!Array.isArray(row)) {
        throw new ToolInputError(`工作表「${name}」第 ${rowIndex + 1} 行不是数组。`, '每一行都必须是单元格值数组。')
      }
      if (row.length > MAX_WRITE_COLS) {
        throw new ToolInputError(`工作表「${name}」第 ${rowIndex + 1} 行单元格过多（${row.length}，上限 ${MAX_WRITE_COLS}）。`, '请缩减列数。')
      }
      return row.map((cell) => {
        if (cell === undefined || cell === null || cell === '') return null
        if (typeof cell === 'string') {
          if (cell.startsWith('=') && cell.length - 1 > MAX_FORMULA_CHARS) {
            throw new ToolInputError(
              `工作表「${name}」第 ${rowIndex + 1} 行有公式过长（${cell.length - 1} 字符，Excel 上限 ${MAX_FORMULA_CHARS}）。`,
              '请缩短公式或拆成多个单元格。'
            )
          }
          if (!cell.startsWith('=') && cell.length > MAX_CELL_CHARS) {
            throw new ToolInputError(
              `工作表「${name}」第 ${rowIndex + 1} 行有单元格文本过长（${cell.length} 字符，Excel 上限 ${MAX_CELL_CHARS}）。`,
              '请拆分到多个单元格或缩短文本。'
            )
          }
          return cell
        }
        if (typeof cell === 'number') {
          if (!Number.isFinite(cell)) throw new ToolInputError(`工作表「${name}」第 ${rowIndex + 1} 行包含非有限数字。`, '请检查数字。')
          return cell
        }
        if (typeof cell === 'boolean') return cell
        throw new ToolInputError(
          `工作表「${name}」第 ${rowIndex + 1} 行包含不支持的值类型（${typeof cell}）。`,
          '单元格只支持字符串/数字/布尔/null。'
        )
      })
    })
    return { name, rows }
  })
}

function cellXml(ref: string, raw: CellInput, cached?: { value: CellInput; error?: string }): string {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw === 'string' && raw.startsWith('=') && raw.length > 1) {
    const formula = raw.slice(1)
    const common = `r="${ref}"`
    const formulaXml = `<f>${escapeXml(formula)}</f>`
    if (!cached || cached.value === null || cached.error) return `<c ${common}>${formulaXml}</c>`
    if (typeof cached.value === 'number') return `<c ${common}>${formulaXml}<v>${cached.value}</v></c>`
    if (typeof cached.value === 'boolean') return `<c ${common} t="b">${formulaXml}<v>${cached.value ? 1 : 0}</v></c>`
    return `<c ${common} t="str">${formulaXml}<v>${escapeXml(String(cached.value))}</v></c>`
  }
  if (typeof raw === 'number') return `<c r="${ref}"><v>${raw}</v></c>`
  if (typeof raw === 'boolean') return `<c r="${ref}" t="b"><v>${raw ? 1 : 0}</v></c>`
  const preserve = needsPreserve(raw) ? ' xml:space="preserve"' : ''
  return `<c r="${ref}" t="inlineStr"><is><t${preserve}>${escapeXml(raw)}</t></is></c>`
}

function buildSheetXml(rows: CellInput[][], cached: Map<string, { value: CellInput; error?: string }>): string {
  const rowXmls: string[] = []
  let maxRow = 0
  let maxColumn = 0
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? []
    const cells: string[] = []
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const value = row[columnIndex]
      if (value === undefined || value === null || value === '') continue
      const ref = coordToRef(columnIndex, rowIndex)
      cells.push(cellXml(ref, value, cached.get(ref)))
      maxRow = Math.max(maxRow, rowIndex + 1)
      maxColumn = Math.max(maxColumn, columnIndex + 1)
    }
    if (cells.length > 0) rowXmls.push(`<row r="${rowIndex + 1}">${cells.join('')}</row>`)
  }
  const dimension = maxRow > 0 ? `A1:${coordToRef(maxColumn - 1, maxRow - 1)}` : 'A1'
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="${dimension}"/>` +
    `<sheetData>${rowXmls.join('')}</sheetData>` +
    '</worksheet>'
  )
}

function buildWorkbookXml(sheets: WriteSheetInput[]): string {
  const entries = sheets
    .map((sheet, index) => `<sheet name="${escapeXmlAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${entries}</sheets>` +
    '<calcPr calcId="191029" fullCalcOnLoad="1"/>' +
    '</workbook>'
  )
}

function buildWorkbookRelsXml(sheetCount: number): string {
  const relationships: string[] = []
  for (let index = 0; index < sheetCount; index += 1) {
    relationships.push(
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )
  }
  relationships.push(
    `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
  )
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    relationships.join('') +
    '</Relationships>'
  )
}

function buildContentTypesXml(sheetCount: number): string {
  const overrides: string[] = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  ]
  for (let index = 0; index < sheetCount; index += 1) {
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.join('') +
    '</Types>'
  )
}

function buildRootRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'
  )
}

function buildStylesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  )
}

interface FormulaCellMeta {
  sheet: string
  ref: string
  formula: string
  cached: CellInput
  error?: string
}

async function buildWorkbookBuffer(sheets: WriteSheetInput[]): Promise<{ buffer: Buffer; formulas: FormulaCellMeta[] }> {
  const zip = new JSZip()
  const formulas: FormulaCellMeta[] = []
  zip.file('[Content_Types].xml', buildContentTypesXml(sheets.length))
  zip.file('_rels/.rels', buildRootRelsXml())
  zip.file('xl/workbook.xml', buildWorkbookXml(sheets))
  zip.file('xl/_rels/workbook.xml.rels', buildWorkbookRelsXml(sheets.length))
  zip.file('xl/styles.xml', buildStylesXml())
  for (let index = 0; index < sheets.length; index += 1) {
    const sheet = sheets[index]
    const evaluated = evaluateSheet(sheet.rows)
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, buildSheetXml(sheet.rows, evaluated))
    for (const [ref, result] of evaluated) {
      const row = cellRefToCoord(ref)
      const raw = row ? sheet.rows[row.row]?.[row.column] : undefined
      if (typeof raw !== 'string' || !raw.startsWith('=')) continue
      formulas.push({ sheet: sheet.name, ref, formula: raw.slice(1), cached: result.value, ...(result.error ? { error: result.error } : {}) })
    }
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return { buffer, formulas }
}

/** 重新解包 + 解析，确认公式单元格真的按期望写入了（写入自检，失败就不交付） */
async function verifyWorkbookBuffer(
  buffer: Buffer,
  sheets: WriteSheetInput[],
  formulas: FormulaCellMeta[]
): Promise<{ sheetCount: number; formulaCount: number; cachedCount: number }> {
  const zip = await JSZip.loadAsync(buffer)
  const workbookXml = await readZipXml(zip, 'xl/workbook.xml')
  const relsXml = await readZipXml(zip, 'xl/_rels/workbook.xml.rels')
  const parts = parseWorkbookParts(workbookXml, relsXml)
  if (parts.sheets.length !== sheets.length) {
    throw new ToolExecutionError(`写入自检失败：工作表数量不一致（期望 ${sheets.length}，实际 ${parts.sheets.length}）。`, '这是工具内部错误，请重试或换一种方式生成。')
  }
  let cachedCount = 0
  for (const formula of formulas) {
    if (formula.cached !== null && !formula.error) cachedCount += 1
  }
  // 逐个校验公式：解析回读，公式文本必须一致（缓存值存在时也要保留）
  const expected = new Map(formulas.map((formula) => [`${formula.sheet}!${formula.ref}`, formula]))
  for (const sheet of parts.sheets) {
    const xml = await readZipXml(zip, sheet.part)
    for (const cell of parseSheetCells(xml).cells) {
      const match = expected.get(`${sheet.name}!${cell.ref}`)
      if (!match) continue
      if (cell.formula !== match.formula) {
        throw new ToolExecutionError(
          `写入自检失败：${sheet.name}!${cell.ref} 的公式没有正确写入（期望 ${match.formula}，实际 ${cell.formula ?? '空'}）。`,
          '这是工具内部错误，请重试。'
        )
      }
      if (match.cached !== null && !match.error && cell.rawValue === undefined) {
        throw new ToolExecutionError(`写入自检失败：${sheet.name}!${cell.ref} 缺少缓存值。`, '这是工具内部错误，请重试。')
      }
    }
  }
  return { sheetCount: parts.sheets.length, formulaCount: formulas.length, cachedCount }
}

export const writeXlsxTool: ToolImpl = {
  definition: {
    name: 'write_xlsx',
    description:
      '在工作区生成 Excel（.xlsx）工作簿。sheets 里每个工作表传 name 与二维 rows；单元格支持字符串/数字/布尔/null，' +
      '**字符串以 "=" 开头会写成真公式**（例如 "=B2*C2"、"=SUM(D2:D3)"），工具会同时写入正确缓存值，Excel 打开时也会重算。' +
      '生成后会重新解包自检公式与单元格，确保文件可打开、公式保真；不是截图或改后缀文件。覆盖已有文件前会备份（可撤销）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出 .xlsx 路径，相对工作区根目录（如 "out/sales.xlsx"）' },
        sheets: {
          type: 'array',
          description: '工作表列表（至少一个）',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '工作表名（默认 SheetN；不能含 []:*?/\\ 且不超过 31 字符）' },
              rows: {
                type: 'array',
                description: '二维单元格数组；字符串以 "=" 开头表示公式',
                items: { type: 'array', items: {} }
              }
            },
            required: ['name', 'rows']
          }
        }
      },
      required: ['path', 'sheets']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `生成 Excel ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const sheets = parseWriteSheets(input.sheets)
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, { escapeApproved: ctx.escapeApproved })
    if (resolved.isDirectory) throw new ToolInputError(`「${rawPath}」是一个文件夹，不能当文件写入。`, '请指定 .xlsx 文件路径。')
    if (/\.(xls|xlsb|xlsm|ods)$/i.test(rawPath)) {
      throw new ToolInputError('旧版/宏/ODS 表格格式不支持，请使用 .xlsx。', '把输出路径改成 .xlsx；旧格式需要先另存为 .xlsx。')
    }
    if (!/\.xlsx$/i.test(resolved.absolute)) throw new ToolInputError('path 必须以 .xlsx 结尾。', '例如 out/sales.xlsx（避免生成无法打开的伪表格文件）。')
    const display = displayPath(resolved.absolute, ctx.workspace)
    const { buffer, formulas } = await buildWorkbookBuffer(sheets)
    const verification = await verifyWorkbookBuffer(buffer, sheets, formulas)

    const existed = existsSync(resolved.absolute) && statSync(resolved.absolute).isFile()
    const snapshot = existed ? snapshotFile(resolved.absolute, ctx) : null
    atomicWriteFileSync(resolved.real, buffer)
    const afterHash = sha256(buffer)
    recordRestoreManifest(ctx, resolved.absolute, snapshot?.beforeHash ?? null, afterHash)

    const formulaLines = formulas.slice(0, 40).map((formula) => {
      const cached = formula.error ? '（未计算缓存值）' : `（缓存值 ${formula.cached}）`
      return `- ${formula.sheet}!${formula.ref} = ${formula.formula}${cached}`
    })
    const sheetLines = sheets.map((sheet) => {
      const columns = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0)
      return `- ${sheet.name}：${sheet.rows.length} 行 × ${columns} 列`
    })
    const lines = [
      `已生成 ${display}（${formatBytes(buffer.length)}，${sheets.length} 个工作表）`,
      ...sheetLines,
      formulas.length > 0
        ? `公式 ${formulas.length} 个（真公式 + 缓存值，Excel/LibreOffice 打开时自动重算）：\n${formulaLines.join('\n')}`
        : '本次没有公式单元格。',
      `写入自检：重新解包校验通过（${verification.sheetCount} 个工作表，${verification.formulaCount} 个公式，${verification.cachedCount} 个带缓存值）。`,
      snapshot ? '旧文件已备份，可撤销。' : ''
    ].filter(Boolean)
    return okResult(lines.join('\n'), {
      path: display,
      absolutePath: resolved.absolute,
      sheets: sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length, columns: sheet.rows.reduce((max, row) => Math.max(max, row.length), 0) })),
      formulas: formulas.map((formula) => ({
        sheet: formula.sheet,
        ref: formula.ref,
        formula: formula.formula,
        cached: formula.cached,
        ...(formula.error ? { error: formula.error } : {})
      })),
      formulaCount: formulas.length,
      bytes: buffer.length,
      created: !existed,
      snapshotId: snapshot?.snapshotId ?? null,
      snapshotPath: snapshot?.snapshotPath ?? null,
      beforeHash: snapshot?.beforeHash ?? null,
      afterHash
    })
  }
}

export const xlsxTools: ToolImpl[] = [readXlsxTool, writeXlsxTool]
