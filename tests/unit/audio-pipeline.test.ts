import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTimelineFromProject, LOUDNESS_TARGET, probeAudioLevels, renderProject } from '../../src/main/studio'
import { tempStore, makeDramaProject } from './studio-fixtures'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.TEMP ?? 'C:/Windows/Temp',
    getVersion: () => '0.2.0',
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => Buffer.from(value).toString('utf8')
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

describe('C-04 画音分离管线', () => {
  let store: ReturnType<typeof tempStore>['store']
  let dir = ''

  beforeEach(() => {
    const created = tempStore()
    store = created.store
    dir = created.dir
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('@core:studio-timeline 环境床是独立轨道，铺满全片且可循环；没有素材时不凭空铺', () => {
    const project = makeDramaProject(store)
    // 没有任何音频素材时不凭空造环境床。
    project.assets = project.assets.filter((asset) => asset.kind !== 'audio')
    expect(buildTimelineFromProject(project).clips.some((clip) => clip.kind === 'ambience')).toBe(false)

    const ambience = store.addAsset(project, {
      bytes: Buffer.from('RIFF0000WAVEfmt ambience'),
      title: '医院走廊环境声',
      mime: 'audio/wav',
      kindHint: 'audio',
      tags: ['sfx', 'ambience'],
      metadata: { durationSec: 4 }
    })
    const timeline = buildTimelineFromProject(project)
    const bed = timeline.clips.find((clip) => clip.kind === 'ambience')
    expect(bed).toBeTruthy()
    expect(bed?.assetId).toBe(ambience.id)
    expect(bed?.trackId).toBe('track-ambience')
    expect(bed?.start).toBe(0)
    expect(bed?.duration).toBeCloseTo(timeline.durationSec, 3)
    expect(bed?.loop).toBe(true)
    // 环境床的音量必须低于对白，避免盖住台词。
    expect(bed?.volume).toBeLessThan(1)
    expect(timeline.tracks.find((track) => track.id === 'track-ambience')?.kind).toBe('ambience')

    // 只有 rain/street 类音效时退而用它们兜底。
    const fallback = makeDramaProject(store)
    const fallbackBed = buildTimelineFromProject(fallback).clips.find((clip) => clip.kind === 'ambience')
    expect(fallbackBed).toBeTruthy()
    expect(fallback.assets.find((asset) => asset.id === fallbackBed?.assetId)?.tags).toContain('sfx')
  })

  it('@core:studio-timeline 视频自带音轨不进混音：画面素材不会被当成音频源', async () => {
    const project = makeDramaProject(store)
    // 用一个真实可判定的 wav 当画面素材会走错分支，因此这里直接用真实视频字节验证渲染链路：
    // 只有视频、没有任何音频素材时，成片音轨必须是纯静音，而不是把视频自带声混进来。
    const clip = join(process.cwd(), 'tests', 'fixtures', 'studio-demo', 'short', 'short-90f.mp4')
    expect(existsSync(clip)).toBe(true)
    const video = store.addAsset(project, {
      filePath: clip,
      title: '带声音的视频镜头',
      kindHint: 'video',
      tags: ['video']
    })
    project.shots.forEach((shot, index) => {
      shot.videoAssetId = index === 0 ? video.id : null
      shot.imageAssetId = null
      shot.voiceAssetId = null
    })
    project.assets = project.assets.filter((asset) => !(asset.kind === 'audio'))
    project.timeline = buildTimelineFromProject(project)
    expect(project.timeline.clips.filter((c) => c.kind === 'dialogue').length).toBe(0)
    expect(project.timeline.clips.filter((c) => c.kind === 'music').length).toBe(0)

    const output = await renderProject(project, { quality: 'draft', allowMissing: true, store })
    expect(existsSync(output.path)).toBe(true)
    // 只有画面、没有任何音频层时，音轨应近乎无声；不能等于视频原始音轨（−14dB 量级）。
    expect(output.audioLevels?.meanVolumeDb).toBeDefined()
    expect(output.audioLevels?.meanVolumeDb ?? 0).toBeLessThan(-40)
  }, 180_000)

  it('@core:studio-timeline 三层混音后成片响度落在 −18dB 附近，且采样率固定 48kHz', async () => {
    const project = makeDramaProject(store)
    const { spawnSync } = await import('node:child_process')
    // 用 ffmpeg 生成三段真实的正弦（不同音高，避免同内容被按 sha256 去重成同一素材）。
    const make = (name: string, hz: number): string => {
      const file = join(dir, name)
      const made = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=16:sample_rate=44100`, file], { windowsHide: true })
      expect(made.status).toBe(0)
      return file
    }
    const voice = store.addAsset(project, { filePath: make('voice.wav', 440), title: '测试配音', kindHint: 'audio', tags: ['voice'], metadata: { durationSec: 16 } })
    const bed = store.addAsset(project, { filePath: make('bed.wav', 220), title: '测试环境床', kindHint: 'audio', tags: ['sfx', 'ambience'], metadata: { durationSec: 16 } })
    const score = store.addAsset(project, { filePath: make('score.wav', 330), title: '测试配乐', kindHint: 'audio', tags: ['music', 'model'], metadata: { durationSec: 16 } })
    expect(new Set([voice.id, bed.id, score.id]).size, '三段素材必须各自独立').toBe(3)
    // fixture 自带的「测试环境声」是占位字节（不可解码），会顶掉真实环境床；这里先移除，
    // 让三层各用一段真实音频，才能验证「三层都进了混音」。
    project.assets = project.assets.filter((asset) => !(asset.kind === 'audio' && asset.tags.includes('sfx') && asset.id !== bed.id))
    project.musicAssetId = score.id
    // 画面用随包真实分镜图：fixture 的 1×1 占位图会让 zoompan 卡住，那是测试素材问题，不是管线问题。
    const poster = store.addAsset(project, {
      filePath: join(process.cwd(), 'tests', 'fixtures', 'studio-demo', 'drama-01.jpg'),
      title: '测试画面',
      kindHint: 'image'
    })
    project.shots.forEach((shot, index) => {
      shot.videoAssetId = null
      shot.imageAssetId = poster.id
      shot.voiceAssetId = index === 0 ? voice.id : null
    })
    project.timeline = buildTimelineFromProject(project)
    // 三层都必须在时间线上：对白 / 环境床 / 配乐。
    const kinds = new Set(project.timeline.clips.map((clip) => clip.kind))
    expect(kinds.has('dialogue')).toBe(true)
    expect(kinds.has('ambience')).toBe(true)
    expect(kinds.has('music')).toBe(true)

    const output = await renderProject(project, { quality: 'draft', allowMissing: true, store })
    // 响度目标必须是三层统一后的那一组参数（I=−18 / TP=−2 / LRA=11）。
    expect(LOUDNESS_TARGET).toEqual({ integrated: -18, truePeak: -2, range: 11 })
    // 先把失败原因暴露出来，避免被「降级成静音」掩盖。
    expect(output.audioFailures, `音频片段应全部合成成功：${JSON.stringify(output.audioFailures)}`).toHaveLength(0)
    expect(output.audioLevels).toBeTruthy()
    // 验收：loudnorm 锁定的 EBU R128 积分响度必须贴近 −18 LUFS。
    // 容差 ±1.5：两遍 loudnorm 在常规材料上能到 ±0.2，极端的纯合成音（本例三层正弦）会有 0.5 左右偏差。
    // （mean_volume 是采样均值，口径不同，只作参考报出，不作判据。）
    expect(output.audioLevels?.integratedLufs).toBeGreaterThanOrEqual(-19.5)
    expect(output.audioLevels?.integratedLufs).toBeLessThanOrEqual(-16.5)
    expect(output.audioLevels?.meanVolumeDb).toBeGreaterThanOrEqual(-23)
    expect(output.audioLevels?.meanVolumeDb).toBeLessThanOrEqual(-17)
    // 采样率必须是 48kHz，不能被 loudnorm 推到 96kHz。
    expect(output.audioLevels?.sampleRate).toBe(48000)
    // 不能整段近似无声。
    expect(output.audioLevels?.maxVolumeDb ?? -99).toBeGreaterThan(-40)
    // 成片信息必须如实写出实测响度，而不是只写「已合成」。
    expect(output.message).toContain('LUFS')

    // 读不到电平时不编造数据（这是「通过」与「未知」的分界）。
    writeFileSync(join(dir, 'empty.txt'), 'not audio')
    expect(await probeAudioLevels(join(dir, 'nope.wav'))).toBeNull()
    expect(await probeAudioLevels(join(dir, 'empty.txt'))).toBeNull()
  }, 240_000)
})