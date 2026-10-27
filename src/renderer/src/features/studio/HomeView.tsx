import { useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  BookOpen,
  Clapperboard,
  Copy,
  Plus,
  Search,
  Sparkles,
  Trash2
} from 'lucide-react'
import type { StudioKind, StudioProjectSummary } from '@shared/studio'
import { studioKindLabel, studioKindScale } from '@shared/studio'
import { Button, Modal, Segmented } from '../../ui'
import { previewBrief } from '@shared/brief-preview'
import { useStudioStore } from './studio-store'
import { studioApi } from './api'
import { CoverThumb, KindBadge, SectionTitle, StageIcon, timeAgo } from './components'
import { StudioMark } from './StudioMark'

interface Template {
  id: string
  title: string
  subtitle: string
  kind: StudioKind
  logline: string
  genre: string
  form: '速成草稿' | '精制' | '电影级'
  targetWords?: number
  targetSeconds?: number
  tags: string[]
}

const TEMPLATES: Template[] = [
  {
    id: 'rain-short',
    title: '雨夜短篇',
    subtitle: '12 章 · 情绪起伏 · 克制收尾',
    kind: 'short',
    logline: '一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。她每修好一把伞，就会失去一段记忆。',
    genre: '都市奇幻',
    form: '速成草稿',
    targetWords: 18_000,
    tags: ['短篇', '雨夜', '记忆']
  },
  {
    id: 'long-serial',
    title: '长篇连载',
    subtitle: '三卷 36 章 · 先立人物与设定',
    kind: 'novel',
    logline: '一个修伞的女孩继承外婆的伞铺，每周三都会有一个失忆的少年，来修同一把黑伞。',
    genre: '都市奇幻',
    form: '精制',
    targetWords: 300_000,
    tags: ['长篇', '连载', '伞铺']
  },
  {
    id: 'drama-96',
    title: '96 秒漫剧',
    subtitle: '12 镜 · 配音 · 音乐 · 字幕',
    kind: 'drama',
    logline: '一个雨夜，修伞的女孩捡到一把会让时间倒流的伞。她每修好一把伞，就会失去一段记忆。',
    genre: '都市奇幻',
    form: '速成草稿',
    targetSeconds: 96,
    tags: ['漫剧', '分镜', '草稿']
  }
]

const INSPIRATIONS = [
  '一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。',
  '凌晨书店只卖一本书，每本书里都夹着读者的未来。',
  '一档停播十年的深夜电台，突然收到来自明天的电话。',
  '租来的情感可以按小时计费，但副作用会留在身体里。'
]

const FILTERS: Array<{ id: 'all' | 'recent' | 'drama' | 'short' | 'novel' | 'templates'; label: string }> = [
  { id: 'all', label: '全部作品' },
  { id: 'recent', label: '最近打开' },
  { id: 'drama', label: '漫剧' },
  { id: 'short', label: '中短篇' },
  { id: 'novel', label: '长篇' },
  { id: 'templates', label: '模板' }
]

const KIND_OPTIONS: Array<{ value: StudioKind; title: string; desc: string; icon: React.ReactNode }> = [
  { value: 'drama', title: '漫剧', desc: '30–180 秒 · 分镜 · 配音 · 成片', icon: <Clapperboard size={16} strokeWidth={1.5} /> },
  { value: 'short', title: '中短篇', desc: '3–8 万字 · 章节 · 情绪起伏', icon: <BookOpen size={16} strokeWidth={1.5} /> },
  { value: 'novel', title: '长篇', desc: '20–100 万字 · 分卷分章 · 人物与设定', icon: <BookOpen size={18} strokeWidth={1.5} /> }
]

