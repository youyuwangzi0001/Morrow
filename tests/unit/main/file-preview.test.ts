import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  describeFilePreview,
  handlePreviewProtocol,
  resetPreviewTokensForTest
} from '../../../src/main/services/file-preview'
import { convertDocxToHtml } from '../../../src/main/services/docx-preview'

const fixtures = join(process.cwd(), 'tests', 'unit', 'core', 'fixtures', 'documents')
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
)

let workspace = ''

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'morrow-preview-test-'))
  writeFileSync(join(workspace, 'image.png'), PNG)
  writeFileSync(join(workspace, 'clip.mp3'), Buffer.from('not really audio'))
  writeFileSync(join(workspace, 'clip.webm'), Buffer.from('not really video'))
  writeFileSync(join(workspace, 'archive.zip'), Buffer.from('PK\u0003\u0004'))
  writeFileSync(join(workspace, 'archive.7z'), Buffer.from('7z\u00bc\u00af'))
  copyFileSync(join(fixtures, 'invoice.pdf'), join(workspace, 'invoice.pdf'))
  copyFileSync(join(fixtures, 'invoice.docx'), join(workspace, 'invoice.docx'))
  resetPreviewTokensForTest()
})

afterAll(() => {
  resetPreviewTokensForTest()
  rmSync(workspace, { recursive: true, force: true })
})

describe('describeFilePreview', () => {
  it('为图片/PDF/音视频签发受控 URL', () => {
    const image = describeFilePreview(workspace, 'image.png')
    expect(image.kind).toBe('image')
    expect(image.mime).toBe('image/png')
    expect(image.url).toMatch(/^morrow-file:\/\/preview\//)

    const pdf = describeFilePreview(workspace, 'invoice.pdf')
    expect(pdf.kind).toBe('pdf')
    expect(pdf.mime).toBe('application/pdf')
    expect(pdf.url).toMatch(/^morrow-file:\/\/preview\//)

    const audio = describeFilePreview(workspace, 'clip.mp3')
    expect(audio.kind).toBe('audio')
    expect(audio.mime).toBe('audio/mpeg')
    expect(audio.url).toBeTruthy()

    const video = describeFilePreview(workspace, 'clip.webm')
    expect(video.kind).toBe('video')
    expect(video.mime).toBe('video/webm')
    expect(video.url).toBeTruthy()
  })

  it('DOCX 返回转换类型，不支持格式给出提示', () => {
    const docx = describeFilePreview(workspace, 'invoice.docx')
    expect(docx.kind).toBe('docx')
    expect(docx.url).toBeUndefined()
    expect(docx.mime).toContain('wordprocessingml')

    const zip = describeFilePreview(workspace, 'archive.zip')
    expect(zip.kind).toBe('archive')
    expect(zip.url).toBeUndefined()

    const sevenZip = describeFilePreview(workspace, 'archive.7z')
    expect(sevenZip.kind).toBe('unsupported')
    expect(sevenZip.note).toContain('压缩格式暂不支持')
    expect(sevenZip.url).toBeUndefined()
  })

  it('工作区外路径被拒绝', () => {
    expect(() => describeFilePreview(workspace, '../secret.png')).toThrow()
  })
})

describe('handlePreviewProtocol', () => {
  it('完整读取与 Range 读取都返回正确内容', async () => {
    const meta = describeFilePreview(workspace, 'image.png')
    expect(meta.url).toBeTruthy()
    const request = {
      url: meta.url,
      method: 'GET',
      headers: new Headers()
    } as unknown as Request
    const full = await handlePreviewProtocol(request)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('image/png')
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    const fullBytes = Buffer.from(await full.arrayBuffer())
    expect(fullBytes.equals(PNG)).toBe(true)

    const ranged = await handlePreviewProtocol({
      url: meta.url,
      method: 'GET',
      headers: new Headers({ Range: 'bytes=0-7' })
    } as unknown as Request)
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-7/${statSync(join(workspace, 'image.png')).size}`)
    expect(Buffer.from(await ranged.arrayBuffer()).length).toBe(8)
  })

  it('过期/非法令牌返回 404', async () => {
    const response = await handlePreviewProtocol({
      url: 'morrow-file://preview/not-a-token',
      method: 'GET',
      headers: new Headers()
    } as unknown as Request)
    expect(response.status).toBe(404)
  })
})

describe('convertDocxToHtml', () => {
  it('转换 DOCX 为可展示 HTML，并保留表格文本', async () => {
    const result = await convertDocxToHtml(workspace, 'invoice.docx')
    expect(result.html).toContain('INVOICE')
    expect(result.html).toContain('Aurora')
    expect(result.size).toBeGreaterThan(0)
  })

  it('非 DOCX 文件被拒绝', async () => {
    await expect(convertDocxToHtml(workspace, 'invoice.pdf')).rejects.toThrow(/docx/i)
  })
})
