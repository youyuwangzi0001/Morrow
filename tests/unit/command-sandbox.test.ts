import { describe, expect, it } from 'vitest'
import { buildSandboxLaunch } from '../../src/core/tool-media'
import { CommandSandboxService } from '../../src/main/sandbox'

describe('command-sandbox.test.ts', () => {
  it('@core:terminal 沙箱命令使用 Docker、只挂载工作区并默认断网', () => {
    const launch = buildSandboxLaunch('npm test', 'C:\\work\\demo', 'C:\\work\\demo\\src', 'node:22-bookworm')
    expect(launch.file).toBe('docker')
    expect(launch.detached).toBe(false)
    expect(launch.args).toContain('--network')
    expect(launch.args[launch.args.indexOf('--network') + 1]).toBe('none')
    expect(launch.args).toContain('--security-opt')
    expect(launch.args).toContain('no-new-privileges')
    expect(launch.args).toContain('--cap-drop')
    expect(launch.args).toContain('ALL')
    expect(launch.args).toContain('C:\\work\\demo:/workspace')
    expect(launch.args[launch.args.indexOf('-w') + 1]).toBe('/workspace/src')
    expect(launch.args).toContain('node:22-bookworm')
    expect(launch.args.slice(-3)).toEqual(['sh', '-lc', 'npm test'])
  })

  it('@core:terminal 工作区根目录和子目录都映射到容器内对应路径', () => {
    const root = buildSandboxLaunch('ls', '/home/me/project', '/home/me/project', 'image')
    expect(root.args[root.args.indexOf('-w') + 1]).toBe('/workspace')
    const nested = buildSandboxLaunch('ls', '/home/me/project', '/home/me/project/a/b', 'image')
    expect(nested.args[nested.args.indexOf('-w') + 1]).toBe('/workspace/a/b')
  })

  it('@core:terminal 沙箱被环境变量关闭时如实返回不可用原因', () => {
    const previous = process.env.MORROW_DISABLE_SANDBOX
    process.env.MORROW_DISABLE_SANDBOX = '1'
    try {
      const status = new CommandSandboxService().status()
      expect(status.available).toBe(false)
      expect(status.reason).toContain('MORROW_DISABLE_SANDBOX')
      expect(status.image).toBeTruthy()
    } finally {
      if (previous === undefined) delete process.env.MORROW_DISABLE_SANDBOX
      else process.env.MORROW_DISABLE_SANDBOX = previous
    }
  })
})
