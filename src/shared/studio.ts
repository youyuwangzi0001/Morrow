// Morrow 创作台 · 共享领域模型（唯一数据契约）

export const STUDIO_SCHEMA_VERSION = 1
export const STUDIO_ASPECTS = ['16:9', '9:16', '1:1'] as const
export const STUDIO_PACES = ['速成草稿', '精制', '电影级'] as const

export type StudioKind = 'short' | 'novel' | 'drama'
export type StudioAspect = (typeof STUDIO_ASPECTS)[number]
export type StudioPace = (typeof STUDIO_PACES)[number]

/** 统一阶段 id；不同形态只展示与自己相关的阶段。 */
export type StudioStageId =
  | 'blueprint'
  | 'outline'
  | 'writing'
  | 'storyboard'
  | 'visuals'
  | 'voice'
  | 'music'
  | 'timeline'
  | 'review'
  | 'delivery'

export type StudioStatus =
  | 'waiting'
  | 'ready'
  | 'running'
  | 'review'
  | 'done'
  | 'failed'
  | 'stale'
  | 'skipped'

/** 阶段状态的合法转移；用于审计与 future 状态机校验。 */
export const STUDIO_STATUS_TRANSITIONS: Record<StudioStatus, StudioStatus[]> = {
  waiting: ['ready', 'running', 'review', 'done', 'failed', 'stale', 'skipped'],
  ready: ['running', 'review', 'done', 'failed', 'stale', 'skipped'],
  running: ['ready', 'review', 'done', 'failed', 'stale'],
  review: ['ready', 'running', 'done', 'failed', 'stale'],
  done: ['ready', 'running', 'review', 'stale'],
  failed: ['ready', 'running', 'review', 'done', 'stale'],
  stale: ['ready', 'running', 'review', 'done', 'failed'],
  skipped: ['ready', 'running', 'review', 'done', 'stale']
}

export function canTransitionStudioStatus(from: StudioStatus, to: StudioStatus): boolean {
  return from === to || STUDIO_STATUS_TRANSITIONS[from].includes(to)
}

export interface StudioStageState {
  status: StudioStatus
  updatedAt: number
  message?: string
  /** 0–100，仅表示本阶段可计算的完成度；不可计算时省略。 */
  progress?: number
}

export interface StudioStageDef {
  id: StudioStageId
  label: string
  short: string
  description: string
}

export interface StudioBrief {
  form: StudioPace
  genre: string
  audience: string
  tone: string
  style: string
  aspect: StudioAspect
  constraints: string[]
  references: string[]
  targetWords?: number
  targetSeconds?: number
}

export interface StudioStyleBible {
  look: string
  palette: string[]
  camera: string
  sound: string
  negative: string[]
  updatedAt?: number
}

export interface StudioEstimateLine {
  label: string
  costMin: number | null
  costMax: number | null
  note?: string
}

export interface StudioEstimate {
  minutesMin: number
  minutesMax: number
  costMin: number | null
  costMax: number | null
  currency: 'CNY'
  lines: StudioEstimateLine[]
  note?: string
  basis: 'local' | 'cloud' | 'mixed' | 'unknown'
}

export interface StudioRelationship {
  target: string
  label: string
}

export interface StudioCharacter {
  id: string
  name: string
  role: string
  age?: string
  look: string
  voiceId?: string
  desire?: string
  fear?: string
  secret?: string
  arc?: string
  relationships: StudioRelationship[]
  refAssetIds: string[]
  locked?: boolean
  firstChapterId?: string
}

export interface StudioPlace {
  id: string
  name: string
  description: string
  refAssetIds: string[]
}

export interface StudioFaction {
  id: string
  name: string
  description: string
}

export interface StudioRule {
  id: string
  title: string
  content: string
}

export interface StudioProp {
  id: string
  name: string
  description: string
  refAssetIds: string[]
}

export interface StudioFact {
  id: string
  subject: string
  predicate: string
  object: string
  chapterId?: string
  sceneId?: string
  quote?: string
  confidence: number
  source: 'manual' | 'ai' | 'local' | 'import'
  createdAt: number
}

export interface StudioCandidate {
  id: string
  content: string
  label: string
  source: 'model' | 'local' | 'import'
  model?: string
  note?: string
  createdAt: number
  wordCount: number
}

export interface StudioChapterVersion {
  id: string
  content: string
  createdAt: number
  reason: string
  wordCount: number
}

