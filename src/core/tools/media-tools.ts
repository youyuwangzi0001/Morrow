/**
 * 本地多媒体工具：图片生成/编辑、参考图生视频、ffmpeg 剪辑、媒体探测与引擎诊断。
 * 真正的 HTTP / GPU / ffmpeg 工作由主进程注入的 MediaToolHandler 执行；
 * 这里负责参数校验、工作区边界、进度呈现与成品登记。
 */
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { Artifact, MediaToolMeta } from '../../shared/types'
import { abortError, newId } from '../util'
import type { MediaArtifactResult, MediaToolHandler, ToolContext } from '../types'
import { getNumber, getObjectArray, getString, getStringArray } from './args'
import { displayPath, resolveWorkspacePath } from './paths'
import { ToolInputError, errResult, okResult, oneLineInput, type ToolImpl } from './types'

const IMAGE_SIZES: Record<string, { width: number; height: number }> = {
  '1024x1024': { width: 1024, height: 1024 },
  '1344x768': { width: 1344, height: 768 },
  '768x1344': { width: 768, height: 1344 },
  '1536x1024': { width: 1536, height: 1024 },
  '1024x1536': { width: 1024, height: 1536 }
}

const VIDEO_ASPECTS = ['16:9', '9:16', '1:1'] as const
const VIDEO_QUALITIES = ['fast', 'balanced', 'high'] as const

/** 16:9 / 9:16 / 1:1 的常用档位，均对齐到 32 的倍数，兼顾显存与画质。 */
const VIDEO_SIZES: Record<(typeof VIDEO_ASPECTS)[number], Record<(typeof VIDEO_QUALITIES)[number], { width: number; height: number }>> = {
  '16:9': {
    fast: { width: 960, height: 544 },
    balanced: { width: 1152, height: 640 },
    high: { width: 1344, height: 768 }
  },
  '9:16': {
    fast: { width: 544, height: 960 },
    balanced: { width: 640, height: 1152 },
    high: { width: 768, height: 1344 }
  },
  '1:1': {
    fast: { width: 704, height: 704 },
    balanced: { width: 832, height: 832 },
    high: { width: 992, height: 992 }
  }
}

function requireHandler(ctx: ToolContext): MediaToolHandler {
  if (!ctx.media) {
    throw new ToolInputError(
      '本机多媒体功能不可用。',
      '请在「设置 → 多媒体」里配置并启动 ComfyUI 后重试；也可以先调用 media_status 查看缺什么。'
    )
  }
  return ctx.media
}

function requireWorkspace(ctx: ToolContext): string {
  if (!ctx.workspace) {
    throw new ToolInputError(
      '当前会话没有工作区，无法保存媒体成品。',
      '请先在顶栏选择一个工作文件夹，再生成或剪辑图片/视频。'
    )
  }
  return ctx.workspace
}

function resolveMediaInput(ctx: ToolContext, inputPath: string, label: string): string {
  const resolved = resolveWorkspacePath(inputPath, ctx.workspace, {
    requireExist: true,
    allowedExternalFiles: ctx.attachedFiles,
    escapeApproved: ctx.escapeApproved
  })
  if (resolved.isDirectory) {
    throw new ToolInputError(`${label}「${inputPath}」是文件夹。`, '请指定具体文件。')
  }
  return resolved.absolute
}

function resolveOutputPath(ctx: ToolContext, outputPath: string): string {
  const resolved = resolveWorkspacePath(outputPath, ctx.workspace, {
    requireExist: false,
    escapeApproved: ctx.escapeApproved
  })
  if (resolved.isDirectory) {
    throw new ToolInputError(`输出路径「${outputPath}」是文件夹。`, '请指定带扩展名的文件路径。')
  }
  return resolved.absolute
}

function progressReporter(ctx: ToolContext, verb: string): (update: { stage: string; percent?: number }) => void {
  let last = -1
  return (update) => {
    const percent =
      typeof update.percent === 'number' ? Math.min(100, Math.max(0, Math.round(update.percent))) : undefined
    if (percent !== undefined && percent === last) return
    if (percent !== undefined) last = percent
    const title = percent !== undefined ? `${verb} ${percent}%` : `${verb} · ${update.stage}`
    ctx.progress(update.stage, { title, ...(percent !== undefined ? { percent } : {}), status: 'running' })
  }
}

function mediaArtifact(
  result: MediaArtifactResult,
  title: string,
  kind: MediaToolMeta['kind'],
  ctx: ToolContext
): { artifact: Artifact; meta: MediaToolMeta } {
  const workspace = requireWorkspace(ctx)
  // 主进程返回的落盘路径必须仍在工作区内，防止引擎配置被篡改后越界。
  const checked = resolveWorkspacePath(result.path, workspace, { requireExist: true })
  if (checked.isDirectory) throw new ToolInputError('生成结果不是文件。', '请检查 ComfyUI 的输出目录配置。')
  const artifact: Artifact = {
    id: newId('artifact'),
    title,
    kind: 'file',
    path: checked.absolute,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  ctx.addArtifact(artifact)
  const meta: MediaToolMeta = {
    kind,
    path: checked.absolute,
    artifactId: artifact.id,
    title,
    model: result.model,
    engine: result.engine,
    bytes: result.bytes,
    ...(result.width ? { width: result.width } : {}),
    ...(result.height ? { height: result.height } : {}),
    ...(result.durationSec ? { durationSec: result.durationSec } : {}),
    ...(result.seed !== undefined ? { seed: result.seed } : {}),
    ...(result.elapsedMs ? { elapsedMs: result.elapsedMs } : {}),
    ...(result.thumbnailDataUrl ? { thumbnailDataUrl: result.thumbnailDataUrl } : {}),
    ...(result.referencePath ? { referencePath: result.referencePath } : {})
  }
  return { artifact, meta }
}

function mediaSummary(result: MediaArtifactResult): string {
  const parts = [
    result.width && result.height ? `${result.width}×${result.height}` : '',
    typeof result.durationSec === 'number' ? `${result.durationSec.toFixed(1)} 秒` : '',
    `${(result.bytes / 1024 / 1024).toFixed(1)} MB`,
    `用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒`
  ].filter(Boolean)
  return parts.join(' · ')
}

/* ── generate_image ──────────────────────────────────────────── */

export const generateImageTool: ToolImpl = {
  definition: {
    name: 'generate_image',
    description:
      '用本机 Qwen-Image 2.1 Turbo 生成图片，或带参考图做图像编辑。只在用户要图片/改图时调用。' +
      '提供参考图时输出跟随参考图尺寸，size 只对纯生成生效。' +
      'prompt 要写成具体画面：主体、动作、场景、光线、构图、风格；不要写「生成一张图片」这种空话。' +
      '提供 reference_path 时是编辑：prompt 必须用 <image1> 指代参考图，先写明要保持不变的部分（主体、姿势、构图、背景），再写改什么；' +
      '否则模型会重新画一个无关主体。产出会自动保存到工作区 media/ 并放入画布。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            '具体画面描述。编辑时示例：以 <image1> 为编辑目标，保持狐狸的脸、毛发、姿势和雪林背景不变，只在脖子上加一条红色针织围巾。'
        },
        reference_path: {
          type: 'string',
          description: '工作区内的参考图（可选）。提供时执行图像编辑；支持 PNG/JPG/WebP。'
        },
        size: {
          type: 'string',
          enum: Object.keys(IMAGE_SIZES),
          description: '输出尺寸（默认 1024x1024；16:9 视频首帧用 1344x768）'
        },
        seed: { type: 'number', description: '随机种子（可选）；复现同一画面时填写' }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    category: 'exec',
    risk: 'medium',
    titleFor: (input) =>
      `${input.reference_path ? '编辑图片' : '生成图片'}：${oneLineInput(input, 'prompt', 44) || '未命名'}`
  },
  async execute(input, ctx) {
    try {
      const media = requireHandler(ctx)
      requireWorkspace(ctx)
      const prompt = getString(input, 'prompt', { required: true, maxLength: 8_000 })
      const sizeKey = getString(input, 'size', { defaultValue: '1024x1024' })
      const size = IMAGE_SIZES[sizeKey]
      if (!size) throw new ToolInputError(`不支持的图片尺寸：${sizeKey}`, `可用尺寸：${Object.keys(IMAGE_SIZES).join('、')}。`)
      const referenceRaw = getString(input, 'reference_path', { defaultValue: '' })
      const referencePath = referenceRaw ? resolveMediaInput(ctx, referenceRaw, '参考图') : undefined
      const seedRaw = input.seed
      const seed =
        seedRaw === undefined || seedRaw === null || seedRaw === ''
          ? undefined
          : getNumber(input, 'seed', { min: 0, max: 4_294_967_295 })
      const startedAt = Date.now()
      const onProgress = progressReporter(ctx, referencePath ? '编辑图片' : '生成图片')
      onProgress({ stage: referencePath ? '上传参考图' : '准备生成', percent: 1 })
      const result = await media.generateImage({
        workspace: requireWorkspace(ctx),
        prompt,
        ...(referencePath ? { referencePath } : {}),
        width: size.width,
        height: size.height,
        ...(seed !== undefined ? { seed } : {}),
        signal: ctx.signal,
        onProgress
      })
      const title = `${referencePath ? '编辑图片' : '图片'} · ${prompt.replace(/\s+/g, ' ').slice(0, 28)}`
      const { artifact, meta } = mediaArtifact(result, title, 'image', ctx)
      ctx.progress('完成', { title: referencePath ? '图片已编辑' : '图片已生成', percent: 100 })
      const elapsed = Math.max(result.elapsedMs, Date.now() - startedAt)
      return okResult(
        [
          `${referencePath ? '已按参考图编辑' : '已生成'}图片《${title}》。`,
          `文件：${displayPath(artifact.path ?? result.path, ctx.workspace)}`,
          `参数：${mediaSummary({ ...result, elapsedMs: elapsed })}`,
          `模型：${result.model}（本机）${result.seed !== undefined ? ` · seed ${result.seed}` : ''}`,
          '已放入画布。需要裁剪、缩放或转格式时调用 edit_media；需要改成另一种画面时再次调用 generate_image。'
        ].join('\n'),
        { media: meta, artifactId: artifact.id, path: artifact.path }
      )
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(`图片生成失败：${err instanceof Error ? err.message : String(err)}`, '先用 media_status 检查引擎与模型是否就绪，再重试。')
    }
  }
}

