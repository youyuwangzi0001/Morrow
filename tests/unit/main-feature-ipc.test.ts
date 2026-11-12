// feature IPC 的错误码契约：领域错误（如文件不存在的 NOT_FOUND）必须原样透传给渲染层。
// 只读档的通道级门禁也在这里回归：它挂在同一个统一包装层上，与错误码契约同源。
import { describe, expect, it } from 'vitest'

describe('feature IPC 错误码', () => {
  it('@core:workspace 领域错误保留自己的 code 与 hint，其它异常仍归为 FEATURE_ERROR；只读档统一拦住写通道', async () => {
    const { registerFeatureHandler, invokeFeatureForTest, setReadOnlyProbe, isWriteChannel } = await import('../../src/main/feature-ipc')

    class DomainError extends Error {
      code: string
      hint?: string
      constructor(code: string, message: string, hint?: string) {
        super(message)
        this.code = code
        if (hint) this.hint = hint
      }
    }

    registerFeatureHandler('feature:test:domain', () => {
      throw new DomainError('NOT_FOUND', '这个文件夹已经不存在了。', '刷新文件树后重试。')
    })
    registerFeatureHandler('feature:test:plain', () => {
      throw new Error('普通失败')
    })
    registerFeatureHandler('feature:test:lowercase', () => {
      const err = new Error('小写码')
      ;(err as unknown as { code: string }).code = 'not_found'
      throw err
    })

    const domain = await invokeFeatureForTest('feature:test:domain')
    expect(domain.ok).toBe(false)
    if (!domain.ok) {
      expect(domain.error.code).toBe('NOT_FOUND')
      expect(domain.error.hint).toBe('刷新文件树后重试。')
      expect(domain.error.message).toBe('这个文件夹已经不存在了。')
    }

    const plain = await invokeFeatureForTest('feature:test:plain')
    expect(plain.ok).toBe(false)
    if (!plain.ok) expect(plain.error.code).toBe('FEATURE_ERROR')

    // 系统错误（如 ENOENT 之外的 node code）不是领域码，不能直接当业务分支依据
    const lowercase = await invokeFeatureForTest('feature:test:lowercase')
    expect(lowercase.ok).toBe(false)
    if (!lowercase.ok) expect(lowercase.error.code).toBe('FEATURE_ERROR')

    // ── 只读档的通道级门禁（与错误码同属统一包装层）──
    let readOnly = false
    setReadOnlyProbe(() => readOnly)

    let gitDiscardRan = 0
    let startTaskRan = 0
    let statusRan = 0
    registerFeatureHandler('feature:test:write-exec', () => {
      gitDiscardRan += 1
      return { ok: true }
    })
    registerFeatureHandler('feature:test:read-only-exec', () => {
      statusRan += 1
      return { ok: true }
    })
    // 以真实写通道名注册，门禁才会按 WRITE_ACTIONS 命中
    registerFeatureHandler('feature:terminal:start-task', () => {
      startTaskRan += 1
      return { ok: true }
    })

    // 询问档：写通道照常执行
    const allowed = await invokeFeatureForTest('feature:test:write-exec', {})
    expect(allowed.ok).toBe(true)
    expect(gitDiscardRan).toBe(1)

    // 只读档：通道分类本身要正确（真实注册表里的读写边界）
    for (const channel of [
      'feature:git:status',
      'feature:git:diff',
      'feature:git:log',
      'feature:git:show',
      'feature:git:branches',
      'feature:files:read',
      'feature:files:list',
      'feature:files:inspect',
      'feature:terminal:read',
      'feature:terminal:list'
    ]) {
      expect(isWriteChannel(channel), channel).toBe(false)
    }
    for (const channel of [
      'feature:git:discard',
      'feature:git:commit',
      'feature:git:checkout',
      'feature:git:stage',
      'feature:git:unstage',
      'feature:git:init',
      'feature:files:write',
      'feature:files:delete',
      'feature:files:rename',
      'feature:files:move',
      'feature:terminal:start-task',
      'feature:terminal:write',
      'feature:history:restore'
    ]) {
      expect(isWriteChannel(channel), channel).toBe(true)
    }

    // 只读档下写通道被拒，且 handler 没有被执行
    readOnly = true
    const blockedDiscard = await invokeFeatureForTest('feature:terminal:start-task', { command: 'echo hi' })
    expect(blockedDiscard.ok).toBe(false)
    if (!blockedDiscard.ok) {
      expect(blockedDiscard.error.code).toBe('READ_ONLY')
      expect(blockedDiscard.error.hint).toContain('询问')
    }
    expect(startTaskRan).toBe(0)

    // 只读档下读通道仍然可用（只读不等于什么都做不了）
    const readable = await invokeFeatureForTest('feature:test:read-only-exec', {})
    expect(readable.ok).toBe(true)
    expect(statusRan).toBe(1)

    readOnly = false
    setReadOnlyProbe(() => false)
  })
})
