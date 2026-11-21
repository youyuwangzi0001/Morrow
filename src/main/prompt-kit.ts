// 创作台提示词基座（运行时读取层，仅主进程与测试）。
//
// 只覆盖创作台的方法论与工作流提示词——系统提示词、v4 视频提示词骨架、中文→英文映射
// 与英文兜底句、手部规避的物体改写模板、配乐声明与乐器编制。Agent 侧的辅助提示词
// （侧边聊天、经验编辑、经验整理）不在此列，它们直接写在各自源码里。
//
// 安全模型：这些提示词是应用底层资产，仓库里既不留明文、也不留可直接解密的密文。
// 唯一运行时来源是 src/generated/prompts.bundle.ts——由 scripts/embed-prompts.mjs
// 在本机构建时从私有源数据生成，该目录被 .gitignore 忽略，不进仓库、不进源码包。
//
// 本模块依赖 node:zlib，只能在主进程/测试里用；渲染层需要的产线模块（如 scene-integrity）
// 不含提示词，与这里无关。
import { gunzipSync } from 'node:zlib'
import { PROMPTS_BUNDLE } from '../generated/prompts.bundle'

export interface PromptKit {
  systemPrompts: {
    BLUEPRINT_SYSTEM: string
    LONG_BLUEPRINT_TOP_SYSTEM: string
    LONG_BLUEPRINT_CAST_SYSTEM: string
    LONG_BLUEPRINT_UNITS_SYSTEM: string
    OUTLINE_SYSTEM: string
    STORYBOARD_SYSTEM: string
    PROSE_SYSTEM: string
  }
  v4: {
    /** 音频三行 */
    audioLines: { soundscapeSuffix: string; music: string; noSubtitles: string }
    /** 骨架固定句，含 {占位符} */
    lines: Record<string, string>
  }
  adapter: {
    shotSizes: string[]
    cameraMoves: string[]
    cues: string[]
    fallbacks: Record<string, string>
  }
  hand: {
    /** 结尾否定块 */
    tail: string
    /** 物体改写模板：动作模式 → 模板描述（不含 {object}，运行时前置道具名） */
    templates: Record<string, string>
    /** 没有动作时的静态描述 */
    staticTemplate: string
    /** 没有任何模板命中时的兜底描述 */
    defaultTemplate: string
  }
  music: {
    declaration: string
    palette: Record<string, string[]>
    captionBody: string
  }
}

/** 三套大师方法（写作 / 编剧 / 导演）的打包数据。 */
export interface CreativeMastersBundle {
  version: number
  masters: Record<string, { skill: string; methodology: Record<string, string> }>
}

interface PromptBundle extends CreativeMastersBundle {
  kit: PromptKit
}

/**
 * 解包构建期提示词产物。
 *
 * 产物经 gzip → 逐字节异或 → 整体倒序；解码按相反顺序还原。
 * 编码只避免被顺手 strings 看穿，真正的保护是「不进仓库、不随源码分发」。
 */
function decodeBundle(): PromptBundle {
  const raw = Buffer.from(PROMPTS_BUNDLE, 'base64').reverse()
  for (let index = 0; index < raw.length; index++) raw[index] ^= 0x5a
  return JSON.parse(gunzipSync(raw).toString('utf8')) as PromptBundle
}

let decoded: PromptBundle | null = null
function bundle(): PromptBundle {
  if (!decoded) decoded = decodeBundle()
  return decoded
}

/** 创作台提示词基座。 */
export function loadPromptKit(): PromptKit {
  return bundle().kit
}

/** 三套大师方法（写作 / 编剧 / 导演）。 */
export function loadCreativeMasters(): CreativeMastersBundle {
  return { version: bundle().version, masters: bundle().masters }
}