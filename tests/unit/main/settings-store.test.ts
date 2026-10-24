/**
 * 合并后的 settings-store 组：设置/密钥、数据目录、会话存储、运行钩子、产物读取/搜索、PDF OCR。
 * 每个原文件各自包在 describe('<原文件名>') 中，钩子与临时目录互不污染。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_MODEL, DEMO_MODEL, builtinProviders, defaultSettings } from '../../../src/shared/models'
import { type ProviderConfig, type ChatMessage, type ResearchState } from '../../../src/shared/types'
import { SettingsStore, getSettingsStore } from '../../../src/main/services/settings-store'
import { isNestedPath, readDataLocation, removeDataLocation, resetResolveDataDirCacheForTests, resolveDataDir, samePath, writeDataLocation } from '../../../src/main/services/paths'
import { cleanTargetDataDir, copyUserDataForMigration } from '../../../src/main/services/paths'
import { SessionStore } from '../../../src/main/services/session-store'
import { runHooks, runPromptHooks } from '../../../src/main/services/hooks'
import { readTextSafe, searchWorkspaceFiles } from '../../../src/main/services/workspace'
import { createPdfOcrHandler, normalizeOcrText } from '../../../src/main/services/pdf-ocr'

const electronState = vi.hoisted(() => ({
  dataDir: '',
  appData: '',
  appPath: process.cwd(),
  encryption: true
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => electronState.appPath,
    getPath: (name: string) =>
      name === 'userData'
        ? electronState.dataDir
        : name === 'appData'
          ? electronState.appData
          : join(electronState.dataDir, name)
  },
  safeStorage: {
    isEncryptionAvailable: () => electronState.encryption,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    }
  },
  dialog: {},
  shell: {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

describe('settings-store.test.ts', () => {
/**
 * 设置/密钥持久化边界：配置校验、加密存取、清除语义、文件权限与默认模型回退。
 * 使用临时 userData 与可控 safeStorage mock，不依赖真实 Electron。
 */






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

  it('旧设置里已下线的 Grok 4.1 与 OpenRouter 不会复活', () => {
    const s = store()
    const xai = builtinProviders().find((provider) => provider.id === 'xai')!
    s.saveProvider({
      ...xai,
      models: [
        ...xai.models,
        {
          id: 'grok-4.1-fast',
          label: 'Grok 4.1 Fast',
          contextWindow: 2_000_000,
          maxOutput: 65_536,
          supportsTools: true,
          supportsReasoning: true
        }
      ]
    })

    const file = join(electronState.dataDir, 'settings.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { providers: ProviderConfig[] }
    raw.providers.push({
      id: 'openrouter',
      kind: 'openai-compat',
      name: 'OpenRouter（模型聚合）',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [{ id: 'x-ai/grok-4.7', label: 'Grok 4.7（OpenRouter）', contextWindow: 500_000, supportsTools: true }],
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'custom'
    })
    writeFileSync(file, JSON.stringify(raw))

    const restarted = store()
    const providers = restarted.get().providers
    expect(providers.some((provider) => provider.id === 'openrouter')).toBe(false)
    const mergedXai = providers.find((provider) => provider.id === 'xai')!
    expect(mergedXai.models.map((model) => model.id)).toContain('grok-4.6')
    expect(mergedXai.models.map((model) => model.id)).not.toContain('grok-4.1-fast')

    // 合并结果立即写回磁盘，旧条目不再留在设置文件里
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { providers: ProviderConfig[] }
    expect(persisted.providers.some((provider) => provider.id === 'openrouter')).toBe(false)
    expect(persisted.providers.find((provider) => provider.id === 'xai')!.models.map((model) => model.id)).not.toContain(
      'grok-4.1-fast'
    )
  })

  it('旧 Kimi 模型在启动合并时移除，并保持 K3.1 Pro / K3 / K2.8 的顺序', () => {
    const s = store()
    const kimi = builtinProviders().find((provider) => provider.id === 'kimi')!
    s.saveProvider({
      ...kimi,
      models: [
        { id: 'kimi-k2.6', label: 'Kimi K2.6', contextWindow: 262_144, supportsTools: true },
        ...kimi.models,
        { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', contextWindow: 262_144, supportsTools: true }
      ]
    })

    const restarted = store()
    const merged = restarted.get().providers.find((provider) => provider.id === 'kimi')!
    expect(merged.models.map((model) => model.id)).toEqual(['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.8-preview'])

    const persisted = JSON.parse(readFileSync(join(electronState.dataDir, 'settings.json'), 'utf8')) as {
      providers: ProviderConfig[]
    }
    expect(persisted.providers.find((provider) => provider.id === 'kimi')!.models.map((model) => model.id)).toEqual([
      'kimi-k3.1-pro',
      'kimi-k3',
      'kimi-k2.8-preview'
    ])
  })

  it('旧版未配置外部搜索的用户自动启用内置搜索；显式关闭 builtin 保持关闭', () => {
    store()
    const file = join(electronState.dataDir, 'settings.json')
    const raw = { ...defaultSettings(), webSearch: { enabled: false, provider: 'tavily', apiKeyStored: false, maxResults: 5 } } as Record<string, any>
    writeFileSync(file, JSON.stringify(raw))
    const migrated = store().get().webSearch
    expect(migrated).toMatchObject({ enabled: true, provider: 'builtin' })

    raw.webSearch = { enabled: false, provider: 'builtin', apiKeyStored: false, maxResults: 5 }
    writeFileSync(file, JSON.stringify(raw))
    expect(store().get().webSearch).toMatchObject({ enabled: false, provider: 'builtin' })
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
    const initial = s.get()
    expect(initial.fontSize).toBe(14)
    expect(initial.codeFontSize).toBe(12)
    expect(initial.codeFont).toBe('jetbrains')
    const updated = s.update({ theme: 'light', fontSize: 15, sidebarWidth: 300, compactThreshold: 0.7 })
    expect(updated).toMatchObject({ theme: 'light', fontSize: 15, sidebarWidth: 300, compactThreshold: 0.7 })
    expect(s.get().runningSendMode).toBe('queue')
    expect(s.update({ codeFontSize: 11 }).codeFontSize).toBe(11)
    expect(s.update({ codeFontSize: 14 }).codeFontSize).toBe(14)
    expect(() => s.update({ codeFontSize: 10 })).toThrow()
    expect(() => s.update({ codeFontSize: 15 })).toThrow()
    expect(() => s.update({ codeFontSize: 9 })).toThrow()
    expect(s.update({ fontSize: 12 }).fontSize).toBe(12)
    expect(s.update({ fontSize: 15 }).fontSize).toBe(15)
    expect(() => s.update({ fontSize: 11 })).toThrow()
    expect(() => s.update({ fontSize: 16 })).toThrow()

    // 旧版本允许更大范围，升级载入时夹进当前区间，避免设置页没有选中项。
    writeFileSync(
      join(electronState.dataDir, 'settings.json'),
      JSON.stringify({ ...defaultSettings(), fontSize: 20, codeFontSize: 20, codeFont: 'anthropic' }),
      'utf8'
    )
    expect(store().get().fontSize).toBe(15)
    expect(store().get().codeFontSize).toBe(14)
    // Anthropic Mono 已停止提供；旧配置回落到默认字体，也不能再写入。
    expect(store().get().codeFont).toBe('jetbrains')
    expect(() => s.update({ codeFont: 'anthropic' as never })).toThrow()
    expect(s.update({ runningSendMode: 'steer' }).runningSendMode).toBe('steer')
    expect(() => s.update({ runningSendMode: 'bad' as never })).toThrow()
    expect(s.update({ evolutionEnabled: false }).evolutionEnabled).toBe(false)
    expect(s.update({ evolutionEnabled: true }).evolutionEnabled).toBe(true)

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
})

describe('data-dir.test.ts', () => {
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'morrow-data-dir-'))
  electronState.appData = join(root, 'appdata')
  mkdirSync(electronState.appData, { recursive: true })
  delete process.env.PORTABLE_EXECUTABLE_DIR
  delete process.env.MORROW_DATA_LOCATION_FILE
  resetResolveDataDirCacheForTests()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.PORTABLE_EXECUTABLE_DIR
  delete process.env.MORROW_DATA_LOCATION_FILE
  resetResolveDataDirCacheForTests()
})

