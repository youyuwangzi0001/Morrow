import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  shell: { showItemInFolder: vi.fn() }
}))

import { explorerSelectArgs } from '../../../src/main/services/reveal'

describe('reveal in file manager', () => {
  it('passes /select, and the path as separate arguments so spaces and Chinese survive', () => {
    // 合成一个参数（/select,C:\a b\c.txt）时 explorer 会打开「文档」而不是目标文件。
    const path = 'C:\\交付成品\\Morrow 工作区\\报告 1.html'
    expect(explorerSelectArgs(path)).toEqual(['/select,', path])
  })
})
