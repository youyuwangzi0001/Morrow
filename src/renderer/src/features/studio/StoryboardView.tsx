import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Captions,
  Check,
  ChevronRight,
  Clapperboard,
  Clock3,
  Film,
  Image as ImageIcon,
  Images,
  Loader2,
  Lock,
  LockOpen,
  Mic2,
  Music2,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Video,
  WandSparkles,
  X
} from 'lucide-react'
import type { StudioAsset, StudioJob, StudioShot } from '@shared/studio'
import { formatDuration, formatTimecode, studioStatusLabel } from '@shared/studio'
import { Button, Modal, Segmented } from '../../ui'
import { useStudioStore } from './studio-store'
import {
  AssetImage,
  AudioPill,
  EmptyState,
  JobStatus,
  KindBadge,
  SectionTitle,
  StageIcon,
  StudioProgress,
  StatusDot,
  timeAgo
} from './components'

interface ShotDraft {
  title: string
  action: string
  camera: string
  shotSize: string
  durationSec: number
  dialogue: string
  speaker: string
  prompt: string
  negative: string
  continuity: string
}

function draftOf(shot: StudioShot): ShotDraft {
  return {
    title: shot.title,
    action: shot.action,
    camera: shot.camera,
    shotSize: shot.shotSize,
    durationSec: shot.durationSec,
    dialogue: shot.dialogue,
    speaker: shot.speaker,
    prompt: shot.prompt,
    negative: shot.negative,
    continuity: shot.continuity
  }
}

function SceneScript({ sceneIndex }: { sceneIndex: number }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const scene = active?.scenes[sceneIndex]
  const [synopsis, setSynopsis] = useState(scene?.synopsis ?? '')
  const shots = active && scene ? active.shots.filter((shot) => shot.sceneId === scene.id).sort((a, b) => a.number - b.number) : []
  useEffect(() => {
    setSynopsis(scene?.synopsis ?? '')
  }, [scene?.id])
  if (!active || !scene) return null
  const save = async (): Promise<void> => {
    if (synopsis !== scene.synopsis) await run('save-scene', { sceneId: scene.id, synopsis })
  }
  return (
    <article className="studio-script-scene">
      <header>
        <span className="studio-script-number mono">SCENE {String(sceneIndex + 1).padStart(2, '0')}</span>
        <div>
          <h3>{scene.title}</h3>
          <p>{scene.location} · {scene.timeOfDay} · {scene.beat}</p>
        </div>
        <span className="studio-script-count mono">{shots.length} 镜</span>
      </header>
      <textarea
        className="studio-script-synopsis"
        value={synopsis}
        onChange={(event) => setSynopsis(event.target.value)}
        onBlur={() => void save()}
        rows={2}
        aria-label={`场景 ${sceneIndex + 1} 梗概`}
      />
      <div className="studio-script-cast">
        {scene.characters.map((name) => <span key={name}>{name}</span>)}
      </div>
      <div className="studio-script-shots">
        {shots.map((shot) => (
          <button key={shot.id} type="button" onClick={() => { useStudioStore.getState().setStoryboardTab('board'); useStudioStore.getState().selectShot(shot.id) }}>
            <span className="mono">{String(shot.number).padStart(2, '0')}</span>
            <div>
              <b>{shot.title}</b>
              <p>{shot.action}</p>
              {shot.dialogue ? <em>{shot.speaker}：“{shot.dialogue}”</em> : null}
            </div>
            <span className="mono">{shot.durationSec}s</span>
            <ChevronRight size={12} />
          </button>
        ))}
      </div>
    </article>
  )
}