/* ── generate_video ──────────────────────────────────────────── */

export const generateVideoTool: ToolImpl = {
  definition: {
    name: 'generate_video',
    description:
      '用本机 MiniMax-H3（Ref2VA）生成带同步环境声的视频。默认 5 秒、960×544；生成可能需要几分钟，期间要告诉用户在等。' +
      '提供 reference_path 时以它为视觉锚点；不提供时会先用本机图片模型生成首帧，再让首帧动起来（多花约半分钟）。' +
      'prompt 要写清：主体动作、镜头运动、场景变化、光线、声音/环境声；reference_path 对应提示词里的 <Picture 1>，第二张对应 <Picture 2>。' +
      '产出会自动保存到工作区 media/ 并放入画布。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            '视频描述。示例：<Picture 1> 是主体与外观参考。狐狸轻轻眨眼、耳朵转动，镜头缓慢推近；雪粒飘落，晨光从左侧掠过毛发；环境声是轻微的风声和远处的鸟鸣。'
        },
        reference_path: {
          type: 'string',
          description: '工作区内的首帧/主体参考图（可选）。不填时自动生成一张 16:9 首帧。'
        },
        second_reference_path: {
          type: 'string',
          description: '第二张参考图（可选，用作风格/环境参考，对应 <Picture 2>）'
        },
        last_frame_path: {
          type: 'string',
          description: '末帧图片（可选）。提供时改用 FL2VA 首尾帧转场，从 reference_path/首帧自然过渡到这张图。'
        },
        seconds: { type: 'number', description: '时长（秒），5–15，默认 5；越长越慢，15 秒在 16GB 显卡上可能需要 50 分钟以上' },
        quality: {
          type: 'string',
          enum: [...VIDEO_QUALITIES],
          description: '画质档位：fast（960×544，默认）、balanced（1152×640）、high（1344×768，很慢）'
        },
        aspect_ratio: { type: 'string', enum: [...VIDEO_ASPECTS], description: '画幅（默认 16:9）' },
        first_frame_prompt: {
          type: 'string',
          description: '不提供 reference_path 时，用这段提示词生成首帧；省略则复用 prompt'
        },
        seed: { type: 'number', description: '随机种子（可选）' }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    category: 'exec',
    risk: 'medium',
    titleFor: (input) => `生成视频：${oneLineInput(input, 'prompt', 44) || '未命名'}`
  },
  async execute(input, ctx) {
    try {
      const media = requireHandler(ctx)
      const workspace = requireWorkspace(ctx)
      const prompt = getString(input, 'prompt', { required: true, maxLength: 8_000 })
      const aspect = getString(input, 'aspect_ratio', { defaultValue: '16:9' }) as (typeof VIDEO_ASPECTS)[number]
      if (!VIDEO_ASPECTS.includes(aspect)) {
        throw new ToolInputError(`不支持的画幅：${aspect}`, `可用画幅：${VIDEO_ASPECTS.join('、')}。`)
      }
      const quality = getString(input, 'quality', { defaultValue: 'fast' }) as (typeof VIDEO_QUALITIES)[number]
      if (!VIDEO_QUALITIES.includes(quality)) {
        throw new ToolInputError(`不支持的画质档位：${quality}`, `可用档位：${VIDEO_QUALITIES.join('、')}。`)
      }
      const size = VIDEO_SIZES[aspect][quality]
      const seconds = getNumber(input, 'seconds', { defaultValue: 5, min: 5, max: 15 })
      const seedRaw = input.seed
      const seed =
        seedRaw === undefined || seedRaw === null || seedRaw === ''
          ? undefined
          : getNumber(input, 'seed', { min: 0, max: 4_294_967_295 })
      const referenceRaw = getString(input, 'reference_path', { defaultValue: '' })
      const secondRaw = getString(input, 'second_reference_path', { defaultValue: '' })
      const lastRaw = getString(input, 'last_frame_path', { defaultValue: '' })
      const referencePaths: string[] = []
      if (referenceRaw) referencePaths.push(resolveMediaInput(ctx, referenceRaw, '参考图'))
      if (secondRaw) referencePaths.push(resolveMediaInput(ctx, secondRaw, '第二张参考图'))
      const lastFramePath = lastRaw ? resolveMediaInput(ctx, lastRaw, '末帧') : undefined

      const startedAt = Date.now()
      let referenceNote = ''
      if (referencePaths.length === 0) {
        const framePrompt = getString(input, 'first_frame_prompt', { defaultValue: prompt })
        const frameProgress = progressReporter(ctx, '生成视频首帧')
        frameProgress({ stage: '先生成首帧参考图', percent: 1 })
        const frame = await media.generateImage({
          workspace,
          prompt: `视频首帧，画面要适合作为连续镜头的开始：${framePrompt}`,
          width: size.width,
          height: size.height,
          ...(seed !== undefined ? { seed } : {}),
          signal: ctx.signal,
          onProgress: frameProgress
        })
        referencePaths.push(frame.path)
        const frameTitle = `视频首帧 · ${prompt.replace(/\s+/g, ' ').slice(0, 24)}`
        const { artifact: frameArtifact } = mediaArtifact(frame, frameTitle, 'image', ctx)
        referenceNote = `首帧参考图：${displayPath(frameArtifact.path ?? frame.path, workspace)}（已一并放入画布）`
      }

      const onProgress = progressReporter(ctx, '生成视频')
      onProgress({ stage: '上传参考图', percent: 1 })
      const result = await media.generateVideo({
        workspace,
        prompt,
        referencePaths,
        ...(lastFramePath ? { lastFramePath } : {}),
        width: size.width,
        height: size.height,
        seconds,
        ...(seed !== undefined ? { seed } : {}),
        signal: ctx.signal,
        onProgress
      })
      const title = `视频 · ${prompt.replace(/\s+/g, ' ').slice(0, 28)}`
      const { artifact, meta } = mediaArtifact(result, title, 'video', ctx)
      ctx.progress('完成', { title: '视频已生成', percent: 100 })
      const elapsed = Math.max(result.elapsedMs, Date.now() - startedAt)
      return okResult(
        [
          `已生成视频《${title}》。`,
          `文件：${displayPath(artifact.path ?? result.path, workspace)}`,
          `参数：${mediaSummary({ ...result, elapsedMs: elapsed })} · ${size.width}×${size.height} · ${seconds} 秒`,
          `模型：${result.model}（本机，含同步环境声）${referenceNote ? `\n${referenceNote}` : ''}`,
          '已放入画布。需要剪短、裁切或转 GIF 时调用 edit_media。'
        ].join('\n'),
        { media: meta, artifactId: artifact.id, path: artifact.path }
      )
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(`视频生成失败：${err instanceof Error ? err.message : String(err)}`, '先用 media_status 检查引擎与模型是否就绪；确认显存没有被其他程序占用。')
    }
  }
}

