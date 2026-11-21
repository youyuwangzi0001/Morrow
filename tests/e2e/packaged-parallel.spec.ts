// 在「已打包产物」上验证并行修复：目标推进时另一个对话仍能发送。
//
// 与 tests/e2e/parallel-goal.spec.ts 的区别：那边跑的是 out/ 开发构建，
// 这里直连交付 exe（deliver-0.2.1/Morrow-0.2.1-portable.exe），
// 确认用户实际拿到的包里带的是修复后的行为。
import { test, expect, type Page } from '@playwright/test'
import { launchMorrow, waitUntil, type MorrowApp } from './helpers'
import { startMockLLM } from '../fixtures/mock-llm.mjs'

const PACKAGED_EXE = process.env.MORROW_PACKAGED_EXE

interface ModelRef {
  providerId: string
  modelId: string
}

function goalOf(page: Page, sessionId: string): Promise<Record<string, any> | null> {
  return page.evaluate(async (id: string) => {
    const loaded = await window.morrow.session.load(id)
    return loaded.ok ? ((loaded.data as Record<string, any>).goal ?? null) : null
  }, sessionId)
}

async function configureProvider(page: Page, baseUrl: string): Promise<ModelRef> {
  return page.evaluate(async (url: string) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const config = {
      id: 'packaged-mock',
      kind: 'openai-compat',
      name: '打包验证 Mock',
      baseUrl: url,
      models: [{ id: 'mock-model', label: 'Mock', contextWindow: 32_000, supportsTools: true }],
      apiKeyStored: false,
      enabled: true
    }
    await store.getState().saveProvider({ config })
    const settings = store.getState().settings as Record<string, any>
    const saved = (settings.providers as Array<Record<string, any>>).find((p) => p.id === 'packaged-mock')
    if (!saved) throw new Error('provider 保存失败')
    return { providerId: 'packaged-mock', modelId: 'mock-model' }
  }, baseUrl)
}

async function makeSession(page: Page, title: string, model: ModelRef, workspace: string): Promise<string> {
  return page.evaluate(
    async (arg: { title: string; model: ModelRef; workspace: string }) => {
      const created = await window.morrow.session.create({
        title: arg.title,
        model: arg.model,
        mode: 'work',
        permissionMode: 'auto',
        workspace: arg.workspace
      })
      if (!created.ok) throw new Error(`session.create 失败：${created.error.message}`)
      return created.data.id
    },
    { title, model, workspace }
  )
}

test.describe('打包产物：目标模式下的并行会话', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('@core:goals 交付包内：目标推进时另一对话可发送并完成', async () => {
    test.skip(!PACKAGED_EXE, '未提供 MORROW_PACKAGED_EXE，跳过打包产物验证')
    test.setTimeout(240_000)

    let goalRound = 0
    const mock = await startMockLLM({
      respond: (ctx: { body: Record<string, any> }) => {
        const first = ctx.body.messages?.[0] ?? {}
        const system = String(first.content ?? '')
        if (system.includes('## 目标模式')) {
          goalRound += 1
          if (goalRound <= 6) {
            return {
              text: `目标第 ${goalRound} 轮推进中。`,
              toolCalls: [
                {
                  name: 'update_goal',
                  arguments: { status: 'active', summary: `完成第 ${goalRound} 个切片`, nextStep: '继续下一个切片' }
                }
              ]
            }
          }
          return { text: '目标结束。' }
        }
        return { text: '另一个对话收到了，这是并行执行的回复。' }
      }
    })

    morrow = await launchMorrow({
      name: 'packaged-parallel',
      executablePath: PACKAGED_EXE,
      waitForSelector: '.sidebar'
    })
    const { page } = morrow
    try {
      await waitUntil(
        async () =>
          (await page.evaluate(
            () => Boolean((window as unknown as { __morrowStore?: { getState: () => { ready?: boolean } } }).__morrowStore?.getState().ready)
          ))
            ? true
            : null,
        60_000,
        'store ready'
      )
      await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any>; setState: (p: Record<string, unknown>) => void } }).__morrowStore
        await store.getState().updateSettings({ onboardingDone: true })
        store.setState({ onboardingOpen: false })
      })

      const model = await configureProvider(page, mock.openaiBaseUrl)
      const demo = await page.evaluate(async () => {
        const created = await window.morrow.workspace.createDemo()
        return created.ok ? created.data.path : null
      })
      if (!demo) throw new Error('演示工作区创建失败')

      const goalSessionId = await makeSession(page, '目标会话', model, demo)
      await page.evaluate(async (id: string) => {
        await window.morrow.goal.start({ sessionId: id, objective: '分几轮把笔记写完，每轮只推进一个切片。' })
      }, goalSessionId)

      await waitUntil(
        async () => {
          const goal = await goalOf(page, goalSessionId)
          return goal?.status === 'active' ? goal : null
        },
        90_000,
        '目标进入 active'
      )

      const otherSessionId = await makeSession(page, '并行对话', model, demo)
      expect((await goalOf(page, goalSessionId))?.status, '发送前目标应仍在推进').toBe('active')

      const sent = await page.evaluate(async (id: string) => {
        const result = await window.morrow.chat.send({ sessionId: id, text: '打包验证：帮我看看这份文件。' })
        return result.ok ? { ok: true } : { ok: false, message: result.error?.message ?? '发送失败' }
      }, otherSessionId)
      expect(sent.ok, `打包产物里另一对话被拒绝：${(sent as { message?: string }).message ?? ''}`).toBe(true)

      await waitUntil(
        async () => {
          const text = await page.evaluate(async (id: string) => {
            const loaded = await window.morrow.session.load(id)
            if (!loaded.ok) return ''
            return ((loaded.data as Record<string, any>).messages ?? [])
              .filter((m: Record<string, any>) => m.role === 'assistant')
              .flatMap((m: Record<string, any>) => m.content ?? [])
              .filter((b: Record<string, any>) => b.type === 'text')
              .map((b: Record<string, any>) => String(b.text ?? ''))
              .join('\n')
          }, otherSessionId)
          return text.includes('并行执行的回复') ? text : null
        },
        120_000,
        '打包产物里另一对话完成回复'
      )
    } finally {
      await mock.close()
    }
  })
})