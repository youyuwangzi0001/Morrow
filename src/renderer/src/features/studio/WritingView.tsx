import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Clock3,
  Eye,
  FileClock,
  Globe2,
  ImagePlus,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  Sparkles,
  Trash2,
  Users,
  WandSparkles,
  X
} from 'lucide-react'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { candidateDiff } from '@shared/text-diff'
import type { StudioCandidate, StudioChapter, StudioChapterVersion, StudioCharacter, StudioFact, StudioFaction, StudioProp, StudioRule, StudioVolume } from '@shared/studio'
import { countWords, studioStages, studioStatusLabel } from '@shared/studio'
import { Button, Modal, Select, TextInput, useClickOutside } from '../../ui'
import { useStudioStore } from './studio-store'
import { CharacterDialog } from './BlueprintView'
import { IllustrationDialog } from './IllustrationDialog'
import { StageIcon, timeAgo } from './components'

type FactTab = 'people' | 'facts' | 'world' | 'story' | 'checks'

function CandidateDiff({
  chapter,
  candidate,
  onClose,
  onBefore
}: {
  chapter: StudioChapter
  candidate: StudioCandidate
  onClose: () => void
  onBefore?: () => Promise<void>
}): React.JSX.Element {
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [adopting, setAdopting] = useState(false)
  const [activeId, setActiveId] = useState(candidate.id)
  const [mode, setMode] = useState<'chars' | 'paragraphs'>('chars')
  const candidates = chapter.candidates
  const active = candidates.find((item) => item.id === activeId) ?? candidates[0] ?? candidate
  const diff = useMemo(() => candidateDiff(chapter.content, active.content, mode), [chapter.content, active.content, mode])
  const effectiveMode = diff.degraded ? 'paragraphs' : mode
  const adopt = async (): Promise<void> => {
    setAdopting(true)
    try {
      await onBefore?.()
      await run('adopt-candidate', { chapterId: chapter.id, candidateId: active.id, expectedRevision: chapter.revision })
      notify('success', '已用这一版替换；上一版自动留档，可随时恢复。')
      onClose()
    } finally {
      setAdopting(false)
    }
  }
  const discard = async (): Promise<void> => {
    await run('discard-candidate', { chapterId: chapter.id, candidateId: active.id })
    const rest = candidates.filter((item) => item.id !== active.id)
    if (rest[0]) setActiveId(rest[0].id)
    else onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`对照候选稿 · ${active.label}`}
      description={`${active.wordCount} 字 · ${active.source === 'model' ? active.model ?? '模型' : '本机生成'} · ${timeAgo(active.createdAt)}。用候选前不会改动正文。`}
      width={1080}
      layer="overlay"
      footer={
        <div className="studio-modal-footer studio-diff-footer">
          <span>左边是现在的正文，右边是候选稿；红色是删去，绿色是新增。</span>
          <div>
            <Button variant="ghost" onClick={() => void discard()}>不用这一版</Button>
            <Button variant="gold" icon={<Check size={14} />} loading={adopting} onClick={() => void adopt()}>
              用这一版替换
            </Button>
          </div>
        </div>
      }
    >
      {candidates.length > 1 ? (
        <div className="studio-candidate-switch" role="tablist" aria-label="候选稿">
          {candidates.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={item.id === active.id} className={item.id === active.id ? 'is-active' : ''} onClick={() => setActiveId(item.id)}>
              <b>{item.label}</b>
              <span className="mono">{item.wordCount} 字 · {item.source === 'model' ? '模型' : '本地'}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="studio-diff-modes">
        <span>{candidates.length} 版候选稿</span>
        <button type="button" className={mode === 'chars' ? 'is-active' : ''} onClick={() => setMode('chars')}>逐字对照</button>
        <button type="button" className={mode === 'paragraphs' ? 'is-active' : ''} onClick={() => setMode('paragraphs')}>段落对照</button>
      </div>
      {diff.truncated ? <p className="studio-hint">正文超过 6 万字，对照只显示前 6 万字；用候选时会使用完整内容。</p> : null}
      {diff.degraded ? <p className="studio-hint">正文超过 2 万字，已自动改用段落级对照，避免逐字比对卡住界面；用候选时会使用完整内容。</p> : null}
      <div className="studio-diff-grid">
        <section>
          <header><span>现在的正文</span><b className="mono">{countWords(chapter.content)} 字</b></header>
          <div className="studio-diff-text">
            {effectiveMode === 'chars'
              ? diff.parts.map((part, index) => {
                  if (part.added) return null
                  return <span key={index} className={part.removed ? 'is-removed' : ''}>{part.value}</span>
                })
              : diff.paragraphs.map((part, index) => {
                  if (part.added) return null
                  return part.value.map((paragraph, paragraphIndex) => (
                    <p key={`${index}-${paragraphIndex}`} className={part.removed ? 'is-removed' : ''}>{paragraph}</p>
                  ))
                })}
          </div>
        </section>
        <section>
          <header><span>候选稿</span><b className="mono">{active.wordCount} 字</b></header>
          <div className="studio-diff-text">
            {effectiveMode === 'chars'
              ? diff.parts.map((part, index) => {
                  if (part.removed) return null
                  return <span key={index} className={part.added ? 'is-added' : ''}>{part.value}</span>
                })
              : diff.paragraphs.map((part, index) => {
                  if (part.removed) return null
                  return part.value.map((paragraph, paragraphIndex) => (
                    <p key={`${index}-${paragraphIndex}`} className={part.added ? 'is-added' : ''}>{paragraph}</p>
                  ))
                })}
          </div>
        </section>
      </div>
    </Modal>
  )
}

function VersionDialog({
  chapter,
  onClose,
  onBefore
}: {
  chapter: StudioChapter
  onClose: () => void
  onBefore?: () => Promise<void>
}): React.JSX.Element {
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [restoring, setRestoring] = useState<string | null>(null)
  const restore = async (version: StudioChapterVersion): Promise<void> => {
    setRestoring(version.id)
    try {
      await onBefore?.()
      await run('restore-chapter-version', { chapterId: chapter.id, versionId: version.id, expectedRevision: chapter.revision })
      notify('success', '已恢复到这个版本；恢复前的正文也留档了。')
      onClose()
    } finally {
      setRestoring(null)
    }
  }
  return (
    <Modal open onClose={onClose} title={`历史版本 · 第 ${chapter.number} 章`} description="每次手动修改或用候选前都会留一份；恢复前也会先留档。" width={720} layer="overlay">
      <div className="studio-version-list">
        {chapter.versions.length === 0 ? <p className="studio-hint">还没有历史版本。第一次手动修改或用候选后会自动出现。</p> : null}
        {chapter.versions.map((version) => (
          <div key={version.id} className="studio-version-row">
            <span className="studio-version-time mono">{new Date(version.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <div>
              <b>{version.reason}</b>
              <p>{version.content.replace(/\s+/g, ' ').slice(0, 120) || '（空）'}</p>
            </div>
            <span className="mono">{version.wordCount} 字</span>
            <Button variant="ghost" size="sm" loading={restoring === version.id} onClick={() => void restore(version)}>恢复</Button>
          </div>
        ))}
      </div>
    </Modal>
  )
}

function VolumeDialog({ volume, onClose }: { volume: StudioVolume | null; onClose: () => void }): React.JSX.Element {
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [title, setTitle] = useState(volume?.title ?? '')
  const [summary, setSummary] = useState(volume?.summary ?? '')
  const [saving, setSaving] = useState(false)
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await run('upsert-volume', { volume: { ...(volume ? { id: volume.id } : {}), title, summary } })
      notify('success', volume ? '分卷已更新。' : '分卷已建立。')
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={volume ? '修改分卷' : '新建分卷'}
      description="分卷只调整目录；正文、候选和版本都会保留。"
      width={520}
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void save()} loading={saving}>保存分卷</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field is-wide"><span>卷名</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：第一卷 · 纸伞" autoFocus /></label>
        <label className="studio-field is-wide"><span>卷简介</span><textarea rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="这一卷把主角带到哪里？" /></label>
      </div>
    </Modal>
  )
}

function AddChapterDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (chapterId: string) => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const [title, setTitle] = useState('')
  const [synopsis, setSynopsis] = useState('')
  const [target, setTarget] = useState(String(active?.chapters[0]?.wordTarget ?? 2500))
  const [volumeId, setVolumeId] = useState(active?.volumes[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await run('add-chapter', { title: title || undefined, synopsis, wordTarget: Number(target) || 2500, volumeId: volumeId || null })
      const chapters = [...result.project.chapters].sort((a, b) => b.number - a.number)
      if (chapters[0]) onCreated(chapters[0].id)
      onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建一章"
      description="先写章名和一句简介就够了；正文可以自己写，也可以让助手先给一版。"
      width={560}
      layer="overlay"
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void create()} loading={busy}>建立章节</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field is-wide"><span>章名</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：纸伞与铁骨" autoFocus /></label>
        <label className="studio-field is-wide"><span>本章简介</span><textarea rows={3} value={synopsis} onChange={(event) => setSynopsis(event.target.value)} placeholder="简单说，这一章发生了什么？" /></label>
        <label className="studio-field"><span>目标字数</span><input value={target} onChange={(event) => setTarget(event.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" /></label>
        <label className="studio-field"><span>放入分卷</span>
          <Select
            value={volumeId}
            options={[{ value: '', label: '未分卷' }, ...(active?.volumes ?? []).map((volume) => ({ value: volume.id, label: volume.title }))]}
            onChange={setVolumeId}
            ariaLabel="放入分卷"
          />
        </label>
      </div>
    </Modal>
  )
}

type WorldKind = 'faction' | 'rule' | 'prop'

function WorldItemDialog({ kind, item, onClose }: { kind: WorldKind; item: StudioFaction | StudioRule | StudioProp | null; onClose: () => void }): React.JSX.Element {
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [name, setName] = useState(kind === 'rule' ? '' : (item as StudioFaction | StudioProp | null)?.name ?? '')
  const [description, setDescription] = useState(kind === 'rule' ? '' : (item as StudioFaction | StudioProp | null)?.description ?? '')
  const [title, setTitle] = useState(kind === 'rule' ? (item as StudioRule | null)?.title ?? '' : '')
  const [content, setContent] = useState(kind === 'rule' ? (item as StudioRule | null)?.content ?? '' : '')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const label = kind === 'faction' ? '势力' : kind === 'rule' ? '规则' : '道具'
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const base = kind === 'faction'
        ? { id: item?.id, name, description }
        : kind === 'rule'
          ? { id: item?.id, title, content }
          : { id: item?.id, name, description, refAssetIds: (item as StudioProp | null)?.refAssetIds ?? [] }
      await run(`upsert-${kind}`, { item: base })
      notify('success', `${label}已保存。`)
      onClose()
    } finally {
      setSaving(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (!item) return
    await run(`delete-${kind}`, { itemId: item.id })
    notify('info', `${label}已删除；已有正文不受影响。`)
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`${item ? '编辑' : '新增'}${label}`}
      description="这些设定会带进写作和分镜；改动只提醒后面需要重新核对，不会删掉已有内容。"
      width={560}
      footer={
        <div className="studio-modal-footer">
          {item ? <Button variant="danger" onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}>{confirmDelete ? '确认删除' : '删除'}</Button> : <span />}
          <div>
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="gold" onClick={() => void save()} loading={saving}>保存{label}</Button>
          </div>
        </div>
      }
    >
      <div className="studio-form-grid">
        {kind === 'rule' ? (
          <>
            <label className="studio-field is-wide"><span>规则名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：雨伞不能倒着打开" autoFocus /></label>
            <label className="studio-field is-wide"><span>规则内容</span><textarea rows={5} value={content} onChange={(event) => setContent(event.target.value)} placeholder="它的代价、例外与读者会记住的细节。" /></label>
          </>
        ) : (
          <>
            <label className="studio-field is-wide"><span>{label}名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === 'faction' ? '例如：伞街公所' : '例如：外婆的黑伞'} autoFocus /></label>
            <label className="studio-field is-wide"><span>说明</span><textarea rows={5} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="它和主角、主线以及画面有什么关系？" /></label>
          </>
        )}
      </div>
    </Modal>
  )
}

