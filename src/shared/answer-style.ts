/**
 * 全局回答风格：只改变用户可见答复的措辞与结构，
 * 不改变工具权限、安全边界、引用要求或任务要求的交付格式。
 */
import type { AnswerStyleId } from './types'

export interface AnswerStyleOption {
  id: AnswerStyleId
  label: string
  summary: string
  prompt: string
}

export const ANSWER_STYLE_MAX_CUSTOM = 1200

export const ANSWER_STYLES: AnswerStyleOption[] = [
  {
    id: 'balanced',
    label: '平衡',
    summary: '清晰自然，先结论，再给必要的解释。',
    prompt:
      '先给结论，再给必要的解释或下一步；默认使用短段落或少量要点，不写套话，不重复用户的问题。'
  },
  {
    id: 'concise',
    label: '简洁',
    summary: '尽量短：先答案，只留关键理由与下一步。',
    prompt:
      '优先用最短的可执行回答：先直接回答，通常 1–3 句或不超过 5 个要点；省去客套、背景、重复和展开举例。不要省略关键风险、失败原因或需要用户确认的事项。'
  },
  {
    id: 'explanatory',
    label: '讲解',
    summary: '解释原因、步骤和原理，必要时举例。',
    prompt:
      '先给结论，再解释为什么这样做：补充关键原理、步骤依据和一个必要例子，帮助用户理解；不要堆砌术语或无关背景。'
  },
  {
    id: 'formal',
    label: '正式',
    summary: '专业书面语，适合报告、邮件和对外沟通。',
    prompt:
      '使用专业、客观、完整的书面语，适合直接放进报告、邮件或对外沟通；避免口语、感叹号、网络用语和过度亲昵的表达，但仍保持清楚易懂。'
  },
  {
    id: 'custom',
    label: '自定义',
    summary: '按你写下的偏好回答。',
    prompt: ''
  }
]

const STYLE_IDS = new Set<AnswerStyleId>(ANSWER_STYLES.map((style) => style.id))

export function isAnswerStyleId(value: unknown): value is AnswerStyleId {
  return typeof value === 'string' && STYLE_IDS.has(value as AnswerStyleId)
}

export function normalizeAnswerStyle(value: unknown): AnswerStyleId {
  return isAnswerStyleId(value) ? value : 'balanced'
}

/** 保留换行、压缩首尾空白；超长由设置层拒绝，这里只做宽松归一化。 */
export function normalizeAnswerStyleCustom(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').trim().slice(0, ANSWER_STYLE_MAX_CUSTOM)
}

export function answerStyleLabel(id: AnswerStyleId): string {
  return ANSWER_STYLES.find((style) => style.id === id)?.label ?? '平衡'
}

/**
 * 生成可拼进 system prompt 的「回答风格」段。
 * 明确的优先级说明放在段首，避免风格偏好覆盖安全与任务要求。
 */
export function buildAnswerStyleSection(style: AnswerStyleId, custom?: string): string {
  const normalized = normalizeAnswerStyle(style)
  const selection = ANSWER_STYLES.find((item) => item.id === normalized) ?? ANSWER_STYLES[0]
  const customText = normalizeAnswerStyleCustom(custom)
  const guidance =
    normalized === 'custom'
      ? customText ||
        '用户还没有写下自定义偏好。按「平衡」风格回答：先给结论，再给必要的解释或下一步。'
      : selection.prompt
  return [
    '## 回答风格（全局偏好）',
    '以下偏好只影响你对用户可见答复的措辞与结构，不改变工具使用、权限、安全边界、引用与核验要求，也不改变任务明确要求的交付格式；两者冲突时，以任务与安全要求为准。',
    `当前风格：${selection.label}。`,
    guidance
  ].join('\n')
}
