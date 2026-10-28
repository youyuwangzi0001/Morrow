// settings 功能域组件：由 5 个 TSX 文件扁平合并。
import './settings.css'
import { useEffect, useRef, useState, useMemo } from 'react'
import { RotateCcw, Check, Copy, Download, ExternalLink, FolderOpen, Play, Plus, RefreshCw, Save, Square, Trash2, ArrowLeft, Boxes, Bot, Brain, Gauge, Globe2, KeyRound, Layers, LoaderCircle, LogIn, Moon, Orbit, Route, ShieldCheck, Sparkles, SquareTerminal, Upload, X, Zap, Activity, AlarmClock, Archive, ArchiveRestore, BadgeCheck, ChevronRight, Clapperboard, Eye, EyeOff, FileText, FolderCog, FolderGit2, FolderKanban, Globe, Info, Keyboard, MessageSquareText, Palette, Plug, Search, Shield } from 'lucide-react'
import { ANSWER_STYLES, ANSWER_STYLE_MAX_CUSTOM } from '@shared/types'
import type { AnswerStyleId, MediaEngineSettings, MediaEngineStatus, Result, TokenActivitySummary, CloseAction, CustomCommandInfo, HookConfig, HookEvent, ModelInfo, PermissionLogEntry, PermissionRule, PermissionRuleDecision, PermissionRuleKind, ProviderCategory, CodeFontId, ProviderConfig, ProviderTestResult, SessionMeta, TerminalShellProfile } from '@shared/types'
import { MAX_ENABLED_HOOKS_PER_EVENT } from '@shared/types'
import { useAppStore } from '../store'
import { Button, Segmented, Switch, Badge, Select, TextArea, TextInput, IconButton, Modal, Shortcut } from '../components'
import type { MediaCatalogAction, MediaCatalogStatus, MediaEngineInfo, MediaModelInfo } from '@shared/studio'
import { formatExactTokens, formatUsageTokens, contextSnapshot, contextSourceLabel, formatModelWindow } from './settings-core'
import { addDays, buildMonthLabels, dayKey, dayLabel, diffDays, parseDay, startOfWeek, formatUsd } from '@shared/types'
import type { AgentQuotaWindow, AgentSubscriptionId, AgentSubscriptionState, CodexSubscriptionQuota, CodexSubscriptionState, CustomSubscriptionInput, CustomSubscriptionRecord, CustomSubscriptionState, QoderSubscriptionQuota, QoderSubscriptionState, SubscriptionAction, SubscriptionProtocol, SubscriptionStatus, SubscriptionTestResult } from '@shared/contracts'
import { errorText } from '../components'
import { findModel, isLocalServiceUrl, reasoningEffortsForModel } from '@shared/contracts'
import { RESERVED_COMMAND_NAMES, SHORTCUT_GROUPS } from '@shared/contracts'
import type { SettingsTabId } from './settings-core'
import { consumeRequestedTab, onSettingsTabRequest } from './settings-core'
import type { WorkbenchPanel } from './workbench-core'
import { openWorkbench } from './workbench-core'
import brandMarkUrl from '../assets/brand-mark-dark.png'

