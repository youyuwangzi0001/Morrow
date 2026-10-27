import { describe, expect, it } from 'vitest'
import { creativePromptContext, promptModuleIds, selectCreativePrompts } from '../../../src/main/studio/prompt-library'

describe('studio prompt library', () => {
  it('按任务与用户话语调取不同创作手法', () => {
    const blueprint = promptModuleIds({ kind: 'novel', task: 'blueprint', query: '一个修伞女孩继承外婆的伞铺，悬疑，克制', limit: 6 })
    expect(blueprint).toEqual(expect.arrayContaining(['story-core', 'character-matrix', 'world-rules']))

    const chapter = promptModuleIds({ kind: 'novel', task: 'chapter', query: '这一章让对话更克制，少解释，结尾留一个具体钩子', limit: 6 })
    expect(chapter).toEqual(expect.arrayContaining(['dialogue-subtext', 'prose-concrete', 'pacing-tension']))

    const storyboard = promptModuleIds({ kind: 'drama', task: 'storyboard', query: '一个雨夜追击镜头，需要低角度和连续运镜', limit: 6 })
    expect(storyboard).toEqual(expect.arrayContaining(['storyboard-cinema', 'image-prompt', 'video-motion']))

    const adaptation = promptModuleIds({ kind: 'drama', task: 'adaptation', query: '把小说第3章改成可拍的漫剧剧本', limit: 6 })
    expect(adaptation).toEqual(expect.arrayContaining(['adaptation-source', 'screenplay-format', 'story-core']))
  })

  it('返回结果受 limit 控制且不重复', () => {
    const selected = selectCreativePrompts({ kind: 'drama', task: 'image', query: '角色参考和雨向连续性', limit: 3 })
    expect(selected.length).toBeLessThanOrEqual(3)
    expect(new Set(selected.map((module) => module.id)).size).toBe(selected.length)
    expect(selected.every((module) => module.score >= 12)).toBe(true)
  })

  it('生成可直接拼接的创作手法上下文', () => {
    const context = creativePromptContext({ kind: 'drama', task: 'outline', query: '三幕结构、伏笔、情绪曲线', limit: 4 })
    expect(context).toContain('【创作手法库·按需调取】')
    expect(context).toContain('故事核')
    expect(context.split('\n').length).toBeGreaterThan(2)
  })
})
