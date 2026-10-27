/**
 * 创作台作品仓库：作品文件唯一读写入口。
 *
 * - 每个作品一个目录，project.json 原子写入（临时文件 + rename）；
 * - 素材按 SHA-256 去重，实际文件永不覆盖；
 * - 大改前留版本快照，版本可回退；
 * - 任务先写盘再执行，jobs.jsonl 追加记录；
 * - 渲染层只拿短期预览令牌，不接触真实文件路径。
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  StudioAsset,
  StudioChapter,
  StudioDelivery,
  StudioJob,
  StudioKind,
  StudioProject,
  StudioProjectSummary,
  StudioStageId,
  StudioTimeline,
  StudioTrack
} from '../../shared/studio'
import {
  STUDIO_SCHEMA_VERSION,
  computeProjectProgress,
  countWords,
  defaultStageStatuses,
  emptyStageStates,
  emptyCanvas,
  emptyTimeline,
  projectWordCount,
  timelineDuration
} from '../../shared/studio'
import { resolveDataDir, resolveStudioDataRoot } from '../services/paths'
import { createPreviewUrl } from '../services/file-preview'

const PROJECT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{3,63}$/
const MAX_PROJECT_BYTES = 64 * 1024 * 1024
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024
const MAX_VERSIONS = 60
const MAX_JOBS = 120
const CHUNK_THRESHOLD = 18_000
const CHUNK_SIZE = 12_000

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv'])
const AUDIO_EXT = new Set(['wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac'])

export function studioId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 18)}`
}

export function nowMs(): number {
  return Date.now()
}

export function safeProjectId(id: unknown): string {
  const value = typeof id === 'string' ? id.trim() : ''
  if (!PROJECT_ID_RE.test(value)) throw new Error('作品 id 不合法。')
  return value
}

export function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'avif':
      return 'image/avif'
    case 'svg':
      return 'image/svg+xml'
    case 'mp4':
      return 'video/mp4'
    case 'webm':
      return 'video/webm'
    case 'mov':
      return 'video/quicktime'
    case 'mkv':
      return 'video/x-matroska'
    case 'wav':
      return 'audio/wav'
    case 'mp3':
      return 'audio/mpeg'
    case 'm4a':
      return 'audio/mp4'
    case 'flac':
      return 'audio/flac'
    case 'ogg':
      return 'audio/ogg'
    case 'aac':
      return 'audio/aac'
    case 'srt':
      return 'application/x-subrip'
    case 'ass':
      return 'text/x-ssa'
    case 'epub':
      return 'application/epub+zip'
    case 'pdf':
      return 'application/pdf'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'txt':
      return 'text/plain;charset=utf-8'
    case 'md':
      return 'text/markdown;charset=utf-8'
    case 'json':
      return 'application/json;charset=utf-8'
    case 'zip':
      return 'application/zip'
    default:
      return 'application/octet-stream'
  }
}

export function assetKindForExt(ext: string): StudioAsset['kind'] {
  const value = ext.toLowerCase()
  if (IMAGE_EXT.has(value)) return 'image'
  if (VIDEO_EXT.has(value)) return 'video'
  if (AUDIO_EXT.has(value)) return 'audio'
  return 'other'
}

/** 从 PNG/JPEG/WebP 文件头读尺寸；失败返回 null，不阻断素材入库。 */
export function imageSize(buffer: Buffer): { width: number; height: number } | null {
  try {
    if (buffer.length > 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) break
        const marker = buffer[offset + 1]
        const length = buffer.readUInt16BE(offset + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
        }
        offset += 2 + length
      }
    }
    if (buffer.length > 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buffer.toString('ascii', 12, 16)
      if (chunk === 'VP8X') {
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3)
        }
      }
      if (chunk === 'VP8 ') {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
      }
      if (chunk === 'VP8L') {
        const bits = buffer.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
    }
  } catch {
    // 尺寸读取失败不阻断
  }
  return null
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sha256File(path: string): string {
  return sha256Buffer(readFileSync(path))
}

function atomicWrite(path: string, content: string | Buffer): void {
  const temp = `${path}.tmp-${randomUUID()}`
  writeFileSync(temp, content)
  renameSync(temp, path)
}

function safeRelative(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('路径越过了作品目录。')
  return rel.replace(/\\/g, '/')
}

export class StudioStore {
  readonly dataDir: string
  readonly studioRoot: string

