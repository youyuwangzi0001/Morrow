import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Clapperboard,
  Download,
  ExternalLink,
  FileArchive,
  FileSearch,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Music2,
  Package,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Subtitles,
  Upload,
  X
} from 'lucide-react'
import type { StudioDelivery, StudioExportPreflight } from '@shared/studio'
import { formatDuration, formatWordCount, isStudioVideoDelivery, studioKindLabel } from '@shared/studio'
import { Button, Modal, Segmented } from '../../ui'
import { useStudioStore } from './studio-store'
import { formatBytes, studioApi } from './api'
import { AssetImage, CoverThumb, Money, SectionTitle, StudioProgress, timeAgo } from './components'

function deliveryIcon(kind: StudioDelivery['kind']): React.JSX.Element {
  switch (kind) {
    case 'mp4':
      return <Film size={15} />
    case 'epub':
    case 'pdf':
    case 'docx':
    case 'txt':
    case 'md':
      return <BookOpen size={15} />
    case 'srt':
    case 'ass':
      return <Subtitles size={15} />
    case 'wav':
    case 'mp3':
    case 'm4a':
    case 'flac':
      return <Music2 size={15} />
    case 'cover':
    case 'comic':
      return <ImageIcon size={15} />
    case 'folder':
    case 'package':
      return <FileArchive size={15} />
    default:
      return <FileText size={15} />
  }
}

const FORMAT_HINTS: Record<'mp4' | 'mov' | 'mkv' | 'webm', string> = {
  mp4: 'MP4 最通用：视频网站、微信和手机都能直接播放。',
  mov: 'MOV 适合苹果设备和剪辑软件，文件会更大。',
  mkv: 'MKV 适合保留多轨；少数播放器要额外解码。',
  webm: 'WebM 适合放进网页；部分剪辑软件不认。'
}

const AUDIO_LABELS: Record<'wav' | 'mp3' | 'm4a' | 'flac', string> = {
  wav: 'WAV',
  mp3: 'MP3',
  m4a: 'AAC',
  flac: 'FLAC'
}

const AUDIO_TITLES: Record<'wav' | 'mp3' | 'm4a' | 'flac', string> = {
  wav: '无损音质，文件最大',
  mp3: '最通用，文件小',
  m4a: '苹果设备常用',
  flac: '无损压缩，比 WAV 小'
}

