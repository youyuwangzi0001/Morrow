import { describe, expect, it, vi } from 'vitest'
import {
  PSNR_DUPLICATE_THRESHOLD,
  auditIntraShotDuplicates,
  auditSeams,
  auditSeamsAndStills,
  auditShotStillness,
  computePsnr,
  formatAt,
  normalizePsnr,
  summarizeSeamAudit
} from '../../src/shared/seam-audit'
import type { ShotFrameSample, ShotSampleSet } from '../../src/shared/seam-audit'
import { HARDSUB_DETECT, analyzeGrayFrame, voteHardsub } from '../../src/shared/seam-audit'
import type { HardsubFrameResult } from '../../src/shared/seam-audit'
import { join } from 'node:path'
import { buildTimelineFromProject, renderProject, runChecks } from '../../src/main/studio'
import { makeDramaProject, tempStore } from './studio-fixtures'

// ==========================================================================
// 原 tests/unit/seam-audit.test.ts
// ==========================================================================

/** 造一张灰度帧。 */
function frame(position: 'start' | 'middle' | 'end', at: number, fill: number, md5?: string): ShotFrameSample {
  const pixels = new Uint8Array(64).fill(fill)
  return { position, atSeconds: at, md5: md5 ?? `md5-${position}-${fill}`, pixels, width: 8, height: 8 }
}

/** 造一镜：三帧亮度可控。 */
function shot(number: number, start: number, brightness: [number, number, number]): ShotSampleSet {
  return {
    number,
    assetId: `asset-${number}`,
    startSeconds: start,
    durationSeconds: 4,
    samples: [
      frame('start', start, brightness[0]),
      frame('middle', start + 2, brightness[1]),
      frame('end', start + 3.94, brightness[2])
    ]
  }
}

