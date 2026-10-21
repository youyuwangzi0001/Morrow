import { describe, expect, it } from 'vitest'
import { CONNECTOR_CATALOG, findCatalogEntry } from '../../../src/shared/connector-catalog'
import { buildLocalNpxInvocation, quoteCmdToken } from '../../../src/shared/connector-install'

describe('连接器目录', () => {
  it('条目 id/名称唯一，本机与远程字段完整', () => {
    expect(CONNECTOR_CATALOG.length).toBeGreaterThanOrEqual(6)
    expect(new Set(CONNECTOR_CATALOG.map((entry) => entry.id)).size).toBe(CONNECTOR_CATALOG.length)
    expect(new Set(CONNECTOR_CATALOG.map((entry) => entry.name)).size).toBe(CONNECTOR_CATALOG.length)
    for (const entry of CONNECTOR_CATALOG) {
      expect(entry.name, entry.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
      expect(entry.docsUrl, entry.id).toMatch(/^https:\/\//)
      expect(entry.timeoutMs).toBeGreaterThanOrEqual(5_000)
      if (entry.category === 'remote') {
        expect(entry.url, entry.id).toMatch(/^https:\/\//)
        expect(entry.transport).toBe('http')
        expect(entry.requiresNpx).toBe(false)
      } else {
        expect(entry.transport).toBe('stdio')
        expect(entry.packageArgs?.length, entry.id).toBeGreaterThan(0)
        expect(entry.requiresNpx).toBe(true)
      }
      if (entry.requiresToken) {
        expect(entry.tokenLabel, entry.id).toBeTruthy()
      }
    }
    expect(findCatalogEntry('github-remote')?.name).toBe('github')
    expect(findCatalogEntry('missing')).toBeNull()
  })

  it('Windows 下通过 cmd.exe 启动 npx，并对含空格的目录加引号', () => {
    const invocation = buildLocalNpxInvocation(
      ['@modelcontextprotocol/server-filesystem'],
      'C:\\My Projects\\A&B',
      'win32',
      'C:\\Windows\\System32\\cmd.exe'
    )
    expect(invocation.command).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(invocation.args[3]).toContain('npx -y @modelcontextprotocol/server-filesystem')
    expect(invocation.args[3]).toContain('"C:\\My Projects\\A&B"')
    expect(quoteCmdToken('plain')).toBe('plain')
    expect(quoteCmdToken('has space')).toBe('"has space"')
  })

  it('非 Windows 直接启动 npx', () => {
    const invocation = buildLocalNpxInvocation(['@modelcontextprotocol/server-memory'], null, 'linux')
    expect(invocation.command).toBe('npx')
    expect(invocation.args).toEqual(['-y', '@modelcontextprotocol/server-memory'])
  })
})
