// 创作台 IPC：界面只能通过这一组窄动作读写作品。
import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerFeatureHandler } from '../feature-ipc'
import { getStudioService } from '../studio/service'
import { getStudioStore, resetStudioStoreForTest } from '../studio/store'
import {
  cleanTargetDataDir,
  copyUserDataForMigration,
  isNestedPath,
  readStudioLocation,
  removeStudioLocation,
  resolveDefaultStudioRoot,
  samePath,
  studioDataDirInfo,
  writeStudioLocation
} from '../services/paths'

function recordOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
}

registerFeatureHandler('feature:studio:action', async (payload) => {
  const request = recordOf(payload)
  const type = typeof request.type === 'string' ? request.type : ''
  if (!type) throw new Error('缺少创作台操作类型。')
  return getStudioService().execute(request as { type: string; projectId?: string; [key: string]: unknown })
})

registerFeatureHandler('feature:studio:pick-import', async (payload, event) => {
  const input = recordOf(payload)
  const title = typeof input.title === 'string' ? input.title : '导入素材'
  const kind = input.kind === 'video' ? 'video' : input.kind === 'audio' ? 'audio' : 'image'
  const filters =
    kind === 'video'
      ? [{ name: '视频', extensions: ['mp4', 'webm', 'mov', 'mkv'] }]
      : kind === 'audio'
        ? [{ name: '音频', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg'] }]
        : [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const options = {
    title,
    properties: ['openFile' as const, ...(input.multiple === true ? ['multiSelections' as const] : [])],
    filters
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
})

registerFeatureHandler('feature:studio:pick-package', async (_payload, event) => {
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const options = {
    title: '导入创作台工程包',
    properties: ['openFile' as const],
    filters: [{ name: 'Morrow 创作台工程包', extensions: ['morrowcraft', 'zip'] }]
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
})

registerFeatureHandler('feature:studio:reveal', async (payload) => {
  const input = recordOf(payload)
  const projectId = typeof input.projectId === 'string' ? input.projectId : ''
  const path = typeof input.path === 'string' ? input.path : ''
  if (!projectId || !path) throw new Error('缺少作品或文件路径。')
  const absolute = getStudioStore().deliveryAbsolute(projectId, { path })
  shell.showItemInFolder(absolute)
  return true
})

registerFeatureHandler('feature:studio:open-path', async (payload) => {
  const input = recordOf(payload)
  const projectId = typeof input.projectId === 'string' ? input.projectId : ''
  const path = typeof input.path === 'string' ? input.path : ''
  if (!projectId || !path) throw new Error('缺少作品或文件路径。')
  const absolute = getStudioStore().deliveryAbsolute(projectId, { path })
  const message = await shell.openPath(absolute)
  if (message) throw new Error(message)
  return true
})

registerFeatureHandler('feature:studio:open-data-dir', async () => {
  const message = await shell.openPath(getStudioStore().root)
  if (message) throw new Error(message)
  return true
})

registerFeatureHandler('feature:studio:open-project-dir', async (payload) => {
  const input = recordOf(payload)
  const projectId = typeof input.projectId === 'string' ? input.projectId : ''
  if (!projectId) throw new Error('缺少作品。')
  const message = await shell.openPath(getStudioStore().projectDir(projectId))
  if (message) throw new Error(message)
  return true
})

function mainStudioWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().includes('#island'))
}

function studioJobsRunning(): boolean {
  const store = getStudioStore()
  return store.summaries().some((summary) => {
    try {
      return store.readProject(summary.id).jobs.some((job) => job.status === 'running' || job.status === 'queued')
    } catch {
      return false
    }
  })
}

function studioDataTestMode(): boolean {
  return process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')
}

function relaunchStudioSoon(): void {
  if (studioDataTestMode()) {
    resetStudioStoreForTest()
    return
  }
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 800)
}

registerFeatureHandler('feature:studio:data-dir-info', async () => studioDataDirInfo())

registerFeatureHandler('feature:studio:change-data-dir', async () => {
  if (studioJobsRunning()) throw new Error('还有创作台任务在运行，请等待完成或暂停队列后再更换目录。')
  const win = BrowserWindow.getFocusedWindow() ?? mainStudioWindow()
  const picked = win
    ? await dialog.showOpenDialog(win, { title: '选择创作台数据目录', buttonLabel: '选择此文件夹', properties: ['openDirectory', 'createDirectory'] })
    : await dialog.showOpenDialog({ title: '选择创作台数据目录', buttonLabel: '选择此文件夹', properties: ['openDirectory', 'createDirectory'] })
  if (picked.canceled || !picked.filePaths[0]) return { restarted: false, canceled: true }
  const target = resolve(picked.filePaths[0])
  const current = getStudioStore().root
  if (samePath(target, current)) throw new Error('新目录与当前创作台目录相同。')
  if (isNestedPath(target, current) || isNestedPath(current, target)) throw new Error('新目录不能与当前创作台目录互相包含。')
  if (existsSync(target) && !statSync(target).isDirectory()) throw new Error('请选择一个文件夹。')
  try {
    mkdirSync(target, { recursive: true })
  } catch (err) {
    throw new Error(`无法使用该文件夹：${err instanceof Error ? err.message : String(err)}`)
  }
  if (readdirSync(target).length > 0) throw new Error('请选择一个空文件夹，避免覆盖已有内容。')

  const choice = win
    ? await dialog.showMessageBox(win, {
        type: 'question',
        title: '更换创作台数据目录',
        message: '更换后需要重启 Morrow',
        detail: `新目录：${target}

迁移并重启：复制现有创作台作品、素材、历史版本与任务记录；Agent 对话和设置不移动。
仅切换并重启：新目录从空白创作台开始，原目录保留。`,
        buttons: ['迁移并重启', '仅切换并重启', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
    : await dialog.showMessageBox({
        type: 'question',
        title: '更换创作台数据目录',
        message: '更换后需要重启 Morrow',
        detail: `新目录：${target}

迁移并重启：复制现有创作台作品、素材、历史版本与任务记录；Agent 对话和设置不移动。`,
        buttons: ['迁移并重启', '仅切换并重启', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
  if (choice.response === 2) return { restarted: false, canceled: true }
  let files = 0
  if (choice.response === 0) {
    try {
      files = copyUserDataForMigration(current, target)
    } catch (err) {
      try { cleanTargetDataDir(target) } catch { /* 清理失败不掩盖迁移错误 */ }
      throw new Error(`迁移创作台数据失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    writeStudioLocation(target)
  } catch (err) {
    if (choice.response === 0) {
      try { cleanTargetDataDir(target) } catch { /* ignore */ }
    }
    throw new Error(`保存创作台目录失败：${err instanceof Error ? err.message : String(err)}`)
  }
  relaunchStudioSoon()
  return { restarted: !studioDataTestMode(), path: target, files }
})

registerFeatureHandler('feature:studio:reset-data-dir', async () => {
  if (studioJobsRunning()) throw new Error('还有创作台任务在运行，请等待完成或暂停队列后再恢复目录。')
  if (!readStudioLocation()) return { restarted: false, canceled: true }
  const win = BrowserWindow.getFocusedWindow() ?? mainStudioWindow()
  const current = getStudioStore().root
  const defaultRoot = resolveDefaultStudioRoot()
  if (samePath(current, defaultRoot)) {
    removeStudioLocation()
    relaunchStudioSoon()
    return { restarted: !studioDataTestMode(), path: defaultRoot, files: 0 }
  }
  if (isNestedPath(defaultRoot, current) || isNestedPath(current, defaultRoot)) {
    throw new Error('默认目录与当前自定义目录互相包含，无法安全迁回。')
  }
  if (existsSync(defaultRoot) && readdirSync(defaultRoot).length > 0) {
    throw new Error(`默认创作台目录已有内容：${defaultRoot}。请先备份或移走后再恢复默认。`)
  }
  const choice = win
    ? await dialog.showMessageBox(win, {
        type: 'question',
        title: '恢复默认创作台目录',
        message: '恢复默认并重启？',
        detail: `会把当前创作台数据复制回：${defaultRoot}
原自定义目录保留。Agent 对话和设置不受影响。`,
        buttons: ['恢复默认并重启', '取消'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
    : await dialog.showMessageBox({
        type: 'question',
        title: '恢复默认创作台目录',
        message: '恢复默认并重启？',
        detail: `会把当前创作台数据复制回：${defaultRoot}
原自定义目录保留。`,
        buttons: ['恢复默认并重启', '取消'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
  if (choice.response !== 0) return { restarted: false, canceled: true }
  mkdirSync(defaultRoot, { recursive: true })
  let files = 0
  try {
    files = copyUserDataForMigration(current, defaultRoot)
  } catch (err) {
    try { cleanTargetDataDir(defaultRoot) } catch { /* ignore */ }
    throw new Error(`迁回默认创作台目录失败：${err instanceof Error ? err.message : String(err)}`)
  }
  removeStudioLocation()
  relaunchStudioSoon()
  return { restarted: !studioDataTestMode(), path: defaultRoot, files }
})
