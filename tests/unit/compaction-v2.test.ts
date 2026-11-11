import { describe, expect, it } from 'vitest'
import {
  compactSession,
  applyModelCompaction,
  estimateMessagesTokens,
  messagesToPreserve,
  planCompaction
} from '../../src/core/agent'
import {
  composeCompactionSummary,
  extractCompactionLedger,
  isCompactionSummaryMessage,
  modelMessagesFrom
} from '../../src/core/compaction'
import { positionCompactionNotices } from '../../src/shared/types'
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
    const outcome = applyModelCompaction(literature, literature, plan, '摘要：林晚第一人称，第 6 章夹层平面图，结局沈川活着，钟声结尾。', {
      systemPrompt: '',
      contextLimit: 3_000
    })
    const text = outcome.modelMessages
      .map((item) => item.content.map((block) => (block.type === 'text' ? block.text : '')).join(''))
      .join('\n')
    expect(text).toContain('沈川')
    expect(text).toContain('钟声')
  })

  it('@core:context 压缩摘要记录原文保留的消息，展示标记落在真实切点', () => {
    const plan = planCompaction(literature, '', 3_000, { keepRecent: 4, force: true })
    const outcome = applyModelCompaction(literature, literature, plan, '摘要：林晚第一人称，第 6 章夹层平面图。', {
      systemPrompt: '',
      contextLimit: 3_000
    })
    const summary = outcome.marker
    const preservedIds = summary.preservedMessageIds ?? []
    expect(summary.role).toBe('system')
    expect(preservedIds.length).toBeGreaterThan(0)

    // 分层契约：完整记录一条不少，标记插在真实切点（其后紧跟被保留的第一段历史）
    expect(outcome.messages.length).toBe(literature.length + 1)
    const markerIndex = outcome.messages.findIndex((message) => message.id === summary.id)
    expect(markerIndex).toBeGreaterThan(0)
    expect(outcome.messages[markerIndex + 1]?.id).toBe(literature[plan.cutIndex]?.id)
    // 模型侧：摘要 + 原文保留的消息 + 切点之后的近期历史
    expect(outcome.modelMessages[0]?.id).toBe(summary.id)
    expect(outcome.modelMessages.slice(1, 1 + preservedIds.length).map((message) => message.id)).toEqual(preservedIds)

    // 新格式标记已在真实切点，展示顺序原样返回
    const positioned = positionCompactionNotices(outcome.messages)
    expect(positioned.map((message) => message.id)).toEqual(outcome.messages.map((message) => message.id))
  })

  it('@core:context 没有原文保留消息时摘要仍在开头', () => {
    const summary: ChatMessage = {
      id: 'summary-no-preserve',
      role: 'system',
      createdAt: Date.now(),
      content: [{ type: 'text', text: '[历史对话摘要 · 已压缩]\n摘要正文' }]
    }
    const kept = message('assistant', '继续执行。', 'a-kept')
    const original = [summary, kept]
    expect(positionCompactionNotices(original)).toBe(original)
    expect(positionCompactionNotices([{ ...summary, preservedMessageIds: ['u-none'] }, kept])[0]?.id).toBe('summary-no-preserve')
  })
})

/**
 * 回归：压缩触发必须与服务商真实用量同口径。
 * 历史上触发判定只看本地字符估算（CJK 1 字≈1 token），对中文/工具输出系统性偏低，
 * 于是出现「设置里已显示 430.8k / 400k（100%）却始终不自动压缩」。
 */
