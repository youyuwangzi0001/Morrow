import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeDramaProject, reopenStore, tempStore } from './studio-fixtures'
import { StudioStore, reconcileInterruptedJobsForTest, shouldAutoResume } from '../../src/main/studio'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: (name: string) => join(process.env.TEMP ?? 'C:/Windows/Temp', name),
    getVersion: () => '0.2.0'
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

/** 造一个「应用被杀时正在跑」的外部任务。 */
function makeInterruptedJob(store: StudioStore) {
  const project = makeDramaProject(store)
  // makeDramaProject 只在内存里构造；要先落盘，重启后 summaries() 才看得到。
  store.save(project, '建立测试作品', { snapshot: false })
  const job = {
    id: 'job_interrupted_1',
    requestId: 'req-interrupted',
    projectId: project.id,
    kind: 'video' as const,
    label: '第 1 镜 · 视频',
    stage: 'visuals' as const,
    status: 'running' as const,
    progress: 42,
    message: '解码画面',
    inputHash: 'hash-video-1',
    attempts: 1,
    remoteId: 'comfy-prompt-abc123',
    remoteTargets: [{ remoteId: 'comfy-prompt-abc123', kind: 'video' as const, shotId: project.shots[0].id }],
    cost: 0,
    costNote: '本机 ComfyUI 引擎，不计边际费用',
    outputs: [],
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 5_000
  }
  project.jobs.push(job)
  store.save(project, '模拟断电前正在生成视频', { snapshot: false })
  return { project, job }
}

describe('C-10 断点续跑', () => {
  it('@core:studio-media 中断任务在重启后可恢复到 review，且保留外部任务号可对账', () => {
    const { store, dir } = tempStore()
    const { project } = makeInterruptedJob(store)

    // 重启：新实例读同一目录，等同于应用重新启动
    const reopened = reopenStore(dir)
    const count = reconcileInterruptedJobsForTest(reopened)
    expect(count, '应当核对到 1 个被中断的任务').toBe(1)

    const after = reopened.readProject(project.id)
    const job = after.jobs.find((item) => item.id === 'job_interrupted_1')
    expect(job?.status, '中断任务必须从 running 改为 review').toBe('review')
    // 有外部任务号的不能标 error：结果其实还在 ComfyUI 里，可以取回
    expect(job?.error).toBeUndefined()
    expect(job?.message).toContain('自动核对')
    expect(job?.remoteId).toBe('comfy-prompt-abc123')
    expect(job?.remoteTargets?.[0]?.shotId).toBe(project.shots[0].id)

    // 再跑一次必须幂等：已经 review 的任务不应重复计数
    expect(reconcileInterruptedJobsForTest(reopened), '重复核对不应再改动').toBe(0)
  })

  it('@core:studio-media 没有外部任务号的中断任务标为错误，不能假装能恢复', () => {
    const { store, dir } = tempStore()
    const project = makeDramaProject(store)
    store.save(project, '建立测试作品', { snapshot: false })
    project.jobs.push({
      id: 'job_no_remote',
      requestId: 'req-no-remote',
      projectId: project.id,
      kind: 'image' as const,
      label: '第 1 镜 · 画面',
      stage: 'visuals' as const,
      status: 'running' as const,
      progress: 10,
      message: '生成中',
      inputHash: 'hash-image-1',
      attempts: 1,
      cost: 0,
      outputs: [],
      createdAt: Date.now() - 30_000,
      updatedAt: Date.now() - 1_000
    })
    store.save(project, '模拟无外部任务号的中断', { snapshot: false })

    const reopened = reopenStore(dir)
    expect(reconcileInterruptedJobsForTest(reopened)).toBe(1)
    const job = reopened.readProject(project.id).jobs.find((item) => item.id === 'job_no_remote')
    expect(job?.status).toBe('review')
    // 没有任务号就无法取回，必须如实标注中断，不能显示「可自动核对」
    expect(job?.error, '没有外部任务号必须标中断').toBeTruthy()
    expect(job?.message).not.toContain('自动核对')
  })

  it('@core:studio-media 自动恢复只挑「可对账」的任务，且引擎离线时不假装恢复', () => {
    const { store, dir } = tempStore()
    const { project } = makeInterruptedJob(store)
    const reopened = reopenStore(dir)
    reconcileInterruptedJobsForTest(reopened)
    const job = reopened.readProject(project.id).jobs.find((item) => item.id === 'job_interrupted_1')!

    // 引擎在线 + 有任务号 + review + 提示语匹配 → 允许自动恢复
    expect(shouldAutoResume({ job, engineOnline: true })).toBe(true)
    // 引擎离线：不能「假装恢复」，应留待引擎上线后处理
    expect(shouldAutoResume({ job, engineOnline: false })).toBe(false)
    // 已完成的任务不再重复取回（防重复计费）
    expect(shouldAutoResume({ job: { ...job, status: 'done' }, engineOnline: true })).toBe(false)
    // 已经取回过的（输出里有 resumed 记录）不再重复
    expect(
      shouldAutoResume({ job: { ...job, outputs: [{ label: '第 1 镜 · 外部任务取回', assetId: 'asset_1' }] }, engineOnline: true })
    ).toBe(false)
    // 没有任务号的不能自动恢复
    expect(shouldAutoResume({ job: { ...job, remoteId: undefined }, engineOnline: true })).toBe(false)
  })

  it('@core:studio-media 恢复状态真的落到磁盘：重启后从文件读到的仍是 review 且保留任务号', () => {
    const { store, dir } = tempStore()
    const { project } = makeInterruptedJob(store)
    const projectFile = store.projectFile(project.id)
    expect(existsSync(projectFile), '任务必须先落盘才算「断电前有记录」').toBe(true)

    // 断电前磁盘上确实是 running
    const before = JSON.parse(readFileSync(projectFile, 'utf8'))
    expect(before.jobs.find((item: { id: string }) => item.id === 'job_interrupted_1')?.status).toBe('running')

    // 模拟重启：新实例 + 核对
    expect(reconcileInterruptedJobsForTest(new StudioStore(dir))).toBe(1)

    // 关键：不是只在内存里改了，磁盘上也要是 review
    const after = JSON.parse(readFileSync(projectFile, 'utf8'))
    const diskJob = after.jobs.find((item: { id: string }) => item.id === 'job_interrupted_1')
    expect(diskJob?.status, '磁盘上的状态也要是 review').toBe('review')
    expect(diskJob?.remoteId, '磁盘上必须保留外部任务号').toBe('comfy-prompt-abc123')
    expect(diskJob?.remoteTargets?.[0]?.shotId).toBe(project.shots[0].id)
  })
})