import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Boxes,
  Clapperboard,
  Copy,
  Download,
  ExternalLink,
  Film,
  GitBranch,
  Image as ImageIcon,
  ImagePlus,
  LayoutGrid,
  Loader2,
  Maximize2,
  Mic2,
  Music2,
  Plus,
  Redo2,
  Search,
  Trash2,
  Type,
  Undo2,
  Ungroup,
  Video,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type {
  StudioAsset,
  StudioCanvasConnection,
  StudioCanvasGroup,
  StudioCanvasNode,
  StudioCanvasNodeKind,
  StudioCanvasViewport,
  StudioShot
} from '@shared/studio'
import { Button } from '../../ui'
import { useStudioStore } from './studio-store'
import { renderCanvasSnapshot } from './canvas-snapshot'

interface CanvasSnapshot {
  nodes: StudioCanvasNode[]
  connections: StudioCanvasConnection[]
  groups: StudioCanvasGroup[]
  viewport: StudioCanvasViewport
}

interface DragState {
  mode: 'node' | 'resize' | 'pan' | 'link' | 'marquee' | 'group'
  nodeId?: string
  groupId?: string
  startClientX: number
  startClientY: number
  originX?: number
  originY?: number
  originWidth?: number
  originHeight?: number
  originViewport?: StudioCanvasViewport
  origins?: Record<string, { x: number; y: number }>
  startWorldX?: number
  startWorldY?: number
  additive?: boolean
}

const MIN_ZOOM = 0.2
const MAX_ZOOM = 2.5
const GRID_SIZE = 26

