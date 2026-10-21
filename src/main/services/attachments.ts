/**
 * 附件读取与用户消息构造（纯 Node）。
 * 附件正文只进入模型上下文；用户气泡使用 displayText + attachments 元数据。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { Attachment, ChatImage, ChatMessage, MessageAttachment } from '../../shared/types'
import {
  ATTACHMENT_IMAGE_MAX_BYTES,
  ATTACHMENT_IMAGE_SOURCE_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_TEXT_MAX_BYTES,
  ATTACHMENT_TEXT_MAX_CHARS,
  ATTACHMENT_TOTAL_IMAGE_MAX_BYTES,
  ATTACHMENT_TOTAL_TEXT_MAX_CHARS,
  imageMediaTypeFor,
  isTextFileName
} from '../../shared/file-types'
import { formatBytes } from '../../shared/format'
import { decodeTextBytes } from '../../shared/text-decode'

export function describeAttachment(file: string): Attachment | null {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile()) return null

  const name = basename(file)
  const base = { id: makeAttachmentId(), name, path: file, size: stat.size }
  const mediaType = imageMediaTypeFor(name)
  if (mediaType) {
    if (stat.size > ATTACHMENT_IMAGE_SOURCE_MAX_BYTES) {
      return {
        ...base,
        kind: 'image',
        content: null,
        mediaType,
        note: `图片超过 ${formatBytes(ATTACHMENT_IMAGE_SOURCE_MAX_BYTES)}，未发送给模型`
      }
    }
    try {
      const data = readFileSync(file).toString('base64')
      return { ...base, kind: 'image', content: `data:${mediaType};base64,${data}`, mediaType }
    } catch {
      return null
    }
  }

  if (isTextFileName(name)) {
    if (stat.size > ATTACHMENT_TEXT_MAX_BYTES) {
      return {
        ...base,
        kind: 'file',
        content: null,
        note: `文本文件超过 ${formatBytes(ATTACHMENT_TEXT_MAX_BYTES)}，未内联`
      }
    }
    try {
      const decoded = decodeTextBytes(readFileSync(file))
      if (!decoded) {
        return { ...base, kind: 'file', content: null, note: '内容像二进制文件，未内联' }
      }
      const raw = decoded.text
      const truncated = raw.length > ATTACHMENT_TEXT_MAX_CHARS
      return {
        ...base,
        kind: 'text',
        content: truncated ? raw.slice(0, ATTACHMENT_TEXT_MAX_CHARS) : raw,
        ...(truncated
          ? {
              truncated: true,
              note: `内容过长，仅发送前 ${ATTACHMENT_TEXT_MAX_CHARS.toLocaleString('en-US')} 字符`
            }
          : {})
      }
    } catch {
      return null
    }
  }

  return { ...base, kind: 'file', content: null }
}

/** 从会话用户消息中收集显式附加的文件路径，作为只读工具的白名单。 */
export function collectAttachedFilePaths(messages: readonly ChatMessage[]): string[] {
  const paths = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const attachment of message.attachments ?? []) {
      if (attachment.path && attachment.kind !== 'image') paths.add(attachment.path)
      if (paths.size >= 32) return [...paths]
    }
  }
  return [...paths]
}

export function buildUserMessage(text: string, attachments?: Attachment[]): ChatMessage {
  const userText = text.trim()
  const parts: string[] = userText ? [userText] : []
  const images: ChatImage[] = []
  const meta: MessageAttachment[] = []
  let textBudget = ATTACHMENT_TOTAL_TEXT_MAX_CHARS
  let imageBudget = ATTACHMENT_TOTAL_IMAGE_MAX_BYTES

  for (const raw of (attachments ?? []).slice(0, ATTACHMENT_MAX_COUNT)) {
    const attachment = prepareAttachment(raw)
    let imageSent = false
    let note = attachment.note
    if (attachment.kind === 'text' && typeof attachment.content === 'string') {
      if (attachment.content.length > textBudget) {
        attachment.content = attachment.content.slice(0, Math.max(0, textBudget))
        attachment.truncated = true
        attachment.note = `所有文本附件合计超过 ${ATTACHMENT_TOTAL_TEXT_MAX_CHARS.toLocaleString('en-US')} 字符，仅发送了前部内容`
        note = attachment.note
      }
      textBudget -= attachment.content.length
    }
    if (attachment.kind === 'image') {
      const parsed = typeof attachment.content === 'string' ? parseDataUrl(attachment.content) : null
      if (parsed) {
        const bytes = base64Bytes(parsed.dataBase64)
        if (bytes > imageBudget) {
          attachment.note = `所有图片合计超过 ${Math.round(ATTACHMENT_TOTAL_IMAGE_MAX_BYTES / 1024 / 1024)}MB，这张图片未发送给模型`
          note = attachment.note
        } else {
          images.push({ ...parsed, name: attachment.name })
          imageBudget -= bytes
          imageSent = true
        }
      } else if (!note) {
        note = '图片未能读取（过大或格式不支持），未发送给模型'
      }
    }
    parts.push(attachmentBlock(attachment, imageSent, note))
    meta.push({
      name: attachment.name,
      ...(attachment.path ? { path: attachment.path } : {}),
      size: attachment.size,
      kind: attachment.kind,
      ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
      ...(note ? { note } : {}),
      ...(attachment.truncated ? { truncated: true } : {})
    })
  }

  return {
    id: `msg_${randomUUID().slice(0, 12)}`,
    role: 'user',
    content: [{ type: 'text', text: parts.join('\n\n') }],
    createdAt: Date.now(),
    displayText: userText,
    ...(meta.length > 0 ? { attachments: meta } : {}),
    ...(images.length > 0 ? { images } : {})
  }
}

