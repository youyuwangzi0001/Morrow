// 三份可回归的样例作品：中短篇、长篇、漫剧。
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { StudioAsset, StudioBlueprint, StudioDelivery, StudioProject } from '../../shared/studio'
import { emptyTimeline, countWords, timelineDuration } from '../../shared/studio'
import {
  StudioStore,
  nowMs,
  sha256File,
  studioId
} from './store'
import {
  applyBlueprintToProject,
  createDemoDramaBlueprint,
  demoChapterProse,
  localBlueprint,
  localChapterDraft,
  localRewrite,
  readSeeds
} from './local-creative'
import { buildTimelineFromProject } from './timeline'
import { listSystemVoices } from './audio'
import { resolveFfmpegPaths } from './render'
import { exportTxt } from './exporter'

const DEMO_LOG_LINE = '一个雨夜，修伞的女孩捡到一把会让时间倒流的伞。她每修好一把伞，就会失去一段记忆。'

function demoAssetDir(): string | null {
  const candidates = [join(process.resourcesPath, 'studio-demo'), join(app.getAppPath(), 'resources', 'studio-demo')]
  return candidates.find((dir) => existsSync(dir)) ?? null
}

function thumbFor(file: string, projectId: string, store: StudioStore): Buffer | null {
  const paths = resolveFfmpegPaths()
  if (!paths) return null
  const temp = join(store.tempDir(projectId), `demo-thumb-${Date.now().toString(36)}.jpg`)
  try {
    mkdirSync(join(temp, '..'), { recursive: true })
    const result = spawnSync(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=560:-2', '-q:v', '4', temp], {
      windowsHide: true,
      timeout: 30_000
    })
    if (result.status === 0 && existsSync(temp)) {
      const data = require('node:fs').readFileSync(temp) as Buffer
      require('node:fs').rmSync(temp, { force: true })
      return data
    }
  } catch {
  }
  try {
    require('node:fs').rmSync(temp, { force: true })
  } catch {
  }
  return null
}

function probeDuration(file: string): number | undefined {
  const ffprobe = resolveFfmpegPaths()?.ffprobe
  if (!ffprobe) return undefined
  const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000
  })
  const value = Number((result.stdout ?? '').trim())
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : undefined
}

function addDemoAsset(
  store: StudioStore,
  project: StudioProject,
  dir: string,
  file: string,
  title: string,
  tags: string[]
): StudioAsset | null {
  const path = join(dir, file)
  if (!existsSync(path)) return null
  try {
    const ext = file.split('.').pop() ?? ''
    const kind = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'image' : ['mp4', 'webm', 'mov'].includes(ext) ? 'video' : ['wav', 'mp3'].includes(ext) ? 'audio' : 'other'
    const bytes = require('node:fs').readFileSync(path) as Buffer
    const thumb = kind === 'image' || kind === 'video' ? thumbFor(path, project.id, store) : null
    return store.addAsset(project, {
      bytes,
      title,
      kindHint: kind,
      tags,
      mime: ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'mp4' ? 'video/mp4' : ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'application/octet-stream',
      origin: { source: 'demo' },
      metadata: kind === 'audio' ? { durationSec: probeDuration(path) } : {},
      ...(thumb ? { thumbBytes: thumb } : {})
    })
  } catch {
    return null
  }
}

function attachDeliveryFromFile(store: StudioStore, project: StudioProject, dir: string, file: string, label: string, kind: StudioDelivery['kind']): void {
  const source = join(dir, file)
  if (!existsSync(source)) return
  const exportsDir = store.exportsDir(project.id)
  mkdirSync(exportsDir, { recursive: true })
  const targetName = file.replace(/^demo-/, '')
  const target = join(exportsDir, targetName)
  copyFileSync(source, target)
  const path = `exports/${targetName}`
  const delivery: StudioDelivery = {
    id: studioId('delivery'),
    kind,
    label,
    path,
    bytes: statSync(target).size,
    sha256: sha256File(target),
    createdAt: nowMs(),
    meta: { demo: true }
  }
  project.deliveries.unshift(delivery)
}

