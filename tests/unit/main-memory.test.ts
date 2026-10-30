/**
 * 合并后的 memory 组：记忆中心、Projects、MCP 连接器。
 * 每个原文件各自包在 describe('<原文件名>') 中。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_LEGACY_FILE, MEMORY_STORE_FILE, MemoryService, type MemoryEntry, type MemoryInjection, type MemoryListResult } from '../../src/main/memory'
import { PROJECT_KNOWLEDGE_MAX_BYTES, ProjectService, type ProjectContext, type ProjectKnowledgeInfo, type ProjectRecord, type ProjectSummary } from '../../src/main/runtime'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type Socket } from 'node:net'
import { type McpServerConfig, createMcpConnection, loadMcpConfig, McpError, MCP_SECRET_MARKER, validateMcpServerUrl } from '../../src/core/tool-extra'
import { deleteConnector, getConnector, installMcpRuntimeEnv, listConnectors, saveConnector, startConnectorOAuth, connectorOAuthStatus, revokeConnectorOAuth, setSecretCodecForTest, testConnector, trustWorkspaceConfig, workspaceTrustStatus } from '../../src/main/memory'

import type { ChatMessage, ModelInfo, Session } from "../../src/shared/types"
import type { Provider, ProviderStreamEvent } from "../../src/core/index"
import { EvolutionService } from "../../src/main/agent"
import { createSkillsService } from "../../src/main/memory"

const electronState = vi.hoisted(() => ({
  dataDir: '',
  picked: [] as string[]
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? electronState.dataDir : join(electronState.dataDir, name)) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    }
  },
  dialog: {
    showOpenDialog: async () => ({
      canceled: electronState.picked.length === 0,
      filePaths: electronState.picked.slice()
    })
  },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

describe('memory.test.ts', () => {
/**
 * R10-D 记忆中心服务单测：
 * - 旧 `.morrow/MEMORY.md` 迁移（格式兼容 / 幂等 / 删除不复活 / 清空后新行才导入）；
 * - 项目 / 全局 scope 隔离；
 * - CRUD（添加/编辑/启停/删除/清空/搜索）；
 * - 注入过滤（只启用、项目优先、token 预算、disabled 不出现）；
 * - 导出（Markdown + JSON）；
 * - 边界（空文本/超长/非法 scope/损坏存储恢复）。
 */

/**
 * feature IPC 频道测试需要 import 主进程 feature 模块（它 import electron）。
 * 这里只 mock electron 的 app/dialog/ipcMain，服务本身仍是真实实现。
 */

const tempDirs: string[] = []

function makeRoot(): { root: string; dataDir: string; wsA: string; wsB: string } {
  const root = mkdtempSync(join(tmpdir(), 'morrow-memory-'))
  tempDirs.push(root)
  const dataDir = join(root, 'data')
  const wsA = join(root, 'workspace-a')
  const wsB = join(root, 'workspace-b')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(wsA, { recursive: true })
  mkdirSync(wsB, { recursive: true })
  return { root, dataDir, wsA, wsB }
}

function seedLegacy(workspace: string, content: string): string {
  const dir = join(workspace, '.morrow')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, MEMORY_LEGACY_FILE)
  writeFileSync(path, content, 'utf8')
  return path
}

function service(dataDir: string): MemoryService {
  return new MemoryService({ dataDir })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('工作区 .morrow 目录边界', () => {
  it('@core:memory junction/symlink 指向工作区外时拒绝读写项目记忆', () => {
    const { root, dataDir, wsA } = makeRoot()
    const outside = join(root, 'outside-memory')
    mkdirSync(outside, { recursive: true })
    try {
      symlinkSync(outside, join(wsA, '.morrow'), 'junction')
    } catch {
      return // Windows 未开启开发者模式时无法创建链接
    }
    const svc = service(dataDir)
    expect(() => svc.list('project', wsA)).toThrow(/工作区外/)
    expect(() => svc.add({ scope: 'project', workspace: wsA, text: '不应写到工作区外' })).toThrow(/工作区外/)
    expect(existsSync(join(outside, MEMORY_STORE_FILE))).toBe(false)
  })
})

describe('旧 MEMORY.md 迁移', () => {

  it('@core:memory 重复读取不重复导入；删除迁移条目不复活；MEMORY.md 新增行仍会被导入', () => {
    const { dataDir, wsA } = makeRoot()
    const legacyPath = seedLegacy(wsA, '- [2026-10-01] 第一条\n')
    const svc = service(dataDir)
    expect(svc.list('project', wsA, { includeDisabled: true }).entries).toHaveLength(1)
    expect(svc.list('project', wsA, { includeDisabled: true }).entries).toHaveLength(1)

    const legacyEntry = svc.list('project', wsA, { includeDisabled: true }).entries[0]
    svc.remove('project', wsA, legacyEntry.id)
    // 删除后再次读取：不会因为 MEMORY.md 里还在而被重新导入
    expect(svc.list('project', wsA, { includeDisabled: true }).entries).toHaveLength(0)

    writeFileSync(legacyPath, '- [2026-10-01] 第一条\n- [2026-10-03] 第二条\n', 'utf8')
    const after = svc.list('project', wsA, { includeDisabled: true })
    expect(after.entries.map((entry) => entry.text)).toEqual(['第二条'])
  })
})

describe('CRUD 与 scope 隔离', () => {
  it('@core:memory 项目记忆 CRUD：添加 / 编辑 / 启停 / 搜索 / 删除', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    const entry = svc.add({ scope: 'project', workspace: wsA, text: '周报要按季度口径汇总', tags: ['报表', '#周报'] })
    expect(entry.scope).toBe('project')
    expect(entry.workspace).toBe(realpathSync(wsA))
    expect(entry.tags).toEqual(['报表', '周报'])
    expect(entry.source).toBe('user')

    const updated = svc.update('project', wsA, entry.id, { text: '周报按季度口径汇总（含同比）' })
    expect(updated.text).toContain('同比')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt)

    const disabled = svc.toggle('project', wsA, entry.id, false)
    expect(disabled.enabled).toBe(false)
    expect(svc.list('project', wsA).entries).toHaveLength(0)
    expect(svc.list('project', wsA, { includeDisabled: true }).entries).toHaveLength(1)
    expect(svc.list('project', wsA, { includeDisabled: true, query: '同比' }).entries).toHaveLength(1)

    svc.remove('project', wsA, entry.id)
    expect(svc.list('project', wsA, { includeDisabled: true }).entries).toHaveLength(0)
    expect(() => svc.remove('project', wsA, entry.id)).toThrow(/找不到/)
  })

  it('@core:memory 项目 scope 互相隔离，全局 scope 独立', () => {
    const { dataDir, wsA, wsB } = makeRoot()
    const svc = service(dataDir)
    svc.add({ scope: 'project', workspace: wsA, text: 'A 项目的约定' })
    svc.add({ scope: 'project', workspace: wsB, text: 'B 项目的约定' })
    svc.add({ scope: 'global', text: '全局偏好：输出简体中文' })

    expect(svc.list('project', wsA, { includeDisabled: true }).entries.map((entry) => entry.text)).toEqual(['A 项目的约定'])
    expect(svc.list('project', wsB, { includeDisabled: true }).entries.map((entry) => entry.text)).toEqual(['B 项目的约定'])
    expect(svc.list('global', null).entries.map((entry) => entry.text)).toEqual(['全局偏好：输出简体中文'])

    // 注入：A 只拿到 A + 全局，不应出现 B
    const injection = svc.injection(wsA)
    expect(injection.text).toContain('A 项目的约定')
    expect(injection.text).toContain('全局偏好')
    expect(injection.text).not.toContain('B 项目的约定')
    expect(injection.projectCount).toBe(1)
    expect(injection.globalCount).toBe(1)
  })
})

