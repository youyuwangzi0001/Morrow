import type { StudioKind } from '../../shared/studio'

export type CreativePromptTask =
  | 'blueprint'
  | 'outline'
  | 'chapter'
  | 'rewrite'
  | 'screenplay'
  | 'dialogue'
  | 'storyboard'
  | 'image'
  | 'video'
  | 'voice'
  | 'music'
  | 'review'
  | 'adaptation'
  | 'comic'
  | 'assistant'

export interface CreativePromptModule {
  id: string
  title: string
  category: 'story' | 'character' | 'world' | 'prose' | 'screen' | 'visual' | 'audio' | 'review'
  tasks: CreativePromptTask[]
  kinds: StudioKind[]
  tags: string[]
  triggers: string[]
  priority: number
  prompt: string
}

export interface PromptSelectInput {
  kind: StudioKind
  task: CreativePromptTask
  query?: string
  limit?: number
}

export interface SelectedPromptModule extends CreativePromptModule {
  score: number
}

const ALL_KINDS: StudioKind[] = ['short', 'novel', 'drama']

export const CREATIVE_PROMPT_MODULES: CreativePromptModule[] = [
  {
    id: 'story-core',
    title: '故事核：欲望 × 阻力 × 代价',
    category: 'story',
    tasks: ['blueprint', 'outline', 'chapter', 'adaptation', 'assistant'],
    kinds: ALL_KINDS,
    tags: ['故事核', '一句话', '主题', '冲突'],
    triggers: ['故事', '脑洞', '一句话', '立意', '主线'],
    priority: 10,
    prompt: '一句话必须包含具体主角、可执行欲望、明确阻力和不行动的代价；故事核=欲望×阻力×代价。不要用“成长”“救赎”“人性”等抽象词代替具体事件。'
  },
  {
    id: 'character-matrix',
    title: '人物档案与弧光',
    category: 'character',
    tasks: ['blueprint', 'outline', 'chapter', 'rewrite', 'assistant'],
    kinds: ALL_KINDS,
    tags: ['人物', '角色', '弧光', '关系'],
    triggers: ['人物', '角色', '性格', '成长', '关系', '弧光', '人物小传'],
    priority: 9,
    prompt: '每个人物写清身份、外观、想要、害怕、秘密、旧伤、执念、关系与弧光起点→转折→终点。秘密必须能改变一次选择；配角也要有自己的目标，不能只为主角服务。'
  },
  {
    id: 'world-rules',
    title: '能影响行动的世界规则',
    category: 'world',
    tasks: ['blueprint', 'outline', 'chapter', 'storyboard', 'assistant'],
    kinds: ALL_KINDS,
    tags: ['世界观', '规则', '势力', '道具'],
    triggers: ['世界观', '设定', '规则', '力量体系', '势力', '道具', '时代'],
    priority: 7,
    prompt: '世界设定只保留能影响行动的规则：时间、空间、力量、社会、文化。每条规则都要有代价、例外和被剧情利用的漏洞；不要写百科式背景。'
  },
  {
    id: 'outline-arc',
    title: '章节/镜头功能与情绪曲线',
    category: 'story',
    tasks: ['outline', 'chapter', 'storyboard', 'adaptation'],
    kinds: ALL_KINDS,
    tags: ['大纲', '结构', '节奏', '情绪曲线', '伏笔'],
    triggers: ['大纲', '细纲', '章纲', '结构', '节奏', '伏笔', '情绪'],
    priority: 9,
    prompt: '每个单元必须有目标、阻力、转折、余波和钩子。开篇给承诺，中段升级并付出代价，后段回收伏笔；每 3–4 个单元给小胜/小败，每 8–12 个单元给一次大转折。'
  },
  {
    id: 'hook-opening',
    title: '开头钩子与第一选择',
    category: 'story',
    tasks: ['blueprint', 'chapter', 'rewrite', 'screenplay', 'adaptation', 'assistant'],
    kinds: ALL_KINDS,
    tags: ['开头', '钩子', '第一段', '开场'],
    triggers: ['开头', '开场', '钩子', '第一章', '第一镜', '吸引'],
    priority: 7,
    prompt: '开头 100 字/前 3 秒给具体异常画面与压力，不用天气、梦境或百科说明凑气氛；让主角尽早做一个有代价的选择，读者才知道该担心什么。'
  },
  {
    id: 'scene-engine',
    title: '场景发动机：目标—阻力—转折',
    category: 'story',
    tasks: ['blueprint', 'outline', 'chapter', 'rewrite', 'screenplay', 'storyboard'],
    kinds: ALL_KINDS,
    tags: ['场景', '目标', '冲突', '转折'],
    triggers: ['场景', '桥段', '对峙', '冲突', '转折'],
    priority: 8,
    prompt: '场景=目标+阻力+转折+余波。人物带着未说出口的欲望进场，离开时局势或关系必须变化；晚进早出，删掉没有变化的寒暄。'
  },
  {
    id: 'prose-concrete',
    title: '去 AI 腔的具象写作',
    category: 'prose',
    tasks: ['chapter', 'rewrite', 'assistant'],
    kinds: ALL_KINDS,
    tags: ['文风', '润色', 'AI味', '描写', '对白'],
    triggers: ['润色', '文风', 'AI味', '改写', '描写', '更自然', '更克制'],
    priority: 8,
    prompt: '删“感到/觉得/开始/正在/仿佛/似乎”；把情绪换成身体反应、动作、物件与空间；长短句交替；不要每段总结主题，不要用对称排比制造廉价气势。'
  },
  {
    id: 'dialogue-subtext',
    title: '对白：想要、隐瞒与潜台词',
    category: 'prose',
    tasks: ['chapter', 'rewrite', 'dialogue', 'screenplay', 'storyboard'],
    kinds: ALL_KINDS,
    tags: ['对白', '台词', '潜台词', '语气'],
    triggers: ['对白', '台词', '对话', '潜台词', '语气', '说话'],
    priority: 9,
    prompt: '每句台词都有想要、隐瞒或试探；允许答非所问、抢话、沉默和停顿；潜台词用动作与场景承载。不同人物的句长、词汇、口头禅必须不同，不用台词解释设定。'
  },
  {
    id: 'pacing-tension',
    title: '信息释放与紧张度',
    category: 'prose',
    tasks: ['outline', 'chapter', 'rewrite', 'screenplay', 'storyboard', 'assistant'],
    kinds: ALL_KINDS,
    tags: ['节奏', '紧张', '悬念', '信息'],
    triggers: ['节奏', '紧张', '悬念', '钩子', '拖沓', '加快', '慢一点'],
    priority: 7,
    prompt: '每场只回答一个问题、抛出更大的问题。紧张段落句子变短、动作变密；舒缓段落留一个具体感官细节；章末钩子必须是可见事件或选择，不要只写“他不知道未来会怎样”。'
  },
  {
    id: 'plot-twist',
    title: '公平反转',
    category: 'story',
    tasks: ['outline', 'chapter', 'rewrite', 'assistant'],
    kinds: ALL_KINDS,
    tags: ['反转', '真相', '伏笔'],
    triggers: ['反转', '真相', '揭秘', '意外', '结局'],
    priority: 6,
    prompt: '反转必须来自已埋下的信息与人物选择，不要靠新设定救场。埋设要显眼但可被误读；揭晓时同时改变人物关系和代价，而不是只公布一个身份。'
  },
  {
    id: 'screenplay-format',
    title: '可拍摄的剧本格式',
    category: 'screen',
    tasks: ['adaptation', 'screenplay', 'assistant'],
    kinds: ['drama'],
    tags: ['剧本', '场景标题', '动作', '台词'],
    triggers: ['剧本', '分场', '场景标题', '改编', '可拍'],
    priority: 8,
    prompt: '使用场景标题（内/外·地点·时间）、现在时动作、短台词；只写摄影机和演员能拍到的内容，不写心理活动。每场标清目标、转折与结尾钩子。'
  },
  {
    id: 'scene-transition',
    title: '有理由的转场',
    category: 'screen',
    tasks: ['storyboard', 'screenplay', 'adaptation'],
    kinds: ['drama'],
    tags: ['转场', '切换', '时间跳跃'],
    triggers: ['转场', '切换', '时间跳跃', '蒙太奇'],
    priority: 5,
    prompt: '转场用画面、声音或动作匹配连接；切、叠化、匹配剪辑都要有情绪理由。时间跳跃用具体变化交代，不用字幕解释。'
  },
  {
    id: 'storyboard-cinema',
    title: '电影级分镜与连续性',
    category: 'visual',
    tasks: ['storyboard', 'image', 'video', 'assistant'],
    kinds: ['drama'],
    tags: ['分镜', '景别', '运镜', '构图', '连续性'],
    triggers: ['分镜', '镜头', '景别', '运镜', '构图', '连续性', '机位'],
    priority: 10,
    prompt: '遵循 180°/30° 规则；景别递进；权力用低角度+缓慢推近，弱势用高角度+留白；每镜只承担一个叙事功能，相邻镜头有视觉对比；写清服装、道具、天气、方向与空间关系。'
  },
  {
    id: 'image-prompt',
    title: '画面提示词公式',
    category: 'visual',
    tasks: ['image', 'storyboard'],
    kinds: ['drama'],
    tags: ['画面', '提示词', '绘图', '构图'],
    triggers: ['画面', '绘图', '生成图', '参考图', '镜头图'],
    priority: 9,
    prompt: '提示词顺序：主体动作+外观服装+环境天气+景别角度+构图+光位+风格+技术规格+连续性+避免项。角色参考优先于文字描述；画面不出现文字、水印、分镜边框或漫画格。'
  },
  {
    id: 'video-motion',
    title: '连续镜头的运动提示',
    category: 'visual',
    tasks: ['video', 'storyboard'],
    kinds: ['drama'],
    tags: ['视频', '运镜', '运动', '首帧'],
    triggers: ['视频', '运镜', '运动', '图生视频', '首帧'],
    priority: 9,
    prompt: '视频提示写清首帧一致性、主体运动、镜头运动、环境运动、光线变化与结尾状态；保持单一连续镜头，不切镜；避免文字、水印、换脸、服装变化和多余人物。'
  },
  {
    id: 'voice-performance',
    title: '配音意图与节奏',
    category: 'audio',
    tasks: ['voice', 'dialogue', 'storyboard'],
    kinds: ['drama'],
    tags: ['配音', '声线', '台词', '语气'],
    triggers: ['配音', '声音', '声线', '朗读', '语气'],
    priority: 6,
    prompt: '先定台词的意图（请求/威胁/试探/掩饰），再定节奏（停顿、抢话、呼吸、尾音）。短句更口语；不要让配音念旁白式说明。'
  },
  {
    id: 'sound-music',
    title: '配乐与音效让位',
    category: 'audio',
    tasks: ['music', 'review', 'storyboard'],
    kinds: ['drama'],
    tags: ['音乐', '音效', '混音', '情绪'],
    triggers: ['音乐', '配乐', '音效', '混音', '声音设计'],
    priority: 5,
    prompt: '配乐只服务情绪转折：用动机重复与变化、留白和呼吸；音效写清空间距离与方向；对白优先，音乐让位。'
  },
  {
    id: 'continuity-review',
    title: '连续性与事实核对',
    category: 'review',
    tasks: ['review', 'assistant'],
    kinds: ALL_KINDS,
    tags: ['检查', '连续性', '事实', '一致性'],
    triggers: ['检查', '连续性', '一致性', '穿帮', '核对'],
    priority: 6,
    prompt: '逐项核对人物外观、服装、道具位置、天气/方向、时间、空间关系与说话对象。发现冲突先指出证据与影响，不擅自改正文；没有证据的判断标为不确定。'
  },
  {
    id: 'adaptation-source',
    title: '小说改编：保留代价，删解释',
    category: 'story',
    tasks: ['adaptation', 'screenplay', 'outline'],
    kinds: ['drama'],
    tags: ['改编', '来源', '小说转剧本', '节拍'],
    triggers: ['改编', '小说转', '转剧本', '漫剧化', '原文'],
    priority: 9,
    prompt: '先提取可拍事件、人物欲望与代价，不逐句搬运；每场标注来源章节/原文依据；保留核心关系与选择，删解释性心理描写，把信息变成动作、对白或视觉。'
  },
  {
    id: 'comic-panel',
    title: '漫画分格与阅读方向',
    category: 'visual',
    tasks: ['comic', 'storyboard'],
    kinds: ['drama'],
    tags: ['漫画', '四格', '分格', '阅读方向'],
    triggers: ['漫画', '四格', '分格', '格子', '漫画排版'],
    priority: 6,
    prompt: '每格一个动作节拍；阅读方向清晰；用景别变化控制节奏；对白短，拟声词克制；格子边界与留白服务情绪，不要把所有信息塞进同一格。'
  },
  {
    id: 'audience-promise',
    title: '受众承诺与兑现',
    category: 'story',
    tasks: ['blueprint', 'outline', 'chapter', 'assistant'],
    kinds: ALL_KINDS,
    tags: ['受众', '类型', '爽点', '期待'],
    triggers: ['受众', '读者', '观众', '爽点', '期待', '类型'],
    priority: 5,
    prompt: '先明确读者/观众在什么场景消费、期待什么情绪或快感；每 2–3 个单元兑现一次承诺，不靠标题党；类型约定可以打破，但必须先满足再反转。'
  },
  {
    id: 'chapter-illustration',
    title: '叙事插图的画面选择',
    category: 'visual',
    tasks: ['image', 'comic'],
    kinds: ['short', 'novel'],
    tags: ['插图', '配图', '章节图'],
    triggers: ['插图', '配图', '章节图', '插画'],
    priority: 6,
    prompt: '插图只画一个决定性瞬间：主体明确、环境可读、情绪来自动作和光，不追求把整章信息塞满；不出现文字、水印、分镜边框，保持与人物设定一致。'
  }
]

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ')
}

export function selectCreativePrompts(input: PromptSelectInput): SelectedPromptModule[] {
  const query = normalize(input.query ?? '')
  const limit = Math.max(1, Math.min(10, input.limit ?? 5))
  return CREATIVE_PROMPT_MODULES
    .map((module) => {
      let score = module.priority
      if (module.tasks.includes(input.task)) score += 12
      if (module.kinds.includes(input.kind)) score += 4
      for (const tag of module.tags) if (query.includes(normalize(tag))) score += 3
      for (const trigger of module.triggers) if (query.includes(normalize(trigger))) score += 6
      return { ...module, score }
    })
    .filter((module) => module.score >= 12)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
}

export function creativePromptContext(input: PromptSelectInput): string {
  const selected = selectCreativePrompts(input)
  if (!selected.length) return ''
  return `\n\n【创作手法库·按需调取】\n${selected.map((module, index) => `${index + 1}. ${module.title}：${module.prompt}`).join('\n')}`
}

export function promptModuleIds(input: PromptSelectInput): string[] {
  return selectCreativePrompts(input).map((module) => module.id)
}
