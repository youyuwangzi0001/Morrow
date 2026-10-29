// Verifies every local image referenced by the docs exists.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = process.cwd()
const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md']
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.md')) files.push(relative(root, path).replace(/\\/g, '/'))
  }
}
walk(join(root, 'docs'))

const missing = []
let checked = 0
for (const file of files) {
  const text = readFileSync(join(root, file), 'utf8')
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim()
    if (/^https?:\/\//i.test(target)) continue
    checked += 1
    const path = resolve(dirname(join(root, file)), target)
    if (!existsSync(path)) missing.push(`${file} -> ${target}`)
  }
}
console.log(`checked ${checked} local image links`)
if (missing.length) {
  console.error(`missing ${missing.length}:`)
  for (const item of missing) console.error(`- ${item}`)
  process.exit(1)
}
