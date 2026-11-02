// 启动构建产物并截图（视觉走查通用工具）
// 用法：
//   node scripts/shot.mjs <输出名> [--theme=dark|light] [--wait=ms] [--onboarding=0] [--data=<dir>]
//   --onboarding=0 时跳过首次引导（仅测试启动参数，不会写入用户设置）
import { _electron as electron } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronEnv } from './env.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const name = process.argv[2] || 'shot'
const getArg = (key, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${key}=`))
  return found ? found.slice(key.length + 3) : fallback
}
const theme = getArg('theme', 'dark')
const wait = Number(getArg('wait', '2000'))
const onboarding = getArg('onboarding', '0')
const exe = getArg('exe', undefined)
const outDir = join(root, 'docs', 'verification', 'screens')
mkdirSync(outDir, { recursive: true })
const stamp = Date.now()
const chromiumDir = join(root, 'tmp', `chromium-ud-${stamp}`)
const dataDir = getArg('data', join(root, 'tmp', `app-data-${stamp}`))

const app = await electron.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: [
    '.',
    '--no-sandbox',
    `--user-data-dir=${chromiumDir}`,
    `--data-dir=${dataDir}`,
    '--test-mode',
    ...(onboarding === '0' ? ['--skip-onboarding'] : [])
  ],
  cwd: root,
  env: electronEnv({ MORROW_TEST: '1' })
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(wait)
if (theme === 'light') {
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.waitForTimeout(500)
}
const file = join(outDir, `${name}.png`)
await page.screenshot({ path: file })
console.log('screenshot:', file)
await app.close()
