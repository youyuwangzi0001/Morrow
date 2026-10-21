/**
 * 目录里本机 MCP 服务的启动命令构造（纯函数，可在单元测试覆盖）。
 * Windows 上 npx 是 .cmd，必须通过 cmd.exe 启动；目录参数带空格时需要加引号。
 */

export interface LocalNpxInvocation {
  command: string
  args: string[]
}

export function quoteCmdToken(value: string): string {
  if (!/[\s"&|<>^()%!]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

export function buildLocalNpxInvocation(
  packageArgs: string[],
  folder: string | null | undefined,
  platform: string,
  comspec?: string
): LocalNpxInvocation {
  const fullArgs = ['-y', ...packageArgs, ...(folder ? [folder] : [])]
  if (platform === 'win32') {
    return {
      command: comspec || 'cmd.exe',
      args: ['/d', '/s', '/c', ['npx', ...fullArgs].map(quoteCmdToken).join(' ')]
    }
  }
  return { command: 'npx', args: fullArgs }
}
