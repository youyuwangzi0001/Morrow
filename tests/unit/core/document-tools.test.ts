/**
 * 文档工具单元测试：read_pdf / read_docx / edit_docx / read_xlsx / write_xlsx。
 *
 * 夹具是真实生成的二进制文件（见 fixtures/documents/manifest.json 与 make_fixtures.py）：
 * - template.docx / split-run.docx：python-docx 生成（M11 场景 + 跨 run 占位符健壮性）；
 * - invoice.pdf：python-docx 写的 invoice.docx 经 LibreOffice 导出（M12 场景，独立实现）；
 * - input.xlsx：openpyxl 生成（读取公式/共享字符串/布尔）；
 * - blank.pdf：无文字 PDF（错误路径）；
 * - scanned-zh.pdf：只有一张 JPEG、没有文字层的扫描件，供本机 OCR 与回执测试。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { executeTool, isReadOnlyTool, TOOL_DEFINITIONS } from '../../../src/core/tools/registry'
import { checkXmlWellFormed, collectWordText, replaceInDocxXmlFile } from '../../../src/core/tools/docx-tools'
import { evaluateSheet } from '../../../src/core/tools/xlsx-formula'
import { sha256 } from '../../../src/core/util'
import { restoreSnapshotSafely } from '../../../src/main/services/snapshot-restore'
import { makeToolContext } from './helpers/tool-context'
import { makeTempWorkspace, type TempWorkspace } from './helpers/workspace'

const FIXTURES = join(process.cwd(), 'tests', 'unit', 'core', 'fixtures', 'documents')

function fixturePath(name: string): string {
  return join(FIXTURES, name)
}

/** 把夹具复制进临时工作区（工具只能读工作区内文件） */
function copyFixture(ws: TempWorkspace, fixture: string, target: string): string {
  const absolute = join(ws.root, target)
  mkdirSync(dirname(absolute), { recursive: true })
  copyFileSync(fixturePath(fixture), absolute)
  return absolute
}

describe('文档工具注册与只读分类', () => {
  it('注册表包含 7 个新工具，读工具归为 read（子代理/聊天模式可用），写工具不是只读', () => {
    const names = TOOL_DEFINITIONS.map((definition) => definition.name)
    for (const name of ['read_pdf', 'read_docx', 'edit_docx', 'read_xlsx', 'write_xlsx', 'list_skills', 'read_skill']) {
      expect(names).toContain(name)
    }
    for (const name of ['read_pdf', 'read_docx', 'read_xlsx', 'list_skills', 'read_skill']) {
      expect(isReadOnlyTool(name)).toBe(true)
    }
    expect(isReadOnlyTool('edit_docx')).toBe(false)
    expect(isReadOnlyTool('write_xlsx')).toBe(false)
  })

  it('夹具清单的 sha256 与文件一致（防止夹具被误改/损坏）', () => {
    const manifest = JSON.parse(readFileSync(fixturePath('manifest.json'), 'utf8')) as {
      fixtures: Record<string, { sha256: string }>
    }
    for (const [name, info] of Object.entries(manifest.fixtures)) {
      expect(sha256(readFileSync(fixturePath(name)))).toBe(info.sha256)
    }
  })

  it('只读上下文（子代理）调用写文档工具被注册表拦截', async () => {
    const ws = makeTempWorkspace()
    try {
      const ctx = makeToolContext(ws, { readOnly: true })
      const result = await executeTool('write_xlsx', { path: 'out/a.xlsx', sheets: [{ name: 'S', rows: [[1]] }] }, ctx)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('只读')
    } finally {
      ws.cleanup()
    }
  })
})

/* ── M12：PDF 数字核对 ───────────────────────────────────────── */

