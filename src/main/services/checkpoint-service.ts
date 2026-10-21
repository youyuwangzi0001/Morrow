/**
 * P0-3 检查点与回退。
 *
 * 每轮用户消息开始时创建一个检查点；写/编辑工具（含子代理）成功后，
 * 把「本轮第一次改到该文件时的写前快照」与「最后一次写入后哈希」记入检查点。
 *
 * 回退：
 * - code：把所有受影响文件恢复到目标轮开始前的状态（新建文件删除），
 *   回退前用「最后一次 afterHash」检测文件是否被外部修改，冲突则整体拒绝；
 * - conversation：从目标用户消息开始截断对话，并恢复 todo / artifacts / plan；
 * - both：两者都做。
 *
 * 边界：只跟踪 write_file / edit_file（含子代理）产生的变更；run_command 的
 * 副作用无法通用追踪，若它改动了已登记文件，哈希冲突会阻止回退；未登记文件
 * 不会出现在检查点里。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type {
  CheckpointFile,
  ChatMessage,
  RewindPreview,
  RewindResult,
  RewindScope,
  Session,
  TurnCheckpoint
} from '../../shared/types'
import { userMessageDisplayText } from '../../shared/message'
import { log } from './logger'
import { dataPath } from './paths'
import type { SessionStore } from './session-store'

const SAFE_ID = /^[A-Za-z0-9_-]{4,80}$/
const MAX_CHECKPOINTS = 30
const MAX_LABEL = 160

function sha256File(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null
    const hash = createHash('sha256')
    hash.update(readFileSync(path))
    return hash.digest('hex')
  } catch {
    return null
  }
}

function isInside(root: string, target: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = normalize(resolve(root))
  const candidate = normalize(resolve(target))
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return candidate === base || candidate.startsWith(prefix)
}

function normalizeCheckpoint(raw: unknown, sessionId: string): TurnCheckpoint | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (
    typeof item.id !== 'string' ||
    !SAFE_ID.test(item.id) ||
    item.sessionId !== sessionId ||
    typeof item.messageId !== 'string' ||
    typeof item.label !== 'string' ||
    !Array.isArray(item.files)
  ) {
    return null
  }
  const files: CheckpointFile[] = []
  for (const entry of item.files) {
    if (!entry || typeof entry !== 'object') continue
    const file = entry as Record<string, unknown>
    if (typeof file.path !== 'string' || typeof file.existed !== 'boolean') continue
    files.push({
      path: file.path,
      existed: file.existed,
      beforeHash: typeof file.beforeHash === 'string' ? file.beforeHash : null,
      afterHash: typeof file.afterHash === 'string' ? file.afterHash : null,
      ...(typeof file.snapshotPath === 'string' ? { snapshotPath: file.snapshotPath } : {})
    })
  }
  return {
    id: item.id,
    sessionId,
    messageId: item.messageId,
    messageIndex: typeof item.messageIndex === 'number' ? item.messageIndex : 0,
    label: item.label.slice(0, MAX_LABEL),
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    files,
    todos: Array.isArray(item.todos) ? (item.todos as TurnCheckpoint['todos']) : [],
    artifactIds: Array.isArray(item.artifactIds)
      ? item.artifactIds.filter((id): id is string => typeof id === 'string')
      : [],
    plan: item.plan && typeof item.plan === 'object' ? (item.plan as TurnCheckpoint['plan']) : null,
    planMode: item.planMode === true
  }
}

interface RestorePlanEntry {
  pre: CheckpointFile
  expectedAfter: string | null
}

export class CheckpointService {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly dataDir?: string
  ) {}

  private root(sessionId: string): string {
    return this.dataDir
      ? join(this.dataDir, 'checkpoints', sessionId)
      : dataPath('checkpoints', sessionId)
  }

  private snapshotRoot(sessionId: string): string {
    return this.dataDir ? join(this.dataDir, 'snapshots', sessionId) : dataPath('snapshots', sessionId)
  }

  private fileFor(sessionId: string, checkpointId: string): string {
    return join(this.root(sessionId), `${checkpointId}.json`)
  }

  private save(checkpoint: TurnCheckpoint): void {
    if (!SAFE_ID.test(checkpoint.id) || !SAFE_ID.test(checkpoint.sessionId)) return
    const dir = this.root(checkpoint.sessionId)
    mkdirSync(dir, { recursive: true })
    const file = this.fileFor(checkpoint.sessionId, checkpoint.id)
    const tmp = `${file}.${process.pid}.tmp`
    const content = JSON.stringify(checkpoint, null, 2)
    writeFileSync(tmp, content, 'utf8')
    // Windows 杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        renameSync(tmp, file)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
        if (attempt === 3) {
          writeFileSync(file, content, 'utf8')
          rmSync(tmp, { force: true })
          log.warn('checkpoint rename retried out, wrote in place', { id: checkpoint.id, code })
          return
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
      }
    }
  }

  /** 每轮开始：记录消息位置、todos/artifacts/plan 快照；无文件变更时也可用于对话回退。 */
  create(session: Session, userMessage: ChatMessage, messageIndex: number): TurnCheckpoint | null {
    if (!SAFE_ID.test(session.id)) return null
    const checkpoint: TurnCheckpoint = {
      id: `cp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      sessionId: session.id,
      messageId: userMessage.id,
      messageIndex,
      label: userMessageDisplayText(userMessage).replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) || '（空消息）',
      createdAt: Date.now(),
      files: [],
      todos: session.todos.map((todo) => ({ ...todo })),
      artifactIds: session.artifacts.map((artifact) => artifact.id),
      plan: session.plan ? (JSON.parse(JSON.stringify(session.plan)) as TurnCheckpoint['plan']) : null,
      planMode: session.planMode === true
    }
    this.save(checkpoint)
    this.prune(session.id)
    return checkpoint
  }

  /** 写/编辑工具成功后登记文件；子代理通过 meta.changedFiles 批量上报。 */
  recordToolResult(sessionId: string, checkpointId: string, meta: Record<string, unknown> | undefined): void {
    if (!meta || !SAFE_ID.test(sessionId) || !SAFE_ID.test(checkpointId)) return
    const checkpoint = this.get(sessionId, checkpointId)
    if (!checkpoint) return
    const rawEntries = Array.isArray(meta.changedFiles) ? meta.changedFiles : [meta]
    let changed = false
    for (const raw of rawEntries) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      const path = typeof entry.absolutePath === 'string' ? entry.absolutePath : ''
      if (!path) continue
      const afterHash = typeof entry.afterHash === 'string' ? entry.afterHash : null
      if (!afterHash) continue
      const created = entry.created === true
      const snapshotPath = typeof entry.snapshotPath === 'string' ? entry.snapshotPath : undefined
      const existing = checkpoint.files.find((file) => file.path === path)
      if (existing) {
        existing.afterHash = afterHash
        if (!existing.snapshotPath && snapshotPath && !created) existing.snapshotPath = snapshotPath
        changed = true
        continue
      }
      checkpoint.files.push({
        path,
        existed: !created,
        beforeHash: typeof entry.beforeHash === 'string' ? entry.beforeHash : null,
        afterHash,
        ...(snapshotPath && !created ? { snapshotPath } : {})
      })
      changed = true
    }
    if (changed) this.save(checkpoint)
  }

  get(sessionId: string, checkpointId: string): TurnCheckpoint | null {
    if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(checkpointId)) return null
    const file = this.fileFor(sessionId, checkpointId)
    if (!existsSync(file)) return null
    try {
      return normalizeCheckpoint(JSON.parse(readFileSync(file, 'utf8')) as unknown, sessionId)
    } catch (err) {
      log.warn('checkpoint parse failed', { sessionId, checkpointId, error: String(err) })
      return null
    }
  }

  /** 最新在前，供回退面板展示。 */
  list(sessionId: string): TurnCheckpoint[] {
    if (!SAFE_ID.test(sessionId)) return []
    const dir = this.root(sessionId)
    if (!existsSync(dir)) return []
    const checkpoints: TurnCheckpoint[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const checkpoint = this.get(sessionId, name.slice(0, -'.json'.length))
      if (checkpoint) checkpoints.push(checkpoint)
    }
    return checkpoints.sort((a, b) => b.createdAt - a.createdAt)
  }

  private prune(sessionId: string): void {
    const all = this.list(sessionId)
    for (const checkpoint of all.slice(MAX_CHECKPOINTS)) {
      try {
        rmSync(this.fileFor(sessionId, checkpoint.id), { force: true })
      } catch {
        // 清理失败不影响新一轮
      }
    }
  }

  removeSession(sessionId: string): void {
    if (!SAFE_ID.test(sessionId)) return
    try {
      rmSync(this.root(sessionId), { recursive: true, force: true })
    } catch (err) {
      log.warn('checkpoint cleanup failed', { sessionId, error: String(err) })
    }
  }

  /**
   * 回退预览：找出目标轮及之后所有检查点涉及的文件的「目标轮开始前状态」，
   * 用最后登记的 afterHash 与当前文件哈希比对，检测外部修改。
   */
  preview(session: Session, checkpointId: string): RewindPreview {
    const checkpoint = this.get(session.id, checkpointId)
    if (!checkpoint) throw new Error('这一轮的记录已经过期，换一轮再试。')
    const ascending = this.list(session.id).slice().reverse()
    const targetIndex = ascending.findIndex((item) => item.id === checkpointId)
    if (targetIndex < 0) throw new Error('这一轮的记录已经过期，换一轮再试。')
    const plan = this.buildRestorePlan(ascending, targetIndex)
    const conflicts = this.detectConflicts(session, plan)
    const conflictPaths = new Set(conflicts.map((conflict) => conflict.path))
    const messageIndex = session.messages.findIndex((message) => message.id === checkpoint.messageId)
    return {
      checkpoint,
      files: [...plan].map(([path, entry]) => ({
        path,
        existed: entry.pre.existed,
        conflict: conflictPaths.has(path)
      })),
      conflicts,
      messageFound: messageIndex >= 0,
      fileCount: plan.size,
      removableMessages: messageIndex >= 0 ? session.messages.length - messageIndex : 0
    }
  }

  private buildRestorePlan(ascending: TurnCheckpoint[], targetIndex: number): Map<string, RestorePlanEntry> {
    const plan = new Map<string, RestorePlanEntry>()
    for (const checkpoint of ascending.slice(targetIndex)) {
      for (const file of checkpoint.files) {
        const existing = plan.get(file.path)
        if (!existing) {
          plan.set(file.path, { pre: file, expectedAfter: file.afterHash })
        } else if (file.afterHash) {
          existing.expectedAfter = file.afterHash
        }
      }
    }
    return plan
  }

  private detectConflicts(session: Session, plan: Map<string, RestorePlanEntry>): RewindPreview['conflicts'] {
    const conflicts: RewindPreview['conflicts'] = []
    for (const [path, entry] of plan) {
      const { pre, expectedAfter } = entry
      const inside = this.isAllowedTarget(session, path)
      if (!inside.ok) {
        conflicts.push({ path, reason: inside.reason })
        continue
      }
      if (pre.existed) {
        if (!pre.snapshotPath) {
          conflicts.push({ path, reason: '缺少本轮开始前的文件快照，无法安全恢复。' })
          continue
        }
        if (!this.isAllowedSnapshot(session, pre.snapshotPath)) {
          conflicts.push({ path, reason: '写前快照不属于当前会话，已拒绝恢复。' })
          continue
        }
        if (!existsSync(pre.snapshotPath)) {
          conflicts.push({ path, reason: '写前快照文件已丢失，无法恢复。' })
          continue
        }
        // 快照内容必须仍与登记时的 beforeHash 一致，防止快照被替换/截断后回退出错误内容
        if (pre.beforeHash && sha256File(pre.snapshotPath) !== pre.beforeHash) {
          conflicts.push({ path, reason: '写前快照已损坏或被替换，无法安全恢复。' })
          continue
        }
      }
      const actual = existsSync(path) ? sha256File(path) : null
      if (expectedAfter === null) {
        // 只有「本轮新建、且已经回退删除」的文件会以 null 记录：
        // 若现在又出现了，说明它被外部重建，视为冲突。
        if (actual !== null) conflicts.push({ path, reason: '已回退删除的文件又被外部重新创建。' })
        continue
      }
      if (actual !== expectedAfter) {
        conflicts.push({
          path,
          reason: actual === null ? '文件在检查点之后被删除或移走。' : '文件在检查点之后被外部修改。'
        })
      }
    }
    return conflicts
  }

  private isAllowedTarget(session: Session, path: string): { ok: true } | { ok: false; reason: string } {
    if (!session.workspace) return { ok: false, reason: '会话没有工作区，无法恢复文件。' }
    try {
      const rootReal = realpathSync(session.workspace)
      const target = resolve(path)
      if (!isInside(rootReal, target) && !isInside(session.workspace, target)) {
        return { ok: false, reason: '文件不在当前工作区内，已拒绝恢复。' }
      }
      if (existsSync(target) && !isInside(rootReal, realpathSync(target))) {
        return { ok: false, reason: '文件通过符号链接指向工作区外，已拒绝恢复。' }
      }
      // 目标不存在时，校验最近的已存在父目录仍在工作区（防 junction/符号链接逃逸）
      let probe = dirname(target)
      while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
      if (existsSync(probe) && !isInside(rootReal, realpathSync(probe))) {
        return { ok: false, reason: '目标目录指向工作区外，已拒绝恢复。' }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: `路径校验失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  private isAllowedSnapshot(session: Session, snapshotPath: string): boolean {
    const root = this.snapshotRoot(session.id)
    if (!existsSync(root)) return false
    try {
      const rootReal = realpathSync(root)
      const snapshotReal = realpathSync(snapshotPath)
      return isInside(rootReal, snapshotReal) && statSync(snapshotReal).isFile()
    } catch {
      return false
    }
  }

  /**
   * 执行回退。code 回退在冲突时整体拒绝（不修改任何文件）；
   * conversation 回退要求仍能在当前消息列表里定位到目标用户消息。
   */
  rewind(session: Session, checkpointId: string, scope: RewindScope): RewindResult {
    const checkpoint = this.get(session.id, checkpointId)
    if (!checkpoint) throw new Error('这一轮的记录已经过期，换一轮再试。')
    const ascending = this.list(session.id).slice().reverse()
    const targetIndex = ascending.findIndex((item) => item.id === checkpointId)
    if (targetIndex < 0) throw new Error('这一轮的记录已经过期，换一轮再试。')
    const messageIndex = session.messages.findIndex((message) => message.id === checkpoint.messageId)
    if (scope !== 'code' && messageIndex < 0) {
      throw new Error('这条消息已不在当前对话里（可能已被压缩），请选择「只回退文件」。')
    }

    let restoredFiles = 0
    let removedFiles = 0
    let removedMessages = 0
    const plan = this.buildRestorePlan(ascending, targetIndex)

    if (scope !== 'conversation') {
      const conflicts = this.detectConflicts(session, plan)
      if (conflicts.length > 0) {
        const detail = conflicts
          .slice(0, 5)
          .map((conflict) => `${conflict.path}：${conflict.reason}`)
          .join('；')
        throw new Error(`暂时不能回到这里（${conflicts.length} 个文件有冲突）：${detail}`)
      }
      for (const [path, entry] of plan) {
        if (entry.pre.existed) {
          if (!entry.pre.snapshotPath) throw new Error(`缺少这一轮开始前的文件快照，不能安全恢复：${path}`)
          mkdirSync(dirname(path), { recursive: true })
          const tmp = `${path}.morrow-rewind-${process.pid}.tmp`
          copyFileSync(entry.pre.snapshotPath, tmp)
          renameSync(tmp, path)
          restoredFiles += 1
        } else {
          if (existsSync(path)) {
            if (lstatSync(path).isDirectory()) throw new Error(`这个位置变成了文件夹，已停止回退：${path}`)
            rmSync(path, { force: true })
            removedFiles += 1
          }
        }
      }
    }

    if (scope !== 'code') {
      removedMessages = session.messages.length - messageIndex
      session.messages = session.messages.slice(0, messageIndex)
      session.todos = checkpoint.todos.map((todo) => ({ ...todo }))
      session.artifacts = session.artifacts.filter((artifact) => checkpoint.artifactIds.includes(artifact.id))
      session.plan = checkpoint.plan ? (JSON.parse(JSON.stringify(checkpoint.plan)) as Session['plan']) : null
      session.planMode = session.plan ? checkpoint.planMode === true : false
      this.sessionStore.save(session)
    }

    if (scope === 'code') {
      // 代码已回到目标轮开始前：把目标检查点的 afterHash 改成恢复后的哈希，
      // 删除之后已失效的检查点；目标检查点保留，仍可只回退对话。
      for (const entry of plan.values()) {
        const file = checkpoint.files.find((item) => item.path === entry.pre.path)
        if (file) {
          file.afterHash = entry.pre.existed ? entry.pre.beforeHash : null
          if (entry.pre.existed && entry.pre.snapshotPath) file.snapshotPath = entry.pre.snapshotPath
        }
      }
      this.save(checkpoint)
      for (const later of ascending.slice(targetIndex + 1)) {
        rmSync(this.fileFor(session.id, later.id), { force: true })
      }
    } else {
      for (const removed of ascending.slice(targetIndex)) {
        rmSync(this.fileFor(session.id, removed.id), { force: true })
      }
    }

    log.info('rewind applied', {
      sessionId: session.id,
      checkpointId,
      scope,
      restoredFiles,
      removedFiles,
      removedMessages
    })
    return { checkpointId, scope, restoredFiles, removedFiles, removedMessages }
  }
}

let instance: CheckpointService | null = null
export function getCheckpointService(sessionStore: SessionStore): CheckpointService {
  if (!instance) instance = new CheckpointService(sessionStore)
  return instance
}
