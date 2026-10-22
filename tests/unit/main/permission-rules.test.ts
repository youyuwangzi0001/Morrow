/**
 * P1-10 权限规则：持久化 CRUD、匹配语义、deny 优先、allow 不越过危险命令/外部动作。
 */
import { readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PermissionRulesService } from '../../../src/main/services/permission-rules'
import {
  evaluatePermission,
  permissionRuleMatches,
  type PermissionPolicyContext,
  type PermissionTarget
} from '../../../src/core/permissions'
import { makeTempDir, makeTempWorkspace } from '../core/helpers/workspace'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function service(): PermissionRulesService {
  const dir = makeTempDir('morrow-perm-')
  dirs.push(dir)
  return new PermissionRulesService(dir)
}

function target(toolName: string, category: PermissionTarget['category'], input: Record<string, unknown>): PermissionTarget {
  return { toolName, category, baseRisk: category === 'read' ? 'low' : 'medium', input, title: toolName }
}

function policy(workspace: string, rules: ReturnType<PermissionRulesService['list']>): PermissionPolicyContext {
  return { mode: 'ask', workspace, isDemo: false, sessionGrants: new Set(), workspaceRules: rules }
}

describe('PermissionRulesService', () => {
  it('persists workspace rules and logs approvals', () => {
    const dir = makeTempDir('morrow-perm-persist-')
    dirs.push(dir)
    const ws = makeTempWorkspace()
    try {
      const first = new PermissionRulesService(dir)
      first.add({ workspace: ws.root, tool: 'run_command', kind: 'prefix', pattern: 'npm test', decision: 'allow' })
      const second = new PermissionRulesService(dir)
      const rules = second.list(ws.root)
      expect(rules).toHaveLength(1)
      expect(rules[0]).toMatchObject({ tool: 'run_command', kind: 'prefix', pattern: 'npm test', decision: 'allow' })

      second.appendLog({
        at: Date.now(),
        workspace: ws.root,
        sessionId: 's_test',
        toolName: 'write_file',
        title: '写入 out/a.txt',
        decision: 'once'
      })
      const log = second.listLog(ws.root)
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ toolName: 'write_file', decision: 'once' })
    } finally {
      ws.cleanup()
    }
  })

  it('stores whole-tool rules without a pattern and dedupes identical rules', () => {
    const rules = service()
    const ws = makeTempWorkspace()
    try {
      const first = rules.add({
        workspace: ws.root,
        tool: 'run_command',
        kind: 'tool',
        pattern: 'ignored',
        decision: 'allow'
      })
      expect(first.pattern).toBe('')
      const again = rules.add({
        workspace: ws.root,
        tool: 'run_command',
        kind: 'tool',
        pattern: '',
        decision: 'allow'
      })
      expect(again.id).toBe(first.id)
      expect(rules.list(ws.root)).toHaveLength(1)
    } finally {
      ws.cleanup()
    }
  })

  it('canonicalizes symlinked workspace paths so UI and runtime see the same rules', () => {
    const rules = service()
    const ws = makeTempWorkspace()
    const base = makeTempDir('morrow-perm-link-')
    dirs.push(base)
    const link = join(base, 'ws-link')
    try {
      symlinkSync(ws.root, link, process.platform === 'win32' ? 'junction' : 'dir')
      const created = rules.add({
        workspace: link,
        tool: 'write_file',
        kind: 'path',
        pattern: 'out',
        decision: 'allow'
      })
      expect(rules.list(ws.root).map((rule) => rule.id)).toContain(created.id)
    } finally {
      ws.cleanup()
    }
  })

  it('scopes rule deletion to the requesting workspace', () => {
    const rules = service()
    const a = makeTempWorkspace()
    const b = makeTempWorkspace()
    try {
      const rule = rules.add({
        workspace: a.root,
        tool: 'run_command',
        kind: 'prefix',
        pattern: 'npm test',
        decision: 'allow'
      })
      expect(rules.remove(rule.id, b.root)).toBe(false)
      expect(rules.list(a.root)).toHaveLength(1)
      expect(rules.remove(rule.id, a.root)).toBe(true)
      expect(rules.list(a.root)).toHaveLength(0)
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  it('persists edit_docx always-allow rules against the output path', () => {
    const rules = service()
    const ws = makeTempWorkspace()
    try {
      const rule = rules.addAlwaysRule({
        workspace: ws.root,
        tool: 'edit_docx',
        toolInput: { path: 'templates/in.docx', output_path: 'out/final.docx' }
      })
      expect(rule?.pattern).toBe('out/final.docx')
      const ctx = policy(ws.root, rules.list(ws.root))
      const edit = target('edit_docx', 'write', { path: 'templates/in.docx', output_path: 'out/final.docx' })
      expect(permissionRuleMatches(rule!, edit, ctx)).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('backs up a corrupt rules file instead of silently overwriting it', () => {
    const dir = makeTempDir('morrow-perm-corrupt-')
    dirs.push(dir)
    const ws = makeTempWorkspace()
    try {
      writeFileSync(join(dir, 'permissions.json'), '{not json', 'utf8')
      const rules = new PermissionRulesService(dir)
      expect(rules.list(ws.root)).toEqual([])
      expect(readdirSync(dir).some((name) => name.startsWith('permissions.json.corrupt-'))).toBe(true)
    } finally {
      ws.cleanup()
    }
  })
})

describe('permission rules in evaluatePermission', () => {
  it('allows matching command prefixes and denies deny rules with higher priority', () => {
    const ws = makeTempWorkspace()
    try {
      const rules = [
        {
          id: 'r1',
          workspace: ws.root,
          tool: 'run_command',
          kind: 'prefix' as const,
          pattern: 'npm test',
          decision: 'allow' as const,
          createdAt: Date.now()
        },
        {
          id: 'r2',
          workspace: ws.root,
          tool: 'run_command',
          kind: 'prefix' as const,
          pattern: 'git push',
          decision: 'deny' as const,
          createdAt: Date.now()
        }
      ]
      const ctx = policy(ws.root, rules)
      const npm = target('run_command', 'exec', { command: 'npm test -- --runInBand' })
      expect(permissionRuleMatches(rules[0], npm, ctx)).toBe(true)
      expect(evaluatePermission(npm, ctx).action).toBe('allow')
      expect(permissionRuleMatches(rules[0], target('run_command', 'exec', { command: 'npm run build' }), ctx)).toBe(false)
      // 前缀必须有 token 边界，不能把「npm test」的授权扩散到「npm testing」或拼接命令
      expect(permissionRuleMatches(rules[0], target('run_command', 'exec', { command: 'npm testing' }), ctx)).toBe(false)
      expect(permissionRuleMatches(rules[0], target('run_command', 'exec', { command: 'npm test&&npm run build' }), ctx)).toBe(false)
      expect(permissionRuleMatches(rules[0], target('run_command', 'exec', { command: 'npm test\nnpm run build' }), ctx)).toBe(false)
      expect(permissionRuleMatches(rules[0], target('run_command', 'exec', { command: 'npm test ; npm run build' }), ctx)).toBe(false)
      expect(evaluatePermission(target('run_command', 'exec', { command: 'git push origin main' }), ctx).action).toBe('deny')
    } finally {
      ws.cleanup()
    }
  })

  it('allows path prefixes but never overrides dangerous commands or external actions', () => {
    const ws = makeTempWorkspace()
    try {
      const rules = [
        {
          id: 'r1',
          workspace: ws.root,
          tool: 'write_file',
          kind: 'path' as const,
          pattern: 'out',
          decision: 'allow' as const,
          createdAt: Date.now()
        },
        {
          id: 'r2',
          workspace: ws.root,
          tool: 'run_command',
          kind: 'prefix' as const,
          pattern: 'rm -rf',
          decision: 'allow' as const,
          createdAt: Date.now()
        },
        {
          id: 'r3',
          workspace: ws.root,
          tool: 'web_fetch',
          kind: 'tool' as const,
          pattern: '',
          decision: 'allow' as const,
          createdAt: Date.now()
        }
      ]
      const ctx = policy(ws.root, rules)
      expect(evaluatePermission(target('write_file', 'write', { path: 'out/a.txt', content: 'x' }), ctx).action).toBe('allow')
      expect(evaluatePermission(target('write_file', 'write', { path: 'src/a.ts', content: 'x' }), ctx).action).toBe('allow')
      expect(permissionRuleMatches(rules[0], target('write_file', 'write', { path: 'src/a.ts', content: 'x' }), ctx)).toBe(false)
      expect(evaluatePermission(target('run_command', 'exec', { command: 'rm -rf out' }), ctx).action).toBe('ask')
      expect(evaluatePermission(target('web_fetch', 'exec', { url: 'https://example.com' }), ctx).action).toBe('ask')
    } finally {
      ws.cleanup()
    }
  })
})
