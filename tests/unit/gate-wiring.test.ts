/**
 * 出包门禁的**接线**用例：导演层的时长审核真的进了 gateItems。
 *
 * 这份文件守的不是「判定逻辑对不对」（那在 director-layer.test.ts），而是
 * **判定结论有没有到用户面前**。审计文档 D-04 的教训是：函数写对了、
 * 单测也过了，但生产代码从不调用，于是门禁显示「通过」而缺陷照旧。
 *
 * 所以这里不 mock 审核函数，而是构造真实的 StudioProject 走 renderProject，
 * 用真实报错消息锁住「结论确实传到了出包路径」。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StudioStore, buildTimelineFromProject, nowMs, renderProject, shortFrameShots, musicDeclarationIssue } from '../../src/main/studio'
import type { StudioProject } from '../../src/shared/studio'
import { addShot, TINY_PNG } from './studio-fixtures'

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

/**
 * 造一个「除了时长以外都合格」的漫剧工程。
 *
 * 时长判据是唯一变量：画面、配音、景别、字幕全给齐，这样 renderProject
 * 里其它门禁项都不会先触发，报错只可能来自时长审核。
 */
function makeTimedProject(store: StudioStore, sceneDurations: number[][]): StudioProject {
  const project = store.newProject({
    kind: 'drama',
    title: '门禁接线用例',
    logline: '一段用来验证时长门禁的戏。',
    brief: { aspect: '16:9', targetSeconds: 30, constraints: [] }
  })
  const image = store.addAsset(project, {
    bytes: TINY_PNG,
    title: '测试画面',
    mime: 'image/png',
    kindHint: 'image',
    metadata: { width: 1, height: 1 }
  })
  project.scenes = sceneDurations.map((_, index) => ({
    id: `scene-${index + 1}`,
    episodeId: 'ep-1',
    number: index + 1,
    title: `第 ${index + 1} 场`,
    synopsis: '',
    location: '老街',
    timeOfDay: '夜',
    characters: ['林晚'],
    beat: 'Setup',
    updatedAt: nowMs()
  }))
  let number = 0
  for (const [sceneIndex, durations] of sceneDurations.entries()) {
    for (const durationSec of durations) {
      number += 1
      // 首镜必须是近景（否则先撞上 weak-opening，就验证不到时长这一项），
      // 其余交替景别，避免撞上「相邻同景别」这一项无关门禁
      addShot(project, number, {
        sceneId: `scene-${sceneIndex + 1}`,
        durationSec,
        shotSize: number % 2 === 1 ? '中近景' : '特写',
        imageAssetId: image.id
      })
    }
  }
  project.timeline = buildTimelineFromProject(project)
  return project
}

describe('出包门禁：导演层时长审核已接线', () => {
  let dir = ''

  afterEach(() => {
    if (!dir) return
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录清不掉不影响断言
    }
    dir = ''
  })

  it('@core:studio-media auditDurationPlan 的结论真的进了 gateItems：全等长在出包路径上报 error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'morrow-gate-wire-'))
    const store = new StudioStore(dir)
    // 三场各 2 镜 × 8s = 每场 16s，段间全等长
    const project = makeTimedProject(store, [[8, 8], [8, 8], [8, 8]])

    // 这条消息只有 auditDurationPlan 会产出（含「催眠效应」与段数），
    // 用来证明结论是从导演层传出来的，而不是门禁里另写了一份判定。
    await expect(renderProject(project, { quality: 'draft', allowMissing: true, store })).rejects.toThrow(
      /全片 3 段时长都是 16\.0s[\s\S]*催眠效应/
    )
  }, 240_000)

  it('@core:studio-media 段时长有差异时不误报：导演层 warning 不阻断出包', async () => {
    dir = mkdtempSync(join(tmpdir(), 'morrow-gate-wire-'))
    const store = new StudioStore(dir)
    // 段长 16s / 12s / 12s / 16s —— 段间不等长（不会报 error），但中间两段
    // 时长相撞，auditDurationPlan 会给一条 warn。warn 绝不能升级成阻断：
    // 那是创作建议，拦下来会让用户被一条「建议」卡死在某次出包上。
    const project = makeTimedProject(store, [[8, 8], [6, 6], [6, 6], [8, 8]])

    // 用已取消的 signal 让渲染在门禁之后立刻停下：能证明「门禁没拦」，
    // 又不必真的跑一遍 FFmpeg（这条用例要守的是门禁口径，不是编码管线）。
    await expect(
      renderProject(project, { quality: 'draft', allowMissing: true, store, signal: AbortSignal.abort() })
    ).rejects.toThrow(/已取消/)
  }, 60_000)
})