function ProjectCard({ project, onDelete, onDuplicate }: { project: StudioProjectSummary; onDelete: () => void; onDuplicate: () => void }): React.JSX.Element {
  const openProject = useStudioStore((state) => state.openProject)
  return (
    <article className="studio-project-card">
      <button type="button" className="studio-project-cover" onClick={() => void openProject(project.id)} aria-label={`继续创作 ${project.title}`}>
        <CoverThumb summary={project} size="lg" />
        <span className="studio-project-type"><KindBadge kind={project.kind} /></span>
        {project.demo ? <span className="studio-demo-badge">示例</span> : null}
        <span className="studio-project-progress"><i style={{ width: `${Math.max(4, project.progress)}%` }} /></span>
      </button>
      <div className="studio-project-body">
        <div className="studio-project-title-row">
          <h3>{project.title}</h3>
          <span className="mono">{Math.max(0, project.progress)}%</span>
        </div>
        <p className="studio-project-logline">{project.logline || '还没有一句话介绍。'}</p>
        <div className="studio-project-meta">
          <span>{project.kind === 'drama' ? `${project.shots} 镜 · ${project.progress >= 90 ? '草稿就绪' : '制作中'}` : `${project.chapters} 章 · ${(project.words / 10000).toFixed(1)} 万字`}</span>
          <span>{timeAgo(project.updatedAt)}</span>
        </div>
        <div className="studio-project-actions">
          <button type="button" className="studio-link-btn" onClick={() => void openProject(project.id)}>
            继续创作 <ArrowRight size={12} />
          </button>
          <div className="studio-project-icon-actions">
            <button type="button" title="复制作品" aria-label="复制作品" onClick={onDuplicate}><Copy size={13} /></button>
            <button type="button" title="删除作品" aria-label="删除作品" onClick={onDelete}><Trash2 size={13} /></button>
          </div>
        </div>
      </div>
    </article>
  )
}