function demoCharacters(project: StudioProject, dir: string | null, store: StudioStore) {
  const blueprint = createDemoDramaBlueprint(project, Boolean(dir))
  if (dir) {
    const refs: Record<string, StudioAsset | null> = {}
    for (const [key, file] of [
      ['linwan', 'ref-linwan.jpg'],
      ['boy', 'ref-boy.jpg'],
      ['grandma', 'ref-grandma.jpg']
    ] as const) {
      refs[key] = addDemoAsset(store, project, dir, file, `角色参考 · ${key}`, ['reference', 'character', key])
    }
    if (refs.linwan) blueprint.characters[0].refAssetIds = [refs.linwan.id]
    if (refs.boy) blueprint.characters[1].refAssetIds = [refs.boy.id]
    if (refs.grandma) blueprint.characters[2].refAssetIds = [refs.grandma.id]
  }
  return blueprint
}

/** 把本地结构稿里的随机姓名统一成样例人物，避免同一部作品出现两套名字。 */
function localizeDemoText(project: StudioProject, text: string): string {
  const seeds = readSeeds(project.logline, project.title)
  return text
    .replaceAll(seeds.protagonist, '林晚')
    .replaceAll(seeds.companion, '少年')
    .replaceAll(seeds.elder, '外婆')
}

function appendUniqueParagraphs(base: string, extra: string): string {
  const seen = new Set(base.split(/\n{2,}/).map((paragraph) => paragraph.trim().replace(/\s+/g, ' ').slice(0, 32)).filter(Boolean))
  const add: string[] = []
  for (const paragraph of extra.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)) {
    const key = paragraph.replace(/\s+/g, ' ').slice(0, 32)
    if (!key || seen.has(key)) continue
    seen.add(key)
    add.push(paragraph)
  }
  return add.length ? `${base}\n\n${add.join('\n\n')}` : base
}

function expandedDemoChapter(project: StudioProject, chapter: StudioProject['chapters'][number], base: string): string {
  let content = localizeDemoText(project, base)
  if (countWords(content) < 1900) {
    const extra = localizeDemoText(project, localChapterDraft(project, chapter, '补足本章中间的细节与对话，不改变梗概'))
    content = appendUniqueParagraphs(content, extra)
  }
  if (countWords(content) < 1600) {
    const extra = localizeDemoText(project, localChapterDraft(project, chapter, '把场景推到本章的转折点，保留人物语气'))
    content = appendUniqueParagraphs(content, extra)
  }
  return content
}

function markStage(project: StudioProject, id: StudioProject['stage'], status: StudioProject['stages'][StudioProject['stage']]['status'], message: string, progress: number): void {
  project.stages[id] = { status, updatedAt: nowMs(), message, progress }
}

