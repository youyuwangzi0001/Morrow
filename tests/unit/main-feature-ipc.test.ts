// feature IPC 的错误码契约：领域错误（如文件不存在的 NOT_FOUND）必须原样透传给渲染层。
// 只读档的通道级门禁也挂在这个统一包装层上，所以一并在这里回归。
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

    // ── 只读档的通道级门禁 ──────────────────────────────────────
    // 读通道：只读档必须照常执行，否则「只读」会把查看也一起禁掉
    for (const channel of [
      'feature:files:read',
      'feature:files:list',
      'feature:files:inspect',
      'feature:files:preview',
      'feature:git:status',
      'feature:git:diff',
      'feature:git:log',
      'feature:git:show',
      'feature:git:branches',
      'feature:terminal:read',
      'feature:terminal:list',
      'feature:terminal:profiles',
      'feature:history:list',
      'feature:history:diff',
      'feature:media:catalog',
      'feature:media:status',
      'feature:permissions:list-rules',
      'feature:schedules:list',
      'feature:studio:data-dir-info',
      'feature:studio:reveal',
      'feature:browser:get-state'
    ]) {
      expect(isWriteChannel(channel), channel).toBe(false)
    }
    // 写通道：只读档必须拒绝（含 #4 点名却此前完全没门禁的 git / terminal）
    for (const channel of [
      'feature:files:write',
      'feature:files:create',
      'feature:files:delete',
      'feature:files:rename',
      'feature:files:move',
      'feature:git:init',
      'feature:git:stage',
      'feature:git:unstage',
      'feature:git:discard',
      'feature:git:commit',
      'feature:git:checkout',
      'feature:git:create-branch',
      'feature:git:set-identity',
      'feature:terminal:create',
      'feature:terminal:start-task',
      'feature:terminal:write',
      'feature:terminal:input',
      'feature:terminal:restart',
      'feature:terminal:remove',
      'feature:terminal:stop',
      'feature:history:record',
      'feature:history:restore',
      'feature:media:start',
      'feature:media:catalog-action',
      'feature:schedules:create',
      'feature:schedules:run-now',
      'feature:permissions:add-rule',
      'feature:permissions:remove-rule',
      'feature:studio:change-data-dir',
      'feature:studio:reset-data-dir',
      'feature:browser:decide-download'
    ]) {
      expect(isWriteChannel(channel), channel).toBe(true)
    }
    // 混合通道按 payload 里的动作类型二分：只读动作放行，写动作（保存/生成/导出）拒绝
    for (const type of ['get', 'list', 'list-jobs', 'list-versions', 'export-preflight']) {
      expect(isWriteChannel('feature:studio:action', { type }), type).toBe(false)
    }
    for (const type of ['save-chapter', 'generate-chapter', 'export', 'delete', 'import-package', 'retry-job']) {
      expect(isWriteChannel('feature:studio:action', { type }), type).toBe(true)
    }
    // 缺少类型时无法判定，按写处理（与 handler 报错一致，不留放行口子）
    expect(isWriteChannel('feature:studio:action', {})).toBe(true)

    let readOnly = false
    setReadOnlyProbe(() => readOnly)

    // 以真实写通道名注册，门禁才会按类别命中
    let startTaskRan = 0
    let gitStatusRan = 0
    registerFeatureHandler('feature:terminal:start-task', () => {
      startTaskRan += 1
      return { ok: true }
    })
    registerFeatureHandler('feature:git:status', () => {
      gitStatusRan += 1
      return { ok: true }
    })

    // 询问/完全访问档：写通道照常执行
    const allowed = await invokeFeatureForTest('feature:terminal:start-task', { command: 'echo hi' })
    expect(allowed.ok).toBe(true)
    expect(startTaskRan).toBe(1)

    // 只读档：写通道被拒，且 handler 根本没被执行
    readOnly = true
    const blocked = await invokeFeatureForTest('feature:terminal:start-task', { command: 'echo hi' })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.error.code).toBe('READ_ONLY')
      expect(blocked.error.hint).toContain('询问')
    }
    expect(startTaskRan).toBe(1)

    // 只读档：读通道仍然可用
    const readable = await invokeFeatureForTest('feature:git:status', { workspace: '.' })
    expect(readable.ok).toBe(true)
    expect(gitStatusRan).toBe(1)

    readOnly = false
    setReadOnlyProbe(() => false)
  })
})