export function AnswerStyleTab(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [custom, setCustom] = useState(settings.answerStyleCustom)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resettingRef = useRef(false)

  useEffect(() => {
    setCustom(settings.answerStyleCustom)
  }, [settings.answerStyleCustom])

  const patch = async (value: Parameters<typeof updateSettings>[0]): Promise<void> => {
    setError(null)
    try {
      await updateSettings(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存设置失败')
    }
  }

  const choose = (id: AnswerStyleId): void => {
    if (id !== settings.answerStyle) void patch({ answerStyle: id })
  }

  const saveCustom = async (): Promise<void> => {
    if (saving || resettingRef.current) return
    setSaving(true)
    setError(null)
    try {
      await updateSettings({ answerStyleCustom: custom })
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存自定义风格失败')
    } finally {
      setSaving(false)
    }
  }

  const reset = async (): Promise<void> => {
    setError(null)
    resettingRef.current = true
    try {
      await updateSettings({ answerStyle: 'balanced', answerStyleCustom: '' })
      setCustom('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复默认失败')
    } finally {
      resettingRef.current = false
    }
  }

  const selected = ANSWER_STYLES.find((style) => style.id === settings.answerStyle) ?? ANSWER_STYLES[0]
  const customDirty = custom !== settings.answerStyleCustom

  return (
    <div className="st-style">
      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">回答风格</span>
          <span className="st-setting-desc">{selected.summary} 对之后所有对话生效。</span>
        </div>
        <Segmented
          ariaLabel="全局回答风格"
          value={settings.answerStyle}
          options={ANSWER_STYLES.map((style) => ({ value: style.id, label: style.label, description: style.summary }))}
          onChange={choose}
        />
      </div>

      {settings.answerStyle === 'custom' ? (
        <div className="st-style-custom">
          <div className="st-style-custom-head">
            <label className="st-field-label" htmlFor="st-answer-style-custom">
              你的偏好
            </label>
            <span className={['st-style-custom-count mono', customDirty ? 'is-dirty' : ''].join(' ')}>
              {custom.length}/{ANSWER_STYLE_MAX_CUSTOM}
              {customDirty ? ' · 未保存' : ''}
            </span>
          </div>
          <textarea
            id="st-answer-style-custom"
            className="st-style-textarea"
            value={custom}
            maxLength={ANSWER_STYLE_MAX_CUSTOM}
            rows={3}
            placeholder="例如：像给同事讲方案一样，先说结论；涉及数字时给出处；不要用客套话。"
            onChange={(event) => setCustom(event.target.value)}
          />
          <div className="st-style-custom-foot">
            <p className="st-hint">留空时按「平衡」风格回答；修改后点「保存偏好」。</p>
            <Button size="sm" variant="primary" onClick={() => void saveCustom()} disabled={!customDirty || saving}>
              {saving ? '保存中…' : '保存偏好'}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">发送键</span>
          <span className="st-setting-desc">选择 Enter 还是 Ctrl+Enter 发送消息。</span>
        </div>
        <Segmented
          ariaLabel="发送键"
          value={settings.sendKey}
          options={[
            { value: 'enter', label: 'Enter' },
            { value: 'ctrl+enter', label: 'Ctrl+Enter' }
          ]}
          onChange={(next) => void patch({ sendKey: next })}
        />
      </div>

      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">运行中发送</span>
          <span className="st-setting-desc">插话会停止当前任务并立即按新内容继续；排队会在本轮结束后发送。闪电按钮始终插话，箭头按钮始终排队。</span>
        </div>
        <Segmented
          ariaLabel="运行中发送方式"
          value={settings.runningSendMode}
          options={[
            { value: 'steer', label: '插话' },
            { value: 'queue', label: '排队' }
          ]}
          onChange={(next) => void patch({ runningSendMode: next })}
        />
      </div>

      <Switch
        checked={settings.autoTitle}
        onChange={(next) => void patch({ autoTitle: next })}
        label="自动命名对话"
        description="用第一条消息给对话起一个短标题"
      />
      <Switch
        checked={settings.notifyOnFinish}
        onChange={(next) => void patch({ notifyOnFinish: next })}
        label="任务完成时通知我"
        description="窗口不在前台时，完成/失败/需要审批会发系统通知。"
      />

      <div className="st-style-foot">
        <span className="mono">当前：{selected.label}</span>
        <button
          type="button"
          className="st-style-reset"
          onClick={() => void reset()}
          disabled={settings.answerStyle === 'balanced' && !settings.answerStyleCustom}
        >
          <RotateCcw size={11} strokeWidth={1.7} aria-hidden />
          恢复默认
        </button>
      </div>

      {error ? <p className="st-error" role="alert">{error}</p> : null}
    </div>
  )
}

const MODEL_LINKS = {
  comfyui: 'https://github.com/comfyanonymous/ComfyUI',
  ffmpeg: 'https://www.gyan.dev/ffmpeg/builds/'
} as const

const IMAGE_PROMPT =
  '电影感特写：一只赤狐站在雪后的松林里，清晨侧逆光，毛发细节清晰，浅景深，16:9 构图'

const EDIT_PROMPT =
  '以 <image1> 为编辑目标，保持狐狸的脸、姿势、毛发和雪林背景、光线不变，只在脖子上加一条红色针织围巾，其他什么都不要改。'

const VIDEO_PROMPT =
  '<Picture 1> 是主体与外观参考。狐狸轻轻眨眼、耳朵转动，镜头缓慢推近；雪粒飘落，晨光从左侧掠过毛发；环境声是轻微的风声和远处的鸟鸣。'

const KIND_LABEL: Record<string, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  multimodal: '多模态'
}

const ENGINE_KIND_LABEL: Record<string, string> = {
  comfyui: 'ComfyUI',
  llamacpp: 'llama.cpp',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  'openai-compat': 'OpenAI 兼容',
  custom: '自定义引擎'
}

const CAPABILITY_LABEL: Record<string, string> = {
  chat: '聊天 / 代码',
  vision: '图片理解',
  'text-to-image': '文生图',
  'image-edit': '图片编辑',
  'text-to-video': '文生视频',
  'image-to-video': '图生视频',
  'first-last-video': '首尾帧视频',
  'text-to-speech': '语音合成',
  'text-to-music': '音乐生成',
  'speech-to-text': '语音识别'
}

interface ModelDraft {
  label: string
  id: string
  engine: string
  kind: string
  capabilities: string[]
  filesText: string
  modelPath: string
  alias: string
  contextWindow: string
  args: string
  target: string
  workflowText: string
  outputNode: string
  outputKind: 'image' | 'video' | 'audio'
  promptNode: string
  promptInput: string
  description: string
}

function defaultModelDraft(engine = 'llamacpp'): ModelDraft {
  return {
    label: '',
    id: '',
    engine,
    kind: 'multimodal',
    capabilities: ['chat'],
    filesText: '',
    modelPath: '',
    alias: '',
    contextWindow: '65536',
    args: '',
    target: '',
    workflowText: '',
    outputNode: '',
    outputKind: 'image',
    promptNode: '',
    promptInput: '',
    description: ''
  }
}

function modelFormEngine(engine: MediaEngineInfo): boolean {
  if (engine.kind === 'llamacpp' || engine.kind === 'ollama' || engine.kind === 'lmstudio') return true
  // ComfyUI 的模型必须有可执行工作流；表单里可以直接粘贴 API 格式 JSON。
  return Boolean(engine.modelDir) && (engine.kind === 'custom' || engine.kind === 'openai-compat' || engine.kind === 'comfyui')
}

function splitArgs(value: string): string[] {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) => part.replace(/^["']|["']$/g, ''))
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function modelActionLabel(model: MediaModelInfo): string {
  if (model.installType === 'provider') return '在模型设置中管理'
  if (!model.installed) return model.engine === 'comfyui' || model.engine === 'llamacpp' ? '下载并安装' : '下载模型'
  return '删除模型文件'
}

export function MediaTab(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const copyText = useAppStore((s) => s.copyText)
  const openExternal = useAppStore((s) => s.openExternal)
  const [url, setUrl] = useState(settings.mediaEngine.comfyuiUrl)
  const [dir, setDir] = useState(settings.mediaEngine.comfyuiDir ?? '')
  const [ffmpegPath, setFfmpegPath] = useState(settings.mediaEngine.ffmpegPath ?? '')
  const [enabled, setEnabled] = useState(settings.mediaEngine.enabled)
  const [autoStart, setAutoStart] = useState(settings.mediaEngine.autoStart)
  const [status, setStatus] = useState<MediaEngineStatus | null>(null)
  const [catalog, setCatalog] = useState<MediaCatalogStatus | null>(null)
  const [busy, setBusy] = useState<'save' | 'refresh' | 'start' | 'catalog' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [modelFormOpen, setModelFormOpen] = useState(false)
  const [modelDraft, setModelDraft] = useState<ModelDraft>(defaultModelDraft())
  const [modelFormError, setModelFormError] = useState<string | null>(null)
  const [pickingFiles, setPickingFiles] = useState(false)

  useEffect(() => {
    setUrl(settings.mediaEngine.comfyuiUrl)
    setDir(settings.mediaEngine.comfyuiDir ?? '')
    setFfmpegPath(settings.mediaEngine.ffmpegPath ?? '')
    setEnabled(settings.mediaEngine.enabled)
    setAutoStart(settings.mediaEngine.autoStart)
  }, [settings.mediaEngine])

  // 老数据目录可能没有保存 ComfyUI 路径，但本机已经装好；检测结果只回填空输入框，不覆盖用户输入。
  useEffect(() => {
    if (!dir && status?.comfyuiDir) setDir(status.comfyuiDir)
  }, [dir, status?.comfyuiDir])

  const refresh = async (): Promise<void> => {
    setBusy('refresh')
    setError(null)
    try {
      const [engineResult, catalogResult] = await Promise.all([
        window.morrow.features.invoke('feature:media:status') as Promise<Result<MediaEngineStatus>>,
        window.morrow.features.invoke('feature:media:catalog') as Promise<Result<MediaCatalogStatus>>
      ])
      if (!engineResult.ok) throw new Error(engineResult.error.message)
      setStatus(engineResult.data)
      if (catalogResult.ok) setCatalog(catalogResult.data)
      else throw new Error(catalogResult.error.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : '检查本机引擎失败。')
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    void refresh()
    // 只在打开设置时检测一次，不跟随输入实时请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentConfig = (): MediaEngineSettings => ({
    ...settings.mediaEngine,
    comfyuiUrl: url.trim(),
    comfyuiDir: dir.trim() ? dir.trim() : null,
    ffmpegPath: ffmpegPath.trim() ? ffmpegPath.trim() : null,
    enabled,
    autoStart
  })

  const save = async (thenStart = false): Promise<void> => {
    setBusy(thenStart ? 'start' : 'save')
    setError(null)
    setFlash(null)
    try {
      if (!url.trim()) throw new Error('请填写 ComfyUI 服务地址。')
      await updateSettings({ mediaEngine: currentConfig() })
      if (thenStart) {
        setFlash('正在启动 ComfyUI，首次加载可能需要 1–2 分钟…')
        const result = (await window.morrow.features.invoke('feature:media:start')) as Result<MediaEngineStatus>
        if (!result.ok) throw new Error(result.error.message)
        setStatus(result.data)
        setFlash('ComfyUI 已启动，可以开始生成图片和视频。')
      } else {
        const result = (await window.morrow.features.invoke('feature:media:status')) as Result<MediaEngineStatus>
        if (!result.ok) throw new Error(result.error.message)
        setStatus(result.data)
        setFlash('多媒体设置已保存。')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存多媒体设置失败。')
    } finally {
      setBusy(null)
    }
  }

  const pick = async (kind: 'dir' | 'ffmpeg'): Promise<void> => {
    try {
      const result = (await window.morrow.features.invoke('feature:media:pick', { kind })) as Result<string | null>
      if (!result.ok) throw new Error(result.error.message)
      if (!result.data) return
      if (kind === 'dir') setDir(result.data)
      else setFfmpegPath(result.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '选择路径失败。')
    }
  }

  const catalogAction = async (
    action: MediaCatalogAction['action'],
    id?: string,
    manifest?: Record<string, unknown>,
    confirmText?: string,
    modelId?: string
  ): Promise<boolean> => {
    if (confirmText && !window.confirm(confirmText)) return false
    setBusy('catalog')
    setError(null)
    setFlash(null)
    try {
      const result = (await window.morrow.features.invoke('feature:media:catalog-action', {
        action,
        ...(id ? { id } : {}),
        ...(modelId ? { modelId } : {}),
        ...(manifest ? { manifest } : {})
      })) as Result<MediaCatalogStatus>
      if (!result.ok) throw new Error(result.error.message)
      setCatalog(result.data)
      setFlash('操作已完成，状态已刷新。')
      await useAppStore.getState().refreshSettings()
      const engineResult = (await window.morrow.features.invoke('feature:media:status')) as Result<MediaEngineStatus>
      if (engineResult.ok) setStatus(engineResult.data)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败。')
      return false
    } finally {
      setBusy(null)
    }
  }

  // 语言/多模态引擎优先；ComfyUI 需要工作流，放在最后但不再被排除。
  const formEngines = (catalog?.engines ?? [])
    .filter(modelFormEngine)
    .sort((a, b) => Number(a.kind === 'comfyui') - Number(b.kind === 'comfyui'))
  const formEngine = formEngines.find((engine) => engine.id === modelDraft.engine) ?? formEngines[0]
  const formUsesFiles = formEngine?.kind === 'llamacpp'
    || (formEngine?.kind !== 'ollama' && formEngine?.kind !== 'lmstudio' && Boolean(formEngine?.modelDir))

  const patchDraft = (patch: Partial<ModelDraft>): void => {
    setModelDraft((current) => ({ ...current, ...patch }))
  }

  const openModelForm = (): void => {
    setModelFormError(null)
    setError(null)
    setFlash(null)
    const engine = formEngines[0]
    const draft = defaultModelDraft(engine?.id ?? 'llamacpp')
    setModelDraft(
      engine?.kind === 'comfyui'
        ? { ...draft, kind: 'image', outputKind: 'image', capabilities: ['text-to-image'] }
        : draft
    )
    setModelFormOpen(true)
  }

  const changeFormEngine = (id: string): void => {
    const engine = formEngines.find((item) => item.id === id)
    setModelDraft((current) => ({
      ...current,
      engine: id,
      kind:
        engine?.kind === 'comfyui'
          ? current.outputKind
          : engine?.kind === 'llamacpp'
            ? 'multimodal'
            : current.kind,
      ...(engine?.kind === 'comfyui' ? { capabilities: ['text-to-image'] } : {})
    }))
  }
  const isComfyForm = formEngine?.kind === 'comfyui'

  const toggleCapability = (capability: string): void => {
    setModelDraft((current) => ({
      ...current,
      capabilities: current.capabilities.includes(capability)
        ? current.capabilities.filter((item) => item !== capability)
        : [...current.capabilities, capability]
    }))
  }

  const pickModelFiles = async (): Promise<void> => {
    setPickingFiles(true)
    setModelFormError(null)
    try {
      const result = (await window.morrow.features.invoke('feature:media:pick-files', {
        title: '选择本机模型文件'
      })) as Result<string[]>
      if (!result.ok) throw new Error(result.error.message)
      if (result.data.length === 0) return
      const existing = modelDraft.filesText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const next = [...new Set([...existing, ...result.data])]
      patchDraft({ filesText: next.join('\n') })
    } catch (err) {
      setModelFormError(err instanceof Error ? err.message : '选择文件失败。')
    } finally {
      setPickingFiles(false)
    }
  }

  const openModelDir = async (): Promise<void> => {
    if (!formEngine) return
    setModelFormError(null)
    try {
      const result = (await window.morrow.features.invoke('feature:media:open-model-dir', {
        engineId: formEngine.id
      })) as Result<string>
      if (!result.ok) throw new Error(result.error.message)
    } catch (err) {
      setModelFormError(err instanceof Error ? err.message : '打开模型目录失败。')
    }
  }

  const saveModelDraft = async (): Promise<void> => {
    if (!formEngine) {
      setModelFormError('请先配置一个本地引擎（ComfyUI / llama.cpp / Ollama / LM Studio）。')
      return
    }
    setModelFormError(null)
    const label = modelDraft.label.trim()
    if (!label) {
      setModelFormError('请填写模型名称。')
      return
    }
    const id = (modelDraft.id.trim() || slugify(label) || `model-${Date.now().toString(36)}`).toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) {
      setModelFormError('模型 ID 需为 2–64 位字母、数字、点、下划线或连字符。')
      return
    }
    if (modelDraft.capabilities.length === 0) {
      setModelFormError('请至少选择一种能力。')
      return
    }
    const contextWindow = modelDraft.contextWindow.trim() ? Number(modelDraft.contextWindow) : undefined
    if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow <= 0)) {
      setModelFormError('上下文窗口必须为正整数。')
      return
    }
    const isComfy = formEngine.kind === 'comfyui'
    let comfyWorkflow: Record<string, unknown> | undefined
    if (isComfy) {
      if (!modelDraft.workflowText.trim()) {
        setModelFormError('请粘贴 ComfyUI 的 API 格式工作流 JSON。')
        return
      }
      let parsed: Record<string, unknown>
      try {
        const raw = JSON.parse(modelDraft.workflowText) as unknown
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
        parsed = raw as Record<string, unknown>
      } catch {
        setModelFormError('工作流不是合法 JSON。请在 ComfyUI 里用「保存（API 格式）」导出后粘贴。')
        return
      }
      const nested = parsed.comfy && typeof parsed.comfy === 'object' && !Array.isArray(parsed.comfy)
        ? (parsed.comfy as Record<string, unknown>).workflow
        : undefined
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        comfyWorkflow = nested as Record<string, unknown>
      } else {
        const graph = parsed.graph && typeof parsed.graph === 'object' && !Array.isArray(parsed.graph)
          ? (parsed.graph as Record<string, unknown>)
          : parsed
        const outputNode =
          modelDraft.outputNode.trim() ||
          (typeof parsed.outputNode === 'string' ? parsed.outputNode.trim() : '')
        if (!outputNode) {
          setModelFormError('请填写输出节点 ID（工作流里负责保存图片/视频的节点，例如 save）。')
          return
        }
        if (!graph[outputNode] || typeof graph[outputNode] !== 'object') {
          setModelFormError(`工作流里找不到输出节点「${outputNode}」。请检查节点 ID。`)
          return
        }
        const outputKind =
          modelDraft.outputKind ||
          (parsed.outputKind === 'image' || parsed.outputKind === 'video' || parsed.outputKind === 'audio'
            ? parsed.outputKind
            : 'image')
        const bindings =
          parsed.bindings && typeof parsed.bindings === 'object' && !Array.isArray(parsed.bindings)
            ? { ...(parsed.bindings as Record<string, unknown>) }
            : {}
        if (modelDraft.promptNode.trim() && modelDraft.promptInput.trim()) {
          bindings.prompt = { node: modelDraft.promptNode.trim(), input: modelDraft.promptInput.trim() }
        }
        comfyWorkflow = { graph, bindings, outputNode, outputKind }
      }
    }
    setBusy('catalog')
    try {
      let files: Array<{ dest: string; bytes: number }> = []
      if (formUsesFiles) {
        const paths = modelDraft.filesText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        if (paths.length === 0 && !isComfy) throw new Error('请选择至少一个模型文件。')
        if (paths.length > 0) {
          const resolved = (await window.morrow.features.invoke('feature:media:resolve-model-files', {
            engineId: formEngine.id,
            paths
          })) as Result<Array<{ path: string; dest: string; size: number; copied: boolean }>>
          if (!resolved.ok) throw new Error(resolved.error.message)
          files = resolved.data.map((file) => ({ dest: file.dest, bytes: file.size }))
          if (resolved.data.some((file) => file.copied)) {
            setFlash('模型文件已复制到引擎模型目录。')
          }
        }
      } else if (!modelDraft.target.trim()) {
        throw new Error('请填写引擎内的模型 ID（例如 qwen2.5vl:7b）。')
      }
      const args = splitArgs(modelDraft.args)
      const install = formUsesFiles
        ? {
            type: 'files' as const,
            files,
            ...(isComfy ? {} : { modelPath: modelDraft.modelPath.trim() || files[0]?.dest }),
            ...(modelDraft.alias.trim() ? { alias: modelDraft.alias.trim() } : {}),
            ...(contextWindow ? { contextWindow } : {}),
            ...(args.length > 0 ? { args } : {})
          }
        : {
            type: formEngine.kind === 'ollama' ? 'ollama' as const : formEngine.kind === 'lmstudio' ? 'lmstudio' as const : 'files' as const,
            target: modelDraft.target.trim(),
            ...(contextWindow ? { contextWindow } : {})
          }
      const manifest: Record<string, unknown> = {
        id,
        label,
        engine: formEngine.id,
        kind: isComfy ? modelDraft.outputKind : modelDraft.kind,
        capabilities: modelDraft.capabilities,
        source: 'user',
        install,
        ...(comfyWorkflow ? { comfy: { workflow: comfyWorkflow } } : {}),
        ...(modelDraft.description.trim() ? { description: modelDraft.description.trim() } : {})
      }
      const ok = await catalogAction('register-model', undefined, manifest)
      if (ok) {
        setFlash(`已添加「${label}」。Ollama / LM Studio 模型请先在引擎中拉取；模型文件会自动复制到引擎目录。`)
        setModelFormOpen(false)
      }
    } catch (err) {
      setModelFormError(err instanceof Error ? err.message : '保存模型失败。')
    } finally {
      setBusy(null)
    }
  }

  const startModel = async (modelId: string): Promise<void> => {
    await catalogAction('start-engine', 'llamacpp', undefined, undefined, modelId)
  }

  const importManifest = async (kind: 'model' | 'engine'): Promise<void> => {
    setError(null)
    setFlash(null)
    try {
      const picked = (await window.morrow.features.invoke('feature:media:pick-manifest', { kind })) as Result<{
        kind: 'model' | 'engine'
        manifest: Record<string, unknown>
      } | null>
      if (!picked.ok) throw new Error(picked.error.message)
      if (!picked.data) return
      await catalogAction(kind === 'model' ? 'register-model' : 'register-engine', undefined, picked.data.manifest)
      setFlash(kind === 'model' ? '模型清单已导入。' : '引擎清单已导入。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入清单失败。')
    }
  }

  const engineOnline = status?.engine.online === true
  const nativeEngines = catalog?.engines.filter((engine) => engine.kind !== 'comfyui') ?? []
  const engineLabel = (id: string): string =>
    catalog?.engines.find((engine) => engine.id === id)?.label ?? id

  return (
    <div className="st-media">
      <div className="st-media-intro">
        <div className="st-media-intro-head">
          <span className="st-section-title">本机引擎</span>
          <Badge tone={engineOnline ? 'success' : 'warning'}>{engineOnline ? '已连接' : '未连接'}</Badge>
        </div>
        <p className="st-hint">
          Morrow 不自带图片、视频或音频模型。这里连接你电脑上的 ComfyUI、llama.cpp 等引擎；模型文件只保存在你的电脑上。Qwen / MiniMax 等只是预设，可以随时换。
        </p>
      </div>

      <section className="st-media-card">
        <div className="st-media-card-head">
          <span className="st-media-card-title">ComfyUI</span>
          <span className={['st-media-dot', engineOnline ? 'is-on' : ''].filter(Boolean).join(' ')} aria-hidden />
          <span className="st-media-status mono">
            {status?.engine.version ? `v${status.engine.version}` : engineOnline ? '运行中' : '离线'}
          </span>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} strokeWidth={1.6} />} loading={busy === 'refresh'} onClick={() => void refresh()}>
            检查连接
          </Button>
        </div>
        <div className="st-media-fields">
          <TextInput
            label="服务地址"
            value={url}
            mono
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://127.0.0.1:8188"
            spellCheck={false}
          />
          <div className="st-media-dir-field">
            <TextInput
              label="ComfyUI 文件夹"
              value={dir}
              mono
              onChange={(event) => setDir(event.target.value)}
              placeholder="例如 C:/AI/ComfyUI"
              spellCheck={false}
            />
            <Button size="sm" variant="secondary" icon={<FolderOpen size={12} strokeWidth={1.6} />} onClick={() => void pick('dir')}>
              选择
            </Button>
          </div>
          <p className="st-media-field-hint">选择里面有 main.py 的 ComfyUI 文件夹；装在常见位置时会自动填入。</p>
        </div>
        <div className="st-media-switches">
          <Switch checked={enabled} onChange={setEnabled} label="允许生成和剪辑多媒体内容" description="关闭后 Morrow 不会调用多媒体工具。" />
          <Switch checked={autoStart} onChange={setAutoStart} label="没打开时自动启动" description="只对本机地址有效；远程 ComfyUI 需要你先打开。" />
        </div>
        <div className="st-media-actions">
          <Button variant="primary" icon={<Save size={13} strokeWidth={1.6} />} loading={busy === 'save'} onClick={() => void save(false)}>
            保存并检查
          </Button>
          <Button
            variant="secondary"
            icon={<Play size={13} strokeWidth={1.6} />}
            loading={busy === 'start'}
            disabled={!status?.canStart}
            onClick={() => void save(true)}
          >
            打开 ComfyUI
          </Button>
          <span className="st-media-engine-hint">{status?.engine.message ?? '正在检查引擎…'}</span>
        </div>
        {status?.engine.gpu ? (
          <p className="st-media-engine-meta mono">
            {status.engine.gpu}
            {status.engine.vramFreeMb ? ` · 可用显存约 ${(status.engine.vramFreeMb / 1024).toFixed(1)} GB` : ''}
          </p>
        ) : null}
      </section>

      <section className="st-media-card">
        <div className="st-media-card-head">
          <span className="st-media-card-title">本地引擎</span>
          <Badge tone={nativeEngines.some((engine) => engine.running) ? 'success' : 'neutral'}>
            {nativeEngines.filter((engine) => engine.running).length} 个运行中
          </Badge>
          <Button size="sm" variant="ghost" icon={<Plus size={12} strokeWidth={1.6} />} onClick={() => void importManifest('engine')}>
            导入引擎
          </Button>
        </div>
        {nativeEngines.map((engine) => (
          <div className="st-media-model" key={engine.id}>
            <div className="st-media-model-head">
              <span className="st-media-model-title">{engine.label}</span>
              <Badge tone={engine.running ? 'success' : engine.detected ? 'neutral' : 'warning'}>
                {engine.running ? '运行中' : engine.detected ? '已安装' : '未安装'}
              </Badge>
              <span className="st-media-source">{ENGINE_KIND_LABEL[engine.kind] ?? engine.kind}</span>
            </div>
            <p className="st-media-model-line">
              {engine.version ?? engine.message}
              {engine.modelDir ? <span className="mono"> · {engine.modelDir}</span> : null}
            </p>
            <div className="st-media-model-actions">
              {!engine.detected && engine.installable ? (
                <button
                  type="button"
                  disabled={busy === 'catalog'}
                  onClick={() => void catalogAction('install-engine', engine.id, undefined, `将执行引擎安装命令/安装包：${engine.label}。继续？`)}
                >
                  <Download size={11} strokeWidth={1.6} aria-hidden />
                  安装引擎
                </button>
              ) : null}
              {engine.canStart && !engine.running ? (
                <button type="button" disabled={busy === 'catalog'} onClick={() => void catalogAction('start-engine', engine.id)}>
                  <Play size={11} strokeWidth={1.6} aria-hidden />
                  启动
                </button>
              ) : null}
              {engine.running && engine.canStop ? (
                <button type="button" disabled={busy === 'catalog'} onClick={() => void catalogAction('stop-engine', engine.id, undefined, `停止 ${engine.label}？正在运行的任务会中断。`)}>
                  <Square size={11} strokeWidth={1.6} aria-hidden />
                  停止
                </button>
              ) : null}
              {engine.homepage ? (
                <button type="button" title={engine.homepage} onClick={() => void openExternal(engine.homepage!)}>
                  <ExternalLink size={11} strokeWidth={1.6} aria-hidden />
                  引擎主页
                </button>
              ) : null}
              {engine.source === 'user' ? (
                <button type="button" disabled={busy === 'catalog'} onClick={() => void catalogAction('remove-engine', engine.id, undefined, `移除引擎清单 ${engine.label}？不会删除已安装的文件。`)}>
                  <Trash2 size={11} strokeWidth={1.6} aria-hidden />
                  移除清单
                </button>
              ) : null}
            </div>
          </div>
        ))}
        <p className="st-media-note">
          ComfyUI、llama.cpp、Ollama、LM Studio 的模型都在这里统一安装和管理；也可以导入自己的清单，不需要改代码。
        </p>
      </section>

      <section className="st-media-card">
        <div className="st-media-card-head">
          <span className="st-media-card-title">模型</span>
          <Badge tone={catalog?.models.some((model) => !model.installed) ? 'warning' : 'success'}>
            {catalog ? `${catalog.models.filter((model) => model.installed).length}/${catalog.models.length} 已安装` : '读取中'}
          </Badge>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={12} strokeWidth={1.6} />}
            disabled={formEngines.length === 0}
            onClick={openModelForm}
          >
            添加本机模型
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void importManifest('model')}>
            导入模型 JSON
          </Button>
        </div>
        {formEngines.length === 0 ? (
          <p className="st-hint">
            还没有可用于表单的引擎：先在上方填写 ComfyUI 文件夹，或安装 llama.cpp / Ollama / LM Studio；也可以直接导入模型 JSON。
          </p>
        ) : null}
        {modelFormOpen ? (
          <div className="st-media-model-form" aria-label="添加本机模型">
            <div className="st-media-model-form-head">
              <span className="st-media-card-title">添加本机模型</span>
              <Badge tone="gold">应用内配置</Badge>
              <Button size="sm" variant="ghost" onClick={() => setModelFormOpen(false)}>取消</Button>
            </div>
            <div className="st-media-form-grid">
              <TextInput
                label="模型名称"
                value={modelDraft.label}
                onChange={(event) => patchDraft({ label: event.target.value })}
                placeholder="例如 Qwen3.8-27B 本地"
              />
              <TextInput
                label="模型 ID（可选）"
                value={modelDraft.id}
                onChange={(event) => patchDraft({ id: event.target.value })}
                placeholder={modelDraft.label ? slugify(modelDraft.label) : '留空自动生成'}
                mono
              />
              <div className="field">
                <span className="field-label">引擎</span>
                <Select
                  ariaLabel="模型引擎"
                  value={formEngine?.id ?? null}
                  options={formEngines.map((engine) => ({ value: engine.id, label: engine.label }))}
                  onChange={changeFormEngine}
                />
              </div>
              {isComfyForm ? null : (
                <div className="field">
                  <span className="field-label">模型类型</span>
                  <Select
                    ariaLabel="模型类型"
                    value={modelDraft.kind}
                    options={[
                      { value: 'multimodal', label: '多模态' },
                      { value: 'image', label: '图片' },
                      { value: 'video', label: '视频' },
                      { value: 'audio', label: '音频' }
                    ]}
                    onChange={(value) => patchDraft({ kind: value })}
                  />
                </div>
              )}
            </div>
            {isComfyForm ? (
              <div className="st-media-form-block">
                <TextArea
                  label="ComfyUI 工作流 JSON（API 格式）"
                  value={modelDraft.workflowText}
                  onChange={(event) => patchDraft({ workflowText: event.target.value })}
                  rows={6}
                  className="mono"
                  placeholder={'{\n  "3": { "class_type": "KSampler", "inputs": { ... } },\n  "9": { "class_type": "SaveImage", "inputs": { ... } }\n}'}
                  hint="在 ComfyUI 里用「保存（API 格式）」导出工作流，或粘贴包含 graph / bindings / outputNode / outputKind 的完整清单。"
                />
                <div className="st-media-form-grid">
                  <TextInput
                    label="输出节点 ID"
                    value={modelDraft.outputNode}
                    onChange={(event) => patchDraft({ outputNode: event.target.value })}
                    placeholder="例如 9 / save"
                    mono
                  />
                  <div className="field">
                    <span className="field-label">输出类型</span>
                    <Select
                      ariaLabel="ComfyUI 输出类型"
                      value={modelDraft.outputKind}
                      options={[
                        { value: 'image', label: '图片' },
                        { value: 'video', label: '视频' },
                        { value: 'audio', label: '音频' }
                      ]}
                      onChange={(value) => patchDraft({ outputKind: value, kind: value })}
                    />
                  </div>
                  <TextInput
                    label="提示词节点 ID（可选）"
                    value={modelDraft.promptNode}
                    onChange={(event) => patchDraft({ promptNode: event.target.value })}
                    placeholder="例如 6"
                    mono
                  />
                  <TextInput
                    label="提示词输入名（可选）"
                    value={modelDraft.promptInput}
                    onChange={(event) => patchDraft({ promptInput: event.target.value })}
                    placeholder="text"
                    mono
                  />
                </div>
                <p className="st-hint">填写提示词节点后，对话里的描述会写进该节点；不填则使用工作流里的默认提示词。</p>
              </div>
            ) : null}
            <div className="st-media-form-block">
              <span className="field-label">能力</span>
              <div className="st-media-check-row">
                {Object.entries(CAPABILITY_LABEL).map(([value, label]) => (
                  <label className="st-media-check" key={value}>
                    <input
                      type="checkbox"
                      checked={modelDraft.capabilities.includes(value)}
                      onChange={() => toggleCapability(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            {formUsesFiles ? (
              <>
                <TextArea
                  label="模型文件（每行一个绝对路径）"
                  value={modelDraft.filesText}
                  onChange={(event) => patchDraft({ filesText: event.target.value })}
                  rows={3}
                  className="mono"
                  placeholder={formEngine?.modelDir ? `${formEngine.modelDir}\\qwen38-27b\\model.gguf` : '先配置引擎模型目录'}
                  hint={
                    formEngine?.modelDir
                      ? `选择模型目录外的文件会自动复制进去：${formEngine.modelDir}`
                      : '这个引擎还没有模型目录，请先在下方配置。'
                  }
                />
                <div className="st-media-form-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<FolderOpen size={12} strokeWidth={1.6} />}
                    loading={pickingFiles}
                    onClick={() => void pickModelFiles()}
                  >
                    选择文件
                  </Button>
                  {formEngine?.modelDir ? (
                    <Button size="sm" variant="ghost" onClick={() => void openModelDir()}>打开模型目录</Button>
                  ) : null}
                </div>
                <div className="st-media-form-grid">
                  <TextInput
                    label="主模型文件（相对路径）"
                    value={modelDraft.modelPath}
                    onChange={(event) => patchDraft({ modelPath: event.target.value })}
                    placeholder="留空则使用第一个文件"
                    mono
                  />
                  <TextInput
                    label="别名（可选）"
                    value={modelDraft.alias}
                    onChange={(event) => patchDraft({ alias: event.target.value })}
                    placeholder="llama-server --alias"
                  />
                  <TextInput
                    label="上下文窗口"
                    value={modelDraft.contextWindow}
                    onChange={(event) => patchDraft({ contextWindow: event.target.value })}
                    inputMode="numeric"
                    placeholder="65536"
                  />
                  <TextInput
                    label="启动参数（可选）"
                    value={modelDraft.args}
                    onChange={(event) => patchDraft({ args: event.target.value })}
                    placeholder="--ngl 99 --jinja"
                    mono
                  />
                </div>
              </>
            ) : (
              <TextInput
                label="引擎内模型 ID"
                value={modelDraft.target}
                onChange={(event) => patchDraft({ target: event.target.value })}
                placeholder={formEngine?.kind === 'ollama' ? '例如 qwen2.5vl:7b' : '例如 lmstudio 模型 key'}
                hint={formEngine?.kind === 'ollama' ? '保存后可点安装，由 Ollama 拉取模型。' : '保存后由 LM Studio 管理模型文件。'}
              />
            )}
            <TextInput
              label="说明（可选）"
              value={modelDraft.description}
              onChange={(event) => patchDraft({ description: event.target.value })}
              placeholder="这个模型适合做什么？"
            />
            <div className="st-media-form-actions">
              <Button variant="primary" size="sm" loading={busy === 'catalog'} onClick={() => void saveModelDraft()}>
                保存模型
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setModelFormOpen(false)}>取消</Button>
            </div>
            {modelFormError ? <p className="st-media-form-error" role="alert">{modelFormError}</p> : null}
            <p className="st-media-form-note">
              保存后会立即出现在下方列表；Ollama / LM Studio 需要在引擎中拉取，ComfyUI 会使用这里粘贴的 API 工作流。
            </p>
          </div>
        ) : null}
        {catalog?.models.map((model) => (
          <div className="st-media-model" key={model.id}>
            <div className="st-media-model-head">
              <span className="st-media-model-title">{model.label}</span>
              <Badge tone={model.installed ? 'success' : 'neutral'}>{model.installed ? '已安装' : '未安装'}</Badge>
              <span className="st-media-source">
                {engineLabel(model.engine)} · {KIND_LABEL[model.kind] ?? model.kind}
                {model.source === 'user' ? ' · 自定义' : ' · 内置预设'}
              </span>
            </div>
            <p className="st-media-model-line">{model.message}</p>
            {model.installedFiles.length > 0 ? (
              <p className="st-media-model-line mono">
                <Check size={11} strokeWidth={1.8} aria-hidden /> {model.installedFiles.join(' · ')}
              </p>
            ) : null}
            {model.missing.length > 0 ? (
              <p className="st-media-model-missing">
                缺少：
                {model.missing.map((file) => (
                  <code key={file}>{file}</code>
                ))}
              </p>
            ) : null}
            <div className="st-media-model-actions">
              {!model.installed && model.installType !== 'provider' ? (
                <button
                  type="button"
                  disabled={busy === 'catalog'}
                  onClick={() => void catalogAction('install-model', model.id, undefined, `下载模型「${model.label}」？可能要几十 GB，并需要较长时间。`)}
                >
                  <Download size={11} strokeWidth={1.6} aria-hidden />
                  {modelActionLabel(model)}
                </button>
              ) : null}
              {model.installed && model.installType !== 'provider' ? (
                <button
                  type="button"
                  disabled={busy === 'catalog'}
                  onClick={() => void catalogAction('uninstall-model', model.id, undefined, `移除「${model.label}」？只删除这个模型的文件；正在使用它的任务会中断。`)}
                >
                  <Trash2 size={11} strokeWidth={1.6} aria-hidden />
                  卸载文件
                </button>
              ) : null}
              {model.engine === 'llamacpp' && model.installed && model.installType === 'files' ? (
                <button
                  type="button"
                  disabled={busy === 'catalog' || Boolean(catalog?.engines.find((engine) => engine.id === 'llamacpp')?.running)}
                  onClick={() => void startModel(model.id)}
                  title={catalog?.engines.find((engine) => engine.id === 'llamacpp')?.running ? '已有 llama.cpp 模型运行中；先停止再切换' : '用这个模型启动 llama-server'}
                >
                  <Play size={11} strokeWidth={1.6} aria-hidden />
                  启动此模型
                </button>
              ) : null}
              {model.installType === 'provider' ? (
                <span className="st-media-note-inline">在「设置 → 模型」里管理</span>
              ) : null}
              {model.homepage ? (
                <button type="button" title={model.homepage} onClick={() => void openExternal(model.homepage!)}>
                  <ExternalLink size={11} strokeWidth={1.6} aria-hidden />
                  模型主页
                </button>
              ) : null}
              {model.source === 'user' ? (
                <button type="button" disabled={busy === 'catalog'} onClick={() => void catalogAction('remove-model', model.id, undefined, `移除模型清单「${model.label}」？不会自动删除已下载的文件。`)}>
                  <Trash2 size={11} strokeWidth={1.6} aria-hidden />
                  移除清单
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {!catalog ? <p className="st-hint">正在读取模型目录…</p> : null}
        <p className="st-media-note">
          下载支持断点续传和大小校验；Ollama/LM Studio 使用它们自己的命令下载。模型文件只会保存在你指定的模型目录里。
        </p>
      </section>

      <section className="st-media-card">
        <div className="st-media-card-head">
          <span className="st-media-card-title">ffmpeg（剪辑）</span>
          <Badge tone={status?.ffmpeg.available ? 'success' : 'warning'}>
            {status?.ffmpeg.available ? '可用' : '未找到'}
          </Badge>
        </div>
        <div className="st-media-fields">
          <div className="st-media-dir-field">
            <TextInput
              label="ffmpeg 路径（可选）"
              value={ffmpegPath}
              mono
              onChange={(event) => setFfmpegPath(event.target.value)}
              placeholder="留空会自动查找"
              spellCheck={false}
            />
            <Button size="sm" variant="secondary" icon={<FolderOpen size={12} strokeWidth={1.6} />} onClick={() => void pick('ffmpeg')}>
              选择
            </Button>
          </div>
          <p className="st-media-field-hint mono">{status?.ffmpeg.version ?? status?.ffmpeg.message ?? '用于裁剪、变速、提取音频和视频封面。'}</p>
        </div>
        <p className="st-media-note">
          图片和视频生成不依赖 ffmpeg；只有剪辑、转 GIF 和视频封面需要它。
          <button type="button" className="st-media-link" title={MODEL_LINKS.ffmpeg} onClick={() => void openExternal(MODEL_LINKS.ffmpeg)}>
            下载 ffmpeg
          </button>
        </p>
      </section>

      <section className="st-media-card">
        <div className="st-media-card-head">
          <span className="st-media-card-title">示例提示词</span>
          <Badge tone="gold">可直接复制给 Morrow</Badge>
        </div>
        {[
          { label: '生成图片', value: IMAGE_PROMPT },
          { label: '编辑图片', value: EDIT_PROMPT },
          { label: '生成视频（5 秒）', value: VIDEO_PROMPT }
        ].map((item) => (
          <div className="st-media-prompt" key={item.label}>
            <span className="st-media-prompt-label">{item.label}</span>
            <p>{item.value}</p>
            <button type="button" onClick={() => void copyText(item.value)} aria-label={`复制${item.label}提示词`}>
              <Copy size={11} strokeWidth={1.6} aria-hidden />
              复制
            </button>
          </div>
        ))}
        <p className="st-media-note">
          生成视频时，参考图会被理解为 <span className="mono">&lt;Picture 1&gt;</span>；编辑图片时用 <span className="mono">&lt;image1&gt;</span> 指代输入图，并明确写出要保留的部分。
        </p>
      </section>

      {flash ? <p className="st-media-flash" role="status">{flash}</p> : null}
      {error ? <p className="st-error" role="alert">{error}</p> : null}
    </div>
  )
}

type ViewMode = 'day' | 'week' | 'total'

interface Tile {
  key: string
  label: string
  title: string
  tokens: number
  input: number
  output: number
  cache: number
  estimated: number
  level: number
  /** 自网格起点算起的周列（0 = 第一列） */
  weekColumn: number
  /** 0=周一 … 6=周日 */
  weekday: number
  requests?: number
  outside?: boolean
}

const MODE_LABEL: Record<ViewMode, string> = { day: '每天', week: '每周', total: '累计总量' }

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const

function levelFor(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0
  if (max <= 0) return 1
  const ratio = Math.sqrt(Math.min(1, value / max))
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.78) return 3
  return 4
}

function buildDailyTiles(summary: TokenActivitySummary): { tiles: Tile[]; columns: number; labels: Array<{ column: number; label: string }> } {
  const byDate = new Map(summary.days.map((day) => [day.date, day]))
  if (summary.days.length === 0) return { tiles: [], columns: 0, labels: [] }
  const end = parseDay(summary.days[summary.days.length - 1].date)
  const rangeStart = parseDay(summary.days[0].date)
  const mondayOffset = (rangeStart.getDay() + 6) % 7
  const gridStart = addDays(rangeStart, -mondayOffset)
  const columns = Math.ceil((diffDays(gridStart, end) + 1) / 7)
  const max = Math.max(0, ...summary.days.map((day) => day.totalTokens))
  const tiles: Tile[] = []
  const labels = buildMonthLabels(rangeStart, end)
  for (let column = 0; column < columns; column += 1) {
    const monday = addDays(gridStart, column * 7)
    for (let row = 0; row < 7; row += 1) {
      const date = addDays(monday, row)
      const key = dayKey(date)
      const day = byDate.get(key)
      const outside = date < rangeStart || date > end
      tiles.push({
        key,
        label: dayLabel(date),
        title: day ? `${formatExactTokens(day.totalTokens)} tokens` : '0 tokens',
        tokens: day?.totalTokens ?? 0,
        input: day?.inputTokens ?? 0,
        output: day?.outputTokens ?? 0,
        cache: day?.cacheReadTokens ?? 0,
        estimated: day?.estimatedTokens ?? 0,
        level: levelFor(day?.totalTokens ?? 0, max),
        weekColumn: column,
        weekday: row,
        ...(outside ? { outside: true } : {})
      })
    }
  }
  return { tiles, columns, labels }
}

interface WeekAggregate {
  start: Date
  end: Date
  tokens: number
  input: number
  output: number
  cache: number
  estimated: number
  requests: number
}

interface WeekMetrics {
  weeks: Map<string, WeekAggregate>
  max: number
  rangeStart: Date
}

function buildWeekMetrics(summary: TokenActivitySummary): WeekMetrics {
  const weeks = new Map<string, WeekAggregate>()
  const rangeStart = summary.days.length > 0 ? parseDay(summary.days[0].date) : new Date()
  for (const day of summary.days) {
    const start = startOfWeek(parseDay(day.date))
    const key = dayKey(start)
    const current =
      weeks.get(key) ??
      ({ start, end: addDays(start, 6), tokens: 0, input: 0, output: 0, cache: 0, estimated: 0, requests: 0 } as WeekAggregate)
    current.tokens += day.totalTokens
    current.input += day.inputTokens
    current.output += day.outputTokens
    current.cache += day.cacheReadTokens
    current.estimated += day.estimatedTokens
    current.requests += day.requests
    weeks.set(key, current)
  }
  return { weeks, max: Math.max(0, ...[...weeks.values()].map((week) => week.tokens)), rangeStart }
}

interface CumulativeMetrics {
  byDate: Map<string, number>
  max: number
}

function buildCumulativeMetrics(summary: TokenActivitySummary): CumulativeMetrics {
  const rangeTotal = summary.days.reduce((sum, day) => sum + day.totalTokens, 0)
  // 账本里是最近 365 天；更早的历史只保留在 total 里，作为累计曲线的起点。
  let running = Math.max(0, summary.total - rangeTotal)
  const byDate = new Map<string, number>()
  for (const day of summary.days) {
    running += day.totalTokens
    byDate.set(day.date, running)
  }
  return { byDate, max: Math.max(running, summary.total, 1) }
}

function Tooltip({
  tooltip
}: {
  tooltip: { x: number; y: number; title: string; value: string; detail?: string } | null
}): React.JSX.Element | null {
  if (!tooltip) return null
  return (
    <div className="token-tooltip" style={{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }} role="status">
      <strong>{tooltip.title}</strong>
      <span className="mono">{tooltip.value}</span>
      {tooltip.detail ? <small>{tooltip.detail}</small> : null}
    </div>
  )
}

export function TokenActivityTab(): React.JSX.Element {
  const [summary, setSummary] = useState<TokenActivitySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>('day')
  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; value: string; detail?: string } | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.morrow.tokenActivity.get()
      if (!result.ok) throw new Error(result.error.message)
      setSummary(result.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 Token 活动失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const daily = useMemo(() => (summary ? buildDailyTiles(summary) : { tiles: [], columns: 0, labels: [] }), [summary])
  const weekMetrics = useMemo(
    () => (summary ? buildWeekMetrics(summary) : { weeks: new Map(), max: 0, rangeStart: new Date() }),
    [summary]
  )
  const cumulativeMetrics = useMemo(
    () => (summary ? buildCumulativeMetrics(summary) : { byDate: new Map(), max: 1 }),
    [summary]
  )

  /**
   * 三种统计方式共用同一张「一天一格」的热力图：
   * - 每天：格子值 = 当天用量；
   * - 每周：格子值 = 所在自然周的合计（同一周同色）；
   * - 累计总量：格子值 = 截至当天的历史累计。
   */
  const activeTiles = useMemo(() => {
    if (mode === 'day') return daily.tiles
    return daily.tiles.map((tile) => {
      if (tile.outside) return tile
      const date = parseDay(tile.key)
      if (mode === 'week') {
        const week = weekMetrics.weeks.get(dayKey(startOfWeek(date)))
        if (!week) return tile
        const partial = week.start < weekMetrics.rangeStart
        return {
          ...tile,
          label: `${dayLabel(week.start)}–${dayLabel(week.end)}`,
          title: `${formatExactTokens(week.tokens)} tokens · 该周合计${week.requests ? ` · ${week.requests} 次请求` : ''}${partial ? '（显示范围内）' : ''}`,
          tokens: week.tokens,
          input: week.input,
          output: week.output,
          cache: week.cache,
          estimated: week.estimated,
          requests: week.requests,
          level: levelFor(week.tokens, weekMetrics.max)
        }
      }
      const cumulative = cumulativeMetrics.byDate.get(tile.key) ?? 0
      return {
        ...tile,
        label: `截至 ${dayLabel(date)}`,
        title: `${formatExactTokens(cumulative)} tokens · 累计用量`,
        tokens: cumulative,
        input: 0,
        output: 0,
        cache: 0,
        estimated: 0,
        level: levelFor(cumulative, cumulativeMetrics.max)
      }
    })
  }, [mode, daily.tiles, weekMetrics, cumulativeMetrics])

  const showTooltip = (tile: Tile, currentTarget: HTMLElement): void => {
    const container = gridRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const target = currentTarget.getBoundingClientRect()
    const center = target.left - rect.left + target.width / 2
    // 提示卡最宽 280px；靠近网格边缘时向内收，避免被裁切。
    const x = Math.min(Math.max(center, 144), Math.max(144, rect.width - 144))
    setTooltip({
      x,
      y: target.top - rect.top - 6,
      title: tile.label,
      value: tile.title,
      detail:
        tile.input > 0 || tile.output > 0 || tile.cache > 0 || tile.estimated > 0
          ? [
              tile.input > 0 || tile.output > 0
                ? `输入 ${formatExactTokens(tile.input)} · 输出 ${formatExactTokens(tile.output)}`
                : '',
              tile.cache > 0 ? `其中缓存读取 ${formatExactTokens(tile.cache)}（已含在输入内）` : '',
              tile.estimated > 0 ? `含约 ${formatExactTokens(tile.estimated)} 个估算` : ''
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined
    })
  }

  const modeHint =
    mode === 'day'
      ? '鼠标停在格子上，查看当天用量'
      : mode === 'week'
        ? '鼠标停在格子上，查看所在自然周的合计'
        : '鼠标停在格子上，查看截至当天的历史累计'
  const gridHint = `一天一格 · 每列一周（周一→周日）· ${modeHint}`

  return (
    <div className="token-activity">
      <div className="token-activity-head-actions token-activity-toolbar">
        <Segmented
          value={mode}
          options={(Object.keys(MODE_LABEL) as ViewMode[]).map((key) => ({ value: key, label: MODE_LABEL[key] }))}
          onChange={(next) => {
            setMode(next)
            setTooltip(null)
          }}
          ariaLabel="Token 活动视图"
        />
        <button type="button" className="token-refresh" aria-label="刷新 Token 活动" title="刷新" onClick={() => void load()}>
          <RefreshCw size={13} strokeWidth={1.5} className={loading ? 'is-spinning' : ''} aria-hidden />
        </button>
      </div>

      {summary ? (
        <div className="token-activity-stats">
          <span>今天 <strong>{formatUsageTokens(summary.today)}</strong></span>
          <span>近 7 天 <strong>{formatUsageTokens(summary.week)}</strong></span>
          <span>近一年 <strong>{formatUsageTokens(summary.yearTotal)}</strong></span>
          <span>累计 <strong>{formatUsageTokens(summary.total)}</strong></span>
          <span>近一年活跃 <strong>{summary.activeDays}</strong> 天</span>
        </div>
      ) : null}

      {summary && summary.total > 0 ? <p className="token-mode-note mono">{gridHint}</p> : null}

      {error ? (
        <div className="token-activity-state is-error" role="alert">
          <strong>Token 活动暂时读不到</strong>
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>重试</button>
        </div>
      ) : loading && !summary ? (
        <div className="token-activity-state">正在读取用量账本…</div>
      ) : summary && summary.total === 0 ? (
        <div className="token-activity-state">
          <strong>还没有 Token 记录</strong>
          <span>完成一次真实对话后，这里会按天显示输入、输出与缓存 token。</span>
        </div>
      ) : (
        <>
          <div
            ref={gridRef}
            className="token-mosaic"
            data-mode={mode}
            style={{ '--token-columns': daily.columns } as React.CSSProperties}
            aria-label={
              mode === 'day'
                ? '每天 Token 活动热力图（每列一周，周一到周日，一天一格）'
                : mode === 'week'
                  ? '每周 Token 活动热力图（每列一周，周一到周日，显示周合计）'
                  : '累计 Token 活动热力图（每列一周，周一到周日，显示截至当天累计）'
            }
          >
            {WEEKDAYS.map((label, index) => (
              <span
                key={label}
                className="token-weekday"
                style={{ gridColumn: 1, gridRow: index + 1 }}
                aria-hidden
              >
                {label}
              </span>
            ))}
            {activeTiles.map((tile) => (
              <button
                key={tile.key}
                type="button"
                tabIndex={-1}
                data-date={tile.key}
                data-weekday={tile.weekday + 1}
                style={{ gridColumn: tile.weekColumn + 2, gridRow: tile.weekday + 1 }}
                className={[
                  'token-cell',
                  `level-${tile.level}`,
                  tile.outside ? 'is-outside' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-label={`${tile.label}：${tile.title}`}
                onMouseEnter={(event) => showTooltip(tile, event.currentTarget)}
                onMouseLeave={() => setTooltip(null)}
                onFocus={(event) => showTooltip(tile, event.currentTarget)}
                onBlur={() => setTooltip(null)}
              />
            ))}
            {daily.labels.map((label) => (
              <span
                key={`${label.column}-${label.label}`}
                className={['token-month-label', label.column >= daily.columns - 1 ? 'is-end' : ''].filter(Boolean).join(' ')}
                style={{ gridColumn: label.column + 2, gridRow: 8 }}
                aria-hidden
              >
                {label.label}
              </span>
            ))}
            <Tooltip tooltip={tooltip} />
          </div>

          <footer className="token-activity-foot">
            <div className="token-legend" aria-label="颜色越亮 Token 越多">
              <span>少</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <i key={level} className={`token-cell level-${level}`} aria-hidden />
              ))}
              <span>多</span>
            </div>
            {(summary?.estimatedTokens ?? 0) > 0 ? (
              <span className="token-estimated-note">
                近一年有 {formatExactTokens(summary?.estimatedTokens ?? 0)} 个 token 是本地估算（服务商没有返回用量）
              </span>
            ) : (
              <span className="token-estimated-note is-exact">全部来自服务商返回的精确用量</span>
            )}
          </footer>
        </>
      )}
    </div>
  )
}

type View = { kind: 'hub' } | { kind: 'codex' } | { kind: 'qoder' } | { kind: 'agent'; id: AgentSubscriptionId } | { kind: 'custom'; id?: string }

const AGENT_META: Record<AgentSubscriptionId, { name: string; subtitle: string; description: string; icon: React.JSX.Element }> = {
  kimi: { name: 'Kimi Code', subtitle: 'Kimi 官方 Agent 账号 · 浏览器设备登录', description: '用 Kimi 订阅额度运行 K3 / K3.1 Pro，支持工具调用与图片输入。', icon: <Moon size={17} strokeWidth={1.7} aria-hidden /> },
  glm: { name: 'GLM Coding Plan', subtitle: 'ZCode 账号 · 浏览器登录', description: '用 GLM Coding Plan 的订阅额度运行 GLM-5.3 系列。', icon: <Brain size={17} strokeWidth={1.7} aria-hidden /> },
  minimax: { name: 'MiniMax Code', subtitle: 'MiniMax 官方 Agent 账号', description: '用 MiniMax Code 的订阅额度运行 M3 系列。', icon: <Zap size={17} strokeWidth={1.7} aria-hidden /> },
  step: { name: 'Step Plan', subtitle: '阶跃星辰 Step Plan', description: '用 Step Plan 的订阅额度运行 Step 模型。', icon: <Route size={17} strokeWidth={1.7} aria-hidden /> },
  'command-code': { name: 'Command Code', subtitle: '浏览器领取长期密钥', description: '用 Command Code 的订阅额度运行 Claude / GPT / 国内模型。', icon: <SquareTerminal size={17} strokeWidth={1.7} aria-hidden /> },
  cline: { name: 'Cline Pass', subtitle: 'Cline 官方订阅', description: '用 Cline Pass 额度运行 15 个编码模型。', icon: <Layers size={17} strokeWidth={1.7} aria-hidden /> },
  antigravity: { name: 'Google Antigravity', subtitle: 'Google OAuth · Gemini / Claude', description: '用 Antigravity 额度运行 Gemini 与 Claude 模型。', icon: <Orbit size={17} strokeWidth={1.7} aria-hidden /> },
  opencode: { name: 'OpenCode', subtitle: 'OpenCode Zen / 本机登录', description: '导入本机 OpenCode 凭据，或使用 OpenCode Zen API Key。', icon: <Boxes size={17} strokeWidth={1.7} aria-hidden /> }
}

const EMPTY_FORM: CustomSubscriptionInput = {
  name: '',
  protocol: 'openai-compat',
  baseUrl: '',
  apiKey: '',
  models: []
}

const CODEX_LOGIN_BUSY = '等待浏览器完成 ChatGPT 登录…'

const QODER_LOGIN_BUSY = '等待浏览器完成 Qoder 登录（5 分钟内）…'

function protocolLabel(protocol: SubscriptionProtocol): string {
  return protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions'
}

function planLabel(plan?: string): string {
  if (!plan) return '订阅账号'
  if (plan.toLowerCase() === 'pro') return 'ChatGPT Pro'
  if (plan.toLowerCase() === 'plus') return 'ChatGPT Plus'
  if (plan.toLowerCase() === 'business') return 'ChatGPT Business'
  return plan
}

function resetLabel(timestamp?: number): string {
  if (!timestamp) return '重置时间未知'
  try {
    return `${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp))} 重置`
  } catch {
    return '重置时间未知'
  }
}

function QuotaBar({ window }: { window: CodexSubscriptionQuota['windows'][number] }): React.JSX.Element {
  const used = Math.max(0, Math.min(100, window.usedPercent))
  return (
    <div className="st-sub-window">
      <div className="st-sub-window-head">
        <span>{window.label}</span>
        <span className="mono">{used.toFixed(0)}% 已用</span>
      </div>
      <div className="st-sub-window-bar" aria-hidden>
        <span style={{ width: `${used}%` }} />
      </div>
      <span className="st-sub-window-reset">{resetLabel(window.resetAt)}</span>
    </div>
  )
}

function CodexSummary({ codex, onOpen }: { codex: CodexSubscriptionState; onOpen: () => void }): React.JSX.Element {
  const quota = codex.quota
  const primary = quota?.windows[0]
  return (
    <article className="st-sub-card st-sub-card-codex">
      <div className="st-sub-card-head">
        <span className="st-sub-brand"><Sparkles size={17} strokeWidth={1.7} aria-hidden /></span>
        <div className="st-sub-card-title">
          <span>ChatGPT / Codex 订阅</span>
          <span className="st-sub-card-sub">官方 Agent 账号 · 使用订阅额度</span>
        </div>
        <Badge tone={codex.connected ? 'success' : 'neutral'}>{codex.connected ? '已连接' : '未连接'}</Badge>
      </div>
      {codex.connected ? (
        <div className="st-sub-account-line">
          <span className="truncate">{codex.account?.email ?? '已登录 ChatGPT 账号'}</span>
          <span className="st-sub-plan">{planLabel(codex.account?.plan)}</span>
          {primary ? <span className="st-sub-quota-inline mono">{primary.label} {primary.usedPercent.toFixed(0)}%</span> : null}
        </div>
      ) : (
        <p className="st-sub-card-desc">导入本机 Codex CLI 登录，或在浏览器完成 ChatGPT OAuth；登录后会自动注册为 Morrow 的订阅模型。</p>
      )}
      {primary ? (
        <div className="st-sub-card-meter" aria-hidden>
          <span style={{ width: `${Math.max(0, Math.min(100, primary.usedPercent))}%` }} />
        </div>
      ) : null}
      <div className="st-sub-card-foot">
        <span>{codex.models.length} 个可用模型 · 凭据加密保存在本机</span>
        <Button size="sm" variant={codex.connected ? 'secondary' : 'primary'} onClick={onOpen}>
          {codex.connected ? '管理订阅' : '连接账号'}
        </Button>
      </div>
    </article>
  )
}

function CustomSummary({
  item,
  onOpen
}: {
  item: CustomSubscriptionState
  onOpen: () => void
}): React.JSX.Element {
  return (
    <article className="st-sub-card">
      <div className="st-sub-card-head">
        <span className="st-sub-brand"><KeyRound size={17} strokeWidth={1.7} aria-hidden /></span>
        <div className="st-sub-card-title">
          <span>{item.record.name}</span>
          <span className="st-sub-card-sub">{protocolLabel(item.record.protocol)} · 第三方 coding plan</span>
        </div>
        <Badge tone={item.connected ? 'success' : 'warning'}>{item.connected ? '已连接' : '待补 token'}</Badge>
      </div>
      <div className="st-sub-account-line">
        <span className="mono truncate">{item.record.baseUrl}</span>
        <span className="st-sub-plan">{item.record.models.length} 个模型</span>
      </div>
      <div className="st-sub-card-foot">
        <span>{item.provider?.enabled ? '在模型选择器中启用' : '已在模型选择器中停用'}</span>
        <Button size="sm" variant="secondary" onClick={onOpen}>管理</Button>
      </div>
    </article>
  )
}

function qoderRegionLabel(region?: 'global' | 'cn'): string {
  return region === 'global' ? '全球区（qoder.com）' : '中国站（qoder.com.cn）'
}

function qoderSourceLabel(source?: 'pat' | 'device' | 'local'): string {
  if (source === 'pat') return 'Personal Access Token'
  if (source === 'device') return '浏览器登录'
  if (source === 'local') return '本机 qodercli'
  return '本机登录态'
}

function qoderBucketLabel(kind: QoderSubscriptionQuota['buckets'][number]['kind']): string {
  if (kind === 'add-on') return '加量包'
  if (kind === 'org') return '团队额度'
  return '个人额度'
}

function qoderBucketUsage(bucket: QoderSubscriptionQuota['buckets'][number]): { used?: number; total?: number; percent?: number } {
  const total = bucket.total ?? (bucket.used !== undefined && bucket.remaining !== undefined ? bucket.used + bucket.remaining : undefined)
  const used = bucket.used ?? (total !== undefined && bucket.remaining !== undefined ? total - bucket.remaining : undefined)
  const percent = total !== undefined && total > 0 && used !== undefined ? Math.max(0, Math.min(100, (used / total) * 100)) : undefined
  return { used, total, percent }
}

function QoderBucket({ bucket }: { bucket: QoderSubscriptionQuota['buckets'][number] }): React.JSX.Element {
  const usage = qoderBucketUsage(bucket)
  return (
    <div className="st-sub-window">
      <div className="st-sub-window-head">
        <span>{qoderBucketLabel(bucket.kind)}</span>
        <span className="mono">
          {usage.used !== undefined && usage.total !== undefined
            ? `${usage.used.toLocaleString('zh-CN')} / ${usage.total.toLocaleString('zh-CN')}${bucket.unit ? ` ${bucket.unit}` : ''}`
            : bucket.remaining !== undefined
              ? `剩余 ${bucket.remaining.toLocaleString('zh-CN')}${bucket.unit ? ` ${bucket.unit}` : ''}`
              : '额度未知'}
        </span>
      </div>
      <div className="st-sub-window-bar" aria-hidden>
        <span style={{ width: `${usage.percent ?? 0}%` }} />
      </div>
      <span className="st-sub-window-reset">
        {usage.percent !== undefined ? `${usage.percent.toFixed(0)}% 已用` : '上游没有返回总量'}
        {bucket.remaining !== undefined ? ` · 剩余 ${bucket.remaining.toLocaleString('zh-CN')}` : ''}
      </span>
    </div>
  )
}

function QoderSummary({ qoder, onOpen }: { qoder: QoderSubscriptionState; onOpen: () => void }): React.JSX.Element {
  const primary = qoder.quota?.buckets.find((bucket) => bucket.kind === 'personal') ?? qoder.quota?.buckets[0]
  const usage = primary ? qoderBucketUsage(primary) : undefined
  return (
    <article className="st-sub-card st-sub-card-qoder">
      <div className="st-sub-card-head">
        <span className="st-sub-brand"><Globe2 size={17} strokeWidth={1.7} aria-hidden /></span>
        <div className="st-sub-card-title">
          <span>Qoder 订阅</span>
          <span className="st-sub-card-sub">Qoder CLI 账号 · 专用协议代理</span>
        </div>
        <Badge tone={qoder.connected ? 'success' : 'neutral'}>{qoder.connected ? '已连接' : '未连接'}</Badge>
      </div>
      {qoder.connected ? (
        <div className="st-sub-account-line">
          <span className="truncate">{qoder.account?.email ?? qoder.account?.name ?? '已登录 Qoder 账号'}</span>
          <span className="st-sub-plan">{qoder.account?.region === 'global' ? '全球区' : '中国站'}</span>
          {usage?.percent !== undefined ? <span className="st-sub-quota-inline mono">额度 {usage.percent.toFixed(0)}%</span> : null}
        </div>
      ) : (
        <p className="st-sub-card-desc">用 Qoder PAT、浏览器设备流，或导入本机 qodercli 登录态；连接后按订阅额度调用 Qoder 模型。</p>
      )}
      {usage?.percent !== undefined ? (
        <div className="st-sub-card-meter" aria-hidden>
          <span style={{ width: `${usage.percent}%` }} />
        </div>
      ) : null}
      <div className="st-sub-card-foot">
        <span>{qoder.connected ? `${qoder.models.length} 个可用模型 · 登录态加密保存在本机` : 'PAT / 浏览器 / 本机 qodercli · 凭据加密保存在本机'}</span>
        <Button size="sm" variant={qoder.connected ? 'secondary' : 'primary'} onClick={onOpen}>
          {qoder.connected ? '管理订阅' : '连接账号'}
        </Button>
      </div>
    </article>
  )
}

function AgentQuotaBar({ entry }: { entry: AgentQuotaWindow }): React.JSX.Element {
  const percent = entry.usedPercent
  return (
    <div className="st-sub-window">
      <div className="st-sub-window-head">
        <span>{entry.label}</span>
        <span className="mono">
          {percent !== undefined
            ? `${Math.max(0, Math.min(100, percent)).toFixed(0)}% 已用`
            : entry.remaining !== undefined
              ? `剩余 ${entry.remaining.toLocaleString('zh-CN')}${entry.unit ? ` ${entry.unit}` : ''}`
              : '额度未知'}
        </span>
      </div>
      <div className="st-sub-window-bar" aria-hidden>
        <span style={{ width: `${percent !== undefined ? Math.max(0, Math.min(100, percent)) : 0}%` }} />
      </div>
      <span className="st-sub-window-reset">
        {entry.resetAt ? resetLabel(entry.resetAt) : entry.total !== undefined ? `总量 ${entry.total.toLocaleString('zh-CN')}${entry.unit ? ` ${entry.unit}` : ''}` : '重置时间未知'}
      </span>
    </div>
  )
}

function AgentSummary({ agent, onOpen }: { agent: AgentSubscriptionState; onOpen: () => void }): React.JSX.Element {
  const meta = AGENT_META[agent.id]
  const primary = agent.quota?.windows[0]
  return (
    <article className="st-sub-card">
      <div className="st-sub-card-head">
        <span className="st-sub-brand">{meta.icon}</span>
        <div className="st-sub-card-title">
          <span>{meta.name}</span>
          <span className="st-sub-card-sub">{meta.subtitle}</span>
        </div>
        <Badge tone={agent.connected ? 'success' : 'neutral'}>{agent.connected ? '已连接' : '未连接'}</Badge>
      </div>
      {agent.connected ? (
        <div className="st-sub-account-line">
          <span className="truncate">{agent.account?.email ?? agent.account?.name ?? '已登录订阅账号'}</span>
          {agent.account?.plan ? <span className="st-sub-plan">{agent.account.plan}</span> : null}
          {primary?.usedPercent !== undefined ? <span className="st-sub-quota-inline mono">{primary.label} {primary.usedPercent.toFixed(0)}%</span> : null}
        </div>
      ) : (
        <p className="st-sub-card-desc">{meta.description}</p>
      )}
      {primary?.usedPercent !== undefined ? (
        <div className="st-sub-card-meter" aria-hidden>
          <span style={{ width: `${Math.max(0, Math.min(100, primary.usedPercent))}%` }} />
        </div>
      ) : null}
      <div className="st-sub-card-foot">
        <span>{agent.connected ? `${agent.models.length} 个可用模型 · 凭据加密保存在本机` : '登录态与凭据只保存在本机'}</span>
        <Button size="sm" variant={agent.connected ? 'secondary' : 'primary'} onClick={onOpen}>
          {agent.connected ? '管理订阅' : '连接账号'}
        </Button>
      </div>
    </article>
  )
}

export function SubscriptionTab(): React.JSX.Element {
  const notify = useAppStore((s) => s.notify)
  const openExternal = useAppStore((s) => s.openExternal)
  const [status, setStatus] = useState<SubscriptionStatus | null>(null)
  const [view, setView] = useState<View>({ kind: 'hub' })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<SubscriptionTestResult | null>(null)
  const [form, setForm] = useState<CustomSubscriptionInput>(EMPTY_FORM)
  const [qoderRegion, setQoderRegion] = useState<'global' | 'cn'>('cn')
  const [qoderPat, setQoderPat] = useState('')
  const [qoderPatOpen, setQoderPatOpen] = useState(false)
  const [agentRegion, setAgentRegion] = useState<string>('cn')
  const [agentToken, setAgentToken] = useState('')
  const [agentTokenOpen, setAgentTokenOpen] = useState(false)

  const load = async (): Promise<void> => {
    try {
      const result = (await window.morrow.features.invoke('feature:subscriptions:status')) as Result<SubscriptionStatus>
      if (!result.ok) throw new Error(result.error.message)
      setStatus(result.data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取订阅状态失败。')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    document.getElementById('st-panel-subscriptions')?.scrollTo({ top: 0 })
  }, [view])

  useEffect(() => {
    if (view.kind !== 'agent') return
    const agent = status?.agents?.find((item) => item.id === view.id)
    setAgentRegion(agent?.defaultRegion ?? agent?.regionOptions?.[0]?.value ?? 'cn')
    setAgentToken('')
    setAgentTokenOpen(false)
  }, [view, status])

  const act = async (
    action: SubscriptionAction,
    options: { done?: string; onStatus?: (next: SubscriptionStatus) => void; keepView?: boolean } = {}
  ): Promise<boolean> => {
    setBusy(options.done ?? '处理中…')
    setError(null)
    setTest(null)
    try {
      const result = (await window.morrow.features.invoke('feature:subscriptions:action', action)) as Result<
        SubscriptionStatus | SubscriptionTestResult
      >
      if (!result.ok) throw new Error(result.error.message)
      const data = result.data
      if ('disclaimer' in data) {
        setStatus(data)
        options.onStatus?.(data)
        await useAppStore.getState().refreshSettings()
        if (!options.keepView) setView({ kind: 'hub' })
      } else {
        setTest(data)
      }
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '订阅操作失败。')
      return false
    } finally {
      setBusy(null)
    }
  }

  const openCustom = (record?: CustomSubscriptionRecord): void => {
    if (record) {
      setForm({
        id: record.id,
        name: record.name,
        protocol: record.protocol,
        baseUrl: record.baseUrl,
        apiKey: '',
        models: record.models
      })
      setView({ kind: 'custom', id: record.id })
    } else {
      setForm(EMPTY_FORM)
      setView({ kind: 'custom' })
    }
    setTest(null)
    setError(null)
  }

  const saveCustom = async (): Promise<void> => {
    if (!form.name.trim()) return setError('请填写订阅名称。')
    if (!form.baseUrl.trim()) return setError('请填写接口地址。')
    if (form.models.length === 0) return setError('至少填写一个模型 ID。')
    if (!form.id && !form.apiKey.trim()) return setError('首次添加需要填写 token / API Key。')
    const ok = await act(
      { action: form.id ? 'update-custom' : 'add-custom', input: form },
      { done: form.id ? '保存订阅…' : '添加订阅…', keepView: true }
    )
    if (ok) {
      notify('success', form.id ? '订阅已更新。' : '订阅已添加，可在模型选择器中使用。')
      setView({ kind: 'hub' })
    }
  }

  const importDefault = async (): Promise<void> => {
    await act({ action: 'import-codex' }, { done: '读取本机 Codex 登录…', keepView: true })
  }

  const importFile = async (): Promise<void> => {
    try {
      const picked = (await window.morrow.features.invoke('feature:subscriptions:pick-codex-auth')) as Result<string | null>
      if (!picked.ok) throw new Error(picked.error.message)
      if (!picked.data) return
      await act({ action: 'import-codex', path: picked.data }, { done: '导入 Codex 登录…', keepView: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '选择登录文件失败。')
    }
  }

  const loginBrowser = async (): Promise<void> => {
    setBusy(CODEX_LOGIN_BUSY)
    setError(null)
    try {
      const result = (await window.morrow.features.invoke('feature:subscriptions:action', { action: 'login-codex' })) as Result<SubscriptionStatus>
      if (!result.ok) throw new Error(result.error.message)
      setStatus(result.data)
      setView({ kind: 'codex' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ChatGPT 登录失败。')
    } finally {
      setBusy(null)
    }
  }

  const loginQoderDevice = async (): Promise<void> => {
    const ok = await act(
      { action: 'login-qoder-device' },
      { done: QODER_LOGIN_BUSY, keepView: true }
    )
    if (ok) notify('success', 'Qoder 已连接。')
  }

  const copyLoginUrl = async (provider: 'codex' | 'qoder'): Promise<void> => {
    try {
      const result = (await window.morrow.features.invoke('feature:subscriptions:login-url', { provider })) as Result<{
        url: string | null
      }>
      if (!result.ok) throw new Error(result.error.message)
      if (!result.data.url) throw new Error('登录链接还没有准备好，请稍后再试。')
      await navigator.clipboard.writeText(result.data.url)
      notify('success', '登录链接已复制，请粘贴到浏览器打开。')
    } catch (err) {
      notify('error', errorText(err, '复制登录链接失败。'))
    }
  }

  const loginQoderPat = async (): Promise<void> => {
    if (!qoderPat.trim()) {
      setError('请粘贴 Qoder PAT。')
      return
    }
    const ok = await act(
      { action: 'login-qoder', pat: qoderPat, region: qoderRegion },
      { done: '兑换 Qoder PAT…', keepView: true }
    )
    if (ok) {
      setQoderPat('')
      setQoderPatOpen(false)
      notify('success', 'Qoder 已连接。')
    }
  }

  const importQoderLocal = async (): Promise<void> => {
    const ok = await act({ action: 'import-qoder-local' }, { done: '读取本机 qodercli 登录态…', keepView: true })
    if (ok) notify('success', '已导入本机 Qoder 登录态。')
  }

  const loginAgent = async (agent: AgentSubscriptionState): Promise<void> => {
    const ok = await act(
      { action: 'login-agent', id: agent.id, region: agentRegion },
      { done: `等待浏览器完成 ${AGENT_META[agent.id].name} 登录…`, keepView: true }
    )
    if (ok) notify('success', `${AGENT_META[agent.id].name} 已连接。`)
  }

  const loginAgentToken = async (agent: AgentSubscriptionState): Promise<void> => {
    if (!agentToken.trim()) {
      setError('请先粘贴 API Key。')
      return
    }
    const ok = await act(
      { action: 'login-agent-token', id: agent.id, token: agentToken, region: agentRegion },
      { done: '校验并保存密钥…', keepView: true }
    )
    if (ok) {
      setAgentToken('')
      setAgentTokenOpen(false)
      notify('success', `${AGENT_META[agent.id].name} 已连接。`)
    }
  }

  const importAgentLocal = async (agent: AgentSubscriptionState): Promise<void> => {
    const ok = await act(
      { action: 'import-agent-local', id: agent.id },
      { done: '读取本机登录态…', keepView: true }
    )
    if (ok) notify('success', `已导入本机 ${AGENT_META[agent.id].name} 登录态。`)
  }

  const codex = status?.codex
  const qoder = status?.qoder
  const agents = status?.agents ?? []
  const custom = status?.custom ?? []
  const selectedAgent = view.kind === 'agent' ? agents.find((item) => item.id === view.id) : undefined
  const selectedCustom = view.kind === 'custom' && view.id ? custom.find((item) => item.record.id === view.id) : undefined
  const codexQuota = codex?.quota
  const codexLoginWaiting = busy === CODEX_LOGIN_BUSY
  const qoderLoginWaiting = busy === QODER_LOGIN_BUSY
  const loginWaiting = codexLoginWaiting || qoderLoginWaiting
  const busyRow = (provider: 'codex' | 'qoder'): React.JSX.Element | null =>
    busy ? (
      <div className="st-sub-busy">
        <LoaderCircle size={13} className="st-sub-spin" aria-hidden />
        <span>{busy}{loginWaiting ? ' 登录窗口没有出现？再次点击登录按钮重试，或复制登录链接。登录窗口可能在后台。' : null}</span>
        {loginWaiting ? (
          <span className="st-sub-busy-copy">
            <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void copyLoginUrl(provider)}>
              复制登录链接
            </Button>
          </span>
        ) : null}
      </div>
    ) : null

  if (view.kind === 'codex' && codex) {
    return (
      <div className="st-subs">
        <button type="button" className="st-sub-back" onClick={() => { setView({ kind: 'hub' }); setTest(null); setError(null) }}>
          <ArrowLeft size={13} strokeWidth={1.7} aria-hidden /> 返回订阅
        </button>
        <div className="st-sub-detail-head">
          <span className="st-sub-brand is-large"><Bot size={22} strokeWidth={1.6} aria-hidden /></span>
          <div>
            <h3>ChatGPT / Codex 订阅</h3>
            <p>官方账号的订阅额度；登录态只保存在本机，不经过 Morrow 服务器。</p>
          </div>
          <Badge tone={codex.connected ? 'success' : 'neutral'}>{codex.connected ? '已连接' : '未连接'}</Badge>
        </div>
        {error ? <p className="st-error" role="alert">{error}</p> : null}
        {busyRow('codex')}

        {codex.connected ? (
          <>
            <section className="st-sub-panel">
              <div className="st-sub-panel-head">
                <span>账号</span>
                {codex.account?.email ? <span className="mono">{codex.account.email}</span> : null}
              </div>
              <div className="st-sub-account-grid">
                <div><span>套餐</span><strong>{planLabel(codex.account?.plan ?? codexQuota?.plan)}</strong></div>
                <div><span>账号 ID</span><strong className="mono">{codex.account?.accountId?.slice(-8) ?? '—'}</strong></div>
                <div><span>登录来源</span><strong>{codex.sourcePath ? '本机 Codex CLI' : '浏览器 OAuth'}</strong></div>
                <div><span>凭据到期</span><strong>{codex.account?.expiresAt ? new Date(codex.account.expiresAt).toLocaleDateString('zh-CN') : '自动续期'}</strong></div>
              </div>
              {codex.sourcePath ? <p className="st-sub-note mono">只读导入：{codex.sourcePath}</p> : null}
            </section>

            <section className="st-sub-panel">
              <div className="st-sub-panel-head">
                <span>订阅额度</span>
                <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} disabled={!!busy} onClick={() => void act({ action: 'refresh-codex' }, { done: '刷新额度…', keepView: true })}>刷新</Button>
              </div>
              {codexQuota?.windows.length ? (
                <div className="st-sub-windows">
                  {codexQuota.windows.map((window) => <QuotaBar key={window.label} window={window} />)}
                </div>
              ) : (
                <p className="st-sub-empty">还没有读取到额度。点击刷新，或确认系统代理可访问 ChatGPT。</p>
              )}
              {codexQuota?.credits ? (
                <p className="st-sub-credit">
                  {codexQuota.credits.unlimited
                    ? '账号额度不限额'
                    : codexQuota.credits.hasCredits
                      ? `额外 credits：${codexQuota.credits.balance?.toFixed(0) ?? '可用'}`
                      : '当前没有额外 credits'}
                </p>
              ) : null}
              {codexQuota?.message ? <p className="st-sub-note">{codexQuota.message}</p> : null}
            </section>

            <section className="st-sub-panel">
              <div className="st-sub-panel-head"><span>可用模型</span><span className="mono">{codex.models.length} 个</span></div>
              <div className="st-sub-model-chips">
                {codex.models.map((model) => <span key={model.id}>{model.label}<em>{Math.round(model.contextWindow / 1000)}K</em></span>)}
              </div>
              <p className="st-sub-note">模型实际可用性由 ChatGPT 套餐与上游策略决定；在对话模型选择器中选择「Codex（ChatGPT 订阅）」即可使用。</p>
            </section>

            <section className="st-sub-panel">
              <Switch
                checked={codex.enabled}
                onChange={(enabled) => void act({ action: 'set-codex-enabled', enabled }, { done: enabled ? '启用订阅…' : '停用订阅…', keepView: true })}
                label="在模型选择器中启用"
                description="关闭后不再向 Agent 暴露这套订阅模型；登录态和额度记录保留。"
              />
              <div className="st-sub-panel-actions">
                <Button size="sm" variant="secondary" icon={<Gauge size={12} />} disabled={!!busy} onClick={() => void act({ action: 'test-codex' }, { done: '测试连接…', keepView: true })}>测试连接</Button>
                <Button size="sm" variant="ghost" icon={<Upload size={12} />} disabled={!!busy} onClick={() => void importDefault()}>重新导入本机登录</Button>
                <Button size="sm" variant="ghost" icon={<LogIn size={12} />} disabled={!!busy && !codexLoginWaiting} onClick={() => void loginBrowser()}>{codexLoginWaiting ? '重新打开登录页面' : '重新浏览器登录'}</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={12} />}
                  disabled={!!busy}
                  onClick={() => {
                    if (!window.confirm('移除 ChatGPT 订阅？会删除本机保存的订阅登录态与 Provider，不会影响你的 ChatGPT 账号。')) return
                    void act({ action: 'remove-codex' }, { done: '移除订阅…' })
                  }}
                >
                  移除订阅
                </Button>
              </div>
              {test ? <p className={test.ok ? 'st-sub-ok' : 'st-sub-error'}>{test.ok ? <Check size={12} /> : <X size={12} />}{test.message}{test.latencyMs ? ` · ${test.latencyMs}ms` : ''}</p> : null}
            </section>
          </>
        ) : (
          <section className="st-sub-panel st-sub-connect">
            <p>Codex 订阅使用 ChatGPT 账号的 OAuth 登录态。Morrow 不读取密码，也不发送账号到自己的服务器。</p>
            <div className="st-sub-connect-actions">
              <Button variant="primary" icon={<Upload size={13} />} disabled={!!busy} onClick={() => void importDefault()}>导入本机 Codex CLI 登录</Button>
              <Button variant="secondary" icon={<LogIn size={13} />} disabled={!!busy && !codexLoginWaiting} onClick={() => void loginBrowser()}>{codexLoginWaiting ? '重新打开登录页面' : '浏览器登录 ChatGPT'}</Button>
              <Button variant="ghost" disabled={!!busy} onClick={() => void importFile()}>选择 auth.json</Button>
            </div>
            <p className="st-sub-note">默认读取 <span className="mono">~/.codex/auth.json</span>（或 <span className="mono">CODEX_HOME</span>），只读，不会修改 Codex CLI 的文件。浏览器登录会打开本机 1455 回调。</p>
          </section>
        )}
        <p className="st-sub-disclaimer"><ShieldCheck size={13} aria-hidden /> {status?.disclaimer}</p>
      </div>
    )
  }

  if (view.kind === 'agent' && selectedAgent) {
    const meta = AGENT_META[selectedAgent.id]
    return (
      <div className="st-subs">
        <button type="button" className="st-sub-back" onClick={() => { setView({ kind: 'hub' }); setTest(null); setError(null) }}>
          <ArrowLeft size={13} strokeWidth={1.7} aria-hidden /> 返回订阅
        </button>
        <div className="st-sub-detail-head">
          <span className="st-sub-brand is-large">{AGENT_META[selectedAgent.id].icon}</span>
          <div>
            <h3>{meta.name}</h3>
            <p>{meta.description}</p>
          </div>
          <Badge tone={selectedAgent.connected ? 'success' : 'neutral'}>{selectedAgent.connected ? '已连接' : '未连接'}</Badge>
        </div>
        {error ? <p className="st-error" role="alert">{error}</p> : null}
        {busyRow('codex')}

        {selectedAgent.connected ? (
          <>
            <section className="st-sub-panel">
              <div className="st-sub-panel-head">
                <span>账号</span>
                {selectedAgent.account?.email ? <span className="mono">{selectedAgent.account.email}</span> : null}
              </div>
              <div className="st-sub-account-grid">
                <div><span>套餐</span><strong>{selectedAgent.account?.plan ?? '订阅账号'}</strong></div>
                <div><span>区域</span><strong>{selectedAgent.account?.region ?? '—'}</strong></div>
                <div><span>账号 ID</span><strong className="mono">{selectedAgent.account?.uid?.slice(-8) ?? '—'}</strong></div>
                <div><span>凭据到期</span><strong>{selectedAgent.account?.expiresAt ? new Date(selectedAgent.account.expiresAt).toLocaleDateString('zh-CN') : '自动续期'}</strong></div>
              </div>
              {selectedAgent.account?.sourcePath ? <p className="st-sub-note mono">只读导入：{selectedAgent.account.sourcePath}</p> : null}
            </section>

            <section className="st-sub-panel">
              <div className="st-sub-panel-head">
                <span>订阅额度</span>
                <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} disabled={!!busy} onClick={() => void act({ action: 'refresh-agent', id: selectedAgent.id }, { done: '刷新额度…', keepView: true })}>刷新</Button>
              </div>
              {selectedAgent.quota?.windows.length ? (
                <div className="st-sub-windows">
                  {selectedAgent.quota.windows.map((entry) => <AgentQuotaBar key={entry.id} entry={entry} />)}
                </div>
              ) : (
                <p className="st-sub-empty">{selectedAgent.quota?.message ?? '还没有读取到额度。点击刷新，或确认系统代理可访问服务商。'}</p>
              )}
            </section>

            <section className="st-sub-panel">
              <div className="st-sub-panel-head"><span>可用模型</span><span className="mono">{selectedAgent.models.length} 个</span></div>
              <div className="st-sub-model-chips">
                {selectedAgent.models.map((model) => <span key={model.id}>{model.label}<em>{Math.round(model.contextWindow / 1000)}K</em></span>)}
              </div>
              <p className="st-sub-note">在对话模型选择器中选择「{meta.name}（订阅）」即可使用；实际可用性由服务商套餐决定。</p>
            </section>

            <section className="st-sub-panel">
              <Switch
                checked={selectedAgent.enabled}
                onChange={(enabled) => void act({ action: 'set-agent-enabled', id: selectedAgent.id, enabled }, { done: enabled ? '启用订阅…' : '停用订阅…', keepView: true })}
                label="在模型选择器中启用"
                description="关闭后不再向 Agent 暴露这套订阅模型；登录态和额度记录保留。"
              />
              <div className="st-sub-panel-actions">
                <Button size="sm" variant="secondary" icon={<Gauge size={12} />} disabled={!!busy} onClick={() => void act({ action: 'test-agent', id: selectedAgent.id }, { done: '测试连接…', keepView: true })}>测试连接</Button>
                {selectedAgent.login !== 'local' ? (
                  <Button size="sm" variant="ghost" icon={<LogIn size={12} />} disabled={!!busy} onClick={() => void loginAgent(selectedAgent)}>重新登录</Button>
                ) : null}
                {selectedAgent.tokenLogin ? (
                  <Button size="sm" variant="ghost" icon={<KeyRound size={12} />} disabled={!!busy} onClick={() => setAgentTokenOpen((open) => !open)}>更换密钥</Button>
                ) : null}
                {selectedAgent.localImport?.available ? (
                  <Button size="sm" variant="ghost" icon={<Download size={12} />} disabled={!!busy} onClick={() => void importAgentLocal(selectedAgent)}>重新导入本机登录</Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={12} />}
                  disabled={!!busy}
                  onClick={() => {
                    if (!window.confirm(`移除 ${meta.name} 订阅？会删除本机保存的登录态与 Provider，不会影响你的账号。`)) return
                    void act({ action: 'remove-agent', id: selectedAgent.id }, { done: '移除订阅…' })
                  }}
                >
                  移除订阅
                </Button>
              </div>
              {agentTokenOpen && selectedAgent.tokenLogin ? (
                <div className="st-sub-replace">
                  <div className="st-sub-form-grid">
                    <TextInput
                      label={`新的 ${selectedAgent.tokenLogin.label}`}
                      value={agentToken}
                      onChange={(event) => setAgentToken(event.target.value)}
                      placeholder={selectedAgent.tokenLogin.placeholder}
                      spellCheck={false}
                    />
                  </div>
                  <div className="st-sub-panel-actions">
                    <Button variant="secondary" icon={<KeyRound size={12} />} disabled={!!busy} onClick={() => void loginAgentToken(selectedAgent)}>保存新密钥</Button>
                  </div>
                </div>
              ) : null}
              {test ? <p className={test.ok ? 'st-sub-ok' : 'st-sub-error'}>{test.ok ? <Check size={12} /> : <X size={12} />}{test.message}{test.latencyMs ? ` · ${test.latencyMs}ms` : ''}</p> : null}
            </section>
          </>
        ) : (
          <section className="st-sub-panel st-sub-connect">
            <p>
              {selectedAgent.login === 'local'
                ? '只读取本机凭据或你粘贴的 API Key，登录态保存在本机。'
                : 'Morrow 会打开服务商的授权页；登录完成前请保持这个窗口开着。凭据只保存在本机。'}
            </p>
            <div className="st-sub-connect-list">
              {selectedAgent.login !== 'local' ? (
                <div className="st-sub-connect-item is-stacked">
                  <div>
                    <strong>{selectedAgent.login === 'device' ? '浏览器设备登录' : selectedAgent.login === 'oauth' ? 'Google 登录' : '浏览器登录'}</strong>
                    <span>
                      {selectedAgent.regionOptions?.length
                        ? '选择账号所在区域，然后打开官方授权页完成登录。'
                        : '打开官方授权页完成登录，凭据只保存在本机。'}
                    </span>
                  </div>
                  {selectedAgent.regionOptions?.length ? (
                    <div className="st-sub-form-grid">
                      <div className="field">
                        <span className="field-label">账号区域</span>
                        <Select
                          ariaLabel={`${meta.name} 账号区域`}
                          value={agentRegion}
                          options={selectedAgent.regionOptions}
                          onChange={(next) => setAgentRegion(next)}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div className="st-sub-panel-actions">
                    <Button variant="primary" icon={<LogIn size={13} />} disabled={!!busy} onClick={() => void loginAgent(selectedAgent)}>
                      {selectedAgent.login === 'device' ? '浏览器登录' : selectedAgent.login === 'oauth' ? '使用 Google 登录' : '浏览器登录'}
                    </Button>
                  </div>
                </div>
              ) : null}
              {selectedAgent.tokenLogin ? (
                <div className="st-sub-connect-item is-stacked">
                  <div>
                    <strong>使用 API Key 连接</strong>
                    <span>{selectedAgent.tokenLogin.help ?? '直接粘贴长期密钥；只保存在本机。'}</span>
                  </div>
                  <div className="st-sub-form-grid">
                    <TextInput
                      label={selectedAgent.tokenLogin.label}
                      value={agentToken}
                      onChange={(event) => setAgentToken(event.target.value)}
                      placeholder={selectedAgent.tokenLogin.placeholder}
                      spellCheck={false}
                    />
                  </div>
                  <div className="st-sub-panel-actions">
                    <Button variant={selectedAgent.login === 'local' ? 'primary' : 'secondary'} icon={<KeyRound size={13} />} disabled={!!busy} onClick={() => void loginAgentToken(selectedAgent)}>校验并连接</Button>
                  </div>
                </div>
              ) : null}
              {selectedAgent.localImport ? (
                <div className="st-sub-connect-item">
                  <div>
                    <strong>导入本机登录</strong>
                    <span>{selectedAgent.localImport.available ? '检测到本机登录态，只读导入。' : `未检测到本机登录态（${selectedAgent.localImport.path}）。`}</span>
                  </div>
                  <Button variant="secondary" icon={<Download size={13} />} disabled={!!busy || !selectedAgent.localImport.available} onClick={() => void importAgentLocal(selectedAgent)}>导入</Button>
                </div>
              ) : null}
            </div>
          </section>
        )}
        <p className="st-sub-disclaimer"><ShieldCheck size={13} aria-hidden /> {status?.disclaimer}</p>
      </div>
    )
  }

  if (view.kind === 'qoder' && qoder) {
    return (
      <div className="st-subs">
        <button type="button" className="st-sub-back" onClick={() => { setView({ kind: 'hub' }); setTest(null); setError(null); setQoderPatOpen(false) }}>
          <ArrowLeft size={13} strokeWidth={1.7} aria-hidden /> 返回订阅
        </button>
        <div className="st-sub-detail-head">
          <span className="st-sub-brand is-large"><Globe2 size={22} strokeWidth={1.6} aria-hidden /></span>
          <div>
            <h3>Qoder 订阅</h3>
            <p>Qoder CLI 账号的订阅额度；专用协议代理把 Qoder 上游转换为 Morrow 可用的模型。</p>
          </div>
          <Badge tone={qoder.connected ? 'success' : 'neutral'}>{qoder.connected ? '已连接' : '未连接'}</Badge>
        </div>
        {error ? <p className="st-error" role="alert">{error}</p> : null}
        {busyRow('qoder')}

        {qoder.connected ? (
          <>
            <section className="st-sub-panel">
              <div className="st-sub-panel-head">
                <span>账号</span>
                {qoder.account?.email ? <span className="mono">{qoder.account.email}</span> : null}
              </div>
              <div className="st-sub-account-grid">
                <div><span>区域</span><strong>{qoderRegionLabel(qoder.account?.region)}</strong></div>
                <div><span>登录方式</span><strong>{qoderSourceLabel(qoder.account?.source)}</strong></div>
                <div><span>账号 ID</span><strong className="mono">{qoder.account?.uid?.slice(-8) ?? '—'}</strong></div>
                <div><span>凭据到期</span><strong>{qoder.account?.expiresAt ? new Date(qoder.account.expiresAt).toLocaleDateString('zh-CN') : '自动续期'}</strong></div>
              </div>
              {qoder.account?.sourcePath ? <p className="st-sub-note mono">只读导入：{qoder.account.sourcePath}</p> : null}
            </section>

            <section className="st-sub-panel">
              <div className="st-sub-panel-head">
                <span>订阅额度</span>
                <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} disabled={!!busy} onClick={() => void act({ action: 'refresh-qoder' }, { done: '刷新额度…', keepView: true })}>刷新</Button>
              </div>
              {qoder.quota?.buckets.length ? (
                <div className="st-sub-windows">
                  {qoder.quota.buckets.map((bucket) => <QoderBucket key={bucket.kind} bucket={bucket} />)}
                </div>
              ) : (
                <p className="st-sub-empty">{qoder.quota?.message ?? '还没有读取到额度。点击刷新，或确认系统代理可访问 Qoder。'}</p>
              )}
              {qoder.quota?.expiresAt ? <p className="st-sub-note">额度周期结束：{new Date(qoder.quota.expiresAt).toLocaleDateString('zh-CN')}</p> : null}
            </section>

            <section className="st-sub-panel">
              <div className="st-sub-panel-head"><span>可用模型</span><span className="mono">{qoder.models.length} 个</span></div>
              <div className="st-sub-model-list">
                {qoder.models.map((model) => {
                  const options = model.contextOptions ?? []
                  const defaultValue = model.defaultContextWindow ?? model.contextWindow
                  return (
                    <div className="st-sub-model-row" key={model.id}>
                      <span>{model.label}</span>
                      {options.length > 0 ? (
                        <div className="st-sub-model-context">
                          <Select
                            ariaLabel={`${model.label} 上下文上限`}
                            value={String(defaultValue)}
                            options={options.map((value) => ({
                              value: String(value),
                              label: value >= 1_000_000 && value % 1_000_000 === 0 ? `${value / 1_000_000}M` : `${Math.round(value / 1000)}K`
                            }))}
                            onChange={(next) => {
                              void act(
                                { action: 'set-qoder-context', modelId: model.id, contextWindow: Number(next) },
                                { done: '更新上下文档位…', keepView: true }
                              )
                            }}
                          />
                        </div>
                      ) : (
                        <em>{Math.round((model.defaultContextWindow ?? model.contextWindow) / 1000)}K</em>
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="st-sub-note">模型实际可用性由 Qoder 套餐与上游策略决定；在对话模型选择器中选择「Qoder（订阅）」即可使用。</p>
            </section>

            <section className="st-sub-panel">
              <Switch
                checked={qoder.enabled}
                onChange={(enabled) => void act({ action: 'set-qoder-enabled', enabled }, { done: enabled ? '启用订阅…' : '停用订阅…', keepView: true })}
                label="在模型选择器中启用"
                description="关闭后不再向 Agent 暴露这套订阅模型；登录态和额度记录保留。"
              />
              <div className="st-sub-panel-actions">
                <Button size="sm" variant="secondary" icon={<Gauge size={12} />} disabled={!!busy} onClick={() => void act({ action: 'test-qoder' }, { done: '测试连接…', keepView: true })}>测试连接</Button>
                <Button size="sm" variant="ghost" icon={<LogIn size={12} />} disabled={!!busy && !qoderLoginWaiting} onClick={() => void loginQoderDevice()}>{qoderLoginWaiting ? '重新打开登录页面' : '浏览器重新登录'}</Button>
                {qoder.localImport?.available ? (
                  <Button size="sm" variant="ghost" icon={<Download size={12} />} disabled={!!busy} onClick={() => void importQoderLocal()}>重新导入本机登录</Button>
                ) : null}
                <Button size="sm" variant="ghost" icon={<KeyRound size={12} />} disabled={!!busy} onClick={() => setQoderPatOpen((open) => !open)}>替换 PAT</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={12} />}
                  disabled={!!busy}
                  onClick={() => {
                    if (!window.confirm('移除 Qoder 订阅？会删除本机保存的登录态与 Provider，不会影响你的 Qoder 账号。')) return
                    void act({ action: 'remove-qoder' }, { done: '移除订阅…' })
                  }}
                >
                  移除订阅
                </Button>
              </div>
              {qoderPatOpen ? (
                <div className="st-sub-replace">
                  <div className="st-sub-form-grid">
                    <div className="field">
                      <span className="field-label">PAT 区域</span>
                      <Select
                        ariaLabel="Qoder PAT 区域"
                        value={qoderRegion}
                        options={[{ value: 'cn', label: '中国站（qoder.com.cn）' }, { value: 'global', label: '全球区（qoder.com）' }]}
                        onChange={(next) => setQoderRegion(next as 'global' | 'cn')}
                      />
                    </div>
                    <TextInput
                      label="新的 PAT"
                      type="password"
                      value={qoderPat}
                      onChange={(event) => setQoderPat(event.target.value)}
                      placeholder="pt-…（只保存在本机）"
                      autoComplete="off"
                    />
                  </div>
                  <div className="st-sub-panel-actions">
                    <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void loginQoderPat()}>用 PAT 重新连接</Button>
                    <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void openExternal(qoder.patUrl)} icon={<ExternalLink size={12} />}>打开 PAT 页面</Button>
                  </div>
                </div>
              ) : null}
              {test ? <p className={test.ok ? 'st-sub-ok' : 'st-sub-error'}>{test.ok ? <Check size={12} /> : <X size={12} />}{test.message}{test.latencyMs ? ` · ${test.latencyMs}ms` : ''}</p> : null}
            </section>
          </>
        ) : (
          <section className="st-sub-panel st-sub-connect">
            <p>Qoder 的登录方式与其他 Agent 不同：全球区支持浏览器设备流，中国站和全球区都支持 PAT，也可以直接读取本机 qodercli 的登录态。Morrow 不会读取密码。</p>
            <div className="st-sub-connect-list">
              <div className="st-sub-connect-item">
                <div>
                  <strong>浏览器登录</strong>
                  <span>打开 Qoder 授权页完成设备登录，仅全球区可用。</span>
                </div>
                <Button variant="primary" icon={<LogIn size={13} />} disabled={!!busy && !qoderLoginWaiting} onClick={() => void loginQoderDevice()}>{qoderLoginWaiting ? '重新打开登录页面' : '浏览器登录（全球区）'}</Button>
              </div>
              <div className="st-sub-connect-item is-stacked">
                <div>
                  <strong>Personal Access Token</strong>
                  <span>中国站与全球区分别签发 PAT；区域选错会兑换失败。</span>
                </div>
                <div className="st-sub-form-grid">
                  <div className="field">
                    <span className="field-label">PAT 区域</span>
                    <Select
                      ariaLabel="Qoder PAT 区域"
                      value={qoderRegion}
                      options={[{ value: 'cn', label: '中国站（qoder.com.cn）' }, { value: 'global', label: '全球区（qoder.com）' }]}
                      onChange={(next) => setQoderRegion(next as 'global' | 'cn')}
                    />
                  </div>
                  <TextInput
                    label="PAT"
                    type="password"
                    value={qoderPat}
                    onChange={(event) => setQoderPat(event.target.value)}
                    placeholder="pt-…（只保存在本机）"
                    autoComplete="off"
                  />
                </div>
                <div className="st-sub-panel-actions">
                  <Button variant="secondary" icon={<KeyRound size={13} />} disabled={!!busy} onClick={() => void loginQoderPat()}>连接 PAT</Button>
                  <Button variant="ghost" icon={<ExternalLink size={13} />} disabled={!!busy} onClick={() => void openExternal(qoder.patUrl)}>获取 PAT</Button>
                </div>
              </div>
              <div className="st-sub-connect-item">
                <div>
                  <strong>导入本机 qodercli</strong>
                  <span>
                    {qoder.localImport?.available
                      ? '已检测到本机登录态，只读导入，不会修改 qodercli 的文件。'
                      : '未检测到本机登录态；请先在 Qoder CLI 登录一次。'}
                  </span>
                </div>
                <Button variant="secondary" icon={<Download size={13} />} disabled={!!busy || !qoder.localImport?.available} onClick={() => void importQoderLocal()}>导入本机登录</Button>
              </div>
            </div>
            <p className="st-sub-note">本机凭据路径：<span className="mono">{qoder.localImport?.path ?? '~/.qoder/.auth/user'}</span></p>
          </section>
        )}
        <p className="st-sub-disclaimer"><ShieldCheck size={13} aria-hidden /> {status?.disclaimer}</p>
      </div>
    )
  }

  if (view.kind === 'custom') {
    return (
      <div className="st-subs">
        <button type="button" className="st-sub-back" onClick={() => { setView({ kind: 'hub' }); setError(null); setTest(null) }}>
          <ArrowLeft size={13} strokeWidth={1.7} aria-hidden /> 返回订阅
        </button>
        <div className="st-sub-detail-head">
          <span className="st-sub-brand is-large"><KeyRound size={22} strokeWidth={1.6} aria-hidden /></span>
          <div>
            <h3>{form.id ? '编辑第三方订阅' : '添加第三方订阅'}</h3>
            <p>适用于 Kimi Code、GLM Coding Plan、MiniMax Code、Cline Pass 等兼容 coding plan；token 会加密保存。</p>
          </div>
        </div>
        {error ? <p className="st-error" role="alert">{error}</p> : null}
        <section className="st-sub-panel">
          <div className="st-sub-form-grid">
            <TextInput label="订阅名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如 Kimi Code / GLM Coding Plan" />
            <div className="field">
              <span className="field-label">协议</span>
              <Select
                ariaLabel="订阅协议"
                value={form.protocol}
                options={[
                  { value: 'openai-compat', label: 'OpenAI Chat Completions' },
                  { value: 'anthropic', label: 'Anthropic Messages' }
                ]}
                onChange={(next) => setForm({ ...form, protocol: next as SubscriptionProtocol })}
              />
            </div>
            <TextInput label="接口地址" value={form.baseUrl} mono onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://provider.example.com/v1" />
            <TextInput
              label={form.id ? '替换 token / API Key' : 'token / API Key'}
              type="password"
              value={form.apiKey}
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              placeholder={form.id ? '留空保留已保存的 token' : '只保存在本机，不写入日志'}
              autoComplete="off"
            />
          </div>
          <TextArea
            label="模型 ID（每行一个）"
            rows={6}
            value={form.models.join('\n')}
            onChange={(event) => setForm({ ...form, models: event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) })}
            placeholder={'kimi-k2\nkimi-k2-turbo'}
            hint="这些模型会出现在模型选择器的自定义 Provider 中。上下文窗口等细节可在「设置 → 模型」里继续调整。"
          />
          <div className="st-sub-panel-actions">
            <Button variant="primary" disabled={!!busy} onClick={() => void saveCustom()}>{busy ?? (form.id ? '保存修改' : '添加订阅')}</Button>
            <Button variant="ghost" disabled={!!busy} onClick={() => setView({ kind: 'hub' })}>取消</Button>
          </div>
        </section>
        {selectedCustom ? (
          <section className="st-sub-panel">
            <Switch
              checked={selectedCustom.provider?.enabled === true}
              onChange={(enabled) => void act({ action: 'set-custom-enabled', id: selectedCustom.record.id, enabled }, { done: enabled ? '启用订阅…' : '停用订阅…', keepView: true })}
              label="在模型选择器中启用"
              description="关闭后保留 token 和模型配置，但不向 Agent 暴露。"
            />
            <div className="st-sub-panel-actions">
              <Button size="sm" variant="secondary" icon={<Gauge size={12} />} disabled={!!busy} onClick={() => void act({ action: 'test-custom', id: selectedCustom.record.id }, { done: '测试连接…', keepView: true })}>测试连接</Button>
              <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} disabled={!!busy} onClick={() => {
                if (!window.confirm(`移除订阅「${selectedCustom.record.name}」？会删除对应的 Provider 与本地 token。`)) return
                void act({ action: 'remove-custom', id: selectedCustom.record.id }, { done: '移除订阅…' })
              }}>移除订阅</Button>
            </div>
            {test ? <p className={test.ok ? 'st-sub-ok' : 'st-sub-error'}>{test.ok ? <Check size={12} /> : <X size={12} />}{test.message}{test.latencyMs ? ` · ${test.latencyMs}ms` : ''}</p> : null}
          </section>
        ) : null}
        <p className="st-sub-disclaimer"><ShieldCheck size={13} aria-hidden /> {status?.disclaimer}</p>
      </div>
    )
  }

  return (
    <div className="st-subs">
      {error ? <p className="st-error" role="alert">{error}</p> : null}
      {busy ? <p className="st-sub-busy"><LoaderCircle size={13} className="st-sub-spin" aria-hidden /> {busy}</p> : null}
      <section className="st-sub-section">
        <div className="st-sub-section-head">
          <span>官方 Agent 应用</span>
          <span>使用你已有的订阅</span>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} disabled={!!busy} onClick={() => void load()}>刷新</Button>
        </div>
        {codex ? <CodexSummary codex={codex} onOpen={() => { setView({ kind: 'codex' }); setError(null); setTest(null) }} /> : <p className="st-sub-empty">正在读取 Codex 订阅状态…</p>}
        {qoder ? <QoderSummary qoder={qoder} onOpen={() => { setView({ kind: 'qoder' }); setError(null); setTest(null) }} /> : <p className="st-sub-empty">正在读取 Qoder 订阅状态…</p>}
        {agents.map((agent) => (
          <AgentSummary key={agent.id} agent={agent} onOpen={() => { setView({ kind: 'agent', id: agent.id }); setError(null); setTest(null) }} />
        ))}
      </section>
      <section className="st-sub-section">
        <div className="st-sub-section-head">
          <span>第三方 coding plan</span>
          <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => openCustom()}>添加订阅</Button>
        </div>
        {custom.length > 0 ? (
          <div className="st-sub-list">
            {custom.map((item) => <CustomSummary key={item.record.id} item={item} onOpen={() => openCustom(item.record)} />)}
          </div>
        ) : (
          <div className="st-sub-empty-card">
            <KeyRound size={18} strokeWidth={1.5} aria-hidden />
            <p>还没有第三方订阅。把 coding plan 的兼容接口、token 和模型 ID 添加进来，即可在对话里使用。</p>
            <Button size="sm" variant="secondary" icon={<Plus size={12} />} onClick={() => openCustom()}>添加第三方订阅</Button>
          </div>
        )}
      </section>
      <p className="st-sub-disclaimer"><ShieldCheck size={13} aria-hidden /> {status?.disclaimer ?? '订阅凭据只保存在本机；Morrow 不代充、不共享账号、不绕过服务商限制。'}</p>
    </div>
  )
}

const TABS: { id: SettingsTabId; label: string; icon: React.ReactNode }[] = [
  { id: 'models', label: '模型', icon: <Plug size={15} strokeWidth={1.5} /> },
  { id: 'subscriptions', label: '订阅', icon: <BadgeCheck size={15} strokeWidth={1.5} /> },
  { id: 'media', label: '多媒体', icon: <Clapperboard size={15} strokeWidth={1.5} /> },
  { id: 'search', label: '联网搜索', icon: <Globe size={15} strokeWidth={1.5} /> },
  { id: 'context', label: '上下文', icon: <Gauge size={15} strokeWidth={1.5} /> },
  { id: 'style', label: '回答', icon: <MessageSquareText size={15} strokeWidth={1.5} /> },
  { id: 'usage', label: '用量', icon: <Activity size={15} strokeWidth={1.5} /> },
  { id: 'archive', label: '归档', icon: <Archive size={15} strokeWidth={1.5} /> },
  { id: 'permission', label: '权限', icon: <Shield size={15} strokeWidth={1.5} /> },
  { id: 'automation', label: '自动化', icon: <Zap size={15} strokeWidth={1.5} /> },
  { id: 'tools', label: '功能与工具', icon: <Layers size={15} strokeWidth={1.5} /> },
  { id: 'terminal', label: '终端', icon: <SquareTerminal size={15} strokeWidth={1.5} /> },
  { id: 'appearance', label: '外观', icon: <Palette size={15} strokeWidth={1.5} /> },
  { id: 'shortcuts', label: '快捷键', icon: <Keyboard size={15} strokeWidth={1.5} /> },
  { id: 'about', label: '关于', icon: <Info size={15} strokeWidth={1.5} /> }
]

const PAGE_META: Record<SettingsTabId, { title: string; description: string }> = {
  models: { title: '模型', description: '选一家服务，填上 API Key 就能用。密钥只保存在本机，不会显示出来。' },
  subscriptions: { title: '模型订阅', description: '把已经在用的官方 Agent 账号或第三方 coding plan 接入 Morrow，按订阅额度调用；登录态只保存在本机。' },
  media: { title: '多媒体', description: '连接电脑上的 ComfyUI、llama.cpp 等引擎，让 Morrow 可以生成和剪辑图片、视频与音频。' },
  search: { title: '联网搜索', description: '遇到最新信息、事实核查或资料查询时，自动搜索网页并总结关键来源。' },
  context: { title: '上下文占用', description: '当前对话的上下文用量，以及自动压缩和项目规则。' },
  style: { title: '回答', description: '调整回答风格、发送方式与对话偏好。' },
  usage: { title: 'Token 活动', description: '按天统计真实 token 用量；服务商没有返回时会标成估算。' },
  archive: { title: '归档', description: '归档的对话仍保存在本机，可以随时恢复或永久删除。' },
  permission: { title: '权限', description: '决定 Morrow 能做什么，以及哪些动作需要先问你。' },
  automation: { title: '自动化', description: '自定义命令、集群成员与自动动作。' },
  tools: { title: '功能与工具', description: '记忆、项目、技能、外部工具等入口都在这里。' },
  terminal: { title: '终端', description: '选择默认终端；终端面板、命令和后台任务都会使用它。' },
  appearance: { title: '外观', description: '主题、字号与字体，改动即时生效。' },
  shortcuts: { title: '快捷键', description: '现在能用的快捷键，以及它们的生效范围。' },
  about: { title: '关于', description: '版本、运行环境与数据目录。' }
}

function InlineError({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null
  return (
    <p className="st-error" role="alert">
      {message}
    </p>
  )
}

const CATEGORY_ORDER: { id: ProviderCategory; label: string; hint: string }[] = [
  { id: 'cn', label: '国内', hint: '国内直连，充值方便' },
  { id: 'global', label: '国际', hint: '海外服务商，可能需要网络代理' },
  { id: 'local', label: '本地', hint: '跑在自己的电脑上，不需要联网' },
  { id: 'custom', label: '自定义', hint: '你自己添加的 OpenAI 兼容服务' }
]

function providerCategory(provider: ProviderConfig): ProviderCategory {
  if (provider.category) return provider.category
  return provider.isBuiltin ? 'global' : 'custom'
}

function providerStateText(provider: ProviderConfig): string {
  if (provider.category === 'local') return provider.apiKeyStored ? 'Key 已保存' : '本地服务'
  return provider.apiKeyStored ? 'Key 已保存' : '未连接'
}

/** 模型服务的一句话说明：让第一次配置的人知道该选哪家。 */
const PROVIDER_HINT: Record<string, string> = {
  deepseek: '便宜、长上下文，适合大多数任务',
  kimi: '长文档与代码，国内直连',
  qwen: '阿里云通义千问，国内直连',
  glm: '智谱 GLM，国内直连',
  minimax: '长上下文，适合长任务与工具调用',
  mimo: '小米 MiMo，擅长工具调用与推理',
  anthropic: 'Claude，写代码与长任务',
  openai: 'OpenAI GPT 系列',
  gemini: 'Google Gemini，超长上下文',
  xai: 'xAI Grok（Grok 4.6 / 4.7）',
  meta: 'Meta 的长任务与编程模型',
  ollama: '本机运行，不需要联网',
  lmstudio: '本机运行，不需要联网'
}

function ModelsTab(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const saveProvider = useAppStore((s) => s.saveProvider)
  const removeProvider = useAppStore((s) => s.removeProvider)
  const testProvider = useAppStore((s) => s.testProvider)
  const setModel = useAppStore((s) => s.setModel)
  const syncModels = useAppStore((s) => s.syncModels)

  const providers = useMemo(
    () => settings.providers.filter((provider) => provider.kind !== 'demo'),
    [settings.providers]
  )
  const defaultProviderId =
    settings.providers.find((p) => p.id === settings.defaultModel.providerId)?.id ?? providers[0]?.id ?? ''
  const [selectedId, setSelectedId] = useState(defaultProviderId)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null)
  const [syncNote, setSyncNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [clearKeyArmed, setClearKeyArmed] = useState(false)

  const [customModelId, setCustomModelId] = useState('')
  const [customModelCtx, setCustomModelCtx] = useState('131072')
  const [customModelOut, setCustomModelOut] = useState('32768')
  const [addingModel, setAddingModel] = useState(false)

  const [customOpen, setCustomOpen] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [customModels, setCustomModels] = useState('')
  const [customKey, setCustomKey] = useState('')
  const [customError, setCustomError] = useState<string | null>(null)
  const [customSaving, setCustomSaving] = useState(false)

  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const actionSeq = useRef(0)

  const provider = providers.find((p) => p.id === selectedId) ?? providers[0] ?? null
  const category = provider ? providerCategory(provider) : 'custom'
  const supportsCustomModelId = category === 'local' || category === 'custom'
  const categoryMeta = CATEGORY_ORDER.find((group) => group.id === category)
  // 只渲染当前选中的服务；服务列表收进上方选择器，页面不再堆十几张可展开卡片。
  const groups = provider
    ? [{ id: category, label: categoryMeta?.label ?? '自定义', hint: categoryMeta?.hint ?? '', items: [provider] }]
    : []
  const providerOptions = providers.map((item) => {
    const itemCategory = providerCategory(item)
    const itemCategoryMeta = CATEGORY_ORDER.find((group) => group.id === itemCategory)
    const state = item.apiKeyStored ? 'Key 已保存' : itemCategory === 'local' ? '本地运行' : '未连接'
    return {
      value: item.id,
      label: item.id === 'deepseek' ? `${item.name} · 推荐` : item.name,
      description: `${state} · ${PROVIDER_HINT[item.id] ?? itemCategoryMeta?.hint ?? 'OpenAI 兼容服务'}`
    }
  })

  useEffect(() => {
    if (!provider) return
    // 切换服务商后，上一家还在飞的测试/同步/保存结果都不再属于当前表单
    actionSeq.current += 1
    setBaseUrl(provider.baseUrl)
    setApiKey('')
    setShowKey(false)
    setSaving(false)
    setTesting(false)
    setSyncing(false)
    setAddingModel(false)
    setTestResult(null)
    setSyncNote(null)
    setError(null)
    setFlash(null)
    setConfirmDeleteId(null)
    setClearKeyArmed(false)
    setCustomModelId('')
    // 仅在切换 provider 时重置表单
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id])

  useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => setFlash(null), 2600)
    return () => window.clearTimeout(timer)
  }, [flash])

  const beginAction = (): { seq: number; targetId: string } => {
    const seq = ++actionSeq.current
    return { seq, targetId: provider?.id ?? '' }
  }
  const isCurrentAction = (seq: number, targetId: string): boolean =>
    seq === actionSeq.current && selectedIdRef.current === targetId

  const handleTest = async (): Promise<void> => {
    if (!provider) return
    const { seq, targetId } = beginAction()
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      const result = await testProvider({
        providerId: provider.id,
        config: { ...provider, baseUrl: baseUrl.trim() || provider.baseUrl, enabled: true },
        apiKey: apiKey.trim() || undefined
      })
      if (isCurrentAction(seq, targetId)) setTestResult(result)
    } catch (err) {
      if (isCurrentAction(seq, targetId)) {
        setTestResult({ ok: false, latencyMs: 0, message: errorText(err, '测试连接失败。') })
      }
    } finally {
      if (seq === actionSeq.current) setTesting(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!provider) return
    const { seq, targetId } = beginAction()
    setSaving(true)
    setError(null)
    setSyncNote(null)
    try {
      const config: ProviderConfig = {
        ...provider,
        baseUrl: baseUrl.trim() || provider.baseUrl,
        enabled: true
      }
      await saveProvider({ config, apiKey: apiKey.trim() ? apiKey.trim() : undefined })
      if (isCurrentAction(seq, targetId)) {
        setApiKey('')
        setFlash('已保存并生效')
        setTestResult(null)
      }
    } catch (err) {
      if (isCurrentAction(seq, targetId)) setError(errorText(err, '模型连接保存失败。'))
    } finally {
      if (seq === actionSeq.current) setSaving(false)
    }
  }

  const handleClearKey = async (): Promise<void> => {
    if (!provider) return
    const { seq, targetId } = beginAction()
    setSaving(true)
    setError(null)
    setSyncNote(null)
    try {
      // 只清密钥，不用表单里尚未保存的 Base URL 覆盖已保存配置
      await saveProvider({ config: { ...provider, enabled: true }, apiKey: '' })
      if (isCurrentAction(seq, targetId)) {
        setApiKey('')
        setClearKeyArmed(false)
        setTestResult(null)
        setFlash('已清除保存的密钥')
      }
    } catch (err) {
      if (isCurrentAction(seq, targetId)) setError(errorText(err, '清除密钥失败。'))
    } finally {
      if (seq === actionSeq.current) setSaving(false)
    }
  }

  const handleSync = async (): Promise<void> => {
    if (!provider) return
    setSyncNote(null)
    setError(null)
    if (apiKey.trim()) {
      setSyncNote({ ok: false, text: '检测到还没保存的新 Key：先点「保存连接」，再同步。' })
      return
    }
    if (baseUrl.trim() && baseUrl.trim() !== provider.baseUrl) {
      setSyncNote({ ok: false, text: '检测到还没保存的服务地址：先点「保存连接」，再同步。' })
      return
    }
    const localService =
      category === 'local' || isLocalServiceUrl(baseUrl.trim() || provider.baseUrl, { allowPrivate: true })
    if (!localService && !provider.apiKeyStored) {
      setSyncNote({ ok: false, text: '先保存 API Key（本机或局域网服务可留空），再刷新可用模型。' })
      return
    }
    const { seq, targetId } = beginAction()
    setSyncing(true)
    try {
      const result = await syncModels(provider.id)
      if (!isCurrentAction(seq, targetId)) return
      if (result) {
        setSyncNote({
          ok: true,
          text:
            `同步完成：${result.total} 个模型（新增 ${result.added} / 更新 ${result.updated}）` +
            `${result.truncated ? '，超出上限的模型已省略' : ''}` +
            `${result.skipped ? `，跳过 ${result.skipped} 个无效条目` : ''}。` +
            '服务商返回的上下文与输出上限已更新；未返回的保留本地值。'
        })
      } else {
        setSyncNote({
          ok: false,
          text: '刷新失败。请确认密钥有效、服务地址正确。'
        })
      }
    } finally {
      if (seq === actionSeq.current) setSyncing(false)
    }
  }

  const handleApplyModel = async (target: ProviderConfig, model: ModelInfo): Promise<void> => {
    setError(null)
    try {
      await setModel(model.id, target.id)
      setFlash('已切换默认模型')
    } catch (err) {
      setError(errorText(err, '切换模型失败。'))
    }
  }

  const handleAddModel = async (): Promise<void> => {
    if (!provider) return
    const id = customModelId.trim()
    if (!id) {
      setError('先填一个模型 ID，例如 qwen2.5:7b 或 gpt-4.1。')
      return
    }
    if (provider.models.some((model) => model.id === id)) {
      setError('这个模型 ID 已经在这个提供方里了。')
      return
    }
    const contextWindow = Number(customModelCtx) || 131_072
    const maxOutput = Number(customModelOut) || 32_768
    const inferredEfforts = reasoningEffortsForModel(id, true)
    const supportsReasoning = provider.kind === 'anthropic' || inferredEfforts !== undefined
    const { seq, targetId } = beginAction()
    setAddingModel(true)
    setError(null)
    try {
      const config: ProviderConfig = {
        ...provider,
        enabled: true,
        models: [
          ...provider.models,
          {
            id,
            label: id,
            contextWindow,
            maxOutput,
            supportsTools: true,
            ...(supportsReasoning
              ? {
                  supportsReasoning: true,
                  reasoningStyle: provider.kind === 'anthropic' ? 'thinking' : 'effort',
                  ...(inferredEfforts ? { reasoningEfforts: inferredEfforts } : {})
                }
              : {})
          }
        ]
      }
      await saveProvider({ config })
      await setModel(id, provider.id)
      if (isCurrentAction(seq, targetId)) {
        setCustomModelId('')
        setFlash('已添加模型并切换')
      }
    } catch (err) {
      if (isCurrentAction(seq, targetId)) setError(errorText(err, '添加模型失败。'))
    } finally {
      if (seq === actionSeq.current) setAddingModel(false)
    }
  }

  const handleRemove = async (target: ProviderConfig): Promise<void> => {
    setError(null)
    try {
      await removeProvider(target.id)
      setConfirmDeleteId(null)
      if (target.id === selectedIdRef.current) {
        const fallback = useAppStore.getState().settings.providers.find((p) => p.kind !== 'demo')?.id ?? ''
        setSelectedId(fallback)
      }
    } catch (err) {
      setError(errorText(err, '删除失败。'))
    }
  }

  const handleSaveCustom = async (): Promise<void> => {
    setCustomError(null)
    const name = customName.trim()
    const url = customUrl.trim()
    const modelIds = customModels
      .split(/[,\n，、]/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (!name) return setCustomError('给这个服务起一个名字。')
    if (!/^https?:\/\//i.test(url)) return setCustomError('服务地址需要以 http:// 或 https:// 开头。')
    if (modelIds.length === 0) return setCustomError('至少填一个模型 ID，例如 gpt-4.1。')
    setCustomSaving(true)
    try {
      const config: ProviderConfig = {
        id: `custom-${Date.now().toString(36)}`,
        kind: 'openai-compat',
        name,
        baseUrl: url,
        category: 'custom',
        models: modelIds.map<ModelInfo>((id) => ({
          id,
          label: id,
          contextWindow: 131_072,
          maxOutput: 32_768,
          supportsTools: true
        })),
        apiKeyStored: false,
        enabled: true,
        isBuiltin: false
      }
      await saveProvider({ config, apiKey: customKey.trim() || undefined })
      setCustomOpen(false)
      setCustomName('')
      setCustomUrl('')
      setCustomModels('')
      setCustomKey('')
      setSelectedId(config.id)
      setFlash('已添加自定义服务')
    } catch (err) {
      setCustomError(errorText(err, '自定义服务保存失败。'))
    } finally {
      setCustomSaving(false)
    }
  }

  return (
    <div className="st-models">
      <div className="st-provider-picker">
        <div className="st-provider-picker-copy">
          <span className="st-field-label">服务</span>
          <Select
            value={provider?.id ?? null}
            options={providerOptions}
            onChange={(next) => setSelectedId(next)}
            ariaLabel="选择模型服务"
            width="100%"
          />
        </div>
        <button type="button" className="st-add-provider st-add-provider-inline" onClick={() => setCustomOpen(true)}>
          <Plus size={13} strokeWidth={1.5} aria-hidden />
          自定义服务
        </button>
      </div>

      {groups.map((group) => (
        <section key={group.id} className="st-provider-group" aria-label={group.label}>
          <div className="st-provider-list">
            {group.items.map((item) => {
              const active = provider?.id === item.id
              const isDefault = settings.defaultModel.providerId === item.id
              return (
                <div key={item.id} className={['st-provider', active ? 'is-active' : ''].filter(Boolean).join(' ')}>
                  <div className="st-provider-head is-static">
                    <span className="st-provider-name">{item.name}</span>
                    {isDefault ? <Badge tone="gold">当前</Badge> : null}
                    {!item.enabled ? <span className="st-provider-off mono">未启用</span> : null}
                    <span className="st-provider-models mono">{item.models.length} 个模型</span>
                    <span className={['st-provider-state', item.apiKeyStored ? 'is-on' : ''].join(' ')}>
                      <span className="st-provider-dot" aria-hidden />
                      {providerStateText(item)}
                    </span>
                  </div>

                  {active ? (
                    <div className="st-provider-detail">
                      <div className="st-detail-grid">
                        <div className="st-detail-col">
                          <label className="st-field-label" htmlFor="st-api-key">
                            API Key
                            {category === 'local' ? <span className="st-field-aside">本地服务通常不需要</span> : <span className="st-field-aside">只保存在本机</span>}
                          </label>
                          <div className="st-key-input">
                            <KeyRound size={13} strokeWidth={1.5} aria-hidden />
                            <input
                              id="st-api-key"
                              className="st-key-native mono"
                              type={showKey ? 'text' : 'password'}
                              value={apiKey}
                              autoComplete="off"
                              spellCheck={false}
                              aria-label="API Key"
                              placeholder={item.apiKeyStored ? '已保存，留空表示不修改' : '粘贴 API Key'}
                              onChange={(event) => setApiKey(event.target.value)}
                            />
                            <button
                              type="button"
                              className="st-key-eye"
                              aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                              onClick={() => setShowKey((value) => !value)}
                            >
                              {showKey ? <EyeOff size={13} strokeWidth={1.5} /> : <Eye size={13} strokeWidth={1.5} />}
                            </button>
                          </div>
                        </div>
                        <div className="st-detail-col">
                          <label className="st-field-label" htmlFor="st-base-url">
                            服务地址
                            <span className="st-field-aside">高级，一般不用改</span>
                          </label>
                          <input
                            id="st-base-url"
                            className="st-inline-input mono"
                            value={baseUrl}
                            spellCheck={false}
                            onChange={(event) => setBaseUrl(event.target.value)}
                            aria-label="Base URL"
                          />
                        </div>
                      </div>

                      <div className="st-action-row">
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={testing}
                          icon={<RefreshCw size={13} strokeWidth={1.5} />}
                          onClick={() => void handleTest()}
                        >
                          测试连接
                        </Button>
                        <Button
                          size="sm"
                          variant="gold"
                          loading={saving}
                          icon={<Check size={13} strokeWidth={2} />}
                          onClick={() => void handleSave()}
                        >
                          保存连接
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={syncing}
                          icon={<RefreshCw size={13} strokeWidth={1.5} />}
                          onClick={() => void handleSync()}
                          title="从服务商读取最新可用模型"
                        >
                          刷新可用模型
                        </Button>
                        {item.apiKeyStored ? (
                          clearKeyArmed ? (
                            <span className="st-provider-confirm">
                              清除已保存的密钥？
                              <button type="button" className="st-link-danger" onClick={() => void handleClearKey()}>
                                确认清除
                              </button>
                              <button type="button" className="st-link" onClick={() => setClearKeyArmed(false)}>
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="st-link"
                              onClick={() => setClearKeyArmed(true)}
                              aria-label={`清除 ${item.name} 的密钥`}
                            >
                              清除密钥
                            </button>
                          )
                        ) : null}
                        {!item.isBuiltin ? (
                          confirmDeleteId === item.id ? (
                            <span className="st-provider-confirm">
                              删除这个服务？
                              <button type="button" className="st-link-danger" onClick={() => void handleRemove(item)}>
                                确认删除
                              </button>
                              <button type="button" className="st-link" onClick={() => setConfirmDeleteId(null)}>
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="st-link-danger st-provider-delete"
                              onClick={() => setConfirmDeleteId(item.id)}
                              aria-label={`删除提供方 ${item.name}`}
                            >
                              <Trash2 size={12} strokeWidth={1.5} aria-hidden />
                              删除服务
                            </button>
                          )
                        ) : null}
                      </div>

                      {testResult ? (
                        <p className={['st-test-result', testResult.ok ? 'is-ok' : 'is-error'].join(' ')} role="status">
                          {testResult.ok ? (
                            <BadgeCheck size={13} strokeWidth={1.5} aria-hidden />
                          ) : (
                            <Info size={13} strokeWidth={1.5} aria-hidden />
                          )}
                          {testResult.ok
                            ? `连接正常 · ${testResult.latencyMs}ms${testResult.modelCount ? ` · ${testResult.modelCount} 个模型` : ''}`
                            : testResult.message}
                        </p>
                      ) : null}
                      {syncNote ? (
                        <p className={['st-test-result', syncNote.ok ? 'is-ok' : 'is-error'].join(' ')} role="status">
                          {syncNote.text}
                        </p>
                      ) : null}
                      <InlineError message={error} />
                      {flash ? <p className="st-saved mono">{flash}</p> : null}

                      <div className="st-model-block">
                        <div className="st-model-block-head">
                          <span className="st-field-label">模型</span>
                          <span className="st-model-block-hint">
                            点击切换当前对话的默认模型
                            {item.modelsSyncedAt
                              ? ` · 上次同步 ${new Date(item.modelsSyncedAt).toLocaleString('zh-CN', {
                                  month: 'numeric',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit'
                                })}`
                              : ''}
                          </span>
                        </div>
                        <ul className="st-model-list">
                          {item.models.map((model) => {
                            const isCurrent =
                              settings.defaultModel.providerId === item.id && settings.defaultModel.modelId === model.id
                            return (
                              <li key={model.id}>
                                <button
                                  type="button"
                                  className={['st-model-option', isCurrent ? 'is-current' : ''].filter(Boolean).join(' ')}
                                  aria-pressed={isCurrent}
                                  onClick={() => void handleApplyModel(item, model)}
                                >
                                  <span className={['st-model-radio', isCurrent ? 'is-on' : ''].filter(Boolean).join(' ')} aria-hidden />
                                  <span className="st-model-main">
                                    <span className="st-model-name">{model.label}</span>
                                    <span className="st-model-meta mono">
                                      可处理约 {formatModelWindow(model.contextWindow)} 内容 · 回复最多 {formatModelWindow(model.maxOutput)}
                                      {model.supportsReasoning ? ' · 擅长复杂任务' : ''}
                                    </span>
                                    {model.note ? <span className="st-model-note">{model.note}</span> : null}
                                  </span>
                                  <span className="st-model-id mono">{model.id}</span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                        {supportsCustomModelId ? (
                          <div className="st-custom-model">
                            <span className="st-field-label">自定义模型 ID</span>
                            <div className="st-action-row">
                              <input
                                className="st-inline-input mono"
                                value={customModelId}
                                placeholder="例如 qwen2.5:7b"
                                spellCheck={false}
                                aria-label="自定义模型 ID"
                                onChange={(event) => setCustomModelId(event.target.value)}
                              />
                              <input
                                className="st-inline-input st-inline-input-sm mono"
                                value={customModelCtx}
                                inputMode="numeric"
                                aria-label="上下文窗口"
                                title="上下文窗口（默认 131072）"
                                onChange={(event) => setCustomModelCtx(event.target.value)}
                              />
                              <input
                                className="st-inline-input st-inline-input-sm mono"
                                value={customModelOut}
                                inputMode="numeric"
                                aria-label="最大输出"
                                title="最大输出（默认 32768）"
                                onChange={(event) => setCustomModelOut(event.target.value)}
                              />
                              <Button size="sm" variant="secondary" loading={addingModel} onClick={() => void handleAddModel()}>
                                添加
                              </Button>
                            </div>
                            <p className="st-hint st-custom-model-hint">
                              本地模型 ID 以本机加载为准；上下文/输出可留空，默认 131072 / 32768。
                            </p>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {customOpen ? (
        <div className="st-custom">
          <div className="st-custom-head">
            <span className="st-section-title">添加自定义服务</span>
            <button type="button" className="st-link" onClick={() => setCustomOpen(false)}>
              取消
            </button>
          </div>
          <p className="st-hint st-custom-hint">如果你用的服务不在上面，填服务地址和模型 ID 就能接上。</p>
          <div className="st-row">
            <TextInput
              label="名称"
              placeholder="例如 公司网关"
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
            />
            <TextInput
              label="服务地址"
              placeholder="https://your-gateway/v1"
              mono
              value={customUrl}
              onChange={(event) => setCustomUrl(event.target.value)}
            />
          </div>
          <TextInput
            label="模型 ID（用逗号分开）"
            placeholder="gpt-4.1, gpt-4.1-mini"
            mono
            value={customModels}
            onChange={(event) => setCustomModels(event.target.value)}
          />
          <div className="st-key-field">
            <label className="st-field-label" htmlFor="st-custom-key">
              API Key（可留空，稍后再填）
            </label>
            <div className="st-key-input">
              <Globe size={13} strokeWidth={1.5} aria-hidden />
              <input
                id="st-custom-key"
                className="st-key-native mono"
                type="password"
                value={customKey}
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-…"
                onChange={(event) => setCustomKey(event.target.value)}
              />
            </div>
          </div>
          <InlineError message={customError} />
          <div className="st-custom-actions">
            <Button size="sm" variant="gold" loading={customSaving} onClick={() => void handleSaveCustom()}>
              保存服务
            </Button>
          </div>
        </div>
      ) : null}

      <p className="st-note">
        演示模式离线可用，不需要 API Key；点「看一场演示」就能体验完整流程。
      </p>
    </div>
  )
}

function ContextTab(): React.JSX.Element {
  const session = useAppStore((s) => s.session)
  const settings = useAppStore((s) => s.settings)
  const compacting = useAppStore(
    (s) => s.compacting && (!s.compactingSessionId || s.compactingSessionId === s.session?.id)
  )
  const run = useAppStore((s) => s.run)
  const runCurrent = !!run && run.sessionId === session?.id
  const compactSession = useAppStore((s) => s.compactSession)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [error, setError] = useState<string | null>(null)
  const [rules, setRules] = useState<{
    files: Array<{ path: string; name: string; scope: 'project' | 'parent' | 'user'; bytes: number; tokens: number; included: boolean; truncated: boolean }>
    usedTokens: number
    limitTokens: number
    truncated: boolean
  } | null>(null)
  const [rulesError, setRulesError] = useState<string | null>(null)
  const [rulesLoading, setRulesLoading] = useState(false)
  const [rulesRefresh, setRulesRefresh] = useState(0)
  const workspace = session?.workspace ?? settings.lastWorkspace ?? null

  useEffect(() => {
    let cancelled = false
    if (!workspace) {
      setRules(null)
      setRulesError(null)
      setRulesLoading(false)
      return
    }
    setRules(null)
    setRulesError(null)
    setRulesLoading(true)
    void window.morrow.features
      .invoke<{
        files: Array<{ path: string; name: string; scope: 'project' | 'parent' | 'user'; bytes: number; tokens: number; included: boolean; truncated: boolean }>
        usedTokens: number
        limitTokens: number
        truncated: boolean
      }>('feature:rules:list', { workspace })
      .then((result) => {
        if (cancelled) return
        if (result.ok) setRules(result.data)
        else setRulesError(result.error.message)
      })
      .catch((err) => {
        if (!cancelled) setRulesError(err instanceof Error ? err.message : '读取规则文件失败')
      })
      .finally(() => {
        if (!cancelled) setRulesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspace, rulesRefresh])

  const model = findModel(settings.providers, session?.model ?? settings.defaultModel)
  const usage = session?.usage
  const effectiveContextWindow = session?.model.contextWindow ?? model?.defaultContextWindow ?? model?.contextWindow
  const snapshot = contextSnapshot(usage, effectiveContextWindow)
  const thresholdPercent = Math.round(settings.compactThreshold * 100)
  const planTokens = Math.round(snapshot.limit * settings.compactThreshold)
  const tone = snapshot.ratio >= 0.85 ? 'is-danger' : snapshot.ratio >= 0.6 ? 'is-warning' : ''
  const compactDisabled = !session || runCurrent || compacting

  const patch = async (value: Parameters<typeof updateSettings>[0]): Promise<void> => {
    setError(null)
    try {
      await updateSettings(value)
    } catch (err) {
      setError(errorText(err, '设置保存失败。'))
    }
  }

  return (
    <div className="st-context">
      {session ? (
        <div className={['st-ctx-card', tone].filter(Boolean).join(' ')}>
          <div className="st-ctx-head">
            <span className="st-section-title">当前对话</span>
            <span className={['st-ctx-source', snapshot.source].join(' ')}>{contextSourceLabel(snapshot.source)}</span>
          </div>
          <div className="st-ctx-numbers">
            <span className="st-ctx-used mono">{formatUsageTokens(snapshot.used)}</span>
            <span className="st-ctx-limit mono"> / {formatUsageTokens(snapshot.limit)}</span>
            <span className="st-ctx-percent mono">{snapshot.percent}%</span>
          </div>
          <div
            className="st-ctx-bar"
            role="progressbar"
            aria-valuenow={snapshot.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="上下文占用"
          >
            <span
              className="st-ctx-bar-fill"
              style={{ width: `${snapshot.used > 0 ? Math.max(1, snapshot.percent) : 0}%` }}
            />
          </div>
          <p className="st-ctx-exact mono">
            精确用量 {formatExactTokens(snapshot.used)} / {formatExactTokens(snapshot.limit)} tokens
            {snapshot.source === 'api' ? ' · 按服务商返回的用量统计' : ' · 服务商暂未返回用量，当前按文字长度估算'}
          </p>
        </div>
      ) : (
        <div className="st-ctx-empty">
          <Gauge size={18} strokeWidth={1.5} aria-hidden />
          <div>
            <p className="st-ctx-empty-title">还没有打开的对话。</p>
            <p className="st-hint">
              新建或打开一个对话后，这里会显示它的上下文占用与 token 累计。下面的自动压缩设置对所有对话生效。
            </p>
          </div>
        </div>
      )}

      <div className="st-ctx-grid">
        <div className="st-ctx-stat">
          <span className="st-ctx-stat-label">输入 tokens（累计）</span>
          <span className="st-ctx-stat-value mono">{formatExactTokens(usage?.inputTokens ?? 0)}</span>
        </div>
        <div className="st-ctx-stat">
          <span className="st-ctx-stat-label">输出 tokens（累计）</span>
          <span className="st-ctx-stat-value mono">{formatExactTokens(usage?.outputTokens ?? 0)}</span>
        </div>
        <div className="st-ctx-stat">
          <span className="st-ctx-stat-label">其中缓存读取</span>
          <span className="st-ctx-stat-value mono">
            {usage?.cacheReadTokens ? formatExactTokens(usage.cacheReadTokens) : '—'}
          </span>
        </div>
        <div className="st-ctx-stat">
          <span className="st-ctx-stat-label">当前模型</span>
          <span className="st-ctx-stat-value">{model?.label ?? '—'}</span>
        </div>
        <div className="st-ctx-stat">
          <span className="st-ctx-stat-label">上下文窗口</span>
          <span className="st-ctx-stat-value mono" title={formatExactTokens(effectiveContextWindow)}>
            {formatUsageTokens(effectiveContextWindow)}
          </span>
        </div>
        <div className="st-ctx-stat">
          <span className="st-ctx-stat-label">最大输出</span>
          <span className="st-ctx-stat-value mono" title={formatExactTokens(model?.maxOutput)}>
            {formatUsageTokens(model?.maxOutput)}
          </span>
        </div>
        <div className="st-ctx-stat">
          <span className="st-ctx-stat-label">估算费用（累计）</span>
          <span className="st-ctx-stat-value mono">{formatUsd(usage?.costUsd)}</span>
        </div>
      </div>
      <p className="st-hint">
        {model?.pricing
          ? `参考价：输入 $${model.pricing.inputPerMTok}/M tokens，输出 $${model.pricing.outputPerMTok}/M tokens${model.pricing.cacheReadPerMTok !== undefined ? `，缓存命中 $${model.pricing.cacheReadPerMTok}/M` : ''}。实际以服务商账单为准。`
          : '当前模型没有内置参考价，费用显示为 —；token 用量仍会正常累计。'}
      </p>

      <div className="st-ctx-section">
        <p className="st-section-title">自动压缩</p>
        <p className="st-hint">
          上下文接近阈值时，Morrow 会把较早的对话压成摘要并保留最近的内容，让长任务继续跑下去。
        </p>
        <Switch
          checked={settings.autoCompact}
          onChange={(next) => void patch({ autoCompact: next })}
          label="自动压缩上下文"
          description="关闭后不会自动压缩，仍可随时点「立即压缩」"
        />
        <div className={['st-threshold', settings.autoCompact ? '' : 'is-disabled'].filter(Boolean).join(' ')}>
          <div className="st-threshold-head">
            <span className="st-setting-label">压缩阈值</span>
            <span className="st-threshold-value mono">{thresholdPercent}%</span>
          </div>
          <input
            className="st-range"
            type="range"
            min={50}
            max={95}
            step={1}
            value={thresholdPercent}
            disabled={!settings.autoCompact}
            aria-label="自动压缩阈值"
            onChange={(event) => void patch({ compactThreshold: Number(event.target.value) / 100 })}
          />
          <div className="st-threshold-scale mono">
            <span>50%</span>
            <span>95%</span>
          </div>
          <p className="st-ctx-plan mono">
            {snapshot.limit > 0
              ? `约 ${formatUsageTokens(planTokens)} tokens 时触发自动压缩（窗口 ${formatUsageTokens(snapshot.limit)}）`
              : '当前模型上下文窗口未知，暂不估算触发点'}
          </p>
        </div>

        <div className="st-ctx-actions">
          <Button
            size="sm"
            variant="secondary"
            loading={compacting}
            disabled={compactDisabled && !compacting}
            icon={<RefreshCw size={13} strokeWidth={1.5} />}
            onClick={() => void compactSession()}
          >
            {compacting ? '正在压缩…' : '立即压缩'}
          </Button>
          <span className="st-ctx-actions-hint">
            {!session
              ? '先打开一个对话。'
              : run
                ? '生成过程中不能压缩，先停止或等它完成。'
                : compacting
                  ? '正在压缩上下文，稍等。'
                  : '手动触发一次压缩，会保留最近的消息。'}
          </span>
        </div>
        <InlineError message={error} />
      </div>

      <div className="st-ctx-section">
        <div className="st-rules-head">
          <p className="st-section-title">项目规则文件</p>
          {workspace ? (
            <button type="button" className="st-link-btn" onClick={() => setRulesRefresh((value) => value + 1)}>
              刷新
            </button>
          ) : null}
        </div>
        <p className="st-hint">
          自动发现 AGENTS.md / CLAUDE.md / MORROW.md（文件夹、上级目录与用户目录），按优先级带进对话。也可以在输入框用
          <span className="mono"> /init </span>让 Morrow 分析项目并生成或更新规则文件。
        </p>
        {rules && rules.files.length > 0 ? (
          <>
            <p className="st-rules-budget mono">
              已使用 {formatUsageTokens(rules.usedTokens)} / {formatUsageTokens(rules.limitTokens)} tokens
              {rules.truncated ? ' · 已按预算截断' : ''}
            </p>
            <ul className="st-rules-list">
              {rules.files.map((file) => (
                <li key={file.path} className={file.included ? '' : 'is-skipped'}>
                  <span className="mono st-rules-scope">
                    {file.scope === 'project' ? '项目' : file.scope === 'parent' ? '上级' : '用户'}
                  </span>
                  <span className="st-rules-main">
                    <span className="st-rules-name">{file.name}</span>
                    <span className="st-rules-path mono">{file.path}</span>
                  </span>
                  <span className="st-rules-meta mono">
                    {file.included ? `${file.tokens} tokens` : '超出上限'}
                    {file.truncated ? ' · 只取一部分' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : rulesLoading ? (
          <p className="st-hint">正在读取规则文件…</p>
        ) : (
          <p className="st-hint">{workspace ? '还没有项目说明文件。可以用 /init 生成一个。' : '先打开一个对话或选择文件夹。'}</p>
        )}
        <InlineError message={rulesError} />
      </div>

    </div>
  )
}

const PERMISSION_CARDS = [
  {
    mode: 'read-only' as const,
    label: '只读',
    description: '只能查看文件内容。任何写入、删除、命令执行都会被直接拒绝。'
  },
  {
    mode: 'ask' as const,
    label: '询问',
    description: '当前文件夹内的写入和命令自动执行；危险命令、外部操作或访问文件夹外时仍会先问你。'
  },
  {
    mode: 'auto' as const,
    label: '完全访问',
    description: '不再询问：写入、命令、危险操作和访问文件夹外都直接执行。只在你完全信任的任务里使用。'
  }
]

const TOOL_LABELS: Record<string, string> = {
  run_command: '运行命令',
  terminal: '命令窗口',
  write_file: '写文件',
  edit_file: '改文件',
  write_xlsx: '写 Excel',
  edit_docx: '改 Word',
  read_file: '读取文件',
  list_dir: '查看文件夹',
  search_files: '搜索文件',
  web_search: '联网搜索',
  web_fetch: '读取网页',
  open_artifact: '生成成品'
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

const DANGER_RULES = [
  { title: '删除整个目录', detail: '「询问」档会拦下 rm -rf / del /s 这类命令，等你单独确认；「完全访问」直接执行' },
  { title: '格式化磁盘、关机重启', detail: '「询问」档不会自动执行；「完全访问」直接执行' },
  { title: '文件夹之外的写入', detail: '「询问」档会先问你；「完全访问」直接执行' },
  { title: '联网下载并执行脚本', detail: '「询问」档会展示完整命令后再请求确认；「完全访问」直接执行' }
]

function PermissionTab(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const session = useAppStore((s) => s.session)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const [error, setError] = useState<string | null>(null)
  const current = session?.permissionMode ?? settings.permissionMode
  const workspace = session?.workspace ?? settings.lastWorkspace ?? null
  const [rules, setRules] = useState<PermissionRule[]>([])
  const [log, setLog] = useState<PermissionLogEntry[]>([])
  const [tool, setTool] = useState('run_command')
  const [kind, setKind] = useState<PermissionRuleKind>('prefix')
  const [pattern, setPattern] = useState('')
  const [decision, setDecision] = useState<PermissionRuleDecision>('allow')
  const [busy, setBusy] = useState(false)
  const [ruleError, setRuleError] = useState<string | null>(null)
  const reloadSeq = useRef(0)

  const invoke = async <T,>(channel: string, payload?: unknown): Promise<T> => {
    const result = (await window.morrow.features.invoke(channel, payload)) as import('@shared/types').Result<T>
    if (!result.ok) throw new Error(result.error.message)
    return result.data
  }

  const reload = async (): Promise<void> => {
    if (!workspace) {
      setRules([])
      setLog([])
      return
    }
    const request = ++reloadSeq.current
    try {
      const [ruleResult, logResult] = await Promise.all([
        invoke<{ rules: PermissionRule[] }>('feature:permissions:list-rules', { workspace }),
        invoke<{ entries: PermissionLogEntry[] }>('feature:permissions:list-log', { workspace })
      ])
      // 切换文件夹后，较早的请求不能把旧规则写到新文件夹名下
      if (request !== reloadSeq.current) return
      setRules(ruleResult.rules)
      setLog(logResult.entries)
    } catch (err) {
      if (request === reloadSeq.current) setRuleError(err instanceof Error ? err.message : '读取权限规则失败')
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  const changeTool = (next: string): void => {
    setTool(next)
    if (next === 'run_command' || next === 'terminal') setKind('prefix')
    else if (next === 'write_file' || next === 'edit_file' || next === 'write_xlsx' || next === 'edit_docx') setKind('path')
    else setKind('tool')
  }

  const addRule = async (): Promise<void> => {
    if (!workspace) {
      setRuleError('先打开一个对话或选择文件夹。')
      return
    }
    setBusy(true)
    setRuleError(null)
    try {
      await invoke('feature:permissions:add-rule', { workspace, tool, kind, pattern, decision })
      setPattern('')
      await reload()
    } catch (err) {
      setRuleError(err instanceof Error ? err.message : '添加规则失败')
    } finally {
      setBusy(false)
    }
  }

  const removeRule = async (id: string): Promise<void> => {
    if (!workspace) return
    try {
      await invoke('feature:permissions:remove-rule', { workspace, id })
      await reload()
    } catch (err) {
      setRuleError(err instanceof Error ? err.message : '删除规则失败')
    }
  }

  const kindOptions: Array<{ value: PermissionRuleKind; label: string }> =
    tool === 'run_command' || tool === 'terminal'
      ? [
          { value: 'prefix', label: '命令前缀' },
          { value: 'tool', label: '整个工具' }
        ]
      : [
          { value: 'path', label: '路径前缀' },
          { value: 'tool', label: '整个工具' }
        ]

  const choose = async (mode: (typeof PERMISSION_CARDS)[number]['mode']): Promise<void> => {
    setError(null)
    try {
      await setPermissionMode(mode)
    } catch (err) {
      setError(errorText(err, '权限设置保存失败。'))
    }
  }

  return (
    <div className="st-permission">
      <p className="st-section-title">允许 Morrow 做到哪一步</p>
      <p className="st-hint">默认是「询问」。随时可以改，改完立即对当前对话生效。</p>
      <div className="st-permission-cards" role="radiogroup" aria-label="权限模式">
        {PERMISSION_CARDS.map((card) => {
          const active = current === card.mode
          return (
            <button
              key={card.mode}
              type="button"
              role="radio"
              aria-checked={active}
              className={['st-permission-card', active ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={() => void choose(card.mode)}
            >
              <span className="st-permission-head">
                {card.label}
                {active ? <Check size={14} strokeWidth={2} className="st-permission-check" aria-hidden /> : null}
              </span>
              <span className="st-permission-desc">{card.description}</span>
            </button>
          )
        })}
      </div>
      {current === 'auto' ? (
        <p className="st-warn">
          完全访问下 Morrow 不会停下来确认任何动作，包括删除、越界与联网外发。请只在隔离、可恢复或你完全信任的任务里使用。
        </p>
      ) : null}
      <InlineError message={error} />

      <div className="st-ctx-section">
        <p className="st-section-title">文件夹权限规则</p>
        <p className="st-hint">
          只对当前文件夹生效，拒绝优先；命令规则匹配运行命令，路径规则匹配写文件。「始终允许」会自动保存一条允许规则。
        </p>
        {workspace ? (
          <>
            <div className="st-rule-form">
              <div style={{ width: 150 }}>
                <Select
                  ariaLabel="规则类型"
                  value={tool}
                  options={[
                    { value: 'run_command', label: '运行命令' },
                    { value: 'terminal', label: '命令窗口' },
                    { value: 'write_file', label: '写文件' },
                    { value: 'edit_file', label: '改文件' },
                    { value: 'write_xlsx', label: '写 Excel' },
                    { value: 'edit_docx', label: '改 Word' }
                  ]}
                  onChange={changeTool}
                />
              </div>
              <div style={{ width: 120 }}>
                <Select
                  ariaLabel="权限规则类型"
                  value={kind}
                  options={kindOptions}
                  onChange={(next) => setKind(next)}
                />
              </div>
              <input
                className="text-input mono st-rule-pattern"
                value={pattern}
                placeholder={kind === 'tool' ? '（整个工具规则可留空）' : kind === 'prefix' ? '例如 npm test' : '例如 out/'}
                aria-label="权限规则内容"
                disabled={kind === 'tool'}
                onChange={(event) => setPattern(event.target.value)}
              />
              <Segmented
                ariaLabel="规则动作"
                value={decision}
                options={[
                  { value: 'allow', label: '允许' },
                  { value: 'deny', label: '拒绝' }
                ]}
                onChange={(next) => setDecision(next as PermissionRuleDecision)}
              />
              <Button
                size="sm"
                variant="secondary"
                loading={busy}
                disabled={busy || (kind !== 'tool' && !pattern.trim())}
                onClick={() => void addRule()}
              >
                添加
              </Button>
            </div>
            <ul className="st-perm-rules">
              {rules.length === 0 ? <li className="st-hint">还没有规则。</li> : null}
              {rules.map((rule) => (
                <li key={rule.id}>
                  <span className={['st-rule-decision', rule.decision].join(' ')}>{rule.decision === 'allow' ? '允许' : '拒绝'}</span>
                  <span className="st-rule-summary">
                    {toolLabel(rule.tool)} · {rule.kind === 'prefix' ? '前缀' : rule.kind === 'path' ? '路径' : '工具'}
                    {rule.pattern ? ` · ${rule.pattern}` : ''}
                  </span>
                  <IconButton label="删除这条权限规则" size={24} onClick={() => void removeRule(rule.id)}>
                    <Trash2 size={12} strokeWidth={1.6} />
                  </IconButton>
                </li>
              ))}
            </ul>
            <div className="st-approval-log-head">
              <span className="st-section-title">审批日志</span>
              <button type="button" className="st-link-btn" onClick={() => void reload()}>
                刷新
              </button>
            </div>
            <ul className="st-approval-log">
              {log.length === 0 ? <li className="st-hint">还没有审批记录。</li> : null}
              {log.slice(0, 20).map((entry) => (
                <li key={entry.id}>
                  <span className="mono st-approval-time">
                    {new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="st-approval-tool">{toolLabel(entry.toolName)}</span>
                  <span className="st-approval-title truncate">{entry.title}</span>
                  <span className={`st-rule-decision ${entry.decision === 'deny' ? 'deny' : 'allow'}`}>
                    {entry.decision === 'deny' ? '拒绝' : entry.decision === 'always' ? '始终允许' : '允许一次'}
                  </span>
                </li>
              ))}
            </ul>
            <InlineError message={ruleError} />
          </>
        ) : (
          <p className="st-hint">先打开一个对话或选择文件夹。</p>
        )}
      </div>

      <div className="st-danger">
        <p className="st-section-title">这些动作会被拦下，单独问你</p>
        <ul className="st-danger-list">
          {DANGER_RULES.map((rule) => (
            <li key={rule.title} className="st-danger-item">
              <span className="st-danger-mark" aria-hidden />
              <span className="st-danger-main">
                <span className="st-danger-title">{rule.title}</span>
                <span className="st-danger-detail">{rule.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

const SEARCH_PROVIDERS: Array<{
  value: import('@shared/types').WebSearchProvider
  label: string
  description: string
  needsKey: boolean
}> = [
  { value: 'tavily', label: 'Tavily', description: '专为 AI 搜索准备，摘要质量稳定', needsKey: true },
  { value: 'brave', label: 'Brave Search', description: '独立索引，英文资料更全', needsKey: true },
  { value: 'serper', label: 'Serper', description: '通过 Google 搜索，中文结果丰富', needsKey: true },
  { value: 'searxng', label: 'SearXNG', description: '自己搭建的搜索，可填本机地址', needsKey: false }
]

function SearchTab(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const saveWebSearch = useAppStore((s) => s.saveWebSearch)
  const testWebSearch = useAppStore((s) => s.testWebSearch)
  const openExternal = useAppStore((s) => s.openExternal)
  const saved = settings.webSearch
  const [enabled, setEnabled] = useState(saved.enabled)
  const [provider, setProvider] = useState(saved.provider)
  const [advanced, setAdvanced] = useState(saved.provider !== 'builtin')
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl ?? '')
  const [maxResults, setMaxResults] = useState(String(saved.maxResults))
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<import('@shared/contracts').WebSearchTestResult | null>(null)

  useEffect(() => {
    setEnabled(saved.enabled)
    setProvider(saved.provider)
    setBaseUrl(saved.baseUrl ?? '')
    setMaxResults(String(saved.maxResults))
  }, [saved.enabled, saved.provider, saved.baseUrl, saved.maxResults, saved.apiKeyStored])

  const meta = SEARCH_PROVIDERS.find((item) => item.value === provider) ?? SEARCH_PROVIDERS[0]

  const save = async (thenTest: boolean): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const effectiveProvider = advanced ? provider : 'builtin'
      const ok = await saveWebSearch({
        enabled,
        provider: effectiveProvider,
        ...(advanced && provider === 'searxng' ? { baseUrl } : {}),
        maxResults: Number(maxResults),
        ...(advanced && apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      })
      if (!ok) return
      setApiKey('')
      if (thenTest) setTest(await testWebSearch())
    } catch (err) {
      setError(errorText(err, '保存联网搜索设置失败。'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="st-search">
      <Switch
        checked={enabled}
        onChange={setEnabled}
        label="自动联网搜索"
        description="遇到最新信息、事实核查或资料查询时，Morrow 会自动搜索、阅读关键来源并总结。无需配置。"
      />

      <div className="st-search-advanced">
        <button
          type="button"
          className="st-search-advanced-toggle"
          aria-expanded={advanced}
          onClick={() => setAdvanced((value) => !value)}
        >
          {advanced ? '收起自定义搜索服务' : '自定义搜索服务（可选）'}
        </button>
        {advanced ? (
          <>
            <p className="st-hint">
              只有在你希望使用专用索引（Tavily / Brave / Serper）或自建 SearXNG 时才需要配置；留空则继续使用内置搜索。
            </p>
            <div className="st-setting-row">
              <div className="st-setting-copy">
                <span className="st-setting-label">搜索服务商</span>
                <span className="st-setting-desc">{meta.description}</span>
              </div>
              <div style={{ width: 190 }}>
                <Select
                  ariaLabel="搜索服务商"
                  value={provider}
                  options={SEARCH_PROVIDERS.map((item) => ({
                    value: item.value,
                    label: item.label,
                    description: item.description
                  }))}
                  onChange={(next) => {
                    setProvider(next)
                    setTest(null)
                  }}
                />
              </div>
            </div>

            {provider === 'searxng' ? (
              <TextInput
                label="SearXNG 实例地址"
                mono
                value={baseUrl}
                placeholder="http://127.0.0.1:8888"
                hint="实例需要开启 JSON 输出（format=json），本机或内网地址都行。"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            ) : null}

            <TextInput
              label={provider === 'searxng' ? '访问令牌（可选）' : 'API Key'}
              mono
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={saved.apiKeyStored && provider === saved.provider ? '已保存；留空表示不修改' : '粘贴 API Key'}
              hint={meta.needsKey ? 'Key 由系统加密保存，不会显示在界面或日志里。' : '私有实例需要鉴权时填写。'}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </>
        ) : (
          <p className="st-hint">
            当前使用内置多引擎搜索（Bing / 百度 / DuckDuckGo / Mojeek 自动回退），结果会标出来源；需要正文时 Morrow 会再打开关键页面核对。
          </p>
        )}
      </div>

      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">默认来源数</span>
          <span className="st-setting-desc">模型可以按任务需要少要或多要（最多 10 条）。</span>
        </div>
        <div style={{ width: 120 }}>
          <Select
            ariaLabel="搜索结果数"
            value={maxResults}
            options={['3', '5', '8', '10'].map((value) => ({ value, label: `${value} 条` }))}
            onChange={setMaxResults}
          />
        </div>
      </div>

      <InlineError message={error} />
      {test ? (
        <div className={['st-search-test', test.ok ? 'is-ok' : 'is-error'].join(' ')} role="status">
          <p className="st-search-test-message">{test.ok ? '✓ ' : ''}{test.message}</p>
          {test.ok && test.sources?.length ? (
            <ul className="st-search-sources">
              {test.sources.map((source) => (
                <li key={source.url}>
                  <button type="button" onClick={() => void openExternal(source.url)}>
                    {source.title || source.url}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="st-search-actions">
        <Button variant="ghost" onClick={() => void save(false)} disabled={busy}>
          保存
        </Button>
        <Button variant="gold" onClick={() => void save(true)} disabled={busy}>
          {busy ? '正在保存…' : '保存并测试'}
        </Button>
      </div>
      <p className="st-hint">
        网页内容只当参考资料，不会当成指令；搜索服务只从本机发出请求。
      </p>
    </div>
  )
}

const HOOK_EVENT_OPTIONS: { value: HookEvent; label: string }[] = [
  { value: 'user_prompt_submit', label: '发送消息前' },
  { value: 'post_tool_use', label: '每次工具完成后' },
  { value: 'run_finished', label: '每轮结束后' }
]

interface AgentRoleSummary {
  name: string
  title: string
  description: string
  source: 'builtin' | 'project' | 'user'
}

const HOOK_EVENT_HINT: Record<HookEvent, string> = {
  user_prompt_submit: '返回码 2 会阻止这条消息；其它失败只记录。',
  post_tool_use: '可以读取工具名、参数和结果，不会阻止工具。',
  run_finished: '每轮结束（包括目标续跑轮）后运行一次。'
}

function TerminalTab(): React.JSX.Element {
  const savedShell = useAppStore((s) => s.settings.terminalShell)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [profiles, setProfiles] = useState<TerminalShellProfile[]>([])
  const [fallbackShell, setFallbackShell] = useState('')
  const [wsl, setWsl] = useState<{ installed: boolean; distros: string[] }>({ installed: false, distros: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async (refresh = false): Promise<void> => {
    setLoading(true)
    try {
      const result = (await window.morrow.features.invoke('feature:terminal:profiles', { refresh })) as Result<{
        profiles: TerminalShellProfile[]
        defaultShell: string
        wsl?: { installed: boolean; distros: string[] }
      }>
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setProfiles(result.data.profiles)
      setFallbackShell(result.data.defaultShell)
      setWsl(result.data.wsl ?? { installed: false, distros: [] })
    } catch (err) {
      setError(errorText(err, '读取可用的终端失败。'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const selected = profiles.some((profile) => profile.id === savedShell && !profile.disabled) ? savedShell : fallbackShell
  const meta = profiles.find((profile) => profile.id === selected)
  const isWindows = /Windows/i.test(navigator.userAgent)

  const choose = async (value: string): Promise<void> => {
    setError(null)
    try {
      await updateSettings({ terminalShell: value })
    } catch (err) {
      setError(errorText(err, '保存终端设置失败。'))
    }
  }

  return (
    <div className="st-search">
      <p className="st-hint">选一个默认终端。终端面板、Morrow 运行命令和后台任务都会使用它；命令语法请按对应的终端类型写。</p>

      {loading ? (
        <p className="st-hint">正在读取可用的终端…</p>
      ) : (
        <div className="st-setting-row">
          <div className="st-setting-copy">
            <span className="st-setting-label">默认终端</span>
            <span className="st-setting-desc">
              {meta ? meta.detail : '没有检测到可用的终端。'}
            </span>
          </div>
          <div style={{ width: 220 }}>
            <Select
              ariaLabel="默认终端"
              value={selected}
              options={profiles.map((profile) => ({
                value: profile.id,
                label: profile.label,
                description: profile.detail,
                disabled: profile.disabled
              }))}
              onChange={(next) => void choose(next)}
            />
          </div>
        </div>
      )}

      {isWindows && (!wsl.installed || wsl.distros.length === 0) ? (
        <p className="st-hint">
          {wsl.installed
            ? '检测到 WSL 组件，但还没有 Linux 发行版。在 PowerShell 运行 wsl --install，完成后点「重新检测」。'
            : '未检测到 WSL。安装 WSL 与 Linux 发行版后，点「重新检测」即可选择。'}
        </p>
      ) : null}
      <p className="st-hint">只影响之后新建的终端；已经打开的终端保持原样。</p>
      <InlineError message={error} />
      <div className="st-search-actions">
        <Button
          variant="ghost"
          icon={<RefreshCw size={13} strokeWidth={1.6} aria-hidden />}
          disabled={loading}
          onClick={() => void load(true)}
        >
          重新检测
        </Button>
        <Button
          variant="secondary"
          icon={<SquareTerminal size={13} strokeWidth={1.6} aria-hidden />}
          onClick={() => {
            useAppStore.getState().closeSettings()
            openWorkbench('terminal')
          }}
        >
          打开终端
        </Button>
      </div>
    </div>
  )
}

function AppearanceTab(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setTheme = useAppStore((s) => s.setTheme)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [error, setError] = useState<string | null>(null)

  const codeFontOptions: Array<{ value: CodeFontId; label: string; description: string }> = [
    { value: 'jetbrains', label: 'JetBrains Mono', description: '默认；更宽、适合长时间阅读' },
    { value: 'ibm-plex', label: 'IBM Plex Mono', description: '细窄、安静' },
    { value: 'system', label: '系统等宽', description: '使用 Cascadia Mono / Consolas' }
  ]

  const patch = async (value: Parameters<typeof updateSettings>[0]): Promise<void> => {
    setError(null)
    try {
      await updateSettings(value)
    } catch (err) {
      setError(errorText(err, '设置保存失败。'))
    }
  }

  return (
    <div className="st-appearance">
      <p className="st-hint">这些选项即时生效，不需要重启。</p>

      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">主题</span>
          <span className="st-setting-desc">深色是墨夜书房；浅色是白天的素纸界面。</span>
        </div>
        <Segmented
          ariaLabel="主题"
          value={settings.theme}
          options={[
            { value: 'dark', label: '深色' },
            { value: 'light', label: '浅色' }
          ]}
          onChange={(next) => setTheme(next)}
        />
      </div>

      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">应用字号</span>
          <span className="st-setting-desc">调整正文与界面的基础字号（12–15）。</span>
        </div>
        <Segmented
          ariaLabel="应用字号"
          value={String(settings.fontSize)}
          options={['12', '13', '14', '15'].map((size) => ({ value: size, label: size }))}
          onChange={(next) => void patch({ fontSize: Number(next) })}
        />
      </div>

      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">代码字号</span>
          <span className="st-setting-desc">只影响代码、终端、diff 与等宽数字；与应用字号分开（11–14）。</span>
        </div>
        <Segmented
          ariaLabel="代码字号"
          value={String(settings.codeFontSize || 12)}
          options={['11', '12', '13', '14'].map((size) => ({ value: size, label: size }))}
          onChange={(next) => void patch({ codeFontSize: Number(next) })}
        />
      </div>

      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">代码字体</span>
          <span className="st-setting-desc">编辑器、diff、代码块和终端都会使用。</span>
        </div>
        <div style={{ width: 210 }}>
          <Select
            ariaLabel="代码字体"
            value={settings.codeFont}
            options={codeFontOptions}
            onChange={(next) => void patch({ codeFont: next })}
          />
        </div>
      </div>

      <div className="st-code-preview" aria-label="代码字体预览">
        <div>
          <span className="st-code-preview-key">const</span> morrow = <span className="st-code-preview-str">'明天见'</span>
        </div>
        <div className="st-code-preview-comment">// 代码、diff 与终端使用同一套字体</div>
      </div>
      <p className="st-hint">代码字重固定为常规 400，编辑器、diff 与终端保持一致。</p>

      <Switch
        checked={settings.reduceMotion}
        onChange={(next) => void patch({ reduceMotion: next })}
        label="减少动效"
        description="关掉淡入、呼吸与光带动画，界面更安静"
      />
      <Switch
        checked={settings.showTokenMeter}
        onChange={(next) => void patch({ showTokenMeter: next })}
        label="显示 token 计量"
        description="在输入框显示上下文占用环"
      />
      <Switch
        checked={settings.islandEnabled}
        onChange={(next) => void patch({ islandEnabled: next })}
        label="桌面小伙伴"
        description="在桌面显示一个置顶的小窗口，随时交代任务、查看进度；Ctrl+Shift+M 可随时唤回。"
      />
      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">关闭窗口时</span>
          <span className="st-setting-desc">点标题栏关闭按钮或桌面伙伴「关闭 Morrow…」时执行；选定一次后会记住。</span>
        </div>
        <Segmented
          ariaLabel="关闭窗口时"
          value={settings.closeAction}
          options={[
            { value: 'ask', label: '每次询问' },
            { value: 'minimize', label: '最小化' },
            { value: 'quit', label: '退出' }
          ] satisfies Array<{ value: CloseAction; label: string }>}
          onChange={(next) => void patch({ closeAction: next })}
        />
      </div>

      <InlineError message={error} />
    </div>
  )
}

function AboutTab(): React.JSX.Element {
  const appInfo = useAppStore((s) => s.appInfo)
  const settings = useAppStore((s) => s.settings)
  const copyText = useAppStore((s) => s.copyText)
  const openDataDir = useAppStore((s) => s.openDataDir)
  const openLogs = useAppStore((s) => s.openLogs)
  const changeDataDir = useAppStore((s) => s.changeDataDir)
  const resetDataDir = useAppStore((s) => s.resetDataDir)
  const activeRuns = useAppStore((s) => Object.keys(s.runs).length)
  const [changingDataDir, setChangingDataDir] = useState(false)
  const canChangeDataDir = appInfo?.canChangeDataDir !== false
  const customDataDirActive = appInfo?.dataDirSource === 'custom'
  const hasCustomDataDir = Boolean(appInfo?.customDataDir)
  const dataDirBusy = changingDataDir || activeRuns > 0

  const handleChangeDataDir = async (): Promise<void> => {
    if (!canChangeDataDir || dataDirBusy) return
    setChangingDataDir(true)
    try {
      await changeDataDir()
    } finally {
      setChangingDataDir(false)
    }
  }

  const handleResetDataDir = async (): Promise<void> => {
    if (!canChangeDataDir || dataDirBusy || !hasCustomDataDir) return
    setChangingDataDir(true)
    try {
      await resetDataDir()
    } finally {
      setChangingDataDir(false)
    }
  }

  return (
    <div className="st-about">
      <div className="st-about-brand">
        <img className="st-about-mark" src={brandMarkUrl} alt="" width={44} height={44} draggable={false} aria-hidden />
        <div>
          <p className="st-about-name serif">Morrow</p>
          <p className="st-about-tagline">住在你电脑里的 AI 工作伙伴</p>
        </div>
      </div>

      <dl className="st-about-grid">
        <div className="st-about-item">
          <dt>版本</dt>
          <dd className="mono">v{appInfo?.version ?? '0.1.0'}</dd>
        </div>
        <div className="st-about-item">
          <dt>Electron</dt>
          <dd className="mono">{appInfo?.electron ?? '—'}</dd>
        </div>
        <div className="st-about-item">
          <dt>Chromium</dt>
          <dd className="mono">{appInfo?.chrome ?? '—'}</dd>
        </div>
        <div className="st-about-item">
          <dt>Node</dt>
          <dd className="mono">{appInfo?.node ?? '—'}</dd>
        </div>
      </dl>

      <div className="st-about-datadir">
        <span className="st-field-label">
          数据目录 {customDataDirActive ? <Badge tone="gold">自定义</Badge> : null}
        </span>
        <div className="st-about-path">
          <code className="mono selectable">{appInfo?.dataDir ?? '—'}</code>
          <IconButton label="复制数据目录路径" size={26} onClick={() => void copyText(appInfo?.dataDir ?? '')}>
            <Copy size={12} strokeWidth={1.5} aria-hidden />
          </IconButton>
        </div>
        <div className="st-about-actions">
          <Button
            size="sm"
            variant="gold"
            icon={<FolderCog size={13} strokeWidth={1.5} />}
            loading={changingDataDir}
            disabled={!canChangeDataDir || dataDirBusy}
            onClick={() => void handleChangeDataDir()}
          >
            更改目录
          </Button>
          <Button size="sm" variant="secondary" icon={<FolderOpen size={13} strokeWidth={1.5} />} onClick={() => void openDataDir()}>
            打开数据目录
          </Button>
          <Button size="sm" variant="secondary" icon={<FileText size={13} strokeWidth={1.5} />} onClick={() => void openLogs()}>
            打开日志
          </Button>
          {hasCustomDataDir ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={13} strokeWidth={1.5} />}
              disabled={!canChangeDataDir || dataDirBusy}
              onClick={() => void handleResetDataDir()}
            >
              恢复默认目录
            </Button>
          ) : null}
        </div>
        {!canChangeDataDir ? (
          <p className="st-hint">当前数据目录由启动参数指定，不能在这里修改。</p>
        ) : activeRuns > 0 ? (
          <p className="st-hint">有任务正在运行，先停止任务后再更改数据目录。</p>
        ) : (
          <p className="st-hint">
            更改后会重启 Morrow；可迁移现有对话、设置、项目、记忆与技能，浏览器登录状态不迁移。
          </p>
        )}
        {hasCustomDataDir && !customDataDirActive ? (
          <p className="st-hint is-warn">自定义目录当前不可用，正在使用默认目录；可恢复默认后重新选择。</p>
        ) : null}
        {customDataDirActive ? (
          <p className="st-hint">默认目录：{appInfo?.defaultDataDir ?? '—'}</p>
        ) : null}
      </div>

    </div>
  )
}

function ShortcutsTab(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const groups = SHORTCUT_GROUPS.map((group) => ({
    ...group,
    entries: group.entries
      .filter((entry) => entry.requires !== 'islandEnabled' || settings.islandEnabled)
      .map((entry) =>
        entry.dynamic === 'sendKey'
          ? {
              ...entry,
              keys: settings.sendKey === 'enter' ? 'Enter' : 'Ctrl+Enter',
              hint:
                settings.sendKey === 'enter'
                  ? '当前设置；可在「设置 → 回答」切换为 Ctrl+Enter'
                  : '当前设置；可在「设置 → 回答」切换为 Enter'
            }
          : entry
      )
  }))
  return (
    <div className="st-shortcuts">
      <p className="st-hint">
        下面是现在能用的快捷键。带「聚焦时」或「面板显示时」的条目只在对应区域生效；如果被系统或输入法占用，可能不起作用。
      </p>
      {groups.map((group) => (
        <section key={group.id} className="st-shortcut-group" aria-label={group.label}>
          <div className="st-shortcut-group-head">
            <p className="st-section-title">{group.label}</p>
            {group.description ? <p className="st-shortcut-group-desc">{group.description}</p> : null}
          </div>
          <div className="st-shortcut-grid">
            {group.entries.map((entry) => (
              <div key={entry.id} className="st-shortcut-cell">
                <Shortcut keys={entry.keys} label={entry.label} />
                {entry.hint ? <p className="st-shortcut-hint">{entry.hint}</p> : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function archiveDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function workspaceLabel(path: string | null): string | null {
  if (!path) return null
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function ArchiveTab(): React.JSX.Element {
  const sessions = useAppStore((s) => s.sessions)
  const setSessionArchived = useAppStore((s) => s.setSessionArchived)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const clearAllSessions = useAppStore((s) => s.clearAllSessions)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)

  const archived = useMemo(
    () =>
      sessions
        .filter((session) => !session.temporary && session.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions]
  )

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete || deleting) return
    setDeleting(true)
    setDeleteError(null)
    const id = pendingDelete.id
    await deleteSession(id)
    const stillThere = useAppStore.getState().sessions.some((session) => session.id === id)
    setDeleting(false)
    if (stillThere) {
      setDeleteError('删除没有完成，请稍后重试。')
      return
    }
    setPendingDelete(null)
  }

  const confirmClear = async (): Promise<void> => {
    if (clearing) return
    setClearing(true)
    setClearError(null)
    const deleted = await clearAllSessions()
    setClearing(false)
    if (deleted !== null) {
      setClearOpen(false)
      closeSettings()
    } else {
      setClearError('清除没有完成，可能有部分对话已删除；请查看提示后重试。')
    }
  }

  return (
    <div className="st-archive">
      <p className="st-hint">
        归档的对话仍保存在本机，但不会出现在侧栏。可以随时恢复到对话列表，或永久删除。
      </p>

      <div className="st-archive-summary">
        <span className="mono">已归档 {archived.length} 个对话</span>
      </div>

      {archived.length === 0 ? (
        <div className="st-archive-empty">
          <Archive size={22} strokeWidth={1.4} aria-hidden />
          <p className="st-archive-empty-title">还没有归档的对话</p>
          <p className="st-hint">在侧栏的对话上点「归档对话」，它就会收进这里。</p>
        </div>
      ) : (
        <ul className="st-archive-list" aria-label="已归档的对话">
          {archived.map((session) => {
            const workspace = workspaceLabel(session.workspace)
            return (
              <li key={session.id} className="st-archive-row">
                <div className="st-archive-main">
                  <p className="st-archive-title truncate" title={session.title}>
                    {session.title}
                  </p>
                  <p className="st-archive-preview truncate">
                    {session.preview?.trim() || '没有可预览的内容'}
                  </p>
                  <p className="st-archive-meta mono">
                    {[
                      workspace,
                      `${session.messageCount} 条消息`,
                      `更新于 ${archiveDate(session.updatedAt)}`
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="st-archive-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<ArchiveRestore size={13} strokeWidth={1.5} />}
                    onClick={() => void setSessionArchived(session.id, false)}
                  >
                    恢复
                  </Button>
                  <IconButton
                    label={`删除归档对话「${session.title}」`}
                    size={28}
                    tone="danger"
                    onClick={() => {
                      setDeleteError(null)
                      setPendingDelete(session)
                    }}
                  >
                    <Trash2 size={13} strokeWidth={1.5} aria-hidden />
                  </IconButton>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="st-danger-zone">
        <div className="st-danger-copy">
          <p className="st-section-title">清除全部对话</p>
          <p className="st-about-text">
            删除所有对话（包括已归档的），以及它们的回退记录、成品版本、token 用量、操作记录和定时任务的运行记录。
            文件夹里的文件、设置、记忆、项目、定时安排和 API Key 都不会被删除。
          </p>
        </div>
        <Button
          variant="danger"
          icon={<Trash2 size={13} strokeWidth={1.6} />}
          disabled={sessions.length === 0}
          onClick={() => {
            setClearError(null)
            setClearOpen(true)
          }}
        >
          清除全部
        </Button>
      </div>

      <Modal
        open={pendingDelete !== null}
        onClose={() => {
          if (!deleting) setPendingDelete(null)
        }}
        title="删除归档对话？"
        width={460}
        closeOnBackdrop={!deleting}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>
              取消
            </Button>
            <Button variant="danger" data-autofocus onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? '正在删除…' : '删除'}
            </Button>
          </>
        }
      >
        <div className="st-danger-modal">
          <p className="st-danger-lead">
            将永久删除「{pendingDelete?.title ?? '这个对话'}」及其本地会话文件、回退记录、成品版本和用量记录。
            这个操作无法撤销。
          </p>
          <p className="st-hint">文件夹里的文件、设置和记忆不会受影响。</p>
          {deleteError ? <InlineError message={deleteError} /> : null}
        </div>
      </Modal>

      <Modal
        open={clearOpen}
        onClose={() => {
          if (!clearing) setClearOpen(false)
        }}
        title="清除全部对话？"
        width={470}
        closeOnBackdrop={!clearing}
        footer={
          <>
            <Button variant="ghost" onClick={() => setClearOpen(false)} disabled={clearing}>
              取消
            </Button>
            <Button variant="danger" data-autofocus onClick={() => void confirmClear()} disabled={clearing}>
              {clearing ? '正在清除…' : '确认清除'}
            </Button>
          </>
        }
      >
        <div className="st-danger-modal">
          <p className="st-danger-lead">
            将删除 <strong>{sessions.length}</strong> 个对话，以及它们的回退记录、成品版本、token 用量、操作记录和定时任务的运行记录。
            这个操作无法撤销。
          </p>
          <p className="st-hint">文件夹里的文件、设置、记忆、项目和 API Key 不会受影响；定时任务本身会保留。</p>
          {clearError ? <InlineError message={clearError} /> : null}
        </div>
      </Modal>
    </div>
  )
}

function AutomationTab(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const workspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace)
  const notify = useAppStore((s) => s.notify)
  const [hooks, setHooks] = useState<HookConfig[]>(settings.hooks ?? [])
  const [commands, setCommands] = useState<CustomCommandInfo[]>([])
  const [commandError, setCommandError] = useState<string | null>(null)
  const [hookError, setHookError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadingCommands, setLoadingCommands] = useState(false)
  const [agents, setAgents] = useState<AgentRoleSummary[]>([])
  const [agentsOpen, setAgentsOpen] = useState(false)

  const loadCommands = async (): Promise<void> => {
    setLoadingCommands(true)
    setCommandError(null)
    try {
      const result = await window.morrow.features.invoke<CustomCommandInfo[]>('feature:commands:list', {
        ...(workspace ? { workspace } : {})
      })
      if (result.ok) {
        setCommands(result.data)
      } else {
        setCommandError(result.error.message)
      }
    } catch (err) {
      setCommandError(errorText(err, '读取自定义命令失败'))
    } finally {
      setLoadingCommands(false)
    }
  }

  useEffect(() => {
    void loadCommands()
    // 只在文件夹变化时重新发现命令
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await window.morrow.features.invoke<AgentRoleSummary[]>('feature:agents:list', {
          ...(workspace ? { workspace } : {})
        })
        if (!cancelled && result.ok) setAgents(result.data)
      } catch {
        // 角色列表失败不影响其它自动化设置
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace])

  const editHook = (id: string, patch: Partial<HookConfig>): void => {
    setSaved(false)
    setHookError(null)
    setHooks((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const addHook = (): void => {
    setSaved(false)
    setHookError(null)
    setHooks((items) => [
      ...items,
      {
        id: `hook-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        event: 'user_prompt_submit',
        command: '',
        enabled: false
      }
    ])
  }

  const removeHook = (id: string): void => {
    setSaved(false)
    setHookError(null)
    setHooks((items) => items.filter((item) => item.id !== id))
  }

  const save = async (): Promise<void> => {
    setHookError(null)
    setSaved(false)
    if (hooks.some((hook) => !hook.command.trim())) {
      setHookError('每个自动动作都需要一条命令；不需要时请删除该行。')
      return
    }
    const enabledPerEvent = new Map<HookEvent, number>()
    for (const hook of hooks) {
      if (!hook.enabled) continue
      const count = (enabledPerEvent.get(hook.event) ?? 0) + 1
      if (count > MAX_ENABLED_HOOKS_PER_EVENT) {
        setHookError(`每个时点最多启用 ${MAX_ENABLED_HOOKS_PER_EVENT} 个自动动作；请先停用多余的。`)
        return
      }
      enabledPerEvent.set(hook.event, count)
    }
    setSaving(true)
    try {
      await updateSettings({ hooks })
      setHooks(useAppStore.getState().settings.hooks ?? [])
      setSaved(true)
    } catch (err) {
      setHookError(errorText(err, '保存自动动作失败'))
    } finally {
      setSaving(false)
    }
  }

  const reservedCommands = commands.filter((command) => RESERVED_COMMAND_NAMES.has(command.name))

  return (
    <div className="st-automation">
      <section className="st-auto-section">
        <div className="st-auto-head">
          <p className="st-section-title">自定义命令</p>
          <IconButton label="刷新自定义命令" size={26} disabled={loadingCommands} onClick={() => void loadCommands()}>
            <RefreshCw size={12} strokeWidth={1.6} className={loadingCommands ? 'st-spin' : undefined} aria-hidden />
          </IconButton>
        </div>
        <p className="st-hint">
          在项目文件夹的 <code className="mono">.morrow/commands/</code> 里放一个 Markdown 文件，就能在输入框输入 <code className="mono">/名字</code> 调用；文件里的 <code className="mono">$ARGUMENTS</code> 会换成你输入的参数。所有对话都能用的命令放到 <code className="mono">~/.morrow/commands/</code>。
        </p>
        {commands.length === 0 ? (
          <p className="st-auto-empty">{loadingCommands ? '正在读取…' : '还没有自定义命令。'}</p>
        ) : (
          <ul className="st-command-list">
            {commands.map((command) => {
              const reserved = RESERVED_COMMAND_NAMES.has(command.name)
              return (
                <li key={`${command.scope}:${command.name}`} className={reserved ? 'is-reserved' : undefined}>
                  <span className="st-command-name mono">/{command.name}</span>
                  <span className="st-command-desc truncate" title={command.path}>
                    {command.description}
                    {command.argumentHint ? <span className="st-command-hint"> · {command.argumentHint}</span> : null}
                  </span>
                  <Badge tone={command.scope === 'project' ? 'gold' : 'neutral'}>
                    {command.scope === 'project' ? '项目' : '用户'}
                  </Badge>
                  {reserved ? <Badge tone="warning">重名</Badge> : null}
                </li>
              )
            })}
          </ul>
        )}
        {reservedCommands.length > 0 ? (
          <p className="st-warn">
            {reservedCommands.length} 个命令与内置命令重名，不会出现在斜杠菜单；请重命名对应文件（如
            <code className="mono"> {reservedCommands.map((command) => command.name).join('、')}</code>）。
          </p>
        ) : null}
        <InlineError message={commandError} />
      </section>

      <section className="st-auto-section">
        <div className="st-auto-head">
          <p className="st-section-title">集群成员类型</p>
          <Button size="sm" variant="ghost" onClick={() => setAgentsOpen((value) => !value)}>
            {agentsOpen ? '收起' : '查看全部成员类型'}
          </Button>
        </div>
        <p className="st-hint">
          集群成员会继承当前权限：能读文件、改文件、运行命令和调用外部工具；敏感操作仍按权限设置审批。类型只决定工作重点，不会扩大权限，通常不需要手动设置。
        </p>
        {agentsOpen ? (
          <>
            <p className="st-hint">
              自定义成员可以放在 <code className="mono">.morrow/agents/</code>，写清名称、说明和提示词即可。
            </p>
            <ul className="st-agent-list">
              {agents.map((role) => (
                <li key={role.name}>
                  <span className="st-agent-title">{role.title}</span>
                  <span className="st-agent-desc truncate">{role.description}</span>
                  <Badge tone={role.source === 'builtin' ? 'gold' : 'success'}>
                    {role.source === 'builtin' ? '内置' : role.source === 'project' ? '项目' : '用户'}
                  </Badge>
                </li>
              ))}
              {agents.length === 0 ? <li className="st-auto-empty">正在读取角色…</li> : null}
            </ul>
          </>
        ) : null}
      </section>

      <section className="st-auto-section">
        <p className="st-section-title">自动动作</p>
        <p className="st-hint">
          在发送消息前、工具完成后或每轮结束时，自动运行一条命令。它和 Morrow 有相同的文件和网络权限，
          只添加你信任的命令。
        </p>
        <p className="st-hint">
          每条最多运行 15 秒；每个触发时机最多启用 {MAX_ENABLED_HOOKS_PER_EVENT} 个。
        </p>
        {hooks.length === 0 ? <p className="st-auto-empty">还没有自动动作。</p> : null}
        <div className="st-hook-list">
          {hooks.map((hook) => (
            <div
              key={hook.id}
              className={['st-hook-row', hook.enabled ? 'is-enabled' : ''].filter(Boolean).join(' ')}
            >
              <Select
                value={hook.event}
                options={HOOK_EVENT_OPTIONS}
                onChange={(event) => editHook(hook.id, { event })}
                ariaLabel="什么时候运行"
                width={150}
              />
              <input
                className="text-input mono st-hook-command"
                value={hook.command}
                maxLength={2000}
                placeholder="例如 npm run lint"
                aria-label="要运行的命令"
                onChange={(event) => editHook(hook.id, { command: event.target.value })}
              />
              <label className="st-hook-enabled" title={HOOK_EVENT_HINT[hook.event]}>
                <input
                  type="checkbox"
                  checked={hook.enabled}
                  aria-label="启用这个自动动作"
                  onChange={(event) => editHook(hook.id, { enabled: event.target.checked })}
                />
                启用
              </label>
              <IconButton label="删除这个自动动作" size={26} tone="danger" onClick={() => removeHook(hook.id)}>
                <Trash2 size={12} strokeWidth={1.6} aria-hidden />
              </IconButton>
            </div>
          ))}
        </div>
        <div className="st-hook-actions">
          <Button variant="ghost" onClick={addHook} icon={<Plus size={13} strokeWidth={1.7} aria-hidden />}>
            添加自动动作
          </Button>
          <Button variant="gold" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存自动动作'}
          </Button>
          {saved ? <span className="st-hook-saved">已保存</span> : null}
        </div>
        <InlineError message={hookError} />
      </section>
    </div>
  )
}

interface ToolEntry {
  id: WorkbenchPanel
  title: string
  description: string
  icon: React.ReactNode
}

const TOOL_GROUPS: { label: string; entries: ToolEntry[] }[] = [
  {
    label: '记住与背景',
    entries: [
      {
        id: 'memory',
        title: '记忆',
        description: '记住你的偏好、习惯和项目里的事，并查看 Morrow 的建议。',
        icon: <Brain size={16} strokeWidth={1.5} />
      },
      {
        id: 'projects',
        title: '项目',
        description: '给一个文件夹准备长期说明和参考资料。',
        icon: <FolderKanban size={16} strokeWidth={1.5} />
      }
    ]
  },
  {
    label: '自动化',
    entries: [
      {
        id: 'schedules',
        title: '定时任务',
        description: '让 Morrow 在指定时间自动做一件事，结果保存在新对话里。',
        icon: <AlarmClock size={16} strokeWidth={1.5} />
      }
    ]
  },
  {
    label: '能力扩展',
    entries: [
      {
        id: 'skills',
        title: '技能',
        description: '给 Morrow 装上可以重复使用的工作方法。',
        icon: <Sparkles size={16} strokeWidth={1.5} />
      },
      {
        id: 'connectors',
        title: '外部工具（MCP）',
        description: '连接 MCP 服务或本机程序，让 Morrow 会用更多工具。',
        icon: <Plug size={16} strokeWidth={1.5} />
      }
    ]
  },
  {
    label: '查找与工作',
    entries: [
      {
        id: 'search',
        title: '全局搜索',
        description: '一次查找对话、文件和生成结果。',
        icon: <Search size={16} strokeWidth={1.5} />
      },
      {
        id: 'browser',
        title: '浏览器',
        description: '在应用内打开网页，供 Morrow 读取和操作。',
        icon: <Globe2 size={16} strokeWidth={1.5} />
      },
      {
        id: 'git',
        title: '版本历史（Git）',
        description: '查看文件改动，保存和管理版本记录。',
        icon: <FolderGit2 size={16} strokeWidth={1.5} />
      }
    ]
  }
]

function ToolsTab(): React.JSX.Element {
  const [evolutionPending, setEvolutionPending] = useState(0)
  const evolutionWorkspace = useAppStore(
    (state) => state.session?.workspace ?? state.settings.lastWorkspace ?? null
  )
  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.morrow.features.invoke<{ pending: number }>('feature:evolution:list', {
          workspace: evolutionWorkspace
        })
        if (active && result.ok) setEvolutionPending(result.data.pending)
      } catch {
        // 自进化建议不可用不影响功能入口
      }
    }
    void load()
    const off = window.morrow.features.on?.('feature:evolution:changed', () => void load())
    return () => {
      active = false
      off?.()
    }
  }, [evolutionWorkspace])
  return (
    <div className="st-tools">
      <p className="st-hint">需要的功能都在这里；打开后按 Esc 或关闭按钮即可回到对话。</p>
      {TOOL_GROUPS.map((group) => (
        <section key={group.label} className="st-tool-group">
          <p className="st-tool-group-label mono">{group.label}</p>
          <div className="st-tool-list">
            {group.entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="st-tool-row"
                onClick={() => {
                  useAppStore.getState().closeSettings()
                  openWorkbench(entry.id, entry.id === 'projects' ? { view: 'settings' } : {})
                }}
              >
                <span className="st-tool-icon" aria-hidden>
                  {entry.icon}
                </span>
                <span className="st-tool-copy">
                  <span className="st-tool-heading">
                    <span className="st-tool-title">{entry.title}</span>
                    {entry.id === 'memory' && evolutionPending > 0 ? (
                      <span
                        className="st-tool-badge mono"
                        title={`${evolutionPending} 条建议待处理`}
                        aria-label={`${evolutionPending} 条建议待处理`}
                      >
                        {evolutionPending}
                      </span>
                    ) : null}
                  </span>
                  <span className="st-tool-desc">{entry.description}</span>
                </span>
                <span className="st-tool-open">
                  打开
                  <ChevronRight size={12} strokeWidth={1.7} aria-hidden />
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/** 默认模型卡：放在页面标题右侧，与说明文字同一行顶部对齐。 */
function CurrentModelCard(): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const currentModel = findModel(settings.providers, settings.defaultModel)
  if (!currentModel) return null
  return (
    <div className="st-current-model">
      <span className="st-current-label mono">当前默认模型</span>
      <span className="st-current-name">{currentModel.label}</span>
      <span className="st-current-meta mono">
        可处理约 {formatModelWindow(currentModel.contextWindow)} 内容 · 回复最多 {formatModelWindow(currentModel.maxOutput)}
      </span>
    </div>
  )
}

export function SettingsModal(): React.JSX.Element | null {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const [tab, setTab] = useState<SettingsTabId>('models')
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!settingsOpen) return
    const requested = consumeRequestedTab()
    const next = requested ?? tab
    if (requested && requested !== tab) setTab(requested)
    // 焦点必须落在当前可见的分类上（保留上次打开的分类，而不是固定回「模型连接」）
    const timer = window.setTimeout(() => {
      document.getElementById(`st-tab-${next}`)?.focus()
    }, 90)
    return () => window.clearTimeout(timer)
    // 只在打开时定位；tab 变化由点击/键盘自行处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen])

  // 切换分类时回到顶部，避免继承上一个 Tab 的滚动位置
  useEffect(() => {
    if (settingsOpen) panelRef.current?.scrollTo({ top: 0 })
  }, [tab, settingsOpen])

  // 设置已经打开时，其他组件（Composer token chip / 命令面板）也能请求切换 Tab
  useEffect(
    () =>
      onSettingsTabRequest((next) => {
        setTab(next)
        if (useAppStore.getState().settingsOpen) {
          window.setTimeout(() => document.getElementById(`st-tab-${next}`)?.focus(), 60)
        }
      }),
    []
  )

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const index = TABS.findIndex((item) => item.id === tab)
    let next = index
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    else return
    event.preventDefault()
    const target = TABS[next]
    setTab(target.id)
    document.getElementById(`st-tab-${target.id}`)?.focus()
  }

  return (
    <Modal
      open={settingsOpen}
      onClose={closeSettings}
      title="设置"
      width={880}
      footer={
        <>
          <span className="st-foot-hint mono">外观、权限、回答与终端即时保存；模型、联网搜索与多媒体需点保存</span>
          <Button variant="secondary" onClick={closeSettings}>
            完成
          </Button>
        </>
      }
    >
      <div className="settings">
        <nav
          className="st-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label="设置分类"
          onKeyDown={onTabKeyDown}
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              id={`st-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`st-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className={['st-nav-item', tab === item.id ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={() => setTab(item.id)}
            >
              <span className="st-nav-icon" aria-hidden>
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </nav>

        <div
          ref={panelRef}
          className="st-panel"
          id={`st-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`st-tab-${tab}`}
          tabIndex={0}
        >
          <header className={['st-page-head', tab === 'models' ? 'has-aside' : ''].filter(Boolean).join(' ')}>
            <div className="st-page-head-copy">
              <h2 className="st-page-title">{PAGE_META[tab].title}</h2>
              <p className="st-page-desc">{PAGE_META[tab].description}</p>
            </div>
            {tab === 'models' ? <CurrentModelCard /> : null}
          </header>
          {tab === 'models' ? <ModelsTab /> : null}
          {tab === 'subscriptions' ? <SubscriptionTab /> : null}
          {tab === 'media' ? <MediaTab /> : null}
          {tab === 'search' ? <SearchTab /> : null}
          {tab === 'context' ? <ContextTab /> : null}
          {tab === 'style' ? <AnswerStyleTab /> : null}
          {tab === 'usage' ? <TokenActivityTab /> : null}
          {tab === 'archive' ? <ArchiveTab /> : null}
          {tab === 'permission' ? <PermissionTab /> : null}
          {tab === 'automation' ? <AutomationTab /> : null}
          {tab === 'tools' ? <ToolsTab /> : null}
          {tab === 'terminal' ? <TerminalTab /> : null}
          {tab === 'appearance' ? <AppearanceTab /> : null}
          {tab === 'shortcuts' ? <ShortcutsTab /> : null}
          {tab === 'about' ? <AboutTab /> : null}
        </div>
      </div>
    </Modal>
  )
}
