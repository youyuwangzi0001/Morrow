/**
 * 「手机发消息 → 桌面真起一轮任务」的端到端测试。
 *
 * 守的是用户追加的那条要求：远程控制中心不能只是「能发文字」，
 * 发出去必须真的在桌面启动一轮 agent，并把这一轮的进展推回手机。
 *
 * 这里刻意**不打桩 AgentService**：用真实的 `AgentService.send()`，
 * 只把 Provider 换成仓库自带的 `demo` 实现（按脚本产出 thinking / text /
 * 工具调用，不需要联网、不需要 API Key）。于是断言的是真链路：
 *
 *   dispatchPhoneInvoke('message.send')
 *     → agent.send() 起一轮
 *     → agent.forward() 里的 toPhoneEvent() 裁剪
 *     → publishPhoneEvent() 把手机要看的形状交给通道
 *
 * 最后一跳正是生产里 relay 通道接的那个发布器，所以「手机能不能够得着这一轮」
 * 与生产的形状完全一致，不是另写一份。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
import { demoWorkspacePath } from '../../src/main/workspace'
import {
  dispatchPhoneInvoke,
  setPhoneInvokeHandler,
  setPhonePublisher,
  setPhoneSnapshotProvider
} from '../../src/main/relay-phone'

const DEMO_PROVIDER: ProviderConfig = {
  id: 'demo',
  kind: 'demo',
  name: '演示引擎',
  baseUrl: '',
  models: [{ id: 'demo-model', label: 'Demo', contextWindow: 128_000, supportsTools: true }],
  apiKeyStored: true,
  enabled: true,
  isBuiltin: true,
  category: 'local'
}

/** 手机实际收到的下行事件（经 toPhoneEvent 裁剪后的形状）。 */
type PhoneFrame = Record<string, unknown> & { type: string }

interface Harness {
  service: AgentService
  sessionId: string
  frames: PhoneFrame[]
  cleanup: () => void
}

function setup(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'morrow-phone-send-'))
  electronState.dataDir = dataDir
  electronState.notifications = []
  configurePermissionRulesRuntime(dataDir)
  const settings = new SettingsStore()
  settings.saveProvider(DEMO_PROVIDER, 'demo-key')
  const store = new SessionStore(dataDir)
  // 演示 Provider 只允许在 Morrow 的演示工作区里跑（agent.ts:3359 的硬约束），
  // 会话工作区必须指向那里，否则一轮会在启动前被拒 —— 这与「手机能不能发」无关。
  mkdirSync(demoWorkspacePath(), { recursive: true })
  const session = store.create({
    workspace: demoWorkspacePath(),
    model: { providerId: DEMO_PROVIDER.id, modelId: 'demo-model' },
    permissionMode: 'auto',
    defaultModel: { providerId: DEMO_PROVIDER.id, modelId: 'demo-model' },
    defaultPermission: 'auto',
    title: '手机下发的任务'
  })
  const frames: PhoneFrame[] = []
  // 生产里 relay.ts 用 setPhonePublisher 注册 LAN 通道；这里换成收集器，
  // 收到的东西与手机上解析的是同一份 JSON。
  setPhonePublisher((event) => frames.push(event as PhoneFrame))
  const service = new AgentService(settings, store)
  return {
    service,
    sessionId: session.id,
    frames,
    cleanup: () => {
      try {
        service.cancel(session.id)
      } catch {
        // 取消失败不影响断言
      }
      try {
        rmSync(dataDir, { recursive: true, force: true })
      } catch {
        // 临时目录清理失败不影响断言
      }
    }
  }
}

let harness: Harness | null = null

beforeEach(() => {
  harness = setup()
})

afterEach(() => {
  harness?.cleanup()
  harness = null
  setPhoneInvokeHandler(null)
  setPhonePublisher(null)
  setPhoneSnapshotProvider(null)
})

/** 等到 predicate 成立或超时。返回 false = 超时（测试据此给出可读失败）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

describe('手机发消息真的启动桌面一轮', () => {
  it('@core:relay message.send 返回真 runId，手机随后收到这一轮的完整形状', async () => {
    const h = harness!
    // 与 ipc.ts 的 message.send 分支逐句一致；差别只有 AgentService 的实例来源。
    setPhoneInvokeHandler(async (request) => {
      if (request.method !== 'message.send') {
        return { ok: false, error: { code: 'unsupported', message: '测试只接一条' } }
      }
      try {
        const sent = await h.service.send(
          { sessionId: String(request.params.sessionId), text: String(request.params.text) },
          null
        )
        return { ok: true as const, result: { runId: sent.runId, assistantMessageId: sent.assistantMessageId } }
      } catch (err) {
        return { ok: false as const, error: { code: 'failed', message: err instanceof Error ? err.message : String(err) } }
      }
    })

    const result = await dispatchPhoneInvoke({
      id: 'req-1',
      method: 'message.send',
      params: { sessionId: h.sessionId, text: '把 Q3 销售明细做成复盘' }
    })

    // ① 上行受理：回的是真 runId，不是 ok:true 了事
    expect(result.ok).toBe(true)
    const runId = (result.result as Record<string, unknown>).runId as string
    expect(typeof runId).toBe('string')
    expect(runId.length).toBeGreaterThan(0)
    expect((result.result as Record<string, unknown>).assistantMessageId).toBeTruthy()

    // ② 桌面真的起了这一轮：run_started 带着同一个 runId，且用户消息原文到得了手机
    expect(await waitFor(() => h.frames.some((f) => f.type === 'run_started'))).toBe(true)
    const started = h.frames.find((f) => f.type === 'run_started')!
    expect(started.runId).toBe(runId)
    expect(started.sessionId).toBe(h.sessionId)
    const userMessage = started.userMessage as Record<string, unknown>
    expect(userMessage.text).toBe('把 Q3 销售明细做成复盘')

    // ③ 中间有真实的流式输出（不是空跑一轮）
    expect(await waitFor(() => h.frames.some((f) => f.type === 'message_delta'), 30_000)).toBe(true)

    // ④ 这一轮跑到结束，而且成功
    expect(await waitFor(() => h.frames.some((f) => f.type === 'run_finished'), 90_000)).toBe(true)
    const finished = h.frames.find((f) => f.type === 'run_finished')!
    expect(finished.reason).toBe('complete')

    // ⑤ 收尾时手机拿得到最终助手消息（带结构化块，diff/表格才有数据可画）
    const completed = h.frames.filter((f) => f.type === 'message_completed')
    expect(completed.length).toBeGreaterThan(0)
    const assistant = completed[completed.length - 1]!.message as Record<string, unknown>
    expect(typeof assistant.text).toBe('string')
    expect(Array.isArray(assistant.blocks)).toBe(true)
    expect((assistant.blocks as unknown[]).length).toBeGreaterThan(0)
  }, 150_000)

  it('@core:relay 会话不存在时回失败，且不会凭空起一轮', async () => {
    const h = harness!
    setPhoneInvokeHandler(async (request) => {
      try {
        await h.service.send(
          { sessionId: String(request.params.sessionId), text: String(request.params.text) },
          null
        )
        return { ok: true as const, result: {} }
      } catch (err) {
        return { ok: false as const, error: { code: 'failed', message: err instanceof Error ? err.message : String(err) } }
      }
    })

    const result = await dispatchPhoneInvoke({
      id: 'req-2',
      method: 'message.send',
      params: { sessionId: 'no-such-session', text: '你好' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('会话不存在')
    // 「失败」必须是真的没起：给一点时间让任何迟到的 run_started 现身
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(h.frames.some((f) => f.type === 'run_started')).toBe(false)
  }, 30_000)
})



