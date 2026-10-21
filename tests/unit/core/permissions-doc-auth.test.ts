/**
 * R9 / R2-A：Office 文档写工具的审批签名必须绑定「路径 + 内容/替换参数」。
 * 一次批准不能变成后续换文件/换内容的通行证。
 */
import { describe, expect, it } from 'vitest'
import type { PermissionPolicyContext, PermissionTarget } from '../../../src/core/permissions'
import { evaluatePermission, permissionSignature } from '../../../src/core/permissions'
import { makeTempWorkspace } from './helpers/workspace'

function target(toolName: string, input: Record<string, unknown>): PermissionTarget {
  return { toolName, category: 'write', baseRisk: 'medium', input, title: toolName }
}

function policy(workspace: string, mode: PermissionPolicyContext['mode']): PermissionPolicyContext {
  return { mode, workspace, isDemo: false, sessionGrants: new Set() }
}

describe('R2-A：write_xlsx 审批签名绑定路径与内容', () => {
  const ws = makeTempWorkspace()
  const base = {
    path: 'out/approved.xlsx',
    sheets: [{ name: 'S', rows: [['A1', 'APPROVED']] }]
  }
  try {
    it('同路径同内容签名稳定；换路径/换内容签名不同', () => {
      const first = permissionSignature(target('write_xlsx', base), policy(ws.root, 'ask'))
      expect(permissionSignature(target('write_xlsx', { ...base }), policy(ws.root, 'ask'))).toBe(first)
      const otherPath = permissionSignature(
        target('write_xlsx', { ...base, path: 'out/other.xlsx' }),
        policy(ws.root, 'ask')
      )
      expect(otherPath).not.toBe(first)
      const otherContent = permissionSignature(
        target('write_xlsx', { ...base, sheets: [{ name: 'S', rows: [['A1', 'UNAPPROVED']] }] }),
        policy(ws.root, 'ask')
      )
      expect(otherContent).not.toBe(first)
      // 不再落到 `write_xlsx:default` 这种全工具通行证
      expect(first).not.toContain('default')
      expect(first.replace(/\\/g, '/')).toContain('out/approved.xlsx'.toLowerCase())
    })

    it('ask 模式下：「始终允许」只对完全相同的路径+内容生效，换内容必须重新审批', () => {
      const ctx = policy(ws.root, 'ask')
      const first = evaluatePermission(target('write_xlsx', base), ctx)
      expect(first.action).toBe('ask')
      if (first.action !== 'ask') return
      ctx.sessionGrants = new Set([first.signature])
      // 完全相同 → 复用
      expect(evaluatePermission(target('write_xlsx', { ...base }), ctx)).toEqual({ action: 'allow' })
      // 换内容 → 重新审批
      const changed = evaluatePermission(
        target('write_xlsx', { ...base, sheets: [{ name: 'S', rows: [['A1', 'UNAPPROVED']] }] }),
        ctx
      )
      expect(changed.action).toBe('ask')
      // 换路径 → 重新审批
      expect(evaluatePermission(target('write_xlsx', { ...base, path: 'out/other.xlsx' }), ctx).action).toBe('ask')
    })
  } finally {
    ws.cleanup()
  }
})

describe('R2-A：edit_docx 审批签名绑定输入/输出路径与替换参数', () => {
  const ws = makeTempWorkspace({ 'in/template.docx': 'fake' })
  const base = {
    path: 'in/template.docx',
    output_path: 'out/approved.docx',
    replacements: [{ find: '{{NAME}}', replace: '甲' }]
  }
  try {
    it('换输出路径 / 换替换文字 / 换输入文档都必须重新审批', () => {
      const ctx = policy(ws.root, 'ask')
      const first = evaluatePermission(target('edit_docx', base), ctx)
      expect(first.action).toBe('ask')
      if (first.action !== 'ask') return
      const signature = first.signature
      expect(signature.replace(/\\/g, '/')).toContain('out/approved.docx'.toLowerCase())
      ctx.sessionGrants = new Set([signature])
      expect(evaluatePermission(target('edit_docx', { ...base }), ctx)).toEqual({ action: 'allow' })

      const otherOutput = evaluatePermission(
        target('edit_docx', { ...base, output_path: 'out/other.docx' }),
        ctx
      )
      expect(otherOutput.action).toBe('ask')
      const otherReplace = evaluatePermission(
        target('edit_docx', { ...base, replacements: [{ find: '{{NAME}}', replace: '乙' }] }),
        ctx
      )
      expect(otherReplace.action).toBe('ask')
      // 输入文档变化（输出相同）也必须重新审批
      const otherInput = evaluatePermission(target('edit_docx', { ...base, path: 'in/other.docx' }), ctx)
      expect(otherInput.action).toBe('ask')
    })

    it('输出路径与输入路径同样参与签名（防止改名复用）', () => {
      const a = permissionSignature(target('edit_docx', base), policy(ws.root, 'ask'))
      const b = permissionSignature(target('edit_docx', { ...base, output_path: 'out/b.docx' }), policy(ws.root, 'ask'))
      const c = permissionSignature(target('edit_docx', { ...base, path: 'in/b.docx' }), policy(ws.root, 'ask'))
      expect(new Set([a, b, c]).size).toBe(3)
    })
  } finally {
    ws.cleanup()
  }
})
