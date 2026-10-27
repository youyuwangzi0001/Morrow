// 工具调用的展示元信息：图标种类、人话摘要、耗时、diff 提取。
import type { ChatMessage, PermissionRequest, ToolResult, ToolUseBlock } from '@shared/types'

export type ToolVisual = 'read' | 'write' | 'edit' | 'search' | 'command' | 'list' | 'glob' | 'todo' | 'ask' | 'artifact' | 'web' | 'memory' | 'media' | 'other'

const BY_NAME: Record<string, ToolVisual> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  delete_file: 'write',
  move_file: 'write',
  copy_file: 'write',
  make_dir: 'write',
  view_image: 'read',
  list_dir: 'list',
  glob: 'glob',
  grep: 'search',
  run_command: 'command',
  todo_write: 'todo',
  ask_user: 'ask',
  open_artifact: 'artifact',
  remember: 'memory',
  web_search: 'web',
  web_fetch: 'web',
  browser_open: 'web',
  browser_click: 'web',
  browser_type: 'web',
  browser_read: 'web',
  browser_screenshot: 'web',
  browser_back: 'web',
  browser_forward: 'web',
  browser_reload: 'web',
  browser_close: 'web',
  generate_image: 'media',
  generate_video: 'media',
  generate_film: 'media',
  render_animation: 'media',
  edit_media: 'media',
  inspect_media: 'media',
  describe_media: 'media',
  media_status: 'media'
}

export function toolVisual(block: Pick<ToolUseBlock, 'name' | 'category'>): ToolVisual {
  const byName = BY_NAME[block.name]
  if (byName) return byName
  switch (block.category) {
    case 'read':
      return 'read'
    case 'write':
      return 'write'
    case 'exec':
      return 'command'
    default:
      return 'other'
  }
}

function pickString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** 工具栏/轨迹里的 mono 摘要：路径、命令、搜索词之类 */
export function toolSummary(block: Pick<ToolUseBlock, 'name' | 'input' | 'category'>): string {
  const input = block.input ?? {}
  const path = pickString(input, ['path', 'file_path', 'filePath', 'target', 'dir', 'directory'])
  switch (block.name) {
    case 'run_command':
      return pickString(input, ['command', 'cmd']) ?? ''
    case 'grep':
      return [pickString(input, ['pattern', 'query']), path].filter(Boolean).join('  ·  ')
    case 'glob':
      return [pickString(input, ['pattern', 'glob']), path].filter(Boolean).join('  ·  ')
    case 'todo_write':
      return Array.isArray(input.todos) ? `${input.todos.length} 项任务` : ''
    case 'ask_user':
      return pickString(input, ['question']) ?? ''
    case 'remember':
      return pickString(input, ['key', 'name']) ?? ''
    case 'move_file':
    case 'copy_file':
      return [pickString(input, ['from']), pickString(input, ['to'])].filter(Boolean).join(' → ')
    case 'make_dir':
      return pickString(input, ['path']) ?? ''
    case 'view_image':
      return pickString(input, ['path']) ?? ''
    case 'open_artifact':
      return pickString(input, ['title', 'path']) ?? ''
    case 'generate_image':
    case 'generate_video':
      return pickString(input, ['prompt']) ?? ''
    case 'edit_media':
      return [pickString(input, ['operation']), path].filter(Boolean).join(' · ')
    case 'inspect_media':
      return path ?? ''
    case 'media_status':
      return ''
    default:
      if (path) return path
      const first = Object.values(input).find((value) => typeof value === 'string')
      return typeof first === 'string' ? first : ''
  }
}

/** 文件类工具的路径（用于打开画布/定位） */
export function toolPath(block: Pick<ToolUseBlock, 'name' | 'input'>): string | null {
  return pickString(block.input ?? {}, ['path', 'file_path', 'filePath', 'target'])
}

/** 状态中文标签（失败/等待类才显示，成功不啰嗦） */
export function toolStatusLabel(status: ToolUseBlock['status']): string | null {
  switch (status) {
    case 'running':
      return '运行中'
    case 'waiting':
      return '等待你确认'
    case 'error':
      return '失败'
    case 'denied':
      return '已拒绝'
    case 'interrupted':
      return '已中断'
    default:
      return null
  }
}

