import { describe, expect, it } from 'vitest'
import { phoneArtifact, phoneMessage, toPhoneEvent } from '../../src/main/phone-events'
import type { Artifact, ChatMessage, RuntimeEvent } from '../../src/shared/types'

/**
 * 手机下行的裁剪规则。
 *
 * 这些用例守的不是“能不能转发”，而是**不该转发的东西有没有被拦住**：
 * 工具输出、审批参数、产物正文、附件。它们体积大且与手机展示无关，
 * 一旦泄漏到下行帧，会让手机白耗流量，也会把桌面端本不该离机的
 * 命令原文/文件内容送到另一台设备上。
 */

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

  it('@core:relay 消息 content 转成手机可读正文', () => {
    const phone = toPhoneEvent(event({ type: 'message_completed', messageId: 'm-1', message: message('你好，世界') }))
    const payload = phone?.message as Record<string, unknown>
    expect(payload.text).toBe('你好，世界')
    expect(payload.role).toBe('assistant')
    expect(payload.createdAt).toBe(AT)
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