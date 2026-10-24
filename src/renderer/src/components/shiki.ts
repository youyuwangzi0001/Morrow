/**
 * 按需加载的 Shiki 单例。
 *
 * - 首次渲染代码块时才创建 highlighter（不阻塞首屏）；
 * - 语言包按需 `loadLanguage`，同一语言只加载一次；
 * - 超大代码直接放弃高亮，避免卡住渲染进程；
 * - 双主题：输出 `--shiki-dark/--shiki-light` CSS 变量，由 Markdown.css 按 data-theme 切换。
 */
import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from 'shiki'
import { morrowDark, morrowLight } from './themes'

/** 常见的别名 → shiki 语言 id */
const ALIAS: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  text: 'text',
  plaintext: 'text',
  txt: 'text',
  vue: 'vue',
  rs: 'rust',
  kt: 'kotlin',
  golang: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  objc: 'objective-c',
  ps1: 'powershell',
  bat: 'bat',
  cmd: 'bat'
}

const MAX_HIGHLIGHT_CHARS = 120_000
const MAX_HIGHLIGHT_LINES = 2_000

let highlighterPromise: Promise<Highlighter> | null = null
const languageLoads = new Map<string, Promise<void>>()

/** 语言 id 归一化；不支持的语言返回 null（渲染为纯文本） */
export function resolveLanguage(language?: string | null): string | null {
  if (!language) return null
  const raw = language.trim().toLowerCase().replace(/^language-/, '')
  if (!raw) return null
  const id = ALIAS[raw] ?? raw
  if (id === 'text' || id === 'plaintext') return 'text'
  if (id in bundledLanguages) return id
  return null
}

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [morrowDark, morrowLight],
      langs: []
    })
  }
  return highlighterPromise
}

function loadLanguage(highlighter: Highlighter, id: string): Promise<void> {
  const existing = languageLoads.get(id)
  if (existing) return existing
  const loading = highlighter
    .loadLanguage(id as BundledLanguage)
    .then(() => undefined)
    .catch((error: unknown) => {
      // 加载失败时移除缓存，下次可重试；调用方降级为纯文本
      languageLoads.delete(id)
      throw error
    })
  languageLoads.set(id, loading)
  return loading
}

/**
 * 高亮一段代码，返回 Shiki 的 `<pre>` HTML。
 * 不支持/过大/加载失败时返回 null，由调用方回退到纯文本 `<pre>`。
 */
export async function highlightToHtml(code: string, language?: string | null): Promise<string | null> {
  const id = resolveLanguage(language)
  if (!id || id === 'text') return null
  if (code.length > MAX_HIGHLIGHT_CHARS) return null
  if (code.length > 4_000 && code.split('\n').length > MAX_HIGHLIGHT_LINES) return null
  try {
    const highlighter = await getHighlighter()
    await loadLanguage(highlighter, id)
    return highlighter.codeToHtml(code, {
      lang: id as BundledLanguage,
      themes: { dark: morrowDark.name, light: morrowLight.name },
      defaultColor: false
    })
  } catch {
    return null
  }
}

