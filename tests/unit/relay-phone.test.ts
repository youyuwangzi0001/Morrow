/**
 * 手机通道域（`src/main/relay-phone.ts`）的用例：下行裁剪、上行白名单与作品投影。
 *
 * 守的不是“能不能转发”，而是**不该转发的东西有没有被拦住**：工具输出、审批参数、
 * 产物正文、附件。它们体积大且与手机展示无关，一旦漏到下行帧，既白耗流量，
 * 也会把本不该离机的命令原文与文件内容送到另一台设备上。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Artifact, ChatMessage, RuntimeEvent } from '../../src/shared/types'
import type { StudioDelivery, StudioProjectSummary } from '../../src/shared/studio'
import {
  dispatchPhoneInvoke,
  phoneArtifact,
  phoneInvokeStats,
  phoneMessage,
  phoneProducts,
  phoneStageStatuses,
  phoneStudioJob,
  phoneWorks,
  phoneWorkspaceFilesFrom,
  setPhoneInvokeHandler,
  toPhoneEvent
} from '../../src/main/relay-phone'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchWorkspaceFiles } from '../../src/main/workspace'

const AT = 1_700_000_000_000

const base = { seq: 1, runId: 'run-1', sessionId: 's-1', at: AT }

function event(body: Record<string, unknown>): RuntimeEvent {
  return { ...base, ...body } as unknown as RuntimeEvent
}

function message(text: string): ChatMessage {
  return {
    id: 'm-1',
    role: 'assistant',
    content: [{ type: 'text', text }],
    createdAt: AT
  } as ChatMessage
}

describe('手机端 @ 面板的数据源（F-09）', () => {
  it('@core:relay 快照必须带上工作区文件列表，否则 @ 面板永远是空的', async () => {
    // 回归 F-09：手机端 mentionQueryOf 与整个 @ 面板 UI 都是完整的，
    // 但那一侧的 files 一直传 emptyList() —— 因为桌面从来没下发过文件列表。
    const dir = await mkdtemp(join(tmpdir(), 'morrow-f09-'))
    try {
      await writeFile(join(dir, 'README.md'), '# hi')
      await writeFile(join(dir, 'main.ts'), 'export {}')

      const files = phoneWorkspaceFilesFrom(
        { get: () => ({ lastWorkspace: dir }) },
        searchWorkspaceFiles
      )
      expect(files).not.toBeNull()
      expect(files!.some((f) => f.name === 'README.md')).toBe(true)
      expect(files!.some((f) => f.name === 'main.ts')).toBe(true)
      // 只带 path/name/dir，不带文件内容 —— 面板只需要名字
      for (const f of files!) {
        expect(Object.keys(f).sort()).toEqual(['dir', 'name', 'path'])
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('@core:relay 没有工作区时返回 null 而不是空数组', () => {
    // null 与 [] 对用户是两种不同提示。
    expect(phoneWorkspaceFilesFrom({ get: () => ({}) }, searchWorkspaceFiles)).toBeNull()
  })

  it('@core:relay 读取设置抛异常时不能让整份快照失败', () => {
    const store = { get: () => { throw new Error('设置文件损坏') } }
    expect(phoneWorkspaceFilesFrom(store, searchWorkspaceFiles)).toBeNull()
  })

  it('@core:relay 搜索本身抛异常时也不拖垮快照', () => {
    const store = { get: () => ({ lastWorkspace: '/tmp/x' }) }
    const boom = () => { throw new Error('搜索炸了') }
    expect(phoneWorkspaceFilesFrom(store, boom as never)).toBeNull()
  })
})


describe('手机端 @ 面板的数据源（F-09）', () => {
  it('@core:relay 快照必须带上工作区文件列表，否则 @ 面板永远是空的', async () => {
    // 回归 F-09：手机端 `ThreadReducer.mentionQueryOf` 与整个 @ 面板 UI
    // 都是完整的，但那一侧的 `files` 一直传 `emptyList()` —— 因为桌面
    // **从来没下发过文件列表**。用户打 @ 出来的是空面板。
    const dir = await mkdtemp(join(tmpdir(), 'morrow-f09-'))
    try {
      await writeFile(join(dir, 'README.md'), '# hi')
      await writeFile(join(dir, 'main.ts'), 'export {}')

      const store = {
        get: () => ({ lastWorkspace: dir, recentWorkspaces: [dir] })
      }
      const files = phoneWorkspaceFilesFrom(store, searchWorkspaceFiles)
      expect(files).not.toBeNull()
      expect(files!.some((f) => f.name === 'README.md')).toBe(true)
      expect(files!.some((f) => f.name === 'main.ts')).toBe(true)
      // 只带 path/name/dir，不带文件内容 —— 面板只需要名字
      for (const f of files!) {
        expect(Object.keys(f).sort()).toEqual(['dir', 'name', 'path'])
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('@core:relay 没有工作区时返回 null 而不是空数组', async () => {
    // null 与 [] 对用户是两种不同提示：「还没打开过工作区」vs「工作区是空的」。
    const store = { get: () => ({ lastWorkspace: undefined, recentWorkspaces: [] }) }
    expect(phoneWorkspaceFilesFrom(store, searchWorkspaceFiles)).toBeNull()
  })

  it('@core:relay 读取设置抛异常时不能让整份快照失败', async () => {
    const store = {
      get: () => {
        throw new Error('设置文件损坏')
      }
    }
    expect(phoneWorkspaceFilesFrom(store, searchWorkspaceFiles)).toBeNull()
  })
})

describe('手机下行事件裁剪', () => {
  it('@core:relay 工具结果不下发（输出可能含命令原文与文件内容）', () => {
    const phone = toPhoneEvent(
      event({
        type: 'tool_finished',
        messageId: 'm-1',
        toolUseId: 't-1',
        result: { ok: true, output: 'SECRET-COMMAND-OUTPUT' }
      })
    )
    expect(phone).not.toBeNull()
    expect(JSON.stringify(phone)).not.toContain('SECRET-COMMAND-OUTPUT')
    expect(phone?.toolUseId).toBe('t-1')
  })

  it('@core:relay 工具输入不下发（只保留 messageId）', () => {
    const phone = toPhoneEvent(
      event({
        type: 'tool_started',
        messageId: 'm-1',
        block: { type: 'tool_use', id: 't-1', name: 'run_command', input: { command: 'rm -rf /' } }
      })
    )
    expect(phone).not.toBeNull()
    expect(JSON.stringify(phone)).not.toContain('rm -rf')
  })

  it('@core:relay 工具开始下发名字与标题，让手机能显示「在改哪个文件」', () => {
    const phone = toPhoneEvent(
      event({
        type: 'tool_started',
        messageId: 'm-1',
        block: {
          type: 'tool_use',
          id: 't-1',
          name: 'edit_file',
          title: '修改 src/a.ts',
          category: 'write',
          input: { path: 'src/a.ts', old_string: 'SECRET', new_string: 'SECRET-2' }
        }
      })
    )
    expect(phone?.tool).toEqual({ name: 'edit_file', title: '修改 src/a.ts', category: 'write' })
    expect(phone?.toolUseId).toBe('t-1')
    // 标题之外的输入（片段原文）仍然不下发
    expect(JSON.stringify(phone)).not.toContain('SECRET')
  })

  it('@core:relay 工具结果只下发计数与状态，不下发正文', () => {
    const phone = toPhoneEvent(
      event({
        type: 'tool_finished',
        messageId: 'm-1',
        toolUseId: 't-1',
        result: {
          ok: true,
          output: 'SECRET-COMMAND-OUTPUT',
          durationMs: 1234,
          meta: { diffAdded: 7, diffRemoved: 2, exitCode: 0 }
        }
      })
    )
    expect(phone?.toolResult).toEqual({ ok: true, diffAdded: 7, diffRemoved: 2, durationMs: 1234, exitCode: 0 })
    expect(JSON.stringify(phone)).not.toContain('SECRET-COMMAND-OUTPUT')
  })

  it('@core:relay 删除/新建文件的状态能到手机（用 meta.created / deleted）', () => {
    const created = toPhoneEvent(
      event({ type: 'tool_finished', messageId: 'm-1', toolUseId: 't-1', result: { ok: true, output: '', meta: { created: true } } })
    )
    expect(created?.toolResult).toMatchObject({ created: true })

    const deleted = toPhoneEvent(
      event({ type: 'tool_finished', messageId: 'm-1', toolUseId: 't-2', result: { ok: true, output: '', meta: { deleted: true } } })
    )
    expect(deleted?.toolResult).toMatchObject({ deleted: true })
  })

  it('@core:relay 工具失败只下发 failed 标记，不带错误正文', () => {
    const phone = toPhoneEvent(
      event({
        type: 'tool_finished',
        messageId: 'm-1',
        toolUseId: 't-1',
        result: { ok: false, output: '', error: 'SECRET-ERROR-DETAIL' }
      })
    )
    expect(phone?.toolResult).toMatchObject({ ok: false, failed: true })
    expect(JSON.stringify(phone)).not.toContain('SECRET-ERROR-DETAIL')
  })

  it('@core:relay 消息 content 转成手机可读正文', () => {
    const phone = toPhoneEvent(event({ type: 'message_completed', messageId: 'm-1', message: message('你好，世界') }))
    const payload = phone?.message as Record<string, unknown>
    expect(payload.text).toBe('你好，世界')
    expect(payload.role).toBe('assistant')
    expect(payload.createdAt).toBe(AT)
  })

  it('@core:relay 消息带结构化块：文字、工具、错误各自成块', () => {
    const rich: ChatMessage = {
      id: 'm-rich',
      role: 'assistant',
      createdAt: AT,
      content: [
        { type: 'text', text: '先看下表：\n\n| 月份 | 金额 |\n| --- | ---: |\n| 7 月 | 12 |' },
        {
          type: 'tool_use',
          id: 't-1',
          name: 'edit_file',
          title: '修改 src/a.ts',
          category: 'write',
          status: 'ok',
          result: {
            ok: true,
            output: 'SECRET-OUTPUT',
            meta: { diffAdded: 2, diffRemoved: 1, diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' }
          }
        },
        { type: 'error', message: '这一步失败了', code: 'tool_error' }
      ]
    } as ChatMessage
    const phone = toPhoneEvent(event({ type: 'message_completed', messageId: 'm-rich', message: rich }))
    const payload = phone?.message as Record<string, unknown>
    const blocks = payload.blocks as Array<Record<string, unknown>>
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool', 'error'])
    // 表格留在文字块里（手机按 Markdown 渲染成表格），不是被摊平
    expect(blocks[0].text).toContain('| 月份 | 金额 |')
    // 工具块带行级 diff —— 这正是「手机看不到 diff」的修复点
    expect(blocks[1].diff).toContain('@@ -1 +1 @@')
    expect(blocks[1].result).toMatchObject({ ok: true, diffAdded: 2, diffRemoved: 1 })
    // 命令输出仍然不下发
    expect(JSON.stringify(phone)).not.toContain('SECRET-OUTPUT')
  })

  it('@core:relay 工具块不对命令类工具下发 diff（只有文件写入才有）', () => {
    const command: ChatMessage = {
      id: 'm-cmd',
      role: 'assistant',
      createdAt: AT,
      content: [
        {
          type: 'tool_use',
          id: 't-1',
          name: 'run_command',
          title: '运行命令：npm test',
          category: 'exec',
          input: { command: 'npm test' },
          status: 'success',
          result: { ok: true, output: 'ok', meta: { exitCode: 0, diff: 'SSH-KEY-LIKE-CONTENT' } }
        }
      ]
    } as ChatMessage
    const phone = toPhoneEvent(event({ type: 'message_completed', messageId: 'm-cmd', message: command }))
    const blocks = (phone?.message as Record<string, unknown>).blocks as Array<Record<string, unknown>>
    expect(blocks[0].diff).toBeUndefined()
    expect(JSON.stringify(phone)).not.toContain('SSH-KEY-LIKE-CONTENT')
  })

  it('@core:relay 计划下发步骤清单，不只是标题', () => {
    const phone = toPhoneEvent(
      event({
        type: 'plan_updated',
        planMode: true,
        plan: {
          id: 'p-1',
          title: '销售复盘',
          summary: '把 Q3 明细做成复盘',
          steps: [
            { id: 's-1', text: '读取 CSV' },
            { id: 's-2', text: '按月聚合' }
          ],
          status: 'pending',
          createdAt: AT,
          updatedAt: AT
        }
      })
    )
    const plan = phone?.plan as Record<string, unknown>
    expect(plan.title).toBe('销售复盘')
    expect(plan.summary).toBe('把 Q3 明细做成复盘')
    expect((plan.steps as Array<Record<string, unknown>>).map((s) => s.text)).toEqual(['读取 CSV', '按月聚合'])
    expect(plan.status).toBe('pending')
  })

  it('@core:relay 产物只带元数据，不带内联 HTML 正文', () => {
    const artifact = {
      id: 'a-1',
      title: '报告.html',
      kind: 'html',
      content: '<html>FULL-ARTIFACT-CONTENT</html>',
      createdAt: AT,
      updatedAt: AT + 1
    } as Artifact
    expect(phoneArtifact(artifact).content).toBeUndefined()
    const phone = toPhoneEvent(event({ type: 'artifacts_updated', artifacts: [artifact] }))
    expect(JSON.stringify(phone)).not.toContain('FULL-ARTIFACT-CONTENT')
    expect(JSON.stringify(phone)).toContain('报告.html')
  })

  it('@core:relay 审批只带页面展示字段，不带工具参数原文', () => {
    const phone = toPhoneEvent(
      event({
        type: 'permission_requested',
        request: {
          id: 'req-1',
          sessionId: 's-1',
          toolUseId: 't-1',
          toolName: 'run_command',
          title: '执行命令',
          summary: '在工作区运行构建',
          category: 'command',
          risk: 'high',
          input: { command: 'cat ~/.ssh/id_rsa' },
          allowAlways: false,
          createdAt: AT
        }
      })
    )
    const request = phone?.request as Record<string, unknown>
    expect(request.title).toBe('执行命令')
    expect(request.risk).toBe('high')
    expect(request.allowAlways).toBe(false)
    expect(JSON.stringify(phone)).not.toContain('id_rsa')
  })

  it('@core:relay 消息替换最多带 120 条（保留最近）', () => {
    const messages = Array.from({ length: 200 }, (_, index) => ({
      ...message(`第 ${index} 条`),
      id: `m-${index}`
    }))
    const phone = toPhoneEvent(event({ type: 'messages_replaced', messages }))
    const list = phone?.messages as Array<Record<string, unknown>>
    expect(list).toHaveLength(120)
    expect(list[0].id).toBe('m-80')
    expect(list[119].id).toBe('m-199')
  })

  it('@core:relay 用户消息不带附件与图片数据', () => {
    const userMessage = {
      ...message('看这个文件'),
      role: 'user',
      attachments: [{ name: 'a.png', dataUrl: 'data:image/png;base64,SECRET-BYTES' }],
      images: [{ dataUrl: 'data:image/png;base64,SECRET-BYTES' }]
    } as unknown as ChatMessage
    const phone = toPhoneEvent(event({ type: 'run_started', userMessage, assistantMessageId: 'm-2' }))
    expect(JSON.stringify(phone)).not.toContain('SECRET-BYTES')
    expect((phone?.userMessage as Record<string, unknown>).text).toBe('看这个文件')
  })

  it('@core:relay 手机不关心的事件不下发', () => {
    expect(toPhoneEvent(event({ type: 'episodes_captured', episodeIds: ['e'], scope: 'project', workspace: null }))).toBeNull()
    expect(toPhoneEvent(event({ type: 'demo_step', index: 1, total: 3, caption: 'x' }))).toBeNull()
  })

  it('@core:relay 消息角色与时间原样保留给投影层', () => {
    const phone = phoneMessage({ ...message('ok'), role: 'system', id: 'm-9' } as ChatMessage)
    expect(phone.role).toBe('system')
    expect(phone.id).toBe('m-9')
    expect(phone.createdAt).toBe(AT)
  })
})
describe('协作状态下行', () => {
  it('@core:relay 带出项目/会话/任务 id 供手机干预', () => {
    const phone = toPhoneEvent(
      event({
        type: 'super_updated',
        state: {
          status: 'running',
          projectId: 'proj-1',
          goal: '把 Q3 复盘做完',
          tasks: [{ index: 0, id: 'task-0', taskId: 'task-0b', title: '前端', status: 'running' }]
        }
      })
    )
    const state = (phone as unknown as { state: Record<string, unknown> }).state
    expect(state.sessionId).toBe('s-1')
    expect(state.projectId).toBe('proj-1')
    const tasks = state.tasks as Array<Record<string, unknown>>
    expect(tasks[0].taskId).toBe('task-0b')
  })

  it('@core:relay 卡住告警投影到成员卡（手机据此显示「卡住」）', () => {
    // 回归：StuckAlert 有 12 个字段，但手机侧只需要三个 ——
    // 此前一个都不发，导致 Android 的卡住状态机整块空转。
    const phone = toPhoneEvent(
      event({
        type: 'super_updated',
        state: {
          status: 'running',
          projectId: 'proj-1',
          goal: 'g',
          tasks: [
            {
              index: 0,
              id: 'task-0',
              title: '链接检查',
              status: 'running',
              stuck: {
                id: 'stuck-1',
                taskId: 'task-0',
                taskTitle: '链接检查',
                reason: '连续 3 步无新成果',
                detectedAt: AT,
                lastEffectiveAt: AT - 1000,
                stepsSinceProgress: 3,
                repeatedCount: 2,
                lastOperation: 'docs:check'
              }
            }
          ]
        }
      })
    )
    const tasks = (phone as unknown as { state: Record<string, unknown> }).state
      .tasks as Array<Record<string, unknown>>
    expect(tasks[0].stuck).toMatchObject({
      reason: '连续 3 步无新成果',
      stepsSinceProgress: 3,
      lastOperation: 'docs:check'
    })
  })

  it('@core:relay 已消解的卡住告警不再下发', () => {
    const phone = toPhoneEvent(
      event({
        type: 'super_updated',
        state: {
          status: 'running',
          projectId: 'proj-1',
          goal: 'g',
          tasks: [
            {
              index: 0,
              id: 'task-0',
              title: '链接检查',
              status: 'running',
              stuck: {
                id: 'stuck-1',
                taskId: 'task-0',
                taskTitle: '链接检查',
                reason: '连续 3 步无新成果',
                detectedAt: AT,
                lastEffectiveAt: AT,
                stepsSinceProgress: 3,
                repeatedCount: 2,
                status: 'resolved'
              }
            }
          ]
        }
      })
    )
    const tasks = (phone as unknown as { state: Record<string, unknown> }).state
      .tasks as Array<Record<string, unknown>>
    expect(tasks[0].stuck).toBeUndefined()
  })
})

beforeEach(() => {
  setPhoneInvokeHandler(null)
})

describe('创作台任务下行', () => {
  it('@core:relay 任务进度投影成手机可跟盯的形状', () => {
    // 回归：toPhoneEvent 的 28 个 case 里没有任何 studio 事件，
    // 手机端「渲染中 62%」没有数据源，只能靠 works.get 拉快照。
    const job = {
      id: 'job-1',
      projectId: 'proj-9',
      kind: 'render',
      status: 'running',
      progress: 62.4,
      label: '漫剧 · 90 秒',
      message: '第 7 镜',
      stage: 'visuals'
    }
    const phone = phoneStudioJob(job as never, 'proj-9')

    expect(phone).toMatchObject({
      projectId: 'proj-9',
      jobId: 'job-1',
      kind: 'render',
      status: 'running',
      progress: 62,
      stage: 'visuals'
    })
    expect(typeof phone.at).toBe('number')
  })

  it('@core:relay 没有真实进度时不编造百分比', () => {
    const phone = phoneStudioJob(
      { id: 'job-2', projectId: 'p', kind: 'text', status: 'queued', label: '写作' } as never,
      'p'
    )
    expect(phone.progress).toBeUndefined()
  })
})

describe('手机上行 invoke', () => {
  it('@core:relay 未知方法被拒绝且不调用处理器', async () => {
    let called = false
    setPhoneInvokeHandler(() => {
      called = true
      return { ok: true }
    })
    const result = await dispatchPhoneInvoke({ id: '1', method: 'shell.exec', params: { command: 'rm -rf /' } })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('unsupported')
    expect(called).toBe(false)
  })

  it('@core:relay 手机端不允许 always（不静默降级为 once）', async () => {
    let called = false
    setPhoneInvokeHandler(() => {
      called = true
      return { ok: true }
    })
    const result = await dispatchPhoneInvoke({
      id: '1',
      method: 'approval.decide',
      params: { requestId: 'req-1', decision: 'always' }
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('forbidden')
    expect(called).toBe(false)
  })

  it('@core:relay 缺 requestId 或 runId 时不调用处理器', async () => {
    let calls = 0
    setPhoneInvokeHandler(() => {
      calls++
      return { ok: true }
    })
    const noRequest = await dispatchPhoneInvoke({ id: '1', method: 'approval.decide', params: { decision: 'once' } })
    const noRun = await dispatchPhoneInvoke({ id: '2', method: 'run.stop', params: {} })
    expect(noRequest.error?.code).toBe('bad_request')
    expect(noRun.error?.code).toBe('bad_request')
    expect(calls).toBe(0)
  })

  it('@core:relay works.preview 缺 id 时不调用处理器', async () => {
    let calls = 0
    setPhoneInvokeHandler(() => {
      calls++
      return { ok: true }
    })
    const noWork = await dispatchPhoneInvoke({ id: '1', method: 'works.preview', params: { productId: 'p1' } })
    const noProduct = await dispatchPhoneInvoke({ id: '2', method: 'works.preview', params: { workId: 'w1' } })
    expect(noWork.error?.code).toBe('bad_request')
    expect(noProduct.error?.code).toBe('bad_request')
    expect(calls).toBe(0)
  })

  it('@core:relay 合法的预览请求被交给处理器', async () => {
    const seen: Array<Record<string, unknown>> = []
    setPhoneInvokeHandler((request) => {
      seen.push(request.params)
      return { ok: true, result: { preview: null } }
    })
    const result = await dispatchPhoneInvoke({
      id: 'p1',
      method: 'works.preview',
      params: { workId: 'w1', productId: 'd1' }
    })
    expect(result.ok).toBe(true)
    expect(seen).toEqual([{ workId: 'w1', productId: 'd1' }])
  })

  it('@core:relay swarm 干预缺 id/空指令时不调用处理器', async () => {
    let calls = 0
    setPhoneInvokeHandler(() => {
      calls++
      return { ok: true }
    })
    const noProject = await dispatchPhoneInvoke({ id: '1', method: 'swarm.stopMember', params: { taskId: 't1' } })
    const emptyText = await dispatchPhoneInvoke({
      id: '2',
      method: 'swarm.instruction',
      params: { projectId: 'p1', sessionId: 's1', taskId: 't1', text: '  ' }
    })
    expect(noProject.error?.code).toBe('bad_request')
    expect(emptyText.error?.code).toBe('bad_request')
    expect(calls).toBe(0)
  })

  it('@core:relay 合法的协作重试交给处理器', async () => {
    const seen: Array<Record<string, unknown>> = []
    setPhoneInvokeHandler((request) => {
      seen.push(request.params)
      return { ok: true, result: { started: true } }
    })
    const result = await dispatchPhoneInvoke({
      id: 'r1',
      method: 'swarm.retryMember',
      params: { projectId: 'p1', sessionId: 's1', taskId: 't1' }
    })
    expect(result.ok).toBe(true)
    expect(seen).toEqual([{ projectId: 'p1', sessionId: 's1', taskId: 't1' }])
  })

  it('@core:relay 合法的审批决定被交给处理器', async () => {
    const seen: Array<Record<string, unknown>> = []
    setPhoneInvokeHandler((request) => {
      seen.push(request.params)
      return { ok: true, result: { accepted: true } }
    })
    const result = await dispatchPhoneInvoke({
      id: 'abc',
      method: 'approval.decide',
      params: { requestId: 'req-9', decision: 'once' }
    })
    expect(result).toEqual({ ok: true, result: { accepted: true } })
    expect(seen).toEqual([{ requestId: 'req-9', decision: 'once' }])
  })

  it('@core:relay 处理器抛错变成失败结果而不是抛出', async () => {
    setPhoneInvokeHandler(() => {
      throw new Error('磁盘满了')
    })
    const result = await dispatchPhoneInvoke({ id: '1', method: 'ping', params: {} })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('failed')
    expect(result.error?.message).toBe('磁盘满了')
  })

  it('@core:relay message.send 校验会话与正文后交给处理器', async () => {
    const seen: Array<Record<string, unknown>> = []
    setPhoneInvokeHandler((request) => {
      seen.push(request.params)
      return { ok: true, result: { runId: 'run-1' } }
    })
    const result = await dispatchPhoneInvoke({
      id: 'm1',
      method: 'message.send',
      params: { sessionId: 's1', text: '把 Q3 做复盘' }
    })
    expect(result.ok).toBe(true)
    expect(seen).toEqual([{ sessionId: 's1', text: '把 Q3 做复盘' }])
  })

  it('@core:relay 空白消息不启动一轮，直接拒绝', async () => {
    let called = false
    setPhoneInvokeHandler(() => {
      called = true
      return { ok: true }
    })
    const blank = await dispatchPhoneInvoke({ id: 'm1', method: 'message.send', params: { sessionId: 's1', text: '   ' } })
    const tooLong = await dispatchPhoneInvoke({
      id: 'm2',
      method: 'message.send',
      params: { sessionId: 's1', text: 'x'.repeat(20_001) }
    })
    expect(blank.error?.code).toBe('bad_request')
    expect(tooLong.error?.code).toBe('bad_request')
    expect(called).toBe(false)
  })

  it('@core:relay works.get 不需要参数并原样回传结果', async () => {
    setPhoneInvokeHandler(() => ({ ok: true, result: { works: [{ id: 'w1' }] } }))
    const result = await dispatchPhoneInvoke({ id: 'w1', method: 'works.get', params: {} })
    expect(result).toEqual({ ok: true, result: { works: [{ id: 'w1' }] } })
  })

  it('@core:relay 未注册处理器时回 unavailable', async () => {
    const result = await dispatchPhoneInvoke({ id: '1', method: 'snapshot.get', params: {} })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('unavailable')
  })

  it('@core:relay ping 可用且统计处理次数', async () => {
    setPhoneInvokeHandler(() => ({ ok: true, result: { at: 1 } }))
    const result = await dispatchPhoneInvoke({ id: 'x', method: 'ping', params: {} })
    expect(result).toEqual({ ok: true, result: { at: 1 } })
    expect(phoneInvokeStats().hasHandler).toBe(true)
    // 计数器是模块级累计值（生产里用于诊断），这里只证明这次调用被计入
    expect(phoneInvokeStats().handled).toBeGreaterThanOrEqual(1)
  })
})

function project(overrides: Partial<StudioProjectSummary> = {}): StudioProjectSummary {
  return {
    id: 'w1',
    kind: 'short',
    title: '末日咖啡馆',
    logline: '末日后唯一还开着的咖啡馆',
    updatedAt: 1_700_000_000_000,
    createdAt: 1_600_000_000_000,
    stage: 'writing',
    progress: 42.6,
    words: 1200,
    chapters: 3,
    shots: 0,
    assets: 2,
    budget: { spent: 0, limit: 0 } as StudioProjectSummary['budget'],
    demo: false,
    ...overrides
  }
}

describe('phoneWorks', () => {
  it('@core:relay 字段改名并取整进度', () => {
    const [work] = phoneWorks([project()])
    expect(work).toMatchObject({
      id: 'w1',
      title: '末日咖啡馆',
      kind: 'short',
      logline: '末日后唯一还开着的咖啡馆',
      updatedAtMillis: 1_700_000_000_000,
      stage: 'writing',
      progress: 43,
      chapters: 3,
      shots: 0,
      assets: 2,
      words: 1200
    })
  })

  it('@core:relay 按更新时间倒序且最多 40 个', () => {
    const list = Array.from({ length: 45 }, (_, i) =>
      project({ id: `w${i}`, title: `作品 ${i}`, updatedAt: 1_000 + i })
    )
    const works = phoneWorks(list)
    expect(works).toHaveLength(40)
    expect(works[0].id).toBe('w44')
    expect(works[39].id).toBe('w5')
  })

  it('@core:relay 进度越界被夹到 0–100', () => {
    const works = phoneWorks([
      project({ id: 'a', progress: -5 }),
      project({ id: 'b', progress: 140 }),
      project({ id: 'c', progress: Number.NaN })
    ])
    expect(works.map((w) => w.progress)).toEqual([0, 100, 0])
  })

  it('@core:relay 产物清单按创建时间倒序并映射字段', () => {
    const deliveries = [
      { id: 'd1', kind: 'pdf', label: '成书.pdf', path: 'exports/a.pdf', bytes: 100, sha256: '', createdAt: 2 },
      { id: 'd2', kind: 'mp4', label: '成片', path: 'exports/a.mp4', bytes: 200, sha256: '', createdAt: 3 }
    ] as StudioDelivery[]
    const [work] = phoneWorks([project()], () => phoneProducts(deliveries))
    expect(work.products.map((p) => p.id)).toEqual(['d2', 'd1'])
    expect(work.products[0]).toMatchObject({ kind: 'mp4', label: '成片', bytes: 200, createdAtMillis: 3 })
  })

  it('@core:relay 没有产物时作品本身不丢', () => {
    const [work] = phoneWorks([project()])
    expect(work.id).toBe('w1')
    expect(work.products).toEqual([])
  })

  it('@core:relay 逐阶段真实状态要下发（否则手机只能靠 indexOf 推演）', () => {
    // 回归 M-13：手机原来只有「当前阶段」一个标量，靠 chain.indexOf 推演出
    // 「前面完成、后面等待」。桌面停在 failed 的阶段在手机上显示成「进行中」。
    const [work] = phoneWorks(
      [project()],
      () => [],
      () => ({
        blueprint: { status: 'done', progress: 100 },
        outline: { status: 'failed', progress: 40, message: '模型中断' }
      })
    )
    expect(work.stageStatuses).toMatchObject({
      blueprint: { status: 'done', progress: 100 },
      outline: { status: 'failed', progress: 40, message: '模型中断' }
    })
  })

  it('@core:relay 消息带出 token 用量（否则「用 18.4K token」那行永不显示）', () => {
    // 回归 P1-19：桌面 ChatMessage.usage 一直有，但 phoneMessage 不投 ——
    // 手机对话页那一行的条件恒为 false，界面写了却永远看不到。
    const withUsage = phoneMessage({
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: '答案' }],
      createdAt: AT,
      usage: { inputTokens: 18_000, outputTokens: 400 }
    } as unknown as ChatMessage)
    expect(withUsage.tokensUsed).toBe(18_400)

    // 没有 usage 时不编一个 0 —— 0 会被读成「这条消息没花 token」
    expect(phoneMessage(message('答案')).tokensUsed).toBeUndefined()
  })

  it('@core:relay 桌面没有阶段状态时不编造字段', () => {
    const [work] = phoneWorks([project()], () => [], () => undefined)
    expect(work.stageStatuses).toBeUndefined()
  })

  it('@core:relay 阶段状态裁剪：进度夹到 0–100、长消息截断', () => {
    const stages = phoneStageStatuses({
      writing: { status: 'running', progress: 140, message: 'x'.repeat(600) },
      noProgress: { status: 'waiting' }
    })!
    expect(stages.writing.progress).toBe(100)
    expect((stages.writing.message as string).length).toBeLessThanOrEqual(300)
    // 没有 progress 的阶段不能凭空给一个 0
    expect(stages.noProgress.progress).toBeUndefined()
  })
})
