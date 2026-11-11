import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, makeTempWorkspace } from './helpers'
import { WorkspaceIsolationService, canonicalWorkspacePath } from '../../src/main/workspace-isolation'
import { detectCommandPorts } from '../../src/core/collaboration'
import { SharedResourceManager } from '../../src/main/collaboration'
import { runAgent } from '../../src/core/agent'
import { ScriptedProvider } from './helpers'
import type { CollaborationConflict, ModelInfo } from '../../src/shared/types'
import type { SharedResourceLease } from '../../src/core/types'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 10_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

function conflictRecord(
  mergeConflict: Awaited<ReturnType<WorkspaceIsolationService['merge']>>['conflicts'][number],
  projectId: string,
  taskId: string
): CollaborationConflict {
  return {
    id: 'conflict_test_1',
    projectId,
    taskId,
    path: mergeConflict.path,
    currentPath: mergeConflict.currentPath,
    incomingPath: mergeConflict.incomingPath,
    ...(mergeConflict.basePath ? { basePath: mergeConflict.basePath } : {}),
    ...(mergeConflict.baseHash ? { baseHash: mergeConflict.baseHash } : {}),
    ...(mergeConflict.currentHash ? { currentHash: mergeConflict.currentHash } : {}),
    incomingHash: mergeConflict.incomingHash,
    reason: mergeConflict.reason,
    ...(mergeConflict.currentPreview ? { currentPreview: mergeConflict.currentPreview } : {}),
    ...(mergeConflict.incomingPreview ? { incomingPreview: mergeConflict.incomingPreview } : {}),
    status: 'open',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

describe('shared-resources-tool.test.ts', () => {
  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 64_000, supportsTools: true }

  function holder(resource: string, kind: 'desktop' | 'port'): SharedResourceLease {
    return {
      id: 'lease_holder',
      kind,
      resource,
      owner: { ownerId: 'task:s_shared:task_b', sessionId: 's_shared', label: '任务 B' },
      acquiredAt: 1,
      expiresAt: Date.now() + 60_000
    }
  }

  async function runWithTool(
    toolName: string,
    input: Record<string, unknown>,
    resource: string,
    kind: 'desktop' | 'port'
  ): Promise<{ error: string; executed: boolean }> {
    const ws = makeTempWorkspace()
    let executed = false
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: toolName, input }] },
      { text: '结束。' }
    ])
    const baseAcquire = async () => ({ ok: true as const, lease: holder(resource, kind) })
    try {
      const result = await runAgent({
        runId: 'run_shared',
        sessionId: 'session_shared',
        provider,
        model: MODEL,
        systemPrompt: '你是测试助手。',
        history: [],
        userMessage: { id: 'u-shared', role: 'user', content: [{ type: 'text', text: '测试共享资源' }], createdAt: Date.now() },
        workspace: ws.root,
        permissionMode: 'auto',
        snapshotDir: ws.snapshotDir,
        signal: new AbortController().signal,
        emit: () => undefined,
        onPermission: async () => 'once',
        onAskUser: async () => ({ value: 'A', label: 'A' }),
        maxSteps: 6,
        sharedResources: {
          acquire: async (request) => {
            if (request.resource === resource) {
              return { ok: false as const, holder: holder(resource, kind), reason: '已被「任务 B」占用' }
            }
            return baseAcquire()
          },
          releaseOwner: () => undefined
        }
      })
      const block = result.messages
        .flatMap((message) => message.content)
        .find((entry) => entry.type === 'tool_use' && entry.name === toolName)
      if (block?.type === 'tool_use' && block.result?.ok === true) executed = true
      return { error: block?.type === 'tool_use' ? (block.result?.error ?? '') : '', executed }
    } finally {
      ws.cleanup()
    }
  }

  it('@core:workspace 桌面被另一个任务占用时，电脑操作不执行并说明占用者', async () => {
    const { error, executed } = await runWithTool(
      'computer_screenshot',
      { scope: 'screen' },
      'desktop',
      'desktop'
    )
    expect(executed).toBe(false)
    expect(error).toContain('桌面正被')
    expect(error).toContain('任务 B')
  })

  it('@core:workspace 端口被另一个任务占用时，命令在启动前被拒绝', async () => {
    const { error, executed } = await runWithTool(
      'run_command',
      { command: 'node --version --port 3000' },
      'port:3000',
      'port'
    )
    expect(executed).toBe(false)
    expect(error).toContain('端口 3000')
    expect(error).toContain('任务 B')
  })
})

