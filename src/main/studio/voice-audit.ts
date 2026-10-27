import type {
  StudioCharacter,
  StudioCheck,
  StudioProject,
  StudioVoiceAudit,
  StudioVoiceProfile
} from '../../shared/studio'
import { studioId } from './store'

const SPEECH_VERBS = '说|问道|问|答道|答|道|喊道|喊|低声说|低声|笑道|笑|冷笑|开口|咕哝|嘟囔|吼道|吼|叹道|叹'
const STOP_WORDS = new Set([
  '一个', '什么', '我们', '你们', '他们', '她们', '这个', '那个', '自己', '没有', '就是', '不是',
  '可以', '已经', '还是', '但是', '只是', '如果', '因为', '所以', '然后', '现在', '这里', '那里',
  '知道', '觉得', '时候', '起来', '出来', '过来', '一下', '一点', '真的', '不会', '不要', '不能'
])
const ADDRESS_TERMS = ['您', '你', '先生', '小姐', '老师', '师父', '大人', '陛下', '殿下', '老板', '哥', '姐', '叔', '姨']

interface DialogueLine {
  speaker: string
  text: string
  chapterId?: string
  shotId?: string
}

function cleanLine(raw: string): string {
  return raw
    .replace(/[“”「」『』"]/g, '')
    .replace(/（[^）]{0,40}）/g, '')
    .replace(/\([^)]{0,40}\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

function pushLine(list: DialogueLine[], speaker: string, text: string, extra: Partial<DialogueLine> = {}): void {
  let name = speaker.trim()
  if (name.length > 1) name = name.replace(/(说道|问道|答道|笑道|喊道|吼道|叹道|低声说|说|道|问|答|笑|喊|吼|叹)$/u, '')
  const line = cleanLine(text)
  if (!name || !line || line.length < 2) return
  list.push({ speaker: name, text: line, ...extra })
}

/** 从正文中提取“谁说 + 说了什么”，只收有明确归属的句子。 */
export function extractChapterDialogue(content: string, chapterId: string): DialogueLine[] {
  const lines: DialogueLine[] = []
  const text = content.replace(/\r\n?/g, '\n')
  const before = new RegExp(`([\\u4e00-\\u9fa5]{1,6}?)(?:${SPEECH_VERBS})[：:，,]?\\s*[“「]([^”」]{1,500})[”」]`, 'g')
  const after = new RegExp(`[“「]([^”」]{1,500})[”」]\\s*[，,]?\\s*([\\u4e00-\\u9fa5]{1,6}?)(?:${SPEECH_VERBS})`, 'g')
  const labelled = /^([\u4e00-\u9fa5]{1,6})[：:]\s*[“「]?([^”」\n]{2,500})[”」]?$/gm
  for (const match of text.matchAll(before)) pushLine(lines, match[1], match[2], { chapterId })
  for (const match of text.matchAll(after)) pushLine(lines, match[2], match[1], { chapterId })
  for (const match of text.matchAll(labelled)) pushLine(lines, match[1], match[2], { chapterId })
  const seen = new Set<string>()
  return lines.filter((line) => {
    const key = `${line.speaker}\u0000${line.text}\u0000${line.chapterId ?? ''}\u0000${line.shotId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function extractShotDialogue(project: StudioProject): DialogueLine[] {
  const lines: DialogueLine[] = []
  for (const shot of project.shots) {
    const raw = shot.dialogue.trim()
    if (!raw) continue
    const parts = raw.split(/\n+/).map((item) => item.trim()).filter(Boolean)
    for (const part of parts) {
      const labelled = /^([\u4e00-\u9fa5]{1,6})[：:]\s*(.+)$/.exec(part)
      const speaker = labelled?.[1] || shot.speaker || ''
      const text = labelled?.[2] || part
      if (!speaker) {
        for (const sentence of text.split(/(?<=[。！？!?；;])/).filter((item) => item.trim())) {
          lines.push({ speaker: '', text: cleanLine(sentence), shotId: shot.id })
        }
        continue
      }
      for (const sentence of text.split(/(?<=[。！？!?；;])/).filter((item) => item.trim())) {
        pushLine(lines, speaker, sentence, { shotId: shot.id })
      }
    }
  }
  return lines
}

function charBigrams(text: string): Map<string, number> {
  const clean = text.replace(/[^\u4e00-\u9fa5]/g, '')
  const map = new Map<string, number>()
  for (let index = 0; index + 2 <= clean.length; index += 1) {
    const gram = clean.slice(index, index + 2)
    map.set(gram, (map.get(gram) ?? 0) + 1)
  }
  return map
}

function cosine(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (const value of left.values()) leftNorm += value * value
  for (const value of right.values()) rightNorm += value * value
  for (const [key, value] of left) {
    const other = right.get(key)
    if (other) dot += value * other
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}

function topPhrases(lines: string[]): string[] {
  const counts = new Map<string, number>()
  for (const line of lines) {
    const clean = line.replace(/[^\u4e00-\u9fa5]/g, '')
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= clean.length; index += 1) {
        const phrase = clean.slice(index, index + size)
        if (STOP_WORDS.has(phrase)) continue
        counts.set(phrase, (counts.get(phrase) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .filter(([phrase, count]) => count >= 3 && !STOP_WORDS.has(phrase))
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length)
    .slice(0, 4)
    .map(([phrase, count]) => `${phrase}×${count}`)
}

function addressTerms(lines: string[]): string[] {
  const counts = new Map<string, number>()
  for (const line of lines) {
    for (const term of ADDRESS_TERMS) {
      const found = line.split(term).length - 1
      if (found) counts.set(term, (counts.get(term) ?? 0) + found)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([term, count]) => `${term}×${count}`)
}

function profileFor(character: StudioCharacter, lines: DialogueLine[]): StudioVoiceProfile {
  const texts = lines.map((line) => line.text)
  const words = texts.reduce((sum, line) => sum + line.replace(/\s+/g, '').length, 0)
  const avgLine = texts.length ? words / texts.length : 0
  const questionRatio = texts.length ? texts.filter((line) => /[？?]/.test(line)).length / texts.length : 0
  const exclaimRatio = texts.length ? texts.filter((line) => /[！!]/.test(line)).length / texts.length : 0
  const tone = avgLine < 10 ? '短句居多' : avgLine > 24 ? '长句居多' : '长短相间'
  const mood = questionRatio >= 0.25 ? '常用问句试探' : exclaimRatio >= 0.15 ? '情绪外放' : '语气克制'
  const summary = texts.length ? `${tone}，${mood}；平均每句 ${avgLine.toFixed(1)} 字。` : '还没有可归属的台词。'
  return {
    characterId: character.id,
    name: character.name,
    lineCount: texts.length,
    words,
    avgLine: Math.round(avgLine * 10) / 10,
    questionRatio: Math.round(questionRatio * 100) / 100,
    exclaimRatio: Math.round(exclaimRatio * 100) / 100,
    topPhrases: topPhrases(texts),
    addressTerms: addressTerms(texts),
    summary
  }
}

export interface VoiceAuditResult {
  audit: StudioVoiceAudit
  checks: StudioCheck[]
}

export function auditCharacterVoices(project: StudioProject): VoiceAuditResult {
  const chapterLines = project.chapters.flatMap((chapter) => extractChapterDialogue(chapter.content, chapter.id))
  const shotLines = extractShotDialogue(project)
  const all = [...chapterLines, ...shotLines]
  const knownNames = new Map(project.characters.map((character) => [character.name, character]))
  const names = new Set([...knownNames.keys()])
  for (const line of all) if (line.speaker) names.add(line.speaker)
  const profiles: StudioVoiceProfile[] = []
  for (const name of names) {
    const character = knownNames.get(name) ?? {
      id: `voice_unknown_${name}`,
      name,
      role: '未建档',
      look: '',
      relationships: [],
      refAssetIds: []
    }
    profiles.push(profileFor(character, all.filter((line) => line.speaker === name)))
  }
  profiles.sort((a, b) => b.lineCount - a.lineCount)
  const warnings: StudioVoiceAudit['warnings'] = []
  const unresolved = all.filter((line) => !line.speaker).length
  if (unresolved) {
    warnings.push({ level: 'info', title: `${unresolved} 句台词没有明确说话人`, detail: '这些句子没有进入人物语气统计；可以在分镜台词里用“角色名：台词”补上归属。' })
  }
  if (all.length < 8) {
    warnings.push({ level: 'info', title: '台词样本偏少', detail: `目前只有 ${all.length} 句可归属台词，语气判断仅供参考；正文写到 2000 字以上再跑一次更准。` })
  }
  const vector = new Map<string, Map<string, number>>()
  for (const profile of profiles) {
    const lines = all.filter((line) => line.speaker === profile.name).map((line) => line.text)
    vector.set(profile.characterId, charBigrams(lines.join('')))
  }
  for (let left = 0; left < profiles.length; left += 1) {
    for (let right = left + 1; right < profiles.length; right += 1) {
      const a = profiles[left]
      const b = profiles[right]
      if (a.lineCount < 5 || b.lineCount < 5) continue
      const similarity = cosine(vector.get(a.characterId)!, vector.get(b.characterId)!)
      if (similarity >= 0.82) {
        warnings.push({
          level: 'warn',
          title: `${a.name} 与 ${b.name} 的语气可能趋同`,
          detail: `两人的用词相似度 ${Math.round(similarity * 100)}%，平均句长分别为 ${a.avgLine} / ${b.avgLine} 字。可以给其中一人换口头禅、句长或称谓。`
        })
      }
    }
  }
  for (const profile of profiles) {
    const character = knownNames.get(profile.name)
    if (character?.role.includes('主角') && profile.lineCount === 0) {
      warnings.push({ level: 'warn', title: `${profile.name} 还没有可归属台词`, detail: '主角的欲望与态度需要靠说话方式落地；可以在正文或分镜里补一段带明确说话人的对白。', characterId: character.id })
    }
    if (profile.lineCount >= 8 && profile.topPhrases.length === 0 && profile.avgLine > 30) {
      warnings.push({ level: 'info', title: `${profile.name} 的句子偏长且缺少口头习惯`, detail: '长句本身不是问题；如果角色需要更强的辨识度，可以加入固定称谓或短促反应句。', characterId: profile.characterId })
    }
  }
  const audit: StudioVoiceAudit = {
    createdAt: Date.now(),
    profiles,
    unresolved,
    warnings
  }
  const checks: StudioCheck[] = []
  const now = Date.now()
  for (const warning of warnings) {
    checks.push({
      id: studioId('check'),
      kind: 'voice',
      level: warning.level,
      title: warning.title,
      detail: warning.detail,
      ...(warning.characterId ? { targetId: warning.characterId } : {}),
      createdAt: now
    })
  }
  if (profiles.length && !warnings.length) {
    checks.push({
      id: studioId('check'),
      kind: 'voice',
      level: 'info',
      title: '人物语气没有明显冲突',
      detail: `${profiles.filter((profile) => profile.lineCount > 0).length} 个角色有可归属台词，句长、问句比例与用词没有出现高度重合。`,
      createdAt: now
    })
  }
  return { audit, checks }
}
