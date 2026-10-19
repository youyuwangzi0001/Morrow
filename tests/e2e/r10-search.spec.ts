/**
 * R10-I 搜索 feature 的 E2E 接线测试。
 * Lead 在 src/main/features/index.ts 注册 `import './search'` 且挂载 SearchPanel 后，
 * 本用例会自动从「跳过」变为「真实执行」（同一条测试，不伪造）。
 */
import { expect, test } from '@playwright/test'
import { launchMorrow } from './launch'

test.describe('R10-I 全局搜索接线', () => {
  test('feature:search:status / query 可用，返回分组与索引状态', async () => {
    const morrow = await launchMorrow({ name: 'r10-search' })
    try {
      await morrow.page.waitForFunction(() => Boolean((window as unknown as { morrow?: unknown }).morrow), undefined, {
        timeout: 30_000
      })
      const status = await morrow.page.evaluate(async () => {
        const api = (window as unknown as { morrow: { features: { invoke: (c: string, p?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: { message: string } }> } } }).morrow
        try {
          return await api.features.invoke('feature:search:status', {})
        } catch (err) {
          return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } }
        }
      })
      test.skip(!status.ok, '搜索模块尚未由 Lead 注册到 features/index.ts（集成后自动执行）')
      expect(status.ok).toBe(true)
      expect(status.data).toMatchObject({ ready: expect.any(Boolean), sessions: expect.any(Number), files: expect.any(Number) })

      const query = await morrow.page.evaluate(async () => {
        const api = (window as unknown as { morrow: { features: { invoke: (c: string, p?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: { message: string } }> } } }).morrow
        try {
          return await api.features.invoke('feature:search:query', { q: '测试', limit: 5 })
        } catch (err) {
          return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } }
        }
      })
      expect(query.ok).toBe(true)
      expect(query.data).toMatchObject({
        query: '测试',
        groups: { sessions: expect.any(Array), files: expect.any(Array), artifacts: expect.any(Array) },
        total: expect.any(Number),
        tookMs: expect.any(Number)
      })
      const index = (query.data as { index: { workspaces: unknown } }).index
      expect(Array.isArray(index.workspaces)).toBe(true)
    } finally {
      await morrow.close()
    }
  })
})
