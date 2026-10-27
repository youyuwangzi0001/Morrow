// 计划模式工具：submit_plan。
import type { Artifact, PlanStep, SessionPlan } from '../../shared/types'
import type { ToolContext } from '../types'
import { newId, truncateText } from '../util'
import { getString } from './args'
import { errResult, okResult, oneLineInput, type ToolImpl } from './types'

const MAX_STEPS = 12

function parseSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return []
  const steps: PlanStep[] = []
  for (const item of raw.slice(0, MAX_STEPS)) {
    let text = ''
    if (typeof item === 'string') text = item.trim()
    else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const candidate = obj.text ?? obj.title ?? obj.content
      if (typeof candidate === 'string') text = candidate.trim()
    }
    if (!text) continue
    steps.push({ id: newId('step'), text: truncateText(text, 300) })
  }
  return steps
}

function planMarkdown(plan: SessionPlan): string {
  const lines = [`# ${plan.title}`, '', plan.summary, '', '## 执行步骤', '']
  plan.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.text}`)
  })
  if (plan.risks?.trim()) {
    lines.push('', '## 风险与前提', '', plan.risks.trim())
  }
  lines.push('', '> 本计划由 Morrow 生成，经用户批准后才会执行。')
  return lines.join('\n')
}

export const submitPlanTool: ToolImpl = {
  definition: {
    name: 'submit_plan',
    description:
      '在计划模式下提交执行计划，等待用户批准。只有计划模式可用；调用前应先用只读工具查看工作区与资料。' +
      '计划必须具体、可验证：3-8 个步骤，每步说明要做什么、产出什么。提交后不要声称已经执行或完成。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '计划标题（简短，例如「整理 Q3 销售数据并生成报告」）' },
        summary: { type: 'string', description: '计划概述：目标、方法、最终交付物' },
        steps: {
          type: 'array',
          description: '按顺序执行的具体步骤（3-8 个为宜）',
          items: {
            type: 'object',
            properties: { text: { type: 'string', description: '步骤描述（包含产出）' } },
            required: ['text']
          }
        },
        risks: { type: 'string', description: '风险、假设或需要用户确认的前提（可选）' }
      },
      required: ['title', 'summary', 'steps']
    },
    category: 'meta',
    risk: 'low',
    titleFor: (input) => `提交计划 ${oneLineInput(input, 'title', 48)}`
  },
  async execute(input, ctx: ToolContext): Promise<ReturnType<typeof okResult>> {
    if (!ctx.planMode) {
      return errResult(
        '当前不在计划模式，不能提交计划。',
        '请让用户用 /plan 或输入框旁的「计划」按钮进入计划模式后再试；现有工作模式下直接执行即可。'
      )
    }
    const title = getString(input, 'title', { required: true, maxLength: 200 })
    const summary = getString(input, 'summary', { required: true, maxLength: 4000 })
    const steps = parseSteps(input.steps)
    if (steps.length === 0) {
      return errResult(
        '计划至少需要一个可执行步骤。',
        '请把计划拆成有明确产出的步骤，例如「读取 in/sales.csv，核对总销售额」；最多 12 步。'
      )
    }
    const risks = typeof input.risks === 'string' && input.risks.trim() ? input.risks.trim().slice(0, 3000) : undefined
    const now = Date.now()
    const plan: SessionPlan = {
      id: newId('plan'),
      title: title.trim(),
      summary: summary.trim(),
      steps,
      ...(risks ? { risks } : {}),
      status: 'pending',
      createdAt: now,
      updatedAt: now
    }
    const artifact: Artifact = {
      id: `artifact_${plan.id}`,
      title: `计划：${plan.title}`,
      kind: 'markdown',
      content: planMarkdown(plan),
      createdAt: now,
      updatedAt: now
    }
    plan.artifactId = artifact.id
    ctx.addArtifact(artifact)
    ctx.proposePlan(plan)
    return okResult(
      `计划已提交，等待用户批准（${plan.steps.length} 个步骤）。批准后会自动开始执行；在获得批准前不要声称已经完成任何步骤。`,
      { planId: plan.id, steps: plan.steps.map((step) => step.text) }
    )
  }
}

export const planTools: ToolImpl[] = [submitPlanTool]
