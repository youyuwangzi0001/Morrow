import { useEffect, useState } from 'react'
import { Check, Copy, Download, ExternalLink, FolderOpen, Play, Plus, RefreshCw, Save, Square, Trash2 } from 'lucide-react'
import type { MediaEngineSettings, MediaEngineStatus, Result } from '@shared/types'
import type { MediaCatalogAction, MediaCatalogStatus, MediaEngineInfo, MediaModelInfo } from '@shared/media-models'
import { Badge, Button, Select, Switch, TextArea, TextInput } from '../../ui'
import { useAppStore } from '../../store'
import './SettingsMedia.css'

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