export function HomeView(): React.JSX.Element {
  const projects = useStudioStore((state) => state.projects)
  const engine = useStudioStore((state) => state.engine)
  const filter = useStudioStore((state) => state.libraryFilter)
  const search = useStudioStore((state) => state.search)
  const setSearch = useStudioStore((state) => state.setSearch)
  const setFilter = useStudioStore((state) => state.setLibraryFilter)
  const createProject = useStudioStore((state) => state.createProject)
  const run = useStudioStore((state) => state.run)
  const openProject = useStudioStore((state) => state.openProject)
  const duplicateProject = useStudioStore((state) => state.duplicateProject)
  const deleteProject = useStudioStore((state) => state.deleteProject)
  const busy = useStudioStore((state) => state.busy)
  const openGuide = useStudioStore((state) => state.openGuide)
  const openDemo = useStudioStore((state) => state.openDemo)
  const notify = useStudioStore((state) => state.notify)
  const [kind, setKind] = useState<StudioKind>('drama')
  const [logline, setLogline] = useState('')
  const [form, setForm] = useState<'速成草稿' | '精制' | '电影级'>('速成草稿')
  const [aspect, setAspect] = useState<'16:9' | '9:16' | '1:1'>('16:9')
  const [advanced, setAdvanced] = useState(false)
  const [genre, setGenre] = useState('都市奇幻')
  const [audience, setAudience] = useState('')
  const [tone, setTone] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [confirmDelete, setConfirmDelete] = useState<StudioProjectSummary | null>(null)
  const [creating, setCreating] = useState(false)

  const visibleProjects = useMemo(() => {
    let list = [...projects]
    if (filter === 'drama' || filter === 'short' || filter === 'novel') list = list.filter((project) => project.kind === filter)
    if (filter === 'recent') list = list.slice(0, 3)
    if (filter === 'templates') return []
    const query = search.trim().toLowerCase()
    if (query) list = list.filter((project) => `${project.title} ${project.logline}`.toLowerCase().includes(query))
    return list
  }, [projects, filter, search])

  const preview = useMemo(() => previewBrief(logline, kind), [logline, kind])

  const applyTemplate = (template: Template): void => {
    setKind(template.kind)
    setLogline(template.logline)
    setGenre(template.genre)
    setForm(template.form)
    setAdvanced(false)
    inputRef.current?.focus()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const start = async (): Promise<void> => {
    if (!logline.trim() || creating) return
    setCreating(true)
    try {
      const project = await createProject({
        kind,
        logline: logline.trim(),
        form,
        genre,
        audience,
        tone,
        aspect,
        targetWords: kind === 'short' ? 18_000 : kind === 'novel' ? 300_000 : undefined,
        targetSeconds: kind === 'drama' ? 96 : undefined,
        constraints: kind === 'drama' ? ['角色脸不换', '雨丝方向一致', aspect] : []
      })
      await run('generate-blueprint', { useModel: Boolean(engine?.text.configured), requestId: `blueprint-${project.id}` })
      notify('info', '蓝图正在生成；确认前不会产生费用。')
    } catch {
      // store 已提示错误
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="studio-home">
      <section className="studio-hero">
        <div className="studio-hero-glow" aria-hidden />
        <div className="studio-hero-top">
          <span className="studio-eyebrow">
            {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
          </span>
          <div className="studio-hero-actions">
            <span>一句话先出蓝图，再决定花多少。</span>
            <button type="button" className="studio-home-utility" onClick={openGuide}>使用指引</button>
            <button type="button" className="studio-home-utility is-gold" onClick={openDemo}>看演示</button>
          </div>
        </div>
        <h1 className="studio-hero-title">今天，想把哪句话变成作品？</h1>
        <p className="studio-hero-sub">
          先说一句。这里会给出故事主线、人物、结构与大概花费，再由你决定是否开始。
        </p>

        <div className="studio-brief-sheet">
          <div className="studio-brief-rule" aria-hidden />
          <div className="studio-kind-row" role="radiogroup" aria-label="作品形态">
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={kind === option.value}
                className={kind === option.value ? 'is-active' : ''}
                onClick={() => setKind(option.value)}
              >
                <span className="studio-kind-icon">{option.icon}</span>
                <span>
                  <b>{option.title}</b>
                  <em>{option.desc}</em>
                </span>
              </button>
            ))}
          </div>
          <textarea
            ref={inputRef}
            className="studio-logline-input"
            value={logline}
            onChange={(event) => setLogline(event.target.value)}
            placeholder="例如：一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。"
            maxLength={2000}
            rows={3}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void start()
              }
            }}
          />
          {logline.trim() ? (
            <div className={`studio-brief-preview is-${preview.confidence}`}>
              <span className="studio-brief-preview-state">
                <i /> {preview.confidence === 'high' ? '信息够用了' : preview.confidence === 'medium' ? '还差一点' : '先补主角'}
              </span>
              {preview.subject ? <span className="studio-brief-preview-chip">主角 · {preview.subject}</span> : null}
              {preview.goal ? <span className="studio-brief-preview-chip">想要 · {preview.goal}</span> : null}
              {preview.obstacle ? <span className="studio-brief-preview-chip">阻力 · {preview.obstacle}</span> : null}
              {preview.turn ? <span className="studio-brief-preview-chip">转折 · {preview.turn}</span> : null}
              {preview.questions.length ? <span className="studio-brief-preview-question">可以再补：{preview.questions[0]}</span> : null}
            </div>
          ) : null}
          <div className="studio-brief-controls">
            <Segmented
              value={form}
              options={[
                { value: '速成草稿', label: '速成草稿' },
                { value: '精制', label: '精制' },
                { value: '电影级', label: '电影级' }
              ]}
              onChange={(value) => setForm(value)}
              ariaLabel="制作精细度"
            />
            <Segmented
              value={aspect}
              options={[
                { value: '16:9', label: '16:9' },
                { value: '9:16', label: '9:16' },
                { value: '1:1', label: '1:1' }
              ]}
              onChange={(value) => setAspect(value)}
              ariaLabel="画面比例"
            />
            <button type="button" className="studio-more-toggle" onClick={() => setAdvanced((value) => !value)}>
              {advanced ? '收起要求' : '补充要求'}
            </button>
            <div className="studio-brief-spacer" />
            <Button variant="gold" onClick={() => void start()} loading={creating} disabled={!logline.trim()} icon={<Sparkles size={14} />} iconRight={<ArrowRight size={13} />}>
              生成故事蓝图
            </Button>
          </div>
          {advanced ? (
            <div className="studio-advanced-fields">
              <label>
                <span>故事类型</span>
                <input value={genre} onChange={(event) => setGenre(event.target.value)} placeholder="都市奇幻 / 悬疑 / 现实" />
              </label>
              <label>
                <span>给谁看</span>
                <input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="例如：18–35 岁、喜欢短片" />
              </label>
              <label>
                <span>整体语气</span>
                <input value={tone} onChange={(event) => setTone(event.target.value)} placeholder="例如：克制、潮湿、温柔" />
              </label>
              <div className="studio-target-note">
                <span>目标</span>
                <b className="mono">{kind === 'drama' ? '96 秒 · 12 镜' : kind === 'short' ? '约 1.8 万字 · 12 章' : '约 30 万字 · 36 章'}</b>
              </div>
            </div>
          ) : null}
          <div className="studio-brief-foot">
            <span><i className="is-gold" /> 生成蓝图不收费；你确认后才开始产生费用</span>
            <span><i /> AI 改写不会覆盖你手动改的内容</span>
            <span className={`studio-brief-engine ${engine?.text.configured ? 'is-online' : ''}`}>
              <i /> {engine?.text.configured ? engine.text.modelLabel : '本机可先生成结构'}
            </span>
          </div>
        </div>

        <div className="studio-inspirations">
          <span className="studio-inspiration-label">试试</span>
          {INSPIRATIONS.slice(0, 3).map((idea) => (
            <button key={idea} type="button" onClick={() => { setLogline(idea); inputRef.current?.focus() }}>
              {idea.length > 26 ? `${idea.slice(0, 24)}…` : idea}
            </button>
          ))}
        </div>
      </section>

      <section className="studio-library">
        <div className="studio-home-filter-row" role="tablist" aria-label="筛选作品">
          {FILTERS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? 'is-active' : ''} onClick={() => setFilter(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <SectionTitle
          title={filter === 'templates' ? '从模板开始' : filter === 'recent' ? '最近打开' : '继续创作'}
          aside={
            <div className="studio-library-tools">
              <label className="studio-search">
                <Search size={13} strokeWidth={1.6} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索作品" aria-label="搜索作品" />
              </label>
            </div>
          }
        >
          {filter === 'templates' ? '模板只帮你搭好结构；故事、风格和花费仍由你决定。' : '打开就能接着写：章节、候选、镜头和时间线都在原处。'}
        </SectionTitle>

        {filter === 'templates' ? (
          <div className="studio-template-grid">
            {TEMPLATES.map((template) => (
              <button key={template.id} type="button" className={`studio-template-card is-${template.kind}`} onClick={() => applyTemplate(template)}>
                <span className="studio-template-glyph"><StageIcon stage={template.kind} size={22} /></span>
                <span className="studio-template-copy">
                  <b>{template.title}</b>
                  <em>{template.subtitle}</em>
                  <span>{template.logline}</span>
                </span>
                <span className="studio-template-tags">{template.tags.map((tag) => <i key={tag}>{tag}</i>)}</span>
                <span className="studio-template-use">用这个开始 <ArrowRight size={12} /></span>
              </button>
            ))}
          </div>
        ) : visibleProjects.length ? (
          <div className="studio-project-grid">
            {visibleProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onDelete={() => setConfirmDelete(project)}
                onDuplicate={() => void duplicateProject(project.id)}
              />
            ))}
            <button type="button" className="studio-project-new" onClick={() => { setFilter('all'); inputRef.current?.focus() }}>
              <span><Plus size={18} /></span>
              <b>新建作品</b>
              <em>从一句话开始</em>
            </button>
          </div>
        ) : (
          <div className="studio-library-empty">
            <StudioMark size={44} />
            <h3>{search ? '没有找到这个作品' : '还没有作品'}</h3>
            <p>{search ? '换一个关键词，或清空搜索。' : '先在上面写一句话，Morrow 会给你一份可修改的故事蓝图。'}</p>
            {search ? <button type="button" onClick={() => setSearch('')}>清空搜索</button> : null}
          </div>
        )}
      </section>

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title="删除这个作品？"
        description="作品会移入回收目录，不会立刻永久删除；但它会从作品库消失。"
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>保留作品</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDelete) void deleteProject(confirmDelete.id)
                setConfirmDelete(null)
              }}
            >
              移入回收目录
            </Button>
          </div>
        }
        width={480}
      >
        {confirmDelete ? <p className="studio-confirm-text"><b>{confirmDelete.title}</b><br />{confirmDelete.logline}</p> : null}
      </Modal>
    </div>
  )
}