describe('read_pdf（M12：发票数字核对）', () => {
  it('抽取 INV-0042 / Items 12,18,7 / Printed total 38，且能发现 37≠38', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'invoice.pdf', 'in/invoice.pdf')
      const result = await executeTool('read_pdf', { path: 'in/invoice.pdf' }, makeToolContext(ws))
      expect(result.ok).toBe(true)
      expect(result.output).toContain('INV-0042')
      expect(result.output).toContain('Items: 12, 18, 7')
      expect(result.output).toContain('Printed total: 38')
      expect(result.meta).toMatchObject({ pages: 1, pagesRead: [1] })

      // 用抽出的文字做核对（模型这一步必须按题面发现差 1）
      const itemsMatch = /Items:\s*([\d,\s]+)/.exec(result.output)
      const printedMatch = /Printed total:\s*(\d+)/.exec(result.output)
      expect(itemsMatch).not.toBeNull()
      expect(printedMatch).not.toBeNull()
      const items = (itemsMatch?.[1] ?? '').split(',').map((item) => Number(item.trim()))
      const calculated = items.reduce((sum, item) => sum + item, 0)
      const printed = Number(printedMatch?.[1])
      expect(calculated).toBe(37)
      expect(printed).toBe(38)
      expect(calculated).not.toBe(printed)
    } finally {
      ws.cleanup()
    }
  })

  it('支持 pages 选择与越界页码提示', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'invoice.pdf', 'invoice.pdf')
      const ctx = makeToolContext(ws)
      const result = await executeTool('read_pdf', { path: 'invoice.pdf', pages: '1' }, ctx)
      expect(result.ok).toBe(true)
      expect(result.output).toContain('── 第 1 页 ──')
      const outOfRange = await executeTool('read_pdf', { path: 'invoice.pdf', pages: '1-3' }, ctx)
      expect(outOfRange.ok).toBe(true)
      expect(outOfRange.output).toContain('超出范围')
    } finally {
      ws.cleanup()
    }
  })

  it('pages 一次选择过多时拒绝，避免 1-10000 撑爆页码与说明', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'invoice.pdf', 'invoice.pdf')
      const result = await executeTool('read_pdf', { path: 'invoice.pdf', pages: '1-600' }, makeToolContext(ws))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('500')
    } finally {
      ws.cleanup()
    }
  })

  it('PDF 文件头允许出现在前 1024 字节内（BOM/空行）', async () => {
    const ws = makeTempWorkspace()
    try {
      const pdf = readFileSync(fixturePath('invoice-zh.pdf'))
      writeFileSync(join(ws.root, 'leading.pdf'), Buffer.concat([Buffer.from('\uFEFF\n', 'utf8'), pdf]))
      const result = await executeTool('read_pdf', { path: 'leading.pdf' }, makeToolContext(ws))
      expect(result.ok).toBe(true)
      expect(result.output).toContain('发票编号')
    } finally {
      ws.cleanup()
    }
  })

  it('非法 pages 参数给出可自修复错误', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'invoice.pdf', 'invoice.pdf')
      const result = await executeTool('read_pdf', { path: 'invoice.pdf', pages: '第一页' }, makeToolContext(ws))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('pages 参数不合法')
      expect(result.hint).toContain('"1-3"')
    } finally {
      ws.cleanup()
    }
  })

  it('中文 PDF（LibreOffice 导出）能抽出中文正文与数字', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'invoice-zh.pdf', 'invoice-zh.pdf')
      const result = await executeTool('read_pdf', { path: 'invoice-zh.pdf' }, makeToolContext(ws))
      expect(result.ok).toBe(true)
      expect(result.output).toContain('发票编号：INV-0042')
      expect(result.output).toContain('项目金额：12、18、7')
      expect(result.output).toContain('印刷总额：38')
      expect(result.output).toContain('本发票为离线测试样例')
    } finally {
      ws.cleanup()
    }
  })

  it('无文字/扫描件 PDF 在没有本机 OCR 时明确报错（不能猜内容）', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'blank.pdf', 'scan.pdf')
      const result = await executeTool('read_pdf', { path: 'scan.pdf' }, makeToolContext(ws))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('PDF')
      expect(result.hint).toContain('扫描件')
    } finally {
      ws.cleanup()
    }
  })

  it('扫描页自动调用本机 OCR，并把识别文字交给模型', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'blank.pdf', 'scan.pdf')
      const base = makeToolContext(ws)
      const calls: number[][] = []
      const result = await executeTool(
        'read_pdf',
        { path: 'scan.pdf' },
        {
          ...base,
          ocrPdf: async ({ pages }) => {
            calls.push(pages)
            return {
              totalPages: 1,
              language: 'zh-Hans-CN',
              engine: 'Windows.Media.Ocr',
              pages: pages.map((page) => ({ page, text: '扫描发票\n合计：9821.50 元' }))
            }
          }
        }
      )
      expect(calls).toEqual([[1]])
      expect(result.ok).toBe(true)
      expect(result.output).toContain('本机 OCR 已识别 1 个扫描页')
      expect(result.output).toContain('扫描发票')
      expect(result.output).toContain('9821.50')
      expect(result.meta).toMatchObject({ ocr: true, ocrPages: [1], ocrLanguage: 'zh-Hans-CN' })
      expect(result.output).toContain('关键数字请对照原页复核')
    } finally {
      ws.cleanup()
    }
  })

  it('OCR 失败时不伪造内容，并说明失败原因', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'blank.pdf', 'scan.pdf')
      const result = await executeTool(
        'read_pdf',
        { path: 'scan.pdf' },
        {
          ...makeToolContext(ws),
          ocrPdf: async () => {
            throw new Error('本机没有 Windows OCR 语言包')
          }
        }
      )
      expect(result.ok).toBe(false)
      expect(result.error).toContain('本机 OCR 没有完成')
      expect(result.error).toContain('语言包')
      expect(result.hint).toContain('截图')
    } finally {
      ws.cleanup()
    }
  })

  it('损坏/伪装 PDF 与越界路径都给出明确错误', async () => {
    const ws = makeTempWorkspace()
    try {
      writeFileSync(join(ws.root, 'fake.pdf'), 'not a pdf at all')
      const ctx = makeToolContext(ws)
      const fake = await executeTool('read_pdf', { path: 'fake.pdf' }, ctx)
      expect(fake.ok).toBe(false)
      expect(fake.error).toContain('不是有效的 PDF')

      writeFileSync(join(ws.root, 'broken.pdf'), '%PDF-1.4\nthis stream is broken\n')
      const broken = await executeTool('read_pdf', { path: 'broken.pdf' }, ctx)
      expect(broken.ok).toBe(false)
      expect(broken.error).toBeTruthy()

      const missing = await executeTool('read_pdf', { path: 'nope.pdf' }, ctx)
      expect(missing.ok).toBe(false)
      expect(missing.error).toContain('路径不存在')

      const escape = await executeTool('read_pdf', { path: '../outside.pdf' }, ctx)
      expect(escape.ok).toBe(false)
      expect(escape.error).toContain('工作区')
    } finally {
      ws.cleanup()
    }
  })
})

