// 画布产物导出、预览、版本、附件与内置浏览器。
import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs'
import { dirname, extname, join, resolve, basename, sep } from 'node:path'
import type { Artifact, ArtifactVersionInfo, ArtifactVersionSource, Attachment, ChatImage, ChatMessage, MessageAttachment } from '../shared/types'
import { formatBytes, decodeTextBytes, MORROW_SCROLLBAR_RULES } from '../shared/types'
import { ATTACHMENT_IMAGE_MAX_BYTES, ATTACHMENT_IMAGE_SOURCE_MAX_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_TEXT_MAX_BYTES, ATTACHMENT_TEXT_MAX_CHARS, ATTACHMENT_TOTAL_IMAGE_MAX_BYTES, ATTACHMENT_TOTAL_TEXT_MAX_CHARS, imageMediaTypeFor, isTextFileName } from '../shared/contracts'
import type { Session, WebContents } from 'electron'
import { app, BrowserWindow, WebContentsView, session } from 'electron'
import type { BrowserActionResult, BrowserBounds, BrowserCallContext, BrowserDownloadRequest, BrowserReadResult, BrowserScreenshotResult, BrowserState, BrowserTabInfo } from '../core/util'
import { BROWSER_LIMITS, BROWSER_PARTITION, BROWSER_WEB_PREFERENCES, checkBrowserUrl, isBrowserNavigationAllowed, normalizeBrowserAddress, sanitizeBrowserBounds } from '../core/util'
import { dataPath, revealInFileManager } from './workspace'
import { log } from './logger'

// 成品导出转换：HTML → Markdown / 纯文本，Markdown → HTML，以及 PDF 用的打印文档。

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  bull: '•',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥'
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, body: string) => {
    const key = body.toLowerCase()
    if (key.startsWith('#')) {
      const hex = key.startsWith('#x')
      const code = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return match
        }
      }
      return match
    }
    return ENTITIES[key] ?? match
  })
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function bodyOf(html: string): string {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  return match ? match[1] : html
}

function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<(script|style|head|noscript|template|iframe|object|svg)\b[\s\S]*?<\/\1>/gi, '')
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  if (!match) return null
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '')
}

function inlineMarkdown(html: string): string {
  let out = html
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attribute(tag, 'src') ?? ''
    if (!src) return ''
    const alt = attribute(tag, 'alt') ?? ''
    return `![${alt.replace(/[[\]]/g, '')}](${src})`
  })
  out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs: string, inner: string) => {
    const href = attribute(`<a ${attrs}>`, 'href') ?? ''
    const text = inlineMarkdown(inner).replace(/\s+/g, ' ').trim()
    if (!href || !text) return text
    return `[${text}](${href})`
  })
  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner: string) => `**${inlineMarkdown(inner)}**`)
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner: string) => `*${inlineMarkdown(inner)}*`)
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner: string) => `\`${decodeEntities(inner.replace(/<[^>]+>/g, ''))}\``)
  out = out.replace(/<br\s*\/?>/gi, '\n')
  out = out.replace(/<[^>]+>/g, '')
  out = decodeEntities(out)
  return out
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function tableToMarkdown(table: string): string {
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) =>
      [...row[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((cell) =>
        inlineMarkdown(cell[2]).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
      )
    )
    .filter((row) => row.length > 0)
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const normalized = rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => '')])
  const [head, ...body] = normalized
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`]
  for (const row of body) lines.push(`| ${row.join(' | ')} |`)
  return lines.join('\n')
}

function convertLists(html: string): string {
  // 由内向外转换，避免嵌套 <li> 的非贪婪匹配置断父列表
  let current = html
  for (let pass = 0; pass < 6; pass += 1) {
    const next = current.replace(
      /<(ul|ol)\b[^>]*>((?:(?!<(?:ul|ol)\b)[\s\S])*?)<\/\1>/gi,
      (_match, tag: string, inner: string) => {
        const ordered = tag.toLowerCase() === 'ol'
        const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
        if (items.length === 0) return ''
        const lines = items.map((item, index) => {
          const text = inlineMarkdown(item[1]).replace(/\n+/g, ' ').trim()
          return ordered ? `${index + 1}. ${text}` : `- ${text}`
        })
        return `\n\n${lines.join('\n')}\n\n`
      }
    )
    if (next === current) break
    current = next
  }
  return current
}

/** 把 HTML 报告转成可读的 Markdown：标题、列表、表格、代码块、链接都会被保留。 */
export function htmlToMarkdown(input: string): string {
  const codes: string[] = []
  let html = stripNoise(bodyOf(input))

  html = html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => `\n\n${tableToMarkdown(table)}\n\n`)
  html = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const langMatch = inner.match(/class\s*=\s*["'][^"']*language-([\w-]+)/i)
    const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/^\n+|\s+$/g, '')
    codes.push(`\`\`\`${langMatch?.[1] ?? ''}\n${text}\n\`\`\``)
    return `\n\nMORROWCODE${codes.length - 1}TOKEN\n\n`
  })
  html = html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, inner: string) => {
    const text = inlineMarkdown(inner).replace(/\n+/g, ' ').trim()
    return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : ''
  })
  html = html.replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
  html = html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, inner: string) => {
    const text = htmlToMarkdown(inner)
    return `\n\n${text
      .split('\n')
      .map((line) => (line.trim() ? `> ${line}` : '>'))
      .join('\n')}\n\n`
  })
  html = convertLists(html)
  html = html.replace(/<\/(?:p|div|section|article|header|footer|main|aside|figure|figcaption)>/gi, '\n\n')
  html = html.replace(/<\/(?:td|th)>/gi, ' | ')
  html = html.replace(/<\/tr>/gi, '\n')
  html = inlineMarkdown(html)
  html = html.replace(/MORROWCODE(\d+)TOKEN/g, (_match, index: string) => codes[Number(index)] ?? '')
  return html
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** HTML → 纯文本：去掉样式与脚本，保留段落、列表和表格的可读换行。 */
export function htmlToText(input: string): string {
  let html = stripNoise(bodyOf(input))
  html = html.replace(/<br\s*\/?>/gi, '\n')
  html = html.replace(/<hr\b[^>]*>/gi, '\n\n')
  html = html.replace(/<li\b[^>]*>/gi, '• ')
  html = html.replace(/<\/(?:td|th)>/gi, '\t')
  html = html.replace(/<\/(?:p|div|section|article|header|footer|main|aside|h[1-6]|li|tr|ul|ol|table|blockquote|pre)>/gi, '\n')
  html = html.replace(/<[^>]+>/g, '')
  return decodeEntities(html)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function safeUrl(raw: string): string | null {
  const url = decodeEntities(raw).trim()
  if (!url) return null
  if (/^(?:https?:|mailto:|tel:|#|\/|\.{1,2}\/)/i.test(url)) return url
  return null
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inlineHtml(text: string): string {
  let out = escapeHtml(text)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, alt: string, url: string) => {
    const safe = safeUrl(url)
    return safe ? `<img src="${escapeAttribute(safe)}" alt="${escapeAttribute(alt)}" loading="lazy">` : escapeHtml(alt)
  })
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, label: string, url: string) => {
    const safe = safeUrl(url)
    return safe ? `<a href="${escapeAttribute(safe)}">${label}</a>` : label
  })
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?，。！？]|$)/g, '$1<em>$2</em>')
  return out
}

/** 轻量 Markdown → HTML，用于 Markdown 成品的 HTML/PDF 导出。 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let paragraph: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let listItems: string[] = []
  let inCode = false
  let codeLang = ''
  let codeLines: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    out.push(`<p>${inlineHtml(paragraph.join(' ').trim())}</p>`)
    paragraph = []
  }
  const flushList = (): void => {
    if (!listType) return
    out.push(`<${listType}>${listItems.map((item) => `<li>${inlineHtml(item)}</li>`).join('')}</${listType}>`)
    listType = null
    listItems = []
  }
  const flush = (): void => {
    flushParagraph()
    flushList()
  }

  for (const line of lines) {
    const fence = line.match(/^\s*```([\w+#.-]*)\s*$/)
    if (fence) {
      if (inCode) {
        out.push(
          `<pre><code${codeLang ? ` class="language-${escapeAttribute(codeLang)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`
        )
        inCode = false
        codeLang = ''
        codeLines = []
      } else {
        flush()
        inCode = true
        codeLang = fence[1] ?? ''
      }
      continue
    }
    if (inCode) {
      codeLines.push(line)
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flush()
      const level = heading[1].length
      out.push(`<h${level}>${inlineHtml(heading[2].trim())}</h${level}>`)
      continue
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      flush()
      out.push('<hr>')
      continue
    }
    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      flush()
      out.push(`<blockquote><p>${inlineHtml(quote[1])}</p></blockquote>`)
      continue
    }
    const bullet = line.match(/^\s*([-*+])\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (bullet || numbered) {
      flushParagraph()
      const nextType = bullet ? 'ul' : 'ol'
      if (listType && listType !== nextType) flushList()
      listType = nextType
      listItems.push((bullet?.[2] ?? numbered?.[1] ?? '').trim())
      continue
    }
    if (listType) flushList()
    paragraph.push(line.trim())
  }
  if (inCode) {
    out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  }
  flush()
  return out.join('\n')
}

const PAPER_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 56px 64px; background: #fbfaf7; color: #1d1a14;
    font: 15px/1.75 "Newsreader", "Noto Serif SC", Georgia, serif;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1, h2, h3, h4, h5, h6 { font-family: "Newsreader", "Noto Serif SC", Georgia, serif; font-weight: 600; line-height: 1.3; margin: 1.6em 0 .6em; }
  h1 { font-size: 30px; letter-spacing: -.01em; margin-top: 0; padding-bottom: 14px; border-bottom: 1px solid #c8ae7d; }
  h2 { font-size: 22px; } h3 { font-size: 18px; }
  p { margin: .7em 0; }
  a { color: #8a6f42; text-decoration-thickness: 1px; text-underline-offset: 2px; }
  code { font-family: "IBM Plex Mono", Consolas, monospace; font-size: .88em; background: #f0ece3; padding: .12em .35em; border-radius: 3px; }
  pre { background: #15130f; color: #e9e1d3; padding: 16px 18px; border-radius: 6px; overflow: auto; }
  pre code { background: none; padding: 0; color: inherit; font-size: 12.5px; line-height: 1.65; }
  blockquote { margin: 1em 0; padding: .2em 0 .2em 18px; border-left: 2px solid #c8ae7d; color: #5c5344; }
  ul, ol { padding-left: 1.4em; }
  li { margin: .3em 0; }
  hr { border: 0; border-top: 1px solid #d9d2c4; margin: 2em 0; }
  img { max-width: 100%; height: auto; }
  @media print { body { padding: 0; background: #fff; } a { color: inherit; } pre { white-space: pre-wrap; } }
`

function paperDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${PAPER_STYLE}</style></head>
<body><main>${body}</main></body></html>`
}

function ensureHtmlDocument(html: string, title: string): string {
  if (/<html[\s>]/i.test(html)) {
    if (/<\/head>/i.test(html)) {
      return html.replace(
        /<\/head>/i,
        `<style data-morrow-print>@page { size: A4; margin: 14mm; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }</style></head>`
      )
    }
    return html
  }
  return paperDocument(title, html)
}

/** 生成可直接保存/打印的 HTML 文档。 */
export function buildExportHtml(artifact: { title: string; kind: string }, content: string): string {
  const title = artifact.title || 'Morrow 成品'
  if (artifact.kind === 'html') return ensureHtmlDocument(content, title)
  if (artifact.kind === 'markdown') return paperDocument(title, markdownToHtml(content))
  if (artifact.kind === 'svg') return paperDocument(title, `<div class="svg-wrap">${content}</div>`)
  return paperDocument(title, `<pre><code>${escapeHtml(content)}</code></pre>`)
}

