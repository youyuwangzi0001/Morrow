// 元信息类工具：todo_write / ask_user / remember / swarm / open_artifact。
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
import { WorkspaceEscapeError, ToolInputError } from './types'
import type { GoalPatch } from '../types'
import type { ToolContext } from '../types'
import { resolveAgentRole } from '../agent-roles'
import { newId, truncateText } from '../util'
import { getString } from './args'
import { decodeTextBuffer } from './fs-tools'
import { displayPath, getWorkspaceOrThrow, inspectWorkspacePath, resolveWorkspacePath } from './paths'
import { errResult, okResult, oneLineInput, type ToolImpl } from './types'

const TODO_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']
const MAX_TODOS = 20

export const todoWriteTool: ToolImpl = {
  definition: {
    name: 'todo_write',
    description:
      '更新任务计划面板。用于多步骤任务：先列出当前要执行的一小段，执行过程中把当前步骤标为 in_progress、完成标为 completed。' +
      '每次传入完整列表（不是增量），可以分批追加下一段步骤；简单的一两步任务不需要用。',
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

export const rememberTool: ToolImpl = {
  definition: {
    name: 'remember',
    description:
      '把长期有用的信息写入记忆中心：用户稳定偏好、业务口径或项目约定。' +
      'scope=project 跟随当前文件夹，scope=global 跨项目生效。只记长期有用的信息，不要记一次性内容、文件路径或临时状态。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的信息（一句话，具体、可复用）' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'project（默认）或 global' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选标签，最多 8 个'
        }
      },
      required: ['text']
    },
    category: 'meta',
    risk: 'low',
    titleFor: () => '记录记忆'
  },
  async execute(input, ctx): Promise<ToolResult> {
    const text = getString(input, 'text', { required: true, maxLength: 4000 })
    const scope = input.scope === 'global' ? 'global' : 'project'
    const tags = Array.isArray(input.tags)
      ? input.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8)
      : []
    if (ctx.remember) {
      const saved = await ctx.remember({ text, scope, tags })
      const label = saved.scope === 'global' ? '全局记忆' : '项目记忆'
      return okResult(`已记入${label}：${truncateText(saved.text, 120)}\n可在「设置 → 功能与工具 → 记忆」中查看。`, {
        memoryScope: saved.scope,
        memoryText: saved.text
      })
    }
    if (scope === 'global') {
      return errResult('当前没有连接记忆中心，不能写入全局记忆。', '请在设置 → 功能与工具 → 记忆中手动添加。')
    }
    // 兼容无主进程回调的内核单测/旧集成：仍写项目 MEMORY.md，记忆中心会迁移。
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

const MAX_SWARM_TASKS = 10
const MAX_SWARM_PARALLEL = 10

