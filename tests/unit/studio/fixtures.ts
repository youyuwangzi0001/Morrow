import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StudioStore, studioId, nowMs } from '../../../src/main/studio/store'
import { buildTimelineFromProject } from '../../../src/main/studio/timeline'
import type { StudioProject, StudioShot } from '../../../src/shared/studio'
import { emptyTimeline } from '../../../src/shared/studio'

export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZz3GQAAAABJRU5ErkJggg==',
  'base64'
)

export function tempStore(): { store: StudioStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'morrow-studio-test-'))
  return { store: new StudioStore(dir), dir }
}

export function addShot(project: StudioProject, number: number, overrides: Partial<StudioShot> = {}): StudioShot {
  const shot: StudioShot = {
    id: studioId('shot'),
    sceneId: project.scenes[0]?.id ?? 'scene-1',
    number,
    title: `镜 ${number}`,
    action: `第 ${number} 镜的动作`,
    camera: '固定镜头',
    shotSize: '中景',
    durationSec: 8,
    dialogue: '',
    speaker: '',
    voiceId: '',
    prompt: `第 ${number} 镜的画面`,
    negative: '文字',
    referenceCharacterIds: [],
    referencePlaceIds: [],
    referencePropIds: [],
    imageAssetId: null,
    videoAssetId: null,
    voiceAssetId: null,
    imageCandidates: [],
    videoCandidates: [],
    continuity: '',
    lockedReference: false,
    status: 'ready',
    updatedAt: nowMs(),
    ...overrides
  }
  project.shots.push(shot)
  return shot
}

export function makeDramaProject(store: StudioStore): StudioProject {
  const project = store.newProject({
    kind: 'drama',
    title: '测试漫剧',
    logline: '一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。',
    brief: { aspect: '16:9', targetSeconds: 16, constraints: ['不改脸'] }
  })
  project.scenes = [
    {
      id: 'scene-1',
      episodeId: 'ep-1',
      number: 1,
      title: '雨夜',
      synopsis: '捡到伞',
      location: '老街',
      timeOfDay: '夜',
      characters: ['林晚'],
      beat: 'Setup',
      updatedAt: nowMs()
    }
  ]
  const image = store.addAsset(project, {
    bytes: TINY_PNG,
    title: '测试画面',
    mime: 'image/png',
    kindHint: 'image',
    metadata: { width: 1, height: 1 }
  })
  const audio = store.addAsset(project, {
    bytes: Buffer.from('RIFF0000WAVEfmt test-audio'),
    title: '测试环境声',
    mime: 'audio/wav',
    kindHint: 'audio',
    tags: ['sfx', 'rain'],
    metadata: { durationSec: 4 }
  })
  const voice = store.addAsset(project, {
    bytes: Buffer.from('RIFF0000WAVEfmt test-voice'),
    title: '测试配音',
    mime: 'audio/wav',
    kindHint: 'audio',
    tags: ['voice'],
    metadata: { durationSec: 3 }
  })
  const shot1 = addShot(project, 1, { imageAssetId: image.id, title: '雨夜捡伞', dialogue: '还能修好吗？', speaker: '林晚', voiceAssetId: voice.id })
  addShot(project, 2, { imageAssetId: image.id, title: '伞骨倒转', action: '时间退回一步' })
  project.facts = [
    { id: studioId('fact'), subject: '林晚', predicate: '想要', object: '修好伞', confidence: 0.9, source: 'manual', createdAt: nowMs() },
    { id: studioId('fact'), subject: '林晚', predicate: '想要', object: '关掉店门', confidence: 0.9, source: 'manual', createdAt: nowMs() }
  ]
  project.characters = [
    { id: 'char-1', name: '林晚', role: '主角', look: '短黑发，深色围裙', relationships: [], refAssetIds: [image.id] },
    { id: 'char-2', name: '少年', role: '失忆者', look: '湿透的薄外套', relationships: [], refAssetIds: [] }
  ]
  project.timeline = buildTimelineFromProject(project)
  project.stage = 'timeline'
  store.save(project, '测试漫剧', { snapshot: true })
  return project
}

export function makeNovelProject(store: StudioStore): StudioProject {
  const project = store.newProject({
    kind: 'novel',
    title: '测试长篇',
    logline: '一个修伞的女孩继承外婆的伞铺，每周三都会有一个失忆的少年，来修同一把黑伞。',
    brief: { aspect: '16:9', targetWords: 120000 }
  })
  project.volumes = [{ id: 'vol-1', number: 1, title: '第一卷', summary: '', chapterIds: [] }]
  project.chapters = [
    {
      id: 'ch-1',
      volumeId: 'vol-1',
      number: 1,
      title: '修伞的人',
      synopsis: '林晚在雨夜捡到一把黑伞。',
      beats: ['异常出现'],
      content: '雨是从傍晚开始下的。她把最后一把伞挂在门后。\n\n门外站着一个浑身湿透的少年。',
      wordTarget: 2000,
      status: 'done',
      revision: 1,
      candidates: [],
      versions: [],
      illustrations: [],
      locked: true,
      updatedAt: nowMs()
    }
  ]
  project.facts = [
    { id: studioId('fact'), subject: '林晚', predicate: '想要', object: '继续开伞铺', confidence: 0.9, source: 'manual', createdAt: nowMs() }
  ]
  project.timeline = emptyTimeline(project.brief.aspect)
  project.stage = 'writing'
  store.save(project, '测试长篇', { snapshot: true })
  return project
}
