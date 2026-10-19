/**
 * R10-D 记忆中心服务单测：
 * - 旧 `.morrow/MEMORY.md` 迁移（格式兼容 / 幂等 / 删除不复活 / 清空后新行才导入）；
 * - 项目 / 全局 scope 隔离；
 * - CRUD（添加/编辑/启停/删除/清空/搜索）；
 * - 注入过滤（只启用、项目优先、token 预算、disabled 不出现）；
 * - 导出（Markdown + JSON）；
 * - 边界（空文本/超长/非法 scope/损坏存储恢复）。
 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MEMORY_DEFAULT_INJECTION_TOKENS,
  MEMORY_LEGACY_FILE,
  MemoryService,
  getMemoryInjection,
  getMemoryPrompt,
  normalizeMemoryTags,
  parseLegacyMemory,
  sanitizeMemoryText,
  type MemoryEntry,
  type MemoryInjection,
  type MemoryListResult
} from '../../../src/main/services/memory-service'

/**
 * feature IPC 频道测试需要 import 主进程 feature 模块（它 import electron）。
 * 这里只 mock electron 的 app/dialog/ipcMain，服务本身仍是真实实现。
 */
const electronState = vi.hoisted(() => ({ dataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => electronState.dataDir },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

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
    const { dataDir, wsA } = makeRoot()
    electronState.dataDir = dataDir
    const featureModule = await import('../../../src/main/features/memory')
    const { invokeFeatureForTest, registerFeatureHandler } = await import('../../../src/main/feature-ipc')
    featureModule.registerMemoryFeature(registerFeatureHandler, { dataDir })
    expect(featureModule.MEMORY_FEATURE_CHANNELS.length).toBe(8)

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

    const unregistered = await invokeFeatureForTest('feature:memory:does-not-exist', {})
    expect(unregistered.ok).toBe(false)
    if (!unregistered.ok) expect(unregistered.error.code).toBe('FEATURE_CHANNEL')
  })
})