describe('压缩触发口径：真实 usage 优先于本地估算', () => {
  const limit = 400_000
  const threshold = 0.8
  // 一段确实很长、也确实可压缩的历史：本地估算约 200k，而服务商实测 430.8k。
  // 这正是问题场景——历史够长（能切），只是本地估算没到阈值。
  const longHistory: ChatMessage[] = Array.from({ length: 20 }, (_, index) =>
    message(
      index % 2 === 0 ? 'user' : 'assistant',
      '这是一段足够长的中文内容，用来把本地估算推到阈值附近。'.repeat(400),
      `m${index}`
    )
  )

  it('@core:context 本地估算未到阈值时，服务商已报 430.8k 仍应触发压缩', () => {
    const estimateOnly = planCompaction(longHistory, '', limit, { threshold })
    // 前提：本地估算确实低于阈值，否则这条用例没有覆盖到问题
    expect(estimateOnly.estimatedTokens).toBeLessThan(limit * threshold)
    expect(estimateOnly.shouldCompact).toBe(false)

    const measured = planCompaction(longHistory, '', limit, { threshold, measuredTokens: 430_783 })
    expect(measured.shouldCompact).toBe(true)
    expect(measured.measuredTokens).toBe(430_783)
    // estimatedTokens 仍保留本地估算语义，供下游计算节省量
    expect(measured.estimatedTokens).toBe(estimateOnly.estimatedTokens)
  }, 20_000)

  it('@core:context 实测值未到阈值时不应误触发', () => {
    const plan = planCompaction(longHistory, '', limit, { threshold, measuredTokens: 200_000 })
    expect(plan.shouldCompact).toBe(false)
    expect(plan.reason).toBe('below-threshold')
  })

  it('@core:context 没有真实 usage 时退回本地估算，行为与之前一致', () => {
    const tall = Array.from({ length: 40 }, (_, index) =>
      message(
        index % 2 === 0 ? 'user' : 'assistant',
        '这是一段足够长的中文内容，用来把估算值推过阈值。'.repeat(400),
        `t${index}`
      )
    )
    const withoutUsage = planCompaction(tall, '', limit, { threshold })
    expect(withoutUsage.shouldCompact).toBe(true)
    expect(withoutUsage.estimatedTokens).toBeGreaterThan(0)

    // 0 视为「没有可用实测」，不能因为传了 0 就永远不压缩
    const withZero = planCompaction(tall, '', limit, { threshold, measuredTokens: 0 })
    expect(withZero.shouldCompact).toBe(true)
  }, 20_000)

  it('@core:context 阈值仍然按模型窗口比例计算，与实测值同乘同一套阈值', () => {
    const plan = planCompaction(longHistory, '', limit, { threshold, measuredTokens: 430_783 })
    expect(plan.thresholdTokens).toBe(Math.floor(limit * threshold))
  })

  it('@core:context 实测值低于本地估算时取较大者，不被过时的 usage 拉低', () => {
    // usage 只代表「上一次请求」；此后新增的历史只能由估算覆盖。
    const tall = Array.from({ length: 40 }, (_, index) =>
      message(
        index % 2 === 0 ? 'user' : 'assistant',
        '这是一段足够长的中文内容，用来把估算值推过阈值。'.repeat(400),
        `g${index}`
      )
    )
    const noUsage = planCompaction(tall, '', limit, { threshold })
    expect(noUsage.shouldCompact).toBe(true)

    const staleUsage = planCompaction(tall, '', limit, { threshold, measuredTokens: 1_000 })
    expect(staleUsage.shouldCompact).toBe(true)
    expect(staleUsage.measuredTokens).toBe(1_000)
  }, 20_000)
})

/**
 * 回归：压缩后当前窗口必须留下足够多的近期历史。
 * 旧实现只按「条数」（keepRecent）保留，长消息两三条就撑满，
 * 于是一次压缩把几十轮开发过程削成「摘要 + 首条用户消息」，
 * 用户反馈「只剩我的原始消息，不便于追溯开发过程」。
 */
describe('压缩后保留近期历史（可追溯性）', () => {
  const limit = 12_000
  const threshold = 0.8
  const conversation: ChatMessage[] = []
  for (let index = 0; index < 200; index += 1) {
    conversation.push(message('user', `请继续第 ${index} 步：实现功能 ${index}。`, `u${index}`))
    conversation.push(
      message(
        'assistant',
        `第 ${index} 步完成。修改了 src/module-${index}.ts，运行测试通过，继续下一步。`,
        `a${index}`
      )
    )
  }

  it('@core:context 压缩后保留多轮近期对话，而不是只剩首条用户消息', () => {
    const plan = planCompaction(conversation, '', limit, { threshold, keepRecent: 8 })
    expect(plan.shouldCompact).toBe(true)
    const outcome = applyModelCompaction(conversation, conversation, plan, '摘要：持续实现功能。', {
      systemPrompt: '',
      contextLimit: limit
    })
    const compacted = outcome.modelMessages

    const keptRecent = compacted.slice(1)
    expect(keptRecent.length).toBeGreaterThan(10)
    // 保留段里要有成对的 user/assistant，才能追溯「哪一轮做了什么」
    expect(keptRecent.filter((item) => item.role === 'assistant').length).toBeGreaterThan(3)
    expect(keptRecent.filter((item) => item.role === 'user').length).toBeGreaterThan(3)
  }, 20_000)

  it('@core:context 压缩后不会因为略高于理想目标就再触发深度折叠', () => {
    const plan = planCompaction(conversation, '', limit, { threshold, keepRecent: 8 })
    // 保住近期历史可能让 afterTokens 高于 targetRatio，但仍在阈值以内就不该深度折叠
    expect(plan.afterTokens).toBeDefined()
    expect(plan.afterTokens!).toBeLessThan(plan.thresholdTokens)
    expect(plan.overTarget).toBe(false)
  }, 20_000)
})

