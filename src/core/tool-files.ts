// 文件系统与文档工具：由 core/tool-* 扁平合并。
import { createHash, randomBytes } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ToolResult } from '../shared/types'
import type { ToolContext } from './types'
import { clampInt, formatBytes, sha256, truncateText } from './util'
import { getBoolean, getNumber, getString } from './tool-kit'
import { createUnifiedDiff, diffSummary } from './tool-kit'
import type { ToolImpl } from './tool-kit'
import { ToolInputError, errResult, okResult, oneLineInput, ToolExecutionError } from './tool-kit'
import { displayPath, resolveWorkspacePath } from './tool-kit'
import JSZip from 'jszip'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

// 极简 Excel 公式求值器：只为 write_xlsx 计算「缓存值」用（写入真公式的同时带上正确结果，

export type CellValue = string | number | boolean | null

export type CellInput = CellValue | undefined


export interface FormulaEvalOptions {
  /** 最多求值单元格数，避免病态工作簿拖慢主进程 */
  maxCells?: number
}


export interface EvaluatedCell {
  /** 缓存值；null = 无法求值（公式仍会写入，但不带缓存结果） */
  value: CellValue
  error?: string
}


const MAX_CELLS = 20_000


export function coordToRef(column: number, row: number): string {
  let col = column + 1
  let label = ''
  while (col > 0) {
    const remainder = (col - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    col = Math.floor((col - 1) / 26)
  }
  return `${label}${row + 1}`
}


export function cellRefToCoord(ref: string): { column: number; row: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim())
  if (!match) return null
  let column = 0
  const letters = match[1].toUpperCase()
  for (const char of letters) column = column * 26 + (char.charCodeAt(0) - 64)
  const row = Number(match[2])
  if (column < 1 || column > 16_384 || row < 1 || row > 1_048_576) return null
  return { column: column - 1, row: row - 1 }
}


type Token =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'ref'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }


class FormulaError extends Error {}


function tokenize(formula: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < formula.length) {
    const char = formula[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (/\d/.test(char) || (char === '.' && /\d/.test(formula[index + 1] ?? ''))) {
      const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(formula.slice(index))
      if (!match) throw new FormulaError('数字格式错误')
      tokens.push({ type: 'number', value: Number(match[0]) })
      index += match[0].length
      continue
    }
    if (char === '"') {
      let cursor = index + 1
      let value = ''
      for (;;) {
        if (cursor >= formula.length) throw new FormulaError('字符串缺少结束引号')
        if (formula[cursor] === '"') {
          if (formula[cursor + 1] === '"') {
            value += '"'
            cursor += 2
            continue
          }
          cursor += 1
          break
        }
        value += formula[cursor]
        cursor += 1
      }
      tokens.push({ type: 'string', value })
      index = cursor
      continue
    }
    const refMatch = /^\$?[A-Za-z]{1,3}\$?\d{1,7}(?:\.\.\.)?/.exec(formula.slice(index))
    if (refMatch) {
      tokens.push({ type: 'ref', value: refMatch[0] })
      index += refMatch[0].length
      continue
    }
    const identMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(formula.slice(index))
    if (identMatch) {
      tokens.push({ type: 'ident', value: identMatch[0] })
      index += identMatch[0].length
      continue
    }
    const twoChar = formula.slice(index, index + 2)
    if (['<=', '>=', '<>'].includes(twoChar)) {
      tokens.push({ type: 'op', value: twoChar })
      index += 2
      continue
    }
    if ('+-*/^%&(),:<>'.includes(char)) {
      tokens.push({ type: 'op', value: char })
      index += 1
      continue
    }
    throw new FormulaError(`无法识别的字符：${char}`)
  }
  return tokens
}


type RangeValue = { range: CellInput[][] }

type RuntimeValue = CellValue | RangeValue


function isRange(value: RuntimeValue): value is RangeValue {
  return typeof value === 'object' && value !== null && 'range' in value
}


function toNumber(value: RuntimeValue): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return 0
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new FormulaError('无法把值转换为数字')
}


function flatten(values: RuntimeValue[]): CellInput[] {
  const output: CellInput[] = []
  for (const value of values) {
    if (isRange(value)) {
      for (const row of value.range) output.push(...row)
    } else output.push(value as CellInput)
  }
  return output
}


function round(value: number, digits: number): number {
  const factor = 10 ** Math.trunc(digits)
  return Math.round(value * factor) / factor
}


class Parser {
  private position = 0

