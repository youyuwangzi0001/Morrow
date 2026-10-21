/**
 * 设置/密钥持久化边界：配置校验、加密存取、清除语义、文件权限与默认模型回退。
 * 使用临时 userData 与可控 safeStorage mock，不依赖真实 Electron。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MODEL, DEMO_MODEL, builtinProviders, defaultSettings } from '../../../src/shared/models'
import type { ProviderConfig } from '../../../src/shared/types'

const electronState = vi.hoisted(() => ({ dataDir: '', encryption: true }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? electronState.dataDir : join(electronState.dataDir, name)) },
  safeStorage: {
    isEncryptionAvailable: () => electronState.encryption,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    }
  }
}))

import { SettingsStore } from '../../../src/main/services/settings-store'

const dirs: string[] = []
const SECRET = 'sk-settings-test-secret'

function customProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'custom-test',
    kind: 'openai-compat',
    name: '测试服务',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'model-a', label: 'Model A', contextWindow: 128_000, supportsTools: true }],
    apiKeyStored: false,
    enabled: true,
    isBuiltin: false,
    category: 'custom',
    ...overrides
  }
}

function store(): SettingsStore {
  return new SettingsStore()
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'morrow-settings-'))
  dirs.push(dir)
  electronState.dataDir = dir
  electronState.encryption = true
})

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('SettingsStore：API Key 加密与清除', () => {
  it('密钥只以加密形式落盘，视图不返回明文；清除后配置标记同步', () => {
    const s = store()
    const config = customProvider()
    s.saveProvider(config, SECRET)
    const view = s.get().providers.find((provider) => provider.id === config.id)
    expect(view).toMatchObject({ apiKeyStored: true })
    expect(JSON.stringify(view)).not.toContain(SECRET)
    expect(s.getApiKey(config.id)).toBe(SECRET)

    const settingsText = readFileSync(join(electronState.dataDir, 'settings.json'), 'utf8')
    const secretsText = readFileSync(join(electronState.dataDir, 'secrets.json'), 'utf8')
    expect(settingsText).not.toContain(SECRET)
    expect(secretsText).not.toContain(SECRET)
    expect(secretsText).toContain('enc:')

    s.saveProvider(config, '')
    expect(s.getApiKey(config.id)).toBeNull()
    expect(s.get().providers.find((provider) => provider.id === config.id)?.apiKeyStored).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('settings.json / secrets.json 仅当前用户可读写', () => {
    const s = store()
    s.saveProvider(customProvider(), SECRET)
    expect(statSync(join(electronState.dataDir, 'settings.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(electronState.dataDir, 'secrets.json')).mode & 0o777).toBe(0o600)
  })

  it('加密不可用时拒绝保存密钥且不写入配置', () => {
    electronState.encryption = false
    const s = store()
    expect(() => s.saveProvider(customProvider(), SECRET)).toThrow(/加密/)
    expect(s.get().providers.some((provider) => provider.id === 'custom-test')).toBe(false)
    expect(existsSync(join(electronState.dataDir, 'secrets.json'))).toBe(false)
  })
})

describe('SettingsStore：Provider 配置校验', () => {
  it('非法 Base URL / 模型 / 请求头 / ID 被拒绝，且不覆盖已有配置与密钥', () => {
    const s = store()
    const config = customProvider()
    s.saveProvider(config, SECRET)

    for (const invalid of [
      customProvider({ baseUrl: 'file:///C:/Windows/win.ini' }),
      customProvider({ baseUrl: 'https://user:pass@example.com/v1' }),
      customProvider({ models: [{ id: 'x', label: 'x', contextWindow: 0, supportsTools: true }] }),
      customProvider({ models: [] }),
      customProvider({ headers: { 'X-Test': 'ok\r\nInjected: 1' } }),
      customProvider({ id: '__proto__' })
    ]) {
      expect(() => s.saveProvider(invalid, 'new-key')).toThrow()
    }
    const current = s.get().providers.find((provider) => provider.id === config.id)
    expect(current?.baseUrl).toBe(config.baseUrl)
    expect(s.getApiKey(config.id)).toBe(SECRET)
  })

  it('内置提供方不能改协议类型；自定义提供方不能用 demo 类型', () => {
    const s = store()
    const builtin = builtinProviders().find((provider) => provider.id === 'deepseek')!
    expect(() => s.saveProvider({ ...builtin, kind: 'anthropic' })).toThrow(/协议类型/)
    expect(() => s.saveProvider(customProvider({ kind: 'demo' }))).toThrow(/演示引擎/)
  })

  it('所有内置 Provider 预设都能通过保存校验', () => {
    const s = store()
    for (const provider of builtinProviders()) {
      expect(() => s.saveProvider(provider)).not.toThrow()
    }
  })

  it('内置 Provider 重启合并：保留同步的额外模型与同步元数据；未同步时同 ID 用最新预设', () => {
    const s = store()
    const deepseek = builtinProviders().find((provider) => provider.id === 'deepseek')!
    const syncedAt = 1_800_000_000_000
    const syncedContext = 999_000
    s.saveProvider({
      ...deepseek,
      models: [
        { ...deepseek.models[0], contextWindow: syncedContext },
        ...deepseek.models.slice(1),
        { id: 'synced-extra', label: 'Synced Extra', contextWindow: 64_000, maxOutput: 4_096, supportsTools: true }
      ],
      modelsSyncedAt: syncedAt
    })

    const openai = builtinProviders().find((provider) => provider.id === 'openai')!
    s.saveProvider({
      ...openai,
      models: [
        ...openai.models,
        { id: 'manual-extra', label: 'Manual Extra', contextWindow: 64_000, supportsTools: true }
      ]
    })

    const restarted = store()
    const mergedDeepseek = restarted.get().providers.find((provider) => provider.id === 'deepseek')!
    expect(mergedDeepseek.modelsSyncedAt).toBe(syncedAt)
    expect(mergedDeepseek.models.find((model) => model.id === deepseek.models[0].id)?.contextWindow).toBe(syncedContext)
    expect(mergedDeepseek.models.some((model) => model.id === 'synced-extra')).toBe(true)

    const mergedOpenai = restarted.get().providers.find((provider) => provider.id === 'openai')!
    expect(mergedOpenai.modelsSyncedAt).toBeUndefined()
    expect(mergedOpenai.models.find((model) => model.id === openai.models[0].id)?.contextWindow).toBe(
      openai.models[0].contextWindow
    )
    expect(mergedOpenai.models.some((model) => model.id === 'manual-extra')).toBe(true)
  })

  it('模型列表按 ID 去重，非法模型不会落盘', () => {
    const s = store()
    const config = customProvider({
      models: [
        { id: 'dup', label: 'A', contextWindow: 128_000, supportsTools: true },
        { id: 'dup', label: 'B', contextWindow: 64_000, supportsTools: true }
      ]
    })
    s.saveProvider(config)
    expect(s.get().providers.find((provider) => provider.id === config.id)?.models).toHaveLength(1)
  })
})

describe('SettingsStore：update 与默认模型', () => {
  it('合法设置生效；越界/未知字段/不存在的默认模型被拒绝', () => {
    const s = store()
    const updated = s.update({ theme: 'light', fontSize: 15, sidebarWidth: 300, compactThreshold: 0.7 })
    expect(updated).toMatchObject({ theme: 'light', fontSize: 15, sidebarWidth: 300, compactThreshold: 0.7 })

    for (const effort of ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(s.update({ reasoningEffort: effort }).reasoningEffort).toBe(effort)
    }
    expect(() => s.update({ reasoningEffort: 'ultra' as never })).toThrow()

    for (const patch of [
      { fontSize: 99 },
      { sidebarWidth: 10 },
      { permissionMode: 'god' },
      { notASetting: true },
      { defaultModel: { providerId: 'deepseek', modelId: 'not-exist' } }
    ]) {
      expect(() => s.update(patch as never)).toThrow()
    }
    expect(s.get()).toMatchObject({ theme: 'light', fontSize: 15, sidebarWidth: 300 })
  })

  it('全局回答风格可保存、校验并持久化；旧设置缺省为平衡', () => {
    const s = store()
    expect(s.get().answerStyle).toBe('balanced')
    expect(s.get().answerStyleCustom).toBe('')

    const formal = s.update({ answerStyle: 'formal' })
    expect(formal.answerStyle).toBe('formal')
    const custom = s.update({ answerStyleCustom: '  先结论\n再解释  ' })
    expect(custom.answerStyleCustom).toBe('先结论\n再解释')

    expect(() => s.update({ answerStyle: 'weird' as never })).toThrow()
    expect(() => s.update({ answerStyleCustom: 123 as never })).toThrow()
    expect(() => s.update({ answerStyleCustom: 'x'.repeat(1201) })).toThrow()

    // 重新打开设置文件仍保留选择
    const reopened = store()
    expect(reopened.get().answerStyle).toBe('formal')
    expect(reopened.get().answerStyleCustom).toBe('先结论\n再解释')

    // 旧版本文件没有这些字段：回落到平衡
    writeFileSync(join(electronState.dataDir, 'settings.json'), JSON.stringify({ version: 1, theme: 'dark' }))
    const legacy = store()
    expect(legacy.get().answerStyle).toBe('balanced')
    expect(legacy.get().answerStyleCustom).toBe('')
  })

  it('普通 update 不能注入 providers', () => {
    const s = store()
    const before = s.get().providers.map((provider) => provider.id)
    const updated = s.update({ providers: [customProvider({ id: 'injected' })] } as never)
    expect(updated.providers.map((provider) => provider.id)).toEqual(before)
  })

  it('删除当前默认模型所属的自定义 Provider 后，默认模型回退到可用模型', () => {
    const s = store()
    s.saveProvider(customProvider())
    s.update({ defaultModel: { providerId: 'custom-test', modelId: 'model-a' } })
    expect(s.get().defaultModel.providerId).toBe('custom-test')

    s.removeProvider('custom-test')
    expect(s.get().defaultModel).toEqual(DEFAULT_MODEL)
    expect(s.get().providers.some((provider) => provider.id === 'custom-test')).toBe(false)
  })

  it('更新 Provider 模型清单导致默认模型消失时回退，不留下悬空默认模型', () => {
    const s = store()
    s.saveProvider(customProvider())
    s.update({ defaultModel: { providerId: 'custom-test', modelId: 'model-a' } })
    s.saveProvider(
      customProvider({
        models: [{ id: 'model-b', label: 'B', contextWindow: 128_000, supportsTools: true }]
      })
    )
    expect(s.get().defaultModel).toEqual(DEFAULT_MODEL)
  })

  it('旧版同步模型缺少 reasoningStyle 时按协议补齐，思考强度入口不会消失', () => {
    const legacy = defaultSettings()
    legacy.providers = legacy.providers.map((provider) => {
      if (provider.id !== 'deepseek') return provider
      const model = { ...provider.models[0] }
      delete (model as { reasoningStyle?: 'effort' | 'thinking' }).reasoningStyle
      return { ...provider, modelsSyncedAt: 1_700_000_000_000, models: [model] }
    })
    legacy.providers.push(
      customProvider({
        models: [
          { id: 'model-a', label: 'Model A', contextWindow: 128_000, supportsTools: true, supportsReasoning: true }
        ]
      })
    )
    mkdirSync(electronState.dataDir, { recursive: true })
    writeFileSync(join(electronState.dataDir, 'settings.json'), JSON.stringify(legacy), 'utf8')

    const settings = store().get()
    const syncedModel = settings.providers.find((provider) => provider.id === 'deepseek')?.models[0]
    expect(syncedModel?.supportsReasoning).toBe(true)
    expect(syncedModel?.reasoningStyle).toBe('effort')
    const customModel = settings.providers.find((provider) => provider.id === 'custom-test')?.models[0]
    expect(customModel?.reasoningStyle).toBe('effort')
  })

  it('演示模型不能设为默认模型；旧设置里的演示默认值会在启动时修复', () => {
    mkdirSync(electronState.dataDir, { recursive: true })
    writeFileSync(
      join(electronState.dataDir, 'settings.json'),
      JSON.stringify({ ...defaultSettings(), defaultModel: DEMO_MODEL }),
      'utf8'
    )
    const s = store()
    expect(s.get().defaultModel).toEqual(DEFAULT_MODEL)
    expect(() => s.update({ defaultModel: DEMO_MODEL })).toThrow(/演示模型/)
    expect(s.get().defaultModel).toEqual(DEFAULT_MODEL)

    const saved = JSON.parse(readFileSync(join(electronState.dataDir, 'settings.json'), 'utf8')) as {
      defaultModel: { providerId: string }
    }
    expect(saved.defaultModel.providerId).not.toBe('demo')
  })
})

describe('SettingsStore：损坏的 secrets.json', () => {
  it('非字符串密钥条目被忽略，不影响设置加载', () => {
    mkdirSync(electronState.dataDir, { recursive: true })
    writeFileSync(
      join(electronState.dataDir, 'secrets.json'),
      JSON.stringify({ version: 1, keys: { deepseek: 123, kimi: { nested: true } } }),
      'utf8'
    )
    const s = store()
    expect(s.hasAnyApiKey()).toBe(false)
    expect(s.getApiKey('deepseek')).toBeNull()
  })
})

describe('SettingsStore：运行钩子配置', () => {
  it('钩子持久化；非法事件与空命令被拒绝', () => {
    const s = store()
    s.update({ hooks: [{ id: 'hook-1', event: 'run_finished', command: 'npm run lint', enabled: true }] })
    expect(s.get().hooks).toEqual([
      { id: 'hook-1', event: 'run_finished', command: 'npm run lint', enabled: true }
    ])
    const saved = JSON.parse(readFileSync(join(electronState.dataDir, 'settings.json'), 'utf8')) as {
      hooks: Array<{ command: string }>
    }
    expect(saved.hooks[0]?.command).toBe('npm run lint')

    expect(() =>
      s.update({ hooks: [{ id: 'hook-2', event: 'bad-event' as never, command: 'echo hi', enabled: true }] })
    ).toThrow(/事件/)
    expect(() =>
      s.update({ hooks: [{ id: 'hook-3', event: 'run_finished', command: '   ', enabled: true }] })
    ).toThrow(/命令/)
    expect(() =>
      s.update({
        hooks: [
          { id: 'hook-4', event: 'run_finished', command: 'a', enabled: true },
          { id: 'hook-4', event: 'run_finished', command: 'b', enabled: true }
        ]
      })
    ).toThrow(/重复/)
  })

  it('每个事件最多允许 5 个启用钩子，禁用项不占用名额', () => {
    const s = store()
    const six = Array.from({ length: 6 }, (_, index) => ({
      id: `cap-${index}`,
      event: 'run_finished' as const,
      command: 'echo hi',
      enabled: true
    }))
    expect(() => s.update({ hooks: six })).toThrow(/最多启用 5 个/)
    expect(() =>
      s.update({ hooks: six.map((hook, index) => ({ ...hook, enabled: index < 5 })) })
    ).not.toThrow()
    expect(s.get().hooks).toHaveLength(6)
  })
})
