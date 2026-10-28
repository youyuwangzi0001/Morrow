/**
 * UI 设计令牌审计：CSS 里的字号/字重必须走顶层 token。
 * 用法：npm run audit:ui
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const cssRoot = join(root, 'src', 'renderer')
const tokensFile = join(cssRoot, 'styles.css')
const tsxRoot = join(root, 'src', 'renderer')

function walk(dir, extensions) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, extensions))
    else if (extensions.some((extension) => entry.endsWith(extension))) out.push(full)
  }
  return out
}

const cssFiles = walk(cssRoot, ['.css']).filter((file) => file !== tokensFile)
const tsxFiles = walk(tsxRoot, ['.tsx'])
const files = [...cssFiles, ...tsxFiles]
const allowlist = new Set(['artifacts.tsx', 'terminal.tsx'])
const violations = []
for (const file of files) {
  if (allowlist.has(file.split(/[\\/]/).pop())) continue
  const text = readFileSync(file, 'utf8').replace(/\/\* ui-token-audit:off \*\/[\s\S]*?\/\* ui-token-audit:on \*\//g, '')
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (/font-size:\s*[0-9.]+px/.test(line) || /font-weight:\s*[0-9]+/.test(line) || /line-height:\s*[0-9.]+;/.test(line) || /letter-spacing:\s*-?[0-9.]+em/.test(line) || /fontSize:\s*'[0-9.]+px'/.test(line) || /fontWeight:\s*[0-9]+/.test(line)) {
      violations.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`)
    }
  })
}
if (violations.length > 0) {
  console.error(`UI token audit failed: ${violations.length} raw type declaration(s)`)
  for (const item of violations) console.error('  ' + item)
  process.exit(1)
}
console.log(`UI token audit passed: ${cssFiles.length} CSS + ${tsxFiles.length} TSX files, 0 raw typography declarations (document-preview iframes allowlisted).`)
