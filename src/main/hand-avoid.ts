// 手部规避构图器（C-05 / 缺陷 D-04）。
//
// 为什么需要它：MiniMax-H3 对手部结构的建模不稳定，实测四次独立复现畸形
// （V07 手指数量异常、X01 指腹模糊、X04 四指粘连、W09 指节过多+握持融合）。
//
// 关键教训（方案明确记录）：**不能只删「手」字**。
// W09 已把关键帧改成「照片平放在座椅上、画面无手」，审看确认没有手——
// 但生成视频时模型又把手指补了回来。所以改写必须「连语义一起换掉」：
// 让整个动作不再需要手被执行，而不是「有手的动作 + 一句不要手」。
//
// 做法：识别手部动词语义 → 找到它作用的对象（道具）→ 生成「物体自持」的构图描述。
// 例如「拇指贴住铅笔线抹开」不改成「不出现手」，而是「铅笔笔尖自己压在线上」。
//
// 物体改写模板与结尾否定块属于提示词基座，内嵌在 prompt-kit.generated.ts。

import { loadPromptKit } from './prompt-kit'

/** 手部语义命中结果。 */
export interface HandSemanticHit {
  /** 命中的文本片段 */
  text: string
  /** 命中类型 */
  kind: 'body' | 'finger' | 'grip' | 'gesture'
  /** 匹配到的词 */
  word: string
}

/** 一条动作改写规则：把「手做的动作」换成「物体自身的状态/运动」。 */
interface RewriteRule {
  /** 动作词（正则，中文） */
  pattern: RegExp
  /** 该动作涉及的道具类别，用于挑选物体主体 */
  objectOf?: string
  /** 改写模板；{obj} 会被替换成识别出的道具名 */
  template: string
}

/**
 * 手部相关的身体部位与动作词。
 * 分四类是为了给出准确的原因说明：到底是「画了手」「画了手指」「在握持」还是「在比划」。
 */
const BODY_WORDS = ['手', '手掌', '手背', '手腕', '双手', '一只手', '两手', '指缘', '袖口']
const FINGER_WORDS = ['手指', '拇指', '食指', '中指', '无名指', '小指', '指甲', '指腹', '指尖', '指节', '指根']
const GRIP_WORDS = ['握住', '握着', '握紧', '紧握', '握持', '抓起', '抓住', '攥', '捏住', '捏着', '托着', '端着', '拎着', '提着']
const GESTURE_WORDS = ['抬起', '抚摸', '擦拭', '抹开', '抹了', '推开', '递', '接过', '按下', '按压', '指着', '摆手', '招手', '摊开', '比划', '平放']

/** 常见道具：用于在改写时找到「谁在做事」，把动作转移给物体本身。 */
const PROP_WORDS = [
  '铅笔', '钢笔', '笔尖', '毛笔', '尺', '尺带', '卷尺', '照片', '相框', '信纸', '信封', '纸张', '书本', '书页',
  '杯子', '茶杯', '碗', '盘子', '刀', '剪刀', '钥匙', '门把手', '开关', '按钮', '屏幕', '手机', '相机',
  '伞', '伞柄', '雨伞', '灯笼', '烛台', '蜡烛', '绳子', '绳索', '布料', '窗帘', '被角', '衣角', '纸鹤', '折纸'
]

/**
 * 即使不含「手」字，画面上也需要手的动作。
 * 「她起身离开」的画面里那个人是靠手撑起身体的——只删「手」字不够，
 * 必须把这类动作一并换掉，否则模型仍会为了完成动作而画手。
 */
const IMPLICIT_HAND_ACTIONS = [
  '起身', '站起来', '坐下', '蹲下', '弯腰', '捡起', '捡', '拾起', '伸手', '掏', '翻找', '打开抽屉',
  '拉开', '关上', '拿起', '放下', '推动', '搬', '抱', '扶', '拉扯', '脱下', '穿上', '系上', '解开',
  '擦拭', '梳理', '端着', '递给', '接过', '握着', '握着伞'
]

const ALL_WORDS: Array<{ words: string[]; kind: HandSemanticHit['kind'] }> = [
  { words: FINGER_WORDS, kind: 'finger' },
  { words: GRIP_WORDS, kind: 'grip' },
  { words: GESTURE_WORDS, kind: 'gesture' },
  { words: BODY_WORDS, kind: 'body' },
  // 不含「手」字但画面上需要手的动作，同样算手部语义
  { words: IMPLICIT_HAND_ACTIONS, kind: 'gesture' }
]

/**
 * 检测文本里的手部语义。
 * 返回按出现位置排序的命中列表；同一位置只取最长匹配（「手指」优先于「手」）。
 */