/* ── edit_media ──────────────────────────────────────────────── */

const EDIT_OPERATIONS = [
  'trim',
  'crop',
  'resize',
  'rotate',
  'flip',
  'speed',
  'mute',
  'volume',
  'extract_audio',
  'extract_frame',
  'gif',
  'convert',
  'concat'
] as const

export const editMediaTool: ToolImpl = {
  definition: {
    name: 'edit_media',
    description:
      '用本机 ffmpeg 剪辑/处理已有图片、音频或视频：按时间剪短、裁画面、缩放、旋转、翻转、变速、静音、调音量、提取音频、转 GIF、转格式。' +
      '它不改变画面内容；要改画面内容（加物体、换风格、换背景）请用 generate_image + reference_path。' +
      '输入和输出都必须在工作区内。剪辑前可先用 inspect_media 读取时长和尺寸。产出会自动放入画布。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的输入文件（concat 以外的操作必填）' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'concat 的片段列表（至少 2 段，按播放顺序）；其他操作忽略'
        },
        operation: {
          type: 'string',
          enum: [...EDIT_OPERATIONS],
          description:
            'trim=按时间剪；crop=裁切画面；resize=缩放；rotate=旋转；flip=翻转；speed=变速；mute=静音；volume=调音量；extract_audio=提取音频；extract_frame=从视频抽一帧为图片（可作下一镜首帧）；gif=转 GIF；convert=转格式；concat=把多段视频拼成一条'
        },
        output_path: { type: 'string', description: '输出路径（可选）；省略时自动放到 media/edited/' },
        start_seconds: { type: 'number', description: 'trim/gif 的起点（秒）' },
        end_seconds: { type: 'number', description: 'trim/gif 的终点（秒）' },
        width: { type: 'number', description: 'crop/resize 的宽度（像素）' },
        height: { type: 'number', description: 'crop/resize 的高度（像素）' },
        x: { type: 'number', description: 'crop 的左上角 X' },
        y: { type: 'number', description: 'crop 的左上角 Y' },
        angle: { type: 'number', description: 'rotate 的角度：90 / 180 / 270' },
        flip: { type: 'string', enum: ['horizontal', 'vertical'], description: 'flip 的方向' },
        speed: { type: 'number', description: 'speed 倍率：0.25–4' },
        volume: { type: 'number', description: 'volume 音量倍数：0–4（0 等同静音）' },
        format: { type: 'string', description: 'convert/extract_audio 的目标格式，例如 mp4/mp3/webp/jpg' },
        fps: { type: 'number', description: 'gif 的帧率，默认 12' },
        at_seconds: { type: 'number', description: 'extract_frame 的时间点（秒）；省略时取开头' },
        from_end: { type: 'boolean', description: 'extract_frame 时从视频末尾抽帧（取尾帧接下一镜）' }
      },
      required: ['operation'],
      additionalProperties: false
    },
    category: 'exec',
    risk: 'medium',
    titleFor: (input) => {
      if (input.operation === 'concat') {
        const count = Array.isArray(input.paths) ? input.paths.length : 0
        return `拼接 ${count} 段视频`
      }
      return `剪辑 ${basename(String(input.path ?? '媒体文件'))}`
    }
  },
  async execute(input, ctx) {
    try {
      const media = requireHandler(ctx)
      requireWorkspace(ctx)
      const operation = getString(input, 'operation', { required: true }) as (typeof EDIT_OPERATIONS)[number]
      if (!EDIT_OPERATIONS.includes(operation)) {
        throw new ToolInputError(`不支持的剪辑操作：${operation}`, `可用操作：${EDIT_OPERATIONS.join('、')}。`)
      }
      const isConcat = operation === 'concat'
      const inputPaths = isConcat
        ? getStringArray(input, 'paths', { maxItems: 24 }).map((path, index) => resolveMediaInput(ctx, path, `片段 ${index + 1}`))
        : []
      if (isConcat && inputPaths.length < 2) {
        throw new ToolInputError('concat 至少需要 2 段视频。', '把要拼接的片段路径按播放顺序放进 paths。')
      }
      const rawPath = getString(input, 'path', { defaultValue: '', maxLength: 2_000 })
      if (!isConcat && !rawPath) {
        throw new ToolInputError('缺少必填参数「path」。', '请提供输入文件路径，或改用 operation=concat 传 paths。')
      }
      const inputPath = isConcat ? inputPaths[0] : resolveMediaInput(ctx, rawPath, '输入文件')
      const outputRaw = getString(input, 'output_path', { defaultValue: '' })
      const outputPath = outputRaw ? resolveOutputPath(ctx, outputRaw) : undefined
      const number = (key: string, min: number, max: number): number | undefined => {
        const raw = input[key]
        if (raw === undefined || raw === null || raw === '') return undefined
        return getNumber(input, key, { min, max })
      }
      const text = (key: string): string | undefined => {
        const raw = input[key]
        return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
      }
      const progress = progressReporter(ctx, '剪辑媒体')
      progress({ stage: '准备 ffmpeg', percent: 2 })
      const result = await media.editMedia({
        workspace: requireWorkspace(ctx),
        inputPath,
        ...(isConcat ? { inputPaths } : {}),
        ...(outputPath ? { outputPath } : {}),
        operation,
        ...(number('start_seconds', 0, 86_400) !== undefined ? { startSeconds: number('start_seconds', 0, 86_400) } : {}),
        ...(number('end_seconds', 0, 86_400) !== undefined ? { endSeconds: number('end_seconds', 0, 86_400) } : {}),
        ...(number('width', 1, 16_384) !== undefined ? { width: number('width', 1, 16_384) } : {}),
        ...(number('height', 1, 16_384) !== undefined ? { height: number('height', 1, 16_384) } : {}),
        ...(number('x', 0, 16_384) !== undefined ? { x: number('x', 0, 16_384) } : {}),
        ...(number('y', 0, 16_384) !== undefined ? { y: number('y', 0, 16_384) } : {}),
        ...(number('angle', 0, 360) !== undefined ? { angle: number('angle', 0, 360) } : {}),
        ...(text('flip') ? { flip: text('flip') as 'horizontal' | 'vertical' } : {}),
        ...(number('speed', 0.25, 4) !== undefined ? { speed: number('speed', 0.25, 4) } : {}),
        ...(number('volume', 0, 4) !== undefined ? { volume: number('volume', 0, 4) } : {}),
        ...(text('format') ? { format: text('format') } : {}),
        ...(number('fps', 1, 60) !== undefined ? { fps: number('fps', 1, 60) } : {}),
        ...(number('at_seconds', 0, 86_400) !== undefined ? { atSeconds: number('at_seconds', 0, 86_400) } : {}),
        ...(input.from_end === true ? { fromEnd: true } : {}),
        signal: ctx.signal,
        onProgress: progress
      })
      const kind = result.mediaKind ?? (result.durationSec !== undefined ? 'video' : 'image')
      const title = `剪辑 · ${basename(result.path)}`
      const { artifact, meta } = mediaArtifact(result, title, kind, ctx)
      ctx.progress('完成', { title: '剪辑完成', percent: 100 })
      return okResult(
        [
          `已生成剪辑成品《${title}》。`,
          `文件：${displayPath(artifact.path ?? result.path, ctx.workspace)}`,
          `参数：${mediaSummary(result)} · ${result.model}`,
          '已放入画布，可直接播放预览。'
        ].join('\n'),
        { media: meta, artifactId: artifact.id, path: artifact.path }
      )
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(`媒体剪辑失败：${err instanceof Error ? err.message : String(err)}`, '先用 media_status 检查 ffmpeg 是否可用，再用 inspect_media 确认文件格式。')
    }
  }
}

