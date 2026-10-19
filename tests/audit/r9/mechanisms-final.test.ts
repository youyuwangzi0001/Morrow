/**
 * R9 机制验收最终复跑（阶段 B，scripted/mock，不耗真实请求）。
 *
 * 断言 R2-A—R2-H 8/8 PASS；结果写 docs/audit/logs/r9-mechanism-final.json。
 * 命令：npx vitest run --config tests/audit/vitest.config.ts tests/audit/r9/mechanisms-final.test.ts
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../helpers'
import { runMechanismProbes } from './mechanisms'

describe('R9 机制验收 R2-A—R2-H（最终）', () => {
  it('八项机制探针全部 PASS（scripted/mock，0 真实请求）', async () => {
    const results = await runMechanismProbes()
    const dir = join(PROJECT_ROOT, 'docs', 'audit', 'logs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'r9-mechanism-final.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2), 'utf8')
    const failed = results.filter((item) => item.status !== 'PASS')
    console.log(`[r9-mechanism] ${results.map((item) => `${item.id}:${item.status}`).join(' ')}`)
    for (const item of results) console.log(`[r9-mechanism] ${item.id} ${item.status} · ${item.detail}`)
    expect(failed, JSON.stringify(failed)).toHaveLength(0)
    expect(results).toHaveLength(8)
  }, 600_000)
})
