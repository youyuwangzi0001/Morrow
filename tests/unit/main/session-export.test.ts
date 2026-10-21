import { describe, expect, it } from 'vitest'
import { sessionExportContent, sessionToMarkdown } from '../../../src/main/services/session-export'
import type { Session } from '../../../src/shared/types'

function session(): Session {
  return {
    id: 's_export_test',
    title: '导出测试',
    workspace: 'C:\\ws',
    model: { providerId: 'p', modelId: 'm' },
    permissionMode: 'ask',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messageCount: 3,
    usage: { inputTokens: 10, outputTokens: 20 },
    todos: [{ id: 't1', text: '第一步', status: 'completed' }],
    artifacts: [{ id: 'a1', title: '报告', kind: 'markdown', content: '# x', createdAt: 1, updatedAt: 1 }],
    messages: [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: '请写报告' }], displayText: '请写报告', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: '好的，已经写好。' },
          {
            type: 'tool_use',
            id: 'c1',
            name: 'write_file',
            title: '写入报告',
            category: 'write',
            input: { path: 'out.md' },
            status: 'success',
            result: { ok: true, output: '已写入 out.md' }
          }
        ],
        createdAt: 2
      }
    ]
  }
}

describe('session export', () => {
  it('renders markdown with messages, tools, todos and artifacts', () => {
    const markdown = sessionToMarkdown(session())
    expect(markdown).toContain('# 导出测试')
    expect(markdown).toContain('请写报告')
    expect(markdown).toContain('好的，已经写好。')
    expect(markdown).toContain('write_file')
    expect(markdown).toContain('- [x] 第一步')
    expect(markdown).toContain('报告')
  })

  it('serializes JSON with a safe filename', () => {
    const json = sessionExportContent({ ...session(), title: 'a/b:c' }, 'json')
    expect(json.filename).toMatch(/^a_b_c\.json$/)
    expect(JSON.parse(json.content).id).toBe('s_export_test')
  })
})
