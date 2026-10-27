import { useMemo, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Loader2,
  Pencil,
  PencilLine,
  SquarePen,
  WandSparkles,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Users
} from 'lucide-react'
import type { StudioCharacter, StudioJob } from '@shared/studio'
import { formatDuration, studioKindLabel } from '@shared/studio'
import { Button, Modal, Select } from '../../ui'
import { useStudioStore } from './studio-store'
import {
  KindBadge,
  Money,
  SectionTitle,
  StageIcon,
  StudioProgress,
  Stat,
  timeAgo
} from './components'

function activeJobOf(jobs: StudioJob[], stage: StudioJob['stage']): StudioJob | undefined {
  return [...jobs].reverse().find((job) => job.stage === stage && (job.status === 'running' || job.status === 'queued'))
}

function BriefDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const updateProject = useStudioStore((state) => state.updateProject)
  const [title, setTitle] = useState(active?.title ?? '')
  const [logline, setLogline] = useState(active?.logline ?? '')
  const [tone, setTone] = useState(active?.brief.tone ?? '')
  const [audience, setAudience] = useState(active?.brief.audience ?? '')
  const [style, setStyle] = useState(active?.brief.style ?? '')
  const [saving, setSaving] = useState(false)
  if (!active) return null
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await updateProject({
        title,
        logline,
        brief: { ...active.brief, tone, audience, style }
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="修改作品信息"
      description="这里改的是作品名、一句话和风格。改动不会删掉已写内容，只会提醒你后面需要重新核对。"
      width={620}
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void save()} loading={saving}>保存</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field is-wide"><span>作品名</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="studio-field is-wide"><span>一句话简介</span><textarea rows={4} value={logline} onChange={(event) => setLogline(event.target.value)} /></label>
        <label className="studio-field"><span>整体语气</span><input value={tone} onChange={(event) => setTone(event.target.value)} placeholder="克制、潮湿、温柔" /></label>
        <label className="studio-field"><span>给谁看</span><input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="谁会读 / 看这部作品" /></label>
        <label className="studio-field is-wide"><span>风格</span><input value={style} onChange={(event) => setStyle(event.target.value)} placeholder="文字与画面风格" /></label>
      </div>
    </Modal>
  )
}

