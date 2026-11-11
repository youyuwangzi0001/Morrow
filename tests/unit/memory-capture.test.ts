import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryService } from '../../src/main/memory'
import { parseExperienceEntries } from '../../src/main/agent'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'morrow-capture-test') },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (buffer: Buffer) => buffer.toString()
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

let dataDir = ''
let workspace = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'morrow-capture-data-'))
  workspace = mkdtempSync(join(tmpdir(), 'morrow-capture-ws-'))
  mkdirSync(join(workspace, '.morrow'), { recursive: true })
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

describe('memory-capture.test.ts', () => {
  it('@core:memory 解析经验 JSON，限制条数与长度并把绝对路径收敛为文件名', () => {
    const entries = parseExperienceEntries(
      [
        '```json',
        JSON.stringify({
          entries: [
            {
              title: '登录入口修复',
              intent: '修复登录入口',
              summary: '统一错误提示并补回归测试。',
              tags: ['登录', '测试', '登录'],
              files: ['C:\\\\repo\\\\src\\\\login.ts', 'src/auth.ts']
            },
            { title: '', summary: '缺标题应丢弃' },
            { title: '第三条', summary: '超过两条应丢弃' }
          ]
        }),
        '```'
      ].join('\n')
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].title).toBe('登录入口修复')
    expect(entries[0].files).toEqual(['login.ts', 'src/auth.ts'])
    expect(entries[0].tags).toEqual(['登录', '测试'])
  })

  it('@core:memory 语义去重能找到相似经验，不相关经验不会误判', () => {
    const memory = new MemoryService({ dataDir })
    memory.captureEpisode({
      scope: 'project',
      workspace,
      title: '登录入口修复',
      intent: '修复登录入口错误提示',
      summary: '统一错误提示并补回归测试。',
      files: ['src/login.ts'],
      sourceSessionId: 's1',
      sourceMessageId: 'episode-1'
    })
    const duplicate = memory.findEpisodeDuplicate(
      'project',
      workspace,
      '登录入口修复\n修复登录入口错误提示\n统一错误提示并补回归测试。'
    )
    expect(duplicate?.title).toBe('登录入口修复')
    expect(memory.findEpisodeDuplicate('project', workspace, '调整设置页配色和字体')).toBeNull()
  })

  it('@core:memory 非法经验输出不会写入任何条目', () => {
    expect(parseExperienceEntries('模型没有返回 JSON')).toEqual([])
    expect(parseExperienceEntries('{"entries":[{"title":"只有标题"}]}')).toEqual([])
    expect(parseExperienceEntries('```json\n{"entries":[]}\n```')).toEqual([])
  })
})
