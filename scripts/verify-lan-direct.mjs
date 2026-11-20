/**
 * LAN 直连的真实性验收（netstat + 真握手 + 关闭后端口消失）。
 *
 * 为什么单独一个脚本：单测里 `DirectChannel` 跑在**同一个进程**里，
 * 无法证明「端口真的对外监听」—— 尤其是「只绑了回环却以为能接受局域网手机」这种错误：
 * 单元测试连 127.0.0.1 一样能通，看起来完全正常，真机上手机永远连不上。
 *
 * 四组验收：
 * 1. 启动后 netstat 能看到 <port> LISTENING，且**绑定地址不是 127.0.0.1**
 *    （绑定回环 = 手机连不上，这正是要抓的错误）
 * 2. 真 TLS 握手 + hello → welcome 成功
 * 3. 未配对设备被拒
 * 4. disconnect 后端口消失（开关关掉等于攻击面归零）
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * 临时入口与 bundle 都写在仓库内：
 * `ws` / `selfsigned` 标记为 external（它们内部用 CommonJS 的 `require('events')`，
 * 打进 ESM 会报 "Dynamic require is not supported"），外置后由 node 从
 * ROOT/node_modules 解析 —— 放系统临时目录就找不到依赖了。
 */
const ENTRY = join(ROOT, `tmp-lan-entry-${process.pid}.ts`)
const BUNDLE = join(ROOT, `tmp-lan-bundle-${process.pid}.mjs`)
const ENTRY_SOURCE = `export { PairingService } from './src/relay/pairing'
export { DirectChannel } from './src/relay/net/direct-channel'
export { loadOrCreateTls } from './src/relay/net/tls'
export { SecureChannel } from './src/relay/net/secure-frame'
`

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function netstatListeners(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
    return out
      .split('\n')
      .filter((line) => new RegExp(`:${port}\\s`).test(line) && /LISTEN/i.test(line))
      .map((line) => line.trim().replace(/\s+/g, ' '))
  } catch {
    return []
  }
}

