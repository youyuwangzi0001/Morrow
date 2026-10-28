// studio 功能域逻辑：由 3 个 TS 文件扁平合并。
import type { Result } from '@shared/types'
import type { StudioActionResult, StudioCreateInput, StudioEditPlan, StudioDataDirChangeResult, StudioDataDirInfo, StudioEngineStatus, StudioEvent, StudioExportInput, StudioListResult, StudioProject, StudioRenderInput, StudioAsset, StudioCanvasConnection, StudioCanvasGroup, StudioCanvasNode, StudioShot, StudioProjectSummary, StudioStageId } from '@shared/studio'
import { create } from 'zustand'



type FeatureResult<T> = Result<T>


const invoke = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
  const response = (await window.morrow.features.invoke<T>('feature:studio:action', { type, ...payload })) as FeatureResult<T>
  if (!response.ok) throw new Error(response.error?.message || '操作失败。')
  return response.data as T
}


export const studioApi = {
  list(): Promise<StudioListResult> {
    return invoke<StudioListResult>('list')
  },
  status(): Promise<StudioEngineStatus> {
    return invoke<StudioEngineStatus>('status')
  },
  get(projectId: string): Promise<StudioActionResult> {
    return invoke<StudioActionResult>('get', { projectId })
  },
  create(input: StudioCreateInput): Promise<StudioActionResult> {
    return invoke<StudioActionResult>('create', input as unknown as Record<string, unknown>)
  },
  action<T = StudioActionResult>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    return invoke<T>(type, payload)
  },
  assistant(input: { projectId: string; text: string; selection?: { kind: 'chapter' | 'shot' | 'clip'; id: string } }): Promise<StudioActionResult & { plan: StudioEditPlan }> {
    return invoke<StudioActionResult & { plan: StudioEditPlan }>('assistant', input as unknown as Record<string, unknown>)
  },
  render(input: StudioRenderInput): Promise<StudioActionResult> {
    return invoke<StudioActionResult>('render', input as unknown as Record<string, unknown>)
  },
  exportProject(input: StudioExportInput): Promise<StudioActionResult> {
    return invoke<StudioActionResult>('export', input as unknown as Record<string, unknown>)
  },
  async pickImport(kind: 'image' | 'video' | 'audio' = 'image', options: { multiple?: boolean; title?: string } = {}): Promise<string[]> {
    const response = (await window.morrow.features.invoke<string[]>('feature:studio:pick-import', {
      kind,
      ...options
    })) as FeatureResult<string[]>
    if (!response.ok) throw new Error(response.error?.message || '无法打开文件选择器。')
    return response.data ?? []
  },
  async pickPackage(): Promise<string[]> {
    const response = (await window.morrow.features.invoke<string[]>('feature:studio:pick-package', {})) as FeatureResult<string[]>
    if (!response.ok) throw new Error(response.error?.message || '无法打开文件选择器。')
    return response.data ?? []
  },
  async reveal(projectId: string, path: string): Promise<void> {
    const response = (await window.morrow.features.invoke<boolean>('feature:studio:reveal', { projectId, path })) as FeatureResult<boolean>
    if (!response.ok) throw new Error(response.error?.message || '无法在文件夹中显示。')
  },
  async openPath(projectId: string, path: string): Promise<void> {
    const response = (await window.morrow.features.invoke<boolean>('feature:studio:open-path', { projectId, path })) as FeatureResult<boolean>
    if (!response.ok) throw new Error(response.error?.message || '无法打开文件。')
  },
  async dataDirInfo(): Promise<StudioDataDirInfo> {
    const response = (await window.morrow.features.invoke<StudioDataDirInfo>('feature:studio:data-dir-info', {})) as FeatureResult<StudioDataDirInfo>
    if (!response.ok) throw new Error(response.error?.message || '无法读取创作台数据目录。')
    return response.data
  },
  async changeDataDir(): Promise<StudioDataDirChangeResult> {
    const response = (await window.morrow.features.invoke<StudioDataDirChangeResult>('feature:studio:change-data-dir', {})) as FeatureResult<StudioDataDirChangeResult>
    if (!response.ok) throw new Error(response.error?.message || '无法更换创作台数据目录。')
    return response.data
  },
  async resetDataDir(): Promise<StudioDataDirChangeResult> {
    const response = (await window.morrow.features.invoke<StudioDataDirChangeResult>('feature:studio:reset-data-dir', {})) as FeatureResult<StudioDataDirChangeResult>
    if (!response.ok) throw new Error(response.error?.message || '无法恢复默认创作台数据目录。')
    return response.data
  },
  async openDataDir(): Promise<void> {
    const response = (await window.morrow.features.invoke<boolean>('feature:studio:open-data-dir', {})) as FeatureResult<boolean>
    if (!response.ok) throw new Error(response.error?.message || '无法打开作品目录。')
  },
  async openProjectDir(projectId: string): Promise<void> {
    const response = (await window.morrow.features.invoke<boolean>('feature:studio:open-project-dir', { projectId })) as FeatureResult<boolean>
    if (!response.ok) throw new Error(response.error?.message || '无法打开当前作品文件夹。')
  },
  onEvent(listener: (event: StudioEvent) => void): () => void {
    return window.morrow.features.on('feature:studio:event', (payload) => {
      if (!payload || typeof payload !== 'object') return
      const event = payload as StudioEvent
      if (event.type === 'job' || event.type === 'project') listener(event)
    })
  }
}



export function assetById(project: StudioProject, id: string | null | undefined) {
  return id ? project.assets.find((asset) => asset.id === id) : undefined
}


interface SnapshotInput {
  title: string
  nodes: StudioCanvasNode[]
  connections: StudioCanvasConnection[]
  groups: StudioCanvasGroup[]
  assets: StudioAsset[]
  shots: StudioShot[]
  waveforms: Record<string, number[]>
}


interface Box {
  x: number
  y: number
  width: number
  height: number
}


function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}


