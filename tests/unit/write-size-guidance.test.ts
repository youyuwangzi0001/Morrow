import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeTool, TOOL_DEFINITIONS } from '../../src/core/tools'
import { makeTempWorkspace } from './helpers'
import { makeToolContext } from './helpers'

/**
 * 写长文件的引导语。
 *
 * 4KB / 100 行分段是断流还没修好时的权宜之计：那时参数流被切断会让整段内容作废，
 * 所以只好要求模型少量多次。断流修好后它成了纯负担 —— 复杂逻辑不可能拆进 4KB，
 * 硬拆成十几次调用反而更容易出错、更难一次改对。
 */
describe('write-size-guidance.test.ts', () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'write_file')

  it('@core:tools 工具说明不再要求 4KB / 100 行分段', () => {
    expect(definition).toBeTruthy()
    const description = definition?.description ?? ''
    expect(description).not.toContain('4KB')
    expect(description).not.toContain('100 行')
    expect(description).not.toContain('必须分段')
  })

  it('@core:tools 工具说明鼓励一次写完整，并保留 append 退路', () => {
    const description = definition?.description ?? ''
    expect(description).toContain('一次写完整文件')
    expect(description).toContain('append=true')
  })

  it('@core:tools 一次写完十几 KB 的模块不产生分段提醒', async () => {
    const ws = makeTempWorkspace()
    try {
      // 约 12KB 的实现代码：远超旧的 4KB 阈值，但属于正常的一次性写入
      const content = Array.from(
        { length: 240 },
        (_, index) => `export function step${index}(value: number): number { return value * ${index + 1} }`
      ).join('\n')
      expect(content.length).toBeGreaterThan(8_000)
      const result = await executeTool('write_file', { path: 'logic.ts', content }, makeToolContext(ws))
      expect(result.ok).toBe(true)
      expect(readFileSync(join(ws.root, 'logic.ts'), 'utf8')).toBe(content)
      expect(String(result.output ?? '')).not.toContain('已经很大了')
    } finally {
      ws.cleanup()
    }
  })

  it('@core:tools 真正超大的写入仍提示可以用 append 续写', async () => {
    const ws = makeTempWorkspace()
    try {
      const content = 'x'.repeat(60 * 1024)
      const result = await executeTool('write_file', { path: 'huge.txt', content }, makeToolContext(ws))
      expect(result.ok).toBe(true)
      expect(String(result.output ?? '')).toContain('已经很大了')
      expect(String(result.output ?? '')).toContain('append=true')
    } finally {
      ws.cleanup()
    }
  })
})
