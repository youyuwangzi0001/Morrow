// studio-runtime 单元测试：由 10 个原测试文件合并；每个文件保留独立 describe 作用域。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { StudioAgentFacade } from '../../src/main/studio'
import { runStudioAgentTool, dramaQualityChecks, proseQualityChecks, synthesizeCloudSpeech, extractJson, auditCharacterVoices, storyboardChapterBatches, mergeReviewCoverage, chapterPrompt, novelReviewSegments, novelReviewBatches, novelReviewCoverage } from '../../src/main/studio'
import { creativeMasterSelection, resetCreativeMasterCache } from '../../src/main/creative-masters'
import type { StudioActionResult, StudioJob, StudioProject, StudioStatus } from '../../src/shared/studio'
import { emptyCanvas, emptyStageStates, emptyTimeline, STUDIO_SCHEMA_VERSION, STUDIO_STATUS_TRANSITIONS, canTransitionStudioStatus } from '../../src/shared/studio'
import { makeDramaProject, makeNovelProject, tempStore } from './studio-fixtures'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyUserDataForMigration, removeStudioLocation, resolveDefaultStudioRoot, resolveStudioDataRoot, writeStudioLocation } from '../../src/main/workspace'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { LARGE_DIFF_CHARS, candidateDiff, previewBrief } from '../../src/shared/types'
import { TOOL_DEFINITIONS, getToolDefinition, isReadOnlyTool } from '../../src/core/tools'

describe("agent-tools", () => {
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
  it('@core:studio-assistant 读取作品列表与单作品摘要', async () => {
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

  it('@core:studio-assistant 写作动作自动选择第一章空章', async () => {
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

  it('@core:studio-assistant 媒体动作映射到正确的作品服务动作', async () => {
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

  it('@core:studio-assistant 修改计划只返回 planId，不直接改作品', async () => {
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
})
})

describe("prompt-quality", () => {
describe('studio quality framework', () => {

  it('@core:studio-writing 把正文质检写进作品检查项', () => {
    const { store } = tempStore()
    const project = makeNovelProject(store)
    project.chapters[0].content = '她感到害怕，觉得眼前似乎有影子。突然，她意识到自己正在发抖，仿佛有什么东西在靠近。'.repeat(12)
    const checks = proseQualityChecks(project)
    expect(checks.some((check) => check.kind === 'quality' && check.level === 'warn' && check.title.includes('AI 腔'))).toBe(true)
  })

  it('@core:studio-drama 把漫剧镜头硬门禁写进作品检查项', () => {
    const { store } = tempStore()
    const project = makeDramaProject(store)
    project.shots[0].prompt = ''
    project.shots[1].shotSize = project.shots[0].shotSize
    const checks = dramaQualityChecks(project)
    expect(checks.some((check) => check.title.includes('镜头数量不足'))).toBe(true)
    expect(checks.some((check) => check.title.includes('没有画面提示词'))).toBe(true)
  })
})
describe('creative masters', () => {
  it('@core:studio-writing 小说写作走写作大师，剧本改编走编剧大师，漫剧分镜走导演大师', () => {
    resetCreativeMasterCache()
    expect(creativeMasterSelection({ kind: 'short', task: 'chapter' }).master).toBe('writing')
    expect(creativeMasterSelection({ kind: 'novel', task: 'outline' }).master).toBe('writing')
    expect(creativeMasterSelection({ kind: 'drama', task: 'adaptation' }).master).toBe('screenwriting')
    expect(creativeMasterSelection({ kind: 'drama', task: 'storyboard' }).master).toBe('directing')
    expect(creativeMasterSelection({ kind: 'drama', task: 'assistant', view: 'blueprint' }).master).toBe('screenwriting')
    expect(creativeMasterSelection({ kind: 'drama', task: 'assistant', view: 'music' }).master).toBe('directing')
  })
})
})

describe("data-dir", () => {
describe('创作台自定义数据目录', () => {
  const original = process.env.MORROW_STUDIO_LOCATION_FILE
  let root = ''
  let dataDir = ''
  let pointer = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'morrow-studio-dir-'))
    dataDir = join(root, 'agent-data')
    pointer = join(root, 'studio-location.json')
    process.env.MORROW_STUDIO_LOCATION_FILE = pointer
    mkdirSync(dataDir, { recursive: true })
  })

  afterEach(() => {
    if (original === undefined) delete process.env.MORROW_STUDIO_LOCATION_FILE
    else process.env.MORROW_STUDIO_LOCATION_FILE = original
    rmSync(root, { recursive: true, force: true })
  })

  it('@core:studio-storage 自定义目录不可用时回退默认；迁移复制作品文件且保留源目录', () => {
    const blocked = join(root, 'not-a-dir')
    writeFileSync(blocked, 'file')
    writeStudioLocation(blocked)
    expect(resolveStudioDataRoot(dataDir)).toBe(resolveDefaultStudioRoot(dataDir))

    const source = join(root, 'source-studio')
    const target = join(root, 'target-studio')
    mkdirSync(join(source, 'projects', 'p1'), { recursive: true })
    writeFileSync(join(source, 'projects', 'p1', 'project.json'), '{"title":"demo"}')
    writeFileSync(join(source, 'studio-index.json'), '{"projects":[]}')
    const copied = copyUserDataForMigration(source, target)
    expect(copied).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(target, 'studio-index.json'))).toBe(true)
    expect(existsSync(join(source, 'studio-index.json'))).toBe(true)
    removeStudioLocation()
  })
})
})