function RelationshipGraph({ characters, onPick }: { characters: StudioCharacter[]; onPick: (character: StudioCharacter) => void }): React.JSX.Element {
  const nodes = characters.slice(0, 10).map((character, index, list) => {
    const angle = list.length === 1 ? 0 : (Math.PI * 2 * index) / list.length - Math.PI / 2
    const radius = list.length === 1 ? 0 : 100
    return { character, x: 180 + Math.cos(angle) * radius, y: 130 + Math.sin(angle) * radius }
  })
  const byName = new Map(nodes.map((node) => [node.character.name, node]))
  const edges = characters.flatMap((character) =>
    character.relationships
      .map((relationship) => {
        const source = byName.get(character.name)
        const target = byName.get(relationship.target)
        return source && target ? { source, target, label: relationship.label, key: `${character.id}:${target.character.id}:${relationship.label}` } : null
      })
      .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
  ).slice(0, 32)
  return (
    <div className="studio-relationship-graph">
      {nodes.length ? (
        <svg viewBox="0 0 360 280" role="img" aria-label="人物关系图">
          {edges.map((edge) => (
            <g key={edge.key} className="studio-relationship-edge">
              <line x1={edge.source.x} y1={edge.source.y} x2={edge.target.x} y2={edge.target.y} />
              <text x={(edge.source.x + edge.target.x) / 2} y={(edge.source.y + edge.target.y) / 2 - 4}>{edge.label}</text>
            </g>
          ))}
          {nodes.map((node) => (
            <g
              key={node.character.id}
              className="studio-relationship-node"
              role="button"
              tabIndex={0}
              onClick={() => onPick(node.character)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onPick(node.character)
              }}
            >
              <circle cx={node.x} cy={node.y} r={19} />
              <text className="is-initial" x={node.x} y={node.y + 4}>{node.character.name.slice(0, 1)}</text>
              <text className="is-name" x={node.x} y={node.y + 33}>{node.character.name.slice(0, 6)}</text>
            </g>
          ))}
        </svg>
      ) : <p className="studio-hint">还没有人物，先在蓝图里建立人物。</p>}
      <p className="studio-relationship-hint"><Users size={11} /> {edges.length} 条关系 · 点击人物继续编辑</p>
    </div>
  )
}