function ShotInspector({ shot, onClose }: { shot: StudioShot; onClose: () => void }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const selectShot = useStudioStore((state) => state.selectShot)
  const [draft, setDraft] = useState<ShotDraft>(draftOf(shot))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [referenceOpen, setReferenceOpen] = useState(false)
  const [checkBusy, setCheckBusy] = useState(false)
  useEffect(() => {
    setDraft(draftOf(shot))
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot.id])
  if (!active) return null
  const scene = active.scenes.find((item) => item.id === shot.sceneId)
  const sourceChapter = scene?.sourceChapterId ? active.chapters.find((chapter) => chapter.id === scene.sourceChapterId) : undefined
  const image = active.assets.find((asset) => asset.id === shot.imageAssetId)
  const video = active.assets.find((asset) => asset.id === shot.videoAssetId)
  const voice = active.assets.find((asset) => asset.id === shot.voiceAssetId)
  const character = active.characters.find((item) => shot.referenceCharacterIds.includes(item.id))
  const place = active.places.find((item) => shot.referencePlaceIds.includes(item.id))
  const activeJob = [...active.jobs].reverse().find((job) => (job.stage === 'visuals' || job.stage === 'voice') && (job.status === 'running' || job.status === 'queued'))
  const update = <K extends keyof ShotDraft,>(key: K, value: ShotDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
    setDirty(true)
  }
  const save = async (): Promise<void> => {
    if (!dirty) return
    await run('save-shot', { shotId: shot.id, ...draft })
    setDirty(false)
  }
  const generateImage = async (): Promise<void> => {
    if (dirty) await save()
    setBusy('image')
    try {
      await run('generate-shot-image', { shotId: shot.id, requestId: `shot-image-${shot.id}-${Date.now()}` })
      notify('info', `第 ${shot.number} 镜已排队生成画面。`)
    } finally {
      setBusy(null)
    }
  }
  const generateVideo = async (): Promise<void> => {
    if (!shot.imageAssetId) return
    if (dirty) await save()
    setBusy('video')
    try {
      await run('generate-shot-video', { shotId: shot.id, requestId: `shot-video-${shot.id}-${Date.now()}` })
      notify('info', `第 ${shot.number} 镜已排队升级为视频。`)
    } finally {
      setBusy(null)
    }
  }
  const generateVoice = async (): Promise<void> => {
    if (dirty) await save()
    setBusy('voice')
    try {
      await run('generate-voice', { shotId: shot.id, requestId: `shot-voice-${shot.id}-${Date.now()}` })
      notify('info', `第 ${shot.number} 镜已排队配音。`)
    } finally {
      setBusy(null)
    }
  }
  const checkShot = async (): Promise<void> => {
    setCheckBusy(true)
    try {
      await run('visual-check', { shotIds: [shot.id] })
      notify('info', `第 ${shot.number} 镜已排队逐帧检查；结果会出现在检查页和这里。`)
    } finally {
      setCheckBusy(false)
    }
  }
  const adopt = async (candidateId: string): Promise<void> => {
    await run('adopt-shot-asset', { shotId: shot.id, candidateId })
    notify('success', '已用这一张。')
  }
  return (
    <aside className="studio-shot-inspector" aria-label={`第 ${shot.number} 镜详情`}>
      <header className="studio-inspector-head">
        <div>
          <span className="studio-eyebrow">镜 {String(shot.number).padStart(2, '0')}</span>
          <h2>{shot.title}</h2>
          <p>{scene?.title ?? '场景'} · {shot.shotSize} · {shot.camera}</p>
          {sourceChapter ? <p className="studio-shot-source">来源：第 {sourceChapter.number} 章《{sourceChapter.title}》</p> : null}
        </div>
        <button type="button" onClick={onClose} aria-label="关闭镜头详情"><X size={14} /></button>
      </header>
      <div className="studio-inspector-scroll">
        <div className="studio-shot-preview">
          {video?.url ? (
            <video src={video.url} controls playsInline poster={image?.thumbUrl ?? image?.url} />
          ) : (
            <AssetImage project={active} assetId={shot.imageAssetId} alt={shot.title} fit="cover" />
          )}
          <div className="studio-shot-preview-meta">
            <span className="mono">{formatTimecode(shot.durationSec, 30).slice(3)}</span>
            <StatusDot status={shot.status} />
            <button type="button" title="设为封面" onClick={() => shot.imageAssetId && void run('set-cover', { assetId: shot.imageAssetId })} disabled={!shot.imageAssetId}>
              <ImageIcon size={12} /> 封面
            </button>
            <button type="button" title="上移镜头" onClick={() => void run('move-shot', { shotId: shot.id, offset: -1 })}><ArrowUp size={12} /> 上移</button>
            <button type="button" title="下移镜头" onClick={() => void run('move-shot', { shotId: shot.id, offset: 1 })}><ArrowDown size={12} /> 下移</button>
          </div>
        </div>

        <div className="studio-inspector-actions">
          <Button variant="gold" size="sm" icon={busy === 'image' ? <Loader2 size={12} className="studio-spin" /> : <WandSparkles size={12} />} onClick={() => void generateImage()} disabled={Boolean(activeJob)}>
            {image ? '重做画面' : '生成画面'}
          </Button>
          <Button variant="ghost" size="sm" icon={busy === 'video' ? <Loader2 size={12} className="studio-spin" /> : <Video size={12} />} onClick={() => void generateVideo()} disabled={!image || Boolean(activeJob)}>
            {video ? '重新生成视频' : '升级为视频'}
          </Button>
          <Button variant="ghost" size="sm" icon={<Upload size={12} />} onClick={() => void useStudioStore.getState().importAssets('image', shot.id)}>导入</Button>
        </div>
        {activeJob ? (
          <div className="studio-inspector-job">
            <JobStatus job={activeJob} />
            <span className="truncate">{activeJob.message}</span>
            <StudioProgress value={activeJob.progress} />
          </div>
        ) : null}

        {(shot.imageCandidates.length || shot.videoCandidates.length) ? (
          <section className="studio-inspector-section">
            <div className="studio-inspector-section-head">
              <h3>候选画面</h3>
              <span>{shot.imageCandidates.length + shot.videoCandidates.length} 个</span>
            </div>
            <div className="studio-candidate-grid">
              {shot.imageCandidates.map((candidate) => {
                const asset = active.assets.find((item) => item.id === candidate.assetId)
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className={['studio-candidate-thumb', shot.imageAssetId === candidate.assetId ? 'is-adopted' : ''].filter(Boolean).join(' ')}
                    onClick={() => void adopt(candidate.id)}
                    title={candidate.adopted ? '已选用' : '用这一张'}
                  >
                    {asset ? <img src={asset.thumbUrl ?? asset.url} alt="" loading="lazy" /> : null}
                    <span>{candidate.label}</span>
                    {shot.imageAssetId === candidate.assetId ? <i><Check size={10} /></i> : null}
                  </button>
                )
              })}
              {shot.videoCandidates.map((candidate) => {
                const asset = active.assets.find((item) => item.id === candidate.assetId)
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className={['studio-candidate-thumb', 'is-video', shot.videoAssetId === candidate.assetId ? 'is-adopted' : ''].filter(Boolean).join(' ')}
                    onClick={() => void adopt(candidate.id)}
                  >
                    {asset ? <img src={asset.thumbUrl ?? asset.url} alt="" loading="lazy" /> : null}
                    <span>{candidate.label}</span>
                    <em><Play size={9} /> 视频</em>
                    {shot.videoAssetId === candidate.assetId ? <i><Check size={10} /></i> : null}
                  </button>
                )
              })}
            </div>
          </section>
        ) : null}

        <section className="studio-inspector-section">
          <div className="studio-inspector-section-head"><h3>镜头</h3><button type="button" className={dirty ? 'is-dirty' : ''} onClick={() => void save()} disabled={!dirty}>{dirty ? '保存镜头' : '已保存'}</button></div>
          <div className="studio-form-grid is-compact">
            <label className="studio-field is-wide"><span>标题</span><input value={draft.title} onChange={(event) => update('title', event.target.value)} /></label>
            <label className="studio-field is-wide"><span>这一镜发生什么</span><textarea rows={3} value={draft.action} onChange={(event) => update('action', event.target.value)} /></label>
            <label className="studio-field"><span>镜头远近</span><input value={draft.shotSize} onChange={(event) => update('shotSize', event.target.value)} /></label>
            <label className="studio-field"><span>镜头怎么动</span><input value={draft.camera} onChange={(event) => update('camera', event.target.value)} /></label>
            <label className="studio-field"><span>时长（秒）</span><input value={draft.durationSec} onChange={(event) => update('durationSec', Math.max(1, Number(event.target.value.replace(/[^\d.]/g, '')) || 1))} inputMode="decimal" /></label>
            <label className="studio-field"><span>前后衔接</span><input value={draft.continuity} onChange={(event) => update('continuity', event.target.value)} /></label>
          </div>
        </section>

        <section className="studio-inspector-section">
          <div className="studio-inspector-section-head"><h3>台词与声音</h3><AudioPill asset={voice} /></div>
          <div className="studio-form-grid is-compact">
            <label className="studio-field"><span>说话人</span><input value={draft.speaker} onChange={(event) => update('speaker', event.target.value)} /></label>
            <label className="studio-field"><span>声线</span>
              <select value={shot.voiceId} onChange={(event) => void run('save-shot', { shotId: shot.id, voiceId: event.target.value })}>
                <option value="">跟随人物 / 默认</option>
                {(engine?.voices ?? []).map((item) => <option key={item.name} value={item.name}>{item.name} · {item.culture}</option>)}
              </select>
            </label>
            <label className="studio-field is-wide"><span>台词</span><textarea rows={3} value={draft.dialogue} onChange={(event) => update('dialogue', event.target.value)} placeholder="这一镜说什么？" /></label>
          </div>
          <div className="studio-inspector-inline">
            <Button variant="ghost" size="sm" icon={busy === 'voice' ? <Loader2 size={12} className="studio-spin" /> : <Mic2 size={12} />} onClick={() => void generateVoice()} disabled={!draft.dialogue.trim() || Boolean(activeJob)}>
              {voice ? '重新配音' : '生成配音'}
            </Button>
            <Button variant="ghost" size="sm" icon={<Upload size={12} />} onClick={() => void useStudioStore.getState().importAssets('audio', shot.id)}>导入配音</Button>
            <span className="mono">{engine?.voices.length ? `${engine.voices.length} 个系统声线` : engine?.voiceError ?? '读取声线中…'}</span>
          </div>
        </section>

        <section className="studio-inspector-section">
          <div className="studio-inspector-section-head"><h3>这一镜的检查</h3><button type="button" className={checkBusy ? 'is-dirty' : ''} onClick={() => void checkShot()} disabled={checkBusy || !shot.imageAssetId}>{checkBusy ? '检查中…' : '检查这一镜'}</button></div>
          {active.checks.filter((check) => check.targetId === shot.id).slice(0, 3).map((check) => (
            <div key={check.id} className={`studio-check-row is-${check.level}`}><b>{check.title}</b><p>{check.detail}</p></div>
          ))}
          {!active.checks.some((check) => check.targetId === shot.id) ? <p className="studio-hint">还没有这一镜的画面检查记录。</p> : null}
        </section>

        <section className="studio-inspector-section">
          <div className="studio-inspector-section-head"><h3>人物与场景参考</h3><span>{shot.lockedReference ? '已固定' : '未固定'}</span></div>
          <div className="studio-reference-row">
            {character ? <span className="studio-ref-chip is-character"><i>{character.name.slice(0, 1)}</i>{character.name}</span> : <span className="studio-ref-chip is-empty">没有人物参考</span>}
            {place ? <span className="studio-ref-chip is-place">{place.name}</span> : null}
            <button type="button" className="studio-ref-library-btn" onClick={() => setReferenceOpen(true)}><Images size={11} /> 参考图库</button>
            <button type="button" className={['studio-lock-btn', shot.lockedReference ? 'is-on' : ''].filter(Boolean).join(' ')} onClick={() => void run('save-shot', { shotId: shot.id, lockedReference: !shot.lockedReference })}>
              {shot.lockedReference ? <Lock size={11} /> : <LockOpen size={11} />}
              {shot.lockedReference ? '取消固定' : '固定参考'}
            </button>
          </div>
          {character?.refAssetIds.length ? (
            <div className="studio-ref-thumbs">
              {character.refAssetIds.map((id) => {
                const asset = active.assets.find((item) => item.id === id)
                return asset ? <img key={id} src={asset.thumbUrl ?? asset.url} alt={character.name} /> : null
              })}
            </div>
          ) : <p className="studio-hint">人物还没有参考图。可在人物卡里关联素材；演示作品已内置参考。</p>}
          <label className="studio-field is-wide"><span>画面描述</span><textarea rows={5} value={draft.prompt} onChange={(event) => update('prompt', event.target.value)} /></label>
        </section>
      </div>
      {referenceOpen ? <ReferenceLibraryDialog shot={shot} onClose={() => setReferenceOpen(false)} /> : null}
    </aside>
  )
}