function seedDrama(store: StudioStore, dir: string | null): StudioProject {
  const project = store.newProject({
    kind: 'drama',
    title: '逆行的伞',
    logline: DEMO_LOG_LINE,
    brief: {
      form: '速成草稿',
      genre: '都市奇幻',
      audience: '喜欢都市奇幻短片的 18–35 岁观众',
      tone: '克制的悲伤 → 温柔的释然',
      style: '低饱和雨夜、暖色灯、轻微胶片颗粒',
      aspect: '16:9',
      constraints: ['角色脸不换', '雨丝方向一致', '16:9', '无旁白'],
      references: ['示例：雨夜旧城、修伞铺、纸鹤'],
      targetSeconds: 96
    },
    demo: true
  })
  const blueprintBase = createDemoDramaBlueprint(project, Boolean(dir))
  blueprintBase.approved = true
  blueprintBase.approvedAt = nowMs()
  applyBlueprintToProject(project, blueprintBase)
  project.blueprint = { ...blueprintBase }
  project.demo = true
  project.title = '逆行的伞'
  const images: StudioAsset[] = []
  if (dir) {
    const files = readdirSync(dir)
      .filter((file) => /^drama-\d+\.(png|jpg|jpeg)$/i.test(file))
      .sort()
    for (const [index, file] of files.entries()) {
      const asset = addDemoAsset(store, project, dir, file, `样例分镜 ${String(index + 1).padStart(2, '0')}`, ['image', 'storyboard', 'demo'])
      if (asset) images.push(asset)
    }
  }
  for (const [index, shot] of project.shots.entries()) {
    const asset = images[index % Math.max(1, images.length)]
    if (asset) {
      shot.imageAssetId = asset.id
      shot.imageCandidates.unshift({
        id: studioId('cand'),
        assetId: asset.id,
        label: '样例画面',
        source: 'import',
        createdAt: nowMs(),
        adopted: true
      })
      shot.status = 'done'
    }
  }
  const cover = dir ? addDemoAsset(store, project, dir, 'drama-cover.jpg', '《逆行的伞》封面', ['cover', 'demo']) : null
  if (cover) project.coverAssetId = cover.id
  else if (images[0]) project.coverAssetId = images[0].id
  if (dir) {
    const refs: Record<string, StudioAsset | null> = {
      linwan: addDemoAsset(store, project, dir, 'ref-linwan.jpg', '角色参考 · 林晚', ['reference', 'character', 'demo']),
      boy: addDemoAsset(store, project, dir, 'ref-boy.jpg', '角色参考 · 少年', ['reference', 'character', 'demo']),
      grandma: addDemoAsset(store, project, dir, 'ref-grandma.jpg', '角色参考 · 外婆', ['reference', 'character', 'demo'])
    }
    if (refs.linwan) project.characters[0].refAssetIds = [refs.linwan.id]
    if (refs.boy) project.characters[1].refAssetIds = [refs.boy.id]
    if (refs.grandma) project.characters[2].refAssetIds = [refs.grandma.id]
  }

  const voiceNames = listSystemVoices().voices
  const zhVoice = voiceNames.find((voice) => voice.culture.startsWith('zh'))?.name
  const pickVoice = (needle: string): string => voiceNames.find((voice) => voice.name.toLowerCase().includes(needle))?.name ?? zhVoice ?? ''
  const linVoice = pickVoice('huihui')
  const boyVoice = pickVoice('kangkang')
  const grandmaVoice = pickVoice('yaoyao')
  if (project.characters[0]) project.characters[0].voiceId = linVoice
  if (project.characters[1]) project.characters[1].voiceId = boyVoice
  if (project.characters[2]) project.characters[2].voiceId = grandmaVoice
  if (dir) {
    for (const shot of project.shots) {
      if (!shot.dialogue.trim()) continue
      const file = `voice-${String(shot.number).padStart(2, '0')}.wav`
      const voice = addDemoAsset(store, project, dir, file, `样例配音 · 第 ${shot.number} 镜`, ['voice', 'demo', `shot:${shot.id}`])
      if (voice) {
        shot.voiceAssetId = voice.id
        shot.voiceId = project.characters.find((character) => character.name === shot.speaker)?.voiceId ?? zhVoice ?? ''
      }
    }
    const music = addDemoAsset(store, project, dir, 'music-rain.wav', '配乐 · 雨幕下的钢琴', ['music', 'demo'])
    if (music) {
      project.stages.music = { status: 'done', updatedAt: nowMs(), message: '样例配乐已就位', progress: 100 }
    }
    for (const [file, title, tag] of [
      ['sfx-rain.wav', '音效 · 雨声', 'rain'],
      ['sfx-umbrella.wav', '音效 · 伞骨', 'umbrella'],
      ['sfx-heartbeat.wav', '音效 · 心跳', 'heartbeat']
    ] as const) {
      addDemoAsset(store, project, dir, file, title, ['sfx', tag, 'demo'])
    }
  }
  project.timeline = buildTimelineFromProject(project)
  project.timeline.version = 4
  project.stage = 'timeline'
  markStage(project, 'blueprint', 'done', '蓝图已确认', 100)
  markStage(project, 'outline', 'done', '12 镜剧本与节拍', 100)
  markStage(project, 'storyboard', 'done', '12 镜已就位', 100)
  markStage(project, 'visuals', images.length ? 'done' : 'ready', images.length ? '12 镜全部有画面' : '等待生成画面', images.length ? 100 : 0)
  markStage(project, 'voice', 'done', '7 段对白已配音', 100)
  markStage(project, 'music', 'done', '配乐与音效已就位', 100)
  markStage(project, 'timeline', 'done', '时间线 v4 · 96 秒', 100)
  markStage(project, 'review', 'ready', '可以运行检查', 0)
  if (dir) {
    attachDeliveryFromFile(store, project, dir, 'demo-draft.mp4', '样例动态分镜草稿 · 96 秒', 'mp4')
    if (project.deliveries.length) markStage(project, 'delivery', 'done', '样例草稿已就绪', 100)
    else markStage(project, 'delivery', 'ready', '可以合成草稿', 0)
  }
  if (dir) attachDeliveryFromFile(store, project, dir, 'demo-draft-poster.jpg', '成片预览帧', 'cover')
  project.runtime.imageModelNote = dir ? '样例画面（随包）' : '未配置'
  project.runtime.videoModelNote = dir ? '可按镜升级为视频' : '未配置'
  project.runtime.textModelNote = '示例蓝图'
  project.messages.push(
    {
      id: studioId('msg'),
      role: 'assistant',
      text: '这是《逆行的伞》的完整样例：蓝图、12 镜、配音、配乐和时间线都已经就位。你可以直接播放、拖动片段，或说“镜 03 慢 20%，雨声压低一点”试试大白话改片。',
      createdAt: nowMs()
    },
    {
      id: studioId('msg'),
      role: 'user',
      text: '先把雨丝方向统一，再重做镜 07。不要改脸。',
      createdAt: nowMs() + 1
    },
    {
      id: studioId('msg'),
      role: 'assistant',
      text: '我把这句话拆成了 3 个动作：统一雨向、锁定角色 R2 的面部、只重做镜 07。确认后才会重做，旧候选会保留。',
      createdAt: nowMs() + 2
    }
  )
  store.save(project, '初始化样例 · 逆行的伞', { snapshot: false })
  try { store.writeVersion(store.readProject(project.id), '初始化样例 · 逆行的伞') } catch { /* ignore */ }
  return project
}