function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const char of text.replace(/\s+/g, ' ')) {
    if (char === '\n') {
      lines.push(current)
      current = ''
      if (lines.length >= maxLines) break
      continue
    }
    const next = current + char
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current)
      current = char
      if (lines.length >= maxLines) break
    } else {
      current = next
    }
  }
  if (lines.length < maxLines && current) lines.push(current)
  return lines.slice(0, maxLines)
}


function loadImage(url: string | undefined): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null)
  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    const timer = window.setTimeout(() => resolve(null), 4000)
    image.onload = () => {
      window.clearTimeout(timer)
      resolve(image)
    }
    image.onerror = () => {
      window.clearTimeout(timer)
      resolve(null)
    }
    image.src = url
  })
}


function groupBounds(group: StudioCanvasGroup, nodes: StudioCanvasNode[]): Box | null {
  const members = nodes.filter((node) => group.nodeIds.includes(node.id))
  if (!members.length) return null
  const minX = Math.min(...members.map((node) => node.x))
  const minY = Math.min(...members.map((node) => node.y))
  const maxX = Math.max(...members.map((node) => node.x + node.width))
  const maxY = Math.max(...members.map((node) => node.y + node.height))
  return { x: minX - 18, y: minY - 42, width: maxX - minX + 36, height: maxY - minY + 60 }
}


