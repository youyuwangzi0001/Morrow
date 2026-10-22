/**
 * R9 / R2-A：Office 文档写工具的审批签名必须绑定「路径 + 内容/替换参数」。
 * R12 权限档位调整后，工作区内写入在「询问」档直接执行；签名仍用于记录/规则，
 * 不能变成跨路径/跨内容的通用通行证。
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
      expect(first).not.toContain('default')
      expect(first.replace(/\\/g, '/')).toContain('out/approved.xlsx'.toLowerCase())
    })

    it('询问档下工作区内的 Office 写入直接执行，签名仍随内容变化', () => {
      const ctx = policy(ws.root, 'ask')
      expect(evaluatePermission(target('write_xlsx', base), ctx).action).toBe('allow')
      const changed = evaluatePermission(
        target('write_xlsx', { ...base, sheets: [{ name: 'S', rows: [['A1', 'UNAPPROVED']] }] }),
        ctx
      )
      expect(changed.action).toBe('allow')
      expect(permissionSignature(target('write_xlsx', { ...base }), ctx)).not.toBe(
        permissionSignature(target('write_xlsx', { ...base, path: 'out/other.xlsx' }), ctx)
      )
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
    it('换输出路径 / 换替换文字 / 换输入文档的签名都不同', () => {
      const ctx = policy(ws.root, 'ask')
      const signature = permissionSignature(target('edit_docx', base), ctx)
      expect(signature.replace(/\\/g, '/')).toContain('out/approved.docx'.toLowerCase())
      expect(permissionSignature(target('edit_docx', base), ctx)).toBe(signature)
      expect(permissionSignature(target('edit_docx', { ...base, output_path: 'out/other.docx' }), ctx)).not.toBe(signature)
      expect(
        permissionSignature(target('edit_docx', { ...base, replacements: [{ find: '{{NAME}}', replace: '乙' }] }), ctx)
      ).not.toBe(signature)
      expect(permissionSignature(target('edit_docx', { ...base, path: 'in/other.docx' }), ctx)).not.toBe(signature)
    })

    it('询问档下工作区内 edit_docx 直接执行', () => {
      expect(evaluatePermission(target('edit_docx', base), policy(ws.root, 'ask')).action).toBe('allow')
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
