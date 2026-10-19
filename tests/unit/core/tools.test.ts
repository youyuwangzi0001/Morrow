import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Artifact, TodoItem } from '../../../src/shared/types'
import type { ToolContext } from '../../../src/core/types'
import { executeTool } from '../../../src/core/tools/registry'
import { writeFileTool } from '../../../src/core/tools/fs-tools'
import { createUnifiedDiff } from '../../../src/core/tools/diff'
import { filterSensitiveEnv } from './helpers/env'
import { createProvider } from '../../../src/core/providers'
import { makeTempWorkspace, type TempWorkspace } from './helpers/workspace'

interface CtxState {
  todos: TodoItem[]
  artifacts: Artifact[]
  progressNotes: string[]
}

function makeCtx(ws: TempWorkspace, overrides: Partial<ToolContext> = {}, state: CtxState = { todos: [], artifacts: [], progressNotes: [] }): ToolContext {
  return {
    sessionId: 'session_1',
    runId: 'run_1',
    messageId: 'msg_1',
    toolUseId: 'call_1',
    workspace: ws.root,
    permissionMode: 'auto',
    snapshotDir: ws.snapshotDir,
    signal: new AbortController().signal,
    depth: 0,
    readOnly: false,
    escapeApproved: false,
    demo: false,
    goal: null,
    emit: () => undefined,
    updateGoal: () => null,
    getTodos: () => state.todos,
    setTodos: (todos) => {
      state.todos = todos
    },
    getArtifacts: () => state.artifacts,
    addArtifact: (artifact) => {
      state.artifacts.push(artifact)
    },
    askUser: async () => ({ value: 'A', label: '方案 A' }),
    progress: (note) => {
      state.progressNotes.push(note)
    },
    runSubagent: async () => ({ status: 'completed', summary: '子代理已完成调研', steps: 2, usage: { inputTokens: 10, outputTokens: 5 } }),
    ...overrides
  }
}

const isWindows = process.platform === 'win32'

