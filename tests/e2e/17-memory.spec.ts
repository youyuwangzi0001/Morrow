/**
 * 记忆领域 E2E：自进化建议（强信号复盘、采纳为记忆/技能）+ 任务经验（自动记录、按需注入、沉淀为长期记忆）。
 */
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { launchMorrow, root, screenshotPath } from "./launch"
import { startMockLLM } from "../fixtures/mock-llm.mjs"
import {
  clearEvents,
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  readStore,
  sendMessageViaStore,
  setThemeViaStore,
  waitForRunFinished,
  waitForStoreReady,
  waitUntil
} from "./store"

// ── 自进化建议（原 r19-evolution.spec.ts） ─────────────────────

const REVIEW_SUGGESTIONS = {
  suggestions: [
    {
      kind: 'memory',
      action: 'create',
      scope: 'project',
      title: '报表口径',
      text: '报表统一使用季度口径；数字保留两位小数。',
      tags: ['报表', '口径'],
      rationale: '用户明确要求以后都按这个口径处理。',
      confidence: 0.92
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
        '2. 构建并确认没有进程占用 app.asar。',
        '3. 打包单文件、运行冒烟并核对校验和。',
        '',
        '## 完成检查',
        '窗口能打开，使用说明与 SHA256SUMS 已更新。',
        '',
        '## 反模式',
        '不要跳过冒烟，也不要把 Morrow Data 放进交付包。'
      ].join('\n'),
      rationale: '这次任务形成了可复现的打包流程。',
      confidence: 0.88
    }
  ]
}

function isReviewRequest(ctx: { body?: unknown }): boolean {
  try {
    return JSON.stringify(ctx.body ?? {}).includes('经验编辑')
  } catch {
    return false
  }
}

