// dev / preview 的统一入口：清理 ELECTRON_RUN_AS_NODE 后转交 electron-vite
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronEnv } from './env.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bin = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const args = process.argv.slice(2)
const command = args.length > 0 ? args : ['dev']

const child = spawn(process.execPath, [bin, ...command], {
  cwd: root,
  env: electronEnv(),
  stdio: 'inherit'
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})