describe('read_file', () => {
  it('返回带行号内容，支持 offset/limit', async () => {
    const ws = makeTempWorkspace({ 'note.txt': '第一行\n第二行\n第三行\n' })
    try {
      const ctx = makeCtx(ws)
      const result = await executeTool('read_file', { path: 'note.txt', offset: 2, limit: 1 }, ctx)
      expect(result.ok).toBe(true)
      expect(result.output).toContain('第二行')
      expect(result.output).not.toContain('第一行')
      expect(result.meta).toMatchObject({ startLine: 2, endLine: 2, hasMore: true })
    } finally {
      ws.cleanup()
    }
  })

  it('二进制文件给出可理解错误', async () => {
    const ws = makeTempWorkspace()
    try {
      writeFileSync(join(ws.root, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
      const result = await executeTool('read_file', { path: 'image.bin' }, makeCtx(ws))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('二进制')
    } finally {
      ws.cleanup()
    }
  })

  it('未绑定工作区时提示先选择文件夹', async () => {
    const ws = makeTempWorkspace({ 'a.txt': 'x' })
    try {
      const result = await executeTool('read_file', { path: 'a.txt' }, makeCtx(ws, { workspace: null }))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('工作文件夹')
    } finally {
      ws.cleanup()
    }
  })

  it('越界路径被拦截（未审批）', async () => {
    const ws = makeTempWorkspace({ 'a.txt': 'x' })
    try {
      const result = await executeTool('read_file', { path: '../../secret.txt' }, makeCtx(ws))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('工作区')
    } finally {
      ws.cleanup()
    }
  })
})

describe('write_file / edit_file（快照与 diff）', () => {
  it('新建文件：无快照、状态正确', async () => {
    const ws = makeTempWorkspace()
    try {
      const result = await executeTool('write_file', { path: 'out/报告.md', content: '# 标题\n内容' }, makeCtx(ws))
      expect(result.ok).toBe(true)
      expect(readFileSync(join(ws.root, 'out/报告.md'), 'utf8')).toBe('# 标题\n内容')
      expect(result.meta).toMatchObject({ created: true, snapshotId: null })
      expect(String(result.meta?.afterHash)).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      ws.cleanup()
    }
  })

  it('覆盖文件：旧内容备份到 snapshotDir/<toolUseId>/<filename>，带 beforeHash/diff', async () => {
    const ws = makeTempWorkspace({ 'config.json': '{"a":1}' })
    try {
      const result = await executeTool('write_file', { path: 'config.json', content: '{"a":2}' }, makeCtx(ws))
      expect(result.ok).toBe(true)
      const snapshotPath = join(ws.snapshotDir, 'call_1', 'config.json')
      expect(existsSync(snapshotPath)).toBe(true)
      expect(readFileSync(snapshotPath, 'utf8')).toBe('{"a":1}')
      expect(result.meta).toMatchObject({ snapshotId: 'call_1', path: 'config.json' })
      expect(String(result.meta?.diff)).toContain('-{"a":1}')
      expect(String(result.meta?.diff)).toContain('+{"a":2}')
      expect(result.meta?.beforeHash).not.toBe(result.meta?.afterHash)
    } finally {
      ws.cleanup()
    }
  })

  it('edit_file 唯一匹配成功并备份', async () => {
    const ws = makeTempWorkspace({ 'hello.txt': 'hello world' })
    try {
      const result = await executeTool(
        'edit_file',
        { path: 'hello.txt', old_string: 'world', new_string: 'morrow' },
        makeCtx(ws)
      )
      expect(result.ok).toBe(true)
      expect(readFileSync(join(ws.root, 'hello.txt'), 'utf8')).toBe('hello morrow')
      expect(existsSync(join(ws.snapshotDir, 'call_1', 'hello.txt'))).toBe(true)
      expect(String(result.meta?.diff)).toContain('-hello world')
      expect(String(result.meta?.diff)).toContain('+hello morrow')
    } finally {
      ws.cleanup()
    }
  })

  it('edit_file 多处匹配时拒绝并给自修复提示', async () => {
    const ws = makeTempWorkspace({ 'dup.txt': 'a a a' })
    try {
      const result = await executeTool('edit_file', { path: 'dup.txt', old_string: 'a', new_string: 'b' }, makeCtx(ws))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('3 次')
      expect(result.hint).toContain('replace_all')
      expect(readFileSync(join(ws.root, 'dup.txt'), 'utf8')).toBe('a a a')
    } finally {
      ws.cleanup()
    }
  })

  it('edit_file 找不到原文时提示先 read_file', async () => {
    const ws = makeTempWorkspace({ 'x.txt': 'hello' })
    try {
      const result = await executeTool('edit_file', { path: 'x.txt', old_string: 'bye', new_string: 'hi' }, makeCtx(ws))
      expect(result.ok).toBe(false)
      expect(result.hint).toContain('read_file')
    } finally {
      ws.cleanup()
    }
  })

  it('edit_file replace_all 替换所有匹配', async () => {
    const ws = makeTempWorkspace({ 'dup.txt': 'a a a' })
    try {
      const result = await executeTool(
        'edit_file',
        { path: 'dup.txt', old_string: 'a', new_string: 'b', replace_all: true },
        makeCtx(ws)
      )
      expect(result.ok).toBe(true)
      expect(readFileSync(join(ws.root, 'dup.txt'), 'utf8')).toBe('b b b')
      expect(result.meta).toMatchObject({ replaced: 3 })
    } finally {
      ws.cleanup()
    }
  })

  it('createUnifiedDiff 相同内容返回空 patch', () => {
    expect(createUnifiedDiff('a\nb', 'a\nb').patch).toBe('')
    const diff = createUnifiedDiff('a\nb\nc', 'a\nx\nc', 'f.txt')
    expect(diff.patch).toContain('-b')
    expect(diff.patch).toContain('+x')
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
  })
})

describe('list_dir / glob / grep', () => {
  function wsWithTree(): TempWorkspace {
    return makeTempWorkspace({
      'README.md': '# 项目说明',
      'data/a.csv': 'x,y\n1,2',
      'data/b.csv': 'x,y\n3,4',
      'src/app.ts': 'export const a = 1',
      'src/util/helper.ts': 'export const b = 2',
      'node_modules/pkg/index.js': 'module.exports = {}',
      'notes/异常记录.md': '这里有异常订单需要处理',
      'notes/普通.md': '没有问题的内容'
    })
  }

  it('list_dir 树形展示并跳过 node_modules', async () => {
    const ws = wsWithTree()
    try {
      const result = await executeTool('list_dir', { path: '.', depth: 2 }, makeCtx(ws))
      expect(result.ok).toBe(true)
      expect(result.output).toContain('README.md')
      expect(result.output).toContain('src/')
      expect(result.output).toContain('app.ts')
      expect(result.output).not.toContain('node_modules')
    } finally {
      ws.cleanup()
    }
  })

  it('glob 支持 basename 模式与递归模式', async () => {
    const ws = wsWithTree()
    try {
      const flat = await executeTool('glob', { pattern: '*.csv' }, makeCtx(ws))
      expect(flat.ok).toBe(true)
      expect(flat.meta?.count).toBe(2)
      const recursive = await executeTool('glob', { pattern: '**/*.ts' }, makeCtx(ws))
      expect(recursive.meta?.count).toBe(2)
      const scoped = await executeTool('glob', { pattern: 'src/*.ts' }, makeCtx(ws))
      expect(scoped.meta?.count).toBe(1)
      const zip = await executeTool('glob', { pattern: '**/*.{md,csv}' }, makeCtx(ws))
      expect(Number(zip.meta?.count)).toBeGreaterThanOrEqual(3)
    } finally {
      ws.cleanup()
    }
  })

  it('grep 搜索内容并支持 include 过滤', async () => {
    const ws = wsWithTree()
    try {
      const result = await executeTool('grep', { pattern: '异常', include: '*.md' }, makeCtx(ws))
      expect(result.ok).toBe(true)
      expect(result.meta?.matches).toBe(1)
      expect(result.output).toContain('异常记录.md:1')
    } finally {
      ws.cleanup()
    }
  })

  it('grep 跳过二进制文件并报告数量', async () => {
    const ws = wsWithTree()
    try {
      writeFileSync(join(ws.root, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
      const result = await executeTool('grep', { pattern: '异常' }, makeCtx(ws))
      expect(result.ok).toBe(true)
      expect(Number(result.meta?.skippedBinary)).toBeGreaterThanOrEqual(1)
    } finally {
      ws.cleanup()
    }
  })

  it('grep 非法正则给出可修复提示', async () => {
    const ws = wsWithTree()
    try {
      const result = await executeTool('grep', { pattern: '([abc' }, makeCtx(ws))
      expect(result.ok).toBe(false)
      expect(result.hint).toContain('括号')
    } finally {
      ws.cleanup()
    }
  })
})

describe('run_command', () => {
  it('真实执行命令并返回输出与退出码', async () => {
    const ws = makeTempWorkspace()
    try {
      const command = isWindows ? "Write-Output '你好 Morrow'" : "echo '你好 Morrow'"
      const result = await executeTool('run_command', { command }, makeCtx(ws))
      expect(result.ok).toBe(true)
      expect(result.output).toContain('你好 Morrow')
      expect(result.meta).toMatchObject({ exitCode: 0, timedOut: false })
    } finally {
      ws.cleanup()
    }
  }, 20_000)

  it('非零退出码返回失败与 stderr', async () => {
    const ws = makeTempWorkspace()
    try {
      const command = isWindows ? "Write-Error 'boom'; exit 3" : 'echo boom >&2; exit 3'
      const result = await executeTool('run_command', { command }, makeCtx(ws))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('退出码 3')
      expect(result.output).toContain('boom')
      expect(result.meta?.exitCode).toBe(3)
    } finally {
      ws.cleanup()
    }
  }, 20_000)

  it('超时会被强制终止', async () => {
    const ws = makeTempWorkspace()
    try {
      const command = isWindows ? 'Start-Sleep -Seconds 5' : 'sleep 5'
      const result = await executeTool('run_command', { command, timeout_ms: 1000 }, makeCtx(ws))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('超时')
      expect(Number(result.meta?.durationMs)).toBeLessThan(5000)
    } finally {
      ws.cleanup()
    }
  }, 20_000)

  it('cwd 越界被拦截', async () => {
    const ws = makeTempWorkspace()
    try {
      const result = await executeTool('run_command', { command: 'Get-Date', cwd: '..' }, makeCtx(ws))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('工作区')
    } finally {
      ws.cleanup()
    }
  })

  it('输出超过 32KB 被截断', async () => {
    const ws = makeTempWorkspace()
    try {
      const command = isWindows
        ? "1..2000 | ForEach-Object { 'abcdefghijklmnopqrstuvwxyz' }"
        : "for i in $(seq 1 2000); do echo abcdefghijklmnopqrstuvwxyz; done"
      const result = await executeTool('run_command', { command }, makeCtx(ws))
      expect(result.ok).toBe(true)
      expect(result.meta?.truncated).toBe(true)
      expect(Number(result.meta?.capturedBytes)).toBe(32 * 1024)
    } finally {
      ws.cleanup()
    }
  }, 20_000)

  it('环境变量清理：不带 API Key / 保留 PATH', () => {
    const cleaned = filterSensitiveEnv({
      PATH: 'C:/Windows',
      DEEPSEEK_API_KEY: 'sk-secret',
      OPENAI_API_KEY: 'sk-secret',
      MY_SECRET_TOKEN: 'secret',
      USERPROFILE: 'C:/Users/x',
      MORROW_TEST: '1'
    })
    expect(cleaned.PATH).toBe('C:/Windows')
    expect(cleaned.USERPROFILE).toBe('C:/Users/x')
    expect(cleaned.DEEPSEEK_API_KEY).toBeUndefined()
    expect(cleaned.OPENAI_API_KEY).toBeUndefined()
    expect(cleaned.MY_SECRET_TOKEN).toBeUndefined()
    expect(cleaned.MORROW_TEST).toBeUndefined()
    expect(cleaned.PYTHONUTF8).toBe('1')
  })
})

describe('meta 工具', () => {
  it('todo_write 更新计划并保持 id 稳定', async () => {
    const ws = makeTempWorkspace()
    try {
      const state: CtxState = { todos: [], artifacts: [], progressNotes: [] }
      const ctx = makeCtx(ws, {}, state)
      const first = await executeTool(
        'todo_write',
        { todos: [{ text: '读取数据', status: 'in_progress' }, { text: '写报告' }] },
        ctx
      )
      expect(first.ok).toBe(true)
      expect(state.todos).toHaveLength(2)
      const firstId = state.todos[0].id
      await executeTool(
        'todo_write',
        { todos: [{ text: '读取数据', status: 'completed' }, { text: '写报告', status: 'in_progress' }] },
        ctx
      )
      expect(state.todos[0].id).toBe(firstId)
      expect(state.todos[0].status).toBe('completed')
    } finally {
      ws.cleanup()
    }
  })

  it('ask_user 阻塞到用户回答', async () => {
    const ws = makeTempWorkspace()
    try {
      const ctx = makeCtx(ws, { askUser: async (request) => ({ value: request.options[0]?.value ?? 'x', label: '方案 A' }) })
      const result = await executeTool('ask_user', { question: '选哪个？', options: [{ label: '方案 A' }, { label: '方案 B' }] }, ctx)
      expect(result.ok).toBe(true)
      expect(result.output).toContain('方案 A')
      expect(result.meta?.answer).toMatchObject({ label: '方案 A' })
    } finally {
      ws.cleanup()
    }
  })

  it('remember 写入 .morrow/MEMORY.md', async () => {
    const ws = makeTempWorkspace()
    try {
      const ctx = makeCtx(ws)
      const first = await executeTool('remember', { text: '用户偏好简体中文报告' }, ctx)
      expect(first.ok).toBe(true)
      const second = await executeTool('remember', { text: '金额单位是人民币' }, ctx)
      expect(second.ok).toBe(true)
      const content = readFileSync(join(ws.root, '.morrow/MEMORY.md'), 'utf8')
      expect(content).toContain('用户偏好简体中文报告')
      expect(content).toContain('金额单位是人民币')
      expect(result_meta_path(second)).toBe('.morrow/MEMORY.md')
    } finally {
      ws.cleanup()
    }
  })

  it('open_artifact 从文件注册画布产物', async () => {
    const ws = makeTempWorkspace({ 'report.html': '<html><body>报告</body></html>' })
    try {
      const state: CtxState = { todos: [], artifacts: [], progressNotes: [] }
      const result = await executeTool('open_artifact', { title: '分析报告', path: 'report.html' }, makeCtx(ws, {}, state))
      expect(result.ok).toBe(true)
      expect(state.artifacts).toHaveLength(1)
      expect(state.artifacts[0]).toMatchObject({ title: '分析报告', kind: 'html' })
      expect(state.artifacts[0].content).toContain('报告')
    } finally {
      ws.cleanup()
    }
  })

  it('task 子代理返回摘要；子代理内不能嵌套', async () => {
    const ws = makeTempWorkspace()
    try {
      const state: CtxState = { todos: [], artifacts: [], progressNotes: [] }
      const ctx = makeCtx(ws, {}, state)
      const result = await executeTool('task', { description: '调研数据', prompt: '看看数据' }, ctx)
      expect(result.ok).toBe(true)
      expect(result.output).toContain('子代理已完成调研')
      expect(result.meta).toMatchObject({ steps: 2 })
      expect(state.progressNotes.length).toBeGreaterThan(0)
      const nested = await executeTool('task', { description: '再嵌套', prompt: '不行' }, makeCtx(ws, { depth: 1 }))
      expect(nested.ok).toBe(false)
    } finally {
      ws.cleanup()
    }
  })
})

describe('executeTool 兜底', () => {
  it('未知工具返回可用工具列表', async () => {
    const ws = makeTempWorkspace()
    try {
      const result = await executeTool('hack_disk', {}, makeCtx(ws))
      expect(result.ok).toBe(false)
      expect(result.hint).toContain('read_file')
    } finally {
      ws.cleanup()
    }
  })

  it('缺少必填参数返回自修复提示', async () => {
    const ws = makeTempWorkspace()
    try {
      const result = await executeTool('read_file', {}, makeCtx(ws))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('path')
      expect(result.hint).toBeTruthy()
    } finally {
      ws.cleanup()
    }
  })

  it('子代理上下文会拦下写工具', async () => {
    const ws = makeTempWorkspace()
    try {
      const result = await executeTool('write_file', { path: 'x.txt', content: 'x' }, makeCtx(ws, { readOnly: true }))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('只读')
    } finally {
      ws.cleanup()
    }
  })

  it('已审批越界时工具可以访问工作区外', async () => {
    const ws = makeTempWorkspace()
    try {
      const outside = makeTempWorkspace({ 'outside.txt': 'outside content' })
      try {
        const escaped = join(ws.root, '..', basename(outside.root), 'outside.txt')
        const result = await executeTool('read_file', { path: escaped }, makeCtx(ws, { escapeApproved: true }))
        expect(result.ok).toBe(true)
        expect(result.output).toContain('outside content')
      } finally {
        outside.cleanup()
      }
    } finally {
      ws.cleanup()
    }
  })

  it('createProvider 对 demo 返回离线引擎', () => {
    const provider = createProvider(
      {
        id: 'demo',
        kind: 'demo',
        name: '演示引擎',
        baseUrl: 'local://demo',
        models: [{ id: 'morrow-demo', label: 'Demo', contextWindow: 1000, supportsTools: true }],
        apiKeyStored: true,
        enabled: true
      },
      null
    )
    expect(provider.constructor.name).toBe('DemoProvider')
  })
})

function result_meta_path(result: { meta?: Record<string, unknown> }): string {
  return String(result.meta?.path ?? '')
}

describe('write_file append 模式', () => {
  it('追加到已有文件：保留旧内容、快照与 diff 完整', async () => {
    const ws = makeTempWorkspace({ 'notes.md': '# 标题\n第一段\n' })
    try {
      const result = await executeTool('write_file', { path: 'notes.md', content: '第二段\n', append: true }, makeCtx(ws))
      expect(result.ok).toBe(true)
      expect(readFileSync(join(ws.root, 'notes.md'), 'utf8')).toBe('# 标题\n第一段\n第二段\n')
      expect(result.meta).toMatchObject({ appended: true, created: false, writtenLines: 1 })
      // 快照保留旧内容
      const snapshotPath = join(ws.snapshotDir, 'call_1', 'notes.md')
      expect(existsSync(snapshotPath)).toBe(true)
      expect(readFileSync(snapshotPath, 'utf8')).toBe('# 标题\n第一段\n')
      expect(String(result.meta?.diff)).toContain('+第二段')
      expect(result.meta?.beforeHash).not.toBe(result.meta?.afterHash)
      expect(result.output).toContain('追加')
      expect(result.output).toContain('现共')
    } finally {
      ws.cleanup()
    }
  })

  it('append 到不存在的文件：创建文件且无快照', async () => {
    const ws = makeTempWorkspace()
    try {
      const result = await executeTool('write_file', { path: 'logs/app.log', content: '第一行\n', append: true }, makeCtx(ws))
      expect(result.ok).toBe(true)
      expect(readFileSync(join(ws.root, 'logs/app.log'), 'utf8')).toBe('第一行\n')
      expect(result.meta).toMatchObject({ appended: true, created: true, snapshotId: null })
      expect(String(result.meta?.afterHash)).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      ws.cleanup()
    }
  })

  it('默认覆盖语义不受影响（append=false）', async () => {
    const ws = makeTempWorkspace({ 'a.txt': '旧内容' })
    try {
      const result = await executeTool('write_file', { path: 'a.txt', content: '新内容' }, makeCtx(ws))
      expect(readFileSync(join(ws.root, 'a.txt'), 'utf8')).toBe('新内容')
      expect(result.meta).toMatchObject({ appended: false, created: false })
    } finally {
      ws.cleanup()
    }
  })

  it('titleFor 能区分追加与覆盖', () => {
    const ctx = makeCtx(makeTempWorkspace())
    const write = writeFileTool.definition.titleFor({ path: 'x.html' })
    const append = writeFileTool.definition.titleFor({ path: 'x.html', append: true })
    expect(write).toBe('写入 x.html')
    expect(append).toBe('追加写入 x.html')
    expect(ctx).toBeTruthy()
  })
})