export interface StudioChapterIllustration {
  id: string
  assetId: string
  afterParagraph: number
  caption?: string
  source: 'model' | 'local' | 'import'
  createdAt: number
}

export interface StudioChapter {
  id: string
  volumeId: string | null
  number: number
  title: string
  synopsis: string
  beats: string[]
  content: string
  wordTarget: number
  status: StudioStatus
  revision: number
  candidates: StudioCandidate[]
  versions: StudioChapterVersion[]
  illustrations: StudioChapterIllustration[]
  /** 用户手改后锁定：候选永不自动覆盖。 */
  locked: boolean
  /** 超长章节按分片落盘；content 在读取时恢复为完整文本。 */
  contentRef?: {
    path: string
    chunkSize: number
    chunks: number
    hash: string
  }
  updatedAt: number
}

export interface StudioVolume {
  id: string
  title: string
  summary: string
  number: number
  chapterIds: string[]
}

export interface StudioScene {
  id: string
  episodeId: string | null
  number: number
  title: string
  synopsis: string
  location: string
  timeOfDay: string
  characters: string[]
  beat: string
  sourceChapterId?: string
  updatedAt: number
}

export interface StudioEpisode {
  id: string
  number: number
  title: string
  synopsis: string
  sceneIds: string[]
  durationSec: number
  updatedAt: number
}

export interface StudioCandidateAsset {
  id: string
  assetId: string
  label: string
  source: 'model' | 'local' | 'import'
  model?: string
  createdAt: number
  note?: string
  adopted?: boolean
}

export interface StudioShot {
  id: string
  sceneId: string
  number: number
  title: string
  action: string
  camera: string
  shotSize: string
  durationSec: number
  dialogue: string
  speaker: string
  voiceId: string
  prompt: string
  negative: string
  referenceCharacterIds: string[]
  referencePlaceIds: string[]
  referencePropIds: string[]
  imageAssetId: string | null
  videoAssetId: string | null
  voiceAssetId: string | null
  imageCandidates: StudioCandidateAsset[]
  videoCandidates: StudioCandidateAsset[]
  /** 连续性说明（承接上一镜的雨向、道具、光线等）。 */
  continuity: string
  lockedReference: boolean
  status: StudioStatus
  updatedAt: number
}

export interface StudioAsset {
  id: string
  kind: 'image' | 'video' | 'audio' | 'other'
  mime: string
  bytes: number
  sha256: string
  /** 项目 assets/ 下的相对路径。 */
  path: string
  /** 项目 assets/ 下的缩略图相对路径（可选）。 */
  thumbPath?: string
  title: string
  width?: number
  height?: number
  durationSec?: number
  tags: string[]
  origin?: {
    model?: string
    promptHash?: string
    jobId?: string
    source?: string
  }
  createdAt: number
  /** 签发给渲染层的短期预览地址；不写回项目文件。 */
  url?: string
  thumbUrl?: string
}

export type StudioTrackKind = 'video' | 'dialogue' | 'music' | 'sfx' | 'subtitle'

export interface StudioTrack {
  id: string
  kind: StudioTrackKind
  name: string
  muted: boolean
  locked: boolean
  volume: number
}

export type StudioTransition = 'cut' | 'fade-in' | 'fade-out' | 'fade-both'

export interface StudioClip {
  id: string
  trackId: string
  kind: StudioTrackKind
  label: string
  assetId?: string
  shotId?: string
  /** 时间线起点（秒）。 */
  start: number
  /** 时间线时长（秒）。 */
  duration: number
  /** 素材入点（秒）。 */
  srcIn: number
  speed: number
  volume: number
  transition: StudioTransition
  /** 音乐/环境声可循环铺满片段时长。 */
  loop?: boolean
  text?: string
  style?: {
    yPercent?: number
    size?: number
    color?: string
    background?: boolean
  }
  locked?: boolean
}

export interface StudioTimelineSnapshot {
  id: string
  createdAt: number
  reason: string
  tracks: StudioTrack[]
  clips: StudioClip[]
}

export interface StudioTimeline {
  fps: number
  width: number
  height: number
  aspect: StudioAspect
  durationSec: number
  tracks: StudioTrack[]
  clips: StudioClip[]
  version: number
  updatedAt: number
  snapshots: StudioTimelineSnapshot[]
}

