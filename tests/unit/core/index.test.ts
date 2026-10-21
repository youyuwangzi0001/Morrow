/**
 * 公共出口契约测试：主进程只会 import src/core/index.ts，
 * 这里逐个确认 Lead 集成契约里要求的导出都存在且形状正确。
 */
import { describe, expect, it } from 'vitest'
import * as core from '../../../src/core/index'

describe('src/core/index 公共出口契约', () => {
  it('导出 runAgent / createProvider / testProviderConnection / buildSystemPrompt / estimateTokens', () => {
    expect(core.runAgent).toBeTypeOf('function')
    expect(core.createProvider).toBeTypeOf('function')
    expect(core.testProviderConnection).toBeTypeOf('function')
    expect(core.buildSystemPrompt).toBeTypeOf('function')
    expect(core.estimateTokens).toBeTypeOf('function')
    expect(core.compactSession).toBeTypeOf('function')
    // R6 Goal 模式导出
    expect(core.toolDefinitionsForRun).toBeTypeOf('function')
    expect(core.GOAL_TOOL_DEFINITION.name).toBe('update_goal')
    expect(core.toolDefinitionsForRun(true).some((tool) => tool.name === 'update_goal')).toBe(true)
    expect(core.toolDefinitionsForRun(false).some((tool) => tool.name === 'update_goal')).toBe(false)
    expect(core.buildGoalPromptSection).toBeTypeOf('function')
    expect(core.estimateTokens('你好')).toBe(2)
  })

  it('buildSystemPrompt 不传 tools 时默认列出全部内置工具（主进程集成兼容）', () => {
    const prompt = core.buildSystemPrompt({ workspace: 'C:\\demo' })
    expect(prompt).toContain('read_file')
    expect(prompt).toContain('run_command')
    expect(prompt).not.toContain('本次没有可用工具')
  })

  it('TOOL_DEFINITIONS 覆盖全部内置工具且 schema 完整', () => {
    const names = core.TOOL_DEFINITIONS.map((tool) => tool.name)
    expect(names).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'list_dir',
      'read_pdf',
      'read_docx',
      'edit_docx',
      'read_xlsx',
      'write_xlsx',
      'read_pptx',
      'glob',
      'grep',
      'run_command',
      'list_skills',
      'read_skill',
      'todo_write',
      'ask_user',
      'remember',
      'task',
      'swarm',
      'open_artifact',
      'web_search',
      'web_fetch',
      'terminal',
      'mcp_list',
      'mcp_call',
      'mcp_resources',
      'mcp_prompt',
      'browser_open',
      'browser_click',
      'browser_type',
      'browser_read',
      'browser_screenshot',
      'browser_back',
      'browser_forward',
      'computer_screenshot',
      'computer_click',
      'computer_type',
      'computer_key'
    ])
    for (const tool of core.TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.parameters).toMatchObject({ type: 'object' })
      expect(['read', 'write', 'exec', 'meta']).toContain(tool.category)
      expect(typeof tool.titleFor).toBe('function')
      expect(tool.titleFor({ path: 'a.txt', command: 'ls' })).toBeTruthy()
    }
    // write_file 支持 append 分段写入（大产物分步写）
    const writeFileDef = core.TOOL_DEFINITIONS.find((tool) => tool.name === 'write_file')
    expect(writeFileDef?.parameters).toMatchObject({ type: 'object', properties: { append: { type: 'boolean' } } })
    expect(writeFileDef?.titleFor({ path: 'a.html', append: true })).toContain('追加')

    // 子代理只读工具集
    expect(core.READ_ONLY_TOOL_DEFINITIONS.every((tool) => tool.category === 'read')).toBe(true)
    expect(core.READ_ONLY_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_dir',
      'read_pdf',
      'read_docx',
      'read_xlsx',
      'read_pptx',
      'glob',
      'grep',
      'list_skills',
      'read_skill'
    ])
  })

  it('系统提示词包含中文规范、权限说明与只读子代理提示', () => {
    const prompt = core.buildSystemPrompt({
      workspace: 'C:\\demo',
      permissionMode: 'ask',
      projectMemory: '用户喜欢表格',
      tools: core.TOOL_DEFINITIONS,
      date: new Date('2026-10-19T00:00:00+08:00')
    })
    expect(prompt).toContain('Morrow')
    expect(prompt).toContain('简体中文')
    expect(prompt).toContain('询问模式')
    expect(prompt).toContain('用户喜欢表格')
    expect(prompt).toContain('C:\\demo')
    // 子代理与主代理同权限，主提示词不能再声称子代理只读
    expect(prompt).toContain('与主代理同权限')
    expect(prompt).not.toContain('它只能只读')
  })

  it('权限与工具元信息可用于主进程 UI', () => {
    const readTarget: core.PermissionTarget = {
      toolName: 'read_file',
      category: 'read',
      baseRisk: 'low',
      input: { path: 'a.txt' },
      title: '读取 a.txt'
    }
    expect(core.evaluatePermission(readTarget, { mode: 'read-only', workspace: null, isDemo: false, sessionGrants: new Set() })).toEqual({
      action: 'allow'
    })
    expect(core.toolCategory('run_command')).toBe('exec')
    expect(core.toolRiskFor('run_command', { command: 'shutdown /s' })).toBe('high')
    expect(core.toolTitleFor('write_file', { path: '报告.html' })).toContain('报告.html')
    expect(core.isKnownTool('read_file')).toBe(true)
    expect(core.isKnownTool('nope')).toBe(false)
  })
})
