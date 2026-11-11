// feature IPC 的错误码契约：领域错误（如文件不存在的 NOT_FOUND）必须原样透传给渲染层。
import { describe, expect, it } from 'vitest'

describe('feature IPC 错误码', () => {
  it('@core:workspace 领域错误保留自己的 code 与 hint，其它异常仍归为 FEATURE_ERROR', async () => {
    const { registerFeatureHandler, invokeFeatureForTest } = await import('../../src/main/feature-ipc')

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
  })
})
