import { describe, expect, it } from 'vitest'
import {
  AUDIO_LINES,
  SHOT_CUT_SECONDS,
  buildSegmentFromShots,
  buildV4Prompt,
  formatTimecode,
  mapAction,
  mapCameraMove,
  mapShotSize,
  promptHasErrors,
  scanChineseBoundary,
  shotsNeededForV4,
  validateV4Prompt
} from '../../src/main/video-prompt'
import type { PromptSegment } from '../../src/main/video-prompt'

// ==========================================================================
// 原 tests/unit/prompt-v4.test.ts
// ==========================================================================

/** 方案第 06 章给出的标准样例。 */
function fixtureSegment(): PromptSegment {
  return {
    index: 1,
    total: 9,
    title: 'The Half-Dismantled Canopy',
    spatialLock: [
      { name: 'The Man', side: 'LEFT', facing: 'RIGHT' },
      { name: 'The Aunt', side: 'RIGHT', facing: 'LEFT' }
    ],
    centreProp: 'A folding table',
    entryState: 'The Aunt’s finger hangs in mid-air.',
    shots: [
      { shotSize: 'Medium Close-Up', cameraMove: 'slow push in', action: 'The Man keeps his eyes on the table edge.', dialogue: '我要结婚了。', speaker: 'The Man', tone: 'low and level' },
      { shotSize: 'Close-Up', cameraMove: 'steady hold with slight drift', action: 'The Aunt’s jaw tightens.' },
      { shotSize: 'Medium Shot', cameraMove: 'slow pull back', action: 'The canopy fabric sags between them.' },
      { shotSize: 'Wide Shot', cameraMove: 'gentle lateral track', action: 'Dust turns in the lamp light.' }
    ],
    exitState: 'The Aunt turns her face away from the table.',
    soundscape: 'the diesel idle of a van'
  }
}

