import type {
  StudioAsset,
  StudioCanvasConnection,
  StudioCanvasGroup,
  StudioCanvasNode,
  StudioShot
} from '@shared/studio'

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
