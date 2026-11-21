import { describe, expect, it } from 'vitest'
import {
  PREFERENCE_MAX_CHARS,
  activePreferences,
  checkToPreferenceCandidates,
  isDurablePreference,
  mergePreferences,
  normalizePreferenceText,
  preferencesPromptSection,
  removePreference,
  setPreferenceEnabled,
  toPreference,
  type StudioPreference
} from '../../src/shared/studio-preferences'

/**
 * 偏好沉淀：把「这一次不满意」变成「以后不再犯」。
 * 这一组测试锁定三条硬约束：只沉淀可执行的话、同类合并累加、可撤销。
 */
describe('studio-preferences.test.ts', () => {
  it('@core:studio-preferences 没有抓手的表述不进入偏好库', () => {
    expect(isDurablePreference('感觉不对')).toBe(false)
    expect(isDurablePreference('不太好')).toBe(false)
    expect(isDurablePreference('怪')).toBe(false)
    expect(isDurablePreference('   ')).toBe(false)
    // 有具体抓手的话才留下
    expect(isDurablePreference('不要再出现电动车和现代楼房的穿帮')).toBe(true)
    expect(isDurablePreference('雨夜场景里不要用过亮的固有色')).toBe(true)
  })

  it('@core:studio-preferences 口语前缀被剥掉，长短截断到上限', () => {
    expect(normalizePreferenceText('请不要再写大段内心独白')).toBe('不要再写大段内心独白')
    expect(normalizePreferenceText('麻烦   帮我   改成短句')).toBe('改成短句')
    const long = normalizePreferenceText('甲'.repeat(400))
    expect(long.length).toBe(PREFERENCE_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
  })

  it('@core:studio-preferences 同类问题合并累加，不产生重复条目', () => {
    const first = mergePreferences([], [{ text: '不要写的太满' }, { text: '分镜不要每个镜头都推' }])
    expect(first.added).toBe(2)
    expect(first.preferences).toHaveLength(2)

    // 同一个毛病第二次出现：次数 +1，条目数不变
    const second = mergePreferences(first.preferences, [{ text: '不要写的太满' }])
    expect(second.added).toBe(0)
    expect(second.reinforced).toBe(1)
    expect(second.preferences).toHaveLength(2)
    const hit = second.preferences.find((item) => item.text === '不要写的太满')
    expect(hit?.hits).toBe(2)
  })

  it('@core:studio-preferences 更详细的表述替换含糊的那条，避免越用越模糊', () => {
    const seed = mergePreferences([], [{ text: '雨戏太亮' }]).preferences
    const grown = mergePreferences(seed, [{ text: '雨戏太亮，夜景要把高光压下去，别用太阳底下的光影' }])
    expect(grown.preferences[0]?.text).toBe('雨戏太亮，夜景要把高光压下去，别用太阳底下的光影')
    expect(grown.preferences[0]?.hits).toBe(2)
  })

  it('@core:studio-preferences 只有真正变化才算 changed，空候选不会触发写入', () => {
    const seed = mergePreferences([], [{ text: '不要用旁白解释情绪' }]).preferences
    expect(mergePreferences(seed, []).changed).toBe(false)
    expect(mergePreferences(seed, [{ text: '不对' }]).changed).toBe(false)
    expect(mergePreferences(seed, [{ text: '不要用旁白解释情绪' }]).changed).toBe(true)
  })

  it('@core:studio-preferences 按形态与阶段筛选，命中多的排前面，停用的不注入', () => {
    const preferences: StudioPreference[] = [
      { id: 'a', text: '甲', key: 'a', kind: 'drama', stage: 'all', source: 'review', hits: 1, createdAt: 1, updatedAt: 1 },
      { id: 'b', text: '乙', key: 'b', kind: 'both', stage: 'all', source: 'review', hits: 5, createdAt: 1, updatedAt: 2 },
      { id: 'c', text: '丙', key: 'c', kind: 'both', stage: 'storyboard', source: 'review', hits: 9, createdAt: 1, updatedAt: 3 },
      { id: 'd', text: '丁', key: 'd', kind: 'both', stage: 'all', source: 'review', hits: 99, createdAt: 1, updatedAt: 4, enabled: false }
    ]
    // 中短篇 + 写作阶段：drama 专属与 storyboard 阶段都不该出现，停用的也不出现
    expect(activePreferences(preferences, 'novel', 'writing').map((item) => item.id)).toEqual(['b'])
    // 漫剧 + 分镜：命中 5 的 all 排在命中 9 的 storyboard 之前，因为它们都适用且按 hits 排序
    expect(activePreferences(preferences, 'drama', 'storyboard').map((item) => item.id)).toEqual(['c', 'b', 'a'])
  })

  it('@core:studio-preferences 注入段落只列规则，且受条数上限约束', () => {
    const many: StudioPreference[] = Array.from({ length: 12 }, (_, index) => ({
      id: `p${index}`,
      text: `规则${index}`,
      key: `p${index}`,
      kind: 'both' as const,
      stage: 'all' as const,
      source: 'review' as const,
      hits: 12 - index,
      createdAt: 1,
      updatedAt: 1
    }))
    const section = preferencesPromptSection(many, 'novel', 'writing', 3)
    expect(section.split('\n')).toHaveLength(4)
    expect(section).toContain('规则0')
    expect(section).not.toContain('规则3')
    expect(preferencesPromptSection([], 'novel', 'writing')).toBe('')
  })

  it('@core:studio-preferences 偏好可单条删除与停用', () => {
    const seed = mergePreferences([], [{ text: '不要用第一人称' }, { text: '结尾不要强行升华' }]).preferences
    expect(removePreference(seed, seed[0]!.id)).toHaveLength(1)
    expect(removePreference(seed, 'missing')).toHaveLength(2)
    const disabled = setPreferenceEnabled(seed, seed[0]!.id, false)
    expect(disabled[0]?.enabled).toBe(false)
    expect(activePreferences(disabled, 'novel', 'writing')).toHaveLength(1)
  })

  it('@core:studio-preferences 生成器不会写入空壳偏好', () => {
    expect(toPreference({ text: '感觉不对' })).toBeNull()
    const created = toPreference({ text: '不要再出现现代楼房', kind: 'drama', stage: 'image', projectId: 'p1' }, 123)
    expect(created).toMatchObject({ kind: 'drama', stage: 'image', hits: 1, lastProjectId: 'p1', createdAt: 123 })
  })

  it('@core:studio-preferences 审核结论只沉淀会重复发生的做法问题', () => {
    const checks = [
      { kind: 'continuity', level: 'error', title: '镜 03 与镜 07 人物服装不一致', detail: '镜 03 是校服' },
      { kind: 'missing', level: 'error', title: '缺第 12 镜画面', detail: '尚未出图' },
      { kind: 'price', level: 'warn', title: '预算已用 92%', detail: '余额不足' },
      { kind: 'quality', level: 'info', title: '可以对白再收紧一点', detail: '' },
      { kind: 'subtitle', level: 'warn', title: '字幕单行超过 20 字', detail: '第 4 镜' }
    ]
    const candidates = checkToPreferenceCandidates(checks, 'drama', 'p1')
    // missing / price 是这一次的状态，info 不是用户的不满，都不该进偏好库
    expect(candidates.map((item) => item.text)).toEqual([
      '镜 03 与镜 07 人物服装不一致',
      '字幕单行超过 20 字'
    ])
    expect(candidates.every((item) => item.source === 'review' && item.kind === 'drama')).toBe(true)
  })
})
