// 目标模式与另一个对话的并行：真实 Electron 应用里的回归验证。
//
// 用户报告的问题：一个对话正在推进长期目标时，另开一个对话发送消息会被拦下，
// 提示「另一个对话的目标正在自动推进，先处理它或等它完成」。
// 这里用 mock 模型真跑一遍：目标会话持续多轮推进时，另一个对话必须能正常发送并完成。
import { test, expect, type Page } from '@playwright/test'
import {
  launchMorrow,
  screenshotPath,
  configureMockProvider,
  waitForStoreReady,
  dismissOnboarding,
  waitUntil,
  createSession,
  type MorrowApp
} from './helpers'
import { startMockLLM } from '../fixtures/mock-llm.mjs'

interface ModelRef {
  providerId: string
  modelId: string
}

/** 读目标会话当前的目标状态。 */
function goalOf(page: Page, sessionId: string): Promise<Record<string, any> | null> {
  return page.evaluate(async (id: string) => {
    const loaded = await window.morrow.session.load(id)
    return loaded.ok ? ((loaded.data as Record<string, any>).goal ?? null) : null
  }, sessionId)
}

/** 读某会话的助手文本，用于确认真的跑完了。 */
function assistantTextOf(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async (id: string) => {
    const loaded = await window.morrow.session.load(id)
    if (!loaded.ok) return ''
    const messages = (loaded.data as Record<string, any>).messages ?? []
    return messages
      .filter((message: Record<string, any>) => message.role === 'assistant')
      .flatMap((message: Record<string, any>) => message.content ?? [])
      .filter((block: Record<string, any>) => block.type === 'text')
      .map((block: Record<string, any>) => String(block.text ?? ''))
      .join('\n')
  }, sessionId)
}

test.describe('目标模式下的并行会话', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('@core:goals 一个对话推进目标时，另一个对话照常发送并完成', async () => {
    test.setTimeout(240_000)

    // 目标会话持续多轮保持 active（让它停在目标循环里）；
    // 另一个对话的请求单独回一句可识别的普通回答。
    // 用 systemPrompt 里的目标段区分：只有推进目标的会话才会带上它。
    let goalRound = 0
    const mock = await startMockLLM({
      respond: (ctx: { body: Record<string, any> }) => {
        const first = ctx.body.messages?.[0] ?? {}
        const system = String(first.content ?? '')
        const isGoalSession = system.includes('## 目标模式')
        if (isGoalSession) {
          goalRound += 1
          if (goalRound <= 6) {
            return {
              text: `目标第 ${goalRound} 轮推进中。`,
              toolCalls: [
                {
                  name: 'update_goal',
                  arguments: {
                    status: 'active',
                    summary: `完成第 ${goalRound} 个切片`,
                    nextStep: '继续下一个切片'
                  }
                }
              ]
            }
          }
          return { text: '目标结束。' }
        }
        return { text: '另一个对话收到了，这是并行执行的回复。' }
      }
    })

    morrow = await launchMorrow({ name: 'parallel-goal', waitForSelector: '.sidebar' })
    const { page } = morrow
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const model = (await configureMockProvider(page, mock.openaiBaseUrl)) as ModelRef

      const demo = await page.evaluate(async () => {
        const created = await window.morrow.workspace.createDemo()
        return created.ok ? created.data.path : null
      })
      if (!demo) throw new Error('演示工作区创建失败')

      // 1) 目标会话开始推进
      const goalSessionId = await createSession(page, {
        workspace: demo,
        providerId: model.providerId,
        modelId: model.modelId,
        permissionMode: 'auto',
        title: '目标会话'
      })
      await page.evaluate(async (id: string) => {
        await window.morrow.goal.start({
          sessionId: id,
          objective: '分几轮把笔记写完，每轮只推进一个切片。'
        })
      }, goalSessionId)

      await waitUntil(
        async () => {
          const goal = await goalOf(page, goalSessionId)
          return goal?.status === 'active' ? goal : null
        },
        90_000,
        '目标进入 active'
      )

      // 2) 目标仍在推进时，另开一个对话发送普通消息
      const otherSessionId = await createSession(page, {
        workspace: demo,
        providerId: model.providerId,
        modelId: model.modelId,
        permissionMode: 'auto',
        title: '并行对话'
      })

      const goalAtSend = await goalOf(page, goalSessionId)
      expect(goalAtSend?.status, '发送前目标应仍在推进').toBe('active')

      const sent = await page.evaluate(async (id: string) => {
        const result = await window.morrow.chat.send({ sessionId: id, text: '并行验证：帮我看看这份文件。' })
        return result.ok ? { ok: true } : { ok: false, message: result.error?.message ?? '发送失败' }
      }, otherSessionId)
      expect(sent.ok, `另一个对话发送被拒绝：${(sent as { message?: string }).message ?? ''}`).toBe(true)

      // 3) 它真的跑完了
      await waitUntil(
        async () => {
          const text = await assistantTextOf(page, otherSessionId)
          return text.includes('并行执行的回复') ? text : null
        },
        120_000,
        '另一个对话完成回复'
      )

      // 4) 全程没有出现「目标正在自动推进」的拦截
      const transcript = await assistantTextOf(page, otherSessionId)
      expect(transcript).not.toContain('目标正在自动推进')

      await page.screenshot({ path: screenshotPath('parallel-goal-sessions.png') })
    } finally {
      await mock.close()
    }
  })
})