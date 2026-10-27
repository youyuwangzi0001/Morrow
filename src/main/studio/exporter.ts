// 创作台交付物：成书、字幕、封面与可继续编辑的工程包。
import { BrowserWindow } from 'electron'
import JSZip from 'jszip'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import type { StudioAsset, StudioChapter, StudioDelivery, StudioProject } from '../../shared/studio'
import { countWords, formatDuration, isStudioVideoDelivery, studioKindLabel } from '../../shared/studio'
import { nowMs, sha256Buffer, studioId } from './store'
import { getStudioStore } from './store'
import { toAss, toSrt } from './timeline'

let exportFontCss: string | null | undefined

/** 找到带 Noto Serif SC @font-face 的随包样式；离线导出不依赖系统字体。 */
export function bundledExportFontStylesheet(): string | null {
  if (exportFontCss !== undefined) return exportFontCss
  exportFontCss = null
  try {
    const assets = join(app.getAppPath(), 'out', 'renderer', 'assets')
    for (const name of readdirSync(assets)) {
      if (!name.endsWith('.css')) continue
      const file = join(assets, name)
      const css = readFileSync(file, 'utf8')
      if (css.includes('@font-face') && css.includes('noto-serif-sc')) {
        exportFontCss = pathToFileURL(file).href
        break
      }
    }
  } catch {
    // 开发态未构建或资源缺失时保留系统字体回退
  }
  return exportFontCss
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export function cleanFileName(value: string, fallback = '未命名'): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim()
  return (cleaned || fallback).slice(0, 80)
}

function chapterParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+$/g, '').trim())
    .filter(Boolean)
}

type BookBlock = { kind: 'paragraph'; text: string } | { kind: 'illustration'; asset: StudioAsset; caption: string }

function chapterBlocks(project: StudioProject, chapter: StudioChapter): BookBlock[] {
  const paragraphs = chapterParagraphs(chapter.content)
  const illustrations = chapter.illustrations
    .map((item) => ({ item, asset: project.assets.find((asset) => asset.id === item.assetId) }))
    .filter((entry): entry is { item: StudioChapter['illustrations'][number]; asset: StudioAsset } => Boolean(entry.asset))
  const blocks: BookBlock[] = []
  for (let index = 0; index <= paragraphs.length; index += 1) {
    if (index > 0) blocks.push({ kind: 'paragraph', text: paragraphs[index - 1] })
    for (const { item, asset } of illustrations) {
      if (Math.max(0, Math.min(paragraphs.length, item.afterParagraph)) === index) {
        blocks.push({ kind: 'illustration', asset, caption: item.caption?.trim() || asset.title })
      }
    }
  }
  return blocks
}

function imageContentType(ext: string): string {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/png'
}

function illustrationBytes(project: StudioProject, asset: StudioAsset): Buffer | null {
  try {
    const path = getStudioStore().assetAbsolute(project, asset)
    if (!existsSync(path) || statSync(path).size > 16 * 1024 * 1024) return null
    return readFileSync(path)
  } catch {
    return null
  }
}

function bookMeta(project: StudioProject): { title: string; author: string; words: number; intro: string } {
  return {
    title: project.title || '未命名作品',
    author: 'Morrow 创作台',
    words: project.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0),
    intro: project.logline
  }
}

function saveDelivery(project: StudioProject, input: Omit<StudioDelivery, 'id' | 'createdAt' | 'bytes' | 'sha256' | 'path'> & { path: string; bytes: number; sha256: string }): StudioDelivery {
  const delivery: StudioDelivery = {
    ...input,
    id: studioId('delivery'),
    bytes: input.bytes,
    sha256: input.sha256,
    createdAt: nowMs()
  }
  const existing = project.deliveries.findIndex((item) => item.path === delivery.path)
  if (existing >= 0) project.deliveries.splice(existing, 1)
  project.deliveries.unshift(delivery)
  return delivery
}