/* ── inspect_media ───────────────────────────────────────────── */

export const inspectMediaTool: ToolImpl = {
  definition: {
    name: 'inspect_media',
    description:
      '读取工作区内图片/视频/音频的真实元数据：宽高、时长、帧率、编码、文件大小。剪辑前先调用它确认时长和尺寸，不要猜。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的媒体文件' }
      },
      required: ['path'],
      additionalProperties: false
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `查看媒体信息：${basename(String(input.path ?? '媒体文件'))}`
  },
  async execute(input, ctx) {
    try {
      const media = requireHandler(ctx)
      requireWorkspace(ctx)
      const rawPath = getString(input, 'path', { required: true, maxLength: 2_000 })
      const inputPath = resolveMediaInput(ctx, rawPath, '媒体文件')
      const info = await media.probeMedia({ workspace: requireWorkspace(ctx), path: inputPath })
      const relative = displayPath(inputPath, ctx.workspace)
      const lines = [
        `文件：${relative}`,
        `类型：${info.kind === 'unknown' ? '未知' : info.kind}`,
        info.width && info.height ? `尺寸：${info.width}×${info.height}` : '',
        info.durationSec !== undefined ? `时长：${info.durationSec.toFixed(2)} 秒` : '',
        info.fps !== undefined ? `帧率：${info.fps.toFixed(2)} fps` : '',
        info.codec ? `编码：${info.codec}` : '',
        `大小：${(info.bytes / 1024 / 1024).toFixed(2)} MB`
      ].filter(Boolean)
      return okResult(lines.join('\n'), { probe: info })
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(`读取媒体信息失败：${err instanceof Error ? err.message : String(err)}`, '确认文件没有损坏，并且 ffprobe 可用。')
    }
  }
}

/* ── media_status ────────────────────────────────────────────── */

