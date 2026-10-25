import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  writeText: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  existsSync: vi.fn()
}))

vi.mock('electron', () => ({
  shell: { openExternal: mocks.openExternal },
  clipboard: { writeText: mocks.writeText }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: mocks.existsSync }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: mocks.execFile,
    execFileSync: mocks.execFileSync,
    spawn: mocks.spawn
  }
})

import { openExternalUrl, openLoginUrl } from '../../../src/main/services/external-open'

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

  it.skipIf(process.platform !== 'win32')('登录优先使用 cmd /c start 打开系统默认浏览器', async () => {
    mocks.execFileSync.mockReturnValue('ProgId REG_SZ MSEdgeHTM')
    mocks.existsSync.mockReturnValue(true)
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void }
      child.unref = vi.fn()
      process.nextTick(() => child.emit('spawn'))
      return child
    })
    const result = await openLoginUrl('https://example.com/auth?x=1')
    expect(result).toEqual({ opened: true, copied: true })
    expect(mocks.openExternal).not.toHaveBeenCalled()
    const [exe, args] = mocks.spawn.mock.calls[0] as [string, string[]]
    expect(exe.toLowerCase()).toContain('cmd.exe')
    expect(args).toEqual(['/c', 'start', '""', '"https://example.com/auth?x=1"'])
    expect(mocks.writeText).toHaveBeenCalledWith('https://example.com/auth?x=1')
  })

  it.skipIf(process.platform !== 'win32')('cmd start 无法启动时回退到独立浏览器配置', async () => {
    mocks.execFileSync.mockReturnValue('ProgId REG_SZ MSEdgeHTM')
    mocks.existsSync.mockReturnValue(true)
    mocks.spawn
      .mockImplementationOnce(() => {
        const child = new EventEmitter() as EventEmitter & { unref: () => void }
        child.unref = vi.fn()
        process.nextTick(() => child.emit('error', new Error('no cmd')))
        return child
      })
      .mockImplementation(() => {
        const child = new EventEmitter() as EventEmitter & { unref: () => void }
        child.unref = vi.fn()
        process.nextTick(() => child.emit('spawn'))
        return child
      })
    const result = await openLoginUrl('https://example.com/auth?x=1')
    expect(result).toEqual({ opened: true, copied: true })
    const [exe, args] = mocks.spawn.mock.calls[1] as [string, string[]]
    expect(exe.toLowerCase()).toContain('msedge.exe')
    expect(args.some((arg) => arg.startsWith('--user-data-dir='))).toBe(true)
    expect(args).toContain('--new-window')
    expect(args.at(-1)).toBe('https://example.com/auth?x=1')
    expect(mocks.writeText).toHaveBeenCalledWith('https://example.com/auth?x=1')
  })
})
