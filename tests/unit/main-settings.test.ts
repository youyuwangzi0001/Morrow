/**
 * 合并后的 settings-store 组：设置/密钥、数据目录、会话存储、运行钩子、产物读取/搜索、PDF OCR。
 * 每个原文件各自包在 describe('<原文件名>') 中，钩子与临时目录互不污染。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MODEL, DEMO_MODEL, builtinProviders, defaultSettings } from '../../src/shared/contracts'
import { type ProviderConfig, type ChatMessage } from '../../src/shared/types'
import { SettingsStore, getSettingsStore } from '../../src/main/settings'
import { isNestedPath, resetResolveDataDirCacheForTests, samePath } from '../../src/main/workspace'
import { cleanTargetDataDir, copyUserDataForMigration } from '../../src/main/workspace'
import { SessionStore } from '../../src/main/session'
import { runHooks, runPromptHooks } from '../../src/main/agent'
import { normalizeOcrText } from '../../src/main/workspace'

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
  it('@core:settings 密钥只以加密形式落盘，视图不返回明文；清除后配置标记同步', () => {
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

  it('@core:settings 加密不可用时拒绝保存密钥且不写入配置', () => {
    electronState.encryption = false
    const s = store()
    expect(() => s.saveProvider(customProvider(), SECRET)).toThrow(/加密/)
    expect(s.get().providers.some((provider) => provider.id === 'custom-test')).toBe(false)
    expect(existsSync(join(electronState.dataDir, 'secrets.json'))).toBe(false)
  })
})

describe('SettingsStore：Provider 配置校验', () => {
  it('@core:settings 非法 Base URL / 模型 / 请求头 / ID 被拒绝，且不覆盖已有配置与密钥', () => {
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

  it('@core:settings 内置 Provider 重启合并：保留同步的额外模型与同步元数据；未同步时同 ID 用最新预设', () => {
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
})

describe('SettingsStore：update 与默认模型', () => {
  it('@core:settings 合法设置生效；越界/未知字段/不存在的默认模型被拒绝', () => {
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

  it('@core:settings 演示模型不能设为默认模型；旧设置里的演示默认值会在启动时修复', () => {
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

describe('data directory migration', () => {
  it('@core:settings copies user data and skips caches, logs and browser transient state', () => {
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

  it('@core:settings detects same and nested paths', () => {
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

  it('@core:sessions 归档状态写入会话文件，重启后仍可恢复', () => {
    const session = createSession()
    expect(store.setArchived(session.id, true)?.archived).toBe(true)

    const restarted = new SessionStore(root)
    expect(restarted.list().find((item) => item.id === session.id)?.archived).toBe(true)
    expect(restarted.setArchived(session.id, false)?.archived).toBeFalsy()
    expect(new SessionStore(root).list().find((item) => item.id === session.id)?.archived).toBeFalsy()
  })

  it('@core:sessions 损坏 JSON 与文件名/id 不匹配时跳过，不误加载其他会话', () => {
    writeFileSync(join(root, 'sessions', 's_broken1.json'), '{not-json')
    writeFileSync(join(root, 'sessions', 's_mismatch1.json'), JSON.stringify({ id: 's_other1', messages: [] }))
    expect(store.get('s_broken1')).toBeNull()
    expect(store.get('s_mismatch1')).toBeNull()
    expect(store.list().some((meta) => meta.id === 's_broken1' || meta.id === 's_mismatch1')).toBe(false)
  })

  it('@core:sessions applyRunResult 按消息 id 更新而不是重复追加', () => {
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

  it('@core:sessions branch 复制目标消息之前的历史并重置 goal/固定/归档/usage', () => {
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
})

describe('临时对话与全量清除', () => {
  function isolatedStore(): { store: SessionStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'morrow-session-temp-'))
    return { store: new SessionStore(dir), dir }
  }

  it('@core:sessions 临时对话只在内存中，不写会话文件，重启语义下 list 不包含它', () => {
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

  it('@core:sessions clearAll 删除所有会话文件（含损坏文件）和临时对话，并推进版本', () => {
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
  it('@core:hooks post_tool_use：载荷写入 stdin，cwd 与工作区环境正确，禁用项不执行', async () => {
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

  it('@core:hooks user_prompt_submit：退出码 2 阻止、带出输出并停止后续钩子', async () => {
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
})
})

describe('pdf-ocr.test.ts', () => {

beforeAll(() => {
  electronState.dataDir = mkdtempSync(join(tmpdir(), 'morrow-pdf-ocr-test-'))
})

afterAll(() => {
  rmSync(electronState.dataDir, { recursive: true, force: true })
})

describe('normalizeOcrText', () => {
  it('@core:documents 去掉中文逐字空格，并还原编号、金额与标签标点', () => {
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
})

describe('local-model-presets', () => {
  it('@core:settings 不再预置 Coder390，本地模型由用户自行添加', () => {
    const llama = builtinProviders().find((provider) => provider.id === 'llamacpp')
    expect(llama?.models).toEqual([])
    expect(defaultSettings().providers.find((provider) => provider.id === 'llamacpp')?.models).toEqual([])
  })
})