function ReferenceLibraryDialog({ shot, onClose }: { shot: StudioShot; onClose: () => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const character = active?.characters.find((item) => shot.referenceCharacterIds.includes(item.id))
  const place = active?.places.find((item) => shot.referencePlaceIds.includes(item.id))
  const [characterRefs, setCharacterRefs] = useState<string[]>(character?.refAssetIds ?? [])
  const [placeRefs, setPlaceRefs] = useState<string[]>(place?.refAssetIds ?? [])
  const [saving, setSaving] = useState(false)
  if (!active) return <span />
  const images = active.assets.filter((asset) => asset.kind === 'image')
  const toggle = (current: string[], id: string): string[] => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      if (character) await run('upsert-character', { character: { ...character, refAssetIds: characterRefs } })
      if (place) await run('upsert-place', { place: { ...place, refAssetIds: placeRefs } })
      notify('success', '参考已更新；固定参考后，后面的画面会提示需要重新核对。')
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`参考图库 · 第 ${shot.number} 镜`}
      description="从作品素材里挑人物和地点参考；它们会带进后面的画面生成。"
      width={760}
      layer="overlay"
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={() => void useStudioStore.getState().importAssets('image')}>导入参考图</Button>
          <div><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="gold" onClick={() => void save()} loading={saving}>保存参考</Button></div>
        </div>
      }
    >
      <div className="studio-reference-library">
        {character ? (
          <section>
            <header><b>人物 · {character.name}</b><span>{characterRefs.length} 张已选</span></header>
            <div className="studio-reference-grid">
              {images.map((asset) => (
                <button key={asset.id} type="button" className={characterRefs.includes(asset.id) ? 'is-selected' : ''} onClick={() => setCharacterRefs((current) => toggle(current, asset.id))}>
                  <img src={asset.thumbUrl ?? asset.url} alt={asset.title} loading="lazy" />
                  <span>{asset.title}</span>
                  {characterRefs.includes(asset.id) ? <i><Check size={10} /></i> : null}
                </button>
              ))}
            </div>
          </section>
        ) : <p className="studio-hint">这一镜还没有选人物参考；先在镜头详情里选一张。</p>}
        {place ? (
          <section>
            <header><b>地点 · {place.name}</b><span>{placeRefs.length} 张已选</span></header>
            <div className="studio-reference-grid">
              {images.map((asset) => (
                <button key={asset.id} type="button" className={placeRefs.includes(asset.id) ? 'is-selected' : ''} onClick={() => setPlaceRefs((current) => toggle(current, asset.id))}>
                  <img src={asset.thumbUrl ?? asset.url} alt={asset.title} loading="lazy" />
                  <span>{asset.title}</span>
                  {placeRefs.includes(asset.id) ? <i><Check size={10} /></i> : null}
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {!images.length ? <p className="studio-hint">作品里还没有画面素材，先导入或生成一张参考图。</p> : null}
      </div>
    </Modal>
  )
}

function BulkShotDialog({ sceneId, onClose }: { sceneId: string | null; onClose: () => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [scope, setScope] = useState<'all' | 'scene'>('all')
  const [duration, setDuration] = useState(String(active?.shots[0]?.durationSec ?? 8))
  const [shotSize, setShotSize] = useState(active?.shots[0]?.shotSize ?? '中景')
  const [camera, setCamera] = useState(active?.shots[0]?.camera ?? '固定镜头')
  const [saving, setSaving] = useState(false)
  if (!active) return <span />
  const scene = active.scenes.find((item) => item.id === sceneId)
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await run('update-shots', {
        ...(scope === 'scene' && sceneId ? { sceneId } : {}),
        durationSec: Number(duration) || 8,
        shotSize,
        camera
      })
      notify('success', scope === 'scene' ? `已调整「${scene?.title ?? '当前场景'}」的镜头。` : '已调整全部镜头。')
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="批量调整镜头"
      description="把同一场或全片的时长、镜头远近和镜头运动调成一致；画面与配音会标记为需要重新核对。"
      width={560}
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void save()} loading={saving}>应用到镜头</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field is-wide"><span>范围</span>
          <Segmented value={scope} options={[{ value: 'all', label: `全部 ${active.shots.length} 镜` }, ...(sceneId ? [{ value: 'scene', label: `当前场景 ${scene?.title ?? ''}` }] : [])]} onChange={(value) => setScope(value as 'all' | 'scene')} ariaLabel="批量调整范围" />
        </label>
        <label className="studio-field"><span>时长（秒）</span><input value={duration} onChange={(event) => setDuration(event.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" /></label>
        <label className="studio-field"><span>镜头远近</span><input value={shotSize} onChange={(event) => setShotSize(event.target.value)} placeholder="中景 / 全景 / 特写" /></label>
        <label className="studio-field is-wide"><span>镜头怎么动</span><input value={camera} onChange={(event) => setCamera(event.target.value)} placeholder="固定镜头 / 缓慢推近 / 跟拍" /></label>
      </div>
    </Modal>
  )
}

export function StoryboardView(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const selectedShotId = useStudioStore((state) => state.selectedShotId)
  const selectShot = useStudioStore((state) => state.selectShot)
  const storyboardTab = useStudioStore((state) => state.storyboardTab)
  const setStoryboardTab = useStudioStore((state) => state.setStoryboardTab)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const [batchBusy, setBatchBusy] = useState(false)
  const [assembling, setAssembling] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [musicBusy, setMusicBusy] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [subtitleBusy, setSubtitleBusy] = useState(false)
  if (!active) return <div />
  const shot = active.shots.find((item) => item.id === selectedShotId) ?? null
  const shots = [...active.shots].sort((a, b) => a.number - b.number)
  const visuals = shots.filter((item) => item.imageAssetId || item.videoAssetId).length
  const missing = shots.filter((item) => !item.imageAssetId && !item.videoAssetId)
  const voicesNeeded = shots.filter((item) => item.dialogue.trim())
  const voicesDone = voicesNeeded.filter((item) => item.voiceAssetId).length
  const music = active.assets.filter((asset) => asset.kind === 'audio' && asset.tags.includes('music'))
  const sfx = active.assets.filter((asset) => asset.kind === 'audio' && asset.tags.includes('sfx'))
  const total = shots.reduce((sum, item) => sum + item.durationSec, 0)
  const job = [...active.jobs].reverse().find((item) => (item.stage === 'visuals' || item.stage === 'voice') && (item.status === 'running' || item.status === 'queued'))
  const sceneGroups = active.scenes.map((scene) => ({ scene, shots: shots.filter((item) => item.sceneId === scene.id) }))

  const batchImages = async (): Promise<void> => {
    const targets = missing.length ? missing : shots
    if (!targets.length) return
    setBatchBusy(true)
    try {
      await run('batch-shot-images', { shotIds: targets.map((item) => item.id), requestId: `batch-images-${Date.now()}` })
      notify('info', missing.length ? `已排队补齐 ${targets.length} 镜画面。` : '已排队重新生成全部画面。')
    } finally {
      setBatchBusy(false)
    }
  }
  const assemble = async (): Promise<void> => {
    setAssembling(true)
    try {
      await run('build-timeline')
      notify('success', '时间线已自动装配；可以进入剪辑台播放。')
    } finally {
      setAssembling(false)
    }
  }
  const voices = async (): Promise<void> => {
    const targets = voicesNeeded.filter((item) => !item.voiceAssetId)
    if (!targets.length) {
      notify('info', '所有有台词的镜头都已经有配音。')
      return
    }
    setVoiceBusy(true)
    try {
      await run('generate-voice', { shotIds: targets.map((item) => item.id), requestId: `voice-batch-${Date.now()}` })
      notify('info', `已排队补齐 ${targets.length} 段配音。`)
    } finally {
      setVoiceBusy(false)
    }
  }
  const alignSubtitles = async (): Promise<void> => {
    setSubtitleBusy(true)
    try {
      await run('build-subtitles', {})
      notify('success', '已按台词逐句拆分并对齐字幕；可以到时间线微调。')
    } finally {
      setSubtitleBusy(false)
    }
  }
  const makeMusic = async (kind: 'music' | 'rain' | 'umbrella' | 'heartbeat' = 'music'): Promise<void> => {
    setMusicBusy(true)
    try {
      await run('generate-music', { kind, mood: active.brief.tone, seconds: kind === 'music' ? Math.max(20, Math.round(total || 54)) : 8, requestId: `music-${kind}-${Date.now()}` })
      notify('info', kind === 'music' ? '已排队生成配乐。' : '已排队生成音效。')
    } finally {
      setMusicBusy(false)
    }
  }

  return (
    <div className={`studio-storyboard ${shot && storyboardTab === 'board' ? 'has-inspector' : ''}`}>
      <header className="studio-storyboard-head">
        <div className="studio-storyboard-title">
          <span className="studio-eyebrow">分镜板 · 共 {active.scenes.length} 场</span>
          <h1>{active.title}</h1>
          <div className="studio-storyboard-meta">
            <KindBadge kind={active.kind} />
            <span>{shots.length} 镜</span>
            <i />
            <span>{formatDuration(total)}</span>
            <i />
            <span>{visuals}/{shots.length} 画面</span>
            <i />
            <span>{voicesDone}/{voicesNeeded.length} 配音</span>
            <i />
            <span>{music.length ? '配乐就绪' : '还没有配乐'}</span>
          </div>
        </div>
        <div className="studio-storyboard-actions">
          <div className="studio-tab-switch">
            <button type="button" className={storyboardTab === 'script' ? 'is-active' : ''} onClick={() => setStoryboardTab('script')}><Film size={12} /> 剧本</button>
            <button type="button" className={storyboardTab === 'board' ? 'is-active' : ''} onClick={() => setStoryboardTab('board')}><Images size={12} /> 分镜板</button>
          </div>
          <Button variant="gold" size="sm" icon={batchBusy ? <Loader2 size={12} className="studio-spin" /> : <Sparkles size={12} />} onClick={() => void batchImages()} disabled={Boolean(job)}>
            {missing.length ? `补齐 ${missing.length} 镜画面` : '重新生成全部画面'}
          </Button>
          <Button variant="ghost" size="sm" icon={<SlidersHorizontal size={12} />} onClick={() => setBulkOpen(true)} title="批量调整镜头" aria-label="批量调整">批量调整</Button>
          <Button variant="ghost" size="sm" icon={subtitleBusy ? <Loader2 size={12} className="studio-spin" /> : <Captions size={12} />} onClick={() => void alignSubtitles()} disabled={subtitleBusy || !voicesNeeded.length} title="按台词逐句生成字幕" aria-label="逐句字幕">逐句字幕</Button>
          {!active.timeline.clips.length ? (
            <Button variant="ghost" size="sm" icon={assembling ? <Loader2 size={12} className="studio-spin" /> : <Clapperboard size={12} />} onClick={() => void assemble()} disabled={assembling} title="排好时间线" aria-label="排好时间线">
              排好时间线
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" icon={<Play size={12} />} onClick={() => navigateStage('timeline')} title="去时间线" aria-label="去时间线">
            去时间线
          </Button>
        </div>
      </header>

      {job ? (
        <div className="studio-inline-job">
          <Loader2 size={14} className="studio-spin" />
          <span>{job.label}</span>
          <StudioProgress value={job.progress} />
          <em className="mono">{job.progress}%</em>
          <span className="studio-inline-job-message">{job.message}</span>
        </div>
      ) : null}

      {storyboardTab === 'script' ? (
        <div className="studio-script">
          <div className="studio-script-head">
            <SectionTitle eyebrow="剧本" title="先有剧本，再有分镜" aside={<span className="studio-section-side">{active.scenes.length} 场 · {shots.length} 镜</span>}>
              每一场都能回到原文；改一场只会影响相关镜头，不会删掉已生成的画面。改完简介，点到别处就会保存。
            </SectionTitle>
            <div className="studio-script-tools">
              <Button variant="ghost" size="sm" icon={<RefreshCw size={12} />} onClick={() => void run('generate-storyboard').then(() => notify('info', '已按蓝图更新镜头字段；已有画面不受影响。'))}>重排镜头</Button>
              <Button variant="ghost" size="sm" icon={voiceBusy ? <Loader2 size={12} className="studio-spin" /> : <Mic2 size={12} />} onClick={() => void voices()} disabled={voiceBusy || Boolean(job)}>补齐配音</Button>
            </div>
          </div>
          <div className="studio-script-grid">
            {sceneGroups.map(({ scene }, index) => <SceneScript key={scene.id} sceneIndex={index} />)}
          </div>
          <div className="studio-script-foot">
            <span><Sparkles size={12} /> 台词与动作已经进入镜头计划</span>
            <span className="mono">TOTAL {formatTimecode(total, 30)}</span>
          </div>
        </div>
      ) : (
        <>
          <div className="studio-board-toolbar">
            <div className="studio-board-toolbar-left">
              <span className="studio-board-count"><b>{visuals}</b> / {shots.length} 镜有画面</span>
              <span className="studio-board-missing">{missing.length ? `${missing.length} 镜待生成` : '画面齐全'}</span>
              <Button variant="ghost" size="sm" icon={voiceBusy ? <Loader2 size={12} className="studio-spin" /> : <Mic2 size={12} />} onClick={() => void voices()} disabled={voiceBusy || Boolean(job)}>补齐配音</Button>
              <Button variant="ghost" size="sm" icon={musicBusy ? <Loader2 size={12} className="studio-spin" /> : <Music2 size={12} />} onClick={() => void makeMusic('music')} disabled={musicBusy || Boolean(job)}>生成配乐</Button>
            </div>
            <div className="studio-board-toolbar-right">
              {music[0] ? <AudioPill asset={music[0]} compact /> : <span className="studio-audio is-missing"><Music2 size={12} /> 暂无配乐</span>}
              <span className="mono">{formatTimecode(total, 30)}</span>
            </div>
          </div>

          <div className="studio-board-scroll">
            {sceneGroups.map(({ scene, shots: sceneShots }, sceneIndex) => (
              <section key={scene.id} className="studio-board-scene">
                <div className="studio-board-scene-head">
                  <span className="mono">场 {String(sceneIndex + 1).padStart(2, '0')}</span>
                  <h2>{scene.title}</h2>
                  <span>{scene.location} · {scene.timeOfDay}</span>
                  <i />
                  <span>{sceneShots.length} 镜 · {formatDuration(sceneShots.reduce((sum, shot) => sum + shot.durationSec, 0))}</span>
                </div>
                <div className="studio-shot-grid">
                  {sceneShots.map((item) => {
                    const asset = active.assets.find((entry) => entry.id === (item.videoAssetId ?? item.imageAssetId))
                    const hasVoice = Boolean(item.voiceAssetId)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={['studio-shot-card', selectedShotId === item.id ? 'is-selected' : '', !asset ? 'is-empty' : '', item.videoAssetId ? 'is-video' : ''].filter(Boolean).join(' ')}
                        onClick={() => selectShot(item.id)}
                      >
                        <div className="studio-shot-image">
                          {asset ? (
                            item.videoAssetId ? <video src={asset.url} muted playsInline preload="metadata" poster={asset.thumbUrl} /> : <img src={asset.thumbUrl ?? asset.url} alt={item.title} loading="lazy" />
                          ) : (
                            <span className="studio-shot-missing"><ImageIcon size={18} strokeWidth={1.2} />待生成</span>
                          )}
                          <span className="studio-shot-number mono">{String(item.number).padStart(2, '0')}</span>
                          <span className="studio-shot-duration mono">{item.durationSec}s</span>
                          {item.videoAssetId ? <span className="studio-shot-video-tag"><Video size={10} /> VIDEO</span> : null}
                          {item.dialogue ? <span className={['studio-shot-voice', hasVoice ? 'is-on' : ''].filter(Boolean).join(' ')}><Mic2 size={10} /></span> : null}
                          {item.imageCandidates.length + item.videoCandidates.length > 1 ? <span className="studio-shot-candidates mono">{item.imageCandidates.length + item.videoCandidates.length} 张候选</span> : null}
                        </div>
                        <div className="studio-shot-info">
                          <b>{item.title}</b>
                          <span>{item.shotSize} · {item.camera}</span>
                          <em><StatusDot status={item.status} label={false} /> {studioStatusLabel(item.status)}</em>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
          <footer className="studio-board-foot">
            <span><Clock3 size={12} /> 时长合计 {formatDuration(total)} · 24/30fps 可选</span>
            <span><Lock size={12} /> 参考锁定后角色更稳定</span>
            <span><Sparkles size={12} /> 单镜重做会保留旧画面</span>
          </footer>
        </>
      )}
      {shot && storyboardTab === 'board' ? <ShotInspector shot={shot} onClose={() => selectShot(null)} /> : null}
      {bulkOpen ? <BulkShotDialog sceneId={shot?.sceneId ?? null} onClose={() => setBulkOpen(false)} /> : null}
    </div>
  )
}