export function formatDuration(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`
}

export function toolDuration(block: ToolUseBlock): string {
  const fromResult = block.result?.durationMs
  if (typeof fromResult === 'number') return formatDuration(fromResult)
  if (block.startedAt && block.finishedAt) return formatDuration(block.finishedAt - block.startedAt)
  return ''
}

export interface DiffInfo {
  patch?: string
  before?: string
  after?: string
  filePath?: string
  added?: number
  removed?: number
  truncated?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export interface FileDiffEvent {
  path: string
  created: boolean
  deleted: boolean
}

/** 一条消息里所有文件增删事件；用于按「轮」剔除新建后又删除的净零文件。 */
export function fileDiffEvents(message: ChatMessage): FileDiffEvent[] {
  const events: FileDiffEvent[] = []
  for (const block of message.content) {
    if (block.type !== 'tool_use' || !block.result?.ok) continue
    const meta = block.result.meta as Record<string, unknown> | undefined
    if (Array.isArray(meta?.changedFiles)) {
      for (const entry of meta.changedFiles) {
        if (!entry || typeof entry !== 'object') continue
        const file = entry as Record<string, unknown>
        const path = typeof file.absolutePath === 'string' ? file.absolutePath : ''
        if (!path) continue
        events.push({
          path,
          created: file.created === true,
          deleted: file.deleted === true
        })
      }
      continue
    }
    const path =
      typeof meta?.absolutePath === 'string'
        ? meta.absolutePath
        : typeof block.input?.path === 'string'
          ? block.input.path
          : ''
    if (!path) continue
    const created = meta?.created === true
    const deleted = meta?.deleted === true
    if (!created && !deleted && typeof meta?.diffAdded !== 'number' && typeof meta?.diffRemoved !== 'number') {
      continue
    }
    events.push({ path, created, deleted })
  }
  return events
}

/** 从工具结果 meta 里提取 diff（兼容 patch 字符串 / DiffResult 对象 / before-after） */
export function extractDiff(result?: ToolResult, block?: Pick<ToolUseBlock, 'input'>): DiffInfo | null {
  if (!result) return null
  const meta = result.meta
  const filePath = block ? pickString(block.input ?? {}, ['path', 'file_path', 'filePath']) ?? undefined : undefined
  if (!meta) return null
  const raw = meta.diff
  if (typeof raw === 'string' && raw.trim()) {
    return {
      patch: raw,
      added: typeof meta.diffAdded === 'number' ? meta.diffAdded : undefined,
      removed: typeof meta.diffRemoved === 'number' ? meta.diffRemoved : undefined,
      filePath: filePath ?? (typeof meta.path === 'string' ? meta.path : undefined)
    }
  }
  if (isRecord(raw)) {
    return {
      patch: typeof raw.patch === 'string' ? raw.patch : undefined,
      added: typeof raw.added === 'number' ? raw.added : undefined,
      removed: typeof raw.removed === 'number' ? raw.removed : undefined,
      truncated: raw.truncated === true,
      filePath: filePath ?? (typeof meta.path === 'string' ? meta.path : undefined)
    }
  }
  if (typeof meta.before === 'string' || typeof meta.after === 'string') {
    return {
      before: typeof meta.before === 'string' ? meta.before : '',
      after: typeof meta.after === 'string' ? meta.after : '',
      filePath: filePath ?? (typeof meta.path === 'string' ? meta.path : undefined)
    }
  }
  return null
}

/** 审批请求的一句话解释：让新手知道「会发生什么、可不可以拒绝」 */
export function permissionExplanation(request: PermissionRequest): string {
  const target = toolSummary({ name: request.toolName, input: request.input, category: request.category })
  if (request.toolName === 'run_command') {
    return '这条命令会在你的电脑上运行。你可以先看完整内容，再决定是否允许。'
  }
  if (request.category === 'write') {
    return target
      ? `Morrow 会修改 ${target}，改动前会自动备份，你随时可以在工具记录里查看改了什么。`
      : 'Morrow 会修改工作区里的文件，改动前会自动备份。'
  }
  if (request.category === 'read') {
    return target ? `Morrow 想读取工作区外的内容：${target}` : 'Morrow 想读取工作区外的内容。'
  }
  if (request.category === 'exec') {
    return '这个操作会在你的电脑上执行，只有你允许后才会继续。'
  }
  return 'Morrow 需要你确认后才能继续这一步。'
}
