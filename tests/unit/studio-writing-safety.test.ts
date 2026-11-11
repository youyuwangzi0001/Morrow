import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const settings = {
  defaultModel: { providerId: 'mock-writing', modelId: 'mock-writing-model' },
  providers: [{
    id: 'mock-writing',
    kind: 'openai-compat',
    name: '写作安全测试模型',
    baseUrl: '',
    models: [{
      id: 'mock-writing-model',
      label: '写作安全测试模型',
      contextWindow: 64_000,
      maxOutput: 20_000,
      supportsTools: true
    }],
    apiKeyStored: true,
    enabled: true
  }]
}

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP ?? 'C:/Windows/Temp', getVersion: () => '0.2.0', isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => Buffer.from(v).toString() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

vi.mock('../../src/main/settings', () => ({
  getSettingsStore: () => ({
    get: () => settings,
    getApiKey: () => 'test-key'
  })
}))

import { StudioService, currentTimelineVideo } from '../../src/main/studio'
import { makeDramaProject, makeNovelProject, tempStore } from './studio-fixtures'

let server: Server
let releaseResponse: () => void = () => undefined
let markStarted: () => void = () => undefined
let gate: Promise<void> = Promise.resolve()
let started: Promise<void> = Promise.resolve()

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      markStarted()
      void gate.then(() => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '改写后的正文。' }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  settings.providers[0].baseUrl = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  gate = new Promise<void>((resolve) => { releaseResponse = resolve })
  started = new Promise<void>((resolve) => { markStarted = resolve })
})

