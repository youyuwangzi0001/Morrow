/**
 * 附件文本解码：优先按 UTF-8（含 BOM），失败时回退到 Windows 中文环境常见的 GB18030。
 * 只用于附件读取；编辑器保存仍走 UTF-8，避免静默改写原文件编码。
 */
export interface DecodedText {
  text: string
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'
}

const ALLOWED_CONTROLS = new Set([8, 9, 10, 12, 13])

/** 采样控制字符与 NUL，判断解码结果是否更像二进制而不是文本。 */
export function looksBinaryText(text: string): boolean {
  if (!text) return false
  const sample = text.slice(0, 8192)
  let controls = 0
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index)
    if (code === 0) return true
    if (code < 32 && !ALLOWED_CONTROLS.has(code)) controls += 1
  }
  return controls / sample.length > 0.02
}

function decode(bytes: Uint8Array, encoding: string, fatal = false): string | null {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * 解码附件文本；返回 null 表示内容像二进制，不应内联给模型。
 * GB18030 几乎是 GBK/GB2312 的超集，能覆盖国内常见的旧版 .txt/.csv。
 */
export function decodeTextBytes(bytes: Uint8Array): DecodedText | null {
  if (bytes.length === 0) return { text: '', encoding: 'utf-8' }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = decode(bytes.subarray(3), 'utf-8')
    return text === null || looksBinaryText(text) ? null : { text, encoding: 'utf-8' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = decode(bytes.subarray(2), 'utf-16le')
    return text === null ? null : { text, encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = decode(bytes.subarray(2), 'utf-16be')
    return text === null ? null : { text, encoding: 'utf-16be' }
  }

  const utf8 = decode(bytes, 'utf-8', true)
  if (utf8 !== null && !looksBinaryText(utf8)) return { text: utf8, encoding: 'utf-8' }

  const gb = decode(bytes, 'gb18030')
  if (gb !== null && !gb.includes('\uFFFD') && !looksBinaryText(gb)) {
    return { text: gb, encoding: 'gb18030' }
  }
  return null
}
