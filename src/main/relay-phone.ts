/**
 * 桌面 ↔ 手机的通道域：下行事件、上行指令与两端共用的数据形状。
 * 四个关注点放在同一文件里，因为它们的接口必须一起改：
 * `relay.ts` 在启动时接上当前 LAN 通道。没有注册方时是安全的 no-op。
 */
import type { Artifact, ChatMessage, PermissionRequest, RuntimeEvent, StuckAlert, SuperAgentState, ToolResult, ToolUseBlock } from '../shared/types'
import { messagePlainText } from '../shared/types'
import type { StudioCheck, StudioDelivery, StudioJob, StudioProjectSummary } from '../shared/studio'

/** 下行事件的最小形状，正文由本文件的裁剪函数决定。 */
export interface PhoneEvent {
  type: string
  runId: string
  sessionId: string
  at: number
  [key: string]: unknown
}

type Publisher = (event: PhoneEvent) => void
type SnapshotProvider = () => unknown

/**
 * 创作台任务事件的信封 `type`。
 *
 * 与 28 类 `RuntimeEvent` 并列，但**不属于**那一族：RuntimeEvent 描述
 * 「一轮对话在干什么」，这个描述「一件作品渲染到哪了」。手机侧用
 * `sessionId` 承载 projectId 把它归到作品上。
 */
export const STUDIO_JOB_EVENT = 'studio_job'

/** 手机 `studio_job` 事件的载荷（形状固定，便于两端对照） */
export interface StudioJobPhoneEvent {
  /** Book 所属作品 */
  projectId: string
  jobId: string
  /** 任务类型（text/image/video/voice/music/render/export…） */
  kind: string
  /** queued / running / done / failed / cancelled */
  status: string
  /** 0–100；桌面拿不到真实进度时省略 */
  progress?: number
  label: string
  message?: string
  stage?: string
  at: number
}

/**
 * `StudioJob` → 手机任务事件。
 *
 * 只投「跟盯需要」的字段：用户在手机上要知道的是**哪件作品、哪个任务、
 * 跑到哪了、有没有失败**。`inputHash`/`retry`/`remoteTargets` 属桌面内部账。
 */
export function phoneStudioJob(job: StudioJob, projectId: string): StudioJobPhoneEvent {
  const progress =
    typeof job.progress === 'number' && Number.isFinite(job.progress)
      ? Math.max(0, Math.min(100, Math.round(job.progress)))
      : undefined
  return {
    projectId,
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    ...(progress !== undefined ? { progress } : {}),
    label: clamp(job.label, 200),
    ...(job.message ? { message: clamp(job.message, 400) } : {}),
    ...(job.stage ? { stage: job.stage } : {}),
    at: Date.now()
  }
}

let publisher: Publisher | null = null
let snapshotProvider: SnapshotProvider | null = null

/** 注册/替换发布器。传 null 表示断开（relay 关闭时调用）。 */
export function setPhonePublisher(next: Publisher | null): void {
  publisher = next
}

/** 注册/替换快照提供器。传 null 表示断开。 */
export function setPhoneSnapshotProvider(next: SnapshotProvider | null): void {
  snapshotProvider = next
}

/**
 * 发布一条事件。
 *
 * 发布失败**不能**影响桌面本身：`forward()` 是渲染进程与灵动岛的主链路，
 * 手机端只是旁观者。任何异常都在这里吞掉，避免一个断开的 socket
 * 把桌面事件流整个打断。
 */
export function publishPhoneEvent(event: PhoneEvent): void {
  if (!publisher) return
  try {
    publisher(event)
  } catch {
    // 手机端断开或序列化失败：丢掉这一条，桌面链路继续
  }
}

/** 取当前快照。没有提供器或提供器异常时返回 null（手机显示「正在同步」）。 */
export function buildPhoneSnapshot(): unknown | null {
  if (!snapshotProvider) return null
  try {
    return snapshotProvider()
  } catch {
    return null
  }
}

// ----------------------------------------------------------------

/** 单条消息正文上限：手机屏幕不需要 100 KB 的单条消息 */
const MAX_MESSAGE_TEXT = 20_000
/** 快照里每个会话最多带多少条消息（最近优先） */
export const SNAPSHOT_MESSAGES_PER_SESSION = 40
/** `messages_replaced` 最多带多少条 */
const MAX_REPLACED_MESSAGES = 120

/**
 * 手机 `@` 面板最多带多少个候选文件（F-09）。
 *
 * 400 与 `searchWorkspaceFiles` 内部的结果截断一致。再大的工作区
 * 对「输入时弹出候选」没有意义 —— 用户是来挑一个的，不是来浏览的。
 */
export const MAX_PHONE_WORKSPACE_FILES = 400

/**
 * 取工作区文件列表的内部实现，抽出 `store` 便于测试（F-09）。
 *
 * 生产调用点传 `getSettingsStore()`；测试传一个假 store 就能覆盖
 * 「没有工作区」「设置损坏」这些分支，不必真的去读磁盘上的设置文件。
 */