describe('C-06 接缝与静帧审计器', () => {
  it('@core:studio-media PSNR 计算正确，完全相同返回 Infinity、尺寸不一致返回 NaN', () => {
    const black = new Uint8Array(100)
    expect(computePsnr(black, black)).toBe(Number.POSITIVE_INFINITY)

    // 全黑 vs 灰度 10 → MSE = 100 → 10*log10(65025/100) = 28.131dB
    const gray = new Uint8Array(100).fill(10)
    expect(computePsnr(black, gray)).toBeCloseTo(28.131, 3)

    const white = new Uint8Array(100).fill(255)
    expect(computePsnr(black, white)).toBeCloseTo(0, 5)

    expect(Number.isNaN(computePsnr(black, new Uint8Array(50)))).toBe(true)
    expect(Number.isNaN(computePsnr(new Uint8Array(0), new Uint8Array(0)))).toBe(true)

    // normalizePsnr 把 Infinity 收敛成 99，避免下游写 JSON 变 null
    expect(normalizePsnr(Number.POSITIVE_INFINITY)).toBe(99)
  })

  it('@core:studio-media 静帧判定：首末帧完全相同必报镜号与时间点，运动镜头不误杀', () => {
    // 完全静止：三帧像素一致且 MD5 相同
    const still: ShotSampleSet = {
      number: 7,
      assetId: 'still',
      startSeconds: 12.5,
      durationSeconds: 4,
      samples: [
        frame('start', 12.54, 128, 'same'),
        frame('middle', 14.5, 128, 'same'),
        frame('end', 16.44, 128, 'same')
      ]
    }
    const stillIssues = auditShotStillness(still)
    const hit = stillIssues.find((issue) => issue.kind === 'still')
    expect(hit, '静止镜头必须判静帧').toBeDefined()
    expect(hit?.level).toBe('error')
    expect(hit?.shots).toEqual([7])
    // 验收要求：必须报出镜号与时间点
    expect(hit?.message).toContain('镜 7')
    expect(hit?.message).toMatch(/\d{2}:\d{2}\.\d{3}/)
    expect(hit?.atSeconds).toBeCloseTo(12.54, 2)

    // 真实运动：首末帧亮度差很大（PSNR 低）
    const moving = shot(3, 0, [20, 128, 235])
    expect(auditShotStillness(moving)).toHaveLength(0)

    // 首末帧像素完全相同 → 按方案判据（首末帧 PSNR > 30dB）就该判静帧，
    // 即使中间有变化：观众看到的是「动了一圈回到原样」，与静帧观感无异。
    const pan = shot(4, 0, [90, 200, 90])
    expect(auditShotStillness(pan).some((issue) => issue.kind === 'still')).toBe(true)

    // 中间帧固定、首末不同的镜头不判静帧（中间只是过程，不参与判据）
    expect(auditShotStillness(shot(5, 0, [20, 200, 235]))).toHaveLength(0)
  })

  it('@core:studio-media 接缝重复：注入一帧重复画面必须报出两个镜号与接缝时间点', () => {
    // 镜1 末帧与镜2 首帧逐像素相同（模拟接缝重复）
    const endFrame = frame('end', 3.94, 60, 'shared-frame')
    const shot1: ShotSampleSet = {
      number: 1,
      assetId: 'a1',
      startSeconds: 0,
      durationSeconds: 4,
      samples: [frame('start', 0.04, 10, 's1'), frame('middle', 2, 30, 'm1'), endFrame]
    }
    const shot2: ShotSampleSet = {
      number: 2,
      assetId: 'a2',
      startSeconds: 4,
      durationSeconds: 4,
      samples: [
        { ...endFrame, position: 'start', atSeconds: 4.04 },
        frame('middle', 6, 30, 'm2'),
        frame('end', 7.94, 80, 'e2')
      ]
    }

    const issues = auditSeams([shot1, shot2])
    const hit = issues.find((issue) => issue.kind === 'seam-repeat')
    expect(hit, '接缝重复必须被检出').toBeDefined()
    expect(hit?.level).toBe('error')
    expect(hit?.shots).toEqual([1, 2])
    expect(hit?.message).toContain('镜 1')
    expect(hit?.message).toContain('镜 2')
    expect(hit?.message).toMatch(/\d{2}:\d{2}\.\d{3}/)
    expect(hit?.atSeconds).toBeCloseTo(4.04, 2)

    // 正常接缝（两侧画面差异明显）不报：镜A 末帧亮 200，镜B 首帧亮 20
    const shotA = shot(1, 0, [20, 120, 200])
    const shotB = shot(2, 4, [20, 120, 235])
    expect(auditSeams([shotA, shotB])).toHaveLength(0)
  })

  it('@core:studio-media 镜内重复帧：模型卡住产出同帧时降级为 warn，不阻断出片', () => {
    const stuck: ShotSampleSet = {
      number: 5,
      assetId: 'stuck',
      startSeconds: 0,
      durationSeconds: 4,
      samples: [
        frame('start', 0.04, 100, 'dup'),
        frame('middle', 2, 100, 'dup'),
        frame('end', 3.94, 20, 'tail')
      ]
    }
    const issues = auditIntraShotDuplicates(stuck)
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('duplicate-frame')
    expect(issues[0].level).toBe('warn')
    expect(issues[0].message).toContain('镜 5')
    expect(issues[0].message).toMatch(/\d{2}:\d{2}\.\d{3}/)
  })

  it('@core:studio-media 主入口把三类问题合并并按时间排序，汇总行含算术与首个问题定位', () => {
    const samples = [
      { ...shot(1, 0, [128, 128, 128]), samples: [frame('start', 0.04, 128, 'same'), frame('middle', 2, 128, 'same'), frame('end', 3.94, 128, 'same')] },
      shot(2, 4, [20, 120, 220]),
      {
        ...shot(3, 8, [60, 60, 30]),
        samples: [frame('start', 8.04, 60, 'shared'), frame('middle', 10, 60, 'shared'), frame('end', 11.94, 30, 'e3')]
      }
    ]
    const issues = auditSeamsAndStills(samples)
    expect(issues.some((issue) => issue.kind === 'still')).toBe(true)
    expect(issues.some((issue) => issue.kind === 'duplicate-frame')).toBe(true)
    // 按时间升序
    for (let index = 1; index < issues.length; index += 1) {
      expect(issues[index].atSeconds).toBeGreaterThanOrEqual(issues[index - 1].atSeconds)
    }

    const summary = summarizeSeamAudit(samples, issues)
    expect(summary).toContain('3 镜接缝审计')
    expect(summary).toMatch(/静帧 \d+/)
    expect(summary).toMatch(/接缝重复 \d+/)
    expect(summary).toMatch(/首个问题在 \d{2}:\d{2}\.\d{3}/)
  })

  it('@core:studio-media 无法采样时不凭「不知道」判错：降级 warn 并说明无法确认', () => {
    const broken: ShotSampleSet = {
      number: 9,
      assetId: 'broken',
      startSeconds: 0,
      durationSeconds: 4,
      samples: [{ position: 'start', atSeconds: 0.04, md5: null }]
    }
    const issues = auditShotStillness(broken)
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('sample-missing')
    expect(issues[0].level).toBe('warn')
    expect(issues[0].message).toContain('无法判定静帧')

    // 时间格式化
    expect(formatAt(65.5)).toBe('01:05.500')
    expect(formatAt(-3)).toBe('00:00.000')
    // 阈值是方案实测校准出来的，锁死防止被悄悄改小造成误杀
    expect(PSNR_DUPLICATE_THRESHOLD).toBe(30)
  })
})

