/**
 * Relay 设置的归一化与默认值。
 *
 * ⚠️ 这份测试最初写成「复刻一遍归一化表达式再断言」的形式，结果做了反向验证才发现：
 * 把源码里的 `=== true` 改成 `Boolean(...)` 之后，测试**照样全绿** ——
 * 因为它测的是自己抄的一份逻辑，不是真实代码。这才是最危险的一类测试：
 * 看起来 4 项全过，其实一行源码都没验证。
 *
 * 现在改为实例化真实的 SettingsStore，并写入真实的 settings.json，
 * 让「旧配置升级」这条路径真的走一遍。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ dataDir: '', appData: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: (name: string) =>
      name === 'userData'
        ? electronState.dataDir
        : name === 'appData'
          ? electronState.appData
          : join(electronState.dataDir, name)
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    }
  },
  dialog: {},
  shell: {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

const dirs: string[] = []

async function storeWith(settings: Record<string, unknown> | null) {
  const { SettingsStore } = await import('../../src/main/settings')
  electronState.dataDir = mkdtempSync(join(tmpdir(), 'morrow-relay-settings-'))
  electronState.appData = mkdtempSync(join(tmpdir(), 'morrow-relay-appdata-'))
  dirs.push(electronState.dataDir, electronState.appData)
  if (settings) {
    writeFileSync(join(electronState.dataDir, 'settings.json'), JSON.stringify(settings), 'utf8')
  }
  return new SettingsStore()
}

beforeEach(() => {
  electronState.dataDir = ''
  electronState.appData = ''
})

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('relay 出厂默认', () => {
  it('@core:relay 首页启动（无 settings.json）时 relay 关闭且端口为 0', async () => {
    const s = await storeWith(null)
    const cur = s.get()
    expect(cur.relayEnabled).toBe(false)
    expect(cur.relayPort).toBe(0)
  })
})

describe('relay 旧配置升级（真实走一遍 settings.json 读取）', () => {
  it('@core:relay 旧配置缺 relayEnabled 字段时落到关闭', async () => {
    const s = await storeWith({ version: 1, theme: 'dark', fontSize: 14 })
    expect(s.get().relayEnabled).toBe(false)
  })

  it('@core:relay 只有布尔 true 才开启；字符串 "true"、数字 1 都不算', async () => {
    const truthy = await storeWith({ version: 1, relayEnabled: true })
    expect(truthy.get().relayEnabled).toBe(true)

    for (const tricky of ['true', 'false', 1, 0, {}, [], 'yes']) {
      const s = await storeWith({ version: 1, relayEnabled: tricky })
      expect(s.get().relayEnabled, `${JSON.stringify(tricky)} 不应开启`).toBe(false)
    }
  })

  it('@core:relay 端口收敛：合法值保留，非法值回落到 0', async () => {
    const ok = await storeWith({ version: 1, relayPort: 8787 })
    expect(ok.get().relayPort).toBe(8787)

    for (const bad of [65536, -1, 1.5, NaN, '8787', null]) {
      const s = await storeWith({ version: 1, relayPort: bad })
      expect(s.get().relayPort, `${String(bad)} 应回落`).toBe(0)
    }
  })
})

describe('relay 开关可持久化', () => {
  it('@core:relay 通过 update 打开后，重新读盘仍是开启', async () => {
    const s = await storeWith({ version: 1 })
    expect(s.get().relayEnabled).toBe(false)

    s.update({ relayEnabled: true, relayPort: 8899 })
    expect(s.get().relayEnabled).toBe(true)
    expect(s.get().relayPort).toBe(8899)

    // 落盘检查：文件里必须是布尔 true，不是字符串
    const raw = JSON.parse(readFileSync(join(electronState.dataDir, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(raw.relayEnabled).toBe(true)
    expect(existsSync(join(electronState.dataDir, 'settings.json'))).toBe(true)
  })
})