export function phoneWorkspaceFilesFrom(
  store: { get: () => { lastWorkspace?: string | null } },
  search: (root: string, query: string, limit: number) =>
    Array<{ path: string; name: string; dir: string }>
): Array<{ path: string; name: string; dir: string }> | null {
  let root: string | null = null
  try {
    root = store.get().lastWorkspace ?? null
  } catch {
    // 设置文件损坏 / 尚未初始化：返回 null 让手机显示「没有工作区」，
    // 而不是让整份快照生成失败（那会让手机完全收不到状态）。
    return null
  }
  if (!root) return null
  try {
    return search(root, '', MAX_PHONE_WORKSPACE_FILES).map((item) => ({
      path: item.path,
      name: item.name,
      dir: item.dir
    }))
  } catch {
    return null
  }
}

/**
 * 首连 / 补漏不足时下发的全量快照。
 *
 * 手机端把它当作「一次到位」的状态：会话、消息、运行、待审批、产物、成员。
 * 字段名与各增量事件保持一致，手机可以用同一套投影函数解析，
 * 不需要为快照再写一份 schema。
 */
export interface PhoneSnapshot {
  at: number
  activeSessionId: string | null
  sessions: Array<{
    id: string
    title: string
    liveMessageId: string | null
    messages: Array<Record<string, unknown>>
    artifacts: Array<Record<string, unknown>>
    superAgent: Record<string, unknown> | null
  }>
  runs: Array<{ sessionId: string; runId: string; startedAtMillis: number; stepCount: number }>
  approvals: Array<Record<string, unknown>>
  artifacts: Array<Record<string, unknown>>
  artifactsSessionId: string | null
  members: Record<string, unknown> | null
  /**
   * 工作区里的文件（F-09）。
   *
   * 手机端的输入框支持「@ 引用文件」，`ThreadReducer.mentionQueryOf` 与
   * 整个 `@` 面板 UI 都是完整的 —— 但那一侧的 `files` 一直传的是
   * `emptyList()`，因为**桌面从来没下发过文件列表**。于是用户打 `@`
   * 永远是空面板。
   *
   * 只发搜索结果形态（path/name/dir），不发文件内容：面板只需要名字。
   * 上限 400 条，与 `searchWorkspaceFiles` 内部的截断一致。
   *
   * 没有工作区时为 `null`（不是空数组）—— 「没有工作区」与
   * 「工作区是空的」对用户是两种不同的提示。
   */
  workspaceFiles: Array<{ path: string; name: string; dir: string }> | null
}

const clamp = (value: string, max = 2_000): string => (value.length > max ? value.slice(0, max) : value)

/**
 * 结构化块的单块上限。
 *
 * 为什么按块限而不是只按整条消息限：一块 18 KB 的表格会把整条消息的
 * 预算吃光，后面那些短段落就被截断 —— 用户会看到「前两段完整、后面
 * 全没了」。按块限能让所有块都进来，只是长的那块自己截断。
 */
const MAX_BLOCK_CHARS = 8_000
/** 单条消息最多下发多少块。超出部分折成一条「还有 N 块」的提示块。 */
const MAX_BLOCKS = 60

/**
 * 一条消息的**结构化块**。
 *
 * 手机端不再只拿到一坨纯文本：表格、代码块、行级 diff、链接都以类型化
 * 块的形式下发，手机据此画成表格/代码卡/diff 视图，而不是把源码
 * （`| a | b |`、三连反引号、`+`/`-` 行）当正文显示。
 *
 * 这是对「手机看不到 diff / 表格」这一缺陷的正面修复：此前
 * `messagePlainText()` 只保留 `text`/`error` 块并把它们 join 成纯串，
 * 结构在这一步就丢了，手机无论怎么写渲染器都拿不到数据。
 */
export type PhoneBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool'
      id: string
      name?: string
      title?: string
      category?: string
      status: string
      /** 人话结果摘要（成败、增删行数、退出码、是否新建/删除） */
      result?: Record<string, unknown>
      /** 行级 diff 的文本；只在文件类工具且改动不大时带 */
      diff?: string
      startedAt?: number
      finishedAt?: number
    }
  | { type: 'error'; message: string; code?: string }

/** 单个工具块里 diff 文本的长度上限。超过就只留计数（手机也读不完）。 */
const MAX_TOOL_DIFF_CHARS = 16_000

/**
 * 工具块 → 手机可见的形状。
 *
 * **只对文件写入类工具带 diff 文本。** 命令执行的 `output`、读取类工具的
 * 内容都不下发：那既是最敏感的东西（可能含密钥、私有文件），也是手机
 * 屏幕放不下的日志。文件 diff 是例外 —— 用户要判断「它到底改没改我的
 * 代码」，只给 `+12 −3` 是判断不了的；Trae 手机版的 Unified Diff View
 * 就是这条口径。
 */
