/**
 * 测试辅助：临时工作区 / 快照目录。
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface TempWorkspace {
  root: string
  snapshotDir: string
  cleanup: () => void
}

export function makeTempDir(prefix = 'morrow-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 在 root 下按相对路径写文件（自动建父目录） */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
}

export function makeTempWorkspace(files: Record<string, string> = {}): TempWorkspace {
  const root = makeTempDir('morrow-ws-')
  const snapshotDir = makeTempDir('morrow-snap-')
  writeFiles(root, files)
  return {
    root,
    snapshotDir,
    cleanup: () => {
      // Windows 上刚退出的 ConPTY 宿主可能短暂占用工作目录
      rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 })
      rmSync(snapshotDir, { recursive: true, force: true })
    }
  }
}

/** 复制一份 assets/demo-workspace 到临时目录（避免演示测试改动源资产） */
export function copyDemoWorkspace(source: string): TempWorkspace {
  const root = makeTempDir('morrow-demo-')
  const snapshotDir = makeTempDir('morrow-demo-snap-')
  cpSync(source, root, { recursive: true })
  return {
    root,
    snapshotDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 })
      rmSync(snapshotDir, { recursive: true, force: true })
    }
  }
}
