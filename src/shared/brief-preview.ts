import type { StudioKind } from './studio'

export interface BriefPreview {
  subject: string | null
  goal: string | null
  obstacle: string | null
  turn: string | null
  confidence: 'low' | 'medium' | 'high'
  questions: string[]
}

const SUBJECT_PATTERN = /([\u4e00-\u9fa5A-Za-z0-9]{1,14}(?:女孩|少年|男人|女人|老人|孩子|司机|作家|记者|医生|警察|店主|程序员|工程师|学生|老师|母亲|父亲|外婆|外公|皇后|皇帝|剑客|侦探|歌手|演员|机器人|AI|书店|伞铺|电台))/
const GOAL_PATTERN = /(?:想要|想|必须|决定|为了|要)([\u4e00-\u9fa5A-Za-z0-9“”"「」！？、，。；：\s]{2,40})/
const OBSTACLE_PATTERN = /(?:却|但|可是|然而|没想到|直到|阻止)([\u4e00-\u9fa5A-Za-z0-9“”"「」！？、，。；：\s]{2,40})/
const TURN_PATTERN = /(?:每次|每当|结果|发现|原来|突然|直到)([\u4e00-\u9fa5A-Za-z0-9“”"「」！？、，。；：\s]{2,50})/

function clean(value: string | undefined): string | null {
  if (!value) return null
  const text = value.replace(/^[，,。；;：:\s]+|[，,。；;：:\s]+$/g, '').trim()
  return text ? text.slice(0, 46) : null
}

function firstMatch(pattern: RegExp, text: string): string | null {
  return clean(pattern.exec(text)?.[1])
}

export function previewBrief(logline: string, kind: StudioKind): BriefPreview {
  const text = logline.trim()
  const subject = clean(SUBJECT_PATTERN.exec(text)?.[1])
  const goal = firstMatch(GOAL_PATTERN, text)
  const obstacle = firstMatch(OBSTACLE_PATTERN, text)
  const turn = firstMatch(TURN_PATTERN, text)
  const signals = [goal, obstacle, turn].filter(Boolean).length
  const confidence: BriefPreview['confidence'] = text.length >= 18 && Boolean(subject) && signals >= 2
    ? 'high'
    : text.length >= 8 && signals >= 1
      ? 'medium'
      : 'low'
  const questions: string[] = []
  if (!subject) questions.push('主角是谁？')
  if (!goal) questions.push('她最想要什么？')
  if (!obstacle) questions.push('什么在阻止她？')
  if (!turn) questions.push('哪一刻让局面改变？')
  if (kind === 'drama' && text.length < 22) questions.push('这 96 秒里最关键的画面是什么？')
  return { subject, goal, obstacle, turn, confidence, questions: questions.slice(0, 2) }
}