export type StudioJobKind =
  | 'text'
  | 'image'
  | 'video'
  | 'voice'
  | 'music'
  | 'sfx'
  | 'render'
  | 'export'
  | 'review'
  | 'import'

export type StudioJobStatus = 'queued' | 'running' | 'review' | 'done' | 'failed' | 'cancelled'

export interface StudioJobEventEntry {
  at: number
  status: StudioJobStatus
  message: string
  progress: number
}

export interface StudioJob {
  id: string
  requestId: string
  projectId: string
  kind: StudioJobKind
  label: string
  stage: StudioStageId | 'asset'
  status: StudioJobStatus
  progress: number
  message: string
  inputHash: string
  attempts: number
  remoteId?: string
  /** 外部引擎任务与本地目标；断电后按这些任务号对账。 */
  remoteTargets?: Array<{
    remoteId: string
    kind: 'image' | 'video'
    shotId?: string
    chapterId?: string
  }>
  /** 可安全重放的动作与输入快照；不包含密钥。 */
  retry?: { action: string; payload: Record<string, unknown> }
  /** 完整任务消息流；与 jobs.jsonl 同步，界面可回看。 */
  events?: StudioJobEventEntry[]
  /** null = 无法可靠计价，界面必须显示“未知”。 */
  cost: number | null
  costNote?: string
  outputs: Array<{ label: string; path?: string; assetId?: string }>
  error?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
}

export interface StudioDelivery {
  id: string
  kind: 'mp4' | 'mov' | 'mkv' | 'webm' | 'wav' | 'mp3' | 'm4a' | 'flac' | 'comic' | 'srt' | 'ass' | 'epub' | 'pdf' | 'docx' | 'txt' | 'md' | 'package' | 'cover' | 'folder' | 'png'
  label: string
  /** 项目 exports/ 下的相对路径。 */
  path: string
  url?: string
  bytes: number
  sha256: string
  createdAt: number
  meta?: Record<string, string | number | boolean>
}

export interface StudioCheck {
  id: string
  kind: 'continuity' | 'visual' | 'audio' | 'subtitle' | 'missing' | 'price' | 'voice'
  level: 'info' | 'warn' | 'error'
  title: string
  detail: string
  targetId?: string
  createdAt: number
  resolved?: boolean
}

export interface StudioBlueprintUnit {
  index: number
  title: string
  summary: string
  seconds?: number
  wordTarget?: number
  camera?: string
  shotSize?: string
  dialogue?: string
  speaker?: string
}

export interface StudioBlueprint {
  approved: boolean
  approvedAt?: number
  source: 'model' | 'local' | 'import'
  model?: string
  storyCore: string
  emotion: string
  audience: string
  pitch: string
  structure: string
  styleBible: StudioStyleBible
  characters: StudioCharacter[]
  places: StudioPlace[]
  units: StudioBlueprintUnit[]
  estimate: StudioEstimate
  warnings: string[]
  createdAt: number
}

export type StudioActionType =
  | 'set-clip-speed'
  | 'set-clip-volume'
  | 'set-clip-duration'
  | 'set-subtitle-position'
  | 'set-transition'
  | 'set-track-volume'
  | 'rewrite-chapter'
  | 'regenerate-shot-image'
  | 'regenerate-shot-video'
  | 'regenerate-voice'
  | 'lock-reference'
  | 'noop'

export interface StudioEditAction {
  type: StudioActionType
  clipId?: string
  trackId?: string
  chapterId?: string
  shotId?: string
  target?: string
  value?: number
  text?: string
  instruction?: string
  note?: string
}

export interface StudioEditPlan {
  id: string
  title: string
  summary: string
  actions: StudioEditAction[]
  effects: string[]
  estimate: { seconds: number; cost: number | null; note?: string }
  status: 'pending' | 'applied' | 'cancelled' | 'undone'
  createdAt: number
  appliedAt?: number
  appliedRevision?: number
  /** 应用前的项目快照文件名；只在该版本之后没有新修改时可整体撤销。 */
  undoVersion?: string
}

export interface StudioMessageSource {
  kind: 'chapter' | 'shot' | 'clip' | 'facts'
  id: string
  label: string
}

export interface StudioChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: number
  plan?: StudioEditPlan
  sources?: StudioMessageSource[]
}

export interface StudioBudget {
  limit: number
  spent: number
  currency: 'CNY'
}