export const swarmTool: ToolImpl = {
  definition: {
    name: 'swarm',
    description:
      '把一个任务拆成 1–10 个相互独立的子任务，一次派发给集群成员并行完成（缺省 general，可用 agent 指定分工角色）。' +
      '每个成员与主代理拥有相同的工作区访问权限和工具：可以读写文件、运行命令、调用 MCP；写文件/命令/MCP 是否审批只由当前权限档位决定，角色不限制工具。' +
      'agent 只决定分工（负责什么、边界、交付），不代表技能；成员会按需自己 list_skills/read_skill，不要把技能名当角色或把技能正文塞进任务。' +
      '每个子任务独立运行、互不共享上下文；同一批最多 10 个同时推进。适合「分别核查/实现多个模块再汇总」这类可以并行的任务；' +
      '有先后依赖的任务请按顺序自己完成，或分成多批 swarm。返回每个成员的摘要与失败信息；有任一成员未完成时本工具返回错误，不能当作全部完成。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '这次拆分要达成的总目标（一句话）' },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_SWARM_TASKS,
          description: '相互独立的子任务（1–10 个）',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '子任务标题（展示用）' },
              prompt: { type: 'string', description: '子任务完整说明：背景、要做什么、看哪些文件、输出什么' },
              agent: {
                type: 'string',
                description:
                  '成员分工角色名（见系统提示的可用成员类型，缺省 general）；只决定工作重点与交付边界，不限制权限或工具，也不代表要加载某个技能'
              },
              context: { type: 'string', description: '可选上下文摘要' }
            },
            required: ['title', 'prompt']
          }
        }
      },
      required: ['goal', 'tasks'],
      additionalProperties: false
    },
    category: 'meta',
    risk: 'low',
    titleFor: (input) => {
      const count = Array.isArray(input.tasks) ? input.tasks.length : 0
      return `集群${count > 0 ? ` × ${count}` : ''}`
    }
  },
  async execute(input, ctx): Promise<ToolResult> {
    if (ctx.depth > 0) {
      return errResult('集群成员不能再启动集群。', '请直接完成你负责的子任务，把结论返回给主代理。')
    }
    if (ctx.readOnly || ctx.permissionMode === 'read-only') {
      return errResult('当前是只读上下文，不能启动集群。', '请把任务交回主代理，或切换到有权限的工作模式。')
    }
    const goal = getString(input, 'goal', { required: true, maxLength: 2000 })
    if (!Array.isArray(input.tasks)) return errResult('参数「tasks」必须是数组。', '提供 1–10 个互相独立的子任务。')
    if (input.tasks.length < 1 || input.tasks.length > MAX_SWARM_TASKS) {
      return errResult(`集群需要 1–${MAX_SWARM_TASKS} 个子任务。`, '只有一个独立子任务也可以派给一个成员；有依赖关系的任务请按顺序执行或分成多批。')
    }
    const prepared: Array<{
      index: number
      title: string
      prompt: string
      context?: string
      role: NonNullable<ReturnType<typeof resolveAgentRole>>
    }> = []
    for (let index = 0; index < input.tasks.length; index += 1) {
      const raw = input.tasks[index]
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return errResult('每个子任务必须是一个对象。', '字段：title、prompt、可选 agent/context。')
      }
      const item = raw as Record<string, unknown>
      let title: string
      let prompt: string
      try {
        title = getString(item, 'title', { required: true, maxLength: 120 })
        prompt = getString(item, 'prompt', { required: true, maxLength: 12_000 })
      } catch (err) {
        if (err instanceof ToolInputError) return errResult(err.message, err.hint)
        throw err
      }
      const agentName =
        typeof item.agent === 'string' && item.agent.trim()
          ? item.agent.trim().toLowerCase().slice(0, 80)
          : undefined
      const role = resolveAgentRole(ctx.agents ?? [], agentName)
      if (!role) {
        const available = (ctx.agents ?? []).map((entry) => entry.name).join('、') || '（无）'
        return errResult(`子任务「${title}」使用了未知角色「${agentName}」。可用角色：${available}。`, '使用系统提示中的角色名，或省略 agent。')
      }
      prepared.push({
        index,
        title,
        prompt,
        role,
        ...(typeof item.context === 'string' && item.context.trim() ? { context: item.context.slice(0, 4000) } : {})
      })
    }

    // 先把整批任务以「等待」状态送到界面，用户能立刻看到编排结果，而不是只看到转圈。
    for (const item of prepared) {
      ctx.progress(`等待：${item.title}`, {
        swarmTask: {
          index: item.index,
          title: item.title,
          agent: item.role.name,
          agentTitle: item.role.title,
          status: 'queued'
        }
      })
    }
    ctx.progress(`开始：${prepared.length} 个并行子任务`)
    const results: Array<{
      index: number
      title: string
      agent: string
      role: string
      agentTitle: string
      status: string
      summary: string
      steps: number
      error?: string
    }> = []
    const changedFiles = new Map<string, Record<string, unknown>>()
    for (let offset = 0; offset < prepared.length; offset += MAX_SWARM_PARALLEL) {
      const chunk = prepared.slice(offset, offset + MAX_SWARM_PARALLEL)
      const chunkResults = await Promise.all(
        chunk.map(async (item) => {
          ctx.progress(`进行中：${item.title}`, {
            swarmTask: {
              index: item.index,
              title: item.title,
              agent: item.role.name,
              agentTitle: item.role.title,
              status: 'running'
            }
          })
          const result = await ctx.runSwarmMember({
            description: item.title,
            prompt: `【总目标】${goal}\n\n${item.prompt}`,
            ...(item.context ? { context: item.context } : {}),
            role: item.role,
            swarmTask: { index: item.index, title: item.title, agent: item.role.name }
          })
          ctx.progress(`${result.status === 'completed' ? '完成' : '未完成'}：${item.title}`, {
            swarmTask: {
              index: item.index,
              title: item.title,
              agent: item.role.name,
              agentTitle: item.role.title,
              status: result.status,
              stepCount: result.steps,
              summary: result.summary,
              ...(result.error ? { error: result.error } : {}),
              ...(result.operations && result.operations.length > 0 ? { operations: result.operations } : {})
            }
          })
          return result
        })
      )
      chunk.forEach((item, index) => {
        const result = chunkResults[index]
        results.push({
          index: item.index,
          title: item.title,
          agent: item.role.name,
          role: item.role.title,
          agentTitle: item.role.title,
          status: result.status,
          summary: result.summary,
          steps: result.steps,
          ...(result.error ? { error: result.error } : {}),
          ...(result.operations && result.operations.length > 0 ? { operations: result.operations } : {})
        })
        // 失败的子任务也可能已经改过文件；检查点必须登记，回退才不会漏文件
        for (const file of result.changedFiles ?? []) {
          const path = typeof file.absolutePath === 'string' ? file.absolutePath : ''
          const deleted = file.deleted === true
          if (!path || (typeof file.afterHash !== 'string' && !deleted)) continue
          const existing = changedFiles.get(path)
          // 一个子任务新建、另一个子任务删除：整轮净零，不登记临时文件。
          if (deleted && existing?.created === true) {
            changedFiles.delete(path)
            continue
          }
          if (existing) {
            existing.afterHash = typeof file.afterHash === 'string' ? file.afterHash : null
            existing.deleted = deleted
            existing.diffAdded =
              (typeof existing.diffAdded === 'number' ? existing.diffAdded : 0) +
              (typeof file.diffAdded === 'number' ? file.diffAdded : 0)
            existing.diffRemoved =
              (typeof existing.diffRemoved === 'number' ? existing.diffRemoved : 0) +
              (typeof file.diffRemoved === 'number' ? file.diffRemoved : 0)
          } else {
            changedFiles.set(path, { ...file })
          }
        }
      })
    }

    const completed = results.filter((item) => item.status === 'completed')
    const failed = results.filter((item) => item.status !== 'completed')
    const lines = [
      `【集群结果】${completed.length}/${results.length} 个完成${failed.length > 0 ? `，${failed.length} 个未完成` : ''}`,
      ...results.map(
        (item) =>
          `\n## ${item.title}（${item.role}·${item.status}·${item.steps} 步）\n${truncateText(item.summary || '（无结论）', 1200)}${item.error ? `\n错误：${item.error}` : ''}`
      )
    ]
    if (failed.length > 0) {
      lines.push('\n未完成的子任务不能算作完成；请根据上面的信息重试、缩小范围，或由你自己补齐后再验证。')
    }
    const meta = {
      tasks: results,
      completed: completed.length,
      failed: failed.length,
      ...(changedFiles.size > 0 ? { changedFiles: [...changedFiles.values()].slice(0, 100) } : {})
    }
    return failed.length > 0
      ? {
          ok: false,
          output: lines.join('\n'),
          error: `集群有 ${failed.length}/${results.length} 个子任务未完成。`,
          hint: '不要把未完成的子任务当作已完成；根据输出重试或补齐。',
          meta
        }
      : okResult(lines.join('\n'), meta)
  }
}

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
      if (buffer.length > 8 * 1024 * 1024) {
        throw new ToolInputError(`产物文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），画布只支持 8MB 以内的文本产物。`, '请精简内容后重试。')
      }
      const decoded = decodeTextBuffer(buffer)
      if (!decoded.binary) content = decoded.text
    }

    const now = Date.now()
    const foldPath = (value: string): string => {
      const normalized = value.replace(/\\/g, '/')
      return process.platform === 'win32' ? normalized.toLowerCase() : normalized
    }
    // 同一路径/同一内联标题只保留一张成品卡片；重新打开视为更新，避免画布堆满重复副本
    const existing = ctx.getArtifacts().find((item) => {
      if (absolutePath) return Boolean(item.path && foldPath(item.path) === foldPath(absolutePath))
      return content !== undefined && !item.path && item.kind === kind && item.title === title
    })
    const artifact: Artifact = {
      id: existing?.id ?? newId('artifact'),
      title,
      kind,
      ...(absolutePath ? { path: absolutePath } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(language ? { language } : inferLanguage(rawPath, kind) ? { language: inferLanguage(rawPath, kind) } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    ctx.addArtifact(artifact)
    const sizeText = content !== undefined ? `，${content.length.toLocaleString('zh-CN')} 字符` : ''
    return okResult(`${existing ? '已更新画布中的' : '已在画布中打开'}《${title}》（${kind}${sizeText}）。`, {
      artifactId: artifact.id,
      updated: Boolean(existing),
      kind,
      path: absolutePath ? displayPath(absolutePath, ctx.workspace) : null,
      absolutePath: absolutePath ?? null
    })
  }
}

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

export const metaTools: ToolImpl[] = [todoWriteTool, askUserTool, rememberTool, swarmTool, openArtifactTool]
