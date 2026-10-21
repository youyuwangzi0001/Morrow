/**
 * CodeMirror 语言按需加载与 Morrow 黑金语法配色。
 *
 * 语言包用动态 import，只有真正打开对应文件时才加载对应 chunk；
 * 高亮配色镜像 shiki 的 morrow-dark/morrow-light 主题（金关键字/铜绿字符串/琥珀数字/紫灰注释）。
 */
import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

export type EditorLanguage =
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'html'
  | 'css'
  | 'markdown'
  | 'python'
  | 'xml'
  | 'text'

const EXT_LANGUAGE: Record<string, EditorLanguage> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  pyw: 'python',
  xml: 'xml',
  svg: 'xml',
  txt: 'text',
  log: 'text',
  csv: 'text',
  yml: 'text',
  yaml: 'text',
  sh: 'text',
  ps1: 'text',
  bat: 'text'
}

const LANGUAGE_LABEL: Record<EditorLanguage, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  markdown: 'Markdown',
  python: 'Python',
  xml: 'XML',
  text: '纯文本'
}

export function languageForPath(path: string | null | undefined): EditorLanguage {
  if (!path) return 'text'
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'text'
  return EXT_LANGUAGE[base.slice(dot + 1).toLowerCase()] ?? 'text'
}

export function languageLabel(language: EditorLanguage): string {
  return LANGUAGE_LABEL[language] ?? '纯文本'
}

/** 是否适合用 Markdown / HTML 预览 */
export function canPreview(language: EditorLanguage): boolean {
  return language === 'markdown' || language === 'html'
}

type Loader = () => Promise<LanguageSupport>

const LOADERS: Record<Exclude<EditorLanguage, 'text'>, Loader> = {
  javascript: () => import('@codemirror/lang-javascript').then((mod) => mod.javascript({ jsx: true })),
  typescript: () => import('@codemirror/lang-javascript').then((mod) => mod.javascript({ jsx: true, typescript: true })),
  json: () => import('@codemirror/lang-json').then((mod) => mod.json()),
  html: () => import('@codemirror/lang-html').then((mod) => mod.html()),
  css: () => import('@codemirror/lang-css').then((mod) => mod.css()),
  markdown: () => import('@codemirror/lang-markdown').then((mod) => mod.markdown()),
  python: () => import('@codemirror/lang-python').then((mod) => mod.python()),
  xml: () => import('@codemirror/lang-xml').then((mod) => mod.xml())
}

const languageCache = new Map<EditorLanguage, LanguageSupport>()

/** 异步加载语言支持；失败/纯文本返回 null（编辑器退化为纯文本） */
export async function loadLanguageExtension(language: EditorLanguage): Promise<LanguageSupport | null> {
  if (language === 'text') return null
  const cached = languageCache.get(language)
  if (cached) return cached
  try {
    const support = await LOADERS[language]()
    languageCache.set(language, support)
    return support
  } catch {
    return null
  }
}

/** 与 shiki 主题同源的 CM 语法配色（颜色经由 tokens.css 的 CSS 变量） */
const highlightColors = {
  keyword: 'var(--syntax-keyword)',
  string: 'var(--syntax-string)',
  number: 'var(--syntax-number)',
  function: 'var(--syntax-function)',
  type: 'var(--syntax-type)',
  variable: 'var(--syntax-variable)',
  comment: 'var(--syntax-comment)',
  operator: 'var(--syntax-operator)',
  invalid: 'var(--syntax-invalid)'
}

const morrowHighlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: highlightColors.comment, fontStyle: 'italic' },
  {
    tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.self, t.null, t.atom],
    color: highlightColors.keyword
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: highlightColors.string },
  { tag: [t.number, t.bool, t.null], color: highlightColors.number },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: highlightColors.function },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: highlightColors.type },
  { tag: [t.variableName, t.propertyName, t.attributeName, t.labelName], color: highlightColors.variable },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: highlightColors.operator },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: highlightColors.function, fontWeight: '600' },
  { tag: [t.link, t.url], color: highlightColors.string },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.invalid], color: highlightColors.invalid }
])

export function morrowSyntaxHighlighting(): Extension {
  return syntaxHighlighting(morrowHighlightStyle)
}