export function writeDeliveryFile(projectId: string, fileName: string, content: string | Buffer, label: string, kind: StudioDelivery['kind'], meta?: StudioDelivery['meta']): StudioDelivery {
  const store = getStudioStore()
  const project = store.readProject(projectId)
  const dir = store.exportsDir(projectId)
  mkdirSync(dir, { recursive: true })
  const path = join('exports', fileName)
  const absolute = join(dir, fileName)
  writeFileSync(absolute, content)
  const bytes = statSync(absolute).size
  const sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex')
  const delivery = saveDelivery(project, { kind, label, path, bytes, sha256, ...(meta ? { meta } : {}) })
  project.updatedAt = nowMs()
  store.savePassive(project)
  return delivery
}

function chaptersMarkdown(project: StudioProject): string {
  const meta = bookMeta(project)
  const lines = [`# ${meta.title}`, '', meta.intro, '', '---', '']
  for (const chapter of [...project.chapters].sort((a, b) => a.number - b.number)) {
    lines.push(`## ${chapter.title}`, '')
    if (chapter.content.trim()) lines.push(chapter.content.trim(), '')
    else lines.push('（本章尚未写作）', '')
  }
  return `${lines.join('\n')}\n`
}

function chaptersText(project: StudioProject): string {
  const meta = bookMeta(project)
  const lines = [meta.title, '', meta.intro, '', '='.repeat(32), '']
  for (const chapter of [...project.chapters].sort((a, b) => a.number - b.number)) {
    lines.push(chapter.title, '')
    lines.push(chapter.content.trim() || '（本章尚未写作）', '')
  }
  return lines.join('\n')
}

export function exportTxt(project: StudioProject): StudioDelivery {
  const name = `${cleanFileName(project.title)}.txt`
  return writeDeliveryFile(project.id, name, chaptersText(project), '纯文本稿', 'txt', { words: bookMeta(project).words })
}

export function exportMarkdown(project: StudioProject): StudioDelivery {
  const name = `${cleanFileName(project.title)}.md`
  return writeDeliveryFile(project.id, name, chaptersMarkdown(project), 'Markdown 稿', 'md', { words: bookMeta(project).words })
}

