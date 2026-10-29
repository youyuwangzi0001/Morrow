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

import { openExternalUrl, openLoginUrl } from '../../src/main/workspace'

describe('openExternalUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.MORROW_TEST
  })

  it('优先用 Electron shell 打开外部链接', async () => {
    mocks.openExternal.mockResolvedValue(undefined)
    const result = await openExternalUrl('https://example.com/login?x=1')
    expect(result).toEqual({ opened: true, copied: false })
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/login?x=1')
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('shell 失败时回退系统处理器，仍失败则复制链接', async () => {
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

  it('测试模式只复制登录链接', async () => {
    process.env.MORROW_TEST = '1'
    const result = await openLoginUrl('https://auth.openai.com/oauth/authorize?x=1')
    expect(result).toEqual({ opened: false, copied: true })
    expect(mocks.writeText).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?x=1')
    expect(mocks.openLoginWindow).not.toHaveBeenCalled()
  })

it('内置窗口不可用时仍复制链接', async () => {
    mocks.openLoginWindow.mockReturnValue(false)
    const result = await openLoginUrl('https://auth.openai.com/oauth/authorize?x=1')
    expect(result).toEqual({ opened: false, copied: true })
    expect(mocks.writeText).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?x=1')
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
})
