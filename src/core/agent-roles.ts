/**
 * 内置子代理角色（Swarm）。
 *
 * 角色只限制「能用哪些工具」与追加一段专属系统提示；权限链、工作区边界、
 * 审批与父代理完全一致。只读角色即使父代理处于 auto，也会被权限层按只读处理。
 * 自定义角色由主进程从 .morrow/agents/*.md 加载后叠加。
 */
import type { SubagentRole } from './types'

const READ_TOOLS = [
  'read_file',
  'read_pdf',
  'read_docx',
  'read_xlsx',
  'list_dir',
  'glob',
  'grep',
  'list_skills',
  'read_skill',
  'open_artifact'
]

export const BUILTIN_AGENT_ROLES: SubagentRole[] = [
  {
    name: 'general',
    title: '通用执行者',
    description: '拥有与主代理相同的工具；适合边界清晰、需要动手完成的子任务。',
    source: 'builtin',
    systemPrompt:
      '你是主代理派出的通用执行子代理。独立完成交给你的子任务，必要时读取文件、修改代码或运行命令；涉及写入/命令/MCP 时会按当前权限模式请求用户审批。'
  },
  {
    name: 'explore',
    title: '探索者',
    description: '只读检索代码与文档，快速定位文件、符号、调用关系和数据。',
    tools: READ_TOOLS,
    readOnly: true,
    source: 'builtin',
    systemPrompt:
      '你是只读探索子代理。只用检索与读取工具快速定位事实，不修改任何文件、不执行命令。结论必须给出真实文件路径、行号或代码片段；不确定的地方明确标注，不要猜测。'
  },
  {
    name: 'plan',
    title: '规划者',
    description: '只读分析后给出可执行的分步实施计划与风险。',
    tools: [...READ_TOOLS, 'ask_user'],
    readOnly: true,
    source: 'builtin',
    systemPrompt:
      '你是只读规划子代理。先理解现有代码与约束，再给出具体、可执行、可验证的分步计划（每一步写清改动文件、验证方式与风险）。不要修改文件或执行命令；信息不足时用 ask_user 向用户确认。'
  },
  {
    name: 'review',
    title: '审查者',
    description: '只读审查改动或方案，优先找正确性、安全性与回归风险。',
    tools: [...READ_TOOLS, 'ask_user'],
    readOnly: true,
    source: 'builtin',
    systemPrompt:
      '你是只读代码审查子代理。围绕正确性、安全边界、并发/状态一致性、错误处理与回归风险逐项检查，给出可定位的问题（文件/行号/复现条件）和修复建议。不要修改文件或执行命令；没有发现问题也要说明检查范围与残余风险。'
  },
  {
    name: 'test',
    title: '验证者',
    description: '可以运行构建、测试与诊断命令，复现问题并核对修复结果。',
    tools: [
      'read_file',
      'read_pdf',
      'read_docx',
      'read_xlsx',
      'list_dir',
      'glob',
      'grep',
      'run_command',
      'terminal',
      'list_skills',
      'read_skill'
    ],
    source: 'builtin',
    systemPrompt:
      '你是验证子代理。优先用现有脚本/测试复现问题，记录真实命令、退出码与关键输出；不要为了让结果变绿而跳过失败或修改测试断言。不能修改源码（可用临时命令生成临时文件），把复现步骤、证据与建议修复返回给主代理。'
  },
  {
    name: 'docs',
    title: '文档写作者',
    description: '读写 Markdown 文档，整理说明、指南与发布记录。',
    tools: [...READ_TOOLS, 'write_file', 'edit_file'],
    source: 'builtin',
    systemPrompt:
      '你是文档子代理。基于真实代码与用户要求撰写或修订 Markdown 文档，保持与现有术语、结构和语气一致；只修改文档文件，不修改业务源码。写入会按当前权限模式请求审批。'
  }
]

export function resolveAgentRole(roles: readonly SubagentRole[], name: string | undefined): SubagentRole | null {
  const key = (name ?? 'general').trim().toLowerCase()
  return (
    roles.find((role) => role.name === key) ??
    // 测试/旧调用未注入角色时，缺省仍按内置 general 工作
    (key === 'general' ? BUILTIN_AGENT_ROLES[0] : null)
  )
}

export function agentRoleList(roles: readonly SubagentRole[]): string {
  return roles.map((role) => `${role.name}（${role.title}）：${role.description}`).join('\n')
}