export interface StudioRuntime {
  strategy: 'local-first' | 'cloud-first' | 'local-only' | 'cloud-only'
  queuePaused?: boolean
  budget: StudioBudget
  textModelNote?: string
  imageModelNote?: string
  videoModelNote?: string
  tts?: {
    mode: 'system' | 'cloud'
    model: string
    voice: string
  }
  updatedAt: number
}

export type StudioCanvasNodeKind = 'shot' | 'image' | 'video' | 'audio' | 'text'

export interface StudioCanvasNode {
  id: string
  kind: StudioCanvasNodeKind
  title: string
  x: number
  y: number
  width: number
  height: number
  z: number
  assetId?: string
  shotId?: string
  text?: string
  createdAt: number
  updatedAt: number
}

export interface StudioCanvasConnection {
  id: string
  fromNodeId: string
  toNodeId: string
  label?: string
}

export interface StudioCanvasViewport {
  x: number
  y: number
  zoom: number
}

export interface StudioCanvasGroup {
  id: string
  title: string
  nodeIds: string[]
  createdAt: number
}

export interface StudioCanvas {
  version: number
  initialized?: boolean
  nodes: StudioCanvasNode[]
  connections: StudioCanvasConnection[]
  groups?: StudioCanvasGroup[]
  viewport: StudioCanvasViewport
  updatedAt: number
}

export interface StudioProject {
  schemaVersion: number
  id: string
  kind: StudioKind
  title: string
  logline: string
  brief: StudioBrief
  createdAt: number
  updatedAt: number
  revision: number
  stage: StudioStageId
  stages: Record<StudioStageId, StudioStageState>
  styleBible: StudioStyleBible
  blueprint: StudioBlueprint | null
  volumes: StudioVolume[]
  chapters: StudioChapter[]
  episodes: StudioEpisode[]
  scenes: StudioScene[]
  shots: StudioShot[]
  characters: StudioCharacter[]
  places: StudioPlace[]
  factions: StudioFaction[]
  rules: StudioRule[]
  props: StudioProp[]
  facts: StudioFact[]
  assets: StudioAsset[]
  timeline: StudioTimeline
  deliveries: StudioDelivery[]
  jobs: StudioJob[]
  messages: StudioChatMessage[]
  checks: StudioCheck[]
  runtime: StudioRuntime
  canvas: StudioCanvas
  voiceAudit?: StudioVoiceAudit | null
  coverAssetId: string | null
  demo: boolean
}

export interface StudioVoiceProfile {
  characterId: string
  name: string
  lineCount: number
  words: number
  avgLine: number
  questionRatio: number
  exclaimRatio: number
  topPhrases: string[]
  addressTerms: string[]
  summary: string
}

export interface StudioVoiceAudit {
  createdAt: number
  profiles: StudioVoiceProfile[]
  unresolved: number
  warnings: Array<{ level: 'info' | 'warn'; title: string; detail: string; characterId?: string }>
}

export interface StudioProjectSummary {
  id: string
  kind: StudioKind
  title: string
  logline: string
  updatedAt: number
  createdAt: number
  stage: StudioStageId
  progress: number
  words: number
  chapters: number
  shots: number
  assets: number
  budget: StudioBudget
  coverUrl?: string
  demo: boolean
  missingVisuals?: number
}

export interface StudioVoice {
  name: string
  culture: string
  gender?: string
}

export interface StudioEngineStatus {
  dataDir: string
  studioDataDir: string
  studioDataDirSource: 'default' | 'custom'
  projectCount: number
  ffmpeg: {
    available: boolean
    path?: string
    version?: string
    message: string
    codecs?: string[]
    profile?: 'default' | 'enhanced' | 'missing'
  }
  media: {
    online: boolean
    imageReady: boolean
    videoReady: boolean
    message: string
    gpu?: string
    vramTotalMb?: number
  }
  text: {
    configured: boolean
    providerId?: string
    providerLabel?: string
    modelId?: string
    modelLabel?: string
    contextWindow?: number
    maxOutput?: number
    supportsVision?: boolean
    supportsTools?: boolean
    supportsReasoning?: boolean
    demo: boolean
    message: string
    routes?: Array<{
      providerId: string
      providerLabel: string
      modelId: string
      modelLabel: string
      local: boolean
      configured: boolean
      inputPerMTok?: number
      outputPerMTok?: number
      contextWindow?: number
      maxOutput?: number
      supportsVision?: boolean
      supportsTools?: boolean
      supportsReasoning?: boolean
    }>
  }
  voices: StudioVoice[]
  voiceError?: string
  version: string
}

