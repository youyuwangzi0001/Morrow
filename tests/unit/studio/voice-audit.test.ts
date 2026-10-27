import { describe, expect, it } from 'vitest'
import { auditCharacterVoices, extractChapterDialogue } from '../../../src/main/studio/voice-audit'
import { makeNovelProject, tempStore } from './fixtures'
import { rmSync } from 'node:fs'

describe('人物语气审稿', () => {
  it('提取“谁说 + 说了什么”，忽略没有明确归属的引号', () => {
    const lines = extractChapterDialogue('林晚说：“今天不修伞。”\n“明天再来吧，”老周笑道。\n“没有人知道。”', 'ch1')
    expect(lines.map((line) => line.speaker)).toEqual(['林晚', '老周'])
    expect(lines[0].text).toBe('今天不修伞。')
  })

  it('统计句长、问句与高频用语，并对语气趋同给出提醒', () => {
    const { store, dir } = tempStore()
    try {
      const project = makeNovelProject(store)
      project.characters = [
        { id: 'c1', name: '林晚', role: '主角', look: '', relationships: [], refAssetIds: [] },
        { id: 'c2', name: '老周', role: '配角', look: '', relationships: [], refAssetIds: [] }
      ]
      project.chapters[0].content = [
        '林晚说：“你说这把伞能倒着走时间？”',
        '林晚说：“你确定吗？你看见过吗？”',
        '林晚说：“你为什么不早说？”',
        '林晚说：“你到底是谁？”',
        '林晚说：“你能不能别卖关子？”',
        '老周说：“你确定吗？你看见过吗？”',
        '老周说：“你为什么不早说？”',
        '老周说：“你到底是谁？”',
        '老周说：“你能不能别卖关子？”',
        '老周说：“你说这把伞能倒着走时间？”'
      ].join('\n')
      const { audit, checks } = auditCharacterVoices(project)
      expect(audit.profiles.find((profile) => profile.name === '林晚')?.lineCount).toBe(5)
      expect(audit.profiles.find((profile) => profile.name === '老周')?.questionRatio).toBeGreaterThan(0.5)
      expect(audit.warnings.some((warning) => warning.title.includes('语气可能趋同'))).toBe(true)
      expect(checks.some((check) => check.kind === 'voice' && check.level === 'warn')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