  constructor(dataDir?: string, studioRoot?: string) {
    const resolvedDataDir = dataDir ?? resolveDataDir()
    this.dataDir = resolvedDataDir
    this.studioRoot = studioRoot ?? (dataDir ? join(resolvedDataDir, 'studio') : resolveStudioDataRoot(resolvedDataDir))
    this.ensureRoot()
  }

  get root(): string {
    return this.studioRoot
  }

  get projectsRoot(): string {
    return join(this.root, 'projects')
  }

  get importsRoot(): string {
    return join(this.root, 'imports')
  }

  get indexFile(): string {
    return join(this.root, 'studio-index.json')
  }

  ensureRoot(): void {
    mkdirSync(this.projectsRoot, { recursive: true })
    mkdirSync(this.importsRoot, { recursive: true })
  }

  projectDir(id: string): string {
    return join(this.projectsRoot, safeProjectId(id))
  }

  projectFile(id: string): string {
    return join(this.projectDir(id), 'project.json')
  }

  assetsDir(id: string): string {
    return join(this.projectDir(id), 'assets')
  }

  versionsDir(id: string): string {
    return join(this.projectDir(id), 'versions')
  }

  exportsDir(id: string): string {
    return join(this.projectDir(id), 'exports')
  }

  tempDir(id: string): string {
    return join(this.projectDir(id), 'tmp')
  }

  chunksDir(id: string): string {
    return join(this.projectDir(id), 'chunks')
  }

  projectExists(id: string): boolean {
    return existsSync(this.projectFile(id))
  }

  newProject(input: {
    kind: StudioKind
    title: string
    logline: string
    brief?: Partial<StudioProject['brief']>
    runtime?: Partial<StudioProject['runtime']>
    demo?: boolean
  }): StudioProject {
    const now = nowMs()
    const aspect = input.brief?.aspect ?? '16:9'
    const project: StudioProject = {
      schemaVersion: STUDIO_SCHEMA_VERSION,
      id: studioId('proj'),
      kind: input.kind,
      title: input.title.trim() || '未命名作品',
      logline: input.logline.trim(),
      brief: {
        form: input.brief?.form ?? '速成草稿',
        genre: input.brief?.genre ?? '都市奇幻',
        audience: input.brief?.audience ?? '喜欢故事的普通读者',
        tone: input.brief?.tone ?? '克制、温柔',
        style: input.brief?.style ?? '',
        aspect,
        constraints: Array.isArray(input.brief?.constraints) ? [...input.brief.constraints].slice(0, 20) : [],
        references: Array.isArray(input.brief?.references) ? [...input.brief.references].slice(0, 20) : [],
        ...(input.brief?.targetWords ? { targetWords: Math.round(input.brief.targetWords) } : {}),
        ...(input.brief?.targetSeconds ? { targetSeconds: Math.round(input.brief.targetSeconds) } : {})
      },
      createdAt: now,
      updatedAt: now,
      revision: 0,
      stage: 'blueprint',
      stages: emptyStageStates(now),
      styleBible: {
        look: '',
        palette: [],
        camera: '',
        sound: '',
        negative: []
      },
      blueprint: null,
      volumes: [],
      chapters: [],
      episodes: [],
      scenes: [],
      shots: [],
      characters: [],
      places: [],
      factions: [],
      rules: [],
      props: [],
      facts: [],
      assets: [],
      timeline: emptyTimeline(aspect, now),
      deliveries: [],
      jobs: [],
      messages: [],
      checks: [],
      canvas: emptyCanvas(now),
      runtime: {
        strategy: input.runtime?.strategy ?? 'local-first',
        budget: input.runtime?.budget ?? { limit: 30, spent: 0, currency: 'CNY' },
        updatedAt: now
      },
      coverAssetId: null,
      demo: input.demo === true
    }
    this.ensureProjectDirs(project.id)
    this.save(project, '创建作品', { snapshot: false })
    return project
  }

  ensureProjectDirs(id: string): void {
    for (const dir of [this.projectDir(id), this.assetsDir(id), this.versionsDir(id), this.exportsDir(id), this.tempDir(id)]) {
      mkdirSync(dir, { recursive: true })
    }
  }

