/**
 * 元信息类工具：todo_write / ask_user / remember / task / open_artifact。
 * 它们不直接操作文件系统（remember 除外），而是通过 ToolContext 回调影响会话状态。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Artifact,
  ArtifactKind,
  AskUserOption,
  AskUserRequest,
  Goal,
  TodoItem,
  TodoStatus,
  ToolResult
} from '../../shared/types'
import { WorkspaceEscapeError, ToolInputError } from './errors'
import type { GoalPatch } from '../types'
import type { ToolContext } from '../types'
import { newId, truncateText } from '../util'
import { getString } from './args'
import { decodeTextBuffer } from './fs-tools'
import { displayPath, getWorkspaceOrThrow, inspectWorkspacePath, resolveWorkspacePath } from './paths'
import { errResult, okResult, oneLineInput, type ToolImpl } from './types'

const TODO_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']
const MAX_TODOS = 20

/* ── todo_write ───────────────────────────────────────────────── */

export const todoWriteTool: ToolImpl = {
  definition: {
    name: 'todo_write',
    description:
      '更新任务计划面板。用于多步骤任务：先列出 3-6 个步骤，执行过程中把当前步骤标为 in_progress、完成标为 completed。' +
      '每次传入完整列表（不是增量）。简单的一两步任务不需要用。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整计划列表',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '任务步骤描述（简短）' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '状态，默认 pending' }
            },
            required: ['text']
          }
        }
      },
      required: ['todos']
    },
    category: 'meta',
    risk: 'low',
    titleFor: () => '更新任务计划'
  },
  async execute(input, ctx): Promise<ToolResult> {
    const raw = input.todos
    if (!Array.isArray(raw)) {
      throw new ToolInputError('参数「todos」必须是数组。', '请传入完整计划列表，例如 [{"text": "读取数据", "status": "in_progress"}]。')
    }
    if (raw.length > MAX_TODOS) {
      throw new ToolInputError(`计划条目过多（${raw.length}，上限 ${MAX_TODOS}）。`, '请合并成更少的步骤。')
    }
    const existing = ctx.getTodos()
    const todos: TodoItem[] = []
    for (let index = 0; index < raw.length; index += 1) {
      const item = raw[index]
      let text = ''
      let status: TodoStatus = 'pending'
      if (typeof item === 'string') {
        text = item.trim()
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        const candidate = obj.text ?? obj.content ?? obj.title
        text = typeof candidate === 'string' ? candidate.trim() : ''
        const statusCandidate = typeof obj.status === 'string' ? (obj.status as TodoStatus) : null
        if (statusCandidate && TODO_STATUSES.includes(statusCandidate)) status = statusCandidate
      }
      if (!text) continue
      const sameAsBefore = existing[index] && existing[index].text === text
      todos.push({
        id: sameAsBefore ? existing[index].id : newId('todo'),
        text: text.slice(0, 200),
        status
      })
    }
    ctx.setTodos(todos)
    const completed = todos.filter((todo) => todo.status === 'completed').length
    const inProgress = todos.filter((todo) => todo.status === 'in_progress').length
    return okResult(
      todos.length === 0
        ? '已清空任务计划。'
        : `已更新任务计划：共 ${todos.length} 项（${completed} 完成 / ${inProgress} 进行中 / ${todos.length - completed - inProgress} 待办）。`,
      { todos }
    )
  }
}

/* ── ask_user ─────────────────────────────────────────────────── */

function parseOptions(raw: unknown): AskUserOption[] {
  if (!Array.isArray(raw)) return []
  const options: AskUserOption[] = []
  for (const item of raw.slice(0, 8)) {
    if (typeof item === 'string') {
      const label = item.trim()
      if (label) options.push({ label, value: label })
      continue
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const label = typeof obj.label === 'string' ? obj.label.trim() : typeof obj.text === 'string' ? obj.text.trim() : ''
      if (!label) continue
      options.push({
        label,
        value: typeof obj.value === 'string' ? obj.value : label,
        ...(typeof obj.description === 'string' ? { description: obj.description } : {})
      })
    }
  }
  return options
}

