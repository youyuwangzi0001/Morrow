import { describe, expect, it } from 'vitest'
import { buildOneShotInvocation, commandFailureHint, shellSyntaxHint } from '../../../src/core/shell'

describe('one-shot shell invocation', () => {
  it('PowerShell 7 uses pwsh.exe with a non-interactive UTF-8 command', () => {
    const result = buildOneShotInvocation(
      { id: 'pwsh', label: 'PowerShell 7', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
      'Get-Location'
    )
    expect(result.file).toContain('pwsh.exe')
    expect(result.args).toEqual(
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command'])
    )
    expect(result.args[result.args.length - 1]).toContain('Get-Location')
    expect(result.args[result.args.length - 1]).toContain('OutputEncoding')
  })

  it('Windows PowerShell stays on powershell.exe', () => {
    const result = buildOneShotInvocation(
      { id: 'powershell', label: 'Windows PowerShell', file: 'powershell.exe' },
      'Get-Location'
    )
    expect(result.file).toBe('powershell.exe')
    expect(result.args[result.args.length - 1]).toContain('Get-Location')
  })

  it('cmd uses cmd.exe switches and switches the code page', () => {
    const result = buildOneShotInvocation(
      { id: 'cmd', label: '命令提示符', file: 'cmd.exe' },
      'dir'
    )
    expect(result.file).toBe('cmd.exe')
    expect(result.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(result.args[3]).toContain('chcp 65001')
    expect(result.args[3]).toContain('dir')
  })

  it('Git Bash and WSL use POSIX login shells', () => {
    const gitbash = buildOneShotInvocation(
      { id: 'gitbash', label: 'Git Bash', file: 'C:\\Program Files\\Git\\bin\\bash.exe' },
      'printf ok'
    )
    expect(gitbash.args).toEqual(['-lc', 'printf ok'])
    const wsl = buildOneShotInvocation({ id: 'wsl', label: 'WSL', file: 'wsl.exe' }, 'uname -a')
    expect(wsl.args).toEqual(['-e', 'sh', '-lc', 'uname -a'])
  })

  it('syntax hints follow the selected shell', () => {
    expect(shellSyntaxHint({ id: 'pwsh', label: 'PowerShell 7', file: 'pwsh.exe' })).toContain('PowerShell')
    expect(shellSyntaxHint({ id: 'cmd', label: 'cmd', file: 'cmd.exe' })).toContain('dir')
    expect(shellSyntaxHint({ id: 'gitbash', label: 'Git Bash', file: 'bash.exe' })).toContain('POSIX')
  })

  it('command failures produce actionable hints', () => {
    expect(commandFailureHint('A positional parameter cannot be found that accepts argument', '', 'PowerShell 7')).toContain('引号')
    expect(commandFailureHint('Error: Cannot find module \'x.js\'', '', 'PowerShell 7')).toContain('list_dir')
    expect(commandFailureHint("'foo' is not recognized as the name of a cmdlet", '', 'PowerShell 7')).toContain('PowerShell 7')
    expect(commandFailureHint('ParserError: Missing closing \')\'', '', 'PowerShell 7')).toContain('最小命令')
    expect(commandFailureHint('', 'boom', 'cmd')).toContain('原样重试')
  })
})
