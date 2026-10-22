/**
 * R12 终端一致性：
 * 设置里选中的默认终端必须真正用于 Agent 的 run_command（而不是永远 Windows PowerShell）。
 * 逐个验证 PowerShell 7 / Windows PowerShell / cmd / Git Bash 的语法与输出。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  getEvents,
  installEventCollector,
  sendMessageViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

// Git Bash 在当前 DSH 受限令牌下无法创建 MSYS 共享内存（0xC0000022），
// 其一次性命令与后台任务由 tests/unit/main/terminal.test.ts 在真实 Node 进程中覆盖。
const cases = [
  { id: 'pwsh', command: '$PSVersionTable.PSVersion.Major', expected: '7' },
  { id: 'powershell', command: '$PSVersionTable.PSVersion.Major', expected: '5' },
  { id: 'cmd', command: 'echo %OS%', expected: 'Windows_NT' }
]

test('Agent run_command 使用设置里选中的 PowerShell 7 / Windows PowerShell / cmd', async () => {
  test.setTimeout(240_000)
  const workspace = join(root, 'tmp', `e2e-r12-shell-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({ scripts: [{ text: '完成。' }] })
  const morrow = await launchMorrow({ name: 'r12-shell', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const profiles = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:terminal:profiles')
      return result.ok ? (result.data as { profiles: Array<{ id: string }> }).profiles.map((item) => item.id) : []
    })
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '终端一致性测试'
    })

    for (const item of cases) {
      if (!profiles.includes(item.id)) continue
      await page.evaluate(async (shell) => {
        await window.morrow.settings.update({ terminalShell: shell })
      }, item.id)
      mock.reset([
        { text: `检查 ${item.id}`, toolCalls: [{ name: 'run_command', arguments: { command: item.command } }] },
        { text: '完成。' }
      ])
      await installEventCollector(page)
      await sendMessageViaStore(page, `只运行这一条终端检查：${item.command}`)
      await waitForRunFinished(page, 60_000)
      const event = (await getEvents(page))
        .filter((entry) => entry.type === 'tool_finished')
        .at(-1) as
        | { toolUseId?: string; result?: { ok?: boolean; output?: string; meta?: Record<string, unknown> } }
        | undefined
      if (!event?.result?.ok) console.log('SHELL FAIL', item.id, event?.result?.output)
      expect(event?.result?.ok, `${item.id} 命令失败`).toBe(true)
      expect(String(event?.result?.output ?? '')).toContain(item.expected)
      expect(event?.result?.meta).toMatchObject({ shellId: item.id })
    }
  } finally {
    await morrow.close()
    await mock.close()
  }
})
