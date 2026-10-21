import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverAgentRules } from '../../../src/main/services/agent-rules'
import { makeTempDir } from '../core/helpers/workspace'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function temp(): string {
  const dir = makeTempDir('morrow-rules-')
  dirs.push(dir)
  return dir
}

describe('agent rules discovery', () => {
  it('discovers project, parent and user rules in priority order', () => {
    const root = temp()
    const workspace = join(root, 'repo')
    const home = join(root, 'home')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), 'PARENT-RULE', 'utf8')
    writeFileSync(join(workspace, 'AGENTS.md'), 'PROJECT-AGENTS', 'utf8')
    writeFileSync(join(workspace, 'CLAUDE.md'), 'PROJECT-CLAUDE', 'utf8')
    writeFileSync(join(workspace, 'MORROW.md'), 'PROJECT-MORROW', 'utf8')
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'USER-CLAUDE', 'utf8')

    const discovery = discoverAgentRules(workspace, { homeDir: home })
    expect(discovery.files.filter((file) => file.scope === 'project')).toHaveLength(3)
    expect(discovery.files.some((file) => file.scope === 'parent' && file.name === 'AGENTS.md')).toBe(true)
    expect(discovery.files.some((file) => file.scope === 'user' && file.name === 'CLAUDE.md')).toBe(true)
    const agents = discovery.text.indexOf('PROJECT-AGENTS')
    const claude = discovery.text.indexOf('PROJECT-CLAUDE')
    const parent = discovery.text.indexOf('PARENT-RULE')
    const user = discovery.text.indexOf('USER-CLAUDE')
    expect(agents).toBeGreaterThan(-1)
    expect(agents).toBeLessThan(claude)
    expect(claude).toBeLessThan(parent)
    expect(parent).toBeLessThan(user)
    expect(discovery.text).toContain('安全边界与用户当前指令优先')
  })

  it('truncates rules that exceed the token budget', () => {
    const root = temp()
    const workspace = join(root, 'repo')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'AGENTS.md'), 'A'.repeat(20_000), 'utf8')
    const discovery = discoverAgentRules(workspace, { homeDir: join(root, 'home'), maxTokens: 300 })
    expect(discovery.truncated).toBe(true)
    expect(discovery.usedTokens).toBeLessThanOrEqual(discovery.limitTokens)
    expect(discovery.files[0].truncated).toBe(true)
    expect(discovery.text).toContain('已按规则预算截断')
  })

  it('returns empty text when no rule files exist', () => {
    const root = temp()
    expect(discoverAgentRules(root, { homeDir: join(root, 'home') }).text).toBe('')
  })

  it('discovers MORROW.md in .morrow, parent and user scopes in priority order', () => {
    const root = temp()
    const workspace = join(root, 'repo')
    const home = join(root, 'home')
    mkdirSync(join(workspace, '.morrow'), { recursive: true })
    mkdirSync(join(home, '.morrow'), { recursive: true })
    writeFileSync(join(workspace, '.morrow', 'MORROW.md'), 'DOT-MORROW', 'utf8')
    writeFileSync(join(workspace, 'AGENTS.md'), 'ROOT-AGENTS', 'utf8')
    writeFileSync(join(root, 'MORROW.md'), 'PARENT-MORROW', 'utf8')
    writeFileSync(join(home, '.morrow', 'MORROW.md'), 'USER-MORROW', 'utf8')

    const discovery = discoverAgentRules(workspace, { homeDir: home })
    const order = ['DOT-MORROW', 'ROOT-AGENTS', 'PARENT-MORROW', 'USER-MORROW'].map((marker) =>
      discovery.text.indexOf(marker)
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('skips binary rule files instead of injecting replacement characters', () => {
    const root = temp()
    const workspace = join(root, 'repo')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'AGENTS.md'), Buffer.from([0x41, 0x00, 0x42, 0x43]))
    const discovery = discoverAgentRules(workspace, { homeDir: join(root, 'home') })
    expect(discovery.files).toHaveLength(0)
    expect(discovery.text).toBe('')
  })

  it('does not follow rule symlinks outside the workspace', () => {
    const root = temp()
    const workspace = join(root, 'repo')
    mkdirSync(workspace, { recursive: true })
    const secret = join(root, 'secret.md')
    writeFileSync(secret, 'TOP-SECRET', 'utf8')
    const link = join(workspace, 'AGENTS.md')
    try {
      symlinkSync(secret, link, 'file')
    } catch {
      return // 当前环境不允许创建符号链接时跳过
    }
    expect(discoverAgentRules(workspace, { homeDir: join(root, 'home') }).text).not.toContain('TOP-SECRET')

    // 指向工作区内部的链接仍然可用
    rmSync(link)
    const inside = join(workspace, 'real-rules.md')
    writeFileSync(inside, 'IN-WORKSPACE-RULES', 'utf8')
    symlinkSync(inside, link, 'file')
    expect(discoverAgentRules(workspace, { homeDir: join(root, 'home') }).text).toContain('IN-WORKSPACE-RULES')
  })
})
