import { describe, expect, it } from 'vitest'
import { compactSession, applyCompaction, messagesToPreserve, planCompaction } from '../../src/core/agent'
import { composeCompactionSummary, extractCompactionLedger } from '../../src/core/compaction'
import type { ChatMessage, ModelInfo } from '../../src/shared/types'
import type { Provider } from '../../src/core/types'

function message(role: 'user' | 'assistant', text: string, id: string): ChatMessage {
  return { id, role, content: [{ type: 'text', text }], createdAt: Date.now() }
}

const engineering: ChatMessage[] = [
  message('user', '修复认证轮换缺陷：/api/v1/login 必须保留 expires_in；不要改 src/auth/session.ts 的公开导出；不新增 npm 依赖；本地端口 4317；截止 2026-11-05。', 'u1'),
  message('assistant', '读取 src/auth/session.ts 与 src/auth/rotate.ts，发现并发轮换会抛 SQLITE_BUSY: database is locked。', 'a1'),
  message('user', '移动端 refresh token 不轮换，只有桌面端轮换；v1 客户端继续返回 expires_in。', 'u2'),
  message('assistant', '决定使用 BEGIN IMMEDIATE 包住轮换，失败重试一次；拒绝引入 Redis，避免新增依赖。', 'a2'),
  message('assistant', '【测试】npm test -- auth：14 passed，2 failed；失败原因是并发竞争与移动端分支。', 'a3'),
  message('assistant', '修改 src/auth/rotate.ts；新增 migrations/0042_audit.sql；audit_rotation 一次成功轮换恰好一行，只存 token_hash 和 client_type。', 'a4'),
  message('assistant', '【测试】npm test -- auth：18 passed；coverage 87.1%；移动端连续 3 次 refresh 值不变。', 'a5'),
  message('user', '最终验收必须包含 50 并发、无 SQLITE_BUSY、audit 行数等于成功轮换数；不要把覆盖率改成估算。', 'u3'),
  message('assistant', '【并发测试】50 并发全部成功，0 次 SQLITE_BUSY；audit_rotation 新增 50 行；p95 38ms。', 'a6'),
  message('assistant', '回滚方案：撤销 rotate.ts 事务，保留 migration 0042；不改 package.json，不触碰 session.ts 导出。', 'a7')
]

const literature: ChatMessage[] = [
  message('user', '写民国悬疑长篇：第一人称林晚；不要重生、不要系统；共 8 章，每章约 3000 字；关键人物沈砚（钟表匠）、周鹤（巡捕）；第 6 章发现信纸夹层，结局揭示沈川。', 'l1'),
  message('assistant', '第 1 章：林晚在报社校样发现蓝铅笔字“七天后，钟楼会停”；钟表铺的沈砚在修一只停在四点十七分的怀表。', 'l2'),
  message('user', '沈砚的哥哥沈川失踪；红蜡封上有“鹤”字；林晚不会武功；周鹤不是纯反派。', 'l3'),
  message('assistant', '第 2 章：林晚在钟楼夹层找到鹤字蜡封信，信上写着“不要相信周鹤”；她把信藏进校样夹。', 'l4'),
  message('assistant', '第 3 章：周鹤调查沈川失踪案；沈砚说哥哥去了香港，但摸左腕表带时在说谎。', 'l5'),
  message('user', '第 6 章必须发现信纸夹层里的钟楼地下平面图；不要提前揭示沈川结局；结尾章才让他活着出现。', 'l6'),
  message('assistant', '第 4 章：旧档显示周鹤经手三年前钟楼失火案；沈川的失踪记录被蓝铅笔划掉。', 'l7'),
  message('assistant', '第 5 章：钟楼连续两晚在四点十七分停摆；沈砚修好后故意让齿轮卡住。', 'l8'),
  message('assistant', '第 6 章：信纸受潮分层，夹层是钟楼地下平面图；图纸背面有沈川缩写 S.C.。', 'l9'),
  message('user', '第 7 章林晚用报社通行证支开守门人，不要让她会武功；周鹤封锁钟楼但不要开枪。', 'l10'),
  message('assistant', '第 7 章：林晚用“报社夜间校样”通行证进入钟楼；守门人认识她；周鹤封锁正门。', 'l11'),
  message('user', '结局沈川活着出现，不写获救过程；不点明林晚和沈砚是否在一起；最后一句保留钟声。', 'l12'),
  message('assistant', '第 8 章：沈川被从地下带出，沈砚承认伪造香港来信保护弟弟；结尾林晚烧掉校样，钟声响起。', 'l13')
]

function summaryProvider(summary: string): Provider {
  return {
    id: 'test',
    stream: async function* () {
      yield { type: 'text_delta', text: summary }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
    }
  } as unknown as Provider
}

const model: ModelInfo = {
  id: 'deepseek-flash',
  label: 'DeepSeek Flash',
  contextWindow: 3_000,
  supportsTools: true
}

describe('压缩 v2：真实任务事实保留', () => {
  it('@core:context 账本从工程/叙事历史中抽取可核对事实，并过滤密钥', () => {
    const engineeringLedger = extractCompactionLedger(engineering, 3000)
    expect(engineeringLedger).toContain('expires_in')
    expect(engineeringLedger).toContain('87.1')
    expect(engineeringLedger).toContain('audit_rotation')
    expect(engineeringLedger).toContain('src/auth/rotate.ts')
    expect(engineeringLedger).toContain('4317')

    const literatureLedger = extractCompactionLedger(literature, 3000)
    expect(literatureLedger).toContain('林晚')
    expect(literatureLedger).toContain('平面图')
    expect(literatureLedger).toContain('钟声')

    const withSecret = [message('assistant', 'API Key: sk-test-abcdefghijklmnop，不能写入摘要。', 'secret')]
    expect(extractCompactionLedger(withSecret)).not.toContain('sk-test')
  })

  it('@core:context 旧摘要与账本原文保留，新摘要只追加，不反复改写', () => {
    const previous = '## 历史交接摘要（原文保留）\n用户要求保留 expires_in。\n\n## 关键信息账本（系统原文保留，不参与重写）\n- 已存在账本'
    const ledger = '### 用户约束与决定\n- audit_rotation 一行\n### 文件与路径\n- src/auth/rotate.ts'
    const combined = composeCompactionSummary(previous, '新增历史：完成 50 并发测试。', ledger)
    expect(combined).toContain('用户要求保留 expires_in')
    expect(combined).toContain('新增历史：完成 50 并发测试')
    expect(combined).toContain('audit_rotation 一行')
    expect(combined.indexOf('关键信息账本')).toBeLessThan(combined.indexOf('历史交接摘要'))
    expect(combined.match(/关键信息账本/g)).toHaveLength(1)
  })

  it('@core:context 压缩保留最近用户消息和账本事实，且不把完整历史带回来', async () => {
    const result = await compactSession({
      provider: summaryProvider('## 目标与验收\n修复认证轮换；桌面轮换，移动端不轮换。\n## 已完成与关键决策\nBEGIN IMMEDIATE。'),
      model,
      systemPrompt: '',
      messages: engineering,
      signal: new AbortController().signal,
      force: true,
      keepRecent: 4
    })
    expect(result.compacted).toBe(true)
    const text = result.messages.map((item) => item.content.map((block) => (block.type === 'text' ? block.text : '')).join('')).join('\n')
    expect(text).toContain('expires_in')
    expect(text).toContain('audit_rotation')
    expect(text).toContain('87.1')
  }, 10_000)

  it('@core:context 计划记录最近用户消息预算，叙事任务同样可压缩', () => {
    const plan = planCompaction(literature, '', 3_000, { keepRecent: 4, force: true })
    expect(plan.shouldCompact).toBe(true)
    expect(plan.preserveUserTokens).toBeGreaterThan(0)
    const preserved = messagesToPreserve(literature, plan.cutIndex, plan.preserveUserTokens ?? 0)
    expect(preserved.some((item) => item.content.some((block) => block.type === 'text' && block.text.includes('第 6 章必须发现信纸夹层')))).toBe(true)
    const compacted = applyCompaction(literature, plan.cutIndex, '摘要：林晚第一人称，第 6 章夹层平面图，结局沈川活着，钟声结尾。', plan.preserveUserTokens ?? 0)
    const text = compacted.map((item) => item.content.map((block) => (block.type === 'text' ? block.text : '')).join('')).join('\n')
    expect(text).toContain('沈川')
    expect(text).toContain('钟声')
  })
})