const CODE_FENCE_LANG: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  tsx: 'tsx',
  jsx: 'jsx',
  python: 'py',
  bash: 'sh',
  shell: 'sh',
  powershell: 'ps1',
  css: 'css',
  json: 'json',
  yaml: 'yml',
  html: 'html',
  xml: 'xml',
  sql: 'sql',
  go: 'go',
  rust: 'rs',
  java: 'java',
  markdown: 'md'
}

/** 任意文本型成品 → Markdown。HTML 报告会保留结构；代码会放进围栏代码块。 */
export function buildExportMarkdown(artifact: { title: string; kind: string; language?: string }, content: string): string {
  if (artifact.kind === 'html') return htmlToMarkdown(content)
  if (artifact.kind === 'markdown') return content
  if (artifact.kind === 'svg') return `\`\`\`svg\n${content}\n\`\`\``
  const lang = artifact.language ? CODE_FENCE_LANG[artifact.language.toLowerCase()] ?? artifact.language : ''
  return `\`\`\`${lang}\n${content.replace(/\s+$/g, '')}\n\`\`\``
}

/** 任意文本型成品 → 纯文本。 */
export function buildExportText(artifact: { kind: string }, content: string): string {
  if (artifact.kind === 'html') return htmlToText(content)
  return content
}

export const ARTIFACT_PREVIEW_SCHEME = 'morrow-artifact'

const PREVIEW_TTL_MS = 60 * 60 * 1000

const MAX_ENTRIES = 40

// 画布读取上限为 8MB；这里再留出滚动条/外链桥接注入的余量
const MAX_HTML_BYTES = 10 * 1024 * 1024

// 所有未过期预览的总内存上限，避免频繁切换大产物把渲染进程/主进程拖垮
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

const TOKEN_PATTERN = /^[a-f0-9]{36}$/

interface Entry {
  html: string
  createdAt: number
  bytes: number
}

const entries = new Map<string, Entry>()

let totalBytes = 0

function drop(token: string): void {
  const entry = entries.get(token)
  if (!entry) return
  totalBytes = Math.max(0, totalBytes - entry.bytes)
  entries.delete(token)
}

export const ARTIFACT_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  // 沙箱产物不能探测本机服务；远程资源只走 https
  "connect-src https:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function prune(now = Date.now()): void {
  for (const [token, entry] of entries) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) drop(token)
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (!oldest) break
    drop(oldest)
  }
  while (totalBytes > MAX_TOTAL_BYTES && entries.size > 1) {
    const oldest = entries.keys().next().value
    if (!oldest) break
    drop(oldest)
  }
}

/** 登记一份 HTML 内容，返回可放进 sandbox iframe 的 URL（token 随内容更新而变化） */
export function registerArtifactHtml(html: unknown): string {
  if (typeof html !== 'string') throw new Error('网页内容无效。')
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new Error(`网页产物过大（上限 ${MAX_HTML_BYTES / 1024 / 1024}MB）。`)
  }
  const now = Date.now()
  prune(now)
  const token = randomBytes(18).toString('hex')
  const bytes = Buffer.byteLength(html, 'utf8')
  entries.set(token, { html, createdAt: now, bytes })
  totalBytes += bytes
  prune(now)
  return `${ARTIFACT_PREVIEW_SCHEME}://preview/${token}`
}

/**
 * 内置浏览器只允许打开本服务签发的预览 URL：固定 host + 36 位 token，
 * 避免把浏览器视图变成任意本地/远程页面的入口。
 */
export function isArtifactPreviewUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200) return false
  try {
    const url = new URL(value)
    if (url.protocol !== `${ARTIFACT_PREVIEW_SCHEME}:` || url.host !== 'preview') return false
    if (url.search || url.hash) return false
    const token = url.pathname.replace(/^\//, '')
    return !token.includes('/') && TOKEN_PATTERN.test(token)
  } catch {
    return false
  }
}

/** `protocol.handle` 入口；预览 URL 过期/不存在时返回可读的 404 */
export function handleArtifactPreview(request: Request): Response {
  prune()
  const url = new URL(request.url)
  const token = url.pathname.split('/').filter(Boolean).pop() ?? ''
  const entry = TOKEN_PATTERN.test(token) ? entries.get(token) : undefined
  if (!entry) {
    return new Response('预览已过期，请重新打开产物。', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    })
  }
  entry.createdAt = Date.now()
  return new Response(entry.html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': ARTIFACT_PREVIEW_CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}

const MAX_VERSIONS = 30

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,120}$/

const SAFE_VERSION_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/

const EXT: Record<string, string> = {
  html: '.html',
  markdown: '.md',
  svg: '.svg',
  text: '.txt',
  code: '.txt'
}

interface StoredVersion extends ArtifactVersionInfo {
  /** 快照文件（相对当前成品目录） */
  file: string
}

interface VersionIndex {
  version: 1
  artifactId: string
  versions: StoredVersion[]
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function safeSegment(value: string): string {
  if (SAFE_SEGMENT.test(value)) return value
  return `v_${createHash('sha1').update(value).digest('hex').slice(0, 16)}`
}

function artifactText(artifact: Artifact): string | null {
  // 文件型成品可能是图片/PDF/Office，按 UTF-8 读取会破坏内容，因此不做快照。
  if (artifact.kind === 'file') return null
  if (typeof artifact.content === 'string') return artifact.content
  if (!artifact.path) return null
  try {
    const stat = statSync(artifact.path)
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null
    return readFileSync(artifact.path, 'utf8')
  } catch {
    return null
  }
}

function atomicWrite(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content, { mode: 0o600 })
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
    }
    throw err
  }
  // Windows 上杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      renameSync(tmp, path)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        try {
          rmSync(tmp, { force: true })
        } catch {
        }
        throw err
      }
      if (attempt === 3) {
        try {
          writeFileSync(path, content, { mode: 0o600 })
          rmSync(tmp, { force: true })
          return
        } catch (writeErr) {
          try {
            rmSync(tmp, { force: true })
          } catch {
          }
          throw writeErr
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
    }
  }
}

function publicInfo(stored: StoredVersion): ArtifactVersionInfo {
  const { file: _file, ...info } = stored
  return info
}

export interface ArtifactVersionStoreOptions {
  /** 数据目录（会写到 <dir>/<sessionId>/<artifactId>/） */
  dir: string
  now?: () => number
}

export class ArtifactVersionStore {
  private readonly dir: string
  private readonly now: () => number

  constructor(options: ArtifactVersionStoreOptions) {
    if (!options?.dir) throw new Error('ArtifactVersionStore 需要数据目录')
    this.dir = resolve(options.dir)
    this.now = options.now ?? (() => Date.now())
  }

  private artifactDir(sessionId: string, artifactId: string): string {
    return join(this.dir, safeSegment(sessionId), safeSegment(artifactId))
  }

  private indexPath(sessionId: string, artifactId: string): string {
    return join(this.artifactDir(sessionId, artifactId), 'versions.json')
  }