export async function renderCanvasSnapshot(input: SnapshotInput): Promise<{ dataUrl: string; width: number; height: number }> {
  const { nodes, connections, groups, assets, shots, waveforms } = input
  if (!nodes.length) throw new Error('画布上还没有节点。')
  await document.fonts?.ready.catch(() => undefined)
  const minX = Math.min(...nodes.map((node) => node.x)) - 90
  const minY = Math.min(...nodes.map((node) => node.y)) - 90
  const maxX = Math.max(...nodes.map((node) => node.x + node.width)) + 90
  const maxY = Math.max(...nodes.map((node) => node.y + node.height)) + 110
  const worldWidth = maxX - minX
  const worldHeight = maxY - minY
  const scale = Math.min(2, 4000 / Math.max(worldWidth, worldHeight))
  const header = 96
  const footer = 54
  const width = Math.max(640, Math.round(worldWidth * scale))
  const height = Math.max(480, Math.round(worldHeight * scale)) + header + footer
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器无法创建画布。')
  const dark = document.documentElement.dataset.theme !== 'light'
  const palette = dark
    ? { bg: '#0b0d10', grid: 'rgba(200,174,125,.08)', card: '#141920', cardHead: '#1b222b', border: 'rgba(200,174,125,.24)', text: '#ede7da', muted: '#9a9488', gold: '#c8ae7d', wire: 'rgba(200,174,125,.45)', placeholder: '#1d242d' }
    : { bg: '#f6f1e7', grid: 'rgba(120,92,48,.1)', card: '#fffdf7', cardHead: '#f3ead9', border: 'rgba(120,92,48,.25)', text: '#241f18', muted: '#7c7263', gold: '#8a6a3c', wire: 'rgba(138,106,60,.45)', placeholder: '#efe7d8' }
  ctx.fillStyle = palette.bg
  ctx.fillRect(0, 0, width, height)
  const grid = 26 * scale
  ctx.strokeStyle = palette.grid
  ctx.lineWidth = 1
  for (let x = 0; x < width; x += grid) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let y = 0; y < height; y += grid) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
  ctx.save()
  ctx.translate(0, header)
  ctx.scale(scale, scale)
  ctx.translate(-minX, -minY)

  for (const group of groups) {
    const box = groupBounds(group, nodes)
    if (!box) continue
    ctx.save()
    ctx.setLineDash([8, 6])
    ctx.strokeStyle = 'rgba(200,174,125,.32)'
    ctx.lineWidth = 1.4
    roundRect(ctx, box.x, box.y, box.width, box.height, 14)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(200,174,125,.12)'
    roundRect(ctx, box.x + 12, box.y - 2, Math.min(220, ctx.measureText(group.title).width + 28), 26, 13)
    ctx.fill()
    ctx.fillStyle = palette.gold
    ctx.font = '500 12px "Noto Sans SC", "Microsoft YaHei", sans-serif'
    ctx.fillText(group.title, box.x + 26, box.y + 16)
    ctx.restore()
  }

  for (const edge of connections) {
    const from = nodes.find((node) => node.id === edge.fromNodeId)
    const to = nodes.find((node) => node.id === edge.toNodeId)
    if (!from || !to) continue
    const sx = from.x + from.width
    const sy = from.y + from.height / 2
    const tx = to.x
    const ty = to.y + to.height / 2
    const curve = Math.max(60, Math.abs(tx - sx) * 0.45)
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.bezierCurveTo(sx + curve, sy, tx - curve, ty, tx, ty)
    ctx.strokeStyle = palette.wire
    ctx.lineWidth = 1.6
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(tx, ty, 3, 0, Math.PI * 2)
    ctx.fillStyle = palette.gold
    ctx.fill()
    if (edge.label) {
      const midX = (sx + tx) / 2
      const midY = (sy + ty) / 2
      ctx.font = '11px "Noto Sans SC", "Microsoft YaHei", sans-serif'
      const labelWidth = ctx.measureText(edge.label).width + 14
      ctx.fillStyle = dark ? 'rgba(11,13,16,.86)' : 'rgba(246,241,231,.92)'
      roundRect(ctx, midX - labelWidth / 2, midY - 12, labelWidth, 20, 6)
      ctx.fill()
      ctx.fillStyle = palette.muted
      ctx.textAlign = 'center'
      ctx.fillText(edge.label, midX, midY + 3)
      ctx.textAlign = 'left'
    }
  }

  const assetById = new Map(assets.map((asset) => [asset.id, asset]))
  const shotById = new Map(shots.map((shot) => [shot.id, shot]))
  const images = new Map<string, HTMLImageElement | null>()
  await Promise.all(
    nodes.map(async (node) => {
      const asset = node.assetId ? assetById.get(node.assetId) : undefined
      const shot = node.shotId ? shotById.get(node.shotId) : undefined
      const shotAsset = shot ? assetById.get(shot.imageAssetId ?? shot.videoAssetId ?? '') : undefined
      const source = asset?.thumbUrl ?? asset?.url ?? shotAsset?.thumbUrl ?? shotAsset?.url
      if (source) images.set(node.id, await loadImage(source))
    })
  )

  for (const node of nodes) {
    const asset = node.assetId ? assetById.get(node.assetId) : undefined
    const shot = node.shotId ? shotById.get(node.shotId) : undefined
    const image = images.get(node.id)
    ctx.save()
    ctx.shadowColor = dark ? 'rgba(0,0,0,.45)' : 'rgba(80,60,30,.16)'
    ctx.shadowBlur = 18
    ctx.shadowOffsetY = 8
    ctx.fillStyle = palette.card
    roundRect(ctx, node.x, node.y, node.width, node.height, 12)
    ctx.fill()
    ctx.restore()
    ctx.save()
    roundRect(ctx, node.x, node.y, node.width, node.height, 12)
    ctx.strokeStyle = palette.border
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.clip()
    ctx.fillStyle = palette.cardHead
    ctx.fillRect(node.x, node.y, node.width, 32)
    ctx.fillStyle = palette.gold
    ctx.font = '10px "JetBrains Mono", Consolas, monospace'
    const kindLabel = node.kind === 'shot' ? 'SHOT' : node.kind === 'image' ? 'IMAGE' : node.kind === 'video' ? 'VIDEO' : node.kind === 'audio' ? 'AUDIO' : 'NOTE'
    ctx.fillText(kindLabel, node.x + 12, node.y + 21)
    ctx.fillStyle = palette.text
    ctx.font = '600 13px "Noto Sans SC", "Microsoft YaHei", sans-serif'
    const title = wrapLines(ctx, node.title, node.width - 90, 1)[0] ?? node.title
    ctx.fillText(title, node.x + 58, node.y + 21)
    const bodyY = node.y + 32
    const bodyHeight = node.height - 32
    if (node.kind === 'text') {
      ctx.fillStyle = palette.muted
      ctx.font = '12px "Noto Sans SC", "Microsoft YaHei", sans-serif'
      const lines = wrapLines(ctx, node.text ?? '', node.width - 24, Math.max(1, Math.floor((bodyHeight - 16) / 20)))
      lines.forEach((line, index) => ctx.fillText(line, node.x + 12, bodyY + 22 + index * 20))
    } else if (node.kind === 'audio') {
      ctx.fillStyle = palette.placeholder
      roundRect(ctx, node.x + 10, bodyY + 10, node.width - 20, bodyHeight - 20, 8)
      ctx.fill()
      const peaks = asset ? waveforms[asset.id] ?? [] : []
      if (peaks.length) {
        const barWidth = (node.width - 32) / peaks.length
        peaks.forEach((peak, index) => {
          const barHeight = Math.max(2, peak * (bodyHeight - 34))
          ctx.fillStyle = 'rgba(200,174,125,.65)'
          ctx.fillRect(node.x + 16 + index * barWidth, bodyY + bodyHeight - 16 - barHeight, Math.max(1, barWidth - 1), barHeight)
        })
      } else {
        ctx.fillStyle = palette.muted
        ctx.font = '12px "Noto Sans SC", "Microsoft YaHei", sans-serif'
        ctx.fillText('音频素材', node.x + 18, bodyY + 30)
      }
      ctx.fillStyle = palette.muted
      ctx.font = '10px "JetBrains Mono", Consolas, monospace'
      ctx.fillText(asset?.durationSec ? `${asset.durationSec.toFixed(1)}s` : 'audio', node.x + 16, node.y + node.height - 8)
    } else if (image) {
      const ratio = Math.max((node.width - 2) / image.width, (bodyHeight - 2) / image.height)
      const drawWidth = image.width * ratio
      const drawHeight = image.height * ratio
      ctx.drawImage(image, node.x + (node.width - drawWidth) / 2, bodyY + (bodyHeight - drawHeight) / 2, drawWidth, drawHeight)
      const gradient = ctx.createLinearGradient(0, node.y + node.height - 80, 0, node.y + node.height)
      gradient.addColorStop(0, 'rgba(0,0,0,0)')
      gradient.addColorStop(1, 'rgba(0,0,0,.62)')
      ctx.fillStyle = gradient
      ctx.fillRect(node.x, node.y + node.height - 80, node.width, 80)
      if (shot) {
        ctx.fillStyle = 'rgba(255,255,255,.9)'
        ctx.font = '11px "Noto Sans SC", "Microsoft YaHei", sans-serif'
        const desc = wrapLines(ctx, `${shot.shotSize} · ${shot.camera} · ${shot.durationSec}s  ${shot.action}`, node.width - 24, 2)
        desc.forEach((line, index) => ctx.fillText(line, node.x + 12, node.y + node.height - 26 + index * 15))
      } else if (asset) {
        ctx.fillStyle = 'rgba(255,255,255,.86)'
        ctx.font = '11px "Noto Sans SC", "Microsoft YaHei", sans-serif'
        ctx.fillText(asset.title.slice(0, 24), node.x + 12, node.y + node.height - 14)
      }
    } else {
      ctx.fillStyle = palette.placeholder
      roundRect(ctx, node.x + 10, bodyY + 10, node.width - 20, bodyHeight - 20, 8)
      ctx.fill()
      ctx.fillStyle = palette.muted
      ctx.textAlign = 'center'
      ctx.font = '12px "Noto Sans SC", "Microsoft YaHei", sans-serif'
      if (shot) {
        ctx.font = '32px "JetBrains Mono", Consolas, monospace'
        ctx.fillStyle = 'rgba(200,174,125,.55)'
        ctx.fillText(String(shot.number).padStart(2, '0'), node.x + node.width / 2, bodyY + bodyHeight / 2)
        ctx.fillStyle = palette.muted
        ctx.font = '11px "Noto Sans SC", "Microsoft YaHei", sans-serif'
        ctx.fillText(`${shot.shotSize} · ${shot.camera} · ${shot.durationSec}s`, node.x + node.width / 2, bodyY + bodyHeight / 2 + 26)
      } else {
        ctx.fillText('还没有画面', node.x + node.width / 2, bodyY + bodyHeight / 2)
      }
      ctx.textAlign = 'left'
    }
    ctx.restore()
  }
  ctx.restore()

  ctx.fillStyle = palette.text
  ctx.font = '500 24px "Noto Serif SC", "Songti SC", SimSun, serif'
  ctx.fillText(input.title, 38, 46)
  ctx.fillStyle = palette.muted
  ctx.font = '11px "JetBrains Mono", Consolas, monospace'
  ctx.fillText(`STORY CANVAS · ${nodes.length} NODES · ${connections.length} LINKS · ${new Date().toLocaleString('zh-CN')}`, 38, 68)
  ctx.textAlign = 'right'
  ctx.fillText('MORROW CREATIVE STUDIO', width - 38, height - 24)
  ctx.textAlign = 'left'
  return { dataUrl: canvas.toDataURL('image/png'), width, height }
}

