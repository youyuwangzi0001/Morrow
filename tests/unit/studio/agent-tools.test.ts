import { describe, expect, it, vi } from 'vitest'
import { runStudioAgentTool, type StudioAgentFacade } from '../../../src/main/studio/agent-tools'
import type { StudioActionResult, StudioJob, StudioProject } from '../../../src/shared/studio'
import { emptyCanvas, emptyStageStates, emptyTimeline, STUDIO_SCHEMA_VERSION } from '../../../src/shared/studio'

function project(overrides: Partial<StudioProject> = {}): StudioProject {
  const now = Date.now()
  return {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    id: 'proj_test_1',
    kind: 'novel',
    title: '测试长篇',
    logline: '一句话',
    brief: { form: '速成草稿', genre: '都市', audience: '', tone: '', style: '', aspect: '16:9', constraints: [], references: [] },
    createdAt: now,
    updatedAt: now,
    revision: 2,
    stage: 'writing',
    stages: emptyStageStates(now),
    styleBible: { look: '', palette: [], camera: '', sound: '', negative: [] },
    blueprint: null,
    volumes: [],
    chapters: [
      { id: 'ch1', volumeId: null, number: 1, title: '第一章', synopsis: '', beats: [], content: '已完成', wordTarget: 1000, status: 'done', revision: 1, candidates: [], versions: [], illustrations: [], locked: true, updatedAt: now },
      { id: 'ch2', volumeId: null, number: 2, title: '第二章', synopsis: '', beats: [], content: '', wordTarget: 1000, status: 'ready', revision: 1, candidates: [], versions: [], illustrations: [], locked: false, updatedAt: now }
    ],
    episodes: [],
    scenes: [],
    shots: [],
    characters: [],
    places: [],
    factions: [],
    rules: [],
    props: [],
    facts: [],
    assets: [],
    timeline: emptyTimeline('16:9', now),
    deliveries: [],
    jobs: [],
    messages: [],
    checks: [],
    canvas: emptyCanvas(now),
    runtime: { strategy: 'local-first', budget: { limit: 30, spent: 0, currency: 'CNY' }, updatedAt: now },
    coverAssetId: null,
    demo: false,
    ...overrides
  }
}

function job(): StudioJob {
  return {
    id: 'job_1', requestId: 'req_1', projectId: 'proj_test_1', kind: 'text', label: '写作', stage: 'writing',
    status: 'queued', progress: 0, message: '排队中', inputHash: 'x', attempts: 0, cost: null, outputs: [], createdAt: 1, updatedAt: 1
  }
}

describe('创作台 Agent 工具适配层', () => {
  it('读取作品列表与单作品摘要', async () => {
    const facade: StudioAgentFacade = {
      execute: vi.fn(async (request) => {
        if (request.type === 'list') {
          return { projects: [{ id: 'proj_test_1', title: '测试长篇', kind: 'novel', progress: 40 }], engine: {} }
        }
        if (request.type === 'get') {
          return { project: project() } as StudioActionResult
        }
        throw new Error('unexpected')
      })
    }
    const list = await runStudioAgentTool(facade, { action: 'project', subAction: 'list' })
    expect(list.summary).toContain('测试长篇')
    const get = await runStudioAgentTool(facade, { action: 'project', subAction: 'get', projectId: 'proj_test_1' })
    expect(get.summary).toContain('章节：2')
    expect(get.summary).toContain('总字数 3')
    expect((get.data as { chapters: Array<{ id: string }> }).chapters.map((chapter) => chapter.id)).toEqual(['ch1', 'ch2'])
  })

  it('写作动作自动选择第一章空章', async () => {
    const calls: Array<Record<string, unknown>> = []
    const facade: StudioAgentFacade = {
      execute: vi.fn(async (request) => {
        calls.push(request)
        if (request.type === 'get') return { project: project() } as StudioActionResult
        if (request.type === 'generate-chapter') return { project: project(), job: job() } as StudioActionResult
        throw new Error('unexpected')
      })
    }
    const result = await runStudioAgentTool(facade, { action: 'chapter', projectId: 'proj_test_1', useModel: false })
    expect(result.summary).toContain('第 2 章')
    expect(calls.find((call) => call.type === 'generate-chapter')?.chapterId).toBe('ch2')
  })

  it('媒体动作映射到正确的作品服务动作', async () => {
    const calls: Array<Record<string, unknown>> = []
    const facade: StudioAgentFacade = {
      execute: vi.fn(async (request) => {
        calls.push(request)
        if (request.type === 'get') return { project: project({ kind: 'drama' }) } as StudioActionResult
        return { project: project({ kind: 'drama' }), job: job() } as StudioActionResult
      })
    }
    await runStudioAgentTool(facade, { action: 'media', subAction: 'image', projectId: 'proj_test_1', shotId: 'shot_1' })
    await runStudioAgentTool(facade, { action: 'media', subAction: 'music', projectId: 'proj_test_1', mood: 'rain' })
    expect(calls.some((call) => call.type === 'generate-shot-image' && call.shotId === 'shot_1')).toBe(true)
    expect(calls.some((call) => call.type === 'generate-music' && call.kind === 'music')).toBe(true)
  })

  it('修改计划只返回 planId，不直接改作品', async () => {
    const facade: StudioAgentFacade = {
      execute: vi.fn(async (request) => {
        if (request.type === 'get') return { project: project() } as StudioActionResult
        if (request.type === 'assistant') {
          return { project: project(), plan: { id: 'plan_1', title: '正文改写计划', summary: '生成候选' } }
        }
        throw new Error('unexpected')
      })
    }
    const result = await runStudioAgentTool(facade, { action: 'edit', projectId: 'proj_test_1', instruction: '第 1 章更克制', selectionKind: 'chapter', selectionId: 'ch1' })
    expect(result.summary).toContain('尚未应用')
    expect(result.summary).toContain('plan_1')
  })

  it('缺少 projectId 时给出可执行提示', async () => {
    const facade: StudioAgentFacade = { execute: vi.fn(async () => ({ project: project() })) }
    await expect(runStudioAgentTool(facade, { action: 'chapter' })).rejects.toThrow('缺少 projectId')
  })
})
