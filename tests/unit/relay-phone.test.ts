/**
 * 手机通道域（`src/main/relay-phone.ts`）的用例：下行裁剪、上行白名单与作品投影。
 *
 * 守的不是“能不能转发”，而是**不该转发的东西有没有被拦住**：工具输出、审批参数、
 * 产物正文、附件。它们体积大且与手机展示无关，一旦漏到下行帧，既白耗流量，
 * 也会把本不该离机的命令原文与文件内容送到另一台设备上。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Artifact, ChatMessage, RuntimeEvent } from '../../src/shared/types'
import type { StudioDelivery, StudioProjectSummary } from '../../src/shared/studio'
import {
  dispatchPhoneInvoke,
  phoneArtifact,
  phoneInvokeStats,
  phoneMessage,
  phoneProducts,
  phoneWorks,
  setPhoneInvokeHandler,
  toPhoneEvent
} from '../../src/main/relay-phone'

const AT = 1_700_000_000_000

const base = { seq: 1, runId: 'run-1', sessionId: 's-1', at: AT }

function event(body: Record<string, unknown>): RuntimeEvent {
  return { ...base, ...body } as unknown as RuntimeEvent
}

function message(text: string): ChatMessage {
  return {
    id: 'm-1',
    role: 'assistant',
    content: [{ type: 'text', text }],
    createdAt: AT
  } as ChatMessage
}

describe('手机下行事件裁剪', () => {
  it('@core:relay 工具结果不下发（输出可能含命令原文与文件内容）', () => {
    const phone = toPhoneEvent(
      event({
        type: 'tool_finished',
        messageId: 'm-1',
        toolUseId: 't-1',
        result: { ok: true, output: 'SECRET-COMMAND-OUTPUT' }
      })
    )
    expect(phone).not.toBeNull()
    expect(JSON.stringify(phone)).not.toContain('SECRET-COMMAND-OUTPUT')
    expect(phone?.toolUseId).toBe('t-1')
  })

  it('@core:relay 工具输入不下发（只保留 messageId）', () => {
    const phone = toPhoneEvent(
      event({
        type: 'tool_started',
        messageId: 'm-1',
        block: { type: 'tool_use', id: 't-1', name: 'run_command', input: { command: 'rm -rf /' } }
      })
    )
    expect(phone).not.toBeNull()
    expect(JSON.stringify(phone)).not.toContain('rm -rf')
  })

  it('@core:relay 工具开始下发名字与标题，让手机能显示「在改哪个文件」', () => {
    const phone = toPhoneEvent(
      event({
        type: 'tool_started',
        messageId: 'm-1',
        block: {
          type: 'tool_use',
          id: 't-1',
          name: 'edit_file',
          title: '修改 src/a.ts',
          category: 'write',
          input: { path: 'src/a.ts', old_string: 'SECRET', new_string: 'SECRET-2' }
        }
      })
    )
    expect(phone?.tool).toEqual({ name: 'edit_file', title: '修改 src/a.ts', category: 'write' })
    expect(phone?.toolUseId).toBe('t-1')
    // 标题之外的输入（片段原文）仍然不下发
    expect(JSON.stringify(phone)).not.toContain('SECRET')
  })

  it('@core:relay 工具结果只下发计数与状态，不下发正文', () => {
    const phone = toPhoneEvent(
      event({
        type: 'tool_finished',
        messageId: 'm-1',
        toolUseId: 't-1',
        result: {
          ok: true,
          output: 'SECRET-COMMAND-OUTPUT',
          durationMs: 1234,
          meta: { diffAdded: 7, diffRemoved: 2, exitCode: 0 }
        }
      })
    )
    expect(phone?.toolResult).toEqual({ ok: true, diffAdded: 7, diffRemoved: 2, durationMs: 1234, exitCode: 0 })
    expect(JSON.stringify(phone)).not.toContain('SECRET-COMMAND-OUTPUT')
  })

  it('@core:relay 删除/新建文件的状态能到手机（用 meta.created / deleted）', () => {
    const created = toPhoneEvent(
      event({ type: 'tool_finished', messageId: 'm-1', toolUseId: 't-1', result: { ok: true, output: '', meta: { created: true } } })
    )
    expect(created?.toolResult).toMatchObject({ created: true })

    const deleted = toPhoneEvent(
      event({ type: 'tool_finished', messageId: 'm-1', toolUseId: 't-2', result: { ok: true, output: '', meta: { deleted: true } } })
    )
    expect(deleted?.toolResult).toMatchObject({ deleted: true })
  })

  it('@core:relay 工具失败只下发 failed 标记，不带错误正文', () => {
    const phone = toPhoneEvent(
      event({
        type: 'tool_finished',
        messageId: 'm-1',
        toolUseId: 't-1',
        result: { ok: false, output: '', error: 'SECRET-ERROR-DETAIL' }
      })
    )
    expect(phone?.toolResult).toMatchObject({ ok: false, failed: true })
    expect(JSON.stringify(phone)).not.toContain('SECRET-ERROR-DETAIL')
  })

  it('@core:relay 消息 content 转成手机可读正文', () => {
    const phone = toPhoneEvent(event({ type: 'message_completed', messageId: 'm-1', message: message('你好，世界') }))
    const payload = phone?.message as Record<string, unknown>
    expect(payload.text).toBe('你好，世界')
    expect(payload.role).toBe('assistant')
    expect(payload.createdAt).toBe(AT)
  })

  it('@core:relay 产物只带元数据，不带内联 HTML 正文', () => {
    const artifact = {
      id: 'a-1',
      title: '报告.html',
      kind: 'html',
      content: '<html>FULL-ARTIFACT-CONTENT</html>',
      createdAt: AT,
      updatedAt: AT + 1
    } as Artifact
    expect(phoneArtifact(artifact).content).toBeUndefined()
    const phone = toPhoneEvent(event({ type: 'artifacts_updated', artifacts: [artifact] }))
    expect(JSON.stringify(phone)).not.toContain('FULL-ARTIFACT-CONTENT')
    expect(JSON.stringify(phone)).toContain('报告.html')
  })

  it('@core:relay 审批只带页面展示字段，不带工具参数原文', () => {
    const phone = toPhoneEvent(
      event({
        type: 'permission_requested',
        request: {
          id: 'req-1',
          sessionId: 's-1',
          toolUseId: 't-1',
          toolName: 'run_command',
          title: '执行命令',
          summary: '在工作区运行构建',
          category: 'command',
          risk: 'high',
          input: { command: 'cat ~/.ssh/id_rsa' },
          allowAlways: false,
          createdAt: AT
        }
      })
    )
    const request = phone?.request as Record<string, unknown>
    expect(request.title).toBe('执行命令')
    expect(request.risk).toBe('high')
    expect(request.allowAlways).toBe(false)
    expect(JSON.stringify(phone)).not.toContain('id_rsa')
  })

  it('@core:relay 消息替换最多带 120 条（保留最近）', () => {
    const messages = Array.from({ length: 200 }, (_, index) => ({
      ...message(`第 ${index} 条`),
      id: `m-${index}`
    }))
    const phone = toPhoneEvent(event({ type: 'messages_replaced', messages }))
    const list = phone?.messages as Array<Record<string, unknown>>
    expect(list).toHaveLength(120)
    expect(list[0].id).toBe('m-80')
    expect(list[119].id).toBe('m-199')
  })

  it('@core:relay 用户消息不带附件与图片数据', () => {
    const userMessage = {
      ...message('看这个文件'),
      role: 'user',
      attachments: [{ name: 'a.png', dataUrl: 'data:image/png;base64,SECRET-BYTES' }],
      images: [{ dataUrl: 'data:image/png;base64,SECRET-BYTES' }]
    } as unknown as ChatMessage
    const phone = toPhoneEvent(event({ type: 'run_started', userMessage, assistantMessageId: 'm-2' }))
    expect(JSON.stringify(phone)).not.toContain('SECRET-BYTES')
    expect((phone?.userMessage as Record<string, unknown>).text).toBe('看这个文件')
  })

  it('@core:relay 手机不关心的事件不下发', () => {
    expect(toPhoneEvent(event({ type: 'episodes_captured', episodeIds: ['e'], scope: 'project', workspace: null }))).toBeNull()
    expect(toPhoneEvent(event({ type: 'demo_step', index: 1, total: 3, caption: 'x' }))).toBeNull()
  })

  it('@core:relay 消息角色与时间原样保留给投影层', () => {
    const phone = phoneMessage({ ...message('ok'), role: 'system', id: 'm-9' } as ChatMessage)
    expect(phone.role).toBe('system')
    expect(phone.id).toBe('m-9')
    expect(phone.createdAt).toBe(AT)
  })
})
describe('协作状态下行', () => {
  it('@core:relay 带出项目/会话/任务 id 供手机干预', () => {
    const phone = toPhoneEvent(
      event({
        type: 'super_updated',
        state: {
          status: 'running',
          projectId: 'proj-1',
          goal: '把 Q3 复盘做完',
          tasks: [{ index: 0, id: 'task-0', taskId: 'task-0b', title: '前端', status: 'running' }]
        }
      })
    )
    const state = (phone as unknown as { state: Record<string, unknown> }).state
    expect(state.sessionId).toBe('s-1')
    expect(state.projectId).toBe('proj-1')
    const tasks = state.tasks as Array<Record<string, unknown>>
    expect(tasks[0].taskId).toBe('task-0b')
  })
})

beforeEach(() => {
  setPhoneInvokeHandler(null)
})

describe('手机上行 invoke', () => {
  it('@core:relay 未知方法被拒绝且不调用处理器', async () => {
    let called = false
    setPhoneInvokeHandler(() => {
      called = true
      return { ok: true }
    })
    const result = await dispatchPhoneInvoke({ id: '1', method: 'shell.exec', params: { command: 'rm -rf /' } })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('unsupported')
    expect(called).toBe(false)
  })

  it('@core:relay 手机端不允许 always（不静默降级为 once）', async () => {
    let called = false
    setPhoneInvokeHandler(() => {
      called = true
      return { ok: true }
    })
    const result = await dispatchPhoneInvoke({
      id: '1',
      method: 'approval.decide',
      params: { requestId: 'req-1', decision: 'always' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('forbidden')
    expect(called).toBe(false)
  })

  it('@core:relay 缺 requestId 或 runId 时不调用处理器', async () => {
    let calls = 0
    setPhoneInvokeHandler(() => {
      calls++
      return { ok: true }
    })
    const noRequest = await dispatchPhoneInvoke({ id: '1', method: 'approval.decide', params: { decision: 'once' } })
    const noRun = await dispatchPhoneInvoke({ id: '2', method: 'run.stop', params: {} })
    expect(noRequest.error?.code).toBe('bad_request')
    expect(noRun.error?.code).toBe('bad_request')
    expect(calls).toBe(0)
  })

  it('@core:relay works.preview 缺 id 时不调用处理器', async () => {
    let calls = 0
    setPhoneInvokeHandler(() => {
      calls++
      return { ok: true }
    })
    const noWork = await dispatchPhoneInvoke({ id: '1', method: 'works.preview', params: { productId: 'p1' } })
    const noProduct = await dispatchPhoneInvoke({ id: '2', method: 'works.preview', params: { workId: 'w1' } })
    expect(noWork.error?.code).toBe('bad_request')
    expect(noProduct.error?.code).toBe('bad_request')
    expect(calls).toBe(0)
  })

  it('@core:relay 合法的预览请求被交给处理器', async () => {
    const seen: Array<Record<string, unknown>> = []
    setPhoneInvokeHandler((request) => {
      seen.push(request.params)
      return { ok: true, result: { preview: null } }
    })
    const result = await dispatchPhoneInvoke({
      id: 'p1',
      method: 'works.preview',
      params: { workId: 'w1', productId: 'd1' }
    })
    expect(result.ok).toBe(true)
    expect(seen).toEqual([{ workId: 'w1', productId: 'd1' }])
  })

  it('@core:relay swarm 干预缺 id/空指令时不调用处理器', async () => {
    let calls = 0
    setPhoneInvokeHandler(() => {
      calls++
      return { ok: true }
    })
    const noProject = await dispatchPhoneInvoke({ id: '1', method: 'swarm.stopMember', params: { taskId: 't1' } })
    const emptyText = await dispatchPhoneInvoke({
      id: '2',
      method: 'swarm.instruction',
      params: { projectId: 'p1', sessionId: 's1', taskId: 't1', text: '  ' }
    })
    expect(noProject.error?.code).toBe('bad_request')
    expect(emptyText.error?.code).toBe('bad_request')
    expect(calls).toBe(0)
  })

  it('@core:relay 合法的协作重试交给处理器', async () => {
    const seen: Array<Record<string, unknown>> = []
    setPhoneInvokeHandler((request) => {
      seen.push(request.params)
      return { ok: true, result: { started: true } }
    })
    const result = await dispatchPhoneInvoke({
      id: 'r1',
      method: 'swarm.retryMember',
      params: { projectId: 'p1', sessionId: 's1', taskId: 't1' }
    })
    expect(result.ok).toBe(true)
    expect(seen).toEqual([{ projectId: 'p1', sessionId: 's1', taskId: 't1' }])
  })

  it('@core:relay 合法的审批决定被交给处理器', async () => {
    const seen: Array<Record<string, unknown>> = []
    setPhoneInvokeHandler((request) => {
      seen.push(request.params)
      return { ok: true, result: { accepted: true } }
    })
    const result = await dispatchPhoneInvoke({
      id: 'abc',
      method: 'approval.decide',
      params: { requestId: 'req-9', decision: 'once' }
    })
    expect(result).toEqual({ ok: true, result: { accepted: true } })
    expect(seen).toEqual([{ requestId: 'req-9', decision: 'once' }])
  })

  it('@core:relay 处理器抛错变成失败结果而不是抛出', async () => {
    setPhoneInvokeHandler(() => {
      throw new Error('磁盘满了')
    })
    const result = await dispatchPhoneInvoke({ id: '1', method: 'ping', params: {} })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('failed')
    expect(result.error?.message).toBe('磁盘满了')
  })

  it('@core:relay message.send 校验会话与正文后交给处理器', async () => {
    const seen: Array<Record<string, unknown>> = []
    setPhoneInvokeHandler((request) => {
      seen.push(request.params)
      return { ok: true, result: { runId: 'run-1' } }
    })
    const result = await dispatchPhoneInvoke({
      id: 'm1',
      method: 'message.send',
      params: { sessionId: 's1', text: '把 Q3 做复盘' }
    })
    expect(result.ok).toBe(true)
    expect(seen).toEqual([{ sessionId: 's1', text: '把 Q3 做复盘' }])
  })

  it('@core:relay 空白消息不启动一轮，直接拒绝', async () => {
    let called = false
    setPhoneInvokeHandler(() => {
      called = true
      return { ok: true }
    })
    const blank = await dispatchPhoneInvoke({ id: 'm1', method: 'message.send', params: { sessionId: 's1', text: '   ' } })
    const tooLong = await dispatchPhoneInvoke({
      id: 'm2',
      method: 'message.send',
      params: { sessionId: 's1', text: 'x'.repeat(20_001) }
    })
    expect(blank.error?.code).toBe('bad_request')
    expect(tooLong.error?.code).toBe('bad_request')
    expect(called).toBe(false)
  })

  it('@core:relay works.get 不需要参数并原样回传结果', async () => {
    setPhoneInvokeHandler(() => ({ ok: true, result: { works: [{ id: 'w1' }] } }))
    const result = await dispatchPhoneInvoke({ id: 'w1', method: 'works.get', params: {} })
    expect(result).toEqual({ ok: true, result: { works: [{ id: 'w1' }] } })
  })

  it('@core:relay 未注册处理器时回 unavailable', async () => {
    const result = await dispatchPhoneInvoke({ id: '1', method: 'snapshot.get', params: {} })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('unavailable')
  })

  it('@core:relay ping 可用且统计处理次数', async () => {
    setPhoneInvokeHandler(() => ({ ok: true, result: { at: 1 } }))
    const result = await dispatchPhoneInvoke({ id: 'x', method: 'ping', params: {} })
    expect(result).toEqual({ ok: true, result: { at: 1 } })
    expect(phoneInvokeStats().hasHandler).toBe(true)
    // 计数器是模块级累计值（生产里用于诊断），这里只证明这次调用被计入
    expect(phoneInvokeStats().handled).toBeGreaterThanOrEqual(1)
  })
})

function project(overrides: Partial<StudioProjectSummary> = {}): StudioProjectSummary {
  return {
    id: 'w1',
    kind: 'short',
    title: '末日咖啡馆',
    logline: '末日后唯一还开着的咖啡馆',
    updatedAt: 1_700_000_000_000,
    createdAt: 1_600_000_000_000,
    stage: 'writing',
    progress: 42.6,
    words: 1200,
    chapters: 3,
    shots: 0,
    assets: 2,
    budget: { spent: 0, limit: 0 } as StudioProjectSummary['budget'],
    demo: false,
    ...overrides
  }
}

describe('phoneWorks', () => {
  it('@core:relay 字段改名并取整进度', () => {
    const [work] = phoneWorks([project()])
    expect(work).toMatchObject({
      id: 'w1',
      title: '末日咖啡馆',
      kind: 'short',
      logline: '末日后唯一还开着的咖啡馆',
      updatedAtMillis: 1_700_000_000_000,
      stage: 'writing',
      progress: 43,
      chapters: 3,
      shots: 0,
      assets: 2,
      words: 1200
    })
  })

  it('@core:relay 按更新时间倒序且最多 40 个', () => {
    const list = Array.from({ length: 45 }, (_, i) =>
      project({ id: `w${i}`, title: `作品 ${i}`, updatedAt: 1_000 + i })
    )
    const works = phoneWorks(list)
    expect(works).toHaveLength(40)
    expect(works[0].id).toBe('w44')
    expect(works[39].id).toBe('w5')
  })

  it('@core:relay 进度越界被夹到 0–100', () => {
    const works = phoneWorks([
      project({ id: 'a', progress: -5 }),
      project({ id: 'b', progress: 140 }),
      project({ id: 'c', progress: Number.NaN })
    ])
    expect(works.map((w) => w.progress)).toEqual([0, 100, 0])
  })

  it('@core:relay 产物清单按创建时间倒序并映射字段', () => {
    const deliveries = [
      { id: 'd1', kind: 'pdf', label: '成书.pdf', path: 'exports/a.pdf', bytes: 100, sha256: '', createdAt: 2 },
      { id: 'd2', kind: 'mp4', label: '成片', path: 'exports/a.mp4', bytes: 200, sha256: '', createdAt: 3 }
    ] as StudioDelivery[]
    const [work] = phoneWorks([project()], () => phoneProducts(deliveries))
    expect(work.products.map((p) => p.id)).toEqual(['d2', 'd1'])
    expect(work.products[0]).toMatchObject({ kind: 'mp4', label: '成片', bytes: 200, createdAtMillis: 3 })
  })

  it('@core:relay 没有产物时作品本身不丢', () => {
    const [work] = phoneWorks([project()])
    expect(work.id).toBe('w1')
    expect(work.products).toEqual([])
  })
})