export type StudioView = 'home' | 'blueprint' | 'writing' | 'storyboard' | 'canvas' | 'timeline' | 'review' | 'delivery'

export type StudioLibraryFilter = 'all' | 'recent' | 'short' | 'novel' | 'drama' | 'templates'

export type StoryboardTab = 'script' | 'board'

export type TimelineFocus = 'video' | 'dialogue' | 'music' | 'sfx' | 'subtitle'

interface StudioNotice {
  kind: 'info' | 'success' | 'error'
  text: string
  at: number
}

interface StudioState {
  open: boolean
  booted: boolean
  loading: boolean
  busy: boolean
  assistantBusy: boolean
  autoProducing: boolean
  guideOpen: boolean
  demoOpen: boolean
  projects: StudioProjectSummary[]
  engine: StudioEngineStatus | null
  active: StudioProject | null
  view: StudioView
  libraryFilter: StudioLibraryFilter
  search: string
  assistantOpen: boolean
  leftWidth: number
  rightWidth: number
  settingsOpen: boolean
  timelineInspectorOpen: boolean
  outlineOpen: boolean
  factsOpen: boolean
  focusMode: boolean
  storyboardTab: StoryboardTab
  timelineFocus: TimelineFocus
  focusedStage: StudioStageId | null
  selectedChapterId: string | null
  selectedShotId: string | null
  selectedClipId: string | null
  editorDirty: boolean
  saveState: 'saved' | 'saving' | 'error'
  notice: StudioNotice | null
  lastEventAt: number

  openStudio: () => Promise<void>
  closeStudio: () => void
  openGuide: () => void
  closeGuide: () => void
  openDemo: () => void
  closeDemo: () => void
  bootstrap: (force?: boolean) => Promise<void>
  refreshLibrary: () => Promise<void>
  refreshEngine: () => Promise<void>
  openProject: (id: string, view?: StudioView) => Promise<void>
  refreshActive: (silent?: boolean) => Promise<void>
  createProject: (input: StudioCreateInput) => Promise<StudioProject>
  deleteProject: (id: string) => Promise<void>
  duplicateProject: (id: string) => Promise<void>
  updateProject: (patch: { title?: string; logline?: string; brief?: Record<string, unknown>; runtime?: Record<string, unknown>; stage?: StudioStageId }) => Promise<void>
  run: <T = StudioActionResult>(type: string, payload?: Record<string, unknown>) => Promise<T>
  autoProduce: () => Promise<void>
  sendAssistant: (text: string) => Promise<void>
  applyPlan: (planId: string) => Promise<void>
  cancelPlan: (planId: string) => Promise<void>
  cancelJob: (jobId: string) => Promise<void>
  importAssets: (kind: 'image' | 'video' | 'audio', shotId?: string) => Promise<void>
  render: (input: Omit<StudioRenderInput, 'projectId'>) => Promise<void>
  exportProject: (format: StudioExportInput['format']) => Promise<void>
  setView: (view: StudioView) => void
  navigateStage: (stage: StudioStageId) => void
  setLibraryFilter: (filter: StudioLibraryFilter) => void
  setSearch: (search: string) => void
  setAssistantOpen: (open: boolean) => void
  setLeftWidth: (width: number, persist?: boolean) => void
  setRightWidth: (width: number, persist?: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setTimelineInspectorOpen: (open: boolean) => void
  setOutlineOpen: (open: boolean) => void
  setFactsOpen: (open: boolean) => void
  setFocusMode: (on: boolean) => void
  setStoryboardTab: (tab: StoryboardTab) => void
  setTimelineFocus: (focus: TimelineFocus) => void
  selectChapter: (id: string) => void
  selectShot: (id: string | null) => void
  selectClip: (id: string | null) => void
  setEditorDirty: (dirty: boolean) => void
  setSaveState: (state: 'saved' | 'saving' | 'error') => void
  notify: (kind: StudioNotice['kind'], text: string) => void
  clearNotice: () => void
  handleEvent: (event: StudioEvent) => void
}

function viewForStage(kind: StudioProject['kind'], stage: StudioStageId): StudioView {
  if (stage === 'blueprint') return 'blueprint'
  if (stage === 'writing' || stage === 'outline') return kind === 'drama' ? 'storyboard' : 'writing'
  if (stage === 'visuals') return kind === 'drama' ? 'storyboard' : 'writing'
  if (stage === 'storyboard' || stage === 'voice') return 'storyboard'
  if (stage === 'music' || stage === 'timeline') return 'timeline'
  if (stage === 'review') return 'review'
  if (stage === 'delivery') return 'delivery'
  return 'home'
}

function pickChapter(project: StudioProject, preferred?: string | null): string | null {
  if (preferred && project.chapters.some((chapter) => chapter.id === preferred)) {
    const current = project.chapters.find((chapter) => chapter.id === preferred)
    if (current && (current.content.trim() || current.candidates.length)) return preferred
  }
  const pending = project.chapters.find((chapter) => chapter.candidates.length > 0)
  if (pending) return pending.id
  const written = [...project.chapters].filter((chapter) => chapter.content.trim()).sort((a, b) => b.number - a.number)[0]
  if (written) return written.id
  return project.chapters[0]?.id ?? null
}

function pickShot(project: StudioProject, preferred?: string | null): string | null {
  if (preferred && project.shots.some((shot) => shot.id === preferred)) return preferred
  const missing = project.shots.find((shot) => !shot.imageAssetId && !shot.videoAssetId)
  return (missing ?? project.shots[0])?.id ?? null
}

function mergeSummary(list: StudioProjectSummary[], summary: StudioProjectSummary): StudioProjectSummary[] {
  const index = list.findIndex((item) => item.id === summary.id)
  if (index < 0) return [summary, ...list]
  const next = [...list]
  next[index] = { ...next[index], ...summary }
  return next.sort((a, b) => b.updatedAt - a.updatedAt)
}

const SHOT_SCOPED_ACTIONS = new Set([
  'generate-storyboard',
  'sync-storyboard',
  'save-shot',
  'move-shot',
  'update-shots',
  'generate-shot-image',
  'batch-shot-images',
  'generate-shot-video',
  'adopt-shot-asset',
  'import-shot-asset',
  'generate-voice',
  'build-subtitles'
])

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readProject(projectId: string): Promise<StudioProject> {
  const result = await studioApi.action<StudioActionResult>('get', { projectId })
  if (!result.project) throw new Error('作品读回失败。')
  return result.project
}

let lastLoadedProject = ''

try {
  lastLoadedProject = localStorage.getItem('morrow.studio.project') ?? ''
} catch {
  lastLoadedProject = ''
}

function studioGuideSeen(): boolean {
  try {
    return localStorage.getItem('morrow.studio.guideSeen') === '1'
  } catch {
    return true
  }
}

function markStudioGuideSeen(): void {
  try {
    localStorage.setItem('morrow.studio.guideSeen', '1')
  } catch {
    // 本地存储不可用时只在本次会话内记住
  }
}

export const STUDIO_LEFT_MIN = 200

export const STUDIO_LEFT_MAX = 360

export const STUDIO_RIGHT_MIN = 340

export const STUDIO_RIGHT_MAX = 640

function studioWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const stored = Number(localStorage.getItem(key))
    if (Number.isFinite(stored) && stored > 0) return Math.min(max, Math.max(min, Math.round(stored)))
  } catch {
    // 本地存储不可用时使用默认宽度
  }
  return fallback
}

