// C-06 接缝审计探测层：从视频里抽首/中/末帧，产出 MD5 与灰度像素。
//
// 单独成模块而不是留在 studio.ts 里，是为了让真实验收脚本能直接调用——
// studio.ts 依赖 Electron，脚本里加载不了，而这一层只用到 ffmpeg 与文件 IO。
// ffmpeg 路径由调用方注入（studio.ts 从设置里解析），模块本身不碰全局状态。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GrayImage } from '../shared/seam-audit'
import type { ShotFrameSample, ShotSampleSet } from '../shared/seam-audit'

/** 抽帧探测所需的依赖，由调用方注入。 */
export interface SeamProbeDeps {
  /** ffmpeg 可执行文件路径 */
  ffmpeg: string
  /** 读视频时长（秒）；解析不到返回 null */
  probeDuration: (file: string) => number | null
  /** 解析 PGM 灰度图；注入而不是直接 import，便于真实验收脚本单独加载本模块 */
  parseGray: (buffer: Uint8Array) => GrayImage | null
  /**
   * 读视频流时长（秒），可选。
   * 有的成片音轨比画面长（实测 demo-final：画面 94.6s / 文件 96.0s），
   * 按文件时长抽末帧会落在画面之外、抽不到帧，被误报成「采样缺失」。
   */
  probeVideoStreamDuration?: (file: string) => number | null
}

/** 抽帧宽度：固定宽度让不同尺寸的镜头可比，也把 PSNR 成本压到可接受。 */
const SAMPLE_WIDTH = 320

/**
 * 抽取单帧灰度图并算 MD5（C-06 接缝审计的探测原语）。
 *
 * 为什么转灰度 PGM 而不是直接用 ffmpeg 的 psnr 滤镜：
 * 需要一次抽多帧、跨文件两两比较，滤镜得两两配对跑多次进程；
 * 转 PGM 后像素留在内存里，任意两帧都能算，同一份数据还能同时给 MD5 与 PSNR。
 */
export function extractGrayFrame(
  deps: SeamProbeDeps,
  file: string,
  atSeconds: number,
  workDir: string
): { md5: string; width: number; height: number; pixels: Uint8Array } | null {
  const output = join(workDir, `frame-${Math.round(atSeconds * 1000)}-${process.pid}.pgm`)
  const result = spawnSync(
    deps.ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', Math.max(0, atSeconds).toFixed(3),
      '-i', file,
      '-frames:v', '1', '-vf', `scale=${SAMPLE_WIDTH}:-2,format=gray`,
      // -update 1：image2 写单帧图片时必须显式声明，否则新版 ffmpeg 会报
      // 「filename does not contain an image sequence pattern」并拒绝写文件
      '-f', 'image2', '-update', '1', '-c:v', 'pgm', output
    ],
    { windowsHide: true, timeout: 30_000 }
  )
  if (result.status !== 0 || !existsSync(output)) {
    try { rmSync(output, { force: true }) } catch { /* 清理失败不影响结果 */ }
    return null
  }
  try {
    const buffer = readFileSync(output)
    const parsed = deps.parseGray(buffer)
    if (!parsed) return null
    return {
      md5: createHash('md5').update(buffer).digest('hex'),
      width: parsed.width,
      height: parsed.height,
      pixels: new Uint8Array(parsed.data)
    }
  } finally {
    try { rmSync(output, { force: true }) } catch { /* 清理失败不影响结果 */ }
  }
}

/**
 * 探测一个视频镜头的首/中/末三帧。
 *
 * 采样点刻意避开绝对首尾：末帧取 duration-0.06s 而不是 duration，
 * 因为 -ss 恰好等于片长时 ffmpeg 取不到帧，会误报「采样缺失」——
 * 那种误报会让人去查一个并不存在的问题。
 */
export function probeSeamFrames(
  deps: SeamProbeDeps,
  file: string,
  startSeconds: number,
  durationSeconds: number,
  workDir?: string
): ShotSampleSet | null {
  if (!existsSync(file)) return null
  // 优先用画面流时长：音轨可能比画面长，按文件时长抽末帧会抽空
  const streamDuration = deps.probeVideoStreamDuration?.(file) ?? null
  const duration = streamDuration && streamDuration > 0 ? streamDuration : deps.probeDuration(file)
  if (!duration || duration <= 0) return null
  const requested = durationSeconds > 0 ? durationSeconds : duration
  // 镜内可用时长不能超过素材本身
  const usable = Math.min(requested, duration)

  const tempDir = workDir ?? join(tmpdir(), `morrow-seam-${process.pid}-${Date.now().toString(36)}`)
  const created = !existsSync(tempDir)
  if (created) mkdirSync(tempDir, { recursive: true })

  const offsets: Array<{ position: 'start' | 'middle' | 'end'; at: number }> = [
    { position: 'start', at: 0.04 },
    { position: 'middle', at: usable / 2 },
    { position: 'end', at: Math.max(0.05, usable - 0.06) }
  ]

  const samples: ShotFrameSample[] = offsets.map(({ position, at }) => {
    const frame = extractGrayFrame(deps, file, at, tempDir)
    return {
      position,
      atSeconds: Math.round((startSeconds + at) * 1000) / 1000,
      md5: frame?.md5 ?? null,
      ...(frame ? { pixels: frame.pixels, width: frame.width, height: frame.height } : {})
    }
  })

  if (created) {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
  }

  return {
    number: 0,
    assetId: file,
    startSeconds,
    durationSeconds: usable,
    samples
  }
}