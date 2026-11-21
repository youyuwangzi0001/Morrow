import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ dataDir: '' }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => state.dataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = Buffer.from(value).toString('utf8')
      return text.startsWith('enc:') ? text.slice(4) : text
    }
  },
  dialog: {},
  shell: {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  net: {}
}))

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'

/**
 * Command Code 的模型目录来自上游 `/provider/v1/models`。解析时若丢掉视觉能力，
 * 订阅里的 deepseek-v4.1-flash 会被当成纯文本模型，视觉审图报
 *「没有被标记为支持图片输入」；同一个模型走自定义中转站反而能审图。
 */
describe('command-code-catalog.test.ts', () => {
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'morrow-cc-catalog-'))
    state.dataDir = dir
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('@core:subscriptions 上游目录声明了图片输入，解析后要带 supportsVision', async () => {
    const { parseCommandCodeCatalog } = await import('../../src/main/subscriptions')
    const parsed = parseCommandCodeCatalog({
      data: [
        { id: 'deepseek/deepseek-v4.1-flash', input_modalities: ['text', 'image'], context_length: 1_000_000 },
        { id: 'deepseek/deepseek-v4-flash', input_modalities: ['text'], context_length: 1_000_000 },
        { id: 'text-only-model', context_length: 200_000 }
      ]
    })
    const byId = new Map(parsed.chat.map((model) => [model.id, model]))
    expect(byId.get('deepseek/deepseek-v4.1-flash')?.supportsVision).toBe(true)
    // 声明只有文本的不能凭空带上视觉
    expect(byId.get('deepseek/deepseek-v4-flash')?.supportsVision).toBeUndefined()
    // 完全没声明能力的按不支持处理
    expect(byId.get('text-only-model')?.supportsVision).toBeUndefined()
  })

  it('@core:subscriptions 上游没声明能力时，已知能看图的模型不被降级成纯文本', async () => {
    const { parseCommandCodeCatalog } = await import('../../src/main/subscriptions')
    const parsed = parseCommandCodeCatalog({
      data: [
        // 目录里没写 input_modalities，但这条 ID 在本地清单里是带视觉的
        { id: 'deepseek/deepseek-v4.1-flash', context_length: 1_000_000 },
        // 未知模型仍然按不支持处理，不能凭空给能力
        { id: 'some-unknown-visionless', context_length: 200_000 }
      ]
    })
    const byId = new Map(parsed.chat.map((model) => [model.id, model]))
    expect(byId.get('deepseek/deepseek-v4.1-flash')?.supportsVision).toBe(true)
    expect(byId.get('some-unknown-visionless')?.supportsVision).toBeUndefined()
  })

  it('@core:subscriptions 兼容多种视觉声明写法', async () => {
    const { catalogRowSupportsVision } = await import('../../src/main/subscriptions')
    expect(catalogRowSupportsVision({ supports_vision: true })).toBe(true)
    expect(catalogRowSupportsVision({ supportsVision: true })).toBe(true)
    expect(catalogRowSupportsVision({ modalities: ['text', 'image'] })).toBe(true)
    expect(catalogRowSupportsVision({ capabilities: ['Vision'] })).toBe(true)
    expect(catalogRowSupportsVision({ architecture: { input_modalities: ['text', 'image'] } })).toBe(true)
    expect(catalogRowSupportsVision({ input_modalities: ['text'] })).toBe(false)
    expect(catalogRowSupportsVision({ supports_vision: false })).toBe(false)
    expect(catalogRowSupportsVision({})).toBe(false)
  })
})