describe('workspace-isolation.test.ts', () => {
  it('@core:workspace 两个成员改同一行：主文件不静默覆盖，两份改动都保留并可选择', async () => {
    const dataDir = makeTempDir('morrow-isolation-')
    const ws = makeTempWorkspace({ 'src/math.ts': 'export const value = 1\n' })
    const projectId = 'project_iso00000001'
    try {
      const service = new WorkspaceIsolationService(dataDir)
      const copyA = await service.prepare({
        workspace: ws.root,
        projectId,
        sessionId: 's_iso',
        taskId: 'task_iso_a',
        attemptId: 'attempt_a_a1',
        label: '成员 A'
      })
      const copyB = await service.prepare({
        workspace: ws.root,
        projectId,
        sessionId: 's_iso',
        taskId: 'task_iso_b',
        attemptId: 'attempt_b_a1',
        label: '成员 B'
      })
      expect(copyA.path).not.toBe(copyB.path)
      // 同一份工作区内容只落一份基线：两个成员共用，不各复制一整份仓
      expect(copyA.basePath).toBe(copyB.basePath)
      expect(readFileSync(join(copyA.path, 'src/math.ts'), 'utf8')).toContain('value = 1')
      expect(readFileSync(join(copyB.path, 'src/math.ts'), 'utf8')).toContain('value = 1')

      writeFileSync(join(copyA.path, 'src/math.ts'), 'export const value = 2\n')
      writeFileSync(join(copyB.path, 'src/math.ts'), 'export const value = 3\n')

      const mergeA = await service.merge({
        copy: copyA,
        projectId,
        taskId: 'task_iso_a',
        attemptId: 'attempt_a_a1',
        label: '成员 A'
      })
      expect(mergeA.conflicts).toHaveLength(0)
      expect(mergeA.applied[0]).toMatchObject({ path: 'src/math.ts', action: 'modified' })
      const afterA = readFileSync(join(ws.root, 'src/math.ts'), 'utf8')
      expect(afterA).toContain('value = 2')

      const mergeB = await service.merge({
        copy: copyB,
        projectId,
        taskId: 'task_iso_b',
        attemptId: 'attempt_b_a1',
        label: '成员 B'
      })
      expect(mergeB.conflicts).toHaveLength(1)
      const conflict = mergeB.conflicts[0]
      expect(conflict).toMatchObject({ path: 'src/math.ts', reason: 'content' })
      expect(conflict.currentPreview).toContain('value = 2')
      expect(conflict.incomingPreview).toContain('value = 3')
      // 冲突期间主文件保持 A 的版本，不被 B 静默覆盖
      expect(readFileSync(join(ws.root, 'src/math.ts'), 'utf8')).toBe(afterA)
      expect(readFileSync(conflict.incomingPath, 'utf8')).toContain('value = 3')

      // 冲突后用户又改主文件：采用成员版本必须拒绝，不能覆盖用户的新改动
      writeFileSync(join(ws.root, 'src/math.ts'), 'export const value = 2 // 用户新改动\n')
      const blocked = await service.resolveConflict(conflictRecord(conflict, projectId, 'task_iso_b'), 'incoming')
      expect(blocked.ok).toBe(false)
      expect(blocked.error).toContain('又发生了变化')
      expect(readFileSync(join(ws.root, 'src/math.ts'), 'utf8')).toContain('用户新改动')

      // 恢复成冲突时的主版本后，用户选择采用成员版本
      writeFileSync(join(ws.root, 'src/math.ts'), afterA)
      const resolved = await service.resolveConflict(conflictRecord(conflict, projectId, 'task_iso_b'), 'incoming')
      expect(resolved.ok).toBe(true)
      expect(readFileSync(join(ws.root, 'src/math.ts'), 'utf8')).toContain('value = 3')

      // 选择保留主版本时不改动文件
      const mergeAgain = await service.merge({
        copy: copyB,
        projectId,
        taskId: 'task_iso_b',
        attemptId: 'attempt_b_a1',
        label: '成员 B'
      })
      expect(mergeAgain.conflicts).toHaveLength(0)
      expect(readFileSync(join(ws.root, 'src/math.ts'), 'utf8')).toContain('value = 3')

      // 基线与副本记录保留，可供负责人核对起始版本与改动清单
      expect(existsSync(copyA.basePath)).toBe(true)
      expect(existsSync(join(dataDir, 'collaboration', 'workspaces', projectId, 'records', `${copyA.copyId}.json`))).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      ws.cleanup()
    }
  })

  it('@core:workspace 合并保留用户未提交修改；不同路径写法在 Windows 上规范为同一文件', async () => {
    const dataDir = makeTempDir('morrow-isolation-')
    const ws = makeTempWorkspace({
      'src/math.ts': 'line 1\nline 2\n',
      'notes/user.txt': '用户未提交的内容\n'
    })
    const projectId = 'project_iso00000002'
    try {
      const service = new WorkspaceIsolationService(dataDir)
      const copy = await service.prepare({
        workspace: ws.root,
        projectId,
        sessionId: 's_iso',
        taskId: 'task_iso_user',
        attemptId: 'attempt_user_a1',
        label: '成员'
      })
      expect(readFileSync(join(copy.path, 'notes/user.txt'), 'utf8')).toContain('用户未提交')
      writeFileSync(join(copy.path, 'src/math.ts'), 'line 1\nline 2 changed\n')
      const merge = await service.merge({
        copy,
        projectId,
        taskId: 'task_iso_user',
        attemptId: 'attempt_user_a1',
        label: '成员'
      })
      expect(merge.conflicts).toHaveLength(0)
      expect(readFileSync(join(ws.root, 'notes/user.txt'), 'utf8')).toContain('用户未提交')
      expect(readFileSync(join(ws.root, 'src/math.ts'), 'utf8')).toContain('line 2 changed')
      if (process.platform === 'win32') {
        expect(canonicalWorkspacePath('src\\Math.ts')).toBe(canonicalWorkspacePath('SRC/math.ts'))
      } else {
        expect(canonicalWorkspacePath('src/Math.ts')).not.toBe(canonicalWorkspacePath('src/math.ts'))
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      ws.cleanup()
    }
  })

  it('@core:workspace 工作区副本跳过交付/缓存目录，并可配置安全上限', async () => {
    const dataDir = makeTempDir('morrow-isolation-')
    const ws = makeTempWorkspace({
      'src/app.ts': 'export const ready = true\n',
      'deliver/installer.exe': 'binary',
      'tmp/cache.bin': 'cache',
      'node_modules/pkg/index.js': 'module',
      '.qoder/internal/backup.bin': 'backup'
    })
    const projectId = 'project_iso00000004'
    try {
      const service = new WorkspaceIsolationService(dataDir)
      const copy = await service.prepare({
        workspace: ws.root,
        projectId,
        sessionId: 's_iso',
        taskId: 'task_iso_skip',
        attemptId: 'attempt_skip_a1',
        label: '清理成员'
      })
      expect(copy.fileCount).toBe(1)
      expect(readFileSync(join(copy.path, 'src/app.ts'), 'utf8')).toContain('ready')
      expect(existsSync(join(copy.path, '.qoder'))).toBe(false)
      expect(existsSync(join(copy.path, 'node_modules/pkg/index.js'))).toBe(true)
      expect(existsSync(join(copy.path, 'deliver/installer.exe'))).toBe(true)
      await service.discard(copy)

      const limited = new WorkspaceIsolationService(dataDir, { maxFiles: 0, maxBytes: 1024 })
      // 超限在扫描阶段就拒绝：不落任何目录，比复制到一半再失败更省磁盘
      await expect(
        limited.prepare({
          workspace: ws.root,
          projectId,
          sessionId: 's_iso',
          taskId: 'task_iso_limit',
          attemptId: 'attempt_limit_a1',
          label: '受限成员'
        })
      ).rejects.toThrow(/工作区文件超过 0 个|安全副本上限/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      ws.cleanup()
    }
  })

  it('@core:workspace Git 仓库使用独立 worktree，并带上当前未提交修改', async () => {
    if (!hasGit()) return
    const dataDir = makeTempDir('morrow-isolation-')
    const ws = makeTempWorkspace({ 'file.txt': 'base\n' })
    const projectId = 'project_iso00000003'
    try {
      execFileSync('git', ['init'], { cwd: ws.root, stdio: 'ignore', timeout: 20_000, windowsHide: true })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws.root, stdio: 'ignore', timeout: 20_000, windowsHide: true })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ws.root, stdio: 'ignore', timeout: 20_000, windowsHide: true })
      execFileSync('git', ['add', 'file.txt'], { cwd: ws.root, stdio: 'ignore', timeout: 20_000, windowsHide: true })
      execFileSync('git', ['commit', '-m', 'base'], { cwd: ws.root, stdio: 'ignore', timeout: 20_000, windowsHide: true })
      writeFileSync(join(ws.root, 'file.txt'), 'base + 用户未提交修改\n')

      const service = new WorkspaceIsolationService(dataDir)
      const copy = await service.prepare({
        workspace: ws.root,
        projectId,
        sessionId: 's_iso',
        taskId: 'task_iso_git',
        attemptId: 'attempt_git_a1',
        label: 'Git 成员'
      })
      expect(copy.mode).toBe('git-worktree')
      expect(copy.baseVersion).toMatch(/^git:/)
      expect(existsSync(join(copy.path, '.git'))).toBe(true)
      expect(readFileSync(join(copy.path, 'file.txt'), 'utf8')).toContain('用户未提交修改')
      const status = execFileSync('git', ['-C', copy.path, 'status', '--porcelain'], {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true
      })
      expect(status).toContain('file.txt')

      await service.discard(copy)
      expect(existsSync(copy.path)).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      ws.cleanup()
    }
  })

  it('@core:workspace 并行成员共用同一基线，释放后基线随之回收', async () => {
    const dataDir = makeTempDir('morrow-isolation-')
    const ws = makeTempWorkspace({ 'src/app.ts': 'export const ready = true\n' })
    const projectId = 'project_iso00000005'
    try {
      const service = new WorkspaceIsolationService(dataDir)
      const base = {
        workspace: ws.root,
        projectId,
        sessionId: 's_iso',
        attemptId: 'attempt_share_a1',
        label: '并行成员'
      }
      const copies = await Promise.all([
        service.prepare({ ...base, taskId: 'task_share_a' }),
        service.prepare({ ...base, taskId: 'task_share_b' }),
        service.prepare({ ...base, taskId: 'task_share_c' })
      ])
      // 3 个成员本应只有 1 份基线：内容相同就不再整仓复制
      const basePaths = new Set(copies.map((copy) => copy.basePath))
      expect(basePaths.size).toBe(1)
      expect(new Set(copies.map((copy) => copy.path)).size).toBe(3)
      const sharedBase = copies[0].basePath
      expect(existsSync(sharedBase)).toBe(true)
      // 每个成员仍然拿到完整、可独立写入的内容
      for (const copy of copies) {
        expect(readFileSync(join(copy.path, 'src/app.ts'), 'utf8')).toContain('ready')
      }

      // 前两个释放时基线仍在（还有人用），最后一个释放才真正删掉
      await service.discard(copies[0])
      expect(existsSync(copies[0].path)).toBe(false)
      expect(existsSync(sharedBase)).toBe(true)
      await service.discard(copies[1])
      expect(existsSync(sharedBase)).toBe(true)
      await service.discard(copies[2])
      expect(existsSync(sharedBase)).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      ws.cleanup()
    }
  })

  it('@core:workspace 回收孤儿副本与超期基线，保留仍在使用的副本', async () => {
    const dataDir = makeTempDir('morrow-isolation-')
    const ws = makeTempWorkspace({ 'src/app.ts': 'export const ready = true\n' })
    const projectId = 'project_iso00000006'
    try {
      const service = new WorkspaceIsolationService(dataDir)
      const projectRoot = join(dataDir, 'collaboration', 'workspaces', projectId)
      const live = await service.prepare({
        workspace: ws.root,
        projectId,
        sessionId: 's_iso',
        taskId: 'task_prune_live',
        attemptId: 'attempt_prune_a1',
        label: '仍在运行'
      })
      // 模拟强退留下的无记录目录，以及复制中断的暂存目录
      const orphanCopy = join(projectRoot, 'copies', 'orphan_copy')
      mkdirSync(orphanCopy, { recursive: true })
      writeFileSync(join(orphanCopy, 'left-behind.txt'), 'x'.repeat(2048))
      const staging = join(projectRoot, 'bases', '.tmp-interrupted')
      mkdirSync(staging, { recursive: true })
      writeFileSync(join(staging, 'partial.bin'), 'y'.repeat(1024))

      // 暂存目录要过 TTL 才清，先按未来的时间点回收
      const later = Date.now() + 2 * 60 * 60 * 1000
      const result = await service.prune(projectId, { now: later, activeCopyIds: [live.copyId] })
      expect(result.removedCopies).toContain('orphan_copy')
      expect(result.removedBases).toContain('.tmp-interrupted')
      expect(existsSync(orphanCopy)).toBe(false)
      expect(existsSync(staging)).toBe(false)
      // 运行中的副本与它依赖的基线都不能被动
      expect(existsSync(live.path)).toBe(true)
      expect(existsSync(live.basePath)).toBe(true)

      // 释放后记录标记 releasedAt，目录删除；记录保留供冲突追溯
      await service.discard(live)
      expect(existsSync(live.path)).toBe(false)
      const record = JSON.parse(readFileSync(join(projectRoot, 'records', `${live.copyId}.json`), 'utf8'))
      expect(record.releasedAt).toBeGreaterThan(0)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      ws.cleanup()
    }
  })

  it('@core:workspace 回收不会删除冲突未处理的副本，超期后才回收失败任务', async () => {
    const dataDir = makeTempDir('morrow-isolation-')
    const ws = makeTempWorkspace({ 'note.txt': 'base line\n' })
    const projectId = 'project_iso00000008'
    try {
      const service = new WorkspaceIsolationService(dataDir)
      const request = { workspace: ws.root, projectId, sessionId: 's_iso', attemptId: 'attempt_c_a1', label: '成员' }
      const conflicted = await service.prepare({ ...request, taskId: 'task_conflict_x' })
      const failed = await service.prepare({ ...request, taskId: 'task_failed_xx' })
      // 制造一次未解决冲突：两份都改了同一行
      writeFileSync(join(conflicted.path, 'note.txt'), 'mine\n')
      writeFileSync(join(ws.root, 'note.txt'), 'theirs\n')
      const merge = await service.merge({
        copy: conflicted,
        projectId,
        taskId: 'task_conflict_x',
        attemptId: 'attempt_c_a1',
        label: '成员'
      })
      expect(merge.conflicts).toHaveLength(1)

      // 超过保留期回收：冲突副本必须保留，失败任务的副本可以回收
      const later = Date.now() + 30 * 24 * 60 * 60 * 1000
      await service.prune(projectId, { now: later })
      expect(existsSync(conflicted.path)).toBe(true)
      expect(existsSync(join(conflicted.path, 'note.txt'))).toBe(true)
      expect(existsSync(failed.path)).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      ws.cleanup()
    }
  })

  it('@core:workspace 工作区内容变化后才需要新建基线', async () => {    const dataDir = makeTempDir('morrow-isolation-')
    const ws = makeTempWorkspace({ 'src/app.ts': 'export const ready = true\n' })
    const projectId = 'project_iso00000007'
    try {
      const service = new WorkspaceIsolationService(dataDir)
      const request = {
        workspace: ws.root,
        projectId,
        sessionId: 's_iso',
        attemptId: 'attempt_skip_a1',
        label: '成员'
      }
      const first = await service.prepare({ ...request, taskId: 'task_base_1' })
      const second = await service.prepare({ ...request, taskId: 'task_base_2' })
      expect(second.basePath).toBe(first.basePath)
      await service.discard(first)
      await service.discard(second)

      // 工作区变了，基线指纹变化，必须重新落一份
      writeFileSync(join(ws.root, 'src/app.ts'), 'export const ready = false\n')
      const third = await service.prepare({ ...request, taskId: 'task_base_3' })
      expect(third.basePath).not.toBe(first.basePath)
      expect(readFileSync(join(third.path, 'src/app.ts'), 'utf8')).toContain('ready = false')
      await service.discard(third)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      ws.cleanup()
    }
  })
})