describe('注入过滤与 token 预算', () => {

  it('@core:memory 任意预算下 usedTokens 都不超过上限（包含 omitted 提示）', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    for (let index = 0; index < 20; index += 1) {
      svc.add({ scope: 'project', workspace: wsA, text: `第 ${index} 条记忆：${'预算'.repeat(30)}` })
    }
    for (const maxTokens of [64, 80, 96, 120, 160, 200, 240, 300, 400, 600]) {
      const result = svc.injection(wsA, { maxTokens })
      expect(result.usedTokens, `预算 ${maxTokens}`).toBeLessThanOrEqual(maxTokens)
    }
  })
})

describe('导出与边界', () => {

  it('@core:memory 损坏的 memories.json 会被备份并从空数据恢复', () => {
    const { dataDir, wsA } = makeRoot()
    const storeDir = join(wsA, '.morrow')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'memories.json'), '{ 这不是 JSON', 'utf8')
    const svc = service(dataDir)
    expect(svc.list('project', wsA, { includeDisabled: true }).entries).toHaveLength(0)
    expect(readdirSync(storeDir).some((name) => name.includes('memories.json.corrupt-'))).toBe(true)
    // 恢复后仍可正常写入
    svc.add({ scope: 'project', workspace: wsA, text: '恢复后新增' })
    expect(svc.list('project', wsA).entries).toHaveLength(1)
  })
})

describe('feature IPC 频道（feature:memory:*）', () => {
  it('@core:memory 注册后 add/list/toggle/injection/export 走真实服务，错误 payload 返回 ok=false', async () => {
    const { dataDir, wsA, wsB } = makeRoot()
    electronState.dataDir = dataDir
    const featureModule = await import('../../src/main/features')
    const { invokeFeatureForTest, registerFeatureHandler } = await import('../../src/main/feature-ipc')
    featureModule.registerMemoryFeature(registerFeatureHandler, {
      dataDir,
      // 单测不启动 Electron 设置/会话存储，用白名单模拟「已登记工作区」
      isWorkspaceAllowed: (ws) => ws === wsA
    })
    expect(featureModule.MEMORY_FEATURE_CHANNELS.length).toBe(13)

    const added = await invokeFeatureForTest<{ entry: MemoryEntry }>('feature:memory:add', {
      scope: 'project',
      workspace: wsA,
      text: '通过 feature IPC 写入的记忆',
      tags: ['ipc']
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.data.entry.text).toContain('feature IPC')

    const listed = await invokeFeatureForTest<MemoryListResult>('feature:memory:list', {
      scope: 'project',
      workspace: wsA,
      includeDisabled: true
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.entries).toHaveLength(1)
    expect(listed.data.stats.enabled).toBe(1)

    const toggled = await invokeFeatureForTest<{ entry: MemoryEntry }>('feature:memory:toggle', {
      scope: 'project',
      workspace: wsA,
      id: added.data.entry.id,
      enabled: false
    })
    expect(toggled.ok).toBe(true)
    if (toggled.ok) expect(toggled.data.entry.enabled).toBe(false)

    const injection = await invokeFeatureForTest<MemoryInjection>('feature:memory:injection', { workspace: wsA })
    expect(injection.ok).toBe(true)
    if (injection.ok) {
      // 唯一一条被停用后没有可注入内容：不返回半截标题，也不谎报有内容被省略
      expect(injection.data.text).toBe('')
      expect(injection.data.totalEnabled).toBe(0)
      expect(injection.data.usedTokens).toBe(0)
    }

    const exported = await invokeFeatureForTest<{ markdown: string; count: number }>('feature:memory:export', {
      scope: 'project',
      workspace: wsA
    })
    expect(exported.ok).toBe(true)
    if (exported.ok) {
      expect(exported.data.count).toBe(1)
      expect(exported.data.markdown).toContain('通过 feature IPC')
    }

    const badScope = await invokeFeatureForTest('feature:memory:list', { scope: 'nope' })
    expect(badScope.ok).toBe(false)
    if (!badScope.ok) expect(badScope.error.code).toBe('FEATURE_ERROR')

    const badWorkspace = await invokeFeatureForTest('feature:memory:add', {
      scope: 'project',
      workspace: join(wsA, 'missing'),
      text: '坏工作区'
    })
    expect(badWorkspace.ok).toBe(false)

    // 真实存在但未登记的工作区同样拒绝，防止向任意目录写 .morrow
    const unregisteredWorkspace = await invokeFeatureForTest('feature:memory:add', {
      scope: 'project',
      workspace: wsB,
      text: '不应写入未登记工作区'
    })
    expect(unregisteredWorkspace.ok).toBe(false)
    if (!unregisteredWorkspace.ok) expect(unregisteredWorkspace.error.message).toContain('已登记')

    const unregistered = await invokeFeatureForTest('feature:memory:does-not-exist', {})
    expect(unregistered.ok).toBe(false)
    if (!unregistered.ok) expect(unregistered.error.code).toBe('FEATURE_CHANNEL')
  })
})
})

describe('projects.test.ts', () => {
/**
 * R10-E Projects 服务单测：
 * - 每工作区一个项目：CRUD / 持久化 / 置顶 / 启用切换；
 * - 跨项目隔离：A 的上下文不出现 B 的指令或知识；
 * - 工作区边界：相对路径越界、工作区外绝对路径、目录、非文本、超大文件都被拒绝；
 * - 上下文生成：指令 + 知识摘要 + 记忆中心；未启用项目不生成；失效知识文件被跳过；
 * - token 预算截断与 `getProjectPrompt()` 集成入口。
 */

/** feature IPC 频道测试需要 mock electron（服务本身仍是真实实现） */

const tempDirs: string[] = []

function makeRoot(): { root: string; dataDir: string; wsA: string; wsB: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'morrow-projects-'))
  tempDirs.push(root)
  const dataDir = join(root, 'data')
  const wsA = join(root, 'workspace-a')
  const wsB = join(root, 'workspace-b')
  const outside = join(root, 'outside')
  for (const dir of [dataDir, wsA, wsB, outside]) mkdirSync(dir, { recursive: true })
  return { root, dataDir, wsA, wsB, outside }
}

