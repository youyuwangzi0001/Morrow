// 本地创作引擎（离线可用，绝不冒充模型）：
import type {
  StudioBlueprint,
  StudioBlueprintUnit,
  StudioChapter,
  StudioCharacter,
  StudioEpisode,
  StudioEstimate,
  StudioFact,
  StudioKind,
  StudioPlace,
  StudioProject,
  StudioScene,
  StudioShot,
  StudioStyleBible
} from '../../shared/studio'
import { STUDIO_SCHEMA_VERSION, countWords, emptyTimeline } from '../../shared/studio'
import { studioId, nowMs } from './store'

function hash(input: string): number {
  let value = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function pick<T>(items: readonly T[], seed: number, offset = 0): T {
  return items[(seed + offset * 2654435761) % items.length] as T
}

export interface StorySeeds {
  protagonist: string
  companion: string
  elder: string
  role: string
  place: string
  weather: string
  object: string
  power: string
  theme: string
  logline: string
  title: string
  female: boolean
  pronouns: { they: string; their: string; them: string }
  motifs: string[]
}

const FEMALE_NAMES = ['林晚', '沈知遥', '苏禾', '顾青', '陆吟', '江照', '许栀', '陈默'] as const
const MALE_NAMES = ['沈默', '江迟', '陆遥', '周野', '顾川', '许砚', '谢临', '程野'] as const
const ELDERS = ['外婆', '祖母', '老周', '阿婆', '师父'] as const
const PLACES = ['老街', '旧书店', '车站', '海边小镇', '剧院后巷', '灯塔', '咖啡馆', '医院走廊'] as const
const OBJECTS = ['伞', '旧书', '相机', '唱片', '钟表', '钥匙', '照片', '花'] as const
const ROLES = ['修伞匠', '书店老板', '摄影师', '夜间电台主播', '钟表匠', '花店店员', '档案馆管理员', '舞台灯光师'] as const

function firstMatch(text: string, words: readonly string[]): string | null {
  return words.find((word) => text.includes(word)) ?? null
}

export function readSeeds(logline: string, explicitTitle?: string): StorySeeds {
  const seed = hash(logline)
  const female = /女孩|少女|女人|她/.test(logline) ? true : /男孩|少年|男人|他/.test(logline) ? false : seed % 2 === 0
  const protagonist = pick(female ? FEMALE_NAMES : MALE_NAMES, seed)
  const companion = pick(female ? MALE_NAMES : FEMALE_NAMES, seed, 3)
  const elder = pick(ELDERS, seed, 5)
  const object = firstMatch(logline, OBJECTS) ?? pick(OBJECTS, seed, 2)
  const place = firstMatch(logline, PLACES) ?? pick(PLACES, seed, 7)
  const weather = /雨/.test(logline) ? '雨' : /雪/.test(logline) ? '雪' : /风/.test(logline) ? '风' : '夜'
  const role =
    /修伞/.test(logline) ? '修伞匠' : /书/.test(logline) ? '书店老板' : /摄影/.test(logline) ? '摄影师' : /钟/.test(logline) ? '钟表匠' : pick(ROLES, seed, 4)
  const power = /倒着走时间|倒流|回到过去/.test(logline)
    ? '让时间倒流'
    : /记忆/.test(logline)
      ? '收走记忆'
      : /梦/.test(logline)
        ? '走进别人的梦'
        : /命运/.test(logline)
          ? '改写一次命运'
          : '把说过的话变成真的'
  const theme = /记忆/.test(logline) ? '记住与遗忘' : /时间/.test(logline) ? '修补与失去' : /告别|离开/.test(logline) ? '告别与留下' : '得到与代价'
  const title =
    explicitTitle && explicitTitle !== '未命名作品'
      ? explicitTitle
      : /伞/.test(object) && /时间/.test(power)
        ? '逆行的伞'
        : /书/.test(object) && /记忆/.test(power)
          ? '收书的人'
          : `${place}的${object}`
  const motifs = [...new Set([weather, object, place, power.replace(/^让|收走|走进|改写|把/, '').slice(0, 6), theme.split('与')[0] ?? theme])].filter(Boolean)
  return {
    protagonist,
    companion,
    elder,
    role,
    place,
    weather,
    object,
    power,
    theme,
    logline,
    title,
    female,
    pronouns: { they: female ? '她' : '他', their: female ? '她的' : '他的', them: female ? '她' : '他' },
    motifs
  }
}

function styleFor(project: StudioProject, seeds: StorySeeds): StudioStyleBible {
  const palette =
    seeds.weather === '雨'
      ? ['#c8ae7d', '#7fa292', '#c2795f', '#101820']
      : seeds.weather === '雪'
        ? ['#d8d5ce', '#8c9aa8', '#b08a72', '#14161a']
        : ['#c8ae7d', '#9a8fa8', '#7fa292', '#111014']
  return {
    look: `低饱和的${seeds.weather}色质感，${seeds.place}的暖色灯与潮湿反光，轻微胶片颗粒，画面克制不炫技`,
    palette,
    camera: project.kind === 'drama' ? '固定镜头与缓慢推近为主，关键处一次手持跟随；不频繁切镜' : '以人物近景和空镜交替，留白多于解释',
    sound: `环境声先行：${seeds.weather}声、远处的人声与${seeds.object}的细响；钢琴只在高点出现`,
    negative: ['塑料质感', '过度锐化', '夸张 HDR', '文字水印', '前后不一的服装'],
    updatedAt: nowMs()
  }
}

const CHAPTER_TITLES = [
  '{object}的人',
  '第七把{object}',
  '{weather}里的信',
  '旧{object}与新伤',
  '{place}的灯',
  '每周三来的人',
  '{object}与铁骨',
  '未寄出的名字',
  '倒流的{weather}',
  '针脚里的声音',
  '最后一次修理',
  '{weather}停之后'
] as const

const VOLUME_TITLES = ['梅雨', '出梅计划', '雨停之后'] as const

function chapterTitle(index: number, seeds: StorySeeds): string {
  const template = CHAPTER_TITLES[index % CHAPTER_TITLES.length]
  return template.replace('{object}', seeds.object).replace('{weather}', seeds.weather).replace('{place}', seeds.place)
}

function chapterSynopsis(act: number, index: number, seeds: StorySeeds): string {
  const synopses = [
    `${seeds.protagonist}在${seeds.weather}夜第一次遇见${seeds.object}的异常，决定把它留下。`,
    `${seeds.companion}出现，带来一个无法拒绝的请求；${seeds.protagonist}第一次怀疑自己的记忆。`,
    `${seeds.protagonist}在${seeds.place}找到${seeds.elder}留下的旧痕，发现${seeds.power}有代价。`,
    `一次失败的尝试让${seeds.protagonist}失去一段重要的东西，门在身后关上。`,
    `${seeds.companion}说出部分真相；两人的信任第一次出现裂缝。`,
    `${seeds.protagonist}用${seeds.object}回到某个下午，看见一直不敢看的画面。`,
    `中点：真正要修的不是物件，而是${seeds.protagonist}与${seeds.elder}之间未说完的话。`,
    `代价逼近；${seeds.protagonist}必须在记住与放下之间做出选择。`,
    `最暗的一夜，${seeds.protagonist}发现${seeds.companion}也隐瞒了同一件事。`,
    `${seeds.protagonist}决定最后一次使用${seeds.object}，把机会留给别人。`,
    `${seeds.weather}里，所有线索收拢；一个温柔但不圆满的决定。`,
    `清晨，${seeds.protagonist}重新打开店门；新的${seeds.object}在门口等着。`
  ]
  return synopses[(act * 4 + index) % synopses.length]
}

export function localBlueprint(project: StudioProject, options: { imagesReady: boolean; textConfigured: boolean }): StudioBlueprint {
  const seeds = readSeeds(project.logline, project.title)
  const now = nowMs()
  const targetWords = project.brief.targetWords ?? (project.kind === 'short' ? 18_000 : 300_000)
  const targetSeconds = project.brief.targetSeconds ?? 96
  const chapterCount = project.kind === 'short' ? Math.max(12, Math.min(30, Math.round(targetWords / 2000))) : 36
  const shotCount = Math.max(6, Math.min(24, Math.round(targetSeconds / 8)))
  const characters = blueprintCharacters(project, seeds)
  const places = blueprintPlaces(project, seeds)
  const units =
    project.kind === 'drama'
      ? localShotPlan(seeds).slice(0, shotCount).map((shot, index) => ({
          index: index + 1,
          title: shot.title,
          summary: shot.action,
          seconds: shot.seconds,
          camera: shot.camera,
          shotSize: shot.shotSize,
          dialogue: shot.dialogue,
          speaker: shot.speaker
        }))
      : Array.from({ length: chapterCount }, (_, index) => ({
          index: index + 1,
          title: chapterTitle(index, seeds),
          summary: chapterSynopsis(Math.floor(index / 4), index, seeds),
          wordTarget: project.kind === 'short' ? Math.max(1200, Math.min(3000, Math.round(targetWords / chapterCount))) : 2600
        }))
  const estimate = localEstimate(project, options, shotCount, chapterCount)
  return {
    approved: false,
    source: 'local',
    storyCore: `${seeds.logline} 在这个设定里，${seeds.protagonist}真正要解决的，不是${seeds.object}本身，而是「${seeds.theme}」。`,
    emotion: project.brief.tone || '克制的悲伤，最后落到温柔',
    audience: project.brief.audience || (project.kind === 'drama' ? '喜欢都市奇幻短片的 18–35 岁观众' : '喜欢慢热人物故事的普通读者'),
    pitch:
      project.kind === 'drama'
        ? `一支 ${targetSeconds} 秒的${project.brief.genre}短片：${shotCount} 个镜头，从一件异常的${seeds.object}开始，最后把选择还给人物。`
        : `一部约 ${Math.round(targetWords / 1000)} 千字的${project.brief.genre}${project.kind === 'short' ? '中短篇' : '长篇'}：${chapterCount} 章，围绕「${seeds.theme}」缓慢收紧。`,
    structure:
      project.kind === 'drama'
        ? `三幕 · ${shotCount} 镜 / ${targetSeconds} 秒：捡到 / 使用 / 放手`
        : project.kind === 'short'
          ? `三幕 · ${chapterCount} 章 / 约 ${Math.round(targetWords / 1000)} 千字`
          : `三卷 · ${chapterCount} 章 / 计划约 ${Math.round(targetWords / 1000)} 千字`,
    styleBible: styleFor(project, seeds),
    characters,
    places,
    units,
    estimate,
    warnings: [
      ...(options.textConfigured ? [] : ['当前未连接可用的文本模型：蓝图与初稿由本地结构引擎生成，可随时用模型重写。']),
      ...(options.imagesReady ? [] : ['画面引擎未就绪：分镜图不会自动生成；可先导入参考图，或在设置 → 多媒体里连接 ComfyUI。'])
    ],
    createdAt: now
  }
}

function blueprintCharacters(project: StudioProject, seeds: StorySeeds): StudioCharacter[] {
  const roleLook = seeds.female
    ? `二十多岁，${seeds.role}，短发被${seeds.weather}打湿，手指有常年劳作的薄茧，穿深色围裙`
    : `二十多岁，${seeds.role}，旧外套袖口磨白，指节有细小伤口，眼神安静`
  return [
    {
      id: studioId('char'),
      name: seeds.protagonist,
      role: '主角',
      age: '二十多岁',
      look: roleLook,
      desire: `想弄清${seeds.object}为什么只在自己手里出现异常`,
      fear: '害怕自己正在忘记最重要的人',
      secret: `与${seeds.elder}的离开有关`,
      arc: '从想修好一切，到允许有些东西保持损坏',
      relationships: [{ target: seeds.companion, label: '每周来一次，像在确认什么' }, { target: seeds.elder, label: '未说完的告别' }],
      refAssetIds: [],
      firstChapterId: project.chapters[0]?.id
    },
    {
      id: studioId('char'),
      name: seeds.companion,
      role: '失忆者 / 引线',
      age: '二十岁上下',
      look: `总在${seeds.weather}里出现，衣服湿透却不在意，手里捧着与${seeds.object}有关的东西`,
      desire: `想找回一段不属于自己的记忆`,
      fear: '害怕真相证明自己才是那个被留下的人',
      secret: `他每周三来，并不是为了修${seeds.object}`,
      arc: '从索取答案，到把选择权交还',
      relationships: [{ target: seeds.protagonist, label: '尚未说破的信任' }],
      refAssetIds: []
    },
    {
      id: studioId('char'),
      name: seeds.elder,
      role: '记忆 / 规则',
      age: '已故',
      look: '只出现在倒流的天气里：旧毛衣、药箱、针线篮，轮廓始终有些模糊',
      desire: '把一门手艺与一句话留下',
      fear: '被忘记',
      secret: `第一次使用${seeds.object}的人其实是${seeds.elder}`,
      arc: '从缺席的声音，变成主角愿意带着走的重量',
      relationships: [{ target: seeds.protagonist, label: `教会${seeds.pronouns.them}${seeds.role}的手艺` }],
      refAssetIds: []
    }
  ]
}

function blueprintPlaces(project: StudioProject, seeds: StorySeeds): StudioPlace[] {
  return [
    {
      id: studioId('place'),
      name: `${seeds.place}的${seeds.object}铺`,
      description: `木门、暖黄灯、玻璃上永远擦不净的${seeds.weather}痕；柜台后有一张给客人坐的旧凳子`,
      refAssetIds: []
    },
    {
      id: studioId('place'),
      name: `${seeds.place}深处`,
      description: `雨棚下的窄巷，灯牌坏了一半；夜里能听见远处车站的报站声`,
      refAssetIds: []
    }
  ]
}

function localEstimate(project: StudioProject, options: { imagesReady: boolean; textConfigured: boolean }, shotCount: number, chapterCount: number): StudioEstimate {
  if (project.kind === 'drama') {
    const lines = [
      { label: `文字与分镜（${shotCount} 镜）`, costMin: options.textConfigured ? 0.2 : 0, costMax: options.textConfigured ? 0.8 : 0, note: options.textConfigured ? '按当前模型参考价估算' : '本机生成，不调用模型' },
      { label: `分镜画面（${shotCount} 镜 × 2 候选）`, costMin: options.imagesReady ? 0 : null, costMax: options.imagesReady ? 0 : null, note: options.imagesReady ? '本机生成，不额外收费' : '还没有配置画面引擎，费用未知' },
      { label: `${shotCount} 段配音`, costMin: 0, costMax: 0, note: 'Windows 系统声线，本机生成' },
      { label: '配乐与音效', costMin: 0, costMax: 0, note: '本地器乐草稿' },
      { label: '在本机合成', costMin: 0, costMax: 0, note: '不额外收费' }
    ]
    return {
      minutesMin: project.brief.form === '速成草稿' ? 10 : 30,
      minutesMax: project.brief.form === '速成草稿' ? 18 : 60,
      costMin: options.imagesReady ? 0 : null,
      costMax: options.textConfigured ? 1 : 0,
      currency: 'CNY',
      lines,
      basis: options.textConfigured ? 'mixed' : 'local',
      note: '费用区间为起草时预估；实际账单以模型服务商为准，未知单价绝不伪造。'
    }
  }
  const lines = [
    { label: `蓝图与章纲（${chapterCount} 章）`, costMin: options.textConfigured ? 0.1 : 0, costMax: options.textConfigured ? 0.5 : 0, note: options.textConfigured ? '按当前模型参考价估算' : '本机生成，不调用模型' },
    { label: `章节初稿（按需逐章生成）`, costMin: null, costMax: null, note: '生成时按实际 token 与模型单价记录' },
    { label: '配图（可选）', costMin: options.imagesReady ? 0 : null, costMax: options.imagesReady ? 0 : null, note: options.imagesReady ? '本机生成' : '还没有配置画面引擎' },
    { label: '导出', costMin: 0, costMax: 0, note: '本机完成' }
  ]
  return {
    minutesMin: project.kind === 'short' ? 30 : 60,
    minutesMax: project.kind === 'short' ? 90 : 180,
    costMin: options.textConfigured ? 0.1 : 0,
    costMax: null,
    currency: 'CNY',
    lines,
    basis: options.textConfigured ? 'mixed' : 'local',
    note: '文本费用按章节生成时记录；没有可靠单价时显示未知。'
  }
}

export function applyBlueprintToProject(project: StudioProject, blueprint: StudioBlueprint): StudioProject {
  const seeds = readSeeds(project.logline, project.title)
  project.title = project.title === '未命名作品' ? seeds.title : project.title
  project.blueprint = blueprint
  project.styleBible = blueprint.styleBible
  project.characters = blueprint.characters.map((character) => ({ ...character }))
  project.places = blueprint.places.map((place) => ({ ...place }))
  project.facts = []
  for (const character of project.characters) {
    if (character.desire) {
      project.facts.push({
        id: studioId('fact'),
        subject: character.name,
        predicate: '想要',
        object: character.desire,
        confidence: 0.8,
        source: 'local',
        createdAt: nowMs()
      })
    }
    for (const relationship of character.relationships) {
      project.facts.push({
        id: studioId('fact'),
        subject: character.name,
        predicate: `与${relationship.target}的关系`,
        object: relationship.label,
        confidence: 0.75,
        source: 'local',
        createdAt: nowMs()
      })
    }
  }
  project.facts.push({
    id: studioId('fact'),
    subject: seeds.object,
    predicate: '规则',
    object: `${seeds.power}，但每次使用都会失去一段记忆`,
    confidence: 0.9,
    source: 'local',
    createdAt: nowMs()
  })
  project.runtime.textModelNote = blueprint.source === 'model' ? blueprint.model : '本地结构稿'
  const now = nowMs()
  project.stages.blueprint = { status: blueprint.approved ? 'done' : 'review', updatedAt: now, message: blueprint.approved ? '蓝图已批准' : '等待你审阅蓝图' }
  project.stages.outline = { status: 'ready', updatedAt: now, message: '可以生成大纲' }
  project.stage = 'outline'
  if (blueprint.approved) {
    if (project.kind === 'drama') {
      applyDramaOutline(project, blueprint)
    } else {
      applyNovelOutline(project, blueprint)
    }
  }
  project.updatedAt = now
  return project
}

export function applyNovelOutline(project: StudioProject, blueprint: StudioBlueprint): void {
  const seeds = readSeeds(project.logline, project.title)
  const volumeCount = project.kind === 'novel' ? 3 : 1
  const perVolume = Math.ceil(blueprint.units.length / volumeCount)
  const newVolumes: typeof project.volumes = []
  const newChapters: StudioChapter[] = []
  blueprint.units.forEach((unit, index) => {
    const volumeIndex = Math.floor(index / perVolume)
    if (!newVolumes[volumeIndex]) {
      newVolumes[volumeIndex] = {
        id: studioId('vol'),
        number: volumeIndex + 1,
        title: `第${['一', '二', '三', '四'][volumeIndex] ?? volumeIndex + 1}卷 · ${VOLUME_TITLES[volumeIndex % VOLUME_TITLES.length]}`,
        summary: volumeIndex === 0 ? '异常出现，人物进入故事' : volumeIndex === 1 ? '代价显形，关系翻转' : '选择与余韵',
        chapterIds: []
      }
    }
    const chapter: StudioChapter = {
      id: studioId('ch'),
      volumeId: newVolumes[volumeIndex].id,
      number: index + 1,
      title: unit.title,
      synopsis: unit.summary,
      beats: [unit.summary, `情绪：${index % 4 === 3 ? '收束' : index % 3 === 0 ? '试探' : '推进'}`],
      content: '',
      wordTarget: unit.wordTarget ?? 2500,
      status: 'ready',
      revision: 1,
      candidates: [],
      versions: [],
        illustrations: [],
      locked: false,
      updatedAt: nowMs()
    }
    newVolumes[volumeIndex].chapterIds.push(chapter.id)
    newChapters.push(chapter)
  })
  project.volumes = newVolumes.filter(Boolean)
  project.chapters = newChapters
  project.episodes = []
  project.scenes = []
  project.shots = []
  project.timeline = emptyTimeline(project.brief.aspect)
  if (newChapters[0]) {
    for (const fact of project.facts) {
      if (!fact.chapterId && fact.subject !== seeds.object) fact.chapterId = newChapters[0].id
    }
  }
}

export function applyDramaOutline(project: StudioProject, blueprint: StudioBlueprint): void {
  const seeds = readSeeds(project.logline, project.title)
  const episode: StudioEpisode = {
    id: studioId('ep'),
    number: 1,
    title: project.title,
    synopsis: blueprint.pitch,
    sceneIds: [],
    durationSec: blueprint.units.reduce((sum, unit) => sum + (unit.seconds ?? 8), 0),
    updatedAt: nowMs()
  }
  const sceneTitles = ['捡到', '使用', '放手']
  const scenes: StudioScene[] = sceneTitles.map((title, index) => ({
    id: studioId('scene'),
    episodeId: episode.id,
    number: index + 1,
    title,
    synopsis: index === 0 ? `异常第一次出现，${seeds.protagonist}决定留下${seeds.object}。` : index === 1 ? `规则被使用，代价开始显形。` : `最后一次选择，把${seeds.object}交还。`,
    location: index === 1 ? `${seeds.place}深处` : `${seeds.place}的${seeds.object}铺`,
    timeOfDay: index === 2 ? '清晨' : '夜',
    characters: [seeds.protagonist, ...(index === 1 ? [seeds.companion] : []), ...(index === 2 ? [seeds.elder] : [])],
    beat: index === 0 ? 'Setup' : index === 1 ? 'Confrontation' : 'Resolution',
    updatedAt: nowMs()
  }))
  episode.sceneIds = scenes.map((scene) => scene.id)
  const shotPlans = localShotPlan(seeds)
  const shots: StudioShot[] = blueprint.units.map((unit, index) => {
    const sceneIndex = Math.min(2, Math.floor(index / Math.max(1, Math.ceil(blueprint.units.length / 3))))
    const plan = shotPlans[index % shotPlans.length]
    const scene = scenes[sceneIndex]
    const speaker = unit.speaker ?? plan.speaker
    const character = project.characters.find((item) => item.name === speaker)
    return {
      id: studioId('shot'),
      sceneId: scene.id,
      number: index + 1,
      title: unit.title,
      action: unit.summary,
      camera: unit.camera ?? plan.camera,
      shotSize: unit.shotSize ?? plan.shotSize,
      durationSec: unit.seconds ?? 8,
      dialogue: unit.dialogue ?? plan.dialogue,
      speaker,
      voiceId: character?.voiceId ?? '',
      prompt: imagePromptFor(unit, index, seeds, blueprint.styleBible),
      negative: blueprint.styleBible.negative.join('，'),
      referenceCharacterIds: [character?.id].filter((id): id is string => Boolean(id)),
      referencePlaceIds: [project.places[index === 1 ? 1 : 0]?.id].filter((id): id is string => Boolean(id)),
      referencePropIds: [],
      imageAssetId: null,
      videoAssetId: null,
      voiceAssetId: null,
      imageCandidates: [],
      videoCandidates: [],
      continuity: index === 0 ? '开场；雨向从左后方来' : `承接第 ${index} 镜尾帧，${seeds.weather}向与服装保持一致`,
      lockedReference: false,
      status: 'ready',
      updatedAt: nowMs()
    }
  })
  project.episodes = [episode]
  project.scenes = scenes
  project.shots = shots
  project.chapters = []
  project.volumes = []
  project.timeline = emptyTimeline(project.brief.aspect)
  for (const fact of project.facts) {
    if (!fact.sceneId) fact.sceneId = scenes[0].id
  }
  project.stage = 'storyboard'
}

function imagePromptFor(unit: StudioBlueprintUnit, index: number, seeds: StorySeeds, style: StudioStyleBible): string {
  return [
    `电影剧照，${style.look}`,
    `${unit.shotSize ?? '中景'}，${unit.camera ?? '缓慢推近'}`,
    `画面：${unit.summary}`,
    `人物：${seeds.protagonist}（${seeds.role}，${seeds.female ? '女性' : '男性'}，二十多岁），${seeds.companion}（失忆的年轻人）`,
    `场景：${seeds.place}，${seeds.weather}夜，暖色灯、潮湿反光`,
    `道具：${seeds.object}，一道极细的红线`,
    `第 ${index + 1} 镜，16:9，统一角色与光线，无字幕无文字`
  ].join('；')
}

interface ShotPlan {
  title: string
  action: string
  camera: string
  shotSize: string
  seconds: number
  dialogue: string
  speaker: string
}

function localShotPlan(seeds: StorySeeds): ShotPlan[] {
  const p = seeds.protagonist
  const c = seeds.companion
  const e = seeds.elder
  return [
    { title: `${seeds.weather}夜捡到${seeds.object}`, action: `${p}收起最后一把${seeds.object}时，发现它正反着撑开，水珠沿着伞骨往上流。`, camera: '固定全景，雨丝斜切画面', shotSize: '全景', seconds: 8, dialogue: '', speaker: '' },
    { title: '伞骨倒转', action: `${p}用指腹碰了碰${seeds.object}，时间像退后了一步；墙上的钟往回走了一格。`, camera: '特写，手部与物件', shotSize: '特写', seconds: 8, dialogue: '', speaker: '' },
    { title: '少年出现', action: `${c}站在门外，浑身湿透，手里捧着另一件与${seeds.object}有关的东西。`, camera: '中景，门框构图，缓慢推近', shotSize: '中景', seconds: 8, dialogue: '还能修好吗？', speaker: c },
    { title: '第一次修理', action: `${p}把${seeds.object}拆开，零件在灯下泛出旧伤一样的光。`, camera: '近景，俯拍工作台', shotSize: '近景', seconds: 8, dialogue: '你每周都来，是为了它，还是为了别的？', speaker: p },
    { title: '红线', action: `${seeds.object}的内侧有一道极细的红线，像谁用针尖划过的一条河。`, camera: '微距特写，红线入画', shotSize: '特写', seconds: 8, dialogue: '', speaker: '' },
    { title: `${e}的声音`, action: `水盆里浮起一圈金光；${p}听见${e}在很远的地方说了一句话。`, camera: '中景，蒸汽与光', shotSize: '中景', seconds: 8, dialogue: '修不好也没关系。', speaker: e },
    { title: '倒流的雨', action: `门外雨丝忽然向上飞；${p}看见七年前的自己站在同一条街上。`, camera: '中景推近，雨向反转', shotSize: '中景', seconds: 8, dialogue: '这把伞，能把时间倒着走。', speaker: p },
    { title: `每周三的秘密`, action: `${c}承认自己不是来修${seeds.object}的，而是在等一个人回来。`, camera: '双人近景，侧光', shotSize: '近景', seconds: 8, dialogue: '你认识她，对吗？', speaker: c },
    { title: '记忆变暗', action: `${p}发现自己记不起${e}的声音，只剩一句模糊的尾音。`, camera: '特写，眼神失焦', shotSize: '特写', seconds: 8, dialogue: '我好像，正在忘记她。', speaker: p },
    { title: '时间退回一步', action: `${p}最后一次合上${seeds.object}；雨停了一瞬，整条街安静得能听见心跳。`, camera: '全景，雨停的静止', shotSize: '全景', seconds: 8, dialogue: '', speaker: '' },
    { title: '放手', action: `${p}把修好的${seeds.object}交给${c}，没有问他会去哪里。`, camera: '中景，隔着柜台', shotSize: '中景', seconds: 8, dialogue: '这次，别再弄丢了。', speaker: p },
    { title: `${seeds.weather}停之后`, action: `清晨，${p}重新打开店门；门口放着一把没有署名的${seeds.object}。`, camera: '全景，门外的光慢慢进来', shotSize: '全景', seconds: 8, dialogue: '', speaker: '' }
  ]
}

const WEATHER_BEATS = ['雨是从傍晚开始下的。', '风先到，雨在后面跟了很久。', '雪落在屋檐上，没有声音。', '夜很深，街上的灯只剩两盏。'] as const
const OBJECT_BEATS = [
  '{object}被放在柜台最里面，像一件不愿被认领的失物。',
  '{object}的边角有一道旧裂痕，摸上去像结了痂。',
  '{object}上沾着水，水痕却朝反方向爬。',
  '{object}内侧藏着一道细线，颜色像被时间磨淡的血。'
] as const
const MEMORY_LINES = [
  '{elder}以前说过，修东西和留人一样，都不能太用力。',
  '那年也是这样的{weather}，{elder}把{hisher}从水里捞上来，什么都没问。',
  '记忆里有一把小凳子，永远放在柜台旁边；{elder}坐过，后来空了很久。',
  '有些声音不是听见的，是在某个安静的瞬间突然想起来的。'
] as const
const TURN_LINES = [
  '钟表在墙上往回走了一格。',
  '门外有人经过，脚步停在门口，又慢慢离开。',
  '水盆里浮起一圈金光，又很快散开。',
  '她低头时，看见自己的影子比灯更早一步转向。'
] as const
const HOOK_LINES = [
  '她没有追出去。只是把门开得更大了一些，让{fweather}进来。',
  '那天夜里，她第一次没有把{object}收进柜子。',
  '第二天，门口多了一把与记忆中一模一样的{object}。',
  '她知道，有些东西一旦被修好，就再也回不到原来的样子。'
] as const

function fill(template: string, seeds: StorySeeds, extra: Record<string, string> = {}): string {
  return template
    .replace(/\{object\}/g, seeds.object)
    .replace(/\{weather\}/g, seeds.weather)
    .replace(/\{fweather\}/g, `${seeds.weather}声`)
    .replace(/\{place\}/g, seeds.place)
    .replace(/\{elder\}/g, seeds.elder)
    .replace(/\{hisher\}/g, seeds.pronouns.them)
    .replace(/\{name\}/g, seeds.protagonist)
    .replace(/\{companion\}/g, seeds.companion)
    .replace(/\{(\w+)\}/g, (_, key: string) => extra[key] ?? '')
}

export function localChapterDraft(project: StudioProject, chapter: StudioChapter, instruction?: string): string {
  const seeds = readSeeds(project.logline, project.title)
  const seed = hash(`${project.id}:${chapter.id}:${chapter.content.length}`)
  const target = Math.min(chapter.wordTarget || 1600, 1600)
  const p = seeds.protagonist
  const c = seeds.companion
  const e = seeds.elder
  const paragraphs: string[] = []
  const opening = pick(WEATHER_BEATS, seed)
  paragraphs.push(
    fill(`${opening}${p}把最后一把{object}挂在门后，听见有人敲门。${pick(OBJECT_BEATS, seed, 1)}`, seeds)
  )
  paragraphs.push(
    fill(
      `门外站着${c}，浑身湿透，手里捧着一样与{object}有关的东西。${seeds.female ? '他' : '她'}没有打伞，像是专门来淋这场{weather}的。“还能修好吗？”${seeds.female ? '他' : '她'}问，声音很轻，像怕惊动什么。`,
      seeds
    )
  )
  paragraphs.push(
    fill(
      `${p}没有立刻回答。${seeds.pronouns.they}认得这样东西——它身上的每一道划痕都在提醒一件旧事。${pick(MEMORY_LINES, seed, 2)}`,
      seeds
    )
  )
  paragraphs.push(
    fill(
      `“你怎么知道我能修？”${p}问。${c}看着${seeds.pronouns.them}的手，说：“因为很多人说，你修东西的时候，像在等一个人回来。”`,
      seeds
    )
  )
  paragraphs.push(
    fill(
      `${p}把{object}放到工作台上，拧开灯。灯亮的一瞬，${pick(TURN_LINES, seed, 3)}${seeds.pronouns.they}停了一下，还是伸手把{object}拆开。零件在灯下排出细细的影子，像一条没有走完的路。`,
      seeds
    )
  )
  paragraphs.push(
    fill(
      `${pick(OBJECT_BEATS, seed, 4)} ${pick(MEMORY_LINES, seed, 5)}${seeds.pronouns.they}想起${e}常说的一句话：东西坏了可以补，人的话如果当时没说，就会一直空在那里。`,
      seeds
    )
  )
  paragraphs.push(
    fill(
      `修到一半，${c}忽然说，自己每周三都来，不是因为{weather}最大，而是因为那一天${p}会在店里。${p}的手停在半空，听见自己的心跳比雨更近。`,
      seeds
    )
  )
  paragraphs.push(
    fill(
      `“你认识${e}吗？”${p}问。${c}沉默了很久，才说：“我不记得了。但每次走到这条街，我都会想起一把{object}。”`,
      seeds
    )
  )
  // 依据章纲补齐中段，让每一章都有自己的事实推进，而不是同一段模板换名字。
  const synopsis = chapter.synopsis.replace(/[。；]$/, '')
  paragraphs.push(
    fill(
      `这一夜真正发生的事，是${synopsis}。${p}把它记在一张旧纸上，写完又折起来，放进柜台最下面的抽屉。那里已经有六张同样的纸。`,
      seeds
    )
  )
  if (chapter.beats[0]) {
    paragraphs.push(
      fill(
        `${chapter.beats[0]}。${p}忽然明白，${seeds.object}不是要带${seeds.pronouns.them}回到过去，而是在问${seeds.pronouns.them}：如果重来一次，你还会做同样的选择吗？`,
        seeds
      )
    )
  }
  while (countWords(paragraphs.join('')) < target * 0.82) {
    paragraphs.push(
      fill(
        `${pick(MEMORY_LINES, seed, paragraphs.length)} ${p}没有停下手里的活。灯下的影子被拉得很长，像另一个人一直站在旁边，替${seeds.pronouns.them}把没说完的话听完。`,
        seeds
      )
    )
    if (paragraphs.length > 18) break
  }
  const closing = instruction && /克制|收|淡/.test(instruction)
    ? `{name}最终只说了两个字：“修吧。”门外，{fweather}还在。`
    : pick(HOOK_LINES, seed, 7)
  paragraphs.push(fill(closing, seeds))
  return paragraphs.join('\n\n')
}

export function localRewrite(text: string, instruction: string): string {
  let next = text.trim()
  if (!next) return next
  const calm = /克制|收一点|少一点|冷静|留白|轻一点|温柔/.test(instruction)
  const tense = /紧张|悬疑|加快|节奏|压迫|危险/.test(instruction)
  const shorten = /缩短|精简|删减|更短/.test(instruction)
  const expand = /扩写|细一点|更多细节|加长/.test(instruction)
  if (calm) {
    next = next
      .replace(/突然|忽然|猛地|狠狠地|疯狂地|无比|极其|非常/g, '')
      .replace(/！/g, '。')
      .replace(/(大声|高声)(说|喊)/g, '低声$2')
      .replace(/哭了/g, '眼眶红了')
  }
  if (tense) {
    next = next
      .replace(/([^。！？\n]{18})，/g, '$1。')
      .replace(/她/g, '她')
    const paragraphs = next.split(/\n{2,}/)
    if (paragraphs.length > 1) {
      paragraphs.splice(1, 0, '灯忽然暗了一瞬。\n\n没有人说话。雨声贴得更近了。')
      next = paragraphs.join('\n\n')
    }
  }
  if (shorten) {
    const paragraphs = next.split(/\n{2,}/)
    const keep = Math.max(2, Math.round(paragraphs.length * 0.68))
    next = paragraphs.slice(0, keep).join('\n\n')
  }
  if (expand) {
    const paragraphs = next.split(/\n{2,}/)
    const insertAt = Math.min(1, paragraphs.length)
    paragraphs.splice(insertAt, 0, '门缝里先挤进来一股湿冷的气味，旧木头、雨水和一点铁锈。灯罩上积着薄灰，光落下来时，像隔了一层很薄的雾。')
    next = paragraphs.join('\n\n')
  }
  if (next === text.trim()) {
    next = `${next}\n\n${instruction.includes('雨') ? '雨声在门外停了一瞬，又继续落下。' : '这句话说完，屋里安静了很久。'}`
  }
  return next.trim()
}

export const DEMO_DRAMA_SHOTS = [
  { title: '雨夜捡伞', action: '林晚收起最后一把伞时，发现它正反着撑开，水珠沿着伞骨往上流。', camera: '固定全景，雨丝斜切画面', shotSize: '全景', seconds: 8, dialogue: '', speaker: '', continuity: '开场；雨向从左后方来' },
  { title: '伞骨倒转', action: '她的指腹碰了碰伞面，墙上的钟往回走了一格。', camera: '特写，手部与物件', shotSize: '特写', seconds: 8, dialogue: '', speaker: '', continuity: '承接 01；雨向不变' },
  { title: '少年出现', action: '门外站着一个浑身湿透的少年，手里捧着另一把黑伞，伞骨锈得像一段旧伤。', camera: '中景，门框构图，缓慢推近', shotSize: '中景', seconds: 8, dialogue: '还能修好吗？', speaker: '少年', continuity: '承接 02；门框位置一致' },
  { title: '第一次修伞', action: '林晚把黑伞拆开，零件在灯下泛出旧伤一样的光。', camera: '近景，俯拍工作台', shotSize: '近景', seconds: 7, dialogue: '你每周三都来，是为了它，还是为了别的？', speaker: '林晚', continuity: '承接 03；工作台位置一致' },
  { title: '红线', action: '伞面内侧有一道极细的红线，像谁用针尖划过的一条河。', camera: '微距特写，红线入画', shotSize: '特写', seconds: 8, dialogue: '', speaker: '', continuity: '承接 04；红色成为视觉线索' },
  { title: '外婆的声音', action: '水盆里浮起一圈金光，林晚听见外婆在很远的地方说话。', camera: '中景，蒸汽与光', shotSize: '中景', seconds: 8, dialogue: '修不好也没关系。', speaker: '外婆', continuity: '承接 05；光线变暖' },
  { title: '雨中的纸鹤', action: '门外雨丝忽然向上飞，林晚看见七年前的自己站在同一条街上。', camera: '中景推近，雨向反转', shotSize: '中景', seconds: 9, dialogue: '这把伞，能把时间倒着走。', speaker: '林晚', continuity: '承接 06 尾帧；雨向反转是本片核心' },
  { title: '每周三的秘密', action: '少年承认自己不是来修伞的，而是在等一个人回来。', camera: '双人近景，侧光', shotSize: '近景', seconds: 8, dialogue: '你认识她，对吗？', speaker: '少年', continuity: '承接 07；两人距离缩短' },
  { title: '记忆变暗', action: '林晚发现自己记不起外婆的声音，只剩一句模糊的尾音。', camera: '特写，眼神失焦', shotSize: '特写', seconds: 7, dialogue: '我好像，正在忘记她。', speaker: '林晚', continuity: '承接 08；妆发不变' },
  { title: '时间退回一步', action: '林晚最后一次合上黑伞。雨停了一瞬，整条街安静得能听见心跳。', camera: '全景，雨停的静止', shotSize: '全景', seconds: 9, dialogue: '', speaker: '', continuity: '承接 09；雨停，地面仍湿' },
  { title: '放手', action: '她把修好的伞交给少年，没有问他会去哪里。', camera: '中景，隔着柜台', shotSize: '中景', seconds: 8, dialogue: '这次，别再弄丢了。', speaker: '林晚', continuity: '承接 10；伞骨已修复' },
  { title: '雨停之后', action: '清晨，林晚重新打开店门。门口放着一把没有署名的纸伞，伞面画着一只纸鹤。', camera: '全景，门外的光慢慢进来', shotSize: '全景', seconds: 8, dialogue: '', speaker: '', continuity: '收束；纸鹤与 07 呼应' }
] as const

export function createDemoDramaBlueprint(project: StudioProject, imagesReady: boolean): StudioBlueprint {
  const seeds = readSeeds(project.logline, project.title)
  const blueprint = localBlueprint(project, { imagesReady, textConfigured: false })
  blueprint.source = 'import'
  blueprint.storyCore = '一个修伞的女孩，在雨夜捡到一把能让时间倒流的伞。她每修好一把伞，就会失去一段记忆。'
  blueprint.emotion = '克制的悲伤 → 温柔的释然'
  blueprint.audience = '喜欢都市奇幻短片的 18–35 岁观众'
  blueprint.pitch = '一支 96 秒的都市奇幻短片：12 个镜头，从一把倒着走的伞开始，最后把选择还给人物。'
  blueprint.structure = '三幕 · 12 镜 / 96 秒：捡伞 / 修伞 / 放手'
  blueprint.warnings = imagesReady ? [] : ['画面引擎未就绪：已内置样例分镜图，可先完整体验；要生成新画面请连接 ComfyUI。']
  blueprint.characters = [
    {
      id: studioId('char'),
      name: '林晚',
      role: '主角 · 修伞匠',
      age: '26 岁',
      look: '短发，深色围裙，手上有常年修伞留下的薄茧；雨夜里穿一件旧呢外套',
      voiceId: '',
      desire: '想把外婆留下的伞铺继续开下去',
      fear: '害怕遗忘外婆的声音',
      secret: '她也曾用过那把伞，只是不记得了',
      arc: '从拒绝遗忘，到允许记忆以另一种方式留下',
      relationships: [{ target: '少年', label: '每周三来修同一把伞' }, { target: '外婆', label: '修伞的传承' }],
      refAssetIds: [],
      firstChapterId: project.chapters[0]?.id
    },
    {
      id: studioId('char'),
      name: '少年',
      role: '失忆者 · 引线',
      age: '约 20 岁',
      look: '瘦，黑发被雨打湿，穿一件不合季节的薄外套；手里总捧着一把黑伞',
      voiceId: '',
      desire: '想找回一段不属于自己的记忆',
      fear: '害怕真相证明自己才是被留下的人',
      secret: '每周三来，并不是为了修伞',
      arc: '从索取答案，到把选择权交还',
      relationships: [{ target: '外婆', label: '每周三的约定' }, { target: '林晚', label: '尚未说破的信任' }],
      refAssetIds: []
    },
    {
      id: studioId('char'),
      name: '外婆',
      role: '记忆 · 规则',
      age: '已故六年',
      look: '旧毛衣、药箱、针线篮；只存在于倒流的雨里，轮廓始终有些模糊',
      voiceId: '',
      desire: '把修伞的手艺与一句话留下',
      fear: '被忘记',
      secret: '第一次使用伞的人其实是她',
      arc: '从缺席的声音，变成林晚愿意带着走的重量',
      relationships: [{ target: '林晚', label: '把她从水里捞上来' }],
      refAssetIds: []
    }
  ]
  blueprint.places = [
    { id: studioId('place'), name: '老街伞铺', description: '木门、暖黄灯，玻璃上永远擦不净的雨痕；柜台后有一张给客人坐的旧凳子', refAssetIds: [] },
    { id: studioId('place'), name: '老街深处', description: '雨棚下的窄巷，灯牌坏了一半；夜里能听见远处车站的报站声', refAssetIds: [] }
  ]
  blueprint.units = DEMO_DRAMA_SHOTS.map((shot, index) => ({
    index: index + 1,
    title: shot.title,
    summary: shot.action,
    seconds: shot.seconds,
    camera: shot.camera,
    shotSize: shot.shotSize,
    dialogue: shot.dialogue,
    speaker: shot.speaker
  }))
  blueprint.estimate = {
    minutesMin: 11,
    minutesMax: 16,
    costMin: 6,
    costMax: 10,
    currency: 'CNY',
    lines: [
      { label: '文字与分镜', costMin: 0.4, costMax: 0.8, note: '按模型用量估算，实际以账单为准' },
      { label: '画面 12 镜', costMin: 3, costMax: 5, note: '样例画面已内置；重新生成在本机进行' },
      { label: '配音 8 段', costMin: 0.5, costMax: 1, note: '系统声线本机生成' },
      { label: '配乐 1 首', costMin: 1, costMax: 2, note: '本地器乐草稿免费' },
      { label: '在本机合成', costMin: 0, costMax: 0, note: '不额外收费' }
    ],
    basis: 'mixed',
    note: '确认蓝图后才开始收费；超出预算会再向你确认。'
  }
  blueprint.styleBible = {
    look: '低饱和的雨夜质感，老街暖色灯与潮湿反光，轻微胶片颗粒；角色脸部保持克制，不炫技',
    palette: ['#c8ae7d', '#7fa292', '#c2795f', '#101820'],
    camera: '固定镜头与缓慢推近为主，关键处一次手持跟随；不频繁切镜',
    sound: '雨声先行，钢琴只在高点出现；伞骨与心跳是两件重要的声音',
    negative: ['六根手指', '雨向不一致', '现代高楼', '文字水印', '过度锐化'],
    updatedAt: nowMs()
  }
  blueprint.createdAt = nowMs()
  return blueprint
}

export function demoChapterProse(_project: StudioProject, chapterNumber: number): string {
  const fragments = [
    '雨是从傍晚开始下的。她把最后一把伞挂在门后，听见有人敲门。\n\n门外站着一个浑身湿透的少年，手里捧着一把反向撑开的黑伞。伞骨是铁的，锈得像一段旧伤。\n\n他抬起头，眼睛里有一种熟悉的、刚刚熄灭的光。\n\n她认得那把伞。七年前，外婆就是用这把伞，把她从水里捞上来的。可外婆已经死了六年。\n\n“修得好吗？”少年问。声音很轻，像怕惊动雨。\n\n她把伞撑开。伞面上有一道极细的红线，像谁用针尖划过的河。\n\n少年说，他每周三都来，是因为那天雨最大。\n\n她没问他为什么知道外婆的事。她只是把伞骨一根一根拆下来，放进温水里。\n\n水面上浮起一圈金色的光。时间在伞下退后了一步。\n\n她听见外婆在很远的地方说：别怕，修不好也没关系。',
    '第二天雨没停。少年又来了，站在门外，不进来。\n\n她把昨天拆下的伞骨排在柜台上，像排一副没有说明的旧棋。少年轻声说，他记得这把伞，却不记得在哪里见过她。\n\n“那你还来？”\n\n“因为走到这里，我会想起一句话。”\n\n“什么话？”\n\n他想了很久，最后只摇头。她看见他手背上有一道细小的疤，位置和自己小时候摔伤的一模一样。\n\n她低下头，把一根锈得最厉害的铁骨换掉。铁屑落在水里，散开，又慢慢聚拢。\n\n门外有卖糖炒栗子的推车经过，铃声响了两下。少年回头看，雨顺着他的下颌落下来，像一条很短的线。\n\n她没有再问。只是把修好的那一节伞骨举到灯下，确认它能开合。\n\n合上的声音很轻。像某个人在很远的地方，替她把一句话说完。',
    '外婆的旧工具箱放在柜台最下面，木盖已经变形。她很少打开。\n\n少年走后，她把箱子拖出来，找到一把断掉的竹尺。尺子背面用铅笔写着一行小字：修不好也没关系，记得回来吃饭。\n\n她坐在那张给客人准备的旧凳子上，忽然觉得店里太空。雨声从门缝里钻进来，把灯光切成一条一条。\n\n她想起外婆最后一次修伞，也是这样的天气。外婆说，伞和人一样，坏掉的地方如果一直是同一处，就说明它一直在替主人挡同一种东西。\n\n那天晚上，她第一次把黑伞留在工作台上，没有收进柜子。\n\n半夜她醒来，听见店里有轻轻的转动声。\n\n伞骨自己开合了一次。\n\n她推开门，工作台上没有伞，只有一张被水泡皱的旧照片。照片里是外婆年轻时站在店门口，旁边站着一个她从未见过的小男孩。\n\n男孩手里，也捧着一把黑伞。',
    '少年再来时，她没有问他照片的事。\n\n她只是把照片放在柜台上，推到他面前。少年看了很久，手指停在照片边缘，没有碰。\n\n“你每周三来，是因为那天雨最大。”她说，“还是因为那天她会开门？”\n\n少年的喉结动了一下。他说，他不记得外婆，但记得一张旧桌子，桌上有一盆温水。\n\n她想起那张桌子已经换过三次。\n\n“可能在另一个时间。”她说。\n\n少年笑了一下，那笑容不像一个二十岁的人。他说：“那就修吧。修好之后，也许我就能记起来。”\n\n她低头拆伞，没有再看他。窗外雨声忽然变大，像有人在很远的地方推开了一扇门。',
    '伞修好的那天，雨没有停。\n\n她把伞打开，红线在灯下发亮。少年伸手，却没有接。他说：“你留着吧。”\n\n“为什么？”\n\n“因为我想不起来的人，可能不是她。”\n\n她看着他，忽然明白他从一开始就知道些什么。只是那些事像水下的石头，碰到脚之前，谁也说不清形状。\n\n她把伞合上，放回柜台。\n\n少年走到门口，又回头：“下周还下雨。”\n\n“嗯。”\n\n“我还能来吗？”\n\n她本来想说，伞已经修好了。可她说出口的是：“周三。”\n\n门关上之后，店里安静得只剩水声。她低头，看见工作台抽屉缝里露出一角旧纸。\n\n那张纸上，有外婆的字：\n\n如果有一天有人来修一把黑伞，让他等。',
    '她开始记日记。\n\n每天只写一行：今天记得外婆的声音；今天记得少年的疤；今天记得黑伞的第七根骨。\n\n写完就放进抽屉。抽屉越来越满，记忆却越来越轻。\n\n有一次她抬头，看见镜子里的人比昨天老了一点。她想起外婆说过，时间不是从钟上走的，是从人身上走的。\n\n晚上，她试着打开那把黑伞。雨没有出现，店里却下起了很小的水。\n\n水落到旧照片上，照片里的小男孩慢慢长高，长成她认识的样子。\n\n她伸手去碰，水停了。\n\n少年站在门口，没有打伞。',
    '第七个周三，少年没有来。\n\n她把伞铺的灯开得比平时早。雨一直下，门口的水洼里映着招牌，字被风吹得歪了一下。\n\n天黑之前，她收到一只没有署名的纸盒。里面是把修好的黑伞，伞骨上多了一道新的红绳。\n\n盒子底下压着一张纸：\n\n她把你从水里捞上来那天，也捡到了我。\n\n她坐了很久。窗外的雨声一阵一阵，像有人从很远的地方走来，又在门口停住。\n\n最后她把伞挂在门后，和外婆留下的那把放在一起。\n\n两把伞都修好了。\n\n她没有哭。只是把店门开得更大了一些，让雨进来。'
  ]
  return fragments[(chapterNumber - 1) % fragments.length]
}