  constructor(
    private readonly tokens: Token[],
    private readonly getCell: (ref: string) => CellValue,
    private readonly getRange: (from: string, to: string) => CellInput[][]
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.position]
  }

  private next(): Token {
    const token = this.tokens[this.position]
    if (!token) throw new FormulaError('公式意外结束')
    this.position += 1
    return token
  }

  private matchOp(value: string): boolean {
    const token = this.peek()
    if (token && token.type === 'op' && token.value === value) {
      this.position += 1
      return true
    }
    return false
  }

  private expectOp(value: string): void {
    if (!this.matchOp(value)) throw new FormulaError(`缺少运算符 ${value}`)
  }

  parse(): RuntimeValue {
    const value = this.parseComparison()
    if (this.position !== this.tokens.length) throw new FormulaError('公式里有多余内容')
    return value
  }

  private parseComparison(): RuntimeValue {
    let left = this.parseConcat()
    for (;;) {
      const token = this.peek()
      if (!token || token.type !== 'op' || !['=', '<>', '<', '>', '<=', '>='].includes(token.value)) return left
      this.position += 1
      const right = this.parseConcat()
      const a = isRange(left) ? toNumber(left) : left
      const b = isRange(right) ? toNumber(right) : right
      switch (token.value) {
        case '=':
          left = String(a) === String(b)
          break
        case '<>':
          left = String(a) !== String(b)
          break
        case '<':
          left = toNumber(a) < toNumber(b)
          break
        case '>':
          left = toNumber(a) > toNumber(b)
          break
        case '<=':
          left = toNumber(a) <= toNumber(b)
          break
        default:
          left = toNumber(a) >= toNumber(b)
      }
    }
  }

  private parseConcat(): RuntimeValue {
    let left = this.parseAdditive()
    while (this.matchOp('&')) {
      const right = this.parseAdditive()
      left = `${left === null ? '' : isRange(left) ? '' : String(left)}${right === null ? '' : isRange(right) ? '' : String(right)}`
    }
    return left
  }

  private parseAdditive(): RuntimeValue {
    let left = this.parseMultiplicative()
    for (;;) {
      if (this.matchOp('+')) {
        const right = this.parseMultiplicative()
        left = toNumber(left) + toNumber(right)
      } else if (this.matchOp('-')) {
        const right = this.parseMultiplicative()
        left = toNumber(left) - toNumber(right)
      } else return left
    }
  }

  private parseMultiplicative(): RuntimeValue {
    let left = this.parsePower()
    for (;;) {
      if (this.matchOp('*')) {
        const right = this.parsePower()
        left = toNumber(left) * toNumber(right)
      } else if (this.matchOp('/')) {
        const right = this.parsePower()
        const divisor = toNumber(right)
        if (divisor === 0) throw new FormulaError('除数为 0')
        left = toNumber(left) / divisor
      } else return left
    }
  }

  private parsePower(): RuntimeValue {
    let left = this.parseUnary()
    if (this.matchOp('^')) {
      const right = this.parsePower()
      left = toNumber(left) ** toNumber(right)
    }
    return left
  }

  private parseUnary(): RuntimeValue {
    if (this.matchOp('-')) return -toNumber(this.parseUnary())
    if (this.matchOp('+')) return toNumber(this.parseUnary())
    return this.parsePostfix()
  }

  private parsePostfix(): RuntimeValue {
    let value = this.parsePrimary()
    while (this.matchOp('%')) value = toNumber(value) / 100
    return value
  }

  private parsePrimary(): RuntimeValue {
    const token = this.next()
    if (token.type === 'number') return token.value
    if (token.type === 'string') return token.value
    if (token.type === 'ref') {
      if (this.matchOp(':')) {
        const end = this.next()
        if (end.type !== 'ref') throw new FormulaError('区域格式错误')
        return { range: this.getRange(token.value, end.value) }
      }
      return this.getCell(token.value)
    }
    if (token.type === 'ident') {
      const keyword = token.value.toUpperCase()
      if (keyword === 'TRUE') return true
      if (keyword === 'FALSE') return false
      if (!this.matchOp('(')) throw new FormulaError(`未知名称：${token.value}`)
      const args: RuntimeValue[] = []
      if (!this.matchOp(')')) {
        for (;;) {
          args.push(this.parseComparison())
          if (this.matchOp(')')) break
          this.expectOp(',')
        }
      }
      return this.callFunction(keyword, args)
    }
    if (token.type === 'op' && token.value === '(') {
      const value = this.parseComparison()
      this.expectOp(')')
      return value
    }
    throw new FormulaError('公式语法错误')
  }

  private callFunction(name: string, args: RuntimeValue[]): RuntimeValue {
    switch (name) {
      case 'SUM': {
        let total = 0
        for (const item of flatten(args)) if (typeof item === 'number') total += item
        return total
      }
      case 'AVERAGE': {
        const numbers = flatten(args).filter((item): item is number => typeof item === 'number')
        if (numbers.length === 0) throw new FormulaError('AVERAGE 没有数字参数')
        return numbers.reduce((sum, item) => sum + item, 0) / numbers.length
      }
      case 'MIN': {
        const numbers = flatten(args).filter((item): item is number => typeof item === 'number')
        if (numbers.length === 0) throw new FormulaError('MIN 没有数字参数')
        return Math.min(...numbers)
      }
      case 'MAX': {
        const numbers = flatten(args).filter((item): item is number => typeof item === 'number')
        if (numbers.length === 0) throw new FormulaError('MAX 没有数字参数')
        return Math.max(...numbers)
      }
      case 'COUNT':
        return flatten(args).filter((item) => typeof item === 'number').length
      case 'COUNTA':
        return flatten(args).filter((item) => item !== null && item !== undefined && item !== '').length
      case 'ROUND': {
        if (args.length < 1) throw new FormulaError('ROUND 缺少参数')
        return round(toNumber(args[0]), args.length > 1 ? toNumber(args[1]) : 0)
      }
      case 'ABS': {
        if (args.length < 1) throw new FormulaError('ABS 缺少参数')
        return Math.abs(toNumber(args[0]))
      }
      case 'IF': {
        if (args.length < 2) throw new FormulaError('IF 缺少参数')
        const condition = args[0]
        const truthy = isRange(condition) ? Boolean(toNumber(condition)) : Boolean(condition)
        if (truthy) return args[1]
        return args.length > 2 ? args[2] : false
      }
      default:
        throw new FormulaError(`不支持的函数：${name}`)
    }
  }
}


/**
 * 对一个工作表（二维原始值，公式以 "=" 开头）求值。
 * 返回 `ref → EvaluatedCell`；非公式单元格不返回（写入时直接用原值）。
 */
