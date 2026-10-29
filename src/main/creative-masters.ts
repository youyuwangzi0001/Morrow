import { gunzipSync } from 'node:zlib'
import type { StudioKind } from '../shared/studio'
import { CREATIVE_PROMPTS_GZIP_BASE64 } from './creative-prompts.generated'

export type CreativeMaster = 'writing' | 'screenwriting' | 'directing'

export type CreativeTask =
  | 'blueprint'
  | 'outline'
  | 'chapter'
  | 'rewrite'
  | 'screenplay'
  | 'dialogue'
  | 'storyboard'
  | 'image'
  | 'video'
  | 'voice'
  | 'music'
  | 'review'
  | 'adaptation'
  | 'comic'
  | 'delivery'
  | 'assistant'

export interface CreativeMasterInput {
  kind: StudioKind
  task: CreativeTask
  query?: string
  /** 当前创作台视图，帮助协作者判断用户在哪一步提需求。 */
  view?: string
  /** 主提示词与按需方法论的字符预算；默认 22000，约 12k–18k tokens。 */
  budgetChars?: number
}

export interface CreativeMasterSelection {
  master: CreativeMaster
  label: string
  root: 'embedded'
  skillSections: string[]
  methodology: string[]
  chars: number
}

interface EmbeddedMaster {
  skill: string
  methodology: Record<string, string>
}

interface EmbeddedPayload {
  version: number
  masters: Record<CreativeMaster, EmbeddedMaster>
}

const MASTER_LABEL: Record<CreativeMaster, string> = {
  writing: '写作大师',
  screenwriting: '编剧大师',
  directing: '导演大师'
}

let bundle: EmbeddedPayload | null = null

function embeddedBundle(): EmbeddedPayload {
  if (bundle) return bundle
  try {
    const json = gunzipSync(Buffer.from(CREATIVE_PROMPTS_GZIP_BASE64, 'base64')).toString('utf8')
    const parsed = JSON.parse(json) as EmbeddedPayload
    if (!parsed?.masters?.writing?.skill || !parsed?.masters?.directing?.skill || !parsed?.masters?.screenwriting?.skill) {
      throw new Error('缺少写作、编剧或导演套组')
    }
    bundle = parsed
    return bundle
  } catch (err) {
    throw new Error(`内嵌创作方法损坏，请重新安装 Morrow。${err instanceof Error ? `（${err.message}）` : ''}`)
  }
}

interface MarkdownSection {
  title: string
  body: string
}