  private readIndex(sessionId: string, artifactId: string): VersionIndex {
    const path = this.indexPath(sessionId, artifactId)
    if (!existsSync(path)) return { version: 1, artifactId, versions: [] }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as VersionIndex
      if (raw?.version !== 1 || !Array.isArray(raw.versions)) return { version: 1, artifactId, versions: [] }
      return {
        version: 1,
        artifactId,
        versions: raw.versions.filter(
          (item) =>
            item &&
            typeof item.id === 'string' &&
            typeof item.file === 'string' &&
            SAFE_VERSION_FILE.test(item.file) &&
            !item.file.includes('..')
        )
      }
    } catch {
      return { version: 1, artifactId, versions: [] }
    }
  }

  private writeIndex(sessionId: string, artifactId: string, index: VersionIndex): void {
    atomicWrite(this.indexPath(sessionId, artifactId), JSON.stringify(index, null, 2))
  }

  /** 记录一份快照；内容未变化时返回当前最新版本，不重复落盘。 */
  record(sessionId: string, artifact: Artifact, source?: ArtifactVersionSource): ArtifactVersionInfo | null {
    const text = artifactText(artifact)
    if (text === null) return null
    if (Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_BYTES) return null
    const hash = sha256(text)
    const index = this.readIndex(sessionId, artifact.id)
    const latest = index.versions[index.versions.length - 1]
    if (latest && latest.hash === hash) return publicInfo(latest)

    const directory = this.artifactDir(sessionId, artifact.id)
    mkdirSync(directory, { recursive: true })
    const id = `ver_${this.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const file = `${id}${EXT[artifact.kind] ?? '.txt'}`
    atomicWrite(join(directory, file), text)
    const info: StoredVersion = {
      id,
      artifactId: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      ...(artifact.language ? { language: artifact.language } : {}),
      createdAt: this.now(),
      source: source ?? (index.versions.length > 0 ? 'agent' : 'baseline'),
      size: Buffer.byteLength(text, 'utf8'),
      hash,
      restorable: true,
      file
    }
    index.versions.push(info)
    while (index.versions.length > MAX_VERSIONS) {
      const removed = index.versions.shift()
      if (removed) {
        try {
          rmSync(join(directory, removed.file), { force: true })
        } catch {
        }
      }
    }
    this.writeIndex(sessionId, artifact.id, index)
    return publicInfo(info)
  }

  /** Agent 一轮结束后批量同步；只记录真正变化的成品。 */
  syncArtifacts(sessionId: string, artifacts: Artifact[]): void {
    for (const artifact of artifacts) {
      try {
        this.record(sessionId, artifact, 'agent')
      } catch {
        // 单个成品版本失败不影响其他成品
      }
    }
  }

  list(sessionId: string, artifactId: string): ArtifactVersionInfo[] {
    return this.readIndex(sessionId, artifactId)
      .versions.slice()
      .reverse()
      .map(publicInfo)
  }

  read(sessionId: string, artifactId: string, versionId: string): { version: ArtifactVersionInfo; content: string } | null {
    const index = this.readIndex(sessionId, artifactId)
    const version = index.versions.find((item) => item.id === versionId)
    if (!version || !SAFE_VERSION_FILE.test(version.file) || version.file.includes('..')) return null
    try {
      const content = readFileSync(join(this.artifactDir(sessionId, artifactId), version.file), 'utf8')
      return { version: publicInfo(version), content }
    } catch {
      return null
    }
  }

  removeSession(sessionId: string): void {
    try {
      rmSync(join(this.dir, safeSegment(sessionId)), { recursive: true, force: true })
    } catch {
    }
  }

  /** 仅用于测试/诊断：成品版本目录。 */
  directoryFor(sessionId: string, artifactId: string): string {
    return this.artifactDir(sessionId, artifactId)
  }
}

export function describeAttachment(file: string): Attachment | null {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile()) return null

  const name = basename(file)
  const base = { id: makeAttachmentId(), name, path: file, size: stat.size }
  const mediaType = imageMediaTypeFor(name)
  if (mediaType) {
    if (stat.size > ATTACHMENT_IMAGE_SOURCE_MAX_BYTES) {
      return {
        ...base,
        kind: 'image',
        content: null,
        mediaType,
        note: `图片超过 ${formatBytes(ATTACHMENT_IMAGE_SOURCE_MAX_BYTES)}，未发送给模型`
      }
    }
    try {
      const data = readFileSync(file).toString('base64')
      return { ...base, kind: 'image', content: `data:${mediaType};base64,${data}`, mediaType }
    } catch {
      return null
    }
  }

  if (isTextFileName(name)) {
    if (stat.size > ATTACHMENT_TEXT_MAX_BYTES) {
      return {
        ...base,
        kind: 'file',
        content: null,
        note: `文本文件超过 ${formatBytes(ATTACHMENT_TEXT_MAX_BYTES)}，未内联`
      }
    }
    try {
      const decoded = decodeTextBytes(readFileSync(file))
      if (!decoded) {
        return { ...base, kind: 'file', content: null, note: '内容像二进制文件，未内联' }
      }
      const raw = decoded.text
      const truncated = raw.length > ATTACHMENT_TEXT_MAX_CHARS
      return {
        ...base,
        kind: 'text',
        content: truncated ? raw.slice(0, ATTACHMENT_TEXT_MAX_CHARS) : raw,
        ...(truncated
          ? {
              truncated: true,
              note: `内容过长，仅发送前 ${ATTACHMENT_TEXT_MAX_CHARS.toLocaleString('en-US')} 字符`
            }
          : {})
      }
    } catch {
      return null
    }
  }

  return { ...base, kind: 'file', content: null }
}

/** 从会话用户消息中收集显式附加的文件路径，作为只读工具的白名单。 */
export function collectAttachedFilePaths(messages: readonly ChatMessage[]): string[] {
  const paths = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const attachment of message.attachments ?? []) {
      if (attachment.path && attachment.kind !== 'image') paths.add(attachment.path)
      if (paths.size >= 32) return [...paths]
    }
  }
  return [...paths]
}

export function buildUserMessage(text: string, attachments?: Attachment[]): ChatMessage {
  const userText = text.trim()
  const parts: string[] = userText ? [userText] : []
  const images: ChatImage[] = []
  const meta: MessageAttachment[] = []
  let textBudget = ATTACHMENT_TOTAL_TEXT_MAX_CHARS
  let imageBudget = ATTACHMENT_TOTAL_IMAGE_MAX_BYTES

  for (const raw of (attachments ?? []).slice(0, ATTACHMENT_MAX_COUNT)) {
    const attachment = prepareAttachment(raw)
    let imageSent = false
    let note = attachment.note
    if (attachment.kind === 'text' && typeof attachment.content === 'string') {
      if (attachment.content.length > textBudget) {
        attachment.content = attachment.content.slice(0, Math.max(0, textBudget))
        attachment.truncated = true
        attachment.note = `所有文本附件合计超过 ${ATTACHMENT_TOTAL_TEXT_MAX_CHARS.toLocaleString('en-US')} 字符，仅发送了前部内容`
        note = attachment.note
      }
      textBudget -= attachment.content.length
    }
    if (attachment.kind === 'image') {
      const parsed = typeof attachment.content === 'string' ? parseDataUrl(attachment.content) : null
      if (parsed) {
        const bytes = base64Bytes(parsed.dataBase64)
        if (bytes > imageBudget) {
          attachment.note = `所有图片合计超过 ${Math.round(ATTACHMENT_TOTAL_IMAGE_MAX_BYTES / 1024 / 1024)}MB，这张图片未发送给模型`
          note = attachment.note
        } else {
          images.push({ ...parsed, name: attachment.name })
          imageBudget -= bytes
          imageSent = true
        }
      } else if (!note) {
        note = '图片未能读取（过大或格式不支持），未发送给模型'
      }
    }
    parts.push(attachmentBlock(attachment, imageSent, note))
    meta.push({
      name: attachment.name,
      ...(attachment.path ? { path: attachment.path } : {}),
      size: attachment.size,
      kind: attachment.kind,
      ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
      ...(note ? { note } : {}),
      ...(attachment.truncated ? { truncated: true } : {})
    })
  }

  return {
    id: `msg_${randomUUID().slice(0, 12)}`,
    role: 'user',
    content: [{ type: 'text', text: parts.join('\n\n') }],
    createdAt: Date.now(),
    displayText: userText,
    ...(meta.length > 0 ? { attachments: meta } : {}),
    ...(images.length > 0 ? { images } : {})
  }
}

/** 附件来自渲染层，进入模型上下文前统一钳制，避免超长内容或控制字符污染提示词。 */
function prepareAttachment(input: Attachment): Attachment {
  const name = sanitizeLabel(input.name, 200) || '附件'
  const path = sanitizeLabel(input.path ?? '', 1024)
  const kind = input.kind === 'image' || input.kind === 'text' ? input.kind : 'file'
  let content = typeof input.content === 'string' ? input.content : null
  let note = sanitizeLabel(input.note ?? '', 300) || undefined
  let truncated = Boolean(input.truncated)
  if (kind === 'image') {
    // 图片只接受 data URL；限制长度，避免伪造的超长字符串进入主进程内存
    if (!content || content.length > 7_200_000 || !/^data:image\//i.test(content)) {
      content = null
      note ??= '图片内容无效，未发送给模型'
    }
  } else if (kind === 'text') {
    if (content !== null && content.length > ATTACHMENT_TEXT_MAX_CHARS) {
      content = content.slice(0, ATTACHMENT_TEXT_MAX_CHARS)
      truncated = true
      note ??= `内容过长，仅发送前 ${ATTACHMENT_TEXT_MAX_CHARS.toLocaleString('en-US')} 字符`
    }
  } else {
    // 普通文件只传元数据，正文必须由 read_file/read_pdf 等有审批边界的工具读取
    content = null
  }
  const size = Number.isFinite(input.size) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, input.size)) : 0
  return {
    id: sanitizeLabel(input.id, 80) || makeAttachmentId(),
    name,
    path,
    size,
    kind,
    content,
    ...(input.mediaType
      ? { mediaType: sanitizeLabel(input.mediaType, 100).toLowerCase().replace(/^image\/jpg$/, 'image/jpeg') }
      : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(note ? { note } : {})
  }
}

function sanitizeLabel(value: string, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function attachmentBlock(attachment: Attachment, imageSent: boolean, note?: string): string {
  const header = `[附件] ${attachment.name}（${formatBytes(attachment.size)}${attachment.path ? `，路径：${attachment.path}` : ''}）`
  if (attachment.kind === 'image') {
    return imageSent
      ? `${header}：图片已作为视觉输入附在本条消息里，请直接看图回答，不要靠文件名猜内容。`
      : `${header}：${note ?? '图片未能读取（过大或格式不支持）'}，不要猜测图片内容。`
  }
  if (typeof attachment.content === 'string') {
    const body = attachment.truncated ? `${attachment.content}\n…（内容过长，已截断）` : attachment.content
    return `${header}\n\`\`\`\n${body}\n\`\`\``
  }
  const ext = attachment.name.split('.').pop()?.toLowerCase() ?? ''
  const reader =
    ext === 'pdf'
      ? 'read_pdf'
      : ext === 'docx'
        ? 'read_docx'
        : ext === 'xlsx'
          ? 'read_xlsx'
          : ext === 'pptx'
            ? 'read_pptx'
            : null
  if (reader) {
    return `${header}：${note ?? '文件内容未内联'}。这个文件已随本条消息授权只读访问，需要时用 ${reader} 读取上面的完整路径。`
  }
  if (isTextFileName(attachment.name)) {
    return `${header}：${note ?? '文件内容未内联'}。需要时用 read_file 读取上面的路径，不要猜测正文。`
  }
  if (ext === 'xls') {
    return `${header}：旧版 .xls 无法直接读取；需要用户先另存为 .xlsx。`
  }
  return `${header}：${note ?? '该格式无法直接内联'}。不要猜测文件内容；需要时先与用户确认，或转换为文本/PDF/DOCX/XLSX 后再处理。`
}

/** 只接受主流视觉接口支持的格式；BMP 由渲染层先转成 PNG 再发送。 */
function parseDataUrl(dataUrl: string): ChatImage | null {
  const trimmed = dataUrl.trim()
  // 5MB 图片的 base64 约 6.99M 字符；先挡掉异常超长输入，避免大正则扫描拖住主进程
  if (trimmed.length > 7_200_000) return null
  const match = /^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=]+)$/i.exec(trimmed)
  if (!match) return null
  const mediaType = match[1].toLowerCase().replace(/^image\/jpg$/, 'image/jpeg')
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mediaType)) return null
  const dataBase64 = match[2]
  if (dataBase64.length % 4 !== 0) return null
  const bytes = base64Bytes(dataBase64)
  if (bytes > ATTACHMENT_IMAGE_MAX_BYTES) return null
  return { mediaType, dataBase64 }
}

function base64Bytes(dataBase64: string): number {
  if (dataBase64.length % 4 !== 0) return Number.POSITIVE_INFINITY
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0
  return (dataBase64.length / 4) * 3 - padding
}

function makeAttachmentId(): string {
  return `att_${Date.now()}_${randomBytes(3).toString('hex')}`
}

/** Agent 打开网页时通知渲染层展开浏览器面板 */
export const BROWSER_PRESENT_EVENT = 'feature:browser:present'

/** Agent 关闭浏览器时通知渲染层收起面板 */
export const BROWSER_CLOSED_EVENT = 'feature:browser:closed'

interface SurfaceHandle {
  id: string
  view: WebContentsView
  owner: BrowserWindow
  visible: boolean
  bounds: BrowserBounds | null
  error: { code: string; message: string } | null
  createdAt: number
}

interface PendingDownload {
  request: BrowserDownloadRequest
  item: Electron.DownloadItem
  /** 批准前文件只写到 app 数据目录的暂存区，不进入用户下载目录 */
  holdingPath: string
  /** 下载字节是否已写完（用户仍可稍后决定） */
  done: boolean
  /** Electron 的 done 状态：completed / cancelled / interrupted */
  doneState?: string
  /** 用户已批准，等下载写完后再移动 */
  approved: boolean
  timer: NodeJS.Timeout
}

function emptyState(): BrowserState {
  return {
    open: false,
    visible: false,
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    automationActive: false,
    tabs: [],
    activeTabId: null
  }
}

