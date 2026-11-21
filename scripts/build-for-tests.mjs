import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const buildTemp = resolve(root, 'tmp/esbuild-tests')
mkdirSync(buildTemp, { recursive: true })

// Windows 上 esbuild 需要可写的临时目录。只传给构建子进程，避免把 Git
// 的非仓库夹具也放进 Morrow 仓库，误触发父仓库保护。
const result = spawnSync(process.execPath, [
  resolve(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build', '--logLevel', 'warn'
], {
  cwd: root,
  env: { ...process.env, TEMP: buildTemp, TMP: buildTemp },
  stdio: 'inherit',
  windowsHide: true
})
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
