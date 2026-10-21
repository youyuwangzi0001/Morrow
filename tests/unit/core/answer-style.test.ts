import { describe, expect, it } from 'vitest'
import {
  ANSWER_STYLE_MAX_CUSTOM,
  ANSWER_STYLES,
  answerStyleLabel,
  buildAnswerStyleSection,
  isAnswerStyleId,
  normalizeAnswerStyle,
  normalizeAnswerStyleCustom
} from '../../../src/shared/answer-style'
import { buildSystemPrompt } from '../../../src/core/prompt'

describe('全局回答风格', () => {
  it('风格 id 归一化：未知或缺失回落到平衡', () => {
    for (const style of ANSWER_STYLES) expect(isAnswerStyleId(style.id)).toBe(true)
    expect(isAnswerStyleId('weird')).toBe(false)
    expect(normalizeAnswerStyle('weird')).toBe('balanced')
    expect(normalizeAnswerStyle(undefined)).toBe('balanced')
    expect(normalizeAnswerStyle('formal')).toBe('formal')
    expect(answerStyleLabel('custom')).toBe('自定义')
  })

  it('自定义偏好保留换行、去掉首尾空白并限长', () => {
    expect(normalizeAnswerStyleCustom('  先结论\n\n再解释  ')).toBe('先结论\n\n再解释')
    expect(normalizeAnswerStyleCustom('x'.repeat(ANSWER_STYLE_MAX_CUSTOM + 20))).toHaveLength(
      ANSWER_STYLE_MAX_CUSTOM
    )
    expect(normalizeAnswerStyleCustom(123)).toBe('')
  })

  it('每种预设都带自己的规则，并明确不覆盖安全与任务要求', () => {
    const full = ANSWER_STYLES.map((style) => buildAnswerStyleSection(style.id, '')).join('\n')
    expect(full).toContain('1–3 句')
    expect(full).toContain('补充关键原理')
    expect(full).toContain('专业、客观、完整的书面语')
    for (const style of ANSWER_STYLES.filter((item) => item.id !== 'custom')) {
      const section = buildAnswerStyleSection(style.id, '')
      expect(section).toContain('不改变工具使用、权限、安全边界')
      expect(section).toContain(`当前风格：${style.label}`)
      expect(section).toContain(style.prompt)
    }
  })

  it('自定义风格使用用户文本；为空时回落到平衡规则', () => {
    const section = buildAnswerStyleSection('custom', '像同事讲方案：先结论，再给两条依据。')
    expect(section).toContain('当前风格：自定义')
    expect(section).toContain('像同事讲方案：先结论，再给两条依据。')

    const empty = buildAnswerStyleSection('custom', '   ')
    expect(empty).toContain('用户还没有写下自定义偏好')
    expect(empty).toContain('先给结论')
    expect(empty).not.toContain('像同事讲方案')
  })

  it('系统提示词接入全局风格，只出现当前选择的规则', () => {
    const concise = buildSystemPrompt({ answerStyle: 'concise' })
    expect(concise).toContain('## 回答风格（全局偏好）')
    expect(concise).toContain('当前风格：简洁')
    expect(concise).toContain('1–3 句')
    expect(concise).not.toContain('当前风格：讲解')

    const custom = buildSystemPrompt({
      answerStyle: 'custom',
      answerStyleCustom: '每段不超过三句，先给风险。'
    })
    expect(custom).toContain('当前风格：自定义')
    expect(custom).toContain('每段不超过三句，先给风险。')

    const fallback = buildSystemPrompt({})
    expect(fallback).toContain('当前风格：平衡')
  })
})