function nodeId(kind: StudioCanvasNodeKind): string {
  return `canvas_${kind}_${crypto.randomUUID()}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function assetUrl(asset: StudioAsset | undefined): string | undefined {
  return asset?.thumbUrl ?? asset?.url
}

function shotImage(project: NonNullable<ReturnType<typeof useStudioStore.getState>['active']>, shot: StudioShot): StudioAsset | undefined {
  return project.assets.find((asset) => asset.id === (shot.imageAssetId ?? shot.videoAssetId))
}

function CanvasAudio({ asset, peaks }: { asset: StudioAsset; peaks?: number[] }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  useEffect(() => () => {
    audioRef.current?.pause()
  }, [])
  const toggle = (): void => {
    if (!audioRef.current) audioRef.current = new Audio(asset.url ?? '')
    if (playing) {
      audioRef.current.pause()
      setPlaying(false)
      return
    }
    void audioRef.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
  }
  return (
    <div className="studio-canvas-audio" data-canvas-interactive>
      <button type="button" onClick={toggle} aria-label={playing ? '暂停音频' : '播放音频'}>
        {playing ? <span className="studio-canvas-audio-pause" /> : <span className="studio-canvas-audio-play" />}
      </button>
      <div className="studio-canvas-wave" aria-hidden>
        {peaks?.length ? peaks.map((peak, index) => <i key={index} style={{ height: `${Math.max(4, Math.round(peak * 100))}%` }} />) : <span className="studio-canvas-wave-empty">波形分析中</span>}
      </div>
      <span className="mono">{asset.durationSec ? `${asset.durationSec.toFixed(1)}s` : '音频'}</span>
    </div>
  )
}

export function CanvasView(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const setView = useStudioStore((state) => state.setView)
  const selectShot = useStudioStore((state) => state.selectShot)
  const notify = useStudioStore((state) => state.notify)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const historyRef = useRef<CanvasSnapshot[]>([])
  const futureRef = useRef<CanvasSnapshot[]>([])
  const changeRef = useRef(0)
  const savingRef = useRef(false)
  const seededRef = useRef('')
  const syncedAtRef = useRef(0)
  const [nodes, setNodes] = useState<StudioCanvasNode[]>([])
  const [connections, setConnections] = useState<StudioCanvasConnection[]>([])
  const [groups, setGroups] = useState<StudioCanvasGroup[]>([])
  const [viewport, setViewport] = useState<StudioCanvasViewport>({ x: 96, y: 72, zoom: 0.8 })
  const [initialized, setInitialized] = useState(active?.canvas.initialized === true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [linking, setLinking] = useState<{ fromNodeId: string; x: number; y: number } | null>(null)
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; x: number; y: number; additive: boolean } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [paletteOpen, setPaletteOpen] = useState(true)
  const [paletteTab, setPaletteTab] = useState<'shots' | 'images' | 'audio'>('shots')
  const [query, setQuery] = useState('')
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({})
  const [shotJobs, setShotJobs] = useState<Record<string, string>>({})
  const [generating, setGenerating] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const nodesRef = useRef(nodes)
  const connectionsRef = useRef(connections)
  const groupsRef = useRef(groups)
  const viewportRef = useRef(viewport)
  const pendingSaveRef = useRef(false)
  const spaceRef = useRef(false)
  const waveformPendingRef = useRef(new Set<string>())
  nodesRef.current = nodes
  connectionsRef.current = connections
  groupsRef.current = groups
  viewportRef.current = viewport

  useEffect(() => {
    if (!active) return
    setNodes(active.canvas.nodes.map((node) => ({ ...node })))
    setConnections(active.canvas.connections.map((edge) => ({ ...edge })))
    setGroups((active.canvas.groups ?? []).map((group) => ({ ...group, nodeIds: [...group.nodeIds] })))
    setViewport({ ...active.canvas.viewport })
    setInitialized(active.canvas.initialized === true)
    syncedAtRef.current = active.canvas.updatedAt
    setSelectedId(null)
    setSelectedIds([])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    setDirty(false)
    setSaveState('saved')
    setShotJobs({})
    historyRef.current = []
    futureRef.current = []
    seededRef.current = ''
    // 只跟随作品切换；画布本地编辑不被后台项目刷新覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id])

  useEffect(() => {
    if (!active || active.kind !== 'drama' || initialized || active.canvas.initialized === true || active.canvas.nodes.length > 0 || seededRef.current === active.id) return
    seededRef.current = active.id
    const shotNodes: StudioCanvasNode[] = active.shots.map((shot, index) => ({
      id: nodeId('shot'),
      kind: 'shot',
      title: `镜 ${String(shot.number).padStart(2, '0')} · ${shot.title}`,
      x: 120 + (index % 4) * 280,
      y: 120 + Math.floor(index / 4) * 220,
      width: 246,
      height: 186,
      z: index + 1,
      shotId: shot.id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }))
    const audioAssets = active.assets.filter((asset) => asset.kind === 'audio' && (asset.tags.includes('music') || asset.tags.includes('voice'))).slice(0, 3)
    const audioNodes: StudioCanvasNode[] = audioAssets.map((asset, index) => ({
      id: nodeId('audio'),
      kind: 'audio',
      title: asset.title,
      x: 120 + index * 320,
      y: 120 + Math.ceil(active.shots.length / 4) * 220 + 12,
      width: 300,
      height: 122,
      z: 100 + index,
      assetId: asset.id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }))
    const noteNode: StudioCanvasNode = {
      id: nodeId('text'),
      kind: 'text',
      title: '画布说明',
      x: 1100,
      y: 90,
      width: 280,
      height: 154,
      z: 200,
      text: '把镜头、画面、配音和音乐拖到一起；从节点右侧拉线，记录参考与生成关系。\n\n画布只保存工作流，不替代时间线。',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    const seeded = [...shotNodes, ...audioNodes, noteNode]
    setNodes(seeded)
    setConnections([])
    setGroups([])
    setInitialized(true)
    setDirty(true)
    setSelectedId(shotNodes[0]?.id ?? null)
    setSelectedIds(shotNodes[0] ? [shotNodes[0].id] : [])
  }, [active, initialized])

  const persist = async (): Promise<void> => {
    if (!active) return
    if (savingRef.current) {
      pendingSaveRef.current = true
      return
    }
    savingRef.current = true
    setSaveState('saving')
    const version = changeRef.current
    try {
      await run('save-canvas', {
        canvas: {
          version: 1,
          initialized: true,
          nodes: nodesRef.current,
          connections: connectionsRef.current,
          groups: groupsRef.current,
          viewport: viewportRef.current
        }
      })
      if (changeRef.current === version) {
        setDirty(false)
        setSaveState('saved')
      }
    } catch {
      setSaveState('error')
    } finally {
      savingRef.current = false
    }
    if (pendingSaveRef.current || changeRef.current !== version) {
      pendingSaveRef.current = false
      void persist()
    }
  }

  useEffect(() => {
    if (!active || dirty) return
    if (active.canvas.updatedAt <= syncedAtRef.current) return
    syncedAtRef.current = active.canvas.updatedAt
    setNodes(active.canvas.nodes.map((node) => ({ ...node })))
    setConnections(active.canvas.connections.map((edge) => ({ ...edge })))
    setGroups((active.canvas.groups ?? []).map((group) => ({ ...group, nodeIds: [...group.nodeIds] })))
    setViewport({ ...active.canvas.viewport })
    setInitialized(active.canvas.initialized === true)
  }, [active?.canvas.updatedAt, dirty])

  useEffect(() => {
    if (!dirty || !active) return
    const timer = window.setTimeout(() => {
      void persist()
    }, 700)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, active?.id, nodes, connections, groups, viewport])

  useEffect(() => {
    if (!active) return
    for (const node of nodes) {
      if (node.kind !== 'audio' || !node.assetId || waveforms[node.assetId] || waveformPendingRef.current.has(node.assetId)) continue
      waveformPendingRef.current.add(node.assetId)
      void run<{ peaks: number[] }>('asset-waveform', { assetId: node.assetId })
        .then((result) => {
          if (result?.peaks?.length) setWaveforms((current) => ({ ...current, [node.assetId!]: result.peaks }))
        })
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, nodes.length, active?.assets.length])

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (event.code === 'Space') {
        spaceRef.current = event.type === 'keydown'
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        undo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelected()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectAll()
        return
      }
      if (event.key.toLowerCase() === 'g' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        if (selectedIds.length >= 2) groupSelection()
        else if (selectedGroupId) ungroupSelection()
        return
      }
      if (event.key === 'Escape') {
        setSelectedId(null)
        setSelectedIds([])
        setSelectedGroupId(null)
        setSelectedEdgeId(null)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelected()
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') spaceRef.current = false
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, connections, groups, selectedIds, selectedGroupId, selectedEdgeId])

  if (!active) return <div className="studio-canvas-empty">先打开一部漫剧作品。</div>
  if (active.kind !== 'drama') {
    return (
      <div className="studio-canvas-empty">
        <Clapperboard size={26} strokeWidth={1.2} />
        <h2>画布属于漫剧时间线</h2>
        <p>小说改编为漫剧后，可以在画布里组织镜头、画面、配音和音乐。</p>
        <Button variant="gold" onClick={() => setView('writing')}>回到写作台</Button>
      </div>
    )
  }

  const snapshot = (): CanvasSnapshot => ({
    nodes: nodes.map((node) => ({ ...node })),
    connections: connections.map((edge) => ({ ...edge })),
    groups: groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })),
    viewport: { ...viewport }
  })
  const pushHistory = (): void => {
    historyRef.current.push(snapshot())
    if (historyRef.current.length > 60) historyRef.current.shift()
    futureRef.current = []
  }
  const applySnapshot = (next: CanvasSnapshot): void => {
    setNodes(next.nodes.map((node) => ({ ...node })))
    setConnections(next.connections.map((edge) => ({ ...edge })))
    setGroups(next.groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })))
    setViewport({ ...next.viewport })
    setSelectedId(null)
    setSelectedIds([])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    setDirty(true)
    changeRef.current += 1
  }
  const undo = (): void => {
    const previous = historyRef.current.pop()
    if (!previous) return
    futureRef.current.push(snapshot())
    applySnapshot(previous)
    notify('info', '已撤销画布操作。')
  }
  const redo = (): void => {
    const next = futureRef.current.pop()
    if (!next) return
    historyRef.current.push(snapshot())
    applySnapshot(next)
  }
  const markChanged = (): void => {
    setDirty(true)
    setSaveState('saving')
    changeRef.current += 1
  }
  const updateNode = (id: string, patch: Partial<StudioCanvasNode>, history = false): void => {
    if (history) pushHistory()
    setNodes((list) => list.map((node) => node.id === id ? { ...node, ...patch, updatedAt: Date.now() } : node))
    markChanged()
  }
  const updateEdge = (id: string, patch: Partial<StudioCanvasConnection>, history = false): void => {
    if (history) pushHistory()
    setConnections((list) => list.map((edge) => edge.id === id ? { ...edge, ...patch } : edge))
    markChanged()
  }
  const selectOnly = (id: string | null): void => {
    setSelectedId(id)
    setSelectedIds(id ? [id] : [])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
  }
  const toggleSelection = (id: string): void => {
    setSelectedIds((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      setSelectedId(next[next.length - 1] ?? null)
      setSelectedGroupId(null)
      setSelectedEdgeId(null)
      return next
    })
  }
  const selectAll = (): void => {
    setSelectedIds(nodes.map((node) => node.id))
    setSelectedId(nodes[nodes.length - 1]?.id ?? null)
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
  }
  const selectedNode = selectedIds.length === 1 ? nodes.find((node) => node.id === selectedIds[0]) ?? null : null
  const selectedEdge = connections.find((edge) => edge.id === selectedEdgeId) ?? null
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null
  const selectedSet = new Set(selectedIds)
  const stagePoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: (clientX - rect.left - viewport.x) / viewport.zoom, y: (clientY - rect.top - viewport.y) / viewport.zoom }
  }
  const viewportCenter = (): { x: number; y: number } => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return { x: 500, y: 300 }
    return stagePoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }
  const zoomAt = (nextZoom: number, clientX?: number, clientY?: number): void => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
    const x = clientX ?? rect.left + rect.width / 2
    const y = clientY ?? rect.top + rect.height / 2
    const world = stagePoint(x, y)
    setViewport({ x: x - rect.left - world.x * zoom, y: y - rect.top - world.y * zoom, zoom })
  }
  const fit = (): void => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || !nodes.length) return
    const minX = Math.min(...nodes.map((node) => node.x))
    const minY = Math.min(...nodes.map((node) => node.y))
    const maxX = Math.max(...nodes.map((node) => node.x + node.width))
    const maxY = Math.max(...nodes.map((node) => node.y + node.height))
    const zoom = clamp(Math.min((rect.width - 100) / Math.max(1, maxX - minX), (rect.height - 100) / Math.max(1, maxY - minY)), MIN_ZOOM, 1.3)
    setViewport({ x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom, zoom })
  }
  const addNode = (node: StudioCanvasNode): void => {
    pushHistory()
    setNodes((list) => [...list, node])
    setSelectedId(node.id)
    setSelectedIds([node.id])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    markChanged()
  }
  const addShotNode = (shot: StudioShot): void => {
    const existing = nodes.find((node) => node.kind === 'shot' && node.shotId === shot.id)
    if (existing) {
      selectOnly(existing.id)
      return
    }
    const center = viewportCenter()
    addNode({
      id: nodeId('shot'),
      kind: 'shot',
      title: `镜 ${String(shot.number).padStart(2, '0')} · ${shot.title}`,
      x: center.x - 123,
      y: center.y - 93,
      width: 246,
      height: 186,
      z: nodes.reduce((max, node) => Math.max(max, node.z), 0) + 1,
      shotId: shot.id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }
  const addAssetNode = (asset: StudioAsset): void => {
    const existing = nodes.find((node) => node.assetId === asset.id)
    if (existing) {
      selectOnly(existing.id)
      return
    }
    const kind: StudioCanvasNodeKind = asset.kind === 'audio' ? 'audio' : asset.kind === 'video' ? 'video' : 'image'
    const center = viewportCenter()
    const width = kind === 'audio' ? 300 : kind === 'video' ? 320 : 260
    const height = kind === 'audio' ? 122 : kind === 'video' ? 210 : 200
    addNode({
      id: nodeId(kind),
      kind,
      title: asset.title,
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
      z: nodes.reduce((max, node) => Math.max(max, node.z), 0) + 1,
      assetId: asset.id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }
  const addTextNode = (): void => {
    const center = viewportCenter()
    addNode({
      id: nodeId('text'),
      kind: 'text',
      title: '文本节点',
      x: center.x - 120,
      y: center.y - 70,
      width: 240,
      height: 140,
      z: nodes.reduce((max, node) => Math.max(max, node.z), 0) + 1,
      text: '写一个意图、参考或制作备注……',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }
  const autoLayout = (): void => {
    const shotNodes = nodes.filter((node) => node.kind === 'shot').sort((a, b) => {
      const shotA = active.shots.find((shot) => shot.id === a.shotId)?.number ?? 0
      const shotB = active.shots.find((shot) => shot.id === b.shotId)?.number ?? 0
      return shotA - shotB
    })
    if (!shotNodes.length) return
    pushHistory()
    const positions = new Map(shotNodes.map((node, index) => [node.id, { x: 120 + (index % 4) * 280, y: 120 + Math.floor(index / 4) * 220 }]))
    setNodes((list) => list.map((node) => positions.has(node.id) ? { ...node, ...positions.get(node.id)!, updatedAt: Date.now() } : node))
    markChanged()
    notify('info', '镜头节点已按镜号排布。')
  }
  const autoConnect = (): void => {
    const shotNodes = nodes.filter((node) => node.kind === 'shot').sort((a, b) => {
      const shotA = active.shots.find((shot) => shot.id === a.shotId)?.number ?? 0
      const shotB = active.shots.find((shot) => shot.id === b.shotId)?.number ?? 0
      return shotA - shotB
    })
    if (shotNodes.length < 2) return
    pushHistory()
    const existing = new Set(connections.map((edge) => `${edge.fromNodeId}->${edge.toNodeId}`))
    const next = [...connections]
    for (let index = 0; index < shotNodes.length - 1; index += 1) {
      const key = `${shotNodes[index].id}->${shotNodes[index + 1].id}`
      if (existing.has(key)) continue
      next.push({ id: `canvas_edge_${crypto.randomUUID()}`, fromNodeId: shotNodes[index].id, toNodeId: shotNodes[index + 1].id, label: '顺序' })
    }
    setConnections(next)
    markChanged()
    notify('info', '已按镜号自动连线。')
  }
  const duplicateSelected = (): void => {
    const sources = nodes.filter((node) => selectedSet.has(node.id))
    if (!sources.length) return
    pushHistory()
    let z = nodes.reduce((max, node) => Math.max(max, node.z), 0)
    const copies = sources.map((source) => {
      z += 1
      return {
        ...source,
        id: nodeId(source.kind),
        x: source.x + 32,
        y: source.y + 32,
        z,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    })
    setNodes((list) => [...list, ...copies])
    setSelectedId(copies[copies.length - 1]?.id ?? null)
    setSelectedIds(copies.map((node) => node.id))
    setSelectedGroupId(null)
    markChanged()
  }
  const deleteSelected = (): void => {
    if (selectedEdgeId) {
      pushHistory()
      setConnections((list) => list.filter((edge) => edge.id !== selectedEdgeId))
      setSelectedEdgeId(null)
      markChanged()
      return
    }
    if (!selectedIds.length) return
    const removed = new Set(selectedIds)
    pushHistory()
    setNodes((list) => list.filter((node) => !removed.has(node.id)))
    setConnections((list) => list.filter((edge) => !removed.has(edge.fromNodeId) && !removed.has(edge.toNodeId)))
    setGroups((list) => list
      .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !removed.has(id)) }))
      .filter((group) => group.nodeIds.length >= 2))
    setSelectedId(null)
    setSelectedIds([])
    setSelectedGroupId(null)
    markChanged()
  }
  const groupSelection = (): void => {
    if (selectedIds.length < 2) return
    pushHistory()
    const group: StudioCanvasGroup = {
      id: `canvas_group_${crypto.randomUUID()}`,
      title: `分组 ${groups.length + 1}`,
      nodeIds: [...selectedIds],
      createdAt: Date.now()
    }
    setGroups((list) => [...list, group])
    setSelectedGroupId(group.id)
    markChanged()
    notify('info', '已编组；拖动组标题可整体移动，G 解组。')
  }
  const ungroupSelection = (): void => {
    const targets = groups.filter((group) => group.id === selectedGroupId || group.nodeIds.some((id) => selectedSet.has(id)))
    if (!targets.length) return
    pushHistory()
    const removed = new Set(targets.map((group) => group.id))
    setGroups((list) => list.filter((group) => !removed.has(group.id)))
    setSelectedGroupId(null)
    markChanged()
    notify('info', '已解组，节点保留在原位。')
  }
  const alignSelection = (mode: 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter'): void => {
    const members = nodes.filter((node) => selectedSet.has(node.id))
    if (members.length < 2) return
    pushHistory()
    const left = Math.min(...members.map((node) => node.x))
    const right = Math.max(...members.map((node) => node.x + node.width))
    const top = Math.min(...members.map((node) => node.y))
    const bottom = Math.max(...members.map((node) => node.y + node.height))
    setNodes((list) => list.map((node) => {
      if (!selectedSet.has(node.id)) return node
      if (mode === 'left') return { ...node, x: left }
      if (mode === 'right') return { ...node, x: right - node.width }
      if (mode === 'top') return { ...node, y: top }
      if (mode === 'bottom') return { ...node, y: bottom - node.height }
      if (mode === 'hcenter') return { ...node, x: (left + right) / 2 - node.width / 2 }
      return { ...node, y: (top + bottom) / 2 - node.height / 2 }
    }))
    markChanged()
  }
  const beginGroupDrag = (event: React.PointerEvent<HTMLDivElement>, group: StudioCanvasGroup): void => {    if (event.button !== 0) return
    event.stopPropagation()
    const members = nodes.filter((node) => group.nodeIds.includes(node.id))
    if (!members.length) return
    pushHistory()
    setSelectedIds(group.nodeIds)
    setSelectedId(group.nodeIds[group.nodeIds.length - 1] ?? null)
    setSelectedGroupId(group.id)
    setSelectedEdgeId(null)
    dragRef.current = {
      mode: 'group',
      groupId: group.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      origins: Object.fromEntries(members.map((node) => [node.id, { x: node.x, y: node.y }]))
    }
    stageRef.current?.setPointerCapture(event.pointerId)
  }
  const generateForShot = async (shotId: string, kind: 'image' | 'video' | 'voice'): Promise<void> => {
    const key = `${shotId}:${kind}`
    if (generating) return
    setGenerating(key)
    try {
      const action = kind === 'image' ? 'generate-shot-image' : kind === 'video' ? 'generate-shot-video' : 'generate-voice'
      const result = await run(action, { shotId, useModel: true })
      if (result.job) setShotJobs((current) => ({ ...current, [shotId]: result.job!.id }))
      notify('info', result.message ?? '任务已排队；进度会显示在节点和顶部任务条。')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(null)
    }
  }
  const loadWaveform = async (assetId: string): Promise<void> => {
    if (waveforms[assetId]) return
    try {
      const result = await run<{ peaks: number[] }>('asset-waveform', { assetId })
      if (result?.peaks?.length) setWaveforms((current) => ({ ...current, [assetId]: result.peaks }))
    } catch {
      // 波形失败不阻断画布
    }
  }
  const exportSnapshot = async (): Promise<void> => {
    if (exporting || !active) return
    setExporting(true)
    try {
      const audioIds = [...new Set(nodes.filter((node) => node.kind === 'audio' && node.assetId).map((node) => node.assetId!))]
      const peaks: Record<string, number[]> = { ...waveforms }
      for (const assetId of audioIds) {
        if (peaks[assetId]) continue
        try {
          const result = await run<{ peaks: number[] }>('asset-waveform', { assetId })
          if (result?.peaks?.length) peaks[assetId] = result.peaks
        } catch {
          // 没有波形的节点在快照里显示为音频块
        }
      }
      setWaveforms(peaks)
      const image = await renderCanvasSnapshot({
        title: active.title,
        nodes,
        connections,
        groups,
        assets: active.assets,
        shots: active.shots,
        waveforms: peaks
      })
      const result = await run('save-canvas-snapshot', { dataUrl: image.dataUrl })
      notify('success', result.message ?? '画布快照已导出到交付记录。')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }
  const openShot = (shotId: string | undefined): void => {
    if (!shotId) return
    selectShot(shotId)
    setView('storyboard')
  }
  const beginDrag = (event: React.PointerEvent<HTMLDivElement>, node: StudioCanvasNode): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-canvas-interactive]')) {
      event.stopPropagation()
      if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelection(node.id)
      else if (!selectedSet.has(node.id)) selectOnly(node.id)
      return
    }
    event.stopPropagation()
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      event.preventDefault()
      toggleSelection(node.id)
      return
    }
    const members = selectedSet.has(node.id) && selectedIds.length > 1
      ? nodes.filter((item) => selectedSet.has(item.id))
      : [node]
    if (!selectedSet.has(node.id)) selectOnly(node.id)
    pushHistory()
    dragRef.current = {
      mode: 'node',
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: node.x,
      originY: node.y,
      origins: Object.fromEntries(members.map((item) => [item.id, { x: item.x, y: item.y }]))
    }
    stageRef.current?.setPointerCapture(event.pointerId)
  }
  const beginResize = (event: React.PointerEvent<HTMLButtonElement>, node: StudioCanvasNode): void => {
    event.stopPropagation()
    event.preventDefault()
    pushHistory()
    selectOnly(node.id)
    dragRef.current = {
      mode: 'resize',
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originWidth: node.width,
      originHeight: node.height
    }
    stageRef.current?.setPointerCapture(event.pointerId)
  }
  const beginLink = (event: React.PointerEvent<HTMLButtonElement>, node: StudioCanvasNode): void => {
    event.stopPropagation()
    event.preventDefault()
    const world = stagePoint(event.clientX, event.clientY)
    setLinking({ fromNodeId: node.id, x: world.x, y: world.y })
    dragRef.current = {
      mode: 'link',
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY
    }
    stageRef.current?.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.mode === 'pan' && drag.originViewport) {
      setViewport({
        ...drag.originViewport,
        x: drag.originViewport.x + (event.clientX - drag.startClientX),
        y: drag.originViewport.y + (event.clientY - drag.startClientY)
      })
      return
    }
    if (drag.mode === 'node' && drag.nodeId) {
      const dx = (event.clientX - drag.startClientX) / viewport.zoom
      const dy = (event.clientY - drag.startClientY) / viewport.zoom
      const origins = drag.origins ?? { [drag.nodeId]: { x: drag.originX ?? 0, y: drag.originY ?? 0 } }
      setNodes((list) => list.map((node) => origins[node.id] ? { ...node, x: origins[node.id].x + dx, y: origins[node.id].y + dy } : node))
      return
    }
    if (drag.mode === 'group' && drag.origins) {
      const dx = (event.clientX - drag.startClientX) / viewport.zoom
      const dy = (event.clientY - drag.startClientY) / viewport.zoom
      setNodes((list) => list.map((node) => drag.origins?.[node.id] ? { ...node, x: drag.origins[node.id].x + dx, y: drag.origins[node.id].y + dy } : node))
      return
    }
    if (drag.mode === 'marquee') {
      const world = stagePoint(event.clientX, event.clientY)
      setMarquee((current) => current ? { ...current, x: world.x, y: world.y } : current)
      return
    }
    if (drag.mode === 'resize' && drag.nodeId) {
      const dx = (event.clientX - drag.startClientX) / viewport.zoom
      const dy = (event.clientY - drag.startClientY) / viewport.zoom
      setNodes((list) => list.map((node) => node.id === drag.nodeId ? { ...node, width: clamp((drag.originWidth ?? 240) + dx, 80, 1200), height: clamp((drag.originHeight ?? 160) + dy, 60, 900) } : node))
      return
    }
    if (drag.mode === 'link') {
      const world = stagePoint(event.clientX, event.clientY)
      setLinking((current) => current ? { ...current, x: world.x, y: world.y } : current)
    }
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag?.mode === 'marquee' && marquee) {
      const left = Math.min(marquee.startX, marquee.x)
      const right = Math.max(marquee.startX, marquee.x)
      const top = Math.min(marquee.startY, marquee.y)
      const bottom = Math.max(marquee.startY, marquee.y)
      const hit = nodes.filter((node) => node.x < right && node.x + node.width > left && node.y < bottom && node.y + node.height > top).map((node) => node.id)
      const next = marquee.additive ? [...new Set([...selectedIds, ...hit])] : hit
      setSelectedIds(next)
      setSelectedId(next[next.length - 1] ?? null)
      setSelectedGroupId(null)
      setSelectedEdgeId(null)
      setMarquee(null)
      dragRef.current = null
      stageRef.current?.releasePointerCapture(event.pointerId)
      return
    }
    if (drag?.mode === 'link' && drag.nodeId) {
      const world = stagePoint(event.clientX, event.clientY)
      const target = [...nodes].reverse().find((node) => node.id !== drag.nodeId && world.x >= node.x && world.x <= node.x + node.width && world.y >= node.y && world.y <= node.y + node.height)
      if (target) {
        pushHistory()
        setConnections((list) => list.some((edge) => edge.fromNodeId === drag.nodeId && edge.toNodeId === target.id)
          ? list
          : [...list, { id: `canvas_edge_${crypto.randomUUID()}`, fromNodeId: drag.nodeId!, toNodeId: target.id }])
        markChanged()
      }
    }
    if (drag && drag.mode !== 'pan' && drag.mode !== 'marquee') markChanged()
    dragRef.current = null
    setLinking(null)
    stageRef.current?.releasePointerCapture(event.pointerId)
  }
  const onStagePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button === 1 || spaceRef.current || event.altKey) {
      event.preventDefault()
      dragRef.current = {
        mode: 'pan',
        startClientX: event.clientX,
        startClientY: event.clientY,
        originViewport: { ...viewport }
      }
      stageRef.current?.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0) return
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    if (!additive) {
      setSelectedId(null)
      setSelectedIds([])
      setSelectedGroupId(null)
      setSelectedEdgeId(null)
    }
    const world = stagePoint(event.clientX, event.clientY)
    setMarquee({ startX: world.x, startY: world.y, x: world.x, y: world.y, additive })
    dragRef.current = {
      mode: 'marquee',
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWorldX: world.x,
      startWorldY: world.y,
      additive
    }
    stageRef.current?.setPointerCapture(event.pointerId)
  }
  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    event.preventDefault()
    zoomAt(viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX, event.clientY)
  }
  const shotAssets = active.shots.map((shot) => ({ shot, asset: shotImage(active, shot) }))
  const filteredShots = shotAssets.filter(({ shot }) => !query.trim() || `${shot.number} ${shot.title} ${shot.action}`.toLowerCase().includes(query.trim().toLowerCase()))
  const images = active.assets.filter((asset) => asset.kind === 'image')
  const audioAssets = active.assets.filter((asset) => asset.kind === 'audio')
  const filteredAssets = (paletteTab === 'images' ? images : audioAssets).filter((asset) => !query.trim() || asset.title.toLowerCase().includes(query.trim().toLowerCase()))
  const edgePath = (from: StudioCanvasNode, to: StudioCanvasNode): string => {
    const sx = from.x + from.width
    const sy = from.y + from.height / 2
    const tx = to.x
    const ty = to.y + to.height / 2
    const curve = Math.max(60, Math.abs(tx - sx) * 0.45)
    return `M ${sx} ${sy} C ${sx + curve} ${sy}, ${tx - curve} ${ty}, ${tx} ${ty}`
  }
  const linkSource = linking ? nodes.find((node) => node.id === linking.fromNodeId) : null
  const selectedShot = selectedNode?.shotId ? active.shots.find((shot) => shot.id === selectedNode.shotId) : null
  const selectedAsset = selectedNode?.assetId ? active.assets.find((asset) => asset.id === selectedNode.assetId) : null
  const groupFrames = groups.map((group) => {
    const members = nodes.filter((node) => group.nodeIds.includes(node.id))
    if (members.length < 2) return null
    const minX = Math.min(...members.map((node) => node.x)) - 18
    const minY = Math.min(...members.map((node) => node.y)) - 42
    const maxX = Math.max(...members.map((node) => node.x + node.width)) + 18
    const maxY = Math.max(...members.map((node) => node.y + node.height)) + 18
    return { group, x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }).filter((item): item is { group: StudioCanvasGroup; x: number; y: number; width: number; height: number } => Boolean(item))
  const jobForShot = (shotId: string): { progress: number; status: string; message: string } | null => {
    const jobId = shotJobs[shotId]
    if (!jobId) return null
    const job = active.jobs.find((item) => item.id === jobId)
    return job ? { progress: job.progress, status: job.status, message: job.message } : null
  }

  return (
    <div className="studio-canvas-view">
      <header className="studio-canvas-bar">
        <div className="studio-canvas-heading">
          <span className="studio-eyebrow">漫剧画布</span>
          <h1>{active.title}<em>画布</em></h1>
          <p>{nodes.length} 个节点 · {connections.length} 条连线 · {groups.length} 个分组{selectedIds.length > 1 ? ` · 已选 ${selectedIds.length}` : ''} · 拖拽排布，右侧拉线</p>
        </div>
        <div className="studio-canvas-actions">
          <span className={`studio-canvas-save is-${saveState}`}>{saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已保存'}</span>
          <button type="button" className="studio-canvas-icon" onClick={undo} disabled={!historyRef.current.length} title="撤销" aria-label="撤销"><Undo2 size={14} /></button>
          <button type="button" className="studio-canvas-icon" onClick={redo} disabled={!futureRef.current.length} title="重做" aria-label="重做"><Redo2 size={14} /></button>
          <button type="button" className="studio-canvas-action" onClick={addTextNode}><Type size={13} /> 文本</button>
          <button type="button" className="studio-canvas-action" onClick={groupSelection} disabled={selectedIds.length < 2} title="把选中的节点编为一组（G）"><Boxes size={13} /> 编组</button>
          <button type="button" className="studio-canvas-action" onClick={ungroupSelection} disabled={!selectedGroupId && !groups.some((group) => group.nodeIds.some((id) => selectedSet.has(id)))} title="解散分组"><Ungroup size={13} /> 解组</button>
          <button type="button" className="studio-canvas-action" onClick={autoLayout}><LayoutGrid size={13} /> 自动排布</button>
          <button type="button" className="studio-canvas-action" onClick={autoConnect}><GitBranch size={13} /> 自动连线</button>
          <button type="button" className="studio-canvas-action" onClick={fit}><Maximize2 size={13} /> 适应窗口</button>
          <button type="button" className="studio-canvas-action" onClick={() => void exportSnapshot()} disabled={exporting}>{exporting ? <Loader2 size={13} className="studio-spin" /> : <Download size={13} />} 导出快照</button>
          <button type="button" className="studio-canvas-action" onClick={() => setView('storyboard')}><Clapperboard size={13} /> 分镜</button>
          <button type="button" className="studio-canvas-action" onClick={() => setView('timeline')}><Film size={13} /> 时间线</button>
        </div>
      </header>

      <div className={`studio-canvas-workspace ${paletteOpen ? '' : 'is-palette-closed'}`}>
        {paletteOpen ? (
          <aside className="studio-canvas-palette" aria-label="画布素材">
            <header>
              <div><span className="studio-eyebrow">素材</span><b>素材与镜头</b></div>
              <button type="button" onClick={() => setPaletteOpen(false)} aria-label="收起素材"><X size={14} /></button>
            </header>
            <div className="studio-canvas-tabs" role="tablist" aria-label="画布素材类型">
              <button type="button" className={paletteTab === 'shots' ? 'is-active' : ''} onClick={() => setPaletteTab('shots')}>镜头 <em>{active.shots.length}</em></button>
              <button type="button" className={paletteTab === 'images' ? 'is-active' : ''} onClick={() => setPaletteTab('images')}>画面 <em>{images.length}</em></button>
              <button type="button" className={paletteTab === 'audio' ? 'is-active' : ''} onClick={() => setPaletteTab('audio')}>声音 <em>{audioAssets.length}</em></button>
            </div>
            <label className="studio-canvas-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="找镜头或素材" aria-label="搜索画布素材" /></label>
            <div className="studio-canvas-palette-list">
              {paletteTab === 'shots' ? filteredShots.map(({ shot, asset }) => (
                <button key={shot.id} type="button" className="studio-canvas-palette-card" onClick={() => addShotNode(shot)}>
                  <span className="studio-canvas-palette-thumb">{asset ? <img src={assetUrl(asset)} alt="" loading="lazy" /> : <span className="mono">{String(shot.number).padStart(2, '0')}</span>}</span>
                  <span><b>镜 {String(shot.number).padStart(2, '0')} · {shot.title}</b><em>{shot.shotSize} · {shot.camera} · {shot.durationSec}s</em></span>
                  <Plus size={12} />
                </button>
              )) : filteredAssets.map((asset) => (
                <button key={asset.id} type="button" className="studio-canvas-palette-card" onClick={() => addAssetNode(asset)}>
                  <span className="studio-canvas-palette-thumb">
                    {asset.kind === 'image' ? <img src={assetUrl(asset)} alt="" loading="lazy" /> : asset.kind === 'video' ? <Video size={16} /> : <Music2 size={16} />}
                  </span>
                  <span><b>{asset.title}</b><em>{asset.kind === 'image' ? '画面' : asset.kind === 'video' ? '视频' : '音频'} · {asset.durationSec ? `${asset.durationSec.toFixed(1)}s` : '可拖入'}</em></span>
                  <Plus size={12} />
                </button>
              ))}
              {((paletteTab === 'shots' && !filteredShots.length) || (paletteTab !== 'shots' && !filteredAssets.length)) ? <p className="studio-canvas-palette-empty">没有匹配的素材。</p> : null}
            </div>
            <div className="studio-canvas-palette-foot">
              <button type="button" onClick={addTextNode}><Type size={12} /> 新建文本节点</button>
              <span>素材来自当前作品，不复制文件</span>
            </div>
          </aside>
        ) : null}

        <div
          ref={stageRef}
          className={`studio-canvas-stage ${paletteOpen ? '' : 'is-wide'}`}
          style={{
            backgroundSize: `${GRID_SIZE * viewport.zoom}px ${GRID_SIZE * viewport.zoom}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`
          }}
          onPointerDown={onStagePointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
        >
          {!paletteOpen ? <button type="button" className="studio-canvas-palette-open" onClick={() => setPaletteOpen(true)}><ImageIcon size={13} /> 素材</button> : null}
          <div className="studio-canvas-world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
            {groupFrames.map(({ group, x, y, width, height }) => (
              <div
                key={group.id}
                className={`studio-canvas-group ${selectedGroupId === group.id ? 'is-selected' : ''}`}
                style={{ left: x, top: y, width, height, zIndex: 1 }}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) {
                    event.stopPropagation()
                    setSelectedIds(group.nodeIds)
                    setSelectedId(group.nodeIds[group.nodeIds.length - 1] ?? null)
                    setSelectedGroupId(group.id)
                    setSelectedEdgeId(null)
                  }
                }}
              >
                <div className="studio-canvas-group-head" onPointerDown={(event) => beginGroupDrag(event, group)}>
                  <Boxes size={11} />
                  <input
                    value={group.title}
                    aria-label="分组名称"
                    onChange={(event) => {
                      const title = event.target.value
                      setGroups((list) => list.map((item) => item.id === group.id ? { ...item, title } : item))
                      markChanged()
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  />
                  <span>{group.nodeIds.length} 个节点</span>
                </div>
              </div>
            ))}
            <svg className="studio-canvas-wires" width="1" height="1" aria-hidden>
              {connections.map((edge) => {
                const from = nodes.find((node) => node.id === edge.fromNodeId)
                const to = nodes.find((node) => node.id === edge.toNodeId)
                if (!from || !to) return null
                return (
                  <g key={edge.id}>
                    <path className="studio-canvas-wire-hit" d={edgePath(from, to)} onPointerDown={(event) => { event.stopPropagation(); setSelectedEdgeId(edge.id); setSelectedId(null); setSelectedIds([]); setSelectedGroupId(null) }} />
                    <path className={`studio-canvas-wire ${selectedEdgeId === edge.id ? 'is-selected' : ''}`} d={edgePath(from, to)} />
                  </g>
                )
              })}
              {linking && linkSource ? (
                <path className="studio-canvas-wire is-linking" d={`M ${linkSource.x + linkSource.width} ${linkSource.y + linkSource.height / 2} C ${linkSource.x + linkSource.width + 70} ${linkSource.y + linkSource.height / 2}, ${linking.x - 70} ${linking.y}, ${linking.x} ${linking.y}`} />
              ) : null}
            </svg>
            {marquee ? (
              <div
                className="studio-canvas-marquee"
                style={{
                  left: Math.min(marquee.startX, marquee.x),
                  top: Math.min(marquee.startY, marquee.y),
                  width: Math.abs(marquee.x - marquee.startX),
                  height: Math.abs(marquee.y - marquee.startY)
                }}
              />
            ) : null}
            {nodes.map((node) => {
              const asset = node.assetId ? active.assets.find((item) => item.id === node.assetId) : undefined
              const shot = node.shotId ? active.shots.find((item) => item.id === node.shotId) : undefined
              const image = shot ? shotImage(active, shot) : undefined
              const shotJob = shot ? jobForShot(shot.id) : null
              return (
                <div
                  key={node.id}
                  className={`studio-canvas-node is-${node.kind} ${selectedSet.has(node.id) ? 'is-selected' : ''}`}
                  style={{ left: node.x, top: node.y, width: node.width, height: node.height, zIndex: node.z + 2 }}
                  data-canvas-node={node.id}
                  onPointerDown={(event) => beginDrag(event, node)}
                  onClick={(event) => {
                    if (event.shiftKey || event.ctrlKey || event.metaKey) return
                    selectOnly(node.id)
                  }}
                >
                  <div className="studio-canvas-node-head">
                    <span className="studio-canvas-node-kind">{node.kind === 'shot' ? <Clapperboard size={11} /> : node.kind === 'image' ? <ImageIcon size={11} /> : node.kind === 'video' ? <Video size={11} /> : node.kind === 'audio' ? <Music2 size={11} /> : <Type size={11} />}</span>
                    <b title={node.title}>{node.title}</b>
                    <button type="button" className="studio-canvas-link-handle" onPointerDown={(event) => beginLink(event, node)} title="从这里拉线到另一个节点" aria-label="创建连线" />
                  </div>
                  <div className="studio-canvas-node-body">
                    {node.kind === 'text' ? (
                      <textarea
                        value={node.text ?? ''}
                        data-canvas-interactive
                        onFocus={pushHistory}
                        onChange={(event) => updateNode(node.id, { text: event.target.value })}
                        aria-label={`${node.title}内容`}
                      />
                    ) : node.kind === 'audio' && asset ? (
                      <CanvasAudio asset={asset} peaks={node.assetId ? waveforms[node.assetId] : undefined} />
                    ) : (
                      <>
                        {(asset?.kind === 'video' || node.kind === 'video') && asset?.url ? (
                          <video src={asset.url} muted playsInline preload="metadata" controls data-canvas-interactive />
                        ) : (image ? assetUrl(image) : assetUrl(asset)) ? (
                          <img src={image ? assetUrl(image) : assetUrl(asset)} alt="" loading="lazy" draggable={false} />
                        ) : (
                          <div className="studio-canvas-node-placeholder">{shot ? <span className="mono">{String(shot.number).padStart(2, '0')}</span> : <ImageIcon size={18} />}</div>
                        )}
                        {shot ? (
                          <div className="studio-canvas-shot-copy">
                            <span>{shot.shotSize} · {shot.camera} · {shot.durationSec}s</span>
                            <p>{shot.action || shot.dialogue || '还没有动作描述'}</p>
                          </div>
                        ) : null}
                        {asset && node.kind !== 'shot' ? <span className="studio-canvas-asset-tag">{asset.kind === 'image' ? '画面素材' : '视频素材'}</span> : null}
                      </>
                    )}
                  </div>
                  {shotJob ? (
                    <div className={`studio-canvas-node-job is-${shotJob.status}`} data-canvas-interactive>
                      <span>{shotJob.status === 'running' ? shotJob.message : shotJob.status === 'queued' ? '任务排队中' : shotJob.status === 'done' ? '已生成' : shotJob.message}</span>
                      <i><b style={{ width: `${shotJob.progress}%` }} /></i>
                    </div>
                  ) : null}
                  <button type="button" className="studio-canvas-resize" aria-label="调整节点大小" onPointerDown={(event) => beginResize(event, node)} />
                </div>
              )
            })}
          </div>
          <div
            className="studio-canvas-zoom"
            data-canvas-interactive
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
          >
            <button type="button" onClick={() => zoomAt(viewport.zoom * 0.9)} title="缩小" aria-label="缩小"><ZoomOut size={13} /></button>
            <button type="button" className="studio-canvas-zoom-label mono" onClick={() => zoomAt(1)} title="恢复 100%">{Math.round(viewport.zoom * 100)}%</button>
            <button type="button" onClick={() => zoomAt(viewport.zoom * 1.1)} title="放大" aria-label="放大"><ZoomIn size={13} /></button>
            <button type="button" onClick={fit} title="适应画布" aria-label="适应画布"><Maximize2 size={13} /></button>
          </div>
        </div>

        <aside className="studio-canvas-inspector" aria-label="画布节点详情">
          <header>
            <span className="studio-eyebrow">{selectedEdge ? '连线' : selectedIds.length > 1 ? '已选' : selectedGroup ? '分组' : selectedNode ? '节点' : '画布'}</span>
            <b>{selectedEdge ? '连线' : selectedIds.length > 1 ? `${selectedIds.length} 个节点` : selectedGroup ? selectedGroup.title : selectedNode?.kind === 'shot' ? '镜头节点' : selectedNode ? '节点详情' : '画布'}</b>
            {selectedNode || selectedEdge || selectedIds.length || selectedGroup ? <button type="button" onClick={() => { setSelectedId(null); setSelectedIds([]); setSelectedGroupId(null); setSelectedEdgeId(null) }} aria-label="取消选择"><X size={13} /></button> : null}
          </header>
          {selectedEdge ? (
            <div className="studio-canvas-inspector-body">
              <label><span>连线说明</span><input value={selectedEdge.label ?? ''} placeholder="例如：参考 / 配音 / 生成" onFocus={pushHistory} onChange={(event) => updateEdge(selectedEdge.id, { label: event.target.value })} /></label>
              <Button variant="danger" size="sm" icon={<Trash2 size={12} />} onClick={deleteSelected}>删除连线</Button>
            </div>
          ) : selectedGroup ? (
            <div className="studio-canvas-inspector-body">
              <label><span>分组名称</span><input value={selectedGroup.title} onChange={(event) => { const title = event.target.value; setGroups((list) => list.map((group) => group.id === selectedGroup.id ? { ...group, title } : group)); markChanged() }} /></label>
              <p className="studio-canvas-inspector-note">{selectedGroup.nodeIds.length} 个节点 · 拖动组标题整体移动</p>
              <div className="studio-canvas-inspector-actions">
                <button type="button" onClick={ungroupSelection}><Ungroup size={12} /> 解组</button>
                <button type="button" onClick={duplicateSelected}><Copy size={12} /> 复制节点</button>
                <button type="button" className="is-danger" onClick={deleteSelected}><Trash2 size={12} /> 删除节点</button>
              </div>
            </div>
          ) : selectedIds.length > 1 ? (
            <div className="studio-canvas-inspector-body">
              <p className="studio-canvas-inspector-note">已选 {selectedIds.length} 个节点。拖动任一节点会一起移动；可编组后统一移动。</p>
              <div className="studio-canvas-align">
                <button type="button" onClick={() => alignSelection('left')}>左对齐</button>
                <button type="button" onClick={() => alignSelection('right')}>右对齐</button>
                <button type="button" onClick={() => alignSelection('top')}>顶对齐</button>
                <button type="button" onClick={() => alignSelection('bottom')}>底对齐</button>
                <button type="button" onClick={() => alignSelection('hcenter')}>水平居中</button>
                <button type="button" onClick={() => alignSelection('vcenter')}>垂直居中</button>
              </div>
              <div className="studio-canvas-inspector-actions">
                <button type="button" onClick={groupSelection}><Boxes size={12} /> 编组</button>
                <button type="button" onClick={duplicateSelected}><Copy size={12} /> 副本</button>
                <button type="button" className="is-danger" onClick={deleteSelected}><Trash2 size={12} /> 删除</button>
              </div>
            </div>
          ) : selectedNode ? (
            <div className="studio-canvas-inspector-body">
              <label><span>标题</span><input value={selectedNode.title} onFocus={pushHistory} onChange={(event) => updateNode(selectedNode.id, { title: event.target.value })} /></label>
              {selectedNode.kind === 'text' ? (
                <label><span>内容</span><textarea rows={7} value={selectedNode.text ?? ''} onFocus={pushHistory} onChange={(event) => updateNode(selectedNode.id, { text: event.target.value })} /></label>
              ) : null}
              <div className="studio-canvas-node-fields">
                <label><span>宽度</span><input value={Math.round(selectedNode.width)} inputMode="numeric" onFocus={pushHistory} onChange={(event) => updateNode(selectedNode.id, { width: clamp(Number(event.target.value) || 80, 80, 1200) })} /></label>
                <label><span>高度</span><input value={Math.round(selectedNode.height)} inputMode="numeric" onFocus={pushHistory} onChange={(event) => updateNode(selectedNode.id, { height: clamp(Number(event.target.value) || 60, 60, 900) })} /></label>
              </div>
              {selectedShot ? (
                <div className="studio-canvas-inspector-shot">
                  <span>镜 {selectedShot.number} · {selectedShot.shotSize} · {selectedShot.durationSec}s</span>
                  <p>{selectedShot.action}</p>
                  <button type="button" onClick={() => openShot(selectedShot.id)}><ExternalLink size={12} /> 打开分镜</button>
                  <div className="studio-canvas-generate">
                    <span>在画布内生成</span>
                    <div>
                      <button type="button" disabled={Boolean(generating)} onClick={() => void generateForShot(selectedShot.id, 'image')}>
                        {generating === `${selectedShot.id}:image` ? <Loader2 size={12} className="studio-spin" /> : <ImagePlus size={12} />} 画面
                      </button>
                      <button type="button" disabled={Boolean(generating)} onClick={() => void generateForShot(selectedShot.id, 'video')}>
                        {generating === `${selectedShot.id}:video` ? <Loader2 size={12} className="studio-spin" /> : <Video size={12} />} 视频
                      </button>
                      <button type="button" disabled={Boolean(generating) || !selectedShot.dialogue.trim()} onClick={() => void generateForShot(selectedShot.id, 'voice')}>
                        {generating === `${selectedShot.id}:voice` ? <Loader2 size={12} className="studio-spin" /> : <Mic2 size={12} />} 配音
                      </button>
                    </div>
                    {jobForShot(selectedShot.id) ? <em>{jobForShot(selectedShot.id)!.message}</em> : null}
                  </div>
                </div>
              ) : null}
              {selectedAsset ? <p className="studio-canvas-inspector-note">{selectedAsset.title} · {selectedAsset.kind} · 素材仍在作品里</p> : null}
              <div className="studio-canvas-inspector-actions">
                <button type="button" onClick={duplicateSelected}><Copy size={12} /> 副本</button>
                <button type="button" onClick={() => updateNode(selectedNode.id, { z: nodes.reduce((max, node) => Math.max(max, node.z), 0) + 1 }, true)}><ArrowUpToLine size={12} /> 置顶</button>
                <button type="button" onClick={() => updateNode(selectedNode.id, { z: Math.min(...nodes.map((node) => node.z), 1) - 1 }, true)}><ArrowDownToLine size={12} /> 置底</button>
                <button type="button" className="is-danger" onClick={deleteSelected}><Trash2 size={12} /> 删除</button>
              </div>
            </div>
          ) : (
            <div className="studio-canvas-inspector-empty">
              <p>从左侧添加镜头、画面或声音。拖拽节点排布，从节点右侧的圆点拉线，建立“参考 → 生成 → 配音 → 合成”的工作流。</p>
              <p className="studio-canvas-inspector-tip">框选或 Shift 点选多个节点；按 G 编组，拖动组标题整体移动。</p>
              <dl>
                <div><dt>节点</dt><dd>{nodes.length}</dd></div>
                <div><dt>连线</dt><dd>{connections.length}</dd></div>
                <div><dt>分组</dt><dd>{groups.length}</dd></div>
                <div><dt>已保存</dt><dd>{saveState === 'saved' ? '是' : '…'}</dd></div>
              </dl>
              <Button variant="ghost" size="sm" onClick={() => setPaletteOpen(true)} disabled={paletteOpen}>打开素材栏</Button>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