export function evaluateSheet(rows: CellInput[][], options: FormulaEvalOptions = {}): Map<string, EvaluatedCell> {
  const maxCells = options.maxCells ?? MAX_CELLS
  const formulas = new Map<string, { row: number; column: number; formula: string }>()
  const rawByRef = new Map<string, CellInput>()

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? []
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const value = row[columnIndex]
      if (value === undefined || value === null || value === '') continue
      const ref = coordToRef(columnIndex, rowIndex)
      rawByRef.set(ref, value)
      if (typeof value === 'string' && value.startsWith('=') && value.length > 1) {
        formulas.set(ref, { row: rowIndex, column: columnIndex, formula: value.slice(1) })
      }
    }
  }
  const results = new Map<string, EvaluatedCell>()
  if (formulas.size === 0) return results
  if (formulas.size > maxCells) return results

  const inProgress = new Set<string>()
  const cache = new Map<string, CellValue>()

  const readCell = (ref: string): CellValue => {
    const key = ref.toUpperCase()
    const formula = formulas.get(key)
    if (!formula) return rawByRef.get(key) ?? null
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    if (inProgress.has(key)) throw new FormulaError('公式存在循环引用')
    inProgress.add(key)
    try {
      const value = evaluateFormula(formula.formula)
      cache.set(key, value)
      return value
    } finally {
      inProgress.delete(key)
    }
  }

  const readRange = (fromRef: string, toRef: string): CellInput[][] => {
    const from = cellRefToCoord(fromRef)
    const to = cellRefToCoord(toRef)
    if (!from || !to) throw new FormulaError('区域引用格式错误')
    const rowStart = Math.min(from.row, to.row)
    const rowEnd = Math.max(from.row, to.row)
    const colStart = Math.min(from.column, to.column)
    const colEnd = Math.max(from.column, to.column)
    if ((rowEnd - rowStart + 1) * (colEnd - colStart + 1) > 50_000) throw new FormulaError('区域过大')
    const matrix: CellInput[][] = []
    for (let row = rowStart; row <= rowEnd; row += 1) {
      const values: CellInput[] = []
      for (let column = colStart; column <= colEnd; column += 1) {
        values.push(readCell(coordToRef(column, row)))
      }
      matrix.push(values)
    }
    return matrix
  }

  const evaluateFormula = (formula: string): CellValue => {
    const tokens = tokenize(formula)
    const parser = new Parser(tokens, readCell, readRange)
    const value = parser.parse()
    if (isRange(value)) throw new FormulaError('公式结果是区域，无法作为单元格值')
    return value
  }

  for (const ref of formulas.keys()) {
    try {
      results.set(ref, { value: readCell(ref) })
    } catch (err) {
      results.set(ref, { value: null, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}


const MAX_READ_BYTES = 256 * 1024

const MAX_WRITE_CHARS = 2 * 1024 * 1024

/** 快照只为 diff/预览保留这个大小以内的文本；更大的文件仍完整备份，但用流式哈希避免整文件读入内存 */
const MAX_SNAPSHOT_TEXT_BYTES = 2 * 1024 * 1024

const DEFAULT_READ_LINES = 2000

const MAX_READ_LINES = 20_000

const MAX_LIST_ENTRIES = 400

const SKIP_DIRS = new Set(['node_modules', '.git', '.morrow', '.svn', '.hg'])

const MAX_OUTPUT_CHARS = 64 * 1024


function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}


/** 解码文本；识别 UTF-16LE/BE BOM；前 8KB 含 NUL 判定为二进制 */
export function decodeTextBuffer(buffer: Buffer): { text: string; binary: boolean } {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: stripBom(buffer.subarray(2).toString('utf16le')), binary: false }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const tmp = swapped[i]
      swapped[i] = swapped[i + 1]
      swapped[i + 1] = tmp
    }
    return { text: stripBom(swapped.toString('utf16le')), binary: false }
  }
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (probe.includes(0)) return { text: '', binary: true }
  return { text: stripBom(buffer.toString('utf8')), binary: false }
}


/** 只读取文件头，避免把超大文件整个读进内存 */
function readFileHead(absolutePath: string, maxBytes: number): { buffer: Buffer; fileSize: number; truncated: boolean } {
  const stat = statSync(absolutePath)
  const fileSize = stat.size
  if (fileSize <= maxBytes) {
    const buffer = readFileSync(absolutePath)
    return { buffer, fileSize, truncated: false }
  }
  const fd = openSync(absolutePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0)
    return { buffer: buffer.subarray(0, bytesRead), fileSize, truncated: true }
  } finally {
    closeSync(fd)
  }
}


/** 原子写文件：先写同目录临时文件再 rename，避免进程崩溃留下半个文件 */
export function atomicWriteFileSync(target: string, data: string | Uint8Array): void {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let mode: number | null = null
  try {
    mode = statSync(target).mode
  } catch {
    // 新文件使用默认权限
  }
  try {
    if (typeof data === 'string') {
      writeFileSync(tmp, data, { encoding: 'utf8', ...(mode !== null ? { mode } : {}) })
    } else {
      writeFileSync(tmp, data, { ...(mode !== null ? { mode } : {}) })
    }
    if (mode !== null) {
      try {
        chmodSync(tmp, mode)
      } catch {
        // Windows/受限文件系统可能不支持；保留内容写入结果
      }
    }
    // Windows 上杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        renameSync(tmp, target)
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
        if (attempt === 3) throw err
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
      }
    }
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不影响原始错误
    }
    throw err
  }
}


function atomicWriteTextFile(target: string, content: string): void {
  atomicWriteFileSync(target, content)
}


/** 流式哈希：大文件/二进制快照不整文件读入内存 */
function hashFileSync(absolutePath: string): string {
  const fd = openSync(absolutePath, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let position = 0
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
      position += read
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}


export interface SnapshotInfo {
  snapshotId: string
  snapshotPath: string
  beforeHash: string
  beforeText: string | null
  beforeBinary: boolean
}


/**
 * 记录「这次写入后的文件哈希」。撤销（restoreSnapshot）用它判断文件在写入之后
 * 是否被用户手工改过：当前哈希 ≠ afterHash 且 ≠ beforeHash → 冲突，拒绝覆盖。
 * R7 审计修复：旧实现只有 before 快照，撤销会静默覆盖用户后来的修改。
 */
/** 快照目录使用单层安全名：provider 返回的 tool id 不能带出 .. 或路径分隔符。 */
function snapshotSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120)
  return cleaned || 'tool'
}


