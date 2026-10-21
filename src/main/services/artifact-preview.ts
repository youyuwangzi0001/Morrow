/**
 * 画布 HTML 产物的沙箱预览协议。
 *
 * 为什么不用 srcdoc：srcdoc 会继承主窗口 CSP，生产环境 `script-src 'self'` 会拦掉报告里的
 * 内联脚本，导致「可交互报告」在打包版里变成静态页。这里用独立协议返回文档并附带自己的 CSP：
 * 允许内联脚本/样式与常见远程资源，但禁止嵌入、顶层导航与表单提交；iframe 仍不带 allow-same-origin，
 * 拿不到宿主数据。
 */
import { randomBytes } from 'node:crypto'

export const ARTIFACT_PREVIEW_SCHEME = 'morrow-artifact'

const PREVIEW_TTL_MS = 60 * 60 * 1000
const MAX_ENTRIES = 40
// 画布读取上限为 8MB；这里再留出滚动条/外链桥接注入的余量
const MAX_HTML_BYTES = 10 * 1024 * 1024
// 所有未过期预览的总内存上限，避免频繁切换大产物把渲染进程/主进程拖垮
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const TOKEN_PATTERN = /^[a-f0-9]{36}$/

interface Entry {
  html: string
  createdAt: number
  bytes: number
}

const entries = new Map<string, Entry>()
let totalBytes = 0

function drop(token: string): void {
  const entry = entries.get(token)
  if (!entry) return
  totalBytes = Math.max(0, totalBytes - entry.bytes)
  entries.delete(token)
}

export const ARTIFACT_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  // 沙箱产物不能探测本机服务；远程资源只走 https
  "connect-src https:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function prune(now = Date.now()): void {
  for (const [token, entry] of entries) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) drop(token)
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (!oldest) break
    drop(oldest)
  }
  while (totalBytes > MAX_TOTAL_BYTES && entries.size > 1) {
    const oldest = entries.keys().next().value
    if (!oldest) break
    drop(oldest)
  }
}

/** 登记一份 HTML 内容，返回可放进 sandbox iframe 的 URL（token 随内容更新而变化） */
export function registerArtifactHtml(html: unknown): string {
  if (typeof html !== 'string') throw new Error('网页内容无效。')
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new Error(`网页产物过大（上限 ${MAX_HTML_BYTES / 1024 / 1024}MB）。`)
  }
  const now = Date.now()
  prune(now)
  const token = randomBytes(18).toString('hex')
  const bytes = Buffer.byteLength(html, 'utf8')
  entries.set(token, { html, createdAt: now, bytes })
  totalBytes += bytes
  prune(now)
  return `${ARTIFACT_PREVIEW_SCHEME}://preview/${token}`
}

/** `protocol.handle` 入口；预览 URL 过期/不存在时返回可读的 404 */
export function handleArtifactPreview(request: Request): Response {
  prune()
  const url = new URL(request.url)
  const token = url.pathname.split('/').filter(Boolean).pop() ?? ''
  const entry = TOKEN_PATTERN.test(token) ? entries.get(token) : undefined
  if (!entry) {
    return new Response('预览已过期，请重新打开产物。', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    })
  }
  entry.createdAt = Date.now()
  return new Response(entry.html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': ARTIFACT_PREVIEW_CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}
