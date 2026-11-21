import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ dataDir: '' }))

/**
 * 「订阅模型的自定义设置不生效」的最小复现：
 * 用户改过的最大输出 / 上下文档位，在订阅恢复（用上游目录重写 Provider）后是否还在。
 */
describe('subscription-model-override.test.ts', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'morrow-override-'))
  state.dataDir = dataDir

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

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('@core:subscriptions 用户改过的最大输出与上下文档位，在订阅恢复后仍然保留', async () => {
    const { SettingsStore, getSettingsStore } = await import('../../src/main/settings')
    const { setProviderModelContext, setProviderModelOutput } = await import('../../src/main/subscriptions')

    const providerId = 'command-code-subscription'
    const catalog = () => [
      { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', contextWindow: 872_000, maxOutput: 128_000, supportsTools: true, supportsReasoning: true },
      { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', contextWindow: 1_048_576, maxOutput: 32_768, supportsTools: true }
    ]
    const save = (): void => {
      getSettingsStore().saveProvider({
        id: providerId,
        kind: 'openai-compat',
        name: 'Command Code（订阅）',
        baseUrl: 'http://127.0.0.1:1234/v1',
        models: catalog(),
        category: 'custom',
        managedBySubscription: true,
        apiKeyStored: true,
        enabled: true
      }, 'token')
    }

    new SettingsStore()
    save()
    setProviderModelOutput(providerId, 'gpt-6.2-astra', 32_768)
    setProviderModelContext(providerId, 'gpt-6.2-astra', 200_000)

    const read = () => {
      const provider = getSettingsStore().get().providers.find((item) => item.id === providerId)
      return provider?.models.find((item) => item.id === 'gpt-6.2-astra')
    }
    expect(read()?.maxOutput).toBe(32_768)
    expect(read()?.defaultContextWindow).toBe(200_000)

    // 订阅恢复：用同一份上游目录重写
    save()

    expect(read()?.maxOutput).toBe(32_768)
    expect(read()?.maxOutputEdited).toBe(true)
    expect(read()?.defaultContextWindow).toBe(200_000)
    expect(read()?.contextEdited).toBe(true)
  })

  it('@core:subscriptions 设置页读到的模型要带上用户改过的档位，否则下拉框永远显示默认值', async () => {
    const { getSettingsStore } = await import('../../src/main/settings')
    const { setProviderModelContext, setProviderModelOutput } = await import('../../src/main/subscriptions')

    const providerId = 'command-code-subscription'
    const catalog = () => [
      { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', contextWindow: 872_000, maxOutput: 128_000, supportsTools: true, supportsReasoning: true },
      { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', contextWindow: 1_048_576, maxOutput: 32_768, supportsTools: true }
    ]
    getSettingsStore().saveProvider({
      id: providerId,
      kind: 'openai-compat',
      name: 'Command Code（订阅）',
      baseUrl: 'http://127.0.0.1:1234/v1',
      models: catalog(),
      category: 'custom',
      managedBySubscription: true,
      apiKeyStored: true,
      enabled: true
    }, 'token')

    setProviderModelOutput(providerId, 'gpt-6.2-astra', 32_768)
    setProviderModelContext(providerId, 'gpt-6.2-astra', 200_000)

    // 设置页的数据来源：订阅 status 里的 models，必须反映用户改动
    const { withProviderModelOverrides } = await import('../../src/main/subscriptions')
    const merged = withProviderModelOverrides(providerId, catalog() as import('../../src/shared/types').ModelInfo[])
    const astra = merged.find((model) => model.id === 'gpt-6.2-astra')
    expect(astra?.maxOutput).toBe(32_768)
    expect(astra?.defaultContextWindow).toBe(200_000)
  })
})