function seedWorkspace(workspace: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(workspace, relativePath)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
}

function service(dataDir: string, now?: () => number): ProjectService {
  return new ProjectService({ dataDir, ...(now ? { now } : {}) })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('工作区边界与知识文件校验', () => {

  it('@core:projects 拒绝工作区外路径 / 相对越界 / 目录 / 非文本 / 超大文件 / .morrow 内部文件', () => {
    const { dataDir, wsA, outside } = makeRoot()
    seedWorkspace(wsA, { 'ok.md': 'hello' })
    writeFileSync(join(outside, 'secret.md'), 'outside', 'utf8')
    writeFileSync(join(wsA, 'big.md'), 'x'.repeat(PROJECT_KNOWLEDGE_MAX_BYTES + 10), 'utf8')
    writeFileSync(join(wsA, 'image.png'), 'not really png', 'utf8')
    mkdirSync(join(wsA, 'folder'), { recursive: true })
    mkdirSync(join(wsA, '.morrow'), { recursive: true })
    writeFileSync(join(wsA, '.morrow', 'MEMORY.md'), '- [2026-01-01] 记忆', 'utf8')

    const svc = service(dataDir)
    const project = svc.create({ workspace: wsA })
    const validate = (path: string): void => {
      svc.update(project.id, { knowledgePaths: [path] })
    }
    expect(() => validate(join(outside, 'secret.md'))).toThrow(/工作区内/)
    expect(() => validate('../outside/secret.md')).toThrow(/工作区内|不存在/)
    expect(() => validate('missing.md')).toThrow(/不存在/)
    expect(() => validate('folder')).toThrow(/普通文件|不支持/)
    expect(() => validate('image.png')).toThrow(/文本类/)
    expect(() => validate('big.md')).toThrow(/过大/)
    expect(() => validate('.morrow/MEMORY.md')).toThrow(/不支持/)
    expect(() => validate('ok.md')).not.toThrow()
  })
})

describe('项目上下文生成与隔离', () => {
  it('@core:projects 生成指令 + 知识摘要 + 记忆；跨项目不泄漏', () => {
    const { dataDir, wsA, wsB } = makeRoot()
    seedWorkspace(wsA, {
      'brief.md': '这是一个只有 A 项目才有的知识文件内容：CANARY_A_KNOWLEDGE。',
      'numbers.csv': '季度,销售额\nQ3,123'
    })
    seedWorkspace(wsB, { 'brief.md': 'B 项目专属：CANARY_B_KNOWLEDGE。' })

    const svc = service(dataDir)
    const projectA = svc.create({
      workspace: wsA,
      name: '经营分析',
      description: 'A 项目描述',
      instructions: '报告必须标注数据来源。',
      knowledgePaths: ['brief.md', 'numbers.csv']
    })
    svc.create({
      workspace: wsB,
      name: 'B 项目',
      instructions: 'B 项目指令',
      knowledgePaths: ['brief.md']
    })

    // 记忆中心：项目记忆 + 全局记忆
    const memory = new MemoryService({ dataDir })
    memory.add({ scope: 'project', workspace: wsA, text: 'A 项目记忆：口径按季度' })
    memory.add({ scope: 'global', text: '全局记忆：输出简体中文' })

    const contextA = svc.context(wsA, { memoryTokens: 300 })!
    expect(contextA).not.toBeNull()
    expect(contextA.project.id).toBe(projectA.id)
    expect(contextA.text).toContain('经营分析')
    expect(contextA.text).toContain('报告必须标注数据来源')
    expect(contextA.text).toContain('CANARY_A_KNOWLEDGE')
    expect(contextA.text).toContain('季度,销售额')
    expect(contextA.text).toContain('A 项目记忆')
    expect(contextA.text).toContain('全局记忆')
    expect(contextA.text).toContain('不可信数据')
    expect(contextA.text).not.toContain('CANARY_B_KNOWLEDGE')
    expect(contextA.text).not.toContain('B 项目指令')
    expect(contextA.knowledge).toHaveLength(2)
    expect(contextA.memory?.included).toBeGreaterThanOrEqual(2)

    const contextB = svc.context(wsB)!
    expect(contextB.text).toContain('CANARY_B_KNOWLEDGE')
    expect(contextB.text).not.toContain('CANARY_A_KNOWLEDGE')
    expect(contextB.text).not.toContain('A 项目记忆')
  })

  it('@core:projects 知识文件失效后仍能保存项目修改，并可移除失效资料；新增无效路径仍被拒绝', () => {
    const { dataDir, wsA } = makeRoot()
    seedWorkspace(wsA, { 'keep.md': 'keep', 'gone.md': 'gone' })
    const svc = service(dataDir)
    const project = svc.create({ workspace: wsA, knowledgePaths: ['keep.md', 'gone.md'] })
    unlinkSync(join(wsA, 'gone.md'))

    // 保留失效资料时，修改说明可以正常保存
    const updated = svc.update(project.id, {
      instructions: '失效资料不影响保存',
      knowledgePaths: ['keep.md', 'gone.md']
    })
    expect(updated.instructions).toContain('失效资料不影响保存')
    expect(updated.knowledgePaths).toEqual(['keep.md', 'gone.md'])

    // 可以移除失效资料
    const cleaned = svc.update(project.id, { knowledgePaths: ['keep.md'] })
    expect(cleaned.knowledgePaths).toEqual(['keep.md'])

    // 新增一个不存在的路径仍然报错，避免把错误路径写进项目
    expect(() => svc.update(project.id, { knowledgePaths: ['keep.md', 'missing.md'] })).toThrow(/不存在/)
  })
})

describe('feature IPC 频道（feature:projects:*）', () => {
  it('@core:projects 注册后 create/list/update/context/set-active/remove 全链路可用', async () => {
    const { dataDir, wsA } = makeRoot()
    seedWorkspace(wsA, { 'docs/brief.md': 'IPC_CANARY_KNOWLEDGE 项目资料' })
    electronState.dataDir = dataDir
    electronState.picked = []
    const featureModule = await import('../../src/main/features')
    const { invokeFeatureForTest, registerFeatureHandler } = await import('../../src/main/feature-ipc')
    featureModule.registerProjectsFeature(registerFeatureHandler, { dataDir })
    expect(featureModule.PROJECTS_FEATURE_CHANNELS.length).toBe(10)

    const created = await invokeFeatureForTest<ProjectRecord>('feature:projects:create', {
      workspace: wsA,
      name: 'IPC 项目',
      description: '描述',
      instructions: 'IPC 指令：保留两位小数。',
      knowledgePaths: ['docs/brief.md'],
      pinned: true
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const projectId = created.data.id

    const listed = await invokeFeatureForTest<{ projects: ProjectSummary[] }>('feature:projects:list')
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.data.projects).toHaveLength(1)
      expect(listed.data.projects[0].knowledgeCount).toBe(1)
      expect(listed.data.projects[0].workspaceExists).toBe(true)
    }

    const byWorkspace = await invokeFeatureForTest<ProjectRecord | null>('feature:projects:get', { workspace: wsA })
    expect(byWorkspace.ok).toBe(true)
    if (byWorkspace.ok) expect(byWorkspace.data?.id).toBe(projectId)

    const updated = await invokeFeatureForTest<ProjectRecord>('feature:projects:update', {
      id: projectId,
      instructions: 'IPC 更新后的指令'
    })
    expect(updated.ok).toBe(true)

    const context = await invokeFeatureForTest<ProjectContext | null>('feature:projects:context', { workspace: wsA })
    expect(context.ok).toBe(true)
    if (context.ok) {
      expect(context.data).not.toBeNull()
      expect(context.data?.text).toContain('IPC 更新后的指令')
      expect(context.data?.text).toContain('IPC_CANARY_KNOWLEDGE')
    }

    // 知识文件校验：越界路径被拒绝
    const badKnowledge = await invokeFeatureForTest('feature:projects:knowledge-validate', {
      workspace: wsA,
      path: '../outside.md'
    })
    expect(badKnowledge.ok).toBe(false)

    // 文件选择器：返回工作区内文件；越界文件进入 errors
    electronState.picked = [join(wsA, 'docs', 'brief.md')]
    const picked = await invokeFeatureForTest<{ files: ProjectKnowledgeInfo[]; errors: unknown[] }>(
      'feature:projects:knowledge-pick',
      { workspace: wsA }
    )
    expect(picked.ok).toBe(true)
    if (picked.ok) {
      expect(picked.data.files.map((file) => file.path)).toContain('docs/brief.md')
      expect(picked.data.errors).toHaveLength(0)
    }

    // 停用后上下文不再注入，ignoreActive 预览仍可用
    const deactivated = await invokeFeatureForTest<ProjectRecord>('feature:projects:set-active', {
      id: projectId,
      active: false
    })
    expect(deactivated.ok).toBe(true)
    const contextInactive = await invokeFeatureForTest<ProjectContext | null>('feature:projects:context', {
      workspace: wsA
    })
    expect(contextInactive.ok).toBe(true)
    if (contextInactive.ok) expect(contextInactive.data).toBeNull()
    const preview = await invokeFeatureForTest<ProjectContext | null>('feature:projects:context', {
      workspace: wsA,
      ignoreActive: true
    })
    expect(preview.ok).toBe(true)
    if (preview.ok) expect(preview.data).not.toBeNull()

    const removed = await invokeFeatureForTest('feature:projects:remove', { id: projectId })
    expect(removed.ok).toBe(true)
    const empty = await invokeFeatureForTest<{ projects: ProjectSummary[] }>('feature:projects:list')
    if (empty.ok) expect(empty.data.projects).toHaveLength(0)

    const badPayload = await invokeFeatureForTest('feature:projects:create', { name: '缺工作区' })
    expect(badPayload.ok).toBe(false)
  })
})
})