export const mediaStatusTool: ToolImpl = {
  definition: {
    name: 'media_status',
    description:
      '检查本机多媒体能力：ComfyUI 是否连上、图片/视频模型文件是否齐全、ffmpeg 是否可用。' +
      '用户要生成/剪辑媒体但不确定引擎状态，或生成失败时先调用它；不要凭空猜模型装没装。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    category: 'read',
    risk: 'low',
    titleFor: () => '检查本机多媒体引擎'
  },
  async execute(_input, ctx) {
    try {
      const media = requireHandler(ctx)
      const status = await media.status()
      const lines: string[] = []
      lines.push(status.engine.online ? `ComfyUI：已连接 ${status.engine.url}${status.engine.version ? `（${status.engine.version}）` : ''}` : `ComfyUI：未连接 ${status.engine.url}`)
      if (status.engine.gpu) {
        lines.push(`显卡：${status.engine.gpu}${status.engine.vramFreeMb ? ` · 可用显存 ${Math.round(status.engine.vramFreeMb / 1024)} GB` : ''}`)
      }
      for (const model of status.models) {
        if (!model.verified) {
          lines.push(`${model.label}：未核对（还没有配置 ComfyUI 安装目录，无法检查本地文件）`)
          continue
        }
        lines.push(`${model.label}：${model.ready ? '已就绪' : `缺少 ${model.missing.length} 个文件`}`)
        if (!model.ready) for (const file of model.missing) lines.push(`  - ${file}`)
      }
      lines.push(`ffmpeg：${status.ffmpeg.available ? `${status.ffmpeg.version ?? '已安装'}（${status.ffmpeg.path ?? ''}）` : '未检测到'}`)
      if (!status.engine.online) {
        lines.push(status.canStart ? '下一步：在设置 → 多媒体里点「启动引擎」，或让用户运行 ComfyUI。' : '下一步：在设置 → 多媒体里填写 ComfyUI 安装目录，或手动启动 ComfyUI。')
      }
      if (status.models.some((model) => model.verified && !model.ready)) {
        lines.push('模型缺失时：设置 → 多媒体里有每个文件的下载链接与放置路径；Morrow 不内置权重。')
      }
      return okResult(lines.join('\n'), { status })
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(`检查多媒体引擎失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/* ── generate_film ───────────────────────────────────────────── */

export const generateFilmTool: ToolImpl = {
  definition: {
    name: 'generate_film',
    description:
      '把 Qwen 生图与 MiniMax 生视频串成连贯短片：逐镜生成首帧 → 生成视频 → 抽取尾帧 → 作为下一镜首帧继续，最后用 ffmpeg 拼成一条完整视频。' +
      '适合用户要「一段连贯短片 / 分镜 / 多镜头故事」；单张图或单条视频用 generate_image / generate_video 即可。' +
      'shots 至少 2 个、最多 6 个；style 写全片统一的角色、场景、光线和画风，否则各镜会漂移。' +
      '每个分镜的 prompt 写这一镜的動作与镜头运动；image_prompt 可单独写首帧画面；last_frame_path 可指定末帧做转场（需 FL2VA）。' +
      '生成可能持续十几分钟，先告诉用户在等；产出会自动保存到工作区 media/films/ 并放入画布。',
    parameters: {
      type: 'object',
      properties: {
        style: {
          type: 'string',
          description: '全片统一风格：角色外观、世界、光线、镜头语言。例如：同一只戴红围巾的赤狐，雪松林，清晨侧光，电影感浅景深。'
        },
        shots: {
          type: 'array',
          minItems: 2,
          maxItems: 6,
          description: '分镜列表，按播放顺序',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: '这一镜的动作、镜头运动与环境声' },
              image_prompt: { type: 'string', description: '这一镜首帧的画面描述（可选；默认复用 prompt）' },
              seconds: { type: 'number', description: '这一镜时长（5–10 秒，默认 5）' },
              last_frame_path: { type: 'string', description: '这一镜的末帧图片（可选；提供时用首尾帧转场）' },
              continue_previous: { type: 'boolean', description: '是否从上一镜尾帧继续（默认 true；设 false 则重新生成本镜首帧）' }
            },
            required: ['prompt'],
            additionalProperties: false
          }
        },
        aspect_ratio: { type: 'string', enum: [...VIDEO_ASPECTS], description: '画幅（默认 16:9）' },
        quality: { type: 'string', enum: [...VIDEO_QUALITIES], description: '画质档位：fast（默认）/ balanced / high' },
        seed: { type: 'number', description: '随机种子（可选）' }
      },
      required: ['shots'],
      additionalProperties: false
    },
    category: 'exec',
    risk: 'medium',
    titleFor: (input) => {
      const shots = Array.isArray(input.shots) ? input.shots.length : 0
      return `制作短片：${shots} 个镜头`
    }
  },
  async execute(input, ctx) {
    try {
      const media = requireHandler(ctx)
      const workspace = requireWorkspace(ctx)
      const aspect = getString(input, 'aspect_ratio', { defaultValue: '16:9' }) as (typeof VIDEO_ASPECTS)[number]
      if (!VIDEO_ASPECTS.includes(aspect)) throw new ToolInputError(`不支持的画幅：${aspect}`)
      const quality = getString(input, 'quality', { defaultValue: 'fast' }) as (typeof VIDEO_QUALITIES)[number]
      if (!VIDEO_QUALITIES.includes(quality)) throw new ToolInputError(`不支持的画质档位：${quality}`)
      const size = VIDEO_SIZES[aspect][quality]
      const rawShots = getObjectArray(input, 'shots')
      if (rawShots.length < 2 || rawShots.length > 6) {
        throw new ToolInputError('短片需要 2–6 个分镜。', '把故事拆成 2–6 个镜头后重试。')
      }
      const shots = rawShots.map((raw, index) => {
        const prompt = getString(raw, 'prompt', { required: true, maxLength: 4_000 })
        const imagePrompt = getString(raw, 'image_prompt', { defaultValue: '', maxLength: 4_000 })
        const seconds = getNumber(raw, 'seconds', { defaultValue: 5, min: 5, max: 10 })
        const lastRaw = getString(raw, 'last_frame_path', { defaultValue: '' })
        const lastFramePath = lastRaw ? resolveMediaInput(ctx, lastRaw, `分镜 ${index + 1} 的末帧`) : undefined
        return {
          prompt,
          seconds,
          ...(imagePrompt ? { imagePrompt } : {}),
          ...(lastFramePath ? { lastFramePath } : {}),
          ...(raw.continue_previous === false ? { continuePrevious: false } : {})
        }
      })
      const style = getString(input, 'style', {
        defaultValue: '同一角色、同一世界、连贯的电影感画面，统一的色彩与光线'
      })
      const seedRaw = input.seed
      const seed =
        seedRaw === undefined || seedRaw === null || seedRaw === ''
          ? undefined
          : getNumber(input, 'seed', { min: 0, max: 4_294_967_295 })
      const progress = progressReporter(ctx, '制作短片')
      progress({ stage: '准备分镜', percent: 1 })
      const result = await media.generateFilm({
        workspace,
        shots,
        style,
        width: size.width,
        height: size.height,
        ...(seed !== undefined ? { seed } : {}),
        signal: ctx.signal,
        onProgress: progress
      })
      if (result.coverPath && existsSync(result.coverPath)) {
        const cover = resolveWorkspacePath(result.coverPath, workspace, { requireExist: true })
        if (!cover.isDirectory) {
          ctx.addArtifact({
            id: newId('artifact'),
            title: `短片封面 · ${shots[0].prompt.replace(/\s+/g, ' ').slice(0, 22)}`,
            kind: 'file',
            path: cover.absolute,
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
        }
      }
      const title = `短片 · ${shots[0].prompt.replace(/\s+/g, ' ').slice(0, 26)}`
      const { artifact, meta } = mediaArtifact(result, title, 'video', ctx)
      ctx.progress('完成', { title: '短片已完成', percent: 100 })
      const shotLines = result.shots
        .map((shot, index) => `${index + 1}. ${displayPath(shot.path, workspace)}${shot.durationSec ? `（${shot.durationSec.toFixed(1)} 秒）` : ''}`)
        .join('\n')
      return okResult(
        [
          `短片已完成：${shots.length} 个镜头，总时长 ${(result.durationSec ?? 0).toFixed(1)} 秒。`,
          `文件：${displayPath(artifact.path ?? result.path, workspace)}`,
          `模型：${result.model}（本机）· ${mediaSummary(result)}`,
          `分镜：\n${shotLines}`,
          result.coverPath ? `封面：${displayPath(result.coverPath, workspace)}` : '',
          '已放入画布，可直接播放。需要调整某一镜、重新生成或继续加镜头时，告诉我要改哪一镜即可。'
        ]
          .filter(Boolean)
          .join('\n'),
        { media: meta, artifactId: artifact.id, path: artifact.path }
      )
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(`短片生成失败：${err instanceof Error ? err.message : String(err)}`, '先用 media_status 检查两个模型和 ffmpeg；分镜多时耗时较长，可以把数量降到 2–3 个先试。')
    }
  }
}

/* ── render_animation ───────────────────────────────────────── */

export const renderAnimationTool: ToolImpl = {
  definition: {
    name: 'render_animation',
    description:
      '把工作区里由代码写成的 HTML/Canvas/SVG 动画渲染成 MP4，适合让本地代码模型制作「代码美学」等需要精确控制的镜头。' +
      'HTML 必须自包含，并暴露 window.renderAt(t)：同步绘制第 t 秒的画面；渲染器会按 fps 逐帧调用并截图，再由 ffmpeg 合成视频。' +
      '页面可以有 CSS/字体/渐变，但不要依赖鼠标或异步加载；需要素材时用工作区内的相对路径。' +
      '产出是带静音音轨的 MP4，可直接用 edit_media(concat) 与生成视频拼接。完成后自动放进画布。',
    parameters: {
      type: 'object',
      properties: {
        html_path: { type: 'string', description: '工作区内的自包含 HTML 文件（必须提供 window.renderAt(t)）' },
        duration_seconds: { type: 'number', description: '时长（秒），0.5–60，默认 5' },
        fps: { type: 'number', description: '帧率，8–30，默认 24' },
        width: { type: 'number', description: '输出宽度，默认 960' },
        height: { type: 'number', description: '输出高度，默认 544' },
        time_unit: { type: 'string', enum: ['seconds', 'milliseconds'], description: 'renderAt(t) 的时间单位，默认 seconds；若页面按毫秒绘制则传 milliseconds' },
        output_path: { type: 'string', description: '输出路径（可选）；省略时放到 media/code/' }
      },
      required: ['html_path'],
      additionalProperties: false
    },
    category: 'exec',
    risk: 'medium',
    titleFor: (input) => `渲染代码动画：${basename(String(input.html_path ?? 'HTML'))}`
  },
  async execute(input, ctx) {
    try {
      const media = requireHandler(ctx)
      const workspace = requireWorkspace(ctx)
      const rawHtml = getString(input, 'html_path', { required: true, maxLength: 2_000 })
      const htmlPath = resolveMediaInput(ctx, rawHtml, 'HTML 动画')
      if (!/\.(html?|xhtml)$/i.test(htmlPath)) {
        throw new ToolInputError('render_animation 只接受 .html 文件。', '请先用 write_file 写出自包含的 HTML 动画。')
      }
      const durationSeconds = getNumber(input, 'duration_seconds', { defaultValue: 5, min: 0.5, max: 60 })
      const fps = getNumber(input, 'fps', { defaultValue: 24, min: 8, max: 30 })
      const width = getNumber(input, 'width', { defaultValue: 960, min: 64, max: 2_048 })
      const height = getNumber(input, 'height', { defaultValue: 544, min: 64, max: 2_048 })
      const timeUnitRaw = getString(input, 'time_unit', { defaultValue: 'seconds' })
      const timeUnit = timeUnitRaw === 'milliseconds' ? 'milliseconds' : 'seconds'
      const outputRaw = getString(input, 'output_path', { defaultValue: '' })
      const outputPath = outputRaw ? resolveOutputPath(ctx, outputRaw) : undefined
      const progress = progressReporter(ctx, '渲染代码动画')
      progress({ stage: '打开页面', percent: 1 })
      const result = await media.renderAnimation({
        workspace,
        htmlPath,
        ...(outputPath ? { outputPath } : {}),
        durationSec: durationSeconds,
        fps,
        width,
        height,
        timeUnit,
        signal: ctx.signal,
        onProgress: progress
      })
      const title = `代码动画 · ${basename(result.path)}`
      const { artifact, meta } = mediaArtifact(result, title, 'video', ctx)
      ctx.progress('完成', { title: '代码动画已生成', percent: 100 })
      return okResult(
        [
          `代码动画已渲染完成《${title}》。`,
          `文件：${displayPath(artifact.path ?? result.path, workspace)}`,
          `参数：${mediaSummary(result)} · ${width}×${height} · ${fps}fps`,
          '已放入画布。可以继续用 edit_media(concat) 与生成视频拼接。'
        ].join('\n'),
        { media: meta, artifactId: artifact.id, path: artifact.path }
      )
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(
        `代码动画渲染失败：${err instanceof Error ? err.message : String(err)}`,
        '确认 HTML 是自包含文件，并且暴露了 window.renderAt(t)；如果页面引用了外部资源或异步加载，先改成同步绘制。'
      )
    }
  }
}

/* ── describe_media ─────────────────────────────────────────── */

export const describeMediaTool: ToolImpl = {
  definition: {
    name: 'describe_media',
    description:
      '审看工作区里的图片，或从视频抽取 1–4 帧一起审看。' +
      '优先使用当前对话模型自带的视觉能力；当前模型不支持或调用失败时，才回退本机多模态视觉模型。' +
      '它返回实际看到的画面与可执行的修改建议，不会改文件。生成图片/视频后先用它检查主体一致性、构图、风格和明显瑕疵，再决定重生成、编辑或继续。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的图片或视频' },
        question: { type: 'string', description: '要问视觉模型的问题（可选）；默认审看主体/构图/风格并给修改建议' },
        frames: { type: 'number', description: '视频抽帧数，1–4，默认 3' }
      },
      required: ['path'],
      additionalProperties: false
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `审看媒体：${basename(String(input.path ?? '媒体'))}`
  },
  async execute(input, ctx) {
    try {
      const media = requireHandler(ctx)
      const workspace = requireWorkspace(ctx)
      const rawPath = getString(input, 'path', { required: true, maxLength: 2_000 })
      const path = resolveMediaInput(ctx, rawPath, '媒体文件')
      const question = getString(input, 'question', { defaultValue: '', maxLength: 2_000 })
      const frames = getNumber(input, 'frames', { defaultValue: 3, min: 1, max: 4 })
      const progress = progressReporter(ctx, '审看媒体')
      progress({ stage: '准备画面', percent: 2 })
      const result = await media.describeMedia({
        workspace,
        path,
        ...(question ? { question } : {}),
        frames,
        signal: ctx.signal,
        onProgress: progress,
        ...(ctx.vision ? { visionProvider: ctx.vision } : {})
      })
      ctx.progress('完成', { title: '审看完成', percent: 100 })
      return okResult(
        [
          `视觉模型（${result.model}）审看${result.fallback ? '（当前对话模型不可用，已回退本机）' : ''}：`,
          result.text,
          `（读取 ${result.frameCount} 帧，用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒）`
        ].join('\n'),
        {
          model: result.model,
          frameCount: result.frameCount,
          elapsedMs: result.elapsedMs,
          ...(result.fallback ? { fallback: true } : {})
        }
      )
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(
        `媒体审看失败：${err instanceof Error ? err.message : String(err)}`,
        '先让用户换用支持图片输入的对话模型；如果当前模型不支持或返回空内容，再在设置 → 多媒体启用带 --mmproj 的本机视觉模型（16GB 显卡需先停止 ComfyUI 释放显存）。不要用生图模型或纯文本模型冒充审看；两者都不可用时如实说明失败，并建议用户配置视觉模型或改用可验证的 DOM/几何检查。'
      )
    }
  }
}

/* ── 通用模型/引擎目录 ──────────────────────────────────────── */

function requireCatalog(ctx: ToolContext): NonNullable<MediaToolHandler['catalog']> {
  if (!ctx.media?.catalog) {
    throw new ToolInputError('通用模型目录不可用。', '请重启 Morrow 后重试。')
  }
  return ctx.media.catalog
}

function manifestExample(kind: 'model' | 'engine'): string {
  if (kind === 'model') {
    return JSON.stringify({
      id: 'flux1-dev',
      label: 'FLUX.1 dev',
      engine: 'comfyui',
      kind: 'image',
      capabilities: ['text-to-image'],
      description: '自定义 ComfyUI 工作流示例；graph 使用 ComfyUI API 格式，bindings 指向要替换的节点输入。',
      homepage: 'https://huggingface.co/black-forest-labs/FLUX.1-dev',
      install: {
        type: 'files',
        files: [
          {
            url: 'https://example.com/flux1-dev.safetensors',
            dest: 'diffusion_models/flux1-dev.safetensors',
            bytes: 23802900736,
            sha256: '请填写 64 位 SHA-256；不确定时先省略，下载后由文件大小校验'
          }
        ]
      },
      comfy: {
        requiredNodes: ['UNETLoader', 'DualCLIPLoader', 'VAELoader', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage'],
        workflow: {
          graph: {
            unet: { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev.safetensors', weight_dtype: 'default' } },
            clip: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 't5xxl_fp16.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' } },
            vae: { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
            positive: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: '' } },
            negative: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: '' } },
            latent: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
            sampler: { class_type: 'KSampler', inputs: { model: ['unet', 0], positive: ['positive', 0], negative: ['negative', 0], latent_image: ['latent', 0], seed: 0, steps: 20, cfg: 3.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
            decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['vae', 0] } },
            save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'morrow/custom' } }
          },
          bindings: {
            prompt: { node: 'positive', input: 'text' },
            negativePrompt: { node: 'negative', input: 'text' },
            width: { node: 'latent', input: 'width' },
            height: { node: 'latent', input: 'height' },
            seed: { node: 'sampler', input: 'seed' }
          },
          outputNode: 'save',
          outputKind: 'image'
        }
      }
    }, null, 2)
  }
  return JSON.stringify({
    id: 'my-engine',
    label: '我的本地引擎',
    kind: 'custom',
    capabilities: ['vision', 'chat'],
    description: '自定义引擎示例；Morrow 只执行清单中声明的检测/安装/启停命令。',
    detect: { command: 'my-engine', args: ['--version'], healthUrl: 'http://127.0.0.1:9999/health' },
    install: { kind: 'winget', wingetId: 'Vendor.MyEngine', note: '安装可能需要系统权限。' },
    service: {
      start: { command: 'my-engine', args: ['serve'], detached: true },
      stop: { command: 'my-engine', args: ['stop'] },
      healthUrl: 'http://127.0.0.1:9999/health',
      port: 9999
    },
    modelDir: 'C:/AI/models'
  }, null, 2)
}

export const listLocalModelsTool: ToolImpl = {
  definition: {
    name: 'list_local_models',
    description:
      '列出本机所有已注册的媒体引擎与模型：ComfyUI、llama.cpp、Ollama、LM Studio、自定义引擎，以及每个模型的能力、安装状态、缺失文件与运行状态。' +
      '用户询问“有哪些模型/能不能用某个模型/部署环境如何”时先调用它；不要假设只有 Qwen 或 MiniMax。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    category: 'read',
    risk: 'low',
    titleFor: () => '查看本地引擎与模型'
  },
  async execute(_input, ctx) {
    try {
      const catalog = requireCatalog(ctx)
      const status = await catalog.status()
      const lines: string[] = ['引擎：']
      for (const engine of status.engines) {
        lines.push(`- ${engine.label}（id=${engine.id}，${engine.kind}）：${engine.running ? '运行中' : engine.detected ? '已安装未运行' : '未安装'}${engine.version ? `，${engine.version}` : ''}${engine.modelDir ? `，模型目录 ${engine.modelDir}` : ''}`)
      }
      lines.push('模型：')
      for (const model of status.models) {
        const caps = model.capabilities.join('/')
        const state = model.installed ? (model.running ? '已安装并运行' : '已安装') : model.missing.length ? `缺少 ${model.missing.length} 个文件` : model.message
        lines.push(`- ${model.label}（id=${model.id}，引擎=${model.engine}，类型=${model.kind}，能力=${caps}）：${state}；来源=${model.source === 'builtin' ? '内置预设' : '自定义清单'}，安装方式=${model.installType}`)
      }
      lines.push('安装/卸载模型用 manage_local_model；安装/启动/停止引擎用 manage_local_engine；清单格式用 action=schema。模型来源不限于内置预设。')
      return okResult(lines.join('\n'), { status })
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(`读取模型目录失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export const manageLocalModelTool: ToolImpl = {
  definition: {
    name: 'manage_local_model',
    description:
      '管理任意本地图片/视频/音频/多模态模型：注册自定义清单、下载/安装、卸载文件、移除清单。' +
      '用户说“下载/安装/部署/卸载某个模型”时用这个工具；先 list_local_models 查已有模型，注册自定义模型前用 action=schema 查看清单格式。' +
      '内置 Qwen/MiniMax 只是预设；ComfyUI 模型通过 files + workflow 清单描述，Ollama/LM Studio 通过 target 拉取，llama.cpp 通过 GGUF 文件清单描述。' +
      '安装/卸载是高影响操作，按当前权限档位审批。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['schema', 'register', 'install', 'uninstall', 'remove'], description: '操作' },
        id: { type: 'string', description: '模型 id；install/uninstall/remove 必填' },
        manifest: { type: 'object', description: '模型清单；register 必填，格式见 action=schema', additionalProperties: true }
      },
      required: ['action'],
      additionalProperties: false
    },
    category: 'exec',
    risk: 'high',
    titleFor: (input) => `${String(input.action ?? '管理')}模型${input.id ? `：${oneLineInput(input, 'id')}` : ''}`
  },
  async execute(input, ctx) {
    try {
      const catalog = requireCatalog(ctx)
      const action = getString(input, 'action', { required: true })
      if (action === 'schema') return okResult(`模型清单格式（按实际模型修改；路径必须相对引擎模型目录）：\n${manifestExample('model')}`)
      const id = getString(input, 'id', { required: action !== 'register', maxLength: 64 })
      if (action === 'register') {
        const manifest = input.manifest
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new ToolInputError('register 需要 manifest 对象。', '先 action=schema 查看格式。')
        const status = await catalog.registerModel(manifest as Record<string, unknown>)
        return okResult(`模型清单已注册。当前共 ${status.models.length} 个模型。`, { status })
      }
      if (action === 'install') {
        const progress = progressReporter(ctx, '安装模型')
        const status = await catalog.installModel(id, progress, ctx.signal)
        ctx.progress('完成', { title: '模型安装完成', percent: 100 })
        return okResult(`模型 ${id} 已安装/拉取完成。`, { status })
      }
      if (action === 'uninstall') {
        const status = await catalog.uninstallModel(id)
        return okResult(`模型 ${id} 的文件已卸载。`, { status })
      }
      if (action === 'remove') {
        const status = await catalog.removeModel(id)
        return okResult(`模型清单 ${id} 已移除（未删除已下载文件）。`, { status })
      }
      throw new ToolInputError(`不支持的模型操作：${action}`)
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(`模型管理失败：${err instanceof Error ? err.message : String(err)}`, '先 list_local_models 查状态；注册清单用 action=schema。')
    }
  }
}

export const manageLocalEngineTool: ToolImpl = {
  definition: {
    name: 'manage_local_engine',
    description:
      '管理本地媒体/推理引擎：注册自定义引擎、安装、启动、停止、移除清单。' +
      '支持 ComfyUI、llama.cpp、Ollama、LM Studio 与自定义命令清单；用户说“安装/部署/启动/停止某个引擎”时使用。' +
      '安装引擎可能执行 winget、安装包或清单中的命令，属于高影响操作；卸载只移除清单，不删除引擎安装。' +
      '先 list_local_models 查看引擎状态，注册前用 action=schema 查看格式。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['schema', 'register', 'install', 'start', 'stop', 'remove'], description: '操作' },
        id: { type: 'string', description: '引擎 id；除 schema/register 外必填' },
        manifest: { type: 'object', description: '引擎清单；register 必填，格式见 action=schema', additionalProperties: true }
      },
      required: ['action'],
      additionalProperties: false
    },
    category: 'exec',
    risk: 'high',
    titleFor: (input) => `${String(input.action ?? '管理')}引擎${input.id ? `：${oneLineInput(input, 'id')}` : ''}`
  },
  async execute(input, ctx) {
    try {
      const catalog = requireCatalog(ctx)
      const action = getString(input, 'action', { required: true })
      if (action === 'schema') return okResult(`引擎清单格式（按实际引擎修改；Morrow 只执行声明的命令）：\n${manifestExample('engine')}`)
      const id = getString(input, 'id', { required: action !== 'register', maxLength: 64 })
      if (action === 'register') {
        const manifest = input.manifest
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new ToolInputError('register 需要 manifest 对象。', '先 action=schema 查看格式。')
        const status = await catalog.registerEngine(manifest as Record<string, unknown>)
        return okResult(`引擎清单已注册。当前共 ${status.engines.length} 个引擎。`, { status })
      }
      if (action === 'install') {
        ctx.progress('安装引擎', { title: '安装引擎', status: 'running' })
        const status = await catalog.installEngine(id)
        ctx.progress('完成', { title: '引擎安装完成', percent: 100 })
        return okResult(`引擎 ${id} 安装命令已执行。`, { status })
      }
      if (action === 'start') {
        const status = await catalog.startEngine(id)
        return okResult(`引擎 ${id} 已启动。`, { status })
      }
      if (action === 'stop') {
        const status = await catalog.stopEngine(id)
        return okResult(`引擎 ${id} 已停止。`, { status })
      }
      if (action === 'remove') {
        const status = await catalog.removeEngine(id)
        return okResult(`引擎清单 ${id} 已移除。`, { status })
      }
      throw new ToolInputError(`不支持的引擎操作：${action}`)
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(`引擎管理失败：${err instanceof Error ? err.message : String(err)}`, '先 list_local_models 查状态；注册清单用 action=schema。')
    }
  }
}

