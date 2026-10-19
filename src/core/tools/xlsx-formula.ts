/**
 * 极简 Excel 公式求值器：只为 write_xlsx 计算「缓存值」用（写入真公式的同时带上正确结果，
 * 这样 openpyxl(data_only=True)、预览器、其他不重算的读取方也能看到正确数字）。
 *
 * 支持范围（刻意保守）：
 * - 数字/字符串/布尔字面量、单元格引用（A1、$B$2）、区域（A1:B4，仅作为函数参数）；
 * - 运算符：+ - * / ^ %（百分号后缀）&（字符串连接）比较运算；
 * - 函数：SUM / AVERAGE / MIN / MAX / COUNT / COUNTA / ROUND / ABS / IF。
 * 任何不支持的结构（未知函数、INDIRECT、循环引用等）都不求值，只是不写缓存值——公式本身依旧保真写入。
 */

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

/* ── 词法分析 ─────────────────────────────────────────────────── */

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

/* ── 递归下降解析 ─────────────────────────────────────────────── */

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