/* ── M11：DOCX 读取与占位符替换 ─────────────────────────────── */

describe('read_docx / edit_docx（M11：DOCX 定点替换）', () => {
  it('读取模板：标题、正文占位符、1×2 表格、保密条款齐全', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'template.docx', 'in/template.docx')
      const result = await executeTool('read_docx', { path: 'in/template.docx' }, makeToolContext(ws))
      expect(result.ok).toBe(true)
      expect(result.output).toContain('# Pilot Letter')
      expect(result.output).toContain('Dear {{NAME}}')
      expect(result.output).toContain('We are glad to confirm your pilot participation.')
      expect(result.output).toContain('[表格 1] 1 行 × 2 列')
      expect(result.output).toContain('| Date | {{DATE}} |')
      expect(result.output).toContain('CONFIDENTIAL - internal only')
      expect(result.output).toContain('发现的占位符（2）')
      expect(result.meta).toMatchObject({ tables: 1 })
      expect(result.meta?.placeholders).toEqual(expect.arrayContaining(['{{NAME}}', '{{DATE}}']))
    } finally {
      ws.cleanup()
    }
  })

  it('M11 全流程：复制为 out/letter.docx，替换 2 处，保留标题/表格/保密条款，输入字节不变', async () => {
    const ws = makeTempWorkspace()
    try {
      const inputPath = copyFixture(ws, 'template.docx', 'in/template.docx')
      const inputHashBefore = sha256(readFileSync(inputPath))
      const result = await executeTool(
        'edit_docx',
        {
          path: 'in/template.docx',
          output_path: 'out/letter.docx',
          replacements: [
            { find: '{{NAME}}', replace: '林宁' },
            { find: '{{DATE}}', replace: '2026-04-10' }
          ]
        },
        makeToolContext(ws)
      )
      expect(result.ok).toBe(true)
      expect(result.meta).toMatchObject({ replacements: 2, inputUnchanged: true, created: true })
      expect(result.meta?.perReplacement).toEqual([
        { find: '{{NAME}}', count: 1 },
        { find: '{{DATE}}', count: 1 }
      ])
      expect(result.output).toContain('替换 2 处')

      // 输入文件字节不变
      expect(existsSync(inputPath)).toBe(true)
      expect(sha256(readFileSync(inputPath))).toBe(inputHashBefore)

      // 输出文件可重新读取，且内容正确
      const outputPath = join(ws.root, 'out/letter.docx')
      expect(existsSync(outputPath)).toBe(true)
      expect(sha256(readFileSync(outputPath))).toBe(String(result.meta?.afterHash))
      const reread = await executeTool('read_docx', { path: 'out/letter.docx' }, makeToolContext(ws))
      expect(reread.ok).toBe(true)
      expect(reread.output).toContain('# Pilot Letter')
      expect(reread.output).toContain('Dear 林宁')
      expect(reread.output).toContain('| Date | 2026-04-10 |')
      expect(reread.output).toContain('CONFIDENTIAL - internal only')
      expect(reread.output).not.toContain('{{NAME}}')
      expect(reread.output).not.toContain('{{DATE}}')
      expect(reread.meta?.placeholders).toEqual([])

      // OOXML 包结构完整：输入里所有 zip 部件在输出里都存在（标题/表格/样式不丢）
      const inputZip = await JSZip.loadAsync(readFileSync(inputPath))
      const outputZip = await JSZip.loadAsync(readFileSync(outputPath))
      const inputEntries = Object.keys(inputZip.files).filter((name) => !inputZip.files[name].dir).sort()
      const outputEntries = Object.keys(outputZip.files).filter((name) => !outputZip.files[name].dir).sort()
      expect(outputEntries).toEqual(inputEntries)
      const documentXml = await outputZip.file('word/document.xml')?.async('string')
      expect(documentXml).toContain('<w:tbl')
      expect(documentXml).toContain('CONFIDENTIAL - internal only')
      expect(documentXml).toContain('林宁')
    } finally {
      ws.cleanup()
    }
  })

  it('替换文本里的 XML 非法控制字符会被剔除，避免生成打不开的 Word', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'template.docx', 'in/template.docx')
      const result = await executeTool(
        'edit_docx',
        {
          path: 'in/template.docx',
          output_path: 'out/control.docx',
          replacements: [{ find: '{{NAME}}', replace: '林\u0000宁' }]
        },
        makeToolContext(ws)
      )
      expect(result.ok).toBe(true)
      const reread = await executeTool('read_docx', { path: 'out/control.docx' }, makeToolContext(ws))
      expect(reread.ok).toBe(true)
      expect(reread.output).toContain('林宁')
      expect(reread.output).not.toContain('\u0000')
    } finally {
      ws.cleanup()
    }
  })

  it('覆盖已有输出文档时备份并可撤销', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'template.docx', 'in/template.docx')
      const output = copyFixture(ws, 'template.docx', 'out/letter.docx')
      const before = readFileSync(output)
      const result = await executeTool(
        'edit_docx',
        {
          path: 'in/template.docx',
          output_path: 'out/letter.docx',
          replacements: [{ find: '{{NAME}}', replace: '林宁' }]
        },
        makeToolContext(ws)
      )
      expect(result.ok).toBe(true)
      expect(result.meta?.snapshotPath).toBeTruthy()
      expect(sha256(readFileSync(output))).not.toBe(sha256(before))
      const restored = restoreSnapshotSafely({
        snapshotRoot: ws.snapshotDir,
        snapshotPath: String(result.meta?.snapshotPath),
        targetPath: output,
        workspace: ws.root
      })
      expect(restored.ok).toBe(true)
      expect(sha256(readFileSync(output))).toBe(sha256(before))
    } finally {
      ws.cleanup()
    }
  })

  it('Word 文本保留换行/制表符分隔，相邻 run 不会粘在一起', () => {
    const xml = '<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>World</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>End</w:t></w:r></w:p>'
    expect(collectWordText(xml)).toBe('Hello\nWorld\tEnd')
  })

  it('replace_all=false 在整个文档只替换第一处，而不是每段各替换一次', () => {
    const paragraph = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
    const xml = `<w:document><w:body>${paragraph('A {{X}} B')}${paragraph('C {{X}} D')}</w:body></w:document>`
    const firstOnly = replaceInDocxXmlFile(xml, [{ find: '{{X}}', replace: 'Y' }], false)
    expect(firstOnly.counts[0]).toBe(1)
    expect(firstOnly.xml).toContain('A Y B')
    expect(firstOnly.xml).toContain('C {{X}} D')
    const all = replaceInDocxXmlFile(xml, [{ find: '{{X}}', replace: 'Y' }], true)
    expect(all.counts[0]).toBe(2)
  })

  it('read_docx 的 max_chars 大于默认 60k 时不会被提前截断', async () => {
    const ws = makeTempWorkspace()
    try {
      const zip = new JSZip()
      const body = '长文本'.repeat(40_000)
      zip.file('word/document.xml', `<w:document><w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`)
      writeFileSync(join(ws.root, 'long.docx'), await zip.generateAsync({ type: 'nodebuffer' }))
      const result = await executeTool('read_docx', { path: 'long.docx', max_chars: 80_000 }, makeToolContext(ws))
      expect(result.ok).toBe(true)
      const output = String(result.output)
      expect(output.length).toBeGreaterThan(60_000)
      // truncateText 会在正文后附加「已截断」说明，允许少量说明文字
      expect(output.length).toBeLessThanOrEqual(80_200)
    } finally {
      ws.cleanup()
    }
  })

  it('占位符被 Word 拆到多个 run 时也能替换（split-run.docx）', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'split-run.docx', 'in/split-run.docx')
      const result = await executeTool(
        'edit_docx',
        {
          path: 'in/split-run.docx',
          output_path: 'out/split-run.docx',
          replacements: [
            { find: '{{NAME}}', replace: '林宁' },
            { find: '{{DATE}}', replace: '2026-04-10' }
          ]
        },
        makeToolContext(ws)
      )
      expect(result.ok).toBe(true)
      expect(result.meta).toMatchObject({ replacements: 2 })
      const reread = await executeTool('read_docx', { path: 'out/split-run.docx' }, makeToolContext(ws))
      expect(reread.output).toContain('Dear 林宁,')
      expect(reread.output).toContain('| Date | 2026-04-10 |')
      expect(reread.output).not.toContain('{{NAME}}')
      expect(reread.output).not.toContain('{{DATE}}')
    } finally {
      ws.cleanup()
    }
  })

  it('找不到占位符时不写输出文件并提示先 read_docx', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'template.docx', 'in/template.docx')
      const result = await executeTool(
        'edit_docx',
        { path: 'in/template.docx', output_path: 'out/letter.docx', replacements: [{ find: '{{MISSING}}', replace: 'x' }] },
        makeToolContext(ws)
      )
      expect(result.ok).toBe(false)
      expect(result.error).toContain('没有在')
      expect(result.hint).toContain('read_docx')
      expect(existsSync(join(ws.root, 'out/letter.docx'))).toBe(false)
    } finally {
      ws.cleanup()
    }
  })

  it('输出必须是与输入不同的 .docx 路径', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'template.docx', 'in/template.docx')
      const ctx = makeToolContext(ws)
      const same = await executeTool(
        'edit_docx',
        { path: 'in/template.docx', output_path: 'in/template.docx', replacements: [{ find: '{{NAME}}', replace: 'x' }] },
        ctx
      )
      expect(same.ok).toBe(false)
      expect(same.error).toContain('不能与输入文件相同')

      const notDocx = await executeTool(
        'edit_docx',
        { path: 'in/template.docx', output_path: 'out/letter.txt', replacements: [{ find: '{{NAME}}', replace: 'x' }] },
        ctx
      )
      expect(notDocx.ok).toBe(false)
      expect(notDocx.error).toContain('.docx')

      const escape = await executeTool(
        'edit_docx',
        { path: 'in/template.docx', output_path: '../outside.docx', replacements: [{ find: '{{NAME}}', replace: 'x' }] },
        ctx
      )
      expect(escape.ok).toBe(false)
      expect(escape.error).toContain('工作区')
    } finally {
      ws.cleanup()
    }
  })

  it('损坏/伪装 DOCX 给出明确错误；参数缺失可自修复', async () => {
    const ws = makeTempWorkspace()
    try {
      writeFileSync(join(ws.root, 'fake.docx'), 'definitely not a zip')
      const ctx = makeToolContext(ws)
      const fake = await executeTool('read_docx', { path: 'fake.docx' }, ctx)
      expect(fake.ok).toBe(false)
      expect(fake.error).toContain('不是有效的 .docx')

      const noReplacements = await executeTool('edit_docx', { path: 'fake.docx', output_path: 'out/a.docx' }, ctx)
      expect(noReplacements.ok).toBe(false)
      expect(noReplacements.error).toContain('replacements')

      const template = copyFixture(ws, 'template.docx', 'in/template.docx')
      const noFind = await executeTool(
        'edit_docx',
        { path: 'in/template.docx', output_path: 'out/a.docx', replacements: [{ replace: 'x' }] },
        ctx
      )
      expect(noFind.ok).toBe(false)
      expect(noFind.error).toContain('find')
      expect(existsSync(join(ws.root, 'out/a.docx'))).toBe(false)
      expect(sha256(readFileSync(template))).toBeTruthy()
    } finally {
      ws.cleanup()
    }
  })

  it('XML 良构校验能发现未闭合标签（替换安全网）', () => {
    expect(checkXmlWellFormed('<a><b/></a>').ok).toBe(true)
    expect(checkXmlWellFormed('<a><b></a>').ok).toBe(false)
    expect(checkXmlWellFormed('<a><b></b>').ok).toBe(false)
  })
})

