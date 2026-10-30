import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StudioStore, studioId, ensureDemoProjects, buildTimelineFromProject, currentTimelineVideo } from '../../src/main/studio'
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

  it('@core:studio-storage 新建作品：保存一次再读取，内容不丢不变', () => {
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

  it('@core:studio-storage 素材按 SHA-256 去重并安全写入作品目录', () => {
    const project = store.newProject({ kind: 'short', title: '素材测试', logline: '一句话' })
    const first = store.addAsset(project, { bytes: TINY_PNG, title: '画面', kindHint: 'image', mime: 'image/png' })
    const second = store.addAsset(project, { bytes: TINY_PNG, title: '同一张画面', kindHint: 'image', mime: 'image/png' })
    expect(second.id).toBe(first.id)
    expect(project.assets.filter((asset) => asset.sha256 === first.sha256)).toHaveLength(1)
    expect(existsSync(store.assetAbsolute(project, first))).toBe(true)
    expect(first.width).toBe(1)
    expect(first.height).toBe(1)
  })

  it('@core:studio-storage 章节候选不覆盖正文，手改前自动留档', () => {
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

  it('@core:studio-storage 项目版本可列表并完整恢复，恢复前自动留档', () => {
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

  it('@core:studio-storage 作品文件损坏时从最近版本恢复', () => {
    const project = makeDramaProject(store)
    store.writeVersion(store.readProject(project.id), '损坏前版本')
    writeFileSync(store.projectFile(project.id), '{broken json', 'utf8')
    const read = store.readProject(project.id)
    expect(read.id).toBe(project.id)
    expect(read.title).toBe('测试漫剧')
    expect(read.shots).toHaveLength(2)
  })

  it('@core:studio-storage 拒绝非法作品 id 和越界素材路径', () => {
    expect(() => store.readProject('../escape')).toThrow('作品 id')
    const project = store.newProject({ kind: 'short', title: '安全测试', logline: '一句话' })
    expect(() => store.assetAbsolute(project, { path: '../../outside.bin' })).toThrow('作品目录')
  })

  it('@core:studio-storage 项目版本最多保留 60 个，任务记录裁剪到上限', () => {
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

  it('@core:studio-storage 5 万字章节分片落盘，读取时还原完整正文', () => {
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

  it('@core:studio-storage 分片缺失或哈希不符时不显示残缺正文，并从最近版本恢复', () => {
    const project = makeNovelProject(store)
    const content = '完整正文。'.repeat(12_000)
    project.chapters[0].content = content
    store.save(project, '保存分片正文')
    store.writeVersion(store.readProject(project.id), '完整分片快照')
    const chunkPath = project.chapters[0].contentRef!.path
    const chunkDir = join(store.projectDir(project.id), chunkPath)
    const files = readdirSync(chunkDir).filter((name) => /^part-\d+\.txt$/.test(name)).sort()
    expect(files.length).toBeGreaterThan(2)
    rmSync(join(chunkDir, files[1]), { force: true })
    const recovered = store.readProject(project.id)
    expect(recovered.chapters[0].content).toBe(content)
    expect(recovered.checks.some((check) => check.title.includes('正文分片不完整'))).toBe(true)
    const quarantine = readdirSync(store.projectDir(project.id)).find((name) => name.startsWith('corrupt-'))
    expect(quarantine).toBeTruthy()
    expect(existsSync(join(store.projectDir(project.id), quarantine!, 'project.json'))).toBe(true)
  })

  it('@core:studio-storage project.json 写入失败时旧分片与旧 JSON 一起保持有效', () => {
    const project = makeNovelProject(store)
    const oldContent = '旧稿内容。'.repeat(4_000)
    project.chapters[0].content = oldContent
    store.save(project, '保存旧稿')
    const before = JSON.parse(readFileSync(store.projectFile(project.id), 'utf8')) as { chapters: Array<{ contentRef?: { path: string } }> }
    const oldRef = before.chapters[0].contentRef!.path
    expect(existsSync(join(store.projectDir(project.id), oldRef))).toBe(true)

    project.chapters[0].content = '新稿内容。'.repeat(4_000)
    const original = (store as any).writeProjectPayload.bind(store)
    ;(store as any).writeProjectPayload = () => { throw new Error('模拟磁盘写入失败') }
    expect(() => store.save(project, '保存新稿')).toThrow('模拟磁盘写入失败')
    ;(store as any).writeProjectPayload = original

    const onDisk = JSON.parse(readFileSync(store.projectFile(project.id), 'utf8')) as { chapters: Array<{ contentRef?: { path: string } }> }
    expect(onDisk.chapters[0].contentRef?.path).toBe(oldRef)
    expect(existsSync(join(store.projectDir(project.id), oldRef))).toBe(true)
    expect(store.readProject(project.id).chapters[0].content).toBe(oldContent)

    store.save(project, '重试保存新稿')
    expect(store.readProject(project.id).chapters[0].content).toBe('新稿内容。'.repeat(4_000))
    expect(existsSync(join(store.projectDir(project.id), oldRef))).toBe(false)
  })

  it('@core:studio-storage 只恢复损坏章节，完整章节保留最近保存的新内容', () => {
    const project = makeNovelProject(store)
    const oldFirst = '第一章旧稿。'.repeat(3_000)
    const oldSecond = '第二章旧稿。'.repeat(3_000)
    project.chapters[0].content = oldFirst
    project.chapters.push({
      ...JSON.parse(JSON.stringify(project.chapters[0])),
      id: 'ch-2',
      number: 2,
      title: '第二章',
      content: oldSecond
    })
    store.save(project, '保存两章旧稿')
    store.writeVersion(store.readProject(project.id), '两章旧稿快照')

    const newSecond = '第二章新稿，刚保存但还没有新快照。'.repeat(2_000)
    const current = store.readProject(project.id)
    current.chapters[1].content = newSecond
    store.save(current, '只保存第二章新稿')

    const firstRef = current.chapters[0].contentRef!.path
    const firstDir = join(store.projectDir(project.id), firstRef)
    const parts = readdirSync(firstDir).filter((name) => /^part-\d+\.txt$/.test(name)).sort()
    rmSync(join(firstDir, parts[0]), { force: true })

    const recovered = store.readProject(project.id)
    expect(recovered.chapters[0].content).toBe(oldFirst)
    expect(recovered.chapters[1].content).toBe(newSecond)
    const check = recovered.checks.find((item) => item.title.includes('部分章节正文分片不完整'))
    expect(check?.detail).toContain('已恢复：修伞的人')
    expect(check?.detail).toContain('其余 1 章保持当前版本')
  })

  it('@core:studio-storage 断电恢复演练：损坏作品可从版本恢复超长章节与外部任务号', () => {
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

  it('@core:studio-storage 目标字数与目标时长在保存读回后不丢失', () => {
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

  it('@core:studio-storage 超长章节可写入版本并完整恢复', () => {
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
  it('@core:studio-storage 旧内置漫剧升级为动态镜头与 1080p 成片，时间线仍可编辑', () => {
    const project = makeDramaProject(store)
    project.title = '逆行的伞'
    project.demo = true
    const base = project.shots[0]
    project.shots = Array.from({ length: 12 }, (_, index) => ({
      ...(JSON.parse(JSON.stringify(base)) as typeof base),
      id: `shot-${index + 1}`,
      number: index + 1,
      title: `镜 ${index + 1}`,
      durationSec: 8,
      dialogue: '',
      speaker: '',
      voiceAssetId: null,
      videoAssetId: null,
      imageCandidates: [],
      videoCandidates: []
    }))
    project.timeline = buildTimelineFromProject(project)
    project.timeline.version = 4
    project.timeline.durationSec = 96
    project.episodes = [{
      id: 'ep-1',
      number: 1,
      title: '逆行的伞',
      synopsis: '',
      sceneIds: project.scenes.map((scene) => scene.id),
      durationSec: 96,
      updatedAt: Date.now()
    }]
    store.save(project, '旧内置样例')
    writeFileSync(join(store.root, '.demo-seeded-v1'), '{}\n', 'utf8')
    ensureDemoProjects(store)
    const upgraded = store.readProject(project.id)
    expect(upgraded.timeline.version).toBe(6)
    expect(upgraded.shots.every((shot) => Boolean(shot.videoAssetId))).toBe(true)
    const videoIds = new Set(upgraded.assets.filter((asset) => asset.kind === 'video').map((asset) => asset.id))
    expect(upgraded.shots.every((shot) => videoIds.has(shot.videoAssetId!))).toBe(true)
    expect(upgraded.timeline.clips.filter((clip) => clip.kind === 'video').every((clip) => videoIds.has(clip.assetId!))).toBe(true)
    const final = upgraded.deliveries.find((delivery) => delivery.label.includes('1080p'))
    expect(final).toBeTruthy()
    expect(currentTimelineVideo(upgraded, store)?.id).toBe(final!.id)
  })

})
