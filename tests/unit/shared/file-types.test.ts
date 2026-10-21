import { describe, expect, it } from 'vitest'
import {
  isImageFileName,
  isPreviewImageFileName,
  isTableFileName,
  mimeTypeForFileName,
  previewKindForFileName
} from '../../../src/shared/file-types'

describe('file preview type classification', () => {
  it('keeps chat attachments raster-only while preview accepts more image formats', () => {
    expect(isImageFileName('photo.webp')).toBe(true)
    expect(isImageFileName('diagram.svg')).toBe(false)
    expect(isImageFileName('photo.heic')).toBe(false)
    expect(isPreviewImageFileName('diagram.svg')).toBe(true)
    expect(isPreviewImageFileName('photo.heic')).toBe(true)
    expect(isPreviewImageFileName('scan.tiff')).toBe(true)
    // SVG 仍然走可编辑文本 + 图形预览，而不是二进制图片预览
    expect(previewKindForFileName('diagram.svg')).toBe('text')
    expect(mimeTypeForFileName('photo.heic')).toBe('image/heic')
  })

  it('classifies office, document, archive and table formats', () => {
    expect(previewKindForFileName('book.xlsx')).toBe('xlsx')
    expect(previewKindForFileName('deck.pptx')).toBe('pptx')
    expect(previewKindForFileName('note.rtf')).toBe('document')
    expect(previewKindForFileName('book.epub')).toBe('document')
    expect(previewKindForFileName('bundle.zip')).toBe('archive')
    expect(previewKindForFileName('legacy.doc')).toBe('unsupported')
    expect(previewKindForFileName('data.csv')).toBe('text')
    expect(isTableFileName('data.tsv')).toBe(true)
    expect(previewKindForFileName('main.ts')).toBe('text')
  })
})
