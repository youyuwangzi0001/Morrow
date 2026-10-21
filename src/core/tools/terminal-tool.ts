/**
 * terminal：持久终端与后台任务（由主进程注入 TerminalToolHandler）。
 * - run：一次性命令，等待结束（默认 120s）
 * - start：后台任务，立即返回 id；配合 read/write/stop 管理
 * - list/read/write/stop/restart：查看与管理已有进程
 */
import type { TerminalToolResponse } from '../types'
import { errorMessage } from '../util'
import { getNumber, getString } from './args'
import { ToolInputError } from './errors'
import { errResult, okResult, oneLineInput, type ToolImpl } from './types'

const ACTIONS = ['list', 'start', 'run', 'read', 'write', 'stop', 'restart'] as const

function formatProcesses(response: TerminalToolResponse): string {
  if (!response.processes?.length) return '当前没有运行中的终端或后台任务。'
  return response.processes
    .map((item) => {
      const state = item.status === 'running' ? '运行中' : `已退出${item.exitCode !== undefined ? `(${item.exitCode})` : ''}`
      return `${item.id} · ${item.kind === 'task' ? '后台任务' : '终端'} · ${item.status === 'running' ? state : state}\n  标题：${item.title}\n  目录：${item.cwd}\n  PID：${item.pid ?? '—'}${item.command ? `\n  命令：${item.command}` : ''}`
    })
    .join('\n\n')
}

export const terminalTool: ToolImpl = {
  definition: {
    name: 'terminal',
    description:
      '使用持久终端/后台任务。长任务（dev server、watch、构建、下载）用 action=start 启动后台任务，' +
      '再用 action=read 看日志、action=write 写 stdin、action=stop 停止；短命令用 action=run 等待结果。' +
      'action=list 查看所有进程。终端会话在应用运行期间保持 cwd/变量。不要用它读取工作区外文件或执行危险操作。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS], description: '操作类型' },
        command: { type: 'string', description: 'action=run/start 时要执行的命令' },
        title: { type: 'string', description: 'action=start 的任务标题（可选）' },
        id: { type: 'string', description: 'read/write/stop/restart 的目标进程 id' },
        data: { type: 'string', description: 'action=write 写入 stdin 的内容' },
        tail: { type: 'number', description: 'action=read 读取末尾字符数（默认 40000）' },
        timeout_ms: { type: 'number', description: 'action=run 的超时（默认 120000，最大 300000）' }
      },
      required: ['action'],
      additionalProperties: false
    },
    category: 'exec',
    risk: 'medium',
    titleFor: (input) => {
      const action = typeof input.action === 'string' ? input.action : ''
      if (action === 'start' || action === 'run') return `终端：${oneLineInput(input, 'command', 60) || action}`
      return `终端进程（${action || '操作'}）`
    }
  },
  async execute(input, ctx) {
    try {
      const action = getString(input, 'action', { required: true, maxLength: 20 }) as (typeof ACTIONS)[number]
      if (!ACTIONS.includes(action)) {
        return errResult(`未知的终端操作：${action}。`, `可用操作：${ACTIONS.join('、')}。`)
      }
      if (!ctx.terminal) {
        return errResult('终端服务不可用。', '请重启 Morrow 后再试。')
      }
      const command =
        action === 'run' || action === 'start'
          ? getString(input, 'command', { required: true, maxLength: 4000 })
          : undefined
      const id =
        action === 'read' || action === 'write' || action === 'stop' || action === 'restart'
          ? getString(input, 'id', { required: true, maxLength: 80 })
          : undefined
      const data = action === 'write' ? getString(input, 'data', { required: true, maxLength: 20_000 }) : undefined
      const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : undefined
      const tail =
        input.tail === undefined || input.tail === null || input.tail === ''
          ? undefined
          : getNumber(input, 'tail', { min: 1000, max: 40_000 })
      const timeoutMs =
        input.timeout_ms === undefined || input.timeout_ms === null || input.timeout_ms === ''
          ? undefined
          : getNumber(input, 'timeout_ms', { min: 1000, max: 300_000 })

      const response = await ctx.terminal({
        action,
        ...(command ? { command } : {}),
        ...(id ? { id } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(title ? { title } : {}),
        ...(tail !== undefined ? { tail } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        cwd: ctx.workspace
      })
      if (!response.ok) return errResult(response.error ?? response.summary, response.hint, { terminal: true })
      if (action === 'list') return okResult(formatProcesses(response), { processes: response.processes ?? [] })
      if (action === 'start' && response.process) {
        return okResult(
          `后台任务已启动：${response.process.title}\nID：${response.process.id}\n目录：${response.process.cwd}\n\n用 terminal(action=read,id=...) 查看日志，stop 停止。`,
          { process: response.process }
        )
      }
      if (action === 'run') {
        const output = response.output?.trim() || '（命令没有输出）'
        return okResult(
          `命令结束${response.exitCode !== undefined ? `（退出码 ${response.exitCode}）` : ''}：\n${output}`,
          { exitCode: response.exitCode, output: response.output }
        )
      }
      if (action === 'read') {
        return okResult(
          `进程：${response.process?.id ?? id}（${response.process?.status ?? 'unknown'}）\n\n${response.output?.trim() || '（暂无输出）'}`,
          { process: response.process, output: response.output }
        )
      }
      return okResult(response.summary, { process: response.process })
    } catch (err) {
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(`终端操作失败：${errorMessage(err)}`)
    }
  }
}