function safeFilename(name: string): string {
  let base = basename(name || 'download.bin')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
  // Windows 设备名不能作为文件名
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(base)) base = `_${base}`
  return (base || 'download.bin').slice(0, 160)
}

/** 同名冲突时保留原扩展名，例如 report.pdf → report-1.pdf */
function uniqueDownloadPath(target: string): string {
  if (!existsSync(target)) return target
  const ext = extname(target)
  const stem = target.slice(0, target.length - ext.length)
  for (let index = 1; index <= 1_000; index += 1) {
    const candidate = `${stem}-${index}${ext}`
    if (!existsSync(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

function describeTarget(target: string): string {
  return target.length > 80 ? `${target.slice(0, 80)}…` : target
}

/** Windows 上杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY。 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
      if (attempt === 3) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
    }
  }
}

function insideDirectory(root: string, target: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = normalize(root).replace(/[\\/]+$/, '')
  const candidate = normalize(target)
  return candidate === base || candidate.startsWith(`${base}${sep}`)
}

/** executeJavaScript 可能返回 undefined/不可序列化值：统一转成 JSON 安全结构 */
type LocateResult =
  | { ok: true; x: number; y: number; tag: string; label: string; locatorId: string }
  | { ok: false; reason: string }

type ReadPageResult = { url: string; title: string; text: string }

export class BrowserService {
  private static instance: BrowserService | null = null

  private initialized = false
  /** 活动标签（保持原有单 surface 代码路径） */
  private surface: SurfaceHandle | null = null
  private tabs = new Map<string, SurfaceHandle>()
  private tabOrder: string[] = []
  private activeTabId: string | null = null
  /** 窗口 resize 只绑定一次，不能按标签重复绑定 */
  private ownerListeners: BrowserWindow | null = null
  private state: BrowserState = emptyState()
  private pendingDownloads = new Map<string, PendingDownload>()
  private actionCounts = new Map<string, number>()
  private ownsWebContents = new Set<number>()
  private scrollbarStyled = new Set<number>()
  /** 隐藏/重新展开后必须先收到新的面板 bounds，再显示原生视图，避免旧边界盖住工具栏 */
  private boundsStale = true
  private automationTimer: NodeJS.Timeout | null = null

  static getInstance(): BrowserService {
    if (!BrowserService.instance) BrowserService.instance = new BrowserService()
    return BrowserService.instance
  }

  /* ── 初始化 ─────────────────────────────────────────────────── */

  initialize(): void {
    if (this.initialized) return
    this.initialized = true

    const browserSession = this.browserSession()
    // 内置浏览器使用独立分区：主进程默认 session 上注册的产物协议在这里也要再注册一份，
    // 否则画布成品无法在内置浏览器里打开。
    browserSession.protocol.handle(ARTIFACT_PREVIEW_SCHEME, handleArtifactPreview)
    // 权限：摄像头/麦克风/地理位置/通知/剪贴板/全屏等一律拒绝
    browserSession.setPermissionRequestHandler((webContents, permission, callback) => {
      log.warn('browser permission denied', { permission, url: webContents?.getURL?.() ?? '' })
      callback(false)
    })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.on('will-download', (event, item, webContents) => {
      this.handleDownload(event, item, webContents)
    })

    // 证书错误：只处理本服务持有的 webContents，明确拒绝（保护其余窗口默认行为）
    app.on('certificate-error', (event, webContents, url, error, _certificate, callback) => {
      if (!this.ownsWebContents.has(webContents.id)) return
      event.preventDefault()
      callback(false)
      log.warn('browser certificate error rejected', { url, error })
      const tab = this.tabForWebContents(webContents.id)
      if (tab) this.reportTabError(tab, { code: `CERT_${error}`, message: `证书错误，已拒绝连接：${url}` })
    })

    app.on('before-quit', () => {
      try {
        this.shutdown()
      } catch (err) {
        log.warn('browser shutdown error', String(err))
      }
    })

    // Chromium 需要可写的 downloads 目录才能完成下载（受限令牌下默认用户 Downloads 可能不可写，
    // 实测会导致 download 在 0 字节处 interrupted）。把应用级 downloads 指到数据目录。
    try {
      const downloadsDir = dataPath('downloads')
      mkdirSync(downloadsDir, { recursive: true })
      app.setPath('downloads', downloadsDir)
    } catch (err) {
      log.warn('browser downloads path setup failed', String(err))
    }

    // E2E/测试模式提供只读入口（不暴露给生产渲染进程）：用于 Playwright 断言真实浏览器窗口
    if (process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')) {
      ;(globalThis as typeof globalThis & { __morrowBrowserService?: BrowserService }).__morrowBrowserService = this
    }
    log.info('browser service initialized', { partition: BROWSER_PARTITION })
  }

  private browserSession(): Session {
    return session.fromPartition(BROWSER_PARTITION)
  }

  private shutdown(): void {
    for (const pending of this.pendingDownloads.values()) {
      clearTimeout(pending.timer)
      if (!pending.done) {
        try {
          pending.item.cancel()
        } catch {
        }
      }
      try {
        rmSync(pending.holdingPath, { force: true })
      } catch {
      }
    }
    this.pendingDownloads.clear()
    this.closeSurface()
  }

  /* ── UI surface ─────────────────────────────────────────────── */

  /**
   * 主进程全局安全策略（main/index.ts 的 app.on('web-contents-created')）会拦截所有
   * 非 file:// 导航并调用 shell.openExternal —— 对普通窗口正确，但会让内置浏览器
   * 点击链接变成「在系统浏览器打开」。浏览器的 webContents 必须换成本服务更严格的策略
   * （只允许 http/https，且禁止外部拉起），因此创建后先清掉全局 will-navigate 监听，
   * 再由 attachNavigationGuards 安装自己的守卫。
   * 注意：只对本服务创建的 webContents 生效，不影响主窗口。
   */
  private adoptOwnNavigationPolicy(webContents: WebContents): void {
    try {
      webContents.removeAllListeners('will-navigate')
    } catch (err) {
      log.warn('browser detach global will-navigate failed', String(err))
    }
  }

  private createView(owner: BrowserWindow): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        ...BROWSER_WEB_PREFERENCES,
        // 注意：不设置 preload —— 远程页面拿不到任何 Morrow 能力
        preload: undefined
      }
    })
    this.adoptOwnNavigationPolicy(view.webContents)
    view.setBackgroundColor('#0b0d10')
    const webContentsId = view.webContents.id
    this.ownsWebContents.add(webContentsId)
    view.webContents.on('destroyed', () => {
      this.ownsWebContents.delete(webContentsId)
      this.scrollbarStyled.delete(webContentsId)
    })
    this.attachNavigationGuards(view.webContents)
    owner.contentView.addChildView(view)
    return view
  }

  private bindOwner(owner: BrowserWindow): void {
    if (this.ownerListeners === owner) return
    this.unbindOwner()
    this.ownerListeners = owner
    owner.on('resize', this.onOwnerResize)
    owner.on('enter-full-screen', this.onOwnerResize)
    owner.on('leave-full-screen', this.onOwnerResize)
  }

  private unbindOwner(): void {
    const owner = this.ownerListeners
    this.ownerListeners = null
    if (!owner || owner.isDestroyed()) return
    owner.removeListener('resize', this.onOwnerResize)
    owner.removeListener('enter-full-screen', this.onOwnerResize)
    owner.removeListener('leave-full-screen', this.onOwnerResize)
  }

  private tabForWebContents(webContentsId: number): SurfaceHandle | null {
    if (typeof webContentsId !== 'number') return null
    for (const tab of this.tabs.values()) {
      try {
        const webContents = tab.view?.webContents
        if (webContents && !webContents.isDestroyed() && webContents.id === webContentsId) return tab
      } catch {
        // 标签已销毁：跳过
      }
    }
    return null
  }

  private tabInfo(tab: SurfaceHandle): BrowserTabInfo {
    const webContents = tab.view.webContents
    const liveUrl = webContents.isDestroyed() ? '' : webContents.getURL()
    const url = !liveUrl || liveUrl === 'about:blank' ? '' : liveUrl
    return {
      id: tab.id,
      url,
      title: webContents.isDestroyed() ? '' : webContents.getTitle(),
      loading: webContents.isDestroyed() ? false : webContents.isLoading(),
      ...this.historyState(webContents),
      error: tab.error
    }
  }

  private tabInfos(): BrowserTabInfo[] {
    return this.tabOrder
      .map((id) => this.tabs.get(id))
      .filter((tab): tab is SurfaceHandle => Boolean(tab) && !tab!.view.webContents.isDestroyed())
      .map((tab) => this.tabInfo(tab))
  }

  private emitState(): void {
    this.emitToOwner('feature:browser:state', this.getState())
  }

  private activateTabObject(tab: SurfaceHandle, emit = true): void {
    if (this.surface === tab) {
      this.state = { ...this.state, visible: tab.visible }
      this.applySurfaceVisibility()
      if (emit) this.emitState()
      return
    }
    if (this.surface?.view?.webContents && !this.surface.view.webContents.isDestroyed()) this.surface.view.setVisible(false)
    if (!tab.bounds) tab.bounds = this.surface?.bounds ?? null
    if (tab.bounds) {
      tab.view.setBounds(tab.bounds)
      this.boundsStale = false
    } else {
      this.boundsStale = true
    }
    this.surface = tab
    this.activeTabId = tab.id
    const webContents = tab.view.webContents
    const liveUrl = webContents.isDestroyed() ? '' : webContents.getURL()
    this.state = {
      open: true,
      visible: tab.visible && !tab.error,
      url: !liveUrl || liveUrl === 'about:blank' ? '' : liveUrl,
      title: webContents.isDestroyed() ? '' : webContents.getTitle(),
      loading: webContents.isDestroyed() ? false : webContents.isLoading(),
      ...this.historyState(webContents),
      error: tab.error,
      automationActive: false,
      tabs: [],
      activeTabId: tab.id
    }
    this.applySurfaceVisibility()
    if (emit) this.emitState()
  }

  private createTab(owner: BrowserWindow, url = '', bounds?: unknown, activate = true): SurfaceHandle {
    const view = this.createView(owner)
    const tab: SurfaceHandle = {
      id: `browser-tab-${randomUUID().slice(0, 8)}`,
      view,
      owner,
      visible: true,
      bounds: sanitizeBrowserBounds(bounds) ?? this.surface?.bounds ?? null,
      error: null,
      createdAt: Date.now()
    }
    this.tabs.set(tab.id, tab)
    this.tabOrder.push(tab.id)
    this.bindOwner(owner)
    if (tab.bounds) view.setBounds(tab.bounds)
    view.setVisible(false)
    if (activate) this.activateTabObject(tab, false)
    if (url) {
      this.state = { ...this.state, open: true, url, loading: true, error: null, visible: tab.visible }
      void view.webContents.loadURL(url).catch((err: Error) => {
        this.reportTabError(tab, { code: 'LOAD_FAILED', message: `页面加载失败：${err.message}` })
      })
    }
    this.applySurfaceVisibility()
    this.emitState()
    return tab
  }

  private disposeTab(tab: SurfaceHandle): void {
    this.tabs.delete(tab.id)
    this.tabOrder = this.tabOrder.filter((id) => id !== tab.id)
    try {
      tab.view.setVisible(false)
    } catch {
    }
    setImmediate(() => {
      try {
        if (!tab.owner.isDestroyed()) tab.owner.contentView.removeChildView(tab.view)
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
      } catch (err) {
        log.warn('browser tab dispose error', String(err))
      }
    })
  }

  private reportTabError(tab: SurfaceHandle, error: { code: string; message: string }): void {
    tab.error = error
    if (tab !== this.surface) {
      log.warn('browser tab error (inactive)', { tabId: tab.id, ...error })
      this.emitState()
      return
    }
    this.state = { ...this.state, loading: false, error }
    this.state.visible = false
    this.emitState()
    this.applySurfaceVisibility()
  }

  /** 新建一个空白标签并激活；url 为空时等待用户在地址栏输入。 */
  newTab(event: Electron.IpcMainInvokeEvent, url = '', bounds?: unknown): BrowserState {
    const owner = this.ownerFromEvent(event) ?? this.ownerWindow()
    if (!owner) throw new Error('找不到主窗口，无法新建标签。')
    let target = url.trim()
    if (target) {
      const check = normalizeBrowserAddress(target)
      if (!check.allowed || !check.url) throw new Error(check.reason ?? '网址无效。')
      target = check.url
    }
    if (this.surface && this.surface.owner.id !== owner.id) this.closeSurface()
    this.createTab(owner, target, bounds, true)
    this.emitToOwner(BROWSER_PRESENT_EVENT, { source: 'user' })
    return this.getState()
  }

  activateTab(id: string): BrowserState {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error('这个标签已经关闭。')
    this.activateTabObject(tab)
    this.emitToOwner(BROWSER_PRESENT_EVENT, { source: 'user' })
    return this.getState()
  }

  closeTab(id: string): BrowserState {
    const tab = this.tabs.get(id)
    if (!tab) return this.getState()
    const wasActive = tab === this.surface
    const index = this.tabOrder.indexOf(id)
    const owner = tab.owner
    this.disposeTab(tab)
    if (wasActive) {
      const nextId = this.tabOrder[Math.min(index, this.tabOrder.length - 1)] ?? this.tabOrder[0] ?? null
      if (nextId) this.activateTabObject(this.tabs.get(nextId)!, false)
      else {
        this.closeSurface()
        if (!owner.isDestroyed()) owner.webContents.send(BROWSER_CLOSED_EVENT, {})
        return this.getState()
      }
    }
    this.emitState()
    return this.getState()
  }

  private attachNavigationGuards(webContents: WebContents): void {
    // 自动化与用户共用同一个 surface：加载/错误都写入同一个面板状态
    const isSurface = (): boolean => {
      try {
        return Boolean(this.surface?.view?.webContents && !this.surface.view.webContents.isDestroyed() && this.surface.view.webContents.id === webContents.id)
      } catch {
        return false
      }
    }
    const blocked = (url: string, kind: string): void => {
      log.warn('browser navigation blocked', { url, kind })
      if (!isSurface()) return
      this.reportError({
        code: 'NAVIGATION_BLOCKED',
        message: `已拦截不允许的导航：${url.slice(0, 200)}（只允许 http/https 网页）。`
      })
    }
    webContents.on('will-navigate', (event, url) => {
      if (!isBrowserNavigationAllowed(url)) {
        event.preventDefault()
        blocked(url, 'will-navigate')
      }
    })
    webContents.on('will-redirect', (event, url) => {
      if (!isBrowserNavigationAllowed(url)) {
        event.preventDefault()
        blocked(url, 'will-redirect')
      }
    })
    webContents.setWindowOpenHandler(({ url }) => {
      // 不新增窗口（避免绕过 surface 安全边界），但 http/https 弹窗/新标签改为当前视图导航：
      // 真实网站大量使用 target="_blank"，一律拒绝会让用户觉得「点了没反应」。
      if (isBrowserNavigationAllowed(url)) {
        setTimeout(() => {
          if (webContents.isDestroyed()) return
          void webContents.loadURL(url).catch((err: Error) => {
            log.warn('browser popup navigation failed', { url: url.slice(0, 200), error: String(err) })
            if (isSurface()) this.reportError({ code: 'LOAD_FAILED', message: `页面加载失败：${err.message}` })
          })
        }, 0)
        return { action: 'deny' }
      }
      // 非 http/https 弹窗只记录日志，不能把整页隐藏成错误页（广告/统计脚本常发这类请求）
      log.warn('browser popup blocked', { url: url.slice(0, 200) })
      return { action: 'deny' }
    })
    webContents.on('will-attach-webview', (event) => event.preventDefault())
    webContents.on('dom-ready', () => {
      if (webContents.isDestroyed()) return
      // 远程页面看不到宿主 CSS：用 user origin 注入，确保无边框石墨+香槟金滚动条不被页面样式覆盖。
      void webContents
        .insertCSS(MORROW_SCROLLBAR_RULES, { cssOrigin: 'user' })
        .then(() => this.scrollbarStyled.add(webContents.id))
        .catch((err: Error) => log.warn('browser scrollbar css injection failed', String(err)))
    })
    webContents.on('did-start-loading', () => {
      // 新的导航尝试意味着从上一个错误页恢复：清掉错误并重新显示视图
      const tab = this.tabForWebContents(webContents.id)
      if (!tab) return
      if (tab === this.surface) {
        this.updateState({ loading: true, error: null, visible: this.surface?.visible ?? false })
      } else {
        tab.error = null
        this.emitState()
      }
    })
    webContents.on('did-stop-loading', () => {
      if (!isSurface()) return
      this.updateState({ loading: false })
      this.refreshStateFrom(webContents)
    })
    webContents.on('did-navigate', () => this.refreshStateFrom(webContents))
    webContents.on('did-navigate-in-page', () => this.refreshStateFrom(webContents))
    webContents.on('page-title-updated', () => this.refreshStateFrom(webContents))
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isSurface() || !isMainFrame || errorCode === -3 /* ABORTED */) return
      this.updateState({
        loading: false,
        error: { code: String(errorCode), message: `页面加载失败：${errorDescription || '未知错误'}（${validatedURL.slice(0, 160)}）` }
      })
    })
  }

  getState(): BrowserState {
    if (!this.surface) return { ...emptyState(), tabs: this.tabInfos(), activeTabId: this.activeTabId }
    return { ...this.state, tabs: this.tabInfos(), activeTabId: this.activeTabId }
  }

  private updateState(patch: Partial<BrowserState>): void {
    if (this.surface && 'error' in patch) this.surface.error = patch.error ?? null
    this.state = { ...this.state, ...patch }
    if (patch.error) this.state.visible = false
    this.emitToOwner('feature:browser:state', this.getState())
    this.applySurfaceVisibility()
  }

  /**
   * Electron 44 在部分真实站点（尤其导航经过服务器重定向）后 `canGoBack()` 会误报 false，
   * 但历史条目与活动索引是正确的。这里按索引自行判断，避免后退按钮失效。
   */
  private historyState(webContents: WebContents): { canGoBack: boolean; canGoForward: boolean } {
    try {
      const nav = webContents.navigationHistory
      const index = nav.getActiveIndex()
      const length = nav.length()
      return {
        canGoBack: index > 0,
        canGoForward: index >= 0 && index < length - 1
      }
    } catch {
      return { canGoBack: false, canGoForward: false }
    }
  }

  private refreshStateFrom(webContents?: WebContents | null): void {
    if (!webContents) return
    try {
      if (webContents.isDestroyed() || typeof webContents.id !== 'number') return
    } catch {
      return
    }
    const tab = this.tabForWebContents(webContents.id)
    if (!tab || !this.surface || tab !== this.surface) {
      if (tab) this.emitState()
      return
    }
    const history = this.historyState(webContents)
    this.state = {
      ...this.state,
      open: true,
      url: webContents.getURL(),
      title: webContents.getTitle(),
      loading: webContents.isLoading(),
      ...history
    }
    this.emitState()
  }

  private emitToOwner(channel: string, payload: unknown): void {
    const owner = this.surface?.owner
    if (!owner || owner.isDestroyed()) return
    owner.webContents.send(channel, payload)
  }

  private ownerFromEvent(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
    return BrowserWindow.fromWebContents(event.sender)
  }

  /**
   * Agent 没有 IPC event：优先主窗口，而不是当前聚焦的任意窗口。
   * 灵动岛是 356/396px 宽、置顶的小窗口；不能把网页嵌到它里面。
   */
  private ownerWindow(): BrowserWindow | null {
    const mainSized = (window: BrowserWindow): boolean => {
      if (window.isDestroyed()) return false
      const bounds = window.getContentBounds()
      return bounds.width >= 800 && bounds.height >= 600
    }
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && mainSized(focused)) return focused
    const mainWindows = BrowserWindow.getAllWindows().filter(mainSized)
    if (mainWindows.length > 0) return mainWindows[0]
    if (focused && !focused.isDestroyed()) return focused
    return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null
  }

  /** Agent 正在操作页面：状态里短暂标记，UI 显示「Morrow 操作中」。 */
  private markAutomation(): void {
    if (this.automationTimer) clearTimeout(this.automationTimer)
    this.state = { ...this.state, automationActive: true }
    this.emitToOwner('feature:browser:state', this.getState())
    this.automationTimer = setTimeout(() => {
      this.automationTimer = null
      if (!this.state.automationActive) return
      this.state = { ...this.state, automationActive: false }
      this.emitToOwner('feature:browser:state', this.getState())
    }, 4_000)
    this.automationTimer.unref?.()
  }

  private clearAutomationIndicator(): void {
    if (this.automationTimer) {
      clearTimeout(this.automationTimer)
      this.automationTimer = null
    }
    if (!this.state.automationActive) return
    this.state = { ...this.state, automationActive: false }
    this.emitToOwner('feature:browser:state', this.getState())
  }

  /** Agent 第一次操作时创建可见标签，并通知渲染层打开浏览器面板。 */
  private ensureSurfaceForAutomation(): SurfaceHandle {
    const existing = this.surface
    if (existing && !existing.owner.isDestroyed()) {
      if (!existing.visible) {
        existing.visible = true
        this.state = { ...this.state, visible: true, error: null }
        this.applySurfaceVisibility()
        this.emitState()
      }
      this.emitToOwner(BROWSER_PRESENT_EVENT, { source: 'agent' })
      return existing
    }
    if (existing) this.closeSurface()
    if (this.tabs.size > 0) {
      const lastId = this.tabOrder[this.tabOrder.length - 1]
      const last = lastId ? this.tabs.get(lastId) : null
      if (last) {
        this.activateTabObject(last)
        this.emitToOwner(BROWSER_PRESENT_EVENT, { source: 'agent' })
        return last
      }
    }

    const owner = this.ownerWindow()
    if (!owner) throw new Error('找不到 Morrow 主窗口，无法打开内置浏览器。')
    const handle = this.createTab(owner, '', undefined, true)
    this.emitToOwner(BROWSER_PRESENT_EVENT, { source: 'agent' })
    log.info('browser tab created for automation')
    return handle
  }

  private requireSurface(): SurfaceHandle {
    const surface = this.surface
    if (!surface || surface.owner.isDestroyed()) {
      throw new Error('浏览器还没有打开。请先使用 browser_open 打开一个网页。')
    }
    return surface
  }

  /** 等渲染层把面板 bounds 同步过来，避免 Agent 操作时用户还看不到页面。 */
  private async waitForSurfaceShown(timeoutMs = 1_500): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (this.surface?.bounds) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /** feature:browser:open { url, bounds? } */
  openSurface(url: string, event: Electron.IpcMainInvokeEvent, bounds?: unknown): BrowserState {
    const check = normalizeBrowserAddress(url)
    if (!check.allowed || !check.url) throw new Error(check.reason ?? '网址无效。')
    const owner = this.ownerFromEvent(event) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!owner) throw new Error('找不到主窗口，无法打开内置浏览器。')
    return this.presentSurface(check.url, owner, bounds)
  }

  /**
   * feature:browser:open-preview { url }
   * 画布 HTML 成品直接在内置浏览器查看：不经过系统默认浏览器，也就不会触发
   * Edge 的「现有实例正在以提升的权限运行」提示。URL 必须由 artifact-preview 签发。
   */
  openPreview(url: string, event: Electron.IpcMainInvokeEvent, bounds?: unknown): BrowserState {
    if (!isArtifactPreviewUrl(url)) throw new Error('成品预览地址无效或已过期。')
    const owner = this.ownerFromEvent(event) ?? this.ownerWindow()
    if (!owner) throw new Error('找不到主窗口，无法打开内置浏览器。')
    const state = this.presentSurface(url, owner, bounds)
    this.emitToOwner(BROWSER_PRESENT_EVENT, { source: 'artifact' })
    return state
  }

  private presentSurface(url: string, owner: BrowserWindow, bounds?: unknown): BrowserState {
    // 已存在且属于同一窗口：直接在当前标签导航
    if (this.surface && this.surface.owner.id === owner.id) {
      this.activateTabObject(this.surface, false)
      this.clearAutomationIndicator()
      this.surface.error = null
      this.state = {
        ...this.state,
        open: true,
        error: null,
        url,
        loading: true,
        visible: this.surface.visible
      }
      this.updateState({ visible: this.surface.visible })
      void this.surface.view.webContents.loadURL(url).catch((err: Error) => {
        this.reportError({ code: 'LOAD_FAILED', message: `页面加载失败：${err.message}` })
      })
      return this.getState()
    }
    this.closeSurface()
    this.createTab(owner, url, bounds, true)
    log.info('browser tab opened', { url })
    return this.getState()
  }

  private onOwnerResize = (): void => {
    if (this.surface?.bounds) this.setBounds(this.surface.bounds)
  }

  /** feature:browser:set-bounds { x,y,width,height }：所有标签共用同一个网页视口 */
  setBounds(rawBounds: unknown): BrowserBounds | null {
    const surface = this.surface
    if (!surface) return null
    const sanitized = sanitizeBrowserBounds(rawBounds)
    if (!sanitized) return null
    const owner = surface.owner
    const content = owner.isDestroyed() ? null : owner.getContentBounds()
    const maxWidth = content?.width ?? sanitized.width
    const maxHeight = content?.height ?? sanitized.height
    const x = Math.max(0, Math.min(sanitized.x, Math.max(0, maxWidth - 1)))
    const y = Math.max(0, Math.min(sanitized.y, Math.max(0, maxHeight - 1)))
    const width = Math.max(1, Math.min(sanitized.width, maxWidth - x))
    const height = Math.max(1, Math.min(sanitized.height, maxHeight - y))
    const bounds: BrowserBounds = { x, y, width, height }
    this.boundsStale = false
    for (const tab of this.tabs.values()) {
      tab.bounds = bounds
      if (!tab.view.webContents.isDestroyed()) tab.view.setBounds(bounds)
    }
    this.applySurfaceVisibility()
    return bounds
  }

  setVisible(visible: boolean): void {
    if (!this.surface) return
    for (const tab of this.tabs.values()) tab.visible = visible
    // 隐藏后重新展开时必须由渲染层重新上报 bounds，防止旧视图盖住地址栏。
    if (!visible) this.boundsStale = true
    // 有致命错误时由渲染层错误页承载，原生视图保持隐藏
    this.state = { ...this.state, visible: visible && !(this.surface?.error ?? null) }
    this.applySurfaceVisibility()
    this.emitState()
  }

  private applySurfaceVisibility(): void {
    // 只有活动标签的原生视图可见；空标签/错误标签由渲染层空态或错误页承载。
    for (const [id, tab] of this.tabs) {
      if (tab.view.webContents.isDestroyed()) continue
      const active = tab === this.surface && id === this.activeTabId
      const show =
        active &&
        tab.visible &&
        tab.bounds !== null &&
        !this.boundsStale &&
        !tab.error &&
        (this.state.url !== '' || this.state.loading)
      tab.view.setVisible(show)
    }
  }

  navigate(url: string): BrowserState {
    if (!this.surface) throw new Error('浏览器未打开。')
    this.clearAutomationIndicator()
    const check = normalizeBrowserAddress(url)
    if (!check.allowed || !check.url) throw new Error(check.reason ?? '网址无效。')
    this.state = { ...this.state, error: null, url: check.url, loading: true, visible: this.surface.visible }
    this.updateState({ error: null, loading: true, visible: this.surface.visible })
    void this.surface.view.webContents.loadURL(check.url).catch((err: Error) => {
      this.reportError({ code: 'LOAD_FAILED', message: `页面加载失败：${err.message}` })
    })
    return this.getState()
  }

  back(): BrowserState {
    return this.goHistory('back')
  }

  forward(): BrowserState {
    return this.goHistory('forward')
  }

  private goHistory(direction: 'back' | 'forward'): BrowserState {
    const surface = this.surface
    if (!surface) throw new Error('浏览器未打开。')
    this.clearAutomationIndicator()
    const webContents = surface.view.webContents
    const nav = webContents.navigationHistory
    const index = nav.getActiveIndex()
    const target = direction === 'back' ? index - 1 : index + 1
    if (index < 0 || target < 0) throw new Error('已经到第一页，无法后退。')
    if (target >= nav.length()) throw new Error('已经在最后一页，无法前进。')
    nav.goToIndex(target)
    setTimeout(() => {
      // 用户在 300ms 内关闭标签/面板是正常操作：定时器不能碰已销毁的视图
      if (!webContents.isDestroyed()) this.refreshStateFrom(webContents)
    }, 300)
    return this.getState()
  }

  reload(): BrowserState {
    if (!this.surface) throw new Error('浏览器未打开。')
    this.clearAutomationIndicator()
    this.surface.view.webContents.reload()
    this.updateState({ loading: true, error: null, visible: this.surface.visible })
    return this.getState()
  }

  stop(): BrowserState {
    if (!this.surface) throw new Error('浏览器未打开。')
    this.surface.view.webContents.stop()
    this.updateState({ loading: false })
    return this.getState()
  }

  closeSurface(): void {
    if (this.automationTimer) {
      clearTimeout(this.automationTimer)
      this.automationTimer = null
    }
    const owner = this.surface?.owner ?? this.ownerListeners
    // 已批准的下载继续完成；未确认的请求随面板关闭取消，避免留下孤儿暂存文件
    for (const pending of [...this.pendingDownloads.values()]) {
      if (!pending.approved) this.cancelDownload(pending, '浏览器面板已关闭，未确认的下载已取消。')
    }
    for (const tab of [...this.tabs.values()]) this.disposeTab(tab)
    this.surface = null
    this.activeTabId = null
    this.state = emptyState()
    this.unbindOwner()
    if (owner && !owner.isDestroyed()) owner.webContents.send('feature:browser:state', this.getState())
    log.info('browser surface closed')
  }

  private reportError(error: { code: string; message: string }): void {
    if (!this.surface) return
    this.updateState({ error })
  }

  /* ── 下载确认 ───────────────────────────────────────────────── */

  private handleDownload(event: Electron.Event, item: Electron.DownloadItem, webContents: WebContents): void {
    const tab = webContents ? this.tabForWebContents(webContents.id) : null
    if (!tab || tab.owner.isDestroyed()) {
      // 只有内置浏览器标签才能发起下载，其它 webContents 不允许静默下载
      event.preventDefault()
      log.warn('browser download rejected (no tab)', { filename: item.getFilename(), url: item.getURL().slice(0, 200) })
      return
    }

    // 初次请求：先写进 app 数据目录的暂存区（不是用户下载目录），渲染层确认后再移动。
    // 不调用 preventDefault/pause —— 实测 pause() 在 Electron 44 下状态不可靠、downloadURL 重发会卡住；
    // 暂存 + 批准后移动是确定性的，也不会在用户下载目录出现未确认文件。
    const downloadsDir = dataPath('downloads')
    mkdirSync(downloadsDir, { recursive: true })
    const filename = safeFilename(item.getFilename())
    const request: BrowserDownloadRequest = {
      id: `download-${randomUUID().slice(0, 8)}`,
      filename,
      url: item.getURL().slice(0, 500),
      suggestedPath: join(downloadsDir, filename),
      totalBytes: item.getTotalBytes(),
      createdAt: Date.now()
    }
    const holdingDir = dataPath('tmp', 'browser-downloads')
    mkdirSync(holdingDir, { recursive: true })
    const holdingPath = join(holdingDir, `${request.id}-${filename}`)
    try {
      item.setSavePath(holdingPath)
    } catch (err) {
      log.warn('browser download setSavePath failed', String(err))
      event.preventDefault()
      return
    }
    const timer = setTimeout(() => this.expireDownload(request.id), 60_000)
    const pending: PendingDownload = { request, item, holdingPath, done: false, approved: false, timer }
    this.pendingDownloads.set(request.id, pending)
    item.on('done', (_doneEvent, state) => {
      pending.done = true
      pending.doneState = state
      log.info('browser download done', { id: request.id, state, bytes: item.getReceivedBytes(), holdingPath })
      if (state !== 'completed') {
        const active = this.pendingDownloads.get(request.id) === pending
        if (active) {
          this.pendingDownloads.delete(request.id)
          clearTimeout(pending.timer)
          this.emitToOwner('feature:browser:download-resolved', {
            id: request.id,
            filename: request.filename,
            allow: false,
            error: `下载未完成（${state}），文件已清理。`
          })
        }
        this.cleanupHolding(pending)
        return
      }
      if (pending.approved) this.finalizeDownload(pending)
    })
    this.emitToOwner('feature:browser:download', request)
    log.info('browser download requested', { id: request.id, filename, totalBytes: request.totalBytes, holdingPath })
  }

  private cleanupHolding(pending: PendingDownload): void {
    try {
      rmSync(pending.holdingPath, { force: true })
    } catch {
    }
  }

  /** 下载被取消/拒绝/超时后，等文件句柄释放再清理暂存文件 */
  private removeHoldingWhenDone(pending: PendingDownload): void {
    if (pending.done) {
      this.cleanupHolding(pending)
      return
    }
    const cleanup = (): void => this.cleanupHolding(pending)
    pending.item.once('done', cleanup)
    setTimeout(cleanup, 5_000)
  }

  private cancelDownload(pending: PendingDownload, message?: string): void {
    if (this.pendingDownloads.get(pending.request.id) === pending) {
      this.pendingDownloads.delete(pending.request.id)
    }
    clearTimeout(pending.timer)
    if (!pending.done) {
      try {
        pending.item.cancel()
      } catch {
      }
    }
    this.removeHoldingWhenDone(pending)
    this.emitToOwner('feature:browser:download-resolved', {
      id: pending.request.id,
      filename: pending.request.filename,
      allow: false,
      ...(message ? { error: message } : {})
    })
  }

  private expireDownload(id: string): void {
    const pending = this.pendingDownloads.get(id)
    if (!pending || pending.approved) return
    this.cancelDownload(pending, '下载确认超时，已取消。')
    log.info('browser download request expired (temp removed)', { id, filename: pending.request.filename })
  }

  /** 已批准但长时间收不到 done（异常网络/服务端不停重试）时的兜底 */
  private expireApprovedDownload(id: string): void {
    const pending = this.pendingDownloads.get(id)
    if (!pending || pending.done) return
    this.pendingDownloads.delete(id)
    clearTimeout(pending.timer)
    try {
      pending.item.cancel()
    } catch {
    }
    this.removeHoldingWhenDone(pending)
    this.emitToOwner('feature:browser:download-resolved', {
      id,
      filename: pending.request.filename,
      allow: false,
      error: '下载长时间未完成，已取消并清理暂存文件。'
    })
    log.info('browser approved download expired (temp removed)', { id, filename: pending.request.filename })
  }

  /** 批准后把暂存文件移动到用户下载目录（同名冲突时保留扩展名） */
  private finalizeDownload(pending: PendingDownload): void {
    if (!this.pendingDownloads.delete(pending.request.id)) return
    clearTimeout(pending.timer)
    if (pending.doneState !== 'completed') {
      this.cleanupHolding(pending)
      this.emitToOwner('feature:browser:download-resolved', {
        id: pending.request.id,
        filename: pending.request.filename,
        allow: false,
        error: '下载未完成，文件已清理。'
      })
      return
    }
    const target = uniqueDownloadPath(pending.request.suggestedPath)
    try {
      mkdirSync(dirname(target), { recursive: true })
      try {
        renameWithRetry(pending.holdingPath, target)
      } catch {
        copyFileSync(pending.holdingPath, target)
        rmSync(pending.holdingPath, { force: true })
      }
      log.info('browser download saved', { id: pending.request.id, path: target })
      this.emitToOwner('feature:browser:download-resolved', {
        id: pending.request.id,
        filename: pending.request.filename,
        allow: true,
        path: target
      })
    } catch (err) {
      log.warn('browser download move failed', String(err))
      this.cleanupHolding(pending)
      this.emitToOwner('feature:browser:download-resolved', {
        id: pending.request.id,
        filename: pending.request.filename,
        allow: false,
        error: String(err)
      })
    }
  }

  /** 在资源管理器中定位已批准的下载；只允许 app 数据目录的 downloads 内真实文件 */
  async revealDownload(rawPath: string): Promise<void> {
    const target = resolve(rawPath)
    let realTarget: string
    try {
      realTarget = realpathSync(target)
    } catch {
      throw new Error('文件已被移动或删除，无法定位。')
    }
    const downloadsDir = dataPath('downloads')
    let realDownloads = downloadsDir
    try {
      realDownloads = realpathSync(downloadsDir)
    } catch {
      // 目录可能尚未创建：保持原路径，下面的前缀检查会失败并给出明确错误
    }
    if (!insideDirectory(realDownloads, realTarget)) {
      throw new Error('只能定位内置浏览器下载目录里的文件。')
    }
    try {
      if (!statSync(realTarget).isFile()) throw new Error('not a file')
    } catch {
      throw new Error('这个路径不是可定位的文件。')
    }
    const error = await revealInFileManager(realTarget)
    if (error) throw new Error(error)
  }

  decideDownload(id: string, allow: boolean): void {
    const pending = this.pendingDownloads.get(id)
    if (!pending) throw new Error('下载请求不存在或已处理。')
    if (allow) {
      // 用户批准后不再受 60 秒确认窗口限制，但保留一个长时间兜底，避免异常连接永远挂起
      clearTimeout(pending.timer)
      pending.approved = true
      if (!pending.done) {
        pending.timer = setTimeout(() => this.expireApprovedDownload(id), 10 * 60_000)
        this.emitToOwner('feature:browser:download-resolved', {
          id,
          filename: pending.request.filename,
          allow: true,
          pending: true
        })
        log.info('browser download approved (waiting for bytes)', { id })
        return
      }
      this.finalizeDownload(pending)
      return
    }
    this.cancelDownload(pending)
    log.info('browser download denied + temp removed', { id })
  }

  /* ── K1 自动化：统一操作用户可见的 surface ──────────────── */

  private checkActionBudget(runId: string): void {
    const next = (this.actionCounts.get(runId) ?? 0) + 1
    if (next > BROWSER_LIMITS.maxActionsPerRun) {
      throw new Error(`本轮浏览器自动化已达到步数上限（${BROWSER_LIMITS.maxActionsPerRun} 次），请结束当前任务或重新发起。`)
    }
    this.actionCounts.set(runId, next)
    if (this.actionCounts.size > 200) {
      const key = this.actionCounts.keys().next().value
      if (key) this.actionCounts.delete(key)
    }
  }

  private stateOf(webContents: WebContents): BrowserState {
    const history = this.historyState(webContents)
    return {
      open: true,
      visible: this.surface?.visible ?? false,
      url: webContents.getURL(),
      title: webContents.getTitle(),
      loading: webContents.isLoading(),
      ...history,
      error: this.state.error ?? null,
      automationActive: this.state.automationActive,
      tabs: this.tabInfos(),
      activeTabId: this.activeTabId
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）。`)), timeoutMs)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        }
      )
    })
  }

  /** 执行页面脚本（带超时与错误归一化） */
  private async execute<T>(webContents: WebContents, script: string, timeoutMs: number, label: string): Promise<T> {
    try {
      return (await this.withTimeout(webContents.executeJavaScript(script, true), timeoutMs, label)) as T
    } catch (err) {
      throw new Error(`${label}失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 在页面里定位元素：先按 CSS selector，找不到再按可见文本/placeholder/aria-label */
  private async locateElement(webContents: WebContents, target: string, timeoutMs: number): Promise<LocateResult> {
    const payload = JSON.stringify(target)
    // 用一次性标记把「定位到的元素」交给后续点击/输入，避免二次查询选中别的元素
    const locatorId = `morrow-${randomUUID()}`
    const script = `(async () => {
      const target = ${payload};
      const locatorId = ${JSON.stringify(locatorId)};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const center = async (el) => {
        // 页面可能设置了 scroll-behavior: smooth；强制 instant 等一帧再取坐标，避免点到旧位置
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      };
      const describe = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      let el = null;
      let selectorError = null;
      try {
        el = document.querySelector(target);
      } catch (err) {
        selectorError = String(err && err.message ? err.message : err);
      }
      if (!el) {
        const clickable = ${JSON.stringify(BROWSER_LIMITS.clickableSelector)} + ',input,textarea,select,[contenteditable="true"]';
        const candidates = Array.from(document.querySelectorAll(clickable));
        const exact = candidates.find((candidate) => visible(candidate) && describe(candidate) === target);
        const fuzzy = candidates.find((candidate) => visible(candidate) && describe(candidate).includes(target));
        const byAttr = candidates.find((candidate) => visible(candidate) && (
          (candidate.getAttribute('placeholder') || '').includes(target) ||
          (candidate.getAttribute('aria-label') || '').includes(target) ||
          (candidate.getAttribute('name') || '').includes(target) ||
          (candidate.labels && Array.from(candidate.labels).some((label) => (label.innerText || '').includes(target)))
        ));
        el = exact || fuzzy || byAttr || null;
      }
      if (!el) return { ok: false, reason: selectorError ? ('CSS selector 无效：' + selectorError + '；也没有找到可见文本匹配的元素') : '没有找到匹配的可见元素' };
      if (!visible(el)) return { ok: false, reason: '元素存在但不可见' };
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: '元素处于禁用状态，暂时不能操作' };
      el.setAttribute('data-morrow-locator', locatorId);
      const point = await center(el);
      return { ok: true, x: point.x, y: point.y, tag: el.tagName, label: describe(el), locatorId };
    })()`
    const result = await this.execute<LocateResult>(webContents, script, timeoutMs, '定位网页元素')
    if (!result || typeof result !== 'object') return { ok: false, reason: '定位结果无效' }
    return result
  }

  private clearLocator(webContents: WebContents, locatorId: string): void {
    try {
      webContents
        .executeJavaScript(`document.querySelector('[data-morrow-locator="${locatorId}"]')?.removeAttribute('data-morrow-locator')`)
        .catch(() => undefined)
    } catch {
      // 页面可能正在导航
    }
  }

  private async waitForLoad(webContents: WebContents, timeoutMs: number): Promise<void> {
    if (!webContents.isLoading()) return
    let cleanup = (): void => undefined
    try {
      await this.withTimeout(
        new Promise<void>((resolve) => {
          const onStop = (): void => {
            cleanup()
            resolve()
          }
          cleanup = (): void => {
            webContents.removeListener('did-stop-loading', onStop)
            webContents.removeListener('did-fail-load', onStop)
          }
          webContents.once('did-stop-loading', onStop)
          webContents.once('did-fail-load', onStop)
        }),
        timeoutMs,
        '等待页面加载'
      )
    } finally {
      // 超时也要摘掉监听，避免每次失败都在页面对象上积累监听器
      cleanup()
    }
  }

  /* ── Bridge 实现 ────────────────────────────────────────────── */

  /** 每个非 open 动作都复用同一个可见 surface；未打开时给出可操作错误。 */
  private async automationSurface(): Promise<SurfaceHandle> {
    const surface = this.requireSurface()
    this.markAutomation()
    await this.waitForSurfaceShown()
    return surface
  }

  async automationOpen(url: string, ctx: BrowserCallContext): Promise<BrowserState> {
    this.checkActionBudget(ctx.runId)
    const check = checkBrowserUrl(url)
    if (!check.allowed || !check.url) throw new Error(check.reason ?? '网址无效。')
    const surface = this.ensureSurfaceForAutomation()
    this.markAutomation()
    await this.waitForSurfaceShown()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.openTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    // 本地预览服务经常刚通过 terminal(start) 启动，端口还没 listen；直接打开会得到 ERR_CONNECTION_REFUSED。
    // 对 localhost 做短暂重试，给静态服务器一个就绪窗口，而不是让 Agent 立刻换端口重来。
    const local = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(check.url)
    const attempts = local ? 12 : 1
    let lastError: unknown = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        await this.withTimeout(webContents.loadURL(check.url), timeoutMs, '打开网页')
        return this.stateOf(webContents)
      } catch (err) {
        lastError = err
        const message = err instanceof Error ? err.message : String(err)
        const retryable = /ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET/i.test(message)
        if (attempt < attempts - 1 && retryable) continue
        try {
          webContents.stop()
        } catch {
        }
        this.reportError({
          code: 'LOAD_FAILED',
          message: `页面加载失败：${message}`
        })
        throw new Error(
          `打开网页失败：${message}${local ? '。本地预览服务可能还没启动或端口已变化，请查看终端日志并确认服务正在监听这个端口。' : ''}`
        )
      }
    }
    throw new Error(`打开网页失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  async automationClick(target: string, ctx: BrowserCallContext): Promise<BrowserActionResult> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    const located = await this.locateElement(webContents, target, timeoutMs)
    if (!located.ok) throw new Error(located.reason)
    const navigationStarted = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        webContents.removeListener('did-start-navigation', onStart)
        resolve(false)
      }, 800)
      const onStart = (): void => {
        clearTimeout(timer)
        webContents.removeListener('did-start-navigation', onStart)
        resolve(true)
      }
      webContents.once('did-start-navigation', onStart)
    })
    webContents.sendInputEvent({ type: 'mouseDown', x: located.x, y: located.y, button: 'left', clickCount: 1 })
    webContents.sendInputEvent({ type: 'mouseUp', x: located.x, y: located.y, button: 'left', clickCount: 1 })
    const navigating = await navigationStarted
    if (navigating) await this.waitForLoad(webContents, BROWSER_LIMITS.actionTimeoutMs).catch(() => undefined)
    else await new Promise((resolve) => setTimeout(resolve, 150))
    this.clearLocator(webContents, located.locatorId)
    return {
      url: webContents.getURL(),
      title: webContents.getTitle(),
      target: `<${located.tag.toLowerCase()}> ${located.label}`.trim(),
      x: located.x,
      y: located.y,
      navigating
    }
  }

  async automationType(
    target: string,
    text: string,
    ctx: BrowserCallContext & { submit?: boolean }
  ): Promise<BrowserActionResult> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    const located = await this.locateElement(webContents, target, timeoutMs)
    if (!located.ok) throw new Error(located.reason)
    // 聚焦「刚才定位到的那个元素」并全选，避免按 target 二次查询时选中别的输入框
    const locatorId = located.locatorId
    const focused = await this.execute<{ ok: boolean; reason?: string }>(
      webContents,
      `(() => {
        const el = document.querySelector('[data-morrow-locator="${locatorId}"]');
        if (!el) return { ok: false, reason: '元素已从页面移除，请重新定位' };
        if (el.tagName === 'SELECT') {
          el.removeAttribute('data-morrow-locator');
          return { ok: false, reason: '下拉框不能直接输入文字，请用 browser_click 选择选项' };
        }
        if (el.tagName === 'INPUT') {
          const type = (el.type || 'text').toLowerCase();
          if (['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset', 'image', 'hidden'].includes(type)) {
            el.removeAttribute('data-morrow-locator');
            return { ok: false, reason: '这个输入类型（' + type + '）不支持文字输入' };
          }
        }
        el.focus();
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.select();
        } else if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }
        el.removeAttribute('data-morrow-locator');
        const active = document.activeElement;
        return { ok: active === el || (active && el.contains(active)) };
      })()`,
      timeoutMs,
      '聚焦输入框'
    )
    if (!focused?.ok) throw new Error(focused?.reason ?? '无法聚焦输入框')
    webContents.insertText(text)
    let submitted = false
    if (ctx.submit) {
      const entered = await this.execute<boolean>(
        webContents,
        `(() => {
          const el = document.activeElement;
          if (el && el.form && typeof el.form.requestSubmit === 'function') { el.form.requestSubmit(); return true; }
          if (el && el.form && typeof el.form.submit === 'function') { el.form.submit(); return true; }
          if (el) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
            return true;
          }
          return false;
        })()`,
        timeoutMs,
        '提交表单'
      )
      submitted = entered === true
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    return {
      url: webContents.getURL(),
      title: webContents.getTitle(),
      target: `<${located.tag.toLowerCase()}> ${located.label}${submitted ? '（已提交）' : ''}`.trim()
    }
  }

  async automationRead(ctx: BrowserCallContext & { maxChars?: number }): Promise<BrowserReadResult> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    const maxChars = Math.max(200, Math.min(ctx.maxChars ?? BROWSER_LIMITS.maxReadChars, BROWSER_LIMITS.maxReadChars))
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    // 在页面内就截断，避免超大页面把数 MB 文本经 IPC 回传后再丢弃
    const page = await this.execute<ReadPageResult>(
      webContents,
      `(() => {
        const raw = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim();
        return {
          url: location.href,
          title: (document.title || '').slice(0, 300),
          text: raw.slice(0, ${maxChars + 1})
        };
      })()`,
      timeoutMs,
      '读取网页内容'
    )
    const raw = typeof page?.text === 'string' ? page.text : ''
    return {
      url: typeof page?.url === 'string' ? page.url : webContents.getURL(),
      title: typeof page?.title === 'string' ? page.title : webContents.getTitle(),
      text: raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw,
      truncated: raw.length > maxChars
    }
  }

  async automationScreenshot(ctx: BrowserCallContext): Promise<BrowserScreenshotResult> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    const capture = async (): Promise<BrowserScreenshotResult> => {
      const image = await this.withTimeout(webContents.capturePage(), timeoutMs, '截取网页')
      const png = image.toPNG()
      if (!png || png.length === 0) throw new Error('截图内容为空')
      const size = image.getSize()
      return {
        pngBase64: png.toString('base64'),
        width: size.width,
        height: size.height,
        url: webContents.getURL(),
        title: webContents.getTitle()
      }
    }
    try {
      return await capture()
    } catch {
      // 可见视图首帧可能尚未绘制：稍等后重试一次
      await new Promise((resolve) => setTimeout(resolve, 300))
      return capture()
    }
  }

  async automationBack(ctx: BrowserCallContext): Promise<BrowserState> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    // Electron 44 的 canGoBack() 在部分站点会误报 false；用活动索引判断（与面板按钮一致）
    if (!this.historyState(webContents).canGoBack) throw new Error('已经到第一页，无法后退。')
    const nav = webContents.navigationHistory
    nav.goToIndex(nav.getActiveIndex() - 1)
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    return this.stateOf(webContents)
  }

  async automationForward(ctx: BrowserCallContext): Promise<BrowserState> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    if (!this.historyState(webContents).canGoForward) throw new Error('已经在最后一页，无法前进。')
    const nav = webContents.navigationHistory
    nav.goToIndex(nav.getActiveIndex() + 1)
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    return this.stateOf(webContents)
  }

  async automationReload(ctx: BrowserCallContext): Promise<BrowserState> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    webContents.reload()
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    return this.stateOf(webContents)
  }

  async automationScroll(ctx: BrowserCallContext, deltaY: number): Promise<BrowserActionResult> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    const result = await this.execute<{ x: number; y: number }>(
      webContents,
      `(() => {
        window.scrollBy({ top: ${Math.round(deltaY)}, left: 0, behavior: 'auto' });
        return { x: window.scrollX, y: window.scrollY };
      })()`,
      timeoutMs,
      '滚动页面'
    )
    return {
      url: webContents.getURL(),
      title: webContents.getTitle(),
      target: `${deltaY >= 0 ? '向下' : '向上'}滚动 ${Math.abs(Math.round(deltaY))}px`,
      x: typeof result?.x === 'number' ? result.x : undefined,
      y: typeof result?.y === 'number' ? result.y : undefined
    }
  }

  async closeAutomation(): Promise<void> {
    const owner = this.surface?.owner ?? this.ownerWindow()
    this.closeSurface()
    if (owner && !owner.isDestroyed()) owner.webContents.send(BROWSER_CLOSED_EVENT, {})
  }

  /* ── 测试/E2E 辅助（只在 --test-mode 下被 globalThis 暴露） ──── */

  /** E2E：查询统一 surface 的真实状态（仅在 --test-mode 经 globalThis 暴露） */
  debugInfo(): {
    surface: boolean
    surfaceBounds: BrowserBounds | null
    /** 原生视图是否真正显示；0×0 或隐藏会在窗口上留下黑底 */
    surfaceVisible: boolean
    surfaceWebContentsSize: { width: number; height: number } | null
    surfaceOwnerTitle: string
    surfaceOwnerSize: { width: number; height: number } | null
    surfaceUrl: string
    surfaceTitle: string
    automationActive: boolean
    /** 兼容旧测试字段：自动化现在就在 surface 上执行 */
    automationOpen: boolean
    automationUrl: string
    automationTitle: string
    /** 已成功向当前页面注入统一滚动条样式 */
    scrollbarCssApplied: boolean
    pendingDownloads: string[]
    tabCount: number
    tabs: BrowserTabInfo[]
    activeTabId: string | null
  } {
    const surface = this.surface
    const url = surface?.view.webContents.getURL() ?? ''
    const title = surface?.view.webContents.getTitle() ?? ''
    return {
      surface: Boolean(surface),
      surfaceBounds: surface?.bounds ?? null,
      surfaceVisible: surface ? surface.view.getVisible() : false,
      surfaceWebContentsSize: surface
        ? (() => {
            const bounds = surface.view.getBounds()
            return { width: bounds.width, height: bounds.height }
          })()
        : null,
      surfaceOwnerTitle: surface && !surface.owner.isDestroyed() ? surface.owner.getTitle() : '',
      surfaceOwnerSize:
        surface && !surface.owner.isDestroyed() ? surface.owner.getContentBounds() : null,
      surfaceUrl: url,
      surfaceTitle: title,
      automationActive: this.state.automationActive,
      automationOpen: Boolean(surface),
      automationUrl: url,
      automationTitle: title,
      scrollbarCssApplied: (() => {
        try {
          return surface?.view?.webContents && !surface.view.webContents.isDestroyed()
            ? this.scrollbarStyled.has(surface.view.webContents.id)
            : false
        } catch {
          return false
        }
      })(),
      pendingDownloads: [...this.pendingDownloads.keys()],
      tabCount: this.tabs.size,
      tabs: this.tabInfos(),
      activeTabId: this.activeTabId
    }
  }

  /** E2E 专用：在 surface 页面里执行一段脚本（用于触发下载链接等真实交互；生产不暴露） */
  async debugSurfaceScript(script: string): Promise<unknown> {
    const surface = this.surface
    if (!surface) throw new Error('浏览器面板未打开。')
    const webContents = surface?.view?.webContents
    if (!webContents || webContents.isDestroyed()) throw new Error('浏览器已经关闭。')
    return webContents.executeJavaScript(script)
  }
}

/** 进程级单例（feature 模块 import 时初始化） */
export const browserService = BrowserService.getInstance()

export { describeTarget }