function seedNovel(store: StudioStore, dir: string | null): StudioProject {
  const project = store.newProject({
    kind: 'novel',
    title: '雨伞铺的第七个夏天',
    logline: '一个修伞的女孩继承外婆的伞铺，每周三都会有一个失忆的少年，来修同一把黑伞。',
    brief: {
      form: '精制',
      genre: '都市奇幻',
      audience: '喜欢慢热人物故事的长篇读者',
      tone: '克制、潮湿、温柔',
      style: '旧城梅雨、纸张与铁锈的气味',
      aspect: '16:9',
      constraints: ['林晚视角为主', '外婆只以声音与旧物出现', '不解释时间旅行的原理'],
      targetWords: 300_000
    },
    demo: true
  })
  const base = localBlueprint(project, { imagesReady: Boolean(dir), textConfigured: false })
  const demo = demoCharacters(project, dir, store)
  const blueprint: StudioBlueprint = {
    ...base,
    approved: true,
    approvedAt: nowMs(),
    source: 'import',
    storyCore: '一个修伞的女孩，在雨夜捡到一把能让时间倒流的伞。她每修好一把伞，就会失去一段记忆。',
    emotion: '克制的悲伤 → 温柔的释然',
    audience: '喜欢慢生活奇幻的长篇读者',
    pitch: '一部三卷 36 章的长篇：从一把倒着走的伞开始，写一个人如何学会带着遗忘继续生活。',
    structure: '三卷 · 36 章 / 计划约 30 万字',
    characters: demo.characters,
    places: demo.places,
    styleBible: demo.styleBible,
    units: base.units.map((unit, index) => ({
      ...unit,
      title:
        index < 7
          ? ['修伞的人', '第七把伞', '竹骨', '雨里的信', '旧照片', '少年', '纸伞与铁骨'][index]
          : unit.title,
      summary: localizeDemoText(project,
        index < 7
          ? [
              '林晚在雨夜捡到一把反着撑开的黑伞，决定把它留下。',
              '少年第一次出现，带来一个无法拒绝的请求；林晚开始怀疑自己的记忆。',
              '她在旧工具箱里找到外婆留下的竹尺，发现修伞有另一种代价。',
              '一封被雨泡皱的信让林晚第一次回到七年前。',
              '旧照片里出现一个陌生男孩，手里也捧着黑伞。',
              '少年承认自己每周三来，不是为了修伞。',
              '林晚发现黑伞的内侧写着外婆的名字，以及一句“让他等”。'
            ][index]
          : unit.summary),
      wordTarget: 2600
    }))
  }
  applyBlueprintToProject(project, blueprint)
  project.blueprint = { ...blueprint }
  project.title = '雨伞铺的第七个夏天'
  for (const [index, chapter] of project.chapters.entries()) {
    if (index < 7) {
      chapter.content = expandedDemoChapter(project, chapter, demoChapterProse(project, index + 1))
      chapter.wordTarget = 2200
      chapter.status = 'done'
      chapter.locked = true
      chapter.updatedAt = nowMs()
      chapter.revision = 1
    }
  }
  const seventh = project.chapters[6]
  if (seventh?.content) {
    const rewrite = localRewrite(seventh.content, '更克制一点，收掉解释，留下动作')
    seventh.candidates.push({
      id: studioId('cand'),
      content: rewrite,
      label: '本地改写 · 更克制',
      source: 'local',
      note: '把“熟悉的”改成“刚刚熄灭的”，与第 3 章呼应',
      createdAt: nowMs(),
      wordCount: countWords(rewrite)
    })
  }
  const chapterThree = project.chapters[2]
  if (chapterThree && seventh) {
    project.facts.push(
      {
        id: studioId('fact'),
        subject: '黑伞的伞骨',
        predicate: '材质',
        object: '第 3 章写的是竹制伞骨',
        chapterId: chapterThree.id,
        confidence: 0.82,
        source: 'manual',
        createdAt: nowMs()
      },
      {
        id: studioId('fact'),
        subject: '黑伞的伞骨',
        predicate: '材质',
        object: '第 7 章写成了铁骨',
        chapterId: seventh.id,
        confidence: 0.72,
        source: 'manual',
        createdAt: nowMs()
      }
    )
  }
  if (dir) {
    const cover = addDemoAsset(store, project, dir, 'novel-cover.jpg', '《雨伞铺的第七个夏天》封面', ['cover', 'demo'])
    if (cover) project.coverAssetId = cover.id
    const linwan = addDemoAsset(store, project, dir, 'ref-linwan.jpg', '人物参考 · 林晚', ['reference', 'character', 'demo'])
    const boy = addDemoAsset(store, project, dir, 'ref-boy.jpg', '人物参考 · 少年', ['reference', 'character', 'demo'])
    if (linwan) project.characters[0].refAssetIds = [linwan.id]
    if (boy) project.characters[1].refAssetIds = [boy.id]
  }
  project.stage = 'writing'
  markStage(project, 'blueprint', 'done', '蓝图已确认', 100)
  markStage(project, 'outline', 'done', '三卷 36 章大纲已建立', 100)
  markStage(project, 'writing', 'review', '7/36 章完成，第 7 章有候选待采用', 19)
  markStage(project, 'visuals', 'ready', '可以为章节规划配图', 0)
  markStage(project, 'review', 'ready', '可以检查人物与事实', 0)
  markStage(project, 'delivery', 'ready', '初稿完成度还不够，先继续写', 0)
  project.runtime.textModelNote = '本地结构稿 + 手写样例'
  project.messages.push({
    id: studioId('msg'),
    role: 'assistant',
    text: '《雨伞铺的第七个夏天》已经写到第 7 章。第 3 章说“竹制伞骨”，第 7 章却出现“铁骨”——我在事实里标了提醒，你可以决定是设定变更，还是少年带来的另一把伞。',
    createdAt: nowMs()
  })
  store.save(project, '初始化样例 · 雨伞铺的第七个夏天', { snapshot: false })
  try { store.writeVersion(store.readProject(project.id), '初始化样例 · 雨伞铺的第七个夏天') } catch { /* ignore */ }
  return project
}

