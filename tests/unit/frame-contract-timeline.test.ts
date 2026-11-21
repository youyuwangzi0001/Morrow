import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { buildTimelineFromProject, runChecks } from '../../src/main/studio'
import { timelineDuration } from '../../src/shared/studio'
import { tempStore, makeDramaProject } from './studio-fixtures'

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

describe('C-01 帧数契约接入时间线', () => {
  let store: ReturnType<typeof tempStore>['store']
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

  const attachVideo = (project: ReturnType<typeof makeDramaProject>, bytes: string, metadata: { durationSec: number; frames: number; fps: number }) =>
    store.addAsset(project, {
      bytes: Buffer.from(bytes),
      title: '测试视频',
      mime: 'video/mp4',
      kindHint: 'video',
      metadata: { width: 768, height: 1344, ...metadata }
    })

  it('@core:studio-timeline 按实测帧数排时间线：不足顺延不留空档，超额只用计划时长，无实测保持原行为', () => {
    const project = makeDramaProject(store)
    project.shots[0].durationSec = 5.17
    project.shots[0].videoAssetId = attachVideo(project, 'fake-mp4-90', { durationSec: 3.75, frames: 90, fps: 24 }).id
    const short = buildTimelineFromProject(project)
    const first = short.clips.find((clip) => clip.kind === 'video' && clip.shotId === project.shots[0].id)
    const second = short.clips.find((clip) => clip.kind === 'video' && clip.shotId === project.shots[1].id)
    expect(first?.duration).toBeCloseTo(3.75, 3)
    expect(second?.start).toBeCloseTo(3.75, 3)
    expect(short.durationSec).toBeCloseTo(11.75, 3)
    expect(timelineDuration(short)).toBeCloseTo(11.75, 3)

    const longProject = makeDramaProject(store)
    longProject.shots[0].durationSec = 5
    longProject.shots[0].videoAssetId = attachVideo(longProject, 'fake-mp4-141', { durationSec: 5.875, frames: 141, fps: 24 }).id
    const long = buildTimelineFromProject(longProject)
    expect(long.clips.find((clip) => clip.kind === 'video' && clip.shotId === longProject.shots[0].id)?.duration).toBe(5)
    expect(long.durationSec).toBeCloseTo(13, 3)

    const plain = makeDramaProject(store)
    expect(buildTimelineFromProject(plain).durationSec).toBe(16)
  })

  it('@core:studio-timeline 检查结果显式报出帧数不足，并说明不会补帧或放慢', () => {
    const project = makeDramaProject(store)
    project.shots[0].durationSec = 5.17
    project.shots[0].videoAssetId = attachVideo(project, 'fake-mp4-90-check', { durationSec: 3.75, frames: 90, fps: 24 }).id
    const found = runChecks(project).find((check) => check.title.includes('实测帧数不足'))
    expect(found).toBeTruthy()
    expect(found?.level).toBe('warn')
    expect(found?.detail).toContain('90 帧')
    expect(found?.detail).toContain('3.75s')
    expect(found?.detail).toContain('1.42s')
    expect(found?.detail).toContain('不会补帧或放慢')

    const enough = makeDramaProject(store)
    enough.shots[0].durationSec = 5.17
    enough.shots[0].videoAssetId = attachVideo(enough, 'fake-mp4-124', { durationSec: 5.1667, frames: 124, fps: 24 }).id
    expect(runChecks(enough).some((check) => check.title.includes('实测帧数不足'))).toBe(false)
  })
})