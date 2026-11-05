// Checks the flat documentation set: local image links resolve, every guide image is a
// 2100x1200 PNG, and no stale nested docs directories return.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = process.cwd()
const docsDir = join(root, 'docs')
const screensDir = join(docsDir, 'screens')
const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md']
for (const name of readdirSync(docsDir)) {
  if (name.endsWith('.md')) files.push(relative(root, join(docsDir, name)).replaceAll('\\', '/'))
}

const errors = []
for (const stale of ['guide', 'verification']) {
  if (existsSync(join(docsDir, stale))) errors.push(`docs/${stale}/ 已废弃：文档改为扁平结构，请使用 docs/screens/ 与 docs/VERIFICATION.md`)
}

function pngSize(path) {
  const buffer = readFileSync(path)
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

const referenced = new Set()
let checked = 0
function slugsFor(file) {
  const text = readFileSync(file, 'utf8')
  const slugs = new Set()
  for (const line of text.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const slug = match[1]
      .toLowerCase()
      .replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
    slugs.add(slug)
  }
  return slugs
}

for (const file of files) {
  const text = readFileSync(join(root, file), 'utf8')
  for (const match of text.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim()
    if (/^(?:https?:|mailto:)/i.test(raw)) continue
    const [target, anchor] = raw.split('#')
    const path = target ? resolve(dirname(join(root, file)), target) : join(root, file)
    if (!existsSync(path)) {
      errors.push(`${file} -> ${raw} 目标不存在`)
      continue
    }
    if (anchor && path.endsWith('.md') && !slugsFor(path).has(anchor)) {
      errors.push(`${file} -> ${raw} 锚点不存在`)
    }
  }
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim()
    if (/^https?:\/\//i.test(target)) continue
    checked += 1
    const path = resolve(dirname(join(root, file)), target)
    if (!existsSync(path)) {
      errors.push(`${file} -> ${target} 不存在`)
      continue
    }
    const rel = relative(docsDir, path).replaceAll('\\', '/')
    if (rel.startsWith('screens/')) referenced.add(rel.slice('screens/'.length))
  }
}

const images = readdirSync(screensDir).filter((name) => name.endsWith('.png'))
for (const name of images) {
  const path = join(screensDir, name)
  const size = pngSize(path)
  if (!size) {
    errors.push(`docs/screens/${name} 不是 PNG`)
    continue
  }
  if (size.width !== 2100 || size.height !== 1200) {
    errors.push(`docs/screens/${name} 尺寸 ${size.width}x${size.height}，必须是 2100x1200`)
  }
  if (!referenced.has(name)) errors.push(`docs/screens/${name} 未被任何文档引用`)
}

console.log(`docs: ${files.length} 个 Markdown，${images.length} 张 2100x1200 截图，${checked} 个本地图片链接`)
if (errors.length) {
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
}