describe("cloud-tts", () => {
describe('云端配音', () => {
  let server: Server | null = null
  let dir = ''

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('@core:studio-media 向兼容 /audio/speech 的接口发送真实请求并写入音频', async () => {
    dir = mkdtempSync(join(tmpdir(), 'morrow-cloud-tts-'))
    let captured: Record<string, unknown> | null = null
    let auth = ''
    server = createServer((req, res) => {
      auth = String(req.headers.authorization ?? '')
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        captured = JSON.parse(body) as Record<string, unknown>
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
        res.end(Buffer.alloc(4096, 1))
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const output = join(dir, 'voice.mp3')
    await synthesizeCloudSpeech({
      text: '今天不修伞。',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'tts-1',
      voice: 'alloy',
      outputPath: output,
      workDir: dir
    })
    expect(existsSync(output)).toBe(true)
    expect(readFileSync(output).length).toBe(4096)
    expect(auth).toBe('Bearer sk-test')
    expect(captured).toMatchObject({ model: 'tts-1', input: '今天不修伞。', voice: 'alloy', response_format: 'mp3' })
  })

  it('@core:studio-media 接口报错时抛出包含状态码的信息', async () => {
    dir = mkdtempSync(join(tmpdir(), 'morrow-cloud-tts-'))
    server = createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid key' }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await expect(synthesizeCloudSpeech({
      text: '台词',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'bad',
      model: 'tts-1',
      voice: 'alloy',
      outputPath: join(dir, 'voice.mp3'),
      workDir: dir
    })).rejects.toThrow(/HTTP 401/)
  })
})
})

describe("text", () => {
describe('模型 JSON 容错', () => {

  it('@core:studio-models 修复键名漏写结尾引号与裸键名', () => {
    const text = '{"units":[{"index":1,"title":"第一班",summary:"他上了车",beats:["上车"],},]}'
    const parsed = extractJson<{ units: Array<{ title: string; beats: string[] }> }>(text)
    expect(parsed?.units[0]?.title).toBe('第一班')
    expect(parsed?.units[0]?.beats).toEqual(['上车'])
  })

  it('@core:studio-models 容忍围栏与前后说明', () => {
    const text = '说明：\n```json\n{"ok":true}\n```\n以上。'
    expect(extractJson<{ ok: boolean }>(text)?.ok).toBe(true)
  })
})
describe('大文本候选对照', () => {

  it('@core:studio-writing 超过 2 万字自动退到段落级，不生成逐字 diff', () => {
    const paragraph = '她把伞撑开，雨水沿着伞骨落下来。'
    const original = Array.from({ length: 1200 }, () => paragraph).join('\n\n')
    const next = `${original}\n\n她把灯关了。`
    expect(original.length).toBeGreaterThan(LARGE_DIFF_CHARS)
    const result = candidateDiff(original, next, 'chars')
    expect(result.degraded).toBe(true)
    expect(result.parts).toHaveLength(0)
    expect(result.paragraphs.length).toBeGreaterThan(0)
    expect(result.paragraphs.some((part) => part.added)).toBe(true)
  })
})
describe('brief preview', () => {
  it('@core:studio-models 从完整一句话里提取主角、欲望、阻力与转折', () => {
    const preview = previewBrief('一个雨夜，修伞的女孩捡到一把会倒着走时间的伞，她想找回失去的记忆，却发现每次修伞都会让外婆忘记她。', 'novel')
    expect(preview.subject).toContain('女孩')
    expect(preview.goal).toContain('找回')
    expect(preview.obstacle ?? preview.turn).toBeTruthy()
    expect(preview.confidence).toBe('high')
  })
})
})

