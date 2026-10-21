/**
 * 大文件快照：完整备份 + 流式哈希，不把整文件读入内存；append 后也不做全文件 diff。
 */
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeTool } from '../../../src/core/tools/registry'
import { recordRestoreManifest, snapshotFile } from '../../../src/core/tools/fs-tools'
import { sha256 } from '../../../src/core/util'
import { restoreSnapshotSafely } from '../../../src/main/services/snapshot-restore'
import { makeToolContext } from './helpers/tool-context'
import { makeTempWorkspace } from './helpers/workspace'

const LARGE_BYTES = 2 * 1024 * 1024 + 128

describe('大文件快照', () => {
  it('超过文本阈值的文件仍完整备份并计算哈希，但不在快照信息里保留全文', () => {
    const ws = makeTempWorkspace()
    try {
      const file = join(ws.root, 'large.log')
      const content = Buffer.alloc(LARGE_BYTES, 'a')
      writeFileSync(file, content)
      const snapshot = snapshotFile(file, makeToolContext(ws))
      expect(snapshot).not.toBeNull()
      expect(snapshot?.beforeHash).toBe(sha256(content))
      expect(snapshot?.beforeText).toBeNull()
      expect(readFileSync(snapshot!.snapshotPath)).toEqual(content)
    } finally {
      ws.cleanup()
    }
  })

  it.skipIf(process.platform === 'win32')('原子覆盖保留可执行权限', async () => {
    const ws = makeTempWorkspace()
    try {
      const file = join(ws.root, 'run.sh')
      writeFileSync(file, '#!/bin/sh\necho old\n', 'utf8')
      chmodSync(file, 0o755)
      const result = await executeTool('write_file', { path: 'run.sh', content: '#!/bin/sh\necho new\n' }, makeToolContext(ws))
      expect(result.ok).toBe(true)
      expect(statSync(file).mode & 0o777).toBe(0o755)
      expect(readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho new\n')
    } finally {
      ws.cleanup()
    }
  })

  it('keeps snapshots inside the session when tool id contains traversal', () => {
    const ws = makeTempWorkspace()
    try {
      const file = join(ws.root, 'notes.md')
      writeFileSync(file, 'content\n', 'utf8')
      const ctx = makeToolContext(ws, { toolUseId: '..\\..\\evil' })
      const snapshot = snapshotFile(file, ctx)
      expect(snapshot).not.toBeNull()
      expect(snapshot!.snapshotPath.startsWith(ws.snapshotDir)).toBe(true)
      const relative = snapshot!.snapshotPath.slice(ws.snapshotDir.length)
      expect(relative).not.toContain('..')
      recordRestoreManifest(ctx, file, snapshot!.beforeHash, 'a'.repeat(64))
      expect(readFileSync(snapshot!.snapshotPath, 'utf8')).toBe('content\n')
    } finally {
      ws.cleanup()
    }
  })

  it('does not let a target named .restore.json overwrite the undo manifest', () => {
    const ws = makeTempWorkspace()
    try {
      const file = join(ws.root, '.restore.json')
      writeFileSync(file, '{"user":true}\n', 'utf8')
      const ctx = makeToolContext(ws, { toolUseId: 'call_manifest' })
      const snapshot = snapshotFile(file, ctx)
      expect(snapshot).not.toBeNull()
      expect(snapshot!.snapshotPath).not.toBe(join(ws.snapshotDir, 'call_manifest', '.restore.json'))
      recordRestoreManifest(ctx, file, snapshot!.beforeHash, 'b'.repeat(64))
      expect(readFileSync(snapshot!.snapshotPath, 'utf8')).toBe('{"user":true}\n')
    } finally {
      ws.cleanup()
    }
  })

  it('append 大文件：不生成全文件 diff、行数标为未知，撤销仍能恢复原文', async () => {
    const ws = makeTempWorkspace()
    try {
      const file = join(ws.root, 'large.log')
      const original = Buffer.alloc(LARGE_BYTES, 'a')
      writeFileSync(file, original)
      const result = await executeTool('write_file', { path: 'large.log', content: '\nEND', append: true }, makeToolContext(ws))
      expect(result.ok).toBe(true)
      expect(result.meta?.lines).toBeNull()
      expect(result.meta?.diff).toBe('')
      expect(String(result.output)).toContain('文件较大，行数未统计')
      expect(readFileSync(file).subarray(-4).toString('utf8')).toBe('\nEND')

      const snapshotPath = String(result.meta?.snapshotPath ?? '')
      expect(snapshotPath).not.toBe('')
      const restored = restoreSnapshotSafely({
        snapshotRoot: ws.snapshotDir,
        snapshotPath,
        targetPath: file,
        workspace: ws.root
      })
      expect(restored.ok).toBe(true)
      expect(sha256(readFileSync(file))).toBe(sha256(original))
    } finally {
      ws.cleanup()
    }
  })
})