export interface StudioListResult {
  projects: StudioProjectSummary[]
  engine: StudioEngineStatus
}

export interface StudioCreateInput {
  kind: StudioKind
  title?: string
  logline: string
  form?: StudioPace
  genre?: string
  audience?: string
  tone?: string
  style?: string
  aspect?: StudioAspect
  constraints?: string[]
  targetWords?: number
  targetSeconds?: number
}

export interface StudioDataDirInfo {
  root: string
  defaultRoot: string
  customRoot: string | null
  source: 'default' | 'custom'
}

export interface StudioDataDirChangeResult {
  restarted: boolean
  path?: string
  canceled?: boolean
  files?: number
}

export interface StudioActionResult {
  project: StudioProject
  job?: StudioJob
  plan?: StudioEditPlan
  message?: string
}

export interface StudioJobEvent {
  type: 'job'
  job: StudioJob
}

export interface StudioProjectEvent {
  type: 'project'
  projectId: string
  summary: StudioProjectSummary
}

export type StudioEvent = StudioJobEvent | StudioProjectEvent

export interface StudioExportFormatStatus {
  format: string
  label: string
  ready: boolean
  note: string
}

export interface StudioExportPreflight {
  platform: string
  fonts: {
    detected: string[]
    serif: boolean
    sans: boolean
    bundledSerif?: boolean
    detail: string
  }
  formats: StudioExportFormatStatus[]
  ffmpeg: {
    available: boolean
    profile?: string
    message: string
  }
  warnings: string[]
}

export interface StudioRenderInput {
  projectId: string
  quality: 'draft' | 'final'
  aspect?: StudioAspect
  subtitleMode?: 'soft' | 'burn'
  allowMissing?: boolean
  format?: 'mp4' | 'mov' | 'mkv' | 'webm'
  resolution?: '1080p' | '2160p'
}

export interface StudioExportInput {
  projectId: string
  format: 'txt' | 'md' | 'epub' | 'pdf' | 'docx' | 'srt' | 'ass' | 'package' | 'cover' | 'folder'
}

export interface StudioGenerateInput {
  projectId: string
  /** 仅部分生成动作使用。 */
  chapterId?: string
  shotId?: string
  sceneId?: string
  candidateCount?: number
  useModel?: boolean
  instruction?: string
  shotIds?: string[]
  kind?: 'music' | 'sfx' | 'rain' | 'umbrella' | 'heartbeat' | 'street'
  mood?: string
  seconds?: number
  voiceId?: string
}

export interface StudioAssistantInput {
  projectId: string
  text: string
  selection?: { kind: 'chapter' | 'shot' | 'clip'; id: string }
}

export interface StudioApplyPlanInput {
  projectId: string
  planId: string
}

export interface StudioActionRequest {
  type:
    | 'status'
    | 'list'
    | 'create'
    | 'get'
    | 'delete'
    | 'duplicate'
    | 'list-versions'
    | 'restore-version'
    | 'update-meta'
    | 'save-chapter'
    | 'add-chapter'
    | 'delete-chapter'
    | 'move-chapter'
    | 'upsert-volume'
    | 'delete-volume'
    | 'move-volume'
    | 'generate-blueprint'
    | 'save-blueprint'
    | 'approve-blueprint'
    | 'generate-outline'
    | 'generate-chapter'
    | 'polish-chapter'
    | 'batch-write'
    | 'generate-chapter-illustration'
    | 'attach-chapter-illustration'
    | 'remove-chapter-illustration'
    | 'adopt-candidate'
    | 'discard-candidate'
    | 'restore-chapter-version'
    | 'upsert-character'
    | 'delete-character'
    | 'upsert-place'
    | 'upsert-fact'
    | 'delete-fact'
    | 'upsert-faction'
    | 'delete-faction'
    | 'upsert-rule'
    | 'delete-rule'
    | 'upsert-prop'
    | 'delete-prop'
    | 'generate-storyboard'
    | 'save-scene'
    | 'save-shot'
    | 'move-shot'
    | 'update-shots'
    | 'build-subtitles'
    | 'generate-shot-image'
    | 'batch-shot-images'
    | 'generate-shot-video'
    | 'adopt-shot-asset'
    | 'generate-voice'
    | 'generate-music'
    | 'build-timeline'
    | 'save-timeline'
    | 'render'
    | 'review'
    | 'visual-check'
    | 'auto-advance'
    | 'export'
    | 'import-asset'
    | 'assistant'
    | 'apply-plan'
    | 'cancel-plan'
    | 'undo-plan'
    | 'cancel-job'
    | 'retry-job'
    | 'reconcile-external'
    | 'export-audio'
    | 'export-comic'
    | 'update-runtime'
    | 'list-jobs'
    | 'set-cover'
    | 'import-shot-asset'
    | 'save-canvas'
    | 'save-canvas-snapshot'
    | 'voice-audit'
    | 'asset-waveform'
    | 'asset-proxy'
    | 'text-routes'
    | 'adapt-to-drama'
    | 'pause-queue'
    | 'resume-queue'
  projectId?: string
  [key: string]: unknown
}

