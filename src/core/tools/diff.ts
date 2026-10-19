/**
 * 行级 diff（不引入第三方依赖）。
 * 用途：edit_file/write_file 的 meta.diff、审批卡 diff 预览、UI 差异视图的数据源。
 * 大文件降级为统计信息，避免 O(n*m) 内存爆炸。
 */
export interface DiffResult {
  patch: string
  added: number
  removed: number
  /** 文件过大/差异过多被省略 */
  truncated: boolean
}

const MAX_LINES_FOR_LCS = 1200
const MAX_PATCH_LINES = 400

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function summarize(before: string[], after: string[]): DiffResult {
  const added = Math.max(0, after.length - before.length)
  const removed = Math.max(0, before.length - after.length)
  return {
    patch: `（内容较大，省略逐行 diff：旧文件 ${before.length} 行 → 新文件 ${after.length} 行）`,
    added,
    removed,
    truncated: true
  }
}

/** 最长公共子序列 → 编辑操作序列 */
function diffOps(a: string[], b: string[]): Array<{ type: 'eq' | 'add' | 'del'; line: string; aIndex: number; bIndex: number }> {
  const n = a.length
  const m = b.length
  const width = m + 1
  // dp[i][j] = LCS(a[i:], b[j:])
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const ops: Array<{ type: 'eq' | 'add' | 'del'; line: string; aIndex: number; bIndex: number }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i], aIndex: i, bIndex: j })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ type: 'del', line: a[i], aIndex: i, bIndex: j })
      i += 1
    } else {
      ops.push({ type: 'add', line: b[j], aIndex: i, bIndex: j })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: a[i], aIndex: i, bIndex: j })
    i += 1
  }
  while (j < m) {
    ops.push({ type: 'add', line: b[j], aIndex: i, bIndex: j })
    j += 1
  }
  return ops
}

/**
 * 生成 unified diff 风格文本。
 * @param filePath 展示用路径（放 @@ 头）
 */
export function createUnifiedDiff(before: string, after: string, filePath = 'file'): DiffResult {
  if (before === after) return { patch: '', added: 0, removed: 0, truncated: false }
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  if (oldLines.length > MAX_LINES_FOR_LCS || newLines.length > MAX_LINES_FOR_LCS) {
    return summarize(oldLines, newLines)
  }
  const ops = diffOps(oldLines, newLines)
  const added = ops.filter((op) => op.type === 'add').length
  const removed = ops.filter((op) => op.type === 'del').length
  if (added === 0 && removed === 0) return { patch: '', added: 0, removed: 0, truncated: false }

  const hunks: string[] = []
  let patchLines = 0
  let truncated = false
  const context = 2
  let index = 0
  while (index < ops.length) {
    // 找下一处变更
    if (ops[index].type === 'eq') {
      index += 1
      continue
    }
    const start = Math.max(0, index - context)
    let end = index
    // 变更簇：两个变更之间间隔 <= context*2 就合并进同一个 hunk
    while (end < ops.length) {
      if (ops[end].type !== 'eq') {
        end += 1
        continue
      }
      let lookahead = end
      while (lookahead < ops.length && ops[lookahead].type === 'eq') lookahead += 1
      if (lookahead < ops.length && lookahead - end <= context * 2) {
        end = lookahead
        continue
      }
      break
    }
    const slice = ops.slice(start, Math.min(ops.length, end + context))
    const firstA = slice.find((op) => op.type !== 'add')?.aIndex ?? slice[0]?.aIndex ?? 0
    const firstB = slice.find((op) => op.type !== 'del')?.bIndex ?? slice[0]?.bIndex ?? 0
    const oldCount = slice.filter((op) => op.type !== 'add').length
    const newCount = slice.filter((op) => op.type !== 'del').length
    const header = `@@ -${firstA + 1},${oldCount} +${firstB + 1},${newCount} @@`
    hunks.push(`--- a/${filePath}`, `+++ b/${filePath}`)
    hunks.push(header)
    patchLines += 3
    for (const op of slice) {
      const prefix = op.type === 'eq' ? ' ' : op.type === 'add' ? '+' : '-'
      hunks.push(`${prefix}${op.line}`)
      patchLines += 1
      if (patchLines > MAX_PATCH_LINES) {
        truncated = true
        break
      }
    }
    if (truncated) {
      hunks.push(`…（diff 过长，仅显示前 ${MAX_PATCH_LINES} 行）`)
      break
    }
    index = end
  }
  return { patch: hunks.join('\n'), added, removed, truncated }
}

/** 给审批卡/工具结果用的一句话统计 */
export function diffSummary(result: DiffResult): string {
  if (!result.patch) return '内容没有变化'
  return `+${result.added} / -${result.removed} 行`
}
