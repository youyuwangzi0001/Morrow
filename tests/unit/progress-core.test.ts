import { describe, expect, it } from 'vitest'
import type { Artifact, ChatMessage, Session } from '@shared/types'
import {
  basename,
  collectOutputFiles,
  collectSourceGroups,
  hostnameOf
} from '@shared/progress'

function tool(
  id: string,
  name: string,
  input: Record<string, unknown>,
  finishedAt: number,
  meta?: Record<string, unknown>,
  status: 'success' | 'error' = 'success'
): ChatMessage {
  return {
    id: `msg-${id}`,
    role: 'assistant',
    createdAt: finishedAt - 10,
    content: [
      {
        type: 'tool_use',
        id,
        name,
        title: name,
        category: 'write',
        input,
        status,
        finishedAt,
        ...(meta ? { result: { ok: status === 'success', output: '', meta } } : {})
      }
    ]
  }
}

function artifact(id: string, path: string, title: string, updatedAt: number): Artifact {
  return { id, title, kind: 'markdown', path, createdAt: updatedAt, updatedAt }
}

function session(messages: ChatMessage[], artifacts: Artifact[] = []): Session {
  return {
    id: 's1',
    title: '测试会话',
    workspace: 'C:\\work',
    model: { providerId: 'mock', modelId: 'mock' },
    permissionMode: 'auto',
    createdAt: 1,
    updatedAt: 1,
    messageCount: messages.length,
    messages,
    todos: [],
    artifacts,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }
  } as unknown as Session
}

describe('progress-core 来源', () => {
  it('@core:interface 按 URL 去重并保留查询分组与提供方', () => {
    const search = (id: string, query: string, urls: string[], at: number): ChatMessage => ({
      id: `msg-${id}`,
      role: 'assistant',
      createdAt: at,
      content: [
        {
          type: 'tool_use',
          id,
          name: 'web_search',
          title: '联网搜索',
          category: 'read',
          input: { query },
          status: 'success',
          result: {
            ok: true,
            output: '',
            meta: {
              query,
              provider: 'tavily',
              sources: urls.map((url, index) => ({ url, title: `T${index}`, rank: index + 1 }))
            }
          }
        }
      ]
    })
    const groups = collectSourceGroups(
      session([
        search('a', 'morrow 压缩', ['https://a.example/1', 'https://b.example/2'], 10),
        search('b', 'morrow 压缩', ['https://a.example/1', 'https://c.example/3'], 20)
      ])
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.provider).toBe('tavily')
    expect(groups[0]!.sources.map((source) => source.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3'
    ])
  })

  it('@core:interface 忽略失败的搜索与非法 URL', () => {
    const failed: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      createdAt: 1,
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'web_search',
          title: '联网搜索',
          category: 'read',
          input: {},
          status: 'error',
          result: { ok: false, output: '', meta: { sources: [{ url: 'https://a.example' }] } }
        }
      ]
    }
    const badUrl = tool('t2', 'web_search', {}, 2, {
      query: 'q',
      provider: 'p',
      sources: [{ url: 'file:///etc/passwd' }]
    })
    expect(collectSourceGroups(session([failed, badUrl]))).toEqual([])
  })

  it('@core:interface 从 URL 提取主机名并去掉 www 前缀', () => {
    expect(hostnameOf('https://www.example.com/a')).toBe('example.com')
    expect(hostnameOf('not a url')).toBe('not a url')
  })
})

describe('progress-core 产出文件', () => {
  it('@core:interface 合并写入工具与成果，同一路径只保留一条', () => {
    const writes = [
      tool('w1', 'write_file', { path: 'src/a.ts' }, 100, {
        path: 'src/a.ts',
        absolutePath: 'C:\\work\\src\\a.ts'
      }),
      tool('w2', 'edit_file', { path: 'src/b.ts' }, 200, {
        path: 'src/b.ts',
        absolutePath: 'C:\\work\\src\\b.ts'
      })
    ]
    const files = collectOutputFiles(
      session(writes, [artifact('art1', 'C:\\work\\src\\a.ts', 'A 文件', 300)])
    )
    expect(files.map((file) => file.title)).toEqual(['A 文件', 'b.ts'])
    expect(files[0]!.artifactId).toBe('art1')
    expect(files[1]!.absolutePath).toBe('C:\\work\\src\\b.ts')
  })

  it('@core:interface 忽略失败写入，保留最近 12 条并按时间倒序', () => {
    const messages = Array.from({ length: 14 }, (_, index) =>
      tool(`t${index}`, 'write_file', { path: `f${index}.txt` }, index, {
        path: `f${index}.txt`,
        absolutePath: `C:\\work\\f${index}.txt`
      })
    )
    messages.push(tool('failed', 'write_file', { path: 'bad.txt' }, 99, { path: 'bad.txt' }, 'error'))
    const files = collectOutputFiles(session(messages))
    expect(files).toHaveLength(12)
    expect(files[0]!.title).toBe('f13.txt')
    expect(files.some((file) => file.title === 'bad.txt')).toBe(false)
  })

  it('@core:interface 没有绝对路径时仍可展示写入文件名', () => {
    const files = collectOutputFiles(session([tool('w1', 'write_file', { path: 'docs/report.md' }, 5, { path: 'docs/report.md' })]))
    expect(files).toHaveLength(1)
    expect(files[0]!.title).toBe('report.md')
    expect(files[0]!.absolutePath).toBeUndefined()
  })
})

describe('progress-core 路径', () => {
  it('@core:interface 兼容 Windows 与 POSIX 分隔符', () => {
    expect(basename('C:\\work\\src\\a.ts')).toBe('a.ts')
    expect(basename('docs/report.md')).toBe('report.md')
    expect(basename('C:\\work\\src\\')).toBe('src')
  })
})