export function recordRestoreManifest(
  ctx: ToolContext,
  absolutePath: string,
  beforeHash: string | null,
  afterHash: string
): void {
  try {
    const dir = join(ctx.snapshotDir, snapshotSegment(ctx.toolUseId))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '.restore.json'),
      JSON.stringify({ targetPath: absolutePath, beforeHash, afterHash, at: Date.now() }),
      'utf8'
    )
  } catch {
    // 快照清单写失败不应影响主流程；撤销时会走「缺少清单」的保守分支
  }
}


export const RESTORE_MANIFEST_FILE = '.restore.json'


/**
 * 写/编辑前备份旧文件：<snapshotDir>/<toolUseId>/<filename>。
 * 这是「撤销本轮文件改动」的数据源，主进程只需按 toolUseId 还原。
 */
export function snapshotFile(absolutePath: string, ctx: ToolContext): SnapshotInfo | null {
  if (!existsSync(absolutePath)) return null
  const stat = statSync(absolutePath)
  if (!stat.isFile()) return null
  const snapshotDir = join(ctx.snapshotDir, snapshotSegment(ctx.toolUseId))
  mkdirSync(snapshotDir, { recursive: true })
  const fileName = basename(absolutePath)
  // 目标文件恰好叫 .restore.json 时不能覆盖同一目录下的撤销清单
  const snapshotPath = join(snapshotDir, fileName === RESTORE_MANIFEST_FILE ? `snapshot-${fileName}` : fileName)
  copyFileSync(absolutePath, snapshotPath)
  const beforeHash = hashFileSync(snapshotPath)
  let beforeText: string | null = null
  let beforeBinary = false
  if (stat.size <= MAX_SNAPSHOT_TEXT_BYTES) {
    const buffer = readFileSync(snapshotPath)
    const decoded = decodeTextBuffer(buffer)
    beforeText = decoded.binary ? null : decoded.text
    beforeBinary = decoded.binary
  }
  return {
    snapshotId: ctx.toolUseId,
    snapshotPath,
    beforeHash,
    beforeText,
    beforeBinary
  }
}


function toLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}


function countLines(text: string): number {
  if (!text) return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}


function relativeOrAbsolute(absolute: string, ctx: ToolContext): string {
  return displayPath(absolute, ctx.workspace)
}


export const readFileTool: ToolImpl = {
  definition: {
    name: 'read_file',
    description:
      '读取工作区内的文本文件，返回带行号的内容。支持 offset/limit 分页读取大文件；文件超过 256KB 只读取开头。' +
      '读取前可先用 list_dir 或 glob 确认路径。二进制文件会报错，需用 run_command 处理。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对工作区根目录（如 "报告/数据.csv"）' },
        offset: { type: 'number', description: '起始行号（从 1 开始，默认 1）' },
        limit: { type: 'number', description: '最多读取行数（默认 2000，上限 20000）' }
      },
      required: ['path']
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `读取 ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true,
      allowedExternalFiles: ctx.attachedFiles
    })
    if (resolved.isDirectory) {
      throw new ToolInputError(`「${rawPath}」是一个文件夹，不是文件。`, '可以改用 list_dir 查看文件夹内容。')
    }
    const { buffer, fileSize, truncated: fileTruncated } = readFileHead(resolved.real, MAX_READ_BYTES)
    const decoded = decodeTextBuffer(buffer)
    if (decoded.binary) {
      throw new ToolInputError(
        `「${rawPath}」看起来是二进制文件（可能是图片、压缩包或 Office 文档），不能按文本读取。`,
        '如果确实需要处理它，可以运行命令（例如 Python/Node 脚本）来解析，或改用 open_artifact 作为文件产物打开。'
      )
    }
    const lines = toLines(decoded.text)
    const totalLines = fileTruncated ? lines.length : Math.max(lines.length, countLines(decoded.text))
    const offset = clampInt(getNumber(input, 'offset', { defaultValue: 1, min: 1 }), 1, Math.max(1, totalLines + 1))
    const limit = clampInt(getNumber(input, 'limit', { defaultValue: DEFAULT_READ_LINES, min: 1, max: MAX_READ_LINES }), 1, MAX_READ_LINES)
    const startIndex = offset - 1
    const selected = lines.slice(startIndex, startIndex + limit)
    const endLine = selected.length > 0 ? startIndex + selected.length : startIndex
    const numbered = selected.map((line, i) => `${String(startIndex + i + 1).padStart(5)}│${line}`).join('\n')
    const headerParts = [
      `${relativeOrAbsolute(resolved.absolute, ctx)}（共 ${totalLines} 行`,
      selected.length > 0 ? `显示第 ${offset}-${endLine} 行` : '没有更多内容',
      fileSize > MAX_READ_BYTES ? `文件 ${formatBytes(fileSize)}，仅读取开头 256KB` : `${formatBytes(fileSize)}`,
      '）'
    ]
    const output = `${headerParts.join('，')}\n${truncateText(numbered, MAX_OUTPUT_CHARS)}`
    const hasMore = endLine < totalLines
    return okResult(output, {
      path: relativeOrAbsolute(resolved.absolute, ctx),
      absolutePath: resolved.absolute,
      size: fileSize,
      lines: totalLines,
      startLine: offset,
      endLine,
      hasMore,
      truncated: fileTruncated
    })
  }
}


export const writeFileTool: ToolImpl = {
  definition: {
    name: 'write_file',
    description:
      '把文本内容写入工作区内的文件（会创建缺失的父目录；已存在的文件默认被覆盖）。' +
      'append=true 时追加到文件末尾（文件不存在则创建）。写入前会自动备份旧内容用于撤销。' +
      '内容较长（>约 4KB / 100 行）时建议分次写：先写骨架，再用 append=true 分段追加，避免单次输出被长度上限截断。' +
      '生成 HTML/Markdown 等成品时，内容要完整、可直接使用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对工作区根目录' },
        content: { type: 'string', description: '要写入的文本内容（UTF-8）' },
        append: { type: 'boolean', description: '是否追加到文件末尾（默认 false = 覆盖；文件不存在则创建）' }
      },
      required: ['path', 'content']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `${input.append === true ? '追加写入' : '写入'} ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    if (!('content' in input)) {
      throw new ToolInputError('缺少必填参数「content」。', '请提供要写入的完整文本内容。')
    }
    const rawContent = input.content
    if (typeof rawContent !== 'string') {
      throw new ToolInputError('参数「content」应该是字符串。', '请把文件内容作为字符串传入。')
    }
    if (rawContent.length > MAX_WRITE_CHARS) {
      throw new ToolInputError(
        `内容过大（${formatBytes(rawContent.length)}，上限 ${formatBytes(MAX_WRITE_CHARS)}）。`,
        '请拆分成多个较小的文件，或改用 run_command 生成大文件。'
      )
    }
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, { escapeApproved: ctx.escapeApproved })
    if (resolved.isDirectory) {
      throw new ToolInputError(`「${rawPath}」是一个文件夹，不能当文件写入。`, '请换一个文件路径。')
    }
    const append = getBoolean(input, 'append', false)
    const existed = existsSync(resolved.absolute) && statSync(resolved.absolute).isFile()
    // append 同样要备份旧内容（撤销/差异视图依赖快照 + beforeHash/diff）
    const snapshot = snapshotFile(resolved.absolute, ctx)
    // 写真实路径而不是链接路径：保留符号链接本身，同时与撤销记录的目标路径保持一致
    const writeTarget = resolved.real
    mkdirSync(dirname(writeTarget), { recursive: true })
    if (append) appendFileSync(writeTarget, rawContent, 'utf8')
    else atomicWriteTextFile(writeTarget, rawContent)

    const displayPath = relativeOrAbsolute(resolved.absolute, ctx)
    const writtenBytes = Buffer.byteLength(rawContent, 'utf8')
    const writtenLines = countLines(rawContent)
    let afterText: string | null = rawContent
    let afterHash = sha256(rawContent)
    let afterLines: number | null = writtenLines
    if (append) {
      const afterSize = statSync(resolved.absolute).size
      if (afterSize <= MAX_SNAPSHOT_TEXT_BYTES) {
        const afterBuffer = readFileSync(resolved.absolute)
        const afterDecoded = decodeTextBuffer(afterBuffer)
        afterText = afterDecoded.binary ? null : afterDecoded.text
        afterHash = sha256(afterBuffer)
        afterLines = afterText !== null ? countLines(afterText) : 0
      } else {
        // 大文件只做流式哈希，避免 append 后把整文件读入内存；行数按未知展示
        afterText = null
        afterHash = hashFileSync(resolved.absolute)
        afterLines = null
      }
    }
    const beforeText = snapshot?.beforeText
    const diff =
      afterText !== null && (beforeText !== null && beforeText !== undefined || !existed)
        ? createUnifiedDiff(beforeText ?? '', afterText, displayPath)
        : null
    recordRestoreManifest(ctx, resolved.absolute, snapshot?.beforeHash ?? null, afterHash)
    const lines = [
      `${append ? (existed ? '已追加写入' : '已创建并写入') : existed ? '已覆盖' : '已创建'} ${displayPath}`,
      append
        ? `新增 ${writtenLines} 行 / ${formatBytes(writtenBytes)} · 现共 ${
            afterLines !== null ? `${afterLines} 行` : '文件较大，行数未统计'
          }`
        : `${afterLines ?? writtenLines} 行 · ${formatBytes(writtenBytes)}`,
      diff ? `改动 ${diffSummary(diff)}` : '',
      snapshot ? '旧内容已备份，可撤销。' : ''
    ].filter(Boolean)
    const meta: Record<string, unknown> = {
      snapshotId: snapshot?.snapshotId ?? null,
      snapshotPath: snapshot?.snapshotPath ?? null,
      path: displayPath,
      absolutePath: resolved.absolute,
      beforeHash: snapshot?.beforeHash ?? null,
      afterHash,
      bytes: writtenBytes,
      lines: afterLines,
      writtenLines,
      appended: append,
      diff: diff?.patch ?? '',
      diffAdded: diff?.added ?? 0,
      diffRemoved: diff?.removed ?? 0,
      created: !existed
    }
    return okResult(lines.join('\n'), meta)
  }
}


/** 在 old_string 直接匹配失败时尝试适配文件的行尾风格（Windows CRLF 是常见坑） */
function findMatchVariant(text: string, oldString: string): { needle: string; count: number } {
  const candidates: string[] = [oldString]
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  if (oldString.includes('\n')) {
    candidates.push(oldString.replace(/\r\n/g, '\n').replace(/\n/g, eol))
  }
  if (oldString.includes('\r\n')) {
    candidates.push(oldString.replace(/\r\n/g, '\n'))
  }
  for (const needle of candidates) {
    if (!needle) continue
    const count = text.split(needle).length - 1
    if (count > 0) return { needle, count }
  }
  return { needle: oldString, count: 0 }
}


