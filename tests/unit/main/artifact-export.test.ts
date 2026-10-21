import { describe, expect, it } from 'vitest'
import {
  buildExportHtml,
  buildExportMarkdown,
  buildExportText,
  decodeEntities,
  htmlToMarkdown,
  htmlToText,
  markdownToHtml
} from '../../../src/main/services/artifact-export'

describe('artifact export conversions', () => {
  const report = `<!doctype html>
<html><head><title>季度报告</title><style>body{color:red}</style><script>alert('x')</script></head>
<body>
  <h1>季度复盘</h1>
  <p>收入 <strong>增长 12%</strong>，详见<a href="https://example.com/data">数据页</a>。</p>
  <h2>重点</h2>
  <ul><li>留存提升</li><li>成本下降</li></ul>
  <table>
    <thead><tr><th>指标</th><th>数值</th></tr></thead>
    <tbody><tr><td>收入</td><td>1,200 万</td></tr><tr><td>成本</td><td>800 万</td></tr></tbody>
  </table>
  <pre><code class="language-ts">const ok = true</code></pre>
  <blockquote>下季度继续。</blockquote>
  <img src="chart.png" alt="趋势图">
</body></html>`

  it('HTML 转 Markdown 保留结构并移除脚本样式', () => {
    const md = htmlToMarkdown(report)
    expect(md).toContain('# 季度复盘')
    expect(md).toContain('**增长 12%**')
    expect(md).toContain('[数据页](https://example.com/data)')
    expect(md).toContain('## 重点')
    expect(md).toContain('- 留存提升')
    expect(md).toContain('- 成本下降')
    expect(md).toContain('| 指标 | 数值 |')
    expect(md).toContain('| 收入 | 1,200 万 |')
    expect(md).toContain('```ts\nconst ok = true\n```')
    expect(md).toContain('> 下季度继续。')
    expect(md).toContain('![趋势图](chart.png)')
    expect(md).not.toContain('alert')
    expect(md).not.toContain('color:red')
  })

  it('HTML 转纯文本保留可读内容，不保留标签', () => {
    const text = htmlToText(report)
    expect(text).toContain('季度复盘')
    expect(text).toContain('增长 12%')
    expect(text).toContain('• 留存提升')
    expect(text).toContain('收入\t1,200 万')
    expect(text).not.toContain('<h1>')
    expect(text).not.toContain('alert')
  })

  it('Markdown 转 HTML 支持标题、列表、代码块、链接和强调', () => {
    const html = markdownToHtml(`# 标题

一段 **重点** 与 [链接](https://example.com)。

- 第一项
- 第二项

\`\`\`ts
const n = 1
\`\`\`

> 引用`)
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<strong>重点</strong>')
    expect(html).toContain('<a href="https://example.com">链接</a>')
    expect(html).toContain('<ul><li>第一项</li><li>第二项</li></ul>')
    expect(html).toContain('<pre><code class="language-ts">const n = 1</code></pre>')
    expect(html).toContain('<blockquote><p>引用</p></blockquote>')
  })

  it('拒绝危险链接，转义原始 HTML', () => {
    const html = markdownToHtml('[点我](javascript:alert(1)) <script>alert(2)</script>')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('Markdown 成品导出 HTML 带完整纸张排版', () => {
    const html = buildExportHtml({ title: '复盘', kind: 'markdown' }, '# 复盘\n\n正文')
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('<title>复盘</title>')
    expect(html).toContain('<h1>复盘</h1>')
    expect(html).toContain('@media print')
  })

  it('HTML 成品保留原始文档并注入打印样式', () => {
    const html = buildExportHtml({ title: '报告', kind: 'html' }, report)
    expect(html).toContain('<h1>季度复盘</h1>')
    expect(html).toContain('data-morrow-print')
    expect(html).toContain('print-color-adjust')
  })

  it('代码导出为围栏块与转义 pre，文本导出保持内容', () => {
    const artifact = { title: '脚本', kind: 'code', language: 'typescript' }
    expect(buildExportMarkdown(artifact, 'const x = 1')).toBe('```ts\nconst x = 1\n```')
    const html = buildExportHtml(artifact, '<tag> & value')
    expect(html).toContain('&lt;tag&gt; &amp; value')
    expect(buildExportText({ kind: 'text' }, 'a < b')).toBe('a < b')
  })

  it('实体解码支持命名与数字形式', () => {
    expect(decodeEntities('&amp; &lt; &#65; &#x4e2d; &nbsp;')).toBe('& < A 中  ')
  })
})