export function phoneToolBlock(block: ToolUseBlock): Record<string, unknown> {
  const meta = (block.result?.meta ?? {}) as Record<string, unknown>
  const patch = typeof meta.diff === 'string' ? meta.diff : ''
  const preview = block.result ? phoneToolResult(block.result) : undefined
  return {
    type: 'tool',
    id: block.id,
    ...(block.name ? { name: clamp(block.name, 80) } : {}),
    ...(block.title ? { title: clamp(block.title, 200) } : {}),
    ...(block.category ? { category: block.category } : {}),
    status: block.status,
    ...(preview ? { result: preview } : {}),
    ...(patch && block.category === 'write' ? { diff: clamp(patch, MAX_TOOL_DIFF_CHARS) } : {}),
    ...(typeof block.startedAt === 'number' ? { startedAt: block.startedAt } : {}),
    ...(typeof block.finishedAt === 'number' ? { finishedAt: block.finishedAt } : {})
  }
}

/**
 * 桌面 `ChatMessage` → 手机消息。
 *
 * `text` 仍然保留：旧版手机只认这个字段，删掉会让已装机的用户
 * 看到一片空白。新字段 `blocks` 是增量能力，旧端忽略即可。
 */
export function phoneMessage(message: ChatMessage): Record<string, unknown> {
  const blocks: PhoneBlock[] = []
  for (const block of message.content) {
    if (blocks.length > MAX_BLOCKS) {
      const rest = message.content.length - blocks.length
      blocks.push({ type: 'text', text: `…还有 ${rest} 块内容未同步到手机` })
      break
    }
    switch (block.type) {
      case 'text':
        if (block.text.trim()) blocks.push({ type: 'text', text: clamp(block.text, MAX_BLOCK_CHARS) })
        break
      case 'thinking':
        // 思考过程可以带，但手机默认收起；空的不占位置。
        if (block.text.trim()) blocks.push({ type: 'thinking', text: clamp(block.text, MAX_BLOCK_CHARS) })
        break
      case 'tool_use':
        blocks.push(phoneToolBlock(block) as unknown as PhoneBlock)
        break
      case 'error':
        blocks.push({ type: 'error', message: clamp(block.message, 600), ...(block.code ? { code: block.code } : {}) })
        break
      default: {
        // 穷举保护：新增 ContentBlock 类型时这里会是 never
        const unexpected: never = block
        void unexpected
      }
    }
  }
  return {
    id: message.id,
    role: message.role,
    text: clamp(messagePlainText(message), MAX_MESSAGE_TEXT),
    blocks,
    createdAt: message.createdAt,
    // 这条消息用掉的 token。桌面 `ChatMessage.usage` 一直有，但此前不投 ——
    // 于是手机对话页的「用 18.4K token」那行条件恒 false，永不显示。
    ...(typeof message.usage?.inputTokens === 'number' || typeof message.usage?.outputTokens === 'number'
      ? {
          tokensUsed:
            Math.max(0, Math.round(Number(message.usage?.inputTokens) || 0)) +
            Math.max(0, Math.round(Number(message.usage?.outputTokens) || 0))
        }
      : {}),
    ...(message.interrupted ? { interrupted: true } : {}),
    ...(message.error ? { error: { code: message.error.code, message: clamp(message.error.message, 600) } } : {})
  }
}

/**
 * 桌面成品 → 手机产物视图。
 *
 * 刻意不带 `content`：手机只需要标题/类型/时间；带了会让每次产物更新都
 * 重传完整 HTML。手机端对 `bytes` 的显示会退化成「—」，这是如实反映
 * 「桌面没把正文传过来」，不是编造一个 0。
 */
export function phoneArtifact(artifact: Artifact): Record<string, unknown> {
  return {
    title: artifact.title,
    ...(artifact.path ? { path: artifact.path } : {}),
    kind: artifact.kind,
    ...(artifact.language ? { language: artifact.language } : {}),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt
  }
}

/**
 * 工具调用 → 手机可见的一行摘要。
 *
 * 手机要回答的是「电脑现在在干什么」，不是「把命令原文搬到手机上」：
 * 标题由工具定义的 `titleFor` 生成（「修改 src/a.ts」「删除 out/b.txt」），
 * 已经是一句人话；命令原文与输出正文**永远不下发**——那既是最敏感的
 * 内容（可能含密钥、私有文件），也是手机屏幕放不下的日志。
 *
 * 结果侧只挑能解释「改了什么」的计数与状态：新增/删除行数、是否新建或删除、
 * 退出码、是否超时。这些足以让用户判断「是不是动了我关心的文件」。
 */
export function phoneToolSummary(
  block: { name?: string; title?: string; category?: string }
): Record<string, unknown> {
  return {
    ...(block.name ? { name: clamp(block.name, 80) } : {}),
    ...(block.title ? { title: clamp(block.title, 200) } : {}),
    ...(block.category ? { category: block.category } : {})
  }
}

