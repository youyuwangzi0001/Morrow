import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../../../src/core/prompt'

describe('系统提示：@ 文件引用语义', () => {
  it('工作模式要求先 read_file 再回答，不能只看文件名猜测', () => {
    const prompt = buildSystemPrompt({ workspace: 'C:\\work', permissionMode: 'auto', mode: 'work' })
    expect(prompt).toContain('@相对路径')
    expect(prompt).toContain('read_file')
    expect(prompt).toContain('不要假装已经读过')
  })

  it('聊天模式（只读）同样识别 @ 引用', () => {
    const prompt = buildSystemPrompt({ workspace: 'C:\\work', permissionMode: 'auto', mode: 'chat' })
    expect(prompt).toContain('@相对路径')
    expect(prompt).toContain('read_file')
  })
})