export function detectHandSemantics(text: string): HandSemanticHit[] {
  if (!text) return []
  const hits: HandSemanticHit[] = []
  const taken = new Set<number>()
  // 长词优先，避免「手」把「手指」的位置占掉
  const flattened = ALL_WORDS.flatMap((group) => group.words.map((word) => ({ word, kind: group.kind })))
    .sort((a, b) => b.word.length - a.word.length)
  for (const item of flattened) {
    let from = 0
    while (from < text.length) {
      const at = text.indexOf(item.word, from)
      if (at < 0) break
      from = at + item.word.length
      let overlap = false
      for (let index = at; index < at + item.word.length; index++) {
        if (taken.has(index)) {
          overlap = true
          break
        }
      }
      if (overlap) continue
      for (let index = at; index < at + item.word.length; index++) taken.add(index)
      hits.push({ text: item.word, kind: item.kind, word: item.word })
    }
  }
  return hits.sort((a, b) => text.indexOf(a.text) - text.indexOf(b.text))
}

export interface HandAvoidResult {
  /** 是否发生了改写 */
  rewritten: boolean
  /** 改写前的原文 */
  original: string
  /** 改写后的文本 */
  text: string
  /** 检出的手部语义（用于向用户解释为什么改） */
  hits: HandSemanticHit[]
  /** 人可读的改写说明；direct=true 时说明没有改动 */
  note: string
}

/** 找文本里提到的道具；找不到返回 null。长词优先（「伞柄」属「伞」，「尺带」属「尺」）。 */
export function findProp(text: string): string | null {
  // 先把道具的部件名归一成主体名，避免「伞柄」把「伞」的收拢动作吃掉
  const normalize = (word: string): string => {
    if (/伞柄|伞骨|伞面/.test(word)) return '伞'
    if (/尺带|卷尺/.test(word)) return '尺'
    if (/笔尖|钢笔|毛笔/.test(word)) return '铅笔'
    if (/相框/.test(word)) return '照片'
    return word
  }
  for (const prop of PROP_WORDS) {
    if (text.includes(prop)) return normalize(prop)
  }
  return null
}

/**
 * 按「物体自持」重写一段含手部动作的描述。
 *
 * 不是简单删除：删掉「手」会留下「拇指贴住铅笔线抹开」这种悬空句子，模型照样补手。
 * 这里把它变成「铅笔笔尖压在线上、石墨自己拖出一道痕」——动作由物体完成，手没有存在必要。
 */
export function rewriteHandAction(text: string): HandAvoidResult {
  const hits = detectHandSemantics(text)
  if (!hits.length) {
    return { rewritten: false, original: text, text, hits: [], note: '没有手部语义，未改写' }
  }
  const topProp = findProp(text)
  const clauses = text
    .split(/[，。；、,;]/)
    .map((part) => part.trim())
    .filter(Boolean)

  const kept: string[] = []
  // 同一道具的多个手部动作要合并成一句，否则会出现「铅笔…铅笔…铅笔…」的冗余
  const objectMotions = new Map<string, string[]>()
  for (const clause of clauses) {
    const clauseHits = detectHandSemantics(clause)
    if (!clauseHits.length) {
      // 不含手部语义但残留「她把 / 他把 / 用」这类被截断的施动结构，要一并清掉
      if (/^[他她它](把|将|拿|用)?$/.test(clause)) continue
      // 「他把尺带从盒里抽出来」这类把字句：抽出来本身也要手，整句丢弃
      if (/^[他她它]把/.test(clause) && /抽|拿|取|翻|掏|端|托|递|接/.test(clause)) continue
      // 「把照片举到眼前端详」这类无主语的把字句，同样丢弃
      if (/^把/.test(clause) && /举|抬|递|接|按|压|推|拉|抹|擦/.test(clause)) continue
      // 「慢慢把伞收拢」：把字句即便不带手部动词，结构本身也在描述人操作道具。
      // 不整句丢弃——把其中的动作动词收集起来交给道具主体，否则「收拢」这个语义会丢。
      if (/把/.test(clause) && /收|合|卷|展|开|转|放|拿|抽|拉/.test(clause)) {
        const prop = findProp(clause) ?? topProp
        if (prop) {
          const verbs = clause.match(/收|合|卷|展|开|转|放|抽|拉|推|压|贴|弹|滑/g) ?? []
          const bucket = objectMotions.get(prop) ?? []
          bucket.push(...verbs)
          objectMotions.set(prop, bucket)
        }
        continue
      }
      kept.push(clause)
      continue
    }
    const object = findProp(clause) ?? topProp
    if (!object) {
      // 没有道具可依附：不能保留原句（原句本身就要求画手），整句丢弃
      continue
    }
    const motions = clauseHits
      .filter((hit) => hit.kind === 'grip' || hit.kind === 'gesture')
      .map((hit) => hit.word)
    // 子句里出现但未被词表命中的动作动词也要带上，否则「抽出来」会被漏掉，
    // 结果把「抽出尺带」改写成「尺静止不动」，与原文语义相反。
    const extraMotion = clause.match(/抽|拉|推|弹|滑|落|升|转|翻|飞|飘|滚|倾|倒|合|开|收|拢|展|延|贴|压|移/g) ?? []
    const bucket = objectMotions.get(object) ?? []
    bucket.push(...motions, ...extraMotion)
    objectMotions.set(object, bucket)
  }

  const replaced: string[] = []
  for (const [object, motions] of objectMotions) {
    replaced.push(describeObjectMotion(object, motions))
  }

  const body = [...kept, ...replaced].filter(Boolean).join('，').replace(/[。；，]+$/, '')
  // 结尾固定追加否定块：即使前面改得不彻底，也明确禁止手入画
  const tail = loadPromptKit().hand.tail
  const next = body ? `${body}。${tail}。` : `${tail}。`

  const note = [
    `检出 ${hits.length} 处手部语义（${[...new Set(hits.map((hit) => hit.word))].join('、')}）`,
    topProp ? `已把动作转移给「${topProp}」本身` : '原句没有可依附的道具，已改为纯物体构图',
    '并追加「不出现手」的否定块'
  ].join('；')

  return { rewritten: true, original: text, text: next, hits, note }
}