export const askUserTool: ToolImpl = {
  definition: {
    name: 'ask_user',
    description:
      '向用户提一个选择题，阻塞等待回答。用于需求不明确、有多种合理方案、或需要用户确认关键信息时。' +
      '用户可能选选项或自己输入文字。不要用它问「是否继续」这种基于已有信息就能判断的问题。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题（简短、一次只问一件事）' },
        options: {
          type: 'array',
          description: '可选项（2-4 个为宜）。不传则让用户自由输入。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项文字' },
              description: { type: 'string', description: '补充说明（可选）' },
              value: { type: 'string', description: '返回给程序的值（默认同 label）' }
            },
            required: ['label']
          }
        },
        allow_custom: { type: 'boolean', description: '是否允许用户自己输入答案（默认 true）' }
      },
      required: ['question']
    },
    category: 'meta',
    risk: 'low',
    titleFor: (input) => `询问用户 ${oneLineInput(input, 'question', 48)}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const question = getString(input, 'question', { required: true, maxLength: 2000 })
    const options = parseOptions(input.options)
    const allowCustom = input.allow_custom !== false
    const request: AskUserRequest = {
      id: newId('question'),
      sessionId: ctx.sessionId,
      toolUseId: ctx.toolUseId,
      question,
      options,
      allowCustom,
      createdAt: Date.now()
    }
    const answer = await ctx.askUser(request)
    return okResult(`用户回答：${answer.label}${answer.custom ? '（自定义输入）' : ''}`, { answer })
  }
}

/* ── remember ─────────────────────────────────────────────────── */

export const rememberTool: ToolImpl = {
  definition: {
    name: 'remember',
    description:
      '把关于这个项目的重要信息记到 .morrow/MEMORY.md（例如用户的偏好、业务口径、约定）。' +
      '下次对话会自动带上这些记忆。只记长期有用的信息，不要记一次性的临时内容。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的信息（一句话，具体、可复用）' }
      },
      required: ['text']
    },
    category: 'meta',
    risk: 'low',
    titleFor: () => '记录项目记忆'
  },
  async execute(input, ctx): Promise<ToolResult> {
    const text = getString(input, 'text', { required: true, maxLength: 4000 })
    const workspace = getWorkspaceOrThrow(ctx.workspace)
    const memoryDir = join(workspace, '.morrow')
    const memoryPath = join(memoryDir, 'MEMORY.md')
    mkdirSync(memoryDir, { recursive: true })
    const isNew = !existsSync(memoryPath)
    const date = new Date().toISOString().slice(0, 10)
    if (isNew) {
      appendFileSync(memoryPath, '# Morrow 项目记忆\n\n> 由 Morrow 自动记录，下次对话会作为背景知识注入。\n\n', 'utf8')
    }
    appendFileSync(memoryPath, `- [${date}] ${text}\n`, 'utf8')
    const size = statSync(memoryPath).size
    return okResult(`已记住：${truncateText(text, 120)}\n下次对话会自动带上这条信息。`, {
      path: displayPath(memoryPath, ctx.workspace),
      absolutePath: memoryPath,
      bytes: size
    })
  }
}

/* ── task（子代理） ───────────────────────────────────────────── */

export const taskTool: ToolImpl = {
  definition: {
    name: 'task',
    description:
      '把一个独立的小任务交给子代理去完成。子代理拥有与主代理相同的工具与权限（可读写文件、运行命令、调用 MCP，' +
      '按主代理当前权限模式审批）；同一轮多条 task 调用会真正并行。子代理不能再创建子代理，也不能更新父目标。' +
      '子代理看不到当前对话，必须在 prompt 里写清背景、目标、输入/输出路径和期望输出。返回子代理的结论摘要与真实产物路径。' +
      '子代理失败、被取消或耗尽步数时本工具会返回错误（ok=false），不会把中间文字伪装成完成。',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '一句话说明这个子任务（展示用）' },
        prompt: { type: 'string', description: '完整任务说明：背景、要做什么、看哪些文件、输出什么' },
        context: { type: 'string', description: '可选的上下文摘要（当前任务进展等）' }
      },
      required: ['description', 'prompt']
    },
    category: 'meta',
    risk: 'low',
    titleFor: (input) => `子代理：${oneLineInput(input, 'description', 48)}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (ctx.readOnly || ctx.depth > 0) {
      return errResult('子代理不能再启动子代理。', '请直接使用只读工具完成这个任务，或把任务交回主代理。')
    }
    const description = getString(input, 'description', { required: true, maxLength: 200 })
    const prompt = getString(input, 'prompt', { required: true, maxLength: 20_000 })
    const context = typeof input.context === 'string' ? input.context : undefined
    ctx.progress(`子代理开始：${description}`)
    const result = await ctx.runSubagent({ description, prompt, context })
    const meta = {
      status: result.status,
      steps: result.steps,
      usage: result.usage,
      error: result.error ?? null,
      failedTools: result.failedTools ?? []
    }
    // R2-B/C：失败/取消/步数耗尽绝不能返回 ok=true（旧实现在 summary 有占位文字时恒成功）
    if (result.status !== 'completed') {
      const label =
        result.status === 'exhausted'
          ? '未完成（达到子代理步数上限）'
          : result.status === 'cancelled'
            ? '已取消'
            : '执行失败'
      return errResult(
        `子代理${label}${result.error ? `：${result.error}` : ''}`,
        '子代理没有给出可采用的最终结论，不能把它当成已完成。可以拆小任务后重试，或由主代理自己完成；父任务/Goal 不得据此标记成功。',
        meta
      )
    }
    const lines = [`【子代理摘要】${result.summary || '（子代理没有返回文本结论）'}`]
    if (result.failedTools?.length) {
      lines.push(`⚠ 子代理执行期间有工具失败（结论可能不完整，请自行核实）：${result.failedTools.join('；')}`)
    }
    return okResult(lines.join('\n'), meta)
  }
}

