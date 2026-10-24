/**
 * 合并后的 memory 组：记忆中心、Projects、MCP 连接器。
 * 每个原文件各自包在 describe('<原文件名>') 中。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_DEFAULT_INJECTION_TOKENS, MEMORY_LEGACY_FILE, MEMORY_STORE_FILE, MemoryService, getMemoryInjection, getMemoryPrompt, normalizeMemoryTags, parseLegacyMemory, sanitizeMemoryText, type MemoryEntry, type MemoryInjection, type MemoryListResult } from '../../../src/main/services/memory-service'
import { PROJECT_MAX_INSTRUCTIONS_CHARS, PROJECT_KNOWLEDGE_MAX_BYTES, ProjectService, configureProjectsRuntime, getProjectContext, getProjectPrompt, normalizeProjectWorkspace, type ProjectContext, type ProjectKnowledgeInfo, type ProjectRecord, type ProjectSummary } from '../../../src/main/services/project-service'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type Socket } from 'node:net'
import { type McpServerConfig, createMcpConnection, loadMcpConfig, McpError, MCP_SECRET_MARKER, normalizeMcpServerInput, validateMcpServerUrl } from '../../../src/core/tools/mcp-tools'
import { deleteConnector, getConnector, getConnectorPaths, installMcpRuntimeEnv, listConnectors, saveConnector, setConnectorEnabled, startConnectorOAuth, connectorOAuthStatus, revokeConnectorOAuth, setSecretCodecForTest, testConnector, trustWorkspaceConfig, workspaceTrustStatus } from '../../../src/main/services/mcp-service'
import { invokeFeatureForTest } from '../../../src/main/feature-ipc'
import { CONNECTOR_CHANNELS } from '../../../src/main/features/connectors'
import { CONNECTOR_CATALOG } from '../../../src/shared/connector-catalog'
import { buildLocalNpxInvocation } from '../../../src/shared/connector-catalog'

import type { ChatMessage, ModelInfo, Session } from "../../../src/shared/types"
import type { Provider, ProviderStreamEvent } from "../../../src/core/index"
import { EvolutionService } from "../../../src/main/services/evolution-service"
import { createSkillsService } from "../../../src/main/services/skills-service"

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

describe('记忆存储文件权限', () => {
  it.skipIf(process.platform === 'win32')('global.json 仅当前用户可读写', () => {
    const { dataDir } = makeRoot()
    const svc = service(dataDir)
    svc.add({ scope: 'global', text: '全局记忆' })
    expect(statSync(join(dataDir, 'memories', 'global.json')).mode & 0o777).toBe(0o600)
  })
})

describe('工作区 .morrow 目录边界', () => {
  it('junction/symlink 指向工作区外时拒绝读写项目记忆', () => {
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

describe('工作区记忆文件边界', () => {
  it('memories.json 软链接指向 .morrow 外时拒绝读写', () => {
    const { root, dataDir, wsA } = makeRoot()
    const outsideFile = join(root, 'outside-memories.json')
    writeFileSync(outsideFile, JSON.stringify({ version: 1, entries: [{ id: 'x', text: 'secret' }], legacySeen: [] }), 'utf8')
    const dir = join(wsA, '.morrow')
    mkdirSync(dir, { recursive: true })
    try {
      symlinkSync(outsideFile, join(dir, MEMORY_STORE_FILE), 'file')
    } catch {
      return // Windows 未开启开发者模式时无法创建文件链接
    }
    const svc = service(dataDir)
    expect(() => svc.list('project', wsA)).toThrow(/工作区外/)
    expect(() => svc.add({ scope: 'project', workspace: wsA, text: '不应写到链接目标' })).toThrow(/工作区外/)
    expect(readFileSync(outsideFile, 'utf8')).toContain('secret')
  })

  it('MEMORY.md 软链接指向 .morrow 外时拒绝迁移', () => {
    const { root, dataDir, wsA } = makeRoot()
    const outsideLegacy = join(root, 'outside-memory.md')
    writeFileSync(outsideLegacy, '- [2026-01-01] 工作区外的秘密\n', 'utf8')
    const dir = join(wsA, '.morrow')
    mkdirSync(dir, { recursive: true })
    try {
      symlinkSync(outsideLegacy, join(dir, MEMORY_LEGACY_FILE), 'file')
    } catch {
      return
    }
    const svc = service(dataDir)
    expect(() => svc.list('project', wsA)).toThrow(/工作区外/)
  })
})

describe('旧 MEMORY.md 迁移', () => {
  it('解析 remember 写出的格式（含无日期/星号行），迁移为结构化条目且不修改原文件', () => {
    const { dataDir, wsA } = makeRoot()
    const legacy = [
      '# Morrow 项目记忆',
      '',
      '> 由 Morrow 自动记录，下次对话会作为背景知识注入。',
      '',
      '- [2026-10-01] 用户偏好 CSV 输出',
      '- [2026-10-02] 项目代号 Cedar',
      '* 没有日期的老条目',
      '不是列表行的说明文字'
    ].join('\n')
    const legacyPath = seedLegacy(wsA, legacy)
    const before = readFileSync(legacyPath, 'utf8')

    const result = service(dataDir).list('project', wsA, { includeDisabled: true })
    expect(result.entries).toHaveLength(3)
    expect(result.entries.every((entry) => entry.source === 'migration')).toBe(true)
    expect(result.entries.every((entry) => entry.enabled)).toBe(true)
    expect(result.entries.map((entry) => entry.text)).toEqual(
      expect.arrayContaining(['用户偏好 CSV 输出', '项目代号 Cedar', '没有日期的老条目'])
    )
    const dated = result.entries.find((entry) => entry.text === '用户偏好 CSV 输出')!
    const datedLocal = new Date(dated.createdAt)
    expect(`${datedLocal.getFullYear()}-${String(datedLocal.getMonth() + 1).padStart(2, '0')}-${String(datedLocal.getDate()).padStart(2, '0')}`).toBe('2026-10-01')
    expect(result.stats.migratedTotal).toBe(3)
    expect(result.stats.legacyFileDetected).toBe(true)
    // 原文件保持不变（remember 工具格式不变）
    expect(readFileSync(legacyPath, 'utf8')).toBe(before)
  })

  it('重复读取不重复导入；删除迁移条目不复活；MEMORY.md 新增行仍会被导入', () => {
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

  it('清空后不会把旧行重新迁回；清空之后新增的旧行才导入', () => {
    const { dataDir, wsA } = makeRoot()
    const legacyPath = seedLegacy(wsA, '- [2026-10-01] 会被清空\n')
    const svc = service(dataDir)
    svc.list('project', wsA)
    expect(svc.clear('project', wsA).removed).toBe(1)
    expect(svc.list('project', wsA, { includeDisabled: true }).entries).toHaveLength(0)

    writeFileSync(legacyPath, '- [2026-10-01] 会被清空\n- [2026-10-05] 清空后的新记忆\n', 'utf8')
    const next = svc.list('project', wsA, { includeDisabled: true })
    expect(next.entries.map((entry) => entry.text)).toEqual(['清空后的新记忆'])
  })

  it('parseLegacyMemory 只接受列表行并去重', () => {
    const items = parseLegacyMemory(
      ['# 标题', '> 引用', '- [2026-01-01] AA', '- [2026-01-01] AA', '- BB', '* CC', ''].join('\n'),
      1_700_000_000_000
    )
    expect(items.map((item) => item.text)).toEqual(['AA', 'BB', 'CC'])
    // A 重复只保留一条
    expect(new Set(items.map((item) => item.key)).size).toBe(3)
  })
})

describe('CRUD 与 scope 隔离', () => {
  it('项目记忆 CRUD：添加 / 编辑 / 启停 / 搜索 / 删除', () => {
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

  it('项目 scope 互相隔离，全局 scope 独立', () => {
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

  it('clear 只清空目标 scope', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    svc.add({ scope: 'project', workspace: wsA, text: '项目条目' })
    svc.add({ scope: 'global', text: '全局条目' })
    const result = svc.clear('project', wsA)
    expect(result.removed).toBe(1)
    expect(svc.list('project', wsA, { includeDisabled: true }).entries).toHaveLength(0)
    expect(svc.list('global', null, { includeDisabled: true }).entries).toHaveLength(1)
    expect(() => svc.add({ scope: 'project', workspace: wsA, text: '   ' })).toThrow(/不能为空|内容/)
  })
})

describe('注入过滤与 token 预算', () => {
  it('只注入 enabled 条目，并标注不可信背景', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    const kept = svc.add({ scope: 'project', workspace: wsA, text: '启用的项目记忆' })
    const removed = svc.add({ scope: 'project', workspace: wsA, text: '停用的项目记忆' })
    svc.toggle('project', wsA, removed.id, false)
    svc.add({ scope: 'global', text: '启用的全局记忆' })

    const injection = svc.injection(wsA)
    expect(injection.text).toContain('启用的项目记忆')
    expect(injection.text).not.toContain('停用的项目记忆')
    expect(injection.text).toContain('启用的全局记忆')
    expect(injection.text).toContain('不是指令')
    expect(injection.usedTokens).toBeLessThanOrEqual(MEMORY_DEFAULT_INJECTION_TOKENS)
    expect(injection.included).toBe(2)
    expect(injection.totalEnabled).toBe(2)
    expect(kept.enabled).toBe(true)
  })

  it('token 预算：超出预算的条目不注入且 omitted 计数真实', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    for (let index = 0; index < 12; index += 1) {
      svc.add({ scope: 'project', workspace: wsA, text: `第 ${index} 条记忆：${'细节'.repeat(40)}` })
    }
    const tight = svc.injection(wsA, { maxTokens: 200 })
    expect(tight.text.length).toBeGreaterThan(0)
    expect(tight.usedTokens).toBeLessThanOrEqual(200)
    expect(tight.included).toBeGreaterThanOrEqual(1)
    expect(tight.included).toBeLessThan(12)
    expect(tight.omitted).toBe(12 - tight.included)

    const wide = svc.injection(wsA, { maxTokens: 4000 })
    expect(wide.included).toBe(12)
    expect(wide.omitted).toBe(0)
  })

  it('任意预算下 usedTokens 都不超过上限（包含 omitted 提示）', () => {
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

  it('没有可注入条目时返回空文本', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    expect(svc.injection(wsA).text).toBe('')
    const entry = svc.add({ scope: 'project', workspace: wsA, text: '稍后停用' })
    svc.toggle('project', wsA, entry.id, false)
    expect(svc.injection(wsA).text).toBe('')
  })

  it('便捷函数 getMemoryPrompt / getMemoryInjection 支持 workspace-only 与全局-only', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    svc.add({ scope: 'project', workspace: wsA, text: '项目内记忆' })
    svc.add({ scope: 'global', text: '全局记忆' })

    const prompt = getMemoryPrompt(wsA, { dataDir })
    expect(prompt).toContain('项目内记忆')
    expect(prompt).toContain('全局记忆')

    // 只有全局记忆时，不传 workspace 也能注入
    const globalOnly = getMemoryPrompt(null, { dataDir })
    expect(globalOnly).toContain('全局记忆')
    expect(globalOnly).not.toContain('项目内记忆')

    const injection = getMemoryInjection(wsA, { dataDir, maxTokens: 50 })
    // 50 token 连标题都放不下：诚实返回空注入，而不是塞一条超预算内容
    expect(injection.text).toBe('')
    expect(injection.usedTokens).toBe(0)
    expect(injection.omitted).toBeGreaterThan(0)
  })
})

describe('导出与边界', () => {
  it('导出 Markdown + JSON，空数据也能导出', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    svc.add({ scope: 'project', workspace: wsA, text: '导出用条目', tags: ['标签A'] })
    const result = svc.exportMemory('project', wsA)
    expect(result.count).toBe(1)
    expect(result.markdown).toContain('Morrow 记忆导出')
    expect(result.markdown).toContain('导出用条目')
    expect(result.fileName).toMatch(/morrow-memory-project-/)
    const parsed = JSON.parse(result.json) as { count: number; entries: Array<{ text: string; tags: string[] }> }
    expect(parsed.count).toBe(1)
    expect(parsed.entries[0].text).toBe('导出用条目')
    expect(parsed.entries[0].tags).toEqual(['标签A'])

    const empty = svc.exportMemory('global', null)
    expect(empty.count).toBe(0)
    expect(empty.markdown).toContain('没有记忆条目')
    expect(JSON.parse(empty.json).count).toBe(0)
  })

  it('输入校验：空文本 / 超长 / 非法标签 / 项目 scope 缺工作区', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    expect(() => sanitizeMemoryText('   ')).toThrow()
    expect(() => sanitizeMemoryText('x'.repeat(5000))).toThrow(/过长/)
    expect(() => normalizeMemoryTags(['x'.repeat(50)])).toThrow(/标签/)
    expect(() => svc.add({ scope: 'project', text: '缺工作区' })).toThrow(/工作区/)
    expect(() => svc.add({ scope: 'project', workspace: join(wsA, 'not-exist'), text: '坏工作区' })).toThrow(/工作区/)
    expect(() => svc.add({ scope: 'global', text: 'ok', tags: Array.from({ length: 12 }, (_, i) => `t${i}`) })).not.toThrow()
    const entry = svc.add({ scope: 'global', text: '标签上限', tags: Array.from({ length: 12 }, (_, i) => `t${i}`) })
    expect(entry.tags.length).toBeLessThanOrEqual(8)
  })

  it('损坏的 memories.json 会被备份并从空数据恢复', () => {
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

  it('全局存储写入 dataDir/memories/global.json，不落到工作区', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    svc.add({ scope: 'global', text: '全局落盘位置' })
    expect(existsSync(join(dataDir, 'memories', 'global.json'))).toBe(true)
    expect(existsSync(join(wsA, '.morrow', 'memories.json'))).toBe(false)
  })
})

describe('feature IPC 频道（feature:memory:*）', () => {
  it('注册后 add/list/toggle/injection/export 走真实服务，错误 payload 返回 ok=false', async () => {
    const { dataDir, wsA, wsB } = makeRoot()
    electronState.dataDir = dataDir
    const featureModule = await import('../../../src/main/features/memory')
    const { invokeFeatureForTest, registerFeatureHandler } = await import('../../../src/main/feature-ipc')
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

describe('项目 CRUD / 持久化 / 切换', () => {
  it('创建工作区项目：默认名称、指令/描述/知识文件、列表摘要', () => {
    const { dataDir, wsA } = makeRoot()
    seedWorkspace(wsA, { 'notes/brief.md': '# 项目背景\n必须使用简体中文。' })
    const svc = service(dataDir)
    const project = svc.create({
      workspace: wsA,
      description: '季度经营分析项目',
      instructions: '报告必须用简体中文；数字保留两位小数。',
      knowledgePaths: ['notes/brief.md'],
      pinned: true
    })
    expect(project.name).toBe('workspace-a')
    expect(project.workspace).toBe(normalizeProjectWorkspace(wsA))
    expect(project.knowledgePaths).toEqual(['notes/brief.md'])
    expect(project.pinned).toBe(true)
    expect(project.active).toBe(true)

    const list = svc.list()
    expect(list).toHaveLength(1)
    expect(list[0].workspaceExists).toBe(true)
    expect(list[0].knowledgeCount).toBe(1)

    // 新实例重新读盘（持久化）
    const reloaded = service(dataDir).getByWorkspace(wsA)
    expect(reloaded?.instructions).toContain('两位小数')
    expect(reloaded?.knowledgePaths).toEqual(['notes/brief.md'])
  })

  it('同一工作区不能建两个项目；不同工作区可以；删除后释放', () => {
    const { dataDir, wsA, wsB } = makeRoot()
    const svc = service(dataDir)
    const a = svc.create({ workspace: wsA, name: '项目 A' })
    svc.create({ workspace: wsB, name: '项目 B' })
    expect(() => svc.create({ workspace: wsA })).toThrow(/已经有项目/)
    expect(svc.list().map((project) => project.name).sort()).toEqual(['项目 A', '项目 B'])
    svc.remove(a.id)
    expect(svc.list()).toHaveLength(1)
    expect(() => svc.remove(a.id)).toThrow(/找不到/)
    // 删除后可以重新创建
    expect(svc.create({ workspace: wsA, name: '新 A' }).name).toBe('新 A')
  })

  it('更新 / 置顶 / 启用切换 / 输入校验', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    const project = svc.create({ workspace: wsA, name: '旧名字' })
    const updated = svc.update(project.id, {
      name: '新名字',
      description: '描述',
      instructions: '指令',
      pinned: true
    })
    expect(updated.name).toBe('新名字')
    expect(updated.pinned).toBe(true)
    expect(svc.list()[0].name).toBe('新名字')

    expect(svc.update(project.id, { active: false }).active).toBe(false)
    expect(svc.setActive(project.id, true).active).toBe(true)
    expect(svc.setPinned(project.id, false).pinned).toBe(false)

    expect(() => svc.update(project.id, { name: '   ' })).toThrow(/名称/)
    expect(() => svc.update(project.id, { instructions: 'x'.repeat(PROJECT_MAX_INSTRUCTIONS_CHARS + 1) })).toThrow(
      /过长/
    )
    expect(() => svc.update('proj_missing', { name: 'x' })).toThrow(/找不到/)
  })

  it('置顶项目排在列表最前', () => {
    const { dataDir, wsA, wsB } = makeRoot()
    const svc = service(dataDir)
    const a = svc.create({ workspace: wsA, name: '普通' })
    const b = svc.create({ workspace: wsB, name: '置顶' })
    svc.setPinned(b.id, true)
    expect(svc.list().map((project) => project.id)).toEqual([b.id, a.id])
  })
})

describe('项目存储文件权限', () => {
  it.skipIf(process.platform === 'win32')('projects.json 仅当前用户可读写', () => {
    const { dataDir, wsA } = makeRoot()
    service(dataDir).create({ workspace: wsA, name: '权限测试' })
    expect(statSync(join(dataDir, 'projects', 'projects.json')).mode & 0o777).toBe(0o600)
  })
})

describe('工作区边界与知识文件校验', () => {
  it('接受相对路径与工作区内绝对路径，统一存储为相对 POSIX 路径', () => {
    const { dataDir, wsA } = makeRoot()
    seedWorkspace(wsA, { 'a/one.md': 'one', 'b/two.csv': 'x,y\n1,2' })
    const svc = service(dataDir)
    const project = svc.create({
      workspace: wsA,
      knowledgePaths: ['a/one.md', join(wsA, 'b', 'two.csv')]
    })
    expect(project.knowledgePaths).toEqual(['a/one.md', 'b/two.csv'])
  })

  it('拒绝工作区外路径 / 相对越界 / 目录 / 非文本 / 超大文件 / .morrow 内部文件', () => {
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

  it('符号链接指向工作区外文件时拒绝（创建不了链接的环境跳过）', () => {
    const { dataDir, wsA, outside } = makeRoot()
    writeFileSync(join(outside, 'target.md'), 'outside target', 'utf8')
    let linked = false
    try {
      symlinkSync(join(outside, 'target.md'), join(wsA, 'link.md'), 'file')
      linked = true
    } catch {
      linked = false
    }
    if (!linked) return // Windows 未开启开发者模式时无法建符号链接
    const svc = service(dataDir)
    const project = svc.create({ workspace: wsA })
    expect(() => svc.update(project.id, { knowledgePaths: ['link.md'] })).toThrow(/工作区内/)
  })

  it('直接创建时也校验 knowledgePaths，非法路径不会落盘', () => {
    const { dataDir, wsA, outside } = makeRoot()
    writeFileSync(join(outside, 'x.md'), 'x', 'utf8')
    const svc = service(dataDir)
    expect(() => svc.create({ workspace: wsA, knowledgePaths: [join(outside, 'x.md')] })).toThrow(/工作区内/)
    expect(svc.list()).toHaveLength(0)
  })
})

describe('项目上下文生成与隔离', () => {
  it('生成指令 + 知识摘要 + 记忆；跨项目不泄漏', () => {
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

  it('未启用的项目不生成上下文；ignoreActive 仅供预览', () => {
    const { dataDir, wsA } = makeRoot()
    const svc = service(dataDir)
    const project = svc.create({ workspace: wsA, instructions: '启用后才注入' })
    svc.setActive(project.id, false)
    expect(svc.context(wsA)).toBeNull()
    const preview = svc.context(wsA, { ignoreActive: true })
    expect(preview).not.toBeNull()
    expect(preview!.text).toContain('启用后才注入')
  })

  it('知识文件被删除后：上下文跳过并列入 staleKnowledge，不泄漏旧内容，也不谎报“已截断”', () => {
    const { dataDir, wsA } = makeRoot()
    seedWorkspace(wsA, { 'gone.md': 'STALE_CANARY_CONTENT' })
    const svc = service(dataDir)
    const project = svc.create({ workspace: wsA, instructions: '指令', knowledgePaths: ['gone.md'] })
    unlinkSync(join(wsA, 'gone.md'))
    const context = svc.context(wsA)!
    expect(context.staleKnowledge.map((item) => item.path)).toContain('gone.md')
    expect(context.text).not.toContain('STALE_CANARY_CONTENT')
    expect(context.truncated).toBe(false)
    expect(context.project.id).toBe(project.id)
  })

  it('知识文件失效后仍能保存项目修改，并可移除失效资料；新增无效路径仍被拒绝', () => {
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

  it('工作区被移走后仍可编辑项目并移除资料，但不能新增资料', () => {
    const { dataDir, wsB } = makeRoot()
    seedWorkspace(wsB, { 'brief.md': 'brief' })
    const svc = service(dataDir)
    const project = svc.create({ workspace: wsB, knowledgePaths: ['brief.md'] })
    rmSync(wsB, { recursive: true, force: true })

    const renamed = svc.update(project.id, { name: '移动后的项目', knowledgePaths: ['brief.md'] })
    expect(renamed.name).toBe('移动后的项目')
    expect(renamed.knowledgePaths).toEqual(['brief.md'])

    const cleaned = svc.update(project.id, { knowledgePaths: [] })
    expect(cleaned.knowledgePaths).toEqual([])

    expect(() => svc.update(project.id, { knowledgePaths: ['brief.md'] })).toThrow(/工作区不存在/)
  })

  it('token 预算截断：超长指令/知识会被截断并如实标记', () => {
    const { dataDir, wsA } = makeRoot()
    seedWorkspace(wsA, {
      'long.md': '知识内容。'.repeat(1500),
      'second.md': '第二份知识。'.repeat(1500)
    })
    const svc = service(dataDir)
    const project = svc.create({
      workspace: wsA,
      instructions: '很长的指令。'.repeat(1000),
      knowledgePaths: ['long.md', 'second.md']
    })
    const context = svc.context(wsA, { maxTokens: 400 })!
    expect(context.usedTokens).toBeLessThanOrEqual(400)
    expect(context.truncated).toBe(true)
    expect(context.text.length).toBeLessThan(project.instructions.length)
    // 至少保留了指令或某一份知识之一
    expect(context.text).toContain('项目上下文')
  })

  it('超长描述也不会突破 token 预算；最小预算下仍保留标题', () => {
    const { dataDir, wsA } = makeRoot()
    seedWorkspace(wsA, { 'huge.md': '知识。'.repeat(4000) })
    const svc = service(dataDir)
    svc.create({
      workspace: wsA,
      name: '预算'.repeat(30),
      description: '描述。'.repeat(300),
      instructions: '指令。'.repeat(2000),
      knowledgePaths: ['huge.md']
    })
    for (const maxTokens of [128, 300, 8000]) {
      const context = svc.context(wsA, { maxTokens })!
      expect(context.usedTokens).toBeLessThanOrEqual(context.limitTokens)
      expect(context.text).toContain('项目上下文')
    }
    const tiny = svc.context(wsA, { maxTokens: 128 })!
    expect(tiny.truncated).toBe(true)
    expect(tiny.knowledge.length).toBe(0)
  })

  it('工作区被删除后：列表标记 workspaceExists=false，上下文返回 null', () => {
    const { dataDir, wsB } = makeRoot()
    const svc = service(dataDir)
    svc.create({ workspace: wsB })
    rmSync(wsB, { recursive: true, force: true })
    expect(svc.list()[0].workspaceExists).toBe(false)
    expect(svc.context(wsB)).toBeNull()
    expect(svc.getByWorkspace(wsB)).toBeNull()
  })

  it('损坏的 projects.json 会被备份并从空数据恢复', () => {
    const { dataDir, wsA } = makeRoot()
    mkdirSync(join(dataDir, 'projects'), { recursive: true })
    writeFileSync(join(dataDir, 'projects', 'projects.json'), 'not json at all', 'utf8')
    const svc = service(dataDir)
    expect(svc.list()).toHaveLength(0)
    expect(svc.create({ workspace: wsA }).workspace).toBe(normalizeProjectWorkspace(wsA))
  })
})

describe('Lead 集成入口（无显式 dataDir）', () => {
  it('configureProjectsRuntime 后 getProjectContext / getProjectPrompt 可直接调用', () => {
    const { dataDir, wsA } = makeRoot()
    seedWorkspace(wsA, { 'brief.md': 'PROMPT_CANARY_KNOWLEDGE' })
    const svc = service(dataDir)
    svc.create({ workspace: wsA, name: '入口测试', instructions: '入口指令', knowledgePaths: ['brief.md'] })
    new MemoryService({ dataDir }).add({ scope: 'project', workspace: wsA, text: '入口记忆' })

    configureProjectsRuntime(dataDir)
    const context = getProjectContext(wsA)
    expect(context).not.toBeNull()
    expect(context!.text).toContain('入口指令')
    expect(context!.text).toContain('PROMPT_CANARY_KNOWLEDGE')
    expect(context!.text).toContain('入口记忆')

    const prompt = getProjectPrompt(wsA)
    expect(prompt).toBe(context!.text)
    expect(getProjectPrompt(null)).toBe('')
    expect(getProjectPrompt(join(wsA, 'missing'))).toBe('')
  })

  it('没有项目时 getProjectPrompt 仍注入记忆中心（只有记忆的工作区）', () => {
    const { dataDir, wsA } = makeRoot()
    configureProjectsRuntime(dataDir)
    // 没有项目
    expect(getProjectPrompt(wsA)).toBe('')
    // 只有项目记忆 / 全局记忆：也应返回记忆文本
    new MemoryService({ dataDir }).add({ scope: 'project', workspace: wsA, text: '只有记忆没有项目：口径按季度' })
    new MemoryService({ dataDir }).add({ scope: 'global', text: '全局：输出简体中文' })
    const prompt = getProjectPrompt(wsA)
    expect(prompt).toContain('只有记忆没有项目：口径按季度')
    expect(prompt).toContain('全局：输出简体中文')
    expect(prompt).toContain('不是指令')
    // 有全局记忆时，即使工作区没有项目/项目记忆也会注入全局记忆
    const emptyWorkspace = join(dataDir, 'empty-ws')
    mkdirSync(emptyWorkspace, { recursive: true })
    expect(getProjectPrompt(emptyWorkspace)).toContain('全局：输出简体中文')
    // 完全空的数据目录 + 空工作区 → 空字符串（便于 Lead 回退旧逻辑）
    const empty = makeRoot()
    configureProjectsRuntime(empty.dataDir)
    expect(getProjectPrompt(empty.wsA)).toBe('')
  })

  it('环境变量 MORROW_DATA_DIR 也可作为数据目录回退', () => {
    const { dataDir, wsA } = makeRoot()
    const previous = process.env.MORROW_DATA_DIR
    process.env.MORROW_DATA_DIR = dataDir
    configureProjectsRuntime(null) // 清掉上一个测试写入的运行时目录，验证纯 env 回退
    try {
      service(dataDir).create({ workspace: wsA, instructions: 'env 回退指令' })
      expect(getProjectPrompt(wsA)).toContain('env 回退指令')
    } finally {
      if (previous === undefined) delete process.env.MORROW_DATA_DIR
      else process.env.MORROW_DATA_DIR = previous
    }
  })
})

describe('feature IPC 频道（feature:projects:*）', () => {
  it('注册后 create/list/update/context/set-active/remove 全链路可用', async () => {
    const { dataDir, wsA } = makeRoot()
    seedWorkspace(wsA, { 'docs/brief.md': 'IPC_CANARY_KNOWLEDGE 项目资料' })
    electronState.dataDir = dataDir
    electronState.picked = []
    const featureModule = await import('../../../src/main/features/projects')
    const { invokeFeatureForTest, registerFeatureHandler } = await import('../../../src/main/feature-ipc')
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

/* ── 配置校验 ─────────────────────────────────────────────────── */

