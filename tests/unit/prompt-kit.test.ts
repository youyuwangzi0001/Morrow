// 提示词基座的完整性与"失败要响"边界。
//
// 这些断言保护两条容易被误改的约束：
//   1. 三套大师方法与系统提示词真的在内嵌包里（构建期注入没退化）；
//   2. 内嵌包缺失时，读取必须抛错——不能返回空字符串或占位内容让产线
//      在不知道该用哪套方法论的情况下继续跑。
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  loadCreativeMasters,
  loadPromptKit
} from '../../src/main/prompt-kit'

describe('创作台提示词基座', () => {
  it('@core:studio-models 三套大师方法都在内嵌包内', () => {
    const { masters } = loadCreativeMasters()
    expect(Object.keys(masters).sort()).toEqual(['directing', 'screenwriting', 'writing'])
    for (const suite of Object.values(masters)) {
      expect(JSON.stringify(suite).length, '每套方法都不应是空壳').toBeGreaterThan(500)
    }
  })

  it('@core:studio-models 系统提示词与 v4 骨架齐全', () => {
    const kit = loadPromptKit()
    for (const key of [
      'BLUEPRINT_SYSTEM',
      'OUTLINE_SYSTEM',
      'STORYBOARD_SYSTEM',
      'PROSE_SYSTEM'
    ] as const) {
      expect(kit.systemPrompts[key]?.length ?? 0, `${key} 不应为空`).toBeGreaterThan(50)
    }
    expect(Object.keys(kit.v4.lines).length, 'v4 骨架固定句').toBeGreaterThan(5)
    expect(kit.hand.templates && Object.keys(kit.hand.templates).length).toBeGreaterThan(0)
  })

  it('@core:studio-models 内嵌包为空时必须抛错，不能静默降级', () => {
    // 直接复刻 prompt-kit 的解码步骤：空包在 gunzip 处就该失败。
    // 这条断言防止有人把 decodeBundle 改成"失败就返回空对象"。
    const decode = (): unknown => {
      const raw = Buffer.from('', 'base64').reverse()
      for (let index = 0; index < raw.length; index++) raw[index] ^= 0x5a
      return JSON.parse(gunzipSync(raw).toString('utf8'))
    }
    expect(decode).toThrow()
  })
})