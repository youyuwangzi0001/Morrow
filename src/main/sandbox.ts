import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CommandSandboxStatus } from '../shared/types'
import { log } from './logger'

const execFileAsync = promisify(execFile)

const DEFAULT_IMAGE = 'node:22-bookworm'

const CACHE_MS = 30_000

/**
 * 命令沙箱只使用 Docker，并且不自动拉取镜像：
 * 没装 Docker 或镜像未就绪时如实降级，绝不让用户以为命令已经被隔离。
 */
export class CommandSandboxService {
  private cached: CommandSandboxStatus | null = null
  private refreshing: Promise<CommandSandboxStatus> | null = null
  private readonly image = process.env.MORROW_SANDBOX_IMAGE?.trim() || DEFAULT_IMAGE

  status(): CommandSandboxStatus {
    if (process.env.MORROW_DISABLE_SANDBOX === '1') {
      return {
        available: false,
        kind: 'docker',
        image: this.image,
        reason: '沙箱已被环境变量 MORROW_DISABLE_SANDBOX 关闭',
        checkedAt: Date.now()
      }
    }
    if (!this.cached) {
      void this.refresh()
      return {
        available: false,
        kind: 'docker',
        image: this.image,
        reason: '正在检测 Docker 沙箱…',
        checkedAt: 0
      }
    }
    if (Date.now() - this.cached.checkedAt > CACHE_MS) void this.refresh()
    return this.cached
  }

  async refresh(): Promise<CommandSandboxStatus> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.probe().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async probe(): Promise<CommandSandboxStatus> {
    const unavailable = (reason: string): CommandSandboxStatus => ({
      available: false,
      kind: 'docker',
      image: this.image,
      reason,
      checkedAt: Date.now()
    })
    if (process.env.MORROW_DISABLE_SANDBOX === '1') {
      this.cached = unavailable('沙箱已被环境变量 MORROW_DISABLE_SANDBOX 关闭')
      return this.cached
    }
    try {
      const { stdout } = await execFileAsync('docker', ['version', '--format', '{{.Server.Os}}|{{.Server.Version}}'], {
        timeout: 2_500,
        windowsHide: true
      })
      const [os, version] = stdout.trim().split('|')
      if (os && os !== 'linux') {
        this.cached = unavailable(`Docker 当前使用 ${os} 容器；命令沙箱需要 Linux 容器（Docker Desktop 可切换）。`)
        return this.cached
      }
      if (!version) {
        this.cached = unavailable('Docker 守护进程没有返回版本信息。')
        return this.cached
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.cached = unavailable(
        /ENOENT|not found|无法找到/i.test(message)
          ? '未检测到 Docker；安装 Docker Desktop 并启动后，命令沙箱才会可用。'
          : 'Docker 守护进程不可用；启动 Docker Desktop 后再试。'
      )
      log.info('command sandbox unavailable', { reason: this.cached.reason })
      return this.cached
    }
    try {
      const { stdout } = await execFileAsync('docker', ['image', 'inspect', this.image, '--format', '{{.Id}}'], {
        timeout: 2_500,
        windowsHide: true
      })
      if (!stdout.trim()) throw new Error('empty image id')
    } catch {
      this.cached = unavailable(`沙箱镜像 ${this.image} 尚未就绪；先在终端运行 docker pull ${this.image}。`)
      return this.cached
    }
    this.cached = {
      available: true,
      kind: 'docker',
      image: this.image,
      reason: `Docker 沙箱可用 · ${this.image}`,
      checkedAt: Date.now()
    }
    log.info('command sandbox ready', { image: this.image })
    return this.cached
  }
}

let instance: CommandSandboxService | null = null

export function getCommandSandboxService(): CommandSandboxService {
  if (!instance) instance = new CommandSandboxService()
  return instance
}