describe('BATCH 1 v4 提示词基座', () => {
  it('@core:studio-media 按方案骨架拼出提示词，14 项验收全过', () => {
    const prompt = buildV4Prompt(fixtureSegment())

    // 结构逐字对齐方案
    expect(prompt.startsWith('# Segment 1/9 - The Half-Dismantled Canopy')).toBe(true)
    expect(prompt).toContain('[SPATIAL LOCK]')
    expect(prompt).toContain('- The Man: ALWAYS on the LEFT of frame, facing RIGHT.')
    expect(prompt).toContain('Eye-line never swaps, never mirrored. Positions never trade.')
    expect(prompt).toContain('[ENTRY STATE]')
    expect(prompt).toContain('[Shot 1] Cinematic, Medium Close-Up, slow push in.')
    // 四镜时间码：方案规定 2.5 / 5 / 7.5 秒
    expect(SHOT_CUT_SECONDS).toEqual([0, 2.5, 5, 7.5])
    expect(formatTimecode(2.5)).toBe('00:02.500')
    expect(prompt).toContain('At 00:02.500, the camera cuts to a Close-Up')
    expect(prompt).toContain('At 00:05.000, the camera cuts to a Medium Shot')
    expect(prompt).toContain('At 00:07.500, the camera cuts to a Wide Shot')
    // 中文台词必须在 <d>[Chinese]</d> 内
    expect(prompt).toContain('<d>[Chinese] 我要结婚了。</d>')
    // 音频三行
    expect(prompt).toContain('overall_soundscape: the diesel idle of a van.')
    expect(prompt).toContain(AUDIO_LINES.music)
    expect(prompt).toContain(AUDIO_LINES.noSubtitles)

    const checks = validateV4Prompt(prompt)
    const failed = checks.filter((check) => !check.ok)
    expect(failed, `不应有不通过项：${failed.map((item) => item.id).join(',')}`).toHaveLength(0)
    // 验收项清单：E01–E11 十一项结构/边界 + 三条禁令 + W12–W14 三项提醒 = 17 项
    expect(checks).toHaveLength(17)
    expect(checks.filter((check) => check.level === 'error')).toHaveLength(14)
    expect(checks.filter((check) => check.level === 'warn')).toHaveLength(3)
    expect(promptHasErrors(checks)).toBe(false)
  })

  it('@core:studio-media 中文边界：<d> 之外的汉字必须被抓出，<d> 之内不误报', () => {
    // 合法：台词在 <d>[Chinese]</d> 内
    expect(scanChineseBoundary('He says: <d>[Chinese] 我要结婚了。</d>')).toHaveLength(0)

    // 违规：段标题写中文（方案里点名的错误写法）
    const bad1 = scanChineseBoundary('# Segment 1/9 - 灵棚拆到一半')
    expect(bad1).toHaveLength(1)
    expect(bad1[0].text).toBe('灵棚拆到一半')

    // 违规：音效字段写中文
    const bad2 = scanChineseBoundary('overall_soundscape: 柴油机怠速')
    expect(bad2).toHaveLength(1)
    expect(bad2[0].text).toBe('柴油机怠速')

    // 违规：SPATIAL LOCK 里的人物名写中文
    expect(scanChineseBoundary('- The Man (周建平): ALWAYS on the LEFT.')).toHaveLength(1)

    // 混合：只有 <d> 外的被抓
    const mixed = scanChineseBoundary('# Segment 1/1 - 开场\nHe says: <d>[Chinese] 走吧。</d>\n[EXIT STATE] 结束了。')
    expect(mixed.map((item) => item.text)).toEqual(['开场', '结束了'])
  })

  it('@core:studio-media 四条禁令：写进提示词会坏事的东西必须报 error', () => {
    const base = buildV4Prompt(fixtureSegment())
    const cases: Array<{ label: string; text: string; id: string }> = [
      { label: 'STYLE LOCK', text: `${base}\nSTYLE LOCK: cinematic teal`, id: 'no-style-lock' },
      { label: 'CHARACTER LOCK', text: `${base}\nCHARACTER LOCK enabled`, id: 'no-style-lock' },
      { label: 'Picture 引用', text: `${base}\nUse <Picture 1> as reference.`, id: 'no-picture-tag' },
      { label: '@图片N', text: `${base}\n跟 @图片2 保持一致`, id: 'no-picture-tag' },
      { label: 'Camera: locked', text: `${base}\nCamera: locked in all six shots.`, id: 'no-camera-locked' },
      { label: 'No pan, no orbit', text: `${base}\nNo pan, no orbit.`, id: 'no-camera-locked' }
    ]
    for (const item of cases) {
      const checks = validateV4Prompt(item.text)
      const hit = checks.find((check) => check.id === item.id)
      expect(hit?.ok, `${item.label} 应被判为不通过`).toBe(false)
      expect(hit?.level).toBe('error')
      expect(promptHasErrors(checks), `${item.label} 应触发阻断`).toBe(true)
    }
  })

  it('@core:studio-media 结构缺项与时间码错误都要报出来，不能静默通过', () => {
    const base = buildV4Prompt(fixtureSegment())

    // 缺 [SPATIAL LOCK]
    const noLock = base.replace('[SPATIAL LOCK]', '')
    expect(validateV4Prompt(noLock).find((check) => check.id === 'E02-spatial-lock')?.ok).toBe(false)

    // 缺音频三行里的 music 行
    const noMusic = base.replace(AUDIO_LINES.music, '')
    expect(validateV4Prompt(noMusic).find((check) => check.id === 'E10-audio-three-lines')?.ok).toBe(false)

    // 时间码被改错
    const wrongTime = base.replace('At 00:02.500', 'At 00:03.000')
    expect(validateV4Prompt(wrongTime).find((check) => check.id === 'E09-timecode-exact')?.ok).toBe(false)

    // 顺序被打乱（EXIT STATE 跑到 Shot 前面）
    const reordered = base.replace('[ENTRY STATE]', '[EXIT STATE]')
    expect(validateV4Prompt(reordered).find((check) => check.id === 'E03-entry-state')?.ok).toBe(false)

    // 运镜缺速度词：warn 级，不阻断但要提示
    const noSpeed = base.replace(/slow |steady |gentle /g, '')
    const speedCheck = validateV4Prompt(noSpeed).find((check) => check.id === 'W12-camera-speed-word')
    expect(speedCheck?.ok).toBe(false)
    expect(speedCheck?.level).toBe('warn')
  })

  it('@core:studio-media 中文镜头适配为英文 v4 段：景别/运镜映射正确，不足 4 镜如实提示而不伪造', () => {
    // 景别与运镜映射
    expect(mapShotSize('特写')).toBe('Close-Up')
    expect(mapShotSize('中景')).toBe('Medium Shot')
    expect(mapShotSize('全景')).toBe('Wide Shot')
    expect(mapShotSize('过肩')).toBe('Over-the-Shoulder Shot')
    expect(mapShotSize('')).toBe('Medium Shot')
    expect(mapCameraMove('推近')).toBe('slow push in')
    expect(mapCameraMove('拉开')).toBe('slow pull back')
    // 「固定镜头」不能映射成 static——v4 禁止 Camera: locked 那类写法
    expect(mapCameraMove('固定镜头')).toContain('steady hold')
    expect(mapCameraMove('固定镜头')).not.toMatch(/locked|static/i)

    // 中文动作要能被提取成有差异的英文，而不是所有镜头都退化成同一句
    const a = mapAction('林晚把黑伞拆开，零件在灯下泛出旧伤一样的光', 'fallback')
    const b = mapAction('水珠沿着伞骨往上流', 'fallback')
    const c = mapAction('伞骨忽然反向张开', 'fallback')
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
    expect(a).toMatch(/light|apart/i)
    expect(b).toMatch(/water/i)
    expect(c).toMatch(/reverse|opens/i)

    // 单镜升级为视频：如实报出需要补镜，不偷偷复制镜头凑 4 镜
    const segment = buildSegmentFromShots(
      [{ number: 3, action: '伞骨忽然反向张开', camera: '推近', shotSize: '特写', dialogue: '这把伞不是我的。', speaker: '林晚', continuity: '' }],
      { index: 1, total: 1, title: 'Shot 3' }
    )
    expect(segment.shots).toHaveLength(1)
    expect(shotsNeededForV4(1)).toBe(3)

    const prompt = buildV4Prompt(segment)
    const checks = validateV4Prompt(prompt)
    // 中文台词进 <d>，不裸奔
    expect(scanChineseBoundary(prompt)).toHaveLength(0)
    expect(prompt).toContain('<d>[Chinese] 这把伞不是我的。</d>')
    // 镜头数不足必须被报出来（error），而不是假装合规
    expect(checks.find((check) => check.id === 'E08-four-shots')?.ok).toBe(false)
    expect(promptHasErrors(checks)).toBe(true)
  })
})
