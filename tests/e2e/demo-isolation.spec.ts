/**
 * 演示隔离回归：演示模型不能污染默认模型，也不能在真实文件夹里播放剧本。
 * 运行：npx playwright test tests/e2e/demo-isolation.spec.ts
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_MODEL } from '../../src/shared/models'
import { launchMorrow, root, screenshotPath, type MorrowApp } from './launch'
import {
  installEventCollector,
  waitForRunFinished,
  waitForRunStarted,
  waitForStoreReady,
  waitUntil
} from './store'

const DEMO_MODEL = { providerId: 'demo', modelId: 'morrow-demo' }

function workspaceAt(name: string): string {
  const dir = join(root, 'tmp', `demo-isolation-${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test.describe('演示隔离', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('演示不写入默认模型；普通会话不能用演示模型；旧数据自动修复', async () => {
    test.setTimeout(180_000)
    morrow = await launchMorrow({
      name: 'demo-isolation',
      env: { MORROW_DEMO_SPEED: '0.1' },
      timeoutMs: 90_000,
      waitForSelector: '.onb-skip'
    })
    const { page } = morrow
    await waitForStoreReady(page)
    await installEventCollector(page)

    await page.locator('.onb-skip').click()
    const demoState = await waitUntil(
      async () =>
        page.evaluate(() => {
          const state = (window as unknown as {
            __morrowStore: { getState: () => Record<string, any> }
          }).__morrowStore.getState()
          if (state.session?.demo !== true) return null
          return {
            defaultModel: state.settings.defaultModel as { providerId: string; modelId: string },
            session: {
              id: String(state.session.id),
              model: state.session.model as { providerId: string; modelId: string },
              demo: state.session.demo === true,
              workspace: state.session.workspace as string | null
            }
          }
        }),
      30_000,
      '演示会话建立'
    )
    await waitForRunStarted(page)
    await waitForRunFinished(page, 90_000)

    expect(demoState.defaultModel).toEqual(DEFAULT_MODEL)
    expect(demoState.session.model.providerId).toBe('demo')
    expect(demoState.session.demo).toBe(true)
    expect(demoState.session.workspace).toContain('demo-workspace')
    await page.screenshot({ path: screenshotPath('demo-isolation.png') })

    const afterDemo = await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const created = await store.getState().newSession()
      return {
        model: created.model as { providerId: string },
        demo: created.demo === true,
        defaultModel: store.getState().settings.defaultModel as { providerId: string }
      }
    })
    expect(afterDemo.defaultModel).toEqual(DEFAULT_MODEL)
    expect(afterDemo.model).toEqual(DEFAULT_MODEL)
    expect(afterDemo.demo).toBe(false)

    const realWorkspace = workspaceAt('real')
    const rejectedCreate = await page.evaluate(
      async (arg: { workspace: string; model: { providerId: string; modelId: string } }) =>
        window.morrow.session.create({ workspace: arg.workspace, model: arg.model }),
      { workspace: realWorkspace, model: DEMO_MODEL }
    )
    expect(rejectedCreate.ok).toBe(false)
    if (!rejectedCreate.ok) expect(rejectedCreate.error.message).toContain('演示模型只能在')

    const rejectedDefault = await page.evaluate(
      async (model: { providerId: string; modelId: string }) => window.morrow.settings.update({ defaultModel: model }),
      DEMO_MODEL
    )
    expect(rejectedDefault.ok).toBe(false)

    const realModel = await page.evaluate(
      () => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().settings.defaultModel
    )
    const created = await page.evaluate(
      async (arg: { workspace: string; model: { providerId: string; modelId: string } }) =>
        window.morrow.session.create({ workspace: arg.workspace, model: arg.model, title: '旧演示会话' }),
      { workspace: realWorkspace, model: realModel }
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const file = join(morrow.dataDir, 'sessions', `${created.data.id}.json`)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    raw.model = DEMO_MODEL
    raw.workspace = realWorkspace
    delete raw.demo
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')

    const repaired = await page.evaluate(async (sessionId: string) => window.morrow.session.load(sessionId), created.data.id)
    expect(repaired.ok).toBe(true)
    if (repaired.ok) {
      expect(repaired.data.model.providerId).not.toBe('demo')
      expect(repaired.data.demo).not.toBe(true)
    }
    const repairedFile = JSON.parse(readFileSync(file, 'utf8')) as { model: { providerId: string } }
    expect(repairedFile.model.providerId).not.toBe('demo')
  })
})