/** 把「道具 + 一组手部动作」翻译成一句物体自身的状态描述。模板来自内嵌提示词基座。 */
function describeObjectMotion(object: string, motions: string[] = []): string {
  const joined = motions.join(' ')
  const { staticTemplate, defaultTemplate, templates } = loadPromptKit().hand
  // 按动作性质挑一个不需要施动者的说法；多个动作按「先动后静」合并成一句
  if (!motions.length) return `${object}${staticTemplate}`
  const parts: string[] = []
  const add = (key: string): void => {
    const template = templates[key]
    if (template) parts.push(`${object}${template}`)
  }
  if (/抽|拉出|弹出/.test(joined)) add('抽|拉出|弹出')
  if (/抹|擦|涂/.test(joined)) add('抹|擦|涂')
  if (/推|挪|移/.test(joined)) add('推|挪|移')
  if (/按|压/.test(joined)) add('按|压')
  if (/递|接|交/.test(joined)) add('递|接|交')
  if (/抬|举|升/.test(joined)) add('抬|举|升')
  if (/平放|放/.test(joined)) add('平放|放')
  if (/收|合|卷/.test(joined)) add('收|合|卷')
  if (/展|开|弹/.test(joined)) add('展|开|弹')
  if (/飞|飘|滚|落/.test(joined)) add('飞|飘|滚|落')
  if (/握|抓|捏|托|端|拎|提/.test(joined)) {
    // 已经被收拢/展开/放下描述过的，不再追加「立住」——否则同一句会自相矛盾
    const alreadyDescribed = /收|合|卷|展|开|抽|拉|平放/.test(joined)
    if (!alreadyDescribed) add('握|抓|捏|托|端|拎|提')
  }
  if (!parts.length) parts.push(`${object}${defaultTemplate}`)
  // 去重后合并，避免同一句里出现两次相同说法
  return [...new Set(parts)].join('，')
}

/**
 * 给视频提示词做手部规避处理：逐个分句检查，含手部语义就改写。
 * 与 rewriteHandAction 的区别：这个函数面向完整 prompt（多句话），
 * 只改动含手部语义的句子，其余原样保留，避免把正常描述也一起重写。
 */
export function avoidHandsInPrompt(prompt: string): {
  rewritten: boolean
  original: string
  text: string
  hits: HandSemanticHit[]
  changed: Array<{ from: string; to: string }>
} {
  const hits = detectHandSemantics(prompt)
  if (!hits.length) {
    return { rewritten: false, original: prompt, text: prompt, hits: [], changed: [] }
  }
  // 按句号/换行切句，只改写命中的句子
  const segments = prompt.split(/(?<=[。！？\n])/)
  const changed: Array<{ from: string; to: string }> = []
  const text = segments
    .map((segment) => {
      if (!detectHandSemantics(segment).length) return segment
      const result = rewriteHandAction(segment.replace(/[。！？\n]+$/, ''))
      if (!result.rewritten) return segment
      changed.push({ from: segment.trim(), to: result.text })
      // rewriteHandAction 的结果已自带句末标点，这里不再补，避免「。。」
      return result.text
    })
    .join('')
  return { rewritten: changed.length > 0, original: prompt, text, hits, changed }
}