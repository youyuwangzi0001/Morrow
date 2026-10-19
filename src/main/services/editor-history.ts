/**
 * 文件版本历史（R10-F）。
 *
 * 设计目标：
 * - 纯 Node 实现（不 import electron），可在 vitest 中直接用临时目录测试；
 * - 存用户数据目录 `editor-history/<pathKey>/`，`versions.json` 索引 + `<versionId>.txt` 内容；
 * - 每个文件最多保留 30 个版本，全库有总容量上限，超出按时间淘汰最旧版本；
 * - 保存内容完全相同的版本会去重（避免每次 Ctrl+S 都堆一条）；
 * - restore 只允许恢复「曾经记录过历史」的路径，并支持 mtime 冲突检测，避免覆盖外部修改。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createUnifiedDiff, type DiffResult } from '@core/tools/diff'

export const MAX_VERSIONS_PER_FILE = 30
/** 单个版本内容上限：超过则不记录（避免把大文件/二进制塞进历史） */
export const MAX_VERSION_BYTES = 2 * 1024 * 1024
/** 全库容量上限 */
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024

export type HistorySource = 'user' | 'agent' | 'baseline' | 'restore'

export interface HistoryVersion {
  /** 版本 id（也用于内容文件名） */
  id: string
  /** 规范化后的文件路径（展示原始路径） */
  path: string
  /** 用户看到的文件名 */
  name: string
  createdAt: number
  source: HistorySource
  size: number
  /** 内容 sha256（去重/校验用） */
  contentHash: string
  /** 记录时文件 mtime（restore 冲突检测用，可缺省） */
  mtimeMs?: number
  label?: string
}

export interface HistoryRecordInput {
  path: string
  content: string
  source?: HistorySource
  mtimeMs?: number
  label?: string
  /** 即使内容相同也强制记录一条 */
  force?: boolean
}

export interface HistoryRestoreResult {
  path: string
  versionId: string
  mtimeMs: number
  size: number
  /** 恢复动作本身也被记录为新版本（便于再次回退） */
  newVersionId: string | null
}

interface FileIndex {
  /** 原始路径（展示用，不参与 hash） */
  path: string
  name: string
  versions: HistoryVersion[]
}

const HASHED_PATH_SEPARATOR = /\\/g