describe('data directory pointer', () => {
  it('writes, reads and removes an absolute custom directory', () => {
    const pointer = join(root, 'location.json')
    const target = join(root, 'custom-data')
    writeDataLocation(target, pointer)
    expect(readDataLocation(pointer)).toBe(resolve(target))
    expect(JSON.parse(readFileSync(pointer, 'utf8')).dataDir).toBe(resolve(target))
    removeDataLocation(pointer)
    expect(readDataLocation(pointer)).toBeNull()
  })

  it('ignores malformed and relative pointers', () => {
    const pointer = join(root, 'location.json')
    writeFileSync(pointer, '{not json', 'utf8')
    expect(readDataLocation(pointer)).toBeNull()
    writeFileSync(pointer, JSON.stringify({ dataDir: 'relative/path' }), 'utf8')
    expect(readDataLocation(pointer)).toBeNull()
  })

  it('prefers --data-dir, then a custom pointer, then the default directory', () => {
    const pointer = join(root, 'location.json')
    const custom = join(root, 'custom')
    const argDir = join(root, 'arg-data')
    process.env.MORROW_DATA_LOCATION_FILE = pointer
    writeDataLocation(custom, pointer)

    process.argv.push(`--data-dir=${argDir}`)
    try {
      resetResolveDataDirCacheForTests()
      expect(resolveDataDir()).toBe(resolve(argDir))
    } finally {
      const index = process.argv.findIndex((value) => value.startsWith('--data-dir='))
      if (index >= 0) process.argv.splice(index, 1)
    }

    resetResolveDataDirCacheForTests()
    expect(resolveDataDir()).toBe(resolve(custom))
    removeDataLocation(pointer)
    resetResolveDataDirCacheForTests()
    expect(resolveDataDir()).toBe(join(electronState.appData, 'Morrow'))
  })
})

