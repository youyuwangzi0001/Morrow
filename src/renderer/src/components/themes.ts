/**
 * Shiki 代码高亮主题：与 design tokens 的墨夜 / 素纸两套色板同源。
 *
 * 说明：Shiki 在运行时生成内联颜色，无法直接引用 CSS 变量，
 * 因此这里以常量镜像 styles/tokens.css 的色值（改色板时同步修改）。
 * 深色：石墨底 + 暖纸白字 + 香槟金关键字；浅色：素纸底 + 深墨字。
 */
import type { ThemeRegistration } from 'shiki'

interface TokenColor {
  scope: string[]
  settings: { foreground?: string; fontStyle?: string }
}

/** 两套主题共用的 token 作用域映射（颜色分开） */
function tokenColors(p: {
  comment: string
  keyword: string
  string: string
  number: string
  func: string
  type: string
  variable: string
  tag: string
  operator: string
  regexp: string
  invalid: string
  inserted: string
  deleted: string
}): TokenColor[] {
  return [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: p.comment, fontStyle: 'italic' } },
    {
      scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.operator.new'],
      settings: { foreground: p.keyword }
    },
    { scope: ['string', 'string.quoted', 'string.template', 'constant.other.symbol'], settings: { foreground: p.string } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character', 'support.constant'], settings: { foreground: p.number } },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call', 'entity.name.method'],
      settings: { foreground: p.func }
    },
    {
      scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class'],
      settings: { foreground: p.type }
    },
    {
      scope: ['variable', 'variable.other', 'variable.parameter', 'meta.object-literal.key', 'support.variable', 'variable.language'],
      settings: { foreground: p.variable }
    },
    { scope: ['entity.name.tag', 'meta.tag', 'support.type.property-name'], settings: { foreground: p.tag } },
    {
      scope: ['keyword.operator', 'punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator'],
      settings: { foreground: p.operator }
    },
    { scope: ['string.regexp', 'constant.character.escape', 'string.escape'], settings: { foreground: p.regexp } },
    { scope: ['invalid', 'invalid.illegal'], settings: { foreground: p.invalid } },
    { scope: ['markup.inserted', 'punctuation.definition.inserted'], settings: { foreground: p.inserted } },
    { scope: ['markup.deleted', 'punctuation.definition.deleted'], settings: { foreground: p.deleted } },
    { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: p.func, fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.underline.link'], settings: { foreground: p.string } }
  ]
}

export const morrowDark: ThemeRegistration = {
  name: 'morrow-dark',
  type: 'dark',
  colors: {
    'editor.background': '#0D1117',
    'editor.foreground': '#DCD6C8'
  },
  tokenColors: tokenColors({
    comment: '#6B675F',
    keyword: '#C8AE7D',
    string: '#A9BFAF',
    number: '#C6A764',
    func: '#E4CE9E',
    type: '#BDB39E',
    variable: '#C9C3B6',
    tag: '#C8AE7D',
    operator: '#8C867A',
    regexp: '#C2795F',
    invalid: '#C2795F',
    inserted: '#7FA292',
    deleted: '#C2795F'
  })
}

export const morrowLight: ThemeRegistration = {
  name: 'morrow-light',
  type: 'light',
  colors: {
    'editor.background': '#ECE6D8',
    'editor.foreground': '#2B2925'
  },
  tokenColors: tokenColors({
    comment: '#8C867A',
    keyword: '#8A6A3C',
    string: '#4F7263',
    number: '#8F7018',
    func: '#6E5227',
    type: '#6B614F',
    variable: '#3B3831',
    tag: '#8A6A3C',
    operator: '#7C766A',
    regexp: '#A2543F',
    invalid: '#A2543F',
    inserted: '#4F7263',
    deleted: '#A2543F'
  })
}
