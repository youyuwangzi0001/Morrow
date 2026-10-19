// 诊断构建产物的渲染层错误（console / pageerror / 截图）
import { _electron as electron } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronEnv } from './env.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const stamp = Date.now()
const outDir = join(root, 'tmp', 'debug')
mkdirSync(outDir, { recursive: true })

const app = await electron.launch({
  args: ['.', '--no-sandbox', `--user-data-dir=${join(root, 'tmp', 'chromium-ud-' + stamp)}`, `--data-dir=${join(root, 'tmp', 'app-data-' + stamp)}`, '--test-mode'],
  cwd: root,
  env: electronEnv({ MORROW_TEST: '1' })
})
const page = await app.firstWindow()
const logs = []
page.on('console', (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`))
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.stack || err.message}`))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(2500)
const body = await page.evaluate(() => document.body.innerText.slice(0, 2000))
const html = await page.evaluate(() => document.getElementById('root')?.innerHTML.slice(0, 800) ?? 'NO ROOT')
await page.screenshot({ path: join(outDir, 'diagnose.png') })
console.log('--- logs ---')
console.log(logs.join('\n') || '(none)')
console.log('--- body text ---')
console.log(body)
console.log('--- root html ---')
console.log(html)
await app.close()