/* ── M09：XLSX 真公式 ─────────────────────────────────────────── */

describe('write_xlsx / read_xlsx（M09：可重算工作簿）', () => {
  it('M09：生成 out/sales.xlsx，D2/D3/D4 为真公式，缓存值 6/15/21', async () => {
    const ws = makeTempWorkspace()
    try {
      const result = await executeTool(
        'write_xlsx',
        {
          path: 'out/sales.xlsx',
          sheets: [
            {
              name: 'Sales',
              rows: [
                ['Item', 'Qty', 'Price', 'Total'],
                ['Pen', 2, 3, '=B2*C2'],
                ['Book', 3, 5, '=B3*C3'],
                ['', '', '', '=SUM(D2:D3)']
              ]
            }
          ]
        },
        makeToolContext(ws)
      )
      expect(result.ok).toBe(true)
      const formulas = result.meta?.formulas as Array<{ ref: string; formula: string; cached: number }>
      expect(formulas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sheet: 'Sales', ref: 'D2', formula: 'B2*C2', cached: 6 }),
          expect.objectContaining({ sheet: 'Sales', ref: 'D3', formula: 'B3*C3', cached: 15 }),
          expect.objectContaining({ sheet: 'Sales', ref: 'D4', formula: 'SUM(D2:D3)', cached: 21 })
        ])
      )
      expect(result.meta).toMatchObject({ formulaCount: 3, created: true })

      // 直接检查 OOXML：一定是 <f> 真公式 + 缓存值 + 打开时重算
      const outputPath = join(ws.root, 'out/sales.xlsx')
      const zip = await JSZip.loadAsync(readFileSync(outputPath))
      const sheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string')
      expect(sheetXml).toContain('<f>B2*C2</f>')
      expect(sheetXml).toContain('<f>B3*C3</f>')
      expect(sheetXml).toContain('<f>SUM(D2:D3)</f>')
      expect(sheetXml).toContain('<v>21</v>')
      const workbookXml = await zip.file('xl/workbook.xml')?.async('string')
      expect(workbookXml).toContain('name="Sales"')
      expect(workbookXml).toContain('fullCalcOnLoad="1"')

      // 用 read_xlsx 回读：公式与缓存值都要能被看到
      const reread = await executeTool('read_xlsx', { path: 'out/sales.xlsx' }, makeToolContext(ws))
      expect(reread.ok).toBe(true)
      expect(reread.output).toContain('## 工作表：Sales')
      expect(reread.output).toContain('| Item | Qty | Price | Total |')
      expect(reread.output).toContain('| Pen | 2 | 3 | =B2*C2 |')
      expect(reread.output).toContain('D2 = B2*C2（缓存值：6）')
      expect(reread.output).toContain('D4 = SUM(D2:D3)（缓存值：21）')
    } finally {
      ws.cleanup()
    }
  })

  it('读取 openpyxl 生成的工作簿：共享字符串、数字、布尔、无缓存公式', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'input.xlsx', 'in/input.xlsx')
      const result = await executeTool('read_xlsx', { path: 'in/input.xlsx' }, makeToolContext(ws))
      expect(result.ok).toBe(true)
      expect(result.output).toContain('## 工作表：Sales')
      expect(result.output).toContain('| Pen | 2 | 3 | =B2*C2 |')
      expect(result.output).toContain('D2 = B2*C2（无缓存值）')
      expect(result.output).toContain('D4 = SUM(D2:D3)（无缓存值）')
      expect(result.output).toContain('## 工作表：Notes')
      expect(result.output).toContain('林宁')
      expect(result.output).toContain('TRUE')
      expect(result.output).toContain('2026')
    } finally {
      ws.cleanup()
    }
  })

  it('支持按工作表序号/名称选择与 A1 区域裁剪；未知工作表给出可用列表', async () => {
    const ws = makeTempWorkspace()
    try {
      copyFixture(ws, 'input.xlsx', 'in/input.xlsx')
      const ctx = makeToolContext(ws)
      const byIndex = await executeTool('read_xlsx', { path: 'in/input.xlsx', sheet: '1', range: 'A1:B2' }, ctx)
      expect(byIndex.ok).toBe(true)
      expect(byIndex.output).toContain('| Item | Qty |')
      expect(byIndex.output).toContain('| Pen | 2 |')
      expect(byIndex.output).not.toContain('Price')

      const byName = await executeTool('read_xlsx', { path: 'in/input.xlsx', sheet: 'Notes' }, ctx)
      expect(byName.ok).toBe(true)
      expect(byName.output).toContain('## 工作表：Notes')
      expect(byName.output).not.toContain('## 工作表：Sales')

      const unknown = await executeTool('read_xlsx', { path: 'in/input.xlsx', sheet: '不存在' }, ctx)
      expect(unknown.ok).toBe(false)
      expect(unknown.error).toContain('没有名为')
      expect(unknown.hint).toContain('Sales')

      const badRange = await executeTool('read_xlsx', { path: 'in/input.xlsx', range: 'bogus' }, ctx)
      expect(badRange.ok).toBe(false)
      expect(badRange.error).toContain('range 参数不合法')
    } finally {
      ws.cleanup()
    }
  })

  it('覆盖已有工作簿时备份旧文件（可撤销）', async () => {
    const ws = makeTempWorkspace()
    try {
      const ctx = makeToolContext(ws)
      const first = await executeTool('write_xlsx', { path: 'out/data.xlsx', sheets: [{ name: 'A', rows: [[1]] }] }, ctx)
      expect(first.ok).toBe(true)
      const firstHash = sha256(readFileSync(join(ws.root, 'out/data.xlsx')))
      const second = await executeTool('write_xlsx', { path: 'out/data.xlsx', sheets: [{ name: 'B', rows: [[2]] }] }, ctx)
      expect(second.ok).toBe(true)
      expect(second.meta?.snapshotId).toBe('call_docs')
      const backup = join(ws.snapshotDir, 'call_docs', 'data.xlsx')
      expect(existsSync(backup)).toBe(true)
      expect(second.meta?.snapshotPath).toBe(backup)
      expect(sha256(readFileSync(backup))).toBe(firstHash)
      expect(String(second.meta?.afterHash)).not.toBe(firstHash)

      const restored = restoreSnapshotSafely({
        snapshotRoot: ws.snapshotDir,
        snapshotPath: String(second.meta?.snapshotPath),
        targetPath: join(ws.root, 'out/data.xlsx'),
        workspace: ws.root
      })
      expect(restored.ok).toBe(true)
      expect(sha256(readFileSync(join(ws.root, 'out/data.xlsx')))).toBe(firstHash)
    } finally {
      ws.cleanup()
    }
  })

  it('write_xlsx 参数错误可自修复（缺 sheets / 非法单元格 / 后缀 / 越界）', async () => {
    const ws = makeTempWorkspace()
    try {
      const ctx = makeToolContext(ws)
      const noSheets = await executeTool('write_xlsx', { path: 'out/a.xlsx' }, ctx)
      expect(noSheets.ok).toBe(false)
      expect(noSheets.error).toContain('sheets')

      const badCell = await executeTool(
        'write_xlsx',
        { path: 'out/a.xlsx', sheets: [{ name: 'A', rows: [[{ nested: true }]] }] },
        ctx
      )
      expect(badCell.ok).toBe(false)
      expect(badCell.error).toContain('不支持的值类型')

      const tooLongText = await executeTool(
        'write_xlsx',
        { path: 'out/long-text.xlsx', sheets: [{ name: 'A', rows: [['x'.repeat(32_768)]] }] },
        ctx
      )
      expect(tooLongText.ok).toBe(false)
      expect(tooLongText.error).toContain('文本过长')

      const tooLongFormula = await executeTool(
        'write_xlsx',
        { path: 'out/long-formula.xlsx', sheets: [{ name: 'A', rows: [[`=${'1+'.repeat(5_000)}1`]] }] },
        ctx
      )
      expect(tooLongFormula.ok).toBe(false)
      expect(tooLongFormula.error).toContain('公式过长')

      const badSuffix = await executeTool('write_xlsx', { path: 'out/a.xls', sheets: [{ name: 'A', rows: [[1]] }] }, ctx)
      expect(badSuffix.ok).toBe(false)
      expect(badSuffix.error).toContain('.xlsx')

      const escape = await executeTool('write_xlsx', { path: '../a.xlsx', sheets: [{ name: 'A', rows: [[1]] }] }, ctx)
      expect(escape.ok).toBe(false)
      expect(escape.error).toContain('工作区')

      writeFileSync(join(ws.root, 'fake.xlsx'), 'not a zip')
      const fakeRead = await executeTool('read_xlsx', { path: 'fake.xlsx' }, ctx)
      expect(fakeRead.ok).toBe(false)
      expect(fakeRead.error).toContain('不是有效的 .xlsx')
    } finally {
      ws.cleanup()
    }
  })

  it('公式求值器覆盖 M09 与常见函数，循环引用/未知函数不产生缓存值', () => {
    const result = evaluateSheet([
      ['Item', 'Qty', 'Price', 'Total'],
      ['Pen', 2, 3, '=B2*C2'],
      ['Book', 3, 5, '=B3*C3'],
      ['', '', '', '=SUM(D2:D3)']
    ])
    expect(result.get('D2')?.value).toBe(6)
    expect(result.get('D3')?.value).toBe(15)
    expect(result.get('D4')?.value).toBe(21)
    expect(result.get('D4')?.error).toBeUndefined()

    const functions = evaluateSheet([
      [1, 2, '=SUM(A1:B1)'],
      [3, 4, '=AVERAGE(A1:B2)'],
      [5, 6, '=MAX(A1:B3)'],
      ['=ROUND(10/3,2)', '=IF(A1>0,"yes","no")', '=A1&B1']
    ])
    expect(functions.get('C1')?.value).toBe(3)
    expect(functions.get('C2')?.value).toBe(2.5)
    expect(functions.get('C3')?.value).toBe(6)
    expect(functions.get('A4')?.value).toBe(3.33)
    expect(functions.get('B4')?.value).toBe('yes')
    expect(functions.get('C4')?.value).toBe('12')

    const unsupported = evaluateSheet([[1, '=VLOOKUP(A1,B1:C2,2,FALSE)']])
    expect(unsupported.get('B1')?.value).toBeNull()
    expect(unsupported.get('B1')?.error).toBeTruthy()

    const cyclic = evaluateSheet([[1, '=B1+1'], ['=A2+1']])
    expect(cyclic.get('B1')?.value).toBeNull()
    expect(cyclic.get('B1')?.error).toContain('循环引用')
  })
})