export const editFileTool: ToolImpl = {
  definition: {
    name: 'edit_file',
    description:
      '对工作区内的文本文件做精确替换。old_string 必须在文件中唯一出现（或设置 replace_all=true 全部替换）。' +
      '匹配失败时会返回可自修复的提示：先 read_file 确认原文（注意空格、缩进、换行）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对工作区根目录' },
        old_string: { type: 'string', description: '要被替换的原文（必须与文件内容完全一致）' },
        new_string: { type: 'string', description: '替换后的新内容' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配（默认 false，只允许唯一匹配）' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `修改 ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const oldString = getString(input, 'old_string', { required: true, trim: false })
    const newString = getString(input, 'new_string', { trim: false })
    const replaceAll = input.replace_all === true
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, { escapeApproved: ctx.escapeApproved, requireExist: true })
    if (resolved.isDirectory) throw new ToolInputError(`「${rawPath}」是一个文件夹，不是文件。`, '请指定具体文件。')
    const stat = statSync(resolved.real)
    if (stat.size > 2 * 1024 * 1024) {
      throw new ToolInputError(`文件过大（${formatBytes(stat.size)}），edit_file 只支持 2MB 以内的文本。`, '可以改用 write_file 重写，或用 run_command 处理。')
    }
    const decoded = decodeTextBuffer(readFileSync(resolved.real))
    if (decoded.binary) {
      throw new ToolInputError(`「${rawPath}」是二进制文件，不能用 edit_file 修改。`, '请改用 run_command 或 open_artifact。')
    }
    const text = decoded.text
    const { needle, count } = findMatchVariant(text, oldString)
    if (count === 0) {
      return errResult(
        `没有在「${rawPath}」中找到 old_string。`,
        '请先 read_file 查看当前内容，按实际文本（包含空格/缩进/换行）重试；也可以扩大或缩小 old_string 的上下文。',
        { matchCount: 0 }
      )
    }
    if (count > 1 && !replaceAll) {
      return errResult(
        `old_string 在「${rawPath}」中出现了 ${count} 次，无法确定要改哪一处。`,
        '请提供更长、更独特的 old_string（包含上下文），或设置 replace_all=true 全部替换。',
        { matchCount: count }
      )
    }
    const snapshot = snapshotFile(resolved.absolute, ctx)
    const nextText = replaceAll ? text.split(needle).join(newString) : text.replace(needle, () => newString)
    atomicWriteTextFile(resolved.real, nextText)
    const afterHashEdit = sha256(nextText)
    recordRestoreManifest(ctx, resolved.absolute, snapshot?.beforeHash ?? null, afterHashEdit)
    const diff = createUnifiedDiff(text, nextText, relativeOrAbsolute(resolved.absolute, ctx))
    const meta: Record<string, unknown> = {
      snapshotId: snapshot?.snapshotId ?? null,
      snapshotPath: snapshot?.snapshotPath ?? null,
      path: relativeOrAbsolute(resolved.absolute, ctx),
      absolutePath: resolved.absolute,
      beforeHash: snapshot?.beforeHash ?? null,
      afterHash: afterHashEdit,
      matchCount: count,
      replaced: replaceAll ? count : 1,
      diff: diff.patch,
      diffAdded: diff.added,
      diffRemoved: diff.removed
    }
    return okResult(
      `已修改 ${relativeOrAbsolute(resolved.absolute, ctx)}（替换 ${replaceAll ? count : 1} 处，${diffSummary(diff)}）\n旧内容已备份，可撤销。`,
      meta
    )
  }
}


