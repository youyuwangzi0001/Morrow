import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveFfmpegPaths } from './render'

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
