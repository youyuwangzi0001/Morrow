import { useEffect, useMemo, useState } from 'react'
import {
  BadgeCheck,
  Check,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Gauge,
  Globe,
  Info,
  KeyRound,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  Shield,
  Trash2
} from 'lucide-react'
import { findModel } from '@shared/models'
import type { ModelInfo, ProviderCategory, ProviderConfig, ProviderTestResult } from '@shared/types'
import { useAppStore } from '../../state/store'
import {
  Badge,
  Button,
  IconButton,
  Modal,
  Segmented,
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
import './SettingsModal.css'

const TABS: { id: SettingsTabId; label: string; icon: React.ReactNode }[] = [
  { id: 'models', label: '模型连接', icon: <Plug size={15} strokeWidth={1.5} /> },
  { id: 'context', label: '上下文', icon: <Gauge size={15} strokeWidth={1.5} /> },
  { id: 'permission', label: '权限', icon: <Shield size={15} strokeWidth={1.5} /> },
  { id: 'appearance', label: '外观', icon: <Palette size={15} strokeWidth={1.5} /> },
  { id: 'about', label: '关于', icon: <Info size={15} strokeWidth={1.5} /> }
]

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
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
  { id: 'aggregator', label: '聚合平台', hint: '一个 Key 调多家模型' },
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

  const provider = providers.find((p) => p.id === selectedId) ?? providers[0] ?? null
  const category = provider ? providerCategory(provider) : 'custom'
  const supportsCustomModelId = category === 'local' || category === 'custom'
  const groups = CATEGORY_ORDER.map((group) => ({
    ...group,
    items: providers.filter((item) => providerCategory(item) === group.id)
  })).filter((group) => group.items.length > 0)

  const currentModel = findModel(settings.providers, settings.defaultModel)

  useEffect(() => {
    if (!provider) return
    setBaseUrl(provider.baseUrl)
    setApiKey('')
    setTestResult(null)
    setSyncNote(null)
    setError(null)
    setFlash(null)
    setConfirmDeleteId(null)
    setCustomModelId('')
    // 仅在切换 provider 时重置表单
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id])

  useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => setFlash(null), 2600)
    return () => window.clearTimeout(timer)
  }, [flash])

  const handleTest = async (): Promise<void> => {
    if (!provider) return
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      const result = await testProvider({
        providerId: provider.id,
        config: { ...provider, baseUrl: baseUrl.trim() || provider.baseUrl, enabled: true },
        apiKey: apiKey.trim() || undefined
      })
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, latencyMs: 0, message: errorText(err, '测试连接失败。') })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!provider) return
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
      setApiKey('')
      setFlash('已保存并生效')
      setTestResult(null)
    } catch (err) {
      setError(errorText(err, '模型连接保存失败。'))
    } finally {
      setSaving(false)
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
    if (!provider.apiKeyStored) {
      setSyncNote({ ok: false, text: '先保存 API Key，再刷新可用模型。' })
      return
    }
    setSyncing(true)
    try {
      const result = await syncModels(provider.id)
      if (result) {
        setSyncNote({
          ok: true,
          text: `同步完成：${result.total} 个模型（新增 ${result.added} / 更新 ${result.updated}），上下文与输出上限已按服务商返回更新。`
        })
      } else {
        setSyncNote({
          ok: false,
          text: '刷新失败。请确认密钥有效、服务地址正确。'
        })
      }
    } finally {
      setSyncing(false)
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
    setAddingModel(true)
    setError(null)
    try {
      const config: ProviderConfig = {
        ...provider,
        enabled: true,
        models: [...provider.models, { id, label: id, contextWindow, maxOutput, supportsTools: true }]
      }
      await saveProvider({ config })
      await setModel(id, provider.id)
      setCustomModelId('')
      setFlash('已添加模型并切换')
    } catch (err) {
      setError(errorText(err, '添加模型失败。'))
    } finally {
      setAddingModel(false)
    }
  }

  const handleRemove = async (target: ProviderConfig): Promise<void> => {
    setError(null)
    try {
      await removeProvider(target.id)
      setConfirmDeleteId(null)
      const fallback = useAppStore.getState().settings.providers.find((p) => p.kind !== 'demo')?.id ?? ''
      setSelectedId(fallback)
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
      <div className="st-models-top">
        <div className="st-models-top-copy">
          <p className="st-section-title">模型服务商</p>
          <p className="st-hint">
            选择服务商并填写密钥即可。可用模型会随服务商更新；密钥只保存在本机并加密，界面不会显示。
          </p>
        </div>
        {currentModel ? (
          <div className="st-current-model">
            <span className="st-current-label mono">当前默认模型</span>
            <span className="st-current-name">{currentModel.label}</span>
            <span className="st-current-meta mono">
              可处理约 {formatModelWindow(currentModel.contextWindow)} 内容 · 回复最多 {formatModelWindow(currentModel.maxOutput)}
            </span>
          </div>
        ) : null}
      </div>

      {groups.map((group) => (
        <section key={group.id} className="st-provider-group" aria-label={group.label}>
          <div className="st-provider-group-head">
            <h3 className="st-provider-group-title">{group.label}</h3>
            <span className="st-provider-group-hint">{group.hint}</span>
          </div>
          <div className="st-provider-list" role="radiogroup" aria-label={`${group.label}模型提供方`}>
            {group.items.map((item) => {
              const active = provider?.id === item.id
              const isDefault = settings.defaultModel.providerId === item.id
              return (
                <div key={item.id} className={['st-provider', active ? 'is-active' : ''].filter(Boolean).join(' ')}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className="st-provider-head"
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className={['st-provider-radio', active ? 'is-on' : ''].filter(Boolean).join(' ')} aria-hidden />
                    <span className="st-provider-name">{item.name}</span>
                    {isDefault ? <Badge tone="gold">当前</Badge> : null}
                    {!item.enabled ? <span className="st-provider-off mono">未启用</span> : null}
                    <span className="st-provider-models mono">{item.models.length} 个模型</span>
                    <span className={['st-provider-state', item.apiKeyStored ? 'is-on' : ''].join(' ')}>
                      <span className="st-provider-dot" aria-hidden />
                      {providerStateText(item)}
                    </span>
                  </button>

                  {active ? (
                    <div className="st-provider-detail">
                      <div className="st-detail-grid">
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
                        <div className="st-detail-col">
                          <label className="st-field-label" htmlFor="st-api-key">
                            密钥
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
                              placeholder={item.apiKeyStored ? '已保存，留空表示不修改' : '粘贴密钥'}
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
                          <span className="st-model-block-hint">点击切换当前对话的默认模型</span>
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
            <span className="st-section-title">添加 OpenAI 兼容服务</span>
            <button type="button" className="st-link" onClick={() => setCustomOpen(false)}>
              取消
            </button>
          </div>
          <div className="st-row">
            <TextInput
              label="名称"
              placeholder="例如 公司网关"
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
            />
            <TextInput
              label="Base URL"
              placeholder="https://your-gateway/v1"
              mono
              value={customUrl}
              onChange={(event) => setCustomUrl(event.target.value)}
            />
          </div>
          <TextInput
            label="模型 ID（逗号分隔）"
            placeholder="gpt-4.1, gpt-4.1-mini"
            mono
            value={customModels}
            onChange={(event) => setCustomModels(event.target.value)}
          />
          <div className="st-key-field">
            <label className="st-field-label" htmlFor="st-custom-key">
              密钥（可留空，稍后再填）
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
      ) : (
        <button type="button" className="st-add-provider" onClick={() => setCustomOpen(true)}>
          <Plus size={13} strokeWidth={1.5} aria-hidden />
          添加自定义 OpenAI 兼容服务
        </button>
      )}

      <p className="st-note">
        演示引擎（Morrow Demo）离线可用，不需要 API Key；用「看一场演示」可以直接体验完整流程。
      </p>
    </div>
  )
}

/* ── 上下文（R5 新增） ───────────────────────────────────────── */

function ContextTab(): React.JSX.Element {
  const session = useAppStore((s) => s.session)
  const settings = useAppStore((s) => s.settings)
  const compacting = useAppStore((s) => s.compacting)
  const run = useAppStore((s) => s.run)
  const compactSession = useAppStore((s) => s.compactSession)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [error, setError] = useState<string | null>(null)

  const model = findModel(settings.providers, session?.model ?? settings.defaultModel)
  const usage = session?.usage
  const snapshot = contextSnapshot(usage, model?.contextWindow)
  const thresholdPercent = Math.round(settings.compactThreshold * 100)
  const planTokens = Math.round(snapshot.limit * settings.compactThreshold)
  const tone = snapshot.ratio >= 0.85 ? 'is-danger' : snapshot.ratio >= 0.6 ? 'is-warning' : ''
  const compactDisabled = !session || !!run || compacting

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
            <span className="st-section-title">上下文占用</span>
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
            精确值 {formatExactTokens(snapshot.used)} / {formatExactTokens(snapshot.limit)} tokens
            {snapshot.source === 'api' ? ' · 来自服务商返回的 usage' : ' · 服务商暂未返回 usage，当前为字符估算'}
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
          <span className="st-ctx-stat-label">缓存读取</span>
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
          <span className="st-ctx-stat-value mono" title={formatExactTokens(model?.contextWindow)}>
            {formatUsageTokens(model?.contextWindow)}
          </span>
        </div>
        <div className="st-ctx-stat">
          <span className="st-ctx-stat-label">最大输出</span>
          <span className="st-ctx-stat-value mono" title={formatExactTokens(model?.maxOutput)}>
            {formatUsageTokens(model?.maxOutput)}
          </span>
        </div>
      </div>

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
        <p className="st-section-title">显示</p>
        <Switch
          checked={settings.showTokenMeter}
          onChange={(next) => void patch({ showTokenMeter: next })}
          label="显示 token 计量"
          description="标题栏显示上下文占用环，输入框右下显示 token 用量"
        />
      </div>
    </div>
  )
}

/* ── 权限 ─────────────────────────────────────────────────────── */

const PERMISSION_CARDS = [
  {
    mode: 'read-only' as const,
    label: '只读',
    description: '只能查看文件内容。任何写入、删除、命令执行都会先停下来问你。'
  },
  {
    mode: 'ask' as const,
    label: '询问',
    description: '读取文件自动放行；写文件、跑命令、改配置之前都会弹出一张卡片让你确认。'
  },
  {
    mode: 'auto' as const,
    label: '自动',
    description: '不再逐条询问，写入与命令直接执行。只建议在你自己信任的工作区里使用。'
  }
]

const DANGER_RULES = [
  { title: '删除整个目录', detail: 'rm -rf / del /s 这类命令会被拦下，必须你单独确认' },
  { title: '格式化磁盘、关机重启', detail: '系统级命令不会自动执行' },
  { title: '工作区之外的写入', detail: '只要路径超出当前文件夹，就会先问你' },
  { title: '联网下载并执行脚本', detail: '会展示完整命令后再请求确认' }
]

function PermissionTab(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const session = useAppStore((s) => s.session)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const [error, setError] = useState<string | null>(null)
  const current = session?.permissionMode ?? settings.permissionMode

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
      <p className="st-section-title">Morrow 可以自己做到哪一步</p>
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
          自动模式下 Morrow 不会停下来确认危险动作。跑不熟悉的任务时，建议临时切回「询问」。
        </p>
      ) : null}
      <InlineError message={error} />

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

/* ── 外观 ─────────────────────────────────────────────────────── */

function AppearanceTab(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setTheme = useAppStore((s) => s.setTheme)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [error, setError] = useState<string | null>(null)

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
      <p className="st-section-title">外观</p>
      <p className="st-hint">这些选项即时生效，不需要重启。</p>

      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">主题</span>
          <span className="st-setting-desc">墨夜是深夜书房；素纸是白天的工作台。</span>
        </div>
        <Segmented
          ariaLabel="主题"
          value={settings.theme}
          options={[
            { value: 'dark', label: '墨夜' },
            { value: 'light', label: '素纸' }
          ]}
          onChange={(next) => setTheme(next)}
        />
      </div>

      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">字号</span>
          <span className="st-setting-desc">调整正文与界面的基础字号（13–16）。</span>
        </div>
        <Segmented
          ariaLabel="字号"
          value={String(settings.fontSize)}
          options={['13', '14', '15', '16'].map((size) => ({ value: size, label: size }))}
          onChange={(next) => void patch({ fontSize: Number(next) })}
        />
      </div>

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
        description="在标题栏显示上下文占用环"
      />
      <Switch
        checked={settings.autoTitle}
        onChange={(next) => void patch({ autoTitle: next })}
        label="自动命名对话"
        description="用第一条消息给对话起一个短标题"
      />

      <InlineError message={error} />
    </div>
  )
}

/* ── 关于 ─────────────────────────────────────────────────────── */

function AboutTab(): React.JSX.Element {
  const appInfo = useAppStore((s) => s.appInfo)
  const settings = useAppStore((s) => s.settings)
  const openExternal = useAppStore((s) => s.openExternal)
  const copyText = useAppStore((s) => s.copyText)
  const openDataDir = useAppStore((s) => s.openDataDir)
  const openLogs = useAppStore((s) => s.openLogs)

  return (
    <div className="st-about">
      <div className="st-about-brand">
        <span className="st-about-mark serif" aria-hidden>
          M
        </span>
        <div>
          <p className="st-about-name serif">Morrow</p>
          <p className="st-about-tagline">住在你电脑里的 AI 工作伙伴</p>
        </div>
      </div>

      <dl className="st-about-grid">
        <div className="st-about-item">
          <dt>版本</dt>
          <dd className="mono">v{appInfo?.version ?? '1.0.0'}</dd>
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
        <span className="st-field-label">数据目录</span>
        <div className="st-about-path">
          <code className="mono selectable">{appInfo?.dataDir ?? '—'}</code>
          <IconButton label="复制数据目录路径" size={26} onClick={() => void copyText(appInfo?.dataDir ?? '')}>
            <Copy size={12} strokeWidth={1.5} aria-hidden />
          </IconButton>
        </div>
        <div className="st-about-actions">
          <Button size="sm" variant="secondary" icon={<FolderOpen size={13} strokeWidth={1.5} />} onClick={() => void openDataDir()}>
            打开数据目录
          </Button>
          <Button size="sm" variant="secondary" icon={<FileText size={13} strokeWidth={1.5} />} onClick={() => void openLogs()}>
            打开日志
          </Button>
        </div>
      </div>

      <div className="st-about-privacy">
        <p className="st-section-title">隐私</p>
        <p className="st-about-text">
          对话、设置和工作区数据都保存在本机；API Key 用系统加密存储（Windows DPAPI），界面再也读不到明文。
          只有你发出的消息和它读到的文件内容会发送给你选择的模型提供方，其余数据不会上传。
        </p>
        <button
          type="button"
          className="st-link"
          onClick={() => void openExternal('https://api.deepseek.com')}
        >
          查看模型提供方
        </button>
      </div>

      <div className="st-about-shortcuts">
        <p className="st-section-title">键盘快捷键</p>
        <div className="st-shortcut-grid">
          <Shortcut keys="Ctrl+K" label="打开命令面板" />
          <Shortcut keys="Ctrl+B" label="收起或展开侧栏" />
          <Shortcut keys="Ctrl+N" label="新建对话" />
          <Shortcut keys="Ctrl+," label="打开设置" />
          <Shortcut keys="Esc" label="停止生成或关闭浮层" />
          <Shortcut keys={settings.sendKey === 'enter' ? 'Enter' : 'Ctrl+Enter'} label="发送消息" />
          <Shortcut keys="Shift+Enter" label="换行" />
          <Shortcut keys="@" label="引用工作区文件" />
          <Shortcut keys="/" label="运行命令" />
        </div>
      </div>
    </div>
  )
}

/* ── Modal 组装 ───────────────────────────────────────────────── */

export function SettingsModal(): React.JSX.Element | null {
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const [tab, setTab] = useState<SettingsTabId>('models')

  useEffect(() => {
    if (!settingsOpen) return
    const requested = consumeRequestedTab()
    if (requested) setTab(requested)
    // Modal 自带的首个焦点是右上角关闭按钮，这里把焦点移回当前分类
    const timer = window.setTimeout(() => {
      document.getElementById(`st-tab-${requested ?? 'models'}`)?.focus()
    }, 90)
    return () => window.clearTimeout(timer)
  }, [settingsOpen])

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
          <span className="st-foot-hint mono">改动会立即保存</span>
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
          className="st-panel"
          id={`st-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`st-tab-${tab}`}
          tabIndex={0}
        >
          {tab === 'models' ? <ModelsTab /> : null}
          {tab === 'context' ? <ContextTab /> : null}
          {tab === 'permission' ? <PermissionTab /> : null}
          {tab === 'appearance' ? <AppearanceTab /> : null}
          {tab === 'about' ? <AboutTab /> : null}
        </div>
      </div>
    </Modal>
  )
}
