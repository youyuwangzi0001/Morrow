import { BrowserWindow, dialog, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { registerFeatureHandler } from '../feature-ipc'
import { getMediaService } from '../services/media-service'
import { getMediaCatalog } from '../services/media-catalog'
import type { MediaCatalogAction } from '../../shared/media-models'

registerFeatureHandler('feature:media:status', async () => {
  return getMediaService().status()
})

registerFeatureHandler('feature:media:start', async () => {
  return getMediaService().startEngine()
})

registerFeatureHandler('feature:media:probe', async (payload) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const workspace = typeof record.workspace === 'string' ? record.workspace : ''
  const path = typeof record.path === 'string' ? record.path : ''
  if (!workspace || !path) throw new Error('缺少工作区或文件路径。')
  return getMediaService().probeMedia({ workspace, path })
})

registerFeatureHandler('feature:media:pick', async (payload, event) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const kind = record.kind === 'ffmpeg' ? 'ffmpeg' : 'dir'
  // Windows 的 ffmpeg 是 .exe；macOS/Linux 的可执行文件没有扩展名，不能过滤掉。
  const filters =
    kind === 'dir' ? undefined : process.platform === 'win32' ? [{ name: 'ffmpeg', extensions: ['exe'] }] : undefined
  const options = {
    title: kind === 'dir' ? '选择 ComfyUI 安装目录' : '选择 ffmpeg 可执行文件',
    properties: kind === 'dir' ? ['openDirectory' as const] : ['openFile' as const],
    filters
  }
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : result.filePaths[0] ?? null
})

registerFeatureHandler('feature:media:catalog', async () => {
  return getMediaCatalog().status()
})

registerFeatureHandler('feature:media:catalog-action', async (payload) => {
  const record = payload && typeof payload === 'object' ? (payload as MediaCatalogAction) : null
  if (!record?.action) throw new Error('缺少模型/引擎操作。')
  const catalog = getMediaCatalog()
  const signal = new AbortController().signal
  switch (record.action) {
    case 'install-model':
      if (!record.id) throw new Error('缺少模型 id。')
      return catalog.installModel(record.id, () => undefined, signal)
    case 'uninstall-model':
      if (!record.id) throw new Error('缺少模型 id。')
      return catalog.uninstallModel(record.id)
    case 'start-engine':
      if (!record.id) throw new Error('缺少引擎 id。')
      return catalog.startEngine(record.id, typeof record.modelId === 'string' ? record.modelId : undefined)
    case 'stop-engine':
      if (!record.id) throw new Error('缺少引擎 id。')
      return catalog.stopEngine(record.id)
    case 'install-engine':
      if (!record.id) throw new Error('缺少引擎 id。')
      return catalog.installEngine(record.id)
    case 'register-model':
      if (!record.manifest) throw new Error('缺少模型清单。')
      return catalog.registerModel(record.manifest)
    case 'remove-model':
      if (!record.id) throw new Error('缺少模型 id。')
      return catalog.removeModel(record.id)
    case 'register-engine':
      if (!record.manifest) throw new Error('缺少引擎清单。')
      return catalog.registerEngine(record.manifest)
    case 'remove-engine':
      if (!record.id) throw new Error('缺少引擎 id。')
      return catalog.removeEngine(record.id)
    default:
      throw new Error(`不支持的操作：${String(record.action)}`)
  }
})

registerFeatureHandler('feature:media:open-model-dir', async (payload) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const engineId = typeof record.engineId === 'string' ? record.engineId : ''
  const catalog = await getMediaCatalog().status()
  const engine = catalog.engines.find((item) => item.id === engineId)
  if (!engine?.modelDir) throw new Error('这个引擎还没有模型目录；请先配置引擎目录。')
  const message = await shell.openPath(engine.modelDir)
  if (message) throw new Error(message)
  return engine.modelDir
})

registerFeatureHandler('feature:media:pick-files', async (payload, event) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : '选择本机模型文件'
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const options = {
    title,
    properties: ['openFile' as const, 'multiSelections' as const]
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
})

registerFeatureHandler('feature:media:resolve-model-files', async (payload) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const engineId = typeof record.engineId === 'string' ? record.engineId : ''
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  if (!engineId) throw new Error('请选择模型所属引擎。')
  if (paths.length === 0) throw new Error('请选择至少一个模型文件。')
  const catalog = await getMediaCatalog().status()
  const engine = catalog.engines.find((item) => item.id === engineId)
  if (!engine) throw new Error(`引擎不存在：${engineId}`)
  const modelDir = engine.modelDir
  if (!modelDir) throw new Error(`引擎「${engine.label}」还没有模型目录；请先在上方配置引擎目录。`)

  const uniqueTarget = (name: string): string => {
    const target = join(modelDir, name)
    if (!existsSync(target)) return target
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length)
    for (let index = 2; index < 1000; index += 1) {
      const candidate = join(modelDir, `${stem}-${index}${ext}`)
      if (!existsSync(candidate)) return candidate
    }
    throw new Error(`模型目录里同名文件过多：${name}`)
  }

  const results: Array<{ path: string; dest: string; size: number; copied: boolean }> = []
  for (const raw of paths) {
    const source = resolve(raw.trim())
    if (!existsSync(source)) throw new Error(`模型文件不存在：${source}`)
    const stat = statSync(source)
    if (!stat.isFile()) throw new Error(`不是文件：${source}`)
    const rel = relative(modelDir, source)
    const inside = !rel.startsWith('..') && !isAbsolute(rel)
    if (inside) {
      results.push({ path: source, dest: rel.replace(/\\/g, '/'), size: stat.size, copied: false })
      continue
    }
    // 下载目录里的模型不应逼用户手动搬运：复制进引擎模型目录，重名时自动加序号。
    const target = uniqueTarget(basename(source))
    try {
      await copyFile(source, target)
    } catch (err) {
      throw new Error(`复制模型文件失败：${err instanceof Error ? err.message : String(err)}`)
    }
    results.push({
      path: target,
      dest: relative(modelDir, target).replace(/\\/g, '/'),
      size: stat.size,
      copied: true
    })
  }
  return results
})

registerFeatureHandler('feature:media:pick-manifest', async (payload, event) => {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const kind = record.kind === 'engine' ? 'engine' : 'model'
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const options = {
    title: kind === 'engine' ? '导入引擎清单（JSON）' : '导入模型清单（JSON）',
    properties: ['openFile' as const],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  const { readFileSync } = await import('node:fs')
  try {
    return { kind, manifest: JSON.parse(readFileSync(result.filePaths[0], 'utf8')) as Record<string, unknown> }
  } catch (err) {
    throw new Error(`清单不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
})
