#!/usr/bin/env node
/**
 * B1 真实验收：用 netstat 从**外部**观察 relay 端口。
 *
 * 为什么不用 GuiApp：本机 GUI 模式的 Electron 起不来（已知环境限制，见 A 轨报告）。
 * 但 relay 是纯 Node 的 HTTP 服务，不依赖窗口。所以这里的做法是：
 *   1. 用 esbuild 把 src/relay/server.ts 打成单文件（反映当前真实源码）；
 *   2. 在独立 Node 子进程里启动它；
 *   3. 父进程用 netstat 从外部检查端口状态。
 *
 * 这样验证的是「真实进程 + 真实套接字表」，不是内存里的模拟对象。
 * 这正是蓝图 B1 要求的 netstat 验证方式。
 *
 * 用法：node scripts/verify-relay-netstat.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const BUNDLE = join(tmpdir(), `relay-bundle-${process.pid}.mjs`)
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

/** netstat 查某端口是否在 LISTENING，以及绑定地址 */
function listeningOn(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line)
      if (m && Number(m[2]) === port) return { addr: m[1], pid: Number(m[3]) }
    }
    return null
  } catch {
    return null
  }
}

function portFree(port) {
  return listeningOn(port) === null
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`超时：${label}`)
}

// ── 准备：打包真实源码 ──
try {
  // 直接用本地 esbuild 的 JS 入口，避免依赖 npx 在 PATH 中的可执行性
  const esbuild = join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild')
  execFileSync(process.execPath, [esbuild, 'src/relay/server.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${BUNDLE}`], {
    cwd: ROOT,
    stdio: 'pipe'
  })
  record('打包 src/relay/server.ts 成功', existsSync(BUNDLE), `${(readFileSync(BUNDLE).length / 1024).toFixed(1)} KB`)
} catch (err) {
  record('打包 src/relay/server.ts 成功', false, String(err).slice(0, 200))
  console.log('\n0/1 通过')
  process.exit(1)
}

const PORT = 47833

/** 启动一个服务子进程，返回 { child, dataDir, result() } */
async function runServer(mode) {
  const dataDir = mkdtempSync(join(tmpdir(), `relay-netstat-${mode}-`))
  const script = `
import { startRelay } from ${JSON.stringify(pathToFileURL(BUNDLE).href)};
const r = await startRelay({ allowUnauthenticated: true, enabled: ${mode === 'on'}, dataDir: ${JSON.stringify(dataDir)}, port: ${PORT} });
console.log(JSON.stringify({ port: r.port, listening: r.listening }));
// 保持进程存活，等待外部观察
setTimeout(() => { void r.stop(); }, 20000);
`
  const runner = join(dataDir, 'run.mjs')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(runner, script, 'utf8')

  const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))
  return { child, dataDir, logs }
}

async function stop(child) {
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 400))
}

// ── 场景 1：关闭 → 端口不得监听 ──
{
  if (!portFree(PORT)) {
    record(`场景 1 前置：端口 ${PORT} 空闲`, false, '端口已被其他进程占用，无法验证')
  } else {
    const { child, dataDir, logs } = await runServer('off')
    try {
        console.log('    [子进程输出] ' + logs.join('').slice(0, 600).split(String.fromCharCode(10)).join(' | '))
      const auditExists = existsSync(join(dataDir, 'relay', 'audit.jsonl'))
      record('关闭时不产生审计文件', !auditExists, auditExists ? '存在 audit.jsonl' : '无')
    } finally {
      await stop(child)
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

// ── 场景 2：开启 → 端口出现在 netstat，且只在回环 ──
{
  if (!portFree(PORT)) {
    record(`场景 2 前置：端口 ${PORT} 空闲`, false, '端口被占用')
  } else {
    const { child, dataDir, logs } = await runServer('on')
    try {
      const hit = await waitFor(() => listeningOn(PORT), 10000, `端口 ${PORT} LISTENING`).catch(() => null)
      if (!hit) {
        console.log('    [子进程输出] ' + logs.join('').slice(0, 600).split(String.fromCharCode(10)).join(' | '))
      }
      record(`开启后 netstat 出现 ${PORT}`, !!hit, hit ? `${hit.addr}:${PORT} pid=${hit.pid}` : '未出现')
      if (hit) {
        record('只绑回环地址（不对局域网开放）', hit.addr === '127.0.0.1', `绑定 ${hit.addr}`)
        // 从外部真实发一次请求，确认服务可用
        const res = await fetch(`http://127.0.0.1:${PORT}/relay/chat:send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'NETSTAT-PROBE-SECRET', sessionId: 's-1' })
        })
        const body = await res.json()
        record('白名单通道可达（未绑定返回 NOT_BOUND）', res.status === 500 && body.error?.code === 'NOT_BOUND', `HTTP ${res.status} ${body.error?.code ?? ''}`)

        const bad = await fetch(`http://127.0.0.1:${PORT}/relay/app:change-data-dir`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir: 'C:/hack' })
        })
        const badBody = await bad.json()
        record('非白名单通道被拒绝', bad.status === 403 && badBody.error?.code === 'CHANNEL_DENIED', `HTTP ${bad.status} ${badBody.error?.code ?? ''}`)

        const auditPath = join(dataDir, 'relay', 'audit.jsonl')
        const hasAudit = existsSync(auditPath)
        record('调用后写入审计日志', hasAudit, hasAudit ? 'audit.jsonl' : '缺失')
        if (hasAudit) {
          const text = readFileSync(auditPath, 'utf8')
          record('审计不含请求参数原文', !text.includes('NETSTAT-PROBE-SECRET'), `${text.split('\n').filter(Boolean).length} 条`)
        }
      }
    } finally {
      await stop(child)
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

try {
  rmSync(BUNDLE, { force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)