/**
 * 渲染 2.5D 品牌图标：build/icon-source.svg → build/icon.png（1024，透明背景）
 * 随后由 scripts/make-icons.py 生成多尺寸 .ico。
 */
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const svg = readFileSync(join(root, 'build', 'icon-source.svg'), 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`)
await page.waitForTimeout(150)
const buffer = await page.screenshot({ omitBackground: true, type: 'png' })
writeFileSync(join(root, 'build', 'icon.png'), buffer)
await browser.close()
console.log('[icon] build/icon.png 1024x1024 written')
