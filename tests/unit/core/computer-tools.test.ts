/**
 * R10-K3 受控 computer-use 单测：
 * - 权限：read-only 拒绝、ask/auto 均逐次询问（外部动作，不复用 always）；
 * - Windows 平台守卫、参数/坐标/文本/按键白名单校验、频率限制；
 * - 敏感前台窗口拒绝；截图用注入 runtime 生成文件，不触碰真实鼠标键盘。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PermissionPolicyContext, PermissionTarget } from '../../../src/core/permissions'
import { evaluatePermission } from '../../../src/core/permissions'
import {
  COMPUTER_LIMITS,
  COMPUTER_TOOL_DEFINITIONS,
  COMPUTER_TOOL_NAMES,
  createComputerTools,
  isSensitiveWindow,
  parseKeySequence,
  validateClickInput,
  validateTypeInput,
  type PowerShellResult
} from '../../../src/core/tools/computer-tools'
import { makeToolContext } from './helpers/tool-context'
import { makeTempWorkspace } from './helpers/workspace'

function permissionPolicy(workspace: string, mode: PermissionPolicyContext['mode']): PermissionPolicyContext {
  return { mode, workspace, isDemo: false, sessionGrants: new Set() }
}

function definition(name: string) {
  const found = COMPUTER_TOOL_DEFINITIONS.find((item) => item.name === name)
  if (!found) throw new Error(`missing ${name}`)
  return found
}

function permissionTarget(name: string, input: Record<string, unknown>): PermissionTarget {
  const def = definition(name)
  return { toolName: def.name, category: def.category, baseRisk: def.risk, input, title: def.titleFor(input) }
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])

interface FakeRunner {
  runner: (script: string, options: { signal: AbortSignal; timeoutMs: number }) => Promise<PowerShellResult>
  calls: string[]
}

function fakeRunner(options: { foreground?: { hwnd: number; title: string; processName: string }; screenshotSize?: string; failClick?: boolean } = {}): FakeRunner {
  const calls: string[] = []
  const foreground = options.foreground ?? { hwnd: 4242, title: '记事本 - 未命名', processName: 'notepad' }
  return {
    calls,
    runner: async (script) => {
      calls.push(script)
      const isClickAction = script.includes('mouse_event(0x0002')
      const isScreenshotAction = script.includes('Bitmap')
      if (script.includes('GetWindowText') && !isScreenshotAction && !isClickAction && !script.includes('MorrowInput') && !script.includes('keybd_event([byte]')) {
        return { ok: true, stdout: `${foreground.hwnd}|${foreground.title}|${foreground.processName}`, stderr: '', exitCode: 0 }
      }
      if (isScreenshotAction) {
        const match = /Save\('([^']+)'/.exec(script)
        if (match) {
          writeFileSync(match[1], PNG_BYTES)
        }
        return { ok: true, stdout: options.screenshotSize ?? '800|600', stderr: '', exitCode: 0 }
      }
      if (isClickAction) {
        return options.failClick
          ? { ok: false, stdout: '', stderr: '坐标超出当前前台窗口范围（窗口 1024x768）。', exitCode: 1 }
          : { ok: true, stdout: 'OK', stderr: '', exitCode: 0 }
      }
      return { ok: true, stdout: 'OK', stderr: '', exitCode: 0 }
    }
  }
}

describe('computer-use 权限：read-only 拒绝，ask/auto 均逐次审批', () => {
  it('四个工具都已登记为必问的外部动作', () => {
    expect([...COMPUTER_TOOL_NAMES]).toEqual(['computer_screenshot', 'computer_click', 'computer_type', 'computer_key'])
    const ws = makeTempWorkspace()
    try {
      for (const name of COMPUTER_TOOL_NAMES) {
        const auto = evaluatePermission(permissionTarget(name, { x: 1, y: 2, text: 'a', keys: 'ENTER' }), permissionPolicy(ws.root, 'auto'))
        expect(auto.action).toBe('ask')
        if (auto.action === 'ask') expect(auto.risk).toBe('high')

        const ask = evaluatePermission(permissionTarget(name, { x: 1, y: 2, text: 'a', keys: 'ENTER' }), permissionPolicy(ws.root, 'ask'))
        expect(ask.action).toBe('ask')

        const readonly = evaluatePermission(
          permissionTarget(name, { x: 1, y: 2, text: 'a', keys: 'ENTER' }),
          permissionPolicy(ws.root, 'read-only')
        )
        expect(readonly.action).toBe('deny')
      }
      // 即使会话里已有「始终允许」签名，外部动作仍然每次 ask
      const ctx = permissionPolicy(ws.root, 'auto')
      const first = evaluatePermission(permissionTarget('computer_click', { x: 1, y: 2 }), ctx)
      if (first.action === 'ask') ctx.sessionGrants = new Set([first.signature])
      expect(evaluatePermission(permissionTarget('computer_click', { x: 1, y: 2 }), ctx).action).toBe('ask')
    } finally {
      ws.cleanup()
    }
  })

  it('工具执行层防御：read-only 与演示模式直接拒绝', async () => {
    const ws = makeTempWorkspace()
    try {
      const tools = createComputerTools({ platform: 'win32', runPowerShell: fakeRunner().runner })
      const click = tools.find((tool) => tool.definition.name === 'computer_click')
      expect(click).toBeTruthy()
      const readonlyCtx = makeToolContext(ws, { permissionMode: 'read-only' })
      const denied = await click!.execute({ x: 1, y: 2 }, readonlyCtx)
      expect(denied.ok).toBe(false)
      expect(String(denied.error)).toContain('只读')
      const demoCtx = makeToolContext(ws, { permissionMode: 'auto', demo: true })
      const demoDenied = await click!.execute({ x: 1, y: 2 }, demoCtx)
      expect(demoDenied.ok).toBe(false)
      expect(String(demoDenied.error)).toContain('演示模式')
    } finally {
      ws.cleanup()
    }
  })
})

describe('Windows 守卫与参数校验', () => {
  it('非 Windows 平台返回可读错误，不执行脚本', async () => {
    const ws = makeTempWorkspace()
    try {
      const fake = fakeRunner()
      const tools = createComputerTools({ platform: 'darwin', runPowerShell: fake.runner })
      const screenshot = tools.find((tool) => tool.definition.name === 'computer_screenshot')!
      const result = await screenshot.execute({}, makeToolContext(ws, { permissionMode: 'auto' }))
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain('Windows')
      expect(fake.calls).toHaveLength(0)
    } finally {
      ws.cleanup()
    }
  })

  it('坐标/文本/按键参数校验（含中文与换行）', () => {
    expect(typeof validateClickInput({ x: -1, y: 0 })).toBe('string')
    expect(typeof validateClickInput({ x: 1.5, y: 0 })).toBe('string')
    expect(typeof validateClickInput({ x: COMPUTER_LIMITS.maxCoordinate + 1, y: 0 })).toBe('string')
    expect(validateClickInput({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 })

    expect(validateTypeInput({ text: '' }).ok).toBe(false)
    expect(validateTypeInput({ text: 'a'.repeat(COMPUTER_LIMITS.maxTextLength + 1) }).ok).toBe(false)
    expect(validateTypeInput({ text: '第一行\n第二行' }).ok).toBe(false)
    expect(validateTypeInput({ text: '你好，Morrow' })).toEqual({ ok: true, text: '你好，Morrow' })
    // 合法文本即使以旧实现的错误提示前缀开头，也必须通过
    expect(validateTypeInput({ text: '要输入的文字不能为空，这是一句正常的话' })).toEqual({
      ok: true,
      text: '要输入的文字不能为空，这是一句正常的话'
    })

    expect(parseKeySequence('ENTER')).toEqual([0x0d])
    expect(parseKeySequence('ctrl+a')).toEqual([0x11, 0x41])
    expect(parseKeySequence('SHIFT+TAB')).toEqual([0x10, 0x09])
    expect(parseKeySequence('CTRL+SHIFT+A')).toEqual([0x11, 0x10, 0x41])
    expect(typeof parseKeySequence('F4')).toBe('string')
    expect(typeof parseKeySequence('CTRL+ALT+DELETE')).toBe('string')
    expect(typeof parseKeySequence('SHIFT+DELETE')).toBe('string')
    expect(typeof parseKeySequence('CTRL+DELETE')).toBe('string')
    expect(typeof parseKeySequence('CTRL+SHIFT+ESC')).toBe('string')
    expect(typeof parseKeySequence('')).toBe('string')
  })

  it('按键/文本过长/坐标越界在工具层返回失败', async () => {
    const ws = makeTempWorkspace()
    try {
      const fake = fakeRunner()
      const tools = createComputerTools({ platform: 'win32', runPowerShell: fake.runner, minIntervalMs: { computer_click: 0, computer_type: 0, computer_key: 0 } })
      const ctx = makeToolContext(ws, { permissionMode: 'auto' })
      const click = tools.find((tool) => tool.definition.name === 'computer_click')!
      const badClick = await click.execute({ x: -5, y: 0 }, ctx)
      expect(badClick.ok).toBe(false)
      const type = tools.find((tool) => tool.definition.name === 'computer_type')!
      const badText = await type.execute({ text: 'a'.repeat(COMPUTER_LIMITS.maxTextLength + 1) }, ctx)
      expect(badText.ok).toBe(false)
      expect(String(badText.error)).toContain('过长')
      const key = tools.find((tool) => tool.definition.name === 'computer_key')!
      const badKey = await key.execute({ keys: 'ALT+F4' }, ctx)
      expect(badKey.ok).toBe(false)
    } finally {
      ws.cleanup()
    }
  })
})

describe('敏感窗口与截图', () => {
  it('敏感窗口（银行/密码/设置）拒绝操作', async () => {
    const ws = makeTempWorkspace()
    try {
      const fake = fakeRunner({ foreground: { hwnd: 99, title: '招商银行 - 支付确认', processName: 'chrome' } })
      const tools = createComputerTools({ platform: 'win32', runPowerShell: fake.runner })
      const click = tools.find((tool) => tool.definition.name === 'computer_click')!
      const result = await click.execute({ x: 10, y: 10 }, makeToolContext(ws, { permissionMode: 'auto' }))
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain('敏感')
      // 只调用了读取前台窗口，没有执行点击脚本
      expect(fake.calls.every((script) => !script.includes('mouse_event(0x0002'))).toBe(true)
      expect(isSensitiveWindow('请输入密码', 'app')).toBe(true)
      expect(isSensitiveWindow('记事本', 'notepad')).toBe(false)
      expect(isSensitiveWindow('Settings', 'SystemSettings')).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('截图成功：保存 PNG、注册画布 artifact、返回尺寸/窗口', async () => {
    const ws = makeTempWorkspace()
    try {
      const fake = fakeRunner()
      const tools = createComputerTools({ platform: 'win32', runPowerShell: fake.runner })
      const screenshot = tools.find((tool) => tool.definition.name === 'computer_screenshot')!
      const ctx = makeToolContext(ws, { permissionMode: 'auto' })
      const result = await screenshot.execute({ path: 'out/shot.png' }, ctx)
      expect(result.ok).toBe(true)
      expect(existsSync(join(ws.root, 'out/shot.png'))).toBe(true)
      const meta = result.meta as Record<string, unknown>
      expect(meta.width).toBe(800)
      expect(meta.height).toBe(600)
      expect(ctx.getArtifacts().some((artifact) => artifact.kind === 'file' && artifact.path === join(ws.root, 'out/shot.png'))).toBe(true)
      expect(String(result.output)).toContain('已截取')
      // 高 DPI 缩放下先启用 DPI 感知，避免截图/坐标按逻辑像素错位
      expect(fake.calls.some((script) => script.includes('Bitmap') && script.includes('EnableDpiAwareness'))).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('频率限制：连续点击过快会被拒绝', async () => {
    const ws = makeTempWorkspace()
    try {
      let now = 1000
      const fake = fakeRunner()
      const tools = createComputerTools({
        platform: 'win32',
        runPowerShell: fake.runner,
        now: () => now,
        minIntervalMs: { computer_click: 300 }
      })
      const click = tools.find((tool) => tool.definition.name === 'computer_click')!
      const ctx = makeToolContext(ws, { permissionMode: 'auto' })
      const first = await click.execute({ x: 1, y: 2 }, ctx)
      expect(first.ok).toBe(true)
      now += 50
      const second = await click.execute({ x: 3, y: 4 }, ctx)
      expect(second.ok).toBe(false)
      expect(String(second.error)).toContain('频繁')
      now += 400
      const third = await click.execute({ x: 5, y: 6 }, ctx)
      expect(third.ok).toBe(true)
      expect(fake.calls.some((script) => script.includes('mouse_event(0x0002') && script.includes('EnableDpiAwareness'))).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('PowerShell 失败返回可读错误', async () => {
    const ws = makeTempWorkspace()
    try {
      const fake = fakeRunner({ failClick: true })
      const tools = createComputerTools({ platform: 'win32', runPowerShell: fake.runner })
      const click = tools.find((tool) => tool.definition.name === 'computer_click')!
      const result = await click.execute({ x: 999, y: 999 }, makeToolContext(ws, { permissionMode: 'auto' }))
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain('点击失败')
    } finally {
      ws.cleanup()
    }
  })
})
