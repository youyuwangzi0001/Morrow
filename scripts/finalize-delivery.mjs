/**
 * 交付收尾：把 E2E 截图收敛为 12 张图文指南，清理历史验证图片、媒体证据与打包缓存。
 *
 * 安全边界：
 * - 从不触碰 deliver/（尤其是用户数据 deliver/Morrow Data 与交付产物）。
 * - 检测到 Morrow 正在运行时默认退出，避免删除被占用的运行时缓存。
 * - 历史材料移到 .qoder/internal/verification/，不随交付发布。
 *
 * 用法：node scripts/finalize-delivery.mjs
 * 前置：已跑完 E2E、npm run dist、打包冒烟与打包版 E2E。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const screens = join(root, 'docs', 'verification', 'screens')
const guide = join(root, 'docs', 'guide', 'screens')
const internal = join(root, '.qoder', 'internal', 'verification')

const guideMap = {
  '01-onboarding-dark.png': 'brand-onboarding-dark.png',
  '02-chat-home-dark.png': 'r7-final-layout-dark.png',
  '03-permission-card-dark.png': 'permission-card-dark.png',
  '04-editor-canvas-dark.png': 'r10-editor-open.png',
  '05-settings-models-dark.png': 'settings-title-models-dark.png',
  '06-subscriptions-dark.png': 'subscription-detail-codex-dark.png',
  '07-settings-appearance-dark.png': 'settings-title-appearance-dark.png',
  // 08 是人工净化的多媒体截图，避免被 E2E 测试模型覆盖。
  '09-browser-tabs-dark.png': 'browser-tabs-dark.png',
  '10-terminal-dark.png': 'terminal-dark.png',
  '11-memory-center-dark.png': 'r10-memory-center-dark.png',
  '12-projects-dark.png': 'a1-project-home.png'
}

function runningMorrow() {
  const result = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  if (result.status !== 0) return false
  return /(?:^|,)"?(?:Morrow|Morrow-app)\.exe"?,/im.test(result.stdout || '')
}

function remove(target) {
  try {
    rmSync(target, { recursive: true, force: true })
  } catch (err) {
    console.warn(`[finalize] 跳过被占用的 ${relative(root, target)}：${err instanceof Error ? err.message : String(err)}`)
  }
}

if (runningMorrow()) {
  console.error('[finalize] 检测到 Morrow 正在运行。请先完全退出（含托盘），再执行清理。')
  process.exit(1)
}

if (!existsSync(screens)) {
  console.error('[finalize] 找不到 docs/verification/screens，请先运行全量 E2E。')
  process.exit(1)
}

mkdirSync(guide, { recursive: true })
const missing = []
for (const [dest, source] of Object.entries(guideMap)) {
  const from = join(screens, source)
  if (!existsSync(from)) {
    missing.push(source)
    continue
  }
  copyFileSync(from, join(guide, dest))
}
if (missing.length > 0) {
  console.error(`[finalize] 缺少指南截图：${missing.join('、')}`)
  process.exit(1)
}
console.log(`[finalize] 指南截图 ${Object.keys(guideMap).length} 张 → docs/guide/screens/`)

// 打包冒烟截图是唯一保留在 verification 下的图片证据。
const smokeShot = join(screens, 'packaged-smoke.png')
if (existsSync(smokeShot)) {
  copyFileSync(smokeShot, join(root, 'docs', 'verification', 'packaged-smoke.png'))
}

// 历史媒体证据移到内部归档，不随交付发布。
const media = join(root, 'docs', 'verification', 'media')
if (existsSync(media)) {
  mkdirSync(internal, { recursive: true })
  const target = join(internal, 'media')
  if (!existsSync(target)) renameSync(media, target)
  else remove(media)
  console.log('[finalize] 媒体证据 → .qoder/internal/verification/media')
}

// 只保留本次打包/冒烟日志。
const logs = join(root, 'docs', 'verification', 'logs')
if (existsSync(logs)) {
  const keep = /^(?:dist-portable|smoke-packaged-portable)\.log$/
  for (const name of readdirSync(logs)) {
    if (!keep.test(name)) remove(join(logs, name))
  }
}

// 删除旧验证截图目录（指南已复制，冒烟图已单独保留）。
remove(screens)
console.log('[finalize] 已清理旧验证截图；保留 docs/verification/packaged-smoke.png')

// 打包缓存与临时目录；不动 deliver/、out/、node_modules/。
const tmp = join(root, 'tmp')
if (existsSync(tmp)) {
  for (const name of readdirSync(tmp)) {
    if (/^(?:e2e-|data-|chromium-|electron-|release-|deliver-|pkg-|installer-|r\d|a\d-|b\d-|packaged-single|win-temp|launcher-|test-merge|merge-errors|compile-launcher|write-artifacts|locked-runtimes)/.test(name) || name.endsWith('.log')) {
      remove(join(tmp, name))
    }
  }
}
remove(join(root, 'release'))
remove(join(root, 'test-results'))
remove(join(root, 'playwright-report'))
console.log('[finalize] 已清理 tmp 缓存、release/、test-results/、playwright-report/')

const stats = existsSync(guide)
  ? readdirSync(guide).filter((name) => name.endsWith('.png')).length
  : 0
console.log(`[finalize] 完成：指南 ${stats} 张，验证截图 ${existsSync(screens) ? '仍存在' : '已清理'}`)