export const STUDIO_STAGE_DEFS: Record<StudioStageId, StudioStageDef> = {
  blueprint: { id: 'blueprint', label: '故事蓝图', short: '蓝图', description: '故事主线、人物、结构、风格与预算' },
  outline: { id: 'outline', label: '大纲与节拍', short: '大纲', description: '章节细纲、剧本节拍与镜头计划' },
  writing: { id: 'writing', label: '正文写作', short: '写作', description: '纸页手稿、候选稿与版本' },
  storyboard: { id: 'storyboard', label: '分镜', short: '分镜', description: '镜头、台词、运镜与连续性' },
  visuals: { id: 'visuals', label: '画面', short: '画面', description: '分镜图、参考锁定与视频升级' },
  voice: { id: 'voice', label: '配音', short: '配音', description: '角色声线、逐句配音与时间码' },
  music: { id: 'music', label: '音乐', short: '音乐', description: '配乐、音效与混音' },
  timeline: { id: 'timeline', label: '时间线', short: '时间线', description: '多轨剪辑、字幕与预览' },
  review: { id: 'review', label: '检查', short: '检查', description: '连续性、视觉、响度与缺失素材' },
  delivery: { id: 'delivery', label: '交付', short: '交付', description: '成片、成书与可继续的工程包' }
}

export function studioStages(kind: StudioKind): StudioStageDef[] {
  const ids: StudioStageId[] =
    kind === 'drama'
      ? ['blueprint', 'outline', 'storyboard', 'visuals', 'voice', 'music', 'timeline', 'review', 'delivery']
      : kind === 'novel'
        ? ['blueprint', 'outline', 'writing', 'visuals', 'review', 'delivery']
        : ['blueprint', 'outline', 'writing', 'review', 'delivery']
  return ids.map((id) => STUDIO_STAGE_DEFS[id])
}

export function studioKindLabel(kind: StudioKind): string {
  return kind === 'short' ? '中短篇' : kind === 'novel' ? '长篇' : '漫剧'
}

export function isStudioVideoDelivery(kind: StudioDelivery['kind']): boolean {
  return kind === 'mp4' || kind === 'mov' || kind === 'mkv' || kind === 'webm'
}

export function studioKindScale(kind: StudioKind): string {
  return kind === 'short' ? '3–8 万字 · 章节 · 情绪曲线' : kind === 'novel' ? '20–100 万字 · 卷章 · 世界图谱' : '30–180 秒 · 分镜 · 配音 · 成片'
}

export function studioStatusLabel(status: StudioStatus): string {
  switch (status) {
    case 'waiting':
      return '等待'
    case 'ready':
      return '就绪'
    case 'running':
      return '进行中'
    case 'review':
      return '待确认'
    case 'done':
      return '完成'
    case 'failed':
      return '失败'
    case 'stale':
      return '过期'
    case 'skipped':
      return '跳过'
  }
}

export function studioJobStatusLabel(status: StudioJobStatus): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '进行中'
    case 'review':
      return '需核对'
    case 'done':
      return '完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
  }
}

export function emptyStageStates(now = Date.now()): Record<StudioStageId, StudioStageState> {
  const states = {} as Record<StudioStageId, StudioStageState>
  for (const id of Object.keys(STUDIO_STAGE_DEFS) as StudioStageId[]) {
    states[id] = { status: 'waiting', updatedAt: now }
  }
  return states
}

export function emptyCanvas(now = Date.now()): StudioCanvas {
  return {
    version: 1,
    initialized: false,
    nodes: [],
    connections: [],
    viewport: { x: 96, y: 72, zoom: 0.8 },
    updatedAt: now
  }
}

