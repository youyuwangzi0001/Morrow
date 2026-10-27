// 真实语料作品：把《极速曙光》《再造华夏》的细纲整理成可编辑作品。
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StudioAsset, StudioBlueprint, StudioChapter, StudioCharacter, StudioProject, StudioShot } from '../../shared/studio'
import { CORPUS } from './corpus'
import { emptyTimeline } from '../../shared/studio'
import { StudioStore, nowMs, studioId } from './store'
import { buildTimelineFromProject } from './timeline'

function assetDir(): string | null {
  const candidates = [join(process.resourcesPath, 'studio-demo'), join(app.getAppPath(), 'resources', 'studio-demo')]
  return candidates.find((dir) => existsSync(dir)) ?? null
}

function addImage(store: StudioStore, project: StudioProject, dir: string | null, file: string, title: string, tags: string[], metadata: Record<string, number> = {}): StudioAsset | null {
  if (!dir) return null
  const path = join(dir, file)
  if (!existsSync(path)) return null
  try {
    const bytes = readFileSync(path)
    return store.addAsset(project, {
      bytes,
      title,
      kindHint: 'image',
      mime: file.endsWith('.png') ? 'image/png' : 'image/jpeg',
      tags,
      origin: { source: 'demo' },
      metadata
    })
  } catch {
    return null
  }
}

function addAudio(store: StudioStore, project: StudioProject, dir: string | null, file: string, title: string, tags: string[]): StudioAsset | null {
  if (!dir) return null
  const path = join(dir, file)
  if (!existsSync(path)) return null
  try {
    return store.addAsset(project, {
      bytes: readFileSync(path),
      title,
      kindHint: 'audio',
      mime: 'audio/wav',
      tags,
      origin: { source: 'demo' }
    })
  } catch {
    return null
  }
}

function charactersOf(source: typeof CORPUS.jisu.characters, project: StudioProject): StudioCharacter[] {
  return source.map((item) => ({
    id: studioId('char'),
    name: item.name,
    role: item.role,
    age: item.age,
    look: item.look,
    desire: item.desire,
    fear: item.fear,
    secret: item.secret,
    arc: item.arc,
    relationships: item.relationships.map((rel) => ({ ...rel })),
    refAssetIds: []
  }))
}

function blueprintOf(
  project: StudioProject,
  source: { intro: string; characters: ReturnType<typeof charactersOf>; places: Array<{ name: string; description: string }>; chapters: Array<{ title: string; synopsis: string }> },
  kind: 'short' | 'novel'
): StudioBlueprint {
  return {
    approved: true,
    approvedAt: nowMs(),
    source: 'local',
    storyCore: source.intro,
    emotion: '高压中的克制，胜利后的怀疑',
    audience: project.brief.audience,
    pitch: project.logline,
    structure: `三卷 · ${source.chapters.length} 章`,
    styleBible: {
      look: project.brief.style,
      palette: ['#0b0d10', '#c8ae7d', '#7f9aa2'],
      camera: '近身、克制、以细节承载情绪',
      sound: '雨声、引擎与低频心跳',
      negative: ['不写成爽文流水账', '不改变真实人物动机']
    },
    characters: source.characters,
    places: source.places.map((place) => ({ id: studioId('place'), ...place, refAssetIds: [] })),
    units: source.chapters.map((chapter, index) => ({
      index: index + 1,
      title: chapter.title,
      summary: chapter.synopsis,
      wordTarget: kind === 'short' ? 1600 : 2600
    })),
    estimate: {
      minutesMin: kind === 'short' ? 20 : 60,
      minutesMax: kind === 'short' ? 40 : 120,
      costMin: 0,
      costMax: 0,
      currency: 'CNY',
      lines: [{ label: '本地结构稿', costMin: 0, costMax: 0, note: '不调用云端模型' }],
      note: '样例使用本地结构稿；真实模型费用按实际账单记录。',
      basis: 'local'
    },
    warnings: ['这是基于真实细纲整理的可编辑样例，不是原文复制。'],
    createdAt: nowMs()
  }
}

