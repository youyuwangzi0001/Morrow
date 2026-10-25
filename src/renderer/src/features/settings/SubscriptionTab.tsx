import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Boxes,
  Bot,
  Brain,
  Check,
  Copy,
  Download,
  ExternalLink,
  Gauge,
  Globe2,
  KeyRound,
  Layers,
  LoaderCircle,
  LogIn,
  Moon,
  Orbit,
  Plus,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  Upload,
  X,
  Zap
} from 'lucide-react'
import type { Result } from '@shared/types'
import type {
  AgentQuotaWindow,
  AgentSubscriptionId,
  AgentSubscriptionState,
  CodexSubscriptionQuota,
  CodexSubscriptionState,
  CustomSubscriptionInput,
  CustomSubscriptionRecord,
  CustomSubscriptionState,
  QoderSubscriptionQuota,
  QoderSubscriptionState,
  SubscriptionAction,
  SubscriptionProtocol,
  SubscriptionStatus,
  SubscriptionTestResult
} from '@shared/subscriptions'
import { Badge, Button, Select, Switch, TextArea, TextInput } from '../../ui'
import { errorText } from '../../lib'
import { useAppStore } from '../../store'
import './SettingsSubscriptions.css'

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
        <span>{busy}{loginWaiting ? ' 浏览器没有打开？再次点击登录按钮重试，或复制登录链接到浏览器打开。' : null}</span>
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
              <div className="st-sub-model-chips">
                {qoder.models.map((model) => <span key={model.id}>{model.label}<em>{Math.round(model.contextWindow / 1000)}K</em></span>)}
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
