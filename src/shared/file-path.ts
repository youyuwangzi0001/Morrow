/** 从 Markdown 行内代码/链接里识别工作区文件路径；只做保守匹配，避免把命令、URL、版本号变成文件链接。 */

export interface ParsedFilePath {
  /** 原始展示文本（可能带 :line） */
  display: string
  /** 去掉行号后的文件路径 */
  path: string
  /** 可选行号（仅用于提示，不改变打开目标） */
  line?: string
}

export const FILE_PATH_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'svg', 'py', 'rb', 'go', 'rs', 'java', 'c',
  'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'csv', 'tsv', 'log',
  'pdf', 'docx', 'xlsx', 'pptx', 'zip', '7z', 'rar', 'tar', 'gz', 'exe', 'msi', 'dll', 'png', 'jpg', 'jpeg',
  'gif', 'webp', 'bmp', 'ico', 'mp3', 'wav', 'mp4', 'mov', 'webm', 'woff', 'woff2', 'ttf', 'db', 'sqlite'
])

const BINARY_EXTENSIONS = new Set([
  'pdf', 'docx', 'xlsx', 'pptx', 'zip', '7z', 'rar', 'tar', 'gz', 'exe', 'msi', 'dll', 'png', 'jpg', 'jpeg',
  'gif', 'webp', 'bmp', 'ico', 'mp3', 'wav', 'mp4', 'mov', 'webm', 'woff', 'woff2', 'ttf', 'db', 'sqlite'
])

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/
const UNC = /^\\\\/
/** 排除代码表达式、命令拼接与 Windows 非法字符，避免把 `require('./a.js')` 当成文件 */
const INVALID_PATH_CHARS = /[<>"|?*\u0000-\u001f=;(){}'`]/

export function isAbsoluteFilePath(path: string): boolean {
  return WINDOWS_ABSOLUTE.test(path) || UNC.test(path) || path.startsWith('/')
}

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  return /\.([A-Za-z][A-Za-z0-9]{0,11})$/.exec(base)?.[1]?.toLowerCase() ?? ''
}

/**
 * 仅识别「看起来真的是文件」的文本：
 * - 支持 Windows/UNC/Unix 绝对路径、带目录的相对路径、带已知扩展名的裸文件名；
 * - 支持 `:12` / `:12:3` 行号后缀；
 * - 拒绝 URL、命令行参数、含非法 Windows 字符的内容。
 */
export function parseFilePath(raw: string, options: { allowBare?: boolean } = {}): ParsedFilePath | null {
  const display = raw.trim()
  if (!display || display.length > 500 || /[\r\n]/.test(display)) return null
  if (/^(?:https?|mailto|data|blob|morrow-file|file):/i.test(display)) return null
  if (display.includes('://') || display.startsWith('--') || display.startsWith('-')) return null

  const lineMatch = /^(.*?):(\d+)(?::\d+)?$/.exec(display)
  const path = (lineMatch?.[1] ?? display).trim()
  if (!path || path.length > 400) return null
  if (INVALID_PATH_CHARS.test(path)) return null
  if (!WINDOWS_ABSOLUTE.test(path) && path.includes(':')) return null

  const absolute = isAbsoluteFilePath(path)
  const hasSeparator = /[\\/]/.test(path)
  const ext = extensionOf(path)
  if (!ext) return null
  if (!absolute && !hasSeparator) {
    // 行内代码默认只认带目录的路径；裸文件名留给显式的 Markdown 链接，避免 console.log / example.com 误判。
    if (!options.allowBare || !FILE_PATH_EXTENSIONS.has(ext)) return null
  }

  return {
    display,
    path,
    ...(lineMatch?.[2] ? { line: lineMatch[2] } : {})
  }
}

/** 二进制文件不提供「复制内容」，避免把乱码写进剪贴板。 */
export function isTextFilePath(path: string): boolean {
  return !BINARY_EXTENSIONS.has(extensionOf(path))
}