/** 结果侧摘要：只取计数与状态，绝不带 `output` / `error` 正文。 */
export function phoneToolResult(result: ToolResult | undefined): Record<string, unknown> | undefined {
  if (!result) return undefined
  const meta = (result.meta ?? {}) as Record<string, unknown>
  const int = (key: string): number | undefined => {
    const value = meta[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const summary: Record<string, unknown> = { ok: result.ok === true }
  const added = int('diffAdded')
  const removed = int('diffRemoved')
  if (added !== undefined) summary.diffAdded = added
  if (removed !== undefined) summary.diffRemoved = removed
  if (typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)) {
    summary.durationMs = Math.max(0, Math.round(result.durationMs))
  }
  if (meta.created === true) summary.created = true
  if (meta.deleted === true) summary.deleted = true
  const exitCode = int('exitCode')
  if (exitCode !== undefined) summary.exitCode = exitCode
  if (meta.timedOut === true) summary.timedOut = true
  // 有失败但没正文：只告诉手机「失败了」，原因留在桌面
  if (!result.ok && result.error) summary.failed = true
  return summary
}

/**
 * 文件改动类工具的行级 diff。
 *
 * **这是唯一会下发原文的工具字段**，理由与 `phoneToolBlock` 相同：
 * 「它到底改了哪几行」不能靠 `+12 −3` 回答，而 Trae 手机版的
 * Unified Diff View 证明这是可读的。命令输出、读取内容仍然一律不下发。
 *
 * 只有 `write` 类工具有 `meta.diff`；长度超限就整块不发 ——
 * 截断的 diff 会显示一个「改到一半」的假象，比只给计数更误导。
 */
export function phoneToolDiff(result: ToolResult | undefined): string | undefined {
  if (!result?.ok) return undefined
  const meta = (result.meta ?? {}) as Record<string, unknown>
  const patch = meta.diff
  if (typeof patch !== 'string' || !patch.trim()) return undefined
  if (patch.length > MAX_TOOL_DIFF_CHARS) return undefined
  return patch
}

/** 审批请求只下发手机审批页真正展示与判定要用的字段，不带工具参数原文。 */
export function phonePermission(request: PermissionRequest): Record<string, unknown> {
  return {
    id: request.id,
    toolName: request.toolName,
    title: clamp(request.title, 200),
    summary: clamp(request.summary, 600),
    category: request.category,
    risk: request.risk,
    ...(typeof request.allowAlways === 'boolean' ? { allowAlways: request.allowAlways } : {}),
    createdAt: request.createdAt
  }
}

/**
 * `StuckAlert` → 手机成员卡上的「卡住」徽标。
 *
 * 只投三个字段：手机要回答的是「卡住没有、凭什么、最后在干什么」，
 * 判据本体（evidence 数组、attemptId、resolution 语义）留在桌面。
 * 少投这三个字段的代价很具体：Android 侧的卡住状态机整块是空转的。
 */
function phoneStuck(stuck: StuckAlert | undefined): Record<string, unknown> | undefined {
  if (!stuck) return undefined
  // 已消解的告警不再展示：成员可能随后又跑起来了。
  if (stuck.status === 'resolved') return undefined
  const lastEvidence = stuck.evidence?.[stuck.evidence.length - 1]
  const lastOperation =
    stuck.lastOperation ?? lastEvidence?.title ?? lastEvidence?.output ?? lastEvidence?.name
  return {
    reason: clamp(stuck.reason, 400),
    ...(typeof stuck.stepsSinceProgress === 'number'
      ? { stepsSinceProgress: stuck.stepsSinceProgress }
      : {}),
    ...(lastOperation ? { lastOperation: clamp(lastOperation, 200) } : {}),
    ...(typeof stuck.detectedAt === 'number' ? { detectedAt: stuck.detectedAt } : {})
  }
}

/**
 * 协作状态 → 手机成员列表需要的形状。
 *
 * 手机 `IgnoreBridges.membersOf` 读的是 `{ state: { tasks: [...] } }`，
 * 所以这里保留外层 `state` 结构、只裁字段，不重新发明一套 schema。
 */
export function phoneSuperState(
  state: SuperAgentState | null | undefined,
  sessionId?: string
): Record<string, unknown> | null {
  if (!state) return null
  return {
    status: state.status,
    // 手机干预（停止/重试/发新指令）需要会话 + 项目 + 任务三件套；
    // 缺任何一件，桌面都无法定位到具体成员。
    ...(sessionId ? { sessionId } : {}),
    ...(state.projectId ? { projectId: state.projectId } : {}),
    goal: clamp(state.goal, 800),
    tasks: state.tasks.slice(0, 20).map((task) => ({
      index: task.index,
      ...(task.taskId ?? task.id ? { taskId: task.taskId ?? task.id } : {}),
      title: clamp(task.title, 200),
      agent: 'general',
      ...(task.roleTitle ? { agentTitle: clamp(task.roleTitle, 120) } : {}),
      status: task.status,
      ...(typeof task.stepCount === 'number' ? { stepCount: task.stepCount } : {}),
      ...(task.note ? { note: clamp(task.note, 400) } : {}),
      ...(task.summary ? { summary: clamp(task.summary, 800) } : {}),
      ...(task.error ? { error: clamp(task.error, 600) } : {}),
      ...(() => {
        const stuck = phoneStuck(task.stuck)
        return stuck ? { stuck } : {}
      })()
    }))
  }
}

/**
 * 单条事件裁剪。返回 null = 这条事件对手机没有意义，不占用序号也不占带宽。
 *
 * 被丢掉的是：`question_asked`（手机没有提问 UI）、`collaboration_updated`
 * （手机用 `super_updated` 的成员视图）、`episodes_captured`、`demo_step`。
 */
export function toPhoneEvent(event: RuntimeEvent): PhoneEvent | null {
  const base = {
    type: event.type,
    runId: event.runId,
    sessionId: event.sessionId,
    at: event.at
  }

  switch (event.type) {
    case 'run_started':
      return { ...base, userMessage: phoneMessage(event.userMessage), assistantMessageId: event.assistantMessageId }
    case 'run_finished':
      return { ...base, reason: event.reason }
    case 'message_started':
      return { ...base, messageId: event.messageId, role: event.role }
    case 'message_delta':
      return {
        ...base,
        messageId: event.messageId,
        ...(event.textDelta !== undefined ? { textDelta: clamp(event.textDelta, MAX_MESSAGE_TEXT) } : {}),
        ...(event.thinkingDelta !== undefined ? { thinkingDelta: clamp(event.thinkingDelta, MAX_MESSAGE_TEXT) } : {})
      }
    case 'message_completed':
      return { ...base, messageId: event.messageId, message: phoneMessage(event.message) }
    case 'messages_replaced':
      return {
        ...base,
        messages: event.messages.slice(-MAX_REPLACED_MESSAGES).map(phoneMessage)
      }
    case 'session_updated':
      return { ...base, title: event.title ?? event.meta.title }
    case 'permission_requested':
      return { ...base, request: phonePermission(event.request) }
    case 'permission_resolved':
      return { ...base, requestId: event.requestId, decision: event.decision }
    case 'tool_started':
      // 工具输入可能包含完整文件内容/命令原文；手机只收名字、人话标题与类别。
      // 这三样足够画出「正在修改 src/a.ts」这一行，且不会把命令搬到手机上。
      return { ...base, messageId: event.messageId, toolUseId: event.block.id, tool: phoneToolSummary(event.block) }
    case 'tool_progress':
      return {
        ...base,
        messageId: event.messageId,
        toolUseId: event.toolUseId,
        ...(event.status ? { status: event.status } : {}),
        ...(event.title ? { title: clamp(event.title, 200) } : {}),
        ...(event.note ? { note: clamp(event.note, 400) } : {}),
        ...(typeof event.percent === 'number' ? { percent: event.percent } : {}),
        ...(typeof event.stepCount === 'number' ? { stepCount: event.stepCount } : {}),
        ...(event.memberTask ? { memberTask: event.memberTask } : {})
      }
    case 'tool_finished':
      // 结果正文（命令输出 / 文件内容）不下发；只给「成败 + 改了几行 + 退出码」。
      return {
        ...base,
        messageId: event.messageId,
        toolUseId: event.toolUseId,
        ...(event.result ? { toolResult: phoneToolResult(event.result) } : {}),
        // 文件写入类工具额外带行级 diff：手机要能看见改了哪几行。
        ...(phoneToolDiff(event.result) ? { toolDiff: phoneToolDiff(event.result) } : {}),
        ...(event.interrupted ? { interrupted: true } : {}),
        ...(event.denied ? { denied: true } : {})
      }
    case 'usage_updated':
      return {
        ...base,
        usage: {
          ...(typeof event.usage.inputTokens === 'number' ? { inputTokens: event.usage.inputTokens } : {}),
          ...(typeof event.usage.outputTokens === 'number' ? { outputTokens: event.usage.outputTokens } : {})
        }
      }
    case 'artifacts_updated':
      return {
        ...base,
        artifacts: event.artifacts.slice(-40).map(phoneArtifact),
        ...(event.artifactId ? { artifactId: event.artifactId } : {})
      }
    case 'todos_updated':
      return {
        ...base,
        todos: event.todos.map((todo) => ({ id: todo.id, text: clamp(todo.text, 200), status: todo.status }))
      }
    case 'super_updated':
      return { ...base, state: phoneSuperState(event.state, event.sessionId) }
    case 'goal_updated':
      return {
        ...base,
        goal: event.goal
          ? {
              status: event.goal.status,
              round: event.goal.round,
              maxRounds: event.goal.maxRounds,
              ...(typeof event.goal.stopReason === 'string' ? { stopReason: clamp(event.goal.stopReason, 200) } : {})
            }
          : null
      }
    case 'plan_updated':
      // 计划必须带 steps：只发标题的话，手机上的计划卡永远是「已批准 / 待批准」
      // 加一行标题，用户看不到到底要做什么 —— 而这正是手机上唯一能
      // 提前判断「这个计划靠不靠谱」的地方。
      return {
        ...base,
        planMode: event.planMode,
        plan: event.plan
          ? {
              title: clamp(event.plan.title, 200),
              ...(event.plan.summary ? { summary: clamp(event.plan.summary, 600) } : {}),
              status: event.plan.status,
              steps: event.plan.steps.slice(0, 40).map((step) => ({
                // id 不是所有计划都有；手机只用来做稳定 key，缺了按序号补
                id: step.id,
                text: clamp(step.text, 300)
              })),
              ...(event.plan.risks ? { risks: clamp(event.plan.risks, 600) } : {})
            }
          : null
      }
    case 'research_updated':
      return { ...base, research: event.research ? { status: event.research.status } : null }
    case 'queue_updated':
      return { ...base, queue: event.queue.slice(0, 20).map((item) => ({ id: item.id, text: clamp(item.text, 500) })) }
    case 'compaction':
      return {
        ...base,
        phase: event.phase,
        ...(typeof event.savedTokens === 'number' ? { savedTokens: event.savedTokens } : {})
      }
    case 'notice':
      return { ...base, level: event.level, message: clamp(event.message, 600), ...(event.code ? { code: event.code } : {}) }
    case 'error':
      return { ...base, error: { code: event.error.code, message: clamp(event.error.message, 600) } }
    case 'question_asked':
    case 'question_answered':
    case 'collaboration_updated':
    case 'episodes_captured':
    case 'demo_step':
      return null
    default: {
      // 穷举保护：将来新增事件时这里会是 `never`，编译报错而不是静默丢弃。
      const unexpected: never = event
      void unexpected
      return null
    }
  }
}

// ----------------------------------------------------------------

export interface PhoneInvokeRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

export interface PhoneInvokeError {
  code: string
  message: string
}

export interface PhoneInvokeResult {
  ok: boolean
  result?: unknown
  error?: PhoneInvokeError
}

export type PhoneInvokeHandler = (request: PhoneInvokeRequest) => PhoneInvokeResult | Promise<PhoneInvokeResult>

/**
 * 白名单：每一项都在 ipc.ts 有对应实现，新增方法必须同时改两端与测试。
 *
 * 注意配对确认**不在这里**：它必须发生在 hello 鉴权之前（桌面此时还不认识
 * 这台设备，加密通道建不起来），所以走 `DirectChannel` 的握手前帧
 * （`kind: 'pair-confirm'`，见 relay-channel.ts）。
 */
export const PHONE_METHODS = ['approval.decide', 'run.stop', 'snapshot.get', 'message.send', 'works.get', 'works.preview', 'swarm.stopMember', 'swarm.retryMember', 'swarm.instruction', 'ping'] as const

const MAX_ID = 120
const MAX_METHOD = 80
const MAX_REQUEST_ID = 200

let handler: PhoneInvokeHandler | null = null
let handled = 0
let rejected = 0

/** 注册/清空处理器。由 ipc 层在拿到 AgentService 后调用。 */
export function setPhoneInvokeHandler(next: PhoneInvokeHandler | null): void {
  handler = next
}

export function phoneInvokeStats(): { hasHandler: boolean; handled: number; rejected: number } {
  return { hasHandler: handler !== null, handled, rejected }
}

const fail = (code: string, message: string): PhoneInvokeResult => ({ ok: false, error: { code, message } })

/**
 * 校验并执行一条 invoke。**永不抛错**：调用方（DirectChannel）拿到结果后回帧。
 */
export async function dispatchPhoneInvoke(raw: unknown): Promise<PhoneInvokeResult> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    rejected++
    return fail('bad_request', 'invoke 必须是对象')
  }
  const frame = raw as Record<string, unknown>
  const id = typeof frame.id === 'string' ? frame.id : ''
  const method = typeof frame.method === 'string' ? frame.method : ''
  if (!id || id.length > MAX_ID) {
    rejected++
    return fail('bad_request', '缺 id 或 id 过长')
  }
  if (!method || method.length > MAX_METHOD) {
    rejected++
    return fail('bad_request', '缺 method 或 method 过长')
  }
  if (!(PHONE_METHODS as readonly string[]).includes(method)) {
    rejected++
    return fail('unsupported', `不支持的方法：${method}`)
  }

  const rawParams = frame.params
  const params =
    rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : {}
  if (rawParams !== undefined && (rawParams === null || typeof rawParams !== 'object' || Array.isArray(rawParams))) {
    rejected++
    return fail('bad_request', 'params 必须是对象')
  }

  if (method === 'approval.decide') {
    const requestId = params.requestId
    if (typeof requestId !== 'string' || !requestId || requestId.length > MAX_REQUEST_ID) {
      rejected++
      return fail('bad_request', '缺 requestId')
    }
    // 手机端不允许 always。这里不把 always 映射成 once —— 静默降级
    // 会让用户以为「始终允许」生效了，实际只授权一次，后果更难解释。
    if (params.decision !== 'once' && params.decision !== 'deny') {
      rejected++
      return fail('forbidden', '手机端只允许 once / deny')
    }
  }

  if (method === 'run.stop') {
    if (typeof params.runId !== 'string' || !params.runId || params.runId.length > MAX_ID) {
      rejected++
      return fail('bad_request', '缺 runId')
    }
  }

  if (method === 'message.send') {
    if (typeof params.sessionId !== 'string' || !params.sessionId || params.sessionId.length > MAX_REQUEST_ID) {
      rejected++
      return fail('bad_request', '缺 sessionId')
    }
    // 空白消息不启动一轮 agent：那只会让模型收到空输入，白烧一次调用。
    if (typeof params.text !== 'string' || !params.text.trim()) {
      rejected++
      return fail('bad_request', '消息不能为空')
    }
    if (params.text.length > 20_000) {
      rejected++
      return fail('bad_request', '消息超过 20000 字符')
    }
  }

  if (method === 'works.preview') {
    for (const key of ['workId', 'productId'] as const) {
      const value = params[key]
      if (typeof value !== 'string' || !value || value.length > MAX_REQUEST_ID) {
        rejected++
        return fail('bad_request', `缺 ${key}`)
      }
    }
  }

  if (method === 'swarm.stopMember' || method === 'swarm.retryMember' || method === 'swarm.instruction') {
    for (const key of ['projectId', 'taskId'] as const) {
      const value = params[key]
      if (typeof value !== 'string' || !value || value.length > MAX_REQUEST_ID) {
        rejected++
        return fail('bad_request', `缺 ${key}`)
      }
    }
    if (method !== 'swarm.stopMember') {
      const sessionId = params.sessionId
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > MAX_REQUEST_ID) {
        rejected++
        return fail('bad_request', '缺 sessionId')
      }
    }
    if (method === 'swarm.instruction') {
      const text = params.text
      if (typeof text !== 'string' || !text.trim()) {
        rejected++
        return fail('bad_request', '指令不能为空')
      }
      if (text.length > 4_000) {
        rejected++
        return fail('bad_request', '指令超过 4000 字符')
      }
    }
  }

  if (!handler) {
    rejected++
    return fail('unavailable', '桌面尚未注册上行处理器')
  }

  handled++
  try {
    const result = await handler({ id, method, params })
    // 处理器返回 undefined/非对象属于实现错误：按失败回帧，不把
    // `undefined` 塞进 JSON（序列化后会变成缺字段，手机无法判断结果）。
    if (!result || typeof result !== 'object') return fail('bad_response', '处理器返回了非法结果')
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return fail('failed', message)
  }
}