describe("trash", () => {
describe('创作台回收站', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('@core:studio-storage 删除后进入回收站，可恢复，也可彻底删除', () => {
    const fixture = tempStore()
    dir = fixture.dir
    const store = fixture.store
    const project = store.newProject({
      kind: 'short',
      title: '回收站作品',
      logline: '只用来验证回收站',
      brief: { aspect: '16:9' }
    })
    store.save(project, '测试', { snapshot: false })
    store.deleteProject(project.id)
    expect(store.projectExists(project.id)).toBe(false)
    const listed = store.listTrash()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ projectId: project.id, title: '回收站作品', kind: 'short' })

    const restored = store.restoreTrash(listed[0].entry)
    expect(restored.id).toBe(project.id)
    expect(store.projectExists(project.id)).toBe(true)
    expect(store.listTrash()).toHaveLength(0)

    store.deleteProject(project.id)
    const again = store.listTrash()
    expect(again).toHaveLength(1)
    store.purgeTrash(again[0].entry)
    expect(store.listTrash()).toHaveLength(0)
    expect(store.projectExists(project.id)).toBe(false)
  })

  it('@core:studio-storage 拒绝越界条目名', () => {
    const fixture = tempStore()
    dir = fixture.dir
    expect(() => fixture.store.purgeTrash('not-a-valid-entry')).toThrow('回收站条目名称不合法')
  })
})
})

