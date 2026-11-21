import { describe, expect, it } from 'vitest'
import { avoidHandsInPrompt, detectHandSemantics, findProp, rewriteHandAction } from '../../src/main/hand-avoid'

/**
 * 改写后不允许残留的手部词；只查「画手」相关的，不误伤「扶手」这类词。
 * 注意：改写结果末尾固定带否定块「画面里不出现手、手指或手臂」，
 * 那里出现「手指」是刻意的指令，不算残留，所以先剥掉否定块再检查。
 */
const HAND_FORBIDDEN = ['一只手', '双手', '手指', '拇指', '食指', '中指', '指腹', '指尖', '指节', '手掌', '手腕', '握紧', '握住', '握着', '抓起', '捏住']
const NEGATION_BLOCK = '画面里不出现手、手指或手臂；动作由物体自身完成'

function stripNegation(text: string): string {
  return text.replace(NEGATION_BLOCK, '').replace(/[。；\s]+$/, '')
}

function assertNoHand(text: string): void {
  const body = stripNegation(text)
  for (const word of HAND_FORBIDDEN) {
    expect(body.includes(word), `改写后的描述部分仍含手部词「${word}」：${body}`).toBe(false)
  }
}

describe('C-05 手部规避构图器', () => {
  it('@core:studio-media 含手部语义的提示词被改写成物体主体，且改写后不含手部动词', () => {
    // 方案里的真实样例（V07/X04 的原始描述）
    const original = '一只手抬起，拇指指腹贴在那道更新的铅笔线上，缓慢向旁边抹了一下'
    const result = rewriteHandAction(original)

    expect(result.rewritten, '含手部语义必须改写').toBe(true)
    expect(result.hits.length).toBeGreaterThan(0)
    // 关键：改写后的文本里不能再有手部词，动作要交给物体
    assertNoHand(result.text)
    expect(result.text).toContain('铅笔')
    // 必须带上否定块，即使前文改得不彻底也不给模型补手的机会
    expect(result.text).toContain('不出现手')

    // 原文保留，供界面做前后对照
    expect(result.original).toBe(original)
    expect(result.text).not.toBe(original)
  })

  it('@core:studio-media 无手部语义的提示词原样保留，不做任何改动', () => {
    const samples = [
      '尺带从盒中弹出，贴住墙面延伸，金属表面反出冷光',
      '雨落在伞面上，水珠沿伞骨滑落',
      '纸鹤停在窗台上，翅膀微微颤动'
    ]
    for (const sample of samples) {
      const result = rewriteHandAction(sample)
      expect(result.rewritten, `「${sample}」不该被改写`).toBe(false)
      expect(result.text, '未改写时文本必须完全一致').toBe(sample)
      expect(result.hits).toHaveLength(0)
    }
  })

  it('@core:studio-media 隐式手部动作与悬空主语：不含「手」字也要改，且不残留残句', () => {
    // 「照片平放」这种写法方案里明确记录过：仍会被模型补出手（W09 的教训）
    const flat = rewriteHandAction('她把照片平放在座椅上，起身离开')
    expect(flat.rewritten, '「平放 / 起身」属于隐式手部动作，必须改写').toBe(true)
    assertNoHand(flat.text)
    expect(flat.text).toContain('照片')
    // 不能残留「她把」这种被截断的施动结构
    expect(flat.text.startsWith('她'), '不能以悬空主语开头').toBe(false)
    expect(flat.text).not.toContain('起身')

    // 握持类：动作转移给道具
    const grip = rewriteHandAction('男人握紧伞柄，回头看向巷口')
    expect(grip.rewritten).toBe(true)
    assertNoHand(grip.text)
    expect(grip.text).toContain('伞')

    // 检测器本身要能认出隐式动作与手指细分词
    expect(detectHandSemantics('她把照片平放在座椅上').map((hit) => hit.word)).toContain('平放')
    expect(detectHandSemantics('拇指贴住纸面').map((hit) => hit.word)).toEqual(expect.arrayContaining(['拇指']))
    expect(findProp('男人握紧伞柄')).toBe('伞')
  })

  it('@core:studio-media 完整提示词只改命中句，其余原样保留，且不产生双句号', () => {
    const prompt = 'Picture 1 是这一镜的身份参考。主体动作：一只手抬起，拇指贴住铅笔线抹开。镜头缓缓推近。'
    const result = avoidHandsInPrompt(prompt)

    expect(result.rewritten).toBe(true)
    // 未命中的句子必须原样保留
    expect(result.text).toContain('Picture 1 是这一镜的身份参考。')
    expect(result.text).toContain('镜头缓缓推近。')
    // 命中句被替换，且不留手部词
    assertNoHand(result.text)
    expect(result.text).toContain('铅笔')
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0].from).toContain('一只手')

    // 标点：不允许出现连续句号
    expect(result.text.includes('。。'), `出现双句号：${result.text}`).toBe(false)
    expect(result.text.includes('！。')).toBe(false)

    // 完全无手部语义的 prompt 必须一字不改
    const clean = 'Picture 1 是身份参考。尺带沿墙面延伸，光从左侧掠过。'
    const untouched = avoidHandsInPrompt(clean)
    expect(untouched.rewritten).toBe(false)
    expect(untouched.text).toBe(clean)
    expect(untouched.changed).toHaveLength(0)
  })

  it('@core:studio-media 真实拼装形态：把改写结果放进「主体动作」段后，整段 prompt 不含手部动词', () => {
    // 复刻 studio.ts 的拼接顺序（视频 prompt 的「主体动作」段用改写后的文本）
    const actions = [
      '一只手抬起，拇指指腹贴在那道更新的铅笔线上，缓慢向旁边抹了一下',
      '她把照片平放在座椅上，起身离开',
      '男人握紧伞柄，回头看向巷口'
    ]
    for (const action of actions) {
      const guard = avoidHandsInPrompt(action)
      const prompt = [
        'Picture 1 是这一镜的身份、构图、服装和光线参考；只让画面中已有的人物与道具完成动作，不要换场景、不要新增人物、不要切镜。',
        `主体动作：${guard.text}`,
        '镜头：固定；单一连续运动。',
        '环境运动：保持人物外观、光线与道具位置一致。'
      ].join(' ')
      // 剔除否定块后，整段 prompt 不应再出现任何手部动作词
      const body = prompt.replace('画面里不出现手、手指或手臂；动作由物体自身完成', '')
      for (const word of ['拇指', '指腹', '握紧', '平放', '起身', '一只手', '双手']) {
        expect(body.includes(word), `拼装后的 prompt 仍含「${word}」：${body}`).toBe(false)
      }
    }
  })
})