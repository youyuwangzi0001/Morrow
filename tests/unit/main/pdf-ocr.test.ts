/**
 * 本机 PDF OCR：真实调用 Windows.Data.Pdf + Windows.Media.Ocr。
 * 只在这个 Windows 交付环境里跑；非 Windows 环境跳过。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ appPath: process.cwd(), dataDir: '' }))
electronState.dataDir = mkdtempSync(join(tmpdir(), 'morrow-pdf-ocr-test-'))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => electronState.appPath,
    getPath: (name: string) =>
      name === 'userData' ? electronState.dataDir : join(electronState.dataDir, name)
  }
}))

import { createPdfOcrHandler, normalizeOcrText } from '../../../src/main/services/pdf-ocr'

const FIXTURE = join(process.cwd(), 'tests', 'unit', 'core', 'fixtures', 'documents', 'invoice-zh.pdf')

afterAll(() => {
  rmSync(electronState.dataDir, { recursive: true, force: true })
})

describe('normalizeOcrText', () => {
  it('去掉中文逐字空格，并还原编号、金额与标签标点', () => {
    const input = [
      '发 票 编 号 ·',
      '· INV · 0042',
      '项 目 金 额 ·',
      '· 12 、 18 、 7',
      '印 刷 总 额 ·',
      '· 38',
      '备 注 ： 本 发 票 为 离 线 测 试 样 例 。'
    ].join('\n')
    const text = normalizeOcrText(input)
    expect(text).toContain('发票编号：')
    expect(text).toContain('INV 0042')
    expect(text).toContain('项目金额：')
    expect(text).toContain('12、18、7')
    expect(text).toContain('印刷总额：')
    expect(text).toContain('备注：本发票为离线测试样例。')
  })
})

describe.skipIf(process.platform !== 'win32')('Windows 本机 PDF OCR', () => {
  it('渲染 PDF 页面并识别出中文与数字（离线）', async () => {
    const handler = createPdfOcrHandler()
    const result = await handler({ path: FIXTURE, pages: [1] })
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0].page).toBe(1)
    expect(result.pages[0].error).toBeUndefined()
    expect(result.language).toMatch(/zh|en/i)
    expect(result.pages[0].text).toContain('发票')
    expect(result.pages[0].text).toContain('0042')
    expect(result.pages[0].text).toContain('38')
  }, 60_000)

  it('页码超出范围时逐页返回错误，而不是伪造文字', async () => {
    const handler = createPdfOcrHandler()
    const result = await handler({ path: FIXTURE, pages: [99] })
    expect(result.pages[0].page).toBe(99)
    expect(result.pages[0].text).toBe('')
    expect(result.pages[0].error).toContain('超出范围')
  }, 60_000)
})
