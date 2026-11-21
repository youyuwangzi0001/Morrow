// 审计：行内尾部小标签（状态/大小/计数/时间）在窄容器里被压成竖排的问题。
//
// 典型故障（用户截图）：`<li><span>很长的待办文字</span><em>完成</em></li>`，
// em 默认 flex-shrink:1，父级空间不足时被压到 min-content，
// 中文一个字一行 →「完」「成」竖排，或「549 KB」折成两行。
//
// 判定条件（两类都必须满足「父容器是横向 flex」这一条，否则就是普通块级文案）：
//  A. 类名以短标签词结尾、自身是 flex/inline-flex 叶子 → 需要 flex-shrink:0 + nowrap。
//  B. `... em` / `... > em` 作为行尾标签 → 需要 nowrap（并建议 flex-shrink:0）。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CSS_DIRS = ['src/renderer', 'src/renderer/features']
const TAIL_RE = /(?:^|[-_])(size|count|time|badge|meta|state|status|pct|percent|duration|bytes|usage|cost|round|step|date|quota)$/
const ROW_SKIP = /(?:^|[-_])(step|row|item|head|body|list|group|field|form|panel|card)$/

function parseRules(file) {
  const text = readFileSync(file, 'utf8')
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const rules = []
  let depth = 0
  let start = 0
  let selector = ''
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i]
    if (ch === '{') {
      if (depth === 0) selector = stripped.slice(start, i).replace(/\s+/g, ' ').trim()
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        rules.push({ selector, body: stripped.slice(start, i + 1), line: stripped.slice(0, start).split('\n').length })
        start = i + 1
      }
    }
  }
  return rules
}

/** 判断某选择器描述的容器是否为「横向 flex 行」 */
function isRowFlex(selector, byKey) {
  const rule = byKey.get(selector.trim())
  if (!rule) return null
  const body = rule.body
  if (!/display:\s*(inline-)?flex/.test(body)) return false
  if (/flex-direction:\s*column/.test(body)) return false
  return true
}

/** 从 `a b > em` 里取出父级选择器 `a b` */
function parentSelectorOf(selector) {
  const parts = selector.trim().split(/\s+/)
  if (parts.length < 2) return null
  return parts.slice(0, -1).join(' ').replace(/\s*>\s*$/, '')
}

const findings = []

for (const dir of CSS_DIRS) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    continue
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.css')) continue
    const file = join(dir, entry.name)
    const rules = parseRules(file)

    const byKey = new Map()
    const byClass = new Map()
    const containers = new Set()
    for (const rule of rules) {
      for (const sel of rule.selector.split(',')) {
        const trimmed = sel.trim()
        byKey.set(trimmed, rule)
        const match = trimmed.match(/^\.([a-zA-Z0-9_-]+)$/)
        if (match) byClass.set(match[1], rule)
        const parent = trimmed.match(/^\.([a-zA-Z0-9_-]+)\s*(?:>|\s)\s*[^\s>]/)
        if (parent) containers.add(parent[1])
      }
    }

    // A 类：叶子短标签
    for (const [cls, rule] of byClass) {
      if (!TAIL_RE.test(cls) || ROW_SKIP.test(cls) || containers.has(cls)) continue
      const body = rule.body
      if (!/display:\s*(inline-)?flex/.test(body)) continue
      if (/flex-wrap:\s*wrap|flex-direction:\s*column|line-clamp|pre-wrap|justify-content:\s*center/.test(body)) continue
      const nowrap = /white-space:\s*nowrap/.test(body)
      const noShrink = /flex:\s*0\s+0\s+auto|flex-shrink:\s*0|flex:\s*none/.test(body)
      if (!nowrap || !noShrink) {
        findings.push({
          file,
          line: rule.line,
          selector: `.${cls}`,
          kind: 'A 叶子短标签',
          missing: [!nowrap && 'white-space:nowrap', !noShrink && 'flex-shrink:0'].filter(Boolean).join(' + ')
        })
      }
    }

    // B 类：横向 flex 行里的 `em` 行尾标签
    for (const rule of rules) {
      for (const sel of rule.selector.split(',')) {
        const trimmed = sel.trim()
        if (!/(?:^|[\s>])em$/.test(trimmed)) continue
        const parent = parentSelectorOf(trimmed)
        if (!parent) continue
        const parentRule = byKey.get(parent)
        const body = rule.body
        // 纵向堆叠（说明文字）与自动换行容器里的 em 是正文，不是行尾标签：
        // 这两类加上 nowrap 反而会把长错误信息顶出容器，必须跳过。
        if (/display:\s*block/.test(body)) continue
        if (parentRule && /flex-wrap:\s*wrap/.test(parentRule.body)) continue
        // 后代选择器（没有 `>`）时，em 可能嵌在包裹层里（例如 `li > div` 的 grid 列）。
        // 只要父级存在直接子包裹层规则，就无法认定它是行尾标签，跳过以免误改。
        const nested = !/>\s*em$/.test(trimmed) && rules.some((item) => item.selector.startsWith(`${parent} > `))
        if (nested) continue
        const rowFlex = isRowFlex(parent, byKey)
        if (rowFlex !== true) continue
        if (/white-space:\s*nowrap/.test(body)) continue
        if (/display:\s*block|flex-direction:\s*column/.test(body)) continue
        findings.push({
          file,
          line: rule.line,
          selector: trimmed,
          kind: 'B 行尾标签(em)',
          missing: 'white-space:nowrap（建议同时 flex-shrink:0）'
        })
      }
    }

  }
}

if (findings.length === 0) {
  console.log('OK: 未发现会被压成竖排的行内尾部标签。')
} else {
  console.log(`发现 ${findings.length} 处行内尾部标签缺少防挤压约束：`)
  for (const f of findings) console.log(`  ${f.file}:${f.line}  [${f.kind}] ${f.selector}  缺少 ${f.missing}`)
  process.exitCode = 1
}