/**
 * 回归：同一轮里多次压缩时，轮次必须能追溯。
 * 旧实现每次压缩都新写一条摘要消息，而旧摘要会被切进被压缩段，
 * 界面上就只剩一条「已压缩」，看不出已经是第几次。
 */
describe('多次压缩的轮次记录', () => {
  const limit = 12_000
  const threshold = 0.8

  function buildHistory(): ChatMessage[] {
    const list: ChatMessage[] = []
    for (let index = 0; index < 200; index += 1) {
      list.push(message('user', `第 ${index} 轮需求：继续实现，保持既有测试通过。`.repeat(8), `u${index}`))
      list.push(message('assistant', `第 ${index} 轮完成，改动若干文件并通过测试。`.repeat(12), `a${index}`))
    }
    return list
  }

  it('@core:context 第一次压缩标记为第 1 次，并写明节省量', () => {
    const history = buildHistory()
    const plan = planCompaction(history, '', limit, { threshold })
    expect(plan.compactionRound).toBe(1)
    const outcome = applyModelCompaction(history, history, plan, '摘要正文', {
      systemPrompt: '',
      contextLimit: limit
    })
    const header = outcome.modelMessages[0]!.content[0]
    expect(header.type).toBe('text')
    if (header.type === 'text') {
      expect(header.text).toContain('第 1 次压缩')
      expect(header.text).toMatch(/节省\s*[\d,]+\s*tokens/)
    }
  }, 20_000)

  it('@core:context 第二次压缩接着记第 2 次，不会退回第 1 次', () => {
    const history = buildHistory()
    const first = planCompaction(history, '', limit, { threshold })
    const once = applyModelCompaction(history, history, first, '第一段摘要', {
      systemPrompt: '',
      contextLimit: limit
    })
    // 继续累积历史，直到再次达到阈值（记录与模型侧同步增长）
    const grownRecord = [...once.messages]
    const grownModel = [...once.modelMessages]
    for (let index = 0; index < 120; index += 1) {
      const user = message('user', `后续需求 ${index}：继续保持。`.repeat(8), `nu${index}`)
      const assistant = message('assistant', `后续完成 ${index}，测试通过。`.repeat(12), `na${index}`)
      grownRecord.push(user, assistant)
      grownModel.push(user, assistant)
    }
    // 分层后，压缩规划必须基于模型侧视图；记录只增不减，拿它规划会重复触发
    const second = planCompaction(grownModel, '', limit, { threshold })
    expect(second.shouldCompact).toBe(true)
    expect(second.compactionRound).toBe(2)
    const twice = applyModelCompaction(grownRecord, grownModel, second, '第二段摘要', {
      systemPrompt: '',
      contextLimit: limit
    })
    const header = twice.modelMessages[0]!.content[0]
    if (header.type === 'text') expect(header.text).toContain('第 2 次压缩')
  }, 30_000)
})

/**
 * 分层压缩：模型侧与会话记录分离。
 *
 * 这些用例锁住交接文档要求的核心性质——压缩只作用于「发给模型的那份」，
 * 完整记录（界面、落盘、导出、搜索）永远一条不少。
 */
