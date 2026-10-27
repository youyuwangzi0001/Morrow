// 视频合成：把剪辑表落成真实 MP4。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { StudioClip, StudioProject, StudioTrack } from '../../shared/studio'
import { formatDuration, timelineDuration } from '../../shared/studio'
import { getSettingsStore } from '../services/settings-store'
import { getStudioStore } from './store'
import { toAss, toSrt } from './timeline'

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
        // 单个音频失败不阻断成片；字幕仍在，检查页会给出缺失
        project.checks.push({
          id: `check-audio-${Date.now()}-${index}`,
          kind: 'audio',
          level: 'warn',
          title: `音频片段未合成：${clip.label}`,
          detail: err instanceof Error ? err.message : String(err),
          createdAt: Date.now()
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
      message: `已合成 ${formatDuration(totalDuration)} · ${width}×${height} · ${(bytes / 1024 / 1024).toFixed(1)}MB · 用时 ${elapsed}s${missingShots.length ? ` · ${missingShots.length} 镜缺画面` : ''}`
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