describe("voice-audit", () => {
describe('人物语气审稿', () => {

  it('@core:studio-writing 统计句长、问句与高频用语，并对语气趋同给出提醒', () => {
    const { store, dir } = tempStore()
    try {
      const project = makeNovelProject(store)
      project.characters = [
        { id: 'c1', name: '林晚', role: '主角', look: '', relationships: [], refAssetIds: [] },
        { id: 'c2', name: '老周', role: '配角', look: '', relationships: [], refAssetIds: [] }
      ]
      project.chapters[0].content = [
        '林晚说：“你说这把伞能倒着走时间？”',
        '林晚说：“你确定吗？你看见过吗？”',
        '林晚说：“你为什么不早说？”',
        '林晚说：“你到底是谁？”',
        '林晚说：“你能不能别卖关子？”',
        '老周说：“你确定吗？你看见过吗？”',
        '老周说：“你为什么不早说？”',
        '老周说：“你到底是谁？”',
        '老周说：“你能不能别卖关子？”',
        '老周说：“你说这把伞能倒着走时间？”'
      ].join('\n')
      const { audit, checks } = auditCharacterVoices(project)
      expect(audit.profiles.find((profile) => profile.name === '林晚')?.lineCount).toBe(5)
      expect(audit.profiles.find((profile) => profile.name === '老周')?.questionRatio).toBeGreaterThan(0.5)
      expect(audit.warnings.some((warning) => warning.title.includes('语气可能趋同'))).toBe(true)
      expect(checks.some((check) => check.kind === 'voice' && check.level === 'warn')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
})

describe("registry", () => {
describe('创作台 Agent 工具注册', () => {
  it('@core:studio-assistant 注册 11 个创作动作，并保持只读边界', () => {
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
    const renderProps = getToolDefinition('studio_render')?.parameters?.properties as Record<string, unknown>
    expect(renderProps).not.toHaveProperty('subtitleMode')
  })
})
})

describe('storyboard-chapter-batches', () => {
  const chapters = (count: number, emptyAt = -1): any[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `ch_${index + 1}`,
      number: index + 1,
      title: `第 ${index + 1} 章`,
      content: index === emptyAt ? '' : `第 ${index + 1} 章正文`,
      synopsis: '',
      volumeId: null,
      beats: [],
      wordTarget: 3000,
      status: 'done',
      revision: 1,
      candidates: [],
      versions: [],
      illustrations: [],
      locked: true,
      updatedAt: Date.now()
    }))

  it('@core:studio-drama 超过 12 章时按 8 章分批，不丢章节', () => {
    const batches = storyboardChapterBatches(chapters(15))
    expect(batches.map((batch) => batch.chapters.length)).toEqual([8, 7])
    expect(batches.flatMap((batch) => batch.chapters).map((chapter) => chapter.number)).toEqual(Array.from({ length: 15 }, (_, index) => index + 1))
    expect(storyboardChapterBatches(chapters(36)).map((batch) => batch.chapters.length)).toEqual([8, 8, 8, 8, 4])
  })

  it('@core:studio-drama 12 章以内只调用一次，空章不进入改编', () => {
    expect(storyboardChapterBatches(chapters(12))).toHaveLength(1)
    const withEmpty = storyboardChapterBatches(chapters(5, 2))
    expect(withEmpty).toHaveLength(1)
    expect(withEmpty[0].chapters.map((chapter) => chapter.number)).toEqual([1, 2, 4, 5])
  })
})

describe('chapter-prompt-context', () => {
  it('@core:studio-writing 章节生成读取世界规则、势力、道具与相关旧事实', () => {
    const { store, dir } = tempStore()
    try {
      const project = makeNovelProject(store)
      project.rules = [{ id: 'rule-1', title: '法术代价', content: '使用法术必须失去一段记忆', createdAt: 1 } as any]
      project.factions = [{ id: 'faction-1', name: '伞骨会', description: '收集逆行伞骨的地下组织', createdAt: 1 } as any]
      project.props = [{ id: 'prop-1', name: '黑伞', description: '能倒着走时间的旧伞', createdAt: 1 } as any]
      project.facts = [
        ...Array.from({ length: 90 }, (_, index) => ({ id: `junk-${index}`, subject: `路人${index}`, predicate: '提到', object: `无关传闻${index}`, confidence: 0.5, source: 'manual' as const, createdAt: 1 })),
        { id: 'fact-important', subject: '外婆', predicate: '留下', object: '黑伞与一把修伞刀', confidence: 0.9, source: 'manual' as const, createdAt: 1 },
        { id: 'fact-current', subject: '林晚', predicate: '想要', object: '修好黑伞', chapterId: 'ch-1', confidence: 0.9, source: 'manual' as const, createdAt: 1 }
      ]
      const prompt = chapterPrompt(project, project.chapters[0], '')
      expect(prompt).toContain('使用法术必须失去一段记忆')
      expect(prompt).toContain('伞骨会')
      expect(prompt).toContain('能倒着走时间的旧伞')
      expect(prompt).toContain('外婆留下黑伞与一把修伞刀')
      expect(prompt).toContain('林晚想要修好黑伞')
      expect(prompt).not.toContain('无关传闻89')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('review-segments', () => {
  const chapter = (content: string) => ({
    id: 'chapter-long',
    number: 1,
    title: '长章',
    revision: 2,
    content
  }) as any
  const coverage = (segments: Array<{ start: number; end: number }>, version = 2): any => ({
    id: 'coverage-1',
    createdAt: 1,
    kind: 'novel',
    scope: 'all',
    part: 'novel:test',
    label: '第 1 章',
    unitStart: 1,
    unitEnd: 1,
    covered: 1,
    total: 1,
    source: 'v2',
    model: 'mock',
    issues: 0,
    units: [{ id: 'chapter-long', version }],
    segments: segments.map((segment) => ({ id: 'chapter-long', version, ...segment }))
  })

  it('@core:studio-writing 九千字长章按段送审，尾部未读时不算整章完成', () => {
    const content = `${'正文。'.repeat(4_000)}尾部唯一标记`
    expect(content.length).toBeGreaterThan(8_000)
    const segments = novelReviewSegments([chapter(content)])
    expect(segments).toHaveLength(2)
    expect(segments.map((segment) => segment.text).join('')).toContain('尾部唯一标记')
    expect(novelReviewBatches(segments).flat()).toHaveLength(2)
    const partial = novelReviewCoverage([coverage([{ start: 0, end: 8_000 }])], [chapter(content)])
    expect(partial.count).toBe(0)
    const full = novelReviewCoverage([coverage([{ start: 0, end: 8_000 }, { start: 8_000, end: content.length }])], [chapter(content)])
    expect(full.count).toBe(1)
    const changed = novelReviewCoverage([coverage([{ start: 0, end: content.length }], 1)], [chapter(content)])
    expect(changed.count).toBe(0)
  })

  it('@core:studio-writing 五百章覆盖记录完整保留，不按日志条数截断', () => {
    const entries = Array.from({ length: 125 }, (_, index) => ({
      id: `coverage-${index}`,
      createdAt: index,
      kind: 'novel' as const,
      scope: 'all' as const,
      part: `novel:batch-${index}`,
      label: `第 ${index * 4 + 1}–${index * 4 + 4} 章`,
      unitStart: index * 4 + 1,
      unitEnd: index * 4 + 4,
      covered: 4,
      total: 500,
      source: 'same-source',
      model: 'mock',
      issues: 0
    }))
    const merged = mergeReviewCoverage([], entries, 'novel', 'same-source')
    expect(merged).toHaveLength(125)
    expect(merged[0].unitStart).toBe(1)
    expect(merged.at(-1)?.unitEnd).toBe(500)
  })

  it('@core:studio-writing 逐章审稿后两章覆盖都保留并能一起算出完成', () => {
    const chapters = [1, 2].map((number) => ({
      id: `chapter-${number}`,
      number,
      title: `第 ${number} 章`,
      revision: 1,
      content: `第 ${number} 章短正文。`
    })) as any[]
    const entry = (chapter: any, source: string): any => ({
      id: `coverage-${chapter.id}`,
      createdAt: 1,
      kind: 'novel',
      scope: 'current',
      part: `novel:${chapter.id}`,
      label: `第 ${chapter.number} 章`,
      unitStart: chapter.number,
      unitEnd: chapter.number,
      covered: 1,
      total: 2,
      source,
      model: 'mock',
      issues: 0,
      units: [{ id: chapter.id, version: 1 }],
      segments: [{ id: chapter.id, version: 1, start: 0, end: chapter.content.length }]
    })
    const first = mergeReviewCoverage([], [entry(chapters[0], 'source-ch1')], 'novel', 'source-ch1')
    const merged = mergeReviewCoverage(first, [entry(chapters[1], 'source-ch2')], 'novel', 'source-ch2')
    expect(merged).toHaveLength(2)
    expect(novelReviewCoverage(merged, chapters).count).toBe(2)
  })

  it('@core:studio-writing 五百章覆盖合并后仍能算出全书五百章已读', () => {
    const chapters = Array.from({ length: 500 }, (_, index) => ({
      id: `chapter-${index + 1}`,
      number: index + 1,
      title: `第 ${index + 1} 章`,
      revision: 1,
      content: '短正文。'
    })) as any[]
    const entries = Array.from({ length: 125 }, (_, batch) => ({
      id: `coverage-${batch}`,
      createdAt: batch,
      kind: 'novel' as const,
      scope: 'all' as const,
      part: `novel:batch-${batch}`,
      label: `第 ${batch * 4 + 1}–${batch * 4 + 4} 章`,
      unitStart: batch * 4 + 1,
      unitEnd: batch * 4 + 4,
      covered: 4,
      total: 500,
      source: 'same-source',
      model: 'mock',
      issues: 0,
      units: chapters.slice(batch * 4, batch * 4 + 4).map((chapter) => ({ id: chapter.id, version: 1 })),
      segments: chapters.slice(batch * 4, batch * 4 + 4).map((chapter) => ({ id: chapter.id, version: 1, start: 0, end: chapter.content.length }))
    }))
    const merged = mergeReviewCoverage([], entries, 'novel', 'same-source')
    expect(merged).toHaveLength(125)
    expect(novelReviewCoverage(merged, chapters).count).toBe(500)
  })

  it('@core:studio-writing 逐章审稿保留其他章节的有效记录', () => {
    const first = {
      id: 'coverage-ch1', createdAt: 1, kind: 'novel' as const, scope: 'current' as const,
      part: 'novel:chapter-1', label: '第 1 章', unitStart: 1, unitEnd: 1, covered: 1, total: 2,
      source: 'source-ch1', model: 'mock', issues: 0, units: [{ id: 'ch-1', version: 1 }]
    }
    const second = { ...first, id: 'coverage-ch2', part: 'novel:chapter-2', label: '第 2 章', unitStart: 2, unitEnd: 2, source: 'source-ch2', units: [{ id: 'ch-2', version: 1 }] }
    const merged = mergeReviewCoverage([first], [second], 'novel', 'source-ch2')
    expect(merged.map((entry) => entry.part)).toEqual(['novel:chapter-1', 'novel:chapter-2'])
  })
})

describe("status-transitions", () => {
const STATUSES: StudioStatus[] = ['waiting', 'ready', 'running', 'review', 'done', 'failed', 'stale', 'skipped']
describe('创作阶段状态转移', () => {
  it('@core:studio-jobs 每种状态都有显式转移表', () => {
    for (const status of STATUSES) {
      expect(STUDIO_STATUS_TRANSITIONS[status]).toBeDefined()
      expect(canTransitionStudioStatus(status, status)).toBe(true)
    }
  })

  it('@core:studio-jobs 拒绝不合理的回退', () => {
    expect(canTransitionStudioStatus('waiting', 'running')).toBe(true)
    expect(canTransitionStudioStatus('running', 'done')).toBe(true)
    expect(canTransitionStudioStatus('done', 'stale')).toBe(true)
    expect(canTransitionStudioStatus('running', 'waiting')).toBe(false)
    expect(canTransitionStudioStatus('done', 'failed')).toBe(false)
    expect(canTransitionStudioStatus('stale', 'skipped')).toBe(false)
  })
})
})