describe('MCP 配置规范化与校验', () => {
  it('stdio 需要 command；http/sse 需要 url；transport 可从字段推断', () => {
    const missing = normalizeMcpServerInput('x', {})
    expect(missing.errors.join('；')).toContain('配置不完整')

    const stdio = normalizeMcpServerInput('local', { command: 'node', args: ['server.mjs'] })
    expect(stdio.errors).toEqual([])
    expect(stdio.config).toMatchObject({ transport: 'stdio', command: 'node', args: ['server.mjs'] })

    const http = normalizeMcpServerInput('remote', { url: 'https://mcp.example.com/mcp' })
    expect(http.errors).toEqual([])
    expect(http.config).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/mcp' })

    const sse = normalizeMcpServerInput('remote-sse', { type: 'sse', url: 'https://mcp.example.com/sse' })
    expect(sse.config).toMatchObject({ transport: 'sse' })
  })

  it('URL 协议白名单：file/javascript/data/ftp 一律拒绝', () => {
    for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'ftp://example.com/a']) {
      const result = normalizeMcpServerInput('bad', { transport: 'http', url })
      expect(result.config, url).toBeUndefined()
      expect(result.errors.join('；'), url).toMatch(/http|https|协议/)
    }
  })

  it('拒绝 URL 内嵌账号密码、非法 server 名、超范围 timeout/retries', () => {
    const userinfo = normalizeMcpServerInput('bad', { transport: 'http', url: 'https://user:pass@example.com/mcp' })
    expect(userinfo.errors.join('；')).toContain('用户名/密码')

    expect(normalizeMcpServerInput('bad name!', { command: 'node' }).errors.length).toBeGreaterThan(0)
    expect(normalizeMcpServerInput('x', { command: 'node', timeoutMs: 10 }).errors.join('；')).toContain('timeoutMs')
    expect(normalizeMcpServerInput('x', { command: 'node', retries: 9 }).errors.join('；')).toContain('retries')
    expect(normalizeMcpServerInput('x', { command: 'node', timeoutMs: 5000, retries: 1 }).config).toMatchObject({
      timeoutMs: 5000,
      retries: 1
    })
  })

  it('env/headers 键名与换行被过滤并给出警告；密钥标记作为普通字符串通过', () => {
    const result = normalizeMcpServerInput('x', {
      command: 'node',
      env: { OK_KEY: `${MCP_SECRET_MARKER}user/x/env/OK_KEY`, 'bad key': 'v', INJECT: 'a\r\nb' }
    })
    expect(result.errors).toEqual([])
    expect(result.config?.env).toMatchObject({ OK_KEY: `${MCP_SECRET_MARKER}user/x/env/OK_KEY` })
    expect(result.config?.env?.INJECT).toBeUndefined()
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})

