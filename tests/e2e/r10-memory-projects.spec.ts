/**
 * R10-D/E 记忆中心 + Projects E2E —— 真实 Electron（真实 preload → feature IPC → 主进程服务 → 磁盘）。
 *
 * 覆盖：
 * 1. 旧 `.morrow/MEMORY.md` 在真实应用里自动迁移（幂等），项目/全局记忆 CRUD、启停过滤、搜索、导出、
 *    注入预览（只含启用条目 + token 预算）全部通过 `window.morrow.features.invoke('feature:memory:*')` 验证；
 * 2. 项目 CRUD/指令/知识文件、工作区边界（越界路径被真实主进程拒绝）、上下文生成（指令+知识+记忆）与跨项目隔离；
 * 3. 关闭应用后用同一 `--data-dir` 重启：记忆与项目仍在（会话文件与项目 JSON 落盘）。
 *
 * 不依赖面板挂载（Lead 在 App 里挂载后，可由 r10 验收补 UI 截图）；本 spec 验证的是产品真实数据链路。
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  dismissOnboarding,
  installEventCollector,
  sendMessageViaStore,
  setThemeViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

type FeatureResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

interface MemoryEntryWire {
  id: string
  text: string
  tags: string[]
  source: string
  enabled: boolean
  scope: string
  workspace: string | null
}

interface MemoryListWire {
  entries: MemoryEntryWire[]
  stats: {
    total: number
    enabled: number
    disabled: number
    enabledTokens: number
    limitTokens: number
    migratedTotal: number
    legacyFileDetected: boolean
  }
}

interface MemoryInjectionWire {
  text: string
  usedTokens: number
  limitTokens: number
  included: number
  omitted: number
}

interface ProjectRecordWire {
  id: string
  workspace: string
  name: string
  instructions: string
  knowledgePaths: string[]
  active: boolean
  pinned: boolean
}

interface ProjectListWire {
  projects: Array<ProjectRecordWire & { workspaceExists: boolean; knowledgeCount: number }>
}

interface ProjectContextWire {
  text: string
  projectText: string
  memoryText: string
  knowledge: Array<{ path: string; excerpt?: string }>
  staleKnowledge: Array<{ path: string; error: string }>
  memory: { included: number } | null
  usedTokens: number
  limitTokens: number
  truncated: boolean
}

interface FeatureInvoker {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<FeatureResult<T>>
}

async function feature<T = unknown>(
  page: import('@playwright/test').Page,
  channel: string,
  payload?: unknown
): Promise<T> {
  const result = await page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      const api = (window as unknown as { morrow: { features: FeatureInvoker } }).morrow.features
      return api.invoke<T>(arg.channel, arg.payload)
    },
    { channel, payload }
  )
  if (!result.ok) throw new Error(`${channel} 失败：${result.error.code} ${result.error.message}`)
  return result.data
}

async function featureRaw<T = unknown>(
  page: import('@playwright/test').Page,
  channel: string,
  payload?: unknown
): Promise<FeatureResult<T>> {
  return page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      const api = (window as unknown as { morrow: { features: FeatureInvoker } }).morrow.features
      return api.invoke<T>(arg.channel, arg.payload)
    },
    { channel, payload }
  )
}

function seedLegacyMemory(workspace: string): void {
  const dir = join(workspace, '.morrow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'MEMORY.md'),
    [
      '# Morrow 项目记忆',
      '',
      '> 由 Morrow 自动记录，下次对话会作为背景知识注入。',
      '',
      '- [2026-10-01] E2E 迁移记忆：周报按季度口径汇总',
      '- [2026-10-02] E2E 迁移记忆：金额保留两位小数'
    ].join('\n'),
    'utf8'
  )
}

/** 通过工作台事件直接打开面板（与 TitleBar 扳手菜单等效，均为 Lead 挂载的真实组件） */
async function openWorkbenchPanel(
  page: import('@playwright/test').Page,
  panel: 'memory' | 'projects'
): Promise<void> {
  await page.evaluate((name: string) => {
    window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: name } }))
  }, panel)
}

async function setLastWorkspaceViaStore(page: import('@playwright/test').Page, workspace: string): Promise<void> {
  await page.evaluate(async (path: string) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    await store.getState().updateSettings({ lastWorkspace: path })
  }, workspace)
}

