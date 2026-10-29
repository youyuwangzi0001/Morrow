// Copies fresh E2E screenshots into docs/guide/screens and regenerates manifest.json.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const source = join(root, 'docs', 'verification', 'screens')
const guide = join(root, 'docs', 'guide', 'screens')
mkdirSync(guide, { recursive: true })

const entries = [
  ['01-onboarding-dark.png', 'brand-onboarding-dark.png', '首次启动：认识 Morrow、连接模型、选择工作文件夹'],
  ['02-chat-home-dark.png', 'r7-final-layout-dark.png', '主界面：工作模式、建议任务、会话输入与画布入口'],
  ['03-permission-card-dark.png', 'permission-card-dark.png', '审批卡：高风险写入的影响范围、允许一次与拒绝'],
  ['04-editor-canvas-dark.png', 'r10-editor-open.png', '画布与代码编辑器：多标签文件、语法高亮与只读状态'],
  ['05-settings-models-dark.png', 'r5-final-settings-models.png', '设置 · 模型：服务商、API Key、当前默认模型与思考档位'],
  ['06-subscriptions-dark.png', 'subscriptions-dark.png', '设置 · 订阅：ChatGPT/Codex 与 Qoder 等官方账号接入'],
  ['07-settings-appearance-dark.png', 'settings-appearance-dark.png', '设置 · 外观：主题、应用字号、代码字号与字体'],
  ['08-media-models-dark.png', 'media-settings-models-dark.png', '设置 · 多媒体：本机引擎、模型目录与导入模型入口'],
  ['09-browser-tabs-dark.png', 'browser-tabs-dark.png', '内置浏览器：多标签、地址栏、页面内容与前进后退'],
  ['10-terminal-dark.png', 'terminal-dark.png', '真实终端：PTY、多标签、命令输出与终端设置'],
  ['11-memory-center-dark.png', 'r10-memory-center-dark.png', '记忆中心：项目记忆、长期记忆、任务经验与注入预览'],
  ['12-projects-dark.png', 'a1-project-home.png', '项目主页：项目背景、资料、会话与工作区入口'],
  ['13-studio-home-dark.png', 'studio-home-dark.png', '创作台作品库：三份样例、一句话入口与蓝图选项'],
  ['14-studio-timeline-dark.png', 'studio-timeline-dark.png', '创作台时间线：监视器、五轨剪辑与时间码'],
  ['15-studio-storyboard-dark.png', 'studio-storyboard-dark.png', '创作台分镜：镜头卡、画面与单镜详情'],
  ['16-studio-delivery-dark.png', 'studio-delivery-dark.png', '创作台交付：成片预览、交付物与导出入口'],
  ['17-studio-writing-dark.png', 'studio-writing-dark.png', '创作台写作：文档工具条、卷章大纲、深色纸页与协作助手'],
  ['18-studio-assistant-dark.png', 'studio-assistant-dark.png', '创作台协作助手：大白话修改计划与影响范围'],
  ['19-studio-home-light.png', 'studio-home-light.png', '创作台素纸主题：米白纸页与深墨文字'],
  ['20-studio-about-dark.png', 'studio-about-dark.png', '设置 · 关于：仅保留 Morrow 主应用信息'],
  ['21-studio-guide-dark.png', 'studio-guide-dark.png', '创作台首次使用指引：三步轨道与无外框正文'],
  ['22-studio-demo-dark.png', 'studio-demo-dark.png', '创作台演示：底部控制条驱动真实分镜、镜头详情与样例数据'],
  ['25-studio-canvas-dark.png', 'studio-canvas-dark.png', '漫剧画布：镜头、音频、文本节点与连线组成的真实工作流'],
  ['26-studio-voice-audit-dark.png', 'studio-voice-audit-dark.png', '人物语气审稿：角色句长、问句比例、高频用语与趋同提醒'],
  ['27-studio-timeline-waveform-dark.png', 'studio-timeline-waveform-dark.png', '时间线真实音频峰值波形与 540p 低清预览入口'],
  ['28-studio-settings-dark.png', 'studio-settings-dark.png', '创作台设置：模型与预算、配音与引擎、历史版本、回收站、数据与安全五页整合'],
  ['29-studio-blueprint-dark.png', 'studio-blueprint-dark.png', '创作台蓝图：故事主线、人物、结构、风格与费用预估'],
  ['30-studio-blueprint-edit-dark.png', 'studio-blueprint-edit-dark.png', '创作台蓝图编辑：故事主线、人物、结构与风格可逐项修改'],
  ['31-studio-review-dark.png', 'studio-review-dark.png', '创作台检查：本地检查、模型审稿与交付前硬问题'],
  ['32-studio-delivery-panel-dark.png', 'studio-delivery-panel-dark.png', '交付面板：草稿/成片、分辨率、字幕与格式'],
  ['33-studio-delivery-panel-light.png', 'studio-delivery-panel-light.png', '交付面板素纸主题：同样的选项与可读对比'],
  ['34-studio-delivery-book-dark.png', 'studio-delivery-book-dark.png', '小说交付：电子书、排版稿、Word 与工程包'],
  ['35-studio-island-dark.png', 'studio-island-studio-dark.png', '灵动岛：创作台当前作品、任务进度与完成状态'],
  ['36-studio-auto-pipeline-dark.png', 'studio-auto-pipeline-dark.png', '自动推进：确认范围后补齐素材并合成草稿'],
  ['37-studio-timeline-compact.png', 'studio-timeline-compact.png', '紧凑窗口：时间线工具栏折叠为图标，不遮挡标尺'],
  ['38-studio-canvas-compact.png', 'studio-canvas-compact.png', '紧凑窗口：画布节点与检查器不转行、不遮挡播放控件'],
  ['39-studio-delivery-player.png', 'studio-delivery-player.png', '交付播放器：成片预览与播放控件'],
  ['40-studio-writing-desk.png', 'matrix/studio-writing-desk.png', '写作台：字号/行距/页宽、字数统计与导出 Word'],
  ['41-studio-trash-dark.png', 'matrix/studio-trash-settings.png', '创作台回收站：恢复或彻底删除作品'],
  ['42-token-activity-dark.png', 'token-activity-daily.png', 'Token Activity：每日/每周/累计用量热力图'],
  ['43-studio-voice-tab-dark.png', 'studio-voice-tab-dark.png', '声音 · 配音：声线、生成/重新配音与导入'],
  ['44-studio-music-tab-dark.png', 'studio-music-tab-dark.png', '声音 · 音乐：正式配乐、草稿与移除'],
  ['45-studio-outline-dark.png', 'studio-outline-dark.png', '创作台大纲：分卷、章节梗概与节拍'],
  ['46-studio-create-dark.png', 'studio-create-dark.png', '创作台创建：一句故事、形态、精细度、比例与补充要求'],
  ['47-studio-settings-data-dark.png', 'studio-settings-data-dark.png', '创作台数据与安全：作品目录、迁移与恢复默认'],
  ['48-studio-plan-card-dark.png', 'studio-plan-card-dark.png', '协作者计划卡：影响、费用、待确认与取消']
]

function pngSize(path) {
  try {
    const buffer = readFileSync(path)
    if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  } catch {
    return null
  }
}

const required = new Set(entries.slice(0, 26).map(([dest]) => dest))
const images = []
const missingRequired = []
for (const [dest, src, alt] of entries) {
  const from = join(source, src)
  const target = join(guide, dest)
  if (!existsSync(from)) {
    if (required.has(dest)) missingRequired.push(src)
    continue
  }
  copyFileSync(from, target)
  const size = pngSize(target)
  images.push({
    file: dest,
    alt,
    ...(size ?? {}),
    source: `tests/e2e · ${src}`
  })
}
if (missingRequired.length) {
  console.error('缺少必选指南截图：', missingRequired.join('、'))
  process.exit(1)
}

writeFileSync(join(guide, 'manifest.json'), `${JSON.stringify({
  product: 'Morrow',
  version: '0.2.0',
  capturedAt: new Date().toISOString().slice(0, 10),
  runtime: 'v0.2.0 latest build (Morrow-app.exe)',
  theme: 'dark + light',
  images
}, null, 2)}\n`, 'utf8')
console.log(`guide screens: ${images.length} -> docs/guide/screens`)
