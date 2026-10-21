/** 以采样方式判断内容是否像二进制；用于编辑器打开与附件分类。 */
export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192)
  if (sample.includes(0)) return true
  const text = sample.toString('utf8')
  if (!text) return false
  let replacement = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) replacement += 1
  }
  return replacement / Math.max(1, text.length) > 0.1
}