function seedNovel(
  store: StudioStore,
  dir: string | null,
  source: typeof CORPUS.jisu | typeof CORPUS.zaizao | typeof CORPUS.short,
  kind: 'short' | 'novel',
  coverFile: string
): StudioProject {
  const isJisu = source.title === CORPUS.jisu.title || source.title === CORPUS.short.title
  const isZaizao = source.title === CORPUS.zaizao.title
  const project = store.newProject({
    kind,
    title: source.title,
    logline: source.logline,
    brief: {
      form: kind === 'short' ? '速成草稿' : '精制',
      genre: isJisu ? '赛车竞技' : '历史穿越',
      audience: kind === 'short' ? '喜欢强情节短篇的读者' : '喜欢人物成长与专业细节的长篇读者',
      tone: '高压、克制、在速度与选择之间',
      style: isJisu ? '雨夜赛道、冷青与赛车暖金、真实机械细节' : '五代乱世、灰暗焦土与一线暖金、真实布料与尘土',
      aspect: '16:9',
      constraints: ['尊重真实细纲的人物与关键事件', '不把专业细节写成空话', '手改优先'],
      targetWords: kind === 'short' ? 18_000 : 300_000
    },
    demo: true
  })
  const characters = charactersOf(source.characters as typeof CORPUS.jisu.characters, project)
  const blueprint = blueprintOf(project, { intro: source.intro, characters, places: source.places, chapters: source.chapters }, kind)
  project.blueprint = blueprint
  project.characters = characters
  project.places = blueprint.places
  project.stage = 'writing'
  const volumes = [
    { title: '第一卷 · 雨幕与曲线', from: 1, to: 4 },
    { title: '第二卷 · 失控与代价', from: 5, to: 8 },
    { title: '第三卷 · 黎明之前', from: 9, to: 12 }
  ]
  const chapterList: StudioChapter[] = []
  for (const [index, chapter] of source.chapters.entries()) {
    const number = index + 1
    const volume = volumes.find((item) => number >= item.from && number <= item.to) ?? volumes[volumes.length - 1]
    if (!project.volumes.some((item) => item.title === volume.title)) {
      project.volumes.push({ id: studioId('vol'), title: volume.title, summary: volume.title.split(' · ')[1] ?? '', number: project.volumes.length + 1, chapterIds: [] })
    }
    const volumeRecord = project.volumes.find((item) => item.title === volume.title)!
    const paragraphs = (source.written as Record<string, string[]>)[String(number)]
    const content = Array.isArray(paragraphs) ? paragraphs.join('\n\n') : ''
    const record: StudioChapter = {
      id: studioId('ch'),
      volumeId: volumeRecord.id,
      number,
      title: chapter.title,
      synopsis: chapter.synopsis,
      beats: [chapter.synopsis],
      content,
      wordTarget: kind === 'short' ? 1600 : 2600,
      status: content ? 'done' : 'ready',
      revision: content ? 2 : 1,
      candidates: [],
      versions: [],
      illustrations: [],
      locked: Boolean(content),
      updatedAt: nowMs()
    }
    if (content) store.addChapterVersion(record, content, '样例初始稿')
    if (number === 4) {
      record.candidates.push({
        id: studioId('cand'),
        content: content || `${chapter.title}\n\n${chapter.synopsis}\n\n这是用于测试候选稿的样例，不会自动覆盖手改。`,
        label: '候选稿 · 结构重写',
        source: 'local',
        note: '样例候选：只用于验证采用/对比/回滚',
        createdAt: nowMs(),
        wordCount: chapter.synopsis.length
      })
    }
    volumeRecord.chapterIds.push(record.id)
    chapterList.push(record)
  }
  project.chapters = chapterList
  project.facts = source.facts.map((fact, index) => ({
    id: studioId('fact'),
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    ...(chapterList[Math.min(index, chapterList.length - 1)] ? { chapterId: chapterList[Math.min(index, chapterList.length - 1)].id } : {}),
    confidence: 0.9,
    source: 'local',
    createdAt: nowMs()
  }))
  const cover = addImage(store, project, dir, coverFile, `《${source.title}》封面`, ['cover', 'demo'], { width: 768, height: 1024 })
  if (cover) project.coverAssetId = cover.id
  if (isJisu) {
    for (const [index, file] of ['jisu-02.jpg', 'jisu-04.jpg', 'jisu-05.jpg'].entries()) {
      const ref = addImage(store, project, dir, file, `角色参考 · ${characters[index]?.name ?? ''}`, ['reference', 'character', 'demo'], { width: 1344, height: 768 })
      if (ref && characters[index]) characters[index].refAssetIds = [ref.id]
    }
    const illustration = addImage(store, project, dir, 'jisu-06.jpg', '配图 · 雨停后的赛道', ['illustration', 'demo'], { width: 1344, height: 768 })
    if (illustration && chapterList[0]) chapterList[0].illustrations.push({ id: studioId('ill'), assetId: illustration.id, afterParagraph: 1, caption: '雨停后的赛道', source: 'import', createdAt: nowMs() })
  }
  if (isZaizao) {
    const illustration = addImage(store, project, dir, 'huaxia-01.jpg', '配图 · 邺城战场', ['illustration', 'demo'], { width: 1344, height: 768 })
    if (illustration && chapterList[0]) chapterList[0].illustrations.push({ id: studioId('ill'), assetId: illustration.id, afterParagraph: 1, caption: '邺城战场', source: 'import', createdAt: nowMs() })
  }
  const written = chapterList.filter((chapter) => chapter.content.trim()).length
  project.stages.blueprint = { status: 'done', updatedAt: nowMs(), message: '真实细纲已确认', progress: 100 }
  project.stages.outline = { status: 'done', updatedAt: nowMs(), message: `${chapterList.length} 章细纲已就位`, progress: 100 }
  project.stages.writing = { status: written === chapterList.length ? 'done' : 'ready', updatedAt: nowMs(), message: `已完成 ${written}/${chapterList.length} 章`, progress: Math.round((written / chapterList.length) * 100) }
  project.stages.visuals = { status: cover ? 'done' : 'ready', updatedAt: nowMs(), message: cover ? '封面与章节配图已就位' : '还没有封面', progress: cover ? 100 : 0 }
  project.stages.review = { status: 'ready', updatedAt: nowMs(), message: '可以运行检查', progress: 0 }
  project.stages.delivery = { status: 'ready', updatedAt: nowMs(), message: '可以导出成书', progress: 0 }
  project.runtime.textModelNote = '样例细纲 · 本地结构'
  project.messages.push(
    { id: studioId('msg'), role: 'assistant', text: `这是根据真实细纲整理的《${source.title}》样例。章节、人物与事实都可编辑；第 4 章留了一个候选稿，用来测试采用与回滚。`, createdAt: nowMs() }
  )
  store.save(project, `初始化真实语料 · ${source.title}`, { snapshot: false })
  try { store.writeVersion(store.readProject(project.id), `初始化真实语料 · ${source.title}`) } catch { /* ignore */ }
  return project
}