/* ── run_local_model ────────────────────────────────────────── */

export const runLocalModelTool: ToolImpl = {
  definition: {
    name: 'run_local_model',
    description:
      '用指定本地模型生成或编辑图片/视频/音频。model 来自 list_local_models 的模型 id，不写死 Qwen/MiniMax。' +
      'ComfyUI 自定义模型使用清单里的工作流；内置 Qwen/MiniMax 走原生适配器；Ollama/LM Studio 模型是理解模型，请改用对话或 describe_media。' +
      '支持参考图/首帧/末帧；产出自动保存到工作区 media/ 并放入画布。',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型 id（list_local_models 返回的 id）' },
        prompt: { type: 'string', description: '画面/音频内容描述；编辑时写清要保留什么、只改什么' },
        negative_prompt: { type: 'string', description: '可选负面提示词（工作流支持时）' },
        reference_path: { type: 'string', description: '工作区内的参考图/首帧（可选）' },
        last_frame_path: { type: 'string', description: '工作区内的末帧（可选，视频首尾帧模型使用）' },
        width: { type: 'number', description: '输出宽度（可选；视频默认 960，图片默认 1024）' },
        height: { type: 'number', description: '输出高度（可选；视频默认 544，图片默认 1024）' },
        seconds: { type: 'number', description: '视频/音频时长秒（可选，默认 5）' },
        seed: { type: 'number', description: '随机种子（可选）' }
      },
      required: ['model', 'prompt'],
      additionalProperties: false
    },
    category: 'exec',
    risk: 'medium',
    titleFor: (input) => `调用模型：${oneLineInput(input, 'model')}`
  },
  async execute(input, ctx) {
    try {
      const media = requireHandler(ctx)
      const catalog = media.catalog
      if (!catalog) throw new ToolInputError('通用模型目录不可用。', '请重启 Morrow 后重试。')
      const workspace = requireWorkspace(ctx)
      const modelId = getString(input, 'model', { required: true, maxLength: 64 })
      const prompt = getString(input, 'prompt', { required: true, maxLength: 8_000 })
      const negativePrompt = getString(input, 'negative_prompt', { defaultValue: '', maxLength: 4_000 })
      const manifest = await catalog.manifest(modelId)
      if (manifest.kind === 'multimodal' || manifest.install.type === 'provider' || manifest.install.type === 'ollama' || manifest.install.type === 'lmstudio') {
        throw new ToolInputError(
          `${manifest.label} 是${manifest.kind === 'multimodal' ? '多模态理解' : '语言/理解'}模型，不是图片/视频生成模型。`,
          '用对话或 describe_media 调用它；生成图片/视频请选择 ComfyUI 图像/视频模型。'
        )
      }
      const referenceRaw = getString(input, 'reference_path', { defaultValue: '', maxLength: 2_000 })
      const lastRaw = getString(input, 'last_frame_path', { defaultValue: '', maxLength: 2_000 })
      const referencePath = referenceRaw ? resolveMediaInput(ctx, referenceRaw, '参考图') : undefined
      const lastFramePath = lastRaw ? resolveMediaInput(ctx, lastRaw, '末帧') : undefined
      const widthInput = getNumber(input, 'width', { defaultValue: 0, min: 0, max: 4096 })
      const heightInput = getNumber(input, 'height', { defaultValue: 0, min: 0, max: 4096 })
      const seconds = getNumber(input, 'seconds', { defaultValue: 5, min: 0, max: 60 })
      const seedRaw = input.seed
      const seed = seedRaw === undefined || seedRaw === null || seedRaw === ''
        ? undefined
        : getNumber(input, 'seed', { min: 0, max: 4_294_967_295 })
      const width = widthInput || (manifest.kind === 'video' ? 960 : 1024)
      const height = heightInput || (manifest.kind === 'video' ? 544 : 1024)
      const progress = progressReporter(ctx, `调用 ${manifest.label}`)
      let result: MediaArtifactResult

      if (manifest.comfy?.native === 'qwen-image') {
        progress({ stage: '加载 Qwen-Image', percent: 2 })
        result = await media.generateImage({
          workspace,
          prompt,
          ...(referencePath ? { referencePath } : {}),
          width,
          height,
          ...(seed !== undefined ? { seed } : {}),
          signal: ctx.signal,
          onProgress: progress
        })
      } else if (manifest.comfy?.native === 'minimax-video') {
        let firstFrame = referencePath
        if (!firstFrame) {
          progress({ stage: '先生成首帧', percent: 1 })
          const frame = await media.generateImage({
            workspace,
            prompt: `视频首帧：${prompt}`,
            width,
            height,
            ...(seed !== undefined ? { seed } : {}),
            signal: ctx.signal,
            onProgress: progress
          })
          firstFrame = frame.path
          const { artifact } = mediaArtifact(frame, '视频首帧', 'image', ctx)
          progress({ stage: `首帧已生成：${displayPath(artifact.path ?? frame.path, workspace)}`, percent: 2 })
        }
        progress({ stage: '加载 MiniMax-H3', percent: 2 })
        result = await media.generateVideo({
          workspace,
          prompt,
          referencePaths: [firstFrame],
          ...(lastFramePath ? { lastFramePath } : {}),
          mode: lastFramePath ? 'first-last' : 'reference',
          width,
          height,
          seconds,
          ...(seed !== undefined ? { seed } : {}),
          signal: ctx.signal,
          onProgress: progress
        })
      } else {
        const workflow = manifest.comfy?.workflow
        if (!workflow) {
          throw new ToolInputError(
            `${manifest.label} 还没有可执行工作流。`,
            '在模型清单里补 comfy.workflow（graph/bindings/outputNode/outputKind），或在设置页重新导入。'
          )
        }
        progress({ stage: `加载 ${manifest.label}`, percent: 2 })
        result = await media.runWorkflow({
          workspace,
          modelId,
          modelLabel: manifest.label,
          workflow,
          prompt,
          ...(negativePrompt ? { negativePrompt } : {}),
          referencePaths: [referencePath, lastFramePath].filter((path): path is string => Boolean(path)),
          width,
          height,
          seconds,
          ...(seed !== undefined ? { seed } : {}),
          signal: ctx.signal,
          onProgress: progress
        })
      }

      const kind = result.mediaKind ?? manifest.kind as MediaArtifactResult['mediaKind']
      const { artifact, meta } = mediaArtifact(result, `${manifest.label} · ${result.mediaKind ?? '成品'}`, kind as 'image' | 'video' | 'audio', ctx)
      ctx.progress('完成', { title: '生成完成', percent: 100 })
      return okResult(
        [
          `已用 ${manifest.label} 生成${result.mediaKind === 'video' ? '视频' : result.mediaKind === 'audio' ? '音频' : '图片'}：`,
          displayPath(artifact.path ?? result.path, workspace),
          result.durationSec ? `${result.durationSec.toFixed(2)} 秒` : '',
          result.width && result.height ? `${result.width}×${result.height}` : ''
        ].filter(Boolean).join(' '),
        { media: meta, artifactId: artifact.id, path: artifact.path }
      )
    } catch (err) {
      if (ctx.signal.aborted) throw abortError()
      if (err instanceof ToolInputError) return errResult(err.message, err.hint)
      return errResult(`调用本地模型失败：${err instanceof Error ? err.message : String(err)}`, '先用 list_local_models 确认模型已安装、引擎已启动；自定义模型检查工作流绑定。')
    }
  }
}

export const mediaTools: ToolImpl[] = [
  generateImageTool,
  generateVideoTool,
  generateFilmTool,
  renderAnimationTool,
  editMediaTool,
  inspectMediaTool,
  describeMediaTool,
  mediaStatusTool,
  listLocalModelsTool,
  manageLocalModelTool,
  manageLocalEngineTool,
  runLocalModelTool
]
