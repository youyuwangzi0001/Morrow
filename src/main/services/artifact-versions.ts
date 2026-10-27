// 成品版本历史：每次成品内容变化时保存一份文本快照。
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import type { Artifact, ArtifactVersionInfo, ArtifactVersionSource } from '../../shared/types'

const MAX_VERSIONS = 30
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,120}$/
const SAFE_VERSION_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/

const EXT: Record<string, string> = {
  html: '.html',
  markdown: '.md',
  svg: '.svg',
  text: '.txt',
  code: '.txt'
}

interface StoredVersion extends ArtifactVersionInfo {
  /** 快照文件（相对当前成品目录） */
  file: string
}

interface VersionIndex {
  version: 1
  artifactId: string
  versions: StoredVersion[]
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function safeSegment(value: string): string {
  if (SAFE_SEGMENT.test(value)) return value
  return `v_${createHash('sha1').update(value).digest('hex').slice(0, 16)}`
}

function artifactText(artifact: Artifact): string | null {
  // 文件型成品可能是图片/PDF/Office，按 UTF-8 读取会破坏内容，因此不做快照。
  if (artifact.kind === 'file') return null
  if (typeof artifact.content === 'string') return artifact.content
  if (!artifact.path) return null
  try {
    const stat = statSync(artifact.path)
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null
    return readFileSync(artifact.path, 'utf8')
  } catch {
    return null
  }
}

function atomicWrite(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content, { mode: 0o600 })
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
    }
    throw err
  }
  // Windows 上杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      renameSync(tmp, path)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        try {
          rmSync(tmp, { force: true })
        } catch {
        }
        throw err
      }
      if (attempt === 3) {
        try {
          writeFileSync(path, content, { mode: 0o600 })
          rmSync(tmp, { force: true })
          return
        } catch (writeErr) {
          try {
            rmSync(tmp, { force: true })
          } catch {
          }
          throw writeErr
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
    }
  }
}

function publicInfo(stored: StoredVersion): ArtifactVersionInfo {
  const { file: _file, ...info } = stored
  return info
}

export interface ArtifactVersionStoreOptions {
  /** 数据目录（会写到 <dir>/<sessionId>/<artifactId>/） */
  dir: string
  now?: () => number
}

export class ArtifactVersionStore {
  private readonly dir: string
  private readonly now: () => number

  constructor(options: ArtifactVersionStoreOptions) {
    if (!options?.dir) throw new Error('ArtifactVersionStore 需要数据目录')
    this.dir = resolve(options.dir)
    this.now = options.now ?? (() => Date.now())
  }

  private artifactDir(sessionId: string, artifactId: string): string {
    return join(this.dir, safeSegment(sessionId), safeSegment(artifactId))
  }

  private indexPath(sessionId: string, artifactId: string): string {
    return join(this.artifactDir(sessionId, artifactId), 'versions.json')
  }

  private readIndex(sessionId: string, artifactId: string): VersionIndex {
    const path = this.indexPath(sessionId, artifactId)
    if (!existsSync(path)) return { version: 1, artifactId, versions: [] }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as VersionIndex
      if (raw?.version !== 1 || !Array.isArray(raw.versions)) return { version: 1, artifactId, versions: [] }
      return {
        version: 1,
        artifactId,
        versions: raw.versions.filter(
          (item) =>
            item &&
            typeof item.id === 'string' &&
            typeof item.file === 'string' &&
            SAFE_VERSION_FILE.test(item.file) &&
            !item.file.includes('..')
        )
      }
    } catch {
      return { version: 1, artifactId, versions: [] }
    }
  }

  private writeIndex(sessionId: string, artifactId: string, index: VersionIndex): void {
    atomicWrite(this.indexPath(sessionId, artifactId), JSON.stringify(index, null, 2))
  }

  /** 记录一份快照；内容未变化时返回当前最新版本，不重复落盘。 */
  record(sessionId: string, artifact: Artifact, source?: ArtifactVersionSource): ArtifactVersionInfo | null {
    const text = artifactText(artifact)
    if (text === null) return null
    if (Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_BYTES) return null
    const hash = sha256(text)
    const index = this.readIndex(sessionId, artifact.id)
    const latest = index.versions[index.versions.length - 1]
    if (latest && latest.hash === hash) return publicInfo(latest)

    const directory = this.artifactDir(sessionId, artifact.id)
    mkdirSync(directory, { recursive: true })
    const id = `ver_${this.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const file = `${id}${EXT[artifact.kind] ?? '.txt'}`
    atomicWrite(join(directory, file), text)
    const info: StoredVersion = {
      id,
      artifactId: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      ...(artifact.language ? { language: artifact.language } : {}),
      createdAt: this.now(),
      source: source ?? (index.versions.length > 0 ? 'agent' : 'baseline'),
      size: Buffer.byteLength(text, 'utf8'),
      hash,
      restorable: true,
      file
    }
    index.versions.push(info)
    while (index.versions.length > MAX_VERSIONS) {
      const removed = index.versions.shift()
      if (removed) {
        try {
          rmSync(join(directory, removed.file), { force: true })
        } catch {
        }
      }
    }
    this.writeIndex(sessionId, artifact.id, index)
    return publicInfo(info)
  }

  /** Agent 一轮结束后批量同步；只记录真正变化的成品。 */
  syncArtifacts(sessionId: string, artifacts: Artifact[]): void {
    for (const artifact of artifacts) {
      try {
        this.record(sessionId, artifact, 'agent')
      } catch {
        // 单个成品版本失败不影响其他成品
      }
    }
  }

  list(sessionId: string, artifactId: string): ArtifactVersionInfo[] {
    return this.readIndex(sessionId, artifactId)
      .versions.slice()
      .reverse()
      .map(publicInfo)
  }

  read(sessionId: string, artifactId: string, versionId: string): { version: ArtifactVersionInfo; content: string } | null {
    const index = this.readIndex(sessionId, artifactId)
    const version = index.versions.find((item) => item.id === versionId)
    if (!version || !SAFE_VERSION_FILE.test(version.file) || version.file.includes('..')) return null
    try {
      const content = readFileSync(join(this.artifactDir(sessionId, artifactId), version.file), 'utf8')
      return { version: publicInfo(version), content }
    } catch {
      return null
    }
  }

  removeSession(sessionId: string): void {
    try {
      rmSync(join(this.dir, safeSegment(sessionId)), { recursive: true, force: true })
    } catch {
    }
  }

  /** 仅用于测试/诊断：成品版本目录。 */
  directoryFor(sessionId: string, artifactId: string): string {
    return this.artifactDir(sessionId, artifactId)
  }
}
