import { describe, expect, it } from 'vitest'
import { DANGEROUS_ENGINE_ARGS, detectEngineKind, guardEngineArgs } from '../../src/shared/engine-args'

describe('C-03 引擎启动护栏', () => {
  it('@core:studio-media 危险参数被拒绝启动，并给出可执行替代方案（不是只说别用）', () => {
    // D-01 的真实触发参数
    const result = guardEngineArgs({
      binary: 'C:/AI/MorrowMedia/ComfyUI/.venv/Scripts/python.exe',
      args: ['main.py', '--listen', '127.0.0.1', '--port', '8188', '--use-split-cross-attention'],
      engine: 'comfyui'
    })
    expect(result.ok, '带 --use-split-cross-attention 必须拒绝启动').toBe(false)
    expect(result.blocked.map((item) => item.flag)).toEqual(['--use-split-cross-attention'])
    expect(result.message).toContain('已阻止启动')
    // 提示里必须写清原因与替代做法，用户才能自己改
    expect(result.message).toContain('210.48 GiB')
    expect(result.message).toContain('改用')
    expect(result.message).toContain('--lowvram')

    // 不带引擎类型提示时也要拦住（宁可多拦，也不能放过）
    const unknownEngine = guardEngineArgs({ binary: 'python.exe', args: ['main.py', '--use-split-cross-attention'] })
    expect(unknownEngine.ok).toBe(false)

    // 其他已知危险开关同样拦
    expect(guardEngineArgs({ binary: 'python.exe', args: ['main.py', '--highvram'], engine: 'comfyui' }).ok).toBe(false)
  })

  it('@core:studio-media 合法参数放行，且不做前缀误杀与跨引擎误拦', () => {
    // 内置默认参数：必须放行
    const normal = guardEngineArgs({
      binary: 'python.exe',
      args: ['main.py', '--listen', '127.0.0.1', '--port', '8188', '--reserve-vram', '2.5'],
      engine: 'comfyui'
    })
    expect(normal.ok).toBe(true)
    expect(normal.blocked).toHaveLength(0)
    expect(normal.message).toBe('')

    // 前缀相同但实际不同的参数不能被误杀
    expect(guardEngineArgs({ binary: 'python.exe', args: ['main.py', '--highvramx'], engine: 'comfyui' }).ok).toBe(true)
    expect(guardEngineArgs({ binary: 'python.exe', args: ['main.py', '--use-split-cross-attention-x'], engine: 'comfyui' }).ok).toBe(true)

    // --flag=value 写法也要能识别
    const inline = guardEngineArgs({ binary: 'python.exe', args: ['main.py', '--use-split-cross-attention=true'], engine: 'comfyui' })
    expect(inline.ok).toBe(false)
    expect(inline.blocked[0].flag).toBe('--use-split-cross-attention')

    // 规则限定了引擎：llama.cpp 上出现同名参数不按 comfyui 规则拦
    expect(guardEngineArgs({ binary: 'llama-server.exe', args: ['--highvram'], engine: 'llama' }).ok).toBe(true)

    // 引擎类型识别
    expect(detectEngineKind('C:/AI/ComfyUI/python.exe', ['main.py'])).toBe('comfyui')
    expect(detectEngineKind('C:/llama/llama-server.exe', [])).toBe('llama')
    expect(detectEngineKind('C:/x/unknown.exe', [])).toBe('unknown')
  })

  it('@core:studio-media 每条危险参数都有原因与替代方案，不允许只写「别用」', () => {
    expect(DANGEROUS_ENGINE_ARGS.length).toBeGreaterThan(0)
    for (const rule of DANGEROUS_ENGINE_ARGS) {
      expect(rule.flag.startsWith('--'), `${rule.flag} 应该是长参数`).toBe(true)
      expect(rule.reason.length, `${rule.flag} 缺少原因`).toBeGreaterThan(10)
      expect(rule.alternative.length, `${rule.flag} 缺少替代方案`).toBeGreaterThan(10)
      // 替代方案必须是能照做的具体动作，不能是空话
      expect(/--|去掉|改用|换成|调大|降到/.test(rule.alternative), `${rule.flag} 的替代方案不可执行`).toBe(true)
    }
  })

  it('@core:studio-media 在线实例同样受检：带危险参数手工启动的引擎不能被当成可用', () => {
    // 复刻 assertRunningEngineSafe 的判定：真实命令行长这样（本机实测格式）
    const runningLines = [
      'C:\\AI\\MorrowMedia\\ComfyUI\\.venv\\Scripts\\python.exe main.py --listen 127.0.0.1 --port 8188',
      '"C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python312\\python.exe" main.py --listen 127.0.0.1 --port 8188'
    ]
    const check = (lines: string[]): boolean =>
      lines.some((line) => {
        const args = line.trim().split(/\s+/)
        return !guardEngineArgs({ binary: args[0] ?? '', args, engine: 'comfyui' }).ok
      })

    // 干净在线实例：放行，不能误伤正常用户
    expect(check(runningLines), '参数干净的在线实例不能被拦').toBe(false)

    // 手工带危险参数启动的实例：必须被拦
    const dirty = [...runningLines, 'python.exe main.py --port 8188 --use-split-cross-attention']
    expect(check(dirty), '带危险参数的在线实例必须被拦').toBe(true)

    // 引号包裹的可执行路径不能影响判定
    expect(
      guardEngineArgs({ binary: '"C:\\python.exe"', args: ['main.py', '--highvram'], engine: 'comfyui' }).ok
    ).toBe(false)
  })
})