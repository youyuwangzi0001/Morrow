/**
 * 审计环境的 electron 替身：只实现主进程服务实际用到的 app.getPath。
 * 数据目录固定到环境变量 MORROW_AUDIT_DATA_DIR（每个测试自己设置），避免碰真实用户数据。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function auditDataDir(): string {
  return process.env.MORROW_AUDIT_DATA_DIR || join(tmpdir(), 'morrow-audit-electron')
}

export const app = {
  getPath(name: string): string {
    if (name === 'userData') return auditDataDir()
    return auditDataDir()
  },
  getVersion(): string {
    return '1.0.0'
  },
  getAppPath(): string {
    return process.cwd()
  },
  on(): void {
    // noop
  }
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return false
  },
  encryptString(): Buffer {
    throw new Error('safeStorage 在审计替身中不可用')
  },
  decryptString(): string {
    throw new Error('safeStorage 在审计替身中不可用')
  }
}

export class BrowserWindow {
  webContents = { send: (): void => undefined }
  isDestroyed(): boolean {
    return true
  }
}

export const ipcMain = { handle: (): void => undefined, removeHandler: (): void => undefined }
export const dialog = {}
export const shell = {}