describe('分层压缩：模型侧与完整记录分离', () => {
  const limit = 12_000

  function toolHistory(count: number): ChatMessage[] {
    const list: ChatMessage[] = []
    for (let index = 0; index < count; index += 1) {
      list.push(message('user', `第 ${index} 轮：读取文件并继续。`.repeat(4), `u${index}`))
      const assistant: ChatMessage = message('assistant', `第 ${index} 轮完成。`.repeat(4), `a${index}`)
      assistant.content.push({
        type: 'tool_use',
        id: `tool-${index}`,
        name: 'read_file',
        title: `读取 module-${index}.ts`,
        category: 'read',
        status: 'success',
        input: { path: `src/module-${index}.ts` },
        result: { ok: true, output: `第 ${index} 个模块源码。`.repeat(120) }
      })
      list.push(assistant)
    }
    return list
  }

  it('@core:context 压缩只插入标记且模型侧落进 10%–20% 预算', () => {
    const record = toolHistory(12)
    const modelView = modelMessagesFrom(record)
    const before = estimateMessagesTokens(modelView, '')
    const plan = planCompaction(modelView, '', limit, { threshold: 0.8, keepRecent: 4 })
    expect(plan.shouldCompact).toBe(true)

    const outcome = applyModelCompaction(record, modelView, plan, '## 目标\n继续实现。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })

    // 记录 = 原文 + 1 条摘要标记，顺序与 id 都不变（界面/落盘/导出据此一条不少）
    expect(outcome.messages.length).toBe(record.length + 1)
    const kept = outcome.messages.filter((item) => !isCompactionSummaryMessage(item))
    expect(kept.map((item) => item.id)).toEqual(record.map((item) => item.id))
    expect(outcome.marker.preservedMessageIds?.length).toBeGreaterThan(0)
    // 模型侧显著变短，且落进目标区间
    expect(outcome.afterTokens).toBeLessThan(before)
    expect(outcome.afterTokens / limit).toBeLessThanOrEqual(0.2)
    expect(outcome.modelMessages.length).toBeLessThan(modelView.length)
  }, 20_000)

  it('@core:context 折叠预算写进标记，旧会话单数组也原样重建', () => {
    const record = toolHistory(12)
    const modelView = modelMessagesFrom(record)
    const plan = planCompaction(modelView, '', limit, { threshold: 0.8, keepRecent: 4 })
    const outcome = applyModelCompaction(record, modelView, plan, '## 目标\n继续实现。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })

    expect(outcome.marker.modelTrimChars).toBeGreaterThan(0)
    // 仅凭记录重建，必须复现同样的折叠结果（否则下一轮请求会退回全文）
    const rebuilt = modelMessagesFrom(outcome.messages)
    expect(estimateMessagesTokens(rebuilt, '')).toBe(outcome.afterTokens)
    // 旧会话（没有任何摘要标记）就是完整历史，无需迁移
    expect(modelMessagesFrom(record).map((item) => item.id)).toEqual(record.map((item) => item.id))
  }, 20_000)

  it('@core:context 重建后的模型视图不再触发压缩', () => {
    const record = toolHistory(12)
    const modelView = modelMessagesFrom(record)
    const plan = planCompaction(modelView, '', limit, { threshold: 0.8, keepRecent: 4 })
    const outcome = applyModelCompaction(record, modelView, plan, '## 目标\n继续实现。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })

    // 回归：修复前规划读的是完整记录（只增不减），压缩后估算值继续上涨，
    // 于是每一步都重复压缩，最终把模型视图清到只剩摘要。
    // 重建视图必须稳定低于阈值，下一次规划应明确返回「不需要压缩」。
    const rebuilt = modelMessagesFrom(outcome.messages)
    const again = planCompaction(rebuilt, '', limit, { threshold: 0.8, keepRecent: 4 })
    expect(again.shouldCompact).toBe(false)
    expect(again.estimatedTokens).toBeLessThan(again.thresholdTokens)
    expect(outcome.afterTokens / limit).toBeLessThanOrEqual(0.2)
  }, 20_000)

  it('@core:context 压缩后新增的消息在重建时保持原文', () => {
    const record = toolHistory(12)
    const modelView = modelMessagesFrom(record)
    const plan = planCompaction(modelView, '', limit, { threshold: 0.8, keepRecent: 4 })
    const outcome = applyModelCompaction(record, modelView, plan, '## 目标\n继续实现。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })

    // 模拟压缩之后又发生了新一轮大工具结果
    const later = message('assistant', '压缩后新增的工作。', 'later')
    later.content.push({
      type: 'tool_use',
      id: 'tool-later',
      name: 'read_file',
      title: '读取 later.ts',
      category: 'read',
      status: 'success',
      input: { path: 'src/later.ts' },
      result: { ok: true, output: '压缩后读到的原文。'.repeat(100) }
    })
    const rebuilt = modelMessagesFrom([...outcome.messages, later])
    const tail = rebuilt[rebuilt.length - 1]!
    const block = tail.content.find((item) => item.type === 'tool_use')
    expect(block && block.type === 'tool_use' ? block.result?.output : '').toContain('压缩后读到的原文。'.repeat(10))
  }, 20_000)

})
