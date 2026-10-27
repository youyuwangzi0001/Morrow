// Agent 工具 → 作品服务动作的适配层。
import type { StudioActionResult, StudioEngineStatus, StudioJob, StudioListResult, StudioProject, StudioProjectSummary } from '../../shared/studio'
import { countWords, studioKindLabel, timelineDuration } from '../../shared/studio'

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