function seedDrama(store: StudioStore, dir: string | null): StudioProject {
  const source = CORPUS.drama
  const project = store.newProject({
    kind: 'drama',
    title: source.title,
    logline: source.logline,
    brief: {
      form: '精制',
      genre: '赛车竞技',
      audience: '喜欢高压竞技与人物对抗的 18–35 岁观众',
      tone: '雨幕、引擎、克制的胜负',
      style: '冷青雨夜与赛车暖金、真实机械与雨滴细节',
      aspect: '16:9',
      constraints: ['角色脸不换', '雨丝方向一致', '速度感真实', '不出现文字水印'],
      targetSeconds: 96
    },
    demo: true
  })
  const characters: StudioCharacter[] = [
    { id: studioId('char'), name: '陈雁', role: '车手', age: '22', look: '瘦削、黑发、深色赛车服，眼神锋利', desire: '用直觉赢下比赛', fear: '被证明只是运气', relationships: [{ target: '林烨', label: '互相不服的搭档' }], refAssetIds: [] },
    { id: studioId('char'), name: '林烨', role: '数据工程师', age: '26', look: '华裔、细框眼镜、深色车队外套', desire: '把天赋变成可复现的科学', fear: '模型漏掉人性', relationships: [{ target: '陈雁', label: '他想要证明的人' }], refAssetIds: [] },
    { id: studioId('char'), name: '苏小楠', role: '记者', age: '24', look: '短发、深色外套、录音笔', desire: '写出真问题', fear: '只是看客', relationships: [{ target: '陈雁', label: '采访对象' }], refAssetIds: [] }
  ]
  const places = [
    { id: studioId('place'), name: '蒙扎赛道', description: '雨幕长直道与旧看台', refAssetIds: [] },
    { id: studioId('place'), name: 'P房', description: '数据屏与轮胎', refAssetIds: [] },
    { id: studioId('place'), name: '发布会', description: '闪光灯与尖锐问题', refAssetIds: [] }
  ]
  const blueprint: StudioBlueprint = {
    approved: true,
    approvedAt: nowMs(),
    source: 'local',
    storyCore: '0.12秒不只是数据偏差，它是直觉与科学第一次互相看见的缝隙。',
    emotion: '高压、克制、在胜利后立刻被质疑',
    audience: project.brief.audience,
    pitch: source.intro,
    structure: '三幕 · 12 镜 / 96 秒：雨战 / 质疑 / 黎明',
    styleBible: { look: project.brief.style, palette: ['#080a0d', '#c8ae7d', '#41697d'], camera: '低机位追拍与克制特写', sound: '引擎、雨声、低频心跳', negative: ['文字', '水印', '卡通'] },
    characters,
    places,
    units: source.shots.map((shot, index) => ({ index: index + 1, title: shot.title, summary: shot.action, seconds: shot.durationSec, camera: shot.camera, shotSize: shot.shotSize, dialogue: shot.dialogue, speaker: shot.speaker })),
    estimate: { minutesMin: 2, minutesMax: 5, costMin: 0, costMax: 0, currency: 'CNY', lines: [{ label: '本地样例素材', costMin: 0, costMax: 0, note: '随包图片与配音' }], note: '样例使用随包画面与本地配音，不调用云端模型。', basis: 'local' },
    warnings: ['这是根据真实细纲重写的赛车漫剧样例。'],
    createdAt: nowMs()
  }
  project.blueprint = blueprint
  project.characters = characters
  project.places = places
  project.stage = 'timeline'
  const cover = addImage(store, project, dir, 'jisu-cover.jpg', '《0.12秒》封面', ['cover', 'demo'], { width: 768, height: 1024 })
  const images: StudioAsset[] = []
  for (const file of ['jisu-01.jpg', 'jisu-02.jpg', 'jisu-03.jpg', 'jisu-04.jpg', 'jisu-05.jpg', 'jisu-06.jpg']) {
    const asset = addImage(store, project, dir, file, `分镜画面 · ${file.replace('.png', '')}`, ['image', 'storyboard', 'demo'], { width: 1344, height: 768 })
    if (asset) images.push(asset)
  }
  if (cover) project.coverAssetId = cover.id
  else if (images[0]) project.coverAssetId = images[0].id
  for (const [index, character] of characters.entries()) {
    const ref = images[index + 1] ?? images[index]
    if (ref) character.refAssetIds = [ref.id]
  }
  const voices: Record<string, StudioAsset | null> = {}
  for (const file of ['voice-jisu-01.wav', 'voice-jisu-02.wav', 'voice-jisu-03.wav', 'voice-jisu-04.wav']) {
    voices[file] = addAudio(store, project, dir, file, `配音 · ${file.replace('voice-jisu-', '').replace('.wav', '')}`, ['voice', 'demo'])
  }
  const scene = { id: studioId('scene'), episodeId: null, number: 1, title: '蒙扎雨战', synopsis: '最后一圈与0.12秒的偏差', location: '蒙扎赛道', timeOfDay: '雨夜', characters: ['陈雁', '林烨', '苏小楠'], beat: '救车→夺冠→质疑', updatedAt: nowMs() }
  project.scenes = [scene]
  project.shots = source.shots.map((item, index) => ({
    id: studioId('shot'),
    sceneId: scene.id,
    number: index + 1,
    title: item.title,
    action: item.action,
    camera: item.camera,
    shotSize: item.shotSize,
    durationSec: item.durationSec,
    dialogue: item.dialogue,
    speaker: item.speaker,
    voiceId: characters.find((character) => character.name === item.speaker)?.voiceId ?? '',
    prompt: `${item.action}。${project.brief.style}。保持人物面部、赛车与雨向一致。`,
    negative: '文字，水印，畸形手，多余手指，卡通，过度锐化',
    referenceCharacterIds: item.speaker ? characters.filter((character) => character.name === item.speaker).map((character) => character.id) : [],
    referencePlaceIds: [places[0].id],
    referencePropIds: [],
    imageAssetId: images[index % Math.max(1, images.length)]?.id ?? null,
    videoAssetId: null,
    voiceAssetId: item.voice ? voices[item.voice]?.id ?? null : null,
    imageCandidates: images[index % Math.max(1, images.length)]?.id ? [{ id: studioId('cand'), assetId: images[index % Math.max(1, images.length)]!.id, label: '样例画面', source: 'import' as const, createdAt: nowMs(), adopted: true }] : [],
    videoCandidates: [],
    continuity: item.continuity,
    lockedReference: true,
    status: 'done',
    updatedAt: nowMs()
  })) as StudioShot[]
  const music = addAudio(store, project, dir, 'music-rain.wav', '配乐 · 雨幕与引擎', ['music', 'demo'])
  for (const [file, tag] of [['sfx-rain.wav', 'rain'], ['sfx-heartbeat.wav', 'heartbeat']] as const) {
    addAudio(store, project, dir, file, `音效 · ${tag}`, ['sfx', tag, 'demo'])
  }
  project.timeline = buildTimelineFromProject(project)
  project.timeline.version = 2
  project.stages.blueprint = { status: 'done', updatedAt: nowMs(), message: '蓝图已确认', progress: 100 }
  project.stages.outline = { status: 'done', updatedAt: nowMs(), message: '12 镜剧本已就位', progress: 100 }
  project.stages.storyboard = { status: 'done', updatedAt: nowMs(), message: '12 镜已就位', progress: 100 }
  project.stages.visuals = { status: 'done', updatedAt: nowMs(), message: '12 镜均有画面', progress: 100 }
  project.stages.voice = { status: 'done', updatedAt: nowMs(), message: '关键台词已配音', progress: 100 }
  project.stages.music = { status: music ? 'done' : 'ready', updatedAt: nowMs(), message: music ? '配乐与音效已就位' : '可以使用本地音效', progress: music ? 100 : 0 }
  project.stages.timeline = { status: 'done', updatedAt: nowMs(), message: '五轨时间线已装配', progress: 100 }
  project.stages.review = { status: 'ready', updatedAt: nowMs(), message: '可以运行视觉检查与合成检查', progress: 0 }
  project.stages.delivery = { status: 'ready', updatedAt: nowMs(), message: '可以合成草稿', progress: 0 }
  project.messages.push({ id: studioId('msg'), role: 'assistant', text: '这是根据《极速曙光》雨战细纲重写的赛车漫剧样例：12 镜、4 段关键台词和五轨时间线都已就位。可以逐镜检查或直接合成草稿。', createdAt: nowMs() })
  store.save(project, '初始化真实语料 · 0.12秒', { snapshot: false })
  try { store.writeVersion(store.readProject(project.id), '初始化真实语料 · 0.12秒') } catch { /* ignore */ }
  return project
}

export function ensureCorpusProjects(store: StudioStore): void {
  const marker = join(store.root, '.corpus-seeded-v1')
  if (existsSync(marker)) return
  const dir = assetDir()
  try {
    if (!store.summaries().some((summary) => summary.title === CORPUS.jisu.title)) seedNovel(store, dir, CORPUS.jisu, 'novel', 'jisu-cover.jpg')
    if (!store.summaries().some((summary) => summary.title === CORPUS.zaizao.title)) seedNovel(store, dir, CORPUS.zaizao, 'novel', 'huaxia-cover.jpg')
    if (!store.summaries().some((summary) => summary.title === CORPUS.short.title)) seedNovel(store, dir, CORPUS.short, 'short', 'jisu-short-cover.jpg')
    if (!store.summaries().some((summary) => summary.title === CORPUS.drama.title)) seedDrama(store, dir)
    writeFileSync(marker, `${JSON.stringify({ seededAt: new Date().toISOString(), assets: Boolean(dir), projects: 4 })}\n`, 'utf8')
  } catch {
    // 单个样例失败不阻断作品库；下次打开会重试
  }
}
