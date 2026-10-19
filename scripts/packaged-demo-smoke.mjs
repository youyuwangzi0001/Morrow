// 打包版离线演示验收：从真实入口（文件夹版 Morrow.exe 启动器）启动，走真实 store 启动演示。
// 注意：文件夹版 Morrow.exe 是轻量启动器，会追加 --no-sandbox 后启动 Morrow-app.exe；
// Playwright 的 _electron.launch 只能直接启动 Electron，所以这里用「spawn + CDP」。
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { electronEnv } from './env.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const stamp = Date.now()
const dataDir = join(root, 'tmp', 'pkgdemo-' + stamp)
mkdirSync(dataDir, { recursive: true })
const screens = join(root, 'docs', 'verification', 'screens')
const exe = join(root, 'release', 'Morrow-1.0.0-portable', 'Morrow.exe')
const port = await new Promise((resolve) => {
  const srv = createServer()
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port
    srv.close(() => resolve(p))
  })
})
const started = Date.now()
const child = spawn(exe, [
  '--user-data-dir=' + join(root, 'tmp', 'pkgdemo-ud-' + stamp),
  '--data-dir=' + dataDir,
  '--test-mode',
  '--skip-onboarding',
  '--remote-debugging-port=' + port
], {
  cwd: join(root, 'release', 'Morrow-1.0.0-portable'),
  env: electronEnv({ MORROW_TEST: '1', MORROW_DEMO_SPEED: '0.15' }),
  stdio: 'ignore'
})
let ready = false
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 250))
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
    if (res.ok) { ready = true; break }
  } catch {}
}
console.log('launcher CDP ready:', ready, 'ms:', Date.now() - started)
if (!ready) {
  console.error('启动器未能启动应用')
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  process.exit(1)
}
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].waitForEvent('page')
await page.waitForTimeout(1500)
const packaged = await page.evaluate(async () => {
  const b = await window.morrow.bootstrap()
  return { dataDir: b.data.app.dataDir, electron: b.data.app.electron, version: b.data.app.version }
})
await page.evaluate(() => window.__morrowStore.getState().startDemo())
let state = null
for (let i = 0; i < 500; i++) {
  await page.waitForTimeout(250)
  state = await page.evaluate(() => {
    const s = window.__morrowStore.getState()
    return {
      run: !!s.run,
      msgs: s.session?.messages.length ?? 0,
      artifacts: s.session?.artifacts?.length ?? 0,
      canvas: s.canvas.open,
      todos: s.session?.todos?.map((t) => t.status) ?? [],
      sessions: s.sessions.length,
      toast: s.toast?.message ?? null
    }
  })
  if (!state.run && state.msgs > 0) break
}
console.log('packaged:', JSON.stringify(packaged), 'demo:', JSON.stringify(state))
await page.waitForTimeout(2200)
await page.screenshot({ path: join(screens, 'packaged-demo-done.png') })
console.log('demo workspace:', existsSync(join(dataDir, 'demo-workspace')) ? readdirSync(join(dataDir, 'demo-workspace')) : 'MISSING')
console.log('screenshots:', join(screens, 'packaged-demo-done.png'))
await browser.close()
try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
