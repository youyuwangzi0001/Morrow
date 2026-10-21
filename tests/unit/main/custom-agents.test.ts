import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_AGENT_ROLES } from '../../../src/core/agent-roles'
import { loadAgentRoles, parseAgentFile, summarizeAgentRoles } from '../../../src/main/services/custom-agents'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('自定义子代理角色', () => {
  it('解析 frontmatter：标题、工具白名单与只读标记', () => {
    const role = parseAgentFile(
      `---
title: 安全审计
description: 只读审计安全边界
tools: read_file, grep, glob
read-only: true
---
你只检查安全问题。`,
      'security',
      'project',
      'x.md'
    )
    expect(role).toMatchObject({
      name: 'security',
      title: '安全审计',
      description: '只读审计安全边界',
      tools: ['read_file', 'grep', 'glob'],
      readOnly: true,
      source: 'project'
    })
    expect(role?.systemPrompt).toContain('只检查安全问题')
    expect(parseAgentFile('---\ntitle: 空\n---\n', 'empty', 'user', 'x.md')).toBeNull()

    // 工具名统一小写去重；显式空 tools 表示不允许任何工具，而不是退化成全部工具
    const normalized = parseAgentFile('---\ntools: Read_File, read_file, GREP\n---\n只分析。', 'readonly-role', 'user', 'x.md')
    expect(normalized?.tools).toEqual(['read_file', 'grep'])
    const noTools = parseAgentFile('---\ntools:\n---\n只分析。', 'no-tools', 'user', 'x.md')
    expect(noTools?.tools).toEqual([])
    const readOnly = parseAgentFile('---\nreadonly: TRUE\n---\n只读。', 'ro', 'user', 'x.md')
    expect(readOnly?.readOnly).toBe(true)
  })

  it('达到 32 个角色上限后，项目角色仍可覆盖同名用户角色', () => {
    const home = tempDir('morrow-agents-cap-home-')
    const workspace = tempDir('morrow-agents-cap-ws-')
    const homeDir = join(home, '.morrow', 'agents')
    const projectDir = join(workspace, '.morrow', 'agents')
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    for (let index = 0; index < 32; index += 1) {
      const name = index === 0 ? 'audit' : `role-${String(index).padStart(3, '0')}`
      writeFileSync(join(homeDir, `${name}.md`), `用户级 ${name}\n`, 'utf8')
    }
    writeFileSync(join(projectDir, 'audit.md'), '项目级覆盖\n', 'utf8')
    writeFileSync(join(projectDir, 'extra.md'), '超出上限\n', 'utf8')

    const roles = loadAgentRoles(workspace, home)
    const custom = roles.filter((role) => role.source !== 'builtin')
    expect(custom).toHaveLength(32)
    expect(custom.find((role) => role.name === 'audit')?.systemPrompt).toContain('项目级')
    expect(roles.some((role) => role.name === 'extra')).toBe(false)
  })

  it('拒绝通过链接到工作区外的 .morrow 读取项目角色', () => {
    const home = tempDir('morrow-agents-link-home-')
    const workspace = tempDir('morrow-agents-link-ws-')
    const outside = tempDir('morrow-agents-link-out-')
    mkdirSync(join(outside, 'agents'), { recursive: true })
    writeFileSync(join(outside, 'agents', 'leak.md'), '工作区外角色\n', 'utf8')
    symlinkSync(outside, join(workspace, '.morrow'), 'junction')

    const roles = loadAgentRoles(workspace, home)
    expect(roles.filter((role) => role.source !== 'builtin')).toHaveLength(0)
  })

  it('内置角色始终存在；项目角色覆盖同名用户角色；内置名不可覆盖', () => {
    const home = tempDir('morrow-agents-home-')
    const workspace = tempDir('morrow-agents-ws-')
    mkdirSync(join(home, '.morrow', 'agents'), { recursive: true })
    mkdirSync(join(workspace, '.morrow', 'agents'), { recursive: true })
    writeFileSync(join(home, '.morrow', 'agents', 'audit.md'), '用户级审计\n', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'agents', 'audit.md'), '项目级审计\n', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'agents', 'review.md'), '试图覆盖内置 review\n', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'agents', 'bad name.md'), '忽略\n', 'utf8')

    const roles = loadAgentRoles(workspace, home)
    expect(roles.filter((role) => role.name === 'audit')).toHaveLength(1)
    expect(roles.find((role) => role.name === 'audit')?.systemPrompt).toContain('项目级')
    const review = roles.find((role) => role.name === 'review')
    expect(review?.source).toBe('builtin')
    expect(review?.title).toBe(BUILTIN_AGENT_ROLES.find((role) => role.name === 'review')?.title)

    const summary = summarizeAgentRoles(roles)
    expect(summary.find((role) => role.name === 'audit')).toMatchObject({ source: 'project', readOnly: false })
    expect(summary.map((role) => role.name)).toEqual(expect.arrayContaining(['general', 'explore', 'plan', 'review', 'test', 'docs', 'audit']))
  })
})
