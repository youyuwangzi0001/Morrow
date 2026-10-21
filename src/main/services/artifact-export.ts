/**
 * 成品导出转换：HTML → Markdown / 纯文本，Markdown → HTML，以及 PDF 用的打印文档。
 * 纯函数，不接触 Electron，方便单元测试；PDF 渲染由 ipc 层负责。
 */

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