/* ── URL 安全 / SSRF ─────────────────────────────────────────── */

describe('MCP URL 安全（SSRF）', () => {
  it('默认拒绝 localhost/回环/内网并给出明确提示', async () => {
    const error = (await validateMcpServerUrl('http://127.0.0.1:8787/mcp').catch((err: unknown) => err)) as McpError
    expect(error).toBeInstanceOf(McpError)
    expect(error.kind).toBe('ssrf-blocked')
    expect(error.message).toContain('本机/内网')
    expect(error.hint).toContain('允许访问本机/内网地址')

    for (const url of ['http://localhost:8787/mcp', 'http://10.0.0.8/mcp', 'http://192.168.1.20/mcp', 'http://[::1]:8787/mcp']) {
      const blocked = (await validateMcpServerUrl(url).catch((err: unknown) => err)) as McpError
      expect(blocked, url).toBeInstanceOf(McpError)
      expect(blocked.kind, url).toBe('ssrf-blocked')
    }
  })

  it('DNS 解析到内网地址时拒绝（解析后再校验）', async () => {
    const error = (await validateMcpServerUrl('https://mcp.public.example/mcp', {
      resolveHost: async () => [{ address: '10.1.2.3', family: 4 }]
    }).catch((err: unknown) => err)) as McpError
    expect(error.kind).toBe('ssrf-blocked')

    const ok = await validateMcpServerUrl('https://mcp.public.example/mcp', {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }]
    })
    expect(ok.hostname).toBe('mcp.public.example')
  })

  it('allowPrivateNetwork=true 时允许本机地址（用户显式信任），但协议仍白名单', async () => {
    const url = await validateMcpServerUrl('http://127.0.0.1:8787/mcp', { allowPrivateNetwork: true })
    expect(url.hostname).toBe('127.0.0.1')
    await expect(validateMcpServerUrl('file:///C:/x', { allowPrivateNetwork: true })).rejects.toMatchObject({ kind: 'config' })
    await expect(validateMcpServerUrl('javascript:alert(1)', { allowPrivateNetwork: true })).rejects.toMatchObject({ kind: 'config' })
  })

  it('未开 allowPrivateNetwork 时 HTTP 连接在发请求前就被拒绝', async () => {
    const mock = await startHttpMcp()
    const client = createMcpConnection('mock', httpConfig(`${mock.url}/mcp`, { allowPrivateNetwork: false }))
    try {
      await expect(client.connect()).rejects.toMatchObject({ kind: 'ssrf-blocked' })
      expect(mock.requests).toHaveLength(0)
    } finally {
      await client.close()
    }
  })
})

