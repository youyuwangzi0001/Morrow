/**
 * R10-K3 computer-use 安全验收（零真实鼠标/键盘操作）。
 *
 * 只验证：权限决策（read-only deny；ask/auto 均 ask）、平台守卫、参数校验/频率限制基础、
 * 工具定义与敏感动作标注；不执行真实点击/输入/截图（避免影响桌面）。
 *
 * 命令：npx vitest run --config tests/audit/vitest.config.ts tests/audit/r10/computer-use.test.ts
 */
import { describe, expect, it } from 'vitest'
import { evaluatePermission, type PermissionPolicyContext } from '../../../src/core/permissions'
import { COMPUTER_TOOL_NAMES, COMPUTER_LIMITS, createComputerTools } from '../../../src/core/tools/computer-tools'
import { makeAuditDir, makeToolCtx } from '../helpers'
import { join } from 'node:path'

const TOOLS = ['computer_screenshot', 'computer_click', 'computer_type', 'computer_key']

function policy(mode: 'read-only' | 'ask' | 'auto'): PermissionPolicyContext {
  return { mode, workspace: makeAuditDir('r10-computer'), isSubagent: false, isDemo: false, sessionGrants: new Set<string>() }
}

describe('R10-K3 computer-use 安全', () => {
  it('四个工具均登记为高风险外部动作', () => {
    expect([...COMPUTER_TOOL_NAMES].sort()).toEqual([...TOOLS].sort())
    const tools = createComputerTools({ platform: 'win32', runPowerShell: async () => ({ ok: false, stdout: '', stderr: 'not executed' }) })
    for (const tool of tools) {
      expect(tool.definition.name).toMatch(/^computer_/)
      expect(tool.definition.category).toBe('exec')
      expect(tool.definition.risk).toBe('high')
    }
  })

  it('read-only 拒绝；ask 与 auto 都必须 ask（逐次审批）', () => {
    for (const toolName of TOOLS) {
      const target = {
        toolName,
        category: 'exec' as const,
        baseRisk: 'high' as const,
        input: toolName === 'computer_click' ? { x: 10, y: 10 } : { text: 'R10' },
        title: toolName
      }
      expect(evaluatePermission(target, policy('read-only')).action, `${toolName} read-only`).toBe('deny')
      expect(evaluatePermission(target, policy('ask')).action, `${toolName} ask`).toBe('ask')
      expect(evaluatePermission(target, policy('auto')).action, `${toolName} auto`).toBe('ask')
    }
  })

  it('非 Windows 平台守卫：不执行任何真实操作', async () => {
    let called = 0
    const tools = createComputerTools({
      platform: 'linux',
      runPowerShell: async () => {
        called += 1
        return { ok: true, stdout: '', stderr: '' }
      }
    })
    const tool = tools.find((item) => item.definition.name === 'computer_click')!
    const ctx = makeToolCtx(makeAuditDir('r10-computer-linux'), join(makeAuditDir('r10-computer-linux'), 'snapshots'), { permissionMode: 'ask' })
    const result = await tool.execute({ x: 10, y: 10 }, ctx)
    expect(result.ok).toBe(false)
    expect(String(result.error ?? '') + String(result.output ?? '')).toContain('Windows')
    expect(called).toBe(0)
  })

  it('参数校验：负数/小数坐标、超长文本在触碰桌面之前被拒绝', async () => {
    let called = 0
    const tools = createComputerTools({
      platform: 'win32',
      runPowerShell: async () => {
        called += 1
        return { ok: true, stdout: '', stderr: '' }
      }
    })
    const ctx = makeToolCtx(makeAuditDir('r10-computer-args'), join(makeAuditDir('r10-computer-args'), 'snapshots'), { permissionMode: 'ask' })
    const click = tools.find((item) => item.definition.name === 'computer_click')!
    for (const input of [{ x: -1, y: 10 }, { x: 1.5, y: 10 }, { x: 999999, y: 10 }]) {
      const result = await click.execute(input, ctx)
      expect(result.ok, JSON.stringify(input)).toBe(false)
    }
    const type = tools.find((item) => item.definition.name === 'computer_type')!
    const long = await type.execute({ text: 'x'.repeat(COMPUTER_LIMITS.maxTextLength + 1) }, ctx)
    expect(long.ok).toBe(false)
    expect(called).toBe(0)
  })

  it('read-only ToolContext 直接拒绝（不依赖审批层）', async () => {
    const tools = createComputerTools({ platform: 'win32', runPowerShell: async () => ({ ok: false, stdout: '', stderr: 'x' }) })
    const click = tools.find((item) => item.definition.name === 'computer_click')!
    const result = await click.execute({ x: 10, y: 10 }, makeToolCtx(makeAuditDir('r10-computer-ro'), join(makeAuditDir('r10-computer-ro'), 'snapshots'), { permissionMode: 'read-only', readOnly: true }))
    expect(result.ok).toBe(false)
    expect(String(result.error ?? '') + String(result.output ?? '')).toContain('只读')
  })
})
