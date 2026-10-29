// 创作台仓库、样例、渲染导出、音频、蓝图、助手与主服务。
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, dirname } from 'node:path'
import type { StudioAsset, StudioChapter, StudioDelivery, StudioJob, StudioKind, StudioProject, StudioProjectSummary, StudioStageId, StudioTimeline, StudioTrack, StudioTrashItem, StudioBlueprint, StudioBlueprintSceneSeed, StudioEngineStatus, StudioClip, StudioCheck, StudioVoice, StudioCharacter, StudioVoiceAudit, StudioVoiceProfile, StudioBlueprintUnit, StudioEpisode, StudioFact, StudioScene, StudioShot, StudioShotSeed, StudioStyleBible, StudioVolume, StudioChatMessage, StudioEditAction, StudioEditPlan, StudioMessageSource, StudioActionResult, StudioListResult, StudioCreateInput, StudioExportInput, StudioExportPreflight, StudioJobKind, StudioJobStatus, StudioRenderInput, StudioBlueprintPatch, StudioOutlinePatch, StudioChapterPatch, StudioShotPatch, StudioCharacterPatch, StudioPlacePatch, StudioRenameRequest } from '../shared/studio'
import { STUDIO_SCHEMA_VERSION, computeProjectProgress, countWords, defaultStageStatuses, emptyStageStates, emptyCanvas, emptyTimeline, projectWordCount, timelineDuration, formatDuration, isStudioVideoDelivery, studioKindLabel, canTransitionStudioStatus, resolveMusicAsset, isFormalMusicAsset } from '../shared/studio'
import { resolveDataDir, resolveStudioDataRoot, createPreviewUrl, studioDataDirInfo } from './workspace'
import fixtures from './studio-demo-fixtures.json'
import type { ChatMessage, ModelInfo, ProviderConfig, Settings, Usage } from '../shared/types'
import { previewBrief } from '../shared/types'
import { findModel, isLocalServiceUrl } from '../shared/contracts'
import { createProvider } from '../core/providers'
import { log } from './logger'
import { getSettingsStore } from './settings'
import { app, BrowserWindow } from 'electron'
import { spawnSync, spawn } from 'node:child_process'
import JSZip from 'jszip'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { getMediaService } from './media'
import { creativeMasterPrompt, type CreativeTask } from './creative-masters'
import { localTtsStatus, localTtsVoices, isLocalTtsVoice, QWEN_DEFAULT_VOICE, synthesizeLocalSpeech } from './tts-local'
import { sendFeatureEvent } from './feature-ipc'

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
      titleSource: 'auto',
      logline: input.logline.trim(),
      brief: {
        form: input.brief?.form ?? '速成草稿',
        genre: input.brief?.genre ?? '',
        audience: input.brief?.audience ?? '',
        tone: input.brief?.tone ?? '',
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
      musicAssetId: null,
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
      titleSource: raw.titleSource ?? 'auto',
      brief: {
        form: raw.brief?.form ?? '速成草稿',
        genre: raw.brief?.genre ?? '',
        audience: raw.brief?.audience ?? '',
        tone: raw.brief?.tone ?? '',
        style: raw.brief?.style ?? '',
        aspect: raw.brief?.aspect ?? '16:9',
        constraints: Array.isArray(raw.brief?.constraints) ? raw.brief.constraints : [],
        references: Array.isArray(raw.brief?.references) ? raw.brief.references : [],
        ...(raw.brief?.targetWords ? { targetWords: Math.round(raw.brief.targetWords) } : {}),
        ...(raw.brief?.targetSeconds ? { targetSeconds: Math.round(raw.brief.targetSeconds) } : {})
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
      musicAssetId: raw.musicAssetId ?? null,
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

  private trashDir(): string {
    return join(this.root, 'trash')
  }

  private trashEntryName(value: string): string {
    const entry = basename(value.trim())
    if (!/^[a-zA-Z0-9_-]+-\d{10,17}$/.test(entry)) throw new Error('回收站条目名称不合法。')
    return entry
  }

  listTrash(): StudioTrashItem[] {
    const dir = this.trashDir()
    if (!existsSync(dir)) return []
    const items: StudioTrashItem[] = []
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      const match = /-(\d{10,17})$/.exec(item.name)
      if (!match) continue
      const projectFile = join(dir, item.name, 'project.json')
      if (!existsSync(projectFile)) continue
      try {
        const raw = JSON.parse(readFileSync(projectFile, 'utf8')) as Partial<StudioProject>
        if (!raw.id) continue
        const chapters = Array.isArray(raw.chapters) ? raw.chapters : []
        const shots = Array.isArray(raw.shots) ? raw.shots : []
        items.push({
          entry: item.name,
          projectId: String(raw.id),
          title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : '未命名作品',
          kind: raw.kind === 'novel' || raw.kind === 'drama' ? raw.kind : 'short',
          deletedAt: Number(match[1]) || statSync(projectFile).mtimeMs,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : statSync(projectFile).mtimeMs,
          words: chapters.reduce((sum, chapter) => sum + countWords(typeof chapter.content === 'string' ? chapter.content : ''), 0),
          chapters: chapters.length,
          shots: shots.length
        })
      } catch {
        // 损坏的回收条目不影响其他条目展示；用户可手动打开回收目录处理。
      }
    }
    return items.sort((left, right) => right.deletedAt - left.deletedAt)
  }

  restoreTrash(entry: string): StudioProject {
    const name = this.trashEntryName(entry)
    const from = join(this.trashDir(), name)
    if (!existsSync(from)) throw new Error('这个回收站条目已经不存在。')
    const raw = JSON.parse(readFileSync(join(from, 'project.json'), 'utf8')) as Partial<StudioProject>
    const id = safeProjectId(String(raw.id ?? ''))
    if (this.projectExists(id)) throw new Error('作品库里已经有同 ID 的作品；请先处理那一份，再恢复这一份。')
    const target = this.projectDir(id)
    renameSync(from, target)
    const project = this.readProject(id)
    this.writeIndex(project)
    return project
  }

  purgeTrash(entry: string): void {
    const name = this.trashEntryName(entry)
    const target = join(this.trashDir(), name)
    if (!existsSync(target)) return
    rmSync(target, { recursive: true, force: true })
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

interface DemoFixtures {
  dramaBlueprint: StudioBlueprint
  dramaScenes: StudioBlueprintSceneSeed[]
  novelBlueprint: StudioBlueprint
  novelChapters: string[]
  novelCandidate: string
  shortBlueprint: StudioBlueprint
  shortChapters: string[]
}

const data = fixtures as unknown as DemoFixtures

function sampleCopy(blueprint: StudioBlueprint): StudioBlueprint {
  const copy = structuredClone(blueprint)
  copy.warnings = []
  copy.estimate = {
    ...copy.estimate,
    lines: copy.estimate.lines.map((line) => ({
      ...line,
      note: (line.note ?? '').replace(/^本机生成，不调用模型$/, '随包示例，不产生模型调用').replace(/^本机生成$/, '随包示例')
    })),
    note: '随包示例，不产生模型费用；之后的任务按实际用量记录。'
  }
  return copy
}

export function demoDramaBlueprint(): StudioBlueprint {
  const blueprint = sampleCopy(data.dramaBlueprint)
  blueprint.scenes = structuredClone(data.dramaScenes)
  return blueprint
}

export function demoNovelBlueprint(): StudioBlueprint {
  return sampleCopy(data.novelBlueprint)
}

export function demoShortBlueprint(): StudioBlueprint {
  return sampleCopy(data.shortBlueprint)
}

export function demoNovelChapters(): string[] {
  return [...data.novelChapters]
}

export function demoNovelCandidate(): string {
  return data.novelCandidate
}

export function demoShortChapters(): string[] {
  return [...data.shortChapters]
}

export type StudioTextStrategy = StudioProject['runtime']['strategy']

export interface StudioTextRouteInfo {
  providerId: string
  providerLabel: string
  modelId: string
  modelLabel: string
  local: boolean
  configured: boolean
  inputPerMTok?: number
  outputPerMTok?: number
}

export interface TextCandidate {
  config: ProviderConfig
  model: ModelInfo
  local: boolean
  apiKey: string | null
  default: boolean
}

const STRATEGY_LABEL: Record<StudioTextStrategy, string> = {
  'local-first': '本地优先',
  'cloud-first': '云端优先',
  'local-only': '只本地',
  'cloud-only': '只云端'
}

function isDemoConfig(config: ProviderConfig): boolean {
  return config.kind === 'demo' || config.id === 'demo'
}

function candidateKey(config: ProviderConfig, model: ModelInfo): string {
  return `${config.id}:${model.id}`
}

export function rankTextCandidates(
  settings: Pick<Settings, 'providers' | 'defaultModel'>,
  keyFor: (providerId: string) => string | null,
  strategy: StudioTextStrategy
): TextCandidate[] {
  const defaultKey = `${settings.defaultModel.providerId}:${settings.defaultModel.modelId}`
  const candidates: TextCandidate[] = []
  for (const config of settings.providers) {
    if (!config.enabled || isDemoConfig(config) || !Array.isArray(config.models)) continue
    const local = isLocalServiceUrl(config.baseUrl, { allowPrivate: true })
    if (strategy === 'local-only' && !local) continue
    if (strategy === 'cloud-only' && local) continue
    let apiKey = keyFor(config.id)
    if (!apiKey && local) apiKey = 'morrow-local'
    for (const model of config.models) {
      candidates.push({ config, model, local, apiKey, default: candidateKey(config, model) === defaultKey })
    }
  }
  const score = (candidate: TextCandidate): number => {
    let value = candidate.default ? 30 : 0
    if (candidate.apiKey) value += 100
    if (strategy === 'local-first') value += candidate.local ? 60 : 0
    if (strategy === 'cloud-first') value += candidate.local ? 0 : 60
    return value
  }
  return candidates.sort((left, right) => score(right) - score(left))
}

function rankCandidates(settings: Settings, strategy: StudioTextStrategy): TextCandidate[] {
  return rankTextCandidates(settings, (providerId) => getSettingsStore().getApiKey(providerId), strategy)
}

export function studioTextRoutes(strategy: StudioTextStrategy = 'local-first'): StudioTextRouteInfo[] {
  const settings = getSettingsStore().get()
  return rankCandidates(settings, strategy).slice(0, 8).map((candidate) => ({
    providerId: candidate.config.id,
    providerLabel: candidate.config.name,
    modelId: candidate.model.id,
    modelLabel: candidate.model.label,
    local: candidate.local,
    configured: Boolean(candidate.apiKey),
    ...(candidate.model.pricing ? { inputPerMTok: candidate.model.pricing.inputPerMTok, outputPerMTok: candidate.model.pricing.outputPerMTok } : {}),
    ...(candidate.model.contextWindow ? { contextWindow: candidate.model.contextWindow } : {}),
    ...(candidate.model.maxOutput ? { maxOutput: candidate.model.maxOutput } : {}),
    ...(candidate.model.supportsVision ? { supportsVision: true } : {}),
    ...(candidate.model.supportsTools ? { supportsTools: true } : {}),
    ...(candidate.model.supportsReasoning ? { supportsReasoning: true } : {})
  }))
}

export function studioVisionProvider(strategy: StudioTextStrategy = 'local-first'): { provider: ReturnType<typeof createProvider>; model: ModelInfo; local: boolean } | null {
  const ranked = rankCandidates(getSettingsStore().get(), strategy)
  const chosen = ranked.find((candidate) => candidate.apiKey && candidate.model.supportsVision === true)
  if (!chosen) return null
  return { provider: createProvider(chosen.config, chosen.apiKey!, chosen.model.id), model: chosen.model, local: chosen.local }
}

export interface StudioTextRuntime {
  configured: boolean
  demo: boolean
  config: ProviderConfig | null
  model: ModelInfo | null
  apiKey: string | null
  message: string
}

export function studioTextRuntime(strategy: StudioTextStrategy = 'local-first'): StudioTextRuntime {
  const settings = getSettingsStore().get()
  const ranked = rankCandidates(settings, strategy)
  const chosen = ranked.find((candidate) => candidate.apiKey)
  if (chosen) {
    return {
      configured: true,
      demo: false,
      config: chosen.config,
      model: chosen.model,
      apiKey: chosen.apiKey,
      message: `${STRATEGY_LABEL[strategy]} · ${chosen.config.name} · ${chosen.model.label}${chosen.local ? ' · 本机' : ''}`
    }
  }
  const ref = settings.defaultModel
  const config = settings.providers.find((item) => item.id === ref.providerId) ?? null
  const model = config ? findModel(settings.providers, ref) ?? config.models[0] ?? null : null
  if (config && isDemoConfig(config)) {
    return {
      configured: false,
      demo: true,
      config,
      model,
      apiKey: null,
      message: '当前是离线演示模型；生成蓝图前请在设置里连接真实文本模型。'
    }
  }
  if (!config) {
    return { configured: false, demo: false, config: null, model: null, apiKey: null, message: '还没有选择模型。请到设置里连接文本模型后再生成蓝图。' }
  }
  if (!model) {
    return { configured: false, demo: false, config, model: null, apiKey: null, message: '这个提供方还没有可用模型。' }
  }
  const mode = STRATEGY_LABEL[strategy]
  const reason = strategy === 'local-only'
    ? '没有可用的本地文本模型；请到设置里配置本机 OpenAI 兼容服务，或改为其他策略。'
    : strategy === 'cloud-only'
      ? '没有可用的云端文本模型；请到 Agent 设置里配置云端提供方与 API Key。'
      : config.models.length
        ? `按「${mode}」没有找到带 Key 的可用模型；请到设置里检查账号与密钥。`
        : '这个提供方还没有可用模型。'
  return { configured: false, demo: false, config, model, apiKey: null, message: reason }
}

export interface CompletionResult {
  text: string
  model: string
  usage?: Usage
  costCny: number | null
  costNote?: string
  /** 模型触达本次请求的官方输出上限；结构化任务应拒绝写入。 */
  truncated?: boolean
}

/**
 * 不带工具的纯文本补全；创作台的结构化动作都走这一条窄通道。
 * 输出预算始终以模型官方 maxOutput 为上限，不再使用创作台私设的小额度；
 * 结构化任务触达上限时默认报错，避免把半截 JSON 当成完整结果。
 */
export async function completeCreativeText(options: {
  system: string
  prompt: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  strategy?: StudioTextStrategy
  /** 结构化输出（JSON）；触达输出上限时直接报错，不返回半截内容。 */
  structured?: boolean
  /** 普通文本被截断时自动续写，最多两次。 */
  continueOnTruncate?: boolean
  /** 推理模型写长 JSON 可能超过 3 分钟；这里给足时间，任务本身仍可取消。 */
  timeoutMs?: number
}): Promise<CompletionResult> {
  const runtime = studioTextRuntime(options.strategy ?? 'local-first')
  if (!runtime.configured || !runtime.config || !runtime.model) throw new Error(runtime.message)
  const provider = createProvider(runtime.config, runtime.apiKey, runtime.model.id)
  const official = typeof runtime.model.maxOutput === 'number' && runtime.model.maxOutput > 0 ? runtime.model.maxOutput : undefined
  const requested = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : official ?? 8192
  const budget = Math.max(256, official ? Math.min(requested, official) : requested)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300_000)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let text = ''
  let truncated = false
  let thinkingChars = 0
  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 }
  let hasUsage = false
  const messages: ChatMessage[] = [{
    id: `studio-${Date.now().toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text: options.prompt }],
    createdAt: Date.now()
  }]
  try {
    for (let round = 0; round <= 2; round += 1) {
      let roundText = ''
      let roundTruncated = false
      let roundUsage: Usage | undefined
      const stream = provider.stream({
        system: options.system,
        messages: [...messages],
        tools: [],
        signal: controller.signal,
        maxTokens: budget,
        temperature: options.temperature ?? 0.85
      })
      for await (const event of stream) {
        if (event.type === 'text_delta') roundText += event.text
        else if (event.type === 'thinking_delta') thinkingChars += event.text.length
        else if (event.type === 'usage') roundUsage = event.usage
        else if (event.type === 'notice' && event.code === 'max_tokens') roundTruncated = true
      }
      text += roundText
      truncated = roundTruncated
      const usage = roundUsage
      if (usage) {
        hasUsage = true
        totalUsage.inputTokens += usage.inputTokens
        totalUsage.outputTokens += usage.outputTokens
        if (typeof usage.cacheReadTokens === 'number') {
          totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + usage.cacheReadTokens
        }
      }
      if (!roundTruncated || !options.continueOnTruncate || round >= 2 || !roundText.trim()) break
      messages.push({
        id: `studio-${Date.now().toString(36)}-${round}`,
        role: 'assistant',
        content: [{ type: 'text', text: roundText }],
        createdAt: Date.now()
      }, {
        id: `studio-${Date.now().toString(36)}-${round}-continue`,
        role: 'user',
        content: [{ type: 'text', text: '从刚才中断的地方继续，直接接着写；不要重复已有内容，不要解释。' }],
        createdAt: Date.now()
      })
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
  const trimmed = text.trim()
  if (!trimmed) {
    log.warn('studio creative text empty', { model: runtime.model.label, maxTokens: budget, thinkingChars, usage: hasUsage ? totalUsage : undefined })
    throw new Error('模型没有返回可用的文本。请换一个模型或重试。')
  }
  if (truncated && options.structured && !options.continueOnTruncate) {
    log.warn('studio structured text truncated', { model: runtime.model.label, maxTokens: budget, thinkingChars, usage: totalUsage })
    throw new Error(`模型输出触达官方上限（${budget.toLocaleString('zh-CN')} tokens）后被截断；已拒绝写入残缺结果。请在设置里换用更大输出上限的模型，或把任务拆小后重试。`)
  }
  let costCny: number | null = null
  let costNote: string | undefined
  const pricing = runtime.model.pricing
  if (pricing && hasUsage) {
    const usd = (totalUsage.inputTokens / 1_000_000) * pricing.inputPerMTok + (totalUsage.outputTokens / 1_000_000) * pricing.outputPerMTok
    costCny = Math.round(usd * 7.2 * 1000) / 1000
    costNote = '按模型参考单价折算，实际以服务商账单为准'
  } else {
    costNote = '该模型没有可靠单价，费用显示为未知'
  }
  return { text: trimmed, model: runtime.model.label, ...(hasUsage ? { usage: totalUsage } : {}), costCny, ...(costNote ? { costNote } : {}), ...(truncated ? { truncated: true } : {}) }
}

export function textStatusForEngine(strategy: StudioTextStrategy = 'local-first'): StudioEngineStatus['text'] {
  const runtime = studioTextRuntime(strategy)
  return {
    configured: runtime.configured,
    ...(runtime.config ? { providerId: runtime.config.id, providerLabel: runtime.config.name } : {}),
    ...(runtime.model
      ? {
          modelId: runtime.model.id,
          modelLabel: runtime.model.label,
          ...(runtime.model.contextWindow ? { contextWindow: runtime.model.contextWindow } : {}),
          ...(runtime.model.maxOutput ? { maxOutput: runtime.model.maxOutput } : {}),
          ...(runtime.model.supportsVision ? { supportsVision: true } : {}),
          ...(runtime.model.supportsTools ? { supportsTools: true } : {}),
          ...(runtime.model.supportsReasoning ? { supportsReasoning: true } : {})
        }
      : {}),
    demo: runtime.demo,
    message: runtime.message,
    routes: studioTextRoutes(strategy)
  }
}

/** 按字符数粗估文本费用；没有单价时返回 null（界面必须显示未知）。 */
export function estimateTextCostCny(inputChars: number, outputChars: number, strategy: StudioTextStrategy = 'local-first'): number | null {
  const runtime = studioTextRuntime(strategy)
  if (!runtime.model?.pricing) return null
  const inputTokens = Math.ceil(inputChars / 1.7)
  const outputTokens = Math.ceil(outputChars / 1.7)
  const usd =
    (inputTokens / 1_000_000) * runtime.model.pricing.inputPerMTok +
    (outputTokens / 1_000_000) * runtime.model.pricing.outputPerMTok
  return Math.round(usd * 7.2 * 1000) / 1000
}

/** 修模型常见的 JSON 手误：漏引号/多逗号/裸换行；只改语法，不改中文内容。 */
function repairJsonSyntax(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)"\s*:/g, '$1"$2":')
    .replace(/([{,]\s*)"([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1')
}

/** 从模型输出里提取第一个可解析 JSON 对象；容忍 ```json 围栏和前后说明。 */
export function extractJson<T>(text: string): T | null {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]
  const candidates = [fenced, trimmed]
  for (const candidate of candidates) {
    if (!candidate) continue
    for (const variant of [candidate, repairJsonSyntax(candidate)]) {
      for (const slice of jsonObjectSlices(variant)) {
        try {
          return JSON.parse(slice) as T
        } catch {
          const repaired = repairJsonSyntax(slice)
          try {
            return JSON.parse(repaired) as T
          } catch {
            // 继续尝试下一个候选
          }
        }
      }
    }
  }
  return null
}

/** 提取第一个平衡的 JSON 对象，避免模型在 JSON 前后附带解释文字或第二个对象。 */
function jsonObjectSlices(text: string): string[] {
  const slices: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        slices.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return slices
}

export function buildTimelineFromProject(project: StudioProject): StudioTimeline {
  const timeline = emptyTimeline(project.brief.aspect, nowMs())
  timeline.fps = 30
  timeline.width = project.brief.aspect === '9:16' ? 1080 : project.brief.aspect === '1:1' ? 1080 : 1920
  timeline.height = project.brief.aspect === '9:16' ? 1920 : 1080
  const shots = [...project.shots].sort((a, b) => a.number - b.number)
  let cursor = 0
  const visualClips: StudioClip[] = []
  const dialogueClips: StudioClip[] = []
  const subtitleClips: StudioClip[] = []
  const previousSubtitles = new Map<string, StudioClip[]>()
  for (const clip of project.timeline?.clips ?? []) {
    if (clip.kind !== 'subtitle' || !clip.shotId) continue
    const list = previousSubtitles.get(clip.shotId) ?? []
    list.push(clip)
    previousSubtitles.set(clip.shotId, list)
  }
  for (const shot of shots) {
    const duration = Math.max(1, shot.durationSec || 8)
    const assetId = shot.videoAssetId ?? shot.imageAssetId
    if (assetId) {
      visualClips.push({
        id: studioId('clip'),
        trackId: 'track-video',
        kind: 'video',
        label: `${String(shot.number).padStart(2, '0')} · ${shot.title}`,
        assetId,
        shotId: shot.id,
        start: cursor,
        duration,
        srcIn: 0,
        speed: 1,
        volume: 1,
        transition: shot.number === 1 || shot.number === shots.length ? 'fade-both' : 'cut'
      })
    }
    if (shot.voiceAssetId) {
      const voice = project.assets.find((asset) => asset.id === shot.voiceAssetId)
      const voiceDuration = voice?.durationSec ?? duration
      const clipDuration = Math.min(duration, Math.max(0.5, voiceDuration))
      dialogueClips.push({
        id: studioId('clip'),
        trackId: 'track-dialogue',
        kind: 'dialogue',
        label: `${shot.speaker || '对白'} · ${String(shot.number).padStart(2, '0')}`,
        assetId: shot.voiceAssetId,
        shotId: shot.id,
        start: cursor,
        duration: clipDuration,
        srcIn: 0,
        speed: 1,
        volume: 1,
        transition: 'cut'
      })
    }
    if (shot.dialogue.trim()) {
      const old = previousSubtitles.get(shot.id) ?? []
      const oldText = old.map((clip) => (clip.text ?? '').trim()).join('').replace(/\s+/g, '')
      const newText = shot.dialogue.replace(/\s+/g, '')
      if (old.length && oldText === newText) {
        const base = Math.min(...old.map((clip) => clip.start))
        subtitleClips.push(...old.map((clip) => ({ ...clip, start: cursor + Math.max(0, clip.start - base) })))
      } else {
        subtitleClips.push({
          id: studioId('clip'),
          trackId: 'track-subtitle',
          kind: 'subtitle',
          label: `字幕 · ${String(shot.number).padStart(2, '0')}`,
          shotId: shot.id,
          start: cursor,
          duration,
          srcIn: 0,
          speed: 1,
          volume: 1,
          transition: 'cut',
          text: shot.dialogue,
          style: { yPercent: 86, size: 34, color: '#ede7da', background: true }
        })
      }
    }
    cursor += duration
  }
  timeline.clips.push(...visualClips, ...dialogueClips)
  const music = resolveMusicAsset(project)?.asset
  if (music && cursor > 0) {
    timeline.clips.push({
      id: studioId('clip'),
      trackId: 'track-music',
      kind: 'music',
      label: music.title,
      assetId: music.id,
      start: 0,
      duration: cursor,
      srcIn: 0,
      speed: 1,
      volume: 0.55,
      transition: 'fade-both',
      loop: true
    })
  }
  const sfx = project.assets.filter((asset) => asset.kind === 'audio' && asset.tags.includes('sfx'))
  for (const [index, asset] of sfx.entries()) {
    const start = index === 0 ? 0 : index === 1 ? Math.min(cursor * 0.62, Math.max(0, cursor - (asset.durationSec ?? 4))) : Math.min(cursor * 0.82, Math.max(0, cursor - (asset.durationSec ?? 4)))
    timeline.clips.push({
      id: studioId('clip'),
      trackId: 'track-sfx',
      kind: 'sfx',
      label: asset.title,
      assetId: asset.id,
      start,
      duration: Math.min(cursor - start, asset.durationSec ?? 4),
      srcIn: 0,
      speed: 1,
      volume: 0.55,
      transition: 'fade-both',
      loop: (asset.durationSec ?? 4) < cursor - start
    })
  }
  timeline.clips.push(...subtitleClips)
  timeline.clips.sort((a, b) => a.start - b.start)
  timeline.durationSec = cursor
  timeline.version = (project.timeline?.version ?? 0) + 1
  timeline.updatedAt = nowMs()
  timeline.snapshots = [...(project.timeline?.snapshots ?? [])].slice(-19)
  if (project.timeline?.clips.length) {
    timeline.snapshots.push({
      id: studioId('tl'),
      createdAt: nowMs(),
      reason: '重新装配前',
      tracks: project.timeline.tracks,
      clips: project.timeline.clips
    })
  }
  return timeline
}

export function sanitizeTimeline(project: StudioProject, raw: { tracks?: unknown; clips?: unknown; aspect?: unknown; fps?: unknown }): StudioTimeline {
  const base = project.timeline?.tracks?.length ? project.timeline : emptyTimeline(project.brief.aspect)
  const allowedTracks = new Map<string, StudioTrack>(base.tracks.map((track) => [track.id, track]))
  const tracks = Array.isArray(raw.tracks)
    ? raw.tracks
        .filter((track): track is StudioTrack => Boolean(track) && typeof track === 'object')
        .map((track) => {
          const existing = allowedTracks.get(String(track.id))
          return existing
            ? {
                ...existing,
                muted: track.muted === true,
                locked: track.locked === true,
                volume: clampNumber(track.volume, 0, 2, existing.volume)
              }
            : null
        })
        .filter((track): track is StudioTrack => Boolean(track))
    : base.tracks
  const trackIds = new Set(tracks.map((track) => track.id))
  const clips = Array.isArray(raw.clips)
    ? raw.clips
        .filter((clip): clip is Record<string, unknown> => Boolean(clip) && typeof clip === 'object')
        .map((clip) => sanitizeClip(clip, trackIds))
        .filter((clip): clip is StudioClip => Boolean(clip))
    : base.clips
  const aspect = raw.aspect === '9:16' || raw.aspect === '1:1' || raw.aspect === '16:9' ? raw.aspect : base.aspect
  const fps = clampNumber(raw.fps, 24, 60, base.fps)
  const timeline: StudioTimeline = {
    fps,
    width: base.width,
    height: base.height,
    aspect,
    durationSec: timelineDuration({ clips, durationSec: 0 }),
    tracks: tracks.length ? tracks : base.tracks,
    clips: clips.sort((a, b) => a.start - b.start),
    version: base.version + 1,
    updatedAt: nowMs(),
    snapshots: [
      ...base.snapshots.slice(-19),
      { id: studioId('tl'), createdAt: nowMs(), reason: '保存前', tracks: base.tracks, clips: base.clips }
    ].slice(-20)
  }
  return timeline
}

function sanitizeClip(raw: Record<string, unknown>, trackIds: Set<string>): StudioClip | null {
  const id = typeof raw.id === 'string' && raw.id ? raw.id : studioId('clip')
  const trackId = typeof raw.trackId === 'string' ? raw.trackId : ''
  if (!trackIds.has(trackId)) return null
  const kind = raw.kind
  if (!['video', 'dialogue', 'music', 'sfx', 'subtitle'].includes(String(kind))) return null
  const start = clampNumber(raw.start, 0, 24 * 3600, 0)
  const duration = clampNumber(raw.duration, 0.1, 24 * 3600, 1)
  return {
    id,
    trackId,
    kind: kind as StudioClip['kind'],
    label: typeof raw.label === 'string' ? raw.label.slice(0, 120) : '片段',
    ...(typeof raw.assetId === 'string' ? { assetId: raw.assetId } : {}),
    ...(typeof raw.shotId === 'string' ? { shotId: raw.shotId } : {}),
    start,
    duration,
    srcIn: clampNumber(raw.srcIn, 0, 24 * 3600, 0),
    speed: clampNumber(raw.speed, 0.25, 4, 1),
    volume: clampNumber(raw.volume, 0, 2, 1),
    transition: raw.transition === 'fade-in' || raw.transition === 'fade-out' || raw.transition === 'fade-both' ? raw.transition : 'cut',
    ...(raw.loop === true ? { loop: true } : {}),
    ...(typeof raw.text === 'string' ? { text: raw.text.slice(0, 2000) } : {}),
    ...(raw.style && typeof raw.style === 'object'
      ? {
          style: {
            ...(Number.isFinite((raw.style as Record<string, unknown>).yPercent)
              ? { yPercent: clampNumber((raw.style as Record<string, unknown>).yPercent, 2, 96, 86) }
              : {}),
            ...(Number.isFinite((raw.style as Record<string, unknown>).size)
              ? { size: clampNumber((raw.style as Record<string, unknown>).size, 18, 96, 34) }
              : {}),
            ...(typeof (raw.style as Record<string, unknown>).color === 'string'
              ? { color: String((raw.style as Record<string, unknown>).color).slice(0, 24) }
              : {}),
            background: (raw.style as Record<string, unknown>).background !== false
          }
        }
      : {}),
    ...(raw.locked === true ? { locked: true } : {})
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

export function subtitleClips(timeline: StudioTimeline): StudioClip[] {
  return timeline.clips
    .filter((clip) => clip.kind === 'subtitle' && (clip.text ?? '').trim())
    .sort((a, b) => a.start - b.start)
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const rest = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`
}

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100))
  const h = Math.floor(cs / 360_000)
  const m = Math.floor((cs % 360_000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const rest = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(rest).padStart(2, '0')}`
}

export function toSrt(timeline: StudioTimeline): string {
  return subtitleClips(timeline)
    .map((clip, index) => `${index + 1}\n${srtTime(clip.start)} --> ${srtTime(clip.start + clip.duration)}\n${clip.text ?? ''}\n`)
    .join('\n')
}

const DEFAULT_SUBTITLE_COLOR = '#ede7da'

/** ASS 颜色是 &HAABBGGRR；把界面里的 #RRGGBB 转成正确的 BGR 顺序。 */
function assColor(value: unknown): string {
  const hex = typeof value === 'string' ? value.trim().replace(/^#/, '') : ''
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '&H00DAE7ED'
  return `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase()
}

export function toAss(timeline: StudioTimeline): string {
  const baseColor = assColor(DEFAULT_SUBTITLE_COLOR)
  const header = `[Script Info]
Title: Morrow Studio
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${timeline.width}
PlayResY: ${timeline.height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Morrow,Microsoft YaHei,34,${baseColor},&H000000FF,&H99101418,&H99000000,0,0,0,0,100,100,0.5,0,1,2,1,2,64,64,72,1
Style: MorrowBox,Microsoft YaHei,34,${baseColor},&H000000FF,&H99101418,&H80000000,0,0,0,0,100,100,0.5,0,3,1,0,2,64,64,72,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const events = subtitleClips(timeline)
    .map((clip) => {
      const style = clip.style ?? {}
      const marginV = Math.round(((100 - (style.yPercent ?? 86)) / 100) * timeline.height)
      const size = Math.max(18, Math.min(96, Math.round(style.size ?? 34)))
      const styleName = style.background === false ? 'Morrow' : 'MorrowBox'
      const text = (clip.text ?? '').replace(/\r?\n/g, '\\N').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
      return `Dialogue: 0,${assTime(clip.start)},${assTime(clip.start + clip.duration)},${styleName},,0,0,${Math.max(0, marginV)},,{\\fs${size}\\c${assColor(style.color)}&}${text}`
    })
    .join('\n')
  return `${header}${events}\n`
}

export type StudioPromptTask = CreativeTask

/**
 * 底层创作方法只取自桌面三套大师文件（写作/编剧/导演）。
 * 这里只负责根据模型上下文给出加载预算，不再拼接任何创作台内嵌手法或门禁。
 */
export function masterPromptContext(
  kind: StudioKind,
  task: StudioPromptTask,
  query = '',
  view?: string,
  strategy: StudioTextStrategy = 'local-first'
): string {
  const contextWindow = studioTextRuntime(strategy).model?.contextWindow ?? 32_768
  const budgetChars = contextWindow >= 200_000 ? 34_000 : contextWindow >= 100_000 ? 27_000 : contextWindow >= 64_000 ? 20_000 : contextWindow >= 32_000 ? 13_000 : 7_000
  return `\n\n${creativeMasterPrompt({ kind, task, query, ...(view ? { view } : {}), budgetChars })}`
}

export interface ProseQualityMetrics {
  chars: number
  sentences: number
  avgSentence: number
  fillerHits: number
  fillerRatio: number
  abstractHits: number
  abstractRatio: number
  passiveHits: number
  metaphorHits: number
  metaphorPer1000: number
  paragraphMax: number
  dialogueRatio: number
  questionRatio: number
  openingHook: boolean
  endingHook: boolean
}

const FILLER_PATTERN = /感到|觉得|仿佛|似乎|忽然|突然|意识到|不知不觉|不由自主|下意识|如同|好像/g

const ABSTRACT_PATTERN = /[\u4e00-\u9fa5]{1,3}(?:性|度|化|感)/g

const METAPHOR_PATTERN = /像|仿佛|如同|好似|宛如/g

const OPENING_HOOK_PATTERN = /但|却|然而|没想到|直到|必须|不能|死|血|逃|追|拒绝|秘密|谎|债|消失|不见|反着|倒着|陌生人|不对|突然|停了|站着|没有人/

const ENDING_HOOK_PATTERN = /[？?！!…]|[“”「」]/

export function measureProseQuality(text: string): ProseQualityMetrics {
  const compact = text.replace(/\s+/g, '')
  const chars = Math.max(0, compact.length)
  const sentences = text.split(/[。！？!?…]+/).map((item) => item.trim()).filter(Boolean)
  const paragraphs = text.split(/\n+/).map((item) => item.trim()).filter(Boolean)
  const fillerHits = (text.match(FILLER_PATTERN) ?? []).length
  const abstractHits = (text.match(ABSTRACT_PATTERN) ?? []).length
  const passiveHits = (text.match(/被/g) ?? []).length
  const metaphorHits = (text.match(METAPHOR_PATTERN) ?? []).length
  const dialogueChars = (text.match(/[“「][^”」]{1,200}[”」]/g) ?? []).join('').length
  return {
    chars,
    sentences: sentences.length,
    avgSentence: chars / Math.max(1, sentences.length),
    fillerHits,
    fillerRatio: fillerHits / Math.max(1, chars / 2),
    abstractHits,
    abstractRatio: abstractHits / Math.max(1, chars / 2),
    passiveHits,
    metaphorHits,
    metaphorPer1000: (metaphorHits / Math.max(1, chars)) * 1000,
    paragraphMax: paragraphs.reduce((max, paragraph) => Math.max(max, paragraph.length), 0),
    dialogueRatio: dialogueChars / Math.max(1, chars),
    questionRatio: (text.match(/[？?]/g) ?? []).length / Math.max(1, sentences.length),
    openingHook: OPENING_HOOK_PATTERN.test(compact.slice(0, 300)),
    endingHook: ENDING_HOOK_PATTERN.test(compact.slice(-120))
  }
}

function qualityCheck(level: StudioCheck['level'], title: string, detail: string, targetId?: string): StudioCheck {
  return {
    id: studioId('check'),
    kind: 'quality',
    level,
    title,
    detail,
    ...(targetId ? { targetId } : {}),
    createdAt: Date.now()
  }
}

export function proseQualityChecks(project: StudioProject): StudioCheck[] {
  const checks: StudioCheck[] = []
  const written = project.chapters.filter((chapter) => chapter.content.trim()).sort((left, right) => left.number - right.number)
  if (!written.length) return checks
  const allText = written.map((chapter) => chapter.content).join('\n')
  const overall = measureProseQuality(allText)
  if (overall.chars >= 500) {
    if (overall.fillerRatio > 0.08) {
      checks.push(qualityCheck('warn', '虚词和空泛判断偏多', `虚词/心理标签密度约 ${(overall.fillerRatio * 100).toFixed(1)}%（建议 <5%）。优先把“感到、觉得、仿佛、突然”改成动作、物件或直接陈述。`))
    }
    if (overall.avgSentence > 38) {
      checks.push(qualityCheck('warn', '平均句长偏长', `平均每句约 ${Math.round(overall.avgSentence)} 字（建议 15–25 字）。把长句拆成动作短句，删掉从句里的解释。`))
    }
    if (overall.abstractRatio > 0.1) {
      checks.push(qualityCheck('warn', '抽象名词偏多', `“性/度/化/感”类抽象词约 ${(overall.abstractRatio * 100).toFixed(1)}%（建议 <8%）。换成可见的行为、物件或数字。`))
    }
    if (overall.metaphorPer1000 > 2) {
      checks.push(qualityCheck('info', '比喻密度偏高', `约 ${overall.metaphorPer1000.toFixed(1)} 个/千字（建议 ≤1）。保留最能改变理解的那一个比喻，其余改白描。`))
    }
    if (overall.paragraphMax > 360) {
      checks.push(qualityCheck('info', '有超长段落', `最长一段 ${overall.paragraphMax} 字。手机阅读建议拆到 2–4 行，让动作和停顿更清楚。`))
    }
  }
  for (const chapter of written) {
    const metrics = measureProseQuality(chapter.content)
    if (metrics.chars < 300) continue
    if (metrics.fillerRatio > 0.12) {
      checks.push(qualityCheck('warn', `第 ${chapter.number} 章 AI 腔偏重`, `虚词密度约 ${(metrics.fillerRatio * 100).toFixed(1)}%。建议用“润色”重写该章，或逐段删掉心理标签。`, chapter.id))
    }
    if (metrics.avgSentence > 45) {
      checks.push(qualityCheck('info', `第 ${chapter.number} 章句子偏长`, `平均每句约 ${Math.round(metrics.avgSentence)} 字。拆句后再看节奏。`, chapter.id))
    }
  }
  const first = written[0]
  if (first && measureProseQuality(first.content).chars >= 300 && !measureProseQuality(first.content).openingHook) {
    checks.push(qualityCheck('info', '开篇 300 字没有明显压力', '读者还没看到反常、冲突或必须做的选择。可以加一个具体异常，或让主角尽早付出代价。', first.id))
  }
  const weakEndings = written.filter((chapter) => measureProseQuality(chapter.content).chars >= 300 && !measureProseQuality(chapter.content).endingHook)
  if (weakEndings.length) {
    checks.push(qualityCheck('info', `${weakEndings.length} 章结尾像自然收束`, `${weakEndings.slice(0, 4).map((chapter) => `第 ${chapter.number} 章`).join('、')} 最后一句没有留下问题、动作或选择。章末钩子不必是悬念句，但必须让人想翻下一页。`))
  }
  return checks
}

export function dramaQualityChecks(project: StudioProject): StudioCheck[] {
  const checks: StudioCheck[] = []
  const shots = [...project.shots].sort((left, right) => left.number - right.number)
  if (!shots.length) return checks
  if (shots.length < 6) {
    checks.push(qualityCheck('warn', '镜头数量不足以形成完整漫剧', `当前 ${shots.length} 镜；建议至少 6 镜，才有起承转合。`))
  } else if (shots.length > 40) {
    checks.push(qualityCheck('info', '镜头数量偏多', `当前 ${shots.length} 镜；长片可以保留，但逐镜都要有独立叙事功能。`))
  }
  const noPrompt = shots.filter((shot) => !shot.prompt.trim())
  if (noPrompt.length) checks.push(qualityCheck('warn', `${noPrompt.length} 镜没有画面提示词`, `镜 ${noPrompt.slice(0, 8).map((shot) => shot.number).join('、')} 缺少人物外观、环境、光线与构图描述，生成画面会不稳定。`))
  const noSpeaker = shots.filter((shot) => shot.dialogue.trim() && !shot.speaker.trim())
  if (noSpeaker.length) checks.push(qualityCheck('warn', `${noSpeaker.length} 镜台词没有说话人`, `镜 ${noSpeaker.slice(0, 8).map((shot) => shot.number).join('、')} 无法稳定配音与对口型。`))
  const longLines = shots.filter((shot) => countWords(shot.dialogue) > 60)
  if (longLines.length) checks.push(qualityCheck('info', `${longLines.length} 镜台词偏长`, `镜 ${longLines.slice(0, 6).map((shot) => shot.number).join('、')} 单镜台词超过 60 字，容易压过镜头时长；建议拆镜或压缩。`))
  const badDuration = shots.filter((shot) => shot.durationSec < 3 || shot.durationSec > 20)
  if (badDuration.length) checks.push(qualityCheck('warn', `${badDuration.length} 镜时长超出 3–20 秒`, `镜 ${badDuration.slice(0, 8).map((shot) => shot.number).join('、')} 需要调整时长，否则节奏会塌或画面来不及读完。`))
  const noContinuity = shots.filter((shot) => !shot.continuity.trim())
  if (noContinuity.length) checks.push(qualityCheck('info', `${noContinuity.length} 镜没有写衔接`, '补上服装、道具、方向或与前镜的承接，可减少穿帮。'))
  const repeatedSizes = runsOf(shots.map((shot) => shot.shotSize.trim()).filter(Boolean))
  if (repeatedSizes.length) checks.push(qualityCheck('warn', '连续三镜同一景别', `${repeatedSizes.slice(0, 4).map((item) => `「${item.value}」×${item.count}`).join('、')}。景别递进能让观众感到推进，至少换成中景/近景/特写中的另一种。`))
  const repeatedCameras = runsOf(shots.map((shot) => shot.camera.trim()).filter(Boolean))
  if (repeatedCameras.length) checks.push(qualityCheck('info', '连续三镜同一运镜', `${repeatedCameras.slice(0, 4).map((item) => `「${item.value}」×${item.count}`).join('、')}。固定镜头可以保留，但连续使用会让画面停滞。`))
  const sizes = new Set(shots.map((shot) => shot.shotSize.trim()).filter(Boolean))
  if (sizes.size < 3) checks.push(qualityCheck('info', '景别变化不足', `全片只有 ${sizes.size || 0} 种景别。建议至少覆盖远景/中景/近景，关键情绪再加特写。`))
  return checks
}

function runsOf(values: string[]): Array<{ value: string; count: number }> {
  const runs: Array<{ value: string; count: number }> = []
  let current = ''
  let count = 0
  for (const value of [...values, '\u0000']) {
    if (value === current) {
      count += 1
      continue
    }
    if (current && count >= 3) runs.push({ value: current, count })
    current = value
    count = 1
  }
  return runs
}

const DEMO_LOG_LINE = '一个雨夜，修伞的女孩捡到一把会让时间倒流的伞。她每修好一把伞，就会失去一段记忆。'

function demoAssetDir(): string | null {
  const candidates = [join(process.resourcesPath, 'studio-demo'), join(app.getAppPath(), 'resources', 'studio-demo')]
  return candidates.find((dir) => existsSync(dir)) ?? null
}

function thumbFor(file: string, projectId: string, store: StudioStore): Buffer | null {
  const paths = resolveFfmpegPaths()
  if (!paths) return null
  const temp = join(store.tempDir(projectId), `demo-thumb-${Date.now().toString(36)}.jpg`)
  try {
    mkdirSync(join(temp, '..'), { recursive: true })
    const result = spawnSync(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=560:-2', '-q:v', '4', temp], {
      windowsHide: true,
      timeout: 30_000
    })
    if (result.status === 0 && existsSync(temp)) {
      const data = require('node:fs').readFileSync(temp) as Buffer
      require('node:fs').rmSync(temp, { force: true })
      return data
    }
  } catch {
  }
  try {
    require('node:fs').rmSync(temp, { force: true })
  } catch {
  }
  return null
}

function probeDuration(file: string): number | undefined {
  const ffprobe = resolveFfmpegPaths()?.ffprobe
  if (!ffprobe) return undefined
  const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000
  })
  const value = Number((result.stdout ?? '').trim())
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : undefined
}

function addDemoAsset(
  store: StudioStore,
  project: StudioProject,
  dir: string,
  file: string,
  title: string,
  tags: string[]
): StudioAsset | null {
  const path = join(dir, file)
  if (!existsSync(path)) return null
  try {
    const ext = file.split('.').pop() ?? ''
    const kind = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'image' : ['mp4', 'webm', 'mov'].includes(ext) ? 'video' : ['wav', 'mp3'].includes(ext) ? 'audio' : 'other'
    const bytes = require('node:fs').readFileSync(path) as Buffer
    const thumb = kind === 'image' || kind === 'video' ? thumbFor(path, project.id, store) : null
    return store.addAsset(project, {
      bytes,
      title,
      kindHint: kind,
      tags,
      mime: ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'mp4' ? 'video/mp4' : ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'application/octet-stream',
      origin: { source: 'demo' },
      metadata: kind === 'audio' ? { durationSec: probeDuration(path) } : {},
      ...(thumb ? { thumbBytes: thumb } : {})
    })
  } catch {
    return null
  }
}

function attachDeliveryFromFile(store: StudioStore, project: StudioProject, dir: string, file: string, label: string, kind: StudioDelivery['kind']): void {
  const source = join(dir, file)
  if (!existsSync(source)) return
  const exportsDir = store.exportsDir(project.id)
  mkdirSync(exportsDir, { recursive: true })
  const targetName = file.replace(/^demo-/, '')
  const target = join(exportsDir, targetName)
  copyFileSync(source, target)
  const path = `exports/${targetName}`
  const delivery: StudioDelivery = {
    id: studioId('delivery'),
    kind,
    label,
    path,
    bytes: statSync(target).size,
    sha256: sha256File(target),
    createdAt: nowMs(),
    meta: { demo: true }
  }
  project.deliveries.unshift(delivery)
}

function demoCharacters(project: StudioProject, dir: string | null, store: StudioStore) {
  const blueprint = demoDramaBlueprint()
  if (dir) {
    const refs: Record<string, StudioAsset | null> = {}
    for (const [key, file] of [
      ['linwan', 'ref-linwan.jpg'],
      ['boy', 'ref-boy.jpg'],
      ['grandma', 'ref-grandma.jpg']
    ] as const) {
      refs[key] = addDemoAsset(store, project, dir, file, `角色参考 · ${key}`, ['reference', 'character', key])
    }
    if (refs.linwan) blueprint.characters[0].refAssetIds = [refs.linwan.id]
    if (refs.boy) blueprint.characters[1].refAssetIds = [refs.boy.id]
    if (refs.grandma) blueprint.characters[2].refAssetIds = [refs.grandma.id]
  }
  return blueprint
}

function markStage(project: StudioProject, id: StudioProject['stage'], status: StudioProject['stages'][StudioProject['stage']]['status'], message: string, progress: number): void {
  project.stages[id] = { status, updatedAt: nowMs(), message, progress }
}

function seedDrama(store: StudioStore, dir: string | null): StudioProject {
  const project = store.newProject({
    kind: 'drama',
    title: '逆行的伞',
    logline: DEMO_LOG_LINE,
    brief: {
      form: '速成草稿',
      genre: '都市奇幻',
      audience: '喜欢都市奇幻短片的 18–35 岁观众',
      tone: '克制的悲伤 → 温柔的释然',
      style: '低饱和雨夜、暖色灯、轻微胶片颗粒',
      aspect: '16:9',
      constraints: ['角色脸不换', '雨丝方向一致', '16:9', '无旁白'],
      references: ['示例：雨夜旧城、修伞铺、纸鹤'],
      targetSeconds: 96
    },
    demo: true
  })
  const blueprintBase = demoDramaBlueprint()
  blueprintBase.approved = true
  blueprintBase.approvedAt = nowMs()
  blueprintBase.outlineModel = '随包样例'
  blueprintBase.storyboardModel = '随包样例'
  if (!dir) blueprintBase.warnings = ['随包画面素材没有找到；样例仍可打开，分镜图需要连接画面引擎后重新生成。']
  applyBlueprintToProject(project, blueprintBase)
  project.blueprint = { ...blueprintBase }
  project.demo = true
  project.title = '逆行的伞'
  const images: StudioAsset[] = []
  if (dir) {
    const files = readdirSync(dir)
      .filter((file) => /^drama-\d+\.(png|jpg|jpeg)$/i.test(file))
      .sort()
    for (const [index, file] of files.entries()) {
      const asset = addDemoAsset(store, project, dir, file, `样例分镜 ${String(index + 1).padStart(2, '0')}`, ['image', 'storyboard', 'demo'])
      if (asset) images.push(asset)
    }
  }
  for (const [index, shot] of project.shots.entries()) {
    const asset = images[index % Math.max(1, images.length)]
    if (asset) {
      shot.imageAssetId = asset.id
      shot.imageCandidates.unshift({
        id: studioId('cand'),
        assetId: asset.id,
        label: '样例画面',
        source: 'import',
        createdAt: nowMs(),
        adopted: true
      })
      shot.status = 'done'
    }
  }
  const cover = dir ? addDemoAsset(store, project, dir, 'drama-cover.jpg', '《逆行的伞》封面', ['cover', 'demo']) : null
  if (cover) project.coverAssetId = cover.id
  else if (images[0]) project.coverAssetId = images[0].id
  if (dir) {
    const refs: Record<string, StudioAsset | null> = {
      linwan: addDemoAsset(store, project, dir, 'ref-linwan.jpg', '角色参考 · 林晚', ['reference', 'character', 'demo']),
      boy: addDemoAsset(store, project, dir, 'ref-boy.jpg', '角色参考 · 少年', ['reference', 'character', 'demo']),
      grandma: addDemoAsset(store, project, dir, 'ref-grandma.jpg', '角色参考 · 外婆', ['reference', 'character', 'demo'])
    }
    if (refs.linwan) project.characters[0].refAssetIds = [refs.linwan.id]
    if (refs.boy) project.characters[1].refAssetIds = [refs.boy.id]
    if (refs.grandma) project.characters[2].refAssetIds = [refs.grandma.id]
  }

  const voiceNames = listSystemVoices().voices
  const zhVoice = voiceNames.find((voice) => voice.culture.startsWith('zh'))?.name
  const pickVoice = (needle: string): string => voiceNames.find((voice) => voice.name.toLowerCase().includes(needle))?.name ?? zhVoice ?? ''
  const linVoice = pickVoice('huihui')
  const boyVoice = pickVoice('kangkang')
  const grandmaVoice = pickVoice('yaoyao')
  if (project.characters[0]) project.characters[0].voiceId = linVoice
  if (project.characters[1]) project.characters[1].voiceId = boyVoice
  if (project.characters[2]) project.characters[2].voiceId = grandmaVoice
  if (dir) {
    for (const shot of project.shots) {
      if (!shot.dialogue.trim()) continue
      const file = `voice-${String(shot.number).padStart(2, '0')}.wav`
      const voice = addDemoAsset(store, project, dir, file, `样例配音 · 第 ${shot.number} 镜`, ['voice', 'demo', `shot:${shot.id}`])
      if (voice) {
        shot.voiceAssetId = voice.id
        shot.voiceId = project.characters.find((character) => character.name === shot.speaker)?.voiceId ?? zhVoice ?? ''
      }
    }
    const music = addDemoAsset(store, project, dir, 'music-rain.wav', '配乐 · 雨幕下的钢琴', ['music', 'demo'])
    if (music) {
      project.stages.music = { status: 'done', updatedAt: nowMs(), message: '样例配乐已就位', progress: 100 }
    }
    for (const [file, title, tag] of [
      ['sfx-rain.wav', '音效 · 雨声', 'rain'],
      ['sfx-umbrella.wav', '音效 · 伞骨', 'umbrella'],
      ['sfx-heartbeat.wav', '音效 · 心跳', 'heartbeat']
    ] as const) {
      addDemoAsset(store, project, dir, file, title, ['sfx', tag, 'demo'])
    }
  }
  project.timeline = buildTimelineFromProject(project)
  project.timeline.version = 4
  project.stage = 'timeline'
  markStage(project, 'blueprint', 'done', '蓝图已确认', 100)
  markStage(project, 'outline', 'done', '12 镜剧本与节拍', 100)
  markStage(project, 'storyboard', 'done', '12 镜已就位', 100)
  markStage(project, 'visuals', images.length ? 'done' : 'ready', images.length ? '12 镜全部有画面' : '等待生成画面', images.length ? 100 : 0)
  markStage(project, 'voice', 'done', '7 段对白已配音', 100)
  markStage(project, 'music', 'done', '配乐与音效已就位', 100)
  markStage(project, 'timeline', 'done', '时间线 v4 · 96 秒', 100)
  markStage(project, 'review', 'ready', '可以运行检查', 0)
  if (dir) {
    attachDeliveryFromFile(store, project, dir, 'demo-draft.mp4', '样例动态分镜草稿 · 96 秒', 'mp4')
    if (project.deliveries.length) markStage(project, 'delivery', 'done', '样例草稿已就绪', 100)
    else markStage(project, 'delivery', 'ready', '可以合成草稿', 0)
  }
  if (dir) attachDeliveryFromFile(store, project, dir, 'demo-draft-poster.jpg', '成片预览帧', 'cover')
  project.runtime.imageModelNote = dir ? '样例画面（随包）' : '未配置'
  project.runtime.videoModelNote = dir ? '可按镜升级为视频' : '未配置'
  project.runtime.textModelNote = '示例蓝图'
  project.messages.push(
    {
      id: studioId('msg'),
      role: 'assistant',
      text: '这是《逆行的伞》的完整样例：蓝图、12 镜、配音、配乐和时间线都已经就位。你可以直接播放、拖动片段，或说“镜 03 慢 20%，雨声压低一点”试试大白话改片。',
      createdAt: nowMs()
    },
    {
      id: studioId('msg'),
      role: 'user',
      text: '先把雨丝方向统一，再重做镜 07。不要改脸。',
      createdAt: nowMs() + 1
    },
    {
      id: studioId('msg'),
      role: 'assistant',
      text: '我把这句话拆成了 3 个动作：统一雨向、锁定角色 R2 的面部、只重做镜 07。确认后才会重做，旧候选会保留。',
      createdAt: nowMs() + 2
    }
  )
  store.save(project, '初始化样例 · 逆行的伞', { snapshot: false })
  try { store.writeVersion(store.readProject(project.id), '初始化样例 · 逆行的伞') } catch { /* ignore */ }
  return project
}

function seedNovel(store: StudioStore, dir: string | null): StudioProject {
  const project = store.newProject({
    kind: 'novel',
    title: '雨伞铺的第七个夏天',
    logline: '一个修伞的女孩继承外婆的伞铺，每周三都会有一个失忆的少年，来修同一把黑伞。',
    brief: {
      form: '精制',
      genre: '都市奇幻',
      audience: '喜欢慢热人物故事的长篇读者',
      tone: '克制、潮湿、温柔',
      style: '旧城梅雨、纸张与铁锈的气味',
      aspect: '16:9',
      constraints: ['林晚视角为主', '外婆只以声音与旧物出现', '不解释时间旅行的原理'],
      targetWords: 300_000
    },
    demo: true
  })
  const demo = demoCharacters(project, dir, store)
  const blueprint = demoNovelBlueprint()
  blueprint.approved = true
  blueprint.approvedAt = nowMs()
  blueprint.outlineModel = '随包样例'
  blueprint.characters = demo.characters
  blueprint.places = demo.places
  blueprint.styleBible = demo.styleBible
  applyBlueprintToProject(project, blueprint)
  project.blueprint = { ...blueprint }
  project.title = '雨伞铺的第七个夏天'
  const novelChapters = demoNovelChapters()
  for (const [index, chapter] of project.chapters.entries()) {
    const content = novelChapters[index]
    if (!content) continue
    chapter.content = content
    chapter.wordTarget = 2200
    chapter.status = 'done'
    chapter.locked = true
    chapter.updatedAt = nowMs()
    chapter.revision = 1
  }
  const seventh = project.chapters[6]
  if (seventh?.content) {
    const demoCandidate = demoNovelCandidate()
    seventh.candidates.push({
      id: studioId('cand'),
      content: demoCandidate,
      label: '示例候选 · 更克制',
      source: 'import',
      note: '随包示例：把“熟悉的”改成“刚刚熄灭的”，与第 3 章呼应',
      createdAt: nowMs(),
      wordCount: countWords(demoCandidate)
    })
  }
  const chapterThree = project.chapters[2]
  if (chapterThree && seventh) {
    project.facts.push(
      {
        id: studioId('fact'),
        subject: '黑伞的伞骨',
        predicate: '材质',
        object: '第 3 章写的是竹制伞骨',
        chapterId: chapterThree.id,
        confidence: 0.82,
        source: 'manual',
        createdAt: nowMs()
      },
      {
        id: studioId('fact'),
        subject: '黑伞的伞骨',
        predicate: '材质',
        object: '第 7 章写成了铁骨',
        chapterId: seventh.id,
        confidence: 0.72,
        source: 'manual',
        createdAt: nowMs()
      }
    )
  }
  if (dir) {
    const cover = addDemoAsset(store, project, dir, 'novel-cover.jpg', '《雨伞铺的第七个夏天》封面', ['cover', 'demo'])
    if (cover) project.coverAssetId = cover.id
    const linwan = addDemoAsset(store, project, dir, 'ref-linwan.jpg', '人物参考 · 林晚', ['reference', 'character', 'demo'])
    const boy = addDemoAsset(store, project, dir, 'ref-boy.jpg', '人物参考 · 少年', ['reference', 'character', 'demo'])
    if (linwan) project.characters[0].refAssetIds = [linwan.id]
    if (boy) project.characters[1].refAssetIds = [boy.id]
  }
  project.stage = 'writing'
  markStage(project, 'blueprint', 'done', '蓝图已确认', 100)
  markStage(project, 'outline', 'done', '三卷 36 章大纲已建立', 100)
  markStage(project, 'writing', 'review', '7/36 章完成，第 7 章有候选待采用', 19)
  markStage(project, 'visuals', 'ready', '可以为章节规划配图', 0)
  markStage(project, 'review', 'ready', '可以检查人物与事实', 0)
  markStage(project, 'delivery', 'ready', '初稿完成度还不够，先继续写', 0)
  project.runtime.textModelNote = '随包示例 + 手写样例'
  project.messages.push({
    id: studioId('msg'),
    role: 'assistant',
    text: '《雨伞铺的第七个夏天》已经写到第 7 章。第 3 章说“竹制伞骨”，第 7 章却出现“铁骨”——我在事实里标了提醒，你可以决定是设定变更，还是少年带来的另一把伞。',
    createdAt: nowMs()
  })
  store.save(project, '初始化样例 · 雨伞铺的第七个夏天', { snapshot: false })
  try { store.writeVersion(store.readProject(project.id), '初始化样例 · 雨伞铺的第七个夏天') } catch { /* ignore */ }
  return project
}

function seedShort(store: StudioStore, dir: string | null): StudioProject {
  const project = store.newProject({
    kind: 'short',
    title: '雨停之前',
    logline: '一个修伞的女孩在雨停之前，收到七年前寄出的一封信；写信的人已经不在，但伞还在。',
    brief: {
      form: '速成草稿',
      genre: '都市奇幻',
      audience: '喜欢温柔短篇的读者',
      tone: '克制、安静、最后有一点亮',
      style: '旧城、雨声、伞面与信纸',
      aspect: '16:9',
      constraints: ['第一人称限知', '外婆不直接出场', '结尾不解释时间规则'],
      targetWords: 19_200
    },
    demo: true
  })
  const demo = demoCharacters(project, dir, store)
  const blueprint = demoShortBlueprint()
  blueprint.approved = true
  blueprint.approvedAt = nowMs()
  blueprint.outlineModel = '随包样例'
  blueprint.characters = demo.characters
  blueprint.places = demo.places
  blueprint.styleBible = demo.styleBible
  applyBlueprintToProject(project, blueprint)
  project.blueprint = { ...blueprint }
  project.title = '雨停之前'
  const shortChapters = demoShortChapters()
  for (const [index, chapter] of project.chapters.entries()) {
    const content = shortChapters[index]
    if (!content) continue
    chapter.wordTarget = 1600
    chapter.content = content
    chapter.status = 'done'
    chapter.locked = true
    chapter.updatedAt = nowMs()
  }
  if (dir) {
    const cover = addDemoAsset(store, project, dir, 'short-cover.jpg', '《雨停之前》封面', ['cover', 'demo'])
    if (cover) project.coverAssetId = cover.id
  }
  project.stage = 'delivery'
  markStage(project, 'blueprint', 'done', '蓝图已确认', 100)
  markStage(project, 'outline', 'done', '12 章大纲已建立', 100)
  markStage(project, 'writing', 'done', '12 章初稿完成', 100)
  markStage(project, 'review', 'done', '章节完整', 100)
  markStage(project, 'delivery', 'ready', '可导出 TXT / EPUB / PDF', 0)
  project.runtime.textModelNote = '随包示例 + 手写样例'
  project.messages.push({
    id: studioId('msg'),
    role: 'assistant',
    text: '《雨停之前》12 章已经写完。可以直接导出，也可以去写作台逐章润色；候选稿不会覆盖你手改的正文。',
    createdAt: nowMs()
  })
  store.save(project, '初始化样例 · 雨停之前', { snapshot: false })
  try {
    exportTxt(store.readProject(project.id))
  } catch {
    // 文本导出失败不影响样例打开
  }
  try { store.writeVersion(store.readProject(project.id), '初始化样例 · 雨停之前') } catch { /* ignore */ }
  return project
}

/** 同步播种：素材只从随包目录复制，不访问网络。 */
export function ensureDemoProjects(store: StudioStore): void {
  const marker = join(store.root, '.demo-seeded-v1')
  if (existsSync(marker)) return
  const dir = demoAssetDir()
  try {
    seedDrama(store, dir)
    seedNovel(store, dir)
    seedShort(store, dir)
    writeFileSync(marker, `${JSON.stringify({ seededAt: new Date().toISOString(), assets: Boolean(dir) })}\n`, 'utf8')
  } catch {
    // 单个样例失败不阻断创作台；下次打开会重试
  }
}

export interface RenderOptions {
  quality: 'draft' | 'final'
  subtitleMode: 'soft' | 'burn'
  aspect?: '16:9' | '9:16' | '1:1'
  allowMissing?: boolean
  format?: 'mp4' | 'mov' | 'mkv' | 'webm'
  resolution?: '1080p' | '2160p'
  onProgress?: (stage: string, percent?: number) => void
  signal?: AbortSignal
}

export interface RenderResult {
  path: string
  format: 'mp4' | 'mov' | 'mkv' | 'webm'
  durationSec: number
  width: number
  height: number
  bytes: number
  missingShots: number[]
  placeholders: number
  burnedSubtitles: boolean
  audioFailures: Array<{ label: string; detail: string }>
  message: string
}

interface FfmpegPaths {
  ffmpeg: string
  ffprobe: string
}

export function resolveFfmpegPaths(): FfmpegPaths | null {
  const settings = getSettingsStore().get().mediaEngine
  const configured = settings.ffmpegPath?.trim()
  if (configured) {
    const binary = statSync(configured, { throwIfNoEntry: false })?.isDirectory()
      ? join(configured, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
      : configured
    if (!existsSync(binary)) return null
    const probe = join(dirname(binary), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    return { ffmpeg: binary, ffprobe: existsSync(probe) ? probe : process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe' }
  }
  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(finder, ['ffmpeg'], { encoding: 'utf8', windowsHide: true })
  const found =
    result.status === 0
      ? (result.stdout ?? '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
      : undefined
  if (!found) return null
  const probe = join(dirname(found), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  return { ffmpeg: found, ffprobe: existsSync(probe) ? probe : process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe' }
}

function targetSize(
  aspect: '16:9' | '9:16' | '1:1',
  quality: 'draft' | 'final',
  resolution: '1080p' | '2160p' = '1080p'
): { width: number; height: number } {
  if (quality === 'draft') {
    if (aspect === '9:16') return { width: 540, height: 960 }
    if (aspect === '1:1') return { width: 720, height: 720 }
    return { width: 960, height: 540 }
  }
  const uhd = resolution === '2160p'
  if (aspect === '9:16') return uhd ? { width: 2160, height: 3840 } : { width: 1080, height: 1920 }
  if (aspect === '1:1') return uhd ? { width: 2160, height: 2160 } : { width: 1080, height: 1080 }
  return uhd ? { width: 3840, height: 2160 } : { width: 1920, height: 1080 }
}

async function runFfmpeg(binary: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('已取消。'))
      return
    }
    const child = spawn(binary, args, { cwd: options.cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
      }
      reject(new Error('合成超时；请降低画质或缩短成片后重试。'))
    }, options.timeoutMs ?? 20 * 60_000)
    const abort = (): void => {
      if (settled) return
      try {
        child.kill('SIGKILL')
      } catch {
      }
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      reject(new Error(`无法启动 FFmpeg：${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      if (options.signal?.aborted) {
        reject(new Error('已取消。'))
        return
      }
      if (code === 0) resolvePromise({ stdout, stderr })
      else {
        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-6).join('\n')
        reject(new Error(`FFmpeg 退出码 ${code}：${tail || '未知错误'}`))
      }
    })
  })
}

function fadeFilter(clip: StudioClip, duration: number): string {
  const fade = Math.min(0.32, duration / 5)
  if (clip.transition === 'fade-both') return `,fade=t=in:st=0:d=${fade.toFixed(3)},fade=t=out:st=${Math.max(0, duration - fade).toFixed(3)}:d=${fade.toFixed(3)}`
  if (clip.transition === 'fade-in') return `,fade=t=in:st=0:d=${fade.toFixed(3)}`
  if (clip.transition === 'fade-out') return `,fade=t=out:st=${Math.max(0, duration - fade).toFixed(3)}:d=${fade.toFixed(3)}`
  return ''
}

function videoEncodeArgs(): string[] {
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an']
}

async function renderVisualSegment(input: {
  ffmpeg: string
  project: StudioProject
  clip: StudioClip | null
  duration: number
  index: number
  width: number
  height: number
  fps: number
  draft: boolean
  tempDir: string
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}): Promise<{ file: string; placeholder: boolean }> {
  const { ffmpeg, project, clip, duration, index, width, height, fps, tempDir } = input
  const file = join(tempDir, `segment-${String(index).padStart(4, '0')}.mp4`)
  if (!clip) {
    await runFfmpeg(
      ffmpeg,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=0x10141a:s=${width}x${height}:r=${fps}`,
        '-t',
        String(duration),
        ...videoEncodeArgs(),
        file
      ],
      { signal: input.signal }
    )
    return { file, placeholder: true }
  }
  const asset = project.assets.find((item) => item.id === clip.assetId)
  if (!asset) {
    await runFfmpeg(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x10141a:s=${width}x${height}:r=${fps}`, '-t', String(duration), ...videoEncodeArgs(), file],
      { signal: input.signal }
    )
    return { file, placeholder: true }
  }
  const absolute = getStudioStore().assetAbsolute(project, asset)
  if (!existsSync(absolute)) {
    await runFfmpeg(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x10141a:s=${width}x${height}:r=${fps}`, '-t', String(duration), ...videoEncodeArgs(), file],
      { signal: input.signal }
    )
    return { file, placeholder: true }
  }
  const fade = fadeFilter(clip, duration)
  if (asset.kind === 'image') {
    const zoomW = Math.round(width * 1.1)
    const zoomH = Math.round(height * 1.1)
    const frames = Math.max(1, Math.round(duration * fps))
    const vf =
      `scale=${zoomW}:${zoomH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${zoomW}:${zoomH},` +
      `zoompan=z='min(zoom+0.00045,1.09)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps},` +
      `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS${fade}`
    await runFfmpeg(
      ffmpeg,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-loop',
        '1',
        '-framerate',
        String(fps),
        '-t',
        String(duration),
        '-i',
        absolute,
        '-vf',
        vf,
        '-r',
        String(fps),
        '-frames:v',
        String(frames),
        ...videoEncodeArgs(),
        file
      ],
      { signal: input.signal }
    )
  } else {
    const speed = Math.max(0.25, Math.min(4, clip.speed || 1))
    const sourceDuration = Math.max(0.2, duration * speed)
    const vf =
      `setpts=(PTS-STARTPTS)/${speed},` +
      `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},fps=${fps},` +
      `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS${fade}`
    await runFfmpeg(
      ffmpeg,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(Math.max(0, clip.srcIn)),
        '-t',
        String(sourceDuration + 0.5),
        '-i',
        absolute,
        '-vf',
        vf,
        '-r',
        String(fps),
        '-t',
        String(duration),
        ...videoEncodeArgs(),
        file
      ],
      { signal: input.signal }
    )
  }
  input.onProgress?.(1)
  return { file, placeholder: false }
}

function atempoChain(speed: number): string[] {
  const rate = Math.max(0.25, Math.min(4, speed))
  if (rate >= 0.5 && rate <= 2) return [`atempo=${rate}`]
  if (rate > 2) return ['atempo=2', `atempo=${rate / 2}`]
  return ['atempo=0.5', `atempo=${rate / 0.5}`]
}

async function renderAudioClip(input: {
  ffmpeg: string
  project: StudioProject
  clip: StudioClip
  track: StudioTrack | undefined
  totalDuration: number
  tempDir: string
  index: number
  signal?: AbortSignal
}): Promise<string | null> {
  const { ffmpeg, project, clip, track } = input
  const asset = clip.assetId ? project.assets.find((item) => item.id === clip.assetId) : undefined
  if (!asset || asset.kind !== 'audio') return null
  const absolute = getStudioStore().assetAbsolute(project, asset)
  if (!existsSync(absolute)) return null
  if (track?.muted) return null
  const duration = Math.max(0.1, clip.duration)
  const volume = Math.max(0, Math.min(4, clip.volume * (track?.volume ?? 1)))
  const file = join(input.tempDir, `audio-${String(input.index).padStart(4, '0')}.wav`)
  const filters: string[] = []
  const sourceDuration = clip.loop ? duration : Math.max(0.1, duration * (clip.speed || 1) + 0.15)
  filters.push(`atrim=0:${sourceDuration.toFixed(3)}`, 'asetpts=PTS-STARTPTS')
  if (Math.abs((clip.speed || 1) - 1) > 0.01) filters.push(...atempoChain(clip.speed || 1))
  filters.push(`atrim=0:${duration.toFixed(3)}`, 'asetpts=PTS-STARTPTS')
  filters.push(`volume=${volume.toFixed(3)}`)
  filters.push(`adelay=${Math.round(Math.max(0, clip.start) * 1000)}|${Math.round(Math.max(0, clip.start) * 1000)}`)
  filters.push(`apad=whole_dur=${input.totalDuration.toFixed(3)}`)
  filters.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo')
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  if (clip.loop) args.push('-stream_loop', '-1')
  args.push('-ss', String(Math.max(0, clip.srcIn)), '-i', absolute, '-af', filters.filter(Boolean).join(','), '-t', input.totalDuration.toFixed(3), '-c:a', 'pcm_s16le', file)
  await runFfmpeg(ffmpeg, args, { signal: input.signal })
  return file
}

export async function renderProject(project: StudioProject, options: RenderOptions): Promise<RenderResult> {
  const ffmpegPaths = resolveFfmpegPaths()
  if (!ffmpegPaths) {
    throw new Error('找不到 FFmpeg。请到设置 → 多媒体选择 ffmpeg.exe，或安装 FFmpeg 后重试。工程包导出不受影响。')
  }
  const store = getStudioStore()
  const timeline = project.timeline
  const aspect = options.aspect ?? timeline.aspect ?? project.brief.aspect
  const format = options.format ?? 'mp4'
  const { width, height } = targetSize(aspect, options.quality, options.resolution ?? '1080p')
  const fps = timeline.fps || 30
  const totalDuration = Math.max(1, timelineDuration(timeline))
  const visualClips = timeline.clips
    .filter((clip) => clip.kind === 'video')
    .filter((clip) => !timeline.tracks.find((track) => track.id === clip.trackId)?.muted)
    .sort((a, b) => a.start - b.start)
  if (!visualClips.length) {
    throw new Error('时间线上还没有任何画面。先生成或导入分镜图，再装配时间线后合成。')
  }
  const missingShots = project.shots.filter((shot) => !shot.imageAssetId && !shot.videoAssetId).map((shot) => shot.number)
  if (missingShots.length && !options.allowMissing) {
    throw new Error(`还有 ${missingShots.length} 个镜头没有画面：${missingShots.slice(0, 8).join('、')}${missingShots.length > 8 ? '…' : ''}。请先补齐，或选择“仅合成已有镜头”。`)
  }
  const tempDir = join(store.tempDir(project.id), `render-${Date.now().toString(36)}`)
  mkdirSync(tempDir, { recursive: true })
  const exportsDir = store.exportsDir(project.id)
  mkdirSync(exportsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const outputName = `${project.title.replace(/[\\/:*?"<>|]/g, '')}-${options.quality === 'draft' ? '草稿' : '成片'}-${stamp}.${format}`
  const output = join(exportsDir, outputName)
  const started = Date.now()
  try {
    // 用时间线空档补齐黑色占位，保证音频/字幕不被压缩错位。
    const units: Array<{ clip: StudioClip | null; duration: number }> = []
    let cursor = 0
    for (const clip of visualClips) {
      if (clip.start > cursor + 0.02) units.push({ clip: null, duration: clip.start - cursor })
      units.push({ clip, duration: Math.max(0.1, clip.duration) })
      cursor = Math.max(cursor, clip.start + clip.duration)
    }
    if (totalDuration > cursor + 0.02) units.push({ clip: null, duration: totalDuration - cursor })
    let placeholders = 0
    options.onProgress?.('准备画面', 2)
    const segments: string[] = []
    for (const [index, unit] of units.entries()) {
      if (options.signal?.aborted) throw new Error('已取消。')
      const segment = await renderVisualSegment({
        ffmpeg: ffmpegPaths.ffmpeg,
        project,
        clip: unit.clip,
        duration: unit.duration,
        index,
        width,
        height,
        fps,
        draft: options.quality === 'draft',
        tempDir,
        signal: options.signal,
        onProgress: () => undefined
      })
      segments.push(segment.file)
      if (segment.placeholder) placeholders += 1
      options.onProgress?.(`画面 ${index + 1}/${units.length}`, 3 + Math.round(((index + 1) / units.length) * 52))
    }
    const listFile = join(tempDir, 'concat.txt')
    writeFileSync(listFile, segments.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
    const silentVideo = join(tempDir, 'video.mp4')
    options.onProgress?.('拼接画面', 58)
    try {
      await runFfmpeg(ffmpegPaths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', silentVideo], {
        signal: options.signal,
        timeoutMs: 10 * 60_000
      })
    } catch {
      await runFfmpeg(ffmpegPaths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silentVideo], {
        signal: options.signal,
        timeoutMs: 15 * 60_000
      })
    }
    options.onProgress?.('混音', 64)
    const audioTracks = new Map(timeline.tracks.map((track) => [track.id, track]))
    const audioClips = timeline.clips
      .filter((clip) => clip.kind === 'dialogue' || clip.kind === 'music' || clip.kind === 'sfx')
      .sort((a, b) => a.start - b.start)
    const audioFiles: string[] = []
    const audioFailures: Array<{ label: string; detail: string }> = []
    for (const [index, clip] of audioClips.entries()) {
      if (options.signal?.aborted) throw new Error('已取消。')
      try {
        const file = await renderAudioClip({
          ffmpeg: ffmpegPaths.ffmpeg,
          project,
          clip,
          track: audioTracks.get(clip.trackId),
          totalDuration,
          tempDir,
          index,
          signal: options.signal
        })
        if (file) audioFiles.push(file)
      } catch (err) {
        if (options.signal?.aborted) throw err
        // 单个音频失败不阻断成片；交给服务层决定是否降级为“需核对”
        audioFailures.push({
          label: clip.label,
          detail: err instanceof Error ? err.message : String(err)
        })
      }
      options.onProgress?.(`音频 ${index + 1}/${audioClips.length}`, 64 + Math.round(((index + 1) / Math.max(1, audioClips.length)) * 18))
    }
    const mixedAudio = join(tempDir, 'mix.wav')
    options.onProgress?.('响度标准化', 84)
    if (audioFiles.length === 0) {
      await runFfmpeg(ffmpegPaths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', String(totalDuration), '-c:a', 'pcm_s16le', mixedAudio], { signal: options.signal })
    } else if (audioFiles.length === 1) {
      await runFfmpeg(ffmpegPaths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', audioFiles[0], '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-t', String(totalDuration), mixedAudio], { signal: options.signal })
    } else {
      const inputs = audioFiles.flatMap((file) => ['-i', file])
      const labels = audioFiles.map((_, index) => `[${index}:a]`).join('')
      const filter = `${labels}amix=inputs=${audioFiles.length}:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[out]`
      await runFfmpeg(ffmpegPaths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-t', String(totalDuration), mixedAudio], { signal: options.signal })
    }
    // 字幕
    const subtitles = timeline.clips.filter((clip) => clip.kind === 'subtitle' && (clip.text ?? '').trim())
    const burn = options.subtitleMode === 'burn'
    let assFile = ''
    let srtFile = ''
    if (subtitles.length) {
      assFile = join(tempDir, 'subs.ass')
      srtFile = join(tempDir, 'subs.srt')
      writeFileSync(assFile, toAss(timeline), 'utf8')
      writeFileSync(srtFile, toSrt(timeline), 'utf8')
    }
    options.onProgress?.('封装成片', 90)
    const videoArgs =
      format === 'webm'
        ? ['-c:v', 'libvpx-vp9', '-crf', options.quality === 'draft' ? '38' : '30', '-b:v', '0', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', options.quality === 'draft' ? '23' : '20', '-pix_fmt', 'yuv420p']
    const audioArgs = format === 'webm' ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '192k']
    const containerArgs = format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : []
    const subtitleArgs = format === 'mkv' ? ['-c:s', 'srt'] : format === 'webm' ? ['-c:s', 'webvtt'] : ['-c:s', 'mov_text']
    if (burn && subtitles.length) {
      await runFfmpeg(
        ffmpegPaths.ffmpeg,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          silentVideo,
          '-i',
          mixedAudio,
          '-vf',
          'subtitles=subs.ass',
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          ...videoArgs,
          ...audioArgs,
          '-t',
          String(totalDuration),
          ...containerArgs,
          output
        ],
        { cwd: tempDir, signal: options.signal, timeoutMs: 30 * 60_000 }
      )
    } else if (subtitles.length) {
      await runFfmpeg(
        ffmpegPaths.ffmpeg,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          silentVideo,
          '-i',
          mixedAudio,
          '-i',
          srtFile,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-map',
          '2:s:0',
          ...videoArgs,
          ...audioArgs,
          ...subtitleArgs,
          '-metadata:s:s:0',
          'language=chi',
          '-t',
          String(totalDuration),
          ...containerArgs,
          output
        ],
        { signal: options.signal, timeoutMs: 20 * 60_000 }
      )
    } else {
      await runFfmpeg(
        ffmpegPaths.ffmpeg,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          silentVideo,
          '-i',
          mixedAudio,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          ...videoArgs,
          ...audioArgs,
          '-t',
          String(totalDuration),
          ...containerArgs,
          output
        ],
        { signal: options.signal, timeoutMs: 20 * 60_000 }
      )
    }
    if (!existsSync(output)) throw new Error('合成结束但没有找到输出文件。')
    const bytes = statSync(output).size
    options.onProgress?.('完成', 100)
    const elapsed = Math.round((Date.now() - started) / 1000)
    return {
      path: output,
      format,
      durationSec: totalDuration,
      width,
      height,
      bytes,
      missingShots,
      placeholders,
      burnedSubtitles: burn && subtitles.length > 0,
      audioFailures,
      message: `已合成 ${formatDuration(totalDuration)} · ${width}×${height} · ${(bytes / 1024 / 1024).toFixed(1)}MB · 用时 ${elapsed}s${missingShots.length ? ` · ${missingShots.length} 镜缺画面` : ''}${audioFailures.length ? ` · ${audioFailures.length} 段音频未合成` : ''}`
    }
  } finally {
    if (process.env.MORROW_KEEP_RENDER_TEMP !== '1') {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
      }
    }
  }
}

/** 从成片抽一帧，作为交付预览图（可选，不阻断合成）。 */
export async function extractPoster(videoPath: string, atSec: number, outputPath: string): Promise<boolean> {
  const paths = resolveFfmpegPaths()
  if (!paths) return false
  try {
    await runFfmpeg(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, atSec)), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outputPath], { timeoutMs: 60_000 })
    return existsSync(outputPath)
  } catch {
    return false
  }
}

export interface FfmpegCapabilities {
  available: boolean
  codecs: string[]
  profile: 'default' | 'enhanced' | 'missing'
}

/** 读取本机 FFmpeg 的编码器能力，区分可交付的默认包与增强包。 */
export function ffmpegCapabilities(): FfmpegCapabilities {
  const paths = resolveFfmpegPaths()
  if (!paths) return { available: false, codecs: [], profile: 'missing' }
  const result = spawnSync(paths.ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  if (result.status !== 0) return { available: false, codecs: [], profile: 'missing' }
  const encoders = new Set((result.stdout ?? '').split(/\s+/))
  const codecs = ['libx264', 'libx265', 'libvpx-vp9', 'aac', 'libmp3lame', 'libopus'].filter((name) => encoders.has(name))
  return {
    available: true,
    codecs,
    profile: codecs.includes('libx264') && codecs.includes('libx265') && codecs.includes('libvpx-vp9') && codecs.includes('libmp3lame') ? 'enhanced' : 'default'
  }
}

let exportFontCss: string | null | undefined

/** 找到带 Noto Serif SC @font-face 的随包样式；离线导出不依赖系统字体。 */
export function bundledExportFontStylesheet(): string | null {
  if (exportFontCss !== undefined) return exportFontCss
  exportFontCss = null
  try {
    const assets = join(app.getAppPath(), 'out', 'renderer', 'assets')
    for (const name of readdirSync(assets)) {
      if (!name.endsWith('.css')) continue
      const file = join(assets, name)
      const css = readFileSync(file, 'utf8')
      if (css.includes('@font-face') && css.includes('noto-serif-sc')) {
        exportFontCss = pathToFileURL(file).href
        break
      }
    }
  } catch {
    // 开发态未构建或资源缺失时保留系统字体回退
  }
  return exportFontCss
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export function cleanFileName(value: string, fallback = '未命名'): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim()
  return (cleaned || fallback).slice(0, 80)
}

function chapterParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+$/g, '').trim())
    .filter(Boolean)
}

type BookBlock = { kind: 'paragraph'; text: string } | { kind: 'illustration'; asset: StudioAsset; caption: string }

function chapterBlocks(project: StudioProject, chapter: StudioChapter): BookBlock[] {
  const paragraphs = chapterParagraphs(chapter.content)
  const illustrations = chapter.illustrations
    .map((item) => ({ item, asset: project.assets.find((asset) => asset.id === item.assetId) }))
    .filter((entry): entry is { item: StudioChapter['illustrations'][number]; asset: StudioAsset } => Boolean(entry.asset))
  const blocks: BookBlock[] = []
  for (let index = 0; index <= paragraphs.length; index += 1) {
    if (index > 0) blocks.push({ kind: 'paragraph', text: paragraphs[index - 1] })
    for (const { item, asset } of illustrations) {
      if (Math.max(0, Math.min(paragraphs.length, item.afterParagraph)) === index) {
        blocks.push({ kind: 'illustration', asset, caption: item.caption?.trim() || asset.title })
      }
    }
  }
  return blocks
}

function imageContentType(ext: string): string {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/png'
}

function illustrationBytes(project: StudioProject, asset: StudioAsset): Buffer | null {
  try {
    const path = getStudioStore().assetAbsolute(project, asset)
    if (!existsSync(path) || statSync(path).size > 16 * 1024 * 1024) return null
    return readFileSync(path)
  } catch {
    return null
  }
}

function bookMeta(project: StudioProject): { title: string; author: string; words: number; intro: string } {
  return {
    title: project.title || '未命名作品',
    author: 'Morrow 创作台',
    words: project.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0),
    intro: project.logline
  }
}

function saveDelivery(project: StudioProject, input: Omit<StudioDelivery, 'id' | 'createdAt' | 'bytes' | 'sha256' | 'path'> & { path: string; bytes: number; sha256: string }): StudioDelivery {
  const delivery: StudioDelivery = {
    ...input,
    id: studioId('delivery'),
    bytes: input.bytes,
    sha256: input.sha256,
    createdAt: nowMs()
  }
  const existing = project.deliveries.findIndex((item) => item.path === delivery.path)
  if (existing >= 0) project.deliveries.splice(existing, 1)
  project.deliveries.unshift(delivery)
  return delivery
}

export function writeDeliveryFile(projectId: string, fileName: string, content: string | Buffer, label: string, kind: StudioDelivery['kind'], meta?: StudioDelivery['meta']): StudioDelivery {
  const store = getStudioStore()
  const project = store.readProject(projectId)
  const dir = store.exportsDir(projectId)
  mkdirSync(dir, { recursive: true })
  const path = join('exports', fileName)
  const absolute = join(dir, fileName)
  writeFileSync(absolute, content)
  const bytes = statSync(absolute).size
  const sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex')
  const delivery = saveDelivery(project, { kind, label, path, bytes, sha256, ...(meta ? { meta } : {}) })
  project.updatedAt = nowMs()
  store.savePassive(project)
  return delivery
}

function chaptersMarkdown(project: StudioProject): string {
  const meta = bookMeta(project)
  const lines = [`# ${meta.title}`, '', meta.intro, '', '---', '']
  for (const chapter of [...project.chapters].sort((a, b) => a.number - b.number)) {
    lines.push(`## ${chapter.title}`, '')
    if (chapter.content.trim()) lines.push(chapter.content.trim(), '')
    else lines.push('（本章尚未写作）', '')
  }
  return `${lines.join('\n')}\n`
}

function chaptersText(project: StudioProject): string {
  const meta = bookMeta(project)
  const lines = [meta.title, '', meta.intro, '', '='.repeat(32), '']
  for (const chapter of [...project.chapters].sort((a, b) => a.number - b.number)) {
    lines.push(chapter.title, '')
    lines.push(chapter.content.trim() || '（本章尚未写作）', '')
  }
  return lines.join('\n')
}

export function exportTxt(project: StudioProject): StudioDelivery {
  const name = `${cleanFileName(project.title)}.txt`
  return writeDeliveryFile(project.id, name, chaptersText(project), '纯文本稿', 'txt', { words: bookMeta(project).words })
}

export function exportMarkdown(project: StudioProject): StudioDelivery {
  const name = `${cleanFileName(project.title)}.md`
  return writeDeliveryFile(project.id, name, chaptersMarkdown(project), 'Markdown 稿', 'md', { words: bookMeta(project).words })
}

export async function exportEpub(project: StudioProject): Promise<StudioDelivery> {
  const meta = bookMeta(project)
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  )
  const css = `@charset "utf-8";
html, body { margin: 0; padding: 0; }
body { font-family: "Noto Serif SC", "Songti SC", SimSun, serif; line-height: 1.95; color: #1b1a17; background: #fffaf0; }
h1 { font-size: 1.8em; margin: 2.4em 0 1.2em; font-weight: 500; }
h2 { font-size: 1.35em; margin: 2.2em 0 0.9em; font-weight: 500; }
p { text-indent: 2em; margin: 0 0 0.9em; }
figure { margin: 1.4em 0; text-align: center; page-break-inside: avoid; }
figure img { max-width: 100%; height: auto; }
figcaption { margin-top: 0.5em; color: #6b675f; font-size: 0.85em; text-align: center; }
.cover { text-align: center; padding: 14% 8%; }
.cover .kicker { letter-spacing: 0.3em; font-size: 0.8em; opacity: 0.55; }
.cover h1 { font-size: 2.4em; margin: 0.6em 0; }
.cover .intro { text-indent: 0; opacity: 0.7; }
.meta { text-align: center; text-indent: 0; font-size: 0.85em; opacity: 0.55; }
`
  zip.file('OEBPS/style.css', css)
  const coverAsset = project.coverAssetId ? project.assets.find((asset) => asset.id === project.coverAssetId) : undefined
  let coverHref = ''
  if (coverAsset) {
    try {
      const path = getStudioStore().assetAbsolute(project, coverAsset)
      if (existsSync(path)) {
        const ext = extname(path).slice(1).toLowerCase() || 'png'
        coverHref = `cover.${ext}`
        zip.file(`OEBPS/${coverHref}`, readFileSync(path))
      }
    } catch {
      // 封面丢失不阻断成书
    }
  }
  const chapters = [...project.chapters].sort((a, b) => a.number - b.number)
  const chapterFiles: Array<{ id: string; href: string; title: string }> = []
  const imageFiles = new Map<string, { href: string; mediaType: string }>()
  for (const [index, chapter] of chapters.entries()) {
    const href = `chapter-${String(index + 1).padStart(3, '0')}.xhtml`
    const blocks = chapterBlocks(project, chapter)
    const bodyParts: string[] = []
    for (const block of blocks) {
      if (block.kind === 'paragraph') {
        bodyParts.push(`<p>${escapeXml(block.text)}</p>`)
        continue
      }
      let image = imageFiles.get(block.asset.id)
      if (!image) {
        const bytes = illustrationBytes(project, block.asset)
        if (!bytes) continue
        const ext = extname(block.asset.path).slice(1).toLowerCase() || 'png'
        const imageHref = `images/${block.asset.id}.${ext}`
        zip.file(`OEBPS/${imageHref}`, bytes)
        image = { href: imageHref, mediaType: imageContentType(ext) }
        imageFiles.set(block.asset.id, image)
      }
      bodyParts.push(`<figure class="illustration"><img src="${image.href}" alt="${escapeXml(block.caption)}"/><figcaption>${escapeXml(block.caption)}</figcaption></figure>`)
    }
    const body = bodyParts.length ? bodyParts.join('\n') : '<p class="meta">本章尚未写作。</p>'
    zip.file(
      `OEBPS/${href}`,
      `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>${escapeXml(chapter.title)}</title><link rel="stylesheet" href="style.css"/></head>
<body><h2>${escapeXml(chapter.title)}</h2>${body}</body></html>`
    )
    chapterFiles.push({ id: `ch${index + 1}`, href, title: chapter.title })
  }
  zip.file(
    'OEBPS/cover.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>${escapeXml(meta.title)}</title><link rel="stylesheet" href="style.css"/></head>
<body><div class="cover">
<p class="kicker">MORROW · ${studioKindLabel(project.kind)}</p>
${coverHref ? `<p><img src="${coverHref}" alt="" style="max-width:100%;"/></p>` : ''}
<h1>${escapeXml(meta.title)}</h1>
<p class="intro">${escapeXml(meta.intro)}</p>
<p class="meta">Morrow 创作台 · ${meta.words.toLocaleString('zh-CN')} 字</p>
</div></body></html>`
  )
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title><link rel="stylesheet" href="style.css"/></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>
${chapterFiles.map((file) => `<li><a href="${file.href}">${escapeXml(file.title)}</a></li>`).join('\n')}
</ol></nav></body></html>`
  )
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0" xml:lang="zh-CN">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="bookid">urn:uuid:${project.id}</dc:identifier>
  <dc:title>${escapeXml(meta.title)}</dc:title>
  <dc:creator>Morrow 创作台</dc:creator>
  <dc:language>zh-CN</dc:language>
  <dc:description>${escapeXml(meta.intro)}</dc:description>
  <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
</metadata>
<manifest>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  <item id="css" href="style.css" media-type="text/css"/>
  <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
  ${coverHref ? `<item id="cover-image" href="${coverHref}" media-type="${imageContentType(extname(coverHref).slice(1).toLowerCase())}" properties="cover-image"/>` : ''}
  ${[...imageFiles.entries()].map(([id, image], index) => `<item id="image-${index + 1}" href="${image.href}" media-type="${image.mediaType}"/>`).join('\n  ')}
  ${chapterFiles.map((file) => `<item id="${file.id}" href="${file.href}" media-type="application/xhtml+xml"/>`).join('\n  ')}
</manifest>
<spine>
  <itemref idref="cover"/>
  <itemref idref="nav"/>
  ${chapterFiles.map((file) => `<itemref idref="${file.id}"/>`).join('\n  ')}
</spine>
</package>`
  )
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.epub`, buffer, 'EPUB 电子书', 'epub', { words: meta.words, format: 'EPUB 3' })
}

function xmlParagraphs(content: string): string {
  return chapterParagraphs(content)
    .map((paragraph) => `<w:p><w:pPr><w:ind w:firstLineChars="200" w:firstLine="640"/><w:spacing w:line="380" w:lineRule="auto" w:after="120"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`)
    .join('')
}

export async function exportDocx(project: StudioProject): Promise<StudioDelivery> {
  const meta = bookMeta(project)
  const zip = new JSZip()
  const chapters = [...project.chapters].sort((a, b) => a.number - b.number)
  const imageEntries = new Map<string, { fileName: string; relId: string; ext: string; cx: number; cy: number; bytes: Buffer }>()
  for (const chapter of chapters) {
    for (const block of chapterBlocks(project, chapter)) {
      if (block.kind !== 'illustration' || imageEntries.has(block.asset.id)) continue
      const bytes = illustrationBytes(project, block.asset)
      if (!bytes) continue
      const ext = extname(block.asset.path).slice(1).toLowerCase() || 'png'
      const number = imageEntries.size + 1
      const width = Math.max(320, block.asset.width ?? 1280)
      const height = Math.max(180, block.asset.height ?? 720)
      const scale = Math.min(1, 560 / width)
      imageEntries.set(block.asset.id, {
        fileName: `image-${number}.${ext}`,
        relId: `rIdImg${number}`,
        ext,
        cx: Math.round(width * scale * 9525),
        cy: Math.round(height * scale * 9525),
        bytes
      })
    }
  }
  for (const entry of imageEntries.values()) zip.file(`word/media/${entry.fileName}`, entry.bytes)
  const imageDefaults = [...new Set([...imageEntries.values()].map((entry) => entry.ext))]
    .map((ext) => `<Default Extension="${ext}" ContentType="${imageContentType(ext)}"/>`)
    .join('')
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${imageDefaults}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${[...imageEntries.values()].map((entry) => `<Relationship Id="${entry.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${entry.fileName}"/>`).join('\n')}
</Relationships>`
  )
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:eastAsia="宋体" w:hAnsi="Georgia"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="52"/><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="34"/><w:b/></w:rPr></w:style>
</w:styles>`
  )
  const titleXml = `<w:p><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="center"/><w:spacing w:before="2400" w:after="400"/></w:pPr><w:r><w:t>${escapeXml(meta.title)}</w:t></w:r></w:p>
<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="2000"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/><w:color w:val="666666"/></w:rPr><w:t>${escapeXml(meta.intro)}</w:t></w:r></w:p>`
  const tocXml = `<w:p><w:pPr><w:pageBreakBefore/><w:spacing w:after="360"/></w:pPr><w:r><w:rPr><w:sz w:val="40"/><w:b/></w:rPr><w:t>目录</w:t></w:r></w:p>${chapters.map((chapter, index) => `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:t>${String(index + 1).padStart(2, '0')} · ${escapeXml(chapter.title)}</w:t></w:r></w:p>`).join('')}`
  let drawingId = 0
  const chaptersXml = chapters.map((chapter) => {
    const content = chapterBlocks(project, chapter).map((block) => {
      if (block.kind === 'paragraph') return xmlParagraphs(block.text)
      const image = imageEntries.get(block.asset.id)
      if (!image) return ''
      drawingId += 1
      return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="80"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${image.cx}" cy="${image.cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${drawingId}" name="配图 ${drawingId}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${escapeXml(block.caption)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${image.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${image.cx}" cy="${image.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="280"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="666666"/></w:rPr><w:t>${escapeXml(block.caption)}</w:t></w:r></w:p>`
    }).join('')
    return `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:spacing w:before="600" w:after="240"/><w:pageBreakBefore/></w:pPr><w:r><w:t>${escapeXml(chapter.title)}</w:t></w:r></w:p>${content || '<w:p><w:r><w:t>（本章尚未写作）</w:t></w:r></w:p>'}`
  }).join('')
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${titleXml}${tocXml}${chaptersXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`
  )
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.docx`, buffer, 'Word 排版稿', 'docx', { words: meta.words })
}

function bookHtml(project: StudioProject, coverDataUrl: string | null): string {
  const meta = bookMeta(project)
  const toc = project.chapters.map((chapter) => `<li>${escapeXml(chapter.title)}</li>`).join('')
  const chapters = [...project.chapters]
    .sort((a, b) => a.number - b.number)
    .map((chapter) => {
      const body = chapterBlocks(project, chapter).map((block) => {
        if (block.kind === 'paragraph') return `<p>${escapeXml(block.text)}</p>`
        const bytes = illustrationBytes(project, block.asset)
        if (!bytes) return ''
        const ext = extname(block.asset.path).slice(1).toLowerCase() || 'png'
        const src = `data:${imageContentType(ext)};base64,${bytes.toString('base64')}`
        return `<figure class="illustration"><img src="${src}" alt="${escapeXml(block.caption)}"/><figcaption>${escapeXml(block.caption)}</figcaption></figure>`
      }).join('')
      return `<section class="chapter"><h2>${escapeXml(chapter.title)}</h2>${body || '<p class="empty">（本章尚未写作）</p>'}</section>`
    })
    .join('')
  const fontLink = bundledExportFontStylesheet()
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeXml(meta.title)}</title>
${fontLink ? `<link rel="stylesheet" href="${fontLink}">` : ''}
<style>
@page { size: A4; margin: 22mm 20mm; }
body { margin: 0; color: #1b1a17; background: #fffaf0; font-family: "Newsreader", "Noto Serif SC Variable", "Noto Serif SC", "Songti SC", SimSun, serif; font-size: 11.5pt; line-height: 1.95; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; page-break-after: always; background: radial-gradient(circle at 50% 30%, #f6ecd8, #ede2cc); }
.cover img { max-width: 120mm; max-height: 120mm; object-fit: cover; margin-bottom: 10mm; box-shadow: 0 12px 32px rgba(40,30,10,.18); }
.kicker { letter-spacing: .35em; font-size: 9pt; color: #8a6a3c; }
.cover h1 { font-size: 32pt; font-weight: 500; margin: 6mm 0 4mm; }
.cover .intro { max-width: 120mm; color: #5c574d; font-size: 10.5pt; }
.cover .meta { margin-top: 18mm; color: #8c867a; font-size: 9pt; letter-spacing: .12em; }
.toc { page-break-after: always; padding-top: 18mm; }
.toc h2 { font-size: 18pt; font-weight: 500; margin-bottom: 8mm; }
.toc ol { padding-left: 6mm; color: #3b3831; }
.toc li { margin: 2.4mm 0; }
.chapter { page-break-before: always; }
.chapter h2 { font-size: 17pt; font-weight: 500; margin: 0 0 8mm; }
.chapter p { text-indent: 2em; margin: 0 0 3.2mm; text-align: justify; }
.illustration { margin: 7mm auto; text-align: center; page-break-inside: avoid; }
.illustration img { max-width: 150mm; max-height: 105mm; object-fit: contain; }
.illustration figcaption { margin-top: 2mm; color: #8c867a; font-size: 9pt; text-indent: 0; }
.empty { color: #999; text-indent: 0; }
</style></head><body>
<div class="cover">${coverDataUrl ? `<img src="${coverDataUrl}" alt=""/>` : ''}<p class="kicker">MORROW · ${studioKindLabel(project.kind)}</p><h1>${escapeXml(meta.title)}</h1><p class="intro">${escapeXml(meta.intro)}</p><p class="meta">${meta.words.toLocaleString('zh-CN')} 字 · Morrow 创作台</p></div>
<div class="toc"><h2>目录</h2><ol>${toc}</ol></div>
${chapters}
</body></html>`
}

function coverDataUrl(project: StudioProject): string | null {
  if (!project.coverAssetId) return null
  const asset = project.assets.find((item) => item.id === project.coverAssetId)
  if (!asset) return null
  try {
    const path = getStudioStore().assetAbsolute(project, asset)
    if (!existsSync(path)) return null
    const data = readFileSync(path)
    if (data.length > 12 * 1024 * 1024) return null
    return `data:${asset.mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}

async function printHtmlToPdf(html: string): Promise<Buffer> {
  const temp = join(app.getPath('temp'), `morrow-studio-book-${randomUUID()}.html`)
  writeFileSync(temp, html, 'utf8')
  const wins = BrowserWindow.getAllWindows()
  const parent = wins.find((win) => !win.isDestroyed()) ?? null
  const win = new BrowserWindow({
    show: false,
    width: 960,
    height: 1280,
    ...(parent ? { parent } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadFile(temp)
    await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true).catch(() => undefined)
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    return pdf
  } finally {
    if (!win.isDestroyed()) win.destroy()
    try {
      rmSync(temp, { force: true })
    } catch {
    }
  }
}

export async function exportPdf(project: StudioProject): Promise<StudioDelivery> {
  const pdf = await printHtmlToPdf(bookHtml(project, coverDataUrl(project)))
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.pdf`, pdf, 'PDF 排版稿', 'pdf', { words: bookMeta(project).words, pages: 'A4' })
}

export async function exportCover(project: StudioProject): Promise<StudioDelivery> {
  const store = getStudioStore()
  const existing = project.coverAssetId ? project.assets.find((asset) => asset.id === project.coverAssetId) : undefined
  if (existing) {
    try {
      const source = store.assetAbsolute(project, existing)
      if (existsSync(source)) {
        const ext = extname(source).slice(1) || 'png'
        const name = `${cleanFileName(project.title)}-封面.${ext}`
        const target = join(store.exportsDir(project.id), name)
        mkdirSync(store.exportsDir(project.id), { recursive: true })
        cpSync(source, target)
        const buffer = readFileSync(target)
        return writeDeliveryFile(project.id, name, buffer, '封面', 'cover', { size: `${existing.width ?? ''}×${existing.height ?? ''}` })
      }
    } catch {
      // 继续生成文字封面
    }
  }
  const fontLink = bundledExportFontStylesheet()
  const html = `<!doctype html><html><head><meta charset="utf-8">${fontLink ? `<link rel="stylesheet" href="${fontLink}">` : ''}<style>
html,body { margin:0; width:1200px; height:1600px; background:#0b0d10; color:#ede7da; font-family:"Noto Serif SC Variable","Noto Serif SC","Songti SC",SimSun,serif; }
.wrap { position:relative; width:100%; height:100%; background:radial-gradient(circle at 50% 26%, #27312f 0, #141922 36%, #0b0d10 72%); overflow:hidden; }
.glow { position:absolute; inset:0; background:radial-gradient(circle at 50% 38%, rgba(200,174,125,.24), transparent 46%); }
.line { position:absolute; left:120px; right:120px; top:120px; height:1px; background:rgba(200,174,125,.38); }
.kicker { position:absolute; top:150px; left:120px; font:12px monospace; letter-spacing:.42em; color:#c8ae7d; }
h1 { position:absolute; left:120px; right:120px; top:510px; margin:0; font-size:110px; line-height:1.18; font-weight:400; letter-spacing:.04em; }
.intro { position:absolute; left:124px; right:140px; top:900px; font-size:28px; line-height:1.8; color:#a39d91; }
.foot { position:absolute; left:120px; bottom:130px; font:13px monospace; letter-spacing:.22em; color:#6b675f; }
.corner { position:absolute; right:120px; bottom:120px; width:96px; height:96px; border:1px solid rgba(200,174,125,.25); border-radius:50%; display:flex; align-items:center; justify-content:center; color:#c8ae7d; font-size:32px; }
</style></head><body><div class="wrap"><div class="glow"></div><div class="line"></div><div class="kicker">MORROW · ${studioKindLabel(project.kind)}</div><h1>${escapeXml(project.title)}</h1><div class="intro">${escapeXml(project.logline)}</div><div class="foot">MORROW CREATIVE STUDIO</div><div class="corner">M</div></div></body></html>`
  const temp = join(app.getPath('temp'), `morrow-cover-${randomUUID()}.html`)
  writeFileSync(temp, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await win.loadFile(temp)
    await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true).catch(() => undefined)
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    return writeDeliveryFile(project.id, `${cleanFileName(project.title)}-封面.png`, png, '封面', 'cover', { width: 1200, height: 1600 })
  } finally {
    if (!win.isDestroyed()) win.destroy()
    try {
      rmSync(temp, { force: true })
    } catch {
    }
  }
}

export async function exportPackage(project: StudioProject): Promise<StudioDelivery> {
  const store = getStudioStore()
  const zip = new JSZip()
  const manifest = {
    format: 'morrowcraft',
    schemaVersion: project.schemaVersion,
    id: project.id,
    kind: project.kind,
    title: project.title,
    exportedAt: new Date().toISOString(),
    version: app.getVersion(),
    files: [] as Array<{ path: string; bytes: number; sha256: string }>
  }
  const add = (relative: string, data: Buffer): void => {
    zip.file(relative, data)
    manifest.files.push({ path: relative, bytes: data.length, sha256: sha256Buffer(data) })
  }
  add('project.json', Buffer.from(`${JSON.stringify(project, null, 2)}\n`, 'utf8'))
  for (const asset of project.assets) {
    try {
      const absolute = store.assetAbsolute(project, asset)
      if (existsSync(absolute)) add(asset.path, readFileSync(absolute))
      if (asset.thumbPath) {
        const thumb = join(store.projectDir(project.id), asset.thumbPath)
        if (existsSync(thumb)) add(asset.thumbPath, readFileSync(thumb))
      }
    } catch {
      // 丢失素材只影响工程包内容，不影响其他文件
    }
  }
  add('timeline.json', Buffer.from(`${JSON.stringify(project.timeline, null, 2)}\n`, 'utf8'))
  add('facts.json', Buffer.from(`${JSON.stringify(project.facts, null, 2)}\n`, 'utf8'))
  add('README.txt', Buffer.from(`Morrow 创作台工程包\n\n作品：${project.title}\n类型：${studioKindLabel(project.kind)}\n导出时间：${new Date().toLocaleString('zh-CN')}\n\nproject.json 是可继续编辑的作品文件；assets/ 为按指纹存储的素材；timeline.json 为剪辑表。\n此包不包含模型密钥、账号信息或旧应用数据。\n`, 'utf8'))
  add('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.morrowcraft`, buffer, '创作工程包', 'package', { files: manifest.files.length, schema: project.schemaVersion })
}

export function exportSrt(project: StudioProject): StudioDelivery {
  const cues = project.timeline.clips.filter((clip) => clip.kind === 'subtitle' && (clip.text ?? '').trim())
  if (!cues.length) throw new Error('还没有字幕；先在分镜里生成逐句字幕，再导出 SRT。')
  const content = toSrt(project.timeline).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.srt`, content, '字幕文件 · SRT', 'srt', { clips: cues.length })
}

export function exportAss(project: StudioProject): StudioDelivery {
  const cues = project.timeline.clips.filter((clip) => clip.kind === 'subtitle' && (clip.text ?? '').trim())
  if (!cues.length) throw new Error('还没有字幕；先在分镜里生成逐句字幕，再导出 ASS。')
  return writeDeliveryFile(project.id, `${cleanFileName(project.title)}.ass`, toAss(project.timeline), '字幕文件 · ASS', 'ass', { clips: cues.length })
}

/** 发布套组：成书 + 封面 + 字幕 + 工程包一起放进一个目录。 */
export async function exportFolder(project: StudioProject): Promise<StudioDelivery> {
  const store = getStudioStore()
  const latestVideo = project.deliveries.find((item) => isStudioVideoDelivery(item.kind))
  if (project.kind === 'drama') {
    if (!latestVideo) throw new Error('还没有合成成片；发布套组需要先有一版成片。')
    if (project.stages.timeline.status === 'stale') throw new Error('时间线已过期；先重新装配并合成最新成片，再导出发布套组。')
    const videoPath = store.deliveryAbsolute(project.id, latestVideo)
    if (!existsSync(videoPath)) throw new Error(`成片文件不在本机：${latestVideo.label}。请重新合成后再导出发布套组。`)
  }
  if (project.kind !== 'drama' && !project.chapters.some((chapter) => chapter.content.trim())) throw new Error('还没有正文；先写作再导出发布套组。')
  const stamp = new Date().toISOString().slice(0, 10)
  const folderName = `${cleanFileName(project.title)}-${stamp}`
  const folder = join(store.exportsDir(project.id), folderName)
  mkdirSync(folder, { recursive: true })
  const book = project.kind === 'drama' ? null : await exportEpub(project)
  const cover = await exportCover(project)
  const pkg = await exportPackage(project)
  const copies: string[] = []
  for (const delivery of [book, cover, pkg].filter((item): item is StudioDelivery => Boolean(item))) {
    const source = store.deliveryAbsolute(project.id, delivery)
    if (!existsSync(source)) throw new Error(`发布套组缺少文件：${delivery.label}。请重新导出后再试。`)
    const target = join(folder, basename(source))
    cpSync(source, target)
    copies.push(basename(source))
  }
  if (project.kind === 'drama') {
    if (project.timeline.clips.some((clip) => clip.kind === 'subtitle' && (clip.text ?? '').trim())) {
      const srt = exportSrt(project)
      const ass = exportAss(project)
      for (const delivery of [srt, ass]) {
        const source = store.deliveryAbsolute(project.id, delivery)
        if (!existsSync(source)) throw new Error(`发布套组缺少字幕：${delivery.label}。`)
        cpSync(source, join(folder, basename(source)))
        copies.push(basename(source))
      }
    }
    const latestMp4 = project.deliveries.find((item) => isStudioVideoDelivery(item.kind))
    if (!latestMp4) throw new Error('发布套组缺少成片。')
    const source = store.deliveryAbsolute(project.id, latestMp4)
    if (!existsSync(source)) throw new Error('成片文件不在本机；请重新合成后再导出发布套组。')
    cpSync(source, join(folder, basename(source)))
    copies.push(basename(source))
  }
  writeFileSync(
    join(folder, '交付说明.txt'),
    `${project.title}\n${studioKindLabel(project.kind)} · ${project.logline}\n\n包含：\n${copies.map((name) => `· ${name}`).join('\n')}\n\n生成时间：${new Date().toLocaleString('zh-CN')}\n由 Morrow 创作台导出；工程包可继续编辑，不包含密钥。\n`,
    'utf8'
  )
  const relative = `exports/${folderName}`
  const summaryPath = join(folder, '交付说明.txt')
  const buffer = readFileSync(summaryPath)
  return writeDeliveryFile(project.id, `${folderName}/交付说明.txt`, buffer, '发布套组', 'folder', {
    folder: relative,
    files: copies.length + 1,
    ...(project.kind === 'drama' ? { duration: formatDuration(project.timeline.durationSec) } : {})
  })
}

export interface VoiceSynthesisInput {
  text: string
  voice: string
  rate?: number
  volume?: number
  outputPath: string
  workDir: string
}

const SAMPLE_RATE = 44_100

let voiceCache: { at: number; voices: StudioVoice[]; error?: string } | null = null

function runPowerShell(script: string, args: string[], timeoutMs = 60_000): { code: number; stdout: string; stderr: string } {
  const file = join(tmpdir(), `morrow-studio-${randomUUID()}.ps1`)
  // Windows PowerShell 5 需要 BOM 才能稳定识别 UTF-8 源文件里的中文
  writeFileSync(file, `\uFEFF${script}`, 'utf8')
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs }
    )
    return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } finally {
    try {
      rmSync(file, { force: true })
    } catch {
    }
  }
}

function runPowerShellAsync(script: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const file = join(tmpdir(), `morrow-studio-${randomUUID()}.ps1`)
    writeFileSync(file, `\uFEFF${script}`, 'utf8')
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
      }
      try {
        rmSync(file, { force: true })
      } catch {
      }
      reject(new Error('系统配音超时（60 秒）；请缩短台词后重试。'))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        rmSync(file, { force: true })
      } catch {
      }
      reject(new Error(`无法启动系统配音：${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        rmSync(file, { force: true })
      } catch {
      }
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Windows 10/11 的现代语音 API：支持多角色中文声线，且不依赖 System.Speech 的桌面安全上下文。 */
const WINRT_VOICE_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime]
$rows = @()
foreach ($voice in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
  $rows += [PSCustomObject]@{ name = $voice.DisplayName; culture = $voice.Language; gender = $voice.Gender.ToString() }
}
$rows | ConvertTo-Json -Compress
`

const WINRT_SPEAK_SCRIPT = String.raw`
param(
  [string]$VoiceName = '',
  [Parameter(Mandatory=$true)][string]$OutputFile,
  [Parameter(Mandatory=$true)][string]$TextFile,
  [int]$Rate = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime]
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { throw '配音文本为空。' }
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$chosen = $null
if ($VoiceName) {
  $chosen = $voices | Where-Object { $_.DisplayName -eq $VoiceName } | Select-Object -First 1
  if (-not $chosen) {
    $short = $VoiceName -replace '\s+Desktop$', ''
    $chosen = $voices | Where-Object { $_.DisplayName -eq $short } | Select-Object -First 1
  }
}
if (-not $chosen) {
  $chosen = $voices | Where-Object { $_.Language -like 'zh*' } | Select-Object -First 1
}
if (-not $chosen) { throw '系统上没有可用的中文声线。' }
$synth.Voice = $chosen
$stream = $null
if ($Rate -ne 0) {
  $rateName = if ($Rate -le -7) { 'x-slow' } elseif ($Rate -le -3) { 'slow' } elseif ($Rate -ge 7) { 'x-fast' } elseif ($Rate -ge 3) { 'fast' } else { 'medium' }
  $escaped = [System.Security.SecurityElement]::Escape($text)
  $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/Synthesis' xml:lang='zh-CN'><prosody rate='$rateName'>$escaped</prosody></speak>"
  $stream = Await ($synth.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
} else {
  $stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
}
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
$size = [uint32]$stream.Size
Await ($reader.LoadAsync($size)) ([uint32]) | Out-Null
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes($OutputFile, $bytes)
$reader.Dispose()
$synth.Dispose()
Write-Output ("OK " + $chosen.DisplayName)
`

const SAPI_VOICE_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$rows = @()
foreach ($v in $s.GetInstalledVoices()) {
  if (-not $v.Enabled) { continue }
  $info = $v.VoiceInfo
  $rows += [PSCustomObject]@{ name = $info.Name; culture = $info.Culture.Name; gender = $info.Gender.ToString() }
}
$rows | ConvertTo-Json -Compress
$s.Dispose()
`

const SAPI_SPEAK_SCRIPT = String.raw`
param(
  [string]$VoiceName = '',
  [Parameter(Mandatory=$true)][string]$OutputFile,
  [Parameter(Mandatory=$true)][string]$TextFile,
  [int]$Rate = 0,
  [int]$Volume = 100
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { throw '配音文本为空。' }
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$installed = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
$selected = $false
if ($VoiceName) {
  try { $s.SelectVoice($VoiceName); $selected = $true } catch { $selected = $false }
}
if (-not $selected) {
  foreach ($name in $installed) {
    try { $s.SelectVoice($name); $selected = $true; break } catch { $selected = $false }
  }
}
$s.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$s.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
$s.SetOutputToWaveFile($OutputFile)
$s.Speak($text)
$s.Dispose()
Write-Output 'OK'
`

function parseVoices(stdout: string): StudioVoice[] {
  const text = stdout.trim() || '[]'
  const parsed = JSON.parse(text) as Array<{ name?: string; culture?: string; gender?: string }> | { name?: string; culture?: string; gender?: string }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .filter((row) => typeof row.name === 'string' && row.name.trim())
    .map((row) => ({
      name: row.name as string,
      culture: row.culture ?? '',
      ...(row.gender ? { gender: row.gender } : {})
    }))
}

export function listSystemVoices(force = false): { voices: StudioVoice[]; error?: string } {
  const local = localTtsVoices()
  if (process.platform !== 'win32') {
    return { voices: local, ...(local.length ? {} : { error: '系统配音目前仅支持 Windows。可以改为导入录音，或接入本地/云端声线。' }) }
  }
  if (!force && voiceCache && Date.now() - voiceCache.at < 5 * 60_000) {
    return { voices: [...local, ...voiceCache.voices], ...(voiceCache.error && !local.length ? { error: voiceCache.error } : {}) }
  }
  const withLocal = (voices: StudioVoice[], error?: string): { voices: StudioVoice[]; error?: string } => {
    if (local.length) return { voices: local }
    const system = voices.map((voice) => ({ ...voice, label: `${voice.name}${voice.culture ? ` · ${voice.culture}` : ''}`, kind: 'system' as const }))
    return { voices: system, ...(error ? { error } : {}) }
  }
  const winrt = runPowerShell(WINRT_VOICE_SCRIPT, [], 20_000)
  if (winrt.code === 0) {
    try {
      const voices = parseVoices(winrt.stdout)
      if (voices.length) {
        voiceCache = { at: Date.now(), voices }
        return withLocal(voices)
      }
    } catch {
      // 回退到 SAPI
    }
  }
  const result = runPowerShell(SAPI_VOICE_SCRIPT, [], 20_000)
  if (result.code !== 0) {
    const error = (result.stderr || result.stdout || '无法读取系统声线').trim().slice(0, 300)
    voiceCache = { at: Date.now(), voices: [], error }
    return withLocal([], error)
  }
  try {
    const voices = parseVoices(result.stdout)
    voiceCache = { at: Date.now(), voices }
    return withLocal(voices)
  } catch (err) {
    const error = `系统声线列表不是合法 JSON：${err instanceof Error ? err.message : String(err)}`
    voiceCache = { at: Date.now(), voices: [], error }
    return withLocal([], error)
  }
}

function localVoiceInstruction(shot: StudioShot): string {
  const hints = ['用自然的中文口语说出来，像真人对话，不要播音腔', '句间保留呼吸和自然停顿']
  if (/[？?]/.test(shot.dialogue)) hints.push('带一点疑问和不确定，不要夸张上扬')
  if (/[！!]/.test(shot.dialogue)) hints.push('情绪更强烈，但不要喊叫')
  if (/[……]|\.\.\./.test(shot.dialogue)) hints.push('尾音放轻，留一点迟疑')
  if (/外婆|母亲|父亲|爷爷|奶奶/.test(shot.speaker)) hints.push('年长角色，语速稍慢，声音温和')
  if (/少年|少女|孩子|小[^一-龥]?/.test(shot.speaker)) hints.push('年轻角色，声音轻一点')
  return hints.join('；')
}

export async function synthesizeSpeech(input: VoiceSynthesisInput): Promise<void> {  if (process.platform !== 'win32') throw new Error('系统配音目前仅支持 Windows。')
  if (!input.text.trim()) throw new Error('没有可配音的台词。')
  mkdirSync(input.workDir, { recursive: true })
  const textFile = join(input.workDir, `tts-${randomUUID()}.txt`)
  writeFileSync(textFile, input.text, 'utf8')
  try {
    try {
      const result = await runPowerShellAsync(WINRT_SPEAK_SCRIPT, [
        '-VoiceName',
        input.voice || '',
        '-OutputFile',
        input.outputPath,
        '-TextFile',
        textFile,
        '-Rate',
        String(input.rate ?? 0)
      ], 60_000)
      if (result.code === 0 && existsSync(input.outputPath)) return
      log.warn('winrt tts failed', { code: result.code, stdout: result.stdout.slice(-400), stderr: result.stderr.slice(-400), outputExists: existsSync(input.outputPath) })
      throw new Error((result.stderr || result.stdout || 'Windows 语音合成失败').trim().slice(0, 400))
    } catch (winrtError) {
      // 老系统或 WinRT 不可用时回退 SAPI；两边的错误都给用户看。
      const result = await runPowerShellAsync(SAPI_SPEAK_SCRIPT, [
        '-VoiceName',
        input.voice || '',
        '-OutputFile',
        input.outputPath,
        '-TextFile',
        textFile,
        '-Rate',
        String(input.rate ?? 0),
        '-Volume',
        String(input.volume ?? 100)
      ], 60_000)
      if (result.code !== 0 || !existsSync(input.outputPath)) {
        const sapiError = (result.stderr || result.stdout || '系统配音失败').trim().slice(0, 400)
        log.warn('sapi tts failed', { code: result.code, stdout: result.stdout.slice(-400), stderr: result.stderr.slice(-400), outputExists: existsSync(input.outputPath), voice: input.voice })
        throw new Error(`系统配音失败。现代语音：${winrtError instanceof Error ? winrtError.message : String(winrtError)}；SAPI：${sapiError}`)
      }
    }
  } finally {
    try {
      rmSync(textFile, { force: true })
    } catch {
    }
  }
}

export interface CloudSpeechInput {
  text: string
  baseUrl: string
  apiKey: string
  model: string
  voice: string
  outputPath: string
  workDir: string
  speed?: number
  signal?: AbortSignal
}

/** OpenAI 兼容的 /audio/speech；使用当前云端模型服务商，不另存密钥。 */
export async function synthesizeCloudSpeech(input: CloudSpeechInput): Promise<void> {
  if (!input.text.trim()) throw new Error('没有可配音的台词。')
  let base: URL
  try {
    base = new URL(input.baseUrl)
  } catch {
    throw new Error('云端配音的服务商地址不合法。')
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('云端配音只支持 http(s) 服务商。')
  const cleanPath = base.pathname.replace(/\/+$/, '')
  const endpoint = /\/audio\/speech$/.test(cleanPath)
    ? `${base.origin}${cleanPath}`
    : `${base.origin}${cleanPath}/audio/speech`
  mkdirSync(input.workDir, { recursive: true })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  const onAbort = (): void => controller.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: input.model,
        input: input.text,
        voice: input.voice,
        response_format: 'mp3',
        ...(input.speed && input.speed !== 1 ? { speed: input.speed } : {})
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 400)
      throw new Error(`云端配音失败（HTTP ${response.status}）：${detail || response.statusText}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 1024) throw new Error('云端配音返回的音频为空。')
    if (bytes.length > 60 * 1024 * 1024) throw new Error('云端配音返回的音频超过 60MB。')
    writeFileSync(input.outputPath, bytes)
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
}

function midi(note: number): number {
  return 440 * 2 ** ((note - 69) / 12)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function hashText(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function writeWavStereo(left: Float32Array, right: Float32Array): Buffer {
  const frames = Math.min(left.length, right.length)
  const dataSize = frames * 4
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(2, 22)
  buffer.writeUInt32LE(SAMPLE_RATE, 24)
  buffer.writeUInt32LE(SAMPLE_RATE * 4, 28)
  buffer.writeUInt16LE(4, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  let offset = 44
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(Math.round(clamp(left[index], -1, 1) * 32767), offset)
    buffer.writeInt16LE(Math.round(clamp(right[index], -1, 1) * 32767), offset + 2)
    offset += 4
  }
  return buffer
}

interface MusicMood {
  id: string
  label: string
  root: number
  chords: number[][]
  melody: number[]
  tempo: number
  rain: number
  brightness: number
}

const MOODS: Record<string, MusicMood> = {
  rain: {
    id: 'rain',
    label: '雨幕下的钢琴',
    root: 50,
    chords: [
      [50, 53, 57, 62],
      [46, 50, 53, 58],
      [43, 46, 50, 55],
      [45, 49, 52, 57]
    ],
    melody: [74, 72, 69, 67, 69, 72, 74, 77],
    tempo: 58,
    rain: 0.16,
    brightness: 0.55
  },
  wonder: {
    id: 'wonder',
    label: '倒流的雨',
    root: 52,
    chords: [
      [52, 55, 59, 64],
      [48, 52, 55, 60],
      [45, 48, 52, 57],
      [47, 50, 54, 59]
    ],
    melody: [76, 79, 81, 79, 76, 74, 72, 74],
    tempo: 72,
    rain: 0.22,
    brightness: 0.8
  },
  release: {
    id: 'release',
    label: '克制的告别',
    root: 48,
    chords: [
      [48, 51, 55, 60],
      [43, 48, 51, 55],
      [41, 45, 48, 53],
      [43, 47, 50, 55]
    ],
    melody: [72, 71, 67, 69, 67, 64, 67, 69],
    tempo: 52,
    rain: 0.1,
    brightness: 0.45
  },
  warm: {
    id: 'warm',
    label: '靠近',
    root: 53,
    chords: [
      [53, 57, 60, 65],
      [48, 52, 55, 60],
      [55, 58, 62, 67],
      [50, 53, 57, 62]
    ],
    melody: [72, 76, 77, 79, 77, 76, 72, 69],
    tempo: 66,
    rain: 0.06,
    brightness: 0.7
  },
  tension: {
    id: 'tension',
    label: '不安',
    root: 45,
    chords: [
      [45, 48, 52, 57],
      [46, 50, 53, 58],
      [45, 48, 51, 56],
      [44, 47, 50, 55]
    ],
    melody: [69, 70, 72, 70, 69, 65, 67, 64],
    tempo: 82,
    rain: 0.28,
    brightness: 0.35
  }
}

export function musicMood(mood: string | undefined): MusicMood {
  if (mood && MOODS[mood]) return MOODS[mood] as MusicMood
  if (mood && /雨|rain/i.test(mood)) return MOODS.rain as MusicMood
  if (mood && /紧|不安|危险|tension/i.test(mood)) return MOODS.tension as MusicMood
  if (mood && /告别|悲|sad|release/i.test(mood)) return MOODS.release as MusicMood
  if (mood && /暖|靠近|希望|warm/i.test(mood)) return MOODS.warm as MusicMood
  return MOODS.rain as MusicMood
}

/** 生成一段可循环的本地器乐草稿，返回 WAV 文件路径。 */
export function synthesizeMusic(input: { mood?: string; seconds?: number; seed?: number; outputPath: string; title?: string }): { path: string; mood: MusicMood; duration: number } {
  const mood = musicMood(input.mood)
  const seconds = clamp(input.seconds ?? 54, 8, 300)
  const frames = Math.ceil(seconds * SAMPLE_RATE)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const seed = input.seed ?? hashText(`${input.title ?? ''}:${mood.id}:${seconds}`)
  let random = seed || 1
  const rand = (): number => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    return random / 0xffffffff
  }
  const note = (bufferL: Float32Array, bufferR: Float32Array, startSec: number, durationSec: number, midiNote: number, velocity: number, pan = 0): void => {
    const freq = midi(midiNote)
    const start = Math.floor(startSec * SAMPLE_RATE)
    const length = Math.floor(durationSec * SAMPLE_RATE)
    const panL = Math.cos(((pan + 1) * Math.PI) / 4)
    const panR = Math.sin(((pan + 1) * Math.PI) / 4)
    for (let index = 0; index < length && start + index < frames; index += 1) {
      const t = index / SAMPLE_RATE
      const attack = Math.min(1, t / 0.012)
      const decay = Math.exp(-t * (1.8 + (60 / Math.max(1, midiNote))))
      const body =
        Math.sin(2 * Math.PI * freq * t) * 0.62 +
        Math.sin(2 * Math.PI * freq * 2 * t) * 0.2 * mood.brightness +
        Math.sin(2 * Math.PI * freq * 3 * t) * 0.09 * mood.brightness +
        Math.sin(2 * Math.PI * freq * 4 * t) * 0.035
      const value = body * attack * decay * velocity
      bufferL[start + index] += value * panL
      bufferR[start + index] += value * panR
    }
  }
  const pad = (startSec: number, durationSec: number, notes: number[], velocity: number): void => {
    const start = Math.floor(startSec * SAMPLE_RATE)
    const length = Math.floor(durationSec * SAMPLE_RATE)
    for (const midiNote of notes) {
      const freq = midi(midiNote)
      for (let index = 0; index < length && start + index < frames; index += 1) {
        const t = index / SAMPLE_RATE
        const env = Math.min(1, t / 1.4) * Math.min(1, (durationSec - t) / 1.6) * velocity
        const value = (Math.sin(2 * Math.PI * freq * t) + Math.sin(2 * Math.PI * freq * 1.005 * t) * 0.5) * env * 0.08
        left[start + index] += value * 0.7
        right[start + index] += value * 0.7
      }
    }
  }
  const barSeconds = (60 / mood.tempo) * 4
  let bar = 0
  for (let time = 0; time < seconds + barSeconds; time += barSeconds, bar += 1) {
    const chord = mood.chords[bar % mood.chords.length]
    pad(time, Math.min(barSeconds * 1.2, seconds - time + 1), chord, 0.9)
    // 低音根音
    note(left, right, time, Math.min(3.6, seconds - time), chord[0] - 12, 0.22, -0.2)
    // 分解和弦
    const pattern = [0, 2, 1, 3, 1, 2, 0, 2]
    for (let step = 0; step < pattern.length; step += 1) {
      const at = time + (barSeconds / pattern.length) * step
      if (at >= seconds) break
      note(left, right, at, 2.4, chord[pattern[step] % chord.length] + 12, 0.12 + rand() * 0.05, (rand() - 0.5) * 0.6)
    }
    // 稀疏旋律
    if (bar % 2 === 0) {
      const melodyNote = mood.melody[(bar / 2) % mood.melody.length]
      note(left, right, time + barSeconds * 0.5, 3.2, melodyNote, 0.16, 0.25)
      if (bar % 4 === 2) note(left, right, time + barSeconds * 0.75, 2.4, melodyNote - 3, 0.1, -0.3)
    }
  }
  // 雨声：低通白噪声 + 随机水滴
  let filtered = 0
  for (let index = 0; index < frames; index += 1) {
    const noise = rand() * 2 - 1
    filtered = filtered * 0.985 + noise * 0.015
    const rain = filtered * mood.rain
    left[index] += rain * (0.9 + rand() * 0.1)
    right[index] += rain * (0.9 + rand() * 0.1)
  }
  const drops = Math.floor(seconds * 1.4)
  for (let drop = 0; drop < drops; drop += 1) {
    const start = Math.floor(rand() * (frames - SAMPLE_RATE * 0.2))
    const freq = 900 + rand() * 2200
    const gain = 0.02 + rand() * 0.035
    const length = Math.floor(SAMPLE_RATE * (0.04 + rand() * 0.08))
    for (let index = 0; index < length; index += 1) {
      const t = index / SAMPLE_RATE
      const value = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 60) * gain
      left[start + index] += value
      right[start + index] += value * 0.85
    }
  }
  // 简易回声与淡入淡出
  const delay = Math.floor(SAMPLE_RATE * 0.23)
  for (let index = delay; index < frames; index += 1) {
    left[index] += left[index - delay] * 0.09
    right[index] += right[index - delay] * 0.11
  }
  const fade = Math.floor(SAMPLE_RATE * Math.min(2.5, seconds / 6))
  for (let index = 0; index < fade; index += 1) {
    const gain = index / fade
    left[index] *= gain
    right[index] *= gain
  }
  for (let index = 0; index < fade; index += 1) {
    const gain = index / fade
    left[frames - 1 - index] *= gain
    right[frames - 1 - index] *= gain
  }
  // 归一化
  let peak = 0
  for (let index = 0; index < frames; index += 1) peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]))
  const scale = peak > 0 ? 0.72 / peak : 1
  for (let index = 0; index < frames; index += 1) {
    left[index] *= scale
    right[index] *= scale
  }
  mkdirSync(join(input.outputPath, '..'), { recursive: true })
  writeFileSync(input.outputPath, writeWavStereo(left, right))
  return { path: input.outputPath, mood, duration: seconds }
}

/** 生成真实音效素材（雨声 / 伞骨 / 心跳 / 街声）。 */
export function synthesizeSfx(kind: 'rain' | 'umbrella' | 'heartbeat' | 'street', outputPath: string, seconds = 5): string {
  const frames = Math.ceil(seconds * SAMPLE_RATE)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  let random = hashText(`${kind}:${seconds}`) || 7
  const rand = (): number => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    return random / 0xffffffff
  }
  if (kind === 'rain' || kind === 'street') {
    let low = 0
    let hum = 0
    for (let index = 0; index < frames; index += 1) {
      const noise = rand() * 2 - 1
      low = low * (kind === 'rain' ? 0.985 : 0.996) + noise * (kind === 'rain' ? 0.015 : 0.004)
      hum = hum * 0.9995 + noise * 0.0005
      const value = kind === 'rain' ? low * 0.45 : low * 0.08 + Math.sin(2 * Math.PI * 60 * (index / SAMPLE_RATE)) * 0.006
      left[index] += value + hum * 0.2
      right[index] += value * 0.92 + hum * 0.18
    }
    if (kind === 'street') {
      // 远处一辆车经过
      const start = Math.floor(frames * 0.32)
      for (let index = 0; index < SAMPLE_RATE * 2 && start + index < frames; index += 1) {
        const t = index / SAMPLE_RATE
        const env = Math.sin((Math.PI * t) / 2) ** 2 * Math.exp(-t * 0.9)
        const value = Math.sin(2 * Math.PI * (180 + t * 30) * t) * 0.012 * env
        left[start + index] += value
        right[start + index] += value * 0.7
      }
    }
  } else if (kind === 'heartbeat') {
    for (let index = 0; index < frames; index += 1) {
      const t = index / SAMPLE_RATE
      const beat = t % 0.86
      const thump = (offset: number, gain: number): number => {
        const x = beat - offset
        if (x < 0 || x > 0.22) return 0
        return Math.sin(2 * Math.PI * 52 * x) * Math.exp(-x * 28) * gain
      }
      const value = thump(0, 0.5) + thump(0.22, 0.28)
      left[index] += value
      right[index] += value * 0.9
    }
  } else {
    // 伞骨：金属细响与开合
    for (let click = 0; click < 7; click += 1) {
      const start = Math.floor((0.18 + click * 0.48 + rand() * 0.1) * SAMPLE_RATE)
      const freq = 2600 + rand() * 1800
      for (let index = 0; index < SAMPLE_RATE * 0.08 && start + index < frames; index += 1) {
        const t = index / SAMPLE_RATE
        const value = (Math.sin(2 * Math.PI * freq * t) + rand() * 0.4) * Math.exp(-t * 45) * 0.09
        left[start + index] += value
        right[start + index] += value * 0.8
      }
    }
    for (let index = 0; index < frames; index += 1) {
      const t = index / SAMPLE_RATE
      const env = Math.min(1, t / 0.1) * Math.min(1, (seconds - t) / 0.4)
      const value = (rand() * 2 - 1) * 0.012 * env
      left[index] += value
      right[index] += value
    }
  }
  const fade = Math.floor(SAMPLE_RATE * 0.2)
  for (let index = 0; index < fade; index += 1) {
    const gain = index / fade
    left[index] *= gain
    right[index] *= gain
    left[frames - 1 - index] *= gain
    right[frames - 1 - index] *= gain
  }
  mkdirSync(join(outputPath, '..'), { recursive: true })
  writeFileSync(outputPath, writeWavStereo(left, right))
  return outputPath
}

/** 真实音频峰值：FFmpeg 解码为单声道 PCM，再按桶取绝对值峰值。 */
export function audioWaveform(file: string, buckets = 96): number[] {
  const ffmpeg = resolveFfmpegPaths()?.ffmpeg
  if (!ffmpeg || !existsSync(file)) return []
  const result = spawnSync(
    ffmpeg,
    ['-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
    { maxBuffer: 96 * 1024 * 1024, windowsHide: true }
  )
  if (result.status !== 0 || !result.stdout?.length) return []
  const samples = Math.floor(result.stdout.length / 2)
  const bucketSize = Math.max(1, Math.floor(samples / buckets))
  const peaks: number[] = []
  for (let index = 0; index < buckets; index += 1) {
    const start = index * bucketSize
    const end = Math.min(samples, start + bucketSize)
    let peak = 0
    for (let sample = start; sample < end; sample += 1) {
      const value = Math.abs(result.stdout.readInt16LE(sample * 2))
      if (value > peak) peak = value
    }
    peaks.push(peak / 32768)
  }
  const max = Math.max(...peaks, 0.0001)
  return peaks.map((value) => Math.round((value / max) * 1000) / 1000)
}

export function readWaveformCache(cacheFile: string, sourceFile: string): number[] | null {
  try {
    if (!existsSync(cacheFile) || !existsSync(sourceFile)) return null
    if (statSync(cacheFile).mtimeMs < statSync(sourceFile).mtimeMs) return null
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8')) as { peaks?: unknown }
    if (!Array.isArray(parsed.peaks) || !parsed.peaks.length) return null
    return parsed.peaks.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  } catch {
    return null
  }
}

export function writeWaveformCache(cacheFile: string, peaks: number[]): void {
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, `${JSON.stringify({ peaks, updatedAt: Date.now() })}\n`, 'utf8')
}

/** 生成 540p 低清代理；已存在且比源文件新时直接复用。 */
export function ensureVideoProxy(source: string, target: string): boolean {
  const ffmpeg = resolveFfmpegPaths()?.ffmpeg
  if (!ffmpeg || !existsSync(source)) return false
  if (existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs) return true
  mkdirSync(dirname(target), { recursive: true })
  const result = spawnSync(
    ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', source,
      '-vf', 'scale=-2:540',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      target
    ],
    { maxBuffer: 8 * 1024 * 1024, windowsHide: true }
  )
  return result.status === 0 && existsSync(target)
}

const SPEECH_VERBS = '说|问道|问|答道|答|道|喊道|喊|低声说|低声|笑道|笑|冷笑|开口|咕哝|嘟囔|吼道|吼|叹道|叹'

const STOP_WORDS = new Set([
  '一个', '什么', '我们', '你们', '他们', '她们', '这个', '那个', '自己', '没有', '就是', '不是',
  '可以', '已经', '还是', '但是', '只是', '如果', '因为', '所以', '然后', '现在', '这里', '那里',
  '知道', '觉得', '时候', '起来', '出来', '过来', '一下', '一点', '真的', '不会', '不要', '不能'
])

const ADDRESS_TERMS = ['您', '你', '先生', '小姐', '老师', '师父', '大人', '陛下', '殿下', '老板', '哥', '姐', '叔', '姨']

interface DialogueLine {
  speaker: string
  text: string
  chapterId?: string
  shotId?: string
}

function cleanLine(raw: string): string {
  return raw
    .replace(/[“”「」『』"]/g, '')
    .replace(/（[^）]{0,40}）/g, '')
    .replace(/\([^)]{0,40}\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

function pushLine(list: DialogueLine[], speaker: string, text: string, extra: Partial<DialogueLine> = {}): void {
  let name = speaker.trim()
  if (name.length > 1) name = name.replace(/(说道|问道|答道|笑道|喊道|吼道|叹道|低声说|说|道|问|答|笑|喊|吼|叹)$/u, '')
  const line = cleanLine(text)
  if (!name || !line || line.length < 2) return
  list.push({ speaker: name, text: line, ...extra })
}

/** 从正文中提取“谁说 + 说了什么”，只收有明确归属的句子。 */
export function extractChapterDialogue(content: string, chapterId: string): DialogueLine[] {
  const lines: DialogueLine[] = []
  const text = content.replace(/\r\n?/g, '\n')
  const before = new RegExp(`([\\u4e00-\\u9fa5]{1,6}?)(?:${SPEECH_VERBS})[：:，,]?\\s*[“「]([^”」]{1,500})[”」]`, 'g')
  const after = new RegExp(`[“「]([^”」]{1,500})[”」]\\s*[，,]?\\s*([\\u4e00-\\u9fa5]{1,6}?)(?:${SPEECH_VERBS})`, 'g')
  const labelled = /^([\u4e00-\u9fa5]{1,6})[：:]\s*[“「]?([^”」\n]{2,500})[”」]?$/gm
  for (const match of text.matchAll(before)) pushLine(lines, match[1], match[2], { chapterId })
  for (const match of text.matchAll(after)) pushLine(lines, match[2], match[1], { chapterId })
  for (const match of text.matchAll(labelled)) pushLine(lines, match[1], match[2], { chapterId })
  const seen = new Set<string>()
  return lines.filter((line) => {
    const key = `${line.speaker}\u0000${line.text}\u0000${line.chapterId ?? ''}\u0000${line.shotId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function extractShotDialogue(project: StudioProject): DialogueLine[] {
  const lines: DialogueLine[] = []
  for (const shot of project.shots) {
    const raw = shot.dialogue.trim()
    if (!raw) continue
    const parts = raw.split(/\n+/).map((item) => item.trim()).filter(Boolean)
    for (const part of parts) {
      const labelled = /^([\u4e00-\u9fa5]{1,6})[：:]\s*(.+)$/.exec(part)
      const speaker = labelled?.[1] || shot.speaker || ''
      const text = labelled?.[2] || part
      if (!speaker) {
        for (const sentence of text.split(/(?<=[。！？!?；;])/).filter((item) => item.trim())) {
          lines.push({ speaker: '', text: cleanLine(sentence), shotId: shot.id })
        }
        continue
      }
      for (const sentence of text.split(/(?<=[。！？!?；;])/).filter((item) => item.trim())) {
        pushLine(lines, speaker, sentence, { shotId: shot.id })
      }
    }
  }
  return lines
}

function charBigrams(text: string): Map<string, number> {
  const clean = text.replace(/[^\u4e00-\u9fa5]/g, '')
  const map = new Map<string, number>()
  for (let index = 0; index + 2 <= clean.length; index += 1) {
    const gram = clean.slice(index, index + 2)
    map.set(gram, (map.get(gram) ?? 0) + 1)
  }
  return map
}

function cosine(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (const value of left.values()) leftNorm += value * value
  for (const value of right.values()) rightNorm += value * value
  for (const [key, value] of left) {
    const other = right.get(key)
    if (other) dot += value * other
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}

function topPhrases(lines: string[]): string[] {
  const counts = new Map<string, number>()
  for (const line of lines) {
    const clean = line.replace(/[^\u4e00-\u9fa5]/g, '')
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= clean.length; index += 1) {
        const phrase = clean.slice(index, index + size)
        if (STOP_WORDS.has(phrase)) continue
        counts.set(phrase, (counts.get(phrase) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .filter(([phrase, count]) => count >= 3 && !STOP_WORDS.has(phrase))
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length)
    .slice(0, 4)
    .map(([phrase, count]) => `${phrase}×${count}`)
}

function addressTerms(lines: string[]): string[] {
  const counts = new Map<string, number>()
  for (const line of lines) {
    for (const term of ADDRESS_TERMS) {
      const found = line.split(term).length - 1
      if (found) counts.set(term, (counts.get(term) ?? 0) + found)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([term, count]) => `${term}×${count}`)
}

function profileFor(character: StudioCharacter, lines: DialogueLine[]): StudioVoiceProfile {
  const texts = lines.map((line) => line.text)
  const words = texts.reduce((sum, line) => sum + line.replace(/\s+/g, '').length, 0)
  const avgLine = texts.length ? words / texts.length : 0
  const questionRatio = texts.length ? texts.filter((line) => /[？?]/.test(line)).length / texts.length : 0
  const exclaimRatio = texts.length ? texts.filter((line) => /[！!]/.test(line)).length / texts.length : 0
  const tone = avgLine < 10 ? '短句居多' : avgLine > 24 ? '长句居多' : '长短相间'
  const mood = questionRatio >= 0.25 ? '常用问句试探' : exclaimRatio >= 0.15 ? '情绪外放' : '语气克制'
  const summary = texts.length ? `${tone}，${mood}；平均每句 ${avgLine.toFixed(1)} 字。` : '还没有可归属的台词。'
  return {
    characterId: character.id,
    name: character.name,
    lineCount: texts.length,
    words,
    avgLine: Math.round(avgLine * 10) / 10,
    questionRatio: Math.round(questionRatio * 100) / 100,
    exclaimRatio: Math.round(exclaimRatio * 100) / 100,
    topPhrases: topPhrases(texts),
    addressTerms: addressTerms(texts),
    summary
  }
}

export interface VoiceAuditResult {
  audit: StudioVoiceAudit
  checks: StudioCheck[]
}

export function auditCharacterVoices(project: StudioProject): VoiceAuditResult {
  const chapterLines = project.chapters.flatMap((chapter) => extractChapterDialogue(chapter.content, chapter.id))
  const shotLines = extractShotDialogue(project)
  const all = [...chapterLines, ...shotLines]
  const knownNames = new Map(project.characters.map((character) => [character.name, character]))
  const names = new Set([...knownNames.keys()])
  for (const line of all) if (line.speaker) names.add(line.speaker)
  const profiles: StudioVoiceProfile[] = []
  for (const name of names) {
    const character = knownNames.get(name) ?? {
      id: `voice_unknown_${name}`,
      name,
      role: '未建档',
      look: '',
      relationships: [],
      refAssetIds: []
    }
    profiles.push(profileFor(character, all.filter((line) => line.speaker === name)))
  }
  profiles.sort((a, b) => b.lineCount - a.lineCount)
  const warnings: StudioVoiceAudit['warnings'] = []
  const unresolved = all.filter((line) => !line.speaker).length
  if (unresolved) {
    warnings.push({ level: 'info', title: `${unresolved} 句台词没有明确说话人`, detail: '这些句子没有进入人物语气统计；可以在分镜台词里用“角色名：台词”补上归属。' })
  }
  if (all.length < 8) {
    warnings.push({ level: 'info', title: '台词样本偏少', detail: `目前只有 ${all.length} 句可归属台词，语气判断仅供参考；正文写到 2000 字以上再跑一次更准。` })
  }
  const vector = new Map<string, Map<string, number>>()
  for (const profile of profiles) {
    const lines = all.filter((line) => line.speaker === profile.name).map((line) => line.text)
    vector.set(profile.characterId, charBigrams(lines.join('')))
  }
  for (let left = 0; left < profiles.length; left += 1) {
    for (let right = left + 1; right < profiles.length; right += 1) {
      const a = profiles[left]
      const b = profiles[right]
      if (a.lineCount < 5 || b.lineCount < 5) continue
      const similarity = cosine(vector.get(a.characterId)!, vector.get(b.characterId)!)
      if (similarity >= 0.82) {
        warnings.push({
          level: 'warn',
          title: `${a.name} 与 ${b.name} 的语气可能趋同`,
          detail: `两人的用词相似度 ${Math.round(similarity * 100)}%，平均句长分别为 ${a.avgLine} / ${b.avgLine} 字。可以给其中一人换口头禅、句长或称谓。`
        })
      }
    }
  }
  for (const profile of profiles) {
    const character = knownNames.get(profile.name)
    if (character?.role.includes('主角') && profile.lineCount === 0) {
      warnings.push({ level: 'warn', title: `${profile.name} 还没有可归属台词`, detail: '主角的欲望与态度需要靠说话方式落地；可以在正文或分镜里补一段带明确说话人的对白。', characterId: character.id })
    }
    if (profile.lineCount >= 8 && profile.topPhrases.length === 0 && profile.avgLine > 30) {
      warnings.push({ level: 'info', title: `${profile.name} 的句子偏长且缺少口头习惯`, detail: '长句本身不是问题；如果角色需要更强的辨识度，可以加入固定称谓或短促反应句。', characterId: profile.characterId })
    }
  }
  const audit: StudioVoiceAudit = {
    createdAt: Date.now(),
    profiles,
    unresolved,
    warnings
  }
  const checks: StudioCheck[] = []
  const now = Date.now()
  for (const warning of warnings) {
    checks.push({
      id: studioId('check'),
      kind: 'voice',
      level: warning.level,
      title: warning.title,
      detail: warning.detail,
      ...(warning.characterId ? { targetId: warning.characterId } : {}),
      createdAt: now
    })
  }
  if (profiles.length && !warnings.length) {
    checks.push({
      id: studioId('check'),
      kind: 'voice',
      level: 'info',
      title: '人物语气没有明显冲突',
      detail: `${profiles.filter((profile) => profile.lineCount > 0).length} 个角色有可归属台词，句长、问句比例与用词没有出现高度重合。`,
      createdAt: now
    })
  }
  return { audit, checks }
}

export function applyBlueprintToProject(project: StudioProject, blueprint: StudioBlueprint): StudioProject {
  project.blueprint = blueprint
  project.styleBible = blueprint.styleBible
  if (blueprint.title?.trim() && project.titleSource !== 'user') {
    project.title = blueprint.title.trim().slice(0, 120)
    project.titleSource = blueprint.source === 'model' ? 'model' : 'auto'
  }
  if (blueprint.genre?.trim()) project.brief.genre = blueprint.genre.trim()
  if (blueprint.tone?.trim()) project.brief.tone = blueprint.tone.trim()
  if (blueprint.audience?.trim()) project.brief.audience = blueprint.audience.trim()
  project.characters = blueprint.characters.map((character) => ({ ...character }))
  project.places = blueprint.places.map((place) => ({ ...place }))
  project.facts = []
  const factSource: StudioFact['source'] = blueprint.source === 'model' ? 'ai' : blueprint.source === 'import' ? 'import' : 'manual'
  for (const fact of blueprint.facts ?? []) {
    project.facts.push({
      id: studioId('fact'),
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      confidence: 0.85,
      source: factSource,
      createdAt: nowMs()
    })
  }
  if (!project.facts.length) {
    for (const character of project.characters) {
      if (character.desire) {
        project.facts.push({
          id: studioId('fact'),
          subject: character.name,
          predicate: '想要',
          object: character.desire,
          confidence: 0.7,
          source: factSource,
          createdAt: nowMs()
        })
      }
      for (const relationship of character.relationships) {
        project.facts.push({
          id: studioId('fact'),
          subject: character.name,
          predicate: `与${relationship.target}的关系`,
          object: relationship.label,
          confidence: 0.7,
          source: factSource,
          createdAt: nowMs()
        })
      }
    }
  }
  project.runtime.textModelNote =
    blueprint.source === 'model' ? blueprint.model : blueprint.source === 'import' ? '随包示例' : '本机结构改编'
  const now = nowMs()
  project.stages.blueprint = { status: blueprint.approved ? 'done' : 'review', updatedAt: now, message: blueprint.approved ? '蓝图已批准' : '等待你审阅蓝图' }
  project.stages.outline = { status: 'ready', updatedAt: now, message: '可以生成大纲' }
  project.stage = 'outline'
  if (blueprint.approved) {
    if (project.kind === 'drama') {
      applyDramaOutline(project, blueprint)
    } else {
      applyNovelOutline(project, blueprint)
    }
  }
  project.updatedAt = now
  return project
}

export function applyNovelOutline(project: StudioProject, blueprint: StudioBlueprint): void {
  const units = blueprint.units
  const volumeCount = project.kind === 'novel' ? 3 : 1
  const volumeSeeds = blueprint.volumes?.length
    ? blueprint.volumes
    : Array.from({ length: volumeCount }, (_, index) => {
        const per = Math.ceil(units.length / volumeCount)
        const start = index * per + 1
        const end = Math.min(units.length, (index + 1) * per)
        const first = units[start - 1]
        const last = units[Math.max(start - 1, end - 1)]
        return {
          title: `${['第一', '第二', '第三'][index] ?? index + 1}卷`,
          summary: first && last ? `${first.title} → ${last.title}` : '',
          unitStart: start,
          unitEnd: end
        }
      })
  const volumes: StudioVolume[] = volumeSeeds.map((seed) => ({
    id: studioId('vol'),
    number: 0,
    title: seed.title,
    summary: seed.summary,
    chapterIds: []
  }))
  const volumeIndexFor = (unitIndex: number): number => {
    const found = volumeSeeds.findIndex((seed) => unitIndex + 1 >= seed.unitStart && unitIndex + 1 <= seed.unitEnd)
    if (found >= 0) return found
    return Math.min(volumes.length - 1, Math.floor(unitIndex / Math.max(1, Math.ceil(units.length / Math.max(1, volumes.length)))))
  }
  volumes.forEach((volume, index) => {
    volume.number = index + 1
  })
  const chapters: StudioChapter[] = units.map((unit, index) => {
    const volumeIndex = volumeIndexFor(index)
    const volume = volumes[volumeIndex]
    const chapter: StudioChapter = {
      id: studioId('ch'),
      volumeId: volume?.id ?? volumes[0]?.id ?? '',
      number: index + 1,
      title: unit.title,
      synopsis: unit.summary,
      beats: unit.beats?.length ? [...unit.beats] : [unit.summary],
      content: '',
      wordTarget: Math.max(2000, Math.min(5000, unit.wordTarget ?? 3000)),
      status: 'ready',
      revision: 1,
      candidates: [],
      versions: [],
      illustrations: [],
      locked: false,
      updatedAt: nowMs()
    }
    volume?.chapterIds.push(chapter.id)
    return chapter
  })
  project.volumes = volumes
  project.chapters = chapters
  project.episodes = []
  project.scenes = []
  project.shots = []
  project.timeline = emptyTimeline(project.brief.aspect)
  // 蓝图事实默认是全书全局事实，不绑定到第一章；否则第三章以后会丢失设定。
}

export function applyDramaOutline(project: StudioProject, blueprint: StudioBlueprint): void {
  const units = blueprint.units
  const sceneSeeds = blueprint.scenes ?? []
  if (!sceneSeeds.length) {
    throw new Error('漫剧蓝图里没有场景信息，无法排镜头。请在蓝图页用模型重新生成，补上场景与镜头范围。')
  }
  const episode: StudioEpisode = {
    id: studioId('ep'),
    number: 1,
    title: project.title,
    synopsis: blueprint.pitch,
    sceneIds: [],
    durationSec: units.reduce((sum, unit) => sum + (unit.seconds ?? 8), 0),
    updatedAt: nowMs()
  }
  const sceneRanges = sceneSeeds.map((seed, index) => {
    const fallbackPer = Math.max(1, Math.ceil(units.length / Math.max(1, sceneSeeds.length)))
    return {
      start: Math.max(1, Math.min(units.length, seed.unitStart || index * fallbackPer + 1)),
      end: Math.max(1, Math.min(units.length, seed.unitEnd || (index + 1) * fallbackPer))
    }
  })
  const scenes: StudioScene[] = sceneSeeds.map((seed, index) => ({
    id: studioId('scene'),
    episodeId: episode.id,
    number: index + 1,
    title: seed.title,
    synopsis: seed.synopsis,
    location: seed.location,
    timeOfDay: seed.timeOfDay,
    characters: seed.characters.slice(0, 20),
    beat: index === 0 ? 'Setup' : index === sceneSeeds.length - 1 ? 'Resolution' : 'Confrontation',
    updatedAt: nowMs()
  }))
  episode.sceneIds = scenes.map((scene) => scene.id)
  const sceneIndexFor = (unitIndex: number): number => {
    const found = sceneRanges.findIndex((range) => unitIndex + 1 >= range.start && unitIndex + 1 <= range.end)
    if (found >= 0) return found
    return Math.min(scenes.length - 1, Math.floor(unitIndex / Math.max(1, Math.ceil(units.length / Math.max(1, scenes.length)))))
  }
  const shots: StudioShot[] = units.map((unit, index) => {
    const sceneIndex = sceneIndexFor(index)
    const scene = scenes[sceneIndex]
    const speaker = unit.speaker ?? ''
    const character = project.characters.find((item) => item.name === speaker)
    const sceneCharacters = scene.characters
      .map((name) => project.characters.find((item) => item.name === name))
      .filter((item): item is StudioCharacter => Boolean(item))
    const referenceCharacters = [...new Map([...(character ? [character] : []), ...sceneCharacters].map((item) => [item.id, item])).values()]
    const place = project.places.find((item) => item.name === scene.location) ?? project.places[0]
    return {
      id: studioId('shot'),
      sceneId: scene.id,
      number: index + 1,
      title: unit.title,
      action: unit.summary,
      camera: unit.camera?.trim() || '固定镜头，缓慢推近',
      shotSize: unit.shotSize?.trim() || '中景',
      durationSec: Math.max(3, Math.min(30, unit.seconds ?? 8)),
      dialogue: unit.dialogue ?? '',
      speaker,
      voiceId: character?.voiceId ?? '',
      prompt: imagePromptFor(project, unit, index, scene, blueprint.styleBible),
      negative: blueprint.styleBible.negative.join('，'),
      referenceCharacterIds: referenceCharacters.map((item) => item.id),
      referencePlaceIds: place ? [place.id] : [],
      referencePropIds: [],
      imageAssetId: null,
      videoAssetId: null,
      voiceAssetId: null,
      imageCandidates: [],
      videoCandidates: [],
      continuity: index === 0
        ? '开场；固定人物外观、服装与场景光线'
        : `承接第 ${index} 镜尾帧；人物外观、服装与光线保持一致`,
      lockedReference: false,
      status: 'ready',
      updatedAt: nowMs()
    }
  })
  project.episodes = [episode]
  project.scenes = scenes
  project.shots = shots
  project.chapters = []
  project.volumes = []
  project.timeline = emptyTimeline(project.brief.aspect)
  if (scenes[0]) {
    for (const fact of project.facts) {
      if (!fact.sceneId) fact.sceneId = scenes[0].id
    }
  }
  project.stage = 'storyboard'
}

function imagePromptFor(
  project: StudioProject,
  unit: StudioBlueprintUnit,
  index: number,
  scene: StudioScene,
  style: StudioStyleBible
): string {
  const sceneCharacters = scene.characters
    .map((name) => project.characters.find((character) => character.name === name))
    .filter((character): character is StudioCharacter => Boolean(character))
  const characterDetails = sceneCharacters
    .slice(0, 4)
    .map((character) => `${character.name}（${character.role}${character.look ? `：${character.look.slice(0, 120)}` : ''}）`)
  const place = project.places.find((item) => item.name === scene.location)
  return [
    `电影剧照，${style.look}`,
    `${unit.shotSize?.trim() || '中景'}，${unit.camera?.trim() || '固定镜头，缓慢推近'}`,
    `画面：${unit.summary}`,
    characterDetails.length ? `人物：${characterDetails.join('；')}` : '',
    `场景：${scene.location || '同一故事世界'}${scene.timeOfDay ? `，${scene.timeOfDay}` : ''}`,
    place?.description ? `环境：${place.description}` : '',
    `本场：${scene.synopsis}`,
    `第 ${index + 1} 镜，${project.brief.aspect}，统一角色外观、服装与光线，无字幕无文字`
  ].filter(Boolean).join('；')
}

interface IntentContext {
  selection?: { kind: 'chapter' | 'shot' | 'clip'; id: string }
}

interface DraftPlan {
  title: string
  summary: string
  actions: StudioEditAction[]
  effects: string[]
  seconds: number
  cost: number | null
  note?: string
}

function shotNumberFromText(text: string): number | null {
  const match = /(?:第\s*)?(?:镜|镜头|shot)\s*0?(\d{1,3})/i.exec(text)
  return match ? Number(match[1]) : null
}

function percentFrom(text: string): number | null {
  const match = /(\d{1,3})\s*%/.exec(text)
  return match ? Number(match[1]) : null
}

function targetShot(project: StudioProject, text: string, ctx: IntentContext): StudioShot | null {
  if (ctx.selection?.kind === 'shot') {
    const shot = project.shots.find((item) => item.id === ctx.selection?.id)
    if (shot) return shot
  }
  if (ctx.selection?.kind === 'clip') {
    const clip = project.timeline.clips.find((item) => item.id === ctx.selection?.id)
    if (clip?.shotId) {
      const shot = project.shots.find((item) => item.id === clip.shotId)
      if (shot) return shot
    }
  }
  const number = shotNumberFromText(text)
  if (number !== null) return project.shots.find((shot) => shot.number === number) ?? null
  return null
}

function clipsForShot(project: StudioProject, shotId: string): StudioClip[] {
  return project.timeline.clips.filter((clip) => clip.shotId === shotId)
}

function chineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (value === '十') return 10
  if (value.includes('十')) {
    const [head, tail] = value.split('十')
    const tens = head ? digits[head] : 1
    const ones = tail ? digits[tail] : 0
    if (tens === undefined || ones === undefined) return null
    return tens * 10 + ones
  }
  return digits[value] ?? null
}

function detectStoryboardExtension(text: string): boolean {
  return /补全|补齐|补充|新增|添加|扩展/.test(text) && /分镜|镜头/.test(text)
}

export function draftEditPlan(project: StudioProject, text: string, ctx: IntentContext = {}): DraftPlan {
  const actions: StudioEditAction[] = []
  const effects: string[] = []
  let seconds = 0
  let cost: number | null = 0
  const noteLines: string[] = []
  const shot = targetShot(project, text, ctx)
  const orderOnly = !/并|同时|然后|顺便|再把|另外|还要|改|重做|换画面|配音|音效|音乐|音量|速度/.test(text)
  if (orderOnly) {
    const chapterSwap = /第\s*([0-9一二三四五六七八九十]+)\s*章\s*(?:和|与|跟)\s*第\s*([0-9一二三四五六七八九十]+)\s*章\s*(?:换|调换|交换)/.exec(text)
    if (chapterSwap && project.kind !== 'drama') {
      const first = chineseNumber(chapterSwap[1])
      const second = chineseNumber(chapterSwap[2])
      const left = first ? project.chapters.find((chapter) => chapter.number === first) : undefined
      const right = second ? project.chapters.find((chapter) => chapter.number === second) : undefined
      if (left && right && first && second) {
        return {
          title: '章节顺序调整',
          summary: `交换第 ${first} 章与第 ${second} 章`,
          actions: [
            { type: 'move-chapter', chapterId: left.id, chapterNumber: first, to: second },
            { type: 'move-chapter', chapterId: right.id, chapterNumber: second, to: first }
          ],
          effects: [`交换第 ${first} 章与第 ${second} 章`],
          seconds: 0,
          cost: 0
        }
      }
    }
    const chapterMove = /第\s*([0-9一二三四五六七八九十]+)\s*章\s*(?:移到|移动到|挪到|放到|调到|排到)\s*(最前面|最后面|开头|结尾|第\s*([0-9一二三四五六七八九十]+)\s*(?:章|位)?\s*(前面|后面|之前|之后)?)/.exec(text)
    if (chapterMove && project.kind !== 'drama') {
      const from = chineseNumber(chapterMove[1])
      if (from) {
        const tail = chapterMove[2]
        let to = 0
        if (/最前面|开头/.test(tail)) to = 1
        else if (/最后面|结尾/.test(tail)) to = Math.max(1, project.chapters.length || project.blueprint?.units.length || 1)
        else {
          const target = chineseNumber(chapterMove[3] ?? '')
          if (target) to = target + (/后面|之后/.test(chapterMove[4] ?? '') ? 1 : 0)
        }
        if (to) {
          const chapter = project.chapters.find((item) => item.number === from)
          return {
            title: '章节顺序调整',
            summary: `把第 ${from} 章移到第 ${to} 位`,
            actions: [{ type: 'move-chapter', ...(chapter ? { chapterId: chapter.id } : {}), chapterNumber: from, to }],
            effects: [`把第 ${from} 章移到第 ${to} 位`],
            seconds: 0,
            cost: 0
          }
        }
      }
    }
    const shotSwap = /第\s*([0-9一二三四五六七八九十]+)\s*镜\s*(?:和|与|跟)\s*第\s*([0-9一二三四五六七八九十]+)\s*镜\s*(?:换|调换|交换)/.exec(text)
    if (shotSwap && project.kind === 'drama') {
      const first = chineseNumber(shotSwap[1])
      const second = chineseNumber(shotSwap[2])
      const left = first ? project.shots.find((item) => item.number === first) : undefined
      const right = second ? project.shots.find((item) => item.number === second) : undefined
      if (left && right && first && second) {
        return {
          title: '镜头顺序调整',
          summary: `交换第 ${first} 镜与第 ${second} 镜`,
          actions: [
            { type: 'move-shot', shotId: left.id, shotNumber: first, to: second },
            { type: 'move-shot', shotId: right.id, shotNumber: second, to: first }
          ],
          effects: [`交换第 ${first} 镜与第 ${second} 镜`],
          seconds: 0,
          cost: 0
        }
      }
    }
    const shotMove = /第\s*([0-9一二三四五六七八九十]+)\s*镜\s*(?:移到|移动到|挪到|放到|调到|排到)\s*(最前面|最后面|开头|结尾|第\s*([0-9一二三四五六七八九十]+)\s*(?:镜|位)?\s*(前面|后面|之前|之后)?)/.exec(text)
    if (shotMove && project.kind === 'drama') {
      const from = chineseNumber(shotMove[1])
      if (from) {
        const tail = shotMove[2]
        let to = 0
        if (/最前面|开头/.test(tail)) to = 1
        else if (/最后面|结尾/.test(tail)) to = Math.max(1, project.shots.length)
        else {
          const target = chineseNumber(shotMove[3] ?? '')
          if (target) to = target + (/后面|之后/.test(shotMove[4] ?? '') ? 1 : 0)
        }
        if (to) {
          const target = project.shots.find((item) => item.number === from)
          return {
            title: '镜头顺序调整',
            summary: `把第 ${from} 镜移到第 ${to} 位`,
            actions: [{ type: 'move-shot', ...(target ? { shotId: target.id } : {}), shotNumber: from, to }],
            effects: [`把第 ${from} 镜移到第 ${to} 位`],
            seconds: 0,
            cost: 0
          }
        }
      }
    }
  }
  // 正文改写不再生成“本地改写”候选：正文必须由真实模型写作，写作台提供润色/改写入口。
  // 重新生成类：只排队，确认后执行。
  if (shot) {
    if (/重新生成|重做|再画|换个画面|换一张/.test(text) && /画面|分镜|图/.test(text)) {
      actions.push({ type: 'regenerate-shot-image', shotId: shot.id, instruction: text })
      effects.push(`重做第 ${shot.number} 镜画面，保留旧候选`)
      seconds += 60
      cost = null
    }
    if (/重新生成|重做|升级|生成/.test(text) && /视频|动态/.test(text)) {
      actions.push({ type: 'regenerate-shot-video', shotId: shot.id, instruction: text })
      effects.push(`把第 ${shot.number} 镜升级为视频，保留分镜图`)
      seconds += 120
      cost = null
    }
    if (/重新配音|重配|再配/.test(text)) {
      actions.push({ type: 'regenerate-voice', shotId: shot.id, instruction: text })
      effects.push(`重新生成第 ${shot.number} 镜的配音`)
      seconds += 10
      cost = 0
    }
  }

  // 时间线类修改：只动具体片段。
  const timelineActionable = shot || ctx.selection?.kind === 'clip' || /镜\s*0?\d+|字幕|雨声|音乐|配乐|音量|速度|慢|快/.test(text)
  if (timelineActionable) {
    const clips = shot ? clipsForShot(project, shot.id) : []
    if (ctx.selection?.kind === 'clip') {
      const selected = project.timeline.clips.find((clip) => clip.id === ctx.selection?.id)
      if (selected && !clips.some((clip) => clip.id === selected.id)) clips.push(selected)
    }
    const speedPercent = percentFrom(text)
    if (/\d+\s*%|慢|快|加速|减速|速度/.test(text) && (shot || ctx.selection?.kind === 'clip')) {
      const slow = /慢|减速/.test(text)
      const fast = /快|加速/.test(text)
      const factor = speedPercent !== null ? (slow ? 1 - speedPercent / 100 : fast ? 1 + speedPercent / 100 : 1) : /一半/.test(text) ? 0.5 : slow ? 0.8 : fast ? 1.2 : 1
      const speed = Math.max(0.25, Math.min(4, Number(factor.toFixed(2))))
      if (speed !== 1) {
        for (const clip of clips.filter((item) => item.kind === 'video' || item.kind === 'dialogue')) {
          actions.push({ type: 'set-clip-speed', clipId: clip.id, value: speed })
        }
        if (!clips.length && shot) {
          // 尚未装配时间线时，先记到镜头时长上更符合直觉
          const nextDuration = Math.max(1, Number((shot.durationSec / speed).toFixed(1)))
          actions.push({ type: 'set-clip-duration', shotId: shot.id, value: nextDuration })
          effects.push(`第 ${shot.number} 镜时长调整为 ${nextDuration} 秒（按 ${speed}× 速度换算）`)
        } else {
          effects.push(`${shot ? `第 ${shot.number} 镜` : '所选片段'}速度 ${speed}×`)
        }
        seconds += 8
      }
    }
    const volumeIntent = /压低|降低|小一点|轻一点|调大|大一点|响一点|音量/.test(text)
    if (volumeIntent) {
      const down = /压低|降低|小一点|轻一点|降/.test(text)
      const up = /调大|大一点|响一点|提高|升/.test(text)
      const factor = down ? 0.7 : up ? 1.25 : 1
      const wantsSfx = /雨声|音效|环境声|伞骨|心跳/.test(text)
      const wantsMusic = /音乐|配乐|钢琴|BGM/.test(text)
      const wantsVoice = /配音|对白|人声|台词/.test(text)
      const kindFor = (clip: StudioClip): boolean => {
        if (wantsSfx) return clip.kind === 'sfx'
        if (wantsMusic) return clip.kind === 'music'
        if (wantsVoice) return clip.kind === 'dialogue'
        return clip.kind === 'dialogue' || clip.kind === 'music' || clip.kind === 'sfx'
      }
      let targets = clips.filter(kindFor)
      if (!targets.length) {
        targets = project.timeline.clips.filter(kindFor)
      }
      // “雨声”只动雨声轨里带“雨”的片段，不连带伞骨和心跳。
      if (wantsSfx && /雨/.test(text)) {
        const rain = targets.filter((clip) => `${clip.label} ${project.assets.find((asset) => asset.id === clip.assetId)?.title ?? ''}`.includes('雨'))
        if (rain.length) targets = rain
      }
      for (const clip of targets) {
        actions.push({ type: 'set-clip-volume', clipId: clip.id, value: Number((clip.volume * factor).toFixed(2)) })
      }
      if (targets.length) effects.push(`${wantsSfx ? '音效' : wantsMusic ? '音乐' : wantsVoice ? '对白' : '音频'}音量${down ? '降低' : up ? '提高' : '调整'}`)
      else if (/雨声|音乐|音效|配音/.test(text)) noteLines.push('当前时间线里还没有对应的音频片段，无法直接调音量。')
      seconds += 5
    }
    if (/字幕/.test(text) && /上|高|下|低|挪|移/.test(text)) {
      const up = /上|高/.test(text)
      const subtitleClips = clips.filter((clip) => clip.kind === 'subtitle')
      for (const clip of subtitleClips) {
        const current = clip.style?.yPercent ?? 86
        actions.push({ type: 'set-subtitle-position', clipId: clip.id, value: Math.max(4, Math.min(94, current + (up ? -6 : 6))) })
      }
      if (subtitleClips.length) effects.push(`字幕${up ? '上移' : '下移'} 6%`)
      else noteLines.push('这一镜还没有字幕片段。')
      seconds += 4
    }
    if (/转场|淡入|淡出|硬切/.test(text)) {
      const transition = /硬切|不要转场|直接切/.test(text) ? 'cut' : /淡出/.test(text) ? 'fade-out' : /淡入/.test(text) ? 'fade-in' : 'fade-both'
      for (const clip of clips.filter((item) => item.kind === 'video')) {
        actions.push({ type: 'set-transition', clipId: clip.id, value: 0, text: transition })
      }
      if (clips.some((clip) => clip.kind === 'video')) effects.push(`画面转场改为${transition === 'cut' ? '硬切' : '淡入淡出'}`)
      seconds += 3
    }
    if (/时长|缩短|延长|短一点|长一点/.test(text) && shot) {
      const secondsMatch = /(\d+(?:\.\d+)?)\s*秒/.exec(text)
      const delta = secondsMatch ? Number(secondsMatch[1]) : 2
      const next = Math.max(1, shot.durationSec + (/延长|长/.test(text) ? delta : -delta))
      actions.push({ type: 'set-clip-duration', shotId: shot.id, value: next })
      effects.push(`第 ${shot.number} 镜时长改为 ${next} 秒`)
      seconds += 4
    }
  }

  // 声音页的“加一段雨声/换配乐”不依赖时间线已有片段，直接排队生成。
  if (actions.length === 0) {
    const concreteSfx = /雨声|伞骨|心跳|街声/.test(text)
    const wantsSfx = !/去掉|删掉|不要|关掉|移除/.test(text) && ((concreteSfx && /加|来|生成|铺|要|补|换|做|再/.test(text)) || (/音效/.test(text) && /生成|加一段|来一段|补一段|做一段/.test(text)))
    if (wantsSfx) {
      const kind = /心跳/.test(text) ? 'heartbeat' : /伞/.test(text) ? 'umbrella' : /街|车|环境/.test(text) ? 'street' : 'rain'
      actions.push({ type: 'generate-sfx', sfx: { kind, seconds: 8 }, instruction: text })
      effects.push(`生成音效：${kind === 'heartbeat' ? '心跳' : kind === 'umbrella' ? '伞骨' : kind === 'street' ? '街声' : '雨声'}`)
      seconds += 6
    }
    const wantsMusic = /配乐|音乐|BGM/.test(text) && /生成|来|换|重做|要|补|做|配|再/.test(text) && !/去掉|删掉|不要|关掉|移除/.test(text)
    if (wantsMusic) {
      actions.push({ type: 'generate-music', music: { mood: text.replace(/[，。！？,.!?]/g, ' ').trim().slice(0, 40) }, instruction: text })
      effects.push('生成新配乐')
      seconds += 20
    }
    if (/去掉|删掉|不要|关掉|移除/.test(text) && /雨声|伞骨|心跳|街声|音效/.test(text)) {
      const kind = /心跳/.test(text) ? 'heartbeat' : /伞/.test(text) ? 'umbrella' : /街|车|环境/.test(text) ? 'street' : 'rain'
      actions.push({ type: 'remove-sfx', sfx: { kind }, instruction: text })
      effects.push(`移除音效：${kind === 'heartbeat' ? '心跳' : kind === 'umbrella' ? '伞骨' : kind === 'street' ? '街声' : '雨声'}`)
      seconds += 3
    }
    if (/去掉|删掉|不要|关掉|移除/.test(text) && /配乐|音乐|BGM/.test(text)) {
      actions.push({ type: 'remove-music', instruction: text })
      effects.push('移除配乐')
      seconds += 3
    }
  }

  const lockFace = /不要改脸|不改脸|脸不变|保持.*脸/.test(text)
  const lockRain = /雨.*方向.*不|保持.*雨向/.test(text)
  if (lockFace || lockRain) {
    const note = [lockFace ? '保持角色面部' : '', lockRain ? '保持雨向' : ''].filter(Boolean).join('与')
    actions.push({ type: 'lock-reference', ...(shot ? { shotId: shot.id } : {}), target: shot ? shot.id : 'shot', note: `${note}，不修改参考` })
    effects.push(`锁定${note}，不纳入本次改动`)
    noteLines.push(`已把“${note}”记为约束，重做时会写入提示词。`)
  }

  if (actions.length === 0) {
    const help = project.kind === 'drama'
      ? '可以直接说：镜 03 慢 20%、雨声压低一点、字幕上移、重做镜 07 的画面、或“结尾更克制”。'
      : '可以直接说：第 3 章更克制一点、精简这一章、给第 5 章补一个细节，或者告诉我你想要的整体语气。'
    return {
      title: '还没有找到可执行的修改',
      summary: help,
      actions: [],
      effects: [],
      seconds: 0,
      cost: 0,
      note: help
    }
  }
  const uniqueActions = actions.filter((action, index, list) => {
    const key = `${action.type}:${action.clipId ?? action.chapterId ?? action.shotId ?? action.target}:${action.value ?? action.text ?? ''}`
    return list.findIndex((item) => `${item.type}:${item.clipId ?? item.chapterId ?? item.shotId ?? item.target}:${item.value ?? item.text ?? ''}` === key) === index
  })
  const uniqueEffects = [...new Set([...effects, ...noteLines])]
  const title = uniqueActions.some((action) => action.type === 'rewrite-chapter')
    ? '正文改写计划'
    : uniqueActions.some((action) => action.type === 'generate-sfx' || action.type === 'generate-music' || action.type === 'remove-sfx' || action.type === 'remove-music')
      ? '声音修改计划'
      : uniqueActions.some((action) => action.type === 'regenerate-shot-image' || action.type === 'regenerate-shot-video')
        ? '镜头重做计划'
        : '时间线修改计划'
  return {
    title,
    summary: uniqueEffects.join('；'),
    actions: uniqueActions,
    effects: uniqueEffects,
    seconds,
    cost,
    ...(noteLines.length ? { note: noteLines.join(' ') } : {})
  }
}

export interface ApplyPlanResult {
  project: StudioProject
  regenerate: ApplyPlanRegenerate[]
  timelineChanged: boolean
  storyboardChanged: boolean
  chapterCandidates: number
  stage?: StudioStageId
}

function appendShotFromSeed(project: StudioProject, seed: StudioShotSeed): StudioShot {
  if (!project.blueprint) throw new Error('蓝图尚未建立，无法补全分镜。')
  let scene = project.scenes.find((item) => item.number === seed.sceneIndex)
  if (!scene) {
    const blueprintSeed = project.blueprint.scenes?.[seed.sceneIndex - 1]
    if (!blueprintSeed) throw new Error(`找不到第 ${seed.sceneIndex} 场，无法写入第 ${seed.number} 镜。`)
    scene = {
      id: studioId('scene'),
      episodeId: project.episodes[0]?.id ?? '',
      number: seed.sceneIndex,
      title: blueprintSeed.title,
      synopsis: blueprintSeed.synopsis,
      location: blueprintSeed.location,
      timeOfDay: blueprintSeed.timeOfDay,
      characters: [...blueprintSeed.characters],
      beat: 'Confrontation',
      updatedAt: nowMs()
    }
    project.scenes.push(scene)
  }
  if (project.shots.some((shot) => shot.number === seed.number)) {
    throw new Error(`第 ${seed.number} 镜已经存在，拒绝重复写入。`)
  }
  const speakerCharacter = project.characters.find((character) => character.name === seed.speaker)
  const sceneCharacters = scene.characters
    .map((name) => project.characters.find((character) => character.name === name))
    .filter((character): character is StudioCharacter => Boolean(character))
  const referenceCharacters = [...new Map([
    ...(speakerCharacter ? [speakerCharacter] : []),
    ...sceneCharacters
  ].map((character) => [character.id, character])).values()]
  const place = project.places.find((item) => item.name === scene.location)
  const shot: StudioShot = {
    id: studioId('shot'),
    sceneId: scene.id,
    number: seed.number,
    title: seed.title,
    action: seed.action,
    camera: seed.camera || '固定镜头',
    shotSize: seed.shotSize || '中景',
    durationSec: Math.max(3, Math.min(20, seed.durationSec || 8)),
    dialogue: seed.dialogue,
    speaker: seed.speaker,
    voiceId: speakerCharacter?.voiceId ?? '',
    prompt: seed.prompt || `${seed.title}。${seed.action}。${scene.location}。第 ${seed.number} 镜。`,
    negative: seed.negative,
    referenceCharacterIds: referenceCharacters.map((character) => character.id),
    referencePlaceIds: place ? [place.id] : [],
    referencePropIds: [],
    imageAssetId: null,
    videoAssetId: null,
    voiceAssetId: null,
    imageCandidates: [],
    videoCandidates: [],
    continuity: seed.continuity,
    lockedReference: false,
    status: 'ready',
    updatedAt: nowMs()
  }
  project.shots.push(shot)
  return shot
}

function syncBlueprintAfterShotAppend(project: StudioProject): void {
  if (!project.blueprint) return
  const blueprint = project.blueprint
  const shots = [...project.shots].sort((left, right) => left.number - right.number)
  const units = [...blueprint.units]
  for (const shot of shots) {
    if (units.some((unit) => unit.index === shot.number)) continue
    units.push({
      index: shot.number,
      title: shot.title,
      summary: shot.action,
      seconds: shot.durationSec,
      camera: shot.camera,
      shotSize: shot.shotSize,
      dialogue: shot.dialogue,
      speaker: shot.speaker
    })
  }
  units.sort((left, right) => left.index - right.index)
  const scenes = [...project.scenes].sort((left, right) => left.number - right.number)
  blueprint.units = units
  blueprint.scenes = scenes.map((scene, index) => {
    const numbers = shots.filter((shot) => shot.sceneId === scene.id).map((shot) => shot.number)
    const previous = blueprint.scenes?.[index]
    return {
      title: scene.title,
      synopsis: scene.synopsis,
      location: scene.location,
      timeOfDay: scene.timeOfDay,
      characters: [...scene.characters],
      unitStart: numbers.length ? Math.min(...numbers) : previous?.unitStart ?? index + 1,
      unitEnd: numbers.length ? Math.max(...numbers) : previous?.unitEnd ?? index + 1
    }
  })
  const episode = project.episodes[0]
  if (episode) {
    episode.sceneIds = scenes.map((scene) => scene.id)
    episode.durationSec = shots.reduce((sum, shot) => sum + shot.durationSec, 0)
    episode.updatedAt = nowMs()
    project.episodes = [episode]
  }
}

function patchCharacter(character: StudioCharacter, index: number): StudioCharacter {
  const name = character.name?.trim() || `人物 ${index + 1}`
  return {
    id: character.id || studioId('char'),
    name,
    role: character.role?.trim() || '配角',
    ...(character.age ? { age: character.age.trim() } : {}),
    look: character.look?.trim() || '外观待定',
    ...(character.desire ? { desire: character.desire.trim() } : {}),
    ...(character.fear ? { fear: character.fear.trim() } : {}),
    ...(character.secret ? { secret: character.secret.trim() } : {}),
    ...(character.arc ? { arc: character.arc.trim() } : {}),
    relationships: Array.isArray(character.relationships)
      ? character.relationships.filter((item) => item?.target?.trim()).map((item) => ({ target: item.target.trim(), label: item.label?.trim() || '关系' }))
      : [],
    refAssetIds: Array.isArray(character.refAssetIds) ? [...character.refAssetIds] : []
  }
}

function applyBlueprintPatch(project: StudioProject, patch: StudioBlueprintPatch): void {
  const blueprint = project.blueprint
  if (!blueprint) throw new Error('还没有蓝图，无法更新蓝图。先在蓝图页生成并确认蓝图。')
  if (patch.title !== undefined) {
    blueprint.title = patch.title.trim().slice(0, 120)
    project.title = blueprint.title
    project.titleSource = 'user'
  }
  if (patch.logline !== undefined && patch.logline.trim()) project.logline = patch.logline.trim().slice(0, 1200)
  if (patch.genre !== undefined) {
    blueprint.genre = patch.genre.trim().slice(0, 120)
    project.brief.genre = blueprint.genre
  }
  if (patch.tone !== undefined) {
    blueprint.tone = patch.tone.trim().slice(0, 120)
    project.brief.tone = blueprint.tone
  }
  if (patch.audience !== undefined) {
    blueprint.audience = patch.audience.trim().slice(0, 120)
    project.brief.audience = blueprint.audience
  }
  if (patch.storyCore !== undefined) blueprint.storyCore = patch.storyCore.trim().slice(0, 1200)
  if (patch.emotion !== undefined) blueprint.emotion = patch.emotion.trim().slice(0, 400)
  if (patch.pitch !== undefined) blueprint.pitch = patch.pitch.trim().slice(0, 2000)
  if (patch.structure !== undefined) blueprint.structure = patch.structure.trim().slice(0, 1200)
  if (patch.styleBible) {
    blueprint.styleBible = { ...blueprint.styleBible, ...patch.styleBible }
    project.styleBible = { ...blueprint.styleBible }
  }
  if (patch.characters?.length) {
    blueprint.characters = patch.characters.map(patchCharacter)
    project.characters = blueprint.characters.map((character) => ({ ...character }))
    const allowed = new Set(project.characters.map((character) => character.name))
    for (const scene of project.scenes) {
      scene.characters = scene.characters.filter((name) => allowed.has(name))
      scene.updatedAt = nowMs()
    }
    for (const shot of project.shots) {
      if (shot.speaker && !allowed.has(shot.speaker)) {
        shot.speaker = ''
        shot.voiceAssetId = null
      }
      shot.referenceCharacterIds = shot.referenceCharacterIds.filter((id) => project.characters.some((character) => character.id === id))
      shot.updatedAt = nowMs()
    }
  }
  if (patch.places?.length) {
    blueprint.places = patch.places.map((place, index) => ({
      id: place.id || studioId('place'),
      name: place.name?.trim() || `地点 ${index + 1}`,
      description: place.description?.trim() || '地点说明待定',
      refAssetIds: Array.isArray(place.refAssetIds) ? [...place.refAssetIds] : []
    }))
    project.places = blueprint.places.map((place) => ({ ...place }))
  }
  syncCharacterFacts(project)
  project.stages.blueprint = {
    status: blueprint.approved ? 'done' : 'review',
    updatedAt: nowMs(),
    message: '协作者已按你的要求更新蓝图',
    progress: blueprint.approved ? 100 : 70
  }
  for (const stageId of ['outline', 'writing', 'storyboard', 'visuals', 'voice', 'timeline', 'review', 'delivery'] as const) {
    const stage = project.stages[stageId]
    if (stage && (stage.status === 'done' || stage.status === 'review')) {
      project.stages[stageId] = { ...stage, status: 'stale', updatedAt: nowMs(), message: '蓝图已更新，这一步需要重新核对' }
    }
  }
  project.stage = 'blueprint'
}

function replaceNameDeep(value: string, from: string, to: string): string {
  if (!value || !from) return value
  return value.split(from).join(to)
}

function renameEntity(project: StudioProject, rename: StudioRenameRequest): void {
  const from = rename.from.trim()
  const to = rename.to.trim()
  if (!from || !to || from === to) throw new Error('改名需要明确原来的名字和新的名字。')
  if (rename.target === 'character') {
    const character = project.characters.find((item) => item.name === from)
    if (!character) throw new Error(`人物列表里没有「${from}」。`)
    character.name = to
    for (const item of project.characters) {
      for (const relationship of item.relationships) {
        if (relationship.target === from) relationship.target = to
      }
    }
    for (const scene of project.scenes) scene.characters = scene.characters.map((name) => name === from ? to : name)
    for (const shot of project.shots) {
      if (shot.speaker === from) shot.speaker = to
      shot.title = replaceNameDeep(shot.title, from, to)
      shot.action = replaceNameDeep(shot.action, from, to)
      shot.dialogue = replaceNameDeep(shot.dialogue, from, to)
      shot.continuity = replaceNameDeep(shot.continuity, from, to)
      shot.prompt = replaceNameDeep(shot.prompt, from, to)
      shot.negative = replaceNameDeep(shot.negative, from, to)
      shot.updatedAt = nowMs()
    }
    if (project.blueprint) {
      project.blueprint.characters = project.characters.map((item) => ({ ...item }))
      project.blueprint.scenes = project.blueprint.scenes?.map((scene) => ({
        ...scene,
        characters: scene.characters.map((name) => name === from ? to : name)
      }))
    }
  } else {
    const place = project.places.find((item) => item.name === from)
    if (!place) throw new Error(`地点列表里没有「${from}」。`)
    place.name = to
    for (const scene of project.scenes) if (scene.location === from) scene.location = to
    if (project.blueprint) {
      project.blueprint.places = project.places.map((item) => ({ ...item }))
      project.blueprint.scenes = project.blueprint.scenes?.map((scene) => scene.location === from ? { ...scene, location: to } : scene)
    }
  }
  project.logline = replaceNameDeep(project.logline, from, to)
  if (project.blueprint) {
    project.blueprint.storyCore = replaceNameDeep(project.blueprint.storyCore, from, to)
    project.blueprint.pitch = replaceNameDeep(project.blueprint.pitch, from, to)
    project.blueprint.structure = replaceNameDeep(project.blueprint.structure, from, to)
    project.blueprint.emotion = replaceNameDeep(project.blueprint.emotion, from, to)
    project.blueprint.units = project.blueprint.units.map((unit) => ({
      ...unit,
      title: replaceNameDeep(unit.title, from, to),
      summary: replaceNameDeep(unit.summary, from, to),
      dialogue: unit.dialogue ? replaceNameDeep(unit.dialogue, from, to) : unit.dialogue,
      speaker: unit.speaker === from ? to : unit.speaker,
      beats: unit.beats?.map((beat) => replaceNameDeep(beat, from, to))
    }))
    if (project.blueprint.facts) {
      project.blueprint.facts = project.blueprint.facts.map((fact) => ({
        ...fact,
        subject: replaceNameDeep(fact.subject, from, to),
        object: replaceNameDeep(fact.object, from, to)
      }))
    }
  }
  for (const chapter of project.chapters) {
    chapter.title = replaceNameDeep(chapter.title, from, to)
    chapter.synopsis = replaceNameDeep(chapter.synopsis, from, to)
    chapter.summary = chapter.summary ? replaceNameDeep(chapter.summary, from, to) : chapter.summary
    chapter.beats = chapter.beats.map((beat) => replaceNameDeep(beat, from, to))
    chapter.content = replaceNameDeep(chapter.content, from, to)
    chapter.updatedAt = nowMs()
  }
  for (const fact of project.facts) {
    fact.subject = replaceNameDeep(fact.subject, from, to)
    fact.object = replaceNameDeep(fact.object, from, to)
  }
  for (const clip of project.timeline.clips) {
    clip.label = replaceNameDeep(clip.label, from, to)
    if (clip.text) clip.text = replaceNameDeep(clip.text, from, to)
  }
  const changedStages: StudioStageId[] = ['visuals', 'voice', 'timeline', 'review', 'delivery']
  for (const stageId of changedStages) {
    const stage = project.stages[stageId]
    if (stage && (stage.status === 'done' || stage.status === 'review')) {
      project.stages[stageId] = { ...stage, status: 'stale', updatedAt: nowMs(), message: '人物或地点已改名，旧素材需要重新核对' }
    }
  }
}

function patchOutlineUnit(unit: Partial<StudioBlueprintUnit> & { index?: number }, fallback?: StudioBlueprintUnit): StudioBlueprintUnit {
  const index = Math.max(1, Math.round(unit.index || fallback?.index || 1))
  return {
    ...(fallback ?? { index, title: `第 ${index} 章`, summary: '' }),
    index,
    title: unit.title?.trim().slice(0, 160) || fallback?.title || `第 ${index} 章`,
    summary: unit.summary?.trim().slice(0, 1200) || fallback?.summary || '',
    ...(unit.wordTarget ? { wordTarget: Math.max(500, Math.min(20_000, Math.round(unit.wordTarget))) } : {}),
    ...(unit.seconds ? { seconds: Math.max(1, Math.min(120, unit.seconds)) } : {}),
    ...(unit.camera ? { camera: unit.camera.trim().slice(0, 200) } : {}),
    ...(unit.shotSize ? { shotSize: unit.shotSize.trim().slice(0, 80) } : {}),
    ...(unit.dialogue !== undefined ? { dialogue: unit.dialogue.trim().slice(0, 500) } : {}),
    ...(unit.speaker !== undefined ? { speaker: unit.speaker.trim().slice(0, 80) } : {}),
    ...(unit.beats?.length ? { beats: unit.beats.map((beat) => beat.trim()).filter(Boolean).slice(0, 8) } : {})
  }
}

function applyOutlinePatch(project: StudioProject, patch: StudioOutlinePatch): void {
  const blueprint = project.blueprint
  if (!blueprint) throw new Error('还没有蓝图，无法更新大纲。')
  if (!patch.units?.length) throw new Error('大纲修改没有给出任何单元。')
  const byIndex = new Map(blueprint.units.map((unit) => [unit.index, unit]))
  for (const raw of patch.units) {
    const existing = byIndex.get(Math.max(1, Math.round(raw.index || 0)))
    const next = patchOutlineUnit(raw, existing)
    byIndex.set(next.index, next)
  }
  blueprint.units = [...byIndex.values()].sort((left, right) => left.index - right.index)
  if (patch.scenes?.length) {
    const scenes = [...(blueprint.scenes ?? [])]
    for (const seed of patch.scenes) {
      const index = Math.max(1, Math.round(seed.unitStart || 0))
      const existingIndex = scenes.findIndex((scene, position) => position + 1 === index)
      const next = {
        title: seed.title?.trim() || `第 ${index} 场`,
        synopsis: seed.synopsis?.trim() || '',
        location: seed.location?.trim() || '',
        timeOfDay: seed.timeOfDay?.trim() || '',
        characters: Array.isArray(seed.characters) ? seed.characters.filter(Boolean).slice(0, 20) : [],
        unitStart: Math.max(1, Math.round(seed.unitStart || index)),
        unitEnd: Math.max(1, Math.round(seed.unitEnd || index)),
        ...(seed.sourceChapter ? { sourceChapter: seed.sourceChapter } : {})
      }
      if (existingIndex >= 0) scenes[existingIndex] = next
      else scenes.push(next)
    }
    blueprint.scenes = scenes
  }
  blueprint.outlineModel = project.runtime.textModelNote ?? blueprint.outlineModel
  if (project.kind === 'drama') {
    if (project.shots.length) syncDramaOutline(project, blueprint)
    else applyDramaOutline(project, blueprint)
    project.stages.outline = { status: 'done', updatedAt: nowMs(), message: '协作者已更新镜头计划', progress: 100 }
    if (project.stages.storyboard.status === 'done' || project.stages.storyboard.status === 'review') {
      project.stages.storyboard = { ...project.stages.storyboard, status: 'stale', updatedAt: nowMs(), message: '大纲已更新，分镜需要核对' }
    }
    for (const stageId of ['visuals', 'voice', 'timeline', 'review', 'delivery'] as const) {
      const stage = project.stages[stageId]
      if (stage && (stage.status === 'done' || stage.status === 'review')) {
        project.stages[stageId] = { ...stage, status: 'stale', updatedAt: nowMs(), message: '大纲已更新，旧素材需要重新核对' }
      }
    }
    project.stage = 'outline'
  } else {
    if (project.chapters.some((chapter) => chapter.content.trim())) {
      updateNovelOutline(project, blueprint)
      const extras = project.chapters.filter((chapter) => chapter.number > blueprint.units.length && !chapter.content.trim() && !chapter.candidates.length)
      if (extras.length) {
        project.chapters = project.chapters.filter((chapter) => !extras.includes(chapter))
        for (const volume of project.volumes) volume.chapterIds = volume.chapterIds.filter((id) => project.chapters.some((chapter) => chapter.id === id))
      }
      project.stages.outline = { status: 'done', updatedAt: nowMs(), message: '协作者已更新章纲，正文保持不变', progress: 100 }
      project.stages.writing = { status: 'stale', updatedAt: nowMs(), message: '章纲已更新，已有正文需要核对', progress: 60 }
    } else {
      applyNovelOutline(project, blueprint)
      project.stages.outline = { status: 'done', updatedAt: nowMs(), message: '协作者已更新章纲', progress: 100 }
      project.stages.writing = { status: 'ready', updatedAt: nowMs(), message: '可以按新章纲开始写', progress: 0 }
    }
    thisMarkStale(project, ['review', 'delivery'], '章纲已更新，旧检查与交付需要重新核对')
    project.stage = 'outline'
  }
  project.updatedAt = nowMs()
}

function thisMarkStale(project: StudioProject, stageIds: StudioStageId[], message: string): void {
  for (const stageId of stageIds) {
    const stage = project.stages[stageId]
    if (stage && (stage.status === 'done' || stage.status === 'review')) {
      project.stages[stageId] = { ...stage, status: 'stale', updatedAt: nowMs(), message }
    }
  }
}

function applyChapterPatch(project: StudioProject, action: StudioEditAction): void {
  const patch = action.chapter
  if (!patch) throw new Error('章节修改没有给出内容。')
  const chapter = action.chapterId
    ? project.chapters.find((item) => item.id === action.chapterId)
    : project.chapters.find((item) => item.number === (action.chapterNumber ?? patch.number))
  if (!chapter) throw new Error(`找不到第 ${action.chapterNumber ?? patch.number ?? '?'} 章。`)
  if (patch.title !== undefined) chapter.title = patch.title.trim().slice(0, 160) || chapter.title
  if (patch.synopsis !== undefined) chapter.synopsis = patch.synopsis.trim().slice(0, 2000)
  if (patch.beats?.length) chapter.beats = patch.beats.map((beat) => beat.trim()).filter(Boolean).slice(0, 12)
  if (patch.content !== undefined) {
    const content = stripProseDecorations(patch.content)
    if (!content.trim()) throw new Error('新正文是空的，已拒绝覆盖。')
    if (chapter.content.trim()) {
      chapter.versions.unshift({ id: studioId('cv'), content: chapter.content, createdAt: nowMs(), reason: '协作者替换前自动留档', wordCount: countWords(chapter.content) })
      chapter.versions = chapter.versions.slice(0, 30)
    }
    chapter.content = content
    chapter.summary = summarizeChapterText(content)
    chapter.revision += 1
    chapter.status = 'done'
    chapter.updatedAt = nowMs()
    project.stages.writing = { status: 'done', updatedAt: nowMs(), message: `第 ${chapter.number} 章已由协作者替换（${countWords(content)} 字）`, progress: 100 }
    thisMarkStale(project, ['review', 'delivery'], '正文已更新，旧检查与交付需要重新生成')
    project.stage = 'writing'
  } else {
    chapter.updatedAt = nowMs()
    project.stages.outline = { status: 'done', updatedAt: nowMs(), message: '章节信息已更新', progress: 100 }
    project.stage = 'outline'
  }
  project.updatedAt = nowMs()
}

function applyShotPatch(project: StudioProject, action: StudioEditAction): { shot: StudioShot; voiceChanged: boolean } {
  const patch = action.shot
  if (!patch) throw new Error('镜头修改没有给出内容。')
  const shot = action.shotId
    ? project.shots.find((item) => item.id === action.shotId)
    : project.shots.find((item) => item.number === (action.shotNumber ?? patch.number))
  if (!shot) throw new Error(`找不到第 ${action.shotNumber ?? patch.number ?? '?'} 镜。`)
  const previousDialogue = shot.dialogue
  const previousAction = shot.action
  const previousSpeaker = shot.speaker
  const previousVoiceId = shot.voiceId
  if (patch.sceneIndex) {
    const scene = project.scenes.find((item) => item.number === patch.sceneIndex)
    if (scene) shot.sceneId = scene.id
  }
  if (patch.title !== undefined) shot.title = patch.title.trim().slice(0, 160) || shot.title
  if (patch.action !== undefined) shot.action = patch.action.trim().slice(0, 2000) || shot.action
  if (patch.camera !== undefined) shot.camera = patch.camera.trim().slice(0, 200) || shot.camera
  if (patch.shotSize !== undefined) shot.shotSize = patch.shotSize.trim().slice(0, 80) || shot.shotSize
  if (patch.durationSec !== undefined) shot.durationSec = Math.max(3, Math.min(20, Math.round(patch.durationSec * 10) / 10))
  if (patch.dialogue !== undefined) shot.dialogue = patch.dialogue.trim().slice(0, 500)
  if (patch.speaker !== undefined) shot.speaker = patch.speaker.trim().slice(0, 80)
  if (shot.speaker !== previousSpeaker) {
    shot.voiceId = project.characters.find((character) => character.name === shot.speaker)?.voiceId ?? shot.voiceId
    shot.voiceAssetId = null
  }
  if (patch.voiceId !== undefined) shot.voiceId = patch.voiceId.trim().slice(0, 200)
  if (patch.continuity !== undefined) shot.continuity = patch.continuity.trim().slice(0, 500)
  if (patch.prompt !== undefined) shot.prompt = patch.prompt.trim().slice(0, 4000) || shot.prompt
  if (patch.negative !== undefined) shot.negative = patch.negative.trim().slice(0, 1000)
  const voiceChanged = shot.dialogue !== previousDialogue || shot.speaker !== previousSpeaker || shot.voiceId !== previousVoiceId
  if (voiceChanged) shot.voiceAssetId = null
  if (shot.action !== previousAction && (shot.imageAssetId || shot.videoAssetId)) shot.status = 'stale'
  shot.updatedAt = nowMs()
  const unit = project.blueprint?.units.find((item) => item.index === shot.number)
  if (unit) {
    unit.title = shot.title
    unit.summary = shot.action
    unit.seconds = shot.durationSec
    unit.camera = shot.camera
    unit.shotSize = shot.shotSize
    unit.dialogue = shot.dialogue
    unit.speaker = shot.speaker
  }
  project.stages.storyboard = { status: 'done', updatedAt: nowMs(), message: `第 ${shot.number} 镜已由协作者更新`, progress: 100 }
  thisMarkStale(project, ['visuals', 'voice', 'timeline', 'review', 'delivery'], '镜头文字已更新，旧画面、配音与交付需要重新核对')
  project.stage = 'storyboard'
  project.updatedAt = nowMs()
  return { shot, voiceChanged }
}

function syncCharacterFacts(project: StudioProject): void {
  const manualFacts = project.facts.filter((fact) => fact.source === 'manual')
  const generated: StudioFact[] = []
  for (const character of project.characters) {
    if (character.desire) {
      generated.push({ id: studioId('fact'), subject: character.name, predicate: '想要', object: character.desire, confidence: 0.85, source: 'ai', createdAt: nowMs() })
    }
    for (const relationship of character.relationships) {
      generated.push({ id: studioId('fact'), subject: character.name, predicate: `与${relationship.target}的关系`, object: relationship.label, confidence: 0.8, source: 'ai', createdAt: nowMs() })
    }
  }
  project.facts = [...manualFacts, ...generated]
}

function applyCharacterPatch(project: StudioProject, patch: StudioCharacterPatch): { shotIds: string[]; voiceChanged: boolean; visualChanged: boolean } {
  let character = project.characters.find((item) => item.name === patch.name)
  if (!character) throw new Error(`人物列表里没有「${patch.name}」。`)
  const previousName = character.name
  if (patch.newName && patch.newName.trim() && patch.newName.trim() !== previousName) {
    renameEntity(project, { target: 'character', from: previousName, to: patch.newName.trim() })
    character = project.characters.find((item) => item.name === patch.newName!.trim()) ?? character
  }
  const previousVoiceId = character.voiceId ?? ''
  const previousLook = character.look
  if (patch.role !== undefined) character.role = patch.role.trim().slice(0, 80) || character.role
  if (patch.age !== undefined) character.age = patch.age.trim().slice(0, 40) || undefined
  if (patch.look !== undefined) character.look = patch.look.trim().slice(0, 1000) || character.look
  if (patch.voiceId !== undefined) character.voiceId = patch.voiceId.trim().slice(0, 200) || undefined
  if (patch.desire !== undefined) character.desire = patch.desire.trim().slice(0, 400) || undefined
  if (patch.fear !== undefined) character.fear = patch.fear.trim().slice(0, 400) || undefined
  if (patch.secret !== undefined) character.secret = patch.secret.trim().slice(0, 400) || undefined
  if (patch.arc !== undefined) character.arc = patch.arc.trim().slice(0, 800) || undefined
  if (patch.relationships !== undefined) {
    character.relationships = patch.relationships
      .filter((item) => item?.target?.trim())
      .map((item) => ({ target: item.target.trim(), label: item.label?.trim() || '关系' }))
  }
  if (patch.refAssetIds !== undefined) character.refAssetIds = [...patch.refAssetIds]
  if (patch.locked !== undefined) character.locked = patch.locked
  const shotIds: string[] = []
  const voiceChanged = (character.voiceId ?? '') !== previousVoiceId
  if (voiceChanged) {
    for (const shot of project.shots) {
      if (shot.speaker !== character.name) continue
      shot.voiceId = character.voiceId ?? ''
      shot.voiceAssetId = null
      shot.updatedAt = nowMs()
      shotIds.push(shot.id)
    }
  }
  if (project.blueprint) {
    project.blueprint.characters = project.characters.map((item) => ({ ...item }))
    const allowed = new Set(project.characters.map((item) => item.name))
    for (const scene of project.scenes) {
      scene.characters = scene.characters.filter((name) => allowed.has(name))
      scene.updatedAt = nowMs()
    }
  }
  syncCharacterFacts(project)
  project.stages.blueprint = {
    status: project.blueprint?.approved ? 'done' : 'review',
    updatedAt: nowMs(),
    message: `协作者已更新人物「${character.name}」`,
    progress: project.blueprint?.approved ? 100 : 70
  }
  const visualChanged = character.look !== previousLook || patch.refAssetIds !== undefined
  if (visualChanged) thisMarkStale(project, ['visuals', 'storyboard'], '人物外观已更新，旧画面需要重新核对')
  if (voiceChanged) thisMarkStale(project, ['voice'], '人物声线已更新，旧配音需要重新生成')
  if (!voiceChanged && !visualChanged) thisMarkStale(project, ['outline'], '人物设定已更新，大纲需要核对')
  project.updatedAt = nowMs()
  return { shotIds, voiceChanged, visualChanged }
}

function applyPlacePatch(project: StudioProject, patch: StudioPlacePatch): { visualChanged: boolean } {
  let place = project.places.find((item) => item.name === patch.name)
  if (!place) throw new Error(`地点列表里没有「${patch.name}」。`)
  const previousName = place.name
  const previousDescription = place.description
  if (patch.newName && patch.newName.trim() && patch.newName.trim() !== previousName) {
    renameEntity(project, { target: 'place', from: previousName, to: patch.newName.trim() })
    place = project.places.find((item) => item.name === patch.newName!.trim()) ?? place
  }
  if (patch.description !== undefined) place.description = patch.description.trim().slice(0, 1200) || place.description
  if (patch.refAssetIds !== undefined) place.refAssetIds = [...patch.refAssetIds]
  if (project.blueprint) project.blueprint.places = project.places.map((item) => ({ ...item }))
  const visualChanged = place.description !== previousDescription || patch.refAssetIds !== undefined
  if (visualChanged) thisMarkStale(project, ['visuals', 'storyboard'], '地点设定已更新，旧画面需要重新核对')
  project.stages.blueprint = {
    status: project.blueprint?.approved ? 'done' : 'review',
    updatedAt: nowMs(),
    message: `协作者已更新地点「${place.name}」`,
    progress: project.blueprint?.approved ? 100 : 70
  }
  project.updatedAt = nowMs()
  return { visualChanged }
}

function moveChapter(project: StudioProject, action: StudioEditAction): void {
  if (project.kind === 'drama') throw new Error('漫剧没有正文章节，请用 move-shot 调整镜头顺序。')
  const to = Math.max(1, Math.round(action.to ?? 0))
  if (!to) throw new Error('没有给出章节要移动到的位置。')
  const chapters = [...project.chapters].sort((left, right) => left.number - right.number)
  if (!chapters.length) {
    if (!project.blueprint) throw new Error('还没有大纲，无法调整顺序。')
    const units = [...project.blueprint.units].sort((left, right) => left.index - right.index)
    const index = action.chapterId
      ? units.findIndex((unit) => String(unit.index) === action.chapterId)
      : units.findIndex((unit) => unit.index === action.chapterNumber)
    if (index < 0) throw new Error(`找不到第 ${action.chapterNumber ?? '?'} 个大纲单元。`)
    const [unit] = units.splice(index, 1)
    units.splice(Math.min(units.length, to - 1), 0, unit)
    project.blueprint.units = units.map((item, position) => ({ ...item, index: position + 1 }))
    project.stages.outline = { status: 'done', updatedAt: nowMs(), message: '大纲顺序已调整', progress: 100 }
    project.stage = 'outline'
    project.updatedAt = nowMs()
    return
  }
  const index = action.chapterId
    ? chapters.findIndex((chapter) => chapter.id === action.chapterId)
    : chapters.findIndex((chapter) => chapter.number === action.chapterNumber)
  if (index < 0) throw new Error(`找不到第 ${action.chapterNumber ?? '?'} 章。`)
  const oldNumbers = new Map(chapters.map((chapter) => [chapter.id, chapter.number]))
  const oldUnits = new Map((project.blueprint?.units ?? []).map((unit) => [unit.index, unit]))
  const [chapter] = chapters.splice(index, 1)
  chapters.splice(Math.min(chapters.length, to - 1), 0, chapter)
  const nextUnits: StudioBlueprintUnit[] = []
  chapters.forEach((item, position) => {
    const oldNumber = oldNumbers.get(item.id) ?? item.number
    const unit = oldUnits.get(oldNumber)
    nextUnits.push(unit
      ? { ...unit, index: position + 1 }
      : { index: position + 1, title: item.title, summary: item.synopsis, wordTarget: item.wordTarget, beats: [...item.beats] })
    item.number = position + 1
    item.updatedAt = nowMs()
  })
  for (const unit of oldUnits.values()) {
    if (unit.index > chapters.length) nextUnits.push({ ...unit, index: nextUnits.length + 1 })
  }
  project.chapters = chapters
  if (project.blueprint) project.blueprint.units = nextUnits
  for (const volume of project.volumes) {
    volume.chapterIds = chapters.filter((item) => item.volumeId === volume.id).map((item) => item.id)
  }
  project.stages.writing = { ...project.stages.writing, updatedAt: nowMs(), message: '章节顺序已调整', ...(project.stages.writing.status === 'waiting' ? { status: 'ready' as const } : {}) }
  thisMarkStale(project, ['review', 'delivery'], '章节顺序已调整，旧检查与交付需要重新核对')
  project.stage = 'writing'
  project.updatedAt = nowMs()
}

function moveShot(project: StudioProject, action: StudioEditAction): void {
  const to = Math.max(1, Math.round(action.to ?? 0))
  if (!to) throw new Error('没有给出镜头要移动到的位置。')
  const shots = [...project.shots].sort((left, right) => left.number - right.number)
  const index = action.shotId
    ? shots.findIndex((shot) => shot.id === action.shotId)
    : shots.findIndex((shot) => shot.number === action.shotNumber)
  if (index < 0) throw new Error(`找不到第 ${action.shotNumber ?? '?'} 镜。`)
  const oldNumbers = new Map(shots.map((shot) => [shot.id, shot.number]))
  const [shot] = shots.splice(index, 1)
  const insertAt = Math.min(shots.length, to - 1)
  const targetSceneId = shots[Math.min(shots.length - 1, insertAt)]?.sceneId
  shots.splice(insertAt, 0, shot)
  if (targetSceneId) shot.sceneId = targetSceneId
  const oldUnits = new Map((project.blueprint?.units ?? []).map((unit) => [unit.index, unit]))
  shots.forEach((item, position) => {
    item.number = position + 1
    item.updatedAt = nowMs()
  })
  project.shots = shots
  if (project.blueprint) {
    project.blueprint.units = shots.map((item) => {
      const oldNumber = oldNumbers.get(item.id) ?? item.number
      const unit = oldUnits.get(oldNumber)
      return {
        ...(unit ?? { index: item.number, title: item.title, summary: item.action }),
        index: item.number,
        title: item.title,
        summary: item.action,
        seconds: item.durationSec,
        camera: item.camera,
        shotSize: item.shotSize,
        dialogue: item.dialogue,
        speaker: item.speaker
      }
    })
    project.blueprint.scenes = project.scenes
      .slice()
      .sort((left, right) => left.number - right.number)
      .map((scene) => {
        const numbers = shots.filter((item) => item.sceneId === scene.id).map((item) => item.number)
        return {
          title: scene.title,
          synopsis: scene.synopsis,
          location: scene.location,
          timeOfDay: scene.timeOfDay,
          characters: [...scene.characters],
          unitStart: numbers.length ? Math.min(...numbers) : scene.number,
          unitEnd: numbers.length ? Math.max(...numbers) : scene.number
        }
      })
  }
  const episode = project.episodes[0]
  if (episode) {
    episode.sceneIds = project.scenes.slice().sort((left, right) => left.number - right.number).map((scene) => scene.id)
    episode.updatedAt = nowMs()
  }
  project.stages.storyboard = { status: 'done', updatedAt: nowMs(), message: `${project.shots.length} 镜顺序已调整`, progress: 100 }
  thisMarkStale(project, ['visuals', 'voice', 'timeline', 'review', 'delivery'], '镜头顺序已调整，旧画面、配音与交付需要重新核对')
  project.stage = 'storyboard'
  project.updatedAt = nowMs()
}

export interface ApplyPlanRegenerate {
  kind: 'image' | 'video' | 'voice' | 'sfx' | 'music' | 'chapter'
  shotId?: string
  shotIds?: string[]
  chapterId?: string
  instruction?: string
  voiceId?: string
  sfxKind?: 'rain' | 'umbrella' | 'heartbeat' | 'street'
  seconds?: number
  mood?: string
  engine?: 'model' | 'local'
}

export function applyEditPlan(project: StudioProject, plan: StudioEditPlan): ApplyPlanResult {
  if (!plan.actions.length) throw new Error('这个计划没有可执行的修改，已阻止应用。')
  let timelineChanged = false
  let storyboardChanged = false
  let chapterCandidates = 0
  let requestedStage: StudioStageId | undefined
  const regenerate: ApplyPlanResult['regenerate'] = []
  const shotIdFor = (action: StudioEditAction): string | undefined =>
    action.shotId ?? project.shots.find((shot) => shot.number === action.shotNumber)?.id
  const snapshot = {
    id: studioId('tl'),
    createdAt: nowMs(),
    reason: `应用修改计划：${plan.title}`,
    tracks: project.timeline.tracks.map((track) => ({ ...track })),
    clips: project.timeline.clips.map((clip) => ({ ...clip, style: clip.style ? { ...clip.style } : undefined }))
  }
  const mutateClip = (clipId: string, mutate: (clip: StudioClip) => void): void => {
    const clip = project.timeline.clips.find((item) => item.id === clipId)
    if (!clip) return
    mutate(clip)
    timelineChanged = true
  }
  const lockNotes = (shotId: string): string[] =>
    plan.actions
      .filter((item) => item.type === 'lock-reference' && item.note && (!item.shotId || item.shotId === shotId))
      .map((item) => item.note as string)
  const withLockNotes = (shotId: string, instruction?: string): string =>
    [instruction?.trim(), ...lockNotes(shotId)].filter(Boolean).join('；')
  for (const action of plan.actions) {
    switch (action.type) {
      case 'set-clip-speed':
        if (action.clipId && typeof action.value === 'number') mutateClip(action.clipId, (clip) => { clip.speed = action.value as number })
        break
      case 'set-clip-volume':
        if (action.clipId && typeof action.value === 'number') mutateClip(action.clipId, (clip) => { clip.volume = action.value as number })
        break
      case 'set-subtitle-position':
        if (action.clipId && typeof action.value === 'number') mutateClip(action.clipId, (clip) => { clip.style = { ...(clip.style ?? {}), yPercent: action.value as number } })
        break
      case 'set-transition':
        if (action.clipId && action.text) {
          mutateClip(action.clipId, (clip) => {
            clip.transition = action.text === 'fade-in' || action.text === 'fade-out' || action.text === 'fade-both' ? action.text : 'cut'
          })
        }
        break
      case 'set-clip-duration':
        if (action.shotId && typeof action.value === 'number') {
          const shot = project.shots.find((item) => item.id === action.shotId)
          if (shot) {
            const previous = shot.durationSec
            shot.durationSec = action.value
            shot.updatedAt = nowMs()
            const delta = action.value - previous
            for (const clip of project.timeline.clips.filter((item) => item.shotId === shot.id)) {
              clip.duration = Math.max(0.1, clip.duration + delta)
            }
            // 后续镜头整体顺延，避免重叠
            if (action.shotId) {
              for (const other of project.timeline.clips) {
                if (other.start > (project.timeline.clips.find((item) => item.shotId === action.shotId)?.start ?? 0)) other.start = Math.max(0, other.start + delta)
              }
            }
            timelineChanged = true
          }
        }
        break
      case 'set-track-volume':
        if (action.trackId && typeof action.value === 'number') {
          const track = project.timeline.tracks.find((item) => item.id === action.trackId)
          if (track) {
            track.volume = action.value
            timelineChanged = true
          }
        }
        break
      case 'rewrite-chapter': {
        const chapter = action.chapterId
          ? project.chapters.find((item) => item.id === action.chapterId)
          : project.chapters.find((item) => item.number === (action.chapterNumber ?? action.chapter?.number))
        if (!chapter) throw new Error('找不到要重写的章节。')
        regenerate.push({ kind: 'chapter', chapterId: chapter.id, instruction: action.instruction ?? action.text ?? '按协作者计划重写本章' })
        requestedStage = 'writing'
        break
      }

      case 'regenerate-shot-image': {
        const shotId = shotIdFor(action)
        if (shotId) regenerate.push({ kind: 'image', shotId, instruction: withLockNotes(shotId, action.instruction) })
        requestedStage = 'visuals'
        break
      }
      case 'regenerate-shot-video': {
        const shotId = shotIdFor(action)
        if (shotId) regenerate.push({ kind: 'video', shotId, instruction: withLockNotes(shotId, action.instruction) })
        requestedStage = 'visuals'
        break
      }
      case 'regenerate-voice': {
        const shotId = shotIdFor(action)
        if (action.scope === 'all' || (!shotId && !action.shotNumber)) {
          const shotIds = project.shots.filter((shot) => shot.dialogue.trim()).map((shot) => shot.id)
          if (!shotIds.length) throw new Error('还没有可配音的台词。')
          regenerate.push({ kind: 'voice', shotIds, instruction: action.instruction, voiceId: action.voiceId })
        } else if (shotId) {
          regenerate.push({ kind: 'voice', shotId, instruction: withLockNotes(shotId, action.instruction), voiceId: action.voiceId })
        } else {
          throw new Error(`找不到第 ${action.shotNumber ?? '?'} 镜，无法重配。`)
        }
        requestedStage = 'voice'
        break
      }
      case 'append-shots':
        if (action.shots?.length) {
          for (const seed of action.shots) appendShotFromSeed(project, seed)
          storyboardChanged = true
        }
        requestedStage = 'storyboard'
        break
      case 'lock-reference': {
        const shotId = shotIdFor(action)
        const shot = shotId ? project.shots.find((item) => item.id === shotId) : undefined
        if (shot) {
          shot.lockedReference = true
          const note = action.note?.trim()
          if (note && !shot.continuity.includes(note)) {
            shot.continuity = [shot.continuity, note].filter(Boolean).join('；')
          }
          shot.updatedAt = nowMs()
        }
        break
      }
      case 'update-blueprint':
        if (!action.blueprint) throw new Error('蓝图修改没有给出内容。')
        applyBlueprintPatch(project, action.blueprint)
        requestedStage = 'blueprint'
        break
      case 'replace-outline':
        if (!action.outline) throw new Error('大纲修改没有给出内容。')
        applyOutlinePatch(project, action.outline)
        requestedStage = 'outline'
        break
      case 'update-chapter':
        applyChapterPatch(project, action)
        requestedStage = project.stage
        break
      case 'update-shot': {
        const result = applyShotPatch(project, action)
        if (result.voiceChanged) {
          regenerate.push({ kind: 'voice', shotId: result.shot.id, instruction: action.instruction, voiceId: action.shot?.voiceId })
        }
        // 只改台词时仍停在分镜；明确改声线/说话人才跳到声音页。
        requestedStage = action.shot?.voiceId !== undefined || action.shot?.speaker !== undefined ? 'voice' : 'storyboard'
        break
      }
      case 'move-chapter':
        moveChapter(project, action)
        requestedStage = project.chapters.length ? 'writing' : 'outline'
        break
      case 'move-shot':
        moveShot(project, action)
        storyboardChanged = true
        requestedStage = 'storyboard'
        break
      case 'update-character': {
        if (!action.character) throw new Error('人物修改没有给出内容。')
        const result = applyCharacterPatch(project, action.character)
        if (result.voiceChanged && result.shotIds.length) {
          regenerate.push({ kind: 'voice', shotIds: result.shotIds, instruction: action.instruction ?? '人物声线已更新，按新声线重配', voiceId: action.character.voiceId })
        }
        requestedStage = result.voiceChanged && project.kind === 'drama' ? 'voice' : result.visualChanged && project.kind === 'drama' ? 'visuals' : 'blueprint'
        break
      }
      case 'update-place': {
        if (!action.place) throw new Error('地点修改没有给出内容。')
        const result = applyPlacePatch(project, action.place)
        requestedStage = result.visualChanged && project.kind === 'drama' ? 'visuals' : 'blueprint'
        break
      }
      case 'rename-entity':
        if (!action.rename) throw new Error('改名动作没有给出原名字和新名字。')
        renameEntity(project, action.rename)
        requestedStage = project.kind === 'drama' ? 'storyboard' : 'writing'
        break
      case 'generate-sfx': {
        if (!action.sfx?.kind) throw new Error('音效动作没有指定类型。')
        regenerate.push({ kind: 'sfx', sfxKind: action.sfx.kind, ...(action.sfx.seconds ? { seconds: action.sfx.seconds } : {}), instruction: action.instruction })
        project.stages.music = { status: 'ready', updatedAt: nowMs(), message: '音效任务已排队', progress: 30 }
        requestedStage = 'music'
        break
      }
      case 'generate-music': {
        regenerate.push({ kind: 'music', ...(action.music?.mood ? { mood: action.music.mood } : {}), ...(action.music?.seconds ? { seconds: action.music.seconds } : {}), ...(action.music?.engine ? { engine: action.music.engine } : {}), instruction: action.instruction })
        project.stages.music = { status: 'ready', updatedAt: nowMs(), message: '配乐任务已排队', progress: 30 }
        requestedStage = 'music'
        break
      }
      case 'remove-sfx': {
        const kind = action.sfx?.kind
        if (!kind) throw new Error('移除音效时没有指定类型。')
        const before = project.timeline.clips.length
        project.timeline.clips = project.timeline.clips.filter((clip) => {
          if (clip.kind !== 'sfx') return true
          const asset = project.assets.find((item) => item.id === clip.assetId)
          return !asset?.tags.includes(kind)
        })
        if (project.timeline.clips.length !== before) {
          timelineChanged = true
          project.stages.timeline = { status: 'ready', updatedAt: nowMs(), message: '音效已移除，等待重合成', progress: 100 }
        }
        requestedStage = 'music'
        break
      }
      case 'remove-music': {
        const before = project.timeline.clips.length
        project.timeline.clips = project.timeline.clips.filter((clip) => clip.kind !== 'music')
        project.musicAssetId = null
        if (project.timeline.clips.length !== before) timelineChanged = true
        project.stages.music = { status: 'ready', updatedAt: nowMs(), message: '配乐已移除，可以重新生成', progress: 40 }
        requestedStage = 'music'
        break
      }
      case 'noop':
        break
    }
  }
  if (timelineChanged) {
    project.timeline.snapshots = [...project.timeline.snapshots.slice(-19), snapshot]
    project.timeline.version += 1
    project.timeline.updatedAt = nowMs()
    project.timeline.durationSec = project.timeline.clips.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0)
    project.stages.timeline = { status: 'ready', updatedAt: nowMs(), message: '修改待预览/重合成', progress: 100 }
  }
  if (storyboardChanged) {
    syncBlueprintAfterShotAppend(project)
    project.stages.outline = { status: 'done', updatedAt: nowMs(), message: '镜头计划已同步', progress: 100 }
    project.stages.storyboard = { status: 'done', updatedAt: nowMs(), message: `${project.scenes.length} 场 · ${project.shots.length} 镜`, progress: 100 }
    for (const stageId of ['visuals', 'voice', 'timeline', 'review', 'delivery'] as const) {
      const stage = project.stages[stageId]
      if (stage && (stage.status === 'done' || stage.status === 'review') && canTransitionStudioStatus(stage.status, 'stale')) {
        project.stages[stageId] = { ...stage, status: 'stale', updatedAt: nowMs(), message: '新增分镜，下游需要重新核对' }
      }
    }
    project.stage = 'storyboard'
  }
  plan.status = 'applied'
  plan.appliedAt = nowMs()
  return { project, regenerate, timelineChanged, storyboardChanged, chapterCandidates, ...(requestedStage ? { stage: requestedStage } : {}) }
}

export function createPlanFromDraft(projectId: string, draft: DraftPlan): StudioEditPlan {
  void projectId
  return {
    id: studioId('plan'),
    title: draft.title,
    summary: draft.summary,
    actions: draft.actions,
    effects: draft.effects,
    estimate: { seconds: draft.seconds, cost: draft.cost, ...(draft.note ? { note: draft.note } : {}) },
    status: 'pending',
    createdAt: nowMs()
  }
}

export function localAssistantReply(project: StudioProject, userText: string, plan: StudioEditPlan): { text: string; plan: StudioEditPlan } {
  if (!plan.actions.length) {
    return {
      text: `${plan.summary}\n\n${project.kind === 'drama' ? '也可以让我先检查一次连续性，或直接重做某一镜。' : '也可以让我先检查人物与事实，再决定改哪里。'}`,
      plan
    }
  }
  const lines = [
    `我把「${userText.replace(/\s+/g, ' ').slice(0, 60)}」整理成了 ${plan.actions.length} 个改动，先给你看计划，还没有改任何东西。`,
    ...plan.effects.map((effect) => `· ${effect}`),
    plan.estimate.cost === null ? '预计有模型费用，实际账单会记录在任务里。' : plan.estimate.cost > 0 ? `预计费用约 ¥${plan.estimate.cost}，以实际账单为准。` : '这一步只在本机执行，不产生模型费用。',
    '确认后再应用；应用后仍可撤销。'
  ]
  return { text: lines.join('\n'), plan }
}

export function contextForAssistant(project: StudioProject, selection?: IntentContext['selection'], view?: string): string {
  const words = project.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0)
  const selectedChapter = selection?.kind === 'chapter' ? project.chapters.find((chapter) => chapter.id === selection.id) : undefined
  const selectedShot = selection?.kind === 'shot' ? project.shots.find((shot) => shot.id === selection.id) : undefined
  const selectedClip = selection?.kind === 'clip' ? project.timeline.clips.find((clip) => clip.id === selection.id) : undefined
  return [
    `作品：${project.title}（${project.kind}）`,
    `一句话：${project.logline}`,
    `当前页面：${view || project.stage}；阶段：${project.stage}；预算：¥${project.runtime.budget.spent} / ¥${project.runtime.budget.limit}`,
    project.kind === 'drama' ? `镜头：${project.shots.length}；已有画面：${project.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length}` : `章节：${project.chapters.length}；总字数：${words}`,
    project.kind === 'drama'
      ? `场景与镜头：${project.scenes.map((scene) => `第${scene.number}场《${scene.title}》`).join('；')}；${[...project.shots].sort((a, b) => a.number - b.number).slice(0, 30).map((shot) => `第${shot.number}镜《${shot.title}》${shot.action.slice(0, 60)}${shot.dialogue ? `｜台词：${shot.dialogue.slice(0, 60)}` : ''}`).join('\n')}`
      : `章目：${[...project.chapters].sort((a, b) => a.number - b.number).slice(0, 50).map((chapter) => `第${chapter.number}章《${chapter.title}》${chapter.content.trim() ? `（${countWords(chapter.content)}字）` : '（未写）'}`).join('；')}`,
    selectedChapter ? `当前选中章节：第 ${selectedChapter.number} 章 ${selectedChapter.title}\n${selectedChapter.content.slice(-1200)}` : '',
    selectedShot ? `当前选中镜头：第 ${selectedShot.number} 镜 ${selectedShot.title}\n动作：${selectedShot.action}\n台词：${selectedShot.dialogue}` : '',
    selectedClip ? `当前选中片段：${selectedClip.label}（${selectedClip.start.toFixed(2)}s → ${(selectedClip.start + selectedClip.duration).toFixed(2)}s）` : '',
    `连续性事实：${project.facts.slice(0, 12).map((fact) => `${fact.subject}${fact.predicate}${fact.object}`).join('；')}`
  ]
    .filter(Boolean)
    .join('\n')
}

export function assistantSystemPrompt(kind: StudioProject['kind']): string {
  return [
    '你是 Morrow 创作台的协作者。你了解当前作品、当前阶段和预算。',
    '回答要具体、简短、可执行；不要编造作品里没有的设定。',
    kind === 'drama' ? '讨论镜头时使用镜号，尊重角色参考锁定与连续性。' : '讨论章节时使用章节号，尊重人物事实与手改稿。',
    '引用具体章节、镜头、人物或事实时写明“第 N 章 / 镜 NN / 人物名”，不要编造来源。',
    '如果用户要求修改，先说明会改什么、影响哪些下游；不要在未经确认时声称已经修改。',
    '不要使用 Markdown 表格。'
  ].join('\n')
}

/** 本次回答实际带上的作品上下文，用于界面展示与来源失效校验。 */
export function assistantSources(
  project: StudioProject,
  selection?: { kind: 'chapter' | 'shot' | 'clip'; id: string }
): StudioMessageSource[] {
  const sources: StudioMessageSource[] = []
  if (selection?.kind === 'chapter') {
    const chapter = project.chapters.find((item) => item.id === selection.id)
    if (chapter) sources.push({ kind: 'chapter', id: chapter.id, label: `第 ${chapter.number} 章 · ${chapter.title}` })
  }
  if (selection?.kind === 'shot') {
    const shot = project.shots.find((item) => item.id === selection.id)
    if (shot) sources.push({ kind: 'shot', id: shot.id, label: `镜 ${String(shot.number).padStart(2, '0')} · ${shot.title}` })
  }
  if (selection?.kind === 'clip') {
    const clip = project.timeline.clips.find((item) => item.id === selection.id)
    if (clip) sources.push({ kind: 'clip', id: clip.id, label: `片段 · ${clip.label}` })
  }
  if (project.facts.length) {
    sources.push({ kind: 'facts', id: 'facts', label: `连续性事实 ${project.facts.length} 条` })
  }
  return sources
}

export function assistantMessage(
  role: StudioChatMessage['role'],
  text: string,
  plan?: StudioEditPlan,
  sources?: StudioMessageSource[]
): StudioChatMessage {
  return {
    id: studioId('msg'),
    role,
    text,
    createdAt: nowMs(),
    ...(plan ? { plan } : {}),
    ...(sources?.length ? { sources } : {})
  }
}

export interface StudioAgentFacade {
  execute(request: { type: string; projectId?: string; [key: string]: unknown }): Promise<unknown>
}

export interface StudioAgentResult {
  summary: string
  data?: unknown
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function wordCount(project: StudioProject): number {
  return project.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0)
}

function jobLine(job: StudioJob | undefined): string {
  if (!job) return '动作已提交。'
  return `任务已排队：${job.label}（${job.id}），进度可在创作台查看。`
}

export async function runStudioAgentTool(facade: StudioAgentFacade, input: { action: string; projectId?: string; [key: string]: unknown }): Promise<StudioAgentResult> {
  const action = input.action
  const projectId = str(input.projectId)
  const sub = str(input.subAction)
  const requireId = (): string => {
    if (!projectId) throw new Error('缺少 projectId；先用 studio_project 的 list 找到作品。')
    return projectId
  }
  const getProject = async (): Promise<StudioProject> => {
    const result = (await facade.execute({ type: 'get', projectId: requireId() })) as StudioActionResult
    return result.project
  }

  if (action === 'project') {
    if (sub === 'status') {
      const engine = (await facade.execute({ type: 'status' })) as StudioEngineStatus
      return {
        summary: `文本：${engine.text.message}；画面：${engine.media.message}；FFmpeg：${engine.ffmpeg.message}；系统声线 ${engine.voices.length} 个。`,
        data: engine
      }
    }
    if (sub === 'jobs') {
      const result = (await facade.execute({ type: 'list-jobs', projectId: requireId() })) as { jobs: StudioJob[] }
      return {
        summary: result.jobs.length
          ? result.jobs.map((job) => `${job.label} · ${job.status} · ${job.progress}% · ${job.message}`).join('\n')
          : '还没有任务记录。',
        data: result
      }
    }
    if (sub === 'get' && projectId) {
      const project = await getProject()
      return {
        summary: [
          `${project.id} · ${project.title}（${studioKindLabel(project.kind)}）`,
          `一句话：${project.logline}`,
          `阶段：${project.stage}；蓝图：${project.blueprint ? (project.blueprint.approved ? '已确认' : '待确认') : '未生成'}`,
          project.kind === 'drama'
            ? `镜头：${project.shots.length}；有画面 ${project.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length}；有配音 ${project.shots.filter((shot) => shot.voiceAssetId).length}；时间线 ${project.timeline.clips.length} 片段`
            : `章节：${project.chapters.length}；已写 ${project.chapters.filter((chapter) => chapter.content.trim()).length}；总字数 ${wordCount(project)}`,
          `预算：¥${project.runtime.budget.spent.toFixed(2)} / ¥${project.runtime.budget.limit}；交付物 ${project.deliveries.length}`,
          `章节 id：${project.chapters.slice(0, 16).map((chapter) => `${chapter.id}(第${chapter.number}章)`).join('、') || '无'}`,
          `镜头 id：${project.shots.slice(0, 16).map((shot) => `${shot.id}(镜${shot.number})`).join('、') || '无'}`
        ].join('\n'),
        data: {
          project: {
            id: project.id,
            title: project.title,
            kind: project.kind,
            stage: project.stage,
            revision: project.revision,
            budget: project.runtime.budget
          },
          chapters: project.chapters.map((chapter) => ({
            id: chapter.id,
            number: chapter.number,
            title: chapter.title,
            words: countWords(chapter.content),
            status: chapter.status,
            candidates: chapter.candidates.length
          })),
          shots: project.shots.map((shot) => ({
            id: shot.id,
            number: shot.number,
            title: shot.title,
            status: shot.status,
            hasImage: Boolean(shot.imageAssetId || shot.videoAssetId),
            hasVoice: Boolean(shot.voiceAssetId)
          })),
          blueprintApproved: project.blueprint?.approved ?? false
        }
      }
    }
    const result = (await facade.execute({ type: 'list' })) as StudioListResult
    const projects: StudioProjectSummary[] = result.projects
    return {
      summary: projects.length
        ? projects.map((project) => `${project.id} · ${project.title}（${studioKindLabel(project.kind)}，${project.progress}%）`).join('\n')
        : '作品库还是空的。',
      data: { projects }
    }
  }

  if (action === 'create') {
    const result = (await facade.execute({
      type: 'create',
      kind: input.kind,
      logline: input.logline,
      ...(input.title ? { title: input.title } : {})
    })) as StudioActionResult
    return {
      summary: `已创建作品 ${result.project.id} · ${result.project.title}。下一步可以生成蓝图：studio_blueprint（action=generate）。`,
      data: { projectId: result.project.id, title: result.project.title }
    }
  }

  if (action === 'blueprint') {
    const project = await getProject()
    if (sub === 'status') {
      return {
        summary: project.blueprint
          ? `蓝图${project.blueprint.approved ? '已确认' : '待确认'}：${project.blueprint.storyCore}\n${project.blueprint.warnings.join('\n')}`
          : '还没有蓝图。',
        data: { blueprint: project.blueprint }
      }
    }
    if (sub === 'approve') {
      const result = (await facade.execute({ type: 'approve-blueprint', projectId: project.id })) as StudioActionResult
      return {
        summary: `蓝图已确认；${project.kind === 'drama' ? `${result.project.shots.length} 镜计划已建立` : `${result.project.chapters.length} 章计划已建立`}。`,
        data: { projectId: project.id, stage: result.project.stage }
      }
    }
    if (sub === 'outline') {
      const result = (await facade.execute({ type: 'generate-outline', projectId: project.id, useModel: input.useModel })) as StudioActionResult
      return { summary: jobLine(result.job), data: { job: result.job } }
    }
    const result = (await facade.execute({ type: 'generate-blueprint', projectId: project.id, useModel: input.useModel })) as StudioActionResult
    return { summary: `${jobLine(result.job)} 完成后蓝图会停在“待审阅”，不会自动确认。`, data: { job: result.job } }
  }

  if (action === 'chapter') {
    const project = await getProject()
    const chapterId = str(input.chapterId) || project.chapters.find((chapter) => !chapter.content.trim())?.id || project.chapters[0]?.id
    if (!chapterId) throw new Error('这部作品还没有章节；请先确认蓝图或新建章节。')
    const count = Math.max(1, Math.min(10, Math.round(Number(input.count) || 1)))
    const result = (await facade.execute({
      ...(count > 1
        ? { type: 'batch-write', projectId: project.id, count, instruction: input.instruction, useModel: input.useModel }
        : { type: 'generate-chapter', projectId: project.id, chapterId, instruction: input.instruction, useModel: input.useModel })
    })) as StudioActionResult
    const chapter = project.chapters.find((item) => item.id === chapterId)
    return {
      summary: count > 1 ? result.message ?? `已排队连续写作 ${count} 章。` : `第 ${chapter?.number ?? ''} 章写作任务已提交（${chapter?.title ?? ''}）。已有手改不会被覆盖；${result.job ? jobLine(result.job) : ''}`,
      data: { job: result.job, chapterId, count }
    }
  }

  if (action === 'storyboard') {
    const project = await getProject()
    if (project.kind !== 'drama') throw new Error('只有漫剧使用分镜。')
    if (sub === 'build-timeline') {
      const result = (await facade.execute({ type: 'build-timeline', projectId: project.id, force: input.force === true })) as StudioActionResult
      return {
        summary: `时间线已装配：${result.project.timeline.clips.length} 个片段，${Math.round(timelineDuration(result.project.timeline))} 秒。`,
        data: { projectId: project.id }
      }
    }
    if (sub === 'image') {
      const result = (await facade.execute({ type: 'generate-shot-image', projectId: project.id, shotId: input.shotId })) as StudioActionResult
      return { summary: jobLine(result.job), data: { job: result.job } }
    }
    if (sub === 'batch-images') {
      const result = (await facade.execute({
        type: 'batch-shot-images',
        projectId: project.id,
        shotIds: Array.isArray(input.shotIds) ? input.shotIds : undefined
      })) as StudioActionResult
      return { summary: jobLine(result.job), data: { job: result.job } }
    }
    const result = (await facade.execute({ type: 'generate-storyboard', projectId: project.id })) as StudioActionResult
    return { summary: `分镜已更新：${result.project.shots.length} 镜。`, data: { projectId: project.id, shots: result.project.shots.length } }
  }

  if (action === 'media') {
    const project = await getProject()
    let result: StudioActionResult
    if (sub === 'image') result = (await facade.execute({ type: 'generate-shot-image', projectId: project.id, shotId: input.shotId })) as StudioActionResult
    else if (sub === 'video') result = (await facade.execute({ type: 'generate-shot-video', projectId: project.id, shotId: input.shotId })) as StudioActionResult
    else if (sub === 'voice') result = (await facade.execute({ type: 'generate-voice', projectId: project.id, shotId: input.shotId })) as StudioActionResult
    else if (sub === 'music') result = (await facade.execute({ type: 'generate-music', projectId: project.id, kind: 'music', mood: input.mood, seconds: input.seconds })) as StudioActionResult
    else if (sub === 'sfx') result = (await facade.execute({ type: 'generate-music', projectId: project.id, kind: input.kind || 'rain', seconds: input.seconds })) as StudioActionResult
    else throw new Error('未知的媒体动作；使用 image / video / voice / music / sfx。')
    return { summary: jobLine(result.job), data: { job: result.job } }
  }

  if (action === 'timeline') {
    const project = await getProject()
    if (project.kind !== 'drama') throw new Error('只有漫剧有时间线。')
    if (sub === 'build') {
      const result = (await facade.execute({ type: 'build-timeline', projectId: project.id, force: input.force === true })) as StudioActionResult
      return {
        summary: `时间线已装配：${result.project.timeline.clips.length} 片段 · ${Math.round(timelineDuration(result.project.timeline))} 秒。`,
        data: { projectId: project.id }
      }
    }
    return {
      summary: `时间线 v${project.timeline.version} · ${Math.round(timelineDuration(project.timeline))} 秒 · ${project.timeline.clips.length} 片段 · 轨道：${project.timeline.tracks.map((track) => track.name).join(' / ')}`,
      data: {
        version: project.timeline.version,
        durationSec: timelineDuration(project.timeline),
        clips: project.timeline.clips.length
      }
    }
  }

  if (action === 'edit') {
    const project = await getProject()
    if (sub === 'apply-plan') {
      const planId = str(input.planId)
      if (!planId) throw new Error('缺少 planId；先用 action=plan 生成计划。')
      const result = (await facade.execute({ type: 'apply-plan', projectId: project.id, planId })) as StudioActionResult
      return { summary: `修改计划已应用。${result.message ?? ''} 应用后可撤销。`, data: { plan: result.plan, job: result.job } }
    }
    const selectionKind = str(input.selectionKind)
    const selection =
      selectionKind === 'chapter' || selectionKind === 'shot' || selectionKind === 'clip'
        ? { kind: selectionKind, id: str(input.selectionId) }
        : undefined
    const result = (await facade.execute({
      type: 'assistant',
      projectId: project.id,
      text: str(input.instruction) || '请说明想怎么改。',
      ...(selection ? { selection } : {})
    })) as StudioActionResult & { plan?: { id: string; title: string; summary: string } }
    return {
      summary: `已生成修改计划「${result.plan?.title ?? ''}」：${result.plan?.summary ?? ''}。尚未应用；需要用户确认。planId=${result.plan?.id ?? ''}`,
      data: { plan: result.plan, projectId: project.id }
    }
  }

  if (action === 'review') {
    const project = await getProject()
    const result = (await facade.execute({ type: 'review', projectId: project.id })) as StudioActionResult
    const errors = result.project.checks.filter((check) => check.level === 'error')
    const warns = result.project.checks.filter((check) => check.level === 'warn')
    return {
      summary:
        errors.length || warns.length
          ? `检查完成：${errors.length} 个错误、${warns.length} 条提醒。\n${[...errors, ...warns]
              .slice(0, 8)
              .map((check) => `· ${check.title}：${check.detail}`)
              .join('\n')}`
          : `检查完成：没有发现硬问题；${result.project.checks.length} 条信息已记录。`,
      data: { checks: result.project.checks }
    }
  }

  if (action === 'render') {
    const project = await getProject()
    const result = (await facade.execute({
      type: 'render',
      projectId: project.id,
      quality: input.quality === 'final' ? 'final' : 'draft',
      subtitleMode: input.subtitleMode === 'soft' ? 'soft' : 'burn',
      ...(input.aspect === '16:9' || input.aspect === '9:16' || input.aspect === '1:1' ? { aspect: input.aspect } : {}),
      ...(input.format === 'mov' || input.format === 'mkv' || input.format === 'webm' ? { format: input.format } : { format: 'mp4' }),
      ...(input.resolution === '2160p' ? { resolution: '2160p' } : { resolution: '1080p' })
    })) as StudioActionResult
    return { summary: `${jobLine(result.job)} 完成后会出现在交付记录。`, data: { job: result.job } }
  }

  if (action === 'export') {
    const project = await getProject()
    const format = str(input.format)
    const allowed = ['txt', 'md', 'epub', 'pdf', 'docx', 'srt', 'ass', 'package', 'cover', 'folder']
    if (!allowed.includes(format)) throw new Error('不支持的导出格式。')
    const result = (await facade.execute({ type: 'export', projectId: project.id, format })) as StudioActionResult
    return { summary: `${jobLine(result.job)} 导出完成后会出现在交付记录。`, data: { job: result.job } }
  }

  throw new Error(`不支持的创作台工具动作：${action}`)
}

const MEDIA_EVENT = 'feature:studio:event'

const DEMO_DISABLED = process.env.MORROW_STUDIO_NO_DEMO === '1'

interface JobRunContext {
  signal: AbortSignal
  jobId: string
  progress: (message: string, percent?: number) => void
  attachRemote?: (remoteId: string, target?: { kind: 'image' | 'video'; shotId?: string; chapterId?: string }) => void
}

interface JobOutcome {
  message?: string
  costCny?: number | null
  costNote?: string
  outputs?: StudioJob['outputs']
  apply?: (project: StudioProject) => void
  plannedStatus?: StudioJob['status']
}

interface LaunchJobOptions {
  kind: StudioJobKind
  label: string
  stage: StudioStageId | 'asset'
  requestId?: string
  inputHash: string
  estimatedCostCny?: number | null
  costNote?: string
  retry?: { action: string; payload: Record<string, unknown> }
  run: (project: StudioProject, ctx: JobRunContext) => Promise<JobOutcome>
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function chapterParagraphCount(content: string): number {
  return content.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean).length
}

function friendlyMediaError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/ComfyUI 未连接|找不到 ComfyUI|connect|ECONNREFUSED/i.test(message)) {
    return `${message}。请到设置 → 多媒体确认 ComfyUI 地址与模型，或先导入现成画面。`
  }
  if (/系统配音失败|未安装语音|Internal Speech Error|没有当前安全设置/i.test(message)) {
    return '当前运行环境限制了系统语音（SAPI / WinRT）。可以在这一镜导入一段现成录音，或在 Windows 设置里确认中文语音包后再试。'
  }
  return message
}

export interface StudioServiceOptions {
  store?: StudioStore
}

export class StudioService {
  private readonly store: StudioStore
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly cancelled = new Set<string>()
  private jobChain: Promise<unknown> = Promise.resolve()
  private externalResumeScheduled = false
  private initialized = false
  private statusCache: { at: number; value: StudioEngineStatus } | null = null

  constructor(options: StudioServiceOptions = {}) {
    this.store = options.store ?? getStudioStore()
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true
    if (!DEMO_DISABLED) {
      try {
        ensureDemoProjects(this.store)
      } catch {
        // 样例失败不影响空作品库
      }
    }
    this.reconcileInterruptedJobs()
    if (!this.externalResumeScheduled) {
      this.externalResumeScheduled = true
      setTimeout(() => void this.autoResumeExternalJobs(), 2_500).unref?.()
    }
  }

  /** 启动时核对任务：上次退出时仍显示“进行中”的任务不自动重试。 */
  private reconcileInterruptedJobs(): void {
    for (const summary of this.store.summaries()) {
      try {
        const project = this.store.readProject(summary.id)
        let changed = false
        for (const job of project.jobs) {
          if (job.status === 'running' || job.status === 'queued') {
            job.status = 'review'
            job.message = job.remoteId && (job.kind === 'image' || job.kind === 'video')
              ? '应用退出时外部任务已提交；启动后会自动核对结果。'
              : '应用上次退出时任务被中断；已完成内容保留，请核对后再重试。'
            job.error = job.remoteId ? undefined : '任务中断（结果未确认）'
            job.updatedAt = nowMs()
            changed = true
          }
        }
        if (changed) this.store.savePassive(project)
      } catch {
        // 损坏作品在打开时再处理
      }
    }
  }

  /** ComfyUI 在线时，自动对账上次退出时已提交的外部任务。 */
  private async autoResumeExternalJobs(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return
    const mediaStatus = await getMediaService().status().catch(() => null)
    if (!mediaStatus?.engine.online) return
    let queued = 0
    for (const summary of this.store.summaries()) {
      if (queued >= 3) break
      try {
        const project = this.store.readProject(summary.id)
        for (const job of project.jobs) {
          if (queued >= 3) break
          if (!job.remoteId || (job.kind !== 'image' && job.kind !== 'video')) continue
          if (job.status !== 'review' || !/启动后会自动核对|外部任务已提交/.test(job.message)) continue
          try {
            await this.reconcileExternal({ projectId: project.id, jobId: job.id })
            queued += 1
          } catch {
            // 单个外部任务失败不影响其他作品
          }
        }
      } catch {
        // 损坏作品在打开时再处理
      }
    }
  }

  async status(): Promise<StudioEngineStatus> {
    if (this.statusCache && Date.now() - this.statusCache.at < 6_000) return this.statusCache.value
    this.ensureInitialized()
    const mediaStatus = await getMediaService().status()
    const voices = listSystemVoices()
    const imageReady = Boolean(mediaStatus.models.find((model) => model.id === 'image')?.ready)
    const videoReady = Boolean(mediaStatus.models.find((model) => model.id === 'video')?.ready)
    const studioData = studioDataDirInfo()
    const value: StudioEngineStatus = {
      dataDir: this.store.dataDir,
      studioDataDir: this.store.root,
      studioDataDirSource: studioData.source,
      projectCount: this.store.summaries().length,
      ffmpeg: {
        ...mediaStatus.ffmpeg,
        ...(() => {
          const caps = ffmpegCapabilities()
          return { ...(caps.codecs.length ? { codecs: caps.codecs } : {}), profile: caps.profile }
        })()
      },
      media: {
        online: mediaStatus.engine.online,
        imageReady,
        videoReady,
        message: mediaStatus.engine.message,
        ...(mediaStatus.engine.gpu ? { gpu: mediaStatus.engine.gpu } : {}),
        ...(mediaStatus.engine.vramTotalMb ? { vramTotalMb: mediaStatus.engine.vramTotalMb } : {})
      },
      text: textStatusForEngine(),
      vision: (() => {
        const candidate = studioVisionProvider()
        if (!candidate) return { ready: false }
        return {
          ready: true,
          modelLabel: candidate.model.label || candidate.model.id,
          ...(candidate.local ? { local: true } : {})
        }
      })(),
      voices: voices.voices,
      ...(voices.error ? { voiceError: voices.error } : {}),
      tts: (() => {
        const status = localTtsStatus()
        return { localReady: status.modelReady, running: status.running, message: status.message }
      })(),
      version: app.getVersion()
    }
    this.statusCache = { at: Date.now(), value }
    return value
  }

  async list(): Promise<StudioListResult> {
    this.ensureInitialized()
    const engine = await this.status()
    return { projects: this.store.summaries(), engine }
  }

  getProject(id: string): StudioProject {
    this.ensureInitialized()
    const project = this.store.readProject(safeProjectId(id))
    return project
  }

  result(project: StudioProject, extra: Partial<StudioActionResult> = {}): StudioActionResult {
    const decorated = this.store.decorateProject(project)
    return {
      project: sanitizeProjectForRenderer(decorated),
      ...extra
    }
  }

  private emitProject(project: StudioProject): void {
    sendFeatureEvent(MEDIA_EVENT, { type: 'project', projectId: project.id, summary: this.store.summarize(project) })
  }

  private emitJob(job: StudioJob): void {
    sendFeatureEvent(MEDIA_EVENT, { type: 'job', job })
  }

  private withLock<T>(projectId: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    this.locks.set(
      projectId,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }

  private charge(project: StudioProject, cost: number | null | undefined): void {
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
      project.runtime.budget.spent = Math.round((project.runtime.budget.spent + cost) * 1000) / 1000
    }
  }

  private assertBudget(project: StudioProject, estimate: number | null | undefined): void {
    const limit = project.runtime.budget.limit
    if (!limit || limit <= 0) return
    if (typeof estimate === 'number' && project.runtime.budget.spent + estimate > limit) {
      throw new Error(`这一步预计花费 ¥${estimate.toFixed(2)}，会超过项目预算 ¥${limit}。请先在“模型与预算”里提高预算，或改用本地能力。`)
    }
  }

  /** 上游内容变动后，只把真正会受影响的下游阶段标记为过期；运行中的任务保持不动。 */
  private staleStages(project: StudioProject, stages: StudioStageId[], message: string): void {
    for (const stageId of stages) {
      const stage = project.stages[stageId]
      if (!stage || (stage.status !== 'done' && stage.status !== 'review') || !canTransitionStudioStatus(stage.status, 'stale')) continue
      project.stages[stageId] = {
        ...stage,
        status: 'stale',
        updatedAt: nowMs(),
        message
      }
    }
  }

  private staleAfterManuscriptChange(project: StudioProject): void {
    this.staleStages(project, ['review', 'delivery'], '正文有改动，旧检查与交付物需要重新生成')
  }

  private staleAfterShotChange(project: StudioProject, dialogueChanged: boolean): void {
    this.staleStages(project, dialogueChanged ? ['visuals', 'voice', 'timeline', 'review', 'delivery'] : ['visuals', 'timeline', 'review', 'delivery'], '镜头设定有改动，旧画面、时间线与检查需要重新核对')
  }

  /** 新素材没有进入时间线时，旧成片不算完成。空时间线则保持“可装配”，不伪造过期。 */
  private staleAfterMediaChange(project: StudioProject, message: string): void {
    if (project.kind !== 'drama') return
    if (project.timeline.clips.length) {
      if (canTransitionStudioStatus(project.stages.timeline.status, 'stale')) {
        project.stages.timeline = { ...project.stages.timeline, status: 'stale', updatedAt: nowMs(), message, progress: 0 }
      }
      this.staleStages(project, ['review', 'delivery'], message)
    } else {
      project.stages.timeline = { status: 'ready', updatedAt: nowMs(), message: '有新素材，可以装配时间线', progress: 0 }
    }
  }

  private async launchJob(project: StudioProject, options: LaunchJobOptions): Promise<StudioJob> {
    const requestId = options.requestId?.trim() || studioId('req')
    const existing =
      project.jobs.find((job) => job.requestId === requestId) ??
      project.jobs.find(
        (job) =>
          job.kind === options.kind &&
          job.inputHash === options.inputHash &&
          (job.status === 'queued' || job.status === 'running')
      )
    if (existing) return existing
    this.assertBudget(project, options.estimatedCostCny)
    const now = nowMs()
    const job: StudioJob = {
      id: studioId('job'),
      requestId,
      projectId: project.id,
      kind: options.kind,
      label: options.label,
      stage: options.stage,
      status: 'queued',
      progress: 0,
      message: '排队中',
      inputHash: options.inputHash,
      attempts: 0,
      ...(options.retry ? { retry: options.retry } : {}),
      ...(typeof options.estimatedCostCny === 'number' ? { cost: options.estimatedCostCny } : { cost: null }),
      ...(options.costNote ? { costNote: options.costNote } : {}),
      outputs: [],
      events: [{ at: now, status: 'queued', message: '排队中', progress: 0 }],
      createdAt: now,
      updatedAt: now
    }
    project.jobs.push(job)
    this.store.trimJobs(project)
    this.store.save(project, `排队任务：${job.label}`, { snapshot: false })
    this.store.appendJobLog(project.id, job)
    this.emitJob(job)
    this.emitProject(project)
    this.jobChain = this.jobChain.then(() => this.runJob(project.id, job.id, options.run)).catch(() => undefined)
    return job
  }

  private async runJob(projectId: string, jobId: string, run: LaunchJobOptions['run']): Promise<void> {
    // 队列暂停时保留 queued 状态，恢复后继续；取消仍可穿透暂停。
    while (!this.cancelled.has(jobId)) {
      const queued = this.store.readProject(projectId).runtime.queuePaused === true
      if (!queued) break
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    if (this.cancelled.has(jobId)) {
      await this.finalizeJob(projectId, jobId, null, { message: '已取消（任务尚未开始）。', plannedStatus: 'cancelled' })
      return
    }
    let controller: AbortController | null = null
    let job: StudioJob
    try {
      job = await this.withLock(projectId, () => {
        const project = this.store.readProject(projectId)
        const target = project.jobs.find((item) => item.id === jobId)
        if (!target) throw new Error('任务记录不存在。')
        if (this.cancelled.has(jobId) || target.status === 'cancelled') {
          target.status = 'cancelled'
          target.message = '已取消（任务尚未开始）。'
          target.updatedAt = nowMs()
          this.store.savePassive(project)
          this.emitJob(target)
          throw new Error('__cancelled__')
        }
        target.status = 'running'
        target.startedAt = nowMs()
        target.updatedAt = nowMs()
        target.attempts += 1
        target.message = '开始执行'
        target.progress = 1
        appendJobEvent(target, 'running', '开始执行', 1)
        if (target.stage !== 'asset') {
          project.stages[target.stage] = {
            ...project.stages[target.stage],
            status: 'running',
            updatedAt: nowMs(),
            message: target.label,
            progress: 1
          }
        }
        this.store.savePassive(project)
        this.emitJob(target)
        this.emitProject(project)
        return target
      })
    } catch (err) {
      if (err instanceof Error && err.message === '__cancelled__') return
      return
    }
    controller = new AbortController()
    this.controllers.set(jobId, controller)
    let lastPersist = 0
    const attachRemote = (remoteId: string, target?: { kind: 'image' | 'video'; shotId?: string; chapterId?: string }): void => {
      const id = remoteId.trim().slice(0, 120)
      if (!id) return
      const list = job.remoteTargets ?? []
      if (!list.some((item) => item.remoteId === id)) {
        list.push({ remoteId: id, kind: target?.kind ?? (job.kind === 'video' ? 'video' : 'image'), ...(target?.shotId ? { shotId: target.shotId } : {}), ...(target?.chapterId ? { chapterId: target.chapterId } : {}) })
        job.remoteTargets = list.slice(-20)
      }
      if (job.remoteId === id && !target) return
      job.remoteId = id
      job.updatedAt = nowMs()
      appendJobEvent(job, job.status, `外部任务号 ${id}`, job.progress)
      this.emitJob({ ...job })
      void this.withLock(projectId, () => {
        try {
          const fresh = this.store.readProject(projectId)
          const record = fresh.jobs.find((item) => item.id === jobId)
          if (record) {
            record.remoteId = id
            record.remoteTargets = job.remoteTargets
            record.events = job.events
            record.updatedAt = job.updatedAt
            this.store.savePassive(fresh)
          }
        } catch {
          // 外部任务号持久化失败不阻断任务
        }
      })
    }
    const progress = (message: string, percent?: number): void => {
      job.message = message.slice(0, 400)
      if (typeof percent === 'number' && Number.isFinite(percent)) job.progress = Math.max(0, Math.min(100, Math.round(percent)))
      job.updatedAt = nowMs()
      appendJobEvent(job, job.status, job.message, job.progress)
      this.emitJob({ ...job })
      if (Date.now() - lastPersist > 1_500) {
        lastPersist = Date.now()
        void this.withLock(projectId, () => {
          try {
            const fresh = this.store.readProject(projectId)
            const target = fresh.jobs.find((item) => item.id === jobId)
            if (target) {
              target.message = job.message
              target.progress = job.progress
              target.updatedAt = job.updatedAt
              target.events = job.events
              this.store.savePassive(fresh)
            }
          } catch {
            // 进度持久化失败不阻断任务
          }
        })
      }
    }
    try {
      if (this.cancelled.has(jobId) || controller.signal.aborted) throw new Error('已取消。')
      const snapshot = await this.withLock(projectId, () => this.store.readProject(projectId))
      const outcome = await run(snapshot, { signal: controller.signal, jobId, progress, attachRemote })
      await this.finalizeJob(projectId, jobId, controller, outcome)
    } catch (err) {
      const aborted = controller.signal.aborted || this.cancelled.has(jobId) || /取消|aborted|abort/i.test(err instanceof Error ? err.message : '')
      await this.finalizeJob(projectId, jobId, controller, {
        message: aborted ? '已取消；已完成的内容保留。' : friendlyMediaError(err),
        plannedStatus: aborted ? 'cancelled' : 'failed'
      })
    } finally {
      this.controllers.delete(jobId)
      this.cancelled.delete(jobId)
    }
  }

  private async finalizeJob(
    projectId: string,
    jobId: string,
    controller: AbortController | null,
    outcome: JobOutcome | null
  ): Promise<void> {
    void controller
    await this.withLock(projectId, () => {
      const project = this.store.readProject(projectId)
      const job = project.jobs.find((item) => item.id === jobId)
      if (!job) return
      try {
        if (outcome?.apply) outcome.apply(project)
      } catch (err) {
        outcome = {
          ...outcome,
          message: `结果已返回，但写入作品失败：${err instanceof Error ? err.message : String(err)}`,
          plannedStatus: 'review'
        }
      }
      const planned = outcome?.plannedStatus
      const failed = planned === 'failed'
      const cancelled = planned === 'cancelled'
      job.status = failed ? 'failed' : cancelled ? 'cancelled' : planned === 'review' ? 'review' : 'done'
      job.message = outcome?.message ?? (job.status === 'done' ? '完成' : job.message)
      job.progress = job.status === 'done' ? 100 : job.progress
      job.updatedAt = nowMs()
      job.finishedAt = nowMs()
      appendJobEvent(job, job.status, job.message, job.progress)
      if (outcome?.outputs) job.outputs = outcome.outputs
      if (typeof outcome?.costCny === 'number') job.cost = outcome.costCny
      else if (outcome?.costCny === null) job.cost = null
      if (outcome?.costNote) job.costNote = outcome.costNote
      this.charge(project, outcome?.costCny ?? null)
      if (failed) job.error = outcome?.message || '任务失败'
      if (job.stage !== 'asset') {
        const stage = project.stages[job.stage]
        if (failed) {
          stage.status = 'failed'
          stage.message = job.error ?? '失败'
        } else if (cancelled) {
          stage.status = 'review'
          stage.message = '已取消，已完成内容保留'
        } else if (stage.status === 'running') {
          stage.status = job.status === 'review' ? 'review' : 'done'
          stage.message = job.message
          stage.progress = job.status === 'done' ? 100 : stage.progress
        }
        stage.updatedAt = nowMs()
      }
      this.store.save(project, `任务完成：${job.label}`, { snapshot: false })
      this.store.appendJobLog(project.id, job)
      this.emitJob(job)
      this.emitProject(project)
    })
  }

  async execute(request: { type: string; projectId?: string; [key: string]: unknown }): Promise<unknown> {
    this.ensureInitialized()
    switch (request.type) {
      case 'status':
        return this.status()
      case 'list':
        return this.list()
      case 'create':
        return this.create(request as unknown as StudioCreateInput)
      case 'get':
        return this.result(this.getProject(str(request.projectId)))
      case 'import-package':
        return this.importPackage(request)
      case 'delete':
        return this.deleteProject(str(request.projectId))
      case 'list-trash':
        return this.listTrash()
      case 'restore-trash':
        return this.restoreTrash(request)
      case 'purge-trash':
        return this.purgeTrash(request)
      case 'duplicate':
        return this.result(this.store.duplicateProject(safeProjectId(str(request.projectId))))
      case 'list-versions':
        return this.listVersions(request)
      case 'restore-version':
        return this.restoreVersion(request)
      case 'update-meta':
        return this.updateMeta(request)
      case 'save-chapter':
        return this.saveChapter(request)
      case 'add-chapter':
        return this.addChapter(request)
      case 'delete-chapter':
        return this.deleteChapter(request)
      case 'move-chapter':
        return this.moveChapter(request)
      case 'upsert-volume':
        return this.upsertVolume(request)
      case 'delete-volume':
        return this.deleteVolume(request)
      case 'move-volume':
        return this.moveVolume(request)
      case 'generate-blueprint':
        return this.generateBlueprint(request)
      case 'save-blueprint':
        return this.saveBlueprint(request)
      case 'approve-blueprint':
        return this.approveBlueprint(request)
      case 'generate-outline':
        return this.generateOutline(request)
      case 'generate-chapter':
        return this.generateChapter(request)
      case 'polish-chapter':
        return this.polishChapter(request)
      case 'batch-write':
        return this.batchWrite(request)
      case 'generate-chapter-illustration':
        return this.generateChapterIllustration(request)
      case 'attach-chapter-illustration':
        return this.attachChapterIllustration(request)
      case 'remove-chapter-illustration':
        return this.removeChapterIllustration(request)
      case 'adopt-candidate':
        return this.adoptCandidate(request)
      case 'discard-candidate':
        return this.discardCandidate(request)
      case 'restore-chapter-version':
        return this.restoreChapterVersion(request)
      case 'upsert-character':
        return this.upsertCharacter(request)
      case 'delete-character':
        return this.deleteCharacter(request)
      case 'upsert-place':
        return this.upsertPlace(request)
      case 'upsert-fact':
        return this.upsertFact(request)
      case 'delete-fact':
        return this.deleteFact(request)
      case 'upsert-faction':
        return this.upsertWorldItem(request, 'factions')
      case 'delete-faction':
        return this.deleteWorldItem(request, 'factions')
      case 'upsert-rule':
        return this.upsertWorldItem(request, 'rules')
      case 'delete-rule':
        return this.deleteWorldItem(request, 'rules')
      case 'upsert-prop':
        return this.upsertWorldItem(request, 'props')
      case 'delete-prop':
        return this.deleteWorldItem(request, 'props')
      case 'generate-storyboard':
        return this.generateStoryboard(request)
      case 'sync-storyboard':
        return this.syncStoryboard(request)
      case 'save-scene':
        return this.saveScene(request)
      case 'save-shot':
        return this.saveShot(request)
      case 'move-shot':
        return this.moveShot(request)
      case 'update-shots':
        return this.updateShots(request)
      case 'build-subtitles':
        return this.buildSubtitles(request)
      case 'generate-shot-image':
        return this.generateShotImage(request)
      case 'batch-shot-images':
        return this.batchShotImages(request)
      case 'generate-shot-video':
        return this.generateShotVideo(request)
      case 'adopt-shot-asset':
        return this.adoptShotAsset(request)
      case 'import-shot-asset':
        return this.importAsset(request)
      case 'generate-voice':
        return this.generateVoice(request)
      case 'generate-music':
        return this.generateMusic(request)
      case 'build-timeline':
        return this.buildTimeline(request)
      case 'save-timeline':
        return this.saveTimeline(request)
      case 'render':
        return this.render(request as unknown as StudioRenderInput)
      case 'review':
        return this.review(request)
      case 'model-review':
        return this.modelReview(request)
      case 'visual-check':
        return this.visualCheck(request)
      case 'auto-advance':
        return this.autoAdvance(request)
      case 'export':
        return this.exportProject(request as unknown as StudioExportInput)
      case 'export-preflight':
        return this.exportPreflight(request)
      case 'export-audio':
        return this.exportAudio(request)
      case 'export-comic':
        return this.exportComic(request)
      case 'import-asset':
        return this.importAsset(request)
      case 'assistant':
        return this.assistant(request)
      case 'apply-plan':
        return this.applyPlan(request)
      case 'cancel-plan':
        return this.cancelPlan(request)
      case 'undo-plan':
        return this.undoPlan(request)
      case 'cancel-job':
        return this.cancelJob(request)
      case 'retry-job':
        return this.retryJob(request)
      case 'reconcile-external':
        return this.reconcileExternal(request)
      case 'update-runtime':
        return this.updateRuntime(request)
      case 'list-jobs':
        return this.listJobs(request)
      case 'set-cover':
        return this.setCover(request)
      case 'save-canvas':
        return this.saveCanvas(request)
      case 'save-canvas-snapshot':
        return this.saveCanvasSnapshot(request)
      case 'voice-audit':
        return this.voiceAudit(request)
      case 'asset-waveform':
        return this.assetWaveform(request)
      case 'text-routes':
        return this.textRoutes(request)
      case 'asset-proxy':
        return this.assetProxy(request)
      case 'adapt-to-drama':
        return this.adaptToDrama(request)
      case 'pause-queue':
        return this.setQueuePaused(request, true)
      case 'resume-queue':
        return this.setQueuePaused(request, false)
      default:
        throw new Error(`不支持的创作台操作：${request.type}`)
    }
  }

  /** Agent 工具入口：只做转发，所有写入仍走 execute。 */
  async runAgentTool(input: { action: string; projectId?: string; [key: string]: unknown }): Promise<{ summary: string; data?: unknown }> {
    return runStudioAgentTool(this, input)
  }

  private async importPackage(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const file = str(request.path)
    if (!file || !existsSync(file)) throw new Error('找不到要导入的工程包。')
    if (statSync(file).size > 300 * 1024 * 1024) throw new Error('工程包超过 300MB，请先确认来源。')
    const zip = await JSZip.loadAsync(readFileSync(file))
    const entry = Object.keys(zip.files).find((name) => /(^|\/)project\.json$/.test(name) && !name.includes('node_modules'))
    if (!entry) throw new Error('工程包里没有 project.json。')
    const raw = JSON.parse(await zip.file(entry)!.async('string')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || !['short', 'novel', 'drama'].includes(String(raw.kind)) || !Array.isArray(raw.chapters)) {
      throw new Error('这不是有效的 Morrow 创作台工程包。')
    }
    const now = nowMs()
    const project = this.store.normalizeProject({
      ...(raw as unknown as StudioProject),
      id: studioId('proj'),
      title: `${String(raw.title || '未命名作品')} · 导入`,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      demo: false,
      jobs: [],
      deliveries: [],
      messages: Array.isArray(raw.messages) ? (raw.messages as StudioProject['messages']).slice(-20) : []
    })
    for (const asset of project.assets) {
      delete asset.url
      delete asset.thumbUrl
    }
    this.store.ensureProjectDirs(project.id)
    const prefix = entry.slice(0, -'project.json'.length).replace(/\/$/, '')
    let restored = 0
    for (const name of Object.keys(zip.files)) {
      if (prefix && !name.startsWith(prefix + '/')) continue
      const rel = (prefix ? name.slice(prefix.length + 1) : name).replace(/\\/g, '/')
      if (!rel.startsWith('assets/') || rel.endsWith('/')) continue
      if (rel.split('/').some((part) => part === '..' || part === '')) continue
      const item = zip.file(name)
      if (!item) continue
      const target = join(this.store.projectDir(project.id), rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, await item.async('nodebuffer'))
      restored += 1
    }
    this.store.save(project, '导入工程包', { snapshot: false })
    try { this.store.writeVersion(project, '导入工程包') } catch { /* ignore */ }
    this.emitProject(project)
    return this.result(project, { message: `已导入工程包，恢复 ${restored} 个素材。` })
  }

  private create(input: StudioCreateInput): StudioActionResult {
    const kind: StudioKind = input.kind === 'short' || input.kind === 'novel' || input.kind === 'drama' ? input.kind : 'short'
    const logline = str(input.logline).trim()
    if (!logline) throw new Error('先用一句话说说你想创作什么。')
    if (logline.length > 2000) throw new Error('一句话太长了，请控制在 2000 字以内。')
    const aspect = input.aspect === '9:16' || input.aspect === '1:1' ? input.aspect : '16:9'
    const project = this.store.newProject({
      kind,
      title: str(input.title).trim() || '未命名作品',
      logline,
      brief: {
        form: input.form,
        genre: input.genre,
        audience: input.audience,
        tone: input.tone,
        style: input.style,
        aspect,
        constraints: input.constraints,
        targetWords: input.targetWords ?? (kind === 'short' ? 18_000 : kind === 'novel' ? 300_000 : undefined),
        targetSeconds: input.targetSeconds ?? (kind === 'drama' ? 96 : undefined)
      }
    })
    project.titleSource = str(input.title).trim() ? 'user' : 'auto'
    project.stages.blueprint = { status: 'ready', updatedAt: nowMs(), message: '写一句，生成第一版蓝图' }
    project.messages.push(
      assistantMessage(
        'assistant',
        `这里是「${project.title}」的创作台。先点“生成蓝图”，模型会按你的灵感给出正式标题、故事主线、人物、结构和花费区间；你确认后才开始产生内容。`
      )
    )
    this.store.save(project, '新建作品', { snapshot: false })
    return this.result(project)
  }

  private deleteProject(projectId: string): { deleted: boolean; projectId: string } {
    const id = safeProjectId(projectId)
    this.store.deleteProject(id)
    return { deleted: true, projectId: id }
  }

  private listTrash(): { items: ReturnType<StudioStore['listTrash']> } {
    return { items: this.store.listTrash() }
  }

  private restoreTrash(request: { [key: string]: unknown }): StudioActionResult {
    const project = this.store.restoreTrash(str(request.entry))
    this.emitProject(project)
    return this.result(project, { message: `已把《${project.title}》恢复到作品库。` })
  }

  private purgeTrash(request: { [key: string]: unknown }): { deleted: boolean; message: string } {
    this.store.purgeTrash(str(request.entry))
    return { deleted: true, message: '已彻底删除，无法再恢复。' }
  }

  private listVersions(request: { [key: string]: unknown }): { versions: Array<{ id: string; createdAt: number; reason: string; revision: number }> } {
    const id = safeProjectId(str(request.projectId))
    const project = this.store.readProject(id)
    const versions = this.store.listVersionFiles(id).map((version) => ({
      id: version.name,
      createdAt: version.createdAt,
      reason: version.reason,
      revision: version.revision || project.revision
    }))
    return { versions }
  }

  private restoreVersion(request: { [key: string]: unknown }): StudioActionResult {
    const id = safeProjectId(str(request.projectId))
    const name = str(request.versionId)
    if (!name) throw new Error('缺少版本文件名。')
    const restored = this.store.restoreProjectVersion(id, name)
    this.emitProject(restored)
    return this.result(restored, { message: '已恢复历史版本；恢复前的版本也已留档。' })
  }

  private updateMeta(request: { [key: string]: unknown }): StudioActionResult {
    const id = safeProjectId(str(request.projectId))
    return this.resultSync(id, (project) => {
      if (typeof request.title === 'string') {
        const title = request.title.trim().slice(0, 120)
        if (!title) throw new Error('作品标题不能为空。')
        project.title = title
        project.titleSource = 'user'
      }
      if (typeof request.logline === 'string') {
        const logline = request.logline.trim().slice(0, 2000)
        if (!logline) throw new Error('一句话不能为空。')
        project.logline = logline
      }
      if (request.brief && typeof request.brief === 'object') {
        const brief = request.brief as Record<string, unknown>
        project.brief = {
          ...project.brief,
          ...(typeof brief.form === 'string' && ['速成草稿', '精制', '电影级'].includes(brief.form) ? { form: brief.form as StudioProject['brief']['form'] } : {}),
          ...(typeof brief.genre === 'string' ? { genre: brief.genre.slice(0, 60) } : {}),
          ...(typeof brief.audience === 'string' ? { audience: brief.audience.slice(0, 200) } : {}),
          ...(typeof brief.tone === 'string' ? { tone: brief.tone.slice(0, 200) } : {}),
          ...(typeof brief.style === 'string' ? { style: brief.style.slice(0, 400) } : {}),
          ...(typeof brief.aspect === 'string' && ['16:9', '9:16', '1:1'].includes(brief.aspect) ? { aspect: brief.aspect as StudioProject['brief']['aspect'] } : {}),
          ...(Array.isArray(brief.constraints) ? { constraints: arrayOfStrings(brief.constraints).slice(0, 20) } : {}),
          ...(Number.isFinite(Number(brief.targetWords)) && Number(brief.targetWords) > 0 ? { targetWords: Math.round(Number(brief.targetWords)) } : {}),
          ...(Number.isFinite(Number(brief.targetSeconds)) && Number(brief.targetSeconds) > 0 ? { targetSeconds: Math.round(Number(brief.targetSeconds)) } : {})
        }
      }
      if (request.runtime && typeof request.runtime === 'object') {
        const runtime = request.runtime as Record<string, unknown>
        project.runtime.strategy =
          runtime.strategy === 'cloud-first' || runtime.strategy === 'local-only' || runtime.strategy === 'cloud-only' ? runtime.strategy : project.runtime.strategy
        if (runtime.budget && typeof runtime.budget === 'object') {
          const budget = runtime.budget as Record<string, unknown>
          project.runtime.budget = {
            limit: Math.max(0, num(budget.limit, project.runtime.budget.limit)),
            spent: Math.max(0, num(budget.spent, project.runtime.budget.spent)),
            currency: 'CNY'
          }
        }
      }
      if (request.coverAssetId === null) project.coverAssetId = null
      else if (typeof request.coverAssetId === 'string') project.coverAssetId = request.coverAssetId
      if (typeof request.stage === 'string' && this.isStage(request.stage)) project.stage = request.stage
      if (request.stages && typeof request.stages === 'object') {
        for (const [key, value] of Object.entries(request.stages as Record<string, unknown>)) {
          if (!this.isStage(key) || !value || typeof value !== 'object') continue
          const patch = value as Record<string, unknown>
          project.stages[key] = {
            ...project.stages[key],
            ...(typeof patch.status === 'string' && ['waiting', 'ready', 'running', 'review', 'done', 'failed', 'stale', 'skipped'].includes(patch.status)
              ? { status: patch.status as StudioProject['stages'][StudioStageId]['status'] }
              : {}),
            ...(typeof patch.message === 'string' ? { message: patch.message.slice(0, 300) } : {}),
            updatedAt: nowMs()
          }
        }
      }
      this.store.save(project, '更新作品信息', { snapshot: true })
      return project
    })
  }

  private isStage(value: string): value is StudioStageId {
    return ['blueprint', 'outline', 'writing', 'storyboard', 'visuals', 'voice', 'music', 'timeline', 'review', 'delivery'].includes(value)
  }

  /** 同步动作的统一包装：锁内读写、保存、返回装饰后的作品。 */
  private resultSync(projectId: string, mutate: (project: StudioProject) => StudioProject | void): StudioActionResult {
    const project = this.store.readProject(projectId)
    const result = mutate(project)
    const next = result ?? project
    this.store.save(next, '更新作品', { snapshot: false })
    this.emitProject(next)
    return this.result(next)
  }

  private saveChapter(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const chapterId = str(request.chapterId)
      const chapter = project.chapters.find((item) => item.id === chapterId)
      if (!chapter) throw new Error('找不到这一章。')
      const previous = chapter.content
      if (typeof request.title === 'string' && request.title.trim()) chapter.title = request.title.trim().slice(0, 160)
      if (typeof request.synopsis === 'string') chapter.synopsis = request.synopsis.slice(0, 2000)
      if (Array.isArray(request.beats)) chapter.beats = arrayOfStrings(request.beats).slice(0, 30)
      if (Number.isFinite(Number(request.wordTarget)) && Number(request.wordTarget) > 0) {
        const requested = Math.round(Number(request.wordTarget))
        chapter.wordTarget = project.kind === 'novel' ? Math.max(2000, Math.min(5000, requested)) : requested
      }
      if (typeof request.content === 'string') {
        const content = request.content.slice(0, 2_000_000)
        if (content !== previous) {
          if (previous.trim()) this.store.addChapterVersion(chapter, previous, '手改前自动留档')
          chapter.content = content
          chapter.summary = content.trim() ? summarizeChapterText(content) : undefined
          chapter.revision += 1
          chapter.locked = content.trim().length > 0
          chapter.status = content.trim() ? 'done' : 'ready'
          chapter.updatedAt = nowMs()
          this.staleAfterManuscriptChange(project)
        }
      }
      project.stages.writing = {
        status: project.chapters.every((item) => item.content.trim()) ? 'done' : 'ready',
        updatedAt: nowMs(),
        message: `已完成 ${project.chapters.filter((item) => item.content.trim()).length}/${project.chapters.length} 章`
      }
      project.stage = 'writing'
      this.store.save(project, `保存第 ${chapter.number} 章`, { snapshot: false })
      return project
    })
  }

  private addChapter(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const hasVolume = Object.prototype.hasOwnProperty.call(request, 'volumeId')
      const volumeId = request.volumeId === null ? null : str(request.volumeId)
      if (volumeId && !project.volumes.some((volume) => volume.id === volumeId)) throw new Error('找不到要放入的分卷。')
      const chapter = this.store.addChapter(project, {
        title: str(request.title),
        synopsis: str(request.synopsis),
        wordTarget: project.kind === 'novel' ? Math.max(2000, Math.min(5000, num(request.wordTarget, 3000))) : num(request.wordTarget, 2500),
        content: str(request.content),
        ...(hasVolume ? { volumeId } : {})
      })
      project.stage = 'writing'
      this.renumberChapters(project)
      this.store.save(project, `添加第 ${chapter.number} 章`, { snapshot: true })
      return project
    })
  }

  private deleteChapter(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const chapterId = str(request.chapterId)
      const chapter = project.chapters.find((item) => item.id === chapterId)
      if (!chapter) throw new Error('找不到这一章。')
      if (chapter.content.trim() && !bool(request.confirmed)) throw new Error('这一章已有正文。确认删除请再点一次“确认删除”。')
      project.chapters = project.chapters.filter((item) => item.id !== chapterId)
      for (const volume of project.volumes) volume.chapterIds = volume.chapterIds.filter((id) => id !== chapterId)
      project.facts = project.facts.map((fact) => (fact.chapterId === chapterId ? { ...fact, chapterId: undefined } : fact))
      project.stage = 'writing'
      this.staleAfterManuscriptChange(project)
      this.store.save(project, '删除章节', { snapshot: true })
      return project
    })
  }

  private moveChapter(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const chapter = project.chapters.find((item) => item.id === str(request.chapterId))
      if (!chapter) throw new Error('找不到这一章。')
      if (Object.prototype.hasOwnProperty.call(request, 'volumeId')) {
        const targetVolumeId = request.volumeId === null ? null : str(request.volumeId)
        if (targetVolumeId && !project.volumes.some((volume) => volume.id === targetVolumeId)) throw new Error('找不到目标分卷。')
        for (const volume of project.volumes) volume.chapterIds = volume.chapterIds.filter((id) => id !== chapter.id)
        chapter.volumeId = targetVolumeId
        if (targetVolumeId) {
          const target = project.volumes.find((volume) => volume.id === targetVolumeId)!
          const beforeId = str(request.beforeChapterId)
          const beforeIndex = beforeId ? target.chapterIds.indexOf(beforeId) : -1
          if (beforeIndex >= 0) target.chapterIds.splice(beforeIndex, 0, chapter.id)
          else target.chapterIds.push(chapter.id)
        } else {
          chapter.number = project.chapters.reduce((max, item) => Math.max(max, item.number), 0) + 1
        }
        this.renumberChapters(project)
        this.staleStages(project, ['review', 'delivery'], '章节顺序有改动，旧检查与交付物需要重新生成')
        this.store.save(project, '移动章节到分卷', { snapshot: true })
        return project
      }
      const direction = num(request.offset, 1) >= 0 ? 1 : -1
      const sorted = [...project.chapters].sort((a, b) => a.number - b.number)
      const index = sorted.findIndex((item) => item.id === chapter.id)
      const neighbor = sorted[index + direction]
      if (!neighbor || neighbor.volumeId !== chapter.volumeId) throw new Error('同一卷内没有可交换的位置。')
      const number = chapter.number
      chapter.number = neighbor.number
      neighbor.number = number
      project.chapters = sorted.sort((a, b) => a.number - b.number)
      this.staleAfterManuscriptChange(project)
      this.store.save(project, '调整章节顺序', { snapshot: true })
      return project
    })
  }

  private renumberVolumes(project: StudioProject): void {
    project.volumes.sort((a, b) => a.number - b.number)
    project.volumes.forEach((volume, index) => {
      volume.number = index + 1
    })
  }

  /** 一章只属于一卷；卷内顺序与章节号在每次结构变更后重新落盘。 */
  private renumberChapters(project: StudioProject): void {
    const validVolumeIds = new Set(project.volumes.map((volume) => volume.id))
    for (const chapter of project.chapters) {
      if (chapter.volumeId && !validVolumeIds.has(chapter.volumeId)) chapter.volumeId = null
    }
    let next = 1
    const used = new Set<string>()
    for (const volume of [...project.volumes].sort((a, b) => a.number - b.number)) {
      const listed = volume.chapterIds
        .map((id) => project.chapters.find((chapter) => chapter.id === id && chapter.volumeId === volume.id))
        .filter((chapter): chapter is StudioChapter => Boolean(chapter))
      const rest = project.chapters
        .filter((chapter) => chapter.volumeId === volume.id && !listed.includes(chapter))
        .sort((a, b) => a.number - b.number)
      volume.chapterIds = []
      for (const chapter of [...listed, ...rest]) {
        chapter.number = next
        next += 1
        volume.chapterIds.push(chapter.id)
        used.add(chapter.id)
      }
    }
    for (const chapter of project.chapters.filter((item) => !used.has(item.id)).sort((a, b) => a.number - b.number)) {
      chapter.number = next
      next += 1
    }
    project.chapters.sort((a, b) => a.number - b.number)
  }

  private upsertVolume(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const input = (request.volume ?? request) as Record<string, unknown>
      const id = str(input.id)
      const title = str(input.title).trim()
      if (!title) throw new Error('卷名不能为空。')
      const summary = str(input.summary)
      const existing = id ? project.volumes.find((volume) => volume.id === id) : undefined
      if (existing) {
        existing.title = title
        existing.summary = summary
      } else {
        project.volumes.push({
          id: studioId('vol'),
          title,
          summary,
          number: project.volumes.reduce((max, volume) => Math.max(max, volume.number), 0) + 1,
          chapterIds: []
        })
      }
      this.renumberVolumes(project)
      this.renumberChapters(project)
      this.store.save(project, existing ? '编辑分卷' : '新建分卷', { snapshot: true })
      return project
    })
  }

  private deleteVolume(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const volumeId = str(request.volumeId)
      const volume = project.volumes.find((item) => item.id === volumeId)
      if (!volume) throw new Error('找不到这个分卷。')
      project.volumes = project.volumes.filter((item) => item.id !== volumeId)
      for (const chapter of project.chapters) {
        if (chapter.volumeId === volumeId) chapter.volumeId = null
      }
      this.renumberVolumes(project)
      this.renumberChapters(project)
      this.store.save(project, '删除分卷（章节保留）', { snapshot: true })
      return project
    })
  }

  private moveVolume(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const direction = num(request.offset, 1) >= 0 ? 1 : -1
      const sorted = [...project.volumes].sort((a, b) => a.number - b.number)
      const index = sorted.findIndex((volume) => volume.id === str(request.volumeId))
      const neighbor = sorted[index + direction]
      if (index < 0 || !neighbor) throw new Error('这个方向没有可交换的分卷。')
      const number = sorted[index].number
      sorted[index].number = neighbor.number
      neighbor.number = number
      this.renumberVolumes(project)
      this.renumberChapters(project)
      this.store.save(project, '调整分卷顺序', { snapshot: true })
      return project
    })
  }

  private saveBlueprint(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const blueprint = project.blueprint
      if (!blueprint) throw new Error('还没有蓝图可编辑。')
      const patch = (request.blueprint ?? request) as Record<string, unknown>
      for (const key of ['storyCore', 'pitch', 'emotion', 'audience', 'structure'] as const) {
        const value = patch[key]
        if (typeof value === 'string') {
          const trimmed = value.trim()
          if (!trimmed) throw new Error('故事主线与看点不能为空。')
          blueprint[key] = trimmed
        }
      }
      if (Array.isArray(patch.warnings)) {
        blueprint.warnings = patch.warnings.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      }
      if (Array.isArray(patch.units)) {
        blueprint.units = blueprint.units.map((unit) => {
          const next = (patch.units as Array<Record<string, unknown>>).find((item) => num(item.index, -1) === unit.index)
          if (!next) return unit
          return {
            ...unit,
            title: str(next.title, unit.title).trim() || unit.title,
            summary: str(next.summary, unit.summary),
            ...(typeof next.seconds === 'number' ? { seconds: Math.max(1, Math.min(600, next.seconds)) } : {}),
            ...(typeof next.wordTarget === 'number' ? { wordTarget: project.kind === 'novel' ? Math.max(2000, Math.min(5000, next.wordTarget)) : Math.max(100, Math.min(20_000, next.wordTarget)) } : {})
          }
        })
      }
      if (blueprint.approved) {
        if (Array.isArray(patch.units)) {
          if (project.kind === 'drama') updateDramaShots(project, blueprint)
          else updateNovelOutline(project, blueprint)
        }
        this.staleStages(project, ['writing', 'storyboard', 'visuals', 'voice', 'timeline', 'review', 'delivery'], '蓝图已修改，下游内容需要重新核对')
      }
      this.store.save(project, '编辑故事蓝图', { snapshot: true })
      return project
    })
  }

  private upsertWorldItem(request: { [key: string]: unknown }, key: 'factions' | 'rules' | 'props'): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const input = (request.item ?? request) as Record<string, unknown>
      const id = str(input.id)
      if (key === 'factions') {
        const existing = id ? project.factions.find((item) => item.id === id) : undefined
        const name = str(input.name).trim()
        if (!name) throw new Error('势力名称不能为空。')
        if (existing) {
          existing.name = name
          existing.description = str(input.description)
        } else {
          project.factions.push({ id: studioId('fac'), name, description: str(input.description) })
        }
      } else if (key === 'rules') {
        const existing = id ? project.rules.find((item) => item.id === id) : undefined
        const title = str(input.title).trim()
        if (!title) throw new Error('规则标题不能为空。')
        if (existing) {
          existing.title = title
          existing.content = str(input.content)
        } else {
          project.rules.push({ id: studioId('rule'), title, content: str(input.content) })
        }
      } else {
        const existing = id ? project.props.find((item) => item.id === id) : undefined
        const name = str(input.name).trim()
        if (!name) throw new Error('道具名称不能为空。')
        const refAssetIds = Array.isArray(input.refAssetIds) ? arrayOfStrings(input.refAssetIds) : existing?.refAssetIds ?? []
        if (existing) {
          existing.name = name
          existing.description = str(input.description)
          existing.refAssetIds = refAssetIds
        } else {
          project.props.push({ id: studioId('prop'), name, description: str(input.description), refAssetIds })
        }
      }
      this.staleStages(project, ['visuals', 'timeline', 'review', 'delivery'], '世界观设定有改动，画面与检查需要重新核对')
      this.store.save(project, '编辑世界设定', { snapshot: true })
      return project
    })
  }

  private deleteWorldItem(request: { [key: string]: unknown }, key: 'factions' | 'rules' | 'props'): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const id = str(request.id) || str(request.itemId)
      if (!id) throw new Error('缺少要删除的设定。')
      if (key === 'factions') project.factions = project.factions.filter((item) => item.id !== id)
      else if (key === 'rules') project.rules = project.rules.filter((item) => item.id !== id)
      else project.props = project.props.filter((item) => item.id !== id)
      this.staleStages(project, ['visuals', 'timeline', 'review', 'delivery'], '世界观设定有改动，画面与检查需要重新核对')
      this.store.save(project, '删除世界设定', { snapshot: true })
      return project
    })
  }

  private async retryJob(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const job = project.jobs.find((item) => item.id === str(request.jobId))
    if (!job) throw new Error('找不到这条任务记录。')
    if (job.status === 'running' || job.status === 'queued') throw new Error('任务仍在进行，不能重复启动。')
    if (!job.retry) throw new Error('这条任务没有可安全重放的输入快照。')
    const payload = {
      ...job.retry.payload,
      projectId,
      requestId: `retry-${job.id}-${Date.now().toString(36)}`
    }
    const result = await this.execute({ type: job.retry.action, ...payload })
    return result as StudioActionResult
  }

  /** 按外部任务号取回 ComfyUI 结果，并接回原来的镜头/配图目标。 */
  private async reconcileExternal(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const source = project.jobs.find((item) => item.id === str(request.jobId))
    if (!source) throw new Error('找不到这条任务记录。')
    if (!source.remoteId) throw new Error('这条任务没有外部任务号，不能对账。')
    if (source.kind !== 'image' && source.kind !== 'video') throw new Error('只有画面或视频任务可以对账。')
    const fallbackShot = Array.isArray(source.retry?.payload.shotIds) ? str(source.retry?.payload.shotIds[0]) : str(source.retry?.payload.shotId)
    const fallbackChapter = str(source.retry?.payload.chapterId)
    const targets = source.remoteTargets?.length
      ? source.remoteTargets
      : [{
          remoteId: source.remoteId,
          kind: (source.kind === 'video' ? 'video' : 'image') as 'image' | 'video',
          ...(fallbackShot ? { shotId: fallbackShot } : {}),
          ...(fallbackChapter ? { chapterId: fallbackChapter } : {})
        }]
    const job = await this.launchJob(project, {
      kind: source.kind,
      label: `取回外部任务 · ${source.label}`,
      stage: source.stage,
      requestId: `reconcile-${source.id}`,
      inputHash: sha256Buffer(Buffer.from(`reconcile:${source.id}:${targets.map((target) => target.remoteId).join('|')}`)),
      estimatedCostCny: 0,
      costNote: '取回本机 ComfyUI 已完成任务，不重复计费',
      run: async (snapshot, ctx) => {
        const media = getMediaService()
        const workspace = this.store.projectDir(snapshot.id)
        const generated: Array<{ asset: StudioAsset; kind: 'image' | 'video'; shotId?: string; chapterId?: string }> = []
        const errors: string[] = []
        for (const [index, target] of targets.entries()) {
          if (ctx.signal.aborted) break
          ctx.progress(`核对外部任务 ${index + 1}/${targets.length}`, 5 + Math.round((index / targets.length) * 82))
          try {
            const result = await media.resumePrompt({
              promptId: target.remoteId,
              kind: target.kind,
              workspace,
              signal: ctx.signal,
              onProgress: (update) => ctx.progress(`第 ${index + 1}/${targets.length} 个 · ${update.stage}`, 5 + Math.round(((index + (update.percent ?? 0) / 100) / targets.length) * 82))
            })
            const bytes = readFileSync(result.path)
            const shot = target.shotId ? snapshot.shots.find((item) => item.id === target.shotId) : undefined
            const chapter = target.chapterId ? snapshot.chapters.find((item) => item.id === target.chapterId) : undefined
            const thumb = result.thumbnailDataUrl?.startsWith('data:')
              ? Buffer.from(result.thumbnailDataUrl.split(',')[1] ?? '', 'base64')
              : makeThumbnail(result.path, snapshot.id)
            const tags = [target.kind, 'resumed', `remote:${target.remoteId}`]
            if (shot) tags.push(`shot:${shot.id}`)
            if (chapter) tags.push('illustration', `chapter:${chapter.id}`)
            const asset = await this.store.addAsset(snapshot, {
              bytes,
              title: shot
                ? `第 ${shot.number} 镜 · 外部任务取回`
                : chapter
                  ? `第 ${chapter.number} 章配图候选 · 外部任务取回`
                  : `外部任务取回 · ${target.remoteId.slice(0, 8)}`,
              mime: target.kind === 'video' ? 'video/mp4' : 'image/png',
              kindHint: target.kind,
              tags,
              origin: { model: result.model, jobId: ctx.jobId, source: 'comfyui-resume' },
              metadata: {
                ...(result.width ? { width: result.width } : {}),
                ...(result.height ? { height: result.height } : {}),
                ...(result.durationSec !== undefined ? { durationSec: result.durationSec } : {})
              },
              ...(thumb ? { thumbBytes: thumb } : {})
            })
            generated.push({ asset, kind: target.kind, ...(target.shotId ? { shotId: target.shotId } : {}), ...(target.chapterId ? { chapterId: target.chapterId } : {}) })
            try {
              if (result.path.startsWith(workspace)) rmSync(result.path, { force: true })
            } catch {
            }
          } catch (err) {
            errors.push(`外部任务 ${target.remoteId.slice(0, 8)}：${friendlyMediaError(err)}`)
          }
        }
        if (!generated.length) throw new Error(errors[0] ?? '没有取回可用的外部结果。')
        return {
          message: `已取回 ${generated.length}/${targets.length} 个外部结果${errors.length ? `；${errors.length} 个失败` : ''}。`,
          costCny: 0,
          costNote: '取回本机 ComfyUI 已完成任务，不重复计费',
          outputs: generated.map((item) => ({ label: item.asset.title, assetId: item.asset.id })),
          apply: (fresh) => {
            for (const item of generated) {
              if (!fresh.assets.some((asset) => asset.id === item.asset.id)) fresh.assets.push(item.asset)
              if (!item.shotId) continue
              const shot = fresh.shots.find((candidate) => candidate.id === item.shotId)
              if (!shot) continue
              if (item.kind === 'image') {
                if (!shot.imageAssetId) shot.imageAssetId = item.asset.id
                if (!shot.imageCandidates.some((candidate) => candidate.assetId === item.asset.id)) {
                  shot.imageCandidates.unshift({ id: studioId('cand'), assetId: item.asset.id, label: '外部任务取回', source: 'model', model: item.asset.origin?.model, createdAt: nowMs(), adopted: shot.imageAssetId === item.asset.id })
                }
              } else {
                shot.videoAssetId = item.asset.id
                if (!shot.videoCandidates.some((candidate) => candidate.assetId === item.asset.id)) {
                  shot.videoCandidates.unshift({ id: studioId('cand'), assetId: item.asset.id, label: '外部任务取回', source: 'model', model: item.asset.origin?.model, createdAt: nowMs(), adopted: true })
                }
              }
              shot.status = 'done'
              shot.updatedAt = nowMs()
            }
            const chapterHits = generated.filter((item) => item.chapterId).length
            if (chapterHits) {
              fresh.stages.visuals = {
                status: 'review',
                updatedAt: nowMs(),
                message: `${chapterHits} 张章节配图候选待采用`,
                progress: 60
              }
              fresh.stage = 'writing'
            }
            if (!fresh.coverAssetId && !chapterHits) {
              const firstImage = generated.find((item) => item.kind === 'image')
              if (firstImage) fresh.coverAssetId = firstImage.asset.id
            }
            const original = fresh.jobs.find((item) => item.id === source.id)
            if (original) {
              original.status = 'review'
              original.message = `外部任务结果已取回（${generated.length} 个），请确认采用。`
              original.error = undefined
              original.updatedAt = nowMs()
            }
            if (!chapterHits) finishVisualStage(fresh)
            if (errors.length) {
              fresh.checks.push({ id: studioId('check'), kind: 'missing', level: 'warn', title: `${errors.length} 个外部任务没有取回`, detail: errors.join(String.fromCharCode(10)), createdAt: nowMs() })
            }
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private async adaptToDrama(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const sourceId = safeProjectId(str(request.projectId) || str(request.sourceProjectId))
    const source = this.store.readProject(sourceId)
    if (source.kind === 'drama') throw new Error('这部作品已经是漫剧。')
    const chapters = [...source.chapters].sort((a, b) => a.number - b.number).filter((chapter) => chapter.content.trim()).slice(0, 12)
    if (!chapters.length) throw new Error('至少需要一章已写正文才能改编为漫剧。')
    const runtime = studioTextRuntime(source.runtime.strategy)
    if (!runtime.configured) throw new Error(`改编为漫剧需要可用的文本模型。${runtime.message} 请先在创作台设置 → 模型里连接模型。`)
    const now = nowMs()
    const target = this.store.newProject({
      kind: 'drama',
      title: `${source.title} · 漫剧`,
      logline: source.logline,
      brief: {
        ...source.brief,
        form: '速成草稿',
        aspect: '16:9',
        targetSeconds: Math.max(24, chapters.length * 8),
        constraints: [...source.brief.constraints, '改编自原著，保留原文来源']
      }
    })
    target.characters = source.characters.map((character) => ({ ...character, refAssetIds: [] }))
    target.places = source.places.map((place) => ({ ...place, refAssetIds: [] }))
    target.factions = source.factions.map((item) => ({ ...item }))
    target.rules = source.rules.map((item) => ({ ...item }))
    target.props = source.props.map((item) => ({ ...item, refAssetIds: [] }))
    target.facts = source.facts.map((fact) => ({ ...fact }))
    target.styleBible = { ...source.styleBible, negative: [...source.styleBible.negative] }
    target.chapters = chapters.map((chapter) => ({
      ...chapter,
      volumeId: null,
      number: chapter.number,
      candidates: [],
      versions: [],
      illustrations: [],
      locked: true,
      updatedAt: now
    }))
    const base = source.blueprint
    target.blueprint = {
      approved: true,
      approvedAt: now,
      source: 'model',
      ...(runtime.model?.label ? { model: runtime.model.label } : {}),
      title: source.title,
      genre: base?.genre ?? source.brief.genre,
      tone: base?.tone ?? source.brief.tone,
      storyCore: base?.storyCore ?? source.logline,
      emotion: base?.emotion ?? source.brief.tone,
      audience: base?.audience ?? source.brief.audience,
      pitch: base?.pitch ?? source.logline,
      structure: base?.structure ?? '',
      styleBible: source.styleBible,
      characters: target.characters,
      places: target.places,
      facts: [],
      units: [],
      scenes: [],
      estimate: base?.estimate ?? {
        minutesMin: 0,
        minutesMax: 0,
        costMin: null,
        costMax: null,
        currency: 'CNY',
        lines: [],
        basis: 'unknown',
        note: '按实际 token 记录。'
      },
      warnings: [],
      adaptedFrom: { projectId: source.id, title: source.title, chapters: chapters.length },
      createdAt: now
    }
    target.stage = 'storyboard'
    target.stages.blueprint = { status: 'done', updatedAt: now, message: '改编蓝图已建立，等待模型拆分镜头', progress: 100 }
    target.stages.outline = { status: 'ready', updatedAt: now, message: '等待模型拆分镜头', progress: 0 }
    target.stages.storyboard = { status: 'running', updatedAt: now, message: '等待模型生成分镜', progress: 0 }
    const cover = source.coverAssetId ? source.assets.find((asset) => asset.id === source.coverAssetId) : undefined
    if (cover) {
      try {
        const bytes = readFileSync(this.store.assetAbsolute(source, cover))
        const copied = await this.store.addAsset(target, {
          bytes,
          title: `${cover.title}（改编封面）`,
          mime: cover.mime,
          kindHint: 'image',
          tags: [...cover.tags, 'cover', 'adaptation'],
          metadata: { width: cover.width ?? 0, height: cover.height ?? 0 }
        })
        target.coverAssetId = copied.id
      } catch {
        // 封面不是改编必需项
      }
    }
    this.store.save(target, '由小说改编为漫剧', { snapshot: true })
    this.emitProject(target)
    const result = await this.generateStoryboard({
      projectId: target.id,
      requestId: str(request.requestId) || `adapt-${target.id}-${Date.now()}`
    })
    return { ...result, message: `已建立改编工程；正在用模型把 ${chapters.length} 章正文拆成漫剧分镜。` }
  }

  /** 长篇单次 JSON 容易超过模型输出上限；分五次写骨架、人物、每卷章节，全部来自真实模型。 */
  private async generateLongNovelBlueprint(
    snapshot: StudioProject,
    ctx: JobRunContext
  ): Promise<{ blueprint: StudioBlueprint; cost: number | null; costNote: string }> {
    const targetWords = snapshot.brief.targetWords ?? 300_000
    const plannedUnits = Math.max(36, Math.min(240, Math.ceil(targetWords / 4000)))
    const placeholderUnits: StudioBlueprint['units'] = Array.from({ length: plannedUnits }, (_, index) => ({
      index: index + 1,
      title: `第 ${index + 1} 章`,
      summary: '待展开',
      wordTarget: Math.max(2000, Math.min(5000, Math.round(targetWords / plannedUnits)))
    }))
    const costs: Array<number | null> = []
    ctx.progress('调用模型写长篇骨架', 10)
    const top = await completeCreativeText({
      system: `${LONG_BLUEPRINT_TOP_SYSTEM}${masterPromptContext('novel', 'blueprint', `${snapshot.logline} ${snapshot.brief.genre} ${snapshot.brief.tone} 故事 人物 世界观 分卷`, 'blueprint', snapshot.runtime.strategy)}`,
      prompt: longBlueprintTopPrompt(snapshot, plannedUnits),
      structured: true,
      temperature: 0.72,
      signal: ctx.signal,
      strategy: snapshot.runtime.strategy
    })
    costs.push(top.costCny)
    const topRaw = extractJson<Record<string, unknown>>(top.text)
    if (!topRaw) {
      log.warn('long blueprint top parse failed', { length: top.text.length, preview: top.text.slice(0, 1200) })
      throw new Error('模型返回的长篇骨架不是可解析的 JSON。请重试，或换一个支持长 JSON 输出的模型。')
    }
    const neutral = neutralBlueprint(snapshot)
    const blueprint = normalizeModelBlueprint(snapshot, {
      ...topRaw,
      characters: [],
      places: [],
      units: placeholderUnits
    }, top.model, neutral)
    blueprint.units = []
    const rawVolumeSeeds = blueprint.volumes?.length ? blueprint.volumes : normalizeModelVolumes(undefined, placeholderUnits, 'novel')
    const volumeSeeds = alignVolumeSeeds(rawVolumeSeeds, plannedUnits)

    ctx.progress('调用模型写人物与地点', 32)
    const cast = await completeCreativeText({
      system: `${LONG_BLUEPRINT_CAST_SYSTEM}${masterPromptContext('novel', 'blueprint', `${blueprint.storyCore} ${blueprint.volumes?.map((volume) => volume.title).join(' ')} 人物 角色 关系 世界观`, 'blueprint', snapshot.runtime.strategy)}`,
      prompt: longBlueprintCastPrompt(snapshot, blueprint),
      structured: true,
      temperature: 0.72,
      signal: ctx.signal,
      strategy: snapshot.runtime.strategy
    })
    costs.push(cast.costCny)
    const castRaw = extractJson<Record<string, unknown>>(cast.text)
    if (!castRaw) {
      log.warn('long blueprint cast parse failed', { length: cast.text.length, preview: cast.text.slice(0, 1200) })
      throw new Error('模型返回的人物与地点不是可解析的 JSON。请重试，或换一个支持长 JSON 输出的模型。')
    }
    const castBlueprint = normalizeModelBlueprint(
      { ...snapshot, titleSource: 'user' as const },
      { ...castRaw, units: placeholderUnits, volumes: [], facts: [], styleBible: blueprint.styleBible },
      cast.model,
      neutral
    )
    blueprint.characters = castBlueprint.characters
    blueprint.places = castBlueprint.places

    const volumeUnits: StudioBlueprint['units'][] = []
    for (let volumeIndex = 0; volumeIndex < volumeSeeds.length; volumeIndex += 1) {
      const seed = volumeSeeds[volumeIndex]
      const planned = Math.max(3, seed.unitEnd - seed.unitStart + 1)
      const batchSize = 4
      const batches = Math.max(1, Math.ceil(planned / batchSize))
      const merged: StudioBlueprint['units'] = []
      for (let batch = 0; batch < batches; batch += 1) {
        const count = Math.min(batchSize, planned - batch * batchSize)
        ctx.progress(`调用模型写第 ${volumeIndex + 1} 卷章节（${batch + 1}/${batches}）`, 42 + Math.round(((volumeIndex + batch / batches) / Math.max(1, volumeSeeds.length)) * 35))
        const unitsResult = await completeCreativeText({
          system: `${LONG_BLUEPRINT_UNITS_SYSTEM}${masterPromptContext('novel', 'outline', `${seed.title} ${seed.summary} 大纲 结构 节奏 伏笔`, 'outline', snapshot.runtime.strategy)}`,
          prompt: longVolumeUnitsPrompt(snapshot, blueprint, seed, count),
          structured: true,
          temperature: 0.75,
          signal: ctx.signal,
          strategy: snapshot.runtime.strategy
        })
        costs.push(unitsResult.costCny)
        let units = normalizeUnits('novel', extractJson<Record<string, unknown>>(unitsResult.text)?.units, [], blueprint.styleBible)
        if (!units.length) {
          log.warn('long blueprint units parse failed; retrying once', { volume: volumeIndex + 1, batch: batch + 1, length: unitsResult.text.length, preview: unitsResult.text.slice(0, 1200) })
          ctx.progress(`第 ${volumeIndex + 1} 卷本批 JSON 不完整，正在重试`, 45 + Math.round(((volumeIndex + batch / batches) / Math.max(1, volumeSeeds.length)) * 32))
          const retry = await completeCreativeText({
            system: `${LONG_BLUEPRINT_UNITS_SYSTEM}${masterPromptContext('novel', 'outline', `${seed.title} ${seed.summary} 大纲 结构 节奏 伏笔`, 'outline', snapshot.runtime.strategy)}\n\n上一次输出 JSON 语法不完整。这次只写 ${count} 章，确保每个键名都有双引号，先保证 JSON 完整。`,
            prompt: longVolumeUnitsPrompt(snapshot, blueprint, seed, count),
            structured: true,
            temperature: 0.4,
            signal: ctx.signal,
            strategy: snapshot.runtime.strategy
          })
          costs.push(retry.costCny)
          units = normalizeUnits('novel', extractJson<Record<string, unknown>>(retry.text)?.units, [], blueprint.styleBible)
        }
        if (units.length < count) {
          throw new Error(`模型只返回第 ${volumeIndex + 1} 卷第 ${batch + 1} 批的 ${units.length}/${count} 章，数量不足。请重试，或换一个支持长 JSON 输出的模型。`)
        }
        merged.push(...units.slice(0, count))
      }
      volumeUnits.push(merged)
    }

    let cursor = 1
    const units: StudioBlueprint['units'] = []
    const volumes: NonNullable<StudioBlueprint['volumes']> = []
    volumeSeeds.forEach((seed, index) => {
      const list = volumeUnits[index] ?? []
      const unitStart = cursor
      for (const unit of list) {
        units.push({ ...unit, index: cursor })
        cursor += 1
      }
      volumes.push({ ...seed, unitStart, unitEnd: Math.max(unitStart, cursor - 1) })
    })
    const perChapter = Math.max(2000, Math.min(5000, Math.round(targetWords / Math.max(1, plannedUnits))))
    for (const unit of units) unit.wordTarget = perChapter
    blueprint.units = units
    blueprint.volumes = volumes
    blueprint.estimate = blueprintEstimate(snapshot, units)
    assertModelBlueprint(blueprint, 'novel', snapshot.brief.targetWords)
    const known = costs.every((value): value is number => typeof value === 'number')
    return {
      blueprint,
      cost: known ? costs.reduce((sum, value) => sum + value, 0) : null,
      costNote: '长篇分卷调用模型，按实际 token 记录'
    }
  }

  private async generateBlueprint(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    if (project.blueprint?.approved && project.chapters.some((chapter) => chapter.content.trim())) {
      throw new Error('这部作品已经有正文。重新生成蓝图不会自动覆盖手稿；如需试验，请复制一个作品后再改。')
    }
    const useModel = request.useModel !== false
    const runtime = studioTextRuntime(project.runtime.strategy)
    if (!useModel) throw new Error('蓝图必须使用真实模型生成。请在创作台设置 → 模型里连接文本模型后再试。')
    if (!runtime.configured) throw new Error(`还没有可用的文本模型。${runtime.message} 请先在创作台设置 → 模型里连接模型，再生成蓝图。`)
    const estimated = estimateTextCostCny(project.logline.length + 2200, project.kind === 'drama' ? 6000 : 8000, project.runtime.strategy)
    const requestId = str(request.requestId) || undefined
    const inputHash = sha256Buffer(Buffer.from(`blueprint:${project.id}:${project.logline}:${project.kind}:${project.brief.form}:model:${project.runtime.strategy}`))
    const job = await this.launchJob(project, {
      kind: 'text',
      label: '生成创作蓝图',
      stage: 'blueprint',
      ...(requestId ? { requestId } : {}),
      inputHash,
      estimatedCostCny: estimated,
      costNote: '按当前文本模型参考价估算',
      retry: { action: 'generate-blueprint', payload: { useModel } },
      run: async (snapshot, ctx) => {
        let blueprint: StudioBlueprint
        let cost: number | null
        let costNote: string
        let message: string
        if (snapshot.kind === 'novel') {
          const long = await this.generateLongNovelBlueprint(snapshot, ctx)
          blueprint = long.blueprint
          cost = long.cost
          costNote = long.costNote
          message = `蓝图已生成（${long.blueprint.model ?? '当前模型'}，长篇分卷生成）。`
        } else {
          ctx.progress('调用模型写故事蓝图', 12)
          let result = await completeCreativeText({
            system: `${BLUEPRINT_SYSTEM}${masterPromptContext(snapshot.kind, 'blueprint', `${snapshot.logline} ${snapshot.brief.genre} ${snapshot.brief.tone} 故事 人物 世界观`, 'blueprint', snapshot.runtime.strategy)}`,
            prompt: blueprintPrompt(snapshot),
            structured: true,
            temperature: 0.72,
            signal: ctx.signal,
            strategy: snapshot.runtime.strategy
          })
          let parsed = extractJson<Record<string, unknown>>(result.text)
          if (!parsed) {
            log.warn('blueprint model response parse failed; retrying once', { length: result.text.length, preview: result.text.slice(0, 1200), tail: result.text.slice(-300) })
            ctx.progress('模型输出不完整，正在重试', 48)
            const retry = await completeCreativeText({
              system: `${BLUEPRINT_SYSTEM}${masterPromptContext(snapshot.kind, 'blueprint', `${snapshot.logline} ${snapshot.brief.genre} ${snapshot.brief.tone} 故事 人物 世界观`, 'blueprint', snapshot.runtime.strategy)}\n\n上一次输出在 JSON 中途被截断。这次务必控制篇幅，先保证输出完整、可解析，再写细节。`,
              prompt: blueprintPrompt(snapshot),
              structured: true,
              temperature: 0.55,
              signal: ctx.signal,
              strategy: snapshot.runtime.strategy
            })
            parsed = extractJson<Record<string, unknown>>(retry.text)
            if (!parsed) {
              log.warn('blueprint model response parse failed after retry', { length: retry.text.length, preview: retry.text.slice(0, 1200) })
              throw new Error('模型返回的蓝图不是可解析的 JSON。请重试，或换一个支持长 JSON 输出的模型。')
            }
            result = retry
          }
          blueprint = normalizeModelBlueprint(snapshot, parsed, result.model, neutralBlueprint(snapshot))
          assertModelBlueprint(blueprint, snapshot.kind, snapshot.brief.targetWords)
          cost = result.costCny
          costNote = result.costNote ?? '按实际 token 记录'
          message = `蓝图已生成（${result.model}）。`
        }
        ctx.progress('整理人物与结构', 78)
        const finalBlueprint = blueprint
        return {
          message,
          costCny: cost,
          costNote,
          outputs: [{ label: '蓝图与人物', path: undefined }],
          apply: (fresh) => {
            applyBlueprintToProject(fresh, finalBlueprint)
            if (!finalBlueprint.approved) {
              fresh.stage = 'blueprint'
              fresh.stages.blueprint = { status: 'review', updatedAt: nowMs(), message: '蓝图待审阅', progress: 55 }
            }
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private approveBlueprint(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const blueprint = project.blueprint
    if (!blueprint) throw new Error('还没有可确认的蓝图。')
    blueprint.approved = true
    blueprint.approvedAt = nowMs()
    const hasWrittenChapters = project.chapters.some((chapter) => chapter.content.trim())
    project.stages.blueprint = { status: 'done', updatedAt: nowMs(), message: '蓝图已确认', progress: 100 }
    if (hasWrittenChapters) {
      project.stage = project.kind === 'drama' ? 'storyboard' : 'writing'
      project.stages.outline = { status: 'done', updatedAt: nowMs(), message: '保留已有大纲与正文', progress: 100 }
    } else {
      applyBlueprintToProject(project, blueprint)
      const outlineReady = Boolean(blueprint.outlineModel)
      project.stage = 'outline'
      project.stages.outline = outlineReady
        ? { status: 'done', updatedAt: nowMs(), message: '章纲已建立', progress: 100 }
        : { status: 'ready', updatedAt: nowMs(), message: '可以生成章纲', progress: 55 }
      if (project.kind === 'drama') {
        project.stages.storyboard = outlineReady
          ? { status: 'ready', updatedAt: nowMs(), message: '可以生成分镜', progress: 50 }
          : { status: 'waiting', updatedAt: nowMs(), message: '先细化大纲，再生成分镜', progress: 0 }
      } else {
        project.stages.writing = { status: 'ready', updatedAt: nowMs(), message: '可以开始写第一章', progress: 0 }
      }
    }
    project.messages.push(
      assistantMessage('assistant', hasWrittenChapters ? '蓝图已更新，已有正文与章节保持不变。' : `蓝图已确认，${project.kind === 'drama' ? `${project.shots.length} 个镜头框架已就位。下一步先用模型细化大纲与分镜。` : `${project.chapters.length} 章骨架已就位。下一步先用模型细化章纲，再开始写正文。`}`)
    )
    this.store.save(project, '确认蓝图', { snapshot: true })
    this.emitProject(project)
    return this.result(project)
  }

  /** 长篇一次输出几十章容易截断；按批细化，每批都必须是可解析 JSON。 */
  private async generateOutlineInBatches(
    snapshot: StudioProject,
    blueprint: StudioBlueprint,
    ctx: JobRunContext
  ): Promise<{ units: StudioBlueprint['units']; cost: number | null; costNote: string; model: string }> {
    const batchSize = 12
    const units: StudioBlueprint['units'] = []
    let cost = 0
    let known = true
    let model = ''
    for (let start = 0; start < blueprint.units.length; start += batchSize) {
      const batch = blueprint.units.slice(start, start + batchSize)
      const end = start + batch.length
      ctx.progress(`正在细化第 ${start + 1}–${end} 章`, 20 + Math.round((start / Math.max(1, blueprint.units.length)) * 60))
      const result = await completeCreativeText({
        system: `${OUTLINE_SYSTEM}${masterPromptContext(snapshot.kind, 'outline', `${blueprint.storyCore} ${blueprint.structure} ${batch.map((unit) => unit.title).join(' ')} 结构 节奏 伏笔 情绪`, 'outline', snapshot.runtime.strategy)}`,
        prompt: outlineBatchPrompt(snapshot, blueprint, batch, start, blueprint.units.length),
        structured: true,
        signal: ctx.signal,
        strategy: snapshot.runtime.strategy
      })
      const parsed = extractJson<Record<string, unknown>>(result.text)
      const rawUnits = Array.isArray(parsed?.units) ? parsed.units : []
      if (rawUnits.length < batch.length) {
        throw new Error(`模型只返回第 ${start + 1}–${end} 章中的 ${rawUnits.length} 章，数量不足。请重试或换一个更强的文本模型。`)
      }
      const refined = normalizeUnits(snapshot.kind, rawUnits, batch, blueprint.styleBible).slice(0, batch.length)
      if (!refined.length || refined.some((unit) => !unit.summary.trim() || unit.summary === '（待补充）')) {
        throw new Error(`模型没有返回第 ${start + 1}–${end} 章的完整大纲。请重试。`)
      }
      batch.forEach((original, index) => {
        units.push({ ...(refined[index] ?? original), index: start + index + 1 })
      })
      model = result.model
      if (typeof result.costCny === 'number') cost += result.costCny
      else known = false
    }
    return { units, cost: known ? cost : null, costNote: '长篇分章细化，按实际 token 记录', model: model || blueprint.model || '当前模型' }
  }

  private async generateOutline(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    if (!project.blueprint?.approved) throw new Error('请先看一遍并确认蓝图。')
    const useModel = request.useModel !== false
    const runtime = studioTextRuntime(project.runtime.strategy)
    if (!useModel) throw new Error('大纲必须使用文本模型生成。请在创作台设置 → 模型里连接模型后再试。')
    if (!runtime.configured) throw new Error(`还没有可用的文本模型。${runtime.message} 请先在创作台设置 → 模型里连接模型。`)
    const estimated = estimateTextCostCny(project.blueprint.storyCore.length + 2000, 4000, project.runtime.strategy)
    const job = await this.launchJob(project, {
      kind: 'text',
      label: project.kind === 'drama' ? '生成剧本与镜头计划' : '生成章纲',
      stage: 'outline',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`outline:${project.id}:${project.blueprint.storyCore}:model`)),
      estimatedCostCny: estimated,
      costNote: '按当前文本模型参考价估算',
      retry: { action: 'generate-outline', payload: { useModel } },
      run: async (snapshot, ctx) => {
        const current = snapshot.blueprint as StudioBlueprint
        let units: StudioBlueprint['units']
        let modelLabel: string
        let cost: number | null
        let costNote: string
        if (current.units.length > 16) {
          const batched = await this.generateOutlineInBatches(snapshot, current, ctx)
          units = batched.units
          modelLabel = batched.model
          cost = batched.cost
          costNote = batched.costNote
        } else {
          ctx.progress('正在拆大纲', 20)
          const result = await completeCreativeText({
            system: `${OUTLINE_SYSTEM}${masterPromptContext(snapshot.kind, 'outline', `${current.storyCore} ${current.structure} ${current.units.map((unit) => unit.title).join(' ')} 结构 节奏 伏笔 情绪`, 'outline', snapshot.runtime.strategy)}`,
            prompt: outlinePrompt(snapshot, current),
            structured: true,
            signal: ctx.signal,
            strategy: snapshot.runtime.strategy
          })
          const parsed = extractJson<Record<string, unknown>>(result.text)
          if (!parsed || !Array.isArray(parsed.units) || !parsed.units.length) throw new Error('模型没有返回可用的 units。请重试，或换一个更强的文本模型。')
          units = normalizeUnits(snapshot.kind, parsed.units, current.units, current.styleBible)
          if (!units.length || units.some((unit) => !unit.summary.trim() || unit.summary === '（待补充）')) {
            throw new Error('模型返回的大纲缺少章节摘要，已拒绝写入旧稿。请重试。')
          }
          if (units.length < current.units.length) {
            throw new Error(`模型只返回 ${units.length} 个单元，少于当前大纲的 ${current.units.length} 个；已拒绝用残缺大纲覆盖。请重试。`)
          }
          modelLabel = result.model
          cost = result.costCny
          costNote = result.costNote ?? '按实际 token 记录'
        }
        const finalBlueprint = { ...current, units, source: 'model' as const, model: modelLabel, outlineModel: modelLabel }
        ctx.progress('整理章节与镜头', 82)
        return {
          message: `大纲已更新（${modelLabel}）。`,
          costCny: cost,
          costNote,
          apply: (fresh) => {
            fresh.blueprint = { ...finalBlueprint }
            if (fresh.kind === 'drama') {
              if (!fresh.shots.length) {
                applyDramaOutline(fresh, finalBlueprint)
                fresh.stage = 'storyboard'
                fresh.stages.outline = { status: 'done', updatedAt: nowMs(), message: '镜头计划已更新', progress: 100 }
              } else {
                syncDramaOutline(fresh, finalBlueprint)
                fresh.stages.outline = { status: 'done', updatedAt: nowMs(), message: '镜头文字已更新，画面与配音待核对', progress: 100 }
                if (fresh.stages.storyboard.status === 'done' || fresh.stages.storyboard.status === 'review') {
                  fresh.stages.storyboard = { ...fresh.stages.storyboard, status: 'stale', updatedAt: nowMs(), message: '大纲已更新，分镜需要核对' }
                }
                this.staleStages(fresh, ['visuals', 'voice', 'timeline', 'review', 'delivery'], '大纲已更新，旧画面、配音与交付需要重新核对')
              }
            } else if (fresh.chapters.some((chapter) => chapter.content.trim())) {
              updateNovelOutline(fresh, finalBlueprint)
              fresh.stages.outline = { status: 'done', updatedAt: nowMs(), message: '已更新章纲，保留正文', progress: 100 }
            } else {
              applyNovelOutline(fresh, finalBlueprint)
              fresh.stage = 'writing'
              fresh.stages.outline = { status: 'done', updatedAt: nowMs(), message: '章纲已建立', progress: 100 }
            }
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private async generateChapter(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const chapterId = str(request.chapterId)
    const chapter = project.chapters.find((item) => item.id === chapterId)
    if (!chapter) throw new Error('找不到这一章。')
    if (!project.blueprint?.approved) throw new Error('请先看一遍并确认蓝图，再生成正文。')
    const useModel = request.useModel !== false
    const runtime = studioTextRuntime(project.runtime.strategy)
    const textConfigured = runtime.configured && useModel
    const instruction = str(request.instruction).slice(0, 2000)
    const target = chapter.wordTarget || 2500
    const estimated = textConfigured ? estimateTextCostCny(project.blueprint?.storyCore.length ?? 1000 + instruction.length, target * 1.8, project.runtime.strategy) : 0
    const job = await this.launchJob(project, {
      kind: 'text',
      label: `写第 ${chapter.number} 章 · ${chapter.title}`,
      stage: 'writing',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`chapter:${project.id}:${chapter.id}:${chapter.revision}:${instruction}:${textConfigured}`)),
      estimatedCostCny: estimated,
      costNote: '按当前文本模型参考价估算',
      retry: { action: 'generate-chapter', payload: { chapterId, useModel, instruction } },
      run: async (snapshot, ctx) => {
        const current = snapshot.chapters.find((item) => item.id === chapterId)
        if (!current) throw new Error('这一章已被删除。')
        if (!textConfigured) {
          throw new Error(runtime.configured
            ? '这次选择了不使用模型；正文必须由真实模型生成，请重新生成并允许使用模型。'
            : `写正文需要可用的文本模型。${runtime.message}`)
        }
        ctx.progress('正在写正文', 15)
        const systemPrompt = `${PROSE_SYSTEM}${masterPromptContext(snapshot.kind, 'chapter', `${current.title} ${current.synopsis} ${current.beats.join(' ')} ${instruction}`, 'writing', snapshot.runtime.strategy)}`
        const result = await completeCreativeText({
          system: systemPrompt,
          prompt: chapterPrompt(snapshot, current, instruction),
          continueOnTruncate: true,
          temperature: 0.9,
          signal: ctx.signal,
          strategy: snapshot.runtime.strategy
        })
        let content = stripProseDecorations(result.text)
        if (!content.trim()) throw new Error('模型没有返回可用正文；请重试或换一个模型。')
        let cost: number | null = result.costCny
        const costNote = result.costNote ?? '按实际 token 记录'
        const targetWords = current.wordTarget || 2500
        if (countWords(content) < Math.max(600, targetWords * 0.55)) {
          ctx.progress('字数不足，补写细节', 55)
          const retry = await completeCreativeText({
            system: systemPrompt,
            prompt: [
              chapterPrompt(snapshot, current, instruction),
              '',
              `上一稿只有 ${countWords(content)} 字，低于本章目标 ${targetWords} 字。请保留已经成立的情节，用具体动作、对话、感官细节和场景推进扩写到目标字数；不要写提纲、不要重复段落、不要总结。`,
              '',
              content
            ].join('\n'),
            continueOnTruncate: true,
            temperature: 0.85,
            signal: ctx.signal,
            strategy: snapshot.runtime.strategy
          })
          const expanded = stripProseDecorations(retry.text)
          if (countWords(expanded) > countWords(content)) {
            content = expanded
            if (typeof retry.costCny === 'number') cost = (cost ?? 0) + retry.costCny
          }
        }
        const modelLabel = result.model
        const message = `第 ${current.number} 章已生成（${result.model}）。`
        const wordCount = countWords(content)
        if (wordCount < 300) throw new Error(`模型只返回了 ${wordCount} 字，无法作为正文。请重试或换一个模型。`)
        ctx.progress('生成候选稿', 86)
        return {
          message: `${message} ${wordCount} 字。`,
          costCny: cost,
          costNote,
          outputs: [{ label: `第 ${current.number} 章候选`, path: undefined }],
          apply: (fresh) => {
            const targetChapter = fresh.chapters.find((item) => item.id === chapterId)
            if (!targetChapter) return
            targetChapter.candidates.unshift({
              id: studioId('cand'),
              content,
              label: `模型稿 · ${modelLabel}`,
              source: 'model',
              model: modelLabel,
              ...(instruction ? { note: instruction } : {}),
              createdAt: nowMs(),
              wordCount
            })
            targetChapter.candidates = targetChapter.candidates.slice(0, 6)
            targetChapter.summary = summarizeChapterText(content)
            if (!targetChapter.content.trim()) {
              targetChapter.content = content
              targetChapter.revision += 1
              targetChapter.status = 'done'
              targetChapter.updatedAt = nowMs()
              this.store.addChapterVersion(targetChapter, '', 'AI 初稿')
            }
            targetChapter.updatedAt = nowMs()
            const pending = fresh.chapters.some((item) => item.candidates.length > 0)
            fresh.stages.writing = {
              status: pending ? 'review' : fresh.chapters.every((item) => item.content.trim()) ? 'done' : 'ready',
              updatedAt: nowMs(),
              message: pending ? `第 ${targetChapter.number} 章有候选待采用` : `已完成 ${fresh.chapters.filter((item) => item.content.trim()).length}/${fresh.chapters.length} 章`,
              progress: Math.round((fresh.chapters.filter((item) => item.content.trim()).length / Math.max(1, fresh.chapters.length)) * 100)
            }
            fresh.stage = 'writing'
          }
        }
      }
    })
    return this.result(project, { job })
  }

  /** 连续写作：只推进还没有正文的章节，逐章排队；预算由每个生成任务单独校验。 */
  private async polishChapter(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const chapterId = str(request.chapterId)
    const chapter = project.chapters.find((item) => item.id === chapterId)
    if (!chapter) throw new Error('找不到这一章。')
    if (!chapter.content.trim()) throw new Error('这一章还没有正文，先生成或手写正文再润色。')
    const runtime = studioTextRuntime(project.runtime.strategy)
    if (!runtime.configured) throw new Error('润色需要可用的文本模型；请先在创作台设置 → 模型里连接模型。')
    const instruction = str(request.instruction).slice(0, 1200)
    const replaceContent = request.replaceContent === true
    const estimated = estimateTextCostCny(chapter.content.length + instruction.length, chapter.content.length, project.runtime.strategy) ?? 0
    const job = await this.launchJob(project, {
      kind: 'text',
      label: replaceContent ? `协作者重写第 ${chapter.number} 章 · ${chapter.title}` : `润色第 ${chapter.number} 章 · ${chapter.title}`,
      stage: 'writing',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`polish:${project.id}:${chapter.id}:${chapter.revision}:${instruction}:${replaceContent}`)),
      estimatedCostCny: estimated,
      costNote: '按当前文本模型参考价估算',
      retry: { action: 'polish-chapter', payload: { chapterId, instruction, replaceContent } },
      run: async (snapshot, ctx) => {
        const current = snapshot.chapters.find((item) => item.id === chapterId)
        if (!current) throw new Error('这一章已被删除。')
        ctx.progress(replaceContent ? '正在按计划重写' : '正在润色', 20)
        const result = await completeCreativeText({
          system: `${PROSE_SYSTEM}${masterPromptContext(snapshot.kind, 'rewrite', `${current.title} ${instruction} ${replaceContent ? '按用户要求改写剧情' : '润色 去 AI 腔 对白 克制'}`, 'writing', snapshot.runtime.strategy)}`,
          prompt: replaceContent
            ? [
                `请按用户要求重写这一章，并输出完整正文。`,
                `用户要求：${instruction || '把这一章改得更好。'}`,
                '保持人物、事实与前文连续；用户明确要求改动的部分可以改，没有要求的部分不要顺手改。',
                '不要输出标题、解释或 Markdown。',
                '',
                current.content
              ].join('\n')
            : [
                `请润色以下章节正文。只改语言、节奏、动作与对白，不改情节、人名、事实、段落顺序和章节结尾。`,
                `用户额外要求：${instruction || '更具体、更克制、去 AI 腔。'}`,
                '输出完整正文，不要标题、不要解释、不要 Markdown。',
                '',
                current.content
              ].join('\n'),
          continueOnTruncate: true,
          temperature: replaceContent ? 0.8 : 0.7,
          signal: ctx.signal,
          strategy: snapshot.runtime.strategy
        })
        const content = stripProseDecorations(result.text)
        if (!content.trim()) throw new Error('模型没有返回可用正文。')
        return {
          message: replaceContent ? `第 ${current.number} 章已按计划重写，${countWords(content)} 字。` : `润色稿已生成，${countWords(content)} 字；采用前不会覆盖正文。`,
          costCny: result.costCny,
          costNote: result.costNote ?? '按实际 token 记录',
          outputs: [{ label: `第 ${current.number} 章${replaceContent ? '重写稿' : '润色候选'}`, path: undefined }],
          apply: (fresh) => {
            const target = fresh.chapters.find((item) => item.id === chapterId)
            if (!target) return
            if (replaceContent) {
              if (target.content.trim()) {
                target.versions.unshift({ id: studioId('cv'), content: target.content, createdAt: nowMs(), reason: '协作者重写前自动留档', wordCount: countWords(target.content) })
                target.versions = target.versions.slice(0, 30)
              }
              target.content = content
              target.summary = summarizeChapterText(content)
              target.revision += 1
              target.status = 'done'
              target.updatedAt = nowMs()
              fresh.stages.writing = { status: 'done', updatedAt: nowMs(), message: `第 ${target.number} 章已按计划重写`, progress: 100 }
              for (const stageId of ['review', 'delivery'] as const) {
                const stage = fresh.stages[stageId]
                if (stage && (stage.status === 'done' || stage.status === 'review')) {
                  fresh.stages[stageId] = { ...stage, status: 'stale', updatedAt: nowMs(), message: '正文已重写，旧检查与交付需要重新生成' }
                }
              }
              fresh.stage = 'writing'
              return
            }
            target.candidates.unshift({
              id: studioId('cand'),
              content,
              label: `润色稿 · ${result.model}`,
              source: 'model',
              model: result.model,
              ...(instruction ? { note: instruction } : {}),
              createdAt: nowMs(),
              wordCount: countWords(content)
            })
            target.candidates = target.candidates.slice(0, 6)
            target.updatedAt = nowMs()
            fresh.stages.writing = { status: 'review', updatedAt: nowMs(), message: '有润色候选待采用', progress: 60 }
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private async batchWrite(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    if (project.kind === 'drama') throw new Error('漫剧请按镜头逐镜生成；连续写作只用于小说。')
    if (!project.blueprint?.approved) throw new Error('请先审阅并确认蓝图，再开始连续写作。')
    const count = Math.max(1, Math.min(10, Math.round(num(request.count, 3))))
    const requested = Array.isArray(request.chapterIds) ? new Set(arrayOfStrings(request.chapterIds)) : null
    const targets = project.chapters
      .filter((chapter) => !chapter.content.trim() && (!requested || requested.has(chapter.id)))
      .sort((a, b) => a.number - b.number)
      .slice(0, count)
    if (!targets.length) throw new Error('没有待写的章节；已有正文不会被自动覆盖。')
    const useModel = request.useModel !== false
    const runtime = studioTextRuntime(project.runtime.strategy)
    const textConfigured = runtime.configured && useModel
    if (!textConfigured) {
      throw new Error(runtime.configured ? '这次没有启用模型；连续写作必须调用文本模型。' : `连续写作需要可用的文本模型。${runtime.message}`)
    }
    if (textConfigured) {
      const storyCoreLength = project.blueprint?.storyCore?.length ?? 1000
      const estimateTotal = targets.reduce((sum, chapter) => sum + (estimateTextCostCny(storyCoreLength + 2000, chapter.wordTarget * 1.8, project.runtime.strategy) ?? 0), 0)
      this.assertBudget(project, estimateTotal)
    }
    const jobs: StudioJob[] = []
    const errors: string[] = []
    for (const chapter of targets) {
      try {
        const result = await this.generateChapter({
          projectId,
          chapterId: chapter.id,
          instruction: str(request.instruction),
          useModel: request.useModel
        })
        if (result.job) jobs.push(result.job)
      } catch (err) {
        errors.push(`第 ${chapter.number} 章：${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }
    const latest = this.store.readProject(projectId)
    return this.result(latest, {
      ...(jobs[0] ? { job: jobs[0] } : {}),
      message: jobs.length
        ? `已排队续写 ${jobs.length} 章${targets.length > jobs.length ? `（另有 ${targets.length - jobs.length} 章未排队）` : ''}${errors.length ? `；${errors.join('；')}` : ''}`
        : errors.join('；') || '没有可排队的章节。'
    })
  }

  /** 为章节生成配图候选；只入库候选，采用后才写入章节。 */
  private async generateChapterIllustration(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const chapter = project.chapters.find((item) => item.id === str(request.chapterId))
    if (!chapter) throw new Error('找不到这一章。')
    if (!chapter.content.trim()) throw new Error('这一章还没有正文，先生成或手写正文再配图。')
    const readiness = await this.mediaReady('image')
    if (!readiness.ok) throw new Error(`${readiness.message}。可以先导入现成图片作为配图。`)
    const count = Math.max(1, Math.min(3, Math.round(num(request.count, 2))))
    const instruction = str(request.instruction).slice(0, 800)
    const prompt = [
      `为小说章节《${chapter.title}》配一张叙事插图。`,
      chapter.synopsis ? `本章梗概：${chapter.synopsis}。` : '',
      `正文片段：${chapter.content.slice(0, 1600)}`,
      project.styleBible.look ? `整体风格：${project.styleBible.look}。` : '',
      '画面要有明确的主体、环境与情绪，不要出现文字、水印、分镜边框或漫画格子。',
      instruction
    ].filter(Boolean).join('\n')
    const job = await this.launchJob(project, {
      kind: 'image',
      label: `为第 ${chapter.number} 章生成配图`,
      stage: 'visuals',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`illustration:${project.id}:${chapter.id}:${chapter.revision}:${instruction}`)),
      estimatedCostCny: 0,
      costNote: '本机 ComfyUI 引擎，不计边际费用',
      retry: { action: 'generate-chapter-illustration', payload: { chapterId: chapter.id, count, instruction } },
      run: async (snapshot, ctx) => {
        const media = getMediaService()
        const workspace = this.store.projectDir(snapshot.id)
        const generated: StudioAsset[] = []
        for (let index = 0; index < count; index += 1) {
          if (ctx.signal.aborted) break
          ctx.progress(`第 ${index + 1}/${count} 张配图`, 5 + Math.round((index / count) * 82))
          try {
            const result = await media.generateImage({
              workspace,
              prompt,
              width: 1024,
              height: 1024,
              signal: ctx.signal,
              onProgress: (update) => ctx.progress(`第 ${index + 1}/${count} 张 · ${update.stage}`, 5 + Math.round(((index + (update.percent ?? 0) / 100) / count) * 82)),
              ...(ctx.attachRemote ? { onPromptId: (promptId: string) => ctx.attachRemote?.(promptId, { kind: 'image', chapterId: chapter.id }) } : {})
            })
            const bytes = readFileSync(result.path)
            const asset = await this.store.addAsset(snapshot, {
              bytes,
              title: `第 ${chapter.number} 章配图候选 ${index + 1}`,
              mime: 'image/png',
              kindHint: 'image',
              tags: ['illustration', `chapter:${chapter.id}`],
              origin: { model: result.model, jobId: ctx.jobId, source: 'comfyui', promptHash: createHash('sha256').update(prompt).digest('hex').slice(0, 16) },
              metadata: { width: result.width, height: result.height }
            })
            generated.push(asset)
          } catch (err) {
            if (ctx.signal.aborted) break
            ctx.progress(`第 ${index + 1} 张失败：${friendlyMediaError(err)}`, 5 + Math.round(((index + 1) / count) * 82))
          }
        }
        if (!generated.length) throw new Error('没有生成可用的配图。')
        return {
          message: `已生成 ${generated.length} 张配图候选；采用前不会插入正文。`,
          costCny: 0,
          costNote: '本机 ComfyUI 引擎，不计边际费用',
          outputs: generated.map((asset) => ({ label: asset.title, assetId: asset.id })),
          apply: (fresh) => {
            for (const asset of generated) {
              if (!fresh.assets.some((item) => item.id === asset.id)) fresh.assets.push(asset)
            }
            fresh.stages.visuals = { status: 'review', updatedAt: nowMs(), message: `${generated.length} 张配图候选待采用`, progress: 60 }
            fresh.stage = 'writing'
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private attachChapterIllustration(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const chapter = project.chapters.find((item) => item.id === str(request.chapterId))
      if (!chapter) throw new Error('找不到这一章。')
      const asset = project.assets.find((item) => item.id === str(request.assetId) && item.kind === 'image')
      if (!asset) throw new Error('找不到要采用的图片素材。')
      const paragraphCount = chapterParagraphCount(chapter.content)
      const afterParagraph = Math.max(0, Math.min(paragraphCount, Math.round(num(request.afterParagraph, 0))))
      const existing = chapter.illustrations.find((item) => item.assetId === asset.id)
      if (existing) {
        existing.afterParagraph = afterParagraph
        existing.caption = str(request.caption).slice(0, 200) || existing.caption
      } else {
        chapter.illustrations.push({
          id: studioId('ill'),
          assetId: asset.id,
          afterParagraph,
          ...(str(request.caption) ? { caption: str(request.caption).slice(0, 200) } : {}),
          source: asset.origin?.source === 'comfyui' ? 'model' : 'import',
          createdAt: nowMs()
        })
      }
      chapter.illustrations = chapter.illustrations.sort((a, b) => a.afterParagraph - b.afterParagraph)
      const written = project.chapters.filter((item) => item.content.trim())
      const withImage = written.filter((item) => item.illustrations.length).length
      project.stages.visuals = {
        status: written.length > 0 && withImage >= written.length ? 'done' : 'review',
        updatedAt: nowMs(),
        message: `${withImage}/${written.length} 章有配图`,
        progress: written.length ? Math.round((withImage / written.length) * 100) : 0
      }
      this.staleAfterManuscriptChange(project)
      this.store.save(project, `采用第 ${chapter.number} 章配图`, { snapshot: false })
      return project
    })
  }

  private removeChapterIllustration(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const chapter = project.chapters.find((item) => item.id === str(request.chapterId))
      if (!chapter) throw new Error('找不到这一章。')
      chapter.illustrations = chapter.illustrations.filter((item) => item.id !== str(request.illustrationId))
      this.staleAfterManuscriptChange(project)
      this.store.save(project, '移除章节配图', { snapshot: false })
      return project
    })
  }

  private adoptCandidate(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const chapter = project.chapters.find((item) => item.id === str(request.chapterId))
      const candidate = chapter?.candidates.find((item) => item.id === str(request.candidateId))
      if (!chapter || !candidate) throw new Error('找不到这个候选稿。')
      if (chapter.content.trim() && chapter.content !== candidate.content) {
        this.store.addChapterVersion(chapter, chapter.content, '采用候选前自动留档')
      }
      chapter.content = candidate.content
      chapter.summary = summarizeChapterText(candidate.content)
      chapter.candidates = chapter.candidates.filter((item) => item.id !== candidate.id)
      chapter.revision += 1
      chapter.status = 'done'
      chapter.locked = true
      chapter.updatedAt = nowMs()
      this.staleAfterManuscriptChange(project)
      project.stages.writing = {
        status: project.chapters.every((item) => item.content.trim()) && !project.chapters.some((item) => item.candidates.length) ? 'done' : 'review',
        updatedAt: nowMs(),
        message: `已采用 ${chapter.title} 的候选稿`,
        progress: Math.round((project.chapters.filter((item) => item.content.trim()).length / Math.max(1, project.chapters.length)) * 100)
      }
      this.store.save(project, `采用第 ${chapter.number} 章候选`, { snapshot: true })
      return project
    })
  }

  private discardCandidate(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const chapter = project.chapters.find((item) => item.id === str(request.chapterId))
      if (!chapter) throw new Error('找不到这一章。')
      chapter.candidates = chapter.candidates.filter((item) => item.id !== str(request.candidateId))
      this.store.save(project, '丢弃候选', { snapshot: false })
      return project
    })
  }

  private restoreChapterVersion(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const chapter = project.chapters.find((item) => item.id === str(request.chapterId))
      const version = chapter?.versions.find((item) => item.id === str(request.versionId))
      if (!chapter || !version) throw new Error('找不到这个历史版本。')
      this.store.addChapterVersion(chapter, chapter.content, '恢复历史版本前自动留档')
      chapter.content = version.content
      chapter.summary = summarizeChapterText(version.content)
      chapter.revision += 1
      chapter.status = 'done'
      chapter.updatedAt = nowMs()
      this.staleAfterManuscriptChange(project)
      this.store.save(project, `恢复第 ${chapter.number} 章历史版本`, { snapshot: true })
      return project
    })
  }

  private upsertCharacter(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const input = request.character && typeof request.character === 'object' ? (request.character as Record<string, unknown>) : request
      const id = str(input.id)
      const existing = id ? project.characters.find((item) => item.id === id) : undefined
      const character = existing ?? {
        id: studioId('char'),
        name: '',
        role: '',
        look: '',
        relationships: [],
        refAssetIds: []
      }
      if (typeof input.name === 'string') character.name = input.name.trim().slice(0, 80) || character.name || '未命名角色'
      if (typeof input.role === 'string') character.role = input.role.slice(0, 100)
      if (typeof input.age === 'string') character.age = input.age.slice(0, 40)
      if (typeof input.look === 'string') character.look = input.look.slice(0, 1000)
      if (typeof input.voiceId === 'string') character.voiceId = input.voiceId.slice(0, 200)
      if (typeof input.desire === 'string') character.desire = input.desire.slice(0, 500)
      if (typeof input.fear === 'string') character.fear = input.fear.slice(0, 500)
      if (typeof input.secret === 'string') character.secret = input.secret.slice(0, 500)
      if (typeof input.arc === 'string') character.arc = input.arc.slice(0, 800)
      if (Array.isArray(input.refAssetIds)) character.refAssetIds = arrayOfStrings(input.refAssetIds).filter((assetId) => project.assets.some((asset) => asset.id === assetId))
      if (Array.isArray(input.relationships)) {
        character.relationships = input.relationships
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
          .map((item) => ({ target: str(item.target).slice(0, 80), label: str(item.label).slice(0, 200) }))
          .filter((item) => item.target)
      }
      if (!existing) project.characters.push(character)
      if (id) project.shots = project.shots.map((shot) => (shot.speaker === existing?.name ? { ...shot, voiceId: character.voiceId ?? shot.voiceId } : shot))
      this.staleStages(project, ['visuals', 'review', 'delivery'], '人物设定有改动，相关分镜与检查需要重新核对')
      this.store.save(project, '更新人物设定', { snapshot: true })
      return project
    })
  }

  private deleteCharacter(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const id = str(request.characterId)
      const character = project.characters.find((item) => item.id === id)
      if (!character) throw new Error('找不到这个人物。')
      const referenced = project.shots.filter((shot) => shot.speaker === character.name || shot.referenceCharacterIds.includes(id))
      if (referenced.length && !bool(request.confirmed)) {
        throw new Error(`这个人物被 ${referenced.length} 个镜头引用。确认删除后，相关参考与台词关联会一并清理；请再点一次“确认删除”。`)
      }
      project.characters = project.characters.filter((item) => item.id !== id)
      project.shots = project.shots.map((shot) => ({
        ...shot,
        referenceCharacterIds: shot.referenceCharacterIds.filter((item) => item !== id)
      }))
      project.facts = project.facts.filter((fact) => fact.subject !== character.name)
      this.staleStages(project, ['visuals', 'voice', 'review', 'delivery'], '人物设定有改动，相关分镜、配音与检查需要重新核对')
      this.store.save(project, '删除人物设定', { snapshot: true })
      return project
    })
  }

  private upsertPlace(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const input = request.place && typeof request.place === 'object' ? (request.place as Record<string, unknown>) : request
      const id = str(input.id)
      const existing = id ? project.places.find((item) => item.id === id) : undefined
      const place = existing ?? { id: studioId('place'), name: '', description: '', refAssetIds: [] }
      if (typeof input.name === 'string') place.name = input.name.trim().slice(0, 100) || place.name || '未命名地点'
      if (typeof input.description === 'string') place.description = input.description.slice(0, 1000)
      if (Array.isArray(input.refAssetIds)) place.refAssetIds = arrayOfStrings(input.refAssetIds).filter((assetId) => project.assets.some((asset) => asset.id === assetId))
      if (!existing) project.places.push(place)
      this.staleStages(project, ['visuals', 'review', 'delivery'], '地点设定有改动，相关分镜与检查需要重新核对')
      this.store.save(project, '更新地点设定', { snapshot: true })
      return project
    })
  }

  private upsertFact(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const input = request.fact && typeof request.fact === 'object' ? (request.fact as Record<string, unknown>) : request
      const id = str(input.id)
      const existing = id ? project.facts.find((item) => item.id === id) : undefined
      const fact = existing ?? {
        id: studioId('fact'),
        subject: '',
        predicate: '',
        object: '',
        confidence: 0.8,
        source: 'manual' as const,
        createdAt: nowMs()
      }
      if (typeof input.subject === 'string') fact.subject = input.subject.trim().slice(0, 100)
      if (typeof input.predicate === 'string') fact.predicate = input.predicate.trim().slice(0, 120)
      if (typeof input.object === 'string') fact.object = input.object.trim().slice(0, 1000)
      if (typeof input.chapterId === 'string') fact.chapterId = input.chapterId
      if (typeof input.sceneId === 'string') fact.sceneId = input.sceneId
      if (typeof input.quote === 'string') fact.quote = input.quote.slice(0, 1000)
      if (Number.isFinite(Number(input.confidence))) fact.confidence = Math.max(0, Math.min(1, Number(input.confidence)))
      if (!fact.subject || !fact.predicate || !fact.object) throw new Error('事实需要主体、关系与内容。')
      if (!existing) project.facts.push(fact)
      this.staleStages(project, ['review', 'delivery'], '设定事实有改动，旧检查与交付物需要重新生成')
      this.store.save(project, '更新设定事实', { snapshot: false })
      return project
    })
  }

  private deleteFact(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const id = str(request.factId)
      if (!project.facts.some((fact) => fact.id === id)) throw new Error('找不到这条事实。')
      project.facts = project.facts.filter((fact) => fact.id !== id)
      this.staleStages(project, ['review', 'delivery'], '设定事实有改动，旧检查与交付物需要重新生成')
      this.store.save(project, '删除设定事实', { snapshot: false })
      return project
    })
  }

  private async generateStoryboard(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    if (project.kind !== 'drama') throw new Error('只有漫剧需要分镜。')
    if (!project.blueprint?.approved) throw new Error('请先确认蓝图。')
    const useModel = request.useModel !== false
    const runtime = studioTextRuntime(project.runtime.strategy)
    if (!useModel) throw new Error('分镜必须使用文本模型生成。请在创作台设置 → 模型里连接模型后再试。')
    if (!runtime.configured) throw new Error(`还没有可用的文本模型。${runtime.message} 请在创作台设置 → 模型里连接模型。`)
    const existing = [...project.shots].sort((left, right) => left.number - right.number)
    const locked = existing.some((shot) => shot.imageAssetId || shot.videoAssetId || shot.voiceAssetId)
    const instruction = str(request.instruction).slice(0, 2000)
    const estimated = estimateTextCostCny(project.blueprint.storyCore.length + 3000, 6000, project.runtime.strategy)
    const job = await this.launchJob(project, {
      kind: 'text',
      label: '生成分镜与台词',
      stage: 'storyboard',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`storyboard:${project.id}:${project.revision}:${locked}:${instruction}:model`)),
      estimatedCostCny: estimated,
      costNote: '按当前文本模型参考价估算',
      retry: { action: 'generate-storyboard', payload: { useModel, instruction } },
      run: async (snapshot, ctx) => {
        const current = snapshot.blueprint as StudioBlueprint
        ctx.progress('正在拆分场景与镜头', 15)
        const result = await completeCreativeText({
          system: `${STORYBOARD_SYSTEM}${masterPromptContext('drama', 'storyboard', `${current.storyCore} ${current.structure} ${current.units.map((unit) => unit.title).join(' ')} 分镜 运镜 台词 连续性`, 'storyboard', snapshot.runtime.strategy)}`,
          prompt: storyboardPrompt(snapshot, current, locked, instruction),
          structured: true,
          temperature: 0.8,
          signal: ctx.signal,
          strategy: snapshot.runtime.strategy
        })
        const parsed = extractJson<Record<string, unknown>>(result.text)
        if (!parsed || !Array.isArray(parsed.shots)) {
          log.warn('storyboard parse failed', { length: result.text.length, head: result.text.slice(0, 600), tail: result.text.slice(-300) })
          throw new Error('模型没有返回可解析的分镜。请重试，或换一个支持长 JSON 输出的模型。')
        }
        ctx.progress('整理镜头与场景', 82)
        const storyboard = normalizeModelStoryboard(parsed, snapshot, current, locked)
        return {
          message: `分镜已生成：${storyboard.scenes.length} 场 / ${storyboard.shots.length} 镜（${result.model}）。`,
          costCny: result.costCny,
          costNote: result.costNote ?? '按实际 token 记录',
          apply: (fresh) => {
            applyModelStoryboard(fresh, storyboard, result.model)
          }
        }
      }
    })
    return this.result(project, { job })
  }

  /** 只按已确认蓝图同步镜头字段；不调用模型，也不覆盖已有素材。 */
  private syncStoryboard(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      if (project.kind !== 'drama') throw new Error('只有漫剧需要分镜。')
      if (!project.blueprint?.approved) throw new Error('请先确认蓝图。')
      const before = project.shots.map((shot) => JSON.stringify([shot.title, shot.action, shot.camera, shot.shotSize, shot.durationSec, shot.dialogue, shot.speaker, shot.continuity]))
      if (!project.shots.length) {
        applyDramaOutline(project, project.blueprint)
      } else {
        updateDramaShots(project, project.blueprint)
      }
      const changed = project.shots.filter((shot, index) => before[index] !== JSON.stringify([shot.title, shot.action, shot.camera, shot.shotSize, shot.durationSec, shot.dialogue, shot.speaker, shot.continuity])).length
      const locked = project.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId || shot.voiceAssetId).length
      project.stages.storyboard = {
        ...project.stages.storyboard,
        status: 'ready',
        updatedAt: nowMs(),
        message: changed ? `${changed} 镜已按蓝图更新${locked ? `；${locked} 个已有素材的镜头保持原样` : ''}` : `没有可更新的镜头${locked ? `；${locked} 个已有素材的镜头保持原样` : ''}`,
        progress: 50
      }
      project.stage = 'storyboard'
      this.store.save(project, '按蓝图同步镜头', { snapshot: true })
      return project
    })
  }

  private saveScene(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const scene = project.scenes.find((item) => item.id === str(request.sceneId))
      if (!scene) throw new Error('找不到这个场景。')
      if (typeof request.title === 'string') scene.title = request.title.slice(0, 160)
      if (typeof request.synopsis === 'string') scene.synopsis = request.synopsis.slice(0, 2000)
      if (typeof request.location === 'string') scene.location = request.location.slice(0, 200)
      if (typeof request.timeOfDay === 'string') scene.timeOfDay = request.timeOfDay.slice(0, 80)
      if (typeof request.beat === 'string') scene.beat = request.beat.slice(0, 80)
      if (Array.isArray(request.characters)) scene.characters = arrayOfStrings(request.characters).slice(0, 20)
      scene.updatedAt = nowMs()
      const affected = project.shots.filter((shot) => shot.sceneId === scene.id)
      project.stages.storyboard = {
        status: affected.length ? 'review' : project.stages.storyboard.status,
        updatedAt: nowMs(),
        message: affected.length ? `场景已保存；${affected.length} 镜需要核对动作与画面` : '场景已保存',
        progress: affected.length ? 70 : project.stages.storyboard.progress
      }
      this.staleStages(project, ['visuals', 'timeline', 'review', 'delivery'], '场景设定有改动，相关分镜、时间线与检查需要重新核对')
      this.store.save(project, '保存场景', { snapshot: false })
      return project
    })
  }

  private saveShot(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const shot = project.shots.find((item) => item.id === str(request.shotId))
      if (!shot) throw new Error('找不到这个镜头。')
      const previousDialogue = shot.dialogue
      const previousDuration = shot.durationSec
      const fields = ['title', 'action', 'camera', 'shotSize', 'dialogue', 'speaker', 'prompt', 'negative', 'continuity', 'voiceId'] as const
      for (const field of fields) {
        if (typeof request[field] === 'string') {
          const value = (request[field] as string).slice(0, field === 'prompt' || field === 'action' || field === 'negative' ? 4000 : 500)
          shot[field] = value
        }
      }
      if (Number.isFinite(Number(request.durationSec))) shot.durationSec = Math.max(1, Math.min(60, Number(request.durationSec)))
      if (typeof request.lockedReference === 'boolean') shot.lockedReference = request.lockedReference
      if (Array.isArray(request.referenceCharacterIds)) shot.referenceCharacterIds = arrayOfStrings(request.referenceCharacterIds)
      if (Array.isArray(request.referencePlaceIds)) shot.referencePlaceIds = arrayOfStrings(request.referencePlaceIds)
      if (Array.isArray(request.referencePropIds)) shot.referencePropIds = arrayOfStrings(request.referencePropIds)
      shot.updatedAt = nowMs()
      const dialogueChanged = typeof request.dialogue === 'string' && shot.dialogue !== previousDialogue
      if (dialogueChanged && shot.voiceAssetId) {
        shot.voiceAssetId = null
        shot.status = 'stale'
      }
      this.staleAfterShotChange(project, dialogueChanged)
      const timelineClip = project.timeline.clips.find((clip) => clip.shotId === shot.id && clip.kind === 'subtitle')
      if (timelineClip) timelineClip.text = shot.dialogue
      if (shot.durationSec !== previousDuration) {
        for (const clip of project.timeline.clips.filter((item) => item.shotId === shot.id && item.kind === 'video')) {
          clip.duration = shot.durationSec
        }
        project.timeline.durationSec = Math.max(project.timeline.durationSec, ...project.timeline.clips.map((clip) => clip.start + clip.duration))
        project.timeline.version += 1
        project.timeline.updatedAt = nowMs()
      }
      this.store.save(project, `保存第 ${shot.number} 镜`, { snapshot: false })
      return project
    })
  }

  private mediaReady(model: 'image' | 'video' | 'audio'): Promise<{ ok: boolean; message: string; status: Awaited<ReturnType<ReturnType<typeof getMediaService>['status']>> }> {
    return getMediaService()
      .status()
      .then((status) => {
        const target = status.models.find((item) => item.id === model)
        if (!status.engine.online) return { ok: false, message: status.engine.message, status }
        if (!target?.ready) {
          return {
            ok: false,
            message: `${model === 'image' ? '图片' : model === 'video' ? '视频' : '配乐'}模型未就绪：${target?.missing?.slice(0, 3).join('、') || '请到设置 → 多媒体检查模型文件'}`,
            status
          }
        }
        return { ok: true, message: '', status }
      })
      .catch((err) => {
        throw new Error(`无法检查本地媒体引擎：${err instanceof Error ? err.message : String(err)}`)
      })
  }

  private moveShot(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const sorted = [...project.shots].sort((a, b) => a.number - b.number)
      const index = sorted.findIndex((shot) => shot.id === str(request.shotId))
      const neighbor = sorted[index + (num(request.offset, 1) >= 0 ? 1 : -1)]
      if (index < 0 || !neighbor) throw new Error('这个方向没有可移动的镜头。')
      const number = sorted[index].number
      sorted[index].number = neighbor.number
      neighbor.number = number
      project.shots = sorted.sort((a, b) => a.number - b.number)
      this.staleAfterShotChange(project, false)
      this.store.save(project, '调整镜头顺序', { snapshot: false })
      return project
    })
  }

  private updateShots(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const shotIds = Array.isArray(request.shotIds) ? arrayOfStrings(request.shotIds) : []
      const sceneId = str(request.sceneId)
      const targets = project.shots.filter((shot) => shotIds.length ? shotIds.includes(shot.id) : sceneId ? shot.sceneId === sceneId : true)
      if (!targets.length) throw new Error('没有可调整的镜头。')
      const patch: Partial<StudioShot> = {}
      if (request.durationSec !== undefined) patch.durationSec = Math.max(1, Math.min(120, num(request.durationSec, 8)))
      if (typeof request.shotSize === 'string' && request.shotSize.trim()) patch.shotSize = request.shotSize.trim().slice(0, 40)
      if (typeof request.camera === 'string' && request.camera.trim()) patch.camera = request.camera.trim().slice(0, 80)
      if (typeof request.lockedReference === 'boolean') patch.lockedReference = request.lockedReference
      if (!Object.keys(patch).length) throw new Error('没有要调整的字段。')
      project.shots = project.shots.map((shot) => targets.some((target) => target.id === shot.id) ? { ...shot, ...patch, updatedAt: nowMs() } : shot)
      this.staleAfterShotChange(project, false)
      this.store.save(project, `批量调整 ${targets.length} 镜`, { snapshot: true })
      return project
    })
  }

  private buildSubtitles(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const shotIds = Array.isArray(request.shotIds) ? arrayOfStrings(request.shotIds) : []
      const shots = [...project.shots]
        .filter((shot) => shot.dialogue.trim() && (shotIds.length ? shotIds.includes(shot.id) : true))
        .sort((a, b) => a.number - b.number)
      if (!shots.length) throw new Error('还没有可拆分的台词。')
      const targetIds = new Set(shots.map((shot) => shot.id))
      const kept = project.timeline.clips.filter((clip) => !(clip.kind === 'subtitle' && clip.shotId && targetIds.has(clip.shotId)))
      const added: StudioProject['timeline']['clips'] = []
      let cursor = 0
      for (const shot of shots) {
        const visual = project.timeline.clips.find((clip) => clip.kind === 'video' && clip.shotId === shot.id)
        const start = visual?.start ?? cursor
        const slot = visual?.duration ?? shot.durationSec
        const voice = shot.voiceAssetId ? project.assets.find((asset) => asset.id === shot.voiceAssetId) : undefined
        const available = Math.max(1.2, Math.min(slot, voice?.durationSec ?? slot))
        const sentences = shot.dialogue
          .split(/(?<=[。！？!?；;])/g)
          .map((sentence) => sentence.trim())
          .filter(Boolean)
        const totalWeight = sentences.reduce((sum, sentence) => sum + Math.max(1, sentence.replace(/\s+/g, '').length), 0)
        const weighted = sentences.map((sentence) => Math.max(0.1, available * (Math.max(1, sentence.replace(/\s+/g, '').length) / Math.max(1, totalWeight))))
        const weightedSum = weighted.reduce((sum, value) => sum + value, 0)
        const durations = weighted.map((value) => (value / weightedSum) * available)
        let offset = 0
        for (const [index, sentence] of sentences.entries()) {
          const duration = index === sentences.length - 1
            ? Math.max(0.1, available - offset)
            : Math.max(0.1, durations[index] ?? available / sentences.length)
          added.push({
            id: studioId('clip'),
            trackId: 'track-subtitle',
            kind: 'subtitle',
            label: `镜 ${shot.number} · 句 ${index + 1}`,
            shotId: shot.id,
            start: Math.round((start + offset) * 100) / 100,
            duration: Math.round(duration * 100) / 100,
            srcIn: 0,
            speed: 1,
            volume: 1,
            transition: 'cut',
            text: sentence,
            style: { yPercent: 86, size: 34, color: '#ede7da', background: true }
          })
          offset += duration
        }
        cursor = Math.max(cursor, start + slot)
      }
      project.timeline = {
        ...project.timeline,
        clips: [...kept, ...added].sort((a, b) => a.start - b.start),
        version: project.timeline.version + 1,
        updatedAt: nowMs(),
        durationSec: timelineDuration({ ...project.timeline, clips: [...kept, ...added] })
      }
      project.stages.timeline = { status: 'ready', updatedAt: nowMs(), message: `${added.length} 条逐句字幕已按字数估算排入`, progress: 70 }
      this.staleStages(project, ['review', 'delivery'], '字幕已重排，旧检查与交付物需要重新生成')
      this.store.save(project, '按台词拆分字幕（字数估算）', { snapshot: true })
      return project
    })
  }

  private async generateShotImage(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const shotIds = Array.isArray(request.shotIds)
      ? arrayOfStrings(request.shotIds)
      : [str(request.shotId)]
    const targets = project.shots.filter((shot) => shotIds.includes(shot.id))
    if (!targets.length) throw new Error('找不到要生成画面的镜头。')
    const readiness = await this.mediaReady('image')
    if (!readiness.ok) throw new Error(`${readiness.message}。可以在“画面”里先导入现成图片。`)
    const instruction = str(request.instruction).slice(0, 1200)
    const job = await this.launchJob(project, {
      kind: 'image',
      label: targets.length > 1 ? `批量生成 ${targets.length} 镜画面` : `生成第 ${targets[0].number} 镜画面`,
      stage: 'visuals',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`image:${instruction}:${targets.map((shot) => `${shot.id}:${shot.prompt}:${shot.continuity}:${shot.lockedReference}`).join('|')}`)),
      estimatedCostCny: 0,
      costNote: '本机 ComfyUI 引擎，不计边际费用',
      retry: { action: 'generate-shot-image', payload: { shotIds: targets.map((shot) => shot.id), instruction: str(request.instruction) } },
      run: async (snapshot, ctx) => {
        const generated: Array<{ shotId: string; asset: StudioAsset }> = []
        const errors: string[] = []
        for (const [index, shot] of snapshot.shots.filter((item) => targets.some((target) => target.id === item.id)).entries()) {
          if (ctx.signal.aborted) break
          ctx.progress(`第 ${index + 1}/${targets.length} 镜 · 生成画面`, 3 + Math.round((index / targets.length) * 86))
          try {
            const asset = await this.generateImageForShot(snapshot, shot, ctx, (stage, percent) => {
              const local = typeof percent === 'number' ? percent / 100 : 0
              ctx.progress(`第 ${shot.number} 镜 · ${stage}`, 3 + Math.round(((index + local) / targets.length) * 86))
            }, instruction)
            generated.push({ shotId: shot.id, asset })
            ctx.progress(`第 ${shot.number} 镜已完成`, 3 + Math.round(((index + 1) / targets.length) * 86))
          } catch (err) {
            if (ctx.signal.aborted) break
            errors.push(`第 ${shot.number} 镜：${friendlyMediaError(err)}`)
          }
        }
        if (!generated.length) throw new Error(errors[0] ?? '没有生成任何画面。')
        return {
          message: `已生成 ${generated.length}/${targets.length} 镜画面${errors.length ? `；${errors.length} 镜失败：${errors.slice(0, 3).join('；')}` : ''}`,
          costCny: 0,
          costNote: '本机 ComfyUI 引擎，不计边际费用',
          outputs: generated.map((item) => ({ label: item.asset.title, assetId: item.asset.id })),
          apply: (fresh) => {
            for (const item of generated) {
              if (!fresh.assets.some((asset) => asset.id === item.asset.id)) fresh.assets.push(item.asset)
              const shot = fresh.shots.find((candidate) => candidate.id === item.shotId)
              if (!shot) continue
              if (!shot.imageAssetId) shot.imageAssetId = item.asset.id
              if (!shot.imageCandidates.some((candidate) => candidate.assetId === item.asset.id)) {
                shot.imageCandidates.unshift({
                  id: studioId('cand'),
                  assetId: item.asset.id,
                  label: `画面候选 ${shot.imageCandidates.length + 1}`,
                  source: 'model',
                  model: 'ComfyUI · Qwen-Image',
                  createdAt: nowMs(),
                  adopted: shot.imageAssetId === item.asset.id
                })
              }
              shot.status = shot.imageAssetId ? 'done' : 'ready'
              shot.updatedAt = nowMs()
            }
            if (!fresh.coverAssetId) fresh.coverAssetId = generated[0].asset.id
            finishVisualStage(fresh)
            this.staleAfterMediaChange(fresh, '有新画面，需要重新装配时间线')
            if (errors.length) {
              fresh.checks.push({
                id: studioId('check'),
                kind: 'missing',
                level: 'warn',
                title: `${errors.length} 镜画面生成失败`,
                detail: errors.join('\n'),
                createdAt: nowMs()
              })
            }
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private async generateImageForShot(
    project: StudioProject,
    shot: StudioShot,
    ctx: JobRunContext,
    onProgress: (stage: string, percent?: number) => void,
    instruction = ''
  ): Promise<StudioAsset> {
    const character = project.characters.find((item) => shot.speaker && item.name === shot.speaker)
      ?? project.characters.find((item) => shot.referenceCharacterIds.includes(item.id))
    const place = project.places.find((item) => shot.referencePlaceIds.includes(item.id))
    const referenceAssetId = character?.refAssetIds[0]
      ?? (shot.lockedReference ? shot.imageAssetId ?? project.assets.find((asset) => asset.kind === 'image')?.id : undefined)
    const referenceAsset = referenceAssetId ? project.assets.find((asset) => asset.id === referenceAssetId) : undefined
    const referencePath = referenceAsset ? this.store.assetAbsolute(project, referenceAsset) : undefined
    const prompt = [
      `主体动作：${shot.prompt || shot.action}`,
      character ? `角色外观：${character.name}，${character.look}；保持面部、发型与服装一致。` : '',
      place ? `环境：${place.name}，${place.description}。` : '',
      `镜头：${shot.shotSize || '中景'}，${shot.camera || '固定镜头'}；构图清晰，主体位于三分法交点或中心。`,
      project.styleBible.look ? `风格与光线：${project.styleBible.look}；光位明确，层次清楚。` : '',
      shot.continuity ? `连续性：${shot.continuity}。` : '',
      instruction ? `这次修改要求：${instruction}。` : '',
      shot.negative ? `避免：${shot.negative}。` : '避免：文字、水印、分镜边框、多余人物、换脸、服装变化。'
    ]
      .filter(Boolean)
      .join(' ')
    const media = getMediaService()
    const workspace = this.store.projectDir(project.id)
    const result = await media.generateImage({
      workspace,
      prompt,
      ...(referencePath && existsSync(referencePath) ? { referencePath } : {}),
      width: project.brief.aspect === '9:16' ? 768 : project.brief.aspect === '1:1' ? 1024 : 1344,
      height: project.brief.aspect === '9:16' ? 1344 : 1024,
      signal: ctx.signal,
      onProgress: (update) => onProgress(update.stage, update.percent),
      ...(ctx.attachRemote ? { onPromptId: (promptId: string) => ctx.attachRemote?.(promptId, { kind: 'image', shotId: shot.id }) } : {})
    })
    const bytes = readFileSync(result.path)
    const thumb = makeThumbnail(result.path, project.id)
    const asset = await this.store.addAsset(project, {
      bytes,
      title: `第 ${shot.number} 镜 · ${shot.title}`,
      mime: 'image/png',
      kindHint: 'image',
      tags: ['image', `shot:${shot.id}`, 'storyboard'],
      origin: { model: result.model, jobId: ctx.jobId, source: 'comfyui', promptHash: createHash('sha256').update(prompt).digest('hex').slice(0, 16) },
      metadata: { width: result.width, height: result.height },
      ...(thumb ? { thumbBytes: thumb } : {})
    })
    try {
      if (result.path.startsWith(workspace)) rmSync(result.path, { force: true })
    } catch {
    }
    return asset
  }

  private async batchShotImages(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    return this.generateShotImage(request)
  }

  private async generateShotVideo(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const shot = project.shots.find((item) => item.id === str(request.shotId))
    if (!shot) throw new Error('找不到这个镜头。')
    if (!shot.imageAssetId) throw new Error('先生成或导入这一镜的画面，再升级为视频。')
    const image = project.assets.find((asset) => asset.id === shot.imageAssetId)
    if (!image) throw new Error('这一镜的画面素材丢失了。')
    const readiness = await this.mediaReady('video')
    if (!readiness.ok) throw new Error(`${readiness.message}。草稿模式不需要视频，可以先用分镜图合成。`)
    const instruction = str(request.instruction).slice(0, 1200)
    const job = await this.launchJob(project, {
      kind: 'video',
      label: `升级第 ${shot.number} 镜为视频`,
      stage: 'visuals',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`video:${instruction}:${shot.id}:${image.sha256}:${shot.prompt}:${shot.continuity}`)),
      estimatedCostCny: 0,
      costNote: '本机 ComfyUI 引擎，不计边际费用',
      retry: { action: 'generate-shot-video', payload: { shotId: shot.id, instruction } },
      run: async (snapshot, ctx) => {
        const currentShot = snapshot.shots.find((item) => item.id === shot.id)
        const currentImage = snapshot.assets.find((asset) => asset.id === currentShot?.imageAssetId)
        if (!currentShot || !currentImage) throw new Error('镜头或画面素材在排队期间被修改，请重试。')
        const prompt = [
          `首帧与参考图一致；主体动作：${currentShot.action}`,
          `镜头：${currentShot.camera}；单一连续运动，不切镜。`,
          `环境运动：${currentShot.continuity || '保持人物外观、光线与道具位置一致'}。`,
          instruction ? `这次修改要求：${instruction}。` : '',
          snapshot.styleBible.look ? `风格与光线：${snapshot.styleBible.look}。` : '',
          '保持人物面部与服装一致，不要文字、水印、换脸或多余人物。'
        ].filter(Boolean).join(' ')
        ctx.progress('上传首帧', 6)
        const result = await getMediaService().generateVideo({
          workspace: this.store.projectDir(snapshot.id),
          prompt,
          referencePaths: [this.store.assetAbsolute(snapshot, currentImage)],
          mode: 'first-only',
          width: snapshot.brief.aspect === '9:16' ? 544 : 960,
          height: snapshot.brief.aspect === '9:16' ? 960 : 544,
          seconds: Math.max(5, Math.min(15, Math.round(currentShot.durationSec))),
          signal: ctx.signal,
          onProgress: (update) => ctx.progress(update.stage, update.percent),
          ...(ctx.attachRemote ? { onPromptId: (promptId: string) => ctx.attachRemote?.(promptId, { kind: 'video', shotId: currentShot.id }) } : {})
        })
        ctx.progress('入库视频', 94)
        const bytes = readFileSync(result.path)
        const thumb = makeThumbnail(result.path, snapshot.id)
        const asset = await this.store.addAsset(snapshot, {
          bytes,
          title: `第 ${currentShot.number} 镜 · 视频`,
          mime: 'video/mp4',
          kindHint: 'video',
          tags: ['video', `shot:${currentShot.id}`, 'upgraded'],
          origin: { model: result.model, jobId: ctx.jobId, source: 'comfyui' },
          metadata: { width: result.width, height: result.height, durationSec: result.durationSec },
          ...(thumb ? { thumbBytes: thumb } : {})
        })
        try {
          if (result.path.startsWith(this.store.projectDir(snapshot.id))) rmSync(result.path, { force: true })
        } catch {
        }
        return {
          message: `第 ${currentShot.number} 镜已升级为视频（${Math.round(result.durationSec ?? currentShot.durationSec)} 秒）。记得重新装配时间线。`,
          costCny: 0,
          costNote: '本机 ComfyUI 引擎，不计边际费用',
          outputs: [{ label: asset.title, assetId: asset.id }],
          apply: (fresh) => {
            if (!fresh.assets.some((item) => item.id === asset.id)) fresh.assets.push(asset)
            const target = fresh.shots.find((item) => item.id === currentShot.id)
            if (!target) return
            target.videoAssetId = asset.id
            target.videoCandidates.unshift({
              id: studioId('cand'),
              assetId: asset.id,
              label: '视频候选 1',
              source: 'model',
              model: result.model,
              createdAt: nowMs(),
              adopted: true
            })
            target.updatedAt = nowMs()
            finishVisualStage(fresh)
            this.staleAfterMediaChange(fresh, '有视频更新，需要重新装配时间线')
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private adoptShotAsset(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const shot = project.shots.find((item) => item.id === str(request.shotId))
      if (!shot) throw new Error('找不到这个镜头。')
      const candidateId = str(request.candidateId)
      const image = shot.imageCandidates.find((item) => item.id === candidateId)
      const video = shot.videoCandidates.find((item) => item.id === candidateId)
      if (!image && !video) throw new Error('找不到这个候选。')
      if (image) {
        shot.imageAssetId = image.assetId
        shot.imageCandidates = shot.imageCandidates.map((item) => ({ ...item, adopted: item.id === image.id }))
      }
      if (video) {
        shot.videoAssetId = video.assetId
        shot.videoCandidates = shot.videoCandidates.map((item) => ({ ...item, adopted: item.id === video.id }))
      }
      shot.status = shot.imageAssetId || shot.videoAssetId ? 'done' : shot.status
      shot.updatedAt = nowMs()
      finishVisualStage(project)
      this.staleAfterMediaChange(project, '换用了新镜头素材，需要重新装配时间线')
      this.store.save(project, '采用镜头候选', { snapshot: true })
      return project
    })
  }

  private async importAsset(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const path = str(request.path)
    if (!path || !existsSync(path) || !statSync(path).isFile()) throw new Error('导入文件不存在。')
    const size = statSync(path).size
    if (size <= 0 || size > 512 * 1024 * 1024) throw new Error('文件为空或超过 512MB。')
    const ext = extname(path).slice(1).toLowerCase()
    const kind: StudioAsset['kind'] = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)
      ? 'image'
      : ['mp4', 'webm', 'mov', 'mkv'].includes(ext)
        ? 'video'
        : ['wav', 'mp3', 'm4a', 'flac', 'ogg'].includes(ext)
          ? 'audio'
          : 'other'
    if (kind === 'other') throw new Error('只支持导入图片、视频或音频。')
    const project = this.store.readProject(projectId)
    const shotId = str(request.shotId)
    const shot = shotId ? project.shots.find((item) => item.id === shotId) : undefined
    if (shotId && !shot) throw new Error('找不到这个镜头。')
    const thumb = kind === 'image' || kind === 'video' ? makeThumbnail(path, project.id) : null
    const asset = await this.store.addAsset(project, {
      filePath: path,
      title: basename(path),
      kindHint: kind,
      tags: [kind, 'import', ...(shot ? [`shot:${shot.id}`] : [])],
      origin: { source: 'import' },
      ...(thumb ? { thumbBytes: thumb } : {})
    })
    if (shot) {
      if (kind === 'image') {
        if (!shot.imageAssetId) shot.imageAssetId = asset.id
        shot.imageCandidates.unshift({ id: studioId('cand'), assetId: asset.id, label: '导入画面', source: 'import', createdAt: nowMs(), adopted: shot.imageAssetId === asset.id })
      } else if (kind === 'video') {
        shot.videoAssetId = asset.id
        shot.videoCandidates.unshift({ id: studioId('cand'), assetId: asset.id, label: '导入视频', source: 'import', createdAt: nowMs(), adopted: true })
      } else if (kind === 'audio') {
        shot.voiceAssetId = asset.id
      }
      shot.status = 'done'
      shot.updatedAt = nowMs()
      finishVisualStage(project)
      this.staleAfterMediaChange(project, '有新素材导入，需要重新装配时间线')
    } else if (kind === 'image' && !project.coverAssetId) {
      project.coverAssetId = asset.id
    }
    this.store.save(project, '导入素材', { snapshot: false })
    this.emitProject(project)
    return this.result(project)
  }

  private async generateVoice(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const tts = project.runtime.tts ?? { mode: 'system' as const, model: 'tts-1', voice: '' }
    const cloudMode = tts.mode === 'cloud'
    const cloudRoute = cloudMode ? studioTextRuntime('cloud-first') : null
    if (cloudMode) {
      if (!cloudRoute?.configured || !cloudRoute.config || !cloudRoute.apiKey || isLocalServiceUrl(cloudRoute.config.baseUrl, { allowPrivate: true })) {
        throw new Error('云端配音需要先在 Agent 设置里配置云端模型服务商与 API Key。')
      }
    }
    const voiceList = cloudMode ? { voices: [], error: undefined } : listSystemVoices()
    if (!cloudMode && voiceList.error && !voiceList.voices.length) throw new Error(voiceList.error)
    const localReady = !cloudMode && localTtsStatus().modelReady
    const instruction = str(request.instruction).trim().slice(0, 800)
    const preferred =
      str(request.voiceId) ||
      tts.voice ||
      project.characters.find((character) => character.voiceId)?.voiceId ||
      (localReady ? QWEN_DEFAULT_VOICE : '') ||
      voiceList.voices.find((voice) => voice.culture.startsWith('zh'))?.name ||
      voiceList.voices[0]?.name ||
      ''
    const requestedIds = Array.isArray(request.shotIds) ? arrayOfStrings(request.shotIds) : [str(request.shotId)]
    const targets = project.shots.filter((shot) => (requestedIds.filter(Boolean).length ? requestedIds.includes(shot.id) : Boolean(shot.dialogue.trim()) && !shot.voiceAssetId))
    if (!targets.length) throw new Error('没有需要配音的台词。')
    const voiceNote = cloudMode
      ? `云端配音 · ${tts.model || 'tts-1'}`
      : 'Windows 系统声线，本机生成'
    const job = await this.launchJob(project, {
      kind: 'voice',
      label: targets.length > 1 ? `生成 ${targets.length} 段配音` : `第 ${targets[0].number} 镜配音`,
      stage: 'voice',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`voice:${tts.mode}:${tts.model}:${preferred}:${instruction}:${targets.map((shot) => `${shot.id}:${shot.dialogue}`).join('|')}`)),
      ...(cloudMode ? {} : { estimatedCostCny: 0 }),
      costNote: voiceNote,
      retry: { action: 'generate-voice', payload: { shotIds: targets.map((shot) => shot.id), voiceId: preferred, ...(instruction ? { instruction } : {}) } },
      run: async (snapshot, ctx) => {
        const generated: Array<{ shotId: string; asset: StudioAsset }> = []
        const errors: string[] = []
        for (const [index, shot] of targets.entries()) {
          if (ctx.signal.aborted) break
          ctx.progress(`第 ${index + 1}/${targets.length} 段 · 配音`, 4 + Math.round((index / targets.length) * 86))
          const workDir = join(this.store.tempDir(snapshot.id), `tts-${shot.id}`)
          const character = snapshot.characters.find((item) => item.name === shot.speaker)
          const storedVoice = character?.voiceId || shot.voiceId || ''
          const requestedLocal = isLocalTtsVoice(str(request.voiceId)) ? str(request.voiceId) : isLocalTtsVoice(tts.voice) ? tts.voice : ''
          const voice = cloudMode
            ? (storedVoice || preferred)
            : requestedLocal
              ? requestedLocal
              : isLocalTtsVoice(storedVoice)
                ? storedVoice
                : localReady
                  ? QWEN_DEFAULT_VOICE
                  : (storedVoice || preferred)
          const useLocalVoice = !cloudMode && isLocalTtsVoice(voice)
          const extension = cloudMode ? 'mp3' : 'wav'
          const output = join(workDir, `voice-${Date.now().toString(36)}.${extension}`)
          if (useLocalVoice) ctx.progress(`第 ${index + 1}/${targets.length} 段 · 本地 AI 声线合成`, 4 + Math.round((index / targets.length) * 86))
          try {
            if (cloudMode && cloudRoute?.config) {
              await synthesizeCloudSpeech({
                text: shot.dialogue,
                baseUrl: cloudRoute.config.baseUrl,
                apiKey: cloudRoute.apiKey ?? '',
                model: tts.model || 'tts-1',
                voice: voice || tts.voice || 'alloy',
                outputPath: output,
                workDir,
                signal: ctx.signal
              })
            } else if (useLocalVoice) {
              try {
                await synthesizeLocalSpeech({
                  text: shot.dialogue,
                  voice,
                  instruct: [instruction, localVoiceInstruction(shot)].filter(Boolean).join('；'),
                  outputPath: output
                })
              } catch (localError) {
                errors.push(`第 ${shot.number} 镜本地声线失败，已回退系统声线：${localError instanceof Error ? localError.message : String(localError)}`)
                await synthesizeSpeech({
                  text: shot.dialogue,
                  voice: '',
                  rate: shot.speaker.includes('外婆') ? -2 : 0,
                  outputPath: output,
                  workDir
                })
              }
            } else {
              await synthesizeSpeech({
                text: shot.dialogue,
                voice,
                rate: shot.speaker.includes('外婆') ? -2 : 0,
                outputPath: output,
                workDir
              })
            }
            const duration = probeDuration(output)
            const bytes = readFileSync(output)
            const asset = await this.store.addAsset(snapshot, {
              bytes,
              title: `第 ${shot.number} 镜 · 配音（${shot.speaker || '旁白'}）`,
              mime: cloudMode ? 'audio/mpeg' : 'audio/wav',
              kindHint: 'audio',
              tags: ['voice', `shot:${shot.id}`],
              origin: cloudMode
                ? { model: `Cloud TTS · ${tts.model || 'tts-1'}`, source: 'cloud-tts' }
                : useLocalVoice
                  ? { model: `Qwen3-TTS · ${voice.replace(/^qwen:/, '')}`, source: 'local-tts' }
                  : { model: `Windows SAPI · ${voice}`, source: 'sapi' },
              ...(duration ? { metadata: { durationSec: duration } } : {})
            })
            generated.push({ shotId: shot.id, asset })
            try {
              rmSync(workDir, { recursive: true, force: true })
            } catch {
            }
          } catch (err) {
            errors.push(`第 ${shot.number} 镜：${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (!generated.length) throw new Error(errors[0] ?? '没有生成任何配音。')
        return {
          message: `已生成 ${generated.length}/${targets.length} 段配音${errors.length ? `；${errors.length} 段失败` : ''}`,
          costCny: cloudMode ? null : 0,
          costNote: cloudMode ? '云端配音按服务商账单计费，单价未知' : 'Windows 系统声线，本机生成',
          outputs: generated.map((item) => ({ label: '配音', assetId: item.asset.id })),
          apply: (fresh) => {
            for (const item of generated) {
              if (!fresh.assets.some((asset) => asset.id === item.asset.id)) fresh.assets.push(item.asset)
              const shot = fresh.shots.find((candidate) => candidate.id === item.shotId)
              if (shot) {
                shot.voiceAssetId = item.asset.id
                shot.updatedAt = nowMs()
              }
            }
            finishVoiceStage(fresh)
            this.staleAfterMediaChange(fresh, '有配音更新，需要重新装配时间线')
            if (errors.length) {
              fresh.checks.push({ id: studioId('check'), kind: 'audio', level: 'warn', title: `${errors.length} 段配音失败`, detail: errors.join('\n'), createdAt: nowMs() })
            }
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private async generateMusic(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const kind = str(request.kind) || 'music'
    const isSfx = ['rain', 'umbrella', 'heartbeat', 'street'].includes(kind)
    const engine = isSfx ? 'local' : str(request.engine) === 'local' ? 'local' : 'model'
    const mood = musicMood(str(request.mood) || project.brief.tone)
    const seconds = Math.max(5, Math.min(300, num(request.seconds, isSfx ? 6 : Math.max(20, Math.round(project.timeline.durationSec || project.brief.targetSeconds || 54)))))
    if (engine === 'model' && !isSfx) {
      const readiness = await this.mediaReady('audio')
      if (!readiness.ok) {
        throw new Error(`${readiness.message}。也可以明确选择“本地器乐草稿”，但草稿只是临时试听，不计入正式配乐。`)
      }
    }
    const label = isSfx
      ? `生成音效 · ${kind}`
      : engine === 'local'
        ? `本地配乐草稿 · ${mood.label}`
        : `生成配乐 · ${mood.label}（ACE-Step）`
    const job = await this.launchJob(project, {
      kind: isSfx ? 'sfx' : 'music',
      label,
      stage: 'music',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`music:${project.id}:${kind}:${engine}:${mood.id}:${seconds}`)),
      estimatedCostCny: 0,
      costNote: engine === 'model' && !isSfx ? '本机 ComfyUI 配乐模型，不计边际费用' : '本地器乐/音效，不计模型费用',
      retry: { action: 'generate-music', payload: { kind, mood: mood.id, seconds, engine } },
      run: async (snapshot, ctx) => {
        const workDir = join(this.store.tempDir(snapshot.id), `audio-${Date.now().toString(36)}`)
        mkdirSync(workDir, { recursive: true })
        let asset: StudioAsset
        if (isSfx) {
          const output = join(workDir, `sfx-${kind}.wav`)
          ctx.progress('设计音效', 30)
          synthesizeSfx(kind as 'rain' | 'umbrella' | 'heartbeat' | 'street', output, seconds)
          ctx.progress('入库音效', 88)
          asset = await this.store.addAsset(snapshot, {
            filePath: output,
            title: `音效 · ${kind}`,
            mime: 'audio/wav',
            kindHint: 'audio',
            tags: ['sfx', kind],
            origin: { model: 'Morrow 本地音效', source: 'local' },
            metadata: { durationSec: seconds }
          })
        } else if (engine === 'local') {
          const output = join(workDir, `music-${mood.id}.wav`)
          ctx.progress('编配本地草稿', 30)
          synthesizeMusic({ mood: mood.id, seconds, outputPath: output, title: snapshot.title, seed: snapshot.revision })
          ctx.progress('入库草稿', 88)
          asset = await this.store.addAsset(snapshot, {
            filePath: output,
            title: `配乐草稿 · ${mood.label}`,
            mime: 'audio/wav',
            kindHint: 'audio',
            tags: ['music', 'draft', mood.id],
            origin: { model: 'Morrow 本地器乐（草稿）', source: 'local' },
            metadata: { durationSec: seconds }
          })
        } else {
          ctx.progress('正在生成配乐', 8)
          const result = await getMediaService().generateMusic({
            workspace: this.store.projectDir(snapshot.id),
            prompt: musicModelPrompt(snapshot, mood),
            seconds,
            bpm: mood.tempo,
            signal: ctx.signal,
            onProgress: (update) => ctx.progress(update.stage, typeof update.percent === 'number' ? Math.max(8, Math.min(92, update.percent)) : undefined)
          })
          ctx.progress('入库配乐', 94)
          const bytes = readFileSync(result.path)
          asset = await this.store.addAsset(snapshot, {
            bytes,
            title: `配乐 · ${mood.label}`,
            mime: 'audio/mpeg',
            kindHint: 'audio',
            tags: ['music', 'model', mood.id],
            origin: { model: result.model, jobId: ctx.jobId, source: 'comfyui' },
            metadata: { durationSec: result.durationSec ?? seconds }
          })
          try {
            if (result.path.startsWith(this.store.projectDir(snapshot.id))) rmSync(result.path, { force: true })
          } catch {
          }
        }
        try {
          rmSync(workDir, { recursive: true, force: true })
        } catch {
        }
        const isFormal = !isSfx && engine === 'model'
        return {
          message: isSfx ? `音效已生成：${asset.title} · ${seconds} 秒` : isFormal ? `配乐已生成：${asset.title} · ${seconds} 秒` : `本地器乐草稿已生成：${asset.title} · ${seconds} 秒；安装 ACE-Step 后可生成正式配乐。`,
          costCny: 0,
          costNote: isFormal ? '本机 ComfyUI 配乐模型，不计边际费用' : '本地器乐/音效，不计模型费用',
          outputs: [{ label: asset.title, assetId: asset.id }],
          apply: (fresh) => {
            if (!fresh.assets.some((item) => item.id === asset.id)) fresh.assets.push(asset)
            const formal = fresh.assets.some((item) => isFormalMusicAsset(item))
            if (isFormal) {
              fresh.musicAssetId = asset.id
              fresh.stages.music = { status: 'done', updatedAt: nowMs(), message: '配乐已就位', progress: 100 }
            } else if (isSfx) {
              fresh.stages.music = fresh.stages.music.status === 'done'
                ? fresh.stages.music
                : { status: 'ready', updatedAt: nowMs(), message: formal ? '配乐已就位' : '已有音效，还没有正式配乐', progress: formal ? 100 : 50 }
            } else {
              fresh.stages.music = { status: 'ready', updatedAt: nowMs(), message: '已有本地器乐草稿；安装配乐模型后可生成正式配乐', progress: 50 }
            }
            this.staleAfterMediaChange(fresh, '有音乐或音效更新，需要重新装配时间线')
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private buildTimeline(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      if (project.kind !== 'drama') throw new Error('只有漫剧使用时间线。')
      if (!project.shots.length) throw new Error('还没有镜头。')
      if (!project.shots.some((shot) => shot.imageAssetId || shot.videoAssetId)) throw new Error('还没有任何画面，先补齐分镜图或导入视频。')
      if (project.timeline.clips.length && request.force !== true && project.stages.timeline.status !== 'stale') {
        throw new Error('时间线已有片段。自动排好会按镜头重建，覆盖裁剪、音量与转场；确认后请用 force=true 再执行。')
      }
      project.timeline = buildTimelineFromProject(project)
      project.stage = 'timeline'
      project.stages.timeline = { status: 'done', updatedAt: nowMs(), message: '时间线已按最新素材装配', progress: 100 }
      project.stages.review = { status: 'ready', updatedAt: nowMs(), message: '可以检查' }
      this.store.save(project, '装配时间线', { snapshot: true })
      return project
    })
  }

  private saveTimeline(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const raw = (request.timeline && typeof request.timeline === 'object' ? request.timeline : request) as Record<string, unknown>
      project.timeline = sanitizeTimeline(project, raw)
      project.timeline.durationSec = timelineDuration(project.timeline)
      project.stage = 'timeline'
      project.stages.timeline = { status: 'ready', updatedAt: nowMs(), message: '时间线已保存，等待重合成', progress: 100 }
      if (project.deliveries.some((delivery) => isStudioVideoDelivery(delivery.kind))) {
        project.stages.delivery = { ...project.stages.delivery, status: 'stale', updatedAt: nowMs(), message: '时间线有改动，旧成片未更新' }
      }
      this.staleStages(project, ['review'], '时间线有改动，旧检查需要重新生成')
      this.store.save(project, '保存时间线', { snapshot: false })
      return project
    })
  }

  private async render(input: StudioRenderInput): Promise<StudioActionResult> {
    const projectId = safeProjectId(input.projectId)
    const project = this.store.readProject(projectId)
    if (project.kind !== 'drama') throw new Error('只有漫剧需要合成视频。')
    const requestId = str((input as unknown as Record<string, unknown>).requestId) || undefined
    const quality = input.quality === 'final' ? 'final' : 'draft'
    const subtitleMode = input.subtitleMode === 'soft' ? 'soft' : 'burn'
    const format = input.format === 'mov' || input.format === 'mkv' || input.format === 'webm' ? input.format : 'mp4'
    const resolution = input.resolution === '2160p' ? '2160p' : '1080p'
    if (!project.timeline.clips.length) throw new Error('时间线还没有装配；先排好时间线，再合成。')
    if (project.stages.timeline.status === 'stale') throw new Error('有新素材还没进时间线；先重新装配时间线，再合成。')
    const missingVisualClips = project.shots.filter((shot) => (shot.imageAssetId || shot.videoAssetId) && !project.timeline.clips.some((clip) => clip.kind === 'video' && clip.shotId === shot.id))
    const missingVoiceClips = project.shots.filter((shot) => shot.voiceAssetId && !project.timeline.clips.some((clip) => clip.kind === 'dialogue' && clip.shotId === shot.id))
    if (missingVisualClips.length || missingVoiceClips.length) {
      throw new Error(`时间线和素材不一致：${missingVisualClips.length ? `${missingVisualClips.length} 镜有画面但没有片段` : ''}${missingVisualClips.length && missingVoiceClips.length ? '；' : ''}${missingVoiceClips.length ? `${missingVoiceClips.length} 镜有配音但没有对白片段` : ''}。请重新装配时间线。`)
    }
    const missingVoiceLines = project.shots.filter((shot) => shot.dialogue.trim() && !shot.voiceAssetId)
    if (quality === 'final' && missingVoiceLines.length) {
      throw new Error(`还有 ${missingVoiceLines.length} 段台词没有配音；补齐配音后再导出成片，或先合成草稿。`)
    }
    const job = await this.launchJob(project, {
      kind: 'render',
      label: quality === 'draft' ? `合成动态分镜草稿 · ${format.toUpperCase()}` : `合成成片 · ${resolution === '2160p' ? '4K' : '1080p'} ${format.toUpperCase()}`,
      stage: 'delivery',
      ...(requestId ? { requestId } : {}),
      inputHash: sha256Buffer(Buffer.from(`render:${project.id}:${project.timeline.version}:${quality}:${subtitleMode}:${format}:${resolution}`)),
      estimatedCostCny: 0,
      costNote: 'FFmpeg 本机计算，不计模型费用',
      retry: { action: 'render', payload: { quality, aspect: input.aspect, subtitleMode, format, resolution } },
      run: async (snapshot, ctx) => {
        ctx.progress('检查素材', 2)
        let result: Awaited<ReturnType<typeof renderProject>>
        try {
          result = await renderProject(snapshot, {
            quality,
            subtitleMode,
            format,
            resolution,
            ...(input.aspect ? { aspect: input.aspect } : {}),
            allowMissing: input.allowMissing === true,
            signal: ctx.signal,
            onProgress: (stage, percent) => ctx.progress(stage, percent)
          })
        } catch (err) {
          throw new Error(friendlyMediaError(err))
        }
        const relative = result.path.slice(this.store.projectDir(snapshot.id).length + 1).replace(/\\/g, '/')
        const bytes = statSync(result.path).size
        const sha256 = sha256File(result.path)
        const delivery: StudioDelivery = {
          id: studioId('delivery'),
          kind: format,
          label: quality === 'draft' ? `动态分镜草稿 · ${Math.round(result.durationSec)} 秒 · ${format.toUpperCase()}` : `成片 · ${Math.round(result.durationSec)} 秒 · ${format.toUpperCase()}`,
          path: relative,
          bytes,
          sha256,
          createdAt: nowMs(),
          meta: {
            quality,
            format,
            resolution,
            width: result.width,
            height: result.height,
            durationSec: Math.round(result.durationSec * 10) / 10,
            subtitles: result.burnedSubtitles ? 'burned' : 'soft',
            missingShots: result.missingShots.length,
            placeholders: result.placeholders
          }
        }
        let posterDelivery: StudioDelivery | null = null
        try {
          const poster = join(this.store.exportsDir(snapshot.id), `${basename(result.path, '.' + format)}-poster.jpg`)
          const ok = await extractPoster(result.path, Math.min(2, result.durationSec / 3), poster)
          if (ok) {
            const posterBytes = statSync(poster).size
            posterDelivery = {
              id: studioId('delivery'),
              kind: 'cover',
              label: '成片预览帧',
              path: poster.slice(this.store.projectDir(snapshot.id).length + 1).replace(/\\/g, '/'),
              bytes: posterBytes,
              sha256: sha256File(poster),
              createdAt: nowMs()
            }
          }
        } catch {
          // 抽帧失败不影响成片
        }
        return {
          message: result.message,
          costCny: 0,
          costNote: 'FFmpeg 本机计算，不计模型费用',
          outputs: [{ label: delivery.label, path: result.path }],
          apply: (fresh) => {
            fresh.deliveries.unshift(delivery)
            if (posterDelivery) fresh.deliveries.unshift(posterDelivery)
            fresh.deliveries = fresh.deliveries.slice(0, 30)
            const degraded = result.missingShots.length > 0 || result.audioFailures.length > 0 || result.placeholders > 0 || missingVoiceLines.length > 0
            fresh.stages.delivery = { status: degraded ? 'review' : 'done', updatedAt: nowMs(), message: degraded ? `${delivery.label} · 需核对缺失素材` : delivery.label, progress: degraded ? 70 : 100 }
            fresh.stage = 'delivery'
            if (result.missingShots.length) {
              fresh.checks.push({
                id: studioId('check'),
                kind: 'missing',
                level: 'warn',
                title: `${result.missingShots.length} 镜缺画面，成片中为黑色占位`,
                detail: `缺画面镜头：${result.missingShots.join('、')}`,
                createdAt: nowMs()
              })
            }
            if (result.placeholders > 0) {
              fresh.checks.push({
                id: studioId('check'),
                kind: 'missing',
                level: 'error',
                title: `${result.placeholders} 镜素材丢失，成片中为占位`,
                detail: '有素材记录但文件不在本机。请重新生成或导入缺失镜头后再合成。',
                createdAt: nowMs()
              })
            }
            if (missingVoiceLines.length) {
              fresh.checks.push({
                id: studioId('check'),
                kind: 'audio',
                level: 'warn',
                title: `${missingVoiceLines.length} 段台词没有配音`,
                detail: `镜 ${missingVoiceLines.slice(0, 8).map((shot) => shot.number).join('、')} 只有字幕没有声音。`,
                createdAt: nowMs()
              })
            }
            if (result.audioFailures.length) {
              fresh.checks.push({
                id: studioId('check'),
                kind: 'audio',
                level: 'error',
                title: `${result.audioFailures.length} 段音频没有进成片`,
                detail: result.audioFailures.slice(0, 6).map((item) => `${item.label}：${item.detail}`).join('\n'),
                createdAt: nowMs()
              })
            }
          }
        }
      }
    })
    return this.result(project, { job })
  }

  /** 用真实视觉模型逐镜检查画面；模型或本机视觉不可用时记录“未检查”，不伪造结论。 */
  private async visualCheck(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    if (project.kind !== 'drama') throw new Error('画面检查只用于漫剧镜头。')
    const shotIds = Array.isArray(request.shotIds) ? arrayOfStrings(request.shotIds) : []
    const targets = project.shots.filter((shot) => (shot.imageAssetId || shot.videoAssetId) && (!shotIds.length || shotIds.includes(shot.id)))
    if (!targets.length) throw new Error('还没有可检查的画面；先生成或导入至少一个镜头。')
    const vision = studioVisionProvider(project.runtime.strategy)
    const job = await this.launchJob(project, {
      kind: 'review',
      label: targets.length === 1 ? `检查第 ${targets[0].number} 镜画面` : '逐镜检查画面连续性',
      stage: 'review',
      inputHash: sha256Buffer(Buffer.from(`visual:${project.id}:${targets.map((shot) => `${shot.id}:${shot.imageAssetId ?? shot.videoAssetId}`).join('|')}`)),
      estimatedCostCny: null,
      costNote: vision ? '视觉模型按实际用量计费，完成后以账单为准' : '本机视觉模型，不调用云端',
      retry: { action: 'visual-check', payload: { shotIds: targets.map((shot) => shot.id) } },
      run: async (snapshot, ctx) => {
        const media = getMediaService()
        const checks: StudioProject['checks'] = []
        for (const [index, shot] of targets.entries()) {
          if (ctx.signal.aborted) break
          const asset = snapshot.assets.find((item) => item.id === (shot.imageAssetId ?? shot.videoAssetId))
          if (!asset) continue
          ctx.progress(`检查第 ${index + 1}/${targets.length} 镜`, Math.round((index / targets.length) * 85) + 5)
          try {
            const result = await media.describeMedia({
              workspace: this.store.projectDir(snapshot.id),
              path: isAbsolute(asset.path) ? asset.path : join(this.store.projectDir(snapshot.id), asset.path),
              question: '这是漫剧的一个分镜镜头。只检查画面本身的明显问题：手、脸、眼睛、服装、道具、人物数量与动作方向是否异常或前后不一致。请先给一句结论（通过/有问题），再列出最多三条具体问题；不要评价剧情，不要编造看不清的细节。',
              frames: 1,
              signal: ctx.signal,
              onProgress: (update) => ctx.progress(update.stage, Math.min(88, Math.round((index / targets.length) * 85) + 5 + Math.round((update.percent ?? 0) * 0.02))),
              ...(vision ? { visionProvider: vision } : {})
            })
            const text = result.text.trim().slice(0, 900)
            const issue = /有问题|异常|不一致|畸形|多指|少指|错位|重做|崩|糊|穿帮|多余|缺失/.test(text)
            checks.push({
              id: studioId('check'),
              kind: 'visual',
              level: issue ? 'warn' : 'info',
              title: issue ? `镜 ${shot.number} 画面需要核对` : `镜 ${shot.number} 画面检查完成`,
              detail: `${result.fallback ? '本机视觉模型：' : `${result.model}：`}${text}`,
              targetId: shot.id,
              createdAt: nowMs()
            })
          } catch (err) {
            checks.push({
              id: studioId('check'),
              kind: 'visual',
              level: 'warn',
              title: `镜 ${shot.number} 画面未完成检查`,
              detail: `视觉模型不可用：${err instanceof Error ? err.message : String(err)}`,
              targetId: shot.id,
              createdAt: nowMs()
            })
          }
        }
        if (!checks.length) throw new Error('没有可检查的画面素材。')
        const warnings = checks.filter((check) => check.level === 'warn').length
        return {
          message: warnings ? `视觉检查完成：${warnings} 镜需要核对。` : `视觉检查完成：${checks.length} 镜通过。`,
          costCny: null,
          costNote: vision ? '视觉模型按实际用量计费，完成后以账单为准' : '本机视觉模型，不调用云端',
          outputs: [{ label: `视觉检查 ${checks.length} 镜`, path: undefined }],
          apply: (fresh) => {
            fresh.checks = [...fresh.checks.filter((check) => check.kind !== 'visual'), ...checks]
            fresh.stages.review = {
              status: warnings ? 'review' : 'done',
              updatedAt: nowMs(),
              message: warnings ? `${warnings} 镜画面需要核对` : '视觉检查通过',
              progress: warnings ? 60 : 100
            }
            fresh.stage = 'review'
          }
        }
      }
    })
    return this.result(project, { job })
  }

  /** 排在补齐任务之后的草稿合成步骤：等素材任务完成后再装配/渲染，避免拿到旧快照。 */
  private async queueAutoDraft(project: StudioProject): Promise<StudioJob> {
    return this.launchJob(project, {
      kind: 'render',
      label: '自动推进 · 装配并合成草稿',
      stage: 'delivery',
      inputHash: sha256Buffer(Buffer.from(`auto-draft:${project.id}:${project.timeline.version}:${project.shots.length}`)),
      estimatedCostCny: 0,
      costNote: 'FFmpeg 本机计算，不计模型费用',
      run: async (snapshot, ctx) => {
        ctx.progress('检查时间线与素材', 10)
        if (!snapshot.timeline.clips.length || snapshot.stages.timeline.status === 'stale') {
          ctx.progress('自动装配时间线', 30)
          this.buildTimeline({ projectId: project.id })
        }
        ctx.progress('排队合成草稿', 70)
        await this.render({ projectId: project.id, quality: 'draft', allowMissing: true })
        return { message: '时间线已就绪，草稿合成已排队。' }
      }
    })
  }

  /** 一键只补齐“还没有”的素材；所有花费仍由每个子任务自己的预算闸门控制。 */
  private async autoAdvance(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    if (!project.blueprint?.approved) throw new Error('请先确认蓝图，再自动推进。')
    const queued: string[] = []
    const skipped: string[] = []
    if (project.kind === 'drama') {
      const missingImages = project.shots.filter((shot) => !shot.imageAssetId && !shot.videoAssetId)
      if (missingImages.length) {
        try {
          const result = await this.generateShotImage({ projectId, shotIds: missingImages.map((shot) => shot.id) })
          if (result.job) queued.push(`画面 ${missingImages.length} 镜`)
        } catch (err) {
          skipped.push(`画面：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const missingVoice = project.shots.filter((shot) => shot.dialogue.trim() && !shot.voiceAssetId)
      if (missingVoice.length) {
        try {
          const result = await this.generateVoice({ projectId, shotIds: missingVoice.map((shot) => shot.id) })
          if (result.job) queued.push(`配音 ${missingVoice.length} 段`)
        } catch (err) {
          skipped.push(`配音：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (!resolveMusicAsset(project)?.formal) {
        try {
          const result = await this.generateMusic({ projectId, kind: 'music' })
          if (result.job) queued.push('配乐')
        } catch (err) {
          skipped.push(`配乐：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (bool(request.renderDraft)) {
        const latest = this.store.readProject(projectId)
        const draft = await this.queueAutoDraft(latest)
        queued.push(draft.label)
      }
    } else {
      const empty = project.chapters.filter((chapter) => !chapter.content.trim())
      if (empty.length) {
        try {
          const result = await this.batchWrite({ projectId, count: Math.min(3, empty.length), useModel: request.useModel })
          if (result.job) queued.push(`续写 ${Math.min(3, empty.length)} 章`)
        } catch (err) {
          skipped.push(`续写：${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    const latest = this.store.readProject(projectId)
    return this.result(latest, {
      message: queued.length || skipped.length
        ? `已排队：${queued.join('、') || '无'}${skipped.length ? `；未排队：${skipped.join('；')}` : ''}`
        : '没有需要补齐的素材；已有内容不会被重复生成。'
    })
  }

  private async review(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const before = this.store.readProject(projectId)
    const base = this.resultSync(projectId, (project) => {
      const voice = auditCharacterVoices(project)
      project.voiceAudit = voice.audit
      const checks = [...runChecks(project), ...voice.checks]
      project.checks = checks
      const errors = checks.filter((check) => check.level === 'error').length
      const warns = checks.filter((check) => check.level === 'warn').length
      project.stages.review = {
        status: errors || warns ? 'review' : 'done',
        updatedAt: nowMs(),
        message: errors ? `${errors} 个问题需要处理` : warns ? `${warns} 条提醒` : '检查通过',
        progress: errors || warns ? 60 : 100
      }
      project.stage = 'review'
      this.store.save(project, '运行检查', { snapshot: false })
      return project
    })
    const vision = studioVisionProvider(before.runtime.strategy)
    const hasVisualResult = before.checks.some((check) => check.kind === 'visual' && check.level !== 'info')
    const hasVisualTargets = before.shots.some((shot) => shot.imageAssetId || shot.videoAssetId)
    if (before.kind !== 'drama' || !vision || !hasVisualTargets || hasVisualResult) return base
    try {
      const visual = await this.visualCheck({ projectId })
      return this.result(visual.project, {
        job: visual.job,
        message: `基础检查完成；正在用 ${vision.model.label || vision.model.id} 逐镜检查画面。`
      })
    } catch {
      return base
    }
  }

  /** 模型审稿：按大师方法的检查清单给证据，不再用本地正则冒充语义检查。 */
  /** 漫剧剧情审稿：真实文本模型检查动机、因果、时间线与分镜覆盖，不冒充画面检查。 */
  private async dramaModelReview(project: StudioProject, request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const runtime = studioTextRuntime(project.runtime.strategy)
    if (!runtime.configured) throw new Error(`剧情审稿需要可用的文本模型。${runtime.message}`)
    if (!project.blueprint?.approved || !project.shots.length) throw new Error('还没有可审的镜头计划；先生成并确认蓝图与分镜。')
    const shots = [...project.shots].sort((left, right) => left.number - right.number)
    const shotText = shots.slice(0, 40).map((shot) => ({
      number: shot.number,
      scene: project.scenes.find((scene) => scene.id === shot.sceneId)?.title ?? '',
      title: shot.title,
      action: shot.action,
      dialogue: shot.dialogue,
      speaker: shot.speaker
    }))
    const scenesText = project.scenes.map((scene) => ({ number: scene.number, title: scene.title, synopsis: scene.synopsis, location: scene.location }))
    const estimated = estimateTextCostCny(shotText.length * 120 + 1500, 4000, project.runtime.strategy) ?? 0
    const job = await this.launchJob(project, {
      kind: 'text',
      label: `剧情审稿 · ${shots.length} 镜`,
      stage: 'review',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`drama-review:${project.id}:${shots.map((shot) => `${shot.id}:${shot.action}:${shot.dialogue}`).join('|')}:${runtime.model?.id ?? ''}`)),
      estimatedCostCny: estimated,
      costNote: '按当前文本模型参考价估算',
      retry: { action: 'model-review', payload: {} },
      run: async (snapshot, ctx) => {
        ctx.progress('整理剧情与分镜', 15)
        const result = await completeCreativeText({
          system: [
            '你是漫剧剧情审稿编辑，只检查剧情逻辑，不改稿。',
            '检查人物动机、因果链、时间线、场景转换、伏笔兑现、镜头是否覆盖关键动作、台词是否推进剧情。',
            '每个问题必须引用镜号或场号；不要编造画面里看不到的细节，不要评价画面美感。',
            '严格输出 JSON，不要 Markdown：{"summary":string,"issues":[{"level":"error"|"warn"|"info","title":string,"detail":string,"shotNumber":number,"sceneNumber":number}]}',
            '没有证据的判断不要写；最多 12 条。',
            masterPromptContext('drama', 'review', '剧情逻辑 人物动机 因果 时间线 伏笔 分镜覆盖', 'review', snapshot.runtime.strategy)
          ].join('\n'),
          prompt: [
            `作品：${snapshot.title}`,
            `一句话：${snapshot.logline}`,
            `故事核：${snapshot.blueprint?.storyCore ?? ''}`,
            `人物：${snapshot.characters.map((character) => `${character.name}（${character.role}）`).join('；')}`,
            `场景：${JSON.stringify(scenesText)}`,
            `分镜：${JSON.stringify(shotText)}`,
            '请按导演大师的检查方法核对剧情逻辑与分镜覆盖，引用具体镜号。只输出 JSON。'
          ].join('\n\n'),
          structured: true,
          temperature: 0.3,
          signal: ctx.signal,
          strategy: snapshot.runtime.strategy
        })
        const parsed = extractJson<Record<string, unknown>>(result.text)
        if (!parsed || !Array.isArray(parsed.issues)) throw new Error('模型没有返回可解析的剧情审稿结果。')
        const allowedLevels = new Set(['error', 'warn', 'info'])
        const checks: StudioProject['checks'] = (parsed.issues as Array<Record<string, unknown>>)
          .filter((item) => item && typeof item === 'object')
          .slice(0, 12)
          .map((item) => {
            const level = allowedLevels.has(str(item.level)) ? str(item.level) as 'error' | 'warn' | 'info' : 'info'
            const shotNumber = Math.round(num(item.shotNumber, 0))
            const target = snapshot.shots.find((shot) => shot.number === shotNumber)
            const sceneNumber = Math.round(num(item.sceneNumber, 0))
            const scene = snapshot.scenes.find((itemScene) => itemScene.number === sceneNumber)
            return {
              id: studioId('check'),
              kind: 'continuity' as const,
              level,
              title: `剧情 · ${str(item.title).slice(0, 100) || '需要核对'}`,
              detail: str(item.detail).slice(0, 1200),
              ...(target?.id ? { targetId: target.id } : scene?.id ? { targetId: scene.id } : {}),
              createdAt: nowMs()
            }
          })
        const summary = str(parsed.summary).slice(0, 300)
        const errors = checks.filter((check) => check.level === 'error').length
        const warns = checks.filter((check) => check.level === 'warn').length
        return {
          message: `剧情审稿完成：${errors} 个问题、${warns} 条提醒${summary ? `。${summary}` : ''}`,
          costCny: result.costCny,
          costNote: result.costNote ?? '按实际 token 记录',
          outputs: [{ label: `${shots.length} 镜剧情审稿`, path: undefined }],
          apply: (fresh) => {
            fresh.checks = [...fresh.checks.filter((check) => !check.title.startsWith('剧情 · ')), ...checks]
            fresh.stages.review = {
              status: errors || warns ? 'review' : 'done',
              updatedAt: nowMs(),
              message: errors ? `${errors} 个剧情问题` : warns ? `${warns} 条剧情提醒` : '剧情审稿通过',
              progress: errors || warns ? 60 : 100
            }
            fresh.stage = 'review'
            fresh.messages.push(assistantMessage('assistant', [`剧情审稿：${summary || '已完成。'}`, ...checks.slice(0, 5).map((check) => `· ${check.title}：${check.detail}`)].filter(Boolean).join('\n')))
            fresh.messages = fresh.messages.slice(-80)
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private async modelReview(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    if (project.kind === 'drama') return this.dramaModelReview(project, request)
    const runtime = studioTextRuntime(project.runtime.strategy)
    if (!runtime.configured) throw new Error(`模型审稿需要可用的文本模型。${runtime.message}`)
    const written = project.chapters.filter((chapter) => chapter.content.trim()).sort((left, right) => left.number - right.number)
    if (!written.length) throw new Error('还没有正文可供审稿。')
    const picked = written.length <= 6 ? written : [...written.slice(0, 1), ...written.slice(-5)]
    const chaptersText = picked
      .map((chapter) => `【第 ${chapter.number} 章 · ${chapter.title}】\n${chapter.content.slice(0, 12_000)}`)
      .join('\n\n')
      .slice(0, 60_000)
    const job = await this.launchJob(project, {
      kind: 'text',
      label: `模型审稿 · ${picked.length} 章`,
      stage: 'review',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`model-review:${project.id}:${picked.map((chapter) => `${chapter.id}:${chapter.revision}`).join('|')}:${runtime.model?.id ?? ''}`)),
      estimatedCostCny: estimateTextCostCny(chaptersText.length + 2000, 4000, project.runtime.strategy) ?? 0,
      costNote: '按当前文本模型参考价估算',
      retry: { action: 'model-review', payload: {} },
      run: async (snapshot, ctx) => {
        ctx.progress('准备审稿材料', 12)
        const current = snapshot.chapters.filter((chapter) => picked.some((item) => item.id === chapter.id))
        const result = await completeCreativeText({
          system: [
            '你是 Morrow 创作台的审稿编辑，只做审稿，不改稿。',
            '按写作大师的检查方法核对结构与人物、场景与对话、语言与 AI 腔、连续性与交付完整度。',
            '每个问题必须引用章节号、原文短句或具体缺失项，不许凭感觉。',
            '严格输出 JSON，不要 Markdown：',
            '{"summary":string,"issues":[{"level":"error"|"warn"|"info","title":string,"detail":string,"chapterNumber":number}]}',
            '低于交付标准必须给可执行的改法；没有证据的判断不要写。',
            masterPromptContext(snapshot.kind, 'review', '结构 人物 场景 对话 语言 AI 腔 连续性 交付', 'review', snapshot.runtime.strategy)
          ].join('\n'),
          prompt: [
            `作品：${snapshot.title}`,
            `故事核：${snapshot.blueprint?.storyCore ?? snapshot.logline}`,
            `人物：${snapshot.characters.map((character) => `${character.name}（${character.role ?? ''}）`).join('、') || '未建立'}`,
            `已写 ${written.length}/${snapshot.chapters.length} 章；本次审 ${current.map((chapter) => `第 ${chapter.number} 章`).join('、')}。`,
            '',
            chaptersText
          ].join('\n'),
          structured: true,
          temperature: 0.3,
          signal: ctx.signal,
          strategy: snapshot.runtime.strategy
        })
        const parsed = extractJson<Record<string, unknown>>(result.text)
        if (!parsed || !Array.isArray(parsed.issues)) throw new Error('模型没有返回可解析的审稿结果。请重试。')
        const allowedLevels = new Set(['error', 'warn', 'info'])
        const checks: StudioProject['checks'] = (parsed.issues as Array<Record<string, unknown>>)
          .filter((item) => item && typeof item === 'object')
          .slice(0, 20)
          .map((item) => {
            const level = allowedLevels.has(str(item.level)) ? str(item.level) as 'error' | 'warn' | 'info' : 'info'
            const chapterNumber = Math.round(num(item.chapterNumber, 0))
            const target = snapshot.chapters.find((chapter) => chapter.number === chapterNumber)
            return {
              id: studioId('check'),
              kind: 'quality' as const,
              level,
              title: str(item.title).slice(0, 120) || '模型审稿发现',
              detail: str(item.detail).slice(0, 1200),
              ...(target ? { targetId: target.id } : {}),
              createdAt: nowMs()
            }
          })
        const summary = str(parsed.summary).slice(0, 300)
        const errors = checks.filter((check) => check.level === 'error').length
        const warns = checks.filter((check) => check.level === 'warn').length
        const sampled = picked.length < written.length
        return {
          message: `模型审稿完成：${errors} 个问题、${warns} 条提醒${sampled ? `（抽样 ${picked.length}/${written.length} 章）` : ''}${summary ? `。${summary}` : ''}`,
          costCny: result.costCny,
          costNote: result.costNote ?? '按实际 token 记录',
          outputs: [{ label: `${picked.length} 章模型审稿`, path: undefined }],
          apply: (fresh) => {
            fresh.checks = [...fresh.checks.filter((check) => !check.title.startsWith('模型审稿')), ...checks]
            const localErrors = fresh.checks.filter((check) => check.level === 'error' && !check.resolved && !check.title.startsWith('模型审稿')).length
            if (sampled) {
              fresh.checks.push({
                id: studioId('check'),
                kind: 'quality',
                level: 'info',
                title: `模型审稿为抽样：${picked.length}/${written.length} 章`,
                detail: '长篇一次只审最近章节；未覆盖章节仍需另行审稿或人工核对。',
                createdAt: nowMs()
              })
            }
            fresh.stages.review = {
              status: errors || warns || localErrors || sampled ? 'review' : 'done',
              updatedAt: nowMs(),
              message: errors ? `${errors} 个模型审稿问题` : warns ? `${warns} 条模型审稿提醒` : localErrors ? `${localErrors} 个本地检查错误未处理` : sampled ? `模型审稿通过（抽样 ${picked.length}/${written.length} 章）` : '模型审稿通过',
              progress: errors || warns || localErrors || sampled ? 60 : 100
            }
            fresh.stage = 'review'
            fresh.messages.push(assistantMessage('assistant', [`模型审稿：${summary || '已完成。'}`, ...checks.slice(0, 4).map((check) => `· ${check.title}：${check.detail}`)].filter(Boolean).join('\n')))
            fresh.messages = fresh.messages.slice(-80)
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private async exportAudio(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    if (project.kind !== 'drama') throw new Error('只有漫剧时间线可以导出音频。')
    const format = str(request.format)
    if (!['wav', 'mp3', 'm4a', 'flac'].includes(format)) throw new Error('不支持的音频格式。')
    const latest = [...project.deliveries].reverse().find((item) => isStudioVideoDelivery(item.kind))
    if (!latest) throw new Error('先合成一版草稿或成片，再从成片提取音频。')
    const source = join(this.store.projectDir(projectId), latest.path)
    if (!existsSync(source)) throw new Error('最近一版成片文件不在本机，无法提取音频。')
    const job = await this.launchJob(project, {
      kind: 'export',
      label: `导出音频 · ${format === 'm4a' ? 'AAC' : format.toUpperCase()}`,
      stage: 'delivery',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`audio:${project.id}:${latest.id}:${format}`)),
      estimatedCostCny: 0,
      costNote: 'FFmpeg 本机提取，不计模型费用',
      retry: { action: 'export-audio', payload: { format } },
      run: async (_snapshot, ctx) => {
        const paths = resolveFfmpegPaths()
        if (!paths) throw new Error('没有找到 FFmpeg，无法提取音频。请到设置 → 多媒体选择 ffmpeg.exe。')
        const tempDir = this.store.tempDir(projectId)
        mkdirSync(tempDir, { recursive: true })
        const output = join(tempDir, `audio-${Date.now().toString(36)}.${format}`)
        const codec = format === 'wav'
          ? ['-c:a', 'pcm_s16le', '-ar', '48000']
          : format === 'mp3'
            ? ['-c:a', 'libmp3lame', '-b:a', '192k']
            : format === 'flac'
              ? ['-c:a', 'flac']
              : ['-c:a', 'aac', '-b:a', '192k']
        ctx.progress('提取音轨', 35)
        const result = spawnSync(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', source, '-vn', ...codec, output], { windowsHide: true, timeout: 120_000 })
        if (result.status !== 0 || !existsSync(output)) throw new Error(`音频导出失败：${result.stderr?.toString().slice(0, 400) || 'FFmpeg 未返回结果'}`)
        ctx.progress('写入交付记录', 90)
        const bytes = readFileSync(output)
        const delivery = writeDeliveryFile(projectId, `${cleanFileName(project.title)}-音频.${format}`, bytes, `音频 · ${format === 'm4a' ? 'AAC' : format.toUpperCase()}`, format as StudioDelivery['kind'], { durationSec: Math.round(project.timeline.durationSec), source: latest.label })
        try { rmSync(output, { force: true }) } catch { /* 临时文件清理失败不影响交付 */ }
        return {
          message: `${delivery.label} 已导出。`,
          costCny: 0,
          outputs: [{ label: delivery.label, path: delivery.path }],
          apply: (next) => {
            if (!next.deliveries.some((item) => item.id === delivery.id || item.path === delivery.path)) next.deliveries.unshift(delivery)
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private async exportComic(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    if (project.kind !== 'drama') throw new Error('四格漫画只用于漫剧镜头。')
    const shots = project.shots.filter((shot) => shot.imageAssetId).slice(0, 4)
    if (shots.length < 4) throw new Error('至少需要 4 个有画面的镜头才能排版四格漫画。')
    const job = await this.launchJob(project, {
      kind: 'image',
      label: '排版四格漫画',
      stage: 'delivery',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`comic:${project.id}:${shots.map((shot) => `${shot.id}:${shot.imageAssetId}`).join('|')}`)),
      estimatedCostCny: 0,
      costNote: 'FFmpeg 本机排版，不计模型费用',
      retry: { action: 'export-comic', payload: {} },
      run: async (snapshot, ctx) => {
        const paths = resolveFfmpegPaths()
        if (!paths) throw new Error('没有找到 FFmpeg，无法排版四格漫画。')
        const inputs: string[] = []
        for (const shot of shots) {
          const asset = snapshot.assets.find((item) => item.id === shot.imageAssetId)
          if (!asset) throw new Error(`第 ${shot.number} 镜画面丢失。`)
          inputs.push(this.store.assetAbsolute(snapshot, asset))
        }
        const tempDir = this.store.tempDir(projectId)
        mkdirSync(tempDir, { recursive: true })
        const output = join(tempDir, `comic-${Date.now().toString(36)}.png`)
        ctx.progress('排版四格', 45)
        const filter = [0, 1, 2, 3].map((index) => `[${index}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`).join(';') + ';[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[out]'
        const args = ['-y', '-hide_banner', '-loglevel', 'error', ...inputs.flatMap((input) => ['-i', input]), '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', output]
        const result = spawnSync(paths.ffmpeg, args, { windowsHide: true, timeout: 120_000 })
        if (result.status !== 0 || !existsSync(output)) throw new Error(`四格漫画排版失败：${result.stderr?.toString().slice(0, 400) || 'FFmpeg 未返回结果'}`)
        ctx.progress('写入交付记录', 90)
        const bytes = readFileSync(output)
        const delivery = writeDeliveryFile(projectId, `${cleanFileName(project.title)}-四格漫画.png`, bytes, '四格漫画 · PNG', 'comic', { format: 'PNG 2×2', panels: 4 })
        try { rmSync(output, { force: true }) } catch { /* 临时文件清理失败不影响交付 */ }
        return {
          message: '四格漫画已排版。',
          costCny: 0,
          outputs: [{ label: delivery.label, path: delivery.path }],
          apply: (next) => {
            if (!next.deliveries.some((item) => item.id === delivery.id || item.path === delivery.path)) next.deliveries.unshift(delivery)
          }
        }
      }
    })
    return this.result(project, { job })
  }

  /** 导出预检：字体、FFmpeg 与各格式的真实可用状态；不生成文件，不改作品。 */
  private exportPreflight(request: { [key: string]: unknown }): StudioExportPreflight {
    const project = this.store.readProject(safeProjectId(str(request.projectId)))
    const fontDirs =
      process.platform === 'win32'
        ? [join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')]
        : process.platform === 'darwin'
          ? ['/System/Library/Fonts', '/Library/Fonts']
          : ['/usr/share/fonts', '/usr/local/share/fonts']
    const detected = new Set<string>()
    for (const dir of fontDirs) {
      if (!existsSync(dir)) continue
      try {
        for (const name of readdirSync(dir)) {
          if (!/^(?:msyh|simsun|simhei|simkai|songti|stsong|stkaiti|pingfang|noto(?:serif|sans)(?:sc|cjk)|sourcehanserif|sourcehansans)/i.test(name)) continue
          detected.add(name)
          if (detected.size >= 12) break
        }
      } catch {
        // 字体目录不可读时只返回未检测到，不影响导出
      }
    }
    const fontNames = [...detected]
    const bundledSerif = Boolean(bundledExportFontStylesheet())
    const serif = bundledSerif || fontNames.some((name) => /simsun|songti|stsong|serif|宋/i.test(name))
    const sans = fontNames.some((name) => /msyh|yahei|simhei|pingfang|sans|黑/i.test(name))
    const paths = resolveFfmpegPaths()
    const caps = ffmpegCapabilities()
    const ffmpegAvailable = Boolean(paths)
    const latestVideo = [...project.deliveries].reverse().find((delivery) => isStudioVideoDelivery(delivery.kind) && existsSync(this.store.deliveryAbsolute(project.id, delivery)))
    const hasImages = project.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length >= 4
    const subtitleCues = project.timeline.clips.filter((clip) => clip.kind === 'subtitle' && (clip.text ?? '').trim()).length
    const writtenChapters = project.chapters.filter((chapter) => chapter.content.trim()).length
    const hasContent = project.kind === 'drama' ? project.timeline.clips.length > 0 : writtenChapters > 0
    const timelineReady = project.timeline.clips.length > 0 && project.stages.timeline.status !== 'stale'
    const commonFormats: StudioExportPreflight['formats'] = [
      { format: 'txt', label: 'TXT', ready: project.kind === 'drama' ? true : writtenChapters > 0, note: project.kind === 'drama' ? '纯文本，无字体依赖' : writtenChapters > 0 ? '纯文本，无字体依赖' : '先写至少一章正文' },
      { format: 'md', label: 'Markdown', ready: project.kind === 'drama' ? true : writtenChapters > 0, note: project.kind === 'drama' ? '纯文本，无字体依赖' : writtenChapters > 0 ? '纯文本，无字体依赖' : '先写至少一章正文' },
      { format: 'docx', label: 'DOCX', ready: project.kind === 'drama' ? true : writtenChapters > 0, note: project.kind === 'drama' ? 'eastAsia=宋体，读取器按系统字体回退' : writtenChapters > 0 ? 'eastAsia=宋体，读取器按系统字体回退' : '先写至少一章正文' },
      { format: 'epub', label: 'EPUB', ready: project.kind === 'drama' ? true : writtenChapters > 0, note: project.kind === 'drama' ? '写入字体回退栈，由阅读器本机字体渲染' : writtenChapters > 0 ? '写入字体回退栈，由阅读器本机字体渲染' : '先写至少一章正文' },
      { format: 'pdf', label: 'PDF', ready: project.kind === 'drama' ? true : writtenChapters > 0, note: project.kind === 'drama' ? 'Chromium 打印，嵌入实际使用字形子集' : writtenChapters > 0 ? 'Chromium 打印，嵌入实际使用字形子集' : '先写至少一章正文' },
      { format: 'cover', label: '封面', ready: true, note: '1200×1600 真实渲染' },
      { format: 'srt', label: 'SRT', ready: subtitleCues > 0, note: subtitleCues > 0 ? `${subtitleCues} 条字幕` : '先在分镜里生成逐句字幕' },
      { format: 'ass', label: 'ASS', ready: subtitleCues > 0, note: subtitleCues > 0 ? `${subtitleCues} 条字幕，保留样式` : '先在分镜里生成逐句字幕' },
      { format: 'package', label: '工程包', ready: hasContent, note: hasContent ? '保留章节、素材与任务记录' : '先产生正文或时间线内容' }
    ]
    const formats = project.kind === 'drama'
      ? [
          ...commonFormats.filter((item) => ['srt', 'ass', 'package'].includes(item.format)),
          { format: 'mp4', label: 'MP4 / MOV / MKV / WebM', ready: ffmpegAvailable && timelineReady, note: !ffmpegAvailable ? '需要本机 FFmpeg' : timelineReady ? '按 1080p/4K 合成' : '时间线未装配或已过期，先重新装配' },
          { format: 'audio', label: 'WAV / MP3 / AAC / FLAC', ready: ffmpegAvailable && Boolean(latestVideo), note: latestVideo ? '从最近成片提取音轨' : '先合成一版成片' },
          { format: 'comic', label: '四格漫画', ready: ffmpegAvailable && hasImages, note: hasImages ? '按 2×2 排版' : '至少需要 4 镜有画面' },
          { format: 'folder', label: '发布套组', ready: ffmpegAvailable && Boolean(latestVideo), note: latestVideo ? '成片 + 封面 + 字幕' : '先合成一版成片' }
        ]
      : [
          ...commonFormats,
          { format: 'folder', label: '发布套组', ready: writtenChapters > 0, note: writtenChapters > 0 ? '手稿 + 目录 + 封面 + 字体回退说明' : '先写至少一章正文' }
        ]
    const warnings: string[] = []
    if (!serif && !sans) warnings.push('未检测到中文衬线/黑体字体；DOCX 与 EPUB 可能由系统回退字体渲染，请在目标机器复核。')
    else if (!serif) warnings.push('未检测到中文衬线字体；正文会回退到黑体或系统默认。')
    if (!ffmpegAvailable) warnings.push('未找到 FFmpeg；视频合成、音轨提取与四格漫画不可用，文档导出不受影响。')
    if (project.kind === 'drama' && !project.timeline.clips.length) warnings.push('时间线尚未装配，视频相关格式暂不可用。')
    if (project.kind !== 'drama' && !project.chapters.some((chapter) => chapter.content.trim())) warnings.push('还没有正文，文档会缺少内容。')
    return {
      platform: process.platform,
      fonts: {
        detected: fontNames,
        serif,
        sans,
        bundledSerif,
        detail: `${bundledSerif ? 'PDF 与封面使用随包 Noto Serif SC Variable 并嵌入实际字形子集；' : 'PDF 由 Chromium 嵌入实际使用字形子集；'}DOCX 使用 eastAsia=宋体；EPUB 写入字体回退栈，不内嵌字体文件。`
      },
      formats,
      ffmpeg: {
        available: ffmpegAvailable,
        ...(ffmpegAvailable ? { profile: caps.profile } : {}),
        message: ffmpegAvailable ? `已检测到 FFmpeg（${caps.profile === 'enhanced' ? '增强包' : '默认包'}）` : '未找到 FFmpeg；视频相关导出需要本机安装。'
      },
      warnings
    }
  }

  private async exportProject(input: StudioExportInput): Promise<StudioActionResult> {
    const projectId = safeProjectId(input.projectId)
    const project = this.store.readProject(projectId)
    const format = input.format
    const labelMap: Record<string, string> = {
      txt: '导出纯文本',
      md: '导出 Markdown',
      epub: '导出 EPUB',
      pdf: '导出 PDF',
      docx: '导出 Word',
      srt: '导出字幕 SRT',
      ass: '导出字幕 ASS',
      package: '导出工程包',
      cover: '导出封面',
      folder: '导出发布套组'
    }
    if (project.kind !== 'drama' && !project.chapters.some((chapter) => chapter.content.trim())) {
      throw new Error('还没有正文；先写至少一章，再导出。')
    }
    // 检查过期时先重跑本地检查，不能把“没检查”当成“没有错误”。
    if (!['done', 'review'].includes(project.stages.review.status)) {
      this.review({ projectId })
    }
    const checked = this.store.readProject(projectId)
    const finalFormat = ['txt', 'md', 'docx', 'epub', 'pdf', 'folder'].includes(format)
    const blocking = checked.checks.filter((check) => check.level === 'error' && !check.resolved)
    if (finalFormat && blocking.length) {
      throw new Error(`还有 ${blocking.length} 个错误没处理，不能导出最终稿：${blocking.slice(0, 3).map((check) => check.title).join('；')}。可以到检查页处理，或先导出中间文件。`)
    }
    const totalWords = checked.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0)
    const targetWords = checked.brief.targetWords
    const wordComplete = !targetWords || totalWords >= targetWords * 0.6
    const chapterLengthOk = checked.chapters.every((chapter) => !chapter.content.trim() || countWords(chapter.content) >= Math.min(1000, chapter.wordTarget * 0.4))
    const finalBook = checked.kind !== 'drama'
      && finalFormat
      && checked.chapters.length > 0
      && checked.chapters.every((chapter) => chapter.content.trim())
      && wordComplete
      && chapterLengthOk
    const finalVideo = checked.kind === 'drama'
      && ['mp4', 'mov', 'mkv', 'webm', 'folder'].includes(format)
      && checked.deliveries.some((delivery) => isStudioVideoDelivery(delivery.kind) && existsSync(this.store.deliveryAbsolute(checked.id, delivery)))
    const job = await this.launchJob(project, {
      kind: 'export',
      label: labelMap[format] ?? '导出交付物',
      stage: 'delivery',
      requestId: str((input as unknown as Record<string, unknown>).requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`export:${project.id}:${format}:${project.revision}`)),
      estimatedCostCny: 0,
      costNote: '本机完成，不计模型费用',
      retry: { action: 'export', payload: { format } },
      run: async (_snapshot, ctx) => {
        ctx.progress('准备文件', 15)
        const fresh = this.store.readProject(projectId)
        let delivery: StudioDelivery
        switch (format) {
          case 'txt':
            delivery = exportTxt(fresh)
            break
          case 'md':
            delivery = exportMarkdown(fresh)
            break
          case 'epub':
            delivery = await exportEpub(fresh)
            break
          case 'pdf':
            delivery = await exportPdf(fresh)
            break
          case 'docx':
            delivery = await exportDocx(fresh)
            break
          case 'srt':
            delivery = exportSrt(fresh)
            break
          case 'ass':
            delivery = exportAss(fresh)
            break
          case 'package':
            delivery = await exportPackage(fresh)
            break
          case 'cover':
            delivery = await exportCover(fresh)
            break
          case 'folder':
            delivery = await exportFolder(fresh)
            break
          default:
            throw new Error(`不支持的导出格式：${String(format)}`)
        }
        ctx.progress('写入交付记录', 92)
        return {
          message: `${delivery.label} 已导出（${(delivery.bytes / 1024).toFixed(0)}KB）。`,
          costCny: 0,
          costNote: '本机完成，不计模型费用',
          outputs: [{ label: delivery.label, path: delivery.path }],
          apply: (next) => {
            if (!next.deliveries.some((item) => item.id === delivery.id || item.path === delivery.path)) {
              next.deliveries.unshift(delivery)
            }
            const final = finalBook || finalVideo
            next.stages.delivery = {
              status: final ? 'done' : 'review',
              updatedAt: nowMs(),
              message: final ? delivery.label : `${delivery.label} · 草稿或中间文件，不算最终交付`,
              progress: final ? 100 : 60
            }
            next.stage = 'delivery'
          }
        }
      }
    })
    return this.result(project, { job })
  }

  private setQueuePaused(request: { [key: string]: unknown }, paused: boolean): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      project.runtime.queuePaused = paused
      project.runtime.updatedAt = nowMs()
      this.store.save(project, paused ? '暂停任务队列' : '恢复任务队列', { snapshot: false })
      return project
    })
  }

  private saveCanvas(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const raw = request.canvas as Record<string, unknown> | undefined
      if (!raw || !Array.isArray(raw.nodes)) throw new Error('画布数据不完整。')
      const allowedKinds = new Set(['shot', 'image', 'video', 'audio', 'text'])
      const seen = new Set<string>()
      const nodes: StudioProject['canvas']['nodes'] = []
      for (const item of raw.nodes.slice(0, 400)) {
        if (!item || typeof item !== 'object') continue
        const node = item as Record<string, unknown>
        const id = str(node.id).slice(0, 80)
        const kind = str(node.kind)
        if (!id || seen.has(id) || !allowedKinds.has(kind)) continue
        seen.add(id)
        nodes.push({
          id,
          kind: kind as StudioProject['canvas']['nodes'][number]['kind'],
          title: str(node.title).slice(0, 160) || '未命名节点',
          x: Math.max(-20_000, Math.min(20_000, num(node.x, 0))),
          y: Math.max(-20_000, Math.min(20_000, num(node.y, 0))),
          width: Math.max(80, Math.min(1_200, num(node.width, 240))),
          height: Math.max(60, Math.min(900, num(node.height, 160))),
          z: Math.max(0, Math.min(10_000, num(node.z, nodes.length + 1))),
          ...(str(node.assetId) ? { assetId: str(node.assetId) } : {}),
          ...(str(node.shotId) ? { shotId: str(node.shotId) } : {}),
          ...(typeof node.text === 'string' ? { text: node.text.slice(0, 20_000) } : {}),
          createdAt: num(node.createdAt, Date.now()),
          updatedAt: num(node.updatedAt, Date.now())
        })
      }
      const nodeIds = new Set(nodes.map((node) => node.id))
      const connections: StudioProject['canvas']['connections'] = []
      const seenEdges = new Set<string>()
      if (Array.isArray(raw.connections)) {
        for (const item of raw.connections.slice(0, 600)) {
          if (!item || typeof item !== 'object') continue
          const edge = item as Record<string, unknown>
          const fromNodeId = str(edge.fromNodeId)
          const toNodeId = str(edge.toNodeId)
          const key = `${fromNodeId}->${toNodeId}`
          if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId) || fromNodeId === toNodeId || seenEdges.has(key)) continue
          seenEdges.add(key)
          connections.push({
            id: str(edge.id).slice(0, 80) || studioId('edge'),
            fromNodeId,
            toNodeId,
            ...(str(edge.label) ? { label: str(edge.label).slice(0, 80) } : {})
          })
        }
      }
      const viewport = (raw.viewport && typeof raw.viewport === 'object' ? raw.viewport : {}) as Record<string, unknown>
      const groups: NonNullable<StudioProject['canvas']['groups']> = []
      if (Array.isArray(raw.groups)) {
        const grouped = new Set<string>()
        for (const item of raw.groups.slice(0, 80)) {
          if (!item || typeof item !== 'object') continue
          const group = item as Record<string, unknown>
          const id = str(group.id).slice(0, 80) || studioId('group')
          const nodeIds = arrayOfStrings(group.nodeIds).filter((nodeId) => nodes.some((node) => node.id === nodeId) && !grouped.has(nodeId)).slice(0, 100)
          for (const nodeId of nodeIds) grouped.add(nodeId)
          if (!nodeIds.length) continue
          groups.push({
            id,
            title: str(group.title).slice(0, 120) || '画布分组',
            nodeIds,
            createdAt: num(group.createdAt, nowMs())
          })
        }
      }
      project.canvas = {
        version: 1,
        initialized: raw.initialized === true,
        nodes,
        connections,
        groups,
        viewport: {
          x: Math.max(-30_000, Math.min(30_000, num(viewport.x, 96))),
          y: Math.max(-30_000, Math.min(30_000, num(viewport.y, 72))),
          zoom: Math.max(0.2, Math.min(2.5, num(viewport.zoom, 0.8)))
        },
        updatedAt: nowMs()
      }
      return project
    })
  }

  private saveCanvasSnapshot(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const dataUrl = str(request.dataUrl)
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl)
    if (!match) throw new Error('画布快照必须是 PNG 图片。')
    const buffer = Buffer.from(match[1], 'base64')
    if (!buffer.length || buffer.length > 30 * 1024 * 1024) throw new Error('画布快照为空或超过 30MB。')
    if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('画布快照不是有效的 PNG。')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const delivery = writeDeliveryFile(
      projectId,
      `${cleanFileName(project.title)}-画布-${stamp}.png`,
      buffer,
      '画布快照',
      'png',
      {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
        nodes: project.canvas.nodes.length,
        connections: project.canvas.connections.length
      }
    )
    const fresh = this.store.readProject(projectId)
    this.emitProject(fresh)
    return this.result(fresh, { message: `画布快照已保存：${delivery.label}。` })
  }
  private voiceAudit(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const { audit, checks } = auditCharacterVoices(project)
      project.voiceAudit = audit
      project.checks = [...project.checks.filter((check) => check.kind !== 'voice'), ...checks]
      const warns = checks.filter((check) => check.level === 'warn').length
      project.stages.review = {
        status: warns ? 'review' : 'done',
        updatedAt: nowMs(),
        message: warns ? `${warns} 条人物语气提醒` : '人物语气检查完成',
        progress: warns ? 70 : 100
      }
      project.stage = 'review'
      return project
    })
  }

  private assetWaveform(request: { [key: string]: unknown }): { peaks: number[]; cached: boolean } {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const assetId = str(request.assetId)
    const asset = project.assets.find((item) => item.id === assetId && item.kind === 'audio')
    if (!asset) throw new Error('找不到这段音频素材。')
    const source = this.store.assetAbsolute(project, asset)
    if (!existsSync(source)) throw new Error('音频文件已丢失。')
    const cache = join(this.store.projectDir(projectId), 'derived', 'waveforms', `${assetId}.json`)
    const cached = readWaveformCache(cache, source)
    if (cached) return { peaks: cached, cached: true }
    const peaks = audioWaveform(source, 96)
    if (peaks.length) writeWaveformCache(cache, peaks)
    return { peaks, cached: false }
  }

  private textRoutes(request: { [key: string]: unknown }): { routes: ReturnType<typeof studioTextRoutes>; strategy: StudioProject['runtime']['strategy'] } {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const requested = str(request.strategy)
    const strategy = requested === 'cloud-first' || requested === 'local-only' || requested === 'cloud-only' || requested === 'local-first'
      ? requested
      : project.runtime.strategy
    return { routes: studioTextRoutes(strategy), strategy }
  }

  private assetProxy(request: { [key: string]: unknown }): { url?: string; ready: boolean } {    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const assetId = str(request.assetId)
    const asset = project.assets.find((item) => item.id === assetId && item.kind === 'video')
    if (!asset) throw new Error('找不到这段视频素材。')
    const source = this.store.assetAbsolute(project, asset)
    const target = join(this.store.projectDir(projectId), 'derived', 'proxies', `${assetId}.mp4`)
    if (!ensureVideoProxy(source, target)) return { ready: false }
    const relative = `derived/proxies/${assetId}.mp4`
    return { ready: true, url: this.store.deliverableUrl(projectId, relative, 'video/mp4') }
  }

  private setCover(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      const assetId = str(request.assetId)
      if (!project.assets.some((asset) => asset.id === assetId && asset.kind === 'image')) throw new Error('封面必须是作品里的图片素材。')
      project.coverAssetId = assetId
      this.store.save(project, '设置封面', { snapshot: false })
      return project
    })
  }

  private async planStoryboardExtension(project: StudioProject, text: string): Promise<{
    plan: StudioEditPlan
    reply: string
    cost: number | null
    costNote: string
    model: string
  }> {
    if (project.kind !== 'drama') throw new Error('补全分镜只适用于漫剧作品。')
    const blueprint = project.blueprint
    if (!blueprint?.approved) throw new Error('请先确认故事蓝图，再补全分镜。')
    const runtime = studioTextRuntime(project.runtime.strategy)
    if (!runtime.configured) throw new Error(`还没有可用的文本模型。${runtime.message}`)
    const sceneViews: Array<Pick<StudioScene, 'number' | 'title' | 'synopsis' | 'location' | 'timeOfDay' | 'characters'>> = []
    const sceneCount = Math.max(project.scenes.length, blueprint.scenes?.length ?? 0)
    for (let index = 0; index < sceneCount; index += 1) {
      const existing = project.scenes.find((scene) => scene.number === index + 1)
      const seed = blueprint.scenes?.[index]
      if (existing) sceneViews.push(existing)
      else if (seed) {
        sceneViews.push({
          number: index + 1,
          title: seed.title,
          synopsis: seed.synopsis,
          location: seed.location,
          timeOfDay: seed.timeOfDay,
          characters: seed.characters
        })
      }
    }
    if (!sceneViews.length) throw new Error('当前作品没有场景，请先生成蓝图和大纲。')
    const sceneMatch = /第\s*([一二三四五六七八九十\d]{1,3})\s*场/.exec(text) ?? /场景\s*([一二三四五六七八九十\d]{1,3})/.exec(text)
    const parsedScene = sceneMatch ? chineseNumber(sceneMatch[1]) : null
    const requestedScene = parsedScene ? sceneViews.find((scene) => scene.number === parsedScene) : undefined
    const emptyScene = [...sceneViews].reverse().find((scene) => {
      const existing = project.scenes.find((item) => item.number === scene.number)
      return !existing || !project.shots.some((shot) => shot.sceneId === existing.id)
    })
    const targetScene = requestedScene ?? emptyScene ?? sceneViews[sceneViews.length - 1]
    const maxNumber = project.shots.reduce((max, shot) => Math.max(max, shot.number), 0)
    const rangeMatch = /(\d{1,3})\s*[-–—到至~]\s*(\d{1,3})/.exec(text)
    const singleMatch = /(?:第|补全|补齐|新增|添加)\s*(\d{1,3})\s*(?:镜|个镜头)/.exec(text)
    const seed = blueprint.scenes?.[targetScene.number - 1]
    const sceneHasShots = project.shots.some((shot) => {
      const existing = project.scenes.find((scene) => scene.number === targetScene.number)
      return existing ? shot.sceneId === existing.id : false
    })
    let start = rangeMatch ? Number(rangeMatch[1]) : singleMatch ? Number(singleMatch[1]) : Math.max(maxNumber + 1, seed?.unitStart ?? maxNumber + 1)
    let end = rangeMatch ? Number(rangeMatch[2]) : start + (seed && !sceneHasShots ? Math.max(0, (seed.unitEnd - seed.unitStart)) : 5)
    let adjusted = false
    if (start <= maxNumber) {
      const count = Math.max(1, end - start + 1)
      start = maxNumber + 1
      end = start + count - 1
      adjusted = true
    }
    if (end < start) end = start
    if (end - start + 1 > 12) {
      end = start + 11
      adjusted = true
    }
    const count = end - start + 1
    const existing = [...project.shots].sort((left, right) => left.number - right.number).slice(-30).map((shot) => ({
      number: shot.number,
      title: shot.title,
      action: shot.action,
      dialogue: shot.dialogue,
      speaker: shot.speaker
    }))
    const characters = project.characters.slice(0, 10).map((character) => `${character.name}（${character.role}）`)
    const places = project.places.slice(0, 8).map((place) => `${place.name}：${place.description.slice(0, 120)}`)
    const estimate = estimateTextCostCny(text.length + existing.length * 80 + 1800, 5000, project.runtime.strategy) ?? 0
    const limit = project.runtime.budget.limit
    if (limit > 0 && project.runtime.budget.spent + estimate > limit) {
      throw new Error(`预算不足：预计需要 ¥${estimate.toFixed(2)}，当前上限 ¥${limit}`)
    }
    const result = await completeCreativeText({
      system: `你是漫剧分镜师。只补全用户指定的新镜头，不重写已有镜头；保持人物、场景、道具和前后衔接一致。只输出 JSON，不要 Markdown。${masterPromptContext('drama', 'storyboard', `${targetScene.title} ${targetScene.synopsis} 补全分镜 运镜 连续性`, 'storyboard', project.runtime.strategy)}`,
      prompt: [        `作品：${project.title}`,
        `故事核：${blueprint.storyCore}`,
        `人物：${characters.join('；')}`,
        `地点：${places.join('；')}`,
        `目标场次：第 ${targetScene.number} 场《${targetScene.title}》 · ${targetScene.synopsis} · ${targetScene.location} · ${targetScene.timeOfDay}`,
        `场景人物：${targetScene.characters.join('、') || '未指定'}`,
        `已有镜头（不要重复）：${JSON.stringify(existing)}`,
        `请补全第 ${start}–${end} 镜，共 ${count} 镜，全部属于第 ${targetScene.number} 场。`,
        '输出 {"shots":[{"number":数字,"title":"短标题","action":"具体动作与画面","camera":"运镜","shotSize":"景别","seconds":3-20,"dialogue":"台词，可为空","speaker":"说话人，必须在人物列表或为旁白","continuity":"与上一镜的衔接","prompt":"画面生成提示","negative":"避免项"}]}。',
        '必须返回完整 count 个镜头；台词只使用已有人物或旁白；不要输出解释。'
      ].join('\n\n'),
      structured: true,
      temperature: 0.8,
      strategy: project.runtime.strategy
    })
    this.charge(project, result.costCny)
    const parsed = extractJson<Record<string, unknown>>(result.text)
    const rawShots = parsed && Array.isArray(parsed.shots)
      ? parsed.shots.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : []
    if (rawShots.length !== count) {
      throw new Error(`模型只返回 ${rawShots.length} 镜，正在补全 ${count} 镜；已拒绝写入残缺分镜，请重试`)
    }
    const allowedNames = new Set(project.characters.map((character) => character.name))
    const seeds: StudioShotSeed[] = rawShots.map((item, index) => {
      const title = str(item.title).slice(0, 160).trim()
      const action = str(item.action).slice(0, 2000).trim() || str(item.summary).slice(0, 2000).trim()
      if (!title || !action) throw new Error(`第 ${start + index} 镜缺少标题或动作，已拒绝写入。`)
      const rawSpeaker = str(item.speaker).slice(0, 80).trim()
      const speaker = rawSpeaker === '旁白' || allowedNames.has(rawSpeaker) ? rawSpeaker : ''
      const durationSec = Math.max(3, Math.min(20, num(item.seconds ?? item.durationSec, 8)))
      const camera = str(item.camera).slice(0, 200).trim() || '固定镜头'
      const shotSize = str(item.shotSize).slice(0, 80).trim() || '中景'
      return {
        number: start + index,
        sceneIndex: targetScene.number,
        title,
        action,
        camera,
        shotSize,
        durationSec,
        dialogue: str(item.dialogue).slice(0, 500).trim(),
        speaker,
        continuity: str(item.continuity).slice(0, 500).trim() || `承接第 ${start + index - 1} 镜`,
        prompt: str(item.prompt).slice(0, 4000).trim() || `${title}。${action}。${blueprint.styleBible.look}。第 ${start + index} 镜。`,
        negative: str(item.negative).slice(0, 1000).trim() || blueprint.styleBible.negative.join('，')
      }
    })
    const effects = seeds.map((shot) => `第 ${shot.number} 镜 · ${shot.title}：${shot.action.slice(0, 120)}`)
    const actions: StudioEditAction[] = seeds.map((shot) => ({ type: 'append-shots', shots: [shot] }))
    const plan = createPlanFromDraft(project.id, {
      title: '补全分镜计划',
      summary: `补全第 ${start}–${end} 镜（第 ${targetScene.number} 场《${targetScene.title}》）`,
      actions,
      effects,
      seconds: seeds.reduce((sum, shot) => sum + shot.durationSec, 0),
      cost: result.costCny,
      note: adjusted ? '镜号已顺延到现有镜头之后，避免覆盖已有素材。' : result.costNote ?? '按实际 token 记录'
    })
    const reply = [
      adjusted ? `为了避免覆盖现有镜头，我把补全范围顺延为第 ${start}–${end} 镜（第 ${targetScene.number} 场《${targetScene.title}》）：` : `我会补全第 ${start}–${end} 镜（第 ${targetScene.number} 场《${targetScene.title}》）：`,
      ...seeds.map((shot) => `${shot.number} · ${shot.title}\n   动作：${shot.action}${shot.dialogue ? `\n   台词：${shot.speaker || '旁白'}「${shot.dialogue}」` : ''}`),
      `确认后会把 ${seeds.length} 镜同步写入大纲、分镜和蓝图；已有镜头与素材不会被覆盖。`
    ].join('\n')
    return { plan, reply, cost: 0, costNote: result.costNote ?? '按实际 token 记录', model: result.model }
  }

  /** 给协作者看的作品快照：足够理解要改哪一步，又不会把整本书塞进上下文。 */
  private revisionSnapshot(project: StudioProject, view: string, selection?: IntentContext['selection']): string {
    const blueprint = project.blueprint
    const lines: string[] = [
      `作品：${project.title}（${studioKindLabel(project.kind)}）`,
      `当前页面：${view || project.stage}；项目阶段：${project.stage}`,
      `一句话：${project.logline}`,
      project.brief.genre ? `类型：${project.brief.genre}；语气：${project.brief.tone || '未定'}；受众：${project.brief.audience || '未定'}` : ''
    ]
    if (blueprint) {
      lines.push(
        `故事核：${blueprint.storyCore}`,
        blueprint.pitch ? `故事提要：${blueprint.pitch.slice(0, 500)}` : '',
        blueprint.structure ? `结构：${blueprint.structure.slice(0, 500)}` : '',
        `人物：${project.characters.map((character) => `${character.name}（${character.role}${character.desire ? `，想要${character.desire}` : ''}${character.fear ? `，怕${character.fear}` : ''}）`).join('；') || '未建立'}`,
        `地点：${project.places.map((place) => `${place.name}：${place.description.slice(0, 80)}`).join('；') || '未建立'}`,
        `风格：${blueprint.styleBible.look}；${blueprint.styleBible.camera}`
      )
      if (project.kind === 'drama') {
        lines.push(`场景：${project.scenes.map((scene) => `第${scene.number}场《${scene.title}》${scene.synopsis.slice(0, 80)} @${scene.location}/${scene.timeOfDay}；人物：${scene.characters.join('、')}`).join('\n') || '未建立'}`)
      }
    }
    if (project.kind !== 'drama') {
      const units = blueprint?.units ?? []
      lines.push(`大纲（${units.length} 章）：${units.slice(0, 80).map((unit) => `第${unit.index}章《${unit.title}》：${unit.summary.slice(0, 120)}${unit.beats?.length ? `｜节拍：${unit.beats.slice(0, 3).join(' / ').slice(0, 160)}` : ''}`).join('\n')}`)
      const chapters = [...project.chapters].sort((left, right) => left.number - right.number).slice(0, 80)
      lines.push(`章节：${chapters.map((chapter) => {
        const selected = selection?.kind === 'chapter' && selection.id === chapter.id
        const body = chapter.content.trim()
        const tail = body ? `｜结尾：${body.slice(-160)}` : ''
        const head = selected && body ? `｜开头：${body.slice(0, 500)}` : ''
        return `第${chapter.number}章《${chapter.title}》${body ? `${countWords(body)}字` : '未写'}${tail}${head}`
      }).join('\n')}`)
    } else {
      const shots = [...project.shots].sort((left, right) => left.number - right.number).slice(0, 60)
      lines.push(`分镜（${project.shots.length} 镜）：${shots.map((shot) => {
        const scene = project.scenes.find((item) => item.id === shot.sceneId)
        return `第${shot.number}镜[${scene?.title ?? '?'}]《${shot.title}》${shot.action.slice(0, 120)}${shot.dialogue ? `｜台词 ${shot.speaker || '旁白'}：「${shot.dialogue}」` : ''}｜${shot.camera}/${shot.shotSize}/${shot.durationSec}s｜声线 ${shot.voiceId || '默认'}${shot.imageAssetId || shot.videoAssetId ? '｜已有画面' : ''}${shot.voiceAssetId ? '｜已有配音' : ''}`
      }).join('\n')}`)
    }
    const localVoices = localTtsVoices()
    if (localVoices.length) lines.push(`本地声线可选：${localVoices.map((voice) => `${voice.id}（${voice.label}）`).join('；')}`)
    const music = resolveMusicAsset(project)
    const sfx = project.assets.filter((asset) => asset.kind === 'audio' && asset.tags.includes('sfx'))
    lines.push(`声音素材：${music ? `配乐「${music.asset.title}」${music.formal ? '正式' : '草稿/样例'}` : '还没有配乐'}；音效 ${sfx.map((asset) => asset.title).join('、') || '无'}；时间线片段 ${project.timeline.clips.length} 个`)
    if (selection?.kind === 'chapter') {
      const chapter = project.chapters.find((item) => item.id === selection.id)
      if (chapter) lines.push(`用户当前选中：第${chapter.number}章《${chapter.title}》`)
    } else if (selection?.kind === 'shot') {
      const shot = project.shots.find((item) => item.id === selection.id)
      if (shot) lines.push(`用户当前选中：第${shot.number}镜《${shot.title}》`)
    } else if (selection?.kind === 'clip') {
      const clip = project.timeline.clips.find((item) => item.id === selection.id)
      if (clip) {
        const shot = clip.shotId ? project.shots.find((item) => item.id === clip.shotId) : undefined
        lines.push(`用户当前选中：时间线片段「${clip.label}」（${clip.kind}${shot ? `，第${shot.number}镜` : ''}）`)
      }
    }
    return lines.filter(Boolean).join('\n')
  }

  private normalizeRevisionActions(project: StudioProject, raw: unknown[]): StudioEditAction[] {
    const actions: StudioEditAction[] = []
    for (const item of raw.slice(0, 12)) {
      if (!item || typeof item !== 'object') continue
      const input = item as Record<string, unknown>
      const type = str(input.type) as StudioEditAction['type']
      const shotNumber = Math.round(num(input.shotNumber, 0)) || undefined
      const chapterNumber = Math.round(num(input.chapterNumber ?? (input.chapter as Record<string, unknown> | undefined)?.number, 0)) || undefined
      if (type === 'update-blueprint' && input.blueprint && typeof input.blueprint === 'object') {
        const patch = input.blueprint as StudioBlueprintPatch
        const next: StudioBlueprintPatch = {}
        for (const key of ['title', 'logline', 'genre', 'tone', 'audience', 'storyCore', 'emotion', 'pitch', 'structure'] as const) {
          if (typeof patch[key] === 'string' && patch[key]!.trim()) (next as Record<string, unknown>)[key] = patch[key]!.trim()
        }
        if (patch.styleBible && typeof patch.styleBible === 'object') next.styleBible = patch.styleBible
        if (Array.isArray(patch.characters)) next.characters = patch.characters.filter((character) => character?.name?.trim())
        if (Array.isArray(patch.places)) next.places = patch.places.filter((place) => place?.name?.trim())
        if (Object.keys(next).length) actions.push({ type, blueprint: next })
        continue
      }
      if (type === 'replace-outline' && input.outline && typeof input.outline === 'object') {
        const outline = input.outline as StudioOutlinePatch
        const units = Array.isArray(outline.units)
          ? outline.units.filter((unit) => unit && typeof unit === 'object' && Math.round(num(unit.index, 0)) > 0)
          : []
        if (units.length) actions.push({ type, outline: { units, ...(Array.isArray(outline.scenes) && outline.scenes.length ? { scenes: outline.scenes } : {}) } })
        continue
      }
      if (type === 'update-chapter' && input.chapter && typeof input.chapter === 'object') {
        const chapter = { ...(input.chapter as StudioChapterPatch) }
        if (!chapterNumber && !str(input.chapterId)) continue
        if (chapter.content !== undefined) chapter.content = str(chapter.content)
        actions.push({ type, chapter, ...(chapterNumber ? { chapterNumber } : {}), ...(str(input.chapterId) ? { chapterId: str(input.chapterId) } : {}) })
        continue
      }
      if (type === 'rewrite-chapter') {
        const chapterId = str(input.chapterId) || project.chapters.find((chapter) => chapter.number === chapterNumber)?.id
        if (!chapterId) continue
        actions.push({ type, chapterId, instruction: str(input.instruction).slice(0, 1200) || str(input.reason).slice(0, 1200), ...(chapterNumber ? { chapterNumber } : {}) })
        continue
      }
      if (type === 'update-shot' && input.shot && typeof input.shot === 'object') {
        const shot = { ...(input.shot as StudioShotPatch) }
        const number = Math.round(num(shot.number, 0)) || shotNumber
        if (!number) continue
        if (shot.voiceId !== undefined) shot.voiceId = str(shot.voiceId).slice(0, 200)
        actions.push({ type, shot: { ...shot, number }, shotNumber: number, ...(shot.voiceId ? { voiceId: shot.voiceId } : {}) })
        continue
      }
      if (type === 'move-chapter') {
        const to = Math.round(num(input.to ?? input.position ?? input.toIndex, 0)) || undefined
        if ((!chapterNumber && !str(input.chapterId)) || !to) continue
        actions.push({ type, ...(chapterNumber ? { chapterNumber } : {}), ...(str(input.chapterId) ? { chapterId: str(input.chapterId) } : {}), to })
        continue
      }
      if (type === 'move-shot') {
        const to = Math.round(num(input.to ?? input.position ?? input.toIndex, 0)) || undefined
        if ((!shotNumber && !str(input.shotId)) || !to) continue
        actions.push({ type, ...(shotNumber ? { shotNumber } : {}), ...(str(input.shotId) ? { shotId: str(input.shotId) } : {}), to })
        continue
      }
      if (type === 'update-character' && input.character && typeof input.character === 'object') {
        const raw = input.character as Record<string, unknown>
        const name = str(raw.name).trim()
        if (!name) continue
        const patch: StudioCharacterPatch = { name }
        for (const key of ['newName', 'role', 'age', 'look', 'voiceId', 'desire', 'fear', 'secret', 'arc'] as const) {
          if (typeof raw[key] === 'string') patch[key] = str(raw[key]).trim()
        }
        if (Array.isArray(raw.relationships)) {
          patch.relationships = raw.relationships
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
            .filter((item) => str(item.target).trim())
            .map((item) => ({ target: str(item.target).trim(), label: str(item.label).trim() || '关系' }))
        }
        if (Array.isArray(raw.refAssetIds)) patch.refAssetIds = raw.refAssetIds.map((item) => str(item)).filter(Boolean)
        if (typeof raw.locked === 'boolean') patch.locked = raw.locked
        actions.push({ type, character: patch })
        continue
      }
      if (type === 'update-place' && input.place && typeof input.place === 'object') {
        const raw = input.place as Record<string, unknown>
        const name = str(raw.name).trim()
        if (!name) continue
        const patch: StudioPlacePatch = { name }
        if (typeof raw.newName === 'string') patch.newName = str(raw.newName).trim()
        if (typeof raw.description === 'string') patch.description = str(raw.description)
        if (Array.isArray(raw.refAssetIds)) patch.refAssetIds = raw.refAssetIds.map((item) => str(item)).filter(Boolean)
        actions.push({ type, place: patch })
        continue
      }
      if (type === 'rename-entity' && input.rename && typeof input.rename === 'object') {
        const rename = input.rename as StudioRenameRequest
        if (rename.target === 'character' || rename.target === 'place') {
          if (str(rename.from).trim() && str(rename.to).trim()) actions.push({ type, rename })
        }
        continue
      }
      if (type === 'remove-sfx') {
        const rawKind = str((input.sfx as Record<string, unknown> | undefined)?.kind)
        const kind = /雨|rain/i.test(rawKind) ? 'rain' : /心跳|heart/i.test(rawKind) ? 'heartbeat' : /伞|umbrella/i.test(rawKind) ? 'umbrella' : /街|车|环境|street/i.test(rawKind) ? 'street' : ''
        if (kind) actions.push({ type, sfx: { kind: kind as 'rain' | 'umbrella' | 'heartbeat' | 'street' } })
        continue
      }
      if (type === 'remove-music') {
        actions.push({ type })
        continue
      }
      if (type === 'generate-sfx' && input.sfx && typeof input.sfx === 'object') {
        const sfx = input.sfx as { kind?: string; seconds?: number }
        const rawKind = str(sfx.kind)
        const kind = /雨|rain/i.test(rawKind) ? 'rain' : /心跳|heart/i.test(rawKind) ? 'heartbeat' : /伞|umbrella/i.test(rawKind) ? 'umbrella' : /街|车|环境|street/i.test(rawKind) ? 'street' : ''
        if (kind) actions.push({ type, sfx: { kind: kind as 'rain' | 'umbrella' | 'heartbeat' | 'street', ...(num(sfx.seconds, 0) ? { seconds: Math.max(3, Math.min(30, Math.round(num(sfx.seconds, 8)))) } : {}) } })
        continue
      }
      if (type === 'generate-music') {
        const music = (input.music && typeof input.music === 'object' ? input.music : {}) as Record<string, unknown>
        actions.push({ type, music: { ...(str(music.mood) ? { mood: str(music.mood) } : {}), ...(num(music.seconds, 0) ? { seconds: Math.max(10, Math.min(300, Math.round(num(music.seconds, 60)))) } : {}), ...(music.engine === 'local' ? { engine: 'local' as const } : {}) } })
        continue
      }
      if (type === 'regenerate-shot-image' || type === 'regenerate-shot-video' || type === 'regenerate-voice') {
        const scope = type === 'regenerate-voice' && str(input.scope) === 'all' ? 'all' as const : undefined
        if (!scope && !shotNumber && !str(input.shotId)) continue
        actions.push({ type, ...(shotNumber ? { shotNumber } : {}), ...(str(input.shotId) ? { shotId: str(input.shotId) } : {}), ...(scope ? { scope } : {}), ...(str(input.voiceId) ? { voiceId: str(input.voiceId).slice(0, 200) } : {}), instruction: str(input.instruction).slice(0, 600) })
        continue
      }
      if (type === 'append-shots' && Array.isArray(input.shots)) {
        const shots = input.shots.filter((shot) => shot && typeof shot === 'object' && str((shot as Record<string, unknown>).title).trim())
        if (shots.length) actions.push({ type, shots: shots as StudioShotSeed[] })
      }
    }
    const unique = actions.filter((action, index, list) => {
      const key = `${action.type}:${action.shotNumber ?? action.chapterNumber ?? action.chapterId ?? action.shotId ?? action.rename?.from ?? action.character?.name ?? action.place?.name ?? ''}:${action.to ?? action.voiceId ?? ''}`
      return list.findIndex((item) => `${item.type}:${item.shotNumber ?? item.chapterNumber ?? item.chapterId ?? item.shotId ?? item.rename?.from ?? item.character?.name ?? item.place?.name ?? ''}:${item.to ?? item.voiceId ?? ''}` === key) === index
    })
    return unique
  }

  private revisionEffects(project: StudioProject, actions: StudioEditAction[]): string[] {
    const labelSfx: Record<string, string> = { rain: '雨声', umbrella: '伞骨', heartbeat: '心跳', street: '街声' }
    const short = (value: string, limit = 48): string => value.replace(/\s+/g, ' ').trim().slice(0, limit)
    const fieldLabel: Record<string, string> = {
      title: '标题',
      logline: '一句话',
      genre: '类型',
      tone: '语气',
      audience: '受众',
      storyCore: '故事核',
      emotion: '情绪',
      pitch: '故事提要',
      structure: '结构',
      styleBible: '风格',
      characters: '人物',
      places: '地点'
    }
    return actions.map((action) => {
      if (action.type === 'update-blueprint') {
        const patch = action.blueprint ?? {}
        const bits = Object.entries(patch).slice(0, 4).map(([key, value]) => {
          const label = fieldLabel[key] ?? key
          if (typeof value === 'string') return `${label}「${short(value)}」`
          if (Array.isArray(value)) return `${label} ${value.length} 项`
          return label
        })
        return `更新蓝图：${bits.join('；') || '故事内容'}`
      }
      if (action.type === 'replace-outline') {
        const units = action.outline?.units ?? []
        return `更新 ${units.length} 个大纲单元：${units.slice(0, 3).map((unit) => `第${unit.index}章《${short(unit.title ?? '', 24) || '未命名'}》：${short(unit.summary ?? '', 36) || '保持原样'}`).join('；')}${units.length > 3 ? '…' : ''}`
      }
      if (action.type === 'update-chapter') {
        const chapter = project.chapters.find((item) => item.id === action.chapterId || item.number === (action.chapterNumber ?? action.chapter?.number))
        const patch = action.chapter ?? {}
        const bits = [
          patch.title ? `标题「${short(patch.title, 30)}」` : '',
          patch.synopsis ? `梗概「${short(patch.synopsis, 40)}」` : '',
          patch.content ? `正文 ${countWords(patch.content)} 字` : '',
          patch.beats?.length ? `${patch.beats.length} 个节拍` : ''
        ].filter(Boolean)
        return `更新第 ${chapter?.number ?? action.chapterNumber ?? '?'} 章：${bits.join('；') || '章节信息'}`
      }
      if (action.type === 'rewrite-chapter') {
        const chapter = project.chapters.find((item) => item.id === action.chapterId)
        return `按计划重写第 ${chapter?.number ?? action.chapterNumber ?? '?'} 章正文：${short(action.instruction ?? '', 50)}`
      }
      if (action.type === 'update-shot') {
        const patch = action.shot ?? {}
        const bits = [
          patch.dialogue !== undefined ? `台词「${short(patch.dialogue, 36)}」` : '',
          patch.action ? `动作「${short(patch.action, 40)}」` : '',
          patch.camera ? `运镜「${short(patch.camera, 24)}」` : '',
          patch.title ? `标题「${short(patch.title, 24)}」` : '',
          patch.voiceId ? `声线「${short(patch.voiceId, 30)}」` : ''
        ].filter(Boolean)
        const voiceNote = patch.dialogue !== undefined || patch.speaker !== undefined || patch.voiceId ? '；并重配这一镜的配音' : ''
        return `更新第 ${action.shotNumber ?? patch.number ?? '?'} 镜：${bits.join('；') || '镜头文字'}${voiceNote}`
      }
      if (action.type === 'move-chapter') return `第 ${action.chapterNumber ?? '?'} 章移到第 ${action.to ?? '?'} 位`
      if (action.type === 'move-shot') return `第 ${action.shotNumber ?? '?'} 镜移到第 ${action.to ?? '?'} 位`
      if (action.type === 'update-character') {
        const character = action.character
        const bits = [
          character?.newName ? `改名「${character.newName}」` : '',
          character?.role ? `身份「${short(character.role, 20)}」` : '',
          character?.look ? '外观' : '',
          character?.voiceId ? `声线「${short(character.voiceId, 30)}」` : '',
          character?.desire ? '欲望' : '',
          character?.fear ? '恐惧' : ''
        ].filter(Boolean)
        return `更新人物「${character?.name ?? '?'}」：${bits.join('；') || '人物设定'}${character?.voiceId ? '；并重配该人物的所有台词' : ''}`
      }
      if (action.type === 'update-place') {
        const place = action.place
        return `更新地点「${place?.name ?? '?'}」${place?.newName ? `，并改名为「${place.newName}」` : ''}${place?.description ? `：${short(place.description, 40)}` : ''}`
      }
      if (action.type === 'rename-entity') return `${action.rename?.target === 'place' ? '地点' : '人物'}「${action.rename?.from}」改名为「${action.rename?.to}」`
      if (action.type === 'generate-sfx') return `生成音效：${labelSfx[action.sfx?.kind ?? 'rain'] ?? action.sfx?.kind}`
      if (action.type === 'generate-music') return '生成配乐'
      if (action.type === 'remove-sfx') return `移除音效：${labelSfx[action.sfx?.kind ?? 'rain'] ?? action.sfx?.kind}`
      if (action.type === 'remove-music') return '移除配乐'
      if (action.type === 'regenerate-shot-image') return `重做第 ${action.shotNumber ?? '?'} 镜画面`
      if (action.type === 'regenerate-shot-video') return `升级第 ${action.shotNumber ?? '?'} 镜为视频`
      if (action.type === 'regenerate-voice') return action.scope === 'all' ? `全片重配配音：${short(action.instruction ?? '', 40) || '按新要求'}` : `重做第 ${action.shotNumber ?? '?'} 镜配音${action.voiceId ? `（${short(action.voiceId, 24)}）` : ''}`
      if (action.type === 'append-shots') return `补全 ${action.shots?.length ?? 0} 镜`
      return '更新作品'
    })
  }

  private async planRevision(
    project: StudioProject,
    text: string,
    view: string,
    selection?: IntentContext['selection']
  ): Promise<{ plan: StudioEditPlan | null; reply: string; cost: number | null; costNote: string; model: string } | null> {
    const runtime = studioTextRuntime(project.runtime.strategy)
    if (!runtime.configured) return null
    const system = [
      '你是 Morrow 创作台的协作者。先理解用户在哪一步、想改什么，再把改动拆成可审阅、可撤销的计划。',
      '只输出一个合法 JSON，不要 Markdown、不要解释：{"reply":string,"actions":[...]}。',
      '动作规则：',
      '- 用户只是提问、讨论或要建议：actions 为空数组，reply 直接回答。',
      '- 改蓝图：{"type":"update-blueprint","blueprint":{只放要改的字段}}；不要重写未提到的字段。',
      '- 改大纲：{"type":"replace-outline","outline":{"units":[{index,title?,summary?,beats?,...}]}}；只放要改或新增的单元，index 必填；title/summary 可以只给一个，未提到的字段保持原样。',
      '- 改章节信息：{"type":"update-chapter","chapter":{number,title/synopsis/beats}}；不要用它改整章正文。',
      '- 改整章正文：{"type":"rewrite-chapter","chapter":{number},"instruction":"具体怎么改"}；不要输出整章正文。',
      '- 调整章节或正文顺序：{"type":"move-chapter","chapterNumber":原章号,"to":目标位置}；交换两章用两次动作，第二次带 chapterId 或新的 chapterNumber。',
      '- 调整镜头顺序：{"type":"move-shot","shotNumber":原镜号,"to":目标位置}；交换两镜用两次动作。',
      '- 改镜头文字：{"type":"update-shot","shot":{number,title/action/dialogue/camera/shotSize/seconds/speaker/continuity/prompt}}。',
      '- 改声线：{"type":"update-shot","shot":{"number":3,"voiceId":"qwen:serena"}}；会清空旧配音并排队重配。',
      '- 重配同一镜：{"type":"regenerate-voice","shotNumber":3,"instruction":"读得更冷/更慢"}；全片重配：{"type":"regenerate-voice","scope":"all","instruction":"..."}。',
      '- 改人物局部：{"type":"update-character","character":{"name":"现名","newName?":...,"voiceId?":...,"look?":...,"desire?":...}}；不要用 update-blueprint 重写整个人物表。',
      '- 改地点局部：{"type":"update-place","place":{"name":"现名","newName?":...,"description?":...}}。',
      '- 人物或地点改名：{"type":"rename-entity","rename":{"target":"character"|"place","from":"旧名","to":"新名"}}。',
      '- 加音效：{"type":"generate-sfx","sfx":{"kind":"rain"|"umbrella"|"heartbeat"|"street","seconds":数字}}；换配乐：{"type":"generate-music","music":{"mood":"情绪","seconds":数字}}。',
      '- 去掉音效：{"type":"remove-sfx","sfx":{"kind":"rain"|"umbrella"|"heartbeat"|"street"}}；去掉配乐：{"type":"remove-music"}。',
      '- 重做画面/视频：{"type":"regenerate-shot-image"|"regenerate-shot-video","shotNumber":数字,"instruction":"要求"}。',
      '- 补全新镜头：{"type":"append-shots","shots":[...]}；如果用户明确要补全分镜，优先建议在分镜页补全，避免与已有镜头重叠。',
      '- 不要生成 set-clip-* 等时间线动作；这些交给本地时间线指令。',
      '- 用户说“这一条/这个/它”时，优先使用快照里的当前选中项；没有选中项时用当前页面上下文推断，并在 reply 里说明对象。',
      '- 最多 12 个动作；只改用户要求的部分，保留未提到的人物、事实、素材和正文。',
      '- reply 用中文说清楚会改哪些地方、影响哪些下游；不要声称已经修改。',
      masterPromptContext(project.kind, 'assistant', text, view, project.runtime.strategy)
    ].join('\n')
    const prompt = [
      this.revisionSnapshot(project, view, selection),
      `用户说：${text}`,
      '请判断用户要改哪一步，并按上面的 JSON 契约给出计划。'
    ].join('\n\n')
    const result = await completeCreativeText({
      system,
      prompt,
      structured: true,
      temperature: 0.35,
      strategy: project.runtime.strategy
    })
    const parsed = extractJson<Record<string, unknown>>(result.text)
    if (!parsed) throw new Error('模型没有返回可解析的协作者计划。')
    const rawActions = Array.isArray(parsed.actions) ? parsed.actions : []
    const actions = this.normalizeRevisionActions(project, rawActions)
    const reply = str(parsed.reply).trim().slice(0, 4000)
    if (!actions.length) {
      return reply ? { plan: null, reply, cost: result.costCny, costNote: result.costNote ?? '按模型参考价折算', model: result.model } : null
    }
    const effects = this.revisionEffects(project, actions)
    const plan = createPlanFromDraft(project.id, {
      title: '协作者修改计划',
      summary: effects.join('；'),
      actions,
      effects,
      seconds: 0,
      cost: 0,
      note: result.costNote ?? '策划费用已记入本轮回复；确认后执行，生成任务会另行排队'
    })
    return {
      plan,
      reply: reply || `我整理了一个修改计划，先给你看；确认前不会改任何东西。\n${effects.map((effect) => `· ${effect}`).join('\n')}`,
      cost: result.costCny,
      costNote: result.costNote ?? '按模型参考价折算',
      model: result.model
    }
  }

  private async assistant(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const text = str(request.text).trim().slice(0, 4000)
    if (!text) throw new Error('先告诉我你想改什么。')
    const selectionRaw = request.selection && typeof request.selection === 'object' ? (request.selection as Record<string, unknown>) : null
    const selection =
      selectionRaw && typeof selectionRaw.kind === 'string' && typeof selectionRaw.id === 'string' && ['chapter', 'shot', 'clip'].includes(selectionRaw.kind)
        ? { kind: selectionRaw.kind as 'chapter' | 'shot' | 'clip', id: selectionRaw.id }
        : undefined
    const sources = assistantSources(project, selection)
    if (!selection && detectStoryboardExtension(text)) {
      project.messages.push(assistantMessage('user', text))
      try {
        const extension = await this.planStoryboardExtension(project, text)
        project.messages.push(assistantMessage('assistant', extension.reply, extension.plan, sources))
        project.messages = project.messages.slice(-80)
        this.charge(project, extension.cost)
        project.runtime.textModelNote = extension.model
        project.stage = 'storyboard'
        this.store.save(project, '协作者补全分镜计划', { snapshot: false })
        this.emitProject(project)
        return this.result(project, { plan: extension.plan, message: extension.costNote })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        project.messages.push(assistantMessage('assistant', `补全分镜还没有写入：${reason}。现有分镜、大纲和蓝图都没有改动。`, undefined, sources))
        project.messages = project.messages.slice(-80)
        this.store.save(project, '协作者补全分镜未完成', { snapshot: false })
        this.emitProject(project)
        return this.result(project, { message: reason })
      }
    }
    const wantsCheck = /检查|审稿|连续性|缺失素材/.test(text) && !/慢|快|压低|调大|改|重做|生成|写|导出|合成/.test(text)
    if (wantsCheck) {
      const checks = runChecks(project)
      project.checks = checks
      const errors = checks.filter((check) => check.level === 'error')
      const warns = checks.filter((check) => check.level === 'warn')
      project.stages.review = {
        status: errors.length || warns.length ? 'review' : 'done',
        updatedAt: nowMs(),
        message: errors.length ? `${errors.length} 个问题需要处理` : warns.length ? `${warns.length} 条提醒` : '检查通过',
        progress: errors.length || warns.length ? 60 : 100
      }
      project.messages.push(assistantMessage('user', text))
      const summary = [
        errors.length || warns.length
          ? `检查完成：${errors.length} 个错误、${warns.length} 条提醒。`
          : '检查完成：没有发现硬问题。',
        ...[...errors, ...warns].slice(0, 6).map((check) => `· ${check.title}：${check.detail}`),
        errors.length || warns.length ? '要我按这些问题给出修改计划吗？我会先预览，确认后再改。' : '可以继续下一步，或让我给一个更细的润色建议。'
      ].join('\n')
      project.messages.push(assistantMessage('assistant', summary, undefined, sources))
      project.messages = project.messages.slice(-80)
      project.stage = 'review'
      this.store.save(project, '助手运行检查', { snapshot: false })
      this.emitProject(project)
      return this.result(project, { message: '检查结果已写入作品。' })
    }
    const draft = draftEditPlan(project, text, selection ? { selection } : {})
    const plan = createPlanFromDraft(project.id, draft)
    const view = str(request.view) || project.stage
    project.messages.push(assistantMessage('user', text))
    let reply = localAssistantReply(project, text, plan)
    let messagePlan: StudioEditPlan | undefined = plan.actions.length ? plan : undefined
    let cost: number | null = 0
    let costNote = '本地策划，不调用模型'
    const runtime = studioTextRuntime(project.runtime.strategy)
    let modelUsed = false
    const limit = project.runtime.budget.limit
    const planEstimate = estimateTextCostCny(text.length + 9000, 4000, project.runtime.strategy) ?? 0
    const budgetBlocked = limit > 0 && project.runtime.budget.spent + planEstimate > limit
    if (plan.actions.length === 0 && runtime.configured && !budgetBlocked) {
      try {
        const revision = await this.planRevision(project, text, view, selection)
        if (revision) {
          reply = { text: revision.reply, plan }
          messagePlan = revision.plan ?? undefined
          cost = revision.cost
          costNote = revision.costNote
          modelUsed = true
        }
      } catch (err) {
        log.warn('studio collaborator plan failed', { message: err instanceof Error ? err.message : String(err) })
      }
    }
    if (!modelUsed && plan.actions.length === 0 && runtime.configured && !budgetBlocked) {
      const estimate = estimateTextCostCny(text.length + 1200, 1200, project.runtime.strategy) ?? 0
      if (limit > 0 && project.runtime.budget.spent + estimate > limit) {
        cost = 0
        costNote = `预算不足，本轮只给本地建议（预计需 ¥${estimate.toFixed(2)}，预算上限 ¥${limit}）`
      } else {
        try {
          const result = await completeCreativeText({
            system: `${assistantSystemPrompt(project.kind)}${masterPromptContext(project.kind, 'assistant', text, view, project.runtime.strategy)}`,
            prompt: `${contextForAssistant(project, selection, view)}\n\n用户说：${text}\n\n请直接回答，并给出下一步可执行建议。不要声称已经修改了作品。`,
            continueOnTruncate: true,
            temperature: 0.7,
            strategy: project.runtime.strategy
          })
          reply = { text: result.text, plan }
          messagePlan = undefined
          cost = result.costCny
          costNote = result.costNote ?? '按模型参考价折算'
        } catch {
          // 模型失败时保留本地可执行提示
        }
      }
    }
    project.messages.push(assistantMessage('assistant', reply.text, messagePlan, sources))
    project.messages = project.messages.slice(-80)
    this.charge(project, cost)
    project.runtime.textModelNote = runtime.configured ? runtime.model?.label : '未连接模型'
    this.store.save(project, '协作者回复', { snapshot: false })
    this.emitProject(project)
    return this.result(project, { ...(messagePlan ? { plan: messagePlan } : {}), message: costNote })
  }

  private async applyPlan(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const planId = str(request.planId)
    const project = this.store.readProject(projectId)
    let plan: StudioEditPlan | null = null
    for (const message of project.messages) {
      if (message.plan?.id === planId) plan = message.plan
    }
    if (!plan) throw new Error('找不到这个修改计划。')
    if (plan.status !== 'pending') throw new Error('这个计划已经处理过了。')
    if (!plan.actions.length) throw new Error('这个计划没有可执行的修改，已阻止应用。请让协作者给出具体镜头或动作。')
    this.assertBudget(project, plan.estimate.cost)
    const undoFile = this.store.writeVersion(project, `应用修改计划前：${plan.title}`)
    plan.undoVersion = basename(undoFile)
    const applied = applyEditPlan(project, plan)
    project.stage = applied.stage ?? (applied.storyboardChanged ? 'storyboard' : applied.timelineChanged ? 'timeline' : project.stage)
    this.store.save(project, `应用修改计划：${plan.title}`, { snapshot: false })
    plan.appliedRevision = project.revision
    this.store.savePassive(project)
    this.emitProject(project)
    let firstJob: StudioJob | undefined
    const queueErrors: string[] = []
    for (const action of applied.regenerate) {
      try {
        let result: StudioActionResult
        if (action.kind === 'chapter') {
          if (!action.chapterId) continue
          result = await this.polishChapter({ projectId, chapterId: action.chapterId, instruction: action.instruction, replaceContent: true })
        } else if (action.kind === 'sfx') {
          if (!action.sfxKind) continue
          result = await this.generateMusic({ projectId, kind: action.sfxKind, ...(action.seconds ? { seconds: action.seconds } : {}), requestId: `plan-sfx-${Date.now()}` })
        } else if (action.kind === 'music') {
          result = await this.generateMusic({
            projectId,
            kind: 'music',
            ...(action.mood ? { mood: action.mood } : {}),
            ...(action.seconds ? { seconds: action.seconds } : {}),
            ...(action.engine ? { engine: action.engine } : {}),
            requestId: `plan-music-${Date.now()}`
          })
        } else if (action.kind === 'voice') {
          if (action.shotIds?.length) {
            result = await this.generateVoice({
              projectId,
              shotIds: action.shotIds,
              ...(action.voiceId ? { voiceId: action.voiceId } : {}),
              ...(action.instruction ? { instruction: action.instruction } : {})
            })
          } else {
            const shot = project.shots.find((item) => item.id === action.shotId)
            if (!shot) continue
            result = await this.generateVoice({
              projectId,
              shotId: shot.id,
              ...(action.voiceId ? { voiceId: action.voiceId } : {}),
              ...(action.instruction ? { instruction: action.instruction } : {})
            })
          }
        } else {
          const shot = project.shots.find((item) => item.id === action.shotId)
          if (!shot) continue
          if (action.kind === 'image') {
            result = await this.generateShotImage({ projectId, shotId: shot.id, instruction: action.instruction })
          } else {
            result = await this.generateShotVideo({ projectId, shotId: shot.id, instruction: action.instruction })
          }
        }
        firstJob = firstJob ?? result.job
      } catch (err) {
        queueErrors.push(err instanceof Error ? err.message : String(err))
      }
    }
    const latest = this.store.readProject(projectId)
    return this.result(latest, { plan, ...(firstJob ? { job: firstJob } : {}), message: queueErrors.length ? `计划已应用，但有 ${queueErrors.length} 个重做任务未能排队：${queueErrors.join('；')}` : applied.chapterCandidates ? `已生成 ${applied.chapterCandidates} 个候选稿，采用前不改正文。` : undefined })
  }

  private cancelPlan(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      for (const message of project.messages) {
        if (message.plan?.id === str(request.planId)) message.plan.status = 'cancelled'
      }
      this.store.save(project, '取消修改计划', { snapshot: false })
      return project
    })
  }

  private undoPlan(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    const planId = str(request.planId)
    let plan: StudioEditPlan | null = null
    for (const message of project.messages) {
      if (message.plan?.id === planId) plan = message.plan
    }
    if (!plan) throw new Error('找不到这个修改计划。')
    if (plan.status !== 'applied') throw new Error('只有已应用的修改计划可以撤销。')
    if (!plan.undoVersion) throw new Error('这个计划没有可用的撤销快照。')
    if (plan.appliedRevision && project.revision !== plan.appliedRevision) {
      throw new Error('应用之后作品又有新的修改，不能整体撤销；请在版本记录里选择要恢复的版本。')
    }
    const activeJobs = project.jobs.filter((job) => (job.status === 'running' || job.status === 'queued') && (job.createdAt >= (plan.appliedAt ?? 0)))
    if (activeJobs.length) throw new Error('计划还在排队或执行任务，先取消这些任务再撤销。')
    const file = join(this.store.versionsDir(projectId), plan.undoVersion)
    if (!existsSync(file)) throw new Error('撤销快照已经不在本机，无法撤销。')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as StudioProject
    const restored = this.store.normalizeProject(raw)
    for (const message of restored.messages) {
      if (message.plan?.id === planId) message.plan.status = 'undone'
    }
    restored.messages.push({
      id: studioId('msg'),
      role: 'system',
      text: `已撤销修改计划「${plan.title}」。撤销前的状态仍保留在版本记录里。`,
      createdAt: nowMs()
    })
    this.store.save(restored, `撤销修改计划：${plan.title}`, { snapshot: true })
    this.emitProject(restored)
    return this.result(restored)
  }

  private cancelJob(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    const jobId = str(request.jobId)
    this.cancelled.add(jobId)
    const controller = this.controllers.get(jobId)
    if (controller) controller.abort()
    const project = this.store.readProject(projectId)
    const job = project.jobs.find((item) => item.id === jobId)
    if (job && (job.status === 'queued' || job.status === 'running')) {
      job.status = 'cancelled'
      job.message = '已取消；已完成的内容保留。'
      job.updatedAt = nowMs()
      job.finishedAt = nowMs()
      this.store.savePassive(project)
      this.emitJob(job)
      this.emitProject(project)
    }
    return this.result(project)
  }

  /** 让 Agent 也能读到任务列表与最近状态。 */
  private listJobs(request: { [key: string]: unknown }): { jobs: StudioJob[] } {
    const project = this.store.readProject(safeProjectId(str(request.projectId)))
    return { jobs: [...project.jobs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50) }
  }

  private updateRuntime(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      if (typeof request.strategy === 'string' && ['local-first', 'cloud-first', 'local-only', 'cloud-only'].includes(request.strategy)) {
        project.runtime.strategy = request.strategy as StudioProject['runtime']['strategy']
      }
      if (request.budget && typeof request.budget === 'object') {
        const budget = request.budget as Record<string, unknown>
        project.runtime.budget = {
          limit: Math.max(0, num(budget.limit, project.runtime.budget.limit)),
          spent: Math.max(0, num(budget.spent, project.runtime.budget.spent)),
          currency: 'CNY'
        }
      }
      if (request.tts && typeof request.tts === 'object') {
        const tts = request.tts as Record<string, unknown>
        project.runtime.tts = {
          mode: tts.mode === 'cloud' ? 'cloud' : 'system',
          model: str(tts.model).slice(0, 120) || 'tts-1',
          voice: str(tts.voice).slice(0, 120)
        }
      }
      project.runtime.updatedAt = nowMs()
      this.store.save(project, '更新模型与预算', { snapshot: false })
      return project
    })
  }

}

const BLUEPRINT_SYSTEM = `你是资深中文故事策划。根据用户给出的故事灵感，生成可直接执行的创作蓝图。
只输出一个合法 JSON 对象，不要 Markdown、不要解释。字段：
{"title":string,"genre":string,"tone":string,"audience":string,
"storyCore":string,"emotion":string,"pitch":string,"structure":string,
"characters":[{"name":string,"role":string,"age":string,"look":string,"desire":string,"fear":string,"secret":string,"arc":string,"relationships":[{"target":string,"label":string}]}],
"places":[{"name":string,"description":string}],
"facts":[{"subject":string,"predicate":string,"object":string}],
"volumes":[{"title":string,"summary":string,"unitStart":number,"unitEnd":number}],
"scenes":[{"title":string,"synopsis":string,"location":string,"timeOfDay":string,"characters":string[],"unitStart":number,"unitEnd":number}],
"units":[{"index":number,"title":string,"summary":string,"wordTarget":number,"seconds":number,"camera":string,"shotSize":string,"dialogue":string,"speaker":string,"beats":string[]}],
"styleBible":{"look":string,"palette":string[],"camera":string,"sound":string,"negative":string[]}}
中短篇/长篇用 wordTarget 和 beats，卷数 1 或 3；漫剧用 seconds/camera/shotSize/dialogue/speaker，并给出覆盖全部镜头的 scenes。只写简体中文。
控制篇幅，保证 JSON 完整：storyCore 不超过 240 字，pitch 不超过 320 字，structure 不超过 240 字；每个 unit 的 summary 不超过 180 字；每个角色的 look 不超过 160 字。`

const LONG_BLUEPRINT_TOP_SYSTEM = `你是资深中文长篇小说策划。根据用户灵感写长篇骨架。
只输出一个合法 JSON 对象，不要 Markdown、不要解释。字段：
{"title":string,"genre":string,"tone":string,"audience":string,
"storyCore":string,"emotion":string,"pitch":string,"structure":string,
"facts":[{"subject":string,"predicate":string,"object":string}],
"volumes":[{"title":string,"summary":string,"unitStart":number,"unitEnd":number}],
"styleBible":{"look":string,"palette":string[],"camera":string,"sound":string,"negative":string[]}}
不要输出 characters、places、units；人物与章节会另行生成。计划 3 卷，volumes 覆盖全书章节范围。只写简体中文。`

const LONG_BLUEPRINT_CAST_SYSTEM = `你是中文长篇小说人物编辑。只输出一个合法 JSON 对象：
{"characters":[{"name":string,"role":string,"age":string,"look":string,"desire":string,"fear":string,"secret":string,"arc":string,"relationships":[{"target":string,"label":string}]}],
"places":[{"name":string,"description":string}]}
3–6 个具体人物，3–6 个有空间质感的地点。只写简体中文，不要输出其他字段。`

const LONG_BLUEPRINT_UNITS_SYSTEM = `你是中文长篇小说结构编辑。只输出一个合法 JSON 对象：
{"units":[{"index":number,"title":string,"summary":string,"wordTarget":number,"beats":string[]}]}
每章 3–5 个具体节拍；只写本卷章节，不要输出其他字段。只写简体中文。
控制篇幅，保证 JSON 完整：summary 不超过 160 字，每条 beat 不超过 80 字；先保证本批章节全部输出，再补细节。`

const OUTLINE_SYSTEM = `你是中文故事结构编辑。只输出一个合法 JSON：{"units":[...]}。
中短篇/长篇每项 {"index":number,"title":string,"summary":string,"wordTarget":number,"beats":string[]}（beats 写 3–5 个具体节拍）；
漫剧每项 {"index":number,"title":string,"summary":string,"seconds":number,"camera":string,"shotSize":string,"dialogue":string,"speaker":string}。
保持原有人物与设定，不要引入未经要求的新主角。只写中文。`

const STORYBOARD_SYSTEM = `你是中文漫剧分镜导演。根据已确认的蓝图和镜头计划，输出可直接拍摄的分镜表。
只输出一个合法 JSON 对象，不要 Markdown、不要解释。字段：
{"scenes":[{"title":string,"synopsis":string,"location":string,"timeOfDay":string,"characters":string[],"unitStart":number,"unitEnd":number,"sourceChapter":number}],
"shots":[{"number":number,"sceneIndex":number,"title":string,"action":string,"camera":string,"shotSize":string,"seconds":number,"dialogue":string,"speaker":string,"continuity":string,"prompt":string,"negative":string}]}
要求：保留已确认的人物、地点、故事核与风格，不增加新主角；每镜 action 写清楚可见的动作与事件，camera 写运镜，shotSize 写景别，seconds 3–20；dialogue 只写角色真正说出口的话，speaker 必须是已有人物或“旁白”；continuity 写与上一镜的衔接；prompt 写画面提示词（人物外观、环境、光线、构图），不要文字水印；scenes 覆盖全部镜头，unitStart/unitEnd 使用镜头号；如果输入里有原著章节，每场用 sourceChapter 标注来源章节号。只写简体中文。`

const PROSE_SYSTEM = `你是中文小说作者，按本次加载的大师方法写作。只输出正文，不要标题、不要 Markdown、不要解释、不要写“本章完”。
严格延续已有人物设定与前文，不改名、不换视角。`

function briefLines(project: StudioProject): string[] {
  const parsed = previewBrief(project.logline, project.kind)
  return [
    project.brief.genre ? `故事类型：${project.brief.genre}` : '',
    project.brief.audience ? `目标受众：${project.brief.audience}` : '',
    project.brief.tone ? `整体语气：${project.brief.tone}` : '',
    project.brief.style ? `画面/文字风格：${project.brief.style}` : '',
    `制作精细度：${project.brief.form}`,
    project.brief.constraints.length ? `硬性要求：${project.brief.constraints.join('；')}` : '',
    parsed.subject ? `从一句话里读到的主角：${parsed.subject}` : '',
    parsed.goal ? `从一句话里读到的欲望：${parsed.goal}` : '',
    parsed.obstacle ? `从一句话里读到的阻力：${parsed.obstacle}` : '',
    parsed.turn ? `从一句话里读到的转折：${parsed.turn}` : ''
  ].filter(Boolean)
}

function blueprintPrompt(project: StudioProject): string {
  const target = project.kind === 'drama'
    ? `${project.brief.targetSeconds ?? 96} 秒`
    : `${project.brief.targetWords ?? (project.kind === 'short' ? 30_000 : 300_000)} 字`
  return [
    `作品形态：${studioKindLabel(project.kind)}`,
    `用户灵感：${project.logline}`,
    `目标：${target}`,
    `画面比例：${project.brief.aspect}`,
    ...briefLines(project),
    project.kind === 'short'
      ? '按每章 2500–3500 字规划章节数，units 总字数必须接近目标字数；不要只给 6 章。'
      : ''
  ].filter(Boolean).join('\n')
}

function longBlueprintTopPrompt(project: StudioProject, plannedUnits: number): string {
  const targetWords = project.brief.targetWords ?? 300_000
  return [
    `用户灵感：${project.logline}`,
    `作品形态：长篇`,
    `目标：约 ${targetWords} 字，计划 ${plannedUnits} 章、3 卷`,
    ...briefLines(project),
    `只根据用户灵感写长篇骨架；facts、volumes、styleBible 与故事主线一致。`
  ].filter(Boolean).join('\n')
}

function longBlueprintCastPrompt(project: StudioProject, blueprint: StudioBlueprint): string {
  return [
    `用户灵感：${project.logline}`,
    `故事核：${blueprint.storyCore}`,
    `结构：${blueprint.structure}`,
    `分卷：${(blueprint.volumes ?? []).map((volume) => `${volume.title}：${volume.summary}`).join('；')}`,
    '写能支撑这条主线的 3–6 个具体人物与 3–6 个地点。'
  ].join('\n')
}

function longVolumeUnitsPrompt(project: StudioProject, blueprint: StudioBlueprint, volume: NonNullable<StudioBlueprint['volumes']>[number], count: number): string {
  return [
    `用户灵感：${project.logline}`,
    `故事核：${blueprint.storyCore}`,
    `人物：${blueprint.characters.map((character) => `${character.name}（${character.role}）：${character.desire ?? ''}`).join('；')}`,
    `本卷：第 ${volume.unitStart}–${volume.unitEnd} 章《${volume.title}》：${volume.summary}`,
    `请写本卷约 ${count} 章，标题具体，梗概推进主线，每章给出 3–5 个节拍，单章目标 2000–5000 字。`
  ].join('\n')
}

function outlinePrompt(project: StudioProject, blueprint: StudioBlueprint): string {
  return [
    `作品：${project.title}（${studioKindLabel(project.kind)}）`,
    `故事核：${blueprint.storyCore}`,
    `人物：${project.characters.map((character) => `${character.name}（${character.role}）：${character.look}`).join('；')}`,
    `现有结构：${blueprint.structure}`,
    `现有单位：${JSON.stringify(blueprint.units.slice(0, 36))}`,
    project.kind === 'drama' ? '请保留人物与核心道具，重写或细化每个镜头的动作、景别、运镜与台词；不要增加新主角。' : '请保留人物与核心道具，重写或细化章名与每章梗概；不要增加新主角。'
  ].join('\n')
}

function outlineBatchPrompt(project: StudioProject, blueprint: StudioBlueprint, batch: StudioBlueprint['units'], start: number, total: number): string {
  return [
    `作品：${project.title}（${studioKindLabel(project.kind)}）`,
    `故事核：${blueprint.storyCore}`,
    `人物：${project.characters.map((character) => `${character.name}（${character.role}）：${character.look}`).join('；')}`,
    `全书结构：${blueprint.structure}`,
    `全书章节：${blueprint.units.map((unit, index) => `${index + 1}. ${unit.title}`).join('；')}`,
    `本书共 ${total} 章；本批只细化第 ${start + 1}–${start + batch.length} 章。现有字段：${JSON.stringify(batch)}`,
    '请只输出本批 units 的 JSON 数组；index 使用全局章号；保留原人物与核心道具，不增加新主角；每章 3–5 个具体节拍；summary 不超过 180 字。只输出 JSON。'
  ].join('\n\n')
}

function storyboardPrompt(project: StudioProject, blueprint: StudioBlueprint, locked: boolean, instruction: string): string {
  const existing = [...project.shots].sort((left, right) => left.number - right.number)
  const characters = project.characters.slice(0, 8).map((character) => `${character.name}（${character.role}${character.look ? `：${character.look.slice(0, 160)}` : ''}）`)
  const places = project.places.slice(0, 8).map((place) => `${place.name}：${place.description.slice(0, 160)}`)
  return [
    `作品：${project.title}（漫剧）`,
    `一句话：${project.logline}`,
    `故事核：${blueprint.storyCore}`,
    `情绪与风格：${blueprint.emotion}；${blueprint.styleBible.look}`,
    `人物：${characters.join('；')}`,
    `地点：${places.join('；')}`,
    existing.length
      ? `当前镜头计划（${existing.length} 镜）：${JSON.stringify(existing.map((shot) => ({
          number: shot.number,
          title: shot.title,
          action: shot.action,
          camera: shot.camera,
          shotSize: shot.shotSize,
          seconds: shot.durationSec,
          dialogue: shot.dialogue,
          speaker: shot.speaker
        })))}`
      : '',
    `已确认场景：${JSON.stringify(blueprint.scenes ?? [])}`,
    project.chapters.length
      ? `原著章节（改编为漫剧时保留来源）：${project.chapters
          .slice(0, 12)
          .map((chapter) => `第 ${chapter.number} 章《${chapter.title}》：${(chapter.synopsis || chapter.content.replace(/\s+/g, ' ')).slice(0, 500)}`)
          .join('\n')}`
      : '',
    locked
      ? `这部作品已有 ${existing.length} 镜画面/配音素材；必须输出同样 ${existing.length} 镜，不能增减镜头。`
      : '请输出 6–30 镜，按故事顺序拆分；镜头数量可以少于当前计划，但必须覆盖完整故事。',
    instruction ? `用户补充要求：${instruction}` : '',
    '只输出 JSON。'
  ].filter(Boolean).join('\n\n')
}

function summarizeChapterText(content: string): string {
  const sentences = content
    .replace(/\s+/g, ' ')
    .split(/[。！？!?…]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4)
  if (!sentences.length) return ''
  const head = sentences.slice(0, 2).join('。')
  const tail = sentences.length > 2 ? sentences[sentences.length - 1] : ''
  return `${head}。${tail && tail !== sentences[1] ? `${tail}。` : ''}`.slice(0, 220)
}

function chapterPrompt(project: StudioProject, chapter: StudioChapter, instruction: string): string {
  const sorted = [...project.chapters].sort((a, b) => a.number - b.number)
  const index = sorted.findIndex((item) => item.id === chapter.id)
  const previous = index > 0 ? sorted[index - 1] : null
  const recent = sorted.slice(Math.max(0, index - 3), index)
  const volume = project.volumes.find((item) => item.id === chapter.volumeId)
  const facts = project.facts
    .filter((fact) => !fact.chapterId || fact.chapterId === chapter.id || fact.chapterId === previous?.id)
    .slice(0, 24)
    .map((fact) => `${fact.subject}${fact.predicate}${fact.object}`)
  return [
    `作品：${project.title}`,
    `一句话：${project.logline}`,
    `类型与语气：${project.brief.genre}；${project.brief.tone}`,
    project.blueprint?.storyCore ? `故事核：${project.blueprint.storyCore}` : '',
    volume ? `本卷目标：${volume.title} · ${volume.summary}` : '',
    `人物：${project.characters.slice(0, 8).map((item) => `${item.name}（${item.role}）：${item.look}`).join('；')}`,
    `本章：第 ${chapter.number} 章《${chapter.title}》`,
    `本章梗概：${chapter.synopsis}`,
    `本章节拍：${chapter.beats.join(' / ') || chapter.synopsis}`,
    `目标字数：约 ${chapter.wordTarget} 字（可上下浮动 15%）`,
    previous ? `上一章结尾：\n${previous.content.slice(-900)}` : '',
    previous ? `上一章梗概：${previous.synopsis}` : '',
    recent.length ? `前情摘要：\n${recent.map((item) => `第 ${item.number} 章《${item.title}》：${item.summary || item.synopsis}`).join('\n')}` : '',
    `人物事实：\n${facts.join('\n')}`,
    project.brief.constraints.length ? `硬约束：${project.brief.constraints.join('；')}` : '',
    instruction ? `用户额外要求：${instruction}` : '',
    '只输出这一章正文。'
  ]
    .filter(Boolean)
    .join('\n\n')
}

function stripProseDecorations(text: string): string {
  let value = text.trim()
  value = value.replace(/^```(?:markdown|text)?\s*/i, '').replace(/```$/i, '').trim()
  value = value.replace(/^#+\s*第\s*\d+\s*章.*\n+/, '')
  value = value.replace(/^第\s*\d+\s*章[^\n]*\n+/, '')
  value = value.replace(/^本章完\s*$/gm, '')
  return value.trim()
}

interface RawCharacter {
  name?: unknown
  role?: unknown
  age?: unknown
  look?: unknown
  desire?: unknown
  fear?: unknown
  secret?: unknown
  arc?: unknown
  relationships?: unknown
}

function blueprintEstimate(project: StudioProject, units: StudioBlueprint['units']): StudioBlueprint['estimate'] {
  const words = units.reduce((sum, unit) => sum + (unit.wordTarget ?? 0), 0)
  const seconds = units.reduce((sum, unit) => sum + (unit.seconds ?? 0), 0)
  if (project.kind === 'drama') {
    const minutes = Math.max(1, Math.round((seconds || project.brief.targetSeconds || 96) / 60))
    const textCost = estimateTextCostCny(3000, units.length * 500, project.runtime.strategy)
    return {
      minutesMin: Math.max(1, Math.round(minutes * 0.7)),
      minutesMax: Math.round(minutes * 1.8),
      costMin: textCost,
      costMax: textCost,
      currency: 'CNY',
      lines: [
        { label: '蓝图 / 剧本 / 分镜', costMin: textCost, costMax: textCost, note: '按当前文本模型参考价' },
        { label: '画面 / 配音 / 配乐', costMin: null, costMax: null, note: '取决于本机引擎或云端服务，按任务记录' }
      ],
      basis: 'mixed',
      note: '时间按逐镜时长与返工估算；实际以任务记录为准。'
    }
  }
  const totalWords = words || project.brief.targetWords || 30_000
  const cost = estimateTextCostCny(totalWords * 0.5, totalWords * 1.25, project.runtime.strategy)
  return {
    minutesMin: Math.max(10, Math.round((totalWords / 500) * 0.5)),
    minutesMax: Math.max(20, Math.round((totalWords / 400) * 1.4)),
    costMin: cost,
    costMax: cost,
    currency: 'CNY',
    lines: [
      { label: '蓝图与章纲', costMin: cost === null ? null : Math.round(cost * 0.06 * 1000) / 1000, costMax: cost === null ? null : Math.round(cost * 0.1 * 1000) / 1000, note: '按当前文本模型参考价' },
      { label: '正文写作', costMin: cost === null ? null : Math.round(cost * 0.75 * 1000) / 1000, costMax: cost === null ? null : Math.round(cost * 0.9 * 1000) / 1000, note: `目标约 ${totalWords.toLocaleString('zh-CN')} 字` },
      { label: '审稿与返工', costMin: cost === null ? null : Math.round(cost * 0.04 * 1000) / 1000, costMax: cost === null ? null : Math.round(cost * 0.12 * 1000) / 1000, note: '按一次模型审稿与局部返工估算' }
    ],
    basis: 'mixed',
    note: '按当前文本模型参考价与目标字数估算；实际以任务记录和账单为准。'
  }
}

function neutralBlueprint(project: StudioProject): StudioBlueprint {
  return {
    approved: false,
    source: 'model',
    genre: project.brief.genre,
    tone: project.brief.tone,
    storyCore: project.logline,
    emotion: project.brief.tone,
    audience: project.brief.audience,
    pitch: project.logline,
    structure: '',
    styleBible: {
      look: project.brief.style.trim(),
      palette: [],
      camera: '',
      sound: '',
      negative: ['文字水印', '前后不一的服装', '塑料质感', '过度锐化'],
      updatedAt: nowMs()
    },
    characters: [],
    places: [],
    units: [],
    estimate: {
      minutesMin: 0,
      minutesMax: 0,
      costMin: null,
      costMax: null,
      currency: 'CNY',
      lines: [],
      basis: 'unknown',
      note: '费用按任务实际 token 记录。'
    },
    warnings: [],
    createdAt: nowMs()
  }
}

function normalizeModelBlueprint(project: StudioProject, raw: Record<string, unknown>, model: string, fallback: StudioBlueprint): StudioBlueprint {
  const charactersRaw = Array.isArray(raw.characters) ? (raw.characters as RawCharacter[]) : []
  const characters = charactersRaw.slice(0, 8).map((item) => ({
    id: studioId('char'),
    name: str(item.name).slice(0, 80) || '未命名角色',
    role: str(item.role).slice(0, 100) || '角色',
    ...(str(item.age) ? { age: str(item.age).slice(0, 40) } : {}),
    look: str(item.look).slice(0, 1000) || '外观尚未填写',
    ...(str(item.desire) ? { desire: str(item.desire).slice(0, 500) } : {}),
    ...(str(item.fear) ? { fear: str(item.fear).slice(0, 500) } : {}),
    ...(str(item.secret) ? { secret: str(item.secret).slice(0, 500) } : {}),
    ...(str(item.arc) ? { arc: str(item.arc).slice(0, 800) } : {}),
    relationships: Array.isArray(item.relationships)
      ? item.relationships
          .filter((rel): rel is Record<string, unknown> => Boolean(rel) && typeof rel === 'object')
          .map((rel) => ({ target: str(rel.target).slice(0, 80), label: str(rel.label).slice(0, 200) }))
          .filter((rel) => rel.target)
      : [],
    refAssetIds: []
  }))
  const placesRaw = Array.isArray(raw.places) ? raw.places : []
  const places = placesRaw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .slice(0, 10)
    .map((item) => ({ id: studioId('place'), name: str(item.name).slice(0, 100) || '未命名地点', description: str(item.description).slice(0, 1000), refAssetIds: [] }))
  const units = normalizeUnits(project.kind, raw.units, [], {
    look: '',
    palette: [],
    camera: '',
    sound: '',
    negative: [],
    updatedAt: nowMs()
  })
  const styleRaw = raw.styleBible && typeof raw.styleBible === 'object' ? (raw.styleBible as Record<string, unknown>) : {}
  const neutralStyle = project.brief.style.trim() || '与故事的时代、地域和人物处境一致的写实影像质感'
  const styleBible = {
    look: str(styleRaw.look).slice(0, 1000) || neutralStyle,
    palette: Array.isArray(styleRaw.palette) ? arrayOfStrings(styleRaw.palette).slice(0, 8) : [],
    camera: str(styleRaw.camera).slice(0, 800) || '固定镜头与缓慢推近为主，关键处一次跟随；不频繁切镜',
    sound: str(styleRaw.sound).slice(0, 800) || '环境声先行；配乐只在高潮与留白处出现',
    negative: Array.isArray(styleRaw.negative)
      ? arrayOfStrings(styleRaw.negative).slice(0, 12)
      : ['文字水印', '前后不一的服装', '塑料质感', '过度锐化'],
    updatedAt: nowMs()
  }
  const genre = str(raw.genre).slice(0, 80) || fallback.genre || ''
  const tone = str(raw.tone).slice(0, 120) || fallback.tone || ''
  const audience = str(raw.audience).slice(0, 400) || fallback.audience || ''
  const title = str(raw.title).trim()
  if (title && project.titleSource !== 'user') {
    project.title = title.slice(0, 120)
    project.titleSource = 'model'
  }
  const storyCore = str(raw.storyCore).slice(0, 2000)
  const pitch = str(raw.pitch).slice(0, 1000)
  const structure = str(raw.structure).slice(0, 600)
  const totalSeconds = units.reduce((sum, unit) => sum + (unit.seconds ?? 8), 0)
  const facts = normalizeModelFacts(raw.facts)
  const volumes = project.kind === 'drama' ? [] : normalizeModelVolumes(raw.volumes, units, project.kind)
  const scenes = project.kind === 'drama' ? normalizeModelScenes(raw.scenes, units, project, characters, places) : []
  return {
    approved: false,
    source: 'model',
    model,
    ...(title ? { title: title.slice(0, 120) } : {}),
    ...(genre ? { genre } : {}),
    ...(tone ? { tone } : {}),
    storyCore: storyCore || project.logline,
    emotion: str(raw.emotion).slice(0, 400) || tone || project.brief.tone || '克制而具体',
    audience: audience || project.brief.audience || (project.kind === 'drama' ? '喜欢短片的观众' : '喜欢故事的读者'),
    pitch: pitch || storyCore || project.logline,
    structure: structure || (project.kind === 'drama' ? `三幕 · ${units.length} 镜 / ${totalSeconds} 秒` : `${units.length} 章 · ${volumes.length} 卷`),
    styleBible,
    characters,
    places,
    ...(facts.length ? { facts } : {}),
    ...(volumes.length ? { volumes } : {}),
    ...(scenes.length ? { scenes } : {}),
    units,
    estimate: blueprintEstimate(project, units),
    warnings: fallback.warnings,
    createdAt: nowMs()
  }
}

function normalizeModelFacts(raw: unknown): NonNullable<StudioBlueprint['facts']> {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      subject: str(item.subject).slice(0, 80).trim(),
      predicate: str(item.predicate).slice(0, 120).trim(),
      object: str(item.object).slice(0, 600).trim()
    }))
    .filter((item) => item.subject && item.predicate && item.object)
    .slice(0, 20)
}

function alignVolumeSeeds(seeds: NonNullable<StudioBlueprint['volumes']>, plannedUnits: number): NonNullable<StudioBlueprint['volumes']> {
  if (!seeds.length) return seeds
  const weights = seeds.map((seed) => Math.max(1, seed.unitEnd - seed.unitStart + 1))
  const total = weights.reduce((sum, value) => sum + value, 0)
  let cursor = 1
  return seeds.map((seed, index) => {
    const remaining = plannedUnits - cursor + 1
    const count = index === seeds.length - 1
      ? Math.max(1, remaining)
      : Math.max(1, Math.min(remaining - (seeds.length - index - 1), Math.round((plannedUnits * weights[index]) / total)))
    const start = cursor
    cursor += count
    return { ...seed, unitStart: start, unitEnd: start + count - 1 }
  })
}

function normalizeModelVolumes(raw: unknown, units: StudioBlueprint['units'], kind: StudioKind): NonNullable<StudioBlueprint['volumes']> {
  if (!units.length) return []
  const desired = kind === 'novel' ? 3 : 1
  const provided = Array.isArray(raw)
    ? raw
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          title: str(item.title).slice(0, 120).trim(),
          summary: str(item.summary).slice(0, 800).trim(),
          unitStart: Math.max(1, Math.min(units.length, Math.round(num(item.unitStart, 1)))),
          unitEnd: Math.max(1, Math.min(units.length, Math.round(num(item.unitEnd, units.length))))
        }))
        .filter((item) => item.title && item.unitEnd >= item.unitStart)
        .slice(0, desired)
    : []
  if (provided.length >= desired) return provided
  const per = Math.ceil(units.length / desired)
  return Array.from({ length: desired }, (_, index) => {
    const start = index * per + 1
    const end = Math.min(units.length, (index + 1) * per)
    const first = units[start - 1]
    const last = units[Math.max(start - 1, end - 1)]
    return {
      title: `${['第一', '第二', '第三'][index] ?? index + 1}卷`,
      summary: first && last ? `${first.title} → ${last.title}：${first.summary.slice(0, 180)}` : '',
      unitStart: start,
      unitEnd: end
    }
  }).filter((volume) => volume.unitEnd >= volume.unitStart)
}

function normalizeModelScenes(
  raw: unknown,
  units: StudioBlueprint['units'],
  project: StudioProject,
  characters: StudioBlueprint['characters'],
  places: StudioBlueprint['places']
): NonNullable<StudioBlueprint['scenes']> {
  if (!units.length) return []
  const provided = Array.isArray(raw)
    ? raw
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          title: str(item.title).slice(0, 120).trim(),
          synopsis: str(item.synopsis).slice(0, 1000).trim(),
          location: str(item.location).slice(0, 160).trim(),
          timeOfDay: str(item.timeOfDay).slice(0, 80).trim(),
          characters: arrayOfStrings(item.characters).slice(0, 12),
          unitStart: Math.max(1, Math.min(units.length, Math.round(num(item.unitStart, 1)))),
          unitEnd: Math.max(1, Math.min(units.length, Math.round(num(item.unitEnd, units.length))))
        }))
        .filter((item) => item.title && item.unitEnd >= item.unitStart)
        .sort((left, right) => left.unitStart - right.unitStart)
        .slice(0, 8)
    : []
  void project
  void characters
  void places
  return provided
}

function assertModelBlueprint(blueprint: StudioBlueprint, kind: StudioKind, targetWords?: number): void {
  if (blueprint.characters.length < 2) {
    throw new Error('模型没有给出足够的人物（至少 2 位）。请重试，或换一个更强的文本模型。')
  }
  if (!blueprint.places.length) {
    throw new Error('模型没有给出故事地点。请重试，或换一个更强的文本模型。')
  }
  if (blueprint.units.length < 6) {
    throw new Error('模型给出的章/镜数量过少，无法形成完整故事。请重试，或换一个更强的文本模型。')
  }
  if (kind === 'drama' && !(blueprint.scenes?.length)) {
    throw new Error('模型没有给出漫剧场景。请重试，或换一个更强的文本模型。')
  }
  if (!blueprint.styleBible.look.trim()) {
    throw new Error('模型没有给出画面风格。请重试，或换一个更强的文本模型。')
  }
  if (blueprint.characters.some((character) => character.name === '未命名角色' || !character.look.trim())) {
    throw new Error('模型给出的人物信息不完整。请重试，或换一个更强的文本模型。')
  }
  if (blueprint.units.some((unit) => unit.summary === '（待补充）' || !unit.summary.trim())) {
    throw new Error('模型给出的章/镜摘要不完整。请重试，或换一个更强的文本模型。')
  }
  if ((kind === 'short' || kind === 'novel') && targetWords) {
    const planned = blueprint.units.reduce((sum, unit) => sum + (unit.wordTarget ?? 0), 0)
    if (planned < targetWords * 0.6) {
      throw new Error(`模型只规划了约 ${Math.round(planned / 1000)} 千字，低于目标 ${Math.round(targetWords / 1000)} 千字的 60%。请用更强的模型重试。`)
    }
    if (kind === 'short') {
      const expectedChapters = Math.max(6, Math.ceil(targetWords / 4000))
      if (blueprint.units.length < expectedChapters) {
        throw new Error(`模型只给出 ${blueprint.units.length} 章，目标 ${Math.round(targetWords / 10000)} 万字至少需要 ${expectedChapters} 章。请重试。`)
      }
    }
  }
}

function normalizeUnits(kind: StudioKind, raw: unknown, fallback: StudioBlueprint['units'], style: StudioBlueprint['styleBible']): StudioBlueprint['units'] {
  if (!Array.isArray(raw) || raw.length === 0) return fallback
  const units = raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .slice(0, 80)
    .map((item, index) => {
      const base: StudioBlueprint['units'][number] = {
        index: index + 1,
        title: str(item.title).slice(0, 160) || `第 ${index + 1} 单位`,
        summary: str(item.summary).slice(0, 2000) || '（待补充）'
      }
      const beats = Array.isArray(item.beats) ? arrayOfStrings(item.beats).slice(0, 6).map((beat) => beat.slice(0, 300)) : []
      if (beats.length) base.beats = beats
      if (kind === 'drama') {
        base.seconds = Math.max(3, Math.min(20, num(item.seconds, 8)))
        base.camera = str(item.camera).slice(0, 200) || '固定镜头，缓慢推近'
        base.shotSize = str(item.shotSize).slice(0, 80) || '中景'
        base.dialogue = str(item.dialogue).slice(0, 500)
        base.speaker = str(item.speaker).slice(0, 80)
      } else {
        base.wordTarget = Math.max(2000, Math.min(5000, num(item.wordTarget, 3000)))
      }
      return base
    })
  void style
  return units
}

function updateNovelOutline(project: StudioProject, blueprint: StudioBlueprint): void {
  const existing = [...project.chapters].sort((a, b) => a.number - b.number)
  blueprint.units.forEach((unit, index) => {
    const chapter = existing.find((item) => item.number === index + 1)
    if (chapter) {
      if (!chapter.content.trim()) {
        chapter.title = unit.title
        chapter.synopsis = unit.summary
        chapter.wordTarget = unit.wordTarget ?? chapter.wordTarget
      } else {
        chapter.synopsis = unit.summary
      }
      if (unit.beats?.length) chapter.beats = [...unit.beats]
      chapter.updatedAt = nowMs()
    } else {
      const added = {
        id: studioId('ch'),
        volumeId: project.volumes[0]?.id ?? null,
        number: index + 1,
        title: unit.title,
        synopsis: unit.summary,
        beats: unit.beats ? [...unit.beats] : [],
        content: '',
        wordTarget: Math.max(2000, Math.min(5000, unit.wordTarget ?? 3000)),
        status: 'ready' as const,
        revision: 1,
        candidates: [],
        versions: [],
        illustrations: [],
        locked: false,
        updatedAt: nowMs()
      }
      project.chapters.push(added)
      if (added.volumeId) {
        const volume = project.volumes.find((item) => item.id === added.volumeId)
        if (volume && !volume.chapterIds.includes(added.id)) volume.chapterIds.push(added.id)
      }
    }
  })
}

function shotFromOutlineUnit(
  project: StudioProject,
  blueprint: StudioBlueprint,
  unit: StudioBlueprintUnit,
  index: number,
  scene: StudioScene
): StudioShot {
  const speaker = unit.speaker ?? ''
  const character = project.characters.find((item) => item.name === speaker)
  const sceneCharacters = scene.characters
    .map((name) => project.characters.find((item) => item.name === name))
    .filter((item): item is StudioCharacter => Boolean(item))
  const referenceCharacters = [...new Map([...(character ? [character] : []), ...sceneCharacters].map((item) => [item.id, item])).values()]
  const place = project.places.find((item) => item.name === scene.location) ?? project.places[0]
  return {
    id: studioId('shot'),
    sceneId: scene.id,
    number: index + 1,
    title: unit.title,
    action: unit.summary,
    camera: unit.camera?.trim() || '固定镜头，缓慢推近',
    shotSize: unit.shotSize?.trim() || '中景',
    durationSec: Math.max(3, Math.min(30, unit.seconds ?? 8)),
    dialogue: unit.dialogue ?? '',
    speaker,
    voiceId: character?.voiceId ?? '',
    prompt: imagePromptFor(project, unit, index, scene, blueprint.styleBible),
    negative: blueprint.styleBible.negative.join('，'),
    referenceCharacterIds: referenceCharacters.map((item) => item.id),
    referencePlaceIds: place ? [place.id] : [],
    referencePropIds: [],
    imageAssetId: null,
    videoAssetId: null,
    voiceAssetId: null,
    imageCandidates: [],
    videoCandidates: [],
    continuity: index === 0
      ? '开场；固定人物外观、服装与场景光线'
      : `承接第 ${index} 镜尾帧；人物外观、服装与光线保持一致`,
    lockedReference: false,
    status: 'ready',
    updatedAt: nowMs()
  }
}

/**
 * 重生成大纲时，用新 units 同步已有场景与镜头文字。
 * 已有画面/配音保留关联并标记 stale；新增 unit 落到对应场景，不再只更新“没素材的镜头”。
 */
export function syncDramaOutline(project: StudioProject, blueprint: StudioBlueprint): void {
  const units = blueprint.units
  const now = nowMs()
  const seeds = blueprint.scenes ?? []
  const scenes = [...project.scenes].sort((left, right) => left.number - right.number)
  const seededScenes = seeds.map((seed, index) => {
    const existing = scenes[index]
    const next: StudioScene = existing
      ? {
          ...existing,
          title: seed.title || existing.title,
          synopsis: seed.synopsis || existing.synopsis,
          location: seed.location || existing.location,
          timeOfDay: seed.timeOfDay || existing.timeOfDay,
          characters: seed.characters.length ? [...seed.characters] : existing.characters,
          updatedAt: now
        }
      : {
          id: studioId('scene'),
          episodeId: project.episodes[0]?.id ?? '',
          number: index + 1,
          title: seed.title || `第 ${index + 1} 场`,
          synopsis: seed.synopsis,
          location: seed.location,
          timeOfDay: seed.timeOfDay,
          characters: [...seed.characters],
          beat: index === 0 ? 'Setup' : index === seeds.length - 1 ? 'Resolution' : 'Confrontation',
          updatedAt: now
        }
    if (existing) scenes[index] = next
    else scenes.push(next)
    return next
  })
  const finalScenes = scenes.length ? scenes : seededScenes
  if (!finalScenes.length) return
  const fallbackPer = Math.max(1, Math.ceil(units.length / Math.max(1, seeds.length || finalScenes.length)))
  const ranges = seeds.map((seed, index) => ({
    start: Math.max(1, Math.min(units.length || 1, seed.unitStart || index * fallbackPer + 1)),
    end: Math.max(1, Math.min(units.length || 1, seed.unitEnd || (index + 1) * fallbackPer))
  }))
  const sceneForUnit = (index: number): StudioScene => {
    const number = index + 1
    const found = ranges.findIndex((range) => number >= range.start && number <= range.end)
    if (found >= 0 && finalScenes[found]) return finalScenes[found]
    const perScene = Math.max(1, Math.ceil(units.length / Math.max(1, finalScenes.length)))
    return finalScenes[Math.min(finalScenes.length - 1, Math.floor(index / perScene))]
  }
  const byNumber = new Map(project.shots.map((shot) => [shot.number, shot]))
  units.forEach((unit, index) => {
    const scene = sceneForUnit(index)
    if (!scene) return
    const shot = byNumber.get(index + 1)
    if (!shot) {
      const created = shotFromOutlineUnit(project, blueprint, unit, index, scene)
      project.shots.push(created)
      byNumber.set(created.number, created)
      return
    }
    const dialogueChanged = shot.dialogue !== (unit.dialogue ?? shot.dialogue)
    Object.assign(shot, {
      sceneId: scene.id,
      title: unit.title || shot.title,
      action: unit.summary || shot.action,
      camera: unit.camera?.trim() || shot.camera,
      shotSize: unit.shotSize?.trim() || shot.shotSize,
      durationSec: Math.max(3, Math.min(30, unit.seconds ?? shot.durationSec)),
      dialogue: unit.dialogue ?? shot.dialogue,
      speaker: unit.speaker ?? shot.speaker,
      voiceId: project.characters.find((character) => character.name === (unit.speaker ?? shot.speaker))?.voiceId ?? shot.voiceId,
      voiceAssetId: dialogueChanged ? null : shot.voiceAssetId,
      updatedAt: now
    })
    if (shot.imageAssetId || shot.videoAssetId || shot.voiceAssetId) shot.status = 'stale'
  })
  for (const shot of project.shots) {
    if (!finalScenes.some((scene) => scene.id === shot.sceneId)) shot.sceneId = finalScenes[0].id
  }
  const finalShots = [...project.shots].sort((left, right) => left.number - right.number)
  const blueprintScenes: StudioBlueprintSceneSeed[] = seeds.length
    ? finalScenes.map((scene, index) => {
        const numbers = finalShots.filter((shot) => shot.sceneId === scene.id).map((shot) => shot.number)
        const seed = seeds[index]
        return {
          title: scene.title,
          synopsis: scene.synopsis,
          location: scene.location,
          timeOfDay: scene.timeOfDay,
          characters: [...scene.characters],
          unitStart: numbers.length ? Math.min(...numbers) : seed?.unitStart ?? index + 1,
          unitEnd: numbers.length ? Math.max(...numbers) : seed?.unitEnd ?? index + 1
        }
      })
    : (blueprint.scenes ?? [])
  project.scenes = finalScenes
  project.blueprint = { ...blueprint, scenes: blueprintScenes }
  const episode = project.episodes[0]
  if (episode) {
    episode.sceneIds = finalScenes.map((scene) => scene.id)
    episode.durationSec = finalShots.reduce((sum, shot) => sum + shot.durationSec, 0)
    episode.updatedAt = now
    project.episodes = [episode]
  }
  project.updatedAt = now
}

function updateDramaShots(project: StudioProject, blueprint: StudioBlueprint): void {
  const existing = [...project.shots].sort((a, b) => a.number - b.number)
  blueprint.units.forEach((unit, index) => {
    const shot = existing.find((item) => item.number === index + 1)
    if (shot) {
      if (!shot.imageAssetId && !shot.videoAssetId) {
        shot.title = unit.title
        shot.action = unit.summary
        shot.camera = unit.camera ?? shot.camera
        shot.shotSize = unit.shotSize ?? shot.shotSize
        shot.dialogue = unit.dialogue ?? shot.dialogue
        shot.speaker = unit.speaker ?? shot.speaker
        shot.durationSec = unit.seconds ?? shot.durationSec
      }
      shot.updatedAt = nowMs()
    } else {
      // 新镜头只追加在没有素材的情况下，避免打乱已生成镜号
      if (project.shots.some((item) => item.imageAssetId || item.videoAssetId)) return
      const scene = project.scenes[0]
      if (!scene) return
      project.shots.push({
        id: studioId('shot'),
        sceneId: scene.id,
        number: index + 1,
        title: unit.title,
        action: unit.summary,
        camera: unit.camera ?? '固定镜头',
        shotSize: unit.shotSize ?? '中景',
        durationSec: unit.seconds ?? 8,
        dialogue: unit.dialogue ?? '',
        speaker: unit.speaker ?? '',
        voiceId: '',
        prompt: `${unit.summary}。${blueprint.styleBible.look}。第 ${index + 1} 镜。`,
        negative: blueprint.styleBible.negative.join('，'),
        referenceCharacterIds: [],
        referencePlaceIds: [],
        referencePropIds: [],
        imageAssetId: null,
        videoAssetId: null,
        voiceAssetId: null,
        imageCandidates: [],
        videoCandidates: [],
        continuity: index === 0 ? '开场' : '承接上一镜',
        lockedReference: false,
        status: 'ready',
        updatedAt: nowMs()
      })
    }
  })
}

interface StoryboardShotSeed {
  number: number
  sceneIndex: number
  title: string
  action: string
  camera: string
  shotSize: string
  durationSec: number
  dialogue: string
  speaker: string
  continuity: string
  prompt: string
  negative: string
}

interface ModelStoryboard {
  scenes: StudioBlueprintSceneSeed[]
  shots: StoryboardShotSeed[]
}

function normalizeModelStoryboard(
  raw: Record<string, unknown>,
  project: StudioProject,
  blueprint: StudioBlueprint,
  locked: boolean
): ModelStoryboard {
  const existing = [...project.shots].sort((left, right) => left.number - right.number)
  const rawShots = Array.isArray(raw.shots)
    ? raw.shots.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
  if (!rawShots.length) throw new Error('模型没有给出分镜镜头。请重试，或换一个更强的文本模型。')
  if (locked && rawShots.length !== existing.length) {
    throw new Error(`这部作品已有 ${existing.length} 镜素材，模型却给了 ${rawShots.length} 镜。为避免打乱素材，请只调整现有镜头，或先移除素材再重排。`)
  }
  if (!locked && (rawShots.length < 6 || rawShots.length > 40)) {
    throw new Error(`模型给出了 ${rawShots.length} 镜；漫剧需要 6–40 镜才能形成完整故事。请重试。`)
  }
  const sceneNames = new Set(project.characters.map((character) => character.name))
  const scenes: StudioBlueprintSceneSeed[] = Array.isArray(raw.scenes)
    ? raw.scenes
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          title: str(item.title).slice(0, 120).trim(),
          synopsis: str(item.synopsis).slice(0, 1200).trim(),
          location: str(item.location).slice(0, 200).trim(),
          timeOfDay: str(item.timeOfDay).slice(0, 80).trim(),
          characters: arrayOfStrings(item.characters)
            .map((name) => name.trim())
            .filter((name) => sceneNames.has(name))
            .slice(0, 12),
          unitStart: Math.max(1, Math.min(rawShots.length, Math.round(num(item.unitStart, 1)))),
          unitEnd: Math.max(1, Math.min(rawShots.length, Math.round(num(item.unitEnd, rawShots.length)))),
          ...(project.chapters.length && Number.isFinite(Number(item.sourceChapter))
            ? { sourceChapter: Math.max(1, Math.min(project.chapters.length, Math.round(Number(item.sourceChapter)))) }
            : {})
        }))
        .filter((item) => item.title && item.unitEnd >= item.unitStart)
        .sort((left, right) => left.unitStart - right.unitStart)
        .slice(0, 12)
    : []
  const fallbackScenes = (blueprint.scenes ?? []).map((scene) => ({ ...scene, characters: [...scene.characters] }))
  const finalScenes = scenes.length ? scenes : fallbackScenes
  if (!finalScenes.length) throw new Error('模型没有给出场景，蓝图里也没有可用的场景范围。请先重新生成蓝图。')
  const shots: StoryboardShotSeed[] = rawShots.map((item, index) => {
    const title = str(item.title).slice(0, 160).trim()
    const action = str(item.action).slice(0, 2000).trim() || str(item.summary).slice(0, 2000).trim()
    if (!title || !action) throw new Error(`模型给出的第 ${index + 1} 镜缺少标题或动作。请重试。`)
    const rawSpeaker = str(item.speaker).slice(0, 80).trim()
    const speakerParts = rawSpeaker
      .split(/[／/、,，·]/)
      .map((part) => part.replace(/[（(][^）)]*[）)]/g, '').trim())
      .filter(Boolean)
    const speaker = speakerParts.find((part) => part === '旁白' || sceneNames.has(part))
      ?? [...sceneNames].find((name) => rawSpeaker.includes(name))
      ?? ''
    if (rawSpeaker && !speaker) {
      throw new Error(`模型让不存在的人物「${rawSpeaker}」说话。请重试，或换一个更强的文本模型。`)
    }
    const rawSceneIndex = Math.round(num(item.sceneIndex, 1))
    const sceneIndex = Math.max(1, Math.min(finalScenes.length, rawSceneIndex))
    const durationSec = Math.max(3, Math.min(20, num(item.seconds ?? item.durationSec, 8)))
    const camera = str(item.camera).slice(0, 200).trim() || '固定镜头'
    const shotSize = str(item.shotSize).slice(0, 80).trim() || '中景'
    return {
      number: index + 1,
      sceneIndex,
      title,
      action,
      camera,
      shotSize,
      durationSec,
      dialogue: str(item.dialogue).slice(0, 500).trim(),
      speaker,
      continuity: str(item.continuity).slice(0, 500).trim() || (index === 0 ? '开场；固定人物外观与光线' : `承接第 ${index} 镜`),
      prompt: str(item.prompt).slice(0, 4000).trim(),
      negative: str(item.negative).slice(0, 1000).trim() || blueprint.styleBible.negative.join('，')
    }
  })
  return { scenes: finalScenes, shots }
}

function applyModelStoryboard(project: StudioProject, storyboard: ModelStoryboard, model: string): void {
  if (!project.blueprint?.approved) throw new Error('蓝图尚未确认；分镜结果没有应用。')
  const existing = [...project.shots].sort((left, right) => left.number - right.number)
  const locked = existing.some((shot) => shot.imageAssetId || shot.videoAssetId || shot.voiceAssetId)
  const now = nowMs()
  let scenes: StudioScene[]
  if (locked && project.scenes.length) {
    scenes = project.scenes.map((scene, index) => {
      const seed = storyboard.scenes[index]
      if (!seed) return scene
      return {
        ...scene,
        title: seed.title || scene.title,
        synopsis: seed.synopsis || scene.synopsis,
        location: seed.location || scene.location,
        timeOfDay: seed.timeOfDay || scene.timeOfDay,
        characters: seed.characters.length ? seed.characters : scene.characters,
        beat: scene.beat,
        updatedAt: now
      }
    })
    storyboard.scenes.slice(scenes.length).forEach((seed, index) => {
      scenes.push({
        id: studioId('scene'),
        episodeId: project.episodes[0]?.id ?? '',
        number: project.scenes.length + index + 1,
        title: seed.title,
        synopsis: seed.synopsis,
        location: seed.location,
        timeOfDay: seed.timeOfDay,
        characters: seed.characters,
        beat: 'Confrontation',
        updatedAt: now
      })
    })
  } else {
    scenes = storyboard.scenes.map((seed, index) => {
      const original = project.scenes[index]
      const sourceChapter = seed.sourceChapter
        ? project.chapters.find((chapter) => chapter.number === seed.sourceChapter)
        : undefined
      return {
        id: studioId('scene'),
        episodeId: project.episodes[0]?.id ?? '',
        number: index + 1,
        title: seed.title,
        synopsis: seed.synopsis,
        location: seed.location,
        timeOfDay: seed.timeOfDay,
        characters: seed.characters,
        beat: index === 0 ? 'Setup' : index === storyboard.scenes.length - 1 ? 'Resolution' : 'Confrontation',
        ...(sourceChapter?.id || original?.sourceChapterId ? { sourceChapterId: sourceChapter?.id ?? original?.sourceChapterId } : {}),
        updatedAt: now
      }
    })
  }
  const episodeId = project.episodes[0]?.id ?? studioId('ep')
  scenes.forEach((scene) => { scene.episodeId = episodeId })
  const shots: StudioShot[] = storyboard.shots.map((seed, index) => {
    const scene = scenes[Math.max(0, Math.min(scenes.length - 1, seed.sceneIndex - 1))]
    const speakerCharacter = project.characters.find((character) => character.name === seed.speaker)
    const sceneCharacters = scene.characters
      .map((name) => project.characters.find((character) => character.name === name))
      .filter((character): character is NonNullable<typeof character> => Boolean(character))
    const referenceCharacters = [...new Map([
      ...(speakerCharacter ? [speakerCharacter] : []),
      ...sceneCharacters
    ].map((character) => [character.id, character])).values()]
    const place = project.places.find((item) => item.name === scene.location)
    const prompt = seed.prompt || buildStoryboardImagePrompt(project, seed, scene)
    const previous = locked ? existing[index] : undefined
    if (previous) {
      const dialogueChanged = previous.dialogue !== seed.dialogue
      return {
        ...previous,
        sceneId: scene.id,
        number: index + 1,
        title: seed.title,
        action: seed.action,
        camera: seed.camera,
        shotSize: seed.shotSize,
        durationSec: seed.durationSec,
        dialogue: seed.dialogue,
        speaker: seed.speaker,
        voiceId: speakerCharacter?.voiceId ?? previous.voiceId,
        prompt,
        negative: seed.negative,
        referenceCharacterIds: [...new Set([...previous.referenceCharacterIds, ...referenceCharacters.map((character) => character.id)])],
        referencePlaceIds: [...new Set([...previous.referencePlaceIds, ...(place ? [place.id] : [])])],
        continuity: seed.continuity,
        voiceAssetId: dialogueChanged ? null : previous.voiceAssetId,
        status: dialogueChanged && previous.voiceAssetId ? 'stale' : previous.status,
        updatedAt: now
      }
    }
    return {
      id: studioId('shot'),
      sceneId: scene.id,
      number: index + 1,
      title: seed.title,
      action: seed.action,
      camera: seed.camera,
      shotSize: seed.shotSize,
      durationSec: seed.durationSec,
      dialogue: seed.dialogue,
      speaker: seed.speaker,
      voiceId: speakerCharacter?.voiceId ?? '',
      prompt,
      negative: seed.negative,
      referenceCharacterIds: referenceCharacters.map((character) => character.id),
      referencePlaceIds: place ? [place.id] : [],
      referencePropIds: [],
      imageAssetId: null,
      videoAssetId: null,
      voiceAssetId: null,
      imageCandidates: [],
      videoCandidates: [],
      continuity: seed.continuity,
      lockedReference: false,
      status: 'ready',
      updatedAt: now
    }
  })
  const totalDuration = shots.reduce((sum, shot) => sum + shot.durationSec, 0)
  const episode = {
    id: episodeId,
    number: 1,
    title: project.title,
    synopsis: project.blueprint.pitch || project.logline,
    sceneIds: scenes.map((scene) => scene.id),
    durationSec: totalDuration,
    updatedAt: now
  }
  const blueprintScenes: StudioBlueprintSceneSeed[] = scenes.map((scene) => {
    const numbers = shots.filter((shot) => shot.sceneId === scene.id).map((shot) => shot.number)
    return {
      title: scene.title,
      synopsis: scene.synopsis,
      location: scene.location,
      timeOfDay: scene.timeOfDay,
      characters: scene.characters,
      unitStart: numbers.length ? Math.min(...numbers) : scene.number,
      unitEnd: numbers.length ? Math.max(...numbers) : scene.number
    }
  })
  project.scenes = scenes
  project.shots = shots
  project.episodes = [episode]
  project.blueprint = {
    ...project.blueprint,
    scenes: blueprintScenes,
    units: shots.map((shot, index) => ({
      index: index + 1,
      title: shot.title,
      summary: shot.action,
      seconds: shot.durationSec,
      camera: shot.camera,
      shotSize: shot.shotSize,
      dialogue: shot.dialogue,
      speaker: shot.speaker
    })),
    outlineModel: project.blueprint.outlineModel ?? model,
    storyboardModel: model
  }
  project.stages.outline = { status: 'done', updatedAt: now, message: '镜头计划已随分镜确认', progress: 100 }
  project.stages.storyboard = { status: 'done', updatedAt: now, message: `${scenes.length} 场 · ${shots.length} 镜（${model}）`, progress: 100 }
  project.stage = 'storyboard'
  if (locked) {
    project.timeline = { ...project.timeline, version: project.timeline.version + 1, updatedAt: now }
    staleStoryboardDownstream(project)
  } else {
    project.timeline = emptyTimeline(project.brief.aspect, now)
    project.stages.visuals = { status: 'waiting', updatedAt: now, message: '等待生成画面', progress: 0 }
    project.stages.voice = { status: 'waiting', updatedAt: now, message: '等待配音', progress: 0 }
    project.stages.timeline = { status: 'waiting', updatedAt: now, message: '等待装配时间线', progress: 0 }
  }
  project.updatedAt = now
}

function staleStoryboardDownstream(project: StudioProject): void {
  const now = nowMs()
  for (const stage of ['visuals', 'voice', 'timeline', 'review', 'delivery'] as const) {
    const current = project.stages[stage]
    if (current && (current.status === 'done' || current.status === 'review')) {
      project.stages[stage] = { ...current, status: 'stale', updatedAt: now, message: '分镜有改动，下游需要重新核对' }
    }
  }
}

function buildStoryboardImagePrompt(project: StudioProject, seed: StoryboardShotSeed, scene: StudioScene): string {
  const characters = scene.characters
    .map((name) => project.characters.find((character) => character.name === name))
    .filter((character): character is NonNullable<typeof character> => Boolean(character))
    .slice(0, 4)
    .map((character) => `${character.name}（${character.role}${character.look ? `：${character.look.slice(0, 120)}` : ''}）`)
  const place = project.places.find((item) => item.name === scene.location)
  return [
    `电影剧照，${project.styleBible.look}`,
    `${seed.shotSize}，${seed.camera}`,
    `画面：${seed.action}`,
    characters.length ? `人物：${characters.join('；')}` : '',
    `场景：${scene.location || '同一故事世界'}${scene.timeOfDay ? `，${scene.timeOfDay}` : ''}`,
    place?.description ? `环境：${place.description}` : '',
    `本场：${scene.synopsis}`,
    `第 ${seed.number} 镜，${project.brief.aspect}，统一角色外观、服装与光线，无字幕无文字`
  ].filter(Boolean).join('；')
}

function musicModelPrompt(project: StudioProject, mood: ReturnType<typeof musicMood>): string {
  return [
    '电影短片配乐，纯器乐，无人声，无歌词',
    `情绪：${mood.label}；速度约 ${mood.tempo} BPM`,
    `故事：${project.blueprint?.storyCore ?? project.logline}`,
    `画面风格：${project.styleBible.look}`,
    project.styleBible.sound ? `声音方向：${project.styleBible.sound}` : '',
    `结构：前奏—发展—情绪高点—自然收束；时长与画面一致，不要突然中断`,
    'cinematic instrumental score, no vocals, emotional, coherent ending'
  ].filter(Boolean).join('；')
}

function finishVisualStage(project: StudioProject): void {
  const total = project.shots.length
  if (!total) return
  const done = project.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length
  project.stages.visuals = {
    status: done === total ? 'done' : 'ready',
    updatedAt: nowMs(),
    message: done === total ? `${total} 镜全部有画面` : `已有 ${done}/${total} 镜画面`,
    progress: Math.round((done / total) * 100)
  }
  if (done === total) {
    project.stages.storyboard = { ...project.stages.storyboard, status: 'done', updatedAt: nowMs(), progress: 100 }
  }
}

function finishVoiceStage(project: StudioProject): void {
  const shots = project.shots.filter((shot) => shot.dialogue.trim())
  if (!shots.length) {
    project.stages.voice = { status: 'done', updatedAt: nowMs(), message: '本片没有对白', progress: 100 }
    return
  }
  const done = shots.filter((shot) => shot.voiceAssetId).length
  project.stages.voice = {
    status: done === shots.length ? 'done' : 'ready',
    updatedAt: nowMs(),
    message: done === shots.length ? `${done} 段配音已就位` : `已有 ${done}/${shots.length} 段配音`,
    progress: Math.round((done / shots.length) * 100)
  }
}

function appendJobEvent(job: StudioJob, status: StudioJobStatus, message: string, progress: number): void {
  const events = job.events ?? []
  const last = events[events.length - 1]
  const clean = message.slice(0, 400)
  if (last && last.status === status && last.message === clean && last.progress === progress) return
  events.push({ at: nowMs(), status, message: clean, progress })
  job.events = events.slice(-80)
}

function makeThumbnail(file: string, projectId: string): Buffer | null {
  const paths = resolveFfmpegPaths()
  if (!paths) return null
  const temp = join(getStudioStore().tempDir(projectId), `thumb-${studioId('t').slice(2, 9)}.jpg`)
  try {
    mkdirSync(join(temp, '..'), { recursive: true })
    const result = spawnSync(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', temp], {
      windowsHide: true,
      timeout: 30_000
    })
    if (result.status === 0 && existsSync(temp)) {
      const bytes = readFileSync(temp)
      rmSync(temp, { force: true })
      return bytes
    }
  } catch {
  }
  try {
    rmSync(temp, { force: true })
  } catch {
  }
  return null
}

function runChecks(project: StudioProject): StudioProject['checks'] {
  const checks: StudioProject['checks'] = []
  const priorVisual = project.checks.filter((check) => check.kind === 'visual')
  const now = nowMs()
  const add = (kind: StudioProject['checks'][number]['kind'], level: StudioProject['checks'][number]['level'], title: string, detail: string, targetId?: string): void => {
    checks.push({ id: studioId('check'), kind, level, title, detail, ...(targetId ? { targetId } : {}), createdAt: now })
  }
  if (project.kind === 'drama') {
    const missing = project.shots.filter((shot) => !shot.imageAssetId && !shot.videoAssetId)
    if (missing.length) add('missing', 'error', `${missing.length} 镜没有画面`, `镜 ${missing.map((shot) => shot.number).join('、')} 还需要生成或导入画面。`)
    else add('missing', 'info', '画面齐全', `${project.shots.length} 镜全部有画面。`)
    const noVoice = project.shots.filter((shot) => shot.dialogue.trim() && !shot.voiceAssetId)
    if (noVoice.length) add('audio', 'warn', `${noVoice.length} 段台词没有配音`, `镜 ${noVoice.map((shot) => shot.number).join('、')} 可以逐镜补配。`)
    const tooLong: string[] = []
    for (const shot of project.shots) {
      if (!shot.voiceAssetId) continue
      const voice = project.assets.find((asset) => asset.id === shot.voiceAssetId)
      if (voice?.durationSec && voice.durationSec > shot.durationSec + 0.6) tooLong.push(`镜 ${shot.number}（${voice.durationSec.toFixed(1)}s > ${shot.durationSec}s）`)
    }
    if (tooLong.length) add('audio', 'warn', '配音比镜头长', `${tooLong.join('；')}。可以拉长镜头或重配。`)
    const score = resolveMusicAsset(project)
    const hasMusic = Boolean(score?.formal || score?.demo)
    const hasDraftMusic = Boolean(score && !score.formal && !score.demo)
    if (!hasMusic) add('audio', 'warn', hasDraftMusic ? '只有本地配乐草稿' : '还没有配乐', hasDraftMusic ? '草稿可以试听；安装 ACE-Step 配乐模型后可生成正式配乐。' : '可以先生成配乐，或把声音方向写进补充要求后再生成。')
    if (!project.timeline.clips.length) add('missing', 'warn', '时间线还没有装配', '点击“自动装配时间线”，再合成草稿。')
    if (project.stages.timeline.status === 'stale') add('missing', 'warn', '时间线需要重新装配', '有新素材还没进入时间线；直接合成会得到旧画面或旧声音。')
    const unlinkedVisuals = project.shots.filter((shot) => (shot.imageAssetId || shot.videoAssetId) && !project.timeline.clips.some((clip) => clip.kind === 'video' && clip.shotId === shot.id))
    const unlinkedVoices = project.shots.filter((shot) => shot.voiceAssetId && !project.timeline.clips.some((clip) => clip.kind === 'dialogue' && clip.shotId === shot.id))
    if (unlinkedVisuals.length || unlinkedVoices.length) {
      add('missing', 'error', '素材和时间线不一致', `${unlinkedVisuals.length ? `${unlinkedVisuals.length} 镜有画面但时间线没有片段` : ''}${unlinkedVisuals.length && unlinkedVoices.length ? '；' : ''}${unlinkedVoices.length ? `${unlinkedVoices.length} 镜有配音但时间线没有对白片段` : ''}。请重新装配时间线后再合成。`)
    }
    const badClip = project.timeline.clips.find((clip) => clip.assetId && !project.assets.some((asset) => asset.id === clip.assetId))
    if (badClip) add('missing', 'error', '时间线引用了丢失的素材', `片段「${badClip.label}」找不到素材，请重新装配或替换。`, badClip.id)
    if (project.timeline.clips.length) {
      const subtitleCount = project.timeline.clips.filter((clip) => clip.kind === 'subtitle').length
      if (!subtitleCount) add('subtitle', 'info', '没有字幕', '台词会在配音轨里保留，但成片没有字幕。')
    }
    if (!project.deliveries.some((delivery) => isStudioVideoDelivery(delivery.kind))) add('missing', 'info', '还没有成片', '草稿合成约需几十秒。')
    if (!priorVisual.length) {
      const vision = studioVisionProvider(project.runtime.strategy)
      if (vision) add('visual', 'info', `画面检查将使用 ${vision.model.label || vision.model.id}`, '运行检查后会自动逐镜检查手、脸、服装与道具；也可以单独点击“逐镜检查画面”。')
      else add('visual', 'info', '视觉检查需要真实视觉模型', '在设置里连接带视觉能力的本地或云端模型后，检查会真实调用它。')
    }
  } else {
    const empty = project.chapters.filter((chapter) => !chapter.content.trim())
    if (empty.length) add('missing', 'warn', `${empty.length} 章还没有正文`, `第 ${empty.slice(0, 8).map((chapter) => chapter.number).join('、')} 章可以继续写。`)
    const pending = project.chapters.filter((chapter) => chapter.candidates.length)
    if (pending.length) add('continuity', 'info', `${pending.length} 章有候选待采用`, pending.map((chapter) => `第 ${chapter.number} 章`).join('、') + '。候选不会自动覆盖正文。')
    const short = project.chapters.filter((chapter) => chapter.content.trim() && countWords(chapter.content) < chapter.wordTarget * 0.6)
    if (short.length) add('continuity', 'info', `${short.length} 章明显短于目标字数`, short.slice(0, 6).map((chapter) => `第 ${chapter.number} 章`).join('、') + '。可以先保留，也可以继续扩写。')
    if (!project.deliveries.length) add('missing', 'info', '还没有导出交付物', '可以在交付页导出 TXT / EPUB / PDF。')
    const written = project.chapters.filter((chapter) => chapter.content.trim())
    const text = written.map((chapter) => chapter.content).join('\n')
    const totalWords = countWords(text)
    const targetWords = project.brief.targetWords
    if (targetWords && totalWords < targetWords * 0.6) {
      add('quality', 'warn', '总字数明显低于目标', `已写 ${totalWords.toLocaleString('zh-CN')} 字 / 目标 ${targetWords.toLocaleString('zh-CN')} 字。可以继续续写，或把目标调整到更实际的篇幅。`)
    }
    if (countWords(text) > 800) {
      const counts = new Map<string, number>()
      for (const chapter of written) {
        const compact = chapter.content.replace(/\s+/g, '')
        for (let index = 0; index + 12 <= compact.length; index += 3) {
          const phrase = compact.slice(index, index + 12)
          if (!/^[\u4e00-\u9fa5]{12}$/.test(phrase)) continue
          counts.set(phrase, (counts.get(phrase) ?? 0) + 1)
        }
      }
      const repeated = [...counts.entries()].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3)
      if (repeated.length) add('continuity', 'info', '发现重复片段', repeated.map(([phrase, count]) => `「${phrase}」出现 ${count} 次`).join('；') + '。可以决定是否保留这种有意重复。')
      const longParagraphs = written.flatMap((chapter) => chapter.content.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean).map((paragraph, index) => ({ chapter, paragraph, index }))).filter((item) => item.paragraph.length > 260)
      if (longParagraphs.length) add('continuity', 'info', `${longParagraphs.length} 个段落偏长`, longParagraphs.slice(0, 4).map((item) => `第 ${item.chapter.number} 章第 ${item.index + 1} 段`).join('、') + '。长段落适合沉浸，也可以拆开调整节奏。')
      const dialogueChars = (text.match(/[“「][^”」]{1,80}[”」]/g) ?? []).join('').length
      if (dialogueChars / Math.max(1, countWords(text)) < 0.03) add('continuity', 'info', '对白密度偏低', '叙述占比较高；如果这是刻意的独白式写法可以保留。')
    }
  }
  const groups = new Map<string, typeof project.facts>()
  for (const fact of project.facts) {
    const key = `${fact.subject}::${fact.predicate}`
    const list = groups.get(key) ?? []
    list.push(fact)
    groups.set(key, list)
  }
  for (const [, facts] of groups) {
    if (facts.length < 2) continue
    const values = [...new Set(facts.map((fact) => fact.object))]
    if (values.length > 1) {
      add('continuity', 'warn', `可能的设定冲突：${facts[0].subject} ${facts[0].predicate}`, values.join(' / '), facts[0].id)
    }
  }
  const danglingSources = project.messages.flatMap((message) =>
    (message.sources ?? []).filter((source) => {
      if (source.kind === 'facts') return project.facts.length === 0
      if (source.kind === 'chapter') return !project.chapters.some((chapter) => chapter.id === source.id)
      if (source.kind === 'shot') return !project.shots.some((shot) => shot.id === source.id)
      return !project.timeline.clips.some((clip) => clip.id === source.id)
    })
  )
  if (danglingSources.length) {
    add(
      'continuity',
      'warn',
      '助手引用的来源已失效',
      `${danglingSources.slice(0, 4).map((source) => source.label).join('、')} 已被删除或替换。回答里的相关内容需要重新核对。`
    )
  }
  if (project.runtime.budget.limit > 0 && project.runtime.budget.spent > project.runtime.budget.limit) {
    add('price', 'error', '项目已超预算', `已记录 ¥${project.runtime.budget.spent.toFixed(2)} / ¥${project.runtime.budget.limit}。后续付费动作会被拦住。`)
  }
  checks.push(...(project.kind === 'drama' ? dramaQualityChecks(project) : proseQualityChecks(project)))
  return [...priorVisual, ...checks]
}

let service: StudioService | null = null

export function getStudioService(): StudioService {
  if (!service) service = new StudioService()
  return service
}
