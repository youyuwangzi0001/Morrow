// npm 11 默认不执行依赖的 install 脚本，这里手动确保 Electron 二进制就位。
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const electronDir = join(root, 'node_modules', 'electron')
const installScript = join(electronDir, 'install.js')
const pathTxt = join(electronDir, 'path.txt')

if (!existsSync(installScript)) {
  console.log('[morrow] electron package not installed yet, skip binary check')
  process.exit(0)
}

// 只跑不需要 Electron 的门槛（类型检查、UI 审计、文档检查、清单校验）时，
// 由调用方显式跳过 ~368MB 的二进制下载；默认仍然下载，避免 E2E 缺运行时。
if (process.env.MORROW_SKIP_ELECTRON_BINARY === '1') {
  console.log('[morrow] MORROW_SKIP_ELECTRON_BINARY=1, skip electron binary download')
  process.exit(0)
}

let installed = false
if (existsSync(pathTxt)) {
  const { readFileSync } = await import('node:fs')
  const rel = readFileSync(pathTxt, 'utf8').trim()
  installed = existsSync(join(electronDir, 'dist', rel))
}

if (!installed) {
  console.log('[morrow] downloading electron binary (npmmirror)...')
  execFileSync(process.execPath, [installScript], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
    }
  })
  console.log('[morrow] electron binary ready')
} else {
  console.log('[morrow] electron binary ready')
}