/** 附件来自渲染层，进入模型上下文前统一钳制，避免超长内容或控制字符污染提示词。 */
function prepareAttachment(input: Attachment): Attachment {
  const name = sanitizeLabel(input.name, 200) || '附件'
  const path = sanitizeLabel(input.path ?? '', 1024)
  const kind = input.kind === 'image' || input.kind === 'text' ? input.kind : 'file'
  let content = typeof input.content === 'string' ? input.content : null
  let note = sanitizeLabel(input.note ?? '', 300) || undefined
  let truncated = Boolean(input.truncated)
  if (kind === 'image') {
    // 图片只接受 data URL；限制长度，避免伪造的超长字符串进入主进程内存
    if (!content || content.length > 7_200_000 || !/^data:image\//i.test(content)) {
      content = null
      note ??= '图片内容无效，未发送给模型'
    }
  } else if (kind === 'text') {
    if (content !== null && content.length > ATTACHMENT_TEXT_MAX_CHARS) {
      content = content.slice(0, ATTACHMENT_TEXT_MAX_CHARS)
      truncated = true
      note ??= `内容过长，仅发送前 ${ATTACHMENT_TEXT_MAX_CHARS.toLocaleString('en-US')} 字符`
    }
  } else {
    // 普通文件只传元数据，正文必须由 read_file/read_pdf 等有审批边界的工具读取
    content = null
  }
  const size = Number.isFinite(input.size) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, input.size)) : 0
  return {
    id: sanitizeLabel(input.id, 80) || makeAttachmentId(),
    name,
    path,
    size,
    kind,
    content,
    ...(input.mediaType
      ? { mediaType: sanitizeLabel(input.mediaType, 100).toLowerCase().replace(/^image\/jpg$/, 'image/jpeg') }
      : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(note ? { note } : {})
  }
}

function sanitizeLabel(value: string, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function attachmentBlock(attachment: Attachment, imageSent: boolean, note?: string): string {
  const header = `[附件] ${attachment.name}（${formatBytes(attachment.size)}${attachment.path ? `，路径：${attachment.path}` : ''}）`
  if (attachment.kind === 'image') {
    return imageSent
      ? `${header}：图片已作为视觉输入附在本条消息里，请直接看图回答，不要靠文件名猜内容。`
      : `${header}：${note ?? '图片未能读取（过大或格式不支持）'}，不要猜测图片内容。`
  }
  if (typeof attachment.content === 'string') {
    const body = attachment.truncated ? `${attachment.content}\n…（内容过长，已截断）` : attachment.content
    return `${header}\n\`\`\`\n${body}\n\`\`\``
  }
  const ext = attachment.name.split('.').pop()?.toLowerCase() ?? ''
  const reader =
    ext === 'pdf'
      ? 'read_pdf'
      : ext === 'docx'
        ? 'read_docx'
        : ext === 'xlsx'
          ? 'read_xlsx'
          : ext === 'pptx'
            ? 'read_pptx'
            : null
  if (reader) {
    return `${header}：${note ?? '文件内容未内联'}。这个文件已随本条消息授权只读访问，需要时用 ${reader} 读取上面的完整路径。`
  }
  if (isTextFileName(attachment.name)) {
    return `${header}：${note ?? '文件内容未内联'}。需要时用 read_file 读取上面的路径，不要猜测正文。`
  }
  if (ext === 'xls') {
    return `${header}：旧版 .xls 无法直接读取；需要用户先另存为 .xlsx。`
  }
  return `${header}：${note ?? '该格式无法直接内联'}。不要猜测文件内容；需要时先与用户确认，或转换为文本/PDF/DOCX/XLSX 后再处理。`
}

/** 只接受主流视觉接口支持的格式；BMP 由渲染层先转成 PNG 再发送。 */
function parseDataUrl(dataUrl: string): ChatImage | null {
  const trimmed = dataUrl.trim()
  // 5MB 图片的 base64 约 6.99M 字符；先挡掉异常超长输入，避免大正则扫描拖住主进程
  if (trimmed.length > 7_200_000) return null
  const match = /^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=]+)$/i.exec(trimmed)
  if (!match) return null
  const mediaType = match[1].toLowerCase().replace(/^image\/jpg$/, 'image/jpeg')
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mediaType)) return null
  const dataBase64 = match[2]
  if (dataBase64.length % 4 !== 0) return null
  const bytes = base64Bytes(dataBase64)
  if (bytes > ATTACHMENT_IMAGE_MAX_BYTES) return null
  return { mediaType, dataBase64 }
}

function base64Bytes(dataBase64: string): number {
  if (dataBase64.length % 4 !== 0) return Number.POSITIVE_INFINITY
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0
  return (dataBase64.length / 4) * 3 - padding
}

function makeAttachmentId(): string {
  return `att_${Date.now()}_${randomBytes(3).toString('hex')}`
}