// ----------------------------------------------------------------

/** 手机端产物：只有元数据，没有文件内容。 */
export interface PhoneWorkProduct {
  id: string
  label: string
  /** `StudioDelivery['kind']`：mp4/comic/pdf/png/... */
  kind: string
  bytes: number
  createdAtMillis: number
}

export interface PhoneWork {
  id: string
  title: string
  /** 'short' | 'novel' | 'drama'（与手机 StudioKind 对齐） */
  kind: string
  logline: string
  updatedAtMillis: number
  /** 当前阶段 id（blueprint/outline/...，手机按 StageCatalog 查名字） */
  stage: string
  /** 当前阶段完成度 0–100 */
  progress: number
  chapters: number
  shots: number
  assets: number
  words: number
  /** 成片/成书/工程包清单（新的在前），手机据此显示可预览行 */
  products: PhoneWorkProduct[]
  /** 未通过的 error 级检查数；>0 时手机显示「N 条检查未通过」 */
  blockingChecks?: number
  /**
   * 每个阶段的真实状态：`{ [stageId]: { status, progress?, message? } }`。
   *
   * 有了它，手机不再靠 `chain.indexOf(stage)` 推演「前面都完成、后面都等待」。
   * 缺失时手机退回推演（旧桌面），并在 UI 上标「状态未上报」而不是假装知道。
   */
  stageStatuses?: Record<string, Record<string, unknown>>
}

