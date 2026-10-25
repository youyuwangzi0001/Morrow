import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlarmClock,
  Archive,
  ArchiveRestore,
  BadgeCheck,
  Brain,
  Check,
  ChevronRight,
  Clapperboard,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FolderCog,
  FolderGit2,
  FolderKanban,
  FolderOpen,
  RotateCcw,
  Gauge,
  Globe,
  Globe2,
  Info,
  KeyRound,
  Keyboard,
  Layers,
  MessageSquareText,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  SquareTerminal,
  Trash2,
  Zap
} from 'lucide-react'
import { findModel, isLocalServiceUrl, reasoningEffortsForModel } from '@shared/models'
import { formatUsd } from '@shared/usage'
import { MAX_ENABLED_HOOKS_PER_EVENT } from '@shared/types'
import { RESERVED_COMMAND_NAMES } from '@shared/commands'
import type {
  CloseAction,
  CustomCommandInfo,
  HookConfig,
  HookEvent,
  ModelInfo,
  PermissionLogEntry,
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleKind,
  ProviderCategory,
  CodeFontId,
  ProviderConfig,
  ProviderTestResult,
  Result,
  SessionMeta,
  TerminalShellProfile
} from '@shared/types'
import { useAppStore } from '../../store'
import {
  Badge,
  Button,
  IconButton,
  Modal,
  Segmented,
  Select,
  Shortcut,
  Switch,
  TextInput
} from '../../ui'
import {
  contextSnapshot,
  contextSourceLabel,
  formatExactTokens,
  formatModelWindow,
  formatUsageTokens
} from './context-format'
import { consumeRequestedTab, onSettingsTabRequest, type SettingsTabId } from './settings-tab'
import { SHORTCUT_GROUPS } from '@shared/commands'
import { TokenActivityTab } from './TokenActivityTab'
import { AnswerStyleTab } from './AnswerStyleTab'
import { MediaTab } from './MediaTab'
import { SubscriptionTab } from './SubscriptionTab'
import { openWorkbench, type WorkbenchPanel } from '../workbench/events'
import brandMarkUrl from '../../assets/brand-mark-dark.png'
import { errorText } from '../../lib'
import './SettingsModal.css'

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

/* ── 模型连接（R5 重做：分组 / 同步 / 自定义模型 ID） ─────────── */

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

/* ── 上下文（R5 新增） ───────────────────────────────────────── */

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

/* ── 权限 ─────────────────────────────────────────────────────── */

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

/* ── 联网搜索 ─────────────────────────────────────────────────── */

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
  const [test, setTest] = useState<import('@shared/ipc').WebSearchTestResult | null>(null)

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

/* ── 自动化：自定义命令与运行钩子（P1-12） ───────────────────── */

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

/* ── 外观 ─────────────────────────────────────────────────────── */

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

/* ── 关于 ─────────────────────────────────────────────────────── */

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

/* ── 快捷键 ───────────────────────────────────────────────────── */

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

/* ── 对话归档 ─────────────────────────────────────────────────── */

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

/* ── 功能与工具：原工作台里的入口，统一收进设置 ───────────────── */

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

/* ── Modal 组装 ───────────────────────────────────────────────── */

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
