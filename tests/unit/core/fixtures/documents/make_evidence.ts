/**
 * 离线证据生成脚本：用真实文档工具跑一遍 M09 / M11 / M12 场景，把中间产物与结果写到
 * `tmp/doc-evidence/`（gitignored，可随时重跑）。
 *
 * 运行：npx vite-node tests/unit/core/fixtures/documents/make_evidence.ts
 * 产物：
 *   ws/out/sales.xlsx       —— M09 write_xlsx 生成的工作簿（真公式）
 *   ws/out/letter.docx      —— M11 edit_docx 生成的替换结果
 *   ws/out/read_pdf.txt     —— M12 read_pdf 的原始输出
 *   ws/out/read_docx.txt    —— M11 read_docx 回读输出
 *   ws/out/read_xlsx.txt    —— M09 read_xlsx 回读输出
 *   m09-result.json / m11-result.json / m12-result.json / evidence.json
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { executeTool } from '../../../../../src/core/tools/registry'
import { sha256 } from '../../../../../src/core/util'
import { makeToolContext } from '../../helpers/tool-context'

const ROOT = process.cwd()
const FIXTURES = join(ROOT, 'tests', 'unit', 'core', 'fixtures', 'documents')
const OUT = join(ROOT, 'tmp', 'doc-evidence')
const WS = join(OUT, 'ws')

function copyFixture(name: string, target: string): string {
  const absolute = join(WS, target)
  mkdirSync(dirname(absolute), { recursive: true })
  copyFileSync(join(FIXTURES, name), absolute)
  return absolute
}

function writeFile(target: string, content: string): string {
  const absolute = join(WS, target)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf8')
  return absolute
}

function fileInfo(target: string): { path: string; bytes: number; sha256: string } {
  const absolute = join(WS, target)
  return { path: absolute, bytes: readFileSync(absolute).length, sha256: sha256(readFileSync(absolute)) }
}

function mustOk(label: string, result: { ok: boolean; output: string; error?: string; hint?: string }): void {
  if (!result.ok) {
    throw new Error(`${label} 失败：${result.error ?? 'unknown'} / ${result.hint ?? ''}`)
  }
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })

  // M09 输入 CSV 与 M11/M12 输入文件
  writeFile('in/sales.csv', 'Item,Qty,Price\nPen,2,3\nBook,3,5\n')
  copyFixture('template.docx', 'in/template.docx')
  copyFixture('invoice.pdf', 'in/invoice.pdf')

  // M12：read_pdf
  const pdfResult = await executeTool(
    'read_pdf',
    { path: 'in/invoice.pdf' },
    makeToolContext({ root: WS, snapshotDir: join(OUT, 'snapshots'), cleanup: () => undefined })
  )
  mustOk('read_pdf', pdfResult)
  writeFile('out/read_pdf.txt', pdfResult.output)
  const items = [...pdfResult.output.matchAll(/Items:\s*([\d,\s]+)/g)][0]?.[1]
  const printedRaw = /Printed total:\s*(\d+)/.exec(pdfResult.output)?.[1]
  const invoiceId = /INV-\d+/.exec(pdfResult.output)?.[0]
  const calculated = (items ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .reduce((sum, value) => sum + value, 0)
  const printed = Number(printedRaw)
  const m12 = {
    tool: 'read_pdf',
    fixture: 'fixtures/documents/invoice.pdf',
    invoice_id: invoiceId,
    calculated_total: calculated,
    printed_total: printed,
    matches: calculated === printed
  }

  // M11：edit_docx 复制模板并替换 2 处
  const editResult = await executeTool(
    'edit_docx',
    {
      path: 'in/template.docx',
      output_path: 'out/letter.docx',
      replacements: [
        { find: '{{NAME}}', replace: '林宁' },
        { find: '{{DATE}}', replace: '2026-04-10' }
      ]
    },
    makeToolContext({ root: WS, snapshotDir: join(OUT, 'snapshots'), cleanup: () => undefined })
  )
  mustOk('edit_docx', editResult)
  const readDocxBack = await executeTool(
    'read_docx',
    { path: 'out/letter.docx' },
    makeToolContext({ root: WS, snapshotDir: join(OUT, 'snapshots'), cleanup: () => undefined })
  )
  mustOk('read_docx', readDocxBack)
  writeFile('out/read_docx.txt', readDocxBack.output)
  const m11 = {
    tool: 'edit_docx',
    fixture: 'fixtures/documents/template.docx',
    input_unchanged: editResult.meta?.inputUnchanged === true,
    input_sha256: editResult.meta?.inputHashBefore,
    replacements: editResult.meta?.replacements,
    per_replacement: editResult.meta?.perReplacement,
    output_has_title: readDocxBack.output.includes('# Pilot Letter'),
    output_has_table: readDocxBack.output.includes('| Date | 2026-04-10 |'),
    output_has_confidential: readDocxBack.output.includes('CONFIDENTIAL - internal only'),
    output_placeholders: readDocxBack.meta?.placeholders
  }

  // M09：write_xlsx 真公式
  const writeResult = await executeTool(
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
    makeToolContext({ root: WS, snapshotDir: join(OUT, 'snapshots'), cleanup: () => undefined })
  )
  mustOk('write_xlsx', writeResult)
  const readXlsxBack = await executeTool(
    'read_xlsx',
    { path: 'out/sales.xlsx' },
    makeToolContext({ root: WS, snapshotDir: join(OUT, 'snapshots'), cleanup: () => undefined })
  )
  mustOk('read_xlsx', readXlsxBack)
  writeFile('out/read_xlsx.txt', readXlsxBack.output)
  const formulas = writeResult.meta?.formulas as Array<{ ref: string; formula: string; cached: number }> | undefined
  const zip = await JSZip.loadAsync(readFileSync(join(WS, 'out/sales.xlsx')))
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string')
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string')
  const m09 = {
    tool: 'write_xlsx',
    fixture: 'in/sales.csv（题目数据）',
    grand_total: formulas?.find((formula) => formula.ref === 'D4')?.cached,
    formulas,
    real_formula_nodes: {
      D2: sheetXml?.includes('<f>B2*C2</f>') ?? false,
      D3: sheetXml?.includes('<f>B3*C3</f>') ?? false,
      D4: sheetXml?.includes('<f>SUM(D2:D3)</f>') ?? false
    },
    cached_21: sheetXml?.includes('<v>21</v>') ?? false,
    full_calc_on_load: workbookXml?.includes('fullCalcOnLoad="1"') ?? false
  }

  writeFile('../m12-result.json', JSON.stringify(m12, null, 2) + '\n')
  writeFile('../m11-result.json', JSON.stringify(m11, null, 2) + '\n')
  writeFile('../m09-result.json', JSON.stringify(m09, null, 2) + '\n')

  const evidence = {
    generated_at: new Date().toISOString(),
    workspace: WS,
    tools: ['read_pdf', 'read_docx', 'edit_docx', 'read_xlsx', 'write_xlsx'],
    files: {
      'in/invoice.pdf': fileInfo('in/invoice.pdf'),
      'in/template.docx': fileInfo('in/template.docx'),
      'out/letter.docx': fileInfo('out/letter.docx'),
      'out/sales.xlsx': fileInfo('out/sales.xlsx')
    },
    m12,
    m11,
    m09
  }
  writeFile('../evidence.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ m12, m11, m09: { grand_total: m09.grand_total, formulas: m09.formulas, real_formula_nodes: m09.real_formula_nodes } }, null, 2))
  console.log(`\n证据目录：${OUT}`)
}

void main()
