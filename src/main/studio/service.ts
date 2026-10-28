// 创作台主服务：界面与助手共用的唯一写入口。
import { app } from 'electron'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type {
  StudioActionResult,
  StudioAsset,
  StudioBlueprint,
  StudioChapter,
  StudioCreateInput,
  StudioDelivery,
  StudioEditPlan,
  StudioEngineStatus,
  StudioExportInput,
  StudioExportPreflight,
  StudioGenerateInput,
  StudioJob,
  StudioJobKind,
  StudioJobStatus,
  StudioKind,
  StudioListResult,
  StudioProject,
  StudioRenderInput,
  StudioShot,
  StudioStageId
} from '../../shared/studio'
import {
  canTransitionStudioStatus,
  countWords,
  isStudioVideoDelivery,
  studioKindLabel,
  timelineDuration
} from '../../shared/studio'
import { getMediaService } from '../services/media-service'
import { studioDataDirInfo } from '../services/paths'
import { isLocalServiceUrl } from '../../shared/models'
import { sendFeatureEvent } from '../feature-ipc'
import {
  StudioStore,
  getStudioStore,
  nowMs,
  safeProjectId,
  sanitizeProjectForRenderer,
  sha256Buffer,
  sha256File,
  studioId
} from './store'
import {
  applyBlueprintToProject,
  applyDramaOutline,
  applyNovelOutline,
  localBlueprint,
  localChapterDraft,
  readSeeds
} from './local-creative'
import {
  completeCreativeText,
  estimateTextCostCny,
  extractJson,
  studioTextRuntime,
  studioVisionProvider,
  studioTextRoutes,
  textStatusForEngine
} from './text'
import { buildTimelineFromProject, sanitizeTimeline } from './timeline'
import { listSystemVoices, synthesizeCloudSpeech, synthesizeMusic, synthesizeSfx, synthesizeSpeech, musicMood } from './audio'
import { extractPoster, ffmpegCapabilities, renderProject, resolveFfmpegPaths } from './render'
import {
  bundledExportFontStylesheet,
  cleanFileName,
  exportAss,
  exportCover,
  writeDeliveryFile,
  exportDocx,
  exportEpub,
  exportFolder,
  exportMarkdown,
  exportPackage,
  exportPdf,
  exportSrt,
  exportTxt
} from './exporter'
import { auditCharacterVoices } from './voice-audit'
import { audioWaveform, ensureVideoProxy, readWaveformCache, writeWaveformCache } from './media-derive'
import {
  applyEditPlan,
  assistantMessage,
  assistantSources,
  assistantSystemPrompt,
  contextForAssistant,
  createPlanFromDraft,
  draftEditPlan,
  localAssistantReply
} from './intent'
import { ensureDemoProjects } from './seed'
import { runStudioAgentTool } from './agent-tools'
import { creativePromptContext, selectCreativePrompts } from './prompt-library'

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

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
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

function isoStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
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
      voices: voices.voices,
      ...(voices.error ? { voiceError: voices.error } : {}),
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
    const seeds = readSeeds(logline, input.title)
    const aspect = input.aspect === '9:16' || input.aspect === '1:1' ? input.aspect : '16:9'
    const project = this.store.newProject({
      kind,
      title: str(input.title).trim() || seeds.title,
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
    project.stages.blueprint = { status: 'ready', updatedAt: nowMs(), message: '写一句，生成第一版蓝图' }
    project.messages.push(
      assistantMessage(
        'assistant',
        `这里是「${project.title}」的创作台。先点“生成蓝图”，我会把故事主线、人物、结构和花费区间一次说清；你确认后才开始产生内容。`
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
      if (Number.isFinite(Number(request.wordTarget)) && Number(request.wordTarget) > 0) chapter.wordTarget = Math.round(Number(request.wordTarget))
      if (typeof request.content === 'string') {
        const content = request.content.slice(0, 2_000_000)
        if (content !== previous) {
          if (previous.trim()) this.store.addChapterVersion(chapter, previous, '手改前自动留档')
          chapter.content = content
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
        wordTarget: num(request.wordTarget, 2500),
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
            ...(typeof next.wordTarget === 'number' ? { wordTarget: Math.max(100, Math.min(20_000, next.wordTarget)) } : {})
          }
        })
      }
      if (blueprint.approved) {
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
    const episode = {
      id: studioId('ep'),
      number: 1,
      title: source.title,
      synopsis: source.logline,
      sceneIds: [] as string[],
      durationSec: chapters.length * 8,
      updatedAt: now
    }
    const scenes = chapters.map((chapter, index) => {
      const scene = {
        id: studioId('scene'),
        episodeId: episode.id,
        number: index + 1,
        title: chapter.title,
        synopsis: chapter.synopsis || chapter.content.replace(/\s+/g, ' ').slice(0, 220),
        location: source.places[index % Math.max(1, source.places.length)]?.name ?? '主要场景',
        timeOfDay: index % 2 ? '夜' : '日',
        characters: source.characters.slice(0, 3).map((character) => character.name),
        beat: chapter.beats[0] || chapter.synopsis,
        sourceChapterId: chapter.id,
        updatedAt: now
      }
      episode.sceneIds.push(scene.id)
      return scene
    })
    const shots: StudioShot[] = chapters.map((chapter, index): StudioShot => ({
      id: studioId('shot'),
      sceneId: scenes[index].id,
      number: index + 1,
      title: chapter.title,
      action: chapter.synopsis || chapter.content.replace(/\s+/g, ' ').slice(0, 220),
      camera: index % 3 === 0 ? '缓慢推近' : index % 3 === 1 ? '固定镜头' : '侧向跟拍',
      shotSize: index % 4 === 0 ? '全景' : index % 4 === 1 ? '中景' : '特写',
      durationSec: 8,
      dialogue: '',
      speaker: '',
      voiceId: '',
      prompt: [
        chapter.synopsis || chapter.content.slice(0, 220),
        target.styleBible.look,
        `改编自第 ${chapter.number} 章《${chapter.title}》`,
        '画面主体清晰，保持人物与服装连续，不出现文字与水印'
      ].filter(Boolean).join('。'),
      negative: target.styleBible.negative.join('，') || '文字，水印，换脸',
      referenceCharacterIds: [],
      referencePlaceIds: [],
      referencePropIds: [],
      imageAssetId: null,
      videoAssetId: null,
      voiceAssetId: null,
      imageCandidates: [],
      videoCandidates: [],
      continuity: `承接第 ${chapter.number} 章《${chapter.title}》的事件与人物状态`,
      lockedReference: false,
      status: 'ready',
      updatedAt: now
    }))
    target.episodes = [episode]
    target.scenes = scenes
    target.shots = shots
    target.timeline = { ...target.timeline, durationSec: shots.reduce((sum, shot) => sum + shot.durationSec, 0) }
    const draft = localBlueprint(target, { imagesReady: false, textConfigured: false })
    target.blueprint = {
      ...draft,
      approved: true,
      approvedAt: now,
      source: 'local',
      storyCore: source.blueprint?.storyCore ?? source.logline,
      pitch: source.blueprint?.pitch ?? source.logline,
      structure: `由《${source.title}》${chapters.length} 章正文改编为 ${shots.length} 镜`,
      characters: target.characters,
      places: target.places,
      units: shots.map((shot, index) => ({
        index: index + 1,
        title: shot.title,
        summary: shot.action,
        seconds: shot.durationSec,
        camera: shot.camera,
        shotSize: shot.shotSize,
        dialogue: '',
        speaker: ''
      })),
      warnings: [`已保留 ${chapters.length} 个来源章节；每镜的来源章节写在场景 sourceChapterId 中。`],
      createdAt: now
    }
    target.stage = 'storyboard'
    target.stages.blueprint = { status: 'done', updatedAt: now, message: '改编蓝图已生成', progress: 100 }
    target.stages.outline = { status: 'done', updatedAt: now, message: `${shots.length} 镜计划已就位`, progress: 100 }
    target.stages.storyboard = { status: 'ready', updatedAt: now, message: `${shots.length} 镜待补充画面`, progress: 0 }
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
    return this.result(target, { message: `已改编为 ${shots.length} 镜漫剧，来源章节保留在场景里。` })
  }

  private async generateBlueprint(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    if (project.blueprint?.approved && project.chapters.some((chapter) => chapter.content.trim())) {
      throw new Error('这部作品已经有正文。重新生成蓝图不会自动覆盖手稿；如需试验，请复制一个作品后再改。')
    }
    const useModel = request.useModel !== false
    const runtime = studioTextRuntime(project.runtime.strategy)
    // 蓝图批准前只做本地结构稿：先把故事核、人物与预算摆清楚，不在用户确认前调用付费模型。
    const textConfigured = runtime.configured && useModel && Boolean(project.blueprint?.approved)
    const media = await getMediaService().status().catch(() => null)
    const imagesReady = Boolean(media?.models.find((model) => model.id === 'image')?.ready)
    const draft = localBlueprint(project, { imagesReady, textConfigured })
    if (runtime.configured && useModel && !project.blueprint?.approved) {
      draft.warnings = [...draft.warnings, '蓝图确认前先用本机生成；确认后可以点“用模型重写”。']
    }
    const estimated = textConfigured
      ? estimateTextCostCny(project.logline.length + 3000, project.kind === 'drama' ? 3000 : 6000, project.runtime.strategy)
      : 0
    const requestId = str(request.requestId) || undefined
    const inputHash = sha256Buffer(Buffer.from(`blueprint:${project.id}:${project.logline}:${project.kind}:${project.brief.form}`))
    const job = await this.launchJob(project, {
      kind: 'text',
      label: '生成创作蓝图',
      stage: 'blueprint',
      ...(requestId ? { requestId } : {}),
      inputHash,
      estimatedCostCny: estimated,
      costNote: textConfigured ? '按当前文本模型参考价估算' : '本机生成，不调用模型',
      retry: { action: 'generate-blueprint', payload: { useModel } },
      run: async (snapshot, ctx) => {
        let blueprint = draft
        let cost: number | null = 0
        let costNote = '本机生成，不调用模型'
        let message = '蓝图已生成（本机生成）。'
        if (textConfigured) {
          ctx.progress('正在写蓝图', 12)
          try {
            const result = await completeCreativeText({
              system: `${BLUEPRINT_SYSTEM}${creativePromptContext({
                kind: snapshot.kind,
                task: 'blueprint',
                query: `${snapshot.logline} ${snapshot.brief.genre} ${snapshot.brief.tone} ${snapshot.brief.form} ${snapshot.brief.constraints.join(' ')}`,
                limit: 6
              })}`,
              prompt: blueprintPrompt(snapshot, draft),
              maxTokens: snapshot.kind === 'drama' ? 5000 : 7000,
              signal: ctx.signal,
              strategy: snapshot.runtime.strategy
            })
            const parsed = extractJson<Record<string, unknown>>(result.text)
            if (!parsed) throw new Error('模型返回的蓝图不是可解析的 JSON。')
            blueprint = normalizeModelBlueprint(snapshot, parsed, result.model, draft)
            cost = result.costCny
            costNote = result.costNote ?? '按实际 token 记录'
            message = `蓝图已生成（${result.model}）。`
          } catch (err) {
            if (ctx.signal.aborted) throw err
            const reason = err instanceof Error ? err.message : String(err)
            blueprint = {
              ...draft,
              warnings: [...draft.warnings, `模型生成失败，已改用本机生成：${reason}`]
            }
            message = `模型生成失败，已改用本机生成：${reason}`
          }
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
      project.stage = project.kind === 'drama' ? 'storyboard' : 'writing'
      if (project.kind === 'drama') {
        project.stages.outline = { status: 'done', updatedAt: nowMs(), message: '镜头计划已建立', progress: 100 }
        project.stages.storyboard = { status: 'ready', updatedAt: nowMs(), message: '可开始生成画面', progress: 100 }
      } else {
        project.stages.writing = { status: 'ready', updatedAt: nowMs(), message: '可以开始写第一章', progress: 0 }
      }
    }
    project.messages.push(
      assistantMessage('assistant', hasWrittenChapters ? '蓝图已更新，已有正文与章节保持不变。' : `蓝图已确认，${project.kind === 'drama' ? `${project.shots.length} 个镜头已就位。下一步可以生成画面。` : `${project.chapters.length} 章大纲已就位。下一步可以开始写第一章。`}`)
    )
    this.store.save(project, '确认蓝图', { snapshot: true })
    this.emitProject(project)
    return this.result(project)
  }

  private async generateOutline(request: { [key: string]: unknown }): Promise<StudioActionResult> {
    const projectId = safeProjectId(str(request.projectId))
    const project = this.store.readProject(projectId)
    if (!project.blueprint?.approved) throw new Error('请先看一遍并确认蓝图。')
    const useModel = request.useModel !== false
    const runtime = studioTextRuntime(project.runtime.strategy)
    const textConfigured = runtime.configured && useModel
    const estimated = textConfigured ? estimateTextCostCny(project.blueprint.storyCore.length + 2000, 4000, project.runtime.strategy) : 0
    const job = await this.launchJob(project, {
      kind: 'text',
      label: project.kind === 'drama' ? '生成剧本与镜头计划' : '生成章纲',
      stage: 'outline',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`outline:${project.id}:${project.blueprint.storyCore}`)),
      estimatedCostCny: estimated,
      costNote: textConfigured ? '按当前文本模型参考价估算' : '本机生成，不调用模型',
      retry: { action: 'generate-outline', payload: { useModel } },
      run: async (snapshot, ctx) => {
        let blueprint = snapshot.blueprint as StudioBlueprint
        let cost: number | null = 0
        let message = '大纲已更新（本机生成）。'
        if (textConfigured) {
          ctx.progress('正在拆大纲', 20)
          try {
            const result = await completeCreativeText({
              system: `${OUTLINE_SYSTEM}${creativePromptContext({
                kind: snapshot.kind,
                task: snapshot.kind === 'drama' ? 'storyboard' : 'outline',
                query: `${blueprint.storyCore} ${blueprint.structure} ${blueprint.units.map((unit) => unit.title).join(' ')} 结构 节奏 伏笔 情绪`,
                limit: 6
              })}`,
              prompt: outlinePrompt(snapshot, blueprint),
              maxTokens: 5000,
              signal: ctx.signal,
              strategy: snapshot.runtime.strategy
            })
            const parsed = extractJson<Record<string, unknown>>(result.text)
            if (parsed && Array.isArray(parsed.units)) {
              const units = normalizeUnits(snapshot.kind, parsed.units, blueprint.units, blueprint.styleBible)
              blueprint = { ...blueprint, units, source: 'model', model: result.model }
              cost = result.costCny
              message = `大纲已更新（${result.model}）。`
            } else {
              throw new Error('模型没有返回可解析的 units。')
            }
          } catch (err) {
            if (ctx.signal.aborted) throw err
            message = `模型大纲失败，保留原大纲：${err instanceof Error ? err.message : String(err)}`
          }
        }
        const finalBlueprint = blueprint
        ctx.progress('整理章节与镜头', 82)
        return {
          message,
          costCny: cost,
          costNote: textConfigured ? '按实际 token 记录' : '本机生成，不调用模型',
          apply: (fresh) => {
            fresh.blueprint = { ...finalBlueprint }
            if (fresh.kind === 'drama') {
              const hasAssets = fresh.shots.some((shot) => shot.imageAssetId || shot.videoAssetId || shot.voiceAssetId)
              if (!fresh.shots.length || !hasAssets) {
                applyDramaOutline(fresh, finalBlueprint)
                fresh.stage = 'storyboard'
                fresh.stages.outline = { status: 'done', updatedAt: nowMs(), message: '镜头计划已更新', progress: 100 }
              } else {
                updateDramaShots(fresh, finalBlueprint)
                fresh.stages.outline = { status: 'done', updatedAt: nowMs(), message: '已更新未生成镜头的字段', progress: 100 }
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
      costNote: textConfigured ? '按当前文本模型参考价估算' : '本机生成，不调用模型',
      retry: { action: 'generate-chapter', payload: { chapterId, useModel, instruction } },
      run: async (snapshot, ctx) => {
        const current = snapshot.chapters.find((item) => item.id === chapterId)
        if (!current) throw new Error('这一章已被删除。')
        let content = ''
        let source: 'model' | 'local' = 'local'
        let modelLabel = '本地结构稿'
        let cost: number | null = 0
        let costNote = '本机生成，不调用模型'
        let message = ''
        if (textConfigured) {
          ctx.progress('正在写正文', 15)
          try {
            const result = await completeCreativeText({
              system: `${PROSE_SYSTEM}${creativePromptContext({
                kind: snapshot.kind,
                task: 'chapter',
                query: `${current.title} ${current.synopsis} ${current.beats.join(' ')} ${instruction}`,
                limit: 6
              })}`,
              prompt: chapterPrompt(snapshot, current, instruction),
              maxTokens: Math.min(8000, Math.max(1200, Math.round(target * 1.7))),
              temperature: 0.9,
              signal: ctx.signal,
              strategy: snapshot.runtime.strategy
            })
            content = stripProseDecorations(result.text)
            source = 'model'
            modelLabel = result.model
            cost = result.costCny
            costNote = result.costNote ?? '按实际 token 记录'
            message = `第 ${current.number} 章已生成（${result.model}）。`
          } catch (err) {
            if (ctx.signal.aborted) throw err
            content = localChapterDraft(snapshot, current, instruction)
            source = 'local'
            message = `模型写作失败，已生成本地结构稿：${err instanceof Error ? err.message : String(err)}`
          }
        } else {
          ctx.progress('正在整理本地结构稿', 30)
          content = localChapterDraft(snapshot, current, instruction)
          message = '已生成本地结构稿；不会自动覆盖已有正文。'
        }
        if (!content.trim()) throw new Error('没有生成可用正文。')
        const wordCount = countWords(content)
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
              label: source === 'model' ? `模型稿 · ${modelLabel}` : '本地结构稿',
              source,
              ...(source === 'model' ? { model: modelLabel } : {}),
              ...(instruction ? { note: instruction } : {}),
              createdAt: nowMs(),
              wordCount
            })
            targetChapter.candidates = targetChapter.candidates.slice(0, 6)
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
    if (!runtime.configured) throw new Error('润色需要可用的文本模型；本地结构稿不冒充润色结果。')
    const instruction = str(request.instruction).slice(0, 1200)
    const estimated = estimateTextCostCny(chapter.content.length + instruction.length, chapter.content.length, project.runtime.strategy) ?? 0
    const job = await this.launchJob(project, {
      kind: 'text',
      label: `润色第 ${chapter.number} 章 · ${chapter.title}`,
      stage: 'writing',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`polish:${project.id}:${chapter.id}:${chapter.revision}:${instruction}`)),
      estimatedCostCny: estimated,
      costNote: '按当前文本模型参考价估算',
      retry: { action: 'polish-chapter', payload: { chapterId, instruction } },
      run: async (snapshot, ctx) => {
        const current = snapshot.chapters.find((item) => item.id === chapterId)
        if (!current) throw new Error('这一章已被删除。')
        ctx.progress('正在润色', 20)
        const result = await completeCreativeText({
          system: `${PROSE_SYSTEM}${creativePromptContext({
            kind: snapshot.kind,
            task: 'rewrite',
            query: `${current.title} ${instruction} 润色 去 AI 腔 对白 克制`,
            limit: 6
          })}`,
          prompt: [
            `请润色以下章节正文。只改语言、节奏、动作与对白，不改情节、人名、事实、段落顺序和章节结尾。`,
            `用户额外要求：${instruction || '更具体、更克制、去 AI 腔。'}`,
            '输出完整正文，不要标题、不要解释、不要 Markdown。',
            '',
            current.content
          ].join('\n'),
          maxTokens: Math.min(8000, Math.max(1200, Math.round(countWords(current.content) * 1.35))),
          temperature: 0.7,
          signal: ctx.signal,
          strategy: snapshot.runtime.strategy
        })
        const content = stripProseDecorations(result.text)
        if (!content.trim()) throw new Error('模型没有返回可用正文。')
        return {
          message: `润色稿已生成，${countWords(content)} 字；采用前不会覆盖正文。`,
          costCny: result.costCny,
          costNote: result.costNote ?? '按实际 token 记录',
          outputs: [{ label: `第 ${current.number} 章润色候选`, path: undefined }],
          apply: (fresh) => {
            const target = fresh.chapters.find((item) => item.id === chapterId)
            if (!target) return
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
      ...selectCreativePrompts({ kind: project.kind, task: 'image', query: `${chapter.title} ${instruction} 插图`, limit: 1 }).map((module) => module.prompt),
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
      chapter.candidates = chapter.candidates.filter((item) => item.id !== candidate.id)
      chapter.revision += 1
      chapter.status = 'done'
      chapter.locked = true
      chapter.updatedAt = nowMs()
      this.staleAfterManuscriptChange(project)
      project.facts = project.facts.map((fact) => (fact.chapterId === chapter.id ? fact : fact))
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

  private generateStoryboard(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
      if (project.kind !== 'drama') throw new Error('只有漫剧需要分镜。')
      if (!project.blueprint?.approved) throw new Error('请先确认蓝图。')
      if (!project.shots.length) {
        applyDramaOutline(project, project.blueprint)
      } else {
        updateDramaShots(project, project.blueprint)
      }
      project.stages.storyboard = { status: 'ready', updatedAt: nowMs(), message: `${project.shots.length} 镜已就位`, progress: 100 }
      project.stage = 'storyboard'
      this.store.save(project, '生成分镜', { snapshot: true })
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

  private mediaReady(model: 'image' | 'video'): Promise<{ ok: boolean; message: string; status: Awaited<ReturnType<ReturnType<typeof getMediaService>['status']>> }> {
    return getMediaService()
      .status()
      .then((status) => {
        const target = status.models.find((item) => item.id === model)
        if (!status.engine.online) return { ok: false, message: status.engine.message, status }
        if (!target?.ready) {
          return {
            ok: false,
            message: `${model === 'image' ? '图片' : '视频'}模型未就绪：${target?.missing?.slice(0, 3).join('、') || '请到设置 → 多媒体检查模型文件'}`,
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
      project.stages.timeline = { status: 'ready', updatedAt: nowMs(), message: `${added.length} 条逐句字幕已对齐`, progress: 70 }
      this.staleStages(project, ['review', 'delivery'], '字幕已重排，旧检查与交付物需要重新生成')
      this.store.save(project, '按台词逐句对齐字幕', { snapshot: true })
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
    const character = project.characters.find((item) => shot.referenceCharacterIds.includes(item.id))
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
      ...selectCreativePrompts({ kind: project.kind, task: 'image', query: `${shot.action} ${shot.continuity} ${shot.shotSize} ${instruction}`, limit: 2 }).map((module) => module.prompt),
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
          `环境运动：${currentShot.continuity || '保持雨向、风向与道具位置一致'}。`,
          instruction ? `这次修改要求：${instruction}。` : '',
          snapshot.styleBible.look ? `风格与光线：${snapshot.styleBible.look}。` : '',
          ...selectCreativePrompts({ kind: snapshot.kind, task: 'video', query: `${currentShot.action} ${currentShot.camera} ${currentShot.continuity} ${instruction}`, limit: 2 }).map((module) => module.prompt),
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
            const next = this.store.readProject(fresh.id)
            void next
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
    const preferred =
      str(request.voiceId) ||
      tts.voice ||
      project.characters.find((character) => character.voiceId)?.voiceId ||
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
      inputHash: sha256Buffer(Buffer.from(`voice:${tts.mode}:${tts.model}:${targets.map((shot) => `${shot.id}:${shot.dialogue}:${preferred}`).join('|')}`)),
      ...(cloudMode ? {} : { estimatedCostCny: 0 }),
      costNote: voiceNote,
      retry: { action: 'generate-voice', payload: { shotIds: targets.map((shot) => shot.id), voiceId: preferred } },
      run: async (snapshot, ctx) => {
        const generated: Array<{ shotId: string; asset: StudioAsset }> = []
        const errors: string[] = []
        for (const [index, shot] of targets.entries()) {
          if (ctx.signal.aborted) break
          ctx.progress(`第 ${index + 1}/${targets.length} 段 · 配音`, 4 + Math.round((index / targets.length) * 86))
          const workDir = join(this.store.tempDir(snapshot.id), `tts-${shot.id}`)
          const character = snapshot.characters.find((item) => item.name === shot.speaker)
          const voice = character?.voiceId || shot.voiceId || preferred
          const extension = cloudMode ? 'mp3' : 'wav'
          const output = join(workDir, `voice-${Date.now().toString(36)}.${extension}`)
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
    const kind = str(request.kind)
    const isSfx = ['rain', 'umbrella', 'heartbeat', 'street'].includes(kind)
    const mood = musicMood(str(request.mood) || project.brief.tone)
    const seconds = Math.max(5, Math.min(300, num(request.seconds, isSfx ? 6 : Math.max(20, Math.round(project.timeline.durationSec || project.brief.targetSeconds || 54)))))
    const label = isSfx ? `生成音效 · ${kind}` : `生成配乐 · ${mood.label}`
    const job = await this.launchJob(project, {
      kind: isSfx ? 'sfx' : 'music',
      label,
      stage: 'music',
      requestId: str(request.requestId) || undefined,
      inputHash: sha256Buffer(Buffer.from(`music:${project.id}:${kind}:${mood.id}:${seconds}`)),
      estimatedCostCny: 0,
      costNote: '本地器乐草稿，不计模型费用',
      retry: { action: 'generate-music', payload: { kind, mood: mood.id, seconds } },
      run: async (snapshot, ctx) => {
        const workDir = join(this.store.tempDir(snapshot.id), `audio-${Date.now().toString(36)}`)
        mkdirSync(workDir, { recursive: true })
        const output = join(workDir, isSfx ? `sfx-${kind}.wav` : `music-${mood.id}.wav`)
        ctx.progress(isSfx ? '设计音效' : '编配器乐', 30)
        if (isSfx) synthesizeSfx(kind as 'rain' | 'umbrella' | 'heartbeat' | 'street', output, seconds)
        else synthesizeMusic({ mood: mood.id, seconds, outputPath: output, title: snapshot.title, seed: snapshot.revision })
        ctx.progress('入库音频', 88)
        const asset = await this.store.addAsset(snapshot, {
          filePath: output,
          title: isSfx ? `音效 · ${kind}` : `配乐 · ${mood.label}`,
          mime: 'audio/wav',
          kindHint: 'audio',
          tags: isSfx ? ['sfx', kind] : ['music', mood.id],
          origin: { model: isSfx ? 'Morrow 本地音效' : 'Morrow 本地器乐', source: 'local' },
          metadata: { durationSec: seconds }
        })
        try {
          rmSync(workDir, { recursive: true, force: true })
        } catch {
        }
        return {
          message: `${isSfx ? '音效' : '配乐'}已生成：${asset.title} · ${seconds} 秒`,
          costCny: 0,
          costNote: '本地器乐草稿，不计模型费用',
          outputs: [{ label: asset.title, assetId: asset.id }],
          apply: (fresh) => {
            if (!fresh.assets.some((item) => item.id === asset.id)) fresh.assets.push(asset)
            const hasMusic = fresh.assets.some((item) => item.kind === 'audio' && item.tags.includes('music'))
            fresh.stages.music = {
              status: hasMusic || isSfx ? 'done' : 'ready',
              updatedAt: nowMs(),
              message: hasMusic ? '配乐已就位' : '已有音效，还没有配乐',
              progress: hasMusic ? 100 : 50
            }
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
      if (project.timeline.clips.length && request.force !== true) {
        throw new Error('时间线已有片段。自动排好会按镜头重建，覆盖裁剪、音量与转场；确认后请用 force=true 再执行。')
      }
      project.timeline = buildTimelineFromProject(project)
      project.stage = 'timeline'
      project.stages.timeline = { status: 'ready', updatedAt: nowMs(), message: '时间线已自动装配', progress: 100 }
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
        try {
          const poster = join(this.store.exportsDir(snapshot.id), `${basename(result.path, '.' + format)}-poster.jpg`)
          const ok = await extractPoster(result.path, Math.min(2, result.durationSec / 3), poster)
          if (ok) {
            const posterBytes = statSync(poster).size
            const posterDelivery: StudioDelivery = {
              id: studioId('delivery'),
              kind: 'cover',
              label: '成片预览帧',
              path: poster.slice(this.store.projectDir(snapshot.id).length + 1).replace(/\\/g, '/'),
              bytes: posterBytes,
              sha256: sha256File(poster),
              createdAt: nowMs()
            }
            void posterDelivery
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
            fresh.deliveries = fresh.deliveries.slice(0, 30)
            fresh.stages.delivery = { status: 'done', updatedAt: nowMs(), message: delivery.label, progress: 100 }
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
              path: asset.path,
              question: '这是漫剧的一个分镜镜头。只检查画面本身的明显问题：手、脸、眼睛、雨向、道具、服装、人物数量是否异常或前后不一致。请先给一句结论（通过/有问题），再列出最多三条具体问题；不要评价剧情，不要编造看不清的细节。',
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
        if (!snapshot.timeline.clips.length) {
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
      if (!project.assets.some((asset) => asset.kind === 'audio' && asset.tags.includes('music'))) {
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

  private review(request: { [key: string]: unknown }): StudioActionResult {
    const projectId = safeProjectId(str(request.projectId))
    return this.resultSync(projectId, (project) => {
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
    const latestVideo = [...project.deliveries].reverse().find((delivery) => isStudioVideoDelivery(delivery.kind))
    const hasImages = project.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length >= 4
    const commonFormats: StudioExportPreflight['formats'] = [
      { format: 'txt', label: 'TXT', ready: true, note: '纯文本，无字体依赖' },
      { format: 'md', label: 'Markdown', ready: true, note: '纯文本，无字体依赖' },
      { format: 'docx', label: 'DOCX', ready: true, note: 'eastAsia=宋体，读取器按系统字体回退' },
      { format: 'epub', label: 'EPUB', ready: true, note: '写入字体回退栈，由阅读器本机字体渲染' },
      { format: 'pdf', label: 'PDF', ready: true, note: 'Chromium 打印，嵌入实际使用字形子集' },
      { format: 'cover', label: '封面', ready: true, note: '1200×1600 真实渲染' },
      { format: 'srt', label: 'SRT', ready: true, note: '纯文本字幕' },
      { format: 'ass', label: 'ASS', ready: true, note: '保留字幕样式' },
      { format: 'package', label: '工程包', ready: true, note: '保留章节、素材与任务记录' }
    ]
    const formats = project.kind === 'drama'
      ? [
          ...commonFormats.filter((item) => ['srt', 'ass', 'package'].includes(item.format)),
          { format: 'mp4', label: 'MP4 / MOV / MKV / WebM', ready: ffmpegAvailable && project.timeline.clips.length > 0, note: ffmpegAvailable ? (project.timeline.clips.length ? '按 1080p/4K 合成' : '先装配时间线') : '需要本机 FFmpeg' },
          { format: 'audio', label: 'WAV / MP3 / AAC / FLAC', ready: ffmpegAvailable && Boolean(latestVideo), note: latestVideo ? '从最近成片提取音轨' : '先合成一版成片' },
          { format: 'comic', label: '四格漫画', ready: ffmpegAvailable && hasImages, note: hasImages ? '按 2×2 排版' : '至少需要 4 镜有画面' },
          { format: 'folder', label: '发布套组', ready: ffmpegAvailable && Boolean(latestVideo), note: '成片 + 封面 + 字幕' }
        ]
      : [
          ...commonFormats,
          { format: 'folder', label: '发布套组', ready: true, note: '手稿 + 目录 + 封面 + 字体回退说明' }
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
            next.stages.delivery = { status: 'done', updatedAt: nowMs(), message: delivery.label, progress: 100 }
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
    const wantsCheck = /检查|审稿|连续性|缺失素材/.test(text) && !/慢|快|压低|调大|改|重做|生成|写|导出|合成/.test(text)
    const sources = assistantSources(project, selection)
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
    project.messages.push(assistantMessage('user', text))
    let reply = localAssistantReply(project, text, plan)
    let cost: number | null = 0
    let costNote = '本地策划，不调用模型'
    const runtime = studioTextRuntime(project.runtime.strategy)
    if (plan.actions.length === 0 && runtime.configured) {
      const estimate = estimateTextCostCny(text.length + 1200, 1200, project.runtime.strategy) ?? 0
      const limit = project.runtime.budget.limit
      if (limit > 0 && project.runtime.budget.spent + estimate > limit) {
        cost = 0
        costNote = `预算不足，本轮只给本地建议（预计需 ¥${estimate.toFixed(2)}，预算上限 ¥${limit}）`
      } else {
        try {
          const result = await completeCreativeText({
            system: assistantSystemPrompt(project.kind),
            prompt: `${contextForAssistant(project, selection)}\n\n用户说：${text}\n\n请直接回答，并给出下一步可执行建议。不要声称已经修改了作品。`,
            maxTokens: 1200,
            temperature: 0.7,
            strategy: project.runtime.strategy
          })
          reply = { text: result.text, plan }
          cost = result.costCny
          costNote = result.costNote ?? '按模型参考价折算'
        } catch {
          // 模型失败时保留本地可执行提示
        }
      }
    }
    project.messages.push(assistantMessage('assistant', reply.text, reply.plan, sources))
    project.messages = project.messages.slice(-80)
    this.charge(project, cost)
    project.runtime.textModelNote = runtime.configured ? runtime.model?.label : '本地结构稿'
    this.store.save(project, '协作者回复', { snapshot: false })
    this.emitProject(project)
    return this.result(project, { plan: reply.plan, message: costNote })
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
    this.assertBudget(project, plan.estimate.cost)
    const undoFile = this.store.writeVersion(project, `应用修改计划前：${plan.title}`)
    plan.undoVersion = basename(undoFile)
    const applied = applyEditPlan(project, plan)
    project.stage = applied.timelineChanged ? 'timeline' : project.stage
    this.store.save(project, `应用修改计划：${plan.title}`, { snapshot: false })
    plan.appliedRevision = project.revision
    this.store.savePassive(project)
    this.emitProject(project)
    let firstJob: StudioJob | undefined
    const queueErrors: string[] = []
    for (const action of applied.regenerate) {
      const shot = project.shots.find((item) => item.id === action.shotId)
      if (!shot) continue
      try {
        let result: StudioActionResult
        if (action.kind === 'image') {
          result = await this.generateShotImage({ projectId, shotId: shot.id, instruction: action.instruction })
        } else if (action.kind === 'video') {
          result = await this.generateShotVideo({ projectId, shotId: shot.id, instruction: action.instruction })
        } else {
          result = await this.generateVoice({ projectId, shotId: shot.id })
        }
        firstJob = firstJob ?? result.job
      } catch (err) {
        queueErrors.push(`第 ${shot.number} 镜：${err instanceof Error ? err.message : String(err)}`)
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

const BLUEPRINT_SYSTEM = `你是资深中文故事策划，为 Morrow 创作台写可执行的创作蓝图。
只输出一个合法 JSON 对象，不要 Markdown、不要解释。字段：
{"title":string,"storyCore":string,"emotion":string,"audience":string,"pitch":string,"structure":string,
"characters":[{"name":string,"role":string,"age":string,"look":string,"desire":string,"fear":string,"secret":string,"arc":string,"relationships":[{"target":string,"label":string}]}],
"places":[{"name":string,"description":string}],
"units":[{"index":number,"title":string,"summary":string,"wordTarget":number,"seconds":number,"camera":string,"shotSize":string,"dialogue":string,"speaker":string}],
"styleBible":{"look":string,"palette":string[],"camera":string,"sound":string,"negative":string[]}}
中短篇/长篇用 wordTarget，不要 seconds/camera/shotSize；漫剧用 seconds/camera/shotSize/dialogue/speaker，不要 wordTarget。
人物要具体，结构要能落到章/镜，不要空话。只写中文。`

const OUTLINE_SYSTEM = `你是中文故事结构编辑。只输出一个合法 JSON：{"units":[...]}。
中短篇/长篇每项 {"index":number,"title":string,"summary":string,"wordTarget":number}；
漫剧每项 {"index":number,"title":string,"summary":string,"seconds":number,"camera":string,"shotSize":string,"dialogue":string,"speaker":string}。
保持原有人物与设定，不要引入未经要求的新主角。只写中文。`

const PROSE_SYSTEM = `你是中文小说作者。只输出正文，不要标题、不要 Markdown、不要解释、不要写“本章完”。
文风克制、具体，用动作和物件承载情绪；避免网络流行语和空洞抒情。
严格延续已有人物设定与前文，不改名、不换视角；每段自然推进，结尾留下下一步的牵引。`

function blueprintPrompt(project: StudioProject, fallback: StudioBlueprint): string {
  return [
    `作品形态：${studioKindLabel(project.kind)}（${project.brief.form}）`,
    `一句话：${project.logline}`,
    `类型：${project.brief.genre}；受众：${project.brief.audience}；语气：${project.brief.tone}`,
    `目标：${project.kind === 'drama' ? `${project.brief.targetSeconds ?? 96} 秒` : `${project.brief.targetWords ?? 18000} 字`}`,
    `必须遵守：${project.brief.constraints.length ? project.brief.constraints.join('；') : '无额外约束'}`,
    project.kind === 'drama'
      ? `请拆成约 ${fallback.units.length} 个镜头，时长合计约 ${project.brief.targetSeconds ?? 96} 秒。`
      : `请规划 ${fallback.units.length} 章，章名具体，不要“第X章”式空标题。`,
    '参考基调（可改写，不要照抄）：',
    JSON.stringify({
      storyCore: fallback.storyCore,
      emotion: fallback.emotion,
      structure: fallback.structure,
      characters: fallback.characters.map((character) => ({ name: character.name, role: character.role, look: character.look })),
      styleBible: fallback.styleBible
    })
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

function chapterPrompt(project: StudioProject, chapter: StudioChapter, instruction: string): string {
  const sorted = [...project.chapters].sort((a, b) => a.number - b.number)
  const index = sorted.findIndex((item) => item.id === chapter.id)
  const previous = index > 0 ? sorted[index - 1] : null
  const facts = project.facts
    .filter((fact) => !fact.chapterId || fact.chapterId === chapter.id || fact.chapterId === previous?.id)
    .slice(0, 18)
    .map((fact) => `${fact.subject}${fact.predicate}${fact.object}`)
  return [
    `作品：${project.title}`,
    `一句话：${project.logline}`,
    `类型与语气：${project.brief.genre}；${project.brief.tone}`,
    `本章：第 ${chapter.number} 章《${chapter.title}》`,
    `本章梗概：${chapter.synopsis}`,
    `本章节拍：${chapter.beats.join(' / ') || chapter.synopsis}`,
    `目标字数：约 ${chapter.wordTarget} 字（可上下浮动 15%）`,
    previous ? `上一章结尾：\n${previous.content.slice(-900)}` : '',
    previous ? `上一章梗概：${previous.synopsis}` : '',
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
  const units = normalizeUnits(project.kind, raw.units, fallback.units, fallback.styleBible)
  const styleRaw = raw.styleBible && typeof raw.styleBible === 'object' ? (raw.styleBible as Record<string, unknown>) : {}
  const styleBible = {
    look: str(styleRaw.look).slice(0, 1000) || fallback.styleBible.look,
    palette: Array.isArray(styleRaw.palette) ? arrayOfStrings(styleRaw.palette).slice(0, 8) : fallback.styleBible.palette,
    camera: str(styleRaw.camera).slice(0, 800) || fallback.styleBible.camera,
    sound: str(styleRaw.sound).slice(0, 800) || fallback.styleBible.sound,
    negative: Array.isArray(styleRaw.negative) ? arrayOfStrings(styleRaw.negative).slice(0, 12) : fallback.styleBible.negative,
    updatedAt: nowMs()
  }
  const title = str(raw.title).trim()
  if (title && project.title === '未命名作品') project.title = title.slice(0, 120)
  return {
    approved: false,
    source: 'model',
    model,
    storyCore: str(raw.storyCore).slice(0, 2000) || fallback.storyCore,
    emotion: str(raw.emotion).slice(0, 400) || fallback.emotion,
    audience: str(raw.audience).slice(0, 400) || fallback.audience,
    pitch: str(raw.pitch).slice(0, 1000) || fallback.pitch,
    structure: str(raw.structure).slice(0, 400) || fallback.structure,
    styleBible,
    characters: characters.length ? characters : fallback.characters,
    places: places.length ? places : fallback.places,
    units,
    estimate: { ...fallback.estimate, basis: 'mixed', note: fallback.estimate.note },
    warnings: [...fallback.warnings.filter((warning) => !warning.includes('未连接可用'))],
    createdAt: nowMs()
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
      if (kind === 'drama') {
        base.seconds = Math.max(3, Math.min(20, num(item.seconds, 8)))
        base.camera = str(item.camera).slice(0, 200) || '固定镜头，缓慢推近'
        base.shotSize = str(item.shotSize).slice(0, 80) || '中景'
        base.dialogue = str(item.dialogue).slice(0, 500)
        base.speaker = str(item.speaker).slice(0, 80)
      } else {
        base.wordTarget = Math.max(600, Math.min(8000, num(item.wordTarget, 2500)))
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
      chapter.updatedAt = nowMs()
    } else {
      const added = {
        id: studioId('ch'),
        volumeId: project.volumes[0]?.id ?? null,
        number: index + 1,
        title: unit.title,
        synopsis: unit.summary,
        beats: [],
        content: '',
        wordTarget: unit.wordTarget ?? 2500,
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

function probeDuration(file: string): number | undefined {  try {
    const ffprobe = resolveFfmpegPaths()?.ffprobe
    if (!ffprobe) return undefined
    const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000
    })
    const value = Number((result.stdout ?? '').trim())
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : undefined
  } catch {
    return undefined
  }
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
    const hasMusic = project.assets.some((asset) => asset.kind === 'audio' && asset.tags.includes('music'))
    if (!hasMusic) add('audio', 'info', '还没有配乐', '可以先合成草稿，再决定是否加音乐。')
    if (!project.timeline.clips.length) add('missing', 'warn', '时间线还没有装配', '点击“自动装配时间线”，再合成草稿。')
    const badClip = project.timeline.clips.find((clip) => clip.assetId && !project.assets.some((asset) => asset.id === clip.assetId))
    if (badClip) add('missing', 'error', '时间线引用了丢失的素材', `片段「${badClip.label}」找不到素材，请重新装配或替换。`, badClip.id)
    if (project.timeline.clips.length) {
      const subtitleCount = project.timeline.clips.filter((clip) => clip.kind === 'subtitle').length
      if (!subtitleCount) add('subtitle', 'info', '没有字幕', '台词会在配音轨里保留，但成片没有字幕。')
    }
    if (!project.deliveries.some((delivery) => isStudioVideoDelivery(delivery.kind))) add('missing', 'info', '还没有成片', '草稿合成约需几十秒。')
    if (!priorVisual.length) add('visual', 'info', '视觉检查需要真实视觉模型', '连接视觉模型后可以逐镜检查手部、脸、雨向与道具。')
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
  return [...priorVisual, ...checks]
}

let service: StudioService | null = null

export function getStudioService(): StudioService {
  if (!service) service = new StudioService()
  return service
}

export function resetStudioServiceForTest(store?: StudioStore): void {
  service = store ? new StudioService({ store }) : null
}