/** 规范化路径：绝对路径 + Windows 大小写不敏感（hash 用） */
export function canonicalPath(filePath: string): string {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function pathKey(filePath: string): string {
  return createHash('sha256').update(canonicalPath(filePath)).digest('hex').slice(0, 24)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function safeReadJson(file: string): FileIndex | null {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as FileIndex
    if (!parsed || !Array.isArray(parsed.versions)) return null
    return parsed
  } catch {
    return null
  }
}

function safeWriteFile(file: string, content: string): void {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

export interface EditorHistoryOptions {
  maxVersionsPerFile?: number
  maxTotalBytes?: number
  maxVersionBytes?: number
}

export class EditorHistoryStore {
  private readonly root: string
  private readonly maxVersions: number
  private readonly maxTotalBytes: number
  private readonly maxVersionBytes: number

  constructor(rootDir: string, options: EditorHistoryOptions = {}) {
    this.root = resolve(rootDir)
    this.maxVersions = options.maxVersionsPerFile ?? MAX_VERSIONS_PER_FILE
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES
    this.maxVersionBytes = options.maxVersionBytes ?? MAX_VERSION_BYTES
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true })
  }

  private fileDir(filePath: string): string {
    return join(this.root, pathKey(filePath))
  }

  private indexPath(filePath: string): string {
    return join(this.fileDir(filePath), 'versions.json')
  }

  private readIndex(filePath: string): FileIndex {
    const index = safeReadJson(this.indexPath(filePath))
    if (index) return index
    const name = basename(filePath)
    return { path: resolve(filePath), name, versions: [] }
  }

  private writeIndex(filePath: string, index: FileIndex): void {
    safeWriteFile(this.indexPath(filePath), JSON.stringify(index, null, 2))
  }

  /** 记录一个版本；内容过大返回 null，内容与最新版本相同时（非 force）返回已有版本。 */
  record(input: HistoryRecordInput): HistoryVersion | null {
    const filePath = resolve(input.path)
    if (!filePath) throw new Error('缺少文件路径，无法记录版本')
    const content = typeof input.content === 'string' ? input.content : ''
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.maxVersionBytes) return null

    const hash = sha256(content)
    const index = this.readIndex(filePath)
    const latest = index.versions[0]
    if (!input.force && latest && latest.contentHash === hash) return latest

    const createdAt = Date.now()
    const id = `v${createdAt.toString(36)}-${randomBytes(3).toString('hex')}`
    const version: HistoryVersion = {
      id,
      path: index.path,
      name: index.name,
      createdAt,
      source: input.source ?? 'user',
      size: bytes,
      contentHash: hash,
      ...(typeof input.mtimeMs === 'number' ? { mtimeMs: Math.round(input.mtimeMs) } : {}),
      ...(input.label ? { label: input.label } : {})
    }
    safeWriteFile(join(this.fileDir(filePath), `${id}.txt`), content)
    index.versions = [version, ...index.versions].slice(0, this.maxVersions)
    this.writeIndex(filePath, index)
    // 被裁掉的版本清掉内容文件
    const kept = new Set(index.versions.map((item) => item.id))
    for (const stale of readdirSync(this.fileDir(filePath))) {
      if (stale === 'versions.json' || kept.has(stale.replace(/\.txt$/, ''))) continue
      try {
        unlinkSync(join(this.fileDir(filePath), stale))
      } catch {
        // 清理失败不影响主流程
      }
    }
    this.pruneTotal()
    return version
  }

  /** 版本列表（最新在前），不返回内容。 */
  list(filePath: string): { path: string; versions: HistoryVersion[] } {
    const index = this.readIndex(filePath)
    return { path: index.path, versions: index.versions }
  }

  /** 读取某个版本内容；版本不存在返回 null。 */
  read(filePath: string, versionId: string): { version: HistoryVersion; content: string } | null {
    const index = this.readIndex(filePath)
    const version = index.versions.find((item) => item.id === versionId)
    if (!version) return null
    const contentPath = join(this.fileDir(filePath), `${version.id}.txt`)
    if (!existsSync(contentPath)) return null
    return { version, content: readFileSync(contentPath, 'utf8') }
  }

  /**
   * 某个版本与目标文本（通常是编辑器当前内容）或上一个版本的 unified diff。
   * 目标未提供时与更旧一个版本比较；没有更旧版本则与空文本比较。
   */
  diff(filePath: string, versionId: string, targetContent?: string): (DiffResult & { version: HistoryVersion; targetLabel: string }) | null {
    const index = this.readIndex(filePath)
    const versionIndex = index.versions.findIndex((item) => item.id === versionId)
    if (versionIndex < 0) return null
    const current = this.read(filePath, versionId)
    if (!current) return null
    let target = targetContent
    let targetLabel = '当前内容'
    if (typeof target !== 'string') {
      // 选中项不是最新版：与最新版比较（看这个版本之后改了什么）；
      // 选中项本身就是最新版：与上一版比较（看这一版改了什么）。
      const base = versionIndex === 0 ? index.versions[1] : index.versions[0]
      const baseContent = base ? this.read(filePath, base.id) : null
      target = baseContent?.content ?? ''
      targetLabel = base
        ? versionIndex === 0
          ? `上一版本 ${new Date(base.createdAt).toLocaleString('zh-CN')}`
          : `最新版本 ${new Date(base.createdAt).toLocaleString('zh-CN')}`
        : '空文件'
    }
    const result = createUnifiedDiff(current.content, target, basename(filePath))
    return { ...result, version: current.version, targetLabel }
  }

  /**
   * 恢复某个版本内容到磁盘。
   * - 只允许恢复本服务记录过历史的路径（防任意写）；
   * - expectedMtimeMs 与文件当前 mtime 不一致时抛错（外部修改冲突）；
   * - 恢复本身会记录为新版本，方便再次回退。
   */
  restore(filePath: string, versionId: string, options: { expectedMtimeMs?: number; source?: HistorySource } = {}): HistoryRestoreResult {
    const target = resolve(filePath)
    const index = this.readIndex(target)
    const version = index.versions.find((item) => item.id === versionId)
    if (!version) throw new Error('找不到这个历史版本，可能已经被清理')
    const current = this.read(target, versionId)
    if (!current) throw new Error('这个历史版本的内容已丢失，无法恢复')

    if (existsSync(target)) {
      const stat = statSync(target)
      if (stat.isDirectory()) throw new Error('目标是一个文件夹，不能恢复为文件')
      if (typeof options.expectedMtimeMs === 'number') {
        const currentMtime = Math.round(stat.mtimeMs)
        if (Math.abs(currentMtime - Math.round(options.expectedMtimeMs)) > 1) {
          throw new Error('文件在版本恢复前被外部修改过，请先重新加载再恢复')
        }
      }
    } else {
      if (!existsSync(dirname(target))) throw new Error('目标文件所在文件夹不存在')
    }

    const content = current.content
    const fileDir = dirname(target)
    if (!existsSync(fileDir)) mkdirSync(fileDir, { recursive: true })
    const tmp = join(fileDir, `.${basename(target)}.morrow-restore-${process.pid}.tmp`)
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, target)
    const nextStat = statSync(target)
    const recorded = this.record({
      path: target,
      content,
      source: options.source ?? 'restore',
      mtimeMs: nextStat.mtimeMs,
      label: `恢复 ${version.id}`,
      // 即使内容与已有版本相同，也记录一条「恢复」动作，便于审计与再次回退
      force: true
    })
    return {
      path: target,
      versionId,
      mtimeMs: Math.round(nextStat.mtimeMs),
      size: nextStat.size,
      newVersionId: recorded?.id ?? null
    }
  }

  /** 清空某个文件的全部历史（UI 未使用，供维护/测试） */
  clear(filePath: string): void {
    const dir = this.fileDir(filePath)
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        // ignore
      }
    }
  }

  /** 统计（测试/调试用） */
  stats(): { files: number; versions: number; bytes: number } {
    let files = 0
    let versions = 0
    let bytes = 0
    for (const dirName of readdirSync(this.root)) {
      const dir = join(this.root, dirName)
      if (!statSync(dir).isDirectory()) continue
      const index = safeReadJson(join(dir, 'versions.json'))
      if (!index) continue
      files += 1
      versions += index.versions.length
      for (const version of index.versions) bytes += version.size
    }
    return { files, versions, bytes }
  }

  /** 全库容量上限：按版本时间从旧到新删除，直到低于上限。 */
  private pruneTotal(): void {
    const entries: Array<{ file: string; dir: string; version: HistoryVersion }> = []
    for (const dirName of readdirSync(this.root)) {
      const dir = join(this.root, dirName)
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
      const index = safeReadJson(join(dir, 'versions.json'))
      if (!index || index.versions.length === 0) continue
      for (const version of index.versions) entries.push({ file: this.indexForDir(dir), dir, version })
    }
    let total = entries.reduce((sum, entry) => sum + entry.version.size, 0)
    if (total <= this.maxTotalBytes) return
    entries.sort((a, b) => a.version.createdAt - b.version.createdAt)
    const touched = new Set<string>()
    for (const entry of entries) {
      if (total <= this.maxTotalBytes) break
      if (touched.has(entry.file)) continue
      touched.add(entry.file)
      // 每个文件至少保留最新一版
      const index = safeReadJson(entry.file)
      if (!index || index.versions.length <= 1) continue
      const dropIds = new Set<string>()
      let fileBytes = index.versions.reduce((sum, item) => sum + item.size, 0)
      const sorted = [...index.versions].sort((a, b) => a.createdAt - b.createdAt)
      for (const candidate of sorted) {
        if (total <= this.maxTotalBytes) break
        if (index.versions.length - dropIds.size <= 1) break
        dropIds.add(candidate.id)
        total -= candidate.size
        fileBytes -= candidate.size
        try {
          unlinkSync(join(entry.dir, `${candidate.id}.txt`))
        } catch {
          // ignore
        }
      }
      index.versions = index.versions.filter((item) => !dropIds.has(item.id))
      safeWriteFile(entry.file, JSON.stringify(index, null, 2))
      void fileBytes
    }
  }

  /** pruneTotal 里用于反查索引路径（保留字段以便未来扩展） */
  private indexForDir(dir: string): string {
    return join(dir, 'versions.json')
  }
}

export const __testing = { canonicalPath, pathKey, sha256, HASHED_PATH_SEPARATOR, sep }