function BlueprintDialog({ onClose }: { onClose: () => void }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const blueprint = active?.blueprint
  const [storyCore, setStoryCore] = useState(blueprint?.storyCore ?? '')
  const [pitch, setPitch] = useState(blueprint?.pitch ?? '')
  const [emotion, setEmotion] = useState(blueprint?.emotion ?? '')
  const [audience, setAudience] = useState(blueprint?.audience ?? '')
  const [structure, setStructure] = useState(blueprint?.structure ?? '')
  const [units, setUnits] = useState(blueprint?.units.map((unit) => ({ ...unit })) ?? [])
  const [saving, setSaving] = useState(false)
  if (!blueprint) return null
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await run('save-blueprint', {
        blueprint: {
          storyCore,
          pitch,
          emotion,
          audience,
          structure,
          units: units.map((unit) => ({
            index: unit.index,
            title: unit.title,
            summary: unit.summary,
            ...(typeof unit.seconds === 'number' ? { seconds: unit.seconds } : {}),
            ...(typeof unit.wordTarget === 'number' ? { wordTarget: unit.wordTarget } : {})
          }))
        }
      })
      notify('success', blueprint.approved ? '蓝图已更新；下游内容已标记为需要重新核对。' : '蓝图已保存。')
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="修改故事蓝图"
      description={blueprint.approved ? '这份蓝图已经确认。修改故事主线或章节/镜头会保留已有正文，只提醒你后面需要重新核对。' : '确认前可以逐项修改；确认后才会开始写正文或做画面，并产生费用。'}
      width={780}
      layer="overlay"
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void save()} loading={saving}>保存蓝图</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field is-wide"><span>故事主线</span><textarea rows={3} value={storyCore} onChange={(event) => setStoryCore(event.target.value)} /></label>
        <label className="studio-field is-wide"><span>看点</span><textarea rows={3} value={pitch} onChange={(event) => setPitch(event.target.value)} /></label>
        <label className="studio-field"><span>情绪基调</span><input value={emotion} onChange={(event) => setEmotion(event.target.value)} /></label>
        <label className="studio-field"><span>给谁看</span><input value={audience} onChange={(event) => setAudience(event.target.value)} /></label>
        <label className="studio-field is-wide"><span>故事结构</span><input value={structure} onChange={(event) => setStructure(event.target.value)} /></label>
      </div>
      <div className="studio-blueprint-edit-units">
        <span className="studio-eyebrow">{active.kind === 'drama' ? '逐项修改镜头' : '逐项修改章节'}</span>
        <div className="studio-blueprint-edit-head" aria-hidden>
          <span />
          <span>名称</span>
          <span>这段讲什么</span>
          <span>{active.kind === 'drama' ? '秒数' : '字数'}</span>
        </div>
        {units.map((unit, index) => (
          <div key={unit.index} className="studio-blueprint-edit-unit">
            <span className="mono">{String(unit.index).padStart(2, '0')}</span>
            <input
              value={unit.title}
              aria-label={`第 ${unit.index} 项标题`}
              onChange={(event) => setUnits((list) => list.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item))}
            />
            <input
              value={unit.summary}
              aria-label={`第 ${unit.index} 项梗概`}
              onChange={(event) => setUnits((list) => list.map((item, itemIndex) => itemIndex === index ? { ...item, summary: event.target.value } : item))}
            />
            {typeof unit.seconds === 'number' ? (
              <input
                value={unit.seconds}
                inputMode="numeric"
                aria-label={`第 ${unit.index} 项秒数`}
                onChange={(event) => setUnits((list) => list.map((item, itemIndex) => itemIndex === index ? { ...item, seconds: Math.max(1, Number(event.target.value) || 1) } : item))}
              />
            ) : (
              <input
                value={unit.wordTarget ?? ''}
                inputMode="numeric"
                aria-label={`第 ${unit.index} 项目标字数`}
                onChange={(event) => setUnits((list) => list.map((item, itemIndex) => itemIndex === index ? { ...item, wordTarget: Math.max(100, Number(event.target.value) || 100) } : item))}
              />
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}

export function CharacterDialog({ character, onClose }: { character: StudioCharacter | null; onClose: () => void }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const [draft, setDraft] = useState<StudioCharacter | null>(character)
  const [saving, setSaving] = useState(false)
  if (!active || !character || !draft) return null
  const voiceOptions = [
    { value: '', label: '跟随系统默认' },
    ...(engine?.voices ?? []).map((voice) => ({ value: voice.name, label: `${voice.name}${voice.culture ? ` · ${voice.culture}` : ''}` }))
  ]
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await run('upsert-character', {
        character: {
          ...draft,
          relationships: draft.relationships.filter((relationship) => relationship.target.trim() && relationship.label.trim())
        }
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`修改人物 · ${character.name}`}
      description="这些设定会带进写作和画面；每个人物的事实都能回到具体章节。"
      width={680}
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void save()} loading={saving}>保存人物</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field"><span>名字</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="studio-field"><span>身份</span><input value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} /></label>
        <label className="studio-field"><span>年龄</span><input value={draft.age ?? ''} onChange={(event) => setDraft({ ...draft, age: event.target.value })} /></label>
        <label className="studio-field"><span>声线</span>
          <Select value={draft.voiceId ?? ''} options={voiceOptions} onChange={(value) => setDraft({ ...draft, voiceId: value })} ariaLabel="人物声线" />
        </label>
        <label className="studio-field is-wide"><span>外观</span><textarea rows={3} value={draft.look} onChange={(event) => setDraft({ ...draft, look: event.target.value })} /></label>
        <label className="studio-field"><span>想要</span><textarea rows={2} value={draft.desire ?? ''} onChange={(event) => setDraft({ ...draft, desire: event.target.value })} /></label>
        <label className="studio-field"><span>害怕</span><textarea rows={2} value={draft.fear ?? ''} onChange={(event) => setDraft({ ...draft, fear: event.target.value })} /></label>
        <label className="studio-field is-wide"><span>秘密</span><textarea rows={2} value={draft.secret ?? ''} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} /></label>
        <label className="studio-field is-wide"><span>人物变化</span><textarea rows={2} value={draft.arc ?? ''} onChange={(event) => setDraft({ ...draft, arc: event.target.value })} /></label>
        <div className="studio-field is-wide">
          <span>人物关系</span>
          <div className="studio-relationship-editor">
            {draft.relationships.map((relationship, index) => (
              <div key={index} className="studio-relationship-row">
                <input
                  value={relationship.target}
                  placeholder="对方名字"
                  aria-label="关系对象"
                  onChange={(event) => setDraft({
                    ...draft,
                    relationships: draft.relationships.map((item, itemIndex) => itemIndex === index ? { ...item, target: event.target.value } : item)
                  })}
                />
                <input
                  value={relationship.label}
                  placeholder="关系：母亲 / 债主 / 旧友"
                  aria-label="关系说明"
                  onChange={(event) => setDraft({
                    ...draft,
                    relationships: draft.relationships.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item)
                  })}
                />
                <button type="button" aria-label="删除关系" onClick={() => setDraft({ ...draft, relationships: draft.relationships.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
              </div>
            ))}
            <button type="button" className="studio-relationship-add" onClick={() => setDraft({ ...draft, relationships: [...draft.relationships, { target: '', label: '' }] })}>+ 添加一条关系</button>
          </div>
        </div>
      </div>
      {draft.refAssetIds.length ? (
        <div className="studio-character-refs">
          <span>已固定的参考图</span>
          {draft.refAssetIds.map((id) => {
            const asset = active.assets.find((item) => item.id === id)
            return asset ? <img key={id} src={asset.thumbUrl ?? asset.url} alt="" /> : null
          })}
        </div>
      ) : (
        <p className="studio-hint">还没有人物参考图。去画面页导入后，就能在分镜里固定人物长相。</p>
      )}
    </Modal>
  )
}

export function BlueprintView({ onOpenBudget }: { onOpenBudget: () => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const setView = useStudioStore((state) => state.setView)
  const notify = useStudioStore((state) => state.notify)
  const [approving, setApproving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [showAllUnits, setShowAllUnits] = useState(false)
  const [editBrief, setEditBrief] = useState(false)
  const [editBlueprint, setEditBlueprint] = useState(false)
  const [editingCharacter, setEditingCharacter] = useState<StudioCharacter | null>(null)
  if (!active) return <div />
  const blueprint = active.blueprint
  const job = activeJobOf(active.jobs, 'blueprint')
  const approved = Boolean(blueprint?.approved)
  const unitCount = blueprint?.units.length ?? (active.kind === 'drama' ? 12 : 12)
  const goal = active.kind === 'drama' ? `${unitCount} 镜 · ${formatDuration(blueprint?.units.reduce((sum, unit) => sum + (unit.seconds ?? 8), 0) ?? active.brief.targetSeconds ?? 96)}` : `${unitCount} 章 · 约 ${((active.brief.targetWords ?? 18000) / 10000).toFixed(1)} 万字`
  const estimate = blueprint?.estimate
  const costText = estimate
    ? estimate.costMin === null || estimate.costMax === null
      ? '未知'
      : estimate.costMin === estimate.costMax
        ? `¥${estimate.costMin}`
        : `¥${estimate.costMin}–${estimate.costMax}`
    : '—'
  const warnings = blueprint?.warnings ?? []
  const units = blueprint ? (showAllUnits ? blueprint.units : blueprint.units.slice(0, 8)) : []
  const hasWrittenContent = active.chapters.some((chapter) => chapter.content.trim())
  const canRegenerate = !approved || !hasWrittenContent

  const generate = async (useModel: boolean): Promise<void> => {
    if (regenerating) return
    if (approved && hasWrittenContent) {
      notify('error', '这部作品已经有正文。重新生成不会改动手稿；如果要保留现在这版，请先复制一份作品。')
      return
    }
    setRegenerating(true)
    try {
      await run('generate-blueprint', { useModel, requestId: `bp-${Date.now()}` })
      notify('info', useModel ? '正在用模型重新生成蓝图。' : '正在用本机重新生成蓝图。')
    } finally {
      setRegenerating(false)
    }
  }

  const approve = async (): Promise<void> => {
    if (!blueprint || approving) return
    setApproving(true)
    try {
      await run('approve-blueprint')
      notify('success', active.kind === 'drama' ? '蓝图已确认，镜头安排已准备好。' : '蓝图已确认，章节安排已准备好。')
      setView(active.kind === 'drama' ? 'storyboard' : 'writing')
    } finally {
      setApproving(false)
    }
  }

  if (!blueprint) {
    return (
      <div className="studio-blueprint">
        <div className="studio-blueprint-head">
          <div>
            <span className="studio-eyebrow">故事蓝图 · 01</span>
            <h1>{active.title}</h1>
            <p>{active.logline}</p>
          </div>
          <div className="studio-blueprint-actions">
            <Button variant="ghost" icon={<PencilLine size={13} />} onClick={() => setEditBrief(true)}>修改资料</Button>
            <Button variant="gold" icon={<Sparkles size={14} />} onClick={() => void generate(false)} loading={Boolean(job) || regenerating}>
              {job ? '正在生成蓝图' : '生成故事蓝图'}
            </Button>
          </div>
        </div>
        <div className="studio-blueprint-generating">
          <div className="studio-generating-mark"><FeatherPulse /></div>
          <h2>{job ? job.message : '还没有故事蓝图'}</h2>
          <p>{job ? '先整理故事主线、人物和结构，再请你确认。' : '先用本机整理故事主线、人物、结构、风格和预算；确认前不会调用付费模型。'}</p>
          {job ? <StudioProgress value={job.progress} /> : null}
          {!job ? (
            <div className="studio-generating-hints">
              <span><i /> 不用先想章节名</span>
              <span><i /> 生成蓝图不收费</span>
              <span><i /> 每个字段都可以再改</span>
            </div>
          ) : null}
        </div>
        {editBrief ? <BriefDialog open onClose={() => setEditBrief(false)} /> : null}
      </div>
    )
  }

  return (
    <div className="studio-blueprint">
      <header className="studio-blueprint-head">
        <div className="studio-blueprint-title-block">
          <span className="studio-eyebrow">故事蓝图 · 01 {approved ? '· 已确认' : '· 待确认'}</span>
          <div className="studio-blueprint-title-row">
            <h1>{active.title}</h1>
            <button type="button" className="studio-blueprint-edit-link" onClick={() => setEditBrief(true)} title="修改作品名与一句话">
              <PencilLine size={12} /> 修改资料
            </button>
          </div>
          <p>{active.logline}</p>
          <div className="studio-blueprint-meta">
            <KindBadge kind={active.kind} />
            <span>{goal}</span>
            <span>{blueprint.source === 'model' ? `模型生成 · ${blueprint.model ?? '当前模型'}` : '本机生成'}</span>
            <span>{timeAgo(blueprint.createdAt)}</span>
          </div>
        </div>
        <div className="studio-blueprint-actions">
          {canRegenerate ? (
            <div className="studio-dropdown-group">
              <Button variant="ghost" icon={<RefreshCw size={13} />} loading={regenerating || Boolean(job)} onClick={() => void generate(false)} title={approved ? '用本机重新生成' : '不调用模型；确认蓝图后可用模型重写'}>重新生成</Button>
              {engine?.text.configured && approved ? (
                <Button variant="ghost" icon={<WandSparkles size={13} />} onClick={() => void generate(true)} disabled={regenerating || Boolean(job)}>用模型重写</Button>
              ) : null}
            </div>
          ) : null}
          {approved ? (
            <Button variant="gold" iconRight={<ArrowRight size={13} />} onClick={() => setView(active.kind === 'drama' ? 'storyboard' : 'writing')}>
              {active.kind === 'drama' ? '去做分镜' : '开始写作'}
            </Button>
          ) : (
            <Button variant="gold" icon={<Check size={14} />} onClick={() => void approve()} loading={approving} disabled={Boolean(job)}>
              确认并开始
            </Button>
          )}
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

      {warnings.length ? (
        <div className="studio-blueprint-warning">
          <span>需要注意</span>
          <div>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
        </div>
      ) : null}

      <div className="studio-blueprint-grid">
        <section className="studio-bp-core">
          <div className="studio-bp-index mono">
            01 / 故事主线
            <button type="button" className="studio-bp-edit" onClick={() => setEditBlueprint(true)}>
              <SquarePen size={11} /> 修改
            </button>
          </div>
          <h2>{blueprint.storyCore}</h2>
          <div className="studio-bp-pillars">
            <div><span>情绪基调</span><b>{blueprint.emotion}</b></div>
            <div><span>给谁看</span><b>{blueprint.audience}</b></div>
            <div><span>故事结构</span><b>{blueprint.structure}</b></div>
          </div>
          <p className="studio-bp-pitch">{blueprint.pitch}</p>
        </section>

        <section className="studio-bp-estimate">
          <div className="studio-bp-index mono">02 / 费用与时间</div>
          <div className="studio-estimate-total">
            <div><b>{costText}</b><span>预计费用</span></div>
            <div><b>{estimate ? `${estimate.minutesMin}–${estimate.minutesMax}` : '—'}<em>分钟</em></b><span>预计时长</span></div>
          </div>
          <div className="studio-estimate-lines">
            {estimate?.lines.map((line) => (
              <div key={line.label}>
                <span>{line.label}</span>
                <b>{line.costMin === null || line.costMax === null ? '未知' : line.costMin === line.costMax ? (line.costMin === 0 ? '免费' : `¥${line.costMin}`) : `¥${line.costMin}–${line.costMax}`}</b>
                {line.note ? <em>{line.note}</em> : null}
              </div>
            ))}
          </div>
          <div className="studio-budget-line">
            <span>项目预算</span>
            <b className="mono">¥{active.runtime.budget.spent.toFixed(2)} / {active.runtime.budget.limit ? `¥${active.runtime.budget.limit}` : '不限'}</b>
            <button type="button" onClick={onOpenBudget}><SlidersHorizontal size={12} /> 调整预算</button>
          </div>
          <p className="studio-estimate-note">{estimate?.note ?? '费用按实际账单记录；不知道单价时会写“未知”，不会乱估。'}</p>
        </section>
      </div>

      <section className="studio-bp-section">
        <SectionTitle eyebrow="03 / 人物" title="人物：想要什么，害怕什么" aside={<span className="studio-section-side">{blueprint.characters.length} 人物 · 点击卡片修改</span>}>
          人物的想要、害怕和秘密，会带进之后的写作和画面。
        </SectionTitle>
        <div className="studio-character-grid">
          {blueprint.characters.map((character, index) => {
            const current = active.characters.find((item) => item.id === character.id) ?? character
            return (
              <button key={character.id} type="button" className="studio-character-card" onClick={() => setEditingCharacter(current)}>
                <span className="studio-character-index mono">{String(index + 1).padStart(2, '0')}</span>
                <span className="studio-character-avatar">
                  {current.refAssetIds[0] && active.assets.find((asset) => asset.id === current.refAssetIds[0]) ? (
                    <img src={active.assets.find((asset) => asset.id === current.refAssetIds[0])?.thumbUrl ?? active.assets.find((asset) => asset.id === current.refAssetIds[0])?.url} alt="" />
                  ) : (
                    <Users size={20} strokeWidth={1.3} />
                  )}
                </span>
                <span className="studio-character-copy">
                  <b>{current.name}<em>{current.role}</em></b>
                  <span>{current.age ?? ''}{current.look ? ` · ${current.look.length > 42 ? `${current.look.slice(0, 42)}…` : current.look}` : ''}</span>
                  {current.desire ? <i>想要：{current.desire}</i> : null}
                  {current.fear ? <i>害怕：{current.fear}</i> : null}
                </span>
                <Pencil size={12} className="studio-character-edit" />
              </button>
            )
          })}
        </div>
      </section>

      <section className="studio-bp-section is-split">
        <div className="studio-bp-units">
          <SectionTitle eyebrow={active.kind === 'drama' ? '04 / 镜头安排' : '04 / 章节安排'} title={active.kind === 'drama' ? '镜头安排' : '章节安排'} aside={<button type="button" className="studio-link-btn" onClick={() => setShowAllUnits((value) => !value)}>{showAllUnits ? '收起' : `展开全部 ${blueprint.units.length} 项`} <ChevronDown size={12} /></button>}>
            {active.kind === 'drama' ? '每一镜都会写清台词、运镜和前后衔接；确认后可以逐镜生成、逐镜重做。' : '章名和梗概先定下来；正文仍然一章一章写，随时可以停。'}
          </SectionTitle>
          <div className="studio-unit-list">
            {units.map((unit) => (
              <div key={unit.index} className="studio-unit-row">
                <span className="studio-unit-number mono">{String(unit.index).padStart(2, '0')}</span>
                <div className="studio-unit-copy">
                  <b>{unit.title}</b>
                  <p>{unit.summary}</p>
                  {unit.dialogue ? <em>“{unit.dialogue}” · {unit.speaker}</em> : null}
                </div>
                <span className="studio-unit-meta mono">{unit.seconds ? `${unit.seconds}s` : unit.wordTarget ? `${unit.wordTarget} 字` : ''}</span>
              </div>
            ))}
          </div>
        </div>
        <aside className="studio-bp-side">
          <div className="studio-bp-side-block">
            <span className="studio-bp-index mono">05 / 地点</span>
            <h3>地点</h3>
            {blueprint.places.map((place) => (
              <div key={place.id} className="studio-place-row"><b>{place.name}</b><p>{place.description}</p></div>
            ))}
          </div>
          <div className="studio-bp-side-block">
            <span className="studio-bp-index mono">06 / 风格</span>
            <h3>风格</h3>
            <p>{blueprint.styleBible.look}</p>
            <div className="studio-palette">
              {blueprint.styleBible.palette.map((color) => <span key={color} style={{ background: color }} title={color} />)}
            </div>
            <dl className="studio-style-list">
              <dt>镜头</dt><dd>{blueprint.styleBible.camera}</dd>
              <dt>声音</dt><dd>{blueprint.styleBible.sound}</dd>
              <dt>不要出现</dt><dd>{blueprint.styleBible.negative.join(' · ')}</dd>
            </dl>
          </div>
          <div className="studio-bp-side-block is-quiet">
            <span className="studio-bp-index mono">07 / 要求</span>
            <h3>这次的要求</h3>
            {active.brief.constraints.length ? active.brief.constraints.map((item) => <p key={item} className="studio-constraint"><Check size={11} /> {item}</p>) : <p className="studio-hint">没有额外要求。</p>}
          </div>
        </aside>
      </section>

      <footer className="studio-blueprint-foot">
        <div>
          <Stat value={active.kind === 'drama' ? unitCount : blueprint.units.length} label={active.kind === 'drama' ? '镜头' : '章节'} />
          <Stat value={blueprint.characters.length} label="人物" />
          <Stat value={blueprint.places.length} label="地点" />
          <Stat value={costText} label="预计费用" tone="gold" />
        </div>
        <p>确认蓝图后，才会开始写章节或做镜头；每一步的费用都会单独记录。</p>
        {!approved ? <Button variant="gold" size="lg" icon={<Check size={15} />} onClick={() => void approve()} loading={approving}>确认并开始</Button> : <Button variant="secondary" size="lg" onClick={() => setView(active.kind === 'drama' ? 'storyboard' : 'writing')}>继续做 <ArrowRight size={14} /></Button>}
      </footer>

      {editBrief ? <BriefDialog open onClose={() => setEditBrief(false)} /> : null}
      {editBlueprint ? <BlueprintDialog onClose={() => setEditBlueprint(false)} /> : null}
      {editingCharacter ? <CharacterDialog character={editingCharacter} onClose={() => setEditingCharacter(null)} /> : null}
    </div>
  )
}

function FeatherPulse(): React.JSX.Element {
  return (
    <span className="studio-feather-pulse">
      <span /><span /><span />
      <StageIcon stage="blueprint" size={26} />
    </span>
  )
}