/* ── Streamable HTTP / SSE 传输 ──────────────────────────────── */

describe('Streamable HTTP 传输', () => {
  it('initialize → notifications/initialized → tools/list → tools/call（JSON 响应）', async () => {
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

  it('resources / prompts：列表、模板、读取与带参数获取', async () => {
    const mock = await startHttpMcp()
    const config = httpConfig(`${mock.url}/mcp`)
    await runWithConnection(config, async (client) => {
      const resources = await client.listResources()
      expect(resources.supported).toBe(true)
      expect(resources.resources[0]).toMatchObject({ uri: 'memo://notes/1', name: 'Notes' })
      expect(resources.templates[0]?.uriTemplate).toBe('memo://notes/{id}')
      const contents = await client.readResource('memo://notes/1')
      expect(contents[0]?.text).toBe('# Note')
      const prompts = await client.listPrompts()
      expect(prompts.supported).toBe(true)
      expect(prompts.prompts[0]).toMatchObject({ name: 'summarize' })
      const prompt = await client.getPrompt('summarize', { topic: 'MCP' })
      expect(prompt.messages[0]?.text).toBe('请总结：MCP')
    })
  })

  it('服务端用 SSE 返回 JSON-RPC 响应（Content-Type: text/event-stream）', async () => {
    const mock = await startHttpMcp({ sseResponses: true })
    const config = httpConfig(`${mock.url}/mcp`)
    const tools = await runWithConnection(config, (client) => client.listTools())
    expect(tools.map((tool) => tool.name)).toContain('echo')
  })

  it('MCP 工具错误（isError）不当作成功；JSON-RPC error 映射为错误', async () => {
    const mock = await startHttpMcp()
    const config = httpConfig(`${mock.url}/mcp`)
    const failure = await runWithConnection(config, (client) => client.callTool('fail', {}))
    expect(failure.isError).toBe(true)
    expect(failure.text).toContain('invalid_arguments')
  })

  it('401 返回可理解的 http-status 错误与鉴权提示', async () => {
    const mock = await startHttpMcp({ unauthorized: true })
    const client = createMcpConnection('mock', httpConfig(`${mock.url}/mcp`))
    try {
      const error = (await client.connect().catch((err: unknown) => err)) as McpError
      expect(error).toBeInstanceOf(McpError)
      expect(error.kind).toBe('http-status')
      expect(error.message).toContain('401')
      expect(error.hint).toContain('请求头')
    } finally {
      await client.close()
    }
  })

  it('服务器不可达时归类为 network 错误', async () => {
    const mock = await startHttpMcp()
    const deadUrl = `${mock.url}/mcp`
    await mock.close()
    servers.splice(servers.indexOf(mock), 1)
    const client = createMcpConnection('mock', httpConfig(deadUrl, { retries: 0 }))
    try {
      const error = (await client.connect().catch((err: unknown) => err)) as McpError
      expect(error).toBeInstanceOf(McpError)
      expect(error.kind).toBe('network')
    } finally {
      await client.close()
    }
  })
})

describe('旧版 HTTP+SSE 传输', () => {
  it('endpoint 事件 → POST → SSE message 响应（initialize/list/call）', async () => {
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
  it('工具调用超时 → timeout 错误（不会挂死）', async () => {
    const mock = await startHttpMcp()
    const config = httpConfig(`${mock.url}/mcp`, { timeoutMs: 500 })
    const started = Date.now()
    const error = (await runWithConnection(config, (client) => client.callTool('slow', {})).catch((err: unknown) => err)) as McpError
    expect(error).toBeInstanceOf(McpError)
    expect(error.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('AbortSignal 取消进行中的请求', async () => {
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

/* ── stdio 回归 ──────────────────────────────────────────────── */

const MOCK_STDIO_SOURCE = [
  "const readline = require('node:readline')",
  "const fs = require('node:fs')",
  "if (process.env.MOCK_STDIO_PID_FILE) fs.writeFileSync(process.env.MOCK_STDIO_PID_FILE, String(process.pid))",
  'const tools = [{ name: "echo", description: "回声", inputSchema: { type: "object", properties: { text: { type: "string" } } } }]',
  'function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }',
  "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
  '  let message; try { message = JSON.parse(line) } catch { return }',
  '  if (message.method === "initialize") { send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "mock-stdio", version: "1" } } }); return }',
  '  if (message.method === "notifications/initialized") return',
  '  if (message.method === "tools/list") { send({ jsonrpc: "2.0", id: message.id, result: { tools } }); return }',
  '  if (message.method === "tools/call") { send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(message.params.arguments || {}) }] } }); return }',
  '})',
  "process.on('SIGTERM', () => process.exit(0))"
].join('\n')

describe('stdio 回归', () => {
  it('stdio 连接仍可 initialize/list/call（R8 能力不回退）', async () => {
    const dir = makeTempDir()
    const scriptPath = join(dir, 'mock-stdio.cjs')
    writeFileSync(scriptPath, MOCK_STDIO_SOURCE, 'utf8')
    const config: McpServerConfig = {
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      timeoutMs: 5000
    }
    const result = await runWithConnection(config, async (client) => {
      expect(client.transport).toBe('stdio')
      const tools = await client.listTools()
      const call = await client.callTool('echo', { text: 'stdio-ok' })
      return { tools, call }
    })
    expect(result.tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(result.call.text).toContain('stdio-ok')
  })
})

/* ── 管理服务：保存/掩码/加密/测试连接/删除 ─────────────────── */

describe('连接器管理服务（用户级）', () => {
  it('保存 HTTP 连接器：密钥加密存储、渲染层只拿掩码、mcp.json 只存标记', async () => {
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

  it('测试连接：解密密钥后真实连接 mock server，返回工具列表', async () => {
    const mock = await startHttpMcp()
    saveConnector({
      scope: 'user',
      name: 'remote-http',
      transport: 'http',
      url: `${mock.url}/mcp`,
      allowPrivateNetwork: true,
      headers: [{ key: 'X-Api-Key', value: 'header-secret-value' }]
    })
    const result = await testConnector({ scope: 'user', name: 'remote-http' })
    expect(result.ok).toBe(true)
    expect(result.transport).toBe('http')
    expect(result.tools?.map((tool) => tool.name)).toContain('echo')
    const callRequest = mock.requests.find((request) => request.method === 'tools/list')
    expect(callRequest?.headers['x-api-key']).toBe('header-secret-value')
  })

  it('测试未保存草稿：不写盘；URL 被 SSRF 拒绝时返回 blockedReason', async () => {
    const draftResult = await testConnector({
      scope: 'user',
      draft: { name: 'draft-http', transport: 'http', url: 'http://127.0.0.1:9/mcp' }
    })
    expect(draftResult.ok).toBe(false)
    expect(draftResult.blockedReason).toBe('ssrf-blocked')
    expect(existsSync(join(dataDir, 'mcp.json'))).toBe(false)
  })

  it('启停、改名（密钥迁移）、删除（清理密钥）', async () => {
    const mock = await startHttpMcp()
    saveConnector({
      scope: 'user',
      name: 'rename-me',
      transport: 'http',
      url: `${mock.url}/mcp`,
      allowPrivateNetwork: true,
      headers: [{ key: 'X-Token', value: 'token-value' }]
    })
    const disabled = setConnectorEnabled('user', 'rename-me', false)
    expect(disabled.enabled).toBe(false)
    expect(JSON.parse(readFileSync(join(dataDir, 'mcp.json'), 'utf8')).mcpServers['rename-me'].disabled).toBe(true)

    // 改名：密钥 id 迁移（keep 旧字段），测试连接仍能解析
    const renamed = saveConnector({
      scope: 'user',
      originalName: 'rename-me',
      name: 'renamed',
      transport: 'http',
      url: `${mock.url}/mcp`,
      allowPrivateNetwork: true,
      headers: [{ key: 'X-Token' }]
    })
    expect(renamed.connector.name).toBe('renamed')
    expect(renamed.connector.headers[0]).toMatchObject({ key: 'X-Token', hasSecret: true })
    const result = await testConnector({ scope: 'user', name: 'renamed' })
    expect(result.ok).toBe(true)

    const removed = deleteConnector('user', 'renamed')
    expect(removed.deleted).toBe(true)
    expect(removed.removedSecrets).toBe(1)
    expect(getConnector('user', 'renamed')).toBeNull()
    const secrets = JSON.parse(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8'))
    expect(Object.keys(secrets.entries)).toHaveLength(0)
  })
})

describe('连接器保存边界（重名 / 密钥持久性 / 失败原子性）', () => {
  it('拒绝重名新建与改名覆盖，原连接器配置和密钥保持不变', () => {
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

  it('局部保存省略 env/headers 时保留已有密钥与启停状态；显式数组才增删/清空', () => {
    saveConnector({
      scope: 'user',
      name: 'partial',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      enabled: false,
      headers: [
        { key: 'A', value: 'a-secret' },
        { key: 'B', value: 'b-secret' }
      ]
    })

    const partial = saveConnector({
      scope: 'user',
      originalName: 'partial',
      name: 'partial',
      transport: 'http',
      url: 'https://mcp.example.com/mcp'
    })
    expect(partial.connector.headers.map((field) => field.key)).toEqual(['A', 'B'])
    expect(partial.connector.headers.every((field) => field.hasSecret)).toBe(true)
    expect(partial.connector.enabled).toBe(false)
    let keys = Object.keys(JSON.parse(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')).entries)
    expect(keys.sort()).toEqual(['user/partial/headers/A', 'user/partial/headers/B'])

    const one = saveConnector({
      scope: 'user',
      originalName: 'partial',
      name: 'partial',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: [{ key: 'A' }]
    })
    expect(one.connector.headers.map((field) => field.key)).toEqual(['A'])
    keys = Object.keys(JSON.parse(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')).entries)
    expect(keys).toEqual(['user/partial/headers/A'])

    const cleared = saveConnector({
      scope: 'user',
      originalName: 'partial',
      name: 'partial',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: []
    })
    expect(cleared.connector.headers).toEqual([])
    keys = Object.keys(JSON.parse(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')).entries)
    expect(keys).toEqual([])
  })

  it('配置校验失败时不写密钥或配置（含改名失败不迁移密钥）', () => {
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
  it('保存工作区级配置写入 .morrow/mcp.json 并登记信任；仓库改文件后信任自动失效', async () => {
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

  it('配置文件或密钥文件损坏时拒绝静默覆盖', () => {
    writeFileSync(join(dataDir, 'mcp.json'), '{ broken', 'utf8')
    expect(() => listConnectors('user')).toThrow(/不是合法 JSON/)
    expect(() => saveConnector({ scope: 'user', name: 'x', command: 'node' })).toThrow(/不是合法 JSON/)
    expect(readFileSync(join(dataDir, 'mcp.json'), 'utf8')).toBe('{ broken')

    writeFileSync(join(dataDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf8')
    writeFileSync(join(dataDir, 'mcp-secrets.json'), '{ broken', 'utf8')
    expect(() =>
      saveConnector({
        scope: 'user',
        name: 'x',
        command: 'node',
        env: [{ key: 'TOKEN', value: 'new-secret' }]
      })
    ).toThrow(/密钥文件已损坏/)
    expect(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')).toBe('{ broken')
  })

  it('工作区级操作缺少 workspace 时明确报错', () => {
    expect(() => saveConnector({ scope: 'workspace', name: 'x', transport: 'http', url: 'https://example.com/mcp' })).toThrow(/工作区/)
  })
})

/* ── feature IPC ─────────────────────────────────────────────── */

describe('feature:connectors:* IPC', () => {
  it('list/save/test/templates 走统一 Result 包装', async () => {
    const mock = await startHttpMcp()
    const empty = await invokeFeatureForTest(CONNECTOR_CHANNELS.list, { scope: 'user' })
    expect(empty.ok).toBe(true)
    expect((empty as { data: { connectors: unknown[] } }).data.connectors).toEqual([])

    const saved = await invokeFeatureForTest(CONNECTOR_CHANNELS.save, {
      scope: 'user',
      name: 'ipc-http',
      transport: 'http',
      url: `${mock.url}/mcp`,
      allowPrivateNetwork: true
    })
    expect(saved.ok).toBe(true)

    const testResult = await invokeFeatureForTest(CONNECTOR_CHANNELS.test, { scope: 'user', name: 'ipc-http' })
    expect(testResult.ok).toBe(true)
    expect((testResult as { data: { ok: boolean; tools: unknown[] } }).data.ok).toBe(true)
    expect((testResult as { data: { tools: unknown[] } }).data.tools.length).toBeGreaterThan(0)

    const enabled = await invokeFeatureForTest(CONNECTOR_CHANNELS.setEnabled, {
      scope: 'user',
      name: 'ipc-http',
      enabled: false
    })
    expect(enabled.ok).toBe(true)
  })

  it('非法参数被边界校验拦下（不把任意对象透传给服务层）', async () => {
    const badName = await invokeFeatureForTest(CONNECTOR_CHANNELS.get, { scope: 'user' })
    expect(badName.ok).toBe(false)

    const badTransport = await invokeFeatureForTest(CONNECTOR_CHANNELS.save, {
      scope: 'user',
      name: 'x',
      transport: 'ftp'
    })
    expect(badTransport.ok).toBe(false)

    const missingWorkspace = await invokeFeatureForTest(CONNECTOR_CHANNELS.list, { scope: 'workspace' })
    expect(missingWorkspace.ok).toBe(false)

    const unregistered = await invokeFeatureForTest(CONNECTOR_CHANNELS.list, {
      scope: 'workspace',
      workspace: makeTempDir('morrow-unregistered-')
    })
    expect(unregistered.ok).toBe(false)
    expect((unregistered as { error: { message: string } }).error.message).toContain('已登记')

    const notObject = await invokeFeatureForTest(CONNECTOR_CHANNELS.list, 'not-an-object')
    expect(notObject.ok).toBe(false)
  })

  it('连接器目录可读取且条目完整；paths/secretStatus 可用', async () => {
    const catalog = await invokeFeatureForTest(CONNECTOR_CHANNELS.catalog, {})
    expect(catalog.ok).toBe(true)
    const entries = (catalog as { data: { entries: Array<{ id: string; name: string; transport: string; requiresNpx: boolean; docsUrl: string }> } }).data.entries
    expect(entries.length).toBeGreaterThanOrEqual(8)
    expect(entries.every((entry) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(entry.name))).toBe(true)
    expect(entries.every((entry) => entry.docsUrl.startsWith('https://'))).toBe(true)
    expect(entries.filter((entry) => entry.transport === 'stdio').every((entry) => entry.requiresNpx)).toBe(true)

    // 目录常量本身必须自洽：名称唯一、远程有 https 地址、本机有包名、密钥字段有落点
    expect(new Set(CONNECTOR_CATALOG.map((entry) => entry.id)).size).toBe(CONNECTOR_CATALOG.length)
    expect(new Set(CONNECTOR_CATALOG.map((entry) => entry.name)).size).toBe(CONNECTOR_CATALOG.length)
    for (const entry of CONNECTOR_CATALOG) {
      expect(entry.timeoutMs).toBeGreaterThanOrEqual(1_000)
      expect(entry.docsUrl.startsWith('https://')).toBe(true)
      if (entry.requiresToken) {
        expect(Boolean(entry.headerKey || entry.envKey)).toBe(true)
        expect(entry.requiresNpx).toBe(Boolean(entry.envKey))
      }
      if (entry.category === 'remote') {
        expect(entry.transport).toBe('http')
        expect(entry.url).toMatch(/^https:\/\//)
        expect(entry.requiresNpx).toBe(false)
        expect(entry.packageArgs).toBeUndefined()
      } else {
        expect(entry.transport).toBe('stdio')
        expect(entry.requiresNpx).toBe(true)
        expect(entry.packageArgs?.length).toBeGreaterThan(0)
      }
      if (entry.requiresFolder) {
        expect(entry.name).toBe('filesystem')
        expect(entry.requiresToken).toBe(false)
      }
    }

    // Windows 的 npx 必须经 cmd.exe，并给含空格的文件夹加引号
    const winInvocation = buildLocalNpxInvocation(
      ['@modelcontextprotocol/server-filesystem'],
      'C:\\My Files\\项目',
      'win32',
      'C:\\Windows\\System32\\cmd.exe'
    )
    expect(winInvocation.command).toContain('cmd.exe')
    expect(winInvocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(winInvocation.args[3]).toContain('"C:\\My Files\\项目"')
    const posixInvocation = buildLocalNpxInvocation(['@modelcontextprotocol/server-filesystem'], '/tmp/My Files', 'linux')
    expect(posixInvocation).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/My Files']
    })

    const badForce = await invokeFeatureForTest(CONNECTOR_CHANNELS.runtime, { force: 'yes' })
    expect(badForce.ok).toBe(false)

    const paths = getConnectorPaths('/tmp/some-workspace')
    expect(paths.userConfigPath).toContain('mcp.json')
    expect(paths.secretsPath).toContain('mcp-secrets.json')
    expect(paths.workspaceConfigPath).toContain('.morrow')

    const status = await invokeFeatureForTest(CONNECTOR_CHANNELS.secretStatus, {})
    expect(status.ok).toBe(true)
    expect((status as { data: { mode: string } }).data.mode).toBe('encrypted')
  })
})

/* ── 密钥加密回退 ───────────────────────────────────────────── */

describe('密钥存储模式', () => {
  it('safeStorage 不可用时降级为明文回退并明确标记模式', () => {
    setSecretCodecForTest({
      mode: 'plaintext-fallback',
      encrypt: (plaintext: string) => `plain:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
      decrypt: (payload: string) =>
        payload.startsWith('plain:') ? Buffer.from(payload.slice(6), 'base64').toString('utf8') : null
    })
    const saved = saveConnector({
      scope: 'user',
      name: 'fallback',
      command: 'node',
      env: [{ key: 'TOKEN', value: 'fallback-secret' }]
    })
    expect(saved.secretStorage).toBe('plaintext-fallback')
    expect(saved.connector.secretStorage).toBe('plaintext-fallback')
    const secretsText = readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')
    expect(secretsText).not.toContain('fallback-secret')
  })
})

describe('MCP OAuth 2.0（PKCE）', () => {
  it('授权码 + PKCE 换取令牌、注入 Authorization、加密落盘并可撤销', async () => {
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
    it('简单问答不触发；两次纠正或复杂工具链才触发', () => {
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

    it('同一会话复盘后进入冷却；临时/演示对话直接跳过', async () => {
      const service = new EvolutionService({ dataDir })
      const session = makeSession([
        textMessage('u1', 'user', '以后都用简体中文。'),
        textMessage('a1', 'assistant', '好。')
      ])
      expect(service.shouldAutoReview({ ...session, temporary: true })).toBe('temporary')
      expect(service.shouldAutoReview({ ...session, demo: true })).toBe('demo')
      await service.review({
        session,
        provider: fakeProvider(reviewPayload()),
        model: MODEL,
        signal: new AbortController().signal,
        manual: true
      })
      expect(service.shouldAutoReview(session)).toBe('cooldown')
    })
  })

  describe('EvolutionService：审阅与采纳', () => {
    it('解析记忆/技能建议，脱敏后入库；采纳会真实写入记忆与用户技能库', async () => {
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

    it('忽略建议后不再显示；过期建议会被清理', async () => {
      let now = 1_700_000_000_000
      const service = new EvolutionService({ dataDir, now: () => now })
      const session = makeSession([
        textMessage('u1', 'user', '记住这个偏好。'),
        textMessage('a1', 'assistant', '好。')
      ])
      const result = await service.review({
        session,
        provider: fakeProvider(reviewPayload()),
        model: MODEL,
        signal: new AbortController().signal,
        manual: true
      })
      const first = result.suggestions[0]
      service.ignore(first.id)
      expect(service.list(workspace).suggestions).toHaveLength(1)

      now += 15 * 24 * 60 * 60 * 1000
      expect(service.list(workspace).suggestions).toHaveLength(0)
    })

    it('采纳 update 技能时只替换 SKILL.md，不新建同名技能', async () => {
      const service = new EvolutionService({ dataDir })
      const skillsService = createSkillsService({ dataDir })
      const created = skillsService.createUserSkill({
        name: 'release-pipeline',
        description: '旧描述',
        markdown: '## 旧流程\n\n1. 运行检查。\n2. 打包。\n3. 冒烟。\n\n## 完成检查\n窗口能打开，校验和一致。'
      })
      const session = makeSession([
        textMessage('u1', 'user', '以后都用这个发布流程。'),
        textMessage('a1', 'assistant', '好。')
      ])
      const payload = JSON.stringify({
        suggestions: [
          {
            kind: 'skill',
            action: 'update',
            name: 'release-pipeline',
            targetId: created.id,
            description: '新版发布流程',
            body: '## 新流程\n\n1. 先跑类型检查。\n2. 再跑单元与冒烟。\n3. 最后核对 SHA256SUMS。\n\n## 完成检查\n窗口能打开，交付目录没有运行时缓存。\n\n## 反模式\n不要跳过冒烟。',
            rationale: '用户确认以后都这样做。',
            confidence: 0.9
          }
        ]
      })
      const result = await service.review({
        session,
        provider: fakeProvider(payload),
        model: MODEL,
        signal: new AbortController().signal,
        manual: true
      })
      expect(result.suggestions[0].action).toBe('update')
      const applied = service.apply(result.suggestions[0].id)
      expect(applied.target.id).toBe(created.id)
      const skills = createSkillsService({ dataDir }).list(workspace).skills.filter(
        (skill) => skill.name === 'release-pipeline'
      )
      expect(skills).toHaveLength(1)
      expect(skills[0].description).toContain('新版发布流程')
      expect(readFileSync(skills[0].skillPath, 'utf8')).toContain('## 新流程')
    })

    it('建议正文会沿用会话中的敏感值脱敏', async () => {
      const service = new EvolutionService({ dataDir })
      const session = makeSession([
        textMessage('u1', 'user', '联系邮箱 me@example.com，以后都按这个来。'),
        textMessage('a1', 'assistant', '好。')
      ])
      const payload = JSON.stringify({
        suggestions: [
          {
            kind: 'memory',
            action: 'create',
            scope: 'global',
            title: '联系邮箱',
            text: '默认联系邮箱是 me@example.com。',
            tags: [],
            rationale: '用户给了长期偏好。',
            confidence: 0.9
          }
        ]
      })
      const result = await service.review({
        session,
        provider: fakeProvider(payload),
        model: MODEL,
        signal: new AbortController().signal,
        manual: true
      })
      expect(result.suggestions).toHaveLength(1)
      expect(result.suggestions[0].content).toContain('[REDACTED]')
      expect(result.suggestions[0].content).not.toContain('me@example.com')
    })

    it('已有记忆完全相同时不重复建议', async () => {
      const service = new EvolutionService({ dataDir })
      new MemoryService({ dataDir }).add({
        scope: 'project',
        workspace,
        text: '周报按季度口径汇总；数字保留两位小数。',
        source: 'user'
      })
      const session = makeSession([
        textMessage('u1', 'user', '记住这个口径。'),
        textMessage('a1', 'assistant', '好。')
      ])
      const result = await service.review({
        session,
        provider: fakeProvider(reviewPayload()),
        model: MODEL,
        signal: new AbortController().signal,
        manual: true
      })
      expect(result.suggestions.some((item) => item.kind === 'memory')).toBe(false)
      expect(result.suggestions.some((item) => item.kind === 'skill')).toBe(true)
    })
  })

  describe('EvolutionService：存储边界', () => {
    it('损坏的建议文件不会阻塞记忆中心', () => {
      const service = new EvolutionService({ dataDir })
      const path = service.storePath()
      mkdirSync(join(dataDir, 'evolution'), { recursive: true })
      writeFileSync(path, '{not-json', 'utf8')
      expect(() => service.list(null)).not.toThrow()
      expect(service.list(null).suggestions).toEqual([])
    })
  })

  describe('任务经验（自动记忆）', () => {
    it('捕获、去重、相关检索、启停、删除与清空', () => {
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

    it('没有工作区时写入全局任务经验，不会伪造项目路径', () => {
      const memory = new MemoryService({ dataDir })
      memory.captureEpisode({
        scope: 'global',
        title: '用户级整理',
        intent: '整理下载目录',
        summary: '生成了文件清单。',
        sourceSessionId: 's3',
        sourceMessageId: 'm3'
      })
      expect(memory.listEpisodes('global', null).entries[0].scope).toBe('global')
      expect(readFileSync(join(dataDir, 'episodes', 'global.json'), 'utf8')).toContain('用户级整理')
    })
  })
})