describe('data directory migration', () => {
  it('copies user data and skips caches, logs and browser transient state', () => {
    const source = join(root, 'source')
    const target = join(root, 'target')
    mkdirSync(join(source, 'sessions'), { recursive: true })
    mkdirSync(join(source, 'attachments'), { recursive: true })
    mkdirSync(join(source, 'providers'), { recursive: true })
    mkdirSync(join(source, 'Cache'), { recursive: true })
    mkdirSync(join(source, 'logs'), { recursive: true })
    mkdirSync(join(source, 'Network'), { recursive: true })
    writeFileSync(join(source, 'settings.json'), '{"theme":"dark"}', 'utf8')
    writeFileSync(join(source, 'sessions', 'one.json'), '{"id":"one"}', 'utf8')
    writeFileSync(join(source, 'attachments', 'a.txt'), 'hello', 'utf8')
    writeFileSync(join(source, 'providers', 'p.json'), '[]', 'utf8')
    writeFileSync(join(source, 'Cache', 'cache.bin'), 'x', 'utf8')
    writeFileSync(join(source, 'logs', 'main.log'), 'x', 'utf8')
    writeFileSync(join(source, 'Network', 'Cookies'), 'x', 'utf8')

    const copied = copyUserDataForMigration(source, target)
    expect(copied).toBe(4)
    expect(existsSync(join(target, 'settings.json'))).toBe(true)
    expect(existsSync(join(target, 'sessions', 'one.json'))).toBe(true)
    expect(existsSync(join(target, 'attachments', 'a.txt'))).toBe(true)
    expect(existsSync(join(target, 'providers', 'p.json'))).toBe(true)
    expect(existsSync(join(target, 'Cache'))).toBe(false)
    expect(existsSync(join(target, 'logs'))).toBe(false)
    expect(existsSync(join(target, 'Network'))).toBe(false)

    cleanTargetDataDir(target)
    expect(existsSync(join(target, 'settings.json'))).toBe(false)
  })

  it('detects same and nested paths', () => {
    const base = join(root, 'base')
    expect(samePath(base, join(base, '..', 'base'))).toBe(true)
    expect(isNestedPath(base, join(base, 'child'))).toBe(true)
    expect(isNestedPath(join(base, 'child'), base)).toBe(false)
    expect(isNestedPath(base, join(root, 'sibling'))).toBe(false)
  })
})
})