  normalizeProject(raw: StudioProject): StudioProject {
    const now = nowMs()
    const project: StudioProject = {
      ...raw,
      schemaVersion: STUDIO_SCHEMA_VERSION,
      brief: {
        form: raw.brief?.form ?? '速成草稿',
        genre: raw.brief?.genre ?? '都市奇幻',
        audience: raw.brief?.audience ?? '',
        tone: raw.brief?.tone ?? '',
        style: raw.brief?.style ?? '',
        aspect: raw.brief?.aspect ?? '16:9',
        constraints: Array.isArray(raw.brief?.constraints) ? raw.brief.constraints : [],
        references: Array.isArray(raw.brief?.references) ? raw.brief.references : []
      },
      stages: { ...emptyStageStates(now), ...(raw.stages ?? {}) },
      volumes: Array.isArray(raw.volumes) ? raw.volumes : [],
      chapters: Array.isArray(raw.chapters) ? raw.chapters : [],
      episodes: Array.isArray(raw.episodes) ? raw.episodes : [],
      scenes: Array.isArray(raw.scenes) ? raw.scenes : [],
      shots: Array.isArray(raw.shots) ? raw.shots : [],
      characters: Array.isArray(raw.characters) ? raw.characters : [],
      places: Array.isArray(raw.places) ? raw.places : [],
      factions: Array.isArray(raw.factions) ? raw.factions : [],
      rules: Array.isArray(raw.rules) ? raw.rules : [],
      props: Array.isArray(raw.props) ? raw.props : [],
      facts: Array.isArray(raw.facts) ? raw.facts : [],
      assets: Array.isArray(raw.assets) ? raw.assets : [],
      timeline: raw.timeline ?? emptyTimeline(raw.brief?.aspect, now),
      deliveries: Array.isArray(raw.deliveries) ? raw.deliveries : [],
      jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      checks: Array.isArray(raw.checks) ? raw.checks : [],
      canvas: raw.canvas
        ? {
            version: 1,
            initialized: raw.canvas.initialized === true,
            nodes: Array.isArray(raw.canvas.nodes) ? raw.canvas.nodes : [],
            connections: Array.isArray(raw.canvas.connections) ? raw.canvas.connections : [],
            groups: Array.isArray(raw.canvas.groups) ? raw.canvas.groups : [],
            viewport: { x: Number(raw.canvas.viewport?.x) || 96, y: Number(raw.canvas.viewport?.y) || 72, zoom: Number(raw.canvas.viewport?.zoom) || 0.8 },
            updatedAt: Number(raw.canvas.updatedAt) || now
          }
        : emptyCanvas(now),
      runtime: raw.runtime ?? {
        strategy: 'local-first',
        budget: { limit: 30, spent: 0, currency: 'CNY' },
        updatedAt: now
      },
      styleBible: raw.styleBible ?? { look: '', palette: [], camera: '', sound: '', negative: [] },
      demo: raw.demo === true
    }
    for (const chapter of project.chapters) {
      chapter.candidates = Array.isArray(chapter.candidates) ? chapter.candidates : []
      chapter.versions = Array.isArray(chapter.versions) ? chapter.versions : []
      chapter.illustrations = Array.isArray(chapter.illustrations) ? chapter.illustrations : []
      chapter.beats = Array.isArray(chapter.beats) ? chapter.beats : []
      chapter.wordTarget = Number.isFinite(chapter.wordTarget) ? chapter.wordTarget : 2500
      chapter.locked = chapter.locked === true || chapter.content.trim().length > 0
    }
    for (const shot of project.shots) {
      shot.imageCandidates = Array.isArray(shot.imageCandidates) ? shot.imageCandidates : []
      shot.videoCandidates = Array.isArray(shot.videoCandidates) ? shot.videoCandidates : []
      for (const key of ['referenceCharacterIds', 'referencePlaceIds', 'referencePropIds'] as const) {
        if (!Array.isArray(shot[key])) shot[key] = []
      }
    }
    project.timeline.tracks = Array.isArray(project.timeline.tracks) ? project.timeline.tracks : []
    project.timeline.clips = Array.isArray(project.timeline.clips) ? project.timeline.clips : []
    project.timeline.snapshots = Array.isArray(project.timeline.snapshots) ? project.timeline.snapshots : []
    return project
  }