export function emptyTimeline(aspect: StudioAspect = '16:9', now = Date.now()): StudioTimeline {
  const size = aspect === '9:16' ? { width: 1080, height: 1920 } : aspect === '1:1' ? { width: 1080, height: 1080 } : { width: 1920, height: 1080 }
  return {
    fps: 30,
    width: size.width,
    height: size.height,
    aspect,
    durationSec: 0,
    version: 1,
    updatedAt: now,
    snapshots: [],
    tracks: [
      { id: 'track-video', kind: 'video', name: '画面', muted: false, locked: false, volume: 1 },
      { id: 'track-dialogue', kind: 'dialogue', name: '对白', muted: false, locked: false, volume: 1 },
      { id: 'track-music', kind: 'music', name: '音乐', muted: false, locked: false, volume: 0.55 },
      { id: 'track-sfx', kind: 'sfx', name: '音效', muted: false, locked: false, volume: 0.7 },
      { id: 'track-subtitle', kind: 'subtitle', name: '字幕', muted: false, locked: false, volume: 1 }
    ],
    clips: []
  }
}

export function countWords(text: string): number {
  const clean = text.replace(/\s+/g, '')
  return clean.length
}

export function formatTimecode(seconds: number, fps = 30): string {
  const clamped = Math.max(0, seconds)
  const whole = Math.floor(clamped)
  const frames = Math.min(fps - 1, Math.floor((clamped - whole) * fps))
  const hh = Math.floor(whole / 3600)
  const mm = Math.floor((whole % 3600) / 60)
  const ss = whole % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 60) return `${whole} 秒`
  const mm = Math.floor(whole / 60)
  const ss = whole % 60
  return ss ? `${mm} 分 ${ss} 秒` : `${mm} 分钟`
}

export function formatWordCount(words: number): string {
  if (words >= 10_000) return `${(words / 10_000).toFixed(1)} 万`
  if (words >= 1000) return `${(words / 1000).toFixed(1)}k`
  return String(words)
}

export function projectWordCount(project: Pick<StudioProject, 'chapters'>): number {
  return project.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0)
}

export function timelineDuration(timeline: Pick<StudioTimeline, 'clips' | 'durationSec'>): number {
  const max = timeline.clips.reduce((value, clip) => Math.max(value, clip.start + clip.duration), 0)
  return Math.max(timeline.durationSec, max)
}

/** 首页/作品库的“进度”是阶段完成度，而不是生成量。 */
export function computeProjectProgress(project: StudioProject): number {
  if (project.kind === 'drama') {
    const shots = project.shots.length
    const visuals = shots ? project.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length / shots : 0
    const voicesNeeded = project.shots.filter((shot) => shot.dialogue.trim()).length
    const voices = voicesNeeded ? project.shots.filter((shot) => shot.voiceAssetId).length / voicesNeeded : 0
    const hasMusic = project.assets.some((asset) => asset.kind === 'audio' && asset.tags.includes('music'))
    const hasTimeline = project.timeline.clips.length > 0
    const hasDelivery = project.deliveries.some((item) => isStudioVideoDelivery(item.kind))
    const weights = [0.18, 0.16, 0.26, 0.14, 0.06, 0.1, 0.1]
    const value = [project.blueprint?.approved ? 1 : 0, shots ? 1 : 0, visuals, voices, hasMusic ? 1 : 0, hasTimeline ? 1 : 0, hasDelivery ? 1 : 0]
    return Math.round(value.reduce((sum, item, index) => sum + item * weights[index], 0) * 100)
  }
  const targets = project.chapters.length
  const written = project.chapters.filter((chapter) => chapter.content.trim().length > 0).length
  const reviewed = project.stages.review.status === 'done' ? 1 : 0
  const delivered = project.deliveries.length > 0 ? 1 : 0
  const base = targets ? written / targets : 0
  return Math.round(Math.min(1, base * 0.75 + reviewed * 0.15 + delivered * 0.1) * 100)
}

