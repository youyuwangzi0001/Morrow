/**
 * 文件预览扩展 E2E：
 * - XLSX 多工作表表格、PPTX 幻灯片文本、ZIP 文件列表、RTF 文档；
 * - CSV 编辑器内表格预览、SVG 图形预览；
 * - 旧版 .doc 明确提示用系统应用打开；
 * - 明暗主题截图。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { expect, test, type Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, readStore, setThemeViaStore, waitUntil, waitForStoreReady } from './store'

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function writeZip(workspace: string, name: string, files: Record<string, string>): Promise<void> {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) zip.file(path, content)
  writeFileSync(join(workspace, name), await zip.generateAsync({ type: 'nodebuffer' }))
}

function xlsxFiles(): Record<string, string> {
  return {
    'xl/workbook.xml':
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      '<sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Month</t></si><si><t>Amount</t></si><si><t>Jan</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>100</v></c></row></sheetData></worksheet>',
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

function openFile(page: Page, path: string): Promise<void> {
  return page.evaluate((filePath) => {
    window.dispatchEvent(new CustomEvent('morrow:open-file', { detail: { path: filePath } }))
  }, path)
}

async function createPreviewSession(page: Page, workspace: string): Promise<void> {
  await page.evaluate(async (ws) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const state = store.getState()
    const created = await window.morrow.session.create({
      workspace: ws,
      model: state.settings.defaultModel,
      permissionMode: 'auto',
      title: '文件预览测试'
    })
    if (!created.ok) throw new Error(created.error.message)
    await store.getState().selectSession(created.data.id)
  }, workspace)
}

test('常见文档、压缩包、表格与图形均可打开', async () => {
  test.setTimeout(180_000)
  const workspace = workspaceAt('e2e-preview-extended')
  writeFileSync(join(workspace, 'sales.csv'), 'Month,Amount\nJan,100\nFeb,120\n', 'utf8')
  writeFileSync(join(workspace, 'note.rtf'), '{\\rtf1\\ansi Hello from RTF \\par Second line}', 'utf8')
  writeFileSync(join(workspace, 'legacy.doc'), 'legacy', 'utf8')
  writeFileSync(
    join(workspace, 'mark.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#c8ae7d"/></svg>',
    'utf8'
  )
  await writeZip(workspace, 'sales.xlsx', xlsxFiles())
  await writeZip(workspace, 'deck.pptx', pptxFiles())
  await writeZip(workspace, 'bundle.zip', { 'docs/readme.txt': 'hello', 'docs/': '' })

  const morrow = await launchMorrow({ name: 'preview-extended', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createPreviewSession(page, workspace)

    // XLSX
    await openFile(page, 'sales.xlsx')
    await expect(page.getByTestId('xlsx-preview')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('xlsx-preview')).toContainText('Jan')
    await expect(page.getByTestId('xlsx-preview')).toContainText('100')
    await expect(page.locator('.office-sheet-tab')).toHaveCount(2)
    await page.locator('.office-sheet-tab').nth(1).click()
    await expect(page.getByTestId('xlsx-preview')).toContainText('Note')

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('preview-xlsx-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('preview-xlsx-light.png') })
    await setThemeViaStore(page, 'dark')

    // PPTX
    await openFile(page, 'deck.pptx')
    await expect(page.getByTestId('pptx-preview')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('pptx-preview')).toContainText('Quarterly Sales')
    await expect(page.getByTestId('pptx-preview')).toContainText('Expand to two regions')
    await page.screenshot({ path: screenshotPath('preview-pptx-dark.png') })

    // ZIP
    await openFile(page, 'bundle.zip')
    await expect(page.getByTestId('archive-preview')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('archive-preview')).toContainText('docs/readme.txt')
    await page.screenshot({ path: screenshotPath('preview-archive-dark.png') })

    // RTF
    await openFile(page, 'note.rtf')
    await expect(page.getByTestId('document-preview')).toBeVisible({ timeout: 30_000 })
    const documentFrame = page.frameLocator('.preview-docx-frame')
    await expect(documentFrame.getByText('Hello from RTF')).toBeVisible()
    await expect(documentFrame.getByText('Second line')).toBeVisible()

    // CSV：编辑器内预览表格
    await openFile(page, 'sales.csv')
    await expect(page.locator('.editor-pane')).toBeVisible()
    await page.getByTitle('预览表格').click()
    await expect(page.getByTestId('table-preview')).toBeVisible()
    await expect(page.getByTestId('table-preview')).toContainText('Amount')
    await page.screenshot({ path: screenshotPath('preview-table-dark.png') })

    // SVG：编辑器内预览图形
    await openFile(page, 'mark.svg')
    await page.getByTitle('预览图形').click()
    await expect(page.locator('.editor-preview-svg img')).toBeVisible()

    // 旧版 .doc：明确降级说明
    await openFile(page, 'legacy.doc')
    await expect(page.getByTestId('unsupported-preview')).toBeVisible()
    await expect(page.getByTestId('unsupported-preview')).toContainText('旧版 Office')

    const state = await readStore(page)
    expect(state.session?.workspace).toBe(workspace)
  } finally {
    await morrow.close()
  }
})
