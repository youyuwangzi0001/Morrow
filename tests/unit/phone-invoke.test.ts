import { beforeEach, describe, expect, it } from 'vitest'
import { dispatchPhoneInvoke, phoneInvokeStats, setPhoneInvokeHandler } from '../../src/main/phone-invoke'

/**
 * 手机上行指令的白名单与参数校验。
 *
 * 这些用例守的是**安全边界**，不是「功能能不能用」：
 * 未知方法不能被执行、手机不能回 `always`、参数缺失时处理器根本不会被调用、
 * 处理器抛错不能把异常冒到 socket 层。
 */

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