async function main() {
  // 入口文件现写现用：不依赖仓库里预先存在的临时文件（否则脚本会「只在某台机器上能跑」）
  writeFileSync(ENTRY, ENTRY_SOURCE, 'utf8')

  // 用本地 esbuild 把真实源码打成单文件（与 verify-relay-netstat.mjs 同一手法）
  // ws / selfsigned 外置：它们内部用 CommonJS require，打进 ESM 会炸
  const esbuild = join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild')
  execFileSync(
    process.execPath,
    [esbuild, ENTRY, '--bundle', '--platform=node', '--format=esm', '--external:ws', '--external:selfsigned', `--outfile=${BUNDLE}`],
    { cwd: ROOT, stdio: 'pipe' }
  )

  const mod = await import(pathToFileURL(BUNDLE).href)
  const { DirectChannel, loadOrCreateTls, PairingService } = mod
  const { randomBytes, createECDH } = await import('node:crypto')

  const dataDir = mkdtempSync(join(tmpdir(), 'morrow-lan-'))
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (t) => Buffer.from(t, 'utf8'),
    decryptString: (b) => b.toString('utf8')
  }

  const tls = await loadOrCreateTls({ dataDir, safeStorage })
  const pairing = new PairingService({ secret: randomBytes(32) })
  const ch = new DirectChannel({ pairing, tls })
  await ch.connect()
  const port = ch.port()

  // ── 1. 端口真的在监听，且不是只绑回环 ──
  const listeners = netstatListeners(port)
  check('启动后 netstat 出现 LAN 端口监听', listeners.length > 0, listeners[0] ?? `端口 ${port} 无监听`)

  const loopbackOnly = listeners.length > 0 && listeners.every((l) => l.includes('127.0.0.1:'))
  check('不是只绑回环（否则手机连不上）', listeners.length > 0 && !loopbackOnly, listeners[0] ?? '')

  // ── 2. 真握手 ──
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const phonePub = ecdh.getPublicKey().toString('base64')
  const { ticket } = pairing.issueTicket('lan-phone', phonePub)
  const device = pairing.completePairing(ticket.nonce, phonePub)

  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false })
  const welcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('welcome 超时')), 5000)
    ws.once('open', () => {
      const ts = String(Date.now())
      const sig = PairingService.signRequest(device.sessionKey, 'lan-phone', 'lan', ts)
      ws.send(JSON.stringify({ v: 1, kind: 'hello', deviceId: 'lan-phone', ts, sig, lastSeq: 0 }))
    })
    ws.once('message', (raw) => {
      clearTimeout(timer)
      resolve(JSON.parse(raw.toString()))
    })
    ws.once('error', reject)
  })
  check('真 TLS 握手 + hello → welcome', welcome.kind === 'welcome', `fingerprint=${String(welcome.fingerprint).slice(0, 12)}…`)
  check('证书指纹随 welcome 下发（手机据此固定）', typeof welcome.fingerprint === 'string' && welcome.fingerprint.length > 20)
  check('welcome 下发 16 字节连接 salt（加密通道的前提）', Buffer.from(String(welcome.salt ?? ''), 'base64').length === 16, String(welcome.salt ?? '').slice(0, 10) + '…')
  check('welcome 不含任何载荷（明文下发的只能是元数据）', welcome.replay === undefined && welcome.replayCount === undefined)
  check('已鉴权连接被计入', ch.linkCount() === 1)

  // ── 3. 线上真的是密文（中继转发时看到的就是这些字节） ──
  const { SecureChannel } = mod
  const phoneChannel = new SecureChannel({
    sessionKey: device.sessionKey,
    connectionSalt: welcome.salt,
    deviceId: 'lan-phone'
  })

  const rawFrames = []
  ws.on('message', (raw) => rawFrames.push(raw))

  const SECRET = 'C:\\交付成品\\Morrow\\私密路径'
  ch.broadcast('event', { detail: SECRET })
  await new Promise((r) => setTimeout(r, 200))

  const wire = Buffer.concat(rawFrames).toString('utf8')
  check('线上字节里搜不到广播内容（中继看不到明文）', !wire.includes(SECRET) && !wire.includes('私密路径'), `${rawFrames.length} 帧`)

  const dataFrames = rawFrames.map((b) => JSON.parse(b.toString()))
  const sealedOk = dataFrames.length > 0 && dataFrames.every((f) => Object.keys(f).sort().join() === 'c,n')
  check('每条后续帧都只有 {n, c} 两个字段', sealedOk, JSON.stringify(dataFrames[0] ?? {}).slice(0, 40))

  let decrypted = ''
  try {
    decrypted = phoneChannel.open('desktop-to-phone', dataFrames[0]).toString('utf8')
  } catch (err) {
    decrypted = `解密失败：${err.message}`
  }
  // 解出来的正文里应能找到载荷内容。
  // 注意：这里比对的是**中文部分**而不是完整路径 —— JSON 文本里反斜杠是转义的
  // （`C:\x` 变成 `C:\\x`），拿原串做 includes 会假失败，这是我第一次写这行时的错。
  check('手机用 sessionKey + salt 能解开（说明密钥对得上）', decrypted.includes('私密路径'), decrypted.slice(0, 60))

  // ── 4. 篡改帧被断开（4402） ──
  const tamperWs = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false })
  const tamperCode = await new Promise((resolve) => {
    tamperWs.once('open', () => {
      const ts = String(Date.now())
      const sig = PairingService.signRequest(device.sessionKey, 'lan-phone', 'lan', ts)
      tamperWs.send(JSON.stringify({ v: 1, kind: 'hello', deviceId: 'lan-phone', ts, sig, lastSeq: 0 }))
      tamperWs.once('message', (raw) => {
        const w = JSON.parse(raw.toString())
        const ch2 = new SecureChannel({ sessionKey: device.sessionKey, connectionSalt: w.salt, deviceId: 'lan-phone' })
        const f = ch2.seal('phone-to-desktop', JSON.stringify({ kind: 'ack', seq: 1 }))
        const buf = Buffer.from(f.c, 'base64url')
        buf[buf.length - 1] ^= 0xff
        tamperWs.send(JSON.stringify({ n: f.n, c: buf.toString('base64url') }))
      })
    })
    tamperWs.once('close', (code) => resolve(code))
  })
  check('篡改加密帧被服务端断开（4402）', tamperCode === 4402, `关闭码 ${tamperCode}`)

  // ── 5. 未配对设备被拒 ──
  const bad = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false })
  const closeCode = await new Promise((resolve) => {
    bad.once('open', () => {
      bad.send(JSON.stringify({ v: 1, kind: 'hello', deviceId: 'stranger', ts: String(Date.now()), sig: 'x', lastSeq: 0 }))
    })
    bad.once('close', (code) => resolve(code))
  })
  check('未配对设备被拒（4401）', closeCode === 4401, `关闭码 ${closeCode}`)

  ws.close()
  await new Promise((r) => setTimeout(r, 120))

  // ── 6. 关闭后端口消失 ──
  await ch.disconnect()
  await new Promise((r) => setTimeout(r, 200))
  const afterClose = netstatListeners(port)
  check('disconnect 后端口不再监听（攻击面归零）', afterClose.length === 0, afterClose[0] ?? '无监听')

  rmSync(dataDir, { recursive: true, force: true })
  rmSync(BUNDLE, { force: true })
  rmSync(ENTRY, { force: true })

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('验收脚本本身出错：', err)
  for (const p of [BUNDLE, ENTRY]) {
    try {
      rmSync(p, { force: true })
    } catch {
      // ignore
    }
  }
  process.exit(2)
})
