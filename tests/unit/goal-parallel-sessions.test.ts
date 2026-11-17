/**
 * 目标模式与其他对话的并行边界。
 *
 * 用户遇到的问题：一个对话正在推进长期目标时，另开一个对话发送消息会被拦下，
 * 报「另一个对话的目标正在自动推进」。但普通对话本来就该能并行（运行中心、
 * 按会话隔离的 runs 都是为此设计的），被拦住的只有「再开第二个自动推进的目标」。
 *
 * 这里直接驱动真实的 AgentService：
 * - 目标会话正在推进时，另一个对话发送普通消息必须放行；
 * - 同一时间仍然不允许两个目标循环同时自动推进；
 * - 目标会话自身在推进时，仍然拒绝插入普通消息。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderConfig } from '../../src/shared/types'

const electronState = vi.hoisted(() => ({
  dataDir: '',
  notifications: [] as Array<{ title: string; body: string }>
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: (name: string) => (name === 'userData' ? electronState.dataDir : join(electronState.dataDir, name))
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
  Notification: class {
    static isSupported(): boolean {
      return false
    }
    constructor(options: { title: string; body: string }) {
      electronState.notifications.push(options)
    }
    on(): void {}
    show(): void {}
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return []
    }
    static fromWebContents(): null {
      return null
    }
  },
  dialog: {},
  shell: {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

import { AgentService } from '../../src/main/agent'
import { SessionStore } from '../../src/main/session'
import { SettingsStore } from '../../src/main/settings'
import { configurePermissionRulesRuntime } from '../../src/main/runtime'

const PROVIDER: ProviderConfig = {
  id: 'parallel-test',
  kind: 'openai-compat',
  name: '并行测试服务',
  baseUrl: 'http://127.0.0.1:1/v1',
  models: [{ id: 'parallel-model', label: 'Parallel', contextWindow: 128_000, supportsTools: true }],
  apiKeyStored: true,
  enabled: true,
  isBuiltin: false,
  category: 'custom'
}

interface Harness {
  service: AgentService
  store: SessionStore
  sessionId: string
  cleanup: () => void
}

function setup(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'morrow-parallel-'))
  electronState.dataDir = dataDir
  electronState.notifications = []
  configurePermissionRulesRuntime(dataDir)
  const settings = new SettingsStore()
  settings.saveProvider(PROVIDER, 'sk-parallel-test')
  const store = new SessionStore(dataDir)
  const session = store.create({
    workspace: dataDir,
    model: { providerId: PROVIDER.id, modelId: 'parallel-model' },
    permissionMode: 'auto',
    defaultModel: { providerId: PROVIDER.id, modelId: 'parallel-model' },
    defaultPermission: 'auto',
    title: '并行测试'
  })
  return {
    service: new AgentService(settings, store),
    store,
    sessionId: session.id,
    cleanup: () => {
      try {
        rmSync(dataDir, { recursive: true, force: true })
      } catch {
        // 临时目录清理失败不影响断言
      }
    }
  }
}

let harnesses: Harness[] = []

function newHarness(): Harness {
  const harness = setup()
  harnesses.push(harness)
  return harness
}

beforeEach(() => {
  harnesses = []
})

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.cleanup()
})

describe('目标模式下的并行会话', () => {
  it('@core:goals 目标会话推进时，另一个对话仍能发送普通消息', async () => {
    const h = newHarness()
    const target = h.store.get(h.sessionId)!
    // 模拟「另一个对话的目标正在自动推进」的内存状态
    ;(h.service as unknown as { goalLoops: Set<string> }).goalLoops.add(h.sessionId)

    const other = h.store.create({
      workspace: target.workspace,
      model: target.model,
      permissionMode: 'auto',
      defaultModel: target.model,
      defaultPermission: 'auto',
      title: '另一个对话'
    })

    // 关键断言：不再因为别的对话在推进目标而拒绝发送
    await expect(h.service.send({ sessionId: other.id, text: '帮我看看这份文件。' }, null)).resolves.toBeTruthy()
  })

  it('@core:goals 同一时间只允许一个目标自动推进，第二个目标仍然被拒绝', async () => {
    const h = newHarness()
    const target = h.store.get(h.sessionId)!
    ;(h.service as unknown as { goalLoops: Set<string> }).goalLoops.add(h.sessionId)

    const other = h.store.create({
      workspace: target.workspace,
      model: target.model,
      permissionMode: 'auto',
      defaultModel: target.model,
      defaultPermission: 'auto',
      title: '第二个目标'
    })

    await expect(h.service.startGoal(other.id, '再推进一个目标', 0, null)).rejects.toThrow(/目标正在自动推进/)
  })

  it('@core:goals 目标会话自身推进时不接受普通消息插入', async () => {
    const h = newHarness()
    ;(h.service as unknown as { goalLoops: Set<string> }).goalLoops.add(h.sessionId)

    await expect(h.service.send({ sessionId: h.sessionId, text: '插一句' }, null)).rejects.toThrow()
  })
})