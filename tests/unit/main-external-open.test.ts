import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  writeText: vi.fn(),
  execFile: vi.fn(),
  openLoginWindow: vi.fn()
}))

vi.mock('electron', () => ({
  shell: { openExternal: mocks.openExternal },
  clipboard: { writeText: mocks.writeText }
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: mocks.execFile }
})

import { openExternalUrl, openLoginUrl, loginPermissionAllowed } from '../../src/main/workspace'

describe('openExternalUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.MORROW_TEST
  })

  it('@core:interface 优先用 Electron shell 打开外部链接', async () => {
    mocks.openExternal.mockResolvedValue(undefined)
    const result = await openExternalUrl('https://example.com/login?x=1')
    expect(result).toEqual({ opened: true, copied: false })
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/login?x=1')
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('@core:interface shell 失败时回退系统处理器，仍失败则复制链接', async () => {
    mocks.openExternal.mockRejectedValue(new Error('no browser'))
    mocks.execFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void
      callback(new Error('rundll32 failed'))
    })
    const result = await openExternalUrl('https://example.com/login?x=1')
    expect(result).toEqual({ opened: false, copied: true })
    if (process.platform === 'win32') {
      const [file, args, options] = mocks.execFile.mock.calls[0] as [string, string[], Record<string, unknown>]
      expect(file).toBe('rundll32.exe')
      expect(args).toEqual(['url.dll,FileProtocolHandler', 'https://example.com/login?x=1'])
      expect(options).toEqual(expect.objectContaining({ windowsHide: true }))
    }
    expect(mocks.writeText).toHaveBeenCalledWith('https://example.com/login?x=1')
  })
})

describe('openLoginUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openLoginWindow.mockReset()
    delete process.env.MORROW_TEST
  })

  it('@core:interface 测试模式只复制登录链接', async () => {
    process.env.MORROW_TEST = '1'
    const result = await openLoginUrl('https://auth.openai.com/oauth/authorize?x=1')
    expect(result).toEqual({ opened: false, copied: true })
    expect(mocks.writeText).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?x=1')
    expect(mocks.openLoginWindow).not.toHaveBeenCalled()
  })

  it('@core:interface 登录页只向可信 HTTPS 来源放行本机回环授权', () => {
    const trusted = new Set(['https://commandcode.ai'])
    for (const permission of ['local-network', 'local-network-access', 'loopback-network']) {
      expect(loginPermissionAllowed(permission, 'https://commandcode.ai/studio/auth/cli', trusted)).toBe(true)
    }
    expect(loginPermissionAllowed('clipboard-sanitized-write', 'https://commandcode.ai/', trusted)).toBe(true)
    expect(loginPermissionAllowed('storage-access', 'https://commandcode.ai/', trusted)).toBe(true)
    expect(loginPermissionAllowed('local-network-access', 'http://commandcode.ai/', trusted)).toBe(false)
    expect(loginPermissionAllowed('local-network-access', 'https://evil.example/', trusted)).toBe(false)
    expect(loginPermissionAllowed('camera', 'https://commandcode.ai/', trusted)).toBe(false)
    expect(loginPermissionAllowed('local-network-access', 'not-a-url', trusted)).toBe(false)
  })
})