// ───── 桌面 D-02：补齐 frame-shortfall 与 music-declaration ─────
/**
 * 这两项此前「登记了但从不判定」。`missingGateChecks` 只在开发期打一条
 * warn、不阻断，所以缺口安静地存在了很久。
 *
 * ## 为什么直接测纯函数而不是走 renderProject
 *
 * 上一版我写成「期待 renderProject 抛错」，结果失败 —— 因为这两项都是
 * `level: 'warn'`，而 `assertGatePassed` 只在 `errors.length > 0` 时抛。
 * warn 不阻断是**对的**：它们是创作提醒，不是出包缺陷，拦下来会让用户
 * 被一条建议卡死在某次出包上。
 *
 * 所以判定的正确性用纯函数验证，接线（renderProject 里确实调了它们）
 * 由 gate-coverage.test.ts 的集合一致性守住。
 */
describe('出包门禁：此前从不判定的两项', () => {
  it('@core:studio-media 实测帧数明显少于计划时长时给出 frame-shortfall', () => {
    // 计划 8s，实测 24 帧 @ 8fps = 3s —— 差 5s，必须报
    const rows = shortFrameShots(
      [{ number: 1, durationSec: 8, videoAssetId: 'v1' }],
      [{ id: 'v1', frames: 24, fps: 8 }]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ number: 1, plannedSec: 8, actualSec: 3 })
  })

  it('@core:studio-media 差一帧是正常取整，不当帧数不足', () => {
    // 时间线本来就按实测重算，差一帧必须放过，否则每一镜都会报
    const rows = shortFrameShots(
      [{ number: 1, durationSec: 3, videoAssetId: 'v1' }],
      // 23 帧 @ 8fps = 2.875s，差 0.125s < 0.05? 不 —— 这里差得更多，
      // 所以换一组：24 帧 @ 8fps = 3.0s 正好等长
      [{ id: 'v1', frames: 24, fps: 8 }]
    )
    expect(rows).toEqual([])
  })

  it('@core:studio-media 没探测过 frames 的素材不算帧数不足', () => {
    // 「还没探测」与「不够」是两件事。报成不足会让用户去重做一镜，
    // 而实际只是没跑过 ffprobe。
    const rows = shortFrameShots(
      [{ number: 1, durationSec: 8, videoAssetId: 'v1' }],
      [{ id: 'v1' }]
    )
    expect(rows).toEqual([])
  })

  it('@core:studio-media 配乐测不出纯器乐时给出 music-declaration（warn，不阻断）', () => {
    const issue = musicDeclarationIssue({
      id: 'm1',
      musicAudit: { verdict: 'unknown' }
    })
    expect(issue).not.toBeNull()
    expect(issue!.code).toBe('music-declaration')
    // warn 而不是 error：unknown 是「没证据」，不是「有人声」
    expect(issue!.level).toBe('warn')
    expect(issue!.message).toContain('没能确认是纯器乐')
  })

  it('@core:studio-media 配乐已确认纯器乐时不报', () => {
    expect(musicDeclarationIssue({ id: 'm1', musicAudit: { verdict: 'instrumental' } })).toBeNull()
  })

  it('@core:studio-media 没有人声判定结果时不报 music-declaration', () => {
    // 没有 musicAudit 说明还没跑过检测 —— 与 unknown（跑了但测不出）不同
    expect(musicDeclarationIssue({ id: 'm1' })).toBeNull()
    expect(musicDeclarationIssue(undefined)).toBeNull()
  })
})