export const deleteFileTool: ToolImpl = {
  definition: {
    name: 'delete_file',
    description:
      '删除工作区内的一个文件。删除前自动备份旧内容并生成删除 diff，可回退。' +
      '只删除文件，不删除文件夹；批量清理目录用 run_command。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删除的文件路径（相对工作区根目录）' }
      },
      required: ['path']
    },
    category: 'write',
    risk: 'high',
    titleFor: (input) => `删除 ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true
    })
    let stat
    try {
      stat = lstatSync(resolved.absolute)
    } catch {
      throw new ToolInputError(`文件不存在：${rawPath}`, '先用 list_dir 或 glob 确认路径。')
    }
    if (stat.isSymbolicLink()) {
      throw new ToolInputError('这个路径是符号链接，已拒绝删除。', '请直接删除链接指向的真实文件，或使用系统文件管理器。')
    }
    if (stat.isDirectory()) {
      throw new ToolInputError('delete_file 只能删除文件，不能删除文件夹。', '清理文件夹请使用 run_command，并先核对路径。')
    }
    if (!stat.isFile()) {
      throw new ToolInputError('这个路径不是普通文件，无法删除。', '请确认路径指向一个文件。')
    }
    const snapshot = snapshotFile(resolved.absolute, ctx)
    const beforeText = snapshot?.beforeText ?? null
    const removedLines = beforeText !== null ? countLines(beforeText) : 0
    const bytes = stat.size
    const diff = beforeText !== null ? createUnifiedDiff(beforeText, '', relativeOrAbsolute(resolved.absolute, ctx)) : null
    try {
      rmSync(resolved.absolute)
    } catch (err) {
      throw new ToolInputError(
        `删除文件失败：${err instanceof Error ? err.message : String(err)}`,
        '文件可能被其他程序占用；关闭占用后重试。'
      )
    }
    recordRestoreManifest(ctx, resolved.absolute, snapshot?.beforeHash ?? null, '')
    const meta: Record<string, unknown> = {
      snapshotId: snapshot?.snapshotId ?? null,
      snapshotPath: snapshot?.snapshotPath ?? null,
      path: relativeOrAbsolute(resolved.absolute, ctx),
      absolutePath: resolved.absolute,
      beforeHash: snapshot?.beforeHash ?? null,
      afterHash: null,
      bytes,
      lines: 0,
      deleted: true,
      created: false,
      diff: diff?.patch ?? '',
      diffAdded: 0,
      diffRemoved: removedLines
    }
    return okResult(
      `已删除 ${relativeOrAbsolute(resolved.absolute, ctx)}（${removedLines} 行，${formatBytes(bytes)}）` +
        (snapshot ? '\n删除前已备份，可回退。' : ''),
      meta
    )
  }
}


interface TreeEntry {
  name: string
  relative: string
  isDirectory: boolean
  size: number
}


export const listDirTool: ToolImpl = {
  definition: {
    name: 'list_dir',
    description:
      '以树形列出工作区内的目录内容（默认只看 1 层，可指定 depth 最多 3 层）。' +
      '会自动跳过 node_modules/.git 等噪音目录。开始任务时建议先列一遍了解结构。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，相对工作区根目录（默认 "."）' },
        depth: { type: 'number', description: '递归层数，默认 1，最大 3' }
      }
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `查看目录 ${oneLineInput(input, 'path') || '.'}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { defaultValue: '.' })
    const depth = clampInt(getNumber(input, 'depth', { defaultValue: 1, min: 1, max: 3 }), 1, 3)
    const resolved = resolveWorkspacePath(rawPath || '.', ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true,
      requireDirectory: true
    })
    const displayRoot = relativeOrAbsolute(resolved.absolute, ctx)
    const lines: string[] = [`${displayRoot}/`]
    const entries: TreeEntry[] = []
    let truncated = false

    const walk = (dirAbs: string, level: number, prefix: string): void => {
      if (level > depth || truncated) return
      let children: Dirent[]
      try {
        children = readdirSync(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      const visible = children
        .filter((child) => {
          if (child.isDirectory() && SKIP_DIRS.has(child.name)) return false
          if (child.name === '.DS_Store' || child.name === 'Thumbs.db') return false
          return child.isDirectory() || child.isFile()
        })
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'))
      for (let i = 0; i < visible.length; i += 1) {
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true
          return
        }
        const child = visible[i]
        const last = i === visible.length - 1
        const childAbs = join(dirAbs, child.name)
        const childRel = prefix === '' ? child.name : ''
        const connector = last ? '└─ ' : '├─ '
        if (child.isDirectory()) {
          entries.push({ name: child.name, relative: child.name, isDirectory: true, size: 0 })
          lines.push(`${prefix}${connector}${child.name}/`)
          walk(childAbs, level + 1, `${prefix}${last ? '   ' : '│  '}`)
        } else if (child.isFile()) {
          let size = 0
          try {
            size = statSync(childAbs).size
          } catch {
            // 忽略统计失败
          }
          entries.push({ name: child.name, relative: childRel, isDirectory: false, size })
          lines.push(`${prefix}${connector}${child.name}  (${formatBytes(size)})`)
        }
      }
    }
    walk(resolved.real, 1, '')

    if (entries.length === 0) lines.push('（空目录）')
    if (truncated) lines.push(`…（条目过多，仅显示前 ${MAX_LIST_ENTRIES} 条）`)
    const dirCount = entries.filter((e) => e.isDirectory).length
    lines.push(`\n共 ${entries.length} 项（${dirCount} 个文件夹，${entries.length - dirCount} 个文件）${truncated ? '，已截断' : ''}`)
    return okResult(truncateText(lines.join('\n'), MAX_OUTPUT_CHARS), {
      path: displayRoot,
      absolutePath: resolved.absolute,
      entries: entries.length,
      dirs: dirCount,
      files: entries.length - dirCount,
      truncated,
      depth
    })
  }
}


export const moveFileTool: ToolImpl = {
  definition: {
    name: 'move_file',
    description:
      '把工作区内的一个文件移动或重命名到新路径。目标父目录会自动创建；目标已存在时拒绝覆盖。' +
      '只移动文件，不移动文件夹；移动前后的内容不变。回退请使用本轮检查点（移动不像写入那样生成逐文件快照）。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源文件路径（相对工作区根目录）' },
        to: { type: 'string', description: '目标文件路径（相对工作区根目录）' }
      },
      required: ['from', 'to']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `移动 ${oneLineInput(input, 'from')} → ${oneLineInput(input, 'to')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawFrom = getString(input, 'from', { required: true })
    const rawTo = getString(input, 'to', { required: true })
    const source = resolveWorkspacePath(rawFrom, ctx.workspace, { escapeApproved: ctx.escapeApproved, requireExist: true })
    if (source.isDirectory) throw new ToolInputError(`「${rawFrom}」是文件夹，move_file 只移动文件。`, '需要移动目录时请用 run_command，并说明范围。')
    const target = resolveWorkspacePath(rawTo, ctx.workspace, { escapeApproved: ctx.escapeApproved })
    if (target.isDirectory) throw new ToolInputError(`目标「${rawTo}」是文件夹。`, '请指定一个文件路径。')
    if (source.real === target.real) throw new ToolInputError('源路径和目标路径相同，不需要移动。', '请换一个目标路径。')
    if (existsSync(target.absolute)) {
      throw new ToolInputError(`目标已存在：${rawTo}`, '为避免覆盖，请换一个不存在的目标路径，或先删除目标文件。')
    }
    mkdirSync(dirname(target.real), { recursive: true })
    renameSync(source.real, target.real)
    return okResult(
      `已移动 ${relativeOrAbsolute(source.absolute, ctx)} → ${relativeOrAbsolute(target.absolute, ctx)}。\n如需撤销，请使用本轮检查点或 Git。`,
      {
        from: relativeOrAbsolute(source.absolute, ctx),
        to: relativeOrAbsolute(target.absolute, ctx),
        absoluteFrom: source.absolute,
        absoluteTo: target.absolute,
        moved: true
      }
    )
  }
}


export const copyFileTool: ToolImpl = {
  definition: {
    name: 'copy_file',
    description:
      '把工作区内的一个文件复制到新路径。目标父目录会自动创建；目标已存在时拒绝覆盖。' +
      '适合复制模板/素材后再修改，保留原文件。只复制文件，不复制文件夹。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源文件路径（相对工作区根目录）' },
        to: { type: 'string', description: '目标文件路径（相对工作区根目录）' }
      },
      required: ['from', 'to']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `复制 ${oneLineInput(input, 'from')} → ${oneLineInput(input, 'to')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawFrom = getString(input, 'from', { required: true })
    const rawTo = getString(input, 'to', { required: true })
    const source = resolveWorkspacePath(rawFrom, ctx.workspace, { escapeApproved: ctx.escapeApproved, requireExist: true })
    if (source.isDirectory) throw new ToolInputError(`「${rawFrom}」是文件夹，copy_file 只复制文件。`, '需要复制目录时请用 run_command，并说明范围。')
    const target = resolveWorkspacePath(rawTo, ctx.workspace, { escapeApproved: ctx.escapeApproved })
    if (target.isDirectory) throw new ToolInputError(`目标「${rawTo}」是文件夹。`, '请指定一个文件路径。')
    if (source.real === target.real) throw new ToolInputError('源路径和目标路径相同，不需要复制。', '请换一个目标路径。')
    if (existsSync(target.absolute)) {
      throw new ToolInputError(`目标已存在：${rawTo}`, '为避免覆盖，请换一个不存在的目标路径，或先删除目标文件。')
    }
    mkdirSync(dirname(target.real), { recursive: true })
    copyFileSync(source.real, target.real)
    const afterHash = hashFileSync(target.real)
    recordRestoreManifest(ctx, target.absolute, null, afterHash)
    return okResult(
      `已复制 ${relativeOrAbsolute(source.absolute, ctx)} → ${relativeOrAbsolute(target.absolute, ctx)}（新文件已记录，可撤销）。`,
      {
        from: relativeOrAbsolute(source.absolute, ctx),
        to: relativeOrAbsolute(target.absolute, ctx),
        absoluteFrom: source.absolute,
        absoluteTo: target.absolute,
        afterHash,
        created: true
      }
    )
  }
}


