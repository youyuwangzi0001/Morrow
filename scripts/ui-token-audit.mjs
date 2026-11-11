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
// 文档/导出的预览 HTML 属于内容排版，必须保持文档自身的字号，不跟随应用字号设置。
const allowlist = new Set(['artifacts.tsx'])
const violations = []
for (const file of files) {
  if (allowlist.has(file.split(/[\\/]/).pop())) continue
  const text = readFileSync(file, 'utf8').replace(/\/\* ui-token-audit:off \*\/[\s\S]*?\/\* ui-token-audit:on \*\//g, '')
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    const fontSize = /font-size:\s*([^;]+);/.exec(line)?.[1]?.trim()
    const fontSizeAllowed =
      !fontSize ||
      /var\(--/.test(fontSize) ||
      /^(?:inherit|0|0?\.\d+(?:em|rem)|[0-9.]+%)$/.test(fontSize)
    if (!fontSizeAllowed) {
      violations.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`)
    }
    if (/font-weight:\s*[0-9]+/.test(line) || /line-height:\s*[0-9.]+;/.test(line) || /letter-spacing:\s*-?[0-9.]+em/.test(line) || /fontSize:\s*'[0-9.]+px'/.test(line) || /fontWeight:\s*[0-9]+/.test(line) || /outline:\s*[1-9][0-9.]*px/.test(line)) {
      violations.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`)
    }
  })
}
if (violations.length > 0) {
  console.error(`UI token audit failed: ${violations.length} raw type declaration(s)`)
  for (const item of violations) console.error('  ' + item)
  process.exit(1)
}
// 字号阶梯必须从用户设置的两个基值推导，不能在别处写死 px，否则切换字号时不会生效。
const tokenCss = readFileSync(tokensFile, 'utf8')
if (!/--font-ui-size\s*:/.test(tokenCss) || !/--font-code-size\s*:/.test(tokenCss)) {
  console.error('UI token audit failed: styles.css 缺少 --font-ui-size / --font-code-size 基值')
  process.exit(1)
}
if (!/--focus-ring-width\s*:\s*2px/.test(tokenCss)) {
  console.error('UI token audit failed: 焦点环必须是统一的 2px（--focus-ring-width）')
  process.exit(1)
}
const scaleViolations = []
let scaleTokens = 0
for (const file of cssFiles.concat(tokensFile)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    const match = /^\s*(--fs-[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line)
    if (!match) return
    scaleTokens += 1
    if (!/var\(/.test(match[2])) {
      scaleViolations.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`)
    }
  })
}
if (scaleViolations.length > 0) {
  console.error(`UI token audit failed: ${scaleViolations.length} 个字号令牌没有从基值推导`)
  for (const item of scaleViolations) console.error('  ' + item)
  process.exit(1)
}
console.log(
  `UI token audit passed: ${cssFiles.length} CSS + ${tsxFiles.length} TSX files, 0 raw typography declarations, ${scaleTokens} scale-derived font tokens (document-preview iframes allowlisted).`
)
