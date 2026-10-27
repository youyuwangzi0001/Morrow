/**
 * 文档预览（DOCX / EPUB / ODT / PDF）共用纸面主题。
 * 颜色从顶层 tokens.css 读取，避免 iframe 内再维护一套颜色。
 */
export interface DocumentPageTheme {
  shell: string
  page: string
  ink: string
  muted: string
  border: string
  table: string
  tableHead: string
  accent: string
  quote: string
}

const FALLBACK: DocumentPageTheme = {
  shell: '#0d1117',
  page: '#17191d',
  ink: '#e8e0cf',
  muted: '#9b917d',
  border: 'rgba(237, 231, 218, 0.12)',
  table: 'rgba(237, 231, 218, 0.1)',
  tableHead: 'rgba(200, 174, 125, 0.09)',
  accent: '#c8ae7d',
  quote: '#b9b09c'
}

export function documentPageTheme(): DocumentPageTheme {
  try {
    const style = getComputedStyle(document.documentElement)
    const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
    return {
      shell: read('--studio-doc-shell', FALLBACK.shell),
      page: read('--studio-doc-page', FALLBACK.page),
      ink: read('--studio-doc-ink', FALLBACK.ink),
      muted: read('--studio-doc-muted', FALLBACK.muted),
      border: read('--studio-doc-border', FALLBACK.border),
      table: read('--studio-doc-table', FALLBACK.table),
      tableHead: read('--studio-doc-table-head', FALLBACK.tableHead),
      accent: read('--studio-doc-accent', FALLBACK.accent),
      quote: read('--studio-doc-quote', FALLBACK.quote)
    }
  } catch {
    return FALLBACK
  }
}