function saveStudioWidth(key: string, width: number): void {
  try {
    localStorage.setItem(key, String(width))
  } catch {
    // 本地存储不可用时只在本次会话内生效
  }
}

export const useStudioStore = create<StudioState>()((set, get) => ({
  open: false,
  booted: false,
  loading: false,
  busy: false,
  assistantBusy: false,
  autoProducing: false,
  guideOpen: false,
  demoOpen: false,
  projects: [],
  engine: null,
  active: null,
  view: 'home',
  libraryFilter: 'all',
  search: '',
  assistantOpen: true,
  leftWidth: studioWidth('morrow.studio.leftWidth', 240, STUDIO_LEFT_MIN, STUDIO_LEFT_MAX),
  rightWidth: studioWidth('morrow.studio.rightWidth', 420, STUDIO_RIGHT_MIN, STUDIO_RIGHT_MAX),
  settingsOpen: false,
  timelineInspectorOpen: false,
  outlineOpen: true,
  factsOpen: false,
  focusMode: false,
  storyboardTab: 'board',
  timelineFocus: 'video',
  focusedStage: null,
  selectedChapterId: null,
  selectedShotId: null,
  selectedClipId: null,
  editorDirty: false,
  saveState: 'saved',
  notice: null,
  lastEventAt: 0,

  async openStudio() {
    set({ open: true, guideOpen: !studioGuideSeen() })
    if (!get().booted) {
      await get().bootstrap()
    } else if (!get().active) {
      const wanted = lastLoadedProject
      if (wanted && get().projects.some((project) => project.id === wanted)) {
        try {
          await get().openProject(wanted)
        } catch {
          set({ view: 'home' })
        }
      } else {
        set({ view: 'home' })
      }
    } else {
      void get().refreshActive(true)
    }
  },

  closeStudio() {
    set({ open: false, focusMode: false, factsOpen: false, demoOpen: false })
  },

  openGuide() {
    set({ guideOpen: true, demoOpen: false })
  },

  closeGuide() {
    markStudioGuideSeen()
    set({ guideOpen: false })
  },

  openDemo() {
    markStudioGuideSeen()
    set({ demoOpen: true, guideOpen: false })
  },

  closeDemo() {
    set({ demoOpen: false })
  },

  async bootstrap(force = false) {
    if (get().loading) return
    if (get().booted && !force) return
    set({ loading: true })
    try {
      const result = await studioApi.list()
      set({ projects: result.projects, engine: result.engine, booted: true })
      const current = get().active
      if (current) {
        const exists = result.projects.some((project) => project.id === current.id)
        if (!exists) set({ active: null, view: 'home' })
        else await get().refreshActive(true)
      } else {
        const wanted = lastLoadedProject
        if (wanted && result.projects.some((project) => project.id === wanted)) {
          try {
            await get().openProject(wanted)
          } catch {
            set({ view: 'home' })
          }
        } else {
          set({ view: 'home' })
        }
      }
    } catch (err) {
      get().notify('error', errorMessage(err))
    } finally {
      set({ loading: false })
    }
  },

  async refreshLibrary() {
    try {
      const result = await studioApi.list()
      set({ projects: result.projects, engine: result.engine, booted: true })
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  async refreshEngine() {
    try {
      const engine = await studioApi.status()
      set({ engine })
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  async openProject(id, view) {
    set({ loading: true })
    try {
      const result = await studioApi.get(id)
      const project = result.project
      const stageView = view ?? viewForStage(project.kind, project.stage)
      const selectedChapterId = pickChapter(project, get().selectedChapterId)
      set({
        active: project,
        view: stageView,
        selectedChapterId,
        selectedShotId: null,
        selectedClipId: null,
        timelineInspectorOpen: false,
        editorDirty: false,
        saveState: 'saved',
        storyboardTab: project.kind === 'drama' && project.shots.every((shot) => shot.imageAssetId || shot.videoAssetId) ? 'board' : project.kind === 'drama' ? 'script' : 'board',
        focusedStage: project.stage
      })
      try {
        localStorage.setItem('morrow.studio.project', project.id)
      } catch {
      }
    } catch (err) {
      get().notify('error', errorMessage(err))
      set({ view: 'home' })
      throw err
    } finally {
      set({ loading: false })
    }
  },

  async refreshActive(silent = false) {
    const active = get().active
    if (!active) return
    try {
      const result = await studioApi.get(active.id)
      const project = result.project
      set((state) => ({
        active: project,
        projects: mergeSummary(state.projects, {
          id: project.id,
          kind: project.kind,
          title: project.title,
          logline: project.logline,
          updatedAt: project.updatedAt,
          createdAt: project.createdAt,
          stage: project.stage,
          progress: state.projects.find((item) => item.id === project.id)?.progress ?? 0,
          words: state.projects.find((item) => item.id === project.id)?.words ?? 0,
          chapters: project.chapters.length,
          shots: project.shots.length,
          assets: project.assets.length,
          budget: project.runtime.budget,
          ...(project.coverAssetId ? { coverUrl: project.assets.find((asset) => asset.id === project.coverAssetId)?.thumbUrl ?? project.assets.find((asset) => asset.id === project.coverAssetId)?.url } : {}),
          demo: project.demo,
          missingVisuals: project.shots.filter((shot) => !shot.imageAssetId && !shot.videoAssetId).length
        }),
        selectedChapterId: pickChapter(project, state.selectedChapterId),
        selectedShotId: state.selectedShotId && project.shots.some((shot) => shot.id === state.selectedShotId)
          ? state.selectedShotId
          : null,
        selectedClipId: state.selectedClipId && project.timeline.clips.some((clip) => clip.id === state.selectedClipId)
          ? state.selectedClipId
          : null
      }))
    } catch (err) {
      if (!silent) get().notify('error', errorMessage(err))
    }
  },

  async createProject(input) {
    set({ busy: true })
    try {
      const result = await studioApi.create(input)
      const project = result.project
      set({
        active: project,
        view: 'blueprint',
        selectedChapterId: null,
        selectedShotId: null,
        selectedClipId: null,
        storyboardTab: 'script'
      })
      try {
        localStorage.setItem('morrow.studio.project', project.id)
      } catch {
      }
      await get().refreshLibrary()
      return project
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    } finally {
      set({ busy: false })
    }
  },

  async deleteProject(id) {
    set({ busy: true })
    try {
      await studioApi.action('delete', { projectId: id })
      const projects = get().projects.filter((project) => project.id !== id)
      const active = get().active
      set({ projects, ...(active?.id === id ? { active: null, view: 'home' as StudioView } : {}) })
      get().notify('success', '作品已移入回收站，可在创作台设置 → 回收站恢复。')
      await get().refreshLibrary()
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    } finally {
      set({ busy: false })
    }
  },

  async duplicateProject(id) {
    set({ busy: true })
    try {
      const result = await studioApi.action('duplicate', { projectId: id })
      await get().refreshLibrary()
      await get().openProject(result.project.id)
      get().notify('success', '已复制一个作品。')
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    } finally {
      set({ busy: false })
    }
  },

  async updateProject(patch) {
    const active = get().active
    if (!active) return
    try {
      const result = await studioApi.action('update-meta', { projectId: active.id, ...patch })
      set({ active: result.project })
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    }
  },

  async run<T = StudioActionResult>(type: string, payload: Record<string, unknown> = {}) {
    const active = get().active
    try {
      const result = await studioApi.action<T>(type, { ...payload, ...(active ? { projectId: active.id } : {}) })
      const typed = result as unknown as StudioActionResult
      if (typed?.project) {
        set((state) => ({
          active: typed.project,
          selectedChapterId: pickChapter(typed.project, state.selectedChapterId),
          selectedShotId: SHOT_SCOPED_ACTIONS.has(type)
            ? pickShot(typed.project, state.selectedShotId)
            : state.selectedShotId && typed.project.shots.some((shot) => shot.id === state.selectedShotId)
              ? state.selectedShotId
              : null,
          selectedClipId: state.selectedClipId && typed.project.timeline.clips.some((clip) => clip.id === state.selectedClipId)
            ? state.selectedClipId
            : typed.project.timeline.clips[0]?.id ?? null
        }))
      }
      return result
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    }
  },

  async autoProduce() {
    const initial = get().active
    if (!initial || get().autoProducing) return
    set({ autoProducing: true })
    const notify = get().notify
    const projectId = initial.id
    const waitJob = async (jobId: string | undefined, label: string): Promise<StudioProject> => {
      if (!jobId) return readProject(projectId)
      const started = Date.now()
      while (Date.now() - started < 20 * 60_000) {
        const project = await readProject(projectId)
        set({ active: project })
        const job = project.jobs.find((item) => item.id === jobId)
        if (job && (job.status === 'done' || job.status === 'review')) return project
        if (job && (job.status === 'failed' || job.status === 'cancelled')) throw new Error(`${label}失败：${job.message}`)
        await sleep(1500)
      }
      throw new Error(`${label}等待超时；任务仍在后台，可稍后回来看结果。`)
    }
    const runJob = async (type: string, payload: Record<string, unknown>, label: string): Promise<StudioProject> => {
      notify('info', `一键试做：${label}…`)
      const result = await get().run(type, payload)
      return waitJob(result.job?.id, label)
    }
    try {
      let project = await readProject(projectId)
      if (!project.blueprint) {
        project = await runJob('generate-blueprint', { useModel: true, requestId: `auto-bp-${Date.now()}` }, '生成蓝图')
      }
      if (!project.blueprint?.approved) {
        await get().run('approve-blueprint')
        project = await readProject(projectId)
        set({ active: project })
      }
      if (project.stages.outline.status !== 'done' && project.stages.outline.status !== 'review') {
        project = await runJob('generate-outline', { useModel: true, requestId: `auto-outline-${Date.now()}` }, '细化大纲')
      }
      if (project.kind === 'drama') {
        if (project.stages.storyboard.status !== 'done' && project.stages.storyboard.status !== 'review') {
          project = await runJob('generate-storyboard', { requestId: `auto-board-${Date.now()}` }, '生成分镜')
        }
        const missingImages = project.shots.filter((shot) => !shot.imageAssetId && !shot.videoAssetId)
        if (missingImages.length) {
          try {
            project = await runJob('batch-shot-images', { shotIds: missingImages.map((shot) => shot.id), requestId: `auto-img-${Date.now()}` }, `补齐 ${missingImages.length} 镜画面`)
          } catch (err) {
            notify('error', `画面没有补齐：${errorMessage(err)}。可以导入现成图片后继续。`)
          }
        }
        const missingVoice = project.shots.filter((shot) => shot.dialogue.trim() && !shot.voiceAssetId)
        if (missingVoice.length) {
          try {
            project = await runJob('generate-voice', { shotIds: missingVoice.map((shot) => shot.id), requestId: `auto-voice-${Date.now()}` }, `补齐 ${missingVoice.length} 段配音`)
          } catch (err) {
            notify('error', `配音没有补齐：${errorMessage(err)}。可以稍后逐镜重配。`)
          }
        }
        if (!project.assets.some((asset) => asset.kind === 'audio' && asset.tags.includes('music') && !asset.tags.includes('draft'))) {
          try {
            project = await runJob('generate-music', { kind: 'music', requestId: `auto-music-${Date.now()}` }, '生成配乐')
          } catch {
            try {
              project = await runJob('generate-music', { kind: 'music', engine: 'local', requestId: `auto-music-local-${Date.now()}` }, '生成本地配乐草稿')
            } catch (err) {
              notify('error', `配乐没有生成：${errorMessage(err)}。草稿合成仍可继续。`)
            }
          }
        }
        notify('info', '一键试做：装配时间线…')
        await get().run('build-timeline', { force: true })
        project = await readProject(projectId)
        set({ active: project })
        if (project.shots.some((shot) => shot.dialogue.trim())) {
          notify('info', '一键试做：拆分逐句字幕…')
          await get().run('build-subtitles', { requestId: `auto-subtitles-${Date.now()}` })
          project = await readProject(projectId)
          set({ active: project })
        }
        await get().run('review')
        project = await readProject(projectId)
        set({ active: project })
        project = await runJob('render', { quality: 'draft', allowMissing: true, requestId: `auto-render-${Date.now()}` }, '合成草稿')
        notify(project.stages.delivery.status === 'done' ? 'success' : 'info', project.stages.delivery.status === 'done' ? '一键试做完成：草稿已合成，可在交付页查看。' : '草稿已合成，但有缺失素材需要核对。')
      } else {
        let rounds = 0
        while (rounds < 30) {
          rounds += 1
          project = await readProject(projectId)
          set({ active: project })
          const empty = project.chapters.filter((chapter) => !chapter.content.trim())
          if (!empty.length) break
          const before = project.chapters.filter((chapter) => chapter.content.trim()).length
          project = await runJob('batch-write', { count: Math.min(10, empty.length), useModel: true, requestId: `auto-write-${Date.now()}-${rounds}` }, `写第 ${before + 1}–${Math.min(project.chapters.length, before + 10)} 章`)
          const after = project.chapters.filter((chapter) => chapter.content.trim()).length
          if (after <= before) break
        }
        await get().run('review')
        try {
          project = await runJob('model-review', { requestId: `auto-review-${Date.now()}` }, '模型审稿')
        } catch (err) {
          notify('error', `模型审稿没有完成：${errorMessage(err)}。本地检查结果仍然保留。`)
        }
        project = await readProject(projectId)
        set({ active: project })
        const written = project.chapters.filter((chapter) => chapter.content.trim()).length
        const complete = written >= project.chapters.length
        notify(complete ? 'success' : 'info', `一键试做${complete ? '完成' : '暂停'}：${written}/${project.chapters.length} 章有正文，检查已更新${complete ? '。' : '；可以继续一键写完剩余章。'}`)
      }
    } catch (err) {
      notify('error', `一键试做中断：${errorMessage(err)}`)
    } finally {
      const latest = await readProject(projectId).catch(() => null)
      set({ autoProducing: false, ...(latest ? { active: latest } : {}) })
    }
  },

  async sendAssistant(text) {
    const active = get().active
    if (!active) return
    const selection = (() => {
      const state = get()
      if (state.selectedClipId) return { kind: 'clip' as const, id: state.selectedClipId }
      if (state.view === 'writing' && state.selectedChapterId) return { kind: 'chapter' as const, id: state.selectedChapterId }
      if (state.selectedShotId) return { kind: 'shot' as const, id: state.selectedShotId }
      return undefined
    })()
    set({ assistantBusy: true })
    try {
      const result = await studioApi.assistant({ projectId: active.id, text, ...(selection ? { selection } : {}) })
      set({ active: result.project })
      if (result.message) get().notify('info', result.message)
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    } finally {
      set({ assistantBusy: false })
    }
  },

  async applyPlan(planId) {
    const active = get().active
    if (!active) return
    set({ assistantBusy: true })
    try {
      const result = await studioApi.action('apply-plan', { projectId: active.id, planId })
      set({ active: result.project })
      if (result.job) get().notify('info', '计划已应用，重做任务已排队。')
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    } finally {
      set({ assistantBusy: false })
    }
  },

  async cancelPlan(planId) {
    const active = get().active
    if (!active) return
    try {
      await studioApi.action('cancel-plan', { projectId: active.id, planId })
      await get().refreshActive(true)
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  async cancelJob(jobId) {
    const active = get().active
    if (!active) return
    try {
      const result = await studioApi.action('cancel-job', { projectId: active.id, jobId })
      set({ active: result.project })
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  async importAssets(kind, shotId) {
    const active = get().active
    if (!active) return
    try {
      const paths = await studioApi.pickImport(kind, { title: kind === 'image' ? '导入画面' : kind === 'video' ? '导入视频' : '导入音频' })
      for (const path of paths) {
        const result = await studioApi.action('import-asset', {
          projectId: active.id,
          path,
          ...(shotId ? { shotId } : {})
        })
        set({ active: result.project })
      }
      if (paths.length) get().notify('success', `已导入 ${paths.length} 个素材。`)
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  async render(input) {
    const active = get().active
    if (!active) return
    try {
      const result = await studioApi.render({ ...input, projectId: active.id })
      set({ active: result.project })
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    }
  },

  async exportProject(format) {
    const active = get().active
    if (!active) return
    try {
      const result = await studioApi.exportProject({ projectId: active.id, format })
      set({ active: result.project })
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    }
  },

  setView(view) {
    const stage: StudioStageId | null = view === 'home' ? null : view === 'blueprint' ? 'blueprint' : view === 'writing' ? 'writing' : view === 'storyboard' ? 'storyboard' : view === 'timeline' ? 'timeline' : view === 'review' ? 'review' : view === 'delivery' ? 'delivery' : null
    set({ view, focusMode: false, ...(stage ? { focusedStage: stage } : {}) })
  },

  navigateStage(stage) {
    const active = get().active
    if (!active) return
    const stageView = viewForStage(active.kind, stage)
    const missingVisual = active.shots.find((shot) => !shot.imageAssetId && !shot.videoAssetId)
    const missingVoice = active.shots.find((shot) => shot.dialogue.trim() && !shot.voiceAssetId)
    const focusShot = stage === 'voice' ? missingVoice ?? active.shots[0] : stage === 'visuals' || stage === 'storyboard' ? missingVisual ?? active.shots[0] : null
    const focusClip = stage === 'music'
      ? active.timeline.clips.find((clip) => clip.kind === 'music')
      : stage === 'voice'
        ? active.timeline.clips.find((clip) => clip.kind === 'dialogue')
        : undefined
    set({
      view: stageView,
      focusedStage: stage,
      focusMode: false,
      ...(stage !== 'storyboard' && stage !== 'visuals' && stage !== 'voice' ? { selectedShotId: null } : {}),
      ...(stage !== 'timeline' && stage !== 'music' ? { timelineInspectorOpen: false } : {}),
      ...(stage === 'outline' ? (active.kind === 'drama' ? { storyboardTab: 'script' as StoryboardTab } : { outlineOpen: true }) : {}),
      ...(active.kind === 'drama' && (stage === 'storyboard' || stage === 'visuals' || stage === 'voice')
        ? { storyboardTab: 'board' as StoryboardTab, ...(focusShot ? { selectedShotId: focusShot.id } : {}) }
        : {}),
      ...(stage === 'music' ? { timelineFocus: 'music' as TimelineFocus } : {}),
      ...(stage === 'voice' ? { timelineFocus: 'dialogue' as TimelineFocus } : {}),
      ...(stage === 'timeline' ? { timelineFocus: 'video' as TimelineFocus } : {}),
      ...(focusClip ? { selectedClipId: focusClip.id, timelineInspectorOpen: true } : {})
    })
  },

  setLibraryFilter(filter) {
    set({ libraryFilter: filter })
  },
  setSearch(search) {
    set({ search })
  },
  setAssistantOpen(open) {
    set({ assistantOpen: open })
  },

  setLeftWidth(width, persist = false) {
    const next = Math.min(STUDIO_LEFT_MAX, Math.max(STUDIO_LEFT_MIN, Math.round(width)))
    set({ leftWidth: next })
    if (persist) saveStudioWidth('morrow.studio.leftWidth', next)
  },

  setRightWidth(width, persist = false) {
    const next = Math.min(STUDIO_RIGHT_MAX, Math.max(STUDIO_RIGHT_MIN, Math.round(width)))
    set({ rightWidth: next })
    if (persist) saveStudioWidth('morrow.studio.rightWidth', next)
  },
  setSettingsOpen(open) {
    set({ settingsOpen: open })
  },
  setTimelineInspectorOpen(open) {
    set({ timelineInspectorOpen: open })
  },
  setOutlineOpen(open) {
    set({ outlineOpen: open })
  },
  setFactsOpen(open) {
    set({ factsOpen: open })
  },
  setFocusMode(on) {
    set({ focusMode: on })
  },
  setStoryboardTab(tab) {
    set({ storyboardTab: tab })
  },
  setTimelineFocus(focus) {
    set({ timelineFocus: focus })
  },
  selectChapter(id) {
    set({ selectedChapterId: id, view: 'writing', outlineOpen: true })
    try {
      localStorage.setItem('morrow.studio.chapter', id)
    } catch {
    }
  },
  selectShot(id) {
    set({ selectedShotId: id })
  },
  selectClip(id) {
    set({ selectedClipId: id })
  },
  setEditorDirty(dirty) {
    set({ editorDirty: dirty })
  },
  setSaveState(state) {
    set({ saveState: state })
  },

  notify(kind, text) {
    set({ notice: { kind, text, at: Date.now() } })
  },
  clearNotice() {
    set({ notice: null })
  },

  handleEvent(event) {
    set({ lastEventAt: Date.now() })
    if (event.type === 'project') {
      set((state) => ({ projects: mergeSummary(state.projects, event.summary) }))
      return
    }
    const job = event.job
    set((state) => {
      if (!state.active || state.active.id !== job.projectId) return state
      const jobs = state.active.jobs.some((item) => item.id === job.id)
        ? state.active.jobs.map((item) => (item.id === job.id ? job : item))
        : [...state.active.jobs, job]
      return { active: { ...state.active, jobs } }
    })
    if (job.status !== 'queued' && job.status !== 'running') {
      if (!get().editorDirty) {
        window.setTimeout(() => {
          void get().refreshActive(true)
          void get().refreshEngine()
        }, 180)
      }
      if (job.status === 'failed') get().notify('error', job.error || job.message)
      else if (job.status === 'review') get().notify('info', job.message)
    }
  }
}))