export const makeDirTool: ToolImpl = {
  definition: {
    name: 'make_dir',
    description:
      '在工作区内创建一个文件夹（父目录自动创建）。已存在同名文件夹时返回提示，不报错；' +
      '不能用来创建文件，也不能越出工作区。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件夹路径（相对工作区根目录）' }
      },
      required: ['path']
    },
    category: 'write',
    risk: 'low',
    titleFor: (input) => `新建文件夹 ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, { escapeApproved: ctx.escapeApproved })
    if (existsSync(resolved.absolute) && !statSync(resolved.absolute).isDirectory()) {
      throw new ToolInputError(`「${rawPath}」已存在且是文件。`, '请换一个文件夹名。')
    }
    const existed = existsSync(resolved.absolute)
    mkdirSync(resolved.real, { recursive: true })
    return okResult(
      `${existed ? '文件夹已存在' : '已创建文件夹'} ${relativeOrAbsolute(resolved.absolute, ctx)}。`,
      { path: relativeOrAbsolute(resolved.absolute, ctx), absolutePath: resolved.absolute, created: !existed }
    )
  }
}


export const fsTools: ToolImpl[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  listDirTool,
  moveFileTool,
  copyFileTool,
  makeDirTool
]


const MAX_DOCX_BYTES = 100 * 1024 * 1024

const DOCX_MAX_XML_CHARS = 32 * 1024 * 1024

const DOCX_DEFAULT_MAX_CHARS = 60_000

const DOCX_MAX_CHARS_LIMIT = 200_000

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
  if (text.length > DOCX_MAX_XML_CHARS) {
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
          description: `可选：最多返回多少字符（默认 ${DOCX_DEFAULT_MAX_CHARS}，上限 ${DOCX_MAX_CHARS_LIMIT}）`
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
      Math.max(1, Math.round(getNumber(input, 'max_chars', { defaultValue: DOCX_DEFAULT_MAX_CHARS, min: 1 }))),
      DOCX_MAX_CHARS_LIMIT
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


const MAX_PPTX_BYTES = 50 * 1024 * 1024

const MAX_PART_BYTES = 24 * 1024 * 1024

const PPTX_DEFAULT_MAX_CHARS = 30_000

const PPTX_MAX_CHARS_LIMIT = 120_000

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
          description: `可选：最多返回多少字符（默认 ${PPTX_DEFAULT_MAX_CHARS}，上限 ${PPTX_MAX_CHARS_LIMIT}）`
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
      Math.max(2_000, Math.round(getNumber(input, 'max_chars', { defaultValue: PPTX_DEFAULT_MAX_CHARS, min: 2_000 }))),
      PPTX_MAX_CHARS_LIMIT
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


const MAX_XLSX_BYTES = 50 * 1024 * 1024

const XLSX_MAX_XML_CHARS = 48 * 1024 * 1024

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
  if (text.length > XLSX_MAX_XML_CHARS) throw new ToolExecutionError(`工作簿部件 ${entryName} 过大，无法安全解析。`, '请拆分工作簿。')
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


const MAX_PDF_BYTES = 100 * 1024 * 1024
 // 100MB：正常文档远小于此，避免恶意/超大文件拖垮主进程
const PDF_DEFAULT_MAX_CHARS = 60_000

const PDF_MAX_CHARS_LIMIT = 200_000

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
          description: `可选：最多返回多少字符（默认 ${PDF_DEFAULT_MAX_CHARS}，上限 ${PDF_MAX_CHARS_LIMIT}）`
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
      Math.max(1, Math.round(getNumber(input, 'max_chars', { defaultValue: PDF_DEFAULT_MAX_CHARS, min: 1 }))),
      PDF_MAX_CHARS_LIMIT
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
