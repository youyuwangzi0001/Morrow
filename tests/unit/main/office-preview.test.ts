/**
 * 文件预览扩展 —— 文档转换验收：
 * XLSX 多工作表、PPTX 文本、RTF/ODT/ODS/EPUB、ZIP 列表；
 * 以及 describeFilePreview 对新类型的识别。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  convertDocumentToPreview,
  convertPptxToPreview,
  convertXlsxToPreview,
  listArchive
} from '../../../src/main/services/office-preview'
import { describeFilePreview } from '../../../src/main/services/file-preview'
import { makeTempWorkspace, type TempWorkspace } from '../core/helpers/workspace'

async function writeZip(ws: TempWorkspace, name: string, files: Record<string, string>): Promise<string> {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) zip.file(path, content)
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  const target = join(ws.root, name)
  writeFileSync(target, buffer)
  return target
}

function xlsxFiles(): Record<string, string> {
  return {
    'xl/workbook.xml':
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      '<sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Month</t></si><si><t>Amount</t></si><si><t>Jan</t></si><si><t>A &amp; B</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>100</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" t="inlineStr"><is><t>42</t></is></c></row>' +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Note</t></is></c></row></sheetData></worksheet>'
  }
}

function pptxFiles(): Record<string, string> {
  const slide = (title: string, line: string): string =>
    '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>' +
    `<a:p><a:r><a:t>${title}</a:t></a:r></a:p><a:p><a:r><a:t>${line}</a:t></a:r></a:p>` +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  return {
    'ppt/slides/slide1.xml': slide('Quarterly Sales', 'Revenue up 12%'),
    'ppt/slides/slide2.xml': slide('Next Steps', 'Expand to two regions')
  }
}

describe('office preview conversion', () => {
  it('reads XLSX sheets, shared strings, inline strings and numbers', async () => {
    const ws = makeTempWorkspace()
    try {
      await writeZip(ws, 'sales.xlsx', xlsxFiles())
      const result = await convertXlsxToPreview(ws.root, 'sales.xlsx')
      expect(result.sheets.map((sheet) => sheet.name)).toEqual(['Sales', 'Notes'])
      expect(result.sheets[0].rows[0]).toEqual(['Month', 'Amount'])
      expect(result.sheets[0].rows[1]).toEqual(['Jan', '100'])
      expect(result.sheets[0].rows[2]).toEqual(['A & B', '42'])
      expect(result.sheets[1].rows[0][0]).toBe('Note')
      expect(result.warnings).toEqual([])
    } finally {
      ws.cleanup()
    }
  })

  it('extracts PPTX slide titles and text lines in order', async () => {
    const ws = makeTempWorkspace()
    try {
      await writeZip(ws, 'deck.pptx', pptxFiles())
      const result = await convertPptxToPreview(ws.root, 'deck.pptx')
      expect(result.slides).toHaveLength(2)
      expect(result.slides[0]).toMatchObject({ index: 1, title: 'Quarterly Sales', lines: ['Revenue up 12%'] })
      expect(result.slides[1]).toMatchObject({ index: 2, title: 'Next Steps', lines: ['Expand to two regions'] })
    } finally {
      ws.cleanup()
    }
  })

  it('converts RTF, ODT, ODS and EPUB to escaped readable HTML', async () => {
    const ws = makeTempWorkspace({ 'note.rtf': '{\\rtf1\\ansi Hello \\par World <tag>}' })
    try {
      const rtf = await convertDocumentToPreview(ws.root, 'note.rtf')
      expect(rtf.format).toBe('RTF')
      expect(rtf.html).toContain('<p>Hello</p>')
      expect(rtf.html).toContain('&lt;tag&gt;')

      await writeZip(ws, 'note.odt', {
        'content.xml': '<office:text><text:p>Hello</text:p><text:h>Heading</text:h><text:p>World &amp; more</text:p></office:text>'
      })
      const odt = await convertDocumentToPreview(ws.root, 'note.odt')
      expect(odt.format).toBe('ODT')
      expect(odt.html).toContain('<p>Hello</p>')
      expect(odt.html).toContain('<h2>Heading</h2>')
      expect(odt.html).toContain('World &amp; more')

      await writeZip(ws, 'sheet.ods', {
        'content.xml':
          '<office:document><table:table><table:table-row>' +
          '<table:table-cell><text:p>Name</text:p></table:table-cell><table:table-cell><text:p>Score</text:p></table:table-cell>' +
          '</table:table-row><table:table-row><table:table-cell><text:p>Ada</text:p></table:table-cell>' +
          '<table:table-cell><text:p>98</text:p></table:table-cell></table:table-row></table:table></office:document>'
      })
      const ods = await convertDocumentToPreview(ws.root, 'sheet.ods')
      expect(ods.format).toBe('ODS')
      expect(ods.html).toContain('<table>')
      expect(ods.html).toContain('<td>Ada</td>')

      await writeZip(ws, 'book.epub', {
        'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
        'OEBPS/content.opf':
          '<package><manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
          '<spine><itemref idref="c1"/></spine></package>',
        'OEBPS/chapter1.xhtml': '<html><body><h1>Chapter One</h1><p>Once upon a time.</p></body></html>'
      })
      const epub = await convertDocumentToPreview(ws.root, 'book.epub')
      expect(epub.format).toBe('EPUB')
      expect(epub.html).toContain('Chapter One')
      expect(epub.html).toContain('Once upon a time.')
    } finally {
      ws.cleanup()
    }
  })

  it('lists ZIP entries without extracting and identifies new preview kinds', async () => {
    const ws = makeTempWorkspace()
    try {
      await writeZip(ws, 'bundle.zip', {
        'docs/readme.txt': 'hello',
        'docs/': ''
      })
      const archive = await listArchive(ws.root, 'bundle.zip')
      expect(archive.entries.some((entry) => entry.name === 'docs/readme.txt' && !entry.dir)).toBe(true)
      expect(archive.entries.some((entry) => entry.name === 'docs/' && entry.dir)).toBe(true)

      await writeZip(ws, 'book.xlsx', xlsxFiles())
      expect(describeFilePreview(ws.root, 'book.xlsx').kind).toBe('xlsx')
      await writeZip(ws, 'deck.pptx', pptxFiles())
      expect(describeFilePreview(ws.root, 'deck.pptx').kind).toBe('pptx')
      await writeZip(ws, 'note.odt', { 'content.xml': '<text:p>x</text:p>' })
      writeFileSync(join(ws.root, 'note.rtf'), '{\\rtf1 hello}', 'utf8')
      expect(describeFilePreview(ws.root, 'note.odt').kind).toBe('document')
      expect(describeFilePreview(ws.root, 'bundle.zip').kind).toBe('archive')
      expect(describeFilePreview(ws.root, 'note.rtf').kind).toBe('document')
    } finally {
      ws.cleanup()
    }
  })
})
