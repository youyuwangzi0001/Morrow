// Collapses runs of 3+ newlines (2+ blank lines) to one blank line.
// Strings, template literals, regex literals and comments are protected by the TypeScript scanner.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import ts from 'typescript'

const roots = ['src', 'tests', 'scripts']
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html'])
const write = process.argv.includes('--write')
const here = process.cwd()

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'out') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (extensions.has(extname(entry.name))) out.push(path)
  }
  return out
}

function protectedIntervals(text, ext) {
  if (!['.ts', '.tsx', '.js', '.mjs'].includes(ext)) return []
  const kind = ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const source = ts.createSourceFile(`file${ext}`, text, ts.ScriptTarget.Latest, true, kind)
  const ranges = []
  const add = (start, end) => {
    if (end > start) ranges.push([start, end])
  }
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      add(node.getStart(source), node.end)
    } else if (ts.isTemplateExpression(node)) {
      // Only protect the raw template text; `${...}` is code and may be collapsed safely.
      add(node.head.getStart(source), node.head.end)
      for (const span of node.templateSpans) add(span.literal.getStart(source), span.literal.end)
    }
    for (const comment of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? [])
    ]) {
      add(comment.pos, comment.end)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  // Comments that are not attached to a node (for example at end of file).
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ext === '.tsx' ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text)
  let token = scanner.scan()
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if ((token === ts.SyntaxKind.MultiLineCommentTrivia || token === ts.SyntaxKind.SingleLineCommentTrivia) && scanner.getTextPos() > scanner.getTokenPos()) {
      add(scanner.getTokenPos(), scanner.getTextPos())
    }
    token = scanner.scan()
  }
  ranges.sort((left, right) => left[0] - right[0])
  const merged = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([...range])
  }
  return merged
}

function intersects(ranges, start, end) {
  let left = 0
  let right = ranges.length - 1
  while (left <= right) {
    const mid = Math.floor((left + right) / 2)
    const range = ranges[mid]
    if (range[1] <= start) left = mid + 1
    else if (range[0] >= end) right = mid - 1
    else return true
  }
  return false
}

const files = roots.flatMap((root) => {
  try {
    return walk(join(here, root))
  } catch {
    return []
  }
})
let changedFiles = 0
let removedRuns = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const ranges = protectedIntervals(text, extname(file))
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const replacement = `${newline}${newline}`
  let runs = 0
  const next = text.replace(/(?:\r?\n[ \t]*){3,}/g, (match, offset) => {
    if (intersects(ranges, offset, offset + match.length)) return match
    runs += 1
    return replacement
  })
  if (runs > 0) {
    changedFiles += 1
    removedRuns += runs
    const rel = relative(here, file).replace(/\\/g, '/')
    console.log(`${write ? 'fixed' : 'would fix'} ${rel}: ${runs} runs -> one blank line`)
    if (write) writeFileSync(file, next, 'utf8')
  }
}
console.log(`${write ? 'fixed' : 'would fix'} ${changedFiles} files, ${removedRuns} blank-line runs`)
