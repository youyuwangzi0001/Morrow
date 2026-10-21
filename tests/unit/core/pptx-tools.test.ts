/**
 * read_pptx：按演示顺序提取文字与备注；工作区外只允许显式附件白名单。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { executeTool } from '../../../src/core/tools/registry'
import { makeTempWorkspace } from './helpers/workspace'
import { makeToolContext } from './helpers/tool-context'

const SLIDE_ONE = `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>
<a:p><a:r><a:t>季度回顾</a:t></a:r></a:p>
<a:p><a:r><a:t>收入增长 &amp; 成本下降</a:t></a:r></a:p>
</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`

const SLIDE_TWO = `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>
<a:p><a:r><a:t>渠道结构</a:t></a:r></a:p>
</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`

const NOTES = `<p:notes xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>
<a:p><a:r><a:t>讲一下京东自营的占比。</a:t></a:r></a:p>
</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`

async function buildPptx(): Promise<Buffer> {
  const zip = new JSZip()
  // 演示顺序故意与文件名相反，验证按 presentation.xml 的关系顺序读取
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>'
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'
  )
  zip.file('ppt/slides/slide1.xml', SLIDE_ONE)
  zip.file('ppt/slides/slide2.xml', SLIDE_TWO)
  zip.file(
    'ppt/slides/_rels/slide2.xml.rels',
    '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>'
  )
  zip.file('ppt/notesSlides/notesSlide1.xml', NOTES)
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function buildLongPptx(slideCount = 8, textLength = 1200): Promise<Buffer> {
  const zip = new JSZip()
  const ids: string[] = []
  const rels: string[] = []
  for (let index = 1; index <= slideCount; index += 1) {
    ids.push(`<p:sldId id="${255 + index}" r:id="rId${index + 1}"/>`)
    rels.push(
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index}.xml"/>`
    )
    const text = `第${index}页 ${'内容'.repeat(textLength)}`
    zip.file(
      `ppt/slides/slide${index}.xml`,
      `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    )
  }
  zip.file(
    'ppt/presentation.xml',
    `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`
  )
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships>${rels.join('')}</Relationships>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('read_pptx', () => {
  it('按演示顺序提取文字与备注，支持页码筛选', async () => {
    const ws = makeTempWorkspace()
    try {
      writeFileSync(join(ws.root, 'deck.pptx'), await buildPptx())
      const ctx = makeToolContext(ws)
      const result = await executeTool('read_pptx', { path: 'deck.pptx' }, ctx)
      expect(result.ok, result.error).toBe(true)
      expect(result.output).toContain('共 2 页')
      // 演示顺序：slide2 在前
      expect(result.output.indexOf('渠道结构')).toBeLessThan(result.output.indexOf('季度回顾'))
      expect(result.output).toContain('收入增长 & 成本下降')
      expect(result.output).toContain('讲一下京东自营的占比')
      expect(result.meta).toMatchObject({ slides: 2, slidesRead: 2 })

      const onlySecond = await executeTool('read_pptx', { path: 'deck.pptx', slides: '2', include_notes: false }, ctx)
      expect(onlySecond.ok).toBe(true)
      expect(onlySecond.output).toContain('季度回顾')
      expect(onlySecond.output).not.toContain('渠道结构')
      expect(onlySecond.output).not.toContain('讲一下京东自营')
    } finally {
      ws.cleanup()
    }
  })

  it('max_chars 预算用尽后停止读取后续幻灯片并提示截断', async () => {
    const ws = makeTempWorkspace()
    try {
      writeFileSync(join(ws.root, 'long.pptx'), await buildLongPptx())
      const result = await executeTool('read_pptx', { path: 'long.pptx', max_chars: 2_000 }, makeToolContext(ws))
      expect(result.ok, result.error).toBe(true)
      expect(Number((result.meta as Record<string, unknown>).slidesRead)).toBeLessThan(8)
      expect(result.output).toContain('截断')
      expect(result.output).not.toContain('第8页')
    } finally {
      ws.cleanup()
    }
  })

  it('用户显式附加的工作区外 PPTX 可读，未附加的同一路径被拒绝', async () => {
    const ws = makeTempWorkspace()
    const outside = makeTempWorkspace()
    try {
      const external = join(outside.root, '外部方案.pptx')
      writeFileSync(external, await buildPptx())
      const denied = await executeTool('read_pptx', { path: external }, makeToolContext(ws))
      expect(denied.ok).toBe(false)

      const allowed = await executeTool(
        'read_pptx',
        { path: external },
        makeToolContext(ws, { attachedFiles: [external] })
      )
      expect(allowed.ok, allowed.error).toBe(true)
      expect(allowed.output).toContain('渠道结构')
    } finally {
      ws.cleanup()
      outside.cleanup()
    }
  })

  it('无工作区时仍可读取显式附件', async () => {
    const outside = makeTempWorkspace()
    try {
      const external = join(outside.root, '外部方案.pptx')
      writeFileSync(external, await buildPptx())
      const ctx = makeToolContext(outside, { workspace: null, attachedFiles: [external] })
      const result = await executeTool('read_pptx', { path: external }, ctx)
      expect(result.ok, result.error).toBe(true)
      expect(result.output).toContain('季度回顾')
    } finally {
      outside.cleanup()
    }
  })
})