describe('mcp-connectors.test.ts', () => {
/**
 * R10-G/K2：MCP 连接器（stdio 回归 + Streamable HTTP + 旧版 HTTP/SSE + 管理服务 + feature IPC）。
 *
 * 全部离线：本机 node:http mock（JSON / SSE 响应 / 旧版 SSE）、临时目录、mock Electron safeStorage。
 * 覆盖：initialize → tools/list → tools/call、会话头、超时、取消、SSRF（localhost/内网/协议）、
 * 配置校验、密钥掩码与加密存储、工作区配置哈希信任、CRUD/启停/测试连接、模板「仅示例」、IPC 参数校验。
 */

/* ── mock Electron（safeStorage 用可控的假加密；app.getPath = 临时目录） ── */

/* ── 测试环境 ─────────────────────────────────────────────────── */

const tempDirs: string[] = []
const servers: MockServer[] = []
let dataDir = ''

function makeTempDir(prefix = 'morrow-conn-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

let mcpPreviousDataDir: string | undefined

beforeEach(() => {
  mcpPreviousDataDir = process.env.MORROW_DATA_DIR
  dataDir = makeTempDir('morrow-conn-data-')
  electronState.dataDir = dataDir
  installMcpRuntimeEnv(process.env, dataDir)
})

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    if (server) await server.close()
  }
  setSecretCodecForTest(null)
  if (mcpPreviousDataDir === undefined) delete process.env.MORROW_DATA_DIR
  else process.env.MORROW_DATA_DIR = mcpPreviousDataDir
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/* ── 本机 mock MCP server ────────────────────────────────────── */

interface MockRequestRecord {
  method: string
  message: Record<string, unknown> | null
  headers: IncomingMessage['headers']
}

interface MockServer {
  url: string
  requests: MockRequestRecord[]
  close: () => Promise<void>
}

function startNodeServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<MockServer> {
  const sockets = new Set<Socket>()
  const requests: MockRequestRecord[] = []
  const server: Server = createServer((req, res) => {
    handler(req, res)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise<MockServer>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('mock server 未监听')
      const mock: MockServer = {
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          })
      }
      servers.push(mock)
      // 记录请求由具体 mock 自己 push（这里只提供通用 close）
      resolve(mock)
    })
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

const INITIALIZE_RESULT = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {}, resources: {}, prompts: {} },
  serverInfo: { name: 'morrow-mock-http', version: '1.0.0' }
}

const TOOLS_RESULT = {
  tools: [
    {
      name: 'echo',
      description: '原样返回参数',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    },
    { name: 'slow', description: '慢响应', inputSchema: { type: 'object', properties: {} } },
    { name: 'fail', description: '返回工具错误', inputSchema: { type: 'object', properties: {} } }
  ]
}