export async function exportEpub(project: StudioProject): Promise<StudioDelivery> {
  const meta = bookMeta(project)
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  )
  const css = `@charset "utf-8";
html, body { margin: 0; padding: 0; }
body { font-family: "Noto Serif SC", "Songti SC", SimSun, serif; line-height: 1.95; color: #1b1a17; background: #fffaf0; }
h1 { font-size: 1.8em; margin: 2.4em 0 1.2em; font-weight: 500; }
h2 { font-size: 1.35em; margin: 2.2em 0 0.9em; font-weight: 500; }
p { text-indent: 2em; margin: 0 0 0.9em; }
figure { margin: 1.4em 0; text-align: center; page-break-inside: avoid; }
figure img { max-width: 100%; height: auto; }
figcaption { margin-top: 0.5em; color: #6b675f; font-size: 0.85em; text-align: center; }
.cover { text-align: center; padding: 14% 8%; }
.cover .kicker { letter-spacing: 0.3em; font-size: 0.8em; opacity: 0.55; }
.cover h1 { font-size: 2.4em; margin: 0.6em 0; }
.cover .intro { text-indent: 0; opacity: 0.7; }
.meta { text-align: center; text-indent: 0; font-size: 0.85em; opacity: 0.55; }
`
  zip.file('OEBPS/style.css', css)
  const coverAsset = project.coverAssetId ? project.assets.find((asset) => asset.id === project.coverAssetId) : undefined
  let coverHref = ''
  if (coverAsset) {
    try {
      const path = getStudioStore().assetAbsolute(project, coverAsset)
      if (existsSync(path)) {
        const ext = extname(path).slice(1).toLowerCase() || 'png'
        coverHref = `cover.${ext}`
        zip.file(`OEBPS/${coverHref}`, readFileSync(path))
      }
    } catch {
      // 封面丢失不阻断成书
    }
  }
  const chapters = [...project.chapters].sort((a, b) => a.number - b.number)
  const chapterFiles: Array<{ id: string; href: string; title: string }> = []
  const imageFiles = new Map<string, { href: string; mediaType: string }>()
  for (const [index, chapter] of chapters.entries()) {
    const href = `chapter-${String(index + 1).padStart(3, '0')}.xhtml`
    const blocks = chapterBlocks(project, chapter)
    const bodyParts: string[] = []
    for (const block of blocks) {
      if (block.kind === 'paragraph') {
        bodyParts.push(`<p>${escapeXml(block.text)}</p>`)
        continue
      }
      let image = imageFiles.get(block.asset.id)
      if (!image) {
        const bytes = illustrationBytes(project, block.asset)
        if (!bytes) continue
        const ext = extname(block.asset.path).slice(1).toLowerCase() || 'png'
        const imageHref = `images/${block.asset.id}.${ext}`
        zip.file(`OEBPS/${imageHref}`, bytes)
        image = { href: imageHref, mediaType: imageContentType(ext) }
        imageFiles.set(block.asset.id, image)
      }
      bodyParts.push(`<figure class="illustration"><img src="${image.href}" alt="${escapeXml(block.caption)}"/><figcaption>${escapeXml(block.caption)}</figcaption></figure>`)
    }
    const body = bodyParts.length ? bodyParts.join('\n') : '<p class="meta">本章尚未写作。</p>'
    zip.file(
      `OEBPS/${href}`,
      `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>${escapeXml(chapter.title)}</title><link rel="stylesheet" href="style.css"/></head>
<body><h2>${escapeXml(chapter.title)}</h2>${body}</body></html>`
    )
    chapterFiles.push({ id: `ch${index + 1}`, href, title: chapter.title })
  }
  zip.file(
    'OEBPS/cover.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>${escapeXml(meta.title)}</title><link rel="stylesheet" href="style.css"/></head>
<body><div class="cover">
<p class="kicker">MORROW · ${studioKindLabel(project.kind)}</p>
${coverHref ? `<p><img src="${coverHref}" alt="" style="max-width:100%;"/></p>` : ''}
<h1>${escapeXml(meta.title)}</h1>
<p class="intro">${escapeXml(meta.intro)}</p>
<p class="meta">Morrow 创作台 · ${meta.words.toLocaleString('zh-CN')} 字</p>
</div></body></html>`
  )
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title><link rel="stylesheet" href="style.css"/></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>
${chapterFiles.map((file) => `<li><a href="${file.href}">${escapeXml(file.title)}</a></li>`).join('\n')}
</ol></nav></body></html>`
  )
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0" xml:lang="zh-CN">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="bookid">urn:uuid:${project.id}</dc:identifier>
  <dc:title>${escapeXml(meta.title)}</dc:title>
  <dc:creator>Morrow 创作台</dc:creator>
  <dc:language>zh-CN</dc:language>
  <dc:description>${escapeXml(meta.intro)}</dc:description>
  <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
</metadata>
<manifest>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  <item id="css" href="style.css" media-type="text/css"/>
  <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
  ${coverHref ? `<item id="cover-image" href="${coverHref}" media-type="${imageContentType(extname(coverHref).slice(1).toLowerCase())}" properties="cover-image"/>` : ''}
  ${[...imageFiles.entries()].map(([id, image], index) => `<item id="image-${index + 1}" href="${image.href}" media-type="${image.mediaType}"/>`).join('\n  ')}
  ${chapterFiles.map((file) => `<item id="${file.id}" href="${file.href}" media-type="application/xhtml+xml"/>`).join('\n  ')}
</manifest>
<spine>
  <itemref idref="cover"/>
  <itemref idref="nav"/>
  ${chapterFiles.map((file) => `<itemref idref="${file.id}"/>`).join('\n  ')}
</spine>
</package>`
  )
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.epub`, buffer, 'EPUB 电子书', 'epub', { words: meta.words, format: 'EPUB 3' })
}

function xmlParagraphs(content: string): string {
  return chapterParagraphs(content)
    .map((paragraph) => `<w:p><w:pPr><w:ind w:firstLineChars="200" w:firstLine="640"/><w:spacing w:line="380" w:lineRule="auto" w:after="120"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`)
    .join('')
}