test('自动复盘关闭时仍可手动检查，并能在界面忽略建议', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r19-evolution-manual-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [{ text: '已经整理好了。' }],
    respond: (ctx: { body?: unknown }) =>
      isReviewRequest(ctx) ? { text: JSON.stringify(REVIEW_SUGGESTIONS) } : undefined
  })
  const morrow = await launchMorrow({ name: 'r19-evolution-manual', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '手动复盘测试'
    })
    await page.evaluate(async () => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { updateSettings: (patch: unknown) => Promise<void> } }
      }).__morrowStore
      await store.getState().updateSettings({ evolutionEnabled: false })
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '整理一份清单。')
    await waitForRunFinished(page, 60_000)

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'memory' } }))
    })
    await expect(page.locator('.evo-root')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('switch', { name: '任务完成后自动检查对话' })).toHaveAttribute('aria-checked', 'false')
    await expect(page.locator('.evo-empty')).toBeVisible()
    await page.getByRole('button', { name: '检查最近对话并整理建议' }).click()
    await expect(page.locator('.evo-card')).toHaveCount(2, { timeout: 30_000 })
    await expect(page.locator('.evo-message.is-ok')).toContainText('发现 2 条新建议')
    await page.locator('.evo-card').first().getByRole('button', { name: '忽略' }).click()
    await expect(page.locator('.evo-card')).toHaveCount(1)
    await expect(page.locator('.evo-message.is-ok')).toContainText('已忽略')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('强信号任务自动复盘，建议可采纳为真实记忆与技能', async () => {
  test.setTimeout(180_000)
  const workspace = join(root, 'tmp', `e2e-r19-evolution-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      { text: '先整理一版清单。' },
      { text: '明白，改成纯文本；以后都按这个口径。' }
    ],
    respond: (ctx: { body?: unknown }) =>
      isReviewRequest(ctx) ? { text: JSON.stringify(REVIEW_SUGGESTIONS) } : undefined
  })
  const morrow = await launchMorrow({ name: 'r19-evolution', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '自进化建议测试'
    })
    await page.evaluate(async () => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { updateSettings: (patch: unknown) => Promise<void> } }
      }).__morrowStore
      await store.getState().updateSettings({ evolutionEnabled: true })
    })
    await installEventCollector(page)

    await sendMessageViaStore(page, '帮我整理一份清单。')
    await waitForRunFinished(page, 60_000)
    await clearEvents(page)
    await sendMessageViaStore(page, '不要用表格，改成纯文本；以后都按季度口径。')
    await waitForRunFinished(page, 60_000)

    // 自动复盘在运行结束后异步发生；轮询真实 feature IPC，而不是等固定时间。
    const list = await waitUntil(
      async () => {
        const result = await page.evaluate(async (ws) => {
          const response = await window.morrow.features.invoke<{
            suggestions: Array<{ id: string; status: string; title: string }>
            pending: number
          }>('feature:evolution:list', { workspace: ws })
          return response.ok ? response.data : null
        }, workspace)
        return result && result.pending >= 2 ? result : null
      },
      45_000,
      '自动复盘生成两条建议'
    )
    expect(list.suggestions).toHaveLength(2)

    // 设置 → 功能与工具里的「记忆」入口显示待处理数量，避免建议被藏起来。
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } })
        .__morrowStore
      store.getState().openSettings()
    })
    const settingsDialog = page.getByRole('dialog', { name: '设置' })
    await expect(settingsDialog).toBeVisible({ timeout: 15_000 })
    await settingsDialog.getByRole('tab', { name: '功能与工具' }).click()
    await expect(page.locator('.st-tool-badge')).toHaveText('2')
    await page.screenshot({ path: screenshotPath('r19-evolution-badge-dark.png') })
    await page.keyboard.press('Escape')
    await expect(settingsDialog).toBeHidden()

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'memory' } }))
    })
    await expect(page.locator('.evo-root')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.evo-head-title')).toHaveText('Morrow 的建议')
    await expect(page.locator('.evo-card')).toHaveCount(2)
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r19-evolution-suggestions-dark.png') })

    // 展开技能建议，确认展示的是完整 SKILL.md，而不是只有一句摘要。
    const skillCard = page.locator('.evo-card').filter({ hasText: 'release-pipeline' })
    await skillCard.getByRole('button', { name: /查看 release-pipeline 的完整内容/ }).click()
    await expect(skillCard.locator('.evo-content')).toContainText('## 完成检查')
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r19-evolution-expanded-light.png') })
    await skillCard.getByRole('button', { name: /收起 release-pipeline 的完整内容/ }).click()
    await setThemeViaStore(page, 'dark')

    // 自动复盘开关是可持久化的真实设置；关闭后仍可手动检查。
    const toggle = page.getByRole('switch', { name: '任务完成后自动检查对话' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const store = (window as unknown as {
            __morrowStore: { getState: () => { settings: { evolutionEnabled: boolean } } }
          }).__morrowStore
          return store.getState().settings.evolutionEnabled
        })
      )
      .toBe(false)

    // 采纳记忆：真实写入项目 memories.json，并刷新当前项目列表。
    const memoryCard = page.locator('.evo-card').filter({ hasText: '报表口径' })
    await memoryCard.getByRole('button', { name: '采纳' }).click()
    await expect(page.locator('.evo-message.is-ok')).toContainText('已保存到记忆')
    await expect(page.locator('.mc-list')).toContainText('报表统一使用季度口径')
    await expect(page.locator('.evo-card')).toHaveCount(1)

    // 采纳技能：真实写 SKILL.md，并可从提示直接打开技能库。
    const remainingSkill = page.locator('.evo-card').filter({ hasText: 'release-pipeline' })
    await remainingSkill.getByRole('button', { name: '采纳' }).click()
    await expect(page.locator('.evo-message.is-ok')).toContainText('已保存为技能')
    await expect(page.locator('.evo-empty')).toBeVisible()

    const skills = await page.evaluate(async (ws) => {
      const response = await window.morrow.features.invoke<{
        skills: Array<{ name: string; id: string; source: string }>
      }>('feature:skills:list', { workspace: ws })
      return response.ok ? response.data : null
    }, workspace)
    expect(skills?.skills.some((skill) => skill.name === 'release-pipeline' && skill.source === 'user')).toBe(true)
    const skillMd = join(morrow.dataDir, 'skills', 'release-pipeline', 'SKILL.md')
    expect(readFileSync(skillMd, 'utf8')).toContain('name: release-pipeline')

    await expect(page.getByRole('button', { name: '打开技能库' })).toBeVisible()
    await page.getByRole('button', { name: '打开技能库' }).click()
    await expect(page.getByTestId('skills-panel')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('skills-panel')).toContainText('release-pipeline')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

// ── 任务经验（原 r20-memory-system.spec.ts） ───────────────────

test('任务经验自动记录、可沉淀为长期记忆，并在相关任务中注入', async () => {
  test.setTimeout(180_000)
  const workspace = join(root, 'tmp', `e2e-r20-memory-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '开始整理季度销售数据。',
        toolCalls: [
          {
            name: 'write_file',
            arguments: {
              path: 'out/report.md',
              content: '# 销售报告\n\n季度销售额：100 万\n'
            }
          }
        ]
      },
      { text: '已完成销售报告，生成在 out/report.md。按季度口径汇总，数字保留两位小数。' },
      { text: '已按任务经验更新季度销售报告。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r20-memory-system', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '季度销售报告'
    })
    await page.evaluate(async () => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { updateSettings: (patch: unknown) => Promise<void> } }
      }).__morrowStore
      await store.getState().updateSettings({ episodeMemoryEnabled: true })
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '整理季度销售数据并生成报告。')
    await waitForRunFinished(page, 60_000)

    await waitUntil(
      async () => {
        try {
          const raw = readFileSync(join(workspace, '.morrow', 'episodes.json'), 'utf8')
          return raw.includes('季度销售报告') && raw.includes('out/report.md') ? true : null
        } catch {
          return null
        }
      },
      15_000,
      '自动记录任务经验'
    )

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'memory' } }))
    })
    await expect(page.locator('.evo-root')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('radio', { name: '任务经验' }).click()
    await expect(page.locator('.mc-episodes')).toBeVisible()
    await expect(page.locator('.mc-episode')).toHaveCount(1)
    await expect(page.locator('.mc-episode').first()).toContainText('季度销售报告')
    await page.locator('.mc-episode-head').first().click()
    await expect(page.locator('.mc-episode-detail')).toContainText('write_file')
    await expect(page.locator('.mc-episode-detail')).toContainText('out/report.md')
    await page.screenshot({ path: screenshotPath('r20-task-experience-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r20-task-experience-light.png') })
    await setThemeViaStore(page, 'dark')

    // 沉淀为长期记忆：切换回长期记忆并预填，保存后才进入长期列表。
    await page.getByRole('button', { name: '保存为长期记忆' }).click()
    await expect(page.getByLabel('新的项目记忆')).toBeVisible()
    await expect(page.getByLabel('新的项目记忆')).toHaveValue(/季度销售报告/)
    await page.getByRole('button', { name: '保存记忆' }).click()
    await expect(page.locator('.mc-list')).toContainText('季度销售报告')
    await page.screenshot({ path: screenshotPath('r20-memory-after-save.png') })

    // 注入预览同时展示长期记忆与相关任务经验。
    const previewButton = page.getByRole('button', { name: 'Morrow 会参考的内容' })
    await expect(previewButton).toBeVisible({ timeout: 15_000 })
    await previewButton.click()
    await expect(page.locator('.mc-injection')).toContainText('相关任务经验')
    await expect(page.locator('.mc-injection')).toContainText('季度销售报告')
    await page.screenshot({ path: screenshotPath('r20-memory-injection-light.png') })

    // 下一轮真实请求里应包含任务经验，而不是只存在于 UI。
    await page.keyboard.press('Escape')
    await page.evaluate(async () => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } }
      }).__morrowStore
      await store.getState().sendMessage('继续更新季度销售报告。')
    })
    await waitForRunFinished(page, 60_000)
    const bodies = mock.requests.map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
    expect(bodies.some((body: string) => body.includes('相关任务经验') && body.includes('季度销售报告'))).toBe(true)

    const state = await readStore(page)
    expect(state.session?.messages.at(-1)?.text).toContain('已按任务经验更新')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('remember 工具写入结构化记忆，而不是旁路到 MEMORY.md', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r20-remember-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '记一下这个长期偏好。',
        toolCalls: [
          {
            name: 'remember',
            arguments: { text: '以后销售报告都用季度口径。', scope: 'global' }
          }
        ]
      },
      { text: '已经记入全局记忆。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r20-remember', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'remember 测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '记住以后销售报告都用季度口径。')
    await waitForRunFinished(page, 60_000)

    const memories = await page.evaluate(async (ws) => {
      const result = await window.morrow.features.invoke<{
        entries: Array<{ text: string; scope: string }>
      }>('feature:memory:list', { scope: 'global', workspace: ws, includeDisabled: true })
      return result.ok ? result.data.entries : []
    }, workspace)
    expect(memories.some((entry) => entry.scope === 'global' && entry.text.includes('季度口径'))).toBe(true)
    expect(() => readFileSync(join(workspace, '.morrow', 'MEMORY.md'))).toThrow()
  } finally {
    await morrow.close()
    await mock.close()
  }
})