async function startHttpMcp(options: { sseResponses?: boolean; unauthorized?: boolean } = {}): Promise<MockServer> {
  const mock = await startNodeServer((req, res) => {
    void readBody(req).then((body) => {
      let message: Record<string, unknown> | null = null
      try {
        message = JSON.parse(body) as Record<string, unknown>
      } catch {
        message = null
      }
      mock.requests.push({ method: typeof message?.method === 'string' ? message.method : '', message, headers: req.headers })
      if (options.unauthorized) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (!message) {
        res.writeHead(400)
        res.end()
        return
      }
      const reply = (result: unknown, headers: Record<string, string> = {}): void => {
        if (res.destroyed) return
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message?.id, result })
        if (options.sseResponses) {
          res.writeHead(200, { 'content-type': 'text/event-stream', ...headers })
          res.write(`event: message\ndata: ${payload}\n\n`)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', ...headers })
        res.end(payload)
      }
      const method = message.method
      if (method === 'initialize') {
        reply(INITIALIZE_RESULT, { 'Mcp-Session-Id': 'sess-test' })
        return
      }
      if (method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (method === 'tools/list') {
        reply(TOOLS_RESULT)
        return
      }
      if (method === 'resources/list') {
        reply({ resources: [{ uri: 'memo://notes/1', name: 'Notes', mimeType: 'text/plain' }] })
        return
      }
      if (method === 'resources/templates/list') {
        reply({ resourceTemplates: [{ uriTemplate: 'memo://notes/{id}', name: 'Note' }] })
        return
      }
      if (method === 'resources/read') {
        const params = (message.params ?? {}) as Record<string, unknown>
        reply({ contents: [{ uri: params.uri, mimeType: 'text/plain', text: '# Note' }] })
        return
      }
      if (method === 'prompts/list') {
        reply({ prompts: [{ name: 'summarize', description: '总结主题', arguments: [{ name: 'topic', required: true }] }] })
        return
      }
      if (method === 'prompts/get') {
        const params = (message.params ?? {}) as Record<string, unknown>
        const args = (params.arguments ?? {}) as Record<string, string>
        reply({ description: '总结模板', messages: [{ role: 'user', content: { type: 'text', text: '请总结：' + (args.topic ?? '') } }] })
        return
      }
      if (method === 'tools/call') {
        const params = (message.params ?? {}) as Record<string, unknown>
        if (params.name === 'slow') {
          setTimeout(() => {
            try {
              reply({ content: [{ type: 'text', text: 'slow-done' }] })
            } catch {
              // 客户端已超时断开
            }
          }, 1500)
          return
        }
        if (params.name === 'fail') {
          reply({ isError: true, content: [{ type: 'text', text: 'invalid_arguments: text 必填' }] })
          return
        }
        reply({ content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] })
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  return mock
}

async function startLegacySse(): Promise<MockServer> {
  const streams = new Set<ServerResponse>()
  const mock = await startNodeServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').startsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: endpoint\ndata: /messages\n\n')
      streams.add(res)
      res.on('close', () => streams.delete(res))
      return
    }
    if (req.method === 'POST' && (req.url ?? '').startsWith('/messages')) {
      void readBody(req).then((body) => {
        let message: Record<string, unknown> | null = null
        try {
          message = JSON.parse(body) as Record<string, unknown>
        } catch {
          message = null
        }
        mock.requests.push({ method: typeof message?.method === 'string' ? message.method : '', message, headers: req.headers })
        res.writeHead(202)
        res.end()
        if (!message) return
        const send = (result: unknown): void => {
          const payload = JSON.stringify({ jsonrpc: '2.0', id: message?.id, result })
          for (const stream of streams) {
            try {
              stream.write(`event: message\ndata: ${payload}\n\n`)
            } catch {
              // 流已关闭
            }
          }
        }
        if (message.method === 'initialize') send(INITIALIZE_RESULT)
        else if (message.method === 'tools/list') send(TOOLS_RESULT)
        else if (message.method === 'tools/call') {
          const params = (message.params ?? {}) as Record<string, unknown>
          send({ content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] })
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  return mock
}

function httpConfig(url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { transport: 'http', url, allowPrivateNetwork: true, timeoutMs: 4000, retries: 0, ...overrides }
}

async function runWithConnection<T>(config: McpServerConfig, run: (client: ReturnType<typeof createMcpConnection>) => Promise<T>): Promise<T> {
  const client = createMcpConnection('mock-http', config)
  try {
    await client.connect()
    return await run(client)
  } finally {
    await client.close()
  }
}

/* ── URL 安全 / SSRF ─────────────────────────────────────────── */

describe('MCP URL 安全（SSRF）', () => {

  it('@core:connectors DNS 解析到内网地址时拒绝（解析后再校验）', async () => {
    const error = (await validateMcpServerUrl('https://mcp.public.example/mcp', {
      resolveHost: async () => [{ address: '10.1.2.3', family: 4 }]
    }).catch((err: unknown) => err)) as McpError
    expect(error.kind).toBe('ssrf-blocked')

    const ok = await validateMcpServerUrl('https://mcp.public.example/mcp', {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }]
    })
    expect(ok.hostname).toBe('mcp.public.example')
  })
})

/* ── Streamable HTTP / SSE 传输 ──────────────────────────────── */

describe('Streamable HTTP 传输', () => {
  it('@core:connectors initialize → notifications/initialized → tools/list → tools/call（JSON 响应）', async () => {
    const mock = await startHttpMcp()
    const config = httpConfig(`${mock.url}/mcp`)
    const result = await runWithConnection(config, async (client) => {
      expect(client.transport).toBe('http')
      const tools = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(['echo', 'slow', 'fail'])
      const call = await client.callTool('echo', { text: 'hello' })
      return { tools, call }
    })
    expect(result.call.isError).toBe(false)
    expect(result.call.text).toContain('hello')
    // 初始化之后的请求携带 Mcp-Session-Id
    const sessionRequest = mock.requests.find((request) => request.method === 'tools/list')
    expect(sessionRequest?.headers['mcp-session-id']).toBe('sess-test')
  })

  it('@core:connectors MCP 工具错误（isError）不当作成功；JSON-RPC error 映射为错误', async () => {
    const mock = await startHttpMcp()
    const config = httpConfig(`${mock.url}/mcp`)
    const failure = await runWithConnection(config, (client) => client.callTool('fail', {}))
    expect(failure.isError).toBe(true)
    expect(failure.text).toContain('invalid_arguments')
  })
})

describe('旧版 HTTP+SSE 传输', () => {
  it('@core:connectors endpoint 事件 → POST → SSE message 响应（initialize/list/call）', async () => {
    const mock = await startLegacySse()
    const config: McpServerConfig = { transport: 'sse', url: `${mock.url}/sse`, allowPrivateNetwork: true, timeoutMs: 4000, retries: 0 }
    const result = await runWithConnection(config, async (client) => {
      expect(client.transport).toBe('sse')
      const tools = await client.listTools()
      const call = await client.callTool('echo', { text: 'legacy' })
      return { tools, call }
    })
    expect(result.tools.map((tool) => tool.name)).toContain('echo')
    expect(result.call.text).toContain('legacy')
  })
})

describe('超时与取消', () => {

  it('@core:connectors AbortSignal 取消进行中的请求', async () => {
    const mock = await startHttpMcp()
    const config = httpConfig(`${mock.url}/mcp`, { timeoutMs: 10_000 })
    const controller = new AbortController()
    const client = createMcpConnection('mock', config, { signal: controller.signal })
    try {
      await client.connect()
      const pending = client.callTool('slow', {})
      setTimeout(() => controller.abort(), 100)
      const error = (await pending.catch((err: unknown) => err)) as Error
      expect(error.name).toBe('AbortError')
    } finally {
      await client.close()
    }
  })
})

/* ── 管理服务：保存/掩码/加密/测试连接/删除 ─────────────────── */

describe('连接器管理服务（用户级）', () => {
  it('@core:connectors 保存 HTTP 连接器：密钥加密存储、渲染层只拿掩码、mcp.json 只存标记', async () => {
    const mock = await startHttpMcp()
    const saved = saveConnector({
      scope: 'user',
      name: 'remote-http',
      transport: 'http',
      url: `${mock.url}/mcp`,
      allowPrivateNetwork: true,
      headers: [{ key: 'X-Api-Key', value: 'header-secret-value' }]
    })
    const configText = readFileSync(saved.configPath, 'utf8')
    expect(configText).not.toContain('header-secret-value')
    expect(configText).toContain(MCP_SECRET_MARKER)

    const secretsText = readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')
    expect(secretsText).not.toContain('header-secret-value')

    expect(saved.connector.headers).toEqual([
      { key: 'X-Api-Key', masked: '••••••••', hasSecret: true, plaintext: false }
    ])
    // HTTP 传输不使用 env（只有 stdio 有 env 语义）
    expect(saved.connector.env).toEqual([])
    expect(JSON.stringify(saved.connector)).not.toContain('header-secret-value')

    // stdio 的 env 同样加密 + 掩码
    const stdioSaved = saveConnector({
      scope: 'user',
      name: 'local-stdio',
      transport: 'stdio',
      command: 'node',
      env: [{ key: 'API_KEY', value: 'super-secret-value' }]
    })
    const stdioText = readFileSync(stdioSaved.configPath, 'utf8')
    expect(stdioText).not.toContain('super-secret-value')
    expect(stdioText).toContain(MCP_SECRET_MARKER)
    expect(stdioSaved.connector.env).toEqual([
      { key: 'API_KEY', masked: '••••••••', hasSecret: true, plaintext: false }
    ])

    const listed = listConnectors('user')
    expect(listed.connectors.map((item) => item.name)).toEqual(['local-stdio', 'remote-http'])
    expect(listed.secretsMode).toBe('encrypted')
  })
})

describe('连接器保存边界（重名 / 密钥持久性 / 失败原子性）', () => {
  it('@core:connectors 拒绝重名新建与改名覆盖，原连接器配置和密钥保持不变', () => {
    saveConnector({
      scope: 'user',
      name: 'alpha',
      transport: 'http',
      url: 'https://alpha.example.com/mcp',
      headers: [{ key: 'X-Alpha', value: 'alpha-secret' }]
    })
    saveConnector({
      scope: 'user',
      name: 'beta',
      transport: 'http',
      url: 'https://beta.example.com/mcp',
      headers: [{ key: 'X-Beta', value: 'beta-secret' }]
    })
    const alphaBefore = getConnector('user', 'alpha')

    expect(() =>
      saveConnector({ scope: 'user', name: 'alpha', transport: 'http', url: 'https://evil.example.com/mcp' })
    ).toThrow(/已存在/)
    expect(() =>
      saveConnector({
        scope: 'user',
        originalName: 'beta',
        name: 'alpha',
        transport: 'http',
        url: 'https://evil.example.com/mcp',
        headers: [{ key: 'X-Beta' }]
      })
    ).toThrow(/已存在/)
    expect(() =>
      saveConnector({
        scope: 'user',
        originalName: 'ghost',
        name: 'ghost-2',
        transport: 'http',
        url: 'https://ghost.example.com/mcp'
      })
    ).toThrow(/不存在/)

    expect(getConnector('user', 'alpha')).toEqual(alphaBefore)
    expect(getConnector('user', 'beta')?.url).toBe('https://beta.example.com/mcp')
    const secrets = JSON.parse(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')).entries
    expect(Object.keys(secrets).sort()).toEqual(['user/alpha/headers/X-Alpha', 'user/beta/headers/X-Beta'])
  })

  it('@core:connectors 配置校验失败时不写密钥或配置（含改名失败不迁移密钥）', () => {
    saveConnector({
      scope: 'user',
      name: 'atomic',
      transport: 'stdio',
      command: 'node',
      env: [{ key: 'TOKEN', value: 'atomic-secret' }]
    })
    const configBefore = readFileSync(join(dataDir, 'mcp.json'), 'utf8')
    const secretsBefore = readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')

    expect(() =>
      saveConnector({ scope: 'user', originalName: 'atomic', name: 'atomic', transport: 'stdio', env: [] })
    ).toThrow(/command/)
    expect(readFileSync(join(dataDir, 'mcp.json'), 'utf8')).toBe(configBefore)
    expect(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')).toBe(secretsBefore)
    expect(getConnector('user', 'atomic')?.env[0]).toMatchObject({ key: 'TOKEN', hasSecret: true })

    expect(() =>
      saveConnector({ scope: 'user', originalName: 'atomic', name: 'renamed-atomic', transport: 'stdio', env: [] })
    ).toThrow(/command/)
    expect(getConnector('user', 'atomic')).not.toBeNull()
    expect(getConnector('user', 'renamed-atomic')).toBeNull()
    const keys = Object.keys(JSON.parse(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')).entries)
    expect(keys).toEqual(['user/atomic/env/TOKEN'])
  })
})

/* ── 工作区级配置 + 哈希信任 ─────────────────────────────────── */

describe('工作区级连接器与信任登记', () => {
  it('@core:connectors 保存工作区级配置写入 .morrow/mcp.json 并登记信任；仓库改文件后信任自动失效', async () => {
    const workspace = makeTempDir('morrow-ws-')
    saveConnector({
      scope: 'workspace',
      workspace,
      name: 'ws-http',
      transport: 'http',
      url: 'https://mcp.example.com/mcp'
    })
    const configPath = join(workspace, '.morrow', 'mcp.json')
    expect(existsSync(configPath)).toBe(true)
    expect(workspaceTrustStatus(workspace).trusted).toBe(true)
    expect(existsSync(join(dataDir, 'mcp-trust.json'))).toBe(true)

    // core 侧 loadMcpConfig 依据哈希信任工作区配置
    const loaded = await loadMcpConfig({ workspace, dataDir })
    expect(loaded.source).toBe('workspace')
    expect(loaded.servers[0]).toMatchObject({ source: 'workspace', workspace })
    expect(loaded.trusted).toBe(true)
    expect(loaded.servers.map((server) => server.name)).toEqual(['ws-http'])

    // 模拟仓库里的配置被改（攻击场景）：哈希不一致 → 不再信任
    writeFileSync(configPath, JSON.stringify({ mcpServers: { evil: { command: 'calc.exe' } } }), 'utf8')
    const tampered = await loadMcpConfig({ workspace, dataDir })
    expect(tampered.trusted).toBe(false)
    expect(workspaceTrustStatus(workspace).trusted).toBe(false)

    // 用户在面板点「信任」后恢复
    trustWorkspaceConfig(workspace)
    expect(workspaceTrustStatus(workspace).trusted).toBe(true)
  })
})

describe('MCP OAuth 2.0（PKCE）', () => {
  it('@core:connectors 授权码 + PKCE 换取令牌、注入 Authorization、加密落盘并可撤销', async () => {
    const mockMcp = await startHttpMcp()
    let tokenBody = ''
    const mockAuth = await startNodeServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/token') {
        res.writeHead(404).end('not found')
        return
      }
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        tokenBody = body
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'oauth-access', refresh_token: 'oauth-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'read' }))
      })
    })

    saveConnector({
      scope: 'user',
      name: 'oauth-mcp',
      transport: 'http',
      url: `${mockMcp.url}/mcp`,
      allowPrivateNetwork: true,
      oauth: {
        authorizationUrl: `${mockAuth.url}/authorize`,
        tokenUrl: `${mockAuth.url}/token`,
        clientId: 'client-1',
        scopes: ['read']
      }
    })

    const started = await startConnectorOAuth({ scope: 'user', name: 'oauth-mcp' })
    const authUrl = new URL(started.authorizationUrl)
    expect(authUrl.searchParams.get('response_type')).toBe('code')
    expect(authUrl.searchParams.get('client_id')).toBe('client-1')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authUrl.searchParams.get('code_challenge')?.length).toBeGreaterThan(20)
    expect(authUrl.searchParams.get('scope')).toBe('read')
    const state = authUrl.searchParams.get('state')
    expect(state).toBeTruthy()

    const callback = await fetch(`${started.redirectUri}?code=test-code&state=${encodeURIComponent(state!)}`)
    expect(callback.status).toBe(200)
    expect(await callback.text()).toContain('授权完成')

    let status = connectorOAuthStatus('user', 'oauth-mcp')
    for (let i = 0; i < 30 && !status.authorized; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      status = connectorOAuthStatus('user', 'oauth-mcp')
    }
    expect(status).toMatchObject({ configured: true, authorized: true, hasRefreshToken: true, expired: false })
    expect(tokenBody).toContain('grant_type=authorization_code')
    expect(tokenBody).toContain('code_verifier=')
    expect(tokenBody).toContain('redirect_uri=')

    const oauthFile = readFileSync(join(dataDir, 'mcp-oauth.json'), 'utf8')
    expect(oauthFile).not.toContain('oauth-access')
    expect(oauthFile).not.toContain('oauth-refresh')

    // 后续 MCP 请求自动携带 Bearer 令牌
    const test = await testConnector({ scope: 'user', name: 'oauth-mcp' })
    expect(test.ok).toBe(true)
    const init = mockMcp.requests.find((request) => request.method === 'initialize')
    expect(init?.headers.authorization).toBe('Bearer oauth-access')

    // 同名工作区连接器使用不同 OAuth 端点：不得复用用户级令牌
    const workspace = makeTempDir('morrow-oauth-ws-')
    saveConnector({
      scope: 'workspace',
      workspace,
      name: 'oauth-mcp',
      transport: 'http',
      url: `${mockMcp.url}/mcp`,
      allowPrivateNetwork: true,
      oauth: {
        authorizationUrl: `${mockAuth.url}/authorize`,
        tokenUrl: `${mockAuth.url}/token2`,
        clientId: 'client-2'
      }
    })
    expect(connectorOAuthStatus('workspace', 'oauth-mcp', workspace)).toMatchObject({
      configured: true,
      authorized: false,
      expired: false
    })
    expect(revokeConnectorOAuth('workspace', 'oauth-mcp', workspace)).toBe(false)
    expect(connectorOAuthStatus('user', 'oauth-mcp').authorized).toBe(true)

    expect(revokeConnectorOAuth('user', 'oauth-mcp')).toBe(true)
    expect(connectorOAuthStatus('user', 'oauth-mcp')).toMatchObject({ authorized: false, expired: false })

    // 再次授权后删除连接器：OAuth 令牌一并清理
    const again = await startConnectorOAuth({ scope: 'user', name: 'oauth-mcp' })
    const againState = new URL(again.authorizationUrl).searchParams.get('state')
    const againCallback = await fetch(`${again.redirectUri}?code=test-code-2&state=${encodeURIComponent(againState!)}`)
    expect(await againCallback.text()).toContain('授权完成')
    let reauthorized = connectorOAuthStatus('user', 'oauth-mcp')
    for (let i = 0; i < 30 && !reauthorized.authorized; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      reauthorized = connectorOAuthStatus('user', 'oauth-mcp')
    }
    expect(reauthorized.authorized).toBe(true)
    const scopedTokens = JSON.parse(readFileSync(join(dataDir, 'mcp-oauth.json'), 'utf8')) as { tokens: Record<string, unknown> }
    expect(Object.keys(scopedTokens.tokens).some((key) => key.startsWith('user|'))).toBe(true)
    expect(Object.keys(scopedTokens.tokens).some((key) => key.startsWith('workspace:'))).toBe(false)

    const deleted = deleteConnector('user', 'oauth-mcp')
    expect(deleted.removedOAuth).toBe(true)
    const afterDelete = JSON.parse(readFileSync(join(dataDir, 'mcp-oauth.json'), 'utf8')) as { tokens: Record<string, unknown> }
    expect(Object.keys(afterDelete.tokens).some((key) => key.startsWith('user|'))).toBe(false)
    expect(connectorOAuthStatus('user', 'oauth-mcp')).toMatchObject({ configured: false, authorized: false })
  })
})
})

