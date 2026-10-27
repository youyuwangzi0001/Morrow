import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Info,
  Loader2,
  Mic2,
  Package,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
  X
} from 'lucide-react'
import { formatDuration, formatWordCount, isStudioVideoDelivery, studioJobStatusLabel, studioStatusLabel } from '@shared/studio'
import { Modal, Button } from '../../ui'
import { useStudioStore } from './studio-store'
import { JobStatus, Money, SectionTitle, StageIcon, StudioProgress, timeAgo } from './components'

function levelIcon(level: 'info' | 'warn' | 'error'): React.JSX.Element {
  if (level === 'error') return <CircleAlert size={14} />
  if (level === 'warn') return <AlertTriangle size={14} />
  return <Info size={14} />
}

export function ReviewView(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const setView = useStudioStore((state) => state.setView)
  const selectShot = useStudioStore((state) => state.selectShot)
  const selectChapter = useStudioStore((state) => state.selectChapter)
  const setSettingsOpen = useStudioStore((state) => state.setSettingsOpen)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const cancelJob = useStudioStore((state) => state.cancelJob)
  const [visualBusy, setVisualBusy] = useState(false)
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoConfirm, setAutoConfirm] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState<string | null>(null)
  if (!active) return <div />
  const checks = active.checks
  const errors = checks.filter((check) => check.level === 'error')
  const warns = checks.filter((check) => check.level === 'warn')
  const infos = checks.filter((check) => check.level === 'info')
  const jobs = [...active.jobs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 14)
  const visuals = active.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length
  const voicesNeeded = active.shots.filter((shot) => shot.dialogue.trim())
  const voices = voicesNeeded.filter((shot) => shot.voiceAssetId).length
  const subtitles = active.timeline.clips.filter((clip) => clip.kind === 'subtitle').length
  const words = active.chapters.reduce((sum, chapter) => sum + chapter.content.replace(/\s+/g, '').length, 0)
  const missingImages = active.shots.filter((shot) => !shot.imageAssetId && !shot.videoAssetId).length
  const missingVoices = active.shots.filter((shot) => shot.dialogue.trim() && !shot.voiceAssetId).length
  const hasMusic = active.assets.some((asset) => asset.kind === 'audio' && asset.tags.includes('music'))
  const emptyChapters = active.chapters.filter((chapter) => !chapter.content.trim()).length
  const autoSteps = active.kind === 'drama'
    ? [
        missingImages ? `补齐 ${missingImages} 镜缺失画面` : '',
        missingVoices ? `补齐 ${missingVoices} 段台词配音` : '',
        hasMusic ? '' : '生成一段配乐',
        active.timeline.clips.length ? '沿用已保存的时间线' : '自动排好时间线',
        '合成一版可审看的草稿'
      ].filter(Boolean)
    : [emptyChapters ? `连续续写最多 ${Math.min(3, emptyChapters)} 个空章` : '没有空章需要续写']
  const candidates = active.chapters.reduce((sum, chapter) => sum + chapter.candidates.length, 0)
  const retryJob = async (jobId: string): Promise<void> => {
    try {
      await run('retry-job', { jobId })
      notify('info', '已按任务输入快照重新排队；旧记录保留以便核对。')
    } catch {
      // store 已提示错误
    }
  }
  const reconcileJob = async (jobId: string): Promise<void> => {
    if (reconciling) return
    setReconciling(jobId)
    try {
      const result = await run('reconcile-external', { jobId })
      notify('info', result.message ?? '已开始核对并取回外部任务结果。')
      setExpandedJobId(jobId)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setReconciling(null)
    }
  }
  const jobCost = jobs.reduce((sum, job) => sum + (typeof job.cost === 'number' ? job.cost : 0), 0)
  const unknownCost = jobs.some((job) => job.cost === null)
  const readiness = useMemo(() => {
    const rows = active.kind === 'drama'
      ? [
          { label: `${visuals}/${active.shots.length} 镜有画面`, ok: visuals === active.shots.length && active.shots.length > 0 },
          { label: `${voices}/${voicesNeeded.length} 段台词有配音`, ok: voices === voicesNeeded.length },
          { label: `${subtitles} 条字幕`, ok: subtitles > 0 },
          { label: '配乐已就位', ok: active.assets.some((asset) => asset.kind === 'audio' && asset.tags.includes('music')) },
          { label: '时间线已排好', ok: active.timeline.clips.length > 0 },
          { label: '已合成成片', ok: active.deliveries.some((delivery) => isStudioVideoDelivery(delivery.kind)) }
        ]
      : [
          { label: `${active.chapters.filter((chapter) => chapter.content.trim()).length}/${active.chapters.length} 章有正文`, ok: active.chapters.length > 0 && active.chapters.every((chapter) => chapter.content.trim()) },
          { label: `${candidates} 个候选待采用`, ok: candidates === 0 },
          { label: '人物与事实可追溯', ok: active.facts.length > 0 },
          { label: '已导出交付物', ok: active.deliveries.length > 0 }
        ]
    return rows
  }, [active, visuals, voices, voicesNeeded.length, subtitles, candidates])
  const readyCount = readiness.filter((row) => row.ok).length
  const rerun = async (): Promise<void> => {
    await run('review')
    notify('info', '检查完成，结果已写进作品。')
  }
  const fixMissing = async (): Promise<void> => {
    const missing = active.shots.filter((shot) => !shot.imageAssetId && !shot.videoAssetId)
    if (!missing.length) return
    await run('batch-shot-images', { shotIds: missing.map((shot) => shot.id), requestId: `review-fix-${Date.now()}` })
    notify('info', `已排队补齐 ${missing.length} 镜画面。`)
  }
  const visualCheck = async (): Promise<void> => {
    if (visualBusy) return
    setVisualBusy(true)
    try {
      const result = await run('visual-check')
      notify('info', result.message ?? '视觉检查已排队。')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setVisualBusy(false)
    }
  }
  const voiceAudit = async (): Promise<void> => {
    if (voiceBusy) return
    setVoiceBusy(true)
    try {
      await run('voice-audit')
      notify('success', '人物语气审稿完成，结果已写入检查项。')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setVoiceBusy(false)
    }
  }
  const autoAdvance = async (): Promise<void> => {
    if (autoBusy) return
    setAutoBusy(true)
    try {
      const result = await run('auto-advance', { useModel: Boolean(engine?.text.configured), renderDraft: active.kind === 'drama' })
      notify('info', result.message ?? '已排队补齐缺失内容。')
      setAutoConfirm(false)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setAutoBusy(false)
    }
  }
  const jump = (targetId?: string): void => {
    if (!targetId) return
    const shot = active.shots.find((item) => item.id === targetId)
    if (shot) {
      selectShot(shot.id)
      setView('storyboard')
      return
    }
    const chapter = active.chapters.find((item) => item.id === targetId)
    if (chapter) {
      selectChapter(chapter.id)
      setView('writing')
      return
    }
    const fact = active.facts.find((item) => item.id === targetId)
    if (fact) {
      if (fact.chapterId) {
        selectChapter(fact.chapterId)
        setView('writing')
        return
      }
      if (fact.sceneId) {
        const shot = active.shots.find((item) => item.sceneId === fact.sceneId)
        if (shot) {
          selectShot(shot.id)
          setView('storyboard')
          return
        }
      }
    }
    const clip = active.timeline.clips.find((item) => item.id === targetId)
    if (clip) {
      navigateStage('timeline')
    }
  }

  return (
    <div className="studio-review">
      <header className="studio-review-head">
        <div>
          <span className="studio-eyebrow">检查与记录 · 08</span>
          <h1>制作检查</h1>
          <p>每一项都能核对、能重做、能说明原因。</p>
          <div className="studio-review-meta">
            <span>{errors.length} 个错误</span>
            <i />
            <span>{warns.length} 条提醒</span>
            <i />
            <span>{readyCount}/{readiness.length} 项就绪</span>
            <i />
            <span>已花费用 ¥{active.runtime.budget.spent.toFixed(2)}</span>
          </div>
        </div>
        <div className="studio-review-actions">
          <Button variant="ghost" icon={autoBusy ? <Loader2 size={13} className="studio-spin" /> : <Sparkles size={13} />} onClick={() => setAutoConfirm(true)} disabled={autoBusy}>
            {active.kind === 'drama' ? '自动补齐并合成草稿' : '自动续写空章'}
          </Button>
          {active.kind === 'drama' && visuals > 0 ? (
            <Button variant="ghost" icon={visualBusy ? <Loader2 size={13} className="studio-spin" /> : <ImageIcon size={13} />} onClick={() => void visualCheck()} disabled={visualBusy}>
              逐镜检查画面
            </Button>
          ) : null}
          {checks.length ? <Button variant="gold" icon={<RefreshCw size={13} />} onClick={() => void rerun()}>重新检查</Button> : null}
        </div>
      </header>

      <div className="studio-review-grid">
        <section className="studio-review-checks">
          <SectionTitle eyebrow="发现的问题" title={errors.length ? `${errors.length} 个问题需要处理` : warns.length ? `${warns.length} 条提醒需要你判断` : checks.length ? '检查通过，没有发现问题' : '还没有检查记录'}>
            {checks.length ? '错误会阻止导出；提醒不一定错，但需要你确认；信息项只是当前状态。' : '会检查缺失素材、配音时长、时间线引用、设定冲突和预算。'}
          </SectionTitle>
          {checks.length === 0 ? (
            <div className="studio-review-empty">
              <ShieldCheck size={26} strokeWidth={1.2} />
              <h3>先跑一次检查</h3>
              <p>检查只读作品，不会改动正文或镜头。</p>
              <Button variant="gold" onClick={() => void rerun()} icon={<RefreshCw size={13} />}>运行检查</Button>
            </div>
          ) : (
            <div className="studio-finding-list">
              {[...errors, ...warns, ...infos].map((check, index) => (
                <div key={check.id} className={`studio-finding is-${check.level}`}>
                  <span className="studio-finding-index mono">{String(index + 1).padStart(2, '0')}</span>
                  <span className="studio-finding-icon">{levelIcon(check.level)}</span>
                  <div className="studio-finding-copy">
                    <b>{check.title}</b>
                    <p>{check.detail}</p>
                  </div>
                  {check.targetId ? <button type="button" className="studio-finding-jump" onClick={() => jump(check.targetId)}>定位 <ArrowRight size={11} /></button> : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="studio-review-side">
          <section className="studio-readiness">
            <div className="studio-readiness-head">
              <span className="studio-eyebrow">就绪情况</span>
              <b className="mono">{readyCount}/{readiness.length}</b>
            </div>
            <StudioProgress value={(readyCount / readiness.length) * 100} tone={readyCount === readiness.length ? 'patina' : 'gold'} />
            <div className="studio-readiness-list">
              {readiness.map((row) => (
                <span key={row.label} className={row.ok ? 'is-ok' : ''}>
                  {row.ok ? <Check size={11} /> : <X size={11} />} {row.label}
                </span>
              ))}
            </div>
            {active.kind === 'drama' && visuals < active.shots.length ? (
              <Button variant="ghost" size="sm" icon={<ImageIcon size={12} />} onClick={() => void fixMissing()}>补齐缺失画面</Button>
            ) : null}
            {active.kind === 'drama' ? (
              <Button variant="ghost" size="sm" icon={<Film size={12} />} onClick={() => navigateStage('timeline')}>打开时间线</Button>
            ) : (
              <Button variant="ghost" size="sm" icon={<Package size={12} />} onClick={() => navigateStage('delivery')}>去交付页</Button>
            )}
          </section>

          <section className="studio-review-engine">
            <div className="studio-readiness-head">
              <span className="studio-eyebrow">使用的引擎</span>
              <button type="button" onClick={() => setSettingsOpen(true)}>管理 <ExternalLink size={10} /></button>
            </div>
            <div className={`studio-engine-row ${engine?.text.configured ? 'is-on' : ''}`}>
              <Sparkles size={13} />
              <div><b>文本模型</b><span title={engine?.text.message ?? undefined}>{engine?.text.configured ? `${engine.text.providerLabel} · ${engine.text.modelLabel}` : '还没有可用的文字模型，去设置连接一个。'}</span></div>
              <i />
            </div>
            <div className={`studio-engine-row ${engine?.media.imageReady ? 'is-on' : ''}`}>
              <ImageIcon size={13} />
              <div><b>画面引擎</b><span title={engine?.media.message ?? undefined}>{engine?.media.imageReady ? '已就绪' : engine?.media.message ?? '未检查'}</span></div>
              <i />
            </div>
            <div className={`studio-engine-row ${engine?.media.videoReady ? 'is-on' : ''}`}>
              <Film size={13} />
              <div><b>视频引擎</b><span>{engine?.media.videoReady ? '已就绪 · 图片可以变成视频' : '未就绪 · 草稿不需要视频'}</span></div>
              <i />
            </div>
            <div className={`studio-engine-row ${engine?.ffmpeg.available ? 'is-on' : ''}`}>
              <Wrench size={13} />
              <div><b>FFmpeg</b><span title={engine?.ffmpeg.available ? engine.ffmpeg.version?.slice(0, 48) : engine?.ffmpeg.message ?? undefined}>{engine?.ffmpeg.available ? '已就绪' : engine?.ffmpeg.message ?? '未检查'}</span></div>
              <i />
            </div>
            <div className={`studio-engine-row ${engine?.voices.length ? 'is-on' : ''}`}>
              <Mic2 size={13} />
              <div><b>系统声线</b><span>{engine?.voices.length ? `${engine.voices.length} 个可用` : engine?.voiceError ?? '未检测到'}</span></div>
              <i />
            </div>
          </section>

          <section className="studio-review-budget">
            <div className="studio-readiness-head">
              <span className="studio-eyebrow">费用</span>
              <b className="mono">¥{active.runtime.budget.spent.toFixed(2)} / {active.runtime.budget.limit ? `¥${active.runtime.budget.limit}` : '不限'}</b>
            </div>
            {active.runtime.budget.limit ? <StudioProgress value={(active.runtime.budget.spent / active.runtime.budget.limit) * 100} tone={active.runtime.budget.spent > active.runtime.budget.limit ? 'rust' : 'gold'} /> : <p className="studio-hint">没有设置上限；花费仍会逐项记录。</p>}
            <p>任务合计 <Money value={jobCost} />{unknownCost ? ' + 未知项' : ''}；按实际用量和外部账单记录，不知道单价就写未知。</p>
            <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>调整预算与策略</Button>
          </section>
        </aside>
      </div>

      <section className="studio-voice-audit">
        <SectionTitle
          eyebrow="人物语气"
          title="人物语气审稿"
          aside={(
            <button type="button" className="studio-link-btn" onClick={() => void voiceAudit()} disabled={voiceBusy}>
              {voiceBusy ? <Loader2 size={12} className="studio-spin" /> : <Mic2 size={12} />} {active.voiceAudit ? '重新审稿' : '运行人物语气审稿'}
            </button>
          )}
        >
          从正文与分镜台词里提取有明确说话人的句子，核对句长、问句比例、口头习惯与称谓；只报可核对的差异，不猜人物心理。
        </SectionTitle>
        {active.voiceAudit ? (
          <>
            <div className="studio-voice-summary">
              <span>{active.voiceAudit.profiles.filter((profile) => profile.lineCount > 0).length} 个角色有台词</span>
              <i />
              <span>{active.voiceAudit.profiles.reduce((sum, profile) => sum + profile.lineCount, 0)} 句可归属台词</span>
              <i />
              <span>{active.voiceAudit.unresolved} 句无法归属</span>
              <i />
              <span>{active.voiceAudit.warnings.length} 条提醒</span>
              <i />
              <span>{timeAgo(active.voiceAudit.createdAt)}</span>
            </div>
            {active.voiceAudit.profiles.filter((profile) => profile.lineCount > 0).length ? (
              <div className="studio-voice-profiles">
                {active.voiceAudit.profiles.filter((profile) => profile.lineCount > 0).map((profile) => (
                  <article key={profile.characterId} className="studio-voice-profile">
                    <header>
                      <b>{profile.name}</b>
                      <span>{profile.lineCount} 句 · {profile.words} 字</span>
                    </header>
                    <p>{profile.summary}</p>
                    <div className="studio-voice-metrics">
                      <span>平均 {profile.avgLine} 字</span>
                      <span>问句 {Math.round(profile.questionRatio * 100)}%</span>
                      <span>感叹 {Math.round(profile.exclaimRatio * 100)}%</span>
                    </div>
                    {profile.topPhrases.length ? <em>高频用语：{profile.topPhrases.join('、')}</em> : null}
                    {profile.addressTerms.length ? <em>称谓：{profile.addressTerms.join('、')}</em> : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="studio-hint">还没有可归属的台词。正文里写“张三说：‘……’”或分镜台词用“角色名：台词”，下一轮审稿就能读到。</p>
            )}
            {active.voiceAudit.warnings.length ? (
              <div className="studio-voice-warnings">
                {active.voiceAudit.warnings.map((warning, index) => (
                  <div key={`${warning.title}-${index}`} className={`studio-voice-warning is-${warning.level}`}>
                    <AlertTriangle size={13} />
                    <div><b>{warning.title}</b><p>{warning.detail}</p></div>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="studio-voice-empty">
            <Mic2 size={22} strokeWidth={1.2} />
            <p>运行一次审稿，看看每个角色说话是否像同一个人。</p>
            <Button variant="ghost" size="sm" onClick={() => void voiceAudit()} disabled={voiceBusy}>开始审稿</Button>
          </div>
        )}
      </section>

      <section className="studio-receipts">
        <SectionTitle eyebrow="任务记录" title="每次花钱都有记录" aside={<span className="studio-section-side">{active.runtime.queuePaused ? '队列已暂停' : `${jobs.length} 条最近任务`} <button type="button" className="studio-link-btn" onClick={() => void run(active.runtime.queuePaused ? 'resume-queue' : 'pause-queue')}>{active.runtime.queuePaused ? '恢复队列' : '暂停队列'}</button></span>}>
          任务先写盘再提交；重复点击只算一个任务；结果不确定时进入“需核对”，不自动重试。
        </SectionTitle>
        <div className="studio-receipt-table">
          <div className="studio-receipt-row is-head">
            <span>任务</span><span>状态</span><span>进度</span><span>费用</span><span>时间</span><span />
          </div>
          {jobs.map((job) => (
            <div key={job.id} className="studio-receipt-row">
              <div className="studio-receipt-task">
                <StageIcon stage={job.stage === 'asset' ? 'visuals' : job.stage} size={13} />
                <div>
                  <b>{job.label}</b><span>{job.message}</span>
                  <button
                    type="button"
                    className="studio-receipt-events-toggle"
                    aria-expanded={expandedJobId === job.id}
                    onClick={() => setExpandedJobId((current) => current === job.id ? null : job.id)}
                  >
                    消息流 {job.events?.length ?? 1}
                  </button>
                  {expandedJobId === job.id ? (
                    <div className="studio-receipt-events">
                      {(job.events?.length ? job.events : [{ at: job.createdAt, status: job.status, message: job.message, progress: job.progress }]).map((event, index) => (
                        <div key={`${event.at}-${index}`} className={`studio-receipt-event is-${event.status}`}>
                          <time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                          <span>{studioJobStatusLabel(event.status)}</span>
                          <p>{event.message}</p>
                          <em className="mono">{event.progress}%</em>
                        </div>
                      ))}
                      {job.outputs.length ? (
                        <div className="studio-receipt-outputs">
                          {job.outputs.map((output) => <span key={`${output.label}-${output.path ?? output.assetId ?? ''}`}>{output.label}{output.path ? ` · ${output.path}` : ''}</span>)}
                        </div>
                      ) : null}
                      {job.remoteId ? <p className="studio-receipt-remote mono">外部任务号 {job.remoteId}</p> : null}
                      {job.remoteId && (job.kind === 'image' || job.kind === 'video') ? (
                        <button type="button" className="studio-receipt-reconcile" onClick={() => void reconcileJob(job.id)} disabled={reconciling === job.id}>
                          {reconciling === job.id ? <Loader2 size={11} className="studio-spin" /> : <RefreshCw size={11} />} 取回外部结果
                        </button>
                      ) : null}
                      {job.retry ? <p className="studio-receipt-remote">可用输入快照重试：{job.retry.action}</p> : null}
                    </div>
                  ) : null}
                </div>
              </div>
              <JobStatus job={job} />
              <span className="mono">{job.progress}%</span>
              <Money value={job.cost} />
              <span>{timeAgo(job.createdAt)}</span>
              <span>
                {job.status === 'running' || job.status === 'queued' ? (
                  <button type="button" className="studio-receipt-cancel" onClick={() => void cancelJob(job.id)}>取消</button>
                ) : job.status === 'failed' || job.status === 'review' ? (
                  <span className="studio-receipt-note">需核对{job.retry ? <button type="button" className="studio-receipt-retry" onClick={() => void retryJob(job.id)}>重试</button> : null}</span>
                ) : null}
              </span>
            </div>
          ))}
          {!jobs.length ? <p className="studio-hint">还没有任务记录。生成蓝图、画面、配音或成片后会出现在这里。</p> : null}
        </div>
      </section>

      <footer className="studio-review-foot">
        <span><FolderOpen size={12} /> 作品与任务记录在本地数据目录</span>
        <span><Clock3 size={12} /> 本页只读，不修改作品</span>
        <span><CheckCircle2 size={12} /> 发布前还会再跑一遍完整流程</span>
      </footer>

      <Modal
        open={autoConfirm}
        onClose={() => setAutoConfirm(false)}
        title={active.kind === 'drama' ? '自动推进到草稿' : '自动续写空章'}
        description="只补还没有的内容，不覆盖手改；每个付费步骤仍会单独经过预算闸门。"
        width={520}
        layer="overlay"
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setAutoConfirm(false)} disabled={autoBusy}>取消</Button>
            <Button variant="gold" onClick={() => void autoAdvance()} loading={autoBusy}>
              {active.kind === 'drama' ? '开始补齐并合成' : '开始续写'}
            </Button>
          </div>
        }
      >
        <ol className="studio-auto-steps">
          {autoSteps.map((step) => <li key={step}><Check size={12} /> {step}</li>)}
        </ol>
        <p className="studio-settings-hint">
          预算：已记录 ¥{active.runtime.budget.spent.toFixed(2)} / 上限 {active.runtime.budget.limit ? `¥${active.runtime.budget.limit}` : '不限'}。
          超预算的任务会停下并说明原因，不会悄悄继续。{active.kind === 'drama' ? '草稿合成使用本机 FFmpeg，不计模型费用。' : '续写会按当前模型路由计费；没有可用模型时只保留本机生成的结构。'}
        </p>
      </Modal>
    </div>
  )
}