function seedShort(store: StudioStore, dir: string | null): StudioProject {
  const project = store.newProject({
    kind: 'short',
    title: '雨停之前',
    logline: '一个修伞的女孩在雨停之前，收到七年前寄出的一封信；写信的人已经不在，但伞还在。',
    brief: {
      form: '速成草稿',
      genre: '都市奇幻',
      audience: '喜欢温柔短篇的读者',
      tone: '克制、安静、最后有一点亮',
      style: '旧城、雨声、伞面与信纸',
      aspect: '16:9',
      constraints: ['第一人称限知', '外婆不直接出场', '结尾不解释时间规则'],
      targetWords: 19_200
    },
    demo: true
  })
  const base = localBlueprint(project, { imagesReady: Boolean(dir), textConfigured: false })
  const demo = demoCharacters(project, dir, store)
  const blueprint: StudioBlueprint = {
    ...base,
    approved: true,
    approvedAt: nowMs(),
    source: 'import',
    storyCore: '一个修伞的女孩在雨停之前，收到七年前寄出的一封信；写信的人已经不在，但伞还在。',
    emotion: '悬置 → 认出 → 温柔的释然',
    audience: '喜欢温柔短篇的读者',
    pitch: '一部 12 章的短篇：从一封晚到七年的信开始，写一个人如何把告别修好。',
    structure: '三幕 · 12 章 / 约 1.9 万字',
    characters: demo.characters,
    places: demo.places,
    styleBible: demo.styleBible,
    units: base.units.map((unit, index) => ({
      ...unit,
      summary: localizeDemoText(project, unit.summary),
      title: ['{object}的人', '第七把{object}', '{weather}里的信', '旧{object}与新伤', '{place}的灯', '每周三来的人', '{object}与铁骨', '未寄出的名字', '倒流的{weather}', '针脚里的声音', '最后一次修理', '{weather}停之后'][index % 12]
        .replace('{object}', '伞')
        .replace('{weather}', '雨')
        .replace('{place}', '老街'),
      wordTarget: 1600
    }))
  }
  applyBlueprintToProject(project, blueprint)
  project.blueprint = { ...blueprint }
  project.title = '雨停之前'
  for (const [index, chapter] of project.chapters.entries()) {
    chapter.wordTarget = 1600
    const base = index < 7 ? demoChapterProse(project, index + 1) : localChapterDraft(project, chapter)
    chapter.content = expandedDemoChapter(project, chapter, base)
    chapter.status = 'done'
    chapter.locked = true
    chapter.updatedAt = nowMs()
  }
  if (dir) {
    const cover = addDemoAsset(store, project, dir, 'short-cover.jpg', '《雨停之前》封面', ['cover', 'demo'])
    if (cover) project.coverAssetId = cover.id
  }
  project.stage = 'delivery'
  markStage(project, 'blueprint', 'done', '蓝图已确认', 100)
  markStage(project, 'outline', 'done', '12 章大纲已建立', 100)
  markStage(project, 'writing', 'done', '12 章初稿完成', 100)
  markStage(project, 'review', 'done', '章节完整', 100)
  markStage(project, 'delivery', 'ready', '可导出 TXT / EPUB / PDF', 0)
  project.runtime.textModelNote = '本地结构稿 + 手写样例'
  project.messages.push({
    id: studioId('msg'),
    role: 'assistant',
    text: '《雨停之前》12 章已经写完。可以直接导出，也可以去写作台逐章润色；候选稿不会覆盖你手改的正文。',
    createdAt: nowMs()
  })
  store.save(project, '初始化样例 · 雨停之前', { snapshot: false })
  try {
    exportTxt(store.readProject(project.id))
  } catch {
    // 文本导出失败不影响样例打开
  }
  try { store.writeVersion(store.readProject(project.id), '初始化样例 · 雨停之前') } catch { /* ignore */ }
  return project
}

/** 同步播种：素材只从随包目录复制，不访问网络。 */
export function ensureDemoProjects(store: StudioStore): void {
  const marker = join(store.root, '.demo-seeded-v1')
  if (existsSync(marker)) return
  const dir = demoAssetDir()
  try {
    seedDrama(store, dir)
    seedNovel(store, dir)
    seedShort(store, dir)
    writeFileSync(marker, `${JSON.stringify({ seededAt: new Date().toISOString(), assets: Boolean(dir) })}\n`, 'utf8')
  } catch {
    // 单个样例失败不阻断创作台；下次打开会重试
  }
}