/* ── open_artifact ────────────────────────────────────────────── */

function normalizeKind(raw: string): ArtifactKind | null {
  const value = raw.trim().toLowerCase()
  if (!value) return null
  if (value === 'html' || value === 'htm') return 'html'
  if (value === 'markdown' || value === 'md') return 'markdown'
  if (value === 'svg') return 'svg'
  if (value === 'code') return 'code'
  if (value === 'text' || value === 'txt') return 'text'
  if (value === 'file') return 'file'
  return null
}

function inferKindFromPath(path: string | undefined): ArtifactKind {
  if (!path) return 'text'
  const lower = path.toLowerCase()
  if (/\.(html?|htm)$/.test(lower)) return 'html'
  if (/\.(md|markdown|mdx)$/.test(lower)) return 'markdown'
  if (/\.svg$/.test(lower)) return 'svg'
  if (/\.(txt|log|csv|tsv)$/.test(lower)) return 'text'
  if (/\.(js|mjs|cjs|ts|tsx|jsx|py|json|css|scss|sh|ps1|java|go|rs|sql|yml|yaml|xml)$/.test(lower)) return 'code'
  return 'file'
}

function inferLanguage(path: string | undefined, kind: ArtifactKind): string | undefined {
  if (kind !== 'code' || !path) return undefined
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  const map: Record<string, string> = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'tsx',
    jsx: 'jsx',
    py: 'python',
    json: 'json',
    css: 'css',
    sh: 'bash',
    ps1: 'powershell',
    java: 'java',
    go: 'go',
    rs: 'rust',
    sql: 'sql',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml'
  }
  return ext ? map[ext] : undefined
}