// ==========================================================================
// 原 tests/unit/hardsub.test.ts
// ==========================================================================

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: (name: string) => join(process.env.TEMP ?? 'C:/Windows/Temp', name),
    getVersion: () => '0.2.0'
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

/** 造一张灰度图：默认全暗，再按 draw 回调改指定像素。 */
function makeGray(width: number, height: number, draw?: (x: number, y: number) => number): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(width * height)
  if (!draw) return { width, height, data }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = draw(x, y)
  }
  return { width, height, data }
}

/** 在若干行上画「文字行」：亮块 + 空隙，模拟一行字幕。 */
function drawTextRows(width: number, height: number, rows: [number, number]): { width: number; height: number; data: Uint8Array } {
  return makeGray(width, height, (x, y) => {
    if (y < rows[0] || y > rows[1]) return 10
    // 每 60px 一个亮块，块内 40px 亮、20px 暗：分成多段，最长段约占行宽 1/8。
    return x % 60 < 40 ? 240 : 12
  })
}

describe('C-03 内嵌字幕检测', () => {
  it('@core:studio-media 文字行带判定：亮块分行命中，整片亮区与纯暗场不误报', () => {
    const width = 480
    const height = 103

    // 一行字幕：底部 9 行是亮块文字
    const withText = drawTextRows(width, height, [80, 88])
    const textResult = analyzeGrayFrame(withText)
    expect(textResult.hit, '文字行必须命中').toBe(true)
    expect(textResult.coverage).toBeGreaterThanOrEqual(HARDSUB_DETECT.brightRatio)
    expect(textResult.bandHeight).toBeGreaterThanOrEqual(HARDSUB_DETECT.minBandHeight)
    expect(textResult.bandHeight).toBeLessThanOrEqual(HARDSUB_DETECT.maxBandHeight)

    // 整片亮区（天空、白墙）：亮占比极高但连成一片，不是文字
    const solidBright = makeGray(width, height, () => 240)
    expect(analyzeGrayFrame(solidBright).hit, '整片亮区不能被当成字幕').toBe(false)

    // 纯暗场：没有亮像素
    const dark = makeGray(width, height, () => 8)
    expect(analyzeGrayFrame(dark).hit, '纯暗场不能命中').toBe(false)

    // 只有一条细亮线（1 行）：段高不足，不算字幕行带
    const thinLine = makeGray(width, height, (x, y) => (y === 50 && x % 60 < 40 ? 240 : 10))
    expect(analyzeGrayFrame(thinLine).hit, '单行细线不能命中').toBe(false)

    // 尺寸不足与数据长度不符时必须安全返回，不能抛错
    expect(analyzeGrayFrame({ width: 4, height: 4, data: new Uint8Array(16) }).hit).toBe(false)
    expect(analyzeGrayFrame({ width: 100, height: 100, data: new Uint8Array(10) }).hit).toBe(false)
  })

  it('@core:studio-media 反光/高光不误判成字幕：厚行带与非文字结构必须被排除', () => {
    const width = 480
    const height = 103

    // 复现真实误报：随包成片 40s 处是一块厨具反光，15 行连续高亮、暗像素也够，
    // 早期只按「亮 + 分段」判定时会被当成字幕（实测 coverage 0.37 命中）。
    // 单行字幕实测只有 7–9px 高，因此厚度上限是区分反光的关键判据。
    const glare = makeGray(width, height, (x, y) => {
      if (y < 37 || y > 51) return 40
      return x % 70 < 30 ? 235 : 25
    })
    const glareResult = analyzeGrayFrame(glare)
    expect(glareResult.hit, '15px 厚的反光行带不能判成字幕').toBe(false)

    // 同一位置改成单行字幕厚度（7px）：应当命中，证明判据区分的是厚度而不是亮度。
    const realSubtitle = makeGray(width, height, (x, y) => {
      if (y < 66 || y > 72) return 40
      return x % 70 < 30 ? 235 : 25
    })
    expect(analyzeGrayFrame(realSubtitle).hit, '7px 厚的单行字幕必须命中').toBe(true)
  })

  it('@core:studio-media 多帧投票：单帧命中不算，过半帧命中才判定；空样本不判定', () => {
    const hit = (frame: number): HardsubFrameResult => ({ frame, hit: true, coverage: 0.5, edgeRatio: 0.02, bandHeight: 9 })
    const miss = (frame: number): HardsubFrameResult => ({ frame, hit: false, coverage: 0, edgeRatio: 0, bandHeight: 0 })

    // 1/3 命中：不判定（压缩噪点常造成单帧误报）
    const single = voteHardsub([hit(1), miss(2), miss(3)])
    expect(single.detected).toBe(false)
    expect(single.hits).toBe(1)
    expect(single.samples).toBe(3)

    // 2/3 命中：判定
    const majority = voteHardsub([hit(1), hit(2), miss(3)])
    expect(majority.detected).toBe(true)
    expect(majority.hits).toBe(2)

    // 3/3 命中：判定
    expect(voteHardsub([hit(1), hit(2), hit(3)]).detected).toBe(true)

    // 0 帧：不判定，且不伪装成通过
    const empty = voteHardsub([])
    expect(empty.detected).toBe(false)
    expect(empty.samples).toBe(0)
    expect(empty.reason).toContain('没有可用采样帧')
  })

  it('@core:studio-media 内嵌字幕命中即阻断出片，并落成 error 级检查项（不是警告）', async () => {
    const { store, dir } = tempStore()
    const project = makeDramaProject(store)
    const poster = store.addAsset(project, {
      filePath: join(process.cwd(), 'tests', 'fixtures', 'studio-demo', 'drama-01.jpg'),
      title: '画面',
      kindHint: 'image'
    })
    project.shots.forEach((shot) => {
      shot.videoAssetId = null
      shot.imageAssetId = poster.id
      shot.voiceAssetId = null
    })
    project.timeline = buildTimelineFromProject(project)

    // 第一镜换成视频素材，并标记检出内嵌字幕
    const videoFile = join(process.cwd(), 'tests', 'fixtures', 'studio-demo', 'video-01.mp4')
    const video = store.addAsset(project, { filePath: videoFile, title: '镜 01', kindHint: 'video' })
    project.shots[0].videoAssetId = video.id
    project.shots[0].imageAssetId = null
    video.hardsub = { detected: true, hits: 3, samples: 3, reason: '3/3 帧检出文字行带', checkedAt: Date.now() }

    // 检查项：必须是 error 级，并明确要求整镜重做
    const checks = runChecks(project)
    const hardsubCheck = checks.find((check) => check.title.includes('内嵌字幕'))
    expect(hardsubCheck, '必须生成内嵌字幕检查项').toBeTruthy()
    expect(hardsubCheck?.level, '内嵌字幕必须是 error 级而不是警告').toBe('error')
    expect(hardsubCheck?.detail).toContain('整镜重做')
    expect(hardsubCheck?.detail).toContain('SRT')

    // 出片：即使允许缺画面，也必须被内嵌字幕挡住
    project.timeline = buildTimelineFromProject(project)
    await expect(
      renderProject(project, { quality: 'draft', allowMissing: true, store })
    ).rejects.toThrow(/内嵌字幕[\s\S]*整镜重做/)

    // 清掉标记后不再被这条规则阻断（避免误伤正常出片）
    video.hardsub = { detected: false, hits: 0, samples: 3, reason: '0/3 帧命中', checkedAt: Date.now() }
    expect(runChecks(project).some((check) => check.title.includes('内嵌字幕'))).toBe(false)
  }, 240_000)
})
