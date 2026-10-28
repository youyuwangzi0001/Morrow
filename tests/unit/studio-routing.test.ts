import { describe, expect, it, vi } from 'vitest'
import type { ModelInfo, ProviderConfig } from '../../src/shared/types'
import { rankTextCandidates } from '../../src/main/studio'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP ?? 'C:/Windows/Temp', getVersion: () => '0.2.0', isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

const model = (id: string): ModelInfo => ({ id, label: id, contextWindow: 128_000, supportsTools: true })
const provider = (id: string, baseUrl: string): ProviderConfig => ({
  id,
  kind: 'openai-compat',
  name: id,
  baseUrl,
  models: [model(`${id}-model`)],
  apiKeyStored: true,
  enabled: true
})

const providers = [
  provider('local', 'http://127.0.0.1:11434/v1'),
  provider('cloud', 'https://api.example.com/v1')
]
const defaultModel = { providerId: 'cloud', modelId: 'cloud-model' }

describe('文本路由', () => {
  it('本地优先选择已配置的本机模型', () => {
    const ranked = rankTextCandidates({ providers, defaultModel }, () => 'key', 'local-first')
    expect(ranked[0].config.id).toBe('local')
    expect(ranked[0].local).toBe(true)
  })

  it('云端优先选择已配置的云端模型', () => {
    const ranked = rankTextCandidates({ providers, defaultModel }, () => 'key', 'cloud-first')
    expect(ranked[0].config.id).toBe('cloud')
    expect(ranked[0].local).toBe(false)
  })

  it('只本地与只云端严格过滤', () => {
    expect(rankTextCandidates({ providers, defaultModel }, () => 'key', 'local-only').every((item) => item.local)).toBe(true)
    expect(rankTextCandidates({ providers, defaultModel }, () => 'key', 'cloud-only').every((item) => !item.local)).toBe(true)
  })

  it('缺 Key 的云端路由仍可见，但排在可用路由之后', () => {
    const ranked = rankTextCandidates(
      { providers, defaultModel },
      (providerId) => providerId === 'local' ? 'local-key' : null,
      'cloud-first'
    )
    expect(ranked[0].config.id).toBe('local')
    expect(ranked.find((item) => item.config.id === 'cloud')?.apiKey).toBeNull()
  })
})
