import { describe, expect, it } from 'vitest'
import { TOOL_DEFINITIONS, getToolDefinition, isReadOnlyTool } from '../../../src/core/tools/registry'

describe('创作台 Agent 工具注册', () => {
  it('注册 11 个创作动作，并保持只读边界', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name)
    for (const name of [
      'studio_project',
      'studio_create',
      'studio_blueprint',
      'studio_write',
      'studio_storyboard',
      'studio_media',
      'studio_timeline',
      'studio_edit',
      'studio_review',
      'studio_render',
      'studio_export'
    ]) {
      expect(names).toContain(name)
    }
    expect(isReadOnlyTool('studio_project')).toBe(true)
    expect(isReadOnlyTool('studio_review')).toBe(true)
    expect(isReadOnlyTool('studio_write')).toBe(false)
    expect(isReadOnlyTool('studio_media')).toBe(false)
    expect(getToolDefinition('studio_render')?.risk).toBe('medium')
    expect(getToolDefinition('studio_media')?.risk).toBe('high')
  })

  it('创作动作的 schema 明确 projectId 与动作类型', () => {
    const create = getToolDefinition('studio_create')
    expect(create?.parameters).toMatchObject({ required: ['kind', 'logline'] })
    const media = getToolDefinition('studio_media')
    expect(media?.parameters).toMatchObject({ required: ['projectId', 'action'] })
    const blueprint = getToolDefinition('studio_blueprint')
    expect(blueprint?.parameters).toMatchObject({ required: ['projectId', 'action'] })
    const edit = getToolDefinition('studio_edit')
    expect(edit?.parameters).toMatchObject({ required: ['projectId'] })
  })
})