describe('shared-resources.test.ts', () => {
  it('@core:workspace 桌面与端口一次只归一个任务，释放后可再占用并留下记录', async () => {
    const dataDir = makeTempDir('morrow-resources-')
    try {
      const manager = new SharedResourceManager(dataDir)
      const taskA = { ownerId: 'task:s_res:task_a', sessionId: 's_res', taskId: 'task_a', label: '任务 A' }
      const taskB = { ownerId: 'task:s_res:task_b', sessionId: 's_res', taskId: 'task_b', label: '任务 B' }
      const desktopA = await manager.acquire({ kind: 'desktop', resource: 'desktop', owner: taskA })
      expect(desktopA.ok).toBe(true)
      const desktopB = await manager.acquire({ kind: 'desktop', resource: 'desktop', owner: taskB })
      expect(desktopB.ok).toBe(false)
      if (!desktopB.ok) expect(desktopB.holder?.owner.label).toBe('任务 A')
      manager.releaseOwner({ ownerId: taskA.ownerId })
      const desktopBAfter = await manager.acquire({ kind: 'desktop', resource: 'desktop', owner: taskB })
      expect(desktopBAfter.ok).toBe(true)
      manager.releaseOwner({ ownerId: taskB.ownerId })

      const portA = await manager.acquire({ kind: 'port', resource: 'port:3000', owner: taskA })
      expect(portA.ok).toBe(true)
      const portB = await manager.acquire({ kind: 'port', resource: 'port:3000', owner: taskB })
      expect(portB.ok).toBe(false)
      manager.releaseSession('s_res')
      expect(manager.snapshot()).toHaveLength(0)
      mkdirSync(join(process.cwd(), 'tmp', 'verification', 'collaboration'), { recursive: true })
      writeFileSync(
        join(process.cwd(), 'tmp', 'verification', 'collaboration', 'T09-resources-evidence.json'),
        JSON.stringify({ snapshotAfterRelease: manager.snapshot(), events: manager.history(20) }, null, 2),
        'utf8'
      )

      expect(detectCommandPorts('vite --port 5173 --strictPort')).toEqual([5173])
      expect(detectCommandPorts('PORT=3000 node server.js')).toEqual([3000])
      expect(detectCommandPorts('curl http://localhost:8080/health')).toEqual([8080])
      expect(detectCommandPorts('echo 12:30 ratio')).toEqual([])
      expect(existsSync(join(dataDir, 'collaboration', 'shared-resources.jsonl'))).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
