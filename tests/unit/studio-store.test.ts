import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StudioStore, studioId } from '../../src/main/studio'
import { tempStore, TINY_PNG, makeDramaProject, makeNovelProject } from './studio-fixtures'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.TEMP ?? 'C:/Windows/Temp',
    getVersion: () => '0.2.0',
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => Buffer.from(value).toString('utf8')
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

describe('创作台作品仓库', () => {
  let store: StudioStore
  let dir = ''

  beforeEach(() => {
    const created = tempStore()
    store = created.store
    dir = created.dir
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('新建作品：保存一次再读取，内容不丢不变', () => {
    const project = store.newProject({
      kind: 'short',
      title: '测试短篇',
      logline: '一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。',
      brief: { aspect: '9:16', targetWords: 18000 }
    })
    const read = store.readProject(project.id)
    expect(read.title).toBe('测试短篇')
    expect(read.kind).toBe('short')
    expect(read.brief.aspect).toBe('9:16')
    expect(read.timeline.aspect).toBe('9:16')
    expect(read.revision).toBe(project.revision)
    expect(store.summaries().map((item) => item.id)).toContain(project.id)
  })

  it('素材按 SHA-256 去重并安全写入作品目录', () => {
    const project = store.newProject({ kind: 'short', title: '素材测试', logline: '一句话' })
    const first = store.addAsset(project, { bytes: TINY_PNG, title: '画面', kindHint: 'image', mime: 'image/png' })
    const second = store.addAsset(project, { bytes: TINY_PNG, title: '同一张画面', kindHint: 'image', mime: 'image/png' })
    expect(second.id).toBe(first.id)
    expect(project.assets.filter((asset) => asset.sha256 === first.sha256)).toHaveLength(1)
    expect(existsSync(store.assetAbsolute(project, first))).toBe(true)
    expect(first.width).toBe(1)
    expect(first.height).toBe(1)
  })

  it('章节候选不覆盖正文，手改前自动留档', () => {
    const project = makeNovelProject(store)
    const chapter = project.chapters[0]
    const original = chapter.content
    store.addChapterVersion(chapter, original, '手改前')
    chapter.content = `${original}\n\n她把灯关了。`
    chapter.candidates.unshift({ id: studioId('cand'), content: '另一版本', label: '候选', source: 'local', createdAt: Date.now(), wordCount: 4 })
    store.save(project, '保存章节')
    const read = store.readProject(project.id)
    expect(read.chapters[0].content).toContain('她把灯关了')
    expect(read.chapters[0].candidates).toHaveLength(1)
    expect(read.chapters[0].versions[0].content).toContain('雨是从傍晚开始下的')
  })

  it('项目版本可列表并完整恢复，恢复前自动留档', () => {
    const project = makeNovelProject(store)
    const original = project.chapters[0].content
    store.writeVersion(project, '第一版留档')
    const versions = store.listVersionFiles(project.id)
    expect(versions.some((version) => version.reason === '第一版留档')).toBe(true)
    const version = versions.find((item) => item.reason === '第一版留档')
    expect(version).toBeTruthy()
    project.chapters[0].content = `${original}\n\n第二版新增的一行。`
    store.save(project, '第二版')
    const restored = store.restoreProjectVersion(project.id, version!.name)
    expect(restored.chapters[0].content).toBe(original)
    const after = store.listVersionFiles(project.id)
    expect(after.some((item) => item.reason === '恢复历史版本前自动留档')).toBe(true)
  })

  it('作品文件损坏时从最近版本恢复', () => {
    const project = makeDramaProject(store)
    store.writeVersion(store.readProject(project.id), '损坏前版本')
    writeFileSync(store.projectFile(project.id), '{broken json', 'utf8')
    const read = store.readProject(project.id)
    expect(read.id).toBe(project.id)
    expect(read.title).toBe('测试漫剧')
    expect(read.shots).toHaveLength(2)
  })

  it('拒绝非法作品 id 和越界素材路径', () => {
    expect(() => store.readProject('../escape')).toThrow('作品 id')
    const project = store.newProject({ kind: 'short', title: '安全测试', logline: '一句话' })
    expect(() => store.assetAbsolute(project, { path: '../../outside.bin' })).toThrow('作品目录')
  })

  it('项目版本最多保留 60 个，任务记录裁剪到上限', () => {
    const project = makeNovelProject(store)
    for (let index = 0; index < 65; index += 1) store.writeVersion(project, `版本 ${index}`)
    expect(store.listVersionFiles(project.id).length).toBeLessThanOrEqual(60)
    project.jobs = Array.from({ length: 130 }, (_, index) => ({
      id: `job-${index}`,
      requestId: `req-${index}`,
      projectId: project.id,
      kind: 'text' as const,
      label: `任务 ${index}`,
      stage: 'writing' as const,
      status: 'done' as const,
      progress: 100,
      message: '完成',
      inputHash: String(index),
      attempts: 1,
      cost: 0,
      outputs: [],
      createdAt: index,
      updatedAt: index
    }))
    store.trimJobs(project)
    expect(project.jobs.length).toBeLessThanOrEqual(120)
  })

  it('5 万字章节分片落盘，读取时还原完整正文', () => {
    const project = makeNovelProject(store)
    const chapter = project.chapters[0]
    const content = Array.from({ length: 3000 }, (_, index) => `第 ${index + 1} 段，雨沿着伞骨落下来。`).join('\n')
    expect(content.length).toBeGreaterThan(50_000)
    chapter.content = content
    store.save(project, '保存超长章节')
    expect(chapter.contentRef?.chunks).toBeGreaterThanOrEqual(4)
    const disk = JSON.parse(readFileSync(store.projectFile(project.id), 'utf8')) as { chapters: Array<{ content: string; contentRef?: { path: string; chunks: number } }> }
    expect(disk.chapters[0].content).toBe('')
    expect(disk.chapters[0].contentRef?.path).toContain('chunks/')
    const dir = join(store.projectDir(project.id), disk.chapters[0].contentRef!.path)
    expect(readdirSync(dir).filter((name) => name.endsWith('.txt')).length).toBe(chapter.contentRef?.chunks)
    const read = store.readProject(project.id)
    expect(read.chapters[0].content).toBe(content)
    expect(read.chapters[0].locked).toBe(true)
  })

  it('断电恢复演练：损坏作品可从版本恢复超长章节与外部任务号', () => {
    const project = makeNovelProject(store)
    const content = '恢复演练。'.repeat(12_000)
    project.chapters[0].content = content
    project.jobs.push({
      id: 'job-remote',
      requestId: 'req-remote',
      projectId: project.id,
      kind: 'image',
      label: '外部画面',
      stage: 'visuals',
      status: 'review',
      progress: 42,
      message: '应用退出时外部任务已提交；启动后会自动核对结果。',
      inputHash: 'remote',
      attempts: 1,
      remoteId: 'prompt-123',
      remoteTargets: [{ remoteId: 'prompt-123', kind: 'image', shotId: 'shot-1' }],
      cost: null,
      outputs: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    store.save(project, '保存恢复演练数据')
    store.writeVersion(store.readProject(project.id), '恢复演练快照')
    writeFileSync(store.projectFile(project.id), '{broken', 'utf8')
    const recovered = store.readProject(project.id)
    expect(recovered.chapters[0].content).toBe(content)
    expect(recovered.jobs.find((job) => job.id === 'job-remote')?.remoteId).toBe('prompt-123')
    expect(recovered.jobs.find((job) => job.id === 'job-remote')?.remoteTargets?.[0]?.shotId).toBe('shot-1')
    expect(existsSync(join(store.projectDir(project.id), recovered.chapters[0].contentRef!.path))).toBe(true)
  })

  it('目标字数与目标时长在保存读回后不丢失', () => {
    const project = store.newProject({
      kind: 'novel',
      title: '目标保留',
      logline: '一个修伞的人',
      brief: { targetWords: 50_000, targetSeconds: 96 }
    })
    store.save(project, '保存目标')
    const read = store.readProject(project.id)
    expect(read.brief.targetWords).toBe(50_000)
    expect(read.brief.targetSeconds).toBe(96)
  })

  it('超长章节可写入版本并完整恢复', () => {
    const project = makeNovelProject(store)
    const chapter = project.chapters[0]
    const first = '第一版。'.repeat(6000)
    chapter.content = first
    store.writeVersion(project, '超长第一版')
    const version = store.listVersionFiles(project.id).find((item) => item.reason === '超长第一版')
    chapter.content = '第二版。'.repeat(6000)
    store.save(project, '超长第二版')
    const restored = store.restoreProjectVersion(project.id, version!.name)
    expect(restored.chapters[0].content).toBe(first)
    expect(store.readProject(project.id).chapters[0].content).toBe(first)
  })
})