export function stageProgress(project: StudioProject, stage: StudioStageId): number | undefined {
  if (stage === 'blueprint') return project.blueprint ? (project.blueprint.approved ? 100 : 55) : 0
  if (stage === 'outline') {
    if (project.kind === 'drama') return project.shots.length ? 100 : project.scenes.length ? 55 : 0
    return project.chapters.length ? Math.round((project.chapters.filter((chapter) => chapter.synopsis.trim()).length / project.chapters.length) * 100) : 0
  }
  if (stage === 'writing') {
    const filled = project.chapters.filter((chapter) => chapter.content.trim()).length
    return project.chapters.length ? Math.round((filled / project.chapters.length) * 100) : 0
  }
  if (stage === 'storyboard') return project.shots.length ? 100 : 0
  if (stage === 'visuals') {
    if (project.kind !== 'drama') return project.assets.some((asset) => asset.kind === 'image') ? 100 : 0
    const total = project.shots.length
    if (!total) return 0
    return Math.round((project.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length / total) * 100)
  }
  if (stage === 'voice') {
    const needed = project.shots.filter((shot) => shot.dialogue.trim()).length
    if (!needed) return 100
    return Math.round((project.shots.filter((shot) => shot.voiceAssetId).length / needed) * 100)
  }
  if (stage === 'music') {
    return project.assets.some((asset) => asset.kind === 'audio' && (asset.tags.includes('music') || asset.tags.includes('sfx'))) ? 100 : 0
  }
  if (stage === 'timeline') return project.timeline.clips.length ? 100 : 0
  if (stage === 'review') {
    const unresolved = project.checks.filter((check) => !check.resolved && check.level !== 'info').length
    return project.checks.length ? Math.max(0, 100 - unresolved * 25) : 0
  }
  if (stage === 'delivery') return project.deliveries.length ? 100 : 0
  return 0
}

export function defaultStageStatuses(project: StudioProject): Record<StudioStageId, StudioStageState> {
  const now = Date.now()
  const stages = emptyStageStates(now)
  for (const def of studioStages(project.kind)) {
    const progress = stageProgress(project, def.id)
    const current = project.stages[def.id]
    const keepStatus =
      current?.status === 'running' ||
      current?.status === 'failed' ||
      current?.status === 'stale' ||
      current?.status === 'review' ||
      current?.status === 'skipped'
    stages[def.id] = {
      status: keepStatus
        ? current?.status ?? 'waiting'
        : typeof progress === 'number' && progress >= 100
          ? 'done'
          : typeof progress === 'number' && progress > 0
            ? 'ready'
            : current?.status ?? 'waiting',
      updatedAt: current?.updatedAt ?? now,
      ...(typeof progress === 'number' ? { progress } : {}),
      ...(current?.message ? { message: current.message } : {})
    }
  }
  return stages
}

export interface StudioAudioLibraryItem {
  id: string
  label: string
  kind: 'music' | 'sfx'
  mood?: string
  sfx?: 'rain' | 'umbrella' | 'heartbeat' | 'street'
  seconds: number
  description: string
}

/** 内置音频素材：全部由本机合成，授权随素材标注。 */
export const STUDIO_AUDIO_LIBRARY: StudioAudioLibraryItem[] = [
  { id: 'bed-rain', label: '雨幕钢琴', kind: 'music', mood: 'rain', seconds: 30, description: '慢速钢琴与雨声，适合雨夜、回忆。' },
  { id: 'bed-wonder', label: '倒流的雨', kind: 'music', mood: 'wonder', seconds: 30, description: '明亮分解和弦，适合发现、时间倒流。' },
  { id: 'bed-release', label: '克制的告别', kind: 'music', mood: 'release', seconds: 30, description: '低音铺底，适合告别与收束。' },
  { id: 'bed-warm', label: '靠近', kind: 'music', mood: 'warm', seconds: 30, description: '温暖和弦，适合关系靠近。' },
  { id: 'bed-tension', label: '暗线', kind: 'music', mood: 'tension', seconds: 30, description: '紧张脉冲，适合悬念与追逐。' },
  { id: 'sfx-rain', label: '雨声', kind: 'sfx', sfx: 'rain', seconds: 8, description: '连续雨幕，可循环铺底。' },
  { id: 'sfx-heartbeat', label: '心跳', kind: 'sfx', sfx: 'heartbeat', seconds: 8, description: '低频心跳，适合压迫感。' },
  { id: 'sfx-umbrella', label: '伞骨', kind: 'sfx', sfx: 'umbrella', seconds: 6, description: '金属开合与细响。' },
  { id: 'sfx-street', label: '街声', kind: 'sfx', sfx: 'street', seconds: 8, description: '远处车流与低频环境声。' }
]

export const STUDIO_AUDIO_LICENSE = 'Morrow 原创合成 · 可商用 · 无需署名'
