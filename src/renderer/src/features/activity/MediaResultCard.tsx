import { useEffect, useState } from 'react'
import { ExternalLink, Film, FolderOpen, Image as ImageIcon, Play } from 'lucide-react'
import type { MediaToolMeta } from '@shared/types'
import { formatBytes } from '@shared/usage'
import { previewFile } from '../artifacts/editor-api'
import { useAppStore } from '../../store'

export function readMediaMeta(value: unknown): MediaToolMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.path !== 'string' || !record.path) return null
  if (record.kind !== 'image' && record.kind !== 'video' && record.kind !== 'audio') return null
  return {
    kind: record.kind,
    path: record.path,
    title: typeof record.title === 'string' && record.title ? record.title : record.path.split(/[\\/]/).pop() ?? '媒体成品',
    model: typeof record.model === 'string' ? record.model : '',
    engine: typeof record.engine === 'string' ? record.engine : '',
    bytes: typeof record.bytes === 'number' ? record.bytes : 0,
    ...(typeof record.artifactId === 'string' ? { artifactId: record.artifactId } : {}),
    ...(typeof record.width === 'number' ? { width: record.width } : {}),
    ...(typeof record.height === 'number' ? { height: record.height } : {}),
    ...(typeof record.durationSec === 'number' ? { durationSec: record.durationSec } : {}),
    ...(typeof record.seed === 'number' ? { seed: record.seed } : {}),
    ...(typeof record.elapsedMs === 'number' ? { elapsedMs: record.elapsedMs } : {}),
    ...(typeof record.thumbnailDataUrl === 'string' ? { thumbnailDataUrl: record.thumbnailDataUrl } : {})
  }
}

function durationText(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return ''
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${seconds.toFixed(1)} 秒`
}

export function MediaResultCard({ media }: { media: MediaToolMeta }): React.JSX.Element {
  const openCanvas = useAppStore((s) => s.openCanvas)
  const openArtifactExternal = useAppStore((s) => s.openArtifactExternal)
  const revealArtifact = useAppStore((s) => s.revealArtifact)
  const workspace = useAppStore((s) => s.session?.workspace ?? null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)

  useEffect(() => {
    if (!workspace || media.kind === 'image') return undefined
    let alive = true
    void previewFile(workspace, media.path)
      .then((meta) => {
        if (!alive) return
        if (meta.url) setPreviewUrl(meta.url)
        else setPreviewFailed(true)
      })
      .catch(() => {
        if (alive) setPreviewFailed(true)
      })
    return () => {
      alive = false
    }
  }, [media.kind, media.path, workspace])

  const isVideo = media.kind === 'video'
  const isAudio = media.kind === 'audio'
  const dimensions = media.width && media.height ? `${media.width}×${media.height}` : ''
  const meta = [dimensions, durationText(media.durationSec), media.bytes ? formatBytes(media.bytes) : '', media.model]
    .filter(Boolean)
    .join(' · ')

  const openInCanvas = (): void => {
    if (media.artifactId) openCanvas(media.artifactId)
  }

  return (
    <div className="spine-media" data-testid="tool-media-card" data-media-kind={media.kind}>
      <div className="spine-media-frame">
        {isVideo && previewUrl && !previewFailed ? (
          <video
            className="spine-media-video"
            data-testid="tool-media-video"
            src={previewUrl}
            poster={media.thumbnailDataUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={media.title}
            onError={() => setPreviewFailed(true)}
          />
        ) : isAudio && previewUrl && !previewFailed ? (
          <div className="spine-media-audio">
            <span className="spine-media-audio-icon" aria-hidden>
              <Film size={22} strokeWidth={1.3} />
            </span>
            <audio src={previewUrl} controls preload="metadata" aria-label={media.title} onError={() => setPreviewFailed(true)} />
          </div>
        ) : (
          <button
            type="button"
            className="spine-media-poster"
            onClick={openInCanvas}
            disabled={!media.artifactId}
            aria-label={media.artifactId ? `在画布打开${media.title}` : media.title}
            title={media.artifactId ? '在画布打开' : media.title}
          >
            {media.thumbnailDataUrl ? (
              <img data-testid="tool-media-thumb" src={media.thumbnailDataUrl} alt={media.title} loading="lazy" />
            ) : (
              <span className="spine-media-placeholder" aria-hidden>
                {isVideo ? <Film size={24} strokeWidth={1.2} /> : <ImageIcon size={24} strokeWidth={1.2} />}
              </span>
            )}
            {isVideo ? (
              <span className="spine-media-play" aria-hidden>
                <Play size={14} fill="currentColor" strokeWidth={0} />
              </span>
            ) : null}
            {isVideo && media.durationSec !== undefined ? (
              <span className="spine-media-badge mono">{durationText(media.durationSec)}</span>
            ) : null}
          </button>
        )}
      </div>
      <div className="spine-media-copy">
        <span className="spine-media-title" title={media.title}>
          {media.title}
        </span>
        <span className="spine-media-meta mono">{meta}</span>
        <div className="spine-media-actions">
          {media.artifactId ? (
            <button type="button" onClick={openInCanvas}>
              在画布打开
            </button>
          ) : null}
          <button type="button" onClick={() => void openArtifactExternal(media.path)}>
            <ExternalLink size={11} strokeWidth={1.6} aria-hidden />
            系统打开
          </button>
          <button type="button" onClick={() => void revealArtifact(media.path)}>
            <FolderOpen size={11} strokeWidth={1.6} aria-hidden />
            所在文件夹
          </button>
        </div>
      </div>
    </div>
  )
}