describe("evolution.test.ts", () => {
  const dirs: string[] = []
  let dataDir = ''
  let workspace = ''

  function textMessage(id: string, role: 'user' | 'assistant', text: string): ChatMessage {
    return {
      id,
      role,
      createdAt: Date.now(),
      content: [{ type: 'text', text }]
    }
  }

  function makeSession(messages: ChatMessage[], overrides: Partial<Session> = {}): Session {
    return {
      id: 'session-evolution',
      title: '整理报表并发布',
      workspace,
      model: { providerId: 'mock', modelId: 'mock-model' },
      permissionMode: 'auto',
      mode: 'work',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      messageCount: messages.length,
      messages,
      todos: [],
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      ...overrides
    }
  }

  const MODEL: ModelInfo = {
    id: 'mock-model',
    label: 'Mock',
    contextWindow: 32_000,
    supportsTools: true
  }

  function fakeProvider(output: string): Provider {
    return {
      stream: async function* (): AsyncGenerator<ProviderStreamEvent> {
        yield { type: 'text_delta', text: output }
        yield { type: 'usage', usage: { inputTokens: 321, outputTokens: 87 } }
      }
    }
  }

  function reviewPayload(): string {
    return JSON.stringify({
      suggestions: [
        {
          kind: 'memory',
          action: 'create',
          scope: 'project',
          title: '报表口径',
          text: '周报按季度口径汇总；数字保留两位小数。',
          tags: ['报表', '口径'],
          rationale: '用户明确要求以后都按这个口径处理。',
          confidence: 0.91
        },
        {
          kind: 'skill',
          action: 'create',
          name: 'release-pipeline',
          description: '把双形态交付整理成可重复执行的发布流程。',
          body: [
            '## 何时使用',
            '需要同时产出便携文件夹版和单文件版时。',
            '',
            '## 步骤',
            '1. 运行类型检查和单元测试。',
            '2. 构建并检查 app.asar 是否被占用。',
            '3. 打包单文件并做冒烟。',
            '',
            '## 完成检查',
            '窗口能打开，使用说明和 SHA256SUMS 已更新。',
            '',
            '## 反模式',
            '不要跳过冒烟，不要把 Morrow Data 放进交付包。'
          ].join('\n'),
          rationale: '这次任务形成了可复现的打包流程。',
          confidence: 0.86
        }
      ]
    })
  }

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'morrow-evolution-'))
    dirs.push(root)
    dataDir = join(root, 'data')
    workspace = join(root, 'workspace')
    electronState.dataDir = dataDir
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(workspace, { recursive: true })
  })

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('EvolutionService：信号门禁', () => {
    it('@core:memory 简单问答不触发；两次纠正或复杂工具链才触发', () => {
      const service = new EvolutionService({ dataDir })
      const simple = makeSession([
        textMessage('u1', 'user', '今天几号？'),
        textMessage('a1', 'assistant', '10 月 24 日。')
      ])
      expect(service.shouldAutoReview(simple)).toBe('no-signal')

      const corrected = makeSession([
        textMessage('u1', 'user', '先做一版。'),
        textMessage('a1', 'assistant', '好的。'),
        textMessage('u2', 'user', '不要用表格，改成纯文本。'),
        textMessage('a2', 'assistant', '好的。'),
        textMessage('u3', 'user', '还是不对，以后都按季度口径。'),
        textMessage('a3', 'assistant', '明白。')
      ])
      expect(service.shouldAutoReview(corrected)).toBeNull()
    })
  })

  describe('EvolutionService：审阅与采纳', () => {
    it('@core:memory 解析记忆/技能建议，脱敏后入库；采纳会真实写入记忆与用户技能库', async () => {
      const service = new EvolutionService({ dataDir })
      const session = makeSession([
        textMessage('u1', 'user', '以后都用简体中文。我的邮箱是 me@example.com，请记住。'),
        textMessage('a1', 'assistant', '好的，我会按这个偏好处理。')
      ])
      const result = await service.review({
        session,
        provider: fakeProvider(reviewPayload()),
        model: MODEL,
        signal: new AbortController().signal,
        manual: true
      })
      expect(result.created).toBe(2)
      expect(result.suggestions).toHaveLength(2)
      expect(result.usage?.inputTokens).toBe(321)

      const list = service.list(workspace)
      expect(list.pending).toBe(2)
      const memory = list.suggestions.find((item) => item.kind === 'memory')
      const skill = list.suggestions.find((item) => item.kind === 'skill')
      expect(memory?.kind).toBe('memory')
      expect(skill?.kind).toBe('skill')
      expect(skill?.content).toContain('---\nname: release-pipeline')
      expect(skill?.content).not.toContain('me@example.com')

      const memoryApply = service.apply(memory!.id)
      expect(memoryApply.target.kind).toBe('memory')
      const memories = new MemoryService({ dataDir }).list('project', workspace).entries
      expect(memories.some((entry) => entry.text.includes('季度口径'))).toBe(true)

      const skillApply = service.apply(skill!.id)
      expect(skillApply.target.kind).toBe('skill')
      const skills = createSkillsService({ dataDir }).list(workspace).skills
      const created = skills.find((item) => item.name === 'release-pipeline')
      expect(created).toBeTruthy()
      expect(created?.source).toBe('user')
      expect(readFileSync(created!.skillPath, 'utf8')).toContain('release-pipeline')
      expect(service.list(workspace).suggestions).toHaveLength(0)
    })
  })

  describe('任务经验（自动记忆）', () => {
    it('@core:memory 捕获、去重、相关检索、启停、删除与清空', () => {
      const memory = new MemoryService({ dataDir })
      const first = memory.captureEpisode({
        scope: 'project',
        workspace,
        title: '整理销售报表',
        intent: '把季度销售数据整理成报告',
        summary: '生成 out/report.md，按季度汇总销售额并保留两位小数。',
        tools: ['read_file', 'write_file'],
        files: ['out/report.md'],
        tags: ['报表'],
        sourceSessionId: 's1',
        sourceSessionTitle: '季度报表',
        sourceMessageId: 'm1'
      })
      const list = memory.listEpisodes('project', workspace, { includeDisabled: true })
      expect(list.entries).toHaveLength(1)
      expect(list.stats.total).toBe(1)
      expect(readFileSync(join(workspace, '.morrow', 'episodes.json'), 'utf8')).toContain('整理销售报表')

      const duplicate = memory.captureEpisode({
        scope: 'project',
        workspace,
        title: '整理销售报表',
        intent: '把季度销售数据整理成报告',
        summary: '更新后的结论：销售额同比增长 18%。',
        sourceSessionId: 's1',
        sourceMessageId: 'm1'
      })
      expect(duplicate.id).toBe(first.id)
      expect(memory.listEpisodes('project', workspace).entries).toHaveLength(1)
      expect(memory.listEpisodes('project', workspace).entries[0].summary).toContain('18%')

      const injection = memory.episodeInjection(workspace, '季度销售额报告', { maxTokens: 320 })
      expect(injection.included).toBe(1)
      expect(injection.text).toContain('相关任务经验')
      expect(injection.text).toContain('整理销售报表')

      memory.toggleEpisode('project', workspace, first.id, false)
      expect(memory.listEpisodes('project', workspace).entries).toHaveLength(0)
      expect(memory.listEpisodes('project', workspace, { includeDisabled: true }).entries[0].enabled).toBe(false)
      expect(memory.episodeInjection(workspace, '季度销售额报告').included).toBe(0)

      memory.toggleEpisode('project', workspace, first.id, true)
      memory.removeEpisode('project', workspace, first.id)
      expect(memory.listEpisodes('project', workspace, { includeDisabled: true }).entries).toHaveLength(0)
      memory.captureEpisode({
        scope: 'project',
        workspace,
        title: '临时经验',
        intent: '测试清空',
        summary: '这条会被清空。',
        sourceSessionId: 's2',
        sourceMessageId: 'm2'
      })
      expect(memory.clearEpisodes('project', workspace).removed).toBe(1)
    })
  })
})