function FactPanel({ onEditCharacter }: { onEditCharacter: (character: StudioCharacter) => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const setFactsOpen = useStudioStore((state) => state.setFactsOpen)
  const selectedChapterId = useStudioStore((state) => state.selectedChapterId)
  const selectChapter = useStudioStore((state) => state.selectChapter)
  const selectShot = useStudioStore((state) => state.selectShot)
  const setView = useStudioStore((state) => state.setView)
  const [tab, setTab] = useState<FactTab>('people')
  const [subject, setSubject] = useState('')
  const [predicate, setPredicate] = useState('')
  const [object, setObject] = useState('')
  const [quote, setQuote] = useState('')
  const [checking, setChecking] = useState(false)
  const [worldEditor, setWorldEditor] = useState<{ kind: WorldKind; item: StudioFaction | StudioRule | StudioProp | null } | null>(null)
  if (!active) return <span />
  const chapter = active.chapters.find((item) => item.id === selectedChapterId)
  const jumpToFact = (factId: string): void => {
    const fact = active.facts.find((item) => item.id === factId)
    if (!fact) return
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
      }
    }
  }
  const addFact = async (): Promise<void> => {
    if (!subject.trim() || !predicate.trim() || !object.trim()) return
    const selected = window.getSelection()?.toString().trim().slice(0, 1000) ?? ''
    await run('upsert-fact', {
      fact: {
        subject: subject.trim(),
        predicate: predicate.trim(),
        object: object.trim(),
        ...(chapter ? { chapterId: chapter.id } : {}),
        ...(quote.trim() || selected ? { quote: (quote.trim() || selected).slice(0, 1000) } : {}),
        confidence: 0.9
      }
    })
    setSubject('')
    setPredicate('')
    setObject('')
    setQuote('')
  }
  const review = async (): Promise<void> => {
    setChecking(true)
    try {
      await run('review')
      setTab('checks')
    } finally {
      setChecking(false)
    }
  }
  return (
    <aside className="studio-fact-drawer" aria-label="人物与设定">
      <header>
        <div>
          <span className="studio-eyebrow">设定</span>
          <h2>人物与设定</h2>
        </div>
        <button type="button" onClick={() => setFactsOpen(false)} aria-label="关闭"><X size={14} /></button>
      </header>
      <div className="studio-fact-tabs">
        <button type="button" className={tab === 'people' ? 'is-active' : ''} onClick={() => setTab('people')}><Users size={12} /> 人物</button>
        <button type="button" className={tab === 'facts' ? 'is-active' : ''} onClick={() => setTab('facts')}><BookOpen size={12} /> 设定</button>
        <button type="button" className={tab === 'world' ? 'is-active' : ''} onClick={() => setTab('world')}><Globe2 size={12} /> 世界</button>
        <button type="button" className={tab === 'story' ? 'is-active' : ''} onClick={() => setTab('story')}><BookOpen size={12} /> 章节</button>
        <button type="button" className={tab === 'checks' ? 'is-active' : ''} onClick={() => setTab('checks')}><Eye size={12} /> 检查</button>
      </div>
      <div className="studio-fact-scroll">
        {tab === 'people' ? (
          <>
            {active.characters.map((character) => (
              <button key={character.id} type="button" className="studio-fact-person" onClick={() => onEditCharacter(character)}>
                <span>{character.name.slice(0, 1)}</span>
                <div>
                  <b>{character.name}<em>{character.role}</em></b>
                  <p>{character.desire || character.look}</p>
                  {character.relationships.length ? <small>{character.relationships.map((rel) => `${rel.target}：${rel.label}`).join(' · ')}</small> : null}
                </div>
              </button>
            ))}
            <p className="studio-hint">点击人物可以改外观、想要的、害怕的和声线。</p>
          </>
        ) : null}
        {tab === 'facts' ? (
          <>
            <div className="studio-fact-form">
              <input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="说的是谁：林晚" aria-label="设定主体" />
              <input value={predicate} onChange={(event) => setPredicate(event.target.value)} placeholder="哪方面：想要" aria-label="设定关系" />
              <textarea value={object} onChange={(event) => setObject(event.target.value)} placeholder="内容：把外婆的伞铺继续开下去" rows={2} aria-label="设定内容" />
              <input value={quote} onChange={(event) => setQuote(event.target.value)} placeholder="原文摘录（可选；编辑器里有选中文字时会优先用它）" aria-label="设定原文摘录" />
              <Button variant="ghost" size="sm" onClick={() => void addFact()} disabled={!subject || !predicate || !object}>保存这条设定</Button>
            </div>
            {active.facts.map((fact) => (
              <div key={fact.id} className="studio-fact-row">
                <div>
                  <b>{fact.subject}<i>{fact.predicate}</i>{fact.object}</b>
                  <button type="button" className="studio-fact-source" onClick={() => jumpToFact(fact.id)} title="定位到事实来源">
                    {fact.chapterId ? `第 ${active.chapters.find((item) => item.id === fact.chapterId)?.number ?? '?'} 章` : fact.sceneId ? '镜头设定' : '全局设定'} · {fact.source === 'local' ? '本机生成' : fact.source === 'ai' ? '模型整理' : fact.source === 'import' ? '导入' : '手写'}
                  </button>
                  {fact.quote ? <small className="studio-fact-quote">“{fact.quote}”</small> : null}
                </div>
                <button type="button" title="删除设定" aria-label="删除设定" onClick={() => void run('delete-fact', { factId: fact.id })}><Trash2 size={12} /></button>
              </div>
            ))}
          </>
        ) : null}
        {tab === 'world' ? (
          <div className="studio-world-panel">
            <section>
              <header><b>势力</b><em>{active.factions.length}</em><button type="button" onClick={() => setWorldEditor({ kind: 'faction', item: null })}><Plus size={11} /> 新增</button></header>
              {active.factions.length ? active.factions.map((item) => (
                <button key={item.id} type="button" className="studio-world-row" onClick={() => setWorldEditor({ kind: 'faction', item })}>
                  <Users size={13} />
                  <span><b>{item.name}</b><p>{item.description || '还没有说明。'}</p></span>
                  <Pencil size={11} />
                </button>
              )) : <p className="studio-hint">还没有势力。先写下谁在主角周围施加压力。</p>}
            </section>
            <section>
              <header><b>规则</b><em>{active.rules.length}</em><button type="button" onClick={() => setWorldEditor({ kind: 'rule', item: null })}><Plus size={11} /> 新增</button></header>
              {active.rules.length ? active.rules.map((item) => (
                <button key={item.id} type="button" className="studio-world-row" onClick={() => setWorldEditor({ kind: 'rule', item })}>
                  <ScrollText size={13} />
                  <span><b>{item.title}</b><p>{item.content || '还没有正文。'}</p></span>
                  <Pencil size={11} />
                </button>
              )) : <p className="studio-hint">还没有规则。世界的代价越具体，选择就越有重量。</p>}
            </section>
            <section>
              <header><b>道具</b><em>{active.props.length}</em><button type="button" onClick={() => setWorldEditor({ kind: 'prop', item: null })}><Plus size={11} /> 新增</button></header>
              {active.props.length ? active.props.map((item) => (
                <button key={item.id} type="button" className="studio-world-row" onClick={() => setWorldEditor({ kind: 'prop', item })}>
                  <Layers size={13} />
                  <span><b>{item.name}</b><p>{item.description || '还没有说明。'}</p></span>
                  <Pencil size={11} />
                </button>
              )) : <p className="studio-hint">还没有关键道具。能反复出现、能改变选择的物件最值得记下。</p>}
            </section>
            <section className="studio-relationship-block">
              <header><b>人物关系</b><em>{active.characters.reduce((sum, character) => sum + character.relationships.length, 0)} 条</em></header>
              <RelationshipGraph characters={active.characters} onPick={onEditCharacter} />
            </section>
          </div>
        ) : null}
        {tab === 'story' ? (
          <div className="studio-story-index">
            <p className="studio-hint">按章节号浏览简介和状态；点击进入正文。</p>
            {[...active.chapters].sort((a, b) => a.number - b.number).map((item) => (
              <button
                key={item.id}
                type="button"
                className="studio-story-index-row"
                onClick={() => {
                  selectChapter(item.id)
                  setView('writing')
                  setFactsOpen(false)
                }}
              >
                <span className="mono">{String(item.number).padStart(2, '0')}</span>
                <span>
                  <b>{item.title}</b>
                  <em>{item.synopsis || '还没有简介。'}</em>
                </span>
                <i>{countWords(item.content) ? chapterWordLabel(countWords(item.content)) : '待写'}</i>
              </button>
            ))}
          </div>
        ) : null}
        {tab === 'checks' ? (
          <>
            <Button variant="ghost" size="sm" icon={checking ? <Loader2 size={12} className="studio-spin" /> : <RefreshCw size={12} />} onClick={() => void review()} disabled={checking}>重新检查</Button>
            {active.checks.length === 0 ? <p className="studio-hint">还没有检查记录。运行一次检查，看看人物、设定和章节有没有矛盾。</p> : null}
            {active.checks.filter((check) => check.kind === 'continuity').map((check) => (
              <div key={check.id} className={`studio-check-row is-${check.level}`}>
                <b>{check.title}</b>
                <p>{check.detail}</p>
              </div>
            ))}
            {active.checks.filter((check) => check.kind !== 'continuity').slice(0, 6).map((check) => (
              <div key={check.id} className={`studio-check-row is-${check.level}`}>
                <b>{check.title}</b>
                <p>{check.detail}</p>
              </div>
            ))}
          </>
        ) : null}
      </div>
      {worldEditor ? <WorldItemDialog kind={worldEditor.kind} item={worldEditor.item} onClose={() => setWorldEditor(null)} /> : null}
    </aside>
  )
}