  readProject(id: string): StudioProject {
    const file = this.projectFile(id)
    if (!existsSync(file)) throw new Error('作品不存在，可能已被移动或删除。')
    const size = statSync(file).size
    if (size <= 0 || size > MAX_PROJECT_BYTES) throw new Error('作品文件大小异常，已拒绝打开。')
    let parsed: StudioProject
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as StudioProject
    } catch {
      const backup = this.latestVersionFile(id)
      if (backup) {
        parsed = JSON.parse(readFileSync(backup, 'utf8')) as StudioProject
        this.save(parsed, '从最近版本恢复损坏的作品文件', { snapshot: false })
        return this.normalizeProject(parsed)
      }
      throw new Error('作品文件已损坏，且没有可用的历史版本。')
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.id) throw new Error('作品文件格式不正确。')
    this.hydrateChapters(id, parsed)
    return this.normalizeProject(parsed)
  }

  /** 超长章节按固定字符数分片；短章节仍内联在 project.json。 */
  private syncChapterChunks(projectId: string, chapter: StudioChapter): void {
    const safeId = chapter.id.replace(/[^a-zA-Z0-9_-]/g, '')
    if (!safeId) return
    const dir = join(this.chunksDir(projectId), safeId)
    if (chapter.content.length < CHUNK_THRESHOLD) {
      if (chapter.contentRef) {
        rmSync(dir, { recursive: true, force: true })
        delete chapter.contentRef
      }
      return
    }
    const hash = createHash('sha256').update(chapter.content).digest('hex')
    if (chapter.contentRef?.hash === hash && existsSync(dir)) return
    mkdirSync(dir, { recursive: true })
    const chunks = Math.ceil(chapter.content.length / CHUNK_SIZE)
    for (let index = 0; index < chunks; index += 1) {
      const part = chapter.content.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
      writeFileSync(join(dir, `part-${String(index + 1).padStart(4, '0')}.txt`), part, 'utf8')
    }
    for (const name of readdirSync(dir)) {
      const match = /^part-(\d+)\.txt$/.exec(name)
      if (!match || Number(match[1]) > chunks) rmSync(join(dir, name), { force: true })
    }
    chapter.contentRef = {
      path: `chunks/${safeId}`,
      chunkSize: CHUNK_SIZE,
      chunks,
      hash
    }
  }

  private hydrateChapters(projectId: string, project: StudioProject): void {
    if (!Array.isArray(project.chapters)) return
    for (const chapter of project.chapters) {
      if (!chapter.contentRef?.path) continue
      const safeId = chapter.id.replace(/[^a-zA-Z0-9_-]/g, '')
      const dir = join(this.chunksDir(projectId), safeId)
      if (!existsSync(dir)) {
        if (chapter.content?.trim()) continue
        throw new Error(`章节「${chapter.title}」的分片文件丢失，请从版本历史恢复。`)
      }
      const files = readdirSync(dir).filter((name) => /^part-\d+\.txt$/.test(name)).sort()
      if (!files.length) {
        if (chapter.content?.trim()) continue
        throw new Error(`章节「${chapter.title}」的分片为空，请从版本历史恢复。`)
      }
      chapter.content = files.map((name) => readFileSync(join(dir, name), 'utf8')).join('')
    }
  }

  private serializedProject(project: StudioProject): StudioProject {
    return {
      ...project,
      chapters: project.chapters.map((chapter) => chapter.contentRef
        ? { ...chapter, content: '' }
        : chapter)
    }
  }

  private pruneChunks(projectId: string, project: StudioProject): void {
    const dir = this.chunksDir(projectId)
    if (!existsSync(dir)) return
    const ids = new Set(project.chapters.filter((chapter) => chapter.contentRef).map((chapter) => chapter.id.replace(/[^a-zA-Z0-9_-]/g, '')))
    for (const name of readdirSync(dir)) {
      if (!ids.has(name)) rmSync(join(dir, name), { recursive: true, force: true })
    }
  }

  /** 保存并递增 revision；关键动作额外留版本快照。 */
  save(project: StudioProject, reason: string, options: { snapshot?: boolean; bump?: boolean } = {}): StudioProject {
    this.ensureProjectDirs(project.id)
    const now = nowMs()
    project.updatedAt = now
    if (options.bump !== false) project.revision += 1
    project.stages = { ...project.stages, ...defaultStageStatuses(project) }
    project.timeline.durationSec = timelineDuration(project.timeline)
    for (const chapter of project.chapters) this.syncChapterChunks(project.id, chapter)
    if (options.snapshot) this.writeVersion(project, reason)
    this.pruneChunks(project.id, project)
    atomicWrite(this.projectFile(project.id), `${JSON.stringify(this.serializedProject(project), null, 2)}\n`)
    this.writeIndex(project)
    return project
  }

  /** 不递增 revision 的内部更新（例如渲染层短暂保存，不用于用户修改）。 */
  savePassive(project: StudioProject): void {
    project.updatedAt = nowMs()
    for (const chapter of project.chapters) this.syncChapterChunks(project.id, chapter)
    this.pruneChunks(project.id, project)
    atomicWrite(this.projectFile(project.id), `${JSON.stringify(this.serializedProject(project), null, 2)}\n`)
    this.writeIndex(project)
  }

  writeVersion(project: StudioProject, reason: string): string {
    const dir = this.versionsDir(project.id)
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const file = join(dir, `${String(project.revision + 1).padStart(6, '0')}-${stamp}-${studioId('v').slice(2, 8)}.json`)
    atomicWrite(file, `${JSON.stringify(project, null, 2)}\n`)
    try {
      writeFileSync(join(dir, 'index.jsonl'), `${JSON.stringify({ file: basename(file), reason, at: nowMs(), revision: project.revision })}\n`, { flag: 'a' })
    } catch {
      // 版本索引失败不影响快照本身
    }
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
    for (const old of files.slice(0, Math.max(0, files.length - MAX_VERSIONS))) {
      try {
        rmSync(join(dir, old), { force: true })
      } catch {
        // 清理旧版本失败不阻断保存
      }
    }
    return file
  }

  latestVersionFile(id: string): string | null {
    const dir = this.versionsDir(id)
    if (!existsSync(dir)) return null
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
    return files.length ? join(dir, files[files.length - 1]) : null
  }

  listVersionFiles(id: string): Array<{ file: string; name: string; createdAt: number; reason: string; revision: number }> {
    const dir = this.versionsDir(id)
    if (!existsSync(dir)) return []
    const index = new Map<string, { reason: string; at: number; revision: number }>()
    try {
      for (const line of readFileSync(join(dir, 'index.jsonl'), 'utf8').split(String.fromCharCode(10))) {
        if (!line.trim()) continue
        const entry = JSON.parse(line) as { file?: string; reason?: string; at?: number; revision?: number }
        if (entry.file) index.set(entry.file, { reason: entry.reason ?? '历史版本', at: entry.at ?? 0, revision: entry.revision ?? 0 })
      }
    } catch {
      // 旧版本没有索引时从文件恢复元信息
    }
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
      .map((name) => {
        const file = join(dir, name)
        const meta = index.get(name)
        return {
          file,
          name,
          createdAt: meta?.at || statSync(file).mtimeMs,
          reason: meta?.reason ?? '历史版本',
          revision: meta?.revision ?? 0
        }
      })
  }

  /** 恢复项目级历史版本：恢复前先留档，保留当前任务与交付记录。 */
  restoreProjectVersion(id: string, name: string): StudioProject {
    const safeName = basename(name)
    if (safeName !== name || !name.endsWith('.json')) throw new Error('版本文件名不合法。')
    const current = this.readProject(id)
    this.writeVersion(current, '恢复历史版本前自动留档')
    const file = join(this.versionsDir(id), safeName)
    if (!existsSync(file)) throw new Error('这个历史版本不存在。')
    let parsed: StudioProject
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as StudioProject
    } catch {
      throw new Error('历史版本文件已损坏。')
    }
    if (!parsed || parsed.id !== current.id) throw new Error('历史版本不属于这个作品。')
    const restored = this.normalizeProject(parsed)
    const mergeById = <T extends { id: string }>(left: T[], right: T[]): T[] => {
      const seen = new Set(left.map((item) => item.id))
      return [...left, ...right.filter((item) => !seen.has(item.id))]
    }
    restored.assets = mergeById(current.assets, restored.assets)
    restored.jobs = mergeById(current.jobs, restored.jobs)
    restored.deliveries = mergeById(current.deliveries, restored.deliveries)
    restored.revision = current.revision + 1
    restored.updatedAt = nowMs()
    this.save(restored, `恢复版本：${safeName}`, { snapshot: false, bump: false })
    return restored
  }

  deleteProject(id: string): void {
    const dir = this.projectDir(id)
    if (!existsSync(dir)) return
    // 不直接 rm -rf 用户作品：先移到回收目录，保留可撤回。
    const trash = join(this.root, 'trash')
    mkdirSync(trash, { recursive: true })
    renameSync(dir, join(trash, `${safeProjectId(id)}-${Date.now()}`))
    this.removeFromIndex(id)
  }

  duplicateProject(id: string): StudioProject {
    const source = this.readProject(id)
    const copy = JSON.parse(JSON.stringify(source)) as StudioProject
    copy.id = studioId('proj')
    copy.title = `${source.title} · 副本`
    copy.createdAt = nowMs()
    copy.updatedAt = copy.createdAt
    copy.revision = 0
    copy.demo = false
    copy.deliveries = []
    copy.jobs = []
    this.ensureProjectDirs(copy.id)
    for (const asset of copy.assets) {
      const from = this.assetAbsolute(source, asset)
      const to = join(this.assetsDir(copy.id), basename(asset.path))
      if (existsSync(from)) {
        mkdirSync(this.assetsDir(copy.id), { recursive: true })
        copyFileSync(from, to)
      }
    }
    this.save(copy, '复制作品', { snapshot: false })
    return copy
  }

  assetAbsolute(project: Pick<StudioProject, 'id'>, asset: Pick<StudioAsset, 'path'>): string {
    const file = resolve(this.projectDir(project.id), asset.path)
    safeRelative(this.projectDir(project.id), file)
    return file
  }

  deliveryAbsolute(projectId: string, delivery: Pick<StudioDelivery, 'path'>): string {
    const file = resolve(this.projectDir(projectId), delivery.path)
    safeRelative(this.projectDir(projectId), file)
    return file
  }

  /** 素材文件指纹入库；同内容只存一份。支持传入现成 bytes 或文件路径。 */
  addAsset(
    project: StudioProject,
    input: {
      filePath?: string
      bytes?: Buffer
      title: string
      mime?: string
      kindHint?: StudioAsset['kind']
      tags?: string[]
      origin?: StudioAsset['origin']
      metadata?: { width?: number; height?: number; durationSec?: number }
      thumbBytes?: Buffer
    }
  ): StudioAsset {
    this.ensureProjectDirs(project.id)
    const ext = input.filePath ? extname(input.filePath).slice(1).toLowerCase() : (input.mime?.split('/')[1] ?? 'bin')
    const bytes = input.bytes ?? (input.filePath ? readFileSync(input.filePath) : null)
    if (!bytes) throw new Error('素材内容为空。')
    if (bytes.length === 0) throw new Error('素材文件是空的。')
    if (bytes.length > MAX_ASSET_BYTES) throw new Error('素材超过 2GB，已拒绝导入。')
    const sha = sha256Buffer(bytes)
    const existing = project.assets.find((asset) => asset.sha256 === sha)
    if (existing) return existing
    const mime = input.mime ?? mimeForExt(ext)
    const kind = input.kindHint ?? assetKindForExt(ext)
    const safeExt = ext.replace(/[^a-z0-9]/g, '') || 'bin'
    const rel = `assets/${sha}.${safeExt}`
    const absolute = join(this.projectDir(project.id), rel)
    mkdirSync(this.assetsDir(project.id), { recursive: true })
    if (input.filePath && resolve(input.filePath) !== resolve(absolute)) copyFileSync(input.filePath, absolute)
    else if (!input.filePath) writeFileSync(absolute, bytes)
    const dimensions = kind === 'image' ? imageSize(bytes) : null
    const assetId = studioId('asset')
    let thumbPath: string | undefined
    if (input.thumbBytes && input.thumbBytes.length > 0) {
      const thumbRel = `assets/${sha}-thumb.jpg`
      const thumbAbs = join(this.projectDir(project.id), thumbRel)
      writeFileSync(thumbAbs, input.thumbBytes)
      thumbPath = thumbRel
    }
    const asset: StudioAsset = {
      id: assetId,
      kind,
      mime,
      bytes: bytes.length,
      sha256: sha,
      path: rel,
      ...(thumbPath ? { thumbPath } : {}),
      title: input.title.trim() || '未命名素材',
      ...(input.metadata?.width ?? dimensions?.width ? { width: input.metadata?.width ?? dimensions?.width } : {}),
      ...(input.metadata?.height ?? dimensions?.height ? { height: input.metadata?.height ?? dimensions?.height } : {}),
      ...(input.metadata?.durationSec ? { durationSec: input.metadata.durationSec } : {}),
      tags: input.tags ? [...new Set(input.tags)] : [],
      ...(input.origin ? { origin: input.origin } : {}),
      createdAt: nowMs()
    }
    project.assets.push(asset)
    return asset
  }

  /** 为一个作品生成带令牌的素材地址；令牌只在本进程内存里映射到真实路径。 */
  decorateAsset(project: StudioProject, asset: StudioAsset): StudioAsset {
    const copy = { ...asset }
    try {
      const absolute = this.assetAbsolute(project, asset)
      if (existsSync(absolute)) copy.url = createPreviewUrl(this.projectDir(project.id), absolute, asset.mime)
      if (asset.thumbPath) {
        const thumb = resolve(this.projectDir(project.id), asset.thumbPath)
        safeRelative(this.projectDir(project.id), thumb)
        if (existsSync(thumb)) copy.thumbUrl = createPreviewUrl(this.projectDir(project.id), thumb, 'image/jpeg')
      }
    } catch {
      // 素材丢失时保留记录，界面显示缺失
    }
    return copy
  }

  decorateProject(project: StudioProject): StudioProject {
    const clone = JSON.parse(JSON.stringify(project)) as StudioProject
    clone.assets = clone.assets.map((asset) => this.decorateAsset(project, asset))
    clone.deliveries = clone.deliveries.map((delivery) => {
      const copy = { ...delivery }
      try {
        const absolute = this.deliveryAbsolute(project.id, delivery)
        if (existsSync(absolute)) copy.url = createPreviewUrl(this.projectDir(project.id), absolute, mimeForExt(extname(delivery.path).slice(1)))
      } catch {
        // 交付物被移动时保留记录
      }
      return copy
    })
    return clone
  }

  deliverableUrl(projectId: string, relativePath: string, mime: string): string | undefined {
    const absolute = resolve(this.projectDir(projectId), relativePath)
    try {
      safeRelative(this.projectDir(projectId), absolute)
    } catch {
      return undefined
    }
    return existsSync(absolute) ? createPreviewUrl(this.projectDir(projectId), absolute, mime) : undefined
  }

  summaries(): StudioProjectSummary[] {
    if (!existsSync(this.projectsRoot)) return []
    const result: StudioProjectSummary[] = []
    for (const name of readdirSync(this.projectsRoot)) {
      if (!PROJECT_ID_RE.test(name)) continue
      try {
        const project = this.readProject(name)
        result.push(this.summarize(project))
      } catch {
        // 损坏作品不阻断作品库；界面会提供修复入口
      }
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  summarize(project: StudioProject): StudioProjectSummary {
    const cover = project.coverAssetId ? project.assets.find((asset) => asset.id === project.coverAssetId) : undefined
    const decorated = cover ? this.decorateAsset(project, cover) : undefined
    return {
      id: project.id,
      kind: project.kind,
      title: project.title,
      logline: project.logline,
      updatedAt: project.updatedAt,
      createdAt: project.createdAt,
      stage: project.stage,
      progress: computeProjectProgress(project),
      words: projectWordCount(project),
      chapters: project.chapters.length,
      shots: project.shots.length,
      assets: project.assets.length,
      budget: { ...project.runtime.budget },
      ...(decorated?.thumbUrl || decorated?.url ? { coverUrl: decorated.thumbUrl ?? decorated.url } : {}),
      demo: project.demo,
      ...(project.kind === 'drama'
        ? { missingVisuals: project.shots.filter((shot) => !shot.imageAssetId && !shot.videoAssetId).length }
        : {})
    }
  }

  appendJobLog(projectId: string, job: StudioJob): void {
    try {
      const file = join(this.projectDir(projectId), 'jobs.jsonl')
      mkdirSync(this.projectDir(projectId), { recursive: true })
      writeFileSync(file, `${JSON.stringify(job)}\n`, { flag: 'a' })
    } catch {
      // 日志失败不阻断任务
    }
  }

  trimJobs(project: StudioProject): void {
    if (project.jobs.length > MAX_JOBS) project.jobs = project.jobs.slice(-MAX_JOBS)
  }

  readIndex(): Array<{ id: string; updatedAt: number }> {
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8')) as {
        projects?: Array<{ id?: string; updatedAt?: number }>
      }
      return (parsed.projects ?? [])
        .filter((item): item is { id: string; updatedAt: number } => typeof item.id === 'string' && typeof item.updatedAt === 'number')
    } catch {
      return []
    }
  }

  private writeIndex(project: StudioProject): void {
    const current = this.readIndex().filter((item) => item.id !== project.id)
    current.unshift({ id: project.id, updatedAt: project.updatedAt })
    try {
      atomicWrite(this.indexFile, `${JSON.stringify({ version: 1, projects: current.slice(0, 500) }, null, 2)}\n`)
    } catch {
      // 索引只是加速，不阻断保存
    }
  }

  private removeFromIndex(id: string): void {
    const current = this.readIndex().filter((item) => item.id !== id)
    try {
      atomicWrite(this.indexFile, `${JSON.stringify({ version: 1, projects: current }, null, 2)}\n`)
    } catch {
    }
  }

  /** 项目总占用（字节），供交付页与设置页展示。 */
  projectBytes(id: string): number {
    let total = 0
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const stat = statSync(path)
        if (stat.isDirectory()) walk(path)
        else total += stat.size
      }
    }
    walk(this.projectDir(id))
    return total
  }

  addChapter(project: StudioProject, input: { title?: string; volumeId?: string | null; synopsis?: string; wordTarget?: number; content?: string } = {}): StudioChapter {
    const number = project.chapters.reduce((max, chapter) => Math.max(max, chapter.number), 0) + 1
    const chapter: StudioChapter = {
      id: studioId('ch'),
      volumeId: input.volumeId ?? project.volumes[0]?.id ?? null,
      number,
      title: input.title?.trim() || `第 ${number} 章 · 未命名`,
      synopsis: input.synopsis ?? '',
      beats: [],
      content: input.content ?? '',
      wordTarget: input.wordTarget ?? 2500,
      status: input.content?.trim() ? 'done' : 'ready',
      revision: 1,
      candidates: [],
      versions: [],
      illustrations: [],
      locked: Boolean(input.content?.trim()),
      updatedAt: nowMs()
    }
    project.chapters.push(chapter)
    if (chapter.volumeId) {
      const volume = project.volumes.find((item) => item.id === chapter.volumeId)
      if (volume) volume.chapterIds.push(chapter.id)
    }
    return chapter
  }

  addChapterVersion(chapter: StudioChapter, content: string, reason: string): void {
    chapter.versions.unshift({
      id: studioId('cv'),
      content,
      createdAt: nowMs(),
      reason,
      wordCount: countWords(content)
    })
    chapter.versions = chapter.versions.slice(0, 30)
  }

  ensureDramaTimelineTracks(timeline: StudioTimeline): StudioTimeline {
    const required: Array<{ id: string; kind: StudioTrack['kind']; name: string; volume: number }> = [
      { id: 'track-video', kind: 'video', name: 'V1 画面', volume: 1 },
      { id: 'track-dialogue', kind: 'dialogue', name: 'A1 对白', volume: 1 },
      { id: 'track-music', kind: 'music', name: 'A2 音乐', volume: 0.55 },
      { id: 'track-sfx', kind: 'sfx', name: 'A3 音效', volume: 0.7 },
      { id: 'track-subtitle', kind: 'subtitle', name: 'S1 字幕', volume: 1 }
    ]
    for (const track of required) {
      if (!timeline.tracks.some((item) => item.id === track.id)) {
        timeline.tracks.push({ ...track, muted: false, locked: false })
      }
    }
    return timeline
  }

  stageId(value: unknown): StudioStageId {
    const allowed: StudioStageId[] = [
      'blueprint',
      'outline',
      'writing',
      'storyboard',
      'visuals',
      'voice',
      'music',
      'timeline',
      'review',
      'delivery'
    ]
    if (typeof value !== 'string' || !allowed.includes(value as StudioStageId)) {
      throw new Error('未知的创作阶段。')
    }
    return value as StudioStageId
  }
}

/** 延迟单例：必须在 app ready 后使用（resolveDataDir 依赖 Electron app）。 */
let store: StudioStore | null = null

export function getStudioStore(): StudioStore {
  if (!store) store = new StudioStore()
  return store
}

export function resetStudioStoreForTest(dir?: string): void {
  store = dir ? new StudioStore(dir) : null
}

/** 给渲染层返回的纯数据摘要（不包含真实路径）。 */
export function sanitizeProjectForRenderer(project: StudioProject): StudioProject {
  const clone = JSON.parse(JSON.stringify(project)) as StudioProject
  clone.jobs = clone.jobs.slice(-40)
  clone.messages = clone.messages.slice(-80)
  clone.timeline.snapshots = clone.timeline.snapshots.slice(-20)
  return clone
}
