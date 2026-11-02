/**
 * 扫描版 PDF 的本机 OCR。
 *
 * - 渲染：Windows.Data.Pdf（系统自带，不引入原生 canvas 依赖）
 * - 识别：Windows.Media.Ocr（离线，不上传文件）
 * - PowerShell 只负责调用系统 API；核心工具通过注入的 handler 取回文字。
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PdfOcrHandler, PdfOcrResult } from '../../core/types'
import { dataPath } from './paths'
import { log } from './logger'

const OCR_TIMEOUT_MS = 180_000
const MAX_STDERR_CHARS = 16_000
/** 通过 base64 内存流交给系统 OCR；超大 PDF 建议先拆分 */
const MAX_OCR_PDF_BYTES = 40 * 1024 * 1024

/** 去掉中文 OCR 常见的逐字空格，并把被误识别的间隔号还原为标点。 */
export function normalizeOcrText(text: string): string {
  if (!text) return ''
  let out = text.replace(/\r\n?/g, '\n')
  // 行首的 OCR 项目符号不是正文
  out = out
    .split('\n')
    .map((line) => line.replace(/^[ \t]*[·•・][ \t]*/, '').replace(/[ \t]+/g, ' ').trim())
    .join('\n')
  return out
    .replace(/(\d)\s*[·•・]\s*(\d)/g, '$1.$2')
    .replace(/([\u3400-\u9fff])\s*[·•・]\s*(?=\n|$)/g, '$1：')
    .replace(/([A-Za-z0-9])\s*[·•・]\s*(?=[A-Za-z0-9])/g, '$1 ')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fffA-Za-z0-9])/g, '$1')
    .replace(/([\u3400-\u9fff])\s*([：，。！？；、）】》”’])/g, '$1$2')
    .replace(/([：，。！？；、])\s+(?=[\u3400-\u9fffA-Za-z0-9])/g, '$1')
    .replace(/([（【《“‘])\s*([\u3400-\u9fff])/g, '$1$2')
    .replace(/(\d)\s*、\s*(?=\d)/g, '$1、')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function scriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'pdf-ocr.ps1')
    : join(app.getAppPath(), 'resources', 'pdf-ocr.ps1')
}

function runPowerShell(args: string[], signal?: AbortSignal): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      finish(() => reject(new Error('PDF OCR 已取消。')))
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      finish(() => reject(new Error('PDF OCR 超时，请缩小 pages 范围后重试。')))
    }, OCR_TIMEOUT_MS)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      finish(() => reject(new Error(`无法启动本机 OCR（${err.message}）。`)))
    })
    child.on('close', (code) => {
      finish(() => resolve({ code: code ?? 1, stderr: stderr.trim() }))
    })
  })
}

/** 创建主进程 OCR handler；每次调用使用独立的临时输出文件。 */
export function createPdfOcrHandler(): PdfOcrHandler {
  return async (request): Promise<PdfOcrResult> => {
    if (process.platform !== 'win32') {
      throw new Error('扫描版 PDF 的本机 OCR 目前只支持 Windows。')
    }
    const script = scriptPath()
    if (!existsSync(script)) throw new Error('本机 OCR 脚本缺失，请重新安装或重新解压完整版本。')
    if (!Array.isArray(request.pages) || request.pages.length === 0) {
      throw new Error('没有指定要识别的页码。')
    }
    const pages = [...new Set(request.pages.filter((page) => Number.isInteger(page) && page >= 1))].slice(0, 24)
    if (pages.length === 0) throw new Error('没有指定有效的页码。')

    // 放在应用数据目录的 tmp 下：受限进程/便携版都能写，且不会把扫描件留在系统临时目录。
    const baseDir = dataPath('tmp')
    mkdirSync(baseDir, { recursive: true })
    const tempDir = mkdtempSync(join(baseDir, 'ocr-'))
    const outPath = join(tempDir, 'result.json')
    const inputPath = join(tempDir, 'input.b64')
    try {
      const pdfBytes = readFileSync(request.path)
      if (pdfBytes.byteLength > MAX_OCR_PDF_BYTES) {
        throw new Error(
          `扫描件过大（${Math.round(pdfBytes.byteLength / 1024 / 1024)}MB），本机 OCR 单次最多 40MB；请先拆分 PDF 或只提供关键页。`
        )
      }
      writeFileSync(inputPath, pdfBytes.toString('base64'), 'utf8')
      const { code, stderr } = await runPowerShell(
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-InputPath',
          inputPath,
          '-Pages',
          pages.join(','),
          '-OutPath',
          outPath
        ],
        request.signal
      )
      if (!existsSync(outPath)) {
        throw new Error(
          `本机 OCR 没有返回结果（退出码 ${code}）${stderr ? `：${stderr.slice(0, 300)}` : '。'}`
        )
      }
      const raw = JSON.parse(readFileSync(outPath, 'utf8')) as {
        error?: unknown
        totalPages?: unknown
        language?: unknown
        engine?: unknown
        pages?: unknown
      }
      if (typeof raw.error === 'string' && raw.error.trim()) throw new Error(raw.error.trim())
      const resultPages = Array.isArray(raw.pages)
        ? raw.pages
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
            .map((item) => ({
              page: typeof item.page === 'number' ? item.page : 0,
              text: normalizeOcrText(typeof item.text === 'string' ? item.text : ''),
              ...(typeof item.error === 'string' && item.error ? { error: item.error.slice(0, 300) } : {})
            }))
            .filter((item) => item.page > 0)
        : []
      const result: PdfOcrResult = {
        totalPages: typeof raw.totalPages === 'number' ? raw.totalPages : 0,
        language: typeof raw.language === 'string' ? raw.language : '',
        engine: typeof raw.engine === 'string' ? raw.engine : 'Windows.Media.Ocr',
        pages: resultPages
      }
      log.info('pdf ocr finished', {
        pages: pages.length,
        language: result.language,
        failed: resultPages.filter((page) => page.error).length
      })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/^PDF OCR (超时|已取消)/.test(message)) throw err
      throw new Error(`本机 OCR 失败：${message}`)
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}
