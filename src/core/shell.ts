/**
 * 一次性命令的 Shell 适配。
 *
 * 用户选择的默认终端必须同时作用于终端面板、run_command、terminal(run/start) 和后台任务。
 * 这里只做「命令 → 参数」的纯转换，不触碰进程与 Electron，便于单测覆盖四种终端。
 */
import type { CommandShell } from './types'

const PS_PREFIX =
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ' +
  '$OutputEncoding=[Console]::OutputEncoding; $ProgressPreference="SilentlyContinue"; '

export function fallbackCommandShell(): CommandShell {
  return process.platform === 'win32'
    ? { id: 'powershell', label: 'Windows PowerShell', file: 'powershell.exe' }
    : { id: 'default', label: '默认终端', file: '/bin/sh' }
}

export function buildOneShotInvocation(
  shell: CommandShell | null | undefined,
  command: string
): { file: string; args: string[] } {
  const target = shell?.file ? shell : fallbackCommandShell()
  switch (shell?.id) {
    case 'pwsh':
    case 'powershell':
      return {
        file: target.file,
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          PS_PREFIX + command
        ]
      }
    case 'cmd':
      return { file: target.file, args: ['/d', '/s', '/c', `chcp 65001>nul & ${command}`] }
    case 'gitbash':
      return { file: target.file, args: ['-lc', command] }
    case 'wsl':
      return { file: target.file, args: ['-e', 'sh', '-lc', command] }
    default:
      return process.platform === 'win32'
        ? {
            file: target.file,
            args: [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-Command',
              PS_PREFIX + command
            ]
          }
        : { file: target.file, args: ['-lc', command] }
  }
}

/**
 * 命令失败后的可执行建议：让模型看到「下一步怎么改」，而不是只看到通用提示后原样重试。
 * 只做文本识别，不改变命令本身。
 */
export function commandFailureHint(stderr: string, stdout: string, shellLabel: string): string {
  const text = `${stderr}\n${stdout}`
  if (/A positional parameter cannot be found|找不到接受实际参数|无法找到接受实际参数/i.test(text)) {
    return 'PowerShell 把参数拆错了：路径含空格时要用引号包住，或去掉多余的引号/续行符。把命令拆短，或改用 read_file/grep/list_dir 等内置工具。'
  }
  if (/ParserError|UnexpectedToken|unexpected token|unexpected EOF|Missing closing|字符串缺少终止符|意外的标记/i.test(text)) {
    return '命令里有语法或引号错误。先用一条最小命令验证，再逐步拼接；复杂脚本请用 write_file 写成 .ps1/.js 后执行，避免多层引号。'
  }
  if (/Cannot find module|MODULE_NOT_FOUND|模块.*未找到/i.test(text)) {
    return '脚本或依赖路径不对。先用 list_dir 确认脚本存在、cwd 正确；Node 脚本用工作区内相对路径（如 node scripts/x.js），缺依赖先安装。'
  }
  if (/is not recognized as the name of a cmdlet|CommandNotFoundException|不是内部或外部命令|command not found/i.test(text)) {
    return `当前终端（${shellLabel}）找不到这个命令。检查命令名与语法是否属于该终端；也可以用内置工具完成同样的事，避免依赖外部程序。`
  }
  if (/running scripts is disabled|禁止运行脚本|ExecutionPolicy/i.test(text)) {
    return 'PowerShell 执行策略阻止了脚本。改用 -Command 直接执行，或直接调用解释器（node/python）。'
  }
  if (/Access is denied|Permission denied|拒绝访问|EBUSY|being used by another process|另一个程序正在使用/i.test(text)) {
    return '文件被占用或权限不足。先关闭占用该文件的程序再重试，并确认路径在工作区内。'
  }
  return '检查命令语法、文件路径是否正确；如果是脚本报错，先读一下错误信息再修改，避免原样重试。'
}

/** 给模型看的命令语法提示；避免用户选 cmd/Git Bash 时仍写 PowerShell。 */
export function shellSyntaxHint(
  shell: { id: string; label?: string; file?: string } | null | undefined
): string {
  switch (shell?.id) {
    case 'cmd':
      return '当前是命令提示符（cmd）：用 dir/type/copy 等 cmd 语法，不要用 PowerShell cmdlet。'
    case 'gitbash':
      return '当前是 Git Bash：用 POSIX/bash 语法（ls/cat/grep/&&），不要用 PowerShell cmdlet。'
    case 'wsl':
      return '当前是 WSL：命令在 Linux 中执行，用 POSIX 语法。'
    default:
      return '当前是 PowerShell：用 PowerShell 语法（Get-ChildItem 等），不要用 bash/cmd 专有语法。'
  }
}
