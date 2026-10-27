import { useState } from 'react'
import { ImagePlus, Loader2, Trash2 } from 'lucide-react'
import type { StudioChapter } from '@shared/studio'
import { Button, Modal } from '../../ui'
import { useStudioStore } from './studio-store'

export function IllustrationDialog({ chapter, onClose }: { chapter: StudioChapter; onClose: () => void }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [generating, setGenerating] = useState(false)
  const [positions, setPositions] = useState<Record<string, number>>({})
  const [attaching, setAttaching] = useState<string | null>(null)
  if (!active) return null
  const current = active.chapters.find((item) => item.id === chapter.id) ?? chapter
  const candidates = active.assets.filter((asset) => asset.kind === 'image' && asset.tags.includes(`chapter:${chapter.id}`))
  const attachedIds = new Set(current.illustrations.map((item) => item.assetId))
  const otherImages = active.assets.filter((asset) => asset.kind === 'image' && !candidates.some((item) => item.id === asset.id))
  const generate = async (): Promise<void> => {
    if (generating) return
    setGenerating(true)
    try {
      const result = await run('generate-chapter-illustration', { chapterId: chapter.id, count: 2 })
      notify('info', result.message ?? '配图草稿已排队；用之前不会插进正文。')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }
  const attach = async (assetId: string): Promise<void> => {
    setAttaching(assetId)
    try {
      await run('attach-chapter-illustration', {
        chapterId: chapter.id,
        assetId,
        afterParagraph: positions[assetId] ?? 0
      })
      notify('success', '配图已插入；可以继续调整位置或移除。')
    } finally {
      setAttaching(null)
    }
  }
  const remove = async (illustrationId: string): Promise<void> => {
    await run('remove-chapter-illustration', { chapterId: chapter.id, illustrationId })
  }
  const card = (asset: (typeof active.assets)[number], attached: boolean): React.JSX.Element => (
    <div key={asset.id} className="studio-illustration-card">
      <img src={asset.thumbUrl ?? asset.url} alt={asset.title} />
      <div className="studio-illustration-copy">
        <b>{asset.title}</b>
        <span>{attached ? '已插入' : '草稿'}</span>
      </div>
      {!attached ? (
        <div className="studio-illustration-actions">
          <label>
            第
            <input
              type="number"
              min={0}
              max={Math.max(0, chapterParagraphCount(current.content))}
              value={positions[asset.id] ?? 0}
              onChange={(event) => setPositions((state) => ({ ...state, [asset.id]: Math.max(0, Number(event.target.value) || 0) }))}
              aria-label="插入到第几段之后"
            />
            段后
          </label>
          <Button variant="ghost" size="sm" loading={attaching === asset.id} onClick={() => void attach(asset.id)}>用这张</Button>
        </div>
      ) : null}
    </div>
  )
  return (
    <Modal
      open
      onClose={onClose}
      title={`章节配图 · ${current.title}`}
      description="配图只影响这一章的排版，不会改正文；先生成一版草稿，点“用这张”才插入。"
      width={760}
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>完成</Button>
        </div>
      }
    >
      <div className="studio-illustration-panel">
        <div className="studio-illustration-toolbar">
          <div>
            <b>当前配图 {current.illustrations.length} 张</b>
            <span>{engine?.media.imageReady ? '本机画面引擎就绪' : '画面引擎未就绪，仍可采用作品里已有的图片'}</span>
          </div>
          <Button variant="gold" size="sm" icon={generating ? <Loader2 size={13} className="studio-spin" /> : <ImagePlus size={13} />} onClick={() => void generate()} disabled={generating}>
            先生成 2 张
          </Button>
        </div>
        {current.illustrations.length ? (
          <div className="studio-illustration-grid">
            {current.illustrations.map((item) => {
              const asset = active.assets.find((entry) => entry.id === item.assetId)
              if (!asset) return null
              return (
                <div key={item.id} className="studio-illustration-card is-attached">
                  <img src={asset.thumbUrl ?? asset.url} alt={item.caption ?? asset.title} />
                  <div className="studio-illustration-copy">
                    <b>{item.caption ?? asset.title}</b>
                    <span>第 {item.afterParagraph} 段后</span>
                  </div>
                  <button type="button" className="studio-illustration-remove" onClick={() => void remove(item.id)} title="移除配图" aria-label="移除配图"><Trash2 size={12} /></button>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="studio-hint">还没有插入配图。先生成一版，或从作品已有图片里挑一张。</p>
        )}
        {candidates.filter((asset) => !attachedIds.has(asset.id)).length ? (
          <section className="studio-illustration-section">
            <b>本章草稿</b>
            <div className="studio-illustration-grid">{candidates.filter((asset) => !attachedIds.has(asset.id)).map((asset) => card(asset, false))}</div>
          </section>
        ) : null}
        {otherImages.length ? (
          <section className="studio-illustration-section">
            <b>作品已有图片</b>
            <div className="studio-illustration-grid">{otherImages.slice(0, 12).map((asset) => card(asset, attachedIds.has(asset.id)))}</div>
          </section>
        ) : null}
      </div>
    </Modal>
  )
}

function chapterParagraphCount(content: string): number {
  return content.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean).length
}