function chapterWordLabel(words: number): string {
  if (words <= 0) return '—'
  if (words <= 99_999) return words.toLocaleString('zh-CN')
  return `${(words / 10_000).toFixed(1)} 万`
}

export function WritingView(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const selectedChapterId = useStudioStore((state) => state.selectedChapterId)
  const selectChapter = useStudioStore((state) => state.selectChapter)
  const outlineOpen = useStudioStore((state) => state.outlineOpen)
  const setOutlineOpen = useStudioStore((state) => state.setOutlineOpen)
  const factsOpen = useStudioStore((state) => state.factsOpen)
  const setFactsOpen = useStudioStore((state) => state.setFactsOpen)
  const focusMode = useStudioStore((state) => state.focusMode)
  const setFocusMode = useStudioStore((state) => state.setFocusMode)
  const saveState = useStudioStore((state) => state.saveState)
  const setSaveState = useStudioStore((state) => state.setSaveState)
  const setEditorDirty = useStudioStore((state) => state.setEditorDirty)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const setView = useStudioStore((state) => state.setView)
  const focusedStage = useStudioStore((state) => state.focusedStage)
  const [stageMenuOpen, setStageMenuOpen] = useState(false)
  const stageMenuRef = useClickOutside(() => setStageMenuOpen(false), stageMenuOpen)

  const chapter = active?.chapters.find((item) => item.id === selectedChapterId) ?? null
  const [content, setContent] = useState(chapter?.content ?? '')
  const [title, setTitle] = useState(chapter?.title ?? '')
  const [synopsis, setSynopsis] = useState(chapter?.synopsis ?? '')
  const [dirty, setDirty] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [polishing, setPolishing] = useState(false)
  const [batchWriting, setBatchWriting] = useState(false)
  const [illustrationsOpen, setIllustrationsOpen] = useState(false)
  const [diffCandidate, setDiffCandidate] = useState<StudioCandidate | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [addChapterOpen, setAddChapterOpen] = useState(false)
  const [editingCharacter, setEditingCharacter] = useState<StudioCharacter | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<StudioChapter | null>(null)
  const [volumeEditor, setVolumeEditor] = useState<{ volume: StudioVolume | null } | null>(null)
  const [confirmVolume, setConfirmVolume] = useState<StudioVolume | null>(null)
  const [dragChapterId, setDragChapterId] = useState<string | null>(null)
  const [dropVolumeId, setDropVolumeId] = useState<string | null>(null)
  const [collapsedVolumes, setCollapsedVolumes] = useState<Set<string>>(new Set())
  const [factTab, setFactTab] = useState<FactTab>('people')
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<EditorView | null>(null)
  const contentRef = useRef(content)
  const dirtyRef = useRef(false)
  const titleRef = useRef(title)
  const synopsisRef = useRef(synopsis)
  const chapterRef = useRef<StudioChapter | null>(chapter)
  const savingRef = useRef(false)
  const queuedSaveRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const activeRef = useRef(active)

  contentRef.current = content
  dirtyRef.current = dirty
  titleRef.current = title
  synopsisRef.current = synopsis
  chapterRef.current = chapter
  activeRef.current = active

  const words = countWords(content)
  const candidates = chapter?.candidates ?? []
  const generatingJob = active?.jobs.find((job) => job.stage === 'writing' && (job.status === 'running' || job.status === 'queued'))

  const saveNow = useCallback(async (): Promise<void> => {
    const currentChapter = chapterRef.current
    const project = activeRef.current
    if (!currentChapter || !project) return
    if (savingRef.current) {
      queuedSaveRef.current = true
      return
    }
    savingRef.current = true
    setSaveState('saving')
    const snapshot = contentRef.current
    try {
      const result = await run('save-chapter', {
        chapterId: currentChapter.id,
        content: snapshot,
        title: titleRef.current,
        synopsis: synopsisRef.current,
        wordTarget: currentChapter.wordTarget
      })
      void result
      if (contentRef.current === snapshot) {
        setDirty(false)
        setEditorDirty(false)
        setSaveState('saved')
      } else {
        queuedSaveRef.current = true
      }
    } catch {
      setSaveState('error')
    } finally {
      savingRef.current = false
      if (queuedSaveRef.current) {
        queuedSaveRef.current = false
        window.setTimeout(() => void saveNow(), 240)
      }
    }
  }, [run, setEditorDirty, setSaveState])
  const saveRef = useRef(saveNow)
  saveRef.current = saveNow

  // 章节切换：载入当前章到编辑器和本地状态。
  useEffect(() => {
    if (!chapter) {
      setContent('')
      setTitle('')
      setSynopsis('')
      setDirty(false)
      setEditorDirty(false)
      return
    }
    if (chapterRef.current?.id === chapter.id && dirtyRef.current) return
    setContent(chapter.content)
    setTitle(chapter.title)
    setSynopsis(chapter.synopsis)
    setDirty(false)
    setEditorDirty(false)
    setSaveState('saved')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.id])

  // 外部内容变化（AI 初稿、采用候选、恢复版本）在未手改时同步到编辑器。
  useEffect(() => {
    if (!chapter) return
    if (dirtyRef.current) return
    if (chapter.content !== contentRef.current) {
      setContent(chapter.content)
      const view = editorRef.current
      if (view && view.state.doc.toString() !== chapter.content) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: chapter.content } })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.content, chapter?.revision])

  // CodeMirror 只创建一次；章节切换时替换文档，保持撤销历史按章隔离。
  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: contentRef.current,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          placeholder('从这里开始写。也可以先让助手出一版草稿。'),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const next = update.state.doc.toString()
            contentRef.current = next
            setContent(next)
            setDirty(true)
            setEditorDirty(true)
          }),
          EditorView.theme({
            '&': { height: 'auto' },
            '.cm-scroller': { overflow: 'visible' },
            '.cm-content': { caretColor: 'var(--studio-paper-ink)' }
          })
        ]
      }),
      parent: hostRef.current
    })
    editorRef.current = view
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      view.destroy()
      editorRef.current = null
      if (dirtyRef.current) void saveRef.current()
    }
  }, [setEditorDirty])

  // 自动保存：停笔约 900ms。
  useEffect(() => {
    if (!dirty || !chapter) return
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      void saveNow()
    }, 900)
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [content, dirty, chapter?.id, saveNow])

  const grouped = useMemo(() => {
    if (!active) return []
    const volumes = [...active.volumes].sort((a, b) => a.number - b.number)
    const result = volumes.map((volume) => ({
      id: volume.id,
      title: volume.title,
      chapters: active.chapters.filter((item) => item.volumeId === volume.id).sort((a, b) => a.number - b.number)
    }))
    const orphan = active.chapters.filter((item) => !item.volumeId || !volumes.some((volume) => volume.id === item.volumeId)).sort((a, b) => a.number - b.number)
    if (orphan.length) result.push({ id: 'orphan', title: active.volumes.length ? '未分卷' : '章节', chapters: orphan })
    return result
  }, [active])

  if (!active) return <div />

  const switchChapter = async (id: string): Promise<void> => {
    if (id === selectedChapterId) return
    if (dirty) await saveNow()
    selectChapter(id)
  }

  const generate = async (): Promise<void> => {
    if (!chapter || generating) return
    setGenerating(true)
    try {
      await run('generate-chapter', {
        chapterId: chapter.id,
        useModel: Boolean(engine?.text.configured),
        requestId: `chapter-${chapter.id}-${Date.now()}`
      })
      notify('info', chapter.content.trim() ? '正在生成候选稿；采用前不会改动正文。' : '正在写这一章；完成后可直接继续手改。')
      if (dirty) await saveNow()
    } finally {
      setGenerating(false)
    }
  }

  const polish = async (): Promise<void> => {
    if (!chapter || polishing) return
    setPolishing(true)
    try {
      await run('polish-chapter', { chapterId: chapter.id, requestId: `polish-${chapter.id}-${Date.now()}` })
      notify('info', '润色任务已排队；完成后会以候选稿出现，不覆盖正文。')
    } finally {
      setPolishing(false)
    }
  }

  const addChapter = (): void => setAddChapterOpen(true)

  const batchWrite = async (): Promise<void> => {
    if (batchWriting) return
    if (dirty) await saveNow()
    setBatchWriting(true)
    try {
      const result = await run<{ project: typeof active; job?: { label: string }; message?: string }>('batch-write', {
        count: 3,
        useModel: Boolean(engine?.text.configured)
      })
      notify('info', result.message ?? '已排队连续写作。')
    } finally {
      setBatchWriting(false)
    }
  }

  const deleteChapter = async (): Promise<void> => {
    if (!confirmDelete) return
    await run('delete-chapter', { chapterId: confirmDelete.id, confirmed: true })
    setConfirmDelete(null)
    const next = active.chapters.filter((item) => item.id !== confirmDelete.id).sort((a, b) => a.number - b.number)[0]
    if (next) selectChapter(next.id)
  }

  return (
    <div className={`studio-writing ${focusMode ? 'is-focus' : ''} ${factsOpen ? 'is-facts' : ''}`}>
      <div className="studio-writing-main">
        <header className="studio-writing-bar">
          <div className="studio-writing-bar-left">
            {!focusMode ? (
              <div className="studio-writing-stage" ref={stageMenuRef}>
                <button type="button" className={['studio-writing-stage-btn', stageMenuOpen ? 'is-open' : ''].filter(Boolean).join(' ')} onClick={() => setStageMenuOpen((open) => !open)} aria-expanded={stageMenuOpen} aria-haspopup="menu">
                  <Layers size={14} strokeWidth={1.5} />
                  切换阶段
                  <ChevronDown size={11} strokeWidth={1.6} />
                </button>
                {stageMenuOpen ? (
                  <div className="studio-writing-stage-pop" role="menu">
                    <span className="studio-menu-label">切换阶段</span>
                    {studioStages(active.kind).map((stage) => {
                      const current = (focusedStage ?? active.stage) === stage.id
                      return (
                        <button key={stage.id} type="button" role="menuitem" className={current ? 'is-current' : ''} onClick={() => { setStageMenuOpen(false); navigateStage(stage.id) }}>
                          <StageIcon stage={stage.id} size={13} />
                          <span>{stage.label}</span>
                          {current ? <em>当前</em> : null}
                        </button>
                      )
                    })}
                    <div className="studio-writing-stage-divider" />
                    <button type="button" role="menuitem" onClick={() => { setStageMenuOpen(false); setView('home') }}>
                      <BookOpen size={13} />
                      <span>作品库</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {!focusMode ? (
              <button type="button" className={['studio-bar-icon', outlineOpen ? 'is-active' : ''].filter(Boolean).join(' ')} title={outlineOpen ? '收起目录' : '展开目录'} onClick={() => setOutlineOpen(!outlineOpen)}>
                <BookOpen size={15} />
              </button>
            ) : null}
            <div className="studio-writing-breadcrumb">
              <span>{active.title}</span>
              <i>/</i>
              <b>第 {chapter?.number ?? '—'} 章</b>
            </div>
            <span className={`studio-save-state is-${saveState}`}>
              {saveState === 'saving' ? <Loader2 size={11} className="studio-spin" /> : saveState === 'error' ? '!' : <Check size={11} />}
              {saveState === 'saving' ? '保存中' : saveState === 'error' ? '保存失败' : '已保存'}
            </span>
          </div>
          <div className="studio-writing-bar-right">
            <button type="button" className={['studio-bar-icon', factsOpen ? 'is-active' : ''].filter(Boolean).join(' ')} title="人物、设定与检查" onClick={() => setFactsOpen(!factsOpen)}>
              <Users size={15} />
            </button>
            <button type="button" className="studio-bar-icon" title="历史版本" onClick={() => setHistoryOpen(true)} disabled={!chapter}>
              <FileClock size={15} />
            </button>
            <button type="button" className={['studio-bar-icon', focusMode ? 'is-active' : ''].filter(Boolean).join(' ')} title={focusMode ? '退出专注模式' : '专注模式'} onClick={() => setFocusMode(!focusMode)}>
              {focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <Button variant="gold" size="sm" icon={generating ? <Loader2 size={13} className="studio-spin" /> : <WandSparkles size={13} />} onClick={() => void generate()} disabled={!chapter || Boolean(generatingJob)}>
              {generatingJob ? '写作中' : chapter?.content.trim() ? '生成候选稿' : 'AI 写这一章'}
            </Button>
            {engine?.text.configured && chapter?.content.trim() ? (
              <Button variant="ghost" size="sm" icon={polishing ? <Loader2 size={13} className="studio-spin" /> : <Sparkles size={13} />} onClick={() => void polish()} disabled={polishing || Boolean(generatingJob)} title="生成润色候选稿" aria-label="润色">润色</Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              icon={batchWriting ? <Loader2 size={13} className="studio-spin" /> : <Layers size={13} />}
              onClick={() => void batchWrite()}
              disabled={batchWriting || generating || !active.chapters.some((item) => !item.content.trim())}
              title="只续写还没有正文的章节；每章单独生成一版候选稿，已有正文不会被覆盖"
              aria-label="连续写 3 章"
            >
              连续写 3 章
            </Button>
            {focusMode ? (
              <Button variant="ghost" size="sm" onClick={addChapter} icon={<Plus size={13} />} title="新建章节" aria-label="新章">新建一章</Button>
            ) : null}
          </div>
        </header>

        {!chapter ? (
          <div className="studio-writing-empty">
            <span className="studio-empty-mark"><BookOpen size={24} strokeWidth={1.2} /></span>
            <h2>这本书还没有章节</h2>
            <p>先建立第一章，或者回到蓝图确认章节安排。</p>
            <Button variant="gold" icon={<Plus size={14} />} onClick={addChapter}>新建第一章</Button>
          </div>
        ) : (
          <div className="studio-writing-body">
            {!focusMode && outlineOpen ? (
              <aside className="studio-outline">
                <div className="studio-outline-head">
                  <span className="studio-eyebrow">目录</span>
                  <em className="mono">{active.chapters.reduce((sum, item) => sum + countWords(item.content), 0).toLocaleString('zh-CN')} 字</em>
                </div>
                <div className="studio-outline-scroll">
                  {grouped.map((group) => {
                    const collapsed = collapsedVolumes.has(group.id)
                    const volume = active.volumes.find((item) => item.id === group.id) ?? null
                    return (
                      <div
                        key={group.id}
                        className={`studio-outline-volume ${dropVolumeId === group.id ? 'is-drop-target' : ''}`}
                        onDragOver={(event) => {
                          if (!dragChapterId) return
                          event.preventDefault()
                          setDropVolumeId(group.id)
                        }}
                        onDragLeave={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropVolumeId(null)
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          const chapterId = dragChapterId || event.dataTransfer.getData('text/plain')
                          if (chapterId) void run('move-chapter', { chapterId, volumeId: group.id === 'orphan' ? null : group.id })
                          setDragChapterId(null)
                          setDropVolumeId(null)
                        }}
                      >
                        <div className="studio-outline-volume-head">
                          <button
                            type="button"
                            className="studio-outline-volume-toggle"
                            onClick={() => {
                              setCollapsedVolumes((state) => {
                                const next = new Set(state)
                                if (next.has(group.id)) next.delete(group.id)
                                else next.add(group.id)
                                return next
                              })
                            }}
                          >
                            <ChevronDown size={11} className={collapsed ? 'is-collapsed' : ''} />
                            <span>{group.title}</span>
                            <em>{group.chapters.length}</em>
                          </button>
                          {volume ? (
                            <span className="studio-outline-volume-actions">
                              <button type="button" title="编辑分卷" aria-label="编辑分卷" onClick={() => setVolumeEditor({ volume })}><Pencil size={10} /></button>
                              <button type="button" title="上移分卷" aria-label="上移分卷" onClick={() => void run('move-volume', { volumeId: volume.id, offset: -1 })}><ArrowUp size={10} /></button>
                              <button type="button" title="下移分卷" aria-label="下移分卷" onClick={() => void run('move-volume', { volumeId: volume.id, offset: 1 })}><ArrowDown size={10} /></button>
                              <button type="button" title="删除分卷" aria-label="删除分卷" onClick={() => setConfirmVolume(volume)}><Trash2 size={10} /></button>
                            </span>
                          ) : null}
                        </div>
                        {!collapsed
                          ? group.chapters.map((item) => (
                              <div
                                key={item.id}
                                draggable
                                onDragStart={(event) => {
                                  setDragChapterId(item.id)
                                  event.dataTransfer.effectAllowed = 'move'
                                  event.dataTransfer.setData('text/plain', item.id)
                                }}
                                onDragEnd={() => {
                                  setDragChapterId(null)
                                  setDropVolumeId(null)
                                }}
                                onDragOver={(event) => {
                                  if (!dragChapterId) return
                                  event.preventDefault()
                                  setDropVolumeId(group.id)
                                }}
                                onDrop={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                  const chapterId = dragChapterId || event.dataTransfer.getData('text/plain')
                                  if (chapterId && chapterId !== item.id) {
                                    void run('move-chapter', {
                                      chapterId,
                                      volumeId: group.id === 'orphan' ? null : group.id,
                                      beforeChapterId: item.id
                                    })
                                  }
                                  setDragChapterId(null)
                                  setDropVolumeId(null)
                                }}
                                className={['studio-outline-row', item.id === chapter.id ? 'is-current' : '', dragChapterId === item.id ? 'is-dragging' : ''].filter(Boolean).join(' ')}
                              >
                                <button type="button" className="studio-outline-chapter" onClick={() => void switchChapter(item.id)}>
                                  <span className={`studio-outline-dot is-${item.status}`} />
                                  <span className="studio-outline-number mono">{String(item.number).padStart(2, '0')}</span>
                                  <span className="studio-outline-title">{item.title}</span>
                                  <span className="studio-outline-words mono">{chapterWordLabel(countWords(item.content))}</span>
                                  {item.candidates.length ? <i className="studio-outline-candidate">{item.candidates.length}</i> : null}
                                </button>
                                <span className="studio-outline-actions">
                                  <button type="button" title="上移" aria-label="上移一章" onClick={() => void run('move-chapter', { chapterId: item.id, offset: -1 })}><ArrowUp size={11} /></button>
                                  <button type="button" title="下移" aria-label="下移一章" onClick={() => void run('move-chapter', { chapterId: item.id, offset: 1 })}><ArrowDown size={11} /></button>
                                  <button type="button" title="删除" aria-label="删除一章" onClick={() => setConfirmDelete(item)}><Trash2 size={11} /></button>
                                </span>
                              </div>
                            ))
                          : null}
                      </div>
                    )
                  })}
                </div>
                <div className="studio-outline-add-row">
                  <button type="button" className="studio-outline-add" onClick={addChapter}><Plus size={12} /> 新建一章</button>
                  <button type="button" className="studio-outline-add" onClick={() => setVolumeEditor({ volume: null })}><Plus size={12} /> 新建分卷</button>
                </div>
                <div className="studio-outline-foot">
                  <span>已写 {active.chapters.filter((item) => item.content.trim()).length}/{active.chapters.length} 章</span>
                  <button type="button" onClick={() => setFocusMode(true)}><Maximize2 size={11} /> 专注</button>
                </div>
              </aside>
            ) : null}

            <div className="studio-paper-scroll">
              <article className="studio-paper">
                <header className="studio-paper-head">
                  <span className="studio-paper-chapter mono">第 {chapter.number} 章</span>
                  <input
                    className="studio-paper-title"
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value)
                      setDirty(true)
                      setEditorDirty(true)
                    }}
                    onBlur={() => void saveNow()}
                    aria-label="章节标题"
                  />
                  <div className="studio-paper-meta">
                    <span>{words.toLocaleString('zh-CN')} / {chapter.wordTarget.toLocaleString('zh-CN')} 字</span>
                    <i />
                    <span className={`is-${chapter.status}`}>{studioStatusLabel(chapter.status)}</span>
                    <i />
                    <span>{candidates.length ? `${candidates.length} 版候选稿等你决定` : '候选不会覆盖你写的正文'}</span>
                    {generatingJob ? <span className="studio-paper-live"><Loader2 size={10} className="studio-spin" /> 正在写</span> : null}
                    <button type="button" className="studio-paper-illustration-btn" onClick={() => setIllustrationsOpen(true)}>
                      <ImagePlus size={11} /> 配图{chapter.illustrations.length ? ` ${chapter.illustrations.length}` : ''}
                    </button>
                  </div>
                  <div className="studio-paper-synopsis">
                    <span>本章简介</span>
                    <input
                      value={synopsis}
                      onChange={(event) => {
                        setSynopsis(event.target.value)
                        setDirty(true)
                        setEditorDirty(true)
                      }}
                      onBlur={() => void saveNow()}
                      placeholder="简单说，这一章发生了什么？"
                      aria-label="本章简介"
                    />
                  </div>
                </header>

                {candidates.length ? (
                  <div className="studio-candidate-banner">
                    <span><Sparkles size={12} /> {candidates.length} 版候选稿等你决定，正文没有变。</span>
                    <div>
                      {candidates.slice(0, 2).map((candidate) => (
                        <button key={candidate.id} type="button" onClick={() => setDiffCandidate(candidate)}>{candidate.label}</button>
                      ))}
                      {candidates.length > 2 ? <button type="button" onClick={() => setDiffCandidate(candidates[0])}>查看全部候选</button> : null}
                    </div>
                  </div>
                ) : null}

                <div className="studio-manuscript" ref={hostRef} aria-label="正文编辑器" />
                {chapter.illustrations.length ? (
                  <div className="studio-paper-illustrations" aria-label="章节配图">
                    {chapter.illustrations.map((item) => {
                      const asset = active.assets.find((entry) => entry.id === item.assetId)
                      if (!asset) return null
                      return (
                        <figure key={item.id}>
                          <img src={asset.thumbUrl ?? asset.url} alt={item.caption ?? asset.title} />
                          <figcaption>{item.caption ?? asset.title}<span>第 {item.afterParagraph} 段后</span></figcaption>
                        </figure>
                      )
                    })}
                  </div>
                ) : null}
                {!content.trim() ? (
                  <div className="studio-paper-empty">
                    <Sparkles size={18} strokeWidth={1.3} />
                    <p>这一章还是空白。可以直接开始写，或者让助手先给一版草稿。</p>
                    <Button variant="ghost" size="sm" icon={<WandSparkles size={13} />} onClick={() => void generate()} disabled={Boolean(generatingJob)}>
                      {generatingJob ? '正在生成…' : '先生成一版草稿'}
                    </Button>
                  </div>
                ) : null}
                <footer className="studio-paper-foot">
                  <span>手改自动保存 · 用候选前自动留档</span>
                </footer>
              </article>
            </div>

            {!focusMode && factsOpen ? <FactPanel onEditCharacter={setEditingCharacter} /> : null}
          </div>
        )}
        {focusMode ? (
          <button type="button" className="studio-focus-exit" onClick={() => setFocusMode(false)}><Minimize2 size={13} /> 退出专注</button>
        ) : null}
      </div>

      {diffCandidate && chapter ? <CandidateDiff chapter={chapter} candidate={diffCandidate} onClose={() => setDiffCandidate(null)} onBefore={saveNow} /> : null}
      {historyOpen && chapter ? <VersionDialog chapter={chapter} onClose={() => setHistoryOpen(false)} onBefore={saveNow} /> : null}
      {illustrationsOpen && chapter ? <IllustrationDialog chapter={chapter} onClose={() => setIllustrationsOpen(false)} /> : null}
      <AddChapterDialog
        open={addChapterOpen}
        onClose={() => setAddChapterOpen(false)}
        onCreated={(id) => {
          selectChapter(id)
          setAddChapterOpen(false)
        }}
      />
      {editingCharacter ? <CharacterDialog character={editingCharacter} onClose={() => setEditingCharacter(null)} /> : null}
      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title={`删除第 ${confirmDelete?.number ?? ''} 章？`}
        description="这一章和它的候选稿会被移除；作品会保留其他章节。删除前建议先导出作品。"
        width={460}
        layer="overlay"
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>保留</Button>
            <Button variant="danger" onClick={() => void deleteChapter()}>删除这一章</Button>
          </div>
        }
      >
        <p className="studio-confirm-text"><b>{confirmDelete?.title}</b><br />{confirmDelete ? `${countWords(confirmDelete.content)} 字 · ${confirmDelete.candidates.length} 个候选` : null}</p>
      </Modal>
      {volumeEditor ? <VolumeDialog volume={volumeEditor.volume} onClose={() => setVolumeEditor(null)} /> : null}
      <Modal
        open={Boolean(confirmVolume)}
        onClose={() => setConfirmVolume(null)}
        title={`删除分卷「${confirmVolume?.title ?? ''}」？`}
        description="分卷里的章节会保留并移到「未分卷」，正文、候选与版本都不会删除。"
        width={460}
        layer="overlay"
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setConfirmVolume(null)}>保留分卷</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmVolume) void run('delete-volume', { volumeId: confirmVolume.id })
                setConfirmVolume(null)
              }}
            >
              删除分卷
            </Button>
          </div>
        }
      >
        <p className="studio-confirm-text"><b>{confirmVolume?.title}</b><br />{confirmVolume ? `${confirmVolume.chapterIds.length} 章会保留并移动到未分卷。` : null}</p>
      </Modal>
    </div>
  )
}
