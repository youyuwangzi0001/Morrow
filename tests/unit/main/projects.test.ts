/**
 * R10-E Projects 服务单测：
 * - 每工作区一个项目：CRUD / 持久化 / 置顶 / 启用切换；
 * - 跨项目隔离：A 的上下文不出现 B 的指令或知识；
 * - 工作区边界：相对路径越界、工作区外绝对路径、目录、非文本、超大文件都被拒绝；
 * - 上下文生成：指令 + 知识摘要 + 记忆中心；未启用项目不生成；失效知识文件被跳过；
 * - token 预算截断与 `getProjectPrompt()` 集成入口。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROJECT_MAX_INSTRUCTIONS_CHARS,
  PROJECT_KNOWLEDGE_MAX_BYTES,
  ProjectService,
  configureProjectsRuntime,
  getProjectContext,
  getProjectPrompt,
  normalizeProjectWorkspace,
  type ProjectContext,
  type ProjectKnowledgeInfo,
  type ProjectRecord,
  type ProjectSummary
} from '../../../src/main/services/project-service'
import { MemoryService } from '../../../src/main/services/memory-service'

/** feature IPC 频道测试需要 mock electron（服务本身仍是真实实现） */
const electronState = vi.hoisted(() => ({ dataDir: '', picked: [] as string[] }))
vi.mock('electron', () => ({
  app: { getPath: () => electronState.dataDir },
  dialog: {
    showOpenDialog: async () => ({
      canceled: electronState.picked.length === 0,
      filePaths: electronState.picked.slice()
    })
  },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

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

  it('知识文件被删除后：上下文跳过并列入 staleKnowledge，不泄漏旧内容', () => {
    const { dataDir, wsA } = makeRoot()
    seedWorkspace(wsA, { 'gone.md': 'STALE_CANARY_CONTENT' })
    const svc = service(dataDir)
    const project = svc.create({ workspace: wsA, instructions: '指令', knowledgePaths: ['gone.md'] })
    unlinkSync(join(wsA, 'gone.md'))
    const context = svc.context(wsA)!
    expect(context.staleKnowledge.map((item) => item.path)).toContain('gone.md')
    expect(context.text).not.toContain('STALE_CANARY_CONTENT')
    expect(context.truncated).toBe(true)
    expect(context.project.id).toBe(project.id)
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
