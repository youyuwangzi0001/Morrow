import { describe, expect, it } from 'vitest'
import {
  INSTRUMENTAL_DECLARATION,
  INSTRUMENT_PALETTE,
  VOCAL_DIFF_THRESHOLD_DB,
  VOICE_BAND_HIGH_HZ,
  VOICE_BAND_LOW_HZ,
  auditMusicTrack,
  buildInstrumentalCaption,
  checkInstrumentalDeclaration,
  judgeVocalBand
} from '../../src/main/music-audit'

describe('C-08 配乐校验', () => {
  it('@core:studio-media 频段判定：差值 > 2dB 放行，≤ 2dB 判有人声，测不出是 unknown', () => {
    // 判据数值与方案对齐
    expect(VOCAL_DIFF_THRESHOLD_DB).toBe(2)
    expect(VOICE_BAND_LOW_HZ).toBe(300)
    expect(VOICE_BAND_HIGH_HZ).toBe(3400)

    // 低频器乐掉得多 → 放行（实测低频器乐 11.5dB）
    const instrumental = judgeVocalBand(-24.7, -36.2)
    expect(instrumental.verdict).toBe('instrumental')
    expect(instrumental.diffDb).toBe(11.5)

    // 人声掉得少 → 判有人声（实测人声样本 1.0dB）
    const vocal = judgeVocalBand(-10.5, -11.5)
    expect(vocal.verdict).toBe('vocal')
    expect(vocal.reason).toContain('疑似有人声')

    // 边界取严：差正好 2.0 不放行
    expect(judgeVocalBand(-20, -22).verdict).toBe('vocal')
    expect(judgeVocalBand(-20, -22.1).verdict).toBe('instrumental')

    // 语音频段反而更响（人声主导）必须判有人声
    expect(judgeVocalBand(-25, -20).verdict).toBe('vocal')

    // 测不出不能算通过——把未知报成通过会让人以为配乐已过关
    const unknown = judgeVocalBand(null, -20)
    expect(unknown.verdict).toBe('unknown')
    expect(unknown.reason).toContain('无法判定')
    expect(judgeVocalBand(-20, null).verdict).toBe('unknown')
    expect(judgeVocalBand(Number.NaN, -20).verdict).toBe('unknown')
  })

  it('@core:studio-media 纯器乐声明：必须有正向乐器编制 + 英文收尾句，只写否定式不算', () => {
    const good = buildInstrumentalCaption('rain')
    expect(good).toContain(INSTRUMENTAL_DECLARATION)
    expect(good.toLowerCase()).toContain('felt piano')
    expect(checkInstrumentalDeclaration(good).ok).toBe(true)

    // 五种情绪都能拼出合规 caption（情绪池必须覆盖全面，否则某类配乐生成时没声明可用）
    for (const mood of Object.keys(INSTRUMENT_PALETTE)) {
      const caption = buildInstrumentalCaption(mood)
      expect(checkInstrumentalDeclaration(caption).ok, `情绪 ${mood}`).toBe(true)
    }

    // 方案 FIX-13：不用「无人声」这种否定式，正向描写更有效
    const onlyNegative = checkInstrumentalDeclaration('no vocals, 无人声，安静的音乐')
    expect(onlyNegative.ok).toBe(false)
    expect(onlyNegative.missing.some((item) => /正向乐器编制/.test(item))).toBe(true)

    // 缺收尾句 / 空 caption 都不通过
    expect(checkInstrumentalDeclaration('felt piano and cello drone').ok).toBe(false)
    expect(checkInstrumentalDeclaration('').ok).toBe(false)
    expect(checkInstrumentalDeclaration('   ').ok).toBe(false)
  })

  it('@core:studio-media 综合审计：声明与检测两道都过才放行，未知绝不放行', () => {
    const caption = buildInstrumentalCaption('warm')

    // 两道都过
    const passed = auditMusicTrack(caption, -20, -26)
    expect(passed.passed).toBe(true)
    expect(passed.reason).toContain('通过')

    // 声明缺失就拦——没有正向描述的配乐更容易被模型加进人声
    expect(auditMusicTrack('quiet music', -20, -26).passed).toBe(false)

    // 频段判有人声就拦
    expect(auditMusicTrack(caption, -20, -20.5).passed).toBe(false)

    // 测不出不放行
    const unknown = auditMusicTrack(caption, null, null)
    expect(unknown.passed).toBe(false)
    expect(unknown.reason).toContain('无法判定')

    // 声明与检测都不通过时，两条问题都要报出来（不能只报一条）
    const both = auditMusicTrack('quiet music', -20, -20.5)
    expect(both.passed).toBe(false)
    expect(both.reason).toContain('声明')
    expect(both.reason).toContain('疑似有人声')
  })
})