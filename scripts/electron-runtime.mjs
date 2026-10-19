// 启动真实 Electron 应用的测试运行时。
//
// 背景：DSH 会话里的子进程带有受限令牌/作业对象，直接作为子进程启动 Electron 会原生崩溃
// （0x80000003 / 0xc0000005）。用 WMI 创建进程可以把 Electron 交给 WmiPrvSE 启动，
// 从而获得正常的桌面环境；再用 Chrome DevTools Protocol 连接做截图与交互测试。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function wmiLaunch({ exe, args, cwd, env }) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`
  const envLines = Object.entries(env)
    .map(([k, v]) => `$env:${k} = ${q(v)}`)
    .join('\n')
  const script = `
$ErrorActionPreference = 'Stop'
${envLines}
$exe = ${q(exe)}
$args = @(${args.map((a) => q(a)).join(', ')})
$cmd = '"' + $exe + '" ' + ($args -join ' ')
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = ${q(cwd)} }
if ($res.ReturnValue -eq 0) { Write-Output ('PID=' + $res.ProcessId) } else { Write-Output ('ERR=' + $res.ReturnValue); exit 1 }
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8'
  })
  const pidMatch = out.match(/PID=(\d+)/)
  if (!pidMatch) throw new Error(`WMI 启动失败: ${out.trim()}`)
  return Number(pidMatch[1])
}

async function waitForEndpoint(port, timeoutMs, isAlive) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return await res.json()
    } catch {
      // 还没起来
    }
    if (isAlive && !isAlive()) throw new Error('Electron 进程在调试端口就绪前退出')
    await delay(250)
  }
  throw new Error(`等待 CDP 端口超时（${timeoutMs}ms）`)
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * @param {object} opts
 * @param {string[]} [opts.args] 额外参数（默认启动项目根）
 * @param {string} [opts.dataDir]
 * @param {string} [opts.executablePath] 默认 node_modules/electron/dist/electron.exe
 * @param {string} [opts.cwd]
 * @param {Record<string,string>} [opts.env]
 * @param {number} [opts.timeoutMs]
 */
export async function launchMorrow(opts = {}) {
  const cwd = opts.cwd || root
  const exe = opts.executablePath || join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!existsSync(exe)) throw new Error(`找不到 Electron 可执行文件: ${exe}`)
  const dataDir = opts.dataDir || join(root, 'tmp', 'run-data-' + Date.now())
  const port = opts.port || (await freePort())
  const args = opts.args || ['.']
  const fullArgs = [
    ...args,
    `--remote-debugging-port=${port}`,
    `--data-dir=${dataDir}`,
    '--test-mode',
    ...(opts.extraArgs || [])
  ]
  const env = { MORROW_TEST: '1', ...(opts.env || {}) }
  const pid = wmiLaunch({ exe, args: fullArgs, cwd, env })
  const version = await waitForEndpoint(port, opts.timeoutMs || 45000, () => processAlive(pid))
  return {
    pid,
    port,
    dataDir,
    version,
    endpoint: `http://127.0.0.1:${port}`,
    async close() {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        // 已退出
      }
    }
  }
}