describe('session-store.test.ts', () => {
const MODEL = { providerId: 'demo', modelId: 'demo-model' }
let root = ''
let store: SessionStore

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'morrow-session-store-test-'))
  store = new SessionStore(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function createSession(mode: 'chat' | 'work' | 'research' = 'work') {
  return store.create({
    workspace: 'C:\\workspace',
    mode,
    defaultModel: MODEL,
    defaultPermission: 'ask'
  })
}

describe('SessionStore 持久化', () => {
  it('创建时持久化显式模式，元数据也带回 mode', () => {
    const session = createSession('chat')
    expect(session.mode).toBe('chat')
    const loaded = store.get(session.id)
    expect(loaded?.mode).toBe('chat')
    expect(loaded?.workspace).toBe('C:\\workspace')

    const meta = store.list().find((item) => item.id === session.id)
    expect(meta?.mode).toBe('chat')
    expect(meta?.messageCount).toBe(0)
  })

  it('首次消息自动命名默认标题，临时对话也生效，手动改名不被覆盖', () => {
    const normal = createSession()
    store.autoName(normal, '帮我整理季度销售数据')
    expect(normal.title).toBe('帮我整理季度销售数据')

    const temporary = store.create({
      workspace: 'C:\workspace',
      temporary: true,
      defaultModel: MODEL,
      defaultPermission: 'ask'
    })
    expect(temporary.title).toBe('临时对话')
    store.autoName(temporary, '分析这段日志里的异常订单')
    expect(temporary.title).toBe('分析这段日志里的异常订单')

    const manual = createSession()
    store.rename(manual.id, '我自己起的名字')
    const reloaded = store.get(manual.id)!
    store.autoName(reloaded, '这条消息不应覆盖手动标题')
    expect(reloaded.title).toBe('我自己起的名字')

    const long = createSession()
    store.autoName(long, 'x'.repeat(50))
    expect(long.title.endsWith('…')).toBe(true)
    expect(long.title.length).toBe(27)
  })

  it('重命名与 UI 一致，最多 80 个字符', () => {
    const session = createSession()
    const meta = store.rename(session.id, 'x'.repeat(100))
    expect(meta?.title.length).toBe(80)
    expect(store.get(session.id)?.title.length).toBe(80)
  })

  it('归档状态写入会话文件，重启后仍可恢复', () => {
    const session = createSession()
    expect(store.setArchived(session.id, true)?.archived).toBe(true)

    const restarted = new SessionStore(root)
    expect(restarted.list().find((item) => item.id === session.id)?.archived).toBe(true)
    expect(restarted.setArchived(session.id, false)?.archived).toBeFalsy()
    expect(new SessionStore(root).list().find((item) => item.id === session.id)?.archived).toBeFalsy()
  })

  it('深度研究计划状态（planning/ready + plan）可持久化，不会被读盘过滤', () => {
    const session = createSession('research')
    const research: ResearchState = {
      topic: '研究计划持久化',
      depth: 'quick',
      status: 'ready',
      round: 1,
      maxRounds: 2,
      minSources: 4,
      sourceCount: 0,
      startedAt: 1,
      updatedAt: 2,
      plan: '# 研究计划\n## 子问题\n1. 持久化',
      steer: '只看官方来源'
    }
    session.research = research
    store.save(session)
    expect(store.get(session.id)?.research).toMatchObject({
      status: 'ready',
      plan: '# 研究计划\n## 子问题\n1. 持久化',
      steer: '只看官方来源'
    })
    const planning = { ...research, status: 'planning' as const }
    session.research = planning
    store.save(session)
    expect(store.get(session.id)?.research?.status).toBe('planning')
  })

  it('研究状态在回到工作模式后仍可持久化', () => {
    const session = createSession('work')
    session.research = {
      topic: '完成后回到工作',
      depth: 'quick',
      status: 'completed',
      round: 2,
      maxRounds: 2,
      minSources: 4,
      sourceCount: 4,
      startedAt: 1,
      updatedAt: 2,
      artifactId: 'artifact_report'
    }
    store.save(session)
    const loaded = store.get(session.id)
    expect(loaded?.mode).toBe('work')
    expect(loaded?.research).toMatchObject({ status: 'completed', topic: '完成后回到工作', sourceCount: 4 })
  })

  it('半损坏会话补齐数组/默认值，仍可加载', () => {
    const id = 's_partial1'
    writeFileSync(
      join(root, 'sessions', `${id}.json`),
      JSON.stringify({ id, title: 123, messages: 'bad', usage: 'bad', permissionMode: 'invalid' })
    )
    const session = store.get(id)
    expect(session).not.toBeNull()
    expect(session?.title).toBe('新对话')
    expect(session?.messages).toEqual([])
    expect(session?.todos).toEqual([])
    expect(session?.artifacts).toEqual([])
    expect(session?.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(session?.permissionMode).toBe('ask')
    expect(session?.mode).toBeUndefined()
    expect(session?.messageCount).toBe(0)
  })

  it('损坏 JSON 与文件名/id 不匹配时跳过，不误加载其他会话', () => {
    writeFileSync(join(root, 'sessions', 's_broken1.json'), '{not-json')
    writeFileSync(join(root, 'sessions', 's_mismatch1.json'), JSON.stringify({ id: 's_other1', messages: [] }))
    expect(store.get('s_broken1')).toBeNull()
    expect(store.get('s_mismatch1')).toBeNull()
    expect(store.list().some((meta) => meta.id === 's_broken1' || meta.id === 's_mismatch1')).toBe(false)
  })

  it('list 保留 300 条侧栏上限，listAll 供历史回填读取全部', () => {
    const dir = mkdtempSync(join(tmpdir(), 'morrow-session-bulk-'))
    const local = new SessionStore(dir)
    try {
      for (let index = 0; index < 305; index += 1) {
        const id = `s_bulk${index}`
        writeFileSync(
          join(dir, 'sessions', `${id}.json`),
          JSON.stringify({ id, updatedAt: 1_000 + index, messages: [] }),
          'utf8'
        )
      }
      expect(local.list()).toHaveLength(300)
      expect(local.listAll()).toHaveLength(305)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applyRunResult 按消息 id 更新而不是重复追加', () => {
    const session = createSession()
    const first: ChatMessage = {
      id: 'msg_first',
      role: 'user',
      content: [{ type: 'text', text: '旧内容' }],
      createdAt: 1
    }
    session.messages = [first]
    store.save(session)
    const updated: ChatMessage = { ...first, content: [{ type: 'text', text: '新内容' }] }
    const second: ChatMessage = {
      id: 'msg_second',
      role: 'assistant',
      content: [{ type: 'text', text: '回答' }],
      createdAt: 2
    }
    const saved = store.applyRunResult(store.get(session.id)!, { messages: [updated, second] })
    expect(saved.messages.map((message) => message.id)).toEqual(['msg_first', 'msg_second'])
    expect(saved.messages[0].content).toEqual([{ type: 'text', text: '新内容' }])
    expect(saved.messageCount).toBe(2)
  })

  it('branch 复制目标消息之前的历史并重置 goal/固定/归档/usage', () => {
    const source = createSession()
    source.messages = [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: '第一问' }], createdAt: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'text', text: '第一答' }],
        createdAt: 2,
        stageBoundary: { checkpointId: 'cp_source', label: '完成：第一步' }
      },
      { id: 'm3', role: 'user', content: [{ type: 'text', text: '第二问' }], createdAt: 3 },
      { id: 'm4', role: 'assistant', content: [{ type: 'text', text: '第二答' }], createdAt: 4 }
    ]
    source.todos = [{ id: 't1', text: '步骤', status: 'completed' }]
    source.usage = { inputTokens: 100, outputTokens: 50, contextUsed: 120, contextLimit: 1000, costUsd: 1 }
    source.goal = { id: 'g1', objective: '目标', status: 'active', round: 1, maxRounds: 2 } as typeof source.goal
    source.plan = {
      id: 'plan_1',
      title: '旧计划',
      summary: '测试',
      steps: [{ id: 'step_1', text: '步骤' }],
      status: 'pending',
      createdAt: 1,
      updatedAt: 1
    }
    source.planMode = true
    source.pinned = true
    source.archived = true
    store.save(source)

    const branch = store.branch(source.id, 'm2', '分支标题')!
    expect(branch.title).toBe('分支标题')
    expect(branch.messages.map((item) => item.id)).toEqual(['m1', 'm2'])
    expect(branch.messages[0]).not.toBe(source.messages[0])
    // 检查点按会话隔离，分叉后不能把旧会话的阶段标记带进来
    expect(branch.messages[1].stageBoundary).toBeUndefined()
    expect(source.messages[1].stageBoundary).toEqual({ checkpointId: 'cp_source', label: '完成：第一步' })
    expect(branch.goal).toBeNull()
    expect(branch.plan).toBeNull()
    expect(branch.planMode).toBe(false)
    expect(branch.pinned).toBe(false)
    expect(branch.archived).toBe(false)
    expect(branch.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, contextLimit: 1000 })
    expect(branch.usage.costUsd).toBeUndefined()
    expect(branch.messageCount).toBe(2)
    expect(source.messages).toHaveLength(4)
    expect(store.get(source.id)?.pinned).toBe(true)
  })

  it('remove 物理删除会话文件，并推进会话版本供搜索索引感知', () => {
    const session = createSession()
    const file = join(root, 'sessions', `${session.id}.json`)
    expect(existsSync(file)).toBe(true)
    const before = store.getRevision()
    store.save(session)
    expect(store.getRevision()).toBeGreaterThan(before)
    store.remove(session.id)
    expect(existsSync(file)).toBe(false)
    expect(store.get(session.id)).toBeNull()
    expect(store.getRevision()).toBeGreaterThan(before + 1)
  })
})

