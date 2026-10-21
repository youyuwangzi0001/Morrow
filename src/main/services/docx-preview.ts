/**
 * DOCX → 只读 HTML（Mammoth）。
 *
 * 图片内联为 data URI，渲染层用无脚本 sandbox iframe 展示；
 * 输出体量有上限，避免超大文档把主进程与渲染层同时拖死。
 */
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import mammoth from 'mammoth'
import { DOCX_PREVIEW_MAX_BYTES } from '../../shared/file-types'
import { formatBytes } from '../../shared/format'
import { statWorkspaceFile } from './workspace-files'

const MAX_DOCX_HTML_BYTES = 30 * 1024 * 1024

export interface DocxPreviewResult {
  html: string
  size: number
  mtimeMs: number
  warnings: string[]
}

export async function convertDocxToHtml(workspace: string, inputPath: string): Promise<DocxPreviewResult> {
  const stat = statWorkspaceFile(workspace, inputPath)
  if (stat.kind !== 'file') throw new Error('这是一个文件夹，不能预览。')
  if (extname(stat.absolutePath).toLowerCase() !== '.docx') throw new Error('只支持 .docx 文档预览。')
  if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
    throw new Error(
      `Word 文档有 ${formatBytes(stat.size)}，超过 ${formatBytes(DOCX_PREVIEW_MAX_BYTES)} 的内联预览上限。请用系统应用打开。`
    )
  }

  const result = await mammoth.convertToHtml(
    { buffer: readFileSync(stat.absolutePath) },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const base64 = await image.readAsBase64String()
        return { src: `data:${image.contentType};base64,${base64}` }
      })
    }
  )
  if (Buffer.byteLength(result.value, 'utf8') > MAX_DOCX_HTML_BYTES) {
    throw new Error(
      `「${basename(stat.absolutePath)}」转换后的内容过大（超过 ${formatBytes(MAX_DOCX_HTML_BYTES)}），请用系统应用打开。`
    )
  }

  return {
    html: result.value,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    warnings: result.messages.filter((message) => message.type === 'warning').map((message) => message.message)
  }
}