/** 单件作品最多带多少条未通过检查（够说明问题，不至于把摘要撑大） */
export const MAX_PHONE_CHECKS = 20

/** 一条「未通过检查」的手机侧形状 */
export interface PhoneCheck {
  /** 检查类别（continuity / visual / audio / …），手机用它分组 */
  kind: string
  title: string
  detail: string
}

const MAX_WORKS = 40

/**
 * 手机一次能安全取回的预览字节数。
 *
 * 中继单帧上限 8 MiB（桌面 `maxPayload` / 手机 `MAX_MESSAGE_BYTES` 对齐），
 * base64 后膨胀 4/3，4 MiB 原文 ≈ 5.3 MiB 帧，仍在限内。
 */
export const MAX_PHONE_PREVIEW_BYTES = 4 * 1024 * 1024

/** `works.preview` 的回包：要么带 base64，要么明确告诉手机「太大」。 */
export type PhoneDeliveryPreview =
  | { tooLarge: true; bytes: number; mime: string; label: string; kind: string }
  | { tooLarge: false; bytes: number; mime: string; label: string; kind: string; dataBase64: string }

/** 交付类型 → MIME。手机按它决定用哪种预览器。 */
export function deliveryMime(kind: string): string {
  switch (kind) {
    case 'png':
      return 'image/png'
    case 'cover':
      return 'image/jpeg'
    case 'pdf':
      return 'application/pdf'
    case 'mp4':
      return 'video/mp4'
    case 'mov':
      return 'video/quicktime'
    case 'mkv':
      return 'video/x-matroska'
    case 'webm':
      return 'video/webm'
    case 'wav':
      return 'audio/wav'
    case 'mp3':
      return 'audio/mpeg'
    case 'm4a':
      return 'audio/mp4'
    case 'flac':
      return 'audio/flac'
    case 'srt':
      return 'application/x-subrip'
    case 'ass':
      return 'text/x-ssa'
    case 'epub':
      return 'application/epub+zip'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'txt':
      return 'text/plain; charset=utf-8'
    case 'md':
      return 'text/markdown; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

/** 产物清单：按创建时间倒序，字段改成手机直白命名。 */
export function phoneProducts(deliveries: StudioDelivery[]): PhoneWorkProduct[] {
  return [...deliveries]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((delivery) => ({
      id: delivery.id,
      label: delivery.label || delivery.kind,
      kind: delivery.kind,
      bytes: Number.isFinite(delivery.bytes) ? Math.max(0, Math.round(delivery.bytes)) : 0,
      createdAtMillis: delivery.createdAt
    }))
}

/**
 * 按最近更新倒序；最多 40 个（手机是旁观端，不是归档器）。
 *
 * `productsFor` 允许调用方按需读每个工程的产物清单；纯函数测试传默认值
 * 即得到空清单，不会因为「没有产物」把作品本身丢掉。
 */
/**
 * 每个阶段的真实状态 → 手机能直读的扁平表。
 *
 * 为什么必须下发：手机原来靠 `chain.indexOf(project.stage)` 推演 ——
 * 只有「当前阶段」一个标量。于是桌面上处于 failed / stale / review / skipped
 * 的阶段，在手机上一律显示成「进行中」或「完成」。用户看到进度条在走，
 * 而桌面那边早就停在失败上了。
 *
 * 只投 `{ id: { status, progress, message } }`，不投 updatedAt：
 * 手机不按时间排序阶段，投了也只是多几个没人读的字节。
 */
export function phoneStageStatuses(
  stages: Record<string, { status?: string; progress?: number; message?: string }> | undefined
): Record<string, Record<string, unknown>> | undefined {
  if (!stages) return undefined
  const out: Record<string, Record<string, unknown>> = {}
  for (const [id, state] of Object.entries(stages)) {
    if (!state || typeof state !== 'object') continue
    out[id] = {
      status: typeof state.status === 'string' ? state.status : 'waiting',
      ...(typeof state.progress === 'number' && Number.isFinite(state.progress)
        ? { progress: Math.max(0, Math.min(100, Math.round(state.progress))) }
        : {}),
      ...(state.message ? { message: clamp(state.message, 300) } : {})
    }
  }
  return Object.keys(out).length ? out : undefined
}

export function phoneWorks(
  projects: StudioProjectSummary[],
  productsFor: (projectId: string) => PhoneWorkProduct[] = () => [],
  stagesFor: (projectId: string) => Record<string, Record<string, unknown>> | undefined = () => undefined
): PhoneWork[] {
  return [...projects]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_WORKS)
    .map((project) => ({
      id: project.id,
      title: project.title,
      kind: project.kind,
      logline: project.logline,
      updatedAtMillis: project.updatedAt,
      stage: project.stage,
      progress: Number.isFinite(project.progress) ? Math.max(0, Math.min(100, Math.round(project.progress))) : 0,
      chapters: project.chapters,
      shots: project.shots,
      assets: project.assets,
      words: project.words,
      products: productsFor(project.id),
      ...(typeof project.blockingChecks === 'number' && project.blockingChecks > 0
        ? { blockingChecks: project.blockingChecks }
        : {}),
      ...(() => {
        const stages = stagesFor(project.id)
        return stages ? { stageStatuses: stages } : {}
      })()
    }))
}

/**
 * `StudioCheck[]` → 手机作品页的「未通过检查」摘要。
 *
 * 只投未消解的 error：warn 不阻断出包，铺在手机上会让用户以为出不了片。
 * detail 全量太长（有的一句就是一段 ffmpeg 报错），截到 300 字足够说明问题。
 */
export function phoneChecks(checks: StudioCheck[]): PhoneCheck[] {
  return checks
    .filter((check) => !check.resolved && check.level === 'error')
    .slice(0, MAX_PHONE_CHECKS)
    .map((check) => ({
      // StudioCheck 没有 code，只有 kind（continuity/visual/…）——
      // 手机侧用它来分组文案，不要凭空造一个 id。
      kind: check.kind,
      title: clamp(check.title, 120),
      detail: clamp(check.detail, 300)
    }))
}