describe('临时对话与全量清除', () => {
  function isolatedStore(): { store: SessionStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'morrow-session-temp-'))
    return { store: new SessionStore(dir), dir }
  }

  it('临时对话只在内存中，不写会话文件，重启语义下 list 不包含它', () => {
    const { store: local, dir } = isolatedStore()
    try {
      const session = local.create({
        workspace: 'C:\\workspace',
        temporary: true,
        defaultModel: MODEL,
        defaultPermission: 'ask'
      })
      expect(session.temporary).toBe(true)
      expect(session.title).toBe('临时对话')
      expect(session.id.startsWith('tmp_')).toBe(true)
      expect(existsSync(join(dir, 'sessions', `${session.id}.json`))).toBe(false)
      expect(local.list()).toEqual([])
      expect(local.listTemporaryIds()).toEqual([session.id])

      local.applyRunResult(session, {
        messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], createdAt: 1 }]
      })
      local.rename(session.id, '临时标题')
      expect(local.get(session.id)?.messages).toHaveLength(1)
      expect(local.get(session.id)?.title).toBe('临时标题')
      expect(local.get(session.id)?.temporary).toBe(true)
      expect(existsSync(join(dir, 'sessions', `${session.id}.json`))).toBe(false)

      local.remove(session.id)
      expect(local.get(session.id)).toBeNull()
      expect(local.listTemporaryIds()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('分支临时对话仍是临时对话，不会落盘', () => {
    const { store: local, dir } = isolatedStore()
    try {
      const session = local.create({ temporary: true, defaultModel: MODEL, defaultPermission: 'ask' })
      const withMessage = local.applyRunResult(session, {
        messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '分支' }], createdAt: 1 }]
      })
      const branch = local.branch(withMessage.id, 'm1')
      expect(branch?.temporary).toBe(true)
      expect(branch?.id.startsWith('tmp_')).toBe(true)
      expect(existsSync(join(dir, 'sessions', `${branch!.id}.json`))).toBe(false)
      expect(local.list()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clearAll 删除所有会话文件（含损坏文件）和临时对话，并推进版本', () => {
    const { store: local, dir } = isolatedStore()
    try {
      local.create({ defaultModel: MODEL, defaultPermission: 'ask' })
      local.create({ temporary: true, defaultModel: MODEL, defaultPermission: 'ask' })
      writeFileSync(join(dir, 'sessions', 's_corrupt1.json'), '{bad')
      const before = local.getRevision()
      const removed = local.clearAll()
      expect(removed).toBe(3)
      expect(local.list()).toEqual([])
      expect(local.listTemporaryIds()).toEqual([])
      const sessionsDir = join(dir, 'sessions')
      expect(readdirSync(sessionsDir)).toEqual([])
      expect(local.getRevision()).toBeGreaterThan(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
})

describe('hooks.test.ts', () => {
/**
 * 运行钩子：事件载荷、cwd/环境、退出码 2 阻断、失败不阻断、禁用不执行。
 * 使用临时 userData 与 electron mock；钩子命令为当前 Node 可执行文件 + 临时脚本。
 */






let root: string
let workspace: string
let outputFile: string
let captureScript: string
let blockScript: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'morrow-hooks-'))
  electronState.dataDir = join(root, 'data')
  mkdirSync(electronState.dataDir, { recursive: true })
  workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  outputFile = join(root, 'hook-output.json')
  process.env.HOOK_OUT = outputFile
  captureScript = join(root, 'capture.js')
  blockScript = join(root, 'block.js')
  writeFileSync(
    captureScript,
    `const fs = require('fs')
let data = ''
process.stdin.on('data', (chunk) => { data += chunk })
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.HOOK_OUT, JSON.stringify({
    event: process.env.MORROW_HOOK_EVENT,
    workspace: process.env.MORROW_WORKSPACE,
    cwd: process.cwd(),
    payload: JSON.parse(data)
  }))
})
`,
    'utf8'
  )
  writeFileSync(blockScript, `process.stdout.write('missing version')\nprocess.exit(2)\n`, 'utf8')
})

