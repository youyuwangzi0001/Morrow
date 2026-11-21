// Checks the flat documentation set:
// - every local link and anchor resolves (Markdown links and HTML img/a attributes)
// - every desktop screenshot is a 2100x1200 PNG and is referenced by a document
// - every phone screenshot and diagram is referenced by a document
// - the cover exists, is roughly 2:1 and is referenced by both root READMEs
// - retired documentation directories have not come back
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = process.cwd()
const docsDir = join(root, 'docs')

// Historical records keep their original text and are not part of the current set.
const skippedDirs = new Set(['cards', 'evidence'])
const skippedDirHint = 'docs/cards/ 与 docs/evidence/ 是历史记录，不参与链接检查'

const rootFiles = ['README.md', 'README.zh.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const docFiles = readdirSync(docsDir)
  .flatMap((entry) => {
    const full = join(docsDir, entry)
    if (!statSync(full).isDirectory()) return entry.endsWith('.md') ? [full] : []
    if (skippedDirs.has(entry)) return []
    return walk(full).filter((file) => file.endsWith('.md'))
  })
  .sort()

const files = [...rootFiles, ...docFiles.map((file) => relative(root, file).replaceAll('\\', '/'))]

const errors = []
for (const stale of ['guide', 'verification', 'images']) {
  if (existsSync(join(docsDir, stale))) {
    errors.push(`docs/${stale}/ 已废弃：正文平铺在 docs/，截图放 docs/screens/，示意图放 docs/diagrams/`)
  }
}

function pngSize(path) {
  const buffer = readFileSync(path)
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

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

const referenced = new Set()
const failed = [new Set(), new Set()]
let checkedLinks = 0
let checkedImages = 0

function isExternal(raw) {
  return /^(?:https?:|mailto:|data:|tel:)/i.test(raw)
}

function handleLink(file, raw, kind) {
  const target = raw.trim()
  if (!target || isExternal(target) || target.startsWith('#')) return
  const [pathPart, anchor] = target.split('#')
  const absolute = pathPart ? resolve(dirname(join(root, file)), pathPart) : join(root, file)
  if (!existsSync(absolute)) {
    failed[kind].add(`${file} -> ${target} 目标不存在`)
    return
  }
  if (anchor && absolute.endsWith('.md')) {
    if (!slugsFor(absolute).has(anchor)) {
      failed[kind].add(`${file} -> ${target} 锚点不存在`)
    }
  }
  if (kind === 1) {
    const rel = relative(docsDir, absolute).replaceAll('\\', '/')
    if (rel.startsWith('screens/')) referenced.add(rel.slice('screens/'.length))
    else if (rel.startsWith('diagrams/')) referenced.add(rel)
  }
}

for (const file of files) {
  const text = readFileSync(join(root, file), 'utf8')
  for (const match of text.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
    checkedLinks += 1
    handleLink(file, match[1], 0)
  }
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    checkedImages += 1
    handleLink(file, match[1], 1)
  }
  for (const match of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    checkedImages += 1
    handleLink(file, match[1], 1)
  }
  for (const match of text.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    checkedLinks += 1
    handleLink(file, match[1], 0)
  }
}

errors.push(...failed[0], ...failed[1])

const screensDir = join(docsDir, 'screens')
function checkPng(dir, allowed, label) {
  if (!existsSync(dir)) return 0
  let count = 0
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    const rel = relative(screensDir, full).replaceAll('\\', '/')
    if (stat.isDirectory()) continue
    if (!entry.endsWith('.png')) {
      errors.push(`docs/screens/${rel} 只接受 PNG`)
      continue
    }
    const size = pngSize(full)
    if (!size) {
      errors.push(`docs/screens/${rel} 不是 PNG`)
      continue
    }
    if (allowed && (size.width !== allowed.width || size.height !== allowed.height)) {
      errors.push(`docs/screens/${rel} 尺寸 ${size.width}x${size.height}，必须是 ${allowed.width}x${allowed.height}`)
    }
    if (!referenced.has(rel)) errors.push(`docs/screens/${rel} 未被任何文档引用（${label}）`)
    count += 1
  }
  return count
}

const desktopCount = checkPng(screensDir, { width: 2100, height: 1200 }, '桌面截图')
const mobileCount = (() => {
  const mobileDir = join(screensDir, 'mobile')
  if (!existsSync(mobileDir)) return 0
  let count = 0
  for (const entry of readdirSync(mobileDir)) {
    const full = join(mobileDir, entry)
    if (statSync(full).isDirectory()) continue
    const rel = `mobile/${entry}`
    if (!entry.endsWith('.png')) {
      errors.push(`docs/screens/${rel} 只接受 PNG`)
      continue
    }
    if (!pngSize(full)) {
      errors.push(`docs/screens/${rel} 不是 PNG`)
      continue
    }
    if (!referenced.has(rel)) errors.push(`docs/screens/${rel} 未被任何文档引用（手机截图）`)
    count += 1
  }
  return count
})()

let diagramCount = 0
const diagramsDir = join(docsDir, 'diagrams')
if (existsSync(diagramsDir)) {
  for (const entry of readdirSync(diagramsDir)) {
    if (!entry.endsWith('.png')) continue
    const size = pngSize(join(diagramsDir, entry))
    if (!size) errors.push(`docs/diagrams/${entry} 不是 PNG`)
    if (!referenced.has(`diagrams/${entry}`)) errors.push(`docs/diagrams/${entry} 未被任何文档引用`)
    diagramCount += 1
  }
}

const cover = join(docsDir, 'cover.png')
if (!existsSync(cover)) {
  errors.push('docs/cover.png 缺失：README 顶部封面不可用')
} else {
  const size = pngSize(cover)
  if (!size) errors.push('docs/cover.png 不是 PNG')
  else {
    if (size.width < 1600) errors.push(`docs/cover.png 宽度 ${size.width}，至少 1600`)
    const ratio = size.height / size.width
    if (ratio < 0.42 || ratio > 0.58) {
      errors.push(`docs/cover.png 比例 ${size.width}x${size.height}，应接近 2:1`)
    }
  }
  for (const readme of ['README.md', 'README.zh.md']) {
    const text = readFileSync(join(root, readme), 'utf8')
    if (!/cover\.png/.test(text)) errors.push(`${readme} 没有引用 docs/cover.png`)
  }
}

console.log(
  `docs: ${files.length} 个 Markdown（跳过 ${skippedDirHint}），` +
    `${desktopCount} 张桌面截图 2100x1200，${mobileCount} 张手机截图，${diagramCount} 张示意图，` +
    `${checkedLinks} 个链接，${checkedImages} 个图片引用`
)
if (errors.length) {
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
}