function splitSkill(text: string): { preamble: string; sections: MarkdownSection[] } {
  const lines = text.split(/\r?\n/)
  const sections: MarkdownSection[] = []
  const preamble: string[] = []
  let current: { title: string; lines: string[] } | null = null
  for (const line of lines) {
    const heading = /^(##|###)\s+(.+?)\s*$/.exec(line)
    if (heading) {
      if (current) sections.push({ title: current.title, body: current.lines.join('\n') })
      current = { title: heading[2], lines: [] }
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  if (current) sections.push({ title: current.title, body: current.lines.join('\n') })
  return { preamble: preamble.join('\n'), sections }
}

function pickSections(master: CreativeMaster, task: CreativeTask, kind: StudioKind): string[] {
  if (master === 'screenwriting') return []
  const common = ['输出前自检', '写作红线', '工作流纪律']
  const writing: Partial<Record<CreativeTask, string[]>> = {
    blueprint: ['输入兼容', '任务路由', '第一步', '第二步'],
    outline: ['任务路由', '第二步', '第三步'],
    chapter: ['第三步', '第四步', '第五步'],
    rewrite: ['第五步', '第六步', '自检体系'],
    review: ['第六步', '自检体系', '记忆检查点'],
    assistant: ['任务路由', '第一步', '第五步', '自检体系'],
    adaptation: ['任务路由', '第一步']
  }
  const directing: Partial<Record<CreativeTask, string[]>> = {
    blueprint: ['输入兼容', '第一步'],
    outline: ['第一步', '第二步'],
    storyboard: ['第三步', '第四步', '叙事目的分析法', '镜头设计逻辑', '分镜 Double Check'],
    image: ['叙事目的分析法', '镜头设计逻辑'],
    video: ['镜头设计逻辑'],
    voice: ['叙事目的分析法'],
    music: ['叙事目的分析法'],
    review: ['分镜 Double Check', '叙事目的分析法'],
    assistant: ['五步工作流', '叙事目的分析法', '镜头设计逻辑'],
    delivery: ['第五步']
  }
  const table = master === 'writing' ? writing : directing
  const wanted = [...common, ...(table[task] ?? [])]
  if (task === 'outline' && kind === 'novel') wanted.push('记忆检查点（长篇）')
  return wanted
}

function sectionMatches(title: string, wanted: string[]): boolean {
  return wanted.some((item) => title.includes(item))
}

function trimAtBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text
  const slice = text.slice(0, Math.max(0, limit))
  const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'))
  return `${slice.slice(0, cut > limit * 0.6 ? cut : slice.length).trimEnd()}\n\n（本节方法论文本按模型上下文预算截断；其余步骤仍按主文件执行。）`
}

function composeSkill(master: CreativeMaster, task: CreativeTask, kind: StudioKind): { text: string; sections: string[] } {
  const skill = embeddedBundle().masters[master].skill
  if (master === 'screenwriting') {
    return { text: skill, sections: ['编剧大师（单文件）'] }
  }
  const parsed = splitSkill(skill)
  const wanted = pickSections(master, task, kind)
  const picked = parsed.sections.filter((section) => sectionMatches(section.title, wanted) && (section.body.trim() || section.title.includes('铁律')))
  const text = [parsed.preamble.trim(), ...picked.map((section) => `## ${section.title}\n${section.body.trim()}`)].join('\n\n')
  return { text, sections: picked.map((section) => section.title) }
}

function methodologyFor(master: CreativeMaster, task: CreativeTask, kind: StudioKind): string[] {
  if (master === 'screenwriting') return []
  if (master === 'writing') {
    const table: Partial<Record<CreativeTask, string[]>> = {
      blueprint: ['story-structure.md', 'character-design.md'],
      outline: kind === 'novel' ? ['story-structure.md', 'longform-serialization.md'] : ['story-structure.md', 'scene-dialogue.md'],
      chapter: ['scene-dialogue.md', 'prose-craft.md'],
      rewrite: ['prose-craft.md', 'style-deconstruction.md'],
      review: ['character-design.md', 'prose-craft.md'],
      assistant: ['prose-craft.md'],
      adaptation: ['story-structure.md']
    }
    return table[task] ?? []
  }
  const table: Partial<Record<CreativeTask, string[]>> = {
    blueprint: ['core-methodology.md'],
    outline: ['core-methodology.md', 'storyboard-format.md'],
    storyboard: ['shot-design.md', 'storyboard-format.md'],
    image: ['shot-design.md'],
    video: ['shot-design.md'],
    voice: ['core-methodology.md'],
    music: ['core-methodology.md'],
    review: ['core-methodology.md', 'shot-design.md'],
    assistant: ['core-methodology.md'],
    delivery: ['core-methodology.md']
  }
  return table[task] ?? []
}

function composeMethodology(master: CreativeMaster, task: CreativeTask, kind: StudioKind, limit: number): { text: string; files: string[] } {
  if (limit <= 0) return { text: '', files: [] }
  const methodology = embeddedBundle().masters[master].methodology
  const chunks: string[] = []
  const files: string[] = []
  let used = 0
  for (const file of methodologyFor(master, task, kind)) {
    const raw = methodology[file]
    if (!raw) continue
    const remaining = limit - used
    if (remaining <= 400) break
    const body = trimAtBoundary(raw, remaining)
    chunks.push(`## 方法论 · ${file.replace(/\.md$/, '')}\n${body}`)
    files.push(file)
    used += body.length
  }
  return { text: chunks.join('\n\n'), files }
}

/** 按作品形态、任务和当前视图选择唯一一套大师方法；同一时刻只加载一套，避免互相打架。 */
export function selectCreativeMaster(input: CreativeMasterInput): CreativeMaster {
  if (input.task === 'adaptation' || input.task === 'screenplay') return 'screenwriting'
  if (input.task === 'storyboard' || input.task === 'image' || input.task === 'video' || input.task === 'music' || input.task === 'voice') return 'directing'
  if (input.kind === 'drama') {
    const view = input.view ?? ''
    if (input.task === 'blueprint' || input.task === 'outline' || view === 'blueprint' || view === 'outline') return 'screenwriting'
    return 'directing'
  }
  return 'writing'
}

const OUTPUT_FOOTER = '【输出契约】严格按本次调用方给出的 JSON/正文格式输出；不要输出方法步骤、自检过程、定调单或等待确认的话。'

function masterHeader(master: CreativeMaster, input: CreativeMasterInput): string {
  return [
    `【底层创作方法：${MASTER_LABEL[master]}】`,
    '下面是本次任务唯一采用的创作方法。按它判断和写作，不要把方法原文复述给用户。',
    '本次是 Morrow 创作台的一次性生成任务：按方法完成当前这一步后直接输出要求的 JSON 或正文，不要暂停等待用户确认，不要展示步骤，不要复述方法。',
    `本次任务：${input.task}；作品形态：${input.kind}${input.view ? `；当前页面：${input.view}` : ''}。`
  ].join('\n')
}

/** 交给模型的底层创作方法；只由编译进主进程的三套大师文件组成，不依赖任何外部 prompt 文件。 */
export function creativeMasterPrompt(input: CreativeMasterInput): string {
  const master = selectCreativeMaster(input)
  const header = masterHeader(master, input)
  const totalBudget = Math.max(4000, Math.min(60_000, input.budgetChars ?? 22_000))
  const budget = Math.max(1000, totalBudget - header.length - OUTPUT_FOOTER.length)
  const skill = composeSkill(master, input.task, input.kind)
  const skillText = trimAtBoundary(skill.text, Math.max(1200, Math.floor(budget * 0.7)))
  const methodology = composeMethodology(master, input.task, input.kind, Math.max(0, budget - skillText.length - 240))
  return [header, skillText, methodology.text, OUTPUT_FOOTER].filter(Boolean).join('\n\n')
}

export function creativeMasterSelection(input: CreativeMasterInput): CreativeMasterSelection {
  const master = selectCreativeMaster(input)
  const header = masterHeader(master, input)
  const totalBudget = Math.max(4000, Math.min(60_000, input.budgetChars ?? 22_000))
  const budget = Math.max(1000, totalBudget - header.length - OUTPUT_FOOTER.length)
  const skill = composeSkill(master, input.task, input.kind)
  const skillText = trimAtBoundary(skill.text, Math.max(1200, Math.floor(budget * 0.7)))
  const methodology = composeMethodology(master, input.task, input.kind, Math.max(0, budget - skillText.length - 240))
  return {
    master,
    label: MASTER_LABEL[master],
    root: 'embedded',
    skillSections: skill.sections,
    methodology: methodology.files,
    chars: header.length + skillText.length + methodology.text.length + OUTPUT_FOOTER.length
  }
}

/** 测试或诊断用：丢弃已解压的内嵌提示词，下一次调用重新加载。 */
export function resetCreativeMasterCache(): void {
  bundle = null
}