afterAll(() => {
  delete process.env.HOOK_OUT
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

function commandFor(script: string): string {
  return `"${process.execPath}" "${script}"`
}

function setHooks(hooks: Array<{ id: string; event: 'user_prompt_submit' | 'post_tool_use' | 'run_finished'; command: string; enabled: boolean }>): void {
  getSettingsStore().update({ hooks })
}

describe('运行钩子', () => {
  it('post_tool_use：载荷写入 stdin，cwd 与工作区环境正确，禁用项不执行', async () => {
    setHooks([
      { id: 'capture', event: 'post_tool_use', command: commandFor(captureScript), enabled: true },
      { id: 'disabled', event: 'post_tool_use', command: commandFor(captureScript), enabled: false }
    ])
    rmSync(outputFile, { force: true })
    const results = await runHooks('post_tool_use', { tool: 'read_file', ok: true }, workspace)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ hookId: 'capture', exitCode: 0, timedOut: false })
    const captured = JSON.parse(readFileSync(outputFile, 'utf8')) as {
      event: string
      workspace: string
      cwd: string
      payload: { tool: string }
    }
    expect(captured.event).toBe('post_tool_use')
    expect(captured.workspace).toBe(workspace)
    expect(captured.cwd).toBe(workspace)
    expect(captured.payload.tool).toBe('read_file')
  })

  it('user_prompt_submit：退出码 2 阻止、带出输出并停止后续钩子', async () => {
    rmSync(outputFile, { force: true })
    setHooks([
      { id: 'block', event: 'user_prompt_submit', command: commandFor(blockScript), enabled: true },
      { id: 'after', event: 'user_prompt_submit', command: commandFor(captureScript), enabled: true }
    ])
    const verdict = await runPromptHooks({ text: 'hi' }, workspace)
    expect(verdict.blocked).toBe(true)
    expect(verdict.reason).toContain('missing version')
    expect(existsSync(outputFile)).toBe(false)
  })

  it('非 2 的失败只记录，不阻止发送', async () => {
    const failScript = join(root, 'fail.js')
    writeFileSync(failScript, `process.stderr.write('lint failed')\nprocess.exit(1)\n`, 'utf8')
    setHooks([{ id: 'fail', event: 'user_prompt_submit', command: commandFor(failScript), enabled: true }])
    const verdict = await runPromptHooks({ text: 'hi' }, workspace)
    expect(verdict.blocked).toBe(false)
    const results = await runHooks('user_prompt_submit', { text: 'hi' }, workspace)
    expect(results[0]?.exitCode).toBe(1)
    expect(results[0]?.stderr).toContain('lint failed')
  })
})
})