export async function exportDocx(project: StudioProject): Promise<StudioDelivery> {
  const meta = bookMeta(project)
  const zip = new JSZip()
  const chapters = [...project.chapters].sort((a, b) => a.number - b.number)
  const imageEntries = new Map<string, { fileName: string; relId: string; ext: string; cx: number; cy: number; bytes: Buffer }>()
  for (const chapter of chapters) {
    for (const block of chapterBlocks(project, chapter)) {
      if (block.kind !== 'illustration' || imageEntries.has(block.asset.id)) continue
      const bytes = illustrationBytes(project, block.asset)
      if (!bytes) continue
      const ext = extname(block.asset.path).slice(1).toLowerCase() || 'png'
      const number = imageEntries.size + 1
      const width = Math.max(320, block.asset.width ?? 1280)
      const height = Math.max(180, block.asset.height ?? 720)
      const scale = Math.min(1, 560 / width)
      imageEntries.set(block.asset.id, {
        fileName: `image-${number}.${ext}`,
        relId: `rIdImg${number}`,
        ext,
        cx: Math.round(width * scale * 9525),
        cy: Math.round(height * scale * 9525),
        bytes
      })
    }
  }
  for (const entry of imageEntries.values()) zip.file(`word/media/${entry.fileName}`, entry.bytes)
  const imageDefaults = [...new Set([...imageEntries.values()].map((entry) => entry.ext))]
    .map((ext) => `<Default Extension="${ext}" ContentType="${imageContentType(ext)}"/>`)
    .join('')
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${imageDefaults}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${[...imageEntries.values()].map((entry) => `<Relationship Id="${entry.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${entry.fileName}"/>`).join('\n')}
</Relationships>`
  )
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:eastAsia="宋体" w:hAnsi="Georgia"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="52"/><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="34"/><w:b/></w:rPr></w:style>
</w:styles>`
  )
  const titleXml = `<w:p><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="center"/><w:spacing w:before="2400" w:after="400"/></w:pPr><w:r><w:t>${escapeXml(meta.title)}</w:t></w:r></w:p>
<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="2000"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/><w:color w:val="666666"/></w:rPr><w:t>${escapeXml(meta.intro)}</w:t></w:r></w:p>`
  const tocXml = `<w:p><w:pPr><w:pageBreakBefore/><w:spacing w:after="360"/></w:pPr><w:r><w:rPr><w:sz w:val="40"/><w:b/></w:rPr><w:t>目录</w:t></w:r></w:p>${chapters.map((chapter, index) => `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:t>${String(index + 1).padStart(2, '0')} · ${escapeXml(chapter.title)}</w:t></w:r></w:p>`).join('')}`
  let drawingId = 0
  const chaptersXml = chapters.map((chapter) => {
    const content = chapterBlocks(project, chapter).map((block) => {
      if (block.kind === 'paragraph') return xmlParagraphs(block.text)
      const image = imageEntries.get(block.asset.id)
      if (!image) return ''
      drawingId += 1
      return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="80"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${image.cx}" cy="${image.cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${drawingId}" name="配图 ${drawingId}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${escapeXml(block.caption)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${image.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${image.cx}" cy="${image.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="280"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="666666"/></w:rPr><w:t>${escapeXml(block.caption)}</w:t></w:r></w:p>`
    }).join('')
    return `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:spacing w:before="600" w:after="240"/><w:pageBreakBefore/></w:pPr><w:r><w:t>${escapeXml(chapter.title)}</w:t></w:r></w:p>${content || '<w:p><w:r><w:t>（本章尚未写作）</w:t></w:r></w:p>'}`
  }).join('')
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${titleXml}${tocXml}${chaptersXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`
  )
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.docx`, buffer, 'Word 排版稿', 'docx', { words: meta.words })
}

function bookHtml(project: StudioProject, coverDataUrl: string | null): string {
  const meta = bookMeta(project)
  const toc = project.chapters.map((chapter) => `<li>${escapeXml(chapter.title)}</li>`).join('')
  const chapters = [...project.chapters]
    .sort((a, b) => a.number - b.number)
    .map((chapter) => {
      const body = chapterBlocks(project, chapter).map((block) => {
        if (block.kind === 'paragraph') return `<p>${escapeXml(block.text)}</p>`
        const bytes = illustrationBytes(project, block.asset)
        if (!bytes) return ''
        const ext = extname(block.asset.path).slice(1).toLowerCase() || 'png'
        const src = `data:${imageContentType(ext)};base64,${bytes.toString('base64')}`
        return `<figure class="illustration"><img src="${src}" alt="${escapeXml(block.caption)}"/><figcaption>${escapeXml(block.caption)}</figcaption></figure>`
      }).join('')
      return `<section class="chapter"><h2>${escapeXml(chapter.title)}</h2>${body || '<p class="empty">（本章尚未写作）</p>'}</section>`
    })
    .join('')
  const fontLink = bundledExportFontStylesheet()
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeXml(meta.title)}</title>
${fontLink ? `<link rel="stylesheet" href="${fontLink}">` : ''}
<style>
@page { size: A4; margin: 22mm 20mm; }
body { margin: 0; color: #1b1a17; background: #fffaf0; font-family: "Newsreader", "Noto Serif SC Variable", "Noto Serif SC", "Songti SC", SimSun, serif; font-size: 11.5pt; line-height: 1.95; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; page-break-after: always; background: radial-gradient(circle at 50% 30%, #f6ecd8, #ede2cc); }
.cover img { max-width: 120mm; max-height: 120mm; object-fit: cover; margin-bottom: 10mm; box-shadow: 0 12px 32px rgba(40,30,10,.18); }
.kicker { letter-spacing: .35em; font-size: 9pt; color: #8a6a3c; }
.cover h1 { font-size: 32pt; font-weight: 500; margin: 6mm 0 4mm; }
.cover .intro { max-width: 120mm; color: #5c574d; font-size: 10.5pt; }
.cover .meta { margin-top: 18mm; color: #8c867a; font-size: 9pt; letter-spacing: .12em; }
.toc { page-break-after: always; padding-top: 18mm; }
.toc h2 { font-size: 18pt; font-weight: 500; margin-bottom: 8mm; }
.toc ol { padding-left: 6mm; color: #3b3831; }
.toc li { margin: 2.4mm 0; }
.chapter { page-break-before: always; }
.chapter h2 { font-size: 17pt; font-weight: 500; margin: 0 0 8mm; }
.chapter p { text-indent: 2em; margin: 0 0 3.2mm; text-align: justify; }
.illustration { margin: 7mm auto; text-align: center; page-break-inside: avoid; }
.illustration img { max-width: 150mm; max-height: 105mm; object-fit: contain; }
.illustration figcaption { margin-top: 2mm; color: #8c867a; font-size: 9pt; text-indent: 0; }
.empty { color: #999; text-indent: 0; }
</style></head><body>
<div class="cover">${coverDataUrl ? `<img src="${coverDataUrl}" alt=""/>` : ''}<p class="kicker">MORROW · ${studioKindLabel(project.kind)}</p><h1>${escapeXml(meta.title)}</h1><p class="intro">${escapeXml(meta.intro)}</p><p class="meta">${meta.words.toLocaleString('zh-CN')} 字 · Morrow 创作台</p></div>
<div class="toc"><h2>目录</h2><ol>${toc}</ol></div>
${chapters}
</body></html>`
}

function coverDataUrl(project: StudioProject): string | null {
  if (!project.coverAssetId) return null
  const asset = project.assets.find((item) => item.id === project.coverAssetId)
  if (!asset) return null
  try {
    const path = getStudioStore().assetAbsolute(project, asset)
    if (!existsSync(path)) return null
    const data = readFileSync(path)
    if (data.length > 12 * 1024 * 1024) return null
    return `data:${asset.mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}

async function printHtmlToPdf(html: string): Promise<Buffer> {
  const temp = join(app.getPath('temp'), `morrow-studio-book-${randomUUID()}.html`)
  writeFileSync(temp, html, 'utf8')
  const wins = BrowserWindow.getAllWindows()
  const parent = wins.find((win) => !win.isDestroyed()) ?? null
  const win = new BrowserWindow({
    show: false,
    width: 960,
    height: 1280,
    ...(parent ? { parent } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadFile(temp)
    await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true).catch(() => undefined)
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    return pdf
  } finally {
    if (!win.isDestroyed()) win.destroy()
    try {
      rmSync(temp, { force: true })
    } catch {
    }
  }
}

export async function exportPdf(project: StudioProject): Promise<StudioDelivery> {
  const pdf = await printHtmlToPdf(bookHtml(project, coverDataUrl(project)))
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.pdf`, pdf, 'PDF 排版稿', 'pdf', { words: bookMeta(project).words, pages: 'A4' })
}

export async function exportCover(project: StudioProject): Promise<StudioDelivery> {
  const store = getStudioStore()
  const existing = project.coverAssetId ? project.assets.find((asset) => asset.id === project.coverAssetId) : undefined
  if (existing) {
    try {
      const source = store.assetAbsolute(project, existing)
      if (existsSync(source)) {
        const ext = extname(source).slice(1) || 'png'
        const name = `${cleanFileName(project.title)}-封面.${ext}`
        const target = join(store.exportsDir(project.id), name)
        mkdirSync(store.exportsDir(project.id), { recursive: true })
        cpSync(source, target)
        const buffer = readFileSync(target)
        return writeDeliveryFile(project.id, name, buffer, '封面', 'cover', { size: `${existing.width ?? ''}×${existing.height ?? ''}` })
      }
    } catch {
      // 继续生成文字封面
    }
  }
  const fontLink = bundledExportFontStylesheet()
  const html = `<!doctype html><html><head><meta charset="utf-8">${fontLink ? `<link rel="stylesheet" href="${fontLink}">` : ''}<style>
html,body { margin:0; width:1200px; height:1600px; background:#0b0d10; color:#ede7da; font-family:"Noto Serif SC Variable","Noto Serif SC","Songti SC",SimSun,serif; }
.wrap { position:relative; width:100%; height:100%; background:radial-gradient(circle at 50% 26%, #27312f 0, #141922 36%, #0b0d10 72%); overflow:hidden; }
.glow { position:absolute; inset:0; background:radial-gradient(circle at 50% 38%, rgba(200,174,125,.24), transparent 46%); }
.line { position:absolute; left:120px; right:120px; top:120px; height:1px; background:rgba(200,174,125,.38); }
.kicker { position:absolute; top:150px; left:120px; font:12px monospace; letter-spacing:.42em; color:#c8ae7d; }
h1 { position:absolute; left:120px; right:120px; top:510px; margin:0; font-size:110px; line-height:1.18; font-weight:400; letter-spacing:.04em; }
.intro { position:absolute; left:124px; right:140px; top:900px; font-size:28px; line-height:1.8; color:#a39d91; }
.foot { position:absolute; left:120px; bottom:130px; font:13px monospace; letter-spacing:.22em; color:#6b675f; }
.corner { position:absolute; right:120px; bottom:120px; width:96px; height:96px; border:1px solid rgba(200,174,125,.25); border-radius:50%; display:flex; align-items:center; justify-content:center; color:#c8ae7d; font-size:32px; }
</style></head><body><div class="wrap"><div class="glow"></div><div class="line"></div><div class="kicker">MORROW · ${studioKindLabel(project.kind)}</div><h1>${escapeXml(project.title)}</h1><div class="intro">${escapeXml(project.logline)}</div><div class="foot">MORROW CREATIVE STUDIO</div><div class="corner">M</div></div></body></html>`
  const temp = join(app.getPath('temp'), `morrow-cover-${randomUUID()}.html`)
  writeFileSync(temp, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await win.loadFile(temp)
    await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true).catch(() => undefined)
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    return writeDeliveryFile(project.id, `${cleanFileName(project.title)}-封面.png`, png, '封面', 'cover', { width: 1200, height: 1600 })
  } finally {
    if (!win.isDestroyed()) win.destroy()
    try {
      rmSync(temp, { force: true })
    } catch {
    }
  }
}

export async function exportPackage(project: StudioProject): Promise<StudioDelivery> {
  const store = getStudioStore()
  const zip = new JSZip()
  const manifest = {
    format: 'morrowcraft',
    schemaVersion: project.schemaVersion,
    id: project.id,
    kind: project.kind,
    title: project.title,
    exportedAt: new Date().toISOString(),
    version: app.getVersion(),
    files: [] as Array<{ path: string; bytes: number; sha256: string }>
  }
  const add = (relative: string, data: Buffer): void => {
    zip.file(relative, data)
    manifest.files.push({ path: relative, bytes: data.length, sha256: sha256Buffer(data) })
  }
  add('project.json', Buffer.from(`${JSON.stringify(project, null, 2)}\n`, 'utf8'))
  for (const asset of project.assets) {
    try {
      const absolute = store.assetAbsolute(project, asset)
      if (existsSync(absolute)) add(asset.path, readFileSync(absolute))
      if (asset.thumbPath) {
        const thumb = join(store.projectDir(project.id), asset.thumbPath)
        if (existsSync(thumb)) add(asset.thumbPath, readFileSync(thumb))
      }
    } catch {
      // 丢失素材只影响工程包内容，不影响其他文件
    }
  }
  add('timeline.json', Buffer.from(`${JSON.stringify(project.timeline, null, 2)}\n`, 'utf8'))
  add('facts.json', Buffer.from(`${JSON.stringify(project.facts, null, 2)}\n`, 'utf8'))
  add('README.txt', Buffer.from(`Morrow 创作台工程包\n\n作品：${project.title}\n类型：${studioKindLabel(project.kind)}\n导出时间：${new Date().toLocaleString('zh-CN')}\n\nproject.json 是可继续编辑的作品文件；assets/ 为按指纹存储的素材；timeline.json 为剪辑表。\n此包不包含模型密钥、账号信息或旧应用数据。\n`, 'utf8'))
  add('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.morrowcraft`, buffer, '创作工程包', 'package', { files: manifest.files.length, schema: project.schemaVersion })
}

export function exportSrt(project: StudioProject): StudioDelivery {
  const content = toSrt(project.timeline).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.srt`, content, '字幕文件 · SRT', 'srt', { clips: project.timeline.clips.filter((clip) => clip.kind === 'subtitle').length })
}

export function exportAss(project: StudioProject): StudioDelivery {
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.ass`, toAss(project.timeline), '字幕文件 · ASS', 'ass', { clips: project.timeline.clips.filter((clip) => clip.kind === 'subtitle').length })
}

/** 发布套组：成书 + 封面 + 字幕 + 工程包一起放进一个目录。 */
export async function exportFolder(project: StudioProject): Promise<StudioDelivery> {
  const store = getStudioStore()
  const stamp = new Date().toISOString().slice(0, 10)
  const folderName = `${cleanFileName(project.title)}-${stamp}`
  const folder = join(store.exportsDir(project.id), folderName)
  mkdirSync(folder, { recursive: true })
  const book = project.kind === 'drama' ? null : await exportEpub(project)
  const cover = await exportCover(project)
  const pkg = await exportPackage(project)
  const copies: string[] = []
  for (const delivery of [book, cover, pkg].filter((item): item is StudioDelivery => Boolean(item))) {
    const source = store.deliveryAbsolute(project.id, delivery)
    if (!existsSync(source)) continue
    const target = join(folder, basename(source))
    cpSync(source, target)
    copies.push(basename(source))
  }
  if (project.kind === 'drama') {
    const srt = exportSrt(project)
    const ass = exportAss(project)
    for (const delivery of [srt, ass]) {
      const source = store.deliveryAbsolute(project.id, delivery)
      if (existsSync(source)) {
        cpSync(source, join(folder, basename(source)))
        copies.push(basename(source))
      }
    }
    const latestMp4 = project.deliveries.find((item) => isStudioVideoDelivery(item.kind))
    if (latestMp4) {
      const source = store.deliveryAbsolute(project.id, latestMp4)
      if (existsSync(source)) {
        cpSync(source, join(folder, basename(source)))
        copies.push(basename(source))
      }
    }
  }
  writeFileSync(
    join(folder, '交付说明.txt'),
    `${project.title}\n${studioKindLabel(project.kind)} · ${project.logline}\n\n包含：\n${copies.map((name) => `· ${name}`).join('\n')}\n\n生成时间：${new Date().toLocaleString('zh-CN')}\n由 Morrow 创作台导出；工程包可继续编辑，不包含密钥。\n`,
    'utf8'
  )
  const relative = `exports/${folderName}`
  const summaryPath = join(folder, '交付说明.txt')
  const buffer = readFileSync(summaryPath)
  return writeDeliveryFile(project.id, `${folderName}/交付说明.txt`, buffer, '发布套组', 'folder', {
    folder: relative,
    files: copies.length + 1,
    ...(project.kind === 'drama' ? { duration: formatDuration(project.timeline.durationSec) } : {})
  })
}
