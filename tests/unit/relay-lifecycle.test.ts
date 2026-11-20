/**
 * Relay 生命周期：设置开关与真实服务之间的接线。
 *
 * 这一层最容易做假：只写 setRelaySettings(true) 存进配置，就宣称「功能完成」，
 * 但真实的服务从未启动，或者关了开关端口还在监听。
 * 所以这里断言的是**可观测事实**：端口能不能连上。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ dataDir: '', relayEnabled: false, relayPort: 0 }))

vi.mock('electron', () => ({
  app: { getPath: () => state.dataDir, isPackaged: false, getVersion: () => '0.0.0-test' },
  safeStorage: {
    // 用可用的假实现，让 applyRelaySettings 走真实的 keystore 持久化路径
    isEncryptionAvailable: () => true,
    encryptString: (t: string) => Buffer.from([...Buffer.from(t, 'utf8')].map((b) => b ^ 0x5a)),
    decryptString: (b: Buffer) => Buffer.from([...b].map((c) => c ^ 0x5a)).toString('utf8')
  },
  dialog: {},
  shell: {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined }
}))

vi.mock('../../src/main/settings', () => ({
  getSettingsStore: () => ({
    get: () => ({ relayEnabled: state.relayEnabled, relayPort: state.relayPort })
  })
}))

let dirs: string[] = []

beforeEach(() => {
  state.dataDir = mkdtempSync(join(tmpdir(), 'morrow-relay-life-'))
  dirs.push(state.dataDir)
  state.relayEnabled = false
  state.relayPort = 0
})

afterEach(async () => {
  const { resetRelayForTests } = await import('../../src/relay')
  await resetRelayForTests()
  vi.resetModules()
  while (dirs.length) {
    const d = dirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('node:net') as typeof import('node:net')
    const client = new net.Socket()
    client.setTimeout(400)
    client.once('connect', () => {
      client.destroy()
      resolve(true)
    })
    client.once('error', () => resolve(false))
    client.once('timeout', () => {
      client.destroy()
      resolve(false)
    })
    client.connect(port, '127.0.0.1')
  })
}

describe('relay 生命周期', () => {
  it('@core:relay 设置关闭时不监听、返回 null 端口', async () => {
    const { applyRelaySettings, relayStatus } = await import('../../src/relay')
    const r = await applyRelaySettings()
    expect(r.listening).toBe(false)
    expect(r.port).toBeNull()
    expect(relayStatus().listening).toBe(false)
  })

  it('@core:relay 设置开启后端口真的可连', async () => {
    state.relayEnabled = true
    const { applyRelaySettings, relayStatus } = await import('../../src/relay')
    const r = await applyRelaySettings()
    expect(r.listening).toBe(true)
    expect(r.port).toBeGreaterThan(0)
    expect(await canConnect(r.port as number)).toBe(true)
    expect(relayStatus().port).toBe(r.port)
  })

  it('@core:relay 从开启切回关闭：端口必须真的断开，不能只是状态位变了', async () => {
    state.relayEnabled = true
    const { applyRelaySettings } = await import('../../src/relay')
    const on = await applyRelaySettings()
    const port = on.port as number
    expect(await canConnect(port)).toBe(true)

    state.relayEnabled = false
    const off = await applyRelaySettings()
    expect(off.listening).toBe(false)
    // 关键断言：同一个端口已经连不上了
    expect(await canConnect(port)).toBe(false)
  })

  it('@core:relay 改端口后重新应用：旧端口断开、新端口可连', async () => {
    state.relayEnabled = true
    const { applyRelaySettings } = await import('../../src/relay')
    const first = await applyRelaySettings()
    const oldPort = first.port as number

    // 先占住一个确定可用的端口号，再让 relay 用它
    const net = require('node:net') as typeof import('node:net')
    const probe = net.createServer()
    const newPort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port
        probe.close(() => resolve(p))
      })
    })
    state.relayPort = newPort

    const second = await applyRelaySettings()
    expect(second.port).toBe(newPort)
    expect(await canConnect(newPort)).toBe(true)
    expect(await canConnect(oldPort)).toBe(false)
  })

  it('@core:relay 拒绝绑定非白名单通道（白名单不能被接入方绕过）', async () => {
    const { bindDesktopChannel } = await import('../../src/relay')
    expect(() => bindDesktopChannel('app:change-data-dir', async () => ({}))).toThrow(/非白名单/)
  })

  it('@core:relay 绑定白名单通道后可被分发调用', async () => {
    const { bindDesktopChannel, dispatch } = await import('../../src/relay')
    bindDesktopChannel('session:list', async () => [{ id: 'live-1' }])
    const r = await dispatch('session:list', {})
    expect(r.ok).toBe(true)
    expect(r.data).toEqual([{ id: 'live-1' }])
  })

  it('@core:relay shutdown 后端口断开', async () => {
    state.relayEnabled = true
    const { applyRelaySettings, shutdownRelay } = await import('../../src/relay')
    const r = await applyRelaySettings()
    const port = r.port as number
    expect(await canConnect(port)).toBe(true)

    await shutdownRelay()
    expect(await canConnect(port)).toBe(false)
  })
})

/**
 * 接线验证：applyRelaySettings 真的把 pairing 传给了 startRelay。
 *
 * 为什么必须有这组：B3 修的正是「忘了传 pairing」的缺陷。
 * 如果只测 startRelay（测试自己传 pairing），把 index.ts 里那行删掉，
 * 所有测试仍然全绿 —— 这就是 B2 当初的失败模式。
 *
 * 所以这里走真实入口 applyRelaySettings，然后断言「未配对请求被拒」这个
 * **只有传了 pairing 才会发生**的可观测行为。
 */
describe('applyRelaySettings 真的传了 pairing', () => {
  it('@core:relay 服务启动后，不带签名的请求被 403 拒绝（说明鉴权生效）', async () => {
    state.relayEnabled = true
    const { applyRelaySettings } = await import('../../src/relay')
    const r = await applyRelaySettings()
    expect(r.listening).toBe(true)

    const res = await fetch(`http://127.0.0.1:${r.port}/relay/session:list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({})
    })
    // 没传 pairing 时这里会是 200/500（走到分发），传了 pairing 才会 403
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('DEVICE_REVOKED')
  })

  it('@core:relay 重启后（再次 applyRelaySettings）桌面公钥不变，已配对设备无需重配', async () => {
    state.relayEnabled = true
    const { applyRelaySettings, shutdownRelay } = await import('../../src/relay')

    await applyRelaySettings()
    const { loadOrCreateKey } = await import('../../src/relay/keystore')
    const { safeStorage } = await import('electron')
    const before = loadOrCreateKey({ dataDir: state.dataDir, safeStorage })

    await shutdownRelay()
    await applyRelaySettings()
    const after = loadOrCreateKey({ dataDir: state.dataDir, safeStorage })

    expect(after.restored).toBe(true)
    expect(after.publicKey).toBe(before.publicKey)
  })
})

/**
 * 接线验证：applyRelaySettings 真的起了局域网直连那一套。
 *
 * 为什么必须有这组：写 DirectChannel 的 20 项测试全绿，不等于生产环境里有它。
 * 把 `index.ts` 里 `await startLanStack(...)` 那一行注释掉，
 * 上面所有测试仍然全过 —— 又是 B3 第一批「忘了传 pairing」的同一种失败模式：
 * 组件写得对、测得好，但没人调用。
 *
 * 这里走真实入口，只断言「外部可观测的事实」：
 * 开启后 LAN 端口非空且能连上；关闭后端口必须消失。
 */
describe('applyRelaySettings 真的起了局域网直连', () => {
  it('@core:relay 开启后 lanPort() 返回真实端口，且该端口可连', async () => {
    state.relayEnabled = true
    const { applyRelaySettings, lanPort } = await import('../../src/relay')
    await applyRelaySettings()

    const port = lanPort()
    expect(port).toBeGreaterThan(0)
    // 真的在监听：TCP 能连上（TLS 握手失败是正常的，这里只验证端口活着）
    expect(await canConnect(port as number)).toBe(true)
  })

  it('@core:relay 开启后 channelView() 有值（UI 才有 chip 可显示）', async () => {
    state.relayEnabled = true
    const { applyRelaySettings, channelView } = await import('../../src/relay')
    await applyRelaySettings()

    const view = channelView()
    expect(view).not.toBeNull()
    // 没有手机连上来，所以不可能是 'lan' —— 这正是 probe() 语义要的诚实结果
    expect(view?.tier).not.toBe('lan')
    expect(typeof view?.chip).toBe('string')
  })

  it('@core:relay 关闭后 lanPort() 为 null 且端口真的断开', async () => {
    state.relayEnabled = true
    const { applyRelaySettings, lanPort } = await import('../../src/relay')
    await applyRelaySettings()
    const port = lanPort() as number
    expect(await canConnect(port)).toBe(true)

    state.relayEnabled = false
    await applyRelaySettings()
    expect(lanPort()).toBeNull()
    expect(await canConnect(port)).toBe(false)
  })

  it('@core:relay shutdownRelay 后 lanPort() 为 null（不留后台监听）', async () => {
    state.relayEnabled = true
    const { applyRelaySettings, shutdownRelay, lanPort } = await import('../../src/relay')
    await applyRelaySettings()
    const port = lanPort() as number

    await shutdownRelay()
    expect(lanPort()).toBeNull()
    expect(await canConnect(port)).toBe(false)
  })
})