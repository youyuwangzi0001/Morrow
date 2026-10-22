/**
 * 在系统文件管理器中定位文件。
 *
 * Windows 上 shell.showItemInFolder 常只打开文件夹而不选中，甚至在路径含空格/中文时
 * 静默失败；explorer.exe 的 /select, 与路径必须分成两个参数传递，Node 才会把路径
 * 正确加引号。路径合成一个参数（/select,C:\a b\c.txt）会让 Explorer 打开「文档」。
 */
import { spawn } from 'node:child_process'
import { shell } from 'electron'
import { log } from './logger'

export function explorerSelectArgs(absolutePath: string): string[] {
  // explorer 只接受「/select,」与路径分开传参；合成一个参数时含空格/中文的路径会失败。
  return ['/select,', absolutePath]
}

export function revealInFileManager(absolutePath: string): void {
  if (process.platform === 'win32') {
    try {
      const child = spawn('explorer.exe', explorerSelectArgs(absolutePath), {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.on('error', (err) => log.warn('explorer reveal failed', { path: absolutePath, error: String(err) }))
      child.unref()
      return
    } catch (err) {
      log.warn('explorer reveal spawn failed', { path: absolutePath, error: String(err) })
    }
  }
  shell.showItemInFolder(absolutePath)
}