describe('workspace-read.test.ts', () => {
/**
 * 产物文本读取上限：大文件只读取前缀，不整份载入内存；同时返回 truncated 标记供 UI 提示。
 */




const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readTextSafe', () => {
  it('小文件完整读取', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'morrow-read-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'small.txt')
    writeFileSync(path, 'hello 世界', 'utf8')
    const result = await readTextSafe(path, 1024)
    expect(result.content).toBe('hello 世界')
    expect(result.truncated).toBe(false)
    expect(result.size).toBe(Buffer.byteLength('hello 世界', 'utf8'))
  })

  it('大文件只读前缀并标记 truncated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'morrow-read-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'large.txt')
    const size = 1.5 * 1024 * 1024
    writeFileSync(path, 'a'.repeat(size), 'utf8')
    const result = await readTextSafe(path, 1024 * 1024)
    expect(result.truncated).toBe(true)
    expect(result.size).toBe(size)
    expect(result.content.length).toBe(1024 * 1024)
  })
})
})

describe('workspace-search.test.ts', () => {
/**
 * 工作区文件搜索边界：
 * - 正常返回工作区内匹配文件；
 * - 不跟随工作区内的符号链接 / junction，避免把外部目录的文件名与路径暴露给渲染层。
 */




const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeSandbox(): { root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'morrow-search-test-'))
  tempDirs.push(base)
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  return { root, outside }
}