test.describe('R10-D/E 记忆中心与 Projects', () => {
  test('迁移/CRUD/启停注入 + 项目 CRUD/隔离/上下文 + 重启持久化', async () => {
    test.setTimeout(300_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r10-memproj-ws-${stamp}`)
    const workspaceB = join(root, 'tmp', `r10-memproj-ws-b-${stamp}`)
    const outside = join(root, 'tmp', `r10-memproj-outside-${stamp}`)
    for (const dir of [workspace, workspaceB, outside]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(workspace, 'docs-brief.md'), '# 项目资料\nCANARY_A_KNOWLEDGE：A 项目专属资料。', 'utf8')
    writeFileSync(join(workspace, 'numbers.csv'), 'quarter,sales\nQ3,123', 'utf8')
    writeFileSync(join(workspaceB, 'brief.md'), 'CANARY_B_KNOWLEDGE：B 项目专属资料。', 'utf8')
    writeFileSync(join(outside, 'secret.md'), 'OUTSIDE_CANARY：工作区外文件。', 'utf8')
    seedLegacyMemory(workspace)

    const dataDir = join(root, 'tmp', `r10-memproj-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r10-memproj-chromium-${stamp}`)

    let projectAId = ''
    const first = await launchMorrow({ name: 'r10-memproj-1', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = first
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      // 记忆 IPC 只接受已登记工作区；模拟用户已选择这个文件夹
      await setLastWorkspaceViaStore(page, workspace)

      /* ── 1) 旧 MEMORY.md 迁移 + scope 隔离 ── */
      const migrated = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        includeDisabled: true
      })
      expect(migrated.entries.length).toBe(2)
      expect(migrated.entries.every((entry) => entry.source === 'migration')).toBe(true)
      expect(migrated.stats.migratedTotal).toBe(2)
      expect(migrated.stats.legacyFileDetected).toBe(true)

      const globalEmpty = await feature<MemoryListWire>(page, 'feature:memory:list', { scope: 'global' })
      expect(globalEmpty.entries.length).toBe(0)

      /* ── 2) CRUD：项目记忆 / 全局记忆 / 启停 / 搜索 / 更新 ── */
      const projectEntry = await feature<{ entry: MemoryEntryWire }>(page, 'feature:memory:add', {
        scope: 'project',
        workspace,
        text: 'E2E 项目记忆：报告标题使用「季度经营分析」',
        tags: ['报告', '标题']
      })
      const globalEntry = await feature<{ entry: MemoryEntryWire }>(page, 'feature:memory:add', {
        scope: 'global',
        text: 'E2E 全局记忆：始终使用简体中文',
        tags: ['语言']
      })
      expect(projectEntry.entry.scope).toBe('project')
      expect(globalEntry.entry.scope).toBe('global')

      // 未登记的同级目录不能作为项目记忆工作区（防止向任意目录写 .morrow）
      const unregisteredAdd = await featureRaw(page, 'feature:memory:add', {
        scope: 'project',
        workspace: outside,
        text: '不应写入未登记工作区'
      })
      expect(unregisteredAdd.ok).toBe(false)
      expect(unregisteredAdd.error?.message).toContain('已登记')
      const unregisteredInjection = await featureRaw(page, 'feature:memory:injection', { workspace: outside })
      expect(unregisteredInjection.ok).toBe(false)
      expect(existsSync(join(outside, '.morrow'))).toBe(false)

      await feature(page, 'feature:memory:update', {
        scope: 'project',
        workspace,
        id: projectEntry.entry.id,
        text: 'E2E 项目记忆（已更新）：报告标题使用「季度经营分析」'
      })
      const disabledMigration = migrated.entries.find((entry) => entry.text.includes('金额保留两位小数'))!
      await feature(page, 'feature:memory:toggle', {
        scope: 'project',
        workspace,
        id: disabledMigration.id,
        enabled: false
      })

      const searched = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        query: '经营分析',
        includeDisabled: true
      })
      expect(searched.entries.map((entry) => entry.text).join('')).toContain('季度经营分析')

      const withDisabled = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        includeDisabled: true
      })
      expect(withDisabled.stats.disabled).toBe(1)
      expect(withDisabled.stats.enabled).toBe(2) // 3 条 - 1 条停用

      /* ── 3) 注入预览：只含启用条目、预算内、停用不出现 ── */
      const injection = await feature<MemoryInjectionWire>(page, 'feature:memory:injection', {
        workspace,
        maxTokens: 600
      })
      expect(injection.text).toContain('始终使用简体中文')
      expect(injection.text).toContain('已更新')
      expect(injection.text).not.toContain('金额保留两位小数')
      expect(injection.usedTokens).toBeLessThanOrEqual(injection.limitTokens)
      expect(injection.omitted).toBe(0)
      expect(injection.included).toBe(3) // 项目 2（1 迁移启用 + 1 新增）+ 全局 1

      /* ── 4) 导出 ── */
      const exported = await feature<{ markdown: string; json: string; count: number; fileName: string }>(
        page,
        'feature:memory:export',
        { scope: 'project', workspace }
      )
      expect(exported.count).toBe(3)
      expect(exported.markdown).toContain('E2E 项目记忆')
      expect(JSON.parse(exported.json).count).toBe(3)
      expect(exported.fileName).toMatch(/morrow-memory-project-/)

      /* ── 5) 项目 CRUD + 工作区边界 ── */
      const projectA = await feature<ProjectRecordWire>(page, 'feature:projects:create', {
        workspace,
        name: 'E2E 经营分析项目',
        description: 'E2E 项目描述',
        instructions: 'E2E 项目指令：金额保留两位小数；不要改原始数据。',
        knowledgePaths: ['docs-brief.md', 'numbers.csv'],
        pinned: true
      })
      projectAId = projectA.id
      expect(projectA.knowledgePaths).toEqual(['docs-brief.md', 'numbers.csv'])
      expect(projectA.active).toBe(true)

      const projectB = await feature<ProjectRecordWire>(page, 'feature:projects:create', {
        workspace: workspaceB,
        name: 'E2E B 项目',
        instructions: 'B 项目指令：CANARY_B_INSTRUCTION',
        knowledgePaths: ['brief.md']
      })

      const duplicate = await featureRaw(page, 'feature:projects:create', { workspace })
      expect(duplicate.ok).toBe(false)

      const outsideKnowledge = await featureRaw(page, 'feature:projects:knowledge-validate', {
        workspace,
        path: join(outside, 'secret.md')
      })
      expect(outsideKnowledge.ok).toBe(false)
      expect(!outsideKnowledge.ok && outsideKnowledge.error.message).toMatch(/工作区内/)

      const relativeEscape = await featureRaw(page, 'feature:projects:knowledge-validate', {
        workspace,
        path: '../r10-memproj-outside'
      })
      expect(relativeEscape.ok).toBe(false)

      /* ── 6) 上下文生成：指令 + 知识摘要 + 记忆；跨项目隔离 ── */
      const contextA = await feature<ProjectContextWire>(page, 'feature:projects:context', {
        workspace,
        memoryTokens: 400
      })
      expect(contextA.text).toContain('E2E 项目指令')
      expect(contextA.text).toContain('CANARY_A_KNOWLEDGE')
      expect(contextA.text).toContain('E2E 项目描述')
      expect(contextA.text).toContain('始终使用简体中文')
      expect(contextA.text).toContain('E2E 项目记忆（已更新）')
      expect(contextA.text).not.toContain('CANARY_B_')
      expect(contextA.text).toContain('不可信数据')
      expect(contextA.knowledge.length).toBe(2)
      expect(contextA.usedTokens).toBeLessThanOrEqual(contextA.limitTokens)

      const contextB = await feature<ProjectContextWire>(page, 'feature:projects:context', {
        workspace: workspaceB,
        memoryTokens: 0
      })
      expect(contextB.text).toContain('CANARY_B_INSTRUCTION')
      expect(contextB.text).toContain('CANARY_B_KNOWLEDGE')
      expect(contextB.text).not.toContain('CANARY_A_KNOWLEDGE')
      expect(contextB.text).not.toContain('E2E 项目记忆')

      /* ── 7) 停用项目后不注入（ignoreActive 仍可预览） ── */
      await feature(page, 'feature:projects:set-active', { id: projectA.id, active: false })
      const inactiveContext = await feature<ProjectContextWire | null>(page, 'feature:projects:context', { workspace })
      expect(inactiveContext).toBeNull()
      const preview = await feature<ProjectContextWire | null>(page, 'feature:projects:context', {
        workspace,
        ignoreActive: true
      })
      expect(preview).not.toBeNull()
      await feature(page, 'feature:projects:set-active', { id: projectA.id, active: true })

      /* ── 8) 更新指令 + 列表摘要 ── */
      await feature(page, 'feature:projects:update', {
        id: projectA.id,
        instructions: 'E2E 项目指令（更新）：报告必须给出数据来源。'
      })
      const list = await feature<ProjectListWire>(page, 'feature:projects:list')
      expect(list.projects.length).toBe(2)
      const listedA = list.projects.find((project) => project.id === projectA.id)!
      expect(listedA.instructions).toContain('数据来源')
      expect(listedA.pinned).toBe(true)
      expect(listedA.knowledgeCount).toBe(2)
      expect(listedA.workspaceExists).toBe(true)
      expect(list.projects.find((project) => project.id === projectB.id)?.workspaceExists).toBe(true)

      await page.screenshot({ path: screenshotPath('r10-memory-projects-e2e.png') })

      /* ── 9) 磁盘证据：项目 JSON / 项目记忆 JSON / 全局记忆 JSON ── */
      const projectsFile = readFileSync(join(dataDir, 'projects', 'projects.json'), 'utf8')
      expect(projectsFile).toContain('E2E 经营分析项目')
      const projectMemoriesFile = readFileSync(join(workspace, '.morrow', 'memories.json'), 'utf8')
      expect(projectMemoriesFile).toContain('E2E 项目记忆')
      const globalMemoriesFile = readFileSync(join(dataDir, 'memories', 'global.json'), 'utf8')
      expect(globalMemoriesFile).toContain('始终使用简体中文')
    } finally {
      await first.close()
    }

    /* ── 10) 重启（同一 dataDir）后数据仍在 ── */
    const second = await launchMorrow({ name: 'r10-memproj-2', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = second
      await waitForStoreReady(page)

      const memories = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        includeDisabled: true
      })
      expect(memories.entries.length).toBe(3)
      expect(memories.stats.migratedTotal).toBe(2)
      const globals = await feature<MemoryListWire>(page, 'feature:memory:list', { scope: 'global' })
      expect(globals.entries.map((entry) => entry.text).join('')).toContain('始终使用简体中文')

      const projects = await feature<ProjectListWire>(page, 'feature:projects:list')
      const restored = projects.projects.find((project) => project.id === projectAId)
      expect(restored).toBeTruthy()
      expect(restored?.instructions).toContain('数据来源')
      expect(restored?.knowledgePaths).toEqual(['docs-brief.md', 'numbers.csv'])

      const contextAfterRestart = await feature<ProjectContextWire>(page, 'feature:projects:context', { workspace })
      expect(contextAfterRestart.text).toContain('CANARY_A_KNOWLEDGE')
      expect(contextAfterRestart.text).toContain('数据来源')

      // 项目记忆文件在重启后没有被重复迁移（幂等）
      const diskMemories = JSON.parse(readFileSync(join(workspace, '.morrow', 'memories.json'), 'utf8')) as {
        entries: Array<{ text: string }>
      }
      expect(diskMemories.entries.filter((entry) => entry.text.includes('金额保留两位小数'))).toHaveLength(1)
      expect(existsSync(join(workspaceB, 'brief.md'))).toBe(true)
    } finally {
      await second.close()
    }
  })

  test('UI：工作台 → 记忆中心添加/启停/注入预览（明暗截图）+ 项目面板编辑与上下文预览', async () => {
    test.setTimeout(180_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r10-memproj-ui-ws-${stamp}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'brief.md'), '# 项目资料\nUI_CANARY_KNOWLEDGE：项目知识内容。', 'utf8')
    seedLegacyMemory(workspace)
    const dataDir = join(root, 'tmp', `r10-memproj-ui-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r10-memproj-ui-chromium-${stamp}`)

    const morrow = await launchMorrow({ name: 'r10-memproj-ui', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await setLastWorkspaceViaStore(page, workspace)

      // 先通过真实 IPC 建一个项目（面板负责编辑/预览，不重复测 CRUD）
      await feature(page, 'feature:projects:create', {
        workspace,
        name: 'UI 项目',
        description: 'UI 描述',
        instructions: 'UI 项目指令：先给结论，再给数据来源。',
        knowledgePaths: ['brief.md']
      })

      /* ── 记忆中心 UI ── */
      await openWorkbenchPanel(page, 'memory')
      const memoryRoot = page.locator('.mc-root')
      await expect(memoryRoot).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.modal-title').filter({ hasText: '记忆' })).toBeVisible()
      // 旧 MEMORY.md 迁移条目出现在面板里
      await expect(page.locator('.mc-list')).toContainText('E2E 迁移记忆：周报按季度口径汇总')
      await expect(memoryRoot).toContainText('旧记忆已迁移')

      // 添加一条项目记忆
      await page.getByRole('button', { name: '添加记忆' }).click()
      await page.getByLabel('新的项目记忆').fill('UI 添加的记忆：图表使用香槟金主色。')
      await page.getByLabel('标签（可选，逗号分隔，最多 8 个）').fill('图表, UI')
      await page.getByRole('button', { name: '保存记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('UI 添加的记忆')
      await expect(page.locator('.mc-notice')).toContainText('已保存')

      // 行内停用 + 搜索
      const addedEntry = page.locator('.mc-entry').filter({ hasText: 'UI 添加的记忆' })
      await addedEntry.getByRole('switch', { name: '停用这条记忆' }).click()
      await expect(addedEntry).toContainText('已停用，不会参考')
      await page.getByLabel('搜索记忆').fill('UI 添加')
      await expect(page.locator('.mc-entry')).toHaveCount(1)
      await page.getByLabel('搜索记忆').fill('')

      // 切范围时必须清掉旧范围的清空确认，不能把「清空项目记忆」执行成「清空全局记忆」
      await page.getByRole('radio', { name: '全局记忆' }).click()
      await page.getByRole('button', { name: '添加记忆' }).click()
      await page.getByLabel('新的全局记忆').fill('UI 全局记忆：始终使用简体中文。')
      await page.getByRole('button', { name: '保存记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('UI 全局记忆')
      await page.getByRole('radio', { name: '项目记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('E2E 迁移记忆')
      await page.getByRole('button', { name: '清空项目记忆' }).click()
      await expect(page.getByRole('alertdialog', { name: '确认操作' })).toBeVisible()
      await page.getByRole('radio', { name: '全局记忆' }).click()
      await expect(page.getByRole('alertdialog', { name: '确认操作' })).toHaveCount(0)
      await expect(page.locator('.mc-list')).toContainText('UI 全局记忆')
      await page.getByRole('radio', { name: '项目记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('E2E 迁移记忆')

      // 注入预览（停用条目不出现，旧迁移条目与全局记忆出现）
      await page.getByRole('button', { name: 'Morrow 会参考的内容' }).click()
      const injection = page.locator('.mc-injection')
      await expect(injection).toBeVisible({ timeout: 10_000 })
      await expect(injection).toContainText('E2E 迁移记忆')
      await expect(injection).toContainText('UI 全局记忆')
      await expect(injection).not.toContainText('UI 添加的记忆')
      await expect(injection).toContainText('tokens')
      await page.evaluate(() => {
        document.querySelector('.modal-body')?.scrollTo(0, 0)
      })
      await page.screenshot({ path: screenshotPath('r10-memory-center-dark.png') })

      // 明色主题截图（沿用全局主题 tokens）
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(260)
      await page.screenshot({ path: screenshotPath('r10-memory-center-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.locator('.mc-foot').getByRole('button', { name: '关闭' }).click()
      await expect(page.locator('.mc-root')).toHaveCount(0)

      /* ── 项目面板 UI ── */
      await openWorkbenchPanel(page, 'projects')
      await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.modal-title').filter({ hasText: '项目' })).toBeVisible()
      await expect(page.locator('.pp-project')).toContainText('UI 项目')
      // 默认是项目主页（概览）：标题、项目内对话入口、说明与资料摘要
      await expect(page.locator('.pp-home-title')).toHaveText('UI 项目')
      await expect(page.locator('.pp-home-composer textarea')).toBeVisible()
      await expect(page.locator('.pp-home-cards')).toContainText('UI 项目指令：先给结论')
      await expect(page.locator('.pp-home-cards')).toContainText('brief.md')
      // 切到说明与资料：当前工作区项目默认被选中并带出完整指令
      await page.getByRole('tab', { name: '说明与资料' }).click()
      await expect(page.getByLabel('长期说明（Morrow 做任务时会参考）')).toHaveValue(/先给结论/)
      await expect(page.locator('.pp-knowledge-list')).toContainText('brief.md')
      // 知识文件会异步重新校验并显示真实大小（不是一直「校验中…」）
      await expect(page.locator('.pp-knowledge-size')).toContainText(/B|KB/i, { timeout: 10_000 })

      // 修改指令并保存
      await page.getByLabel('长期说明（Morrow 做任务时会参考）').fill('UI 项目指令（已保存）：先给结论，再给数据来源，并列出风险。')
      await page.getByRole('button', { name: '保存项目' }).click()
      await expect(page.locator('.pp-notice')).toContainText('项目已保存')

      // 上下文预览：指令 + 知识摘要 + 记忆
      await page.getByRole('button', { name: 'Morrow 会看到什么' }).click()
      const preview = page.locator('.pp-preview')
      await expect(preview).toBeVisible({ timeout: 10_000 })
      await expect(preview).toContainText('UI 项目指令（已保存）')
      await expect(preview).toContainText('UI_CANARY_KNOWLEDGE')
      await expect(preview).toContainText('E2E 迁移记忆')
      await preview.scrollIntoViewIfNeeded()
      await page.screenshot({ path: screenshotPath('r10-projects-context-preview.png') })

      // 通过真实 IPC 复核 UI 保存结果（四层互证：DOM/事件/IPC/磁盘）
      const projects = await feature<ProjectListWire>(page, 'feature:projects:list')
      const saved = projects.projects.find((project) => project.name === 'UI 项目')
      expect(saved?.instructions).toContain('并列出风险')
      const diskProject = readFileSync(join(dataDir, 'projects', 'projects.json'), 'utf8')
      expect(diskProject).toContain('并列出风险')
    } finally {
      await morrow.close()
    }
  })

  test('Agent 注入：项目指令 + 知识摘要 + 记忆真实进入 system prompt（mock LLM）', async () => {
    test.setTimeout(180_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r10-memproj-inject-ws-${stamp}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'brief.md'), '# 项目资料\nINJECT_CANARY_KNOWLEDGE：这份资料只在本项目里。', 'utf8')
    const dataDir = join(root, 'tmp', `r10-memproj-inject-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r10-memproj-inject-chromium-${stamp}`)
    // mock LLM：记录真实请求体（system prompt 在 OpenAI 兼容协议的 messages[0]）
    const mock = await startMockLLM({ scripts: [{ text: '收到，我会按项目规矩回答。' }] })

    const morrow = await launchMorrow({ name: 'r10-memproj-inject', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await setLastWorkspaceViaStore(page, workspace)
      await installEventCollector(page)
      const provider = await page.evaluate(async (url: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const config = {
          id: 'mock-r10-inject',
          kind: 'openai-compat',
          name: '本地 Mock（注入测试）',
          baseUrl: url,
          models: [{ id: 'mock-model', label: 'Mock Model', contextWindow: 32_000, supportsTools: true }],
          apiKeyStored: false,
          enabled: true
        }
        await store.getState().saveProvider({ config })
        return { providerId: config.id as string, modelId: 'mock-model' }
      }, mock.openaiBaseUrl)

      /* 项目 + 项目记忆 + 全局记忆都通过真实 feature IPC 落盘 */
      await feature(page, 'feature:projects:create', {
        workspace,
        name: '注入项目',
        instructions: '注入指令：报告必须标注数据来源。',
        knowledgePaths: ['brief.md']
      })
      await feature(page, 'feature:memory:add', {
        scope: 'project',
        workspace,
        text: '注入记忆：图表使用香槟金主色。'
      })
      await feature(page, 'feature:memory:add', {
        scope: 'global',
        text: '注入全局记忆：始终使用简体中文。'
      })

      /* 用 mock provider 建会话并真的发一条消息 */
      await page.evaluate(
        async (arg: { workspace: string; providerId: string; modelId: string }) => {
          const created = await window.morrow.session.create({
            workspace: arg.workspace,
            model: { providerId: arg.providerId, modelId: arg.modelId },
            permissionMode: 'auto',
            title: '注入测试会话'
          })
          if (!created.ok) throw new Error(`session.create 失败：${created.error.message}`)
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          await store.getState().selectSession(created.data.id)
        },
        { workspace, providerId: provider.providerId, modelId: provider.modelId }
      )
      await sendMessageViaStore(page, '你好，请按这个项目的规矩介绍一下背景。')
      // mock LLM 回复很快：不轮询瞬时 run 状态，直接等 run_finished 事件（已安装事件收集器）
      const finished = await waitForRunFinished(page, 60_000)
      expect(finished.reason).toBe('complete')
      expect(mock.calls).toBeGreaterThanOrEqual(1)

      /* 真实请求 body 里必须出现注入内容（四层证据：服务→agent-service→provider 请求） */
      const requestBody = JSON.stringify(mock.requests[0].body)
      expect(requestBody).toContain('注入指令：报告必须标注数据来源')
      expect(requestBody).toContain('INJECT_CANARY_KNOWLEDGE')
      expect(requestBody).toContain('注入记忆：图表使用香槟金主色')
      expect(requestBody).toContain('注入全局记忆：始终使用简体中文')
      // 注入文本明确标注不可信背景/不构成授权
      expect(requestBody).toContain('不是指令')
      await page.screenshot({ path: screenshotPath('r10-memory-projects-injection.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})
