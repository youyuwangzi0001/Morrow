import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '../../../src/shared/types'
import { DemoProvider, collectDemoMetrics, renderDemoReportHtml } from '../../../src/core/providers/demo'
import { resetAllPermissionGrants, runAgent } from '../../../src/core/agent'
import { copyDemoWorkspace } from './helpers/workspace'

const here = dirname(fileURLToPath(import.meta.url))
const DEMO_SOURCE = join(here, '..', '..', '..', 'assets', 'demo-workspace')

describe('演示工作区数据计算（真实 CSV）', () => {
  it('从 assets/demo-workspace 计算出与基准一致的指标', () => {
    const ws = copyDemoWorkspace(DEMO_SOURCE)
    try {
      const metrics = collectDemoMetrics(ws.root)
      expect(metrics.source).toBe('workspace')
      expect(metrics.rawRows).toBe(103)
      expect(metrics.uniqueOrderIds).toBe(102)
      expect(metrics.validOrders).toBe(101)
      expect(metrics.duplicateExtra).toBe(1)
      expect(metrics.refundCount).toBe(1)
      expect(metrics.totalRevenue).toBe(171627.85)
      expect(metrics.avgOrderValue).toBe(1699.29)
      expect(metrics.q2Revenue).toBe(144900)
      expect(metrics.q2ReportedTotal).toBe(145760)
      expect(metrics.q2Gap).toBe(860)
      expect(metrics.qoqGrowth).toBeCloseTo(18.45, 2)
      expect(metrics.monthly.map((month) => month.revenue)).toEqual([43421.35, 61105.65, 67100.85])
      expect(metrics.monthly.map((month) => month.orders)).toEqual([32, 35, 34])
      expect(metrics.channels[0]).toMatchObject({ name: '京东自营', revenue: 61381.95 })
      expect(metrics.channels[1]).toMatchObject({ name: '微信小程序', revenue: 43666.9 })
      expect([...metrics.channels].sort((a, b) => b.orders - a.orders)[0].name).toBe('抖音直播')
      expect(metrics.cities[0]).toMatchObject({ name: '广州', revenue: 47964.7 })
      expect(metrics.categories[0]).toMatchObject({ name: '企业礼盒', revenue: 93712 })
      expect(metrics.anomalies).toHaveLength(4)
      expect(metrics.anomalies.map((item) => item.orderId)).toEqual(
        expect.arrayContaining(['ORD-2026Q3-0054', 'ORD-2026Q3-0098', 'ORD-2026Q3-0031', 'ORD-2026Q3-0003'])
      )
      expect(metrics.customerConflict).toEqual({ customer: '上海星野广告', salesCity: '上海', listCity: '杭州' })
      expect(metrics.files.sales).toBe('销售明细-2026Q3.csv')
    } finally {
      ws.cleanup()
    }
  })

  it('没有工作区时退回内置基准数据', () => {
    const metrics = collectDemoMetrics(null)
    expect(metrics.source).toBe('fallback')
    expect(metrics.totalRevenue).toBe(171627.85)
    expect(metrics.anomalies).toHaveLength(4)
    expect(renderDemoReportHtml(metrics, new Date()).length).toBeGreaterThan(5000)
  })

  it('报告 HTML 自包含：无外链资源、包含关键数字与结构', () => {
    const ws = copyDemoWorkspace(DEMO_SOURCE)
    try {
      const metrics = collectDemoMetrics(ws.root)
      const html = renderDemoReportHtml(metrics, new Date('2026-10-19T10:00:00+08:00'))
      expect(html).toContain('<!DOCTYPE html>')
      expect(html).toContain('Q3 销售复盘')
      expect(html).toContain('171,627.85')
      expect(html).toContain('1,699.29')
      expect(html).toContain('18.45%')
      expect(html).toContain('<svg')
      expect(html).toContain('数据里发现的问题')
      expect(html).toContain('下一步建议')
      // 不允许外部资源（字体/CDN/图片/脚本），只允许 SVG 命名空间字符串
      const withoutSvgNamespace = html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')
      expect(withoutSvgNamespace).not.toMatch(/https?:\/\//)
      expect(html).not.toMatch(/<link\b/i)
      expect(html).not.toMatch(/<script\b/i)
      expect(html).not.toContain('@import')
    } finally {
      ws.cleanup()
    }
  })
})

describe('DemoProvider 剧本（真实执行工具）', () => {
  it('完整播放：9 个演示步骤、12 次工具调用、生成报告并入画布', async () => {
    const ws = copyDemoWorkspace(DEMO_SOURCE)
    try {
      resetAllPermissionGrants()
      const events: RuntimeEvent[] = []
      const provider = new DemoProvider({ speed: 0 })
      const result = await runAgent({
        runId: 'run_demo',
        sessionId: 'session_demo',
        provider,
        model: { id: 'morrow-demo', label: 'Morrow Demo', contextWindow: 128_000, supportsTools: true },
        systemPrompt: '',
        history: [],
        userMessage: { id: 'u1', role: 'user', content: [{ type: 'text', text: '看一场演示' }], createdAt: Date.now() },
        workspace: ws.root,
        permissionMode: 'ask',
        snapshotDir: ws.snapshotDir,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        onPermission: async () => 'once',
        onAskUser: async () => ({ value: 'a', label: 'A' }),
        demo: true,
        maxSteps: 40
      })

      expect(result.reason).toBe('complete')
      // 演示步骤事件
      const demoSteps = events.filter((event) => event.type === 'demo_step')
      expect(demoSteps).toHaveLength(9)
      expect(demoSteps.map((event) => (event.type === 'demo_step' ? event.index : 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      // 演示模式不弹审批
      expect(events.some((event) => event.type === 'permission_requested')).toBe(false)
      // 工具调用全部真实执行
      const toolFinished = events.filter((event) => event.type === 'tool_finished')
      expect(toolFinished).toHaveLength(12)
      expect(toolFinished.every((event) => event.type === 'tool_finished' && event.result.ok)).toBe(true)
      // 计划面板更新过
      expect(events.filter((event) => event.type === 'todos_updated').length).toBeGreaterThanOrEqual(3)
      // 报告写入磁盘并注册为画布产物
      const reportPath = join(ws.root, '分析报告.html')
      expect(existsSync(reportPath)).toBe(true)
      const report = readFileSync(reportPath, 'utf8')
      // 留一份证据文件，供人工/截图检查视觉效果（tmp 不进交付物）
      const evidenceDir = join(here, '..', '..', '..', 'tmp', 'verify')
      mkdirSync(evidenceDir, { recursive: true })
      copyFileSync(reportPath, join(evidenceDir, 'demo-report.html'))
      expect(report).toContain('171,627.85')
      expect(report).toContain('京东自营')
      const artifactEvent = events.find((event) => event.type === 'artifacts_updated')
      expect(artifactEvent?.type === 'artifacts_updated' && artifactEvent.artifacts[0]).toMatchObject({
        title: 'Q3 销售复盘 · 2026',
        kind: 'html'
      })
      // 最后一条消息是三条建议，且主流程消息数 = 9 个剧本回合
      expect(result.messages).toHaveLength(9)
      const lastText = result.messages[result.messages.length - 1].content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
      expect(lastText).toContain('接下来我建议做这三件事')
      // 渲染出的演示文本包含真实数字（run_command 输出被剧本引用）
      const allToolOutput = result.messages
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'tool_use' && block.name === 'run_command')
        .map((block) => (block.type === 'tool_use' ? block.result?.output ?? '' : ''))
        .join('\n')
      expect(allToolOutput).toContain('有效订单数: 101')
      expect(allToolOutput).toContain('总销售额: 171627.85')
      expect(allToolOutput).toContain('差额: 860')
      // 事件信封与收尾
      expect(events[events.length - 1].type).toBe('run_finished')
      const finished = events[events.length - 1]
      expect(finished.type === 'run_finished' && finished.reason).toBe('complete')
    } finally {
      ws.cleanup()
    }
  }, 60_000)

  it('演示结束后再次调用会从头重播', async () => {
    const ws = copyDemoWorkspace(DEMO_SOURCE)
    try {
      const provider = new DemoProvider({ speed: 0 })
      const request = {
        system: '',
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        workspace: ws.root
      }
      const counts: number[] = []
      for (let round = 0; round < 2; round += 1) {
        let demoSteps = 0
        for await (const event of provider.stream(request)) {
          if (event.type === 'demo_step') demoSteps += 1
        }
        counts.push(demoSteps)
      }
      // 第一次播放会在最后一步标记结束；第二次重新出剧本
      expect(counts[0]).toBeGreaterThan(0)
      expect(counts[1]).toBeGreaterThan(0)
    } finally {
      ws.cleanup()
    }
  }, 60_000)
})
