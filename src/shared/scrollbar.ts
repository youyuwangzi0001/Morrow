/**
 * 无外边框的石墨 + 香槟金滚动条。
 * 宿主应用由 base.css 统一；这里给 iframe / 内置浏览器等独立渲染上下文复用。
 * 尺寸与宿主一致：8px 轨道、6px 实色滑块、全圆角、无渐变/箭头。
 */
export const MORROW_SCROLLBAR_RULES = `
* { scrollbar-width: thin !important; scrollbar-color: #8a6f42 transparent !important; }
*::-webkit-scrollbar { width: 8px !important; height: 8px !important; background: transparent !important; }
*::-webkit-scrollbar-track { background: transparent !important; border: 0 !important; }
*::-webkit-scrollbar-thumb {
  min-height: 36px; border: 1px solid transparent !important; border-radius: 999px !important;
  background: #8a6f42 !important; background-clip: content-box !important;
}
*::-webkit-scrollbar-thumb:hover {
  background: #b18f58 !important; background-clip: content-box !important;
}
*::-webkit-scrollbar-thumb:active {
  background: #e4ce9e !important; background-clip: content-box !important;
}
*::-webkit-scrollbar-corner { background: transparent !important; }
*::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; }
`

export const MORROW_SCROLLBAR_CSS = `<style data-morrow-scrollbar>${MORROW_SCROLLBAR_RULES}</style>`

export function withMorrowScrollbar(html: string): string {
  if (!html || html.includes('data-morrow-scrollbar')) return html
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${MORROW_SCROLLBAR_CSS}</head>`)
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, `$&${MORROW_SCROLLBAR_CSS}`)
  return `${MORROW_SCROLLBAR_CSS}${html}`
}