export function DeliveryView(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const setView = useStudioStore((state) => state.setView)
  const setSettingsOpen = useStudioStore((state) => state.setSettingsOpen)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const [quality, setQuality] = useState<'draft' | 'final'>('draft')
  const [audioExporting, setAudioExporting] = useState<string | null>(null)
  const [comicExporting, setComicExporting] = useState(false)
  const [aspect, setAspect] = useState<'16:9' | '9:16' | '1:1'>('16:9')
  const [subtitleMode, setSubtitleMode] = useState<'burn' | 'soft'>('burn')
  const [format, setFormat] = useState<'mp4' | 'mov' | 'mkv' | 'webm'>('mp4')
  const [resolution, setResolution] = useState<'1080p' | '2160p'>('1080p')
  const [exporting, setExporting] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [preflightOpen, setPreflightOpen] = useState(false)
  const [preflightBusy, setPreflightBusy] = useState(false)
  const [preflight, setPreflight] = useState<StudioExportPreflight | null>(null)
  if (!active) return <div />
  const deliveries = [...active.deliveries].sort((a, b) => b.createdAt - a.createdAt)
  const latestVideo = deliveries.find((delivery) => isStudioVideoDelivery(delivery.kind))
  const coverDelivery = deliveries.find((delivery) => delivery.kind === 'cover')
  const words = active.chapters.reduce((sum, chapter) => sum + chapter.content.replace(/\s+/g, '').length, 0)
  const shots = active.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length
  const voicesNeeded = active.shots.filter((shot) => shot.dialogue.trim())
  const voices = voicesNeeded.filter((shot) => shot.voiceAssetId).length
  const subtitles = active.timeline.clips.filter((clip) => clip.kind === 'subtitle').length
  const unresolved = active.checks.filter((check) => check.level === 'error').length
  const activeRenderJob = [...active.jobs].reverse().find((job) => job.kind === 'render' && (job.status === 'running' || job.status === 'queued'))
  const canVideo = engine?.ffmpeg.available
  const checks = useMemo(() => active.kind === 'drama'
    ? [
        { label: `画面齐了（${shots}/${active.shots.length} 镜）`, ok: active.shots.length > 0 && shots === active.shots.length },
        { label: `配音齐了（${voices}/${voicesNeeded.length} 段）`, ok: voices === voicesNeeded.length },
        { label: `字幕 ${subtitles} 条`, ok: subtitles > 0 },
        { label: '时间线已排好', ok: active.timeline.clips.length > 0 },
        { label: '视频合成工具可用', ok: Boolean(engine?.ffmpeg.available) },
        { label: '没有必须修的问题', ok: unresolved === 0 }
      ]
    : [
        { label: `正文齐了（${active.chapters.filter((chapter) => chapter.content.trim()).length}/${active.chapters.length} 章）`, ok: active.chapters.length > 0 && active.chapters.every((chapter) => chapter.content.trim()) },
        { label: `共 ${formatWordCount(words)} 字`, ok: words > 0 },
        { label: '人物与设定能对回原文', ok: active.facts.length > 0 },
        { label: '没有必须修的问题', ok: unresolved === 0 }
      ], [active, shots, voices, voicesNeeded.length, subtitles, unresolved, engine, words])
  const readyCount = checks.filter((check) => check.ok).length
  const renderHint = `${quality === 'draft' ? '草稿用 540p 快速合成，先看节奏。' : `成片按 ${resolution === '2160p' ? '4K' : '1080p'} 输出。`} ${FORMAT_HINTS[format]}${subtitleMode === 'burn' ? '字幕会压在画面里。' : '字幕会单独给一份文件。'}`

  const useRecommended = (): void => {
    setQuality('final')
    setFormat('mp4')
    setSubtitleMode('burn')
    setResolution('1080p')
    setAspect(active.timeline.aspect)
  }

  const exportFormat = async (format: 'txt' | 'md' | 'epub' | 'pdf' | 'docx' | 'srt' | 'ass' | 'package' | 'cover' | 'folder'): Promise<void> => {
    if (exporting) return
    setExporting(format)
    try {
      await run('export', { format, requestId: `export-${format}-${Date.now()}` })
      notify('info', '导出任务已开始；完成后会出现在下方交付记录。')
    } finally {
      setExporting(null)
    }
  }
  const exportAudio = async (format: 'wav' | 'mp3' | 'm4a' | 'flac'): Promise<void> => {
    if (audioExporting) return
    setAudioExporting(format)
    try {
      await run('export-audio', { format, requestId: `export-audio-${format}-${Date.now()}` })
      notify('info', '音频提取已开始；完成后会出现在下方交付记录。')
    } finally {
      setAudioExporting(null)
    }
  }
  const exportComic = async (): Promise<void> => {
    if (comicExporting) return
    setComicExporting(true)
    try {
      await run('export-comic', { requestId: `export-comic-${Date.now()}` })
      notify('info', '四格漫画排版已开始；完成后会出现在下方交付记录。')
    } finally {
      setComicExporting(false)
    }
  }

  const openProjectFolder = async (): Promise<void> => {
    try {
      await studioApi.openProjectDir(active.id)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }

  const openPreflight = async (): Promise<void> => {
    if (preflightBusy) return
    setPreflightOpen(true)
    setPreflightBusy(true)
    try {
      const result = await run<StudioExportPreflight>('export-preflight', { projectId: active.id })
      setPreflight(result)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
      setPreflightOpen(false)
    } finally {
      setPreflightBusy(false)
    }
  }

  const render = async (): Promise<void> => {
    if (rendering || activeRenderJob) return
    setRendering(true)
    try {
      await run('render', { quality, subtitleMode, aspect, format, resolution })
      notify('info', quality === 'draft' ? '动态分镜草稿已排队合成。' : `成片已排队合成（${resolution === '2160p' ? '4K' : '1080p'} · ${format.toUpperCase()}）。`)
    } finally {
      setRendering(false)
    }
  }

  const open = async (delivery: StudioDelivery): Promise<void> => {
    try {
      await studioApi.openPath(active.id, delivery.path)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }
  const reveal = async (delivery: StudioDelivery): Promise<void> => {
    try {
      await studioApi.reveal(active.id, delivery.path)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }

  const bookFormats = [
    { format: 'epub' as const, title: 'EPUB', desc: '电子书 · 手机和阅读器打开，带目录', icon: <BookOpen size={16} /> },
    { format: 'pdf' as const, title: 'PDF', desc: 'A4 排版稿 · 适合打印或发给编辑', icon: <FileText size={16} /> },
    { format: 'docx' as const, title: 'Word', desc: 'DOCX · 可以继续改字', icon: <FileText size={16} /> },
    { format: 'txt' as const, title: 'TXT', desc: '纯文本 · 哪里都能打开', icon: <FileText size={16} /> },
    { format: 'md' as const, title: 'Markdown', desc: '方便逐行比较和版本管理', icon: <FileText size={16} /> },
    { format: 'package' as const, title: '工程包', desc: '可继续编辑 · 素材都在', icon: <Package size={16} /> }
  ]

  return (
    <div className="studio-delivery">
      <header className="studio-delivery-head">
        <div className="studio-delivery-title">
          <span className="studio-eyebrow">交付 · {active.kind === 'drama' ? '影片' : '书稿'}</span>
          <h1>{active.title}</h1>
          <p>{active.logline}</p>
          <div className="studio-delivery-meta">
            <span>{studioKindLabel(active.kind)}</span>
            <i />
            <span>{active.kind === 'drama' ? `${active.timeline.durationSec ? formatDuration(active.timeline.durationSec) : '未排好'} · ${active.shots.length} 镜` : `${active.chapters.length} 章 · ${formatWordCount(words)} 字`}</span>
            <i />
            <span>{deliveries.length} 个文件</span>
            <i />
            <span>{readyCount}/{checks.length} 项已就绪</span>
          </div>
        </div>
        <div className="studio-delivery-actions">
          <Button variant="ghost" icon={<FileSearch size={13} />} onClick={() => void openPreflight()} title="检查字体、FFmpeg 与各格式是否就绪；不会生成文件">导出预检</Button>
          <Button variant="ghost" icon={<ShieldCheck size={13} />} onClick={() => navigateStage('review')}>检查</Button>
          <Button variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void openProjectFolder()}>打开作品文件夹</Button>
        </div>
      </header>

      <div className="studio-delivery-grid">
        <section className="studio-delivery-hero">
          <div className="studio-delivery-poster">
            {latestVideo?.url ? (
              <video src={latestVideo.url} controls playsInline poster={coverDelivery?.url} />
            ) : coverDelivery?.url ? (
              <img src={coverDelivery.url} alt="" />
            ) : (
              <CoverThumb project={active} size="lg" />
            )}
            <div className="studio-delivery-poster-overlay">
              <span className="studio-eyebrow">{latestVideo ? '最新成片' : '作品封面'}</span>
              <h2>{active.title}</h2>
              <p>{active.kind === 'drama' ? `${active.timeline.durationSec ? formatDuration(active.timeline.durationSec) : '待合成'} · 16:9 · 本地创作` : `${formatWordCount(words)} 字 · ${active.chapters.length} 章`}</p>
            </div>
          </div>
          <div className="studio-delivery-readiness">
            <div className="studio-readiness-head">
              <span className="studio-eyebrow">导出预检</span>
              <b className="mono">{readyCount}/{checks.length}</b>
            </div>
            <StudioProgress value={(readyCount / checks.length) * 100} tone={readyCount === checks.length ? 'patina' : 'gold'} />
            <div className="studio-readiness-list">
              {checks.map((check) => <span key={check.label} className={check.ok ? 'is-ok' : ''}>{check.ok ? <Check size={11} /> : <span className="studio-dot" />} {check.label}</span>)}
            </div>
            {!canVideo && active.kind === 'drama' ? <p className="studio-hint">视频合成工具还没就绪：仍可导出工程、字幕和封面；到「设置 → 声音与工具」选择 ffmpeg.exe 后就能合成。</p> : null}
          </div>
        </section>

        <section className="studio-delivery-panel">
          {active.kind === 'drama' ? (
            <>
              <SectionTitle eyebrow="合成" title={latestVideo ? '重新合成或导出新版本' : '合成第一版草稿'} aside={<span className="studio-section-side">{activeRenderJob ? <Loader2 size={12} className="studio-spin" /> : <Sparkles size={12} />} {canVideo ? '本机合成' : '缺合成工具'}</span>}>
                草稿用 540p 快速预览；成片可选 1080p / 4K 与 MP4、MOV、MKV、WebM。合成不会改动素材和时间线。
              </SectionTitle>
              <div className="studio-render-recommend">
                <button type="button" onClick={useRecommended}>不知道怎么选？用推荐设置</button>
                <span>成片 · 1080p · MP4 · 画面内字幕</span>
              </div>
              <div className="studio-render-options">
                <div className="studio-render-option"><span>质量</span>
                  <Segmented value={quality} options={[{ value: 'draft', label: '草稿', description: '540p 快速预览，只看节奏' }, { value: 'final', label: '成片', description: '按你选的清晰度导出' }]} onChange={(value) => { setQuality(value); if (value === 'draft') setSubtitleMode('burn') }} ariaLabel="合成档位" />
                </div>
                <div className="studio-render-option"><span>画面比例</span>
                  <Segmented value={aspect} options={[{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }]} onChange={setAspect} ariaLabel="成片画幅" />
                </div>
                <div className="studio-render-option"><span>字幕</span>
                  <Segmented value={subtitleMode} options={[{ value: 'burn', label: '画面内字幕', description: '观众不用另找字幕文件' }, { value: 'soft', label: '单独字幕', description: '播放器里可以开关' }]} onChange={setSubtitleMode} ariaLabel="字幕方式" />
                </div>
                <div className="studio-render-option"><span>格式</span>
                  <Segmented value={format} options={[{ value: 'mp4', label: 'MP4' }, { value: 'mov', label: 'MOV' }, { value: 'mkv', label: 'MKV' }, { value: 'webm', label: 'WebM' }]} onChange={(value) => setFormat(value as typeof format)} ariaLabel="成片格式" />
                </div>
                {quality === 'final' ? (
                  <div className="studio-render-option"><span>清晰度</span>
                    <Segmented value={resolution} options={[{ value: '1080p', label: '1080p' }, { value: '2160p', label: '4K' }]} onChange={(value) => setResolution(value as typeof resolution)} ariaLabel="成片清晰度" />
                  </div>
                ) : null}
              </div>
              <p className="studio-render-hint">{renderHint}</p>
              <div className="studio-render-action">
                <Button variant="gold" size="lg" icon={rendering || activeRenderJob ? <Loader2 size={15} className="studio-spin" /> : <Clapperboard size={15} />} onClick={() => void render()} disabled={rendering || Boolean(activeRenderJob)}>
                  {activeRenderJob ? '正在合成' : quality === 'draft' ? '合成草稿' : `导出成片 · ${resolution === '2160p' ? '4K' : '1080p'} ${format.toUpperCase()}`}
                </Button>
                {latestVideo ? <Button variant="ghost" size="lg" icon={<Play size={14} />} onClick={() => void open(latestVideo)}>用电脑播放器打开</Button> : null}
                <span className="studio-render-note">合成不会改动素材和时间线；失败的镜头会留在检查页。</span>
              </div>
              {latestVideo ? (
                <div className="studio-delivery-audio">
                  <span>成片音轨</span>
                  {(['wav', 'mp3', 'm4a', 'flac'] as const).map((audio) => (
                    <button key={audio} type="button" title={AUDIO_TITLES[audio]} onClick={() => void exportAudio(audio)} disabled={Boolean(audioExporting)}>
                      <Music2 size={12} /> {AUDIO_LABELS[audio]}
                      {audioExporting === audio ? <Loader2 size={11} className="studio-spin" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="studio-delivery-subformats">
                {active.shots.filter((shot) => shot.imageAssetId).length >= 4 ? (
                  <button type="button" onClick={() => void exportComic()} disabled={comicExporting}><ImageIcon size={14} /><span><b>四格漫画</b><em>2×2 拼图</em></span>{comicExporting ? <Loader2 size={11} className="studio-spin" /> : null}</button>
                ) : null}
                <button type="button" onClick={() => void exportFormat('srt')} disabled={Boolean(exporting)}><Subtitles size={14} /><span><b>SRT 字幕</b><em>逐条可改</em></span></button>
                <button type="button" onClick={() => void exportFormat('ass')} disabled={Boolean(exporting)}><Subtitles size={14} /><span><b>ASS 字幕</b><em>保留样式</em></span></button>
                <button type="button" onClick={() => void exportFormat('cover')} disabled={Boolean(exporting)}><ImageIcon size={14} /><span><b>封面</b><em>1200×1600</em></span></button>
                <button type="button" onClick={() => void exportFormat('package')} disabled={Boolean(exporting)}><Package size={14} /><span><b>工程包</b><em>可继续编辑</em></span></button>
                <button type="button" onClick={() => void exportFormat('folder')} disabled={Boolean(exporting)}><FileArchive size={14} /><span><b>发布文件包</b><em>成片 + 封面 + 字幕</em></span></button>
              </div>
            </>
          ) : (
            <>
              <SectionTitle eyebrow="导出" title="电子书、排版稿与可继续修改的工程包" aside={<span className="studio-section-side"><Sparkles size={12} /> 本机导出</span>}>
                正文、目录与中文字体会一起带进文件；工程包保留全部章节、人物与任务记录，便于继续修改。
              </SectionTitle>
              <div className="studio-book-formats">
                {bookFormats.map((item) => (
                  <button key={item.format} type="button" onClick={() => void exportFormat(item.format)} disabled={Boolean(exporting)}>
                    <span className="studio-format-icon">{item.icon}</span>
                    <span><b>{item.title}</b><em>{item.desc}</em></span>
                    {exporting === item.format ? <Loader2 size={13} className="studio-spin" /> : <Download size={13} />}
                  </button>
                ))}
                <button type="button" onClick={() => void exportFormat('cover')} disabled={Boolean(exporting)}>
                  <span className="studio-format-icon"><ImageIcon size={16} /></span>
                  <span><b>封面</b><em>从封面素材或标题生成</em></span>
                  {exporting === 'cover' ? <Loader2 size={13} className="studio-spin" /> : <Download size={13} />}
                </button>
                <button type="button" onClick={() => void exportFormat('folder')} disabled={Boolean(exporting)}>
                  <span className="studio-format-icon"><FileArchive size={16} /></span>
                  <span><b>发布文件包</b><em>成书 + 封面 + 工程包</em></span>
                  {exporting === 'folder' ? <Loader2 size={13} className="studio-spin" /> : <Download size={13} />}
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      <section className="studio-delivery-list">
        <SectionTitle eyebrow="文件" title="导出过的文件" aside={<span className="studio-section-side">{deliveries.length} 个文件 · 可核对</span>}>
          每个文件都有校验码和生成时间；换电脑或重装前，建议先把可编辑工程另存一份。
        </SectionTitle>
        {deliveries.length ? (
          <div className="studio-delivery-rows">
            {deliveries.map((delivery) => (
              <div key={delivery.id} className="studio-delivery-row" title={`校验码 ${delivery.sha256}`}>
                <span className={`studio-delivery-icon is-${delivery.kind}`}>{deliveryIcon(delivery.kind)}</span>
                <div className="studio-delivery-copy">
                  <b>{delivery.label}</b>
                  <span className="mono">{delivery.path} · {formatBytes(delivery.bytes)} · {timeAgo(delivery.createdAt)}</span>
                </div>
                <div className="studio-delivery-row-actions">
                  <button type="button" onClick={() => void open(delivery)}><ExternalLink size={12} /> 打开</button>
                  <button type="button" title="在文件夹中显示" onClick={() => void reveal(delivery)}><FolderOpen size={12} /> 找文件</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="studio-delivery-empty">
            <Package size={24} strokeWidth={1.2} />
            <h3>还没有导出文件</h3>
            <p>{active.kind === 'drama' ? '合成草稿后，成片与字幕会出现在这里。' : '选一个格式导出，第一个文件会出现在这里。'}</p>
          </div>
        )}
      </section>

      <footer className="studio-delivery-foot">
        <span><ShieldCheck size={12} /> 密钥不会跟着文件导出</span>
        <span><RefreshCw size={12} /> 导出错了可以重新合成</span>
        <span><Money value={active.runtime.budget.spent} /> 已记录费用</span>
        <button type="button" onClick={() => setSettingsOpen(true)}>模型与预算 <ArrowRight size={11} /></button>
      </footer>

      <Modal
        open={preflightOpen}
        onClose={() => setPreflightOpen(false)}
        title="导出预检"
        description="看看字体、视频工具和每种格式是否就绪；不会生成文件，也不会修改作品。"
        width={640}
        layer="overlay"
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setPreflightOpen(false)}>关闭</Button>
          </div>
        }
      >
        {preflightBusy && !preflight ? (
          <div className="studio-version-loading"><Loader2 size={15} className="studio-spin" /> 正在检查字体与工具…</div>
        ) : preflight ? (
          <div className="studio-preflight">
            <div className="studio-preflight-summary">
              <div>
                <span>中文字体</span>
                <b>{preflight.fonts.serif ? '衬线可用' : '衬线缺失'}{preflight.fonts.sans ? ' · 黑体可用' : ' · 黑体缺失'}</b>
                <em>
                  {preflight.fonts.bundledSerif
                    ? '随包 Noto Serif SC Variable'
                    : preflight.fonts.detected.slice(0, 5).join(' · ') || '未检测到中文字体文件'}
                </em>
              </div>
              <div>
                <span>FFmpeg</span>
                <b>{preflight.ffmpeg.available ? (preflight.ffmpeg.profile === 'enhanced' ? '已安装 · 增强包' : '已安装 · 默认包') : '未安装'}</b>
                <em>{preflight.ffmpeg.message}</em>
              </div>
            </div>
            <p className="studio-settings-hint">{preflight.fonts.detail}</p>
            <div className="studio-preflight-grid">
              {preflight.formats.map((item) => (
                <div key={item.format} className={item.ready ? 'is-ready' : ''}>
                  <span>{item.ready ? <Check size={11} /> : <X size={11} />}</span>
                  <div><b>{item.label}</b><em>{item.note}</em></div>
                </div>
              ))}
            </div>
            {preflight.warnings.length ? (
              <div className="studio-preflight-warnings">
                {preflight.warnings.map((warning) => <p key={warning}><AlertTriangle size={12} /> {warning}</p>)}
              </div>
            ) : <p className="studio-settings-hint">这台电脑已经满足主要导出条件；换电脑打开时，仍建议检查字体与播放器兼容性。</p>}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
