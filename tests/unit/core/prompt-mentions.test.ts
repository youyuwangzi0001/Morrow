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

  it('工作模式把视觉审美作为硬指标，并要求读取艺术指导技能', () => {
    const prompt = buildSystemPrompt({ workspace: 'C:\\work', permissionMode: 'auto', mode: 'work' })
    expect(prompt).toContain('## 视觉成品（网页 / 游戏 / 海报 / 界面）')
    expect(prompt).toContain('frontend-art-direction')
    expect(prompt).toContain('多轮视觉打磨')
    expect(prompt).toContain('只有本轮马上给出最终答复时才把全部步骤标为 completed')
  })

  it('工作模式注入当前终端，避免用户选 cmd/Git Bash 时仍写 PowerShell', () => {
    const prompt = buildSystemPrompt({
      workspace: 'C:\\work',
      permissionMode: 'auto',
      mode: 'work',
      terminalShell: { id: 'gitbash', label: 'Git Bash' }
    })
    expect(prompt).toContain('默认终端：Git Bash')
    expect(prompt).toContain('run_command、terminal(run/start) 与终端面板都使用它')
    expect(prompt).toContain('POSIX/bash')
    expect(prompt).toContain('不要假设永远是 PowerShell')
  })

  it('工作模式注入跨类型质量门槛，且与具体模型无关', () => {
    const prompt = buildSystemPrompt({ workspace: 'C:\\work', permissionMode: 'auto', mode: 'work' })
    expect(prompt).toContain('## 交付质量（全类型）')
    expect(prompt).toContain('deliverable-quality')
    expect(prompt).toContain('不要依赖某个模型的特殊标记')
    expect(prompt).toContain('文档/报告/幻灯片')
    expect(prompt).toContain('表格/数据')
    for (const modelLabel of ['DeepSeek V4', 'Claude', 'GPT', 'Kimi']) {
      const forModel = buildSystemPrompt({
        workspace: 'C:\\work',
        permissionMode: 'auto',
        mode: 'work',
        modelLabel
      })
      expect(forModel).toContain('## 交付质量（全类型）')
      expect(forModel).toContain('deliverable-quality')
    }
  })
})
