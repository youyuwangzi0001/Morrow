/**
 * 第三方库的最小类型声明（这些包没有自带 TypeScript 类型）。
 * 只声明 Morrow 实际用到的字段，避免把库的类型当成契约。
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  export interface PdfParseResult {
    numpages: number
    numrender: number
    info?: Record<string, unknown>
    metadata?: unknown
    text: string
    version: string
  }

  export interface PdfParseOptions {
    /** 最多解析页数（默认全部） */
    max?: number
    /** 自定义每页文本渲染（默认用 pdf.js 的 getTextContent 拼接） */
    pagerender?: (pageData: unknown) => string
    version?: string
  }

  /** 传入 PDF 的 Buffer，返回页数与抽取出的全文（页之间用 \f 分隔） */
  export default function pdfParse(dataBuffer: Buffer | Uint8Array, options?: PdfParseOptions): Promise<PdfParseResult>
}