export const openArtifactTool: ToolImpl = {
  definition: {
    name: 'open_artifact',
    description:
      '把一个成品注册到画布面板并立即展示（HTML 网页 / Markdown 文档 / SVG / 代码）。' +
      '用 path 指向工作区里已写好的文件，或用 content 直接给内联内容。HTML 必须自包含（内联 CSS/JS、无外链资源）。' +
      '写完报告后应调用它，让用户直接看到成品。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '产物标题，例如 "Q3 销售分析报告"' },
        kind: { type: 'string', enum: ['html', 'markdown', 'code', 'svg', 'text', 'file'], description: '产物类型（可省略，按扩展名推断）' },
        path: { type: 'string', description: '工作区内的文件路径（与 content 二选一）' },
        content: { type: 'string', description: '内联内容（与 path 二选一）' },
        language: { type: 'string', description: 'code 类型的语言标识（可选）' }
      },
      required: ['title']
    },
    category: 'meta',
    risk: 'low',
    titleFor: (input) => `打开画布 ${oneLineInput(input, 'title', 48)}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const title = getString(input, 'title', { required: true, maxLength: 200 })
    const rawKind = getString(input, 'kind', { defaultValue: '' })
    const language = getString(input, 'language', { defaultValue: '' })
    const rawPath = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : undefined
    let content = typeof input.content === 'string' ? input.content : undefined
    let absolutePath: string | undefined
    let resolvedReal: string | undefined

    if (rawPath) {
      const resolved = resolveWorkspacePath(rawPath, ctx.workspace, { escapeApproved: ctx.escapeApproved, requireExist: true })
      if (resolved.isDirectory) throw new ToolInputError(`「${rawPath}」是文件夹，不能作为画布产物。`, '请指定具体文件。')
      absolutePath = resolved.absolute
      resolvedReal = resolved.real
    }
    if (!rawPath && content === undefined) {
      throw new ToolInputError('需要提供 path 或 content 之一。', '先用 write_file 写好文件再 open_artifact 指向它，或直接传 content。')
    }

    const kind = normalizeKind(rawKind) ?? inferKindFromPath(rawPath)
    if (content === undefined && resolvedReal && kind !== 'file') {
      const buffer = readFileSync(resolvedReal)
      if (buffer.length > 2 * 1024 * 1024) {
        throw new ToolInputError(`产物文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），画布只支持 2MB 以内的文本产物。`, '请精简内容后重试。')
      }
      const decoded = decodeTextBuffer(buffer)
      if (!decoded.binary) content = decoded.text
    }

    const now = Date.now()
    const artifact: Artifact = {
      id: newId('artifact'),
      title,
      kind,
      ...(absolutePath ? { path: absolutePath } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(language ? { language } : inferLanguage(rawPath, kind) ? { language: inferLanguage(rawPath, kind) } : {}),
      createdAt: now,
      updatedAt: now
    }
    ctx.addArtifact(artifact)
    const sizeText = content !== undefined ? `，${content.length.toLocaleString('zh-CN')} 字符` : ''
    return okResult(`已在画布中打开《${title}》（${kind}${sizeText}）。`, {
      artifactId: artifact.id,
      kind,
      path: absolutePath ? displayPath(absolutePath, ctx.workspace) : null,
      absolutePath: absolutePath ?? null
    })
  }
}

/* ── update_goal（仅 Goal 模式） ──────────────────────────────── */

const UPDATABLE_GOAL_STATUSES = ['active', 'completed', 'blocked'] as const
const MAX_EVIDENCE_ITEMS = 12

function goalStatusLabel(status: Goal['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'blocked') return '已阻塞'
  if (status === 'paused') return '已暂停'
  if (status === 'cancelled') return '已取消'
  return '进行中'
}

const EVIDENCE_MTIME_TOLERANCE_MS = 1000

/**
 * R7 审计修复 + R9（R2-E/M49）：completed 必须有真实、新鲜的完成证据。
 * 规则（全部满足才算）：
 * - evidence 至少 1 项、最多 12 项，字符串路径；
 * - 必须位于工作区内、真实存在、是**普通文件**（目录、工作区根、"." 一律拒绝）；
 * - 不能是空文件（0 字节）；
 * - 文件 mtime 必须晚于 Goal 创建时间（本目标期间新增或被覆盖更新），
 *   旧输入/上一轮遗留文件不能冒充本轮产物；
 * - 内容正确性产品无法通用校验（写清限制），但调用方必须显式给出证据路径。
 * 返回规范化后的展示路径；任何一项不满足返回可读错误对象。
 */
export function validateGoalEvidence(
  raw: unknown,
  workspace: string | null,
  goalCreatedAt?: number
): { ok: true; paths: string[] } | { ok: false; error: string; hint: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      error: '标记目标为已完成时必须提供 evidence（完成证据路径数组）。',
      hint:
        '请在 evidence 里列出本次目标真实产出、且位于工作区内的文件路径（例如 "out/report.md"）。' +
        '如果还没有可验证的产物，请继续推进（status=active）或标记 blocked，不要声称完成。'
    }
  }
  if (raw.length > MAX_EVIDENCE_ITEMS) {
    return { ok: false, error: `evidence 最多 ${MAX_EVIDENCE_ITEMS} 项。`, hint: '列出最关键的几个产物路径即可。' }
  }
  if (!workspace) {
    return {
      ok: false,
      error: '当前会话没有绑定工作文件夹，无法核验完成证据，不能标记 completed。',
      hint: '请让用户先选择工作文件夹；或由用户在目标条上手动结束目标（会记为已取消，而不是完成）。'
    }
  }
  const paths: string[] = []
  const missing: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: 'evidence 的每一项都必须是字符串路径。', hint: '例如 ["out/report.md", "out/data.csv"]。' }
    }
    const candidate = item.trim()
    try {
      const resolved = resolveWorkspacePath(candidate, workspace, { requireExist: true })
      if (!resolved.inside) {
        missing.push(`${candidate}（不在工作区内）`)
        continue
      }
      if (resolved.isDirectory) {
        missing.push(`${candidate}（是目录，不能作为完成证据）`)
        continue
      }
      const stat = statSync(resolved.real)
      if (!stat.isFile()) {
        missing.push(`${candidate}（不是普通文件）`)
        continue
      }
      if (stat.size <= 0) {
        missing.push(`${candidate}（空文件，不能作为完成证据）`)
        continue
      }
      if (typeof goalCreatedAt === 'number' && Number.isFinite(goalCreatedAt)) {
        if (stat.mtimeMs < goalCreatedAt - EVIDENCE_MTIME_TOLERANCE_MS) {
          missing.push(`${candidate}（目标创建前就存在的旧文件，本目标期间没有更新，不能冒充本轮产物）`)
          continue
        }
      }
      paths.push(displayPath(resolved.absolute, workspace))
    } catch (err) {
      if (err instanceof WorkspaceEscapeError) {
        missing.push(`${candidate}（不在工作区内）`)
      } else if (err instanceof ToolInputError) {
        missing.push(`${candidate}（不存在或不可访问）`)
      } else {
        missing.push(candidate)
      }
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: `完成证据校验失败：${missing.join('；')}。`,
      hint:
        '完成证据必须是本目标期间在工作区内真实生成或被更新过的非空文件（目录、工作区根/「.」、旧文件、空文件都不行）。' +
        '请先写出产物并确认文件内容，再重新调用 update_goal(completed)；如果还没产出，请继续推进或标记 blocked。'
    }
  }
  return { ok: true, paths: [...new Set(paths)] }
}

export const updateGoalTool: ToolImpl = {
  definition: {
    name: 'update_goal',
    description:
      '更新当前目标状态（仅在目标模式可用）。每轮结束前必须调用：有推进但未完成用 active（并写 summary/nextStep），' +
      '全部完成且验证通过用 completed（必须提供 evidence：本目标期间工作区内真实生成/更新的非空文件路径；目录、旧文件、空文件都会被拒绝），' +
      '遇到无法解决的阻塞用 blocked（必须写 blockedReason）。不要假装完成，也不要跳过这个工具。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'completed', 'blocked'], description: '目标状态' },
        summary: { type: 'string', description: '本轮完成内容摘要（active/completed 时建议填写）' },
        nextStep: { type: 'string', description: '下一轮建议动作（active 时建议填写）' },
        blockedReason: { type: 'string', description: '阻塞原因与需要用户做什么（status=blocked 时必填）' },
        evidence: {
          type: 'array',
          description:
            '完成证据（status=completed 时必填）：工作区内真实存在的产物路径数组，例如 ["out/report.html"]。系统会校验存在性。',
          items: { type: 'string' }
        }
      },
      required: ['status']
    },
    category: 'meta',
    risk: 'low',
    titleFor: (input) => `更新目标状态（${typeof input.status === 'string' ? input.status : 'unknown'}）`
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.goal) {
      return errResult('当前不在目标模式，无法更新目标。', '只有用户主动建立目标后才能使用 update_goal。')
    }
    if (ctx.goal.status !== 'active') {
      return errResult(
        `目标当前状态是「${goalStatusLabel(ctx.goal.status)}」，不能再更新。`,
        '目标已暂停/完成/阻塞/取消，是否继续由用户决定。'
      )
    }
    const rawStatus = typeof input.status === 'string' ? input.status.trim() : ''
    if (!(UPDATABLE_GOAL_STATUSES as readonly string[]).includes(rawStatus)) {
      return errResult(
        `非法的目标状态「${rawStatus || '(空)'}」。`,
        "status 只能是 'active'（继续推进）、'completed'（完成）或 'blocked'（阻塞）。"
      )
    }
    const status = rawStatus as GoalPatch['status']
    const summary = typeof input.summary === 'string' && input.summary.trim() ? input.summary.trim() : undefined
    const nextStep = typeof input.nextStep === 'string' && input.nextStep.trim() ? input.nextStep.trim() : undefined
    const blockedReason =
      typeof input.blockedReason === 'string' && input.blockedReason.trim() ? input.blockedReason.trim() : undefined
    if (status === 'blocked' && !blockedReason) {
      return errResult('status=blocked 时必须提供 blockedReason。', '请说明阻塞原因，以及需要用户做什么才能继续。')
    }
    let evidence: string[] | undefined
    if (status === 'completed') {
      const checked = validateGoalEvidence(input.evidence, ctx.workspace, ctx.goal.createdAt)
      if (!checked.ok) {
        return errResult(checked.error, checked.hint, { evidenceRejected: true })
      }
      evidence = checked.paths
    }
    const patch: GoalPatch = {
      status,
      ...(summary ? { summary } : {}),
      ...(nextStep ? { nextStep } : {}),
      ...(blockedReason ? { blockedReason } : {}),
      ...(evidence ? { evidence } : {})
    }
    const next = ctx.updateGoal(patch)
    if (!next) return errResult('目标更新失败：当前没有可更新的目标。', '请让用户重新建立目标。')
    const lines = [
      `目标状态已更新：${goalStatusLabel(next.status)}（第 ${next.round}/${next.maxRounds} 轮）`
    ]
    if (next.summary) lines.push(`本轮摘要：${truncateText(next.summary, 300)}`)
    if (next.nextStep) lines.push(`下一轮：${truncateText(next.nextStep, 200)}`)
    if (next.blockedReason) lines.push(`阻塞原因：${truncateText(next.blockedReason, 300)}`)
    if (next.evidence?.length) lines.push(`完成证据（已核验存在）：${next.evidence.join('、')}`)
    return okResult(lines.join('\n'), { goal: next })
  }
}

export const metaTools: ToolImpl[] = [todoWriteTool, askUserTool, rememberTool, taskTool, openArtifactTool]