describe('writing-safety', () => {
  it('@core:studio-assistant 重写期间手改正文时保留候选、不覆盖手稿，候选摘要不污染正式摘要', async () => {
    const { store, dir } = tempStore()
    try {
      const project = makeNovelProject(store)
      project.chapters[0].summary = '原摘要：雨夜捡伞'
      store.save(project, '设置摘要', { snapshot: false })
      const service = new StudioService({ store })
      await service.execute({
        type: 'polish-chapter',
        projectId: project.id,
        chapterId: 'ch-1',
        replaceContent: true,
        instruction: '重写这一章结尾'
      })
      await started
      const edited = store.readProject(project.id)
      edited.chapters[0].content = '用户手改的正文。'
      edited.chapters[0].revision += 1
      store.save(edited, '手改正文', { snapshot: false })
      releaseResponse()
      await expect.poll(() => store.readProject(project.id).jobs.at(-1)?.status, { timeout: 20_000, interval: 100 }).toBe('done')
      const after = store.readProject(project.id)
      expect(after.chapters[0].content).toBe('用户手改的正文。')
      expect(after.chapters[0].candidates).toHaveLength(1)
      expect(after.chapters[0].candidates[0].content).toContain('改写后的正文。')
      expect(after.chapters[0].summary).toBe('原摘要：雨夜捡伞')
      expect(after.stages.writing.status).toBe('review')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:studio-drama 冲突镜头的新稿可以比较后采用或丢弃，不会自动覆盖', async () => {
    const { store, dir } = tempStore()
    try {
      const project = makeDramaProject(store)
      project.blueprint = { approved: true, units: [] } as any
      const shot = project.shots[0]
      shot.rewriteCandidate = {
        id: 'rewrite-1',
        model: 'mock-model',
        title: 'AI 标题',
        action: 'AI 新动作',
        camera: '缓慢推近',
        shotSize: '近景',
        durationSec: 6,
        dialogue: 'AI 新台词',
        speaker: '林晚',
        continuity: '承接上一镜',
        prompt: 'AI 画面提示',
        negative: '',
        createdAt: Date.now()
      }
      shot.updatedAt = Date.now()
      store.save(project, '写入 AI 候选')
      const service = new StudioService({ store })
      await service.execute({ type: 'adopt-shot-rewrite', projectId: project.id, shotId: shot.id })
      let after = store.readProject(project.id)
      expect(after.shots[0].action).toBe('AI 新动作')
      expect(after.shots[0].rewriteCandidate).toBeUndefined()
      expect(after.shots[0].voiceAssetId).toBeNull()

      after.shots[0].rewriteCandidate = { ...shot.rewriteCandidate!, id: 'rewrite-2', action: '另一个 AI 动作' }
      after.shots[0].updatedAt = Date.now()
      store.save(after, '再次写入候选')
      await service.execute({ type: 'discard-shot-rewrite', projectId: project.id, shotId: shot.id })
      after = store.readProject(project.id)
      expect(after.shots[0].rewriteCandidate).toBeUndefined()
      expect(after.shots[0].action).toBe('AI 新动作')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:studio-assistant 协作者快照优先包含用户选中的章节正文，而不是只给标题', () => {
    const { store, dir } = tempStore()
    try {
      const project = makeNovelProject(store)
      project.chapters = Array.from({ length: 100 }, (_, index) => ({
        ...project.chapters[0],
        id: `chapter-${index + 1}`,
        number: index + 1,
        title: `第 ${index + 1} 章`,
        synopsis: `第 ${index + 1} 章梗概`,
        content: `第 ${index + 1} 章正文。${index === 99 ? '第 100 章唯一标记：黑伞在雨里倒着走。' : '普通段落。'}`,
        revision: 1
      }))
      const service = new StudioService({ store })
      const snapshot = (service as any).revisionSnapshot(project, 'writing', { kind: 'chapter', id: 'chapter-100' })
      expect(snapshot).toContain('用户当前选中：第100章')
      expect(snapshot).toContain('当前选中章原文')
      expect(snapshot).toContain('第 100 章唯一标记：黑伞在雨里倒着走。')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:studio-jobs 预算把排队任务计入承诺金额，执行前可排除自己重新核算', () => {
    const { store, dir } = tempStore()
    try {
      const project = makeNovelProject(store)
      project.runtime.budget = { ...project.runtime.budget, limit: 1, spent: 0 }
      const service = new StudioService({ store })
      expect(() => (service as any).assertBudget(project, 0.7)).not.toThrow()
      project.jobs.push({
        id: 'queued-job',
        requestId: 'req-queued',
        projectId: project.id,
        kind: 'text',
        label: '排队任务',
        stage: 'writing',
        status: 'queued',
        progress: 0,
        message: '排队中',
        inputHash: 'queued',
        attempts: 0,
        cost: 0.7,
        outputs: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      expect(() => (service as any).assertBudget(project, 0.7)).toThrow(/预算/)
      expect(() => (service as any).assertBudget(project, 0.7, 'queued-job')).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:studio-jobs 启动恢复把中断的任务和阶段一起改成待核对', () => {
    const { store, dir } = tempStore()
    try {
      const project = makeNovelProject(store)
      project.stages.writing = { status: 'running', updatedAt: Date.now(), message: '正在写', progress: 40 }
      project.jobs.push({
        id: 'interrupted-job',
        requestId: 'req-interrupted',
        projectId: project.id,
        kind: 'text',
        label: '写第 1 章',
        stage: 'writing',
        status: 'running',
        progress: 40,
        message: '正在写',
        inputHash: 'interrupted',
        attempts: 1,
        cost: null,
        outputs: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      store.save(project, '模拟中断', { snapshot: false })
      const service = new StudioService({ store })
      ;(service as any).ensureInitialized()
      const after = store.readProject(project.id)
      expect(after.jobs.find((job) => job.id === 'interrupted-job')?.status).toBe('review')
      expect(after.stages.writing.status).toBe('review')
      expect(after.stages.writing.message).toContain('中断')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('@core:studio-timeline 交付与导出只认当前时间线版本的成片', () => {
    const { store, dir } = tempStore()
    try {
      const project = makeDramaProject(store)
      const exportsDir = store.exportsDir(project.id)
      mkdirSync(exportsDir, { recursive: true })
      writeFileSync(join(exportsDir, 'old.mp4'), 'old')
      writeFileSync(join(exportsDir, 'new.mp4'), 'new')
      project.timeline.version = 5
      project.deliveries = [
        { id: 'old', kind: 'mp4', label: '旧成片', path: 'exports/old.mp4', bytes: 3, sha256: 'old', createdAt: 1, meta: { timelineVersion: 3 } },
        { id: 'new', kind: 'mp4', label: '新成片', path: 'exports/new.mp4', bytes: 3, sha256: 'new', createdAt: 2, meta: { timelineVersion: 5 } }
      ] as any
      expect(currentTimelineVideo(project, store)?.id).toBe('new')
      project.stages.timeline.status = 'stale'
      expect(currentTimelineVideo(project, store)).toBeUndefined()
      project.stages.timeline.status = 'done'
      ;(project.deliveries[1].meta as any).renderKey = '过期渲染依据'
      expect(currentTimelineVideo(project, store)).toBeUndefined()
      delete (project.deliveries[1].meta as any).renderKey
      project.timeline.version = 6
      expect(currentTimelineVideo(project, store)).toBeUndefined()
      project.stages.delivery.status = 'stale'
      project.deliveries.push({ id: 'legacy', kind: 'mp4', label: '旧格式成片', path: 'exports/old.mp4', bytes: 3, sha256: 'old', createdAt: 0 } as any)
      expect(currentTimelineVideo(project, store)).toBeUndefined()
      project.stages.delivery.status = 'done'
      expect(currentTimelineVideo(project, store)?.id).toBe('legacy')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