describe('searchWorkspaceFiles', () => {
  it('返回工作区内匹配文件，忽略隐藏目录与 node_modules', () => {
    const { root } = makeSandbox()
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'docs', 'inside-report.md'), 'x', 'utf8')
    writeFileSync(join(root, 'node_modules', 'pkg', 'inside-ignored.md'), 'x', 'utf8')
    writeFileSync(join(root, '.git', 'inside-hidden.md'), 'x', 'utf8')

    const results = searchWorkspaceFiles(root, 'inside')
    expect(results.map((item) => item.name)).toEqual(['inside-report.md'])
  })

  it('不跟随 junction / 符号链接目录，不泄漏外部文件', () => {
    const { root, outside } = makeSandbox()
    writeFileSync(join(root, 'visible.txt'), 'x', 'utf8')
    writeFileSync(join(outside, 'outside-secret.txt'), 'x', 'utf8')
    let linked = false
    try {
      symlinkSync(outside, join(root, 'linked-outside'), 'junction')
      linked = true
    } catch {
      linked = false
    }
    if (!linked) return // Windows 受限环境建不了目录链接时跳过

    const results = searchWorkspaceFiles(root, 'outside')
    expect(results).toHaveLength(0)
    expect(results.some((item) => item.path.includes('outside-secret'))).toBe(false)
  })
})
})

describe('pdf-ocr.test.ts', () => {
/**
 * 本机 PDF OCR：真实调用 Windows.Data.Pdf + Windows.Media.Ocr。
 * 只在这个 Windows 交付环境里跑；非 Windows 环境跳过。
 */


const FIXTURE = join(process.cwd(), 'tests', 'unit', 'core', 'fixtures', 'documents', 'invoice-zh.pdf')

beforeAll(() => {
  electronState.dataDir = mkdtempSync(join(tmpdir(), 'morrow-pdf-ocr-test-'))
})

afterAll(() => {
  rmSync(electronState.dataDir, { recursive: true, force: true })
})

describe('normalizeOcrText', () => {
  it('去掉中文逐字空格，并还原编号、金额与标签标点', () => {
    const input = [
      '发 票 编 号 ·',
      '· INV · 0042',
      '项 目 金 额 ·',
      '· 12 、 18 、 7',
      '印 刷 总 额 ·',
      '· 38',
      '备 注 ： 本 发 票 为 离 线 测 试 样 例 。'
    ].join('\n')
    const text = normalizeOcrText(input)
    expect(text).toContain('发票编号：')
    expect(text).toContain('INV 0042')
    expect(text).toContain('项目金额：')
    expect(text).toContain('12、18、7')
    expect(text).toContain('印刷总额：')
    expect(text).toContain('备注：本发票为离线测试样例。')
  })
})

describe.skipIf(process.platform !== 'win32')('Windows 本机 PDF OCR', () => {
  it('渲染 PDF 页面并识别出中文与数字（离线）', async () => {
    const handler = createPdfOcrHandler()
    const result = await handler({ path: FIXTURE, pages: [1] })
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0].page).toBe(1)
    expect(result.pages[0].error).toBeUndefined()
    expect(result.language).toMatch(/zh|en/i)
    expect(result.pages[0].text).toContain('发票')
    expect(result.pages[0].text).toContain('0042')
    expect(result.pages[0].text).toContain('38')
  }, 60_000)

  it('页码超出范围时逐页返回错误，而不是伪造文字', async () => {
    const handler = createPdfOcrHandler()
    const result = await handler({ path: FIXTURE, pages: [99] })
    expect(result.pages[0].page).toBe(99)
    expect(result.pages[0].text).toBe('')
    expect(result.pages[0].error).toContain('超出范围')
  }, 60_000)
})
})
