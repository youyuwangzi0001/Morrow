/**
 * R10-G MCP 外部工具管理面板（独立受控组件，Lead 负责挂载）。
 *
 * 用法：
 *   <ConnectorsPanel open={connectorsOpen} onClose={() => setConnectorsOpen(false)} />
 *   // 可选 workspace={string|null} 覆盖；不传时自动取当前对话/最近文件夹。
 *
 * 能力：目录一键安装（推荐）、列表（名称/transport/启用状态）、新增/编辑/删除/启停、测试连接并查看工具列表、
 * stdio（command/args/env/cwd）与 HTTP/SSE（url/headers）表单、密钥掩码（不显示明文，只写新值）、
 * 用户级/文件夹级切换、安全说明。
 * 样式全部使用全局 tokens（石墨/香槟金），无自建主题、无外边框卡片。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Copy, LayoutGrid, Loader2, Plus, RefreshCw, Server, ShieldCheck, Terminal, Trash2 } from 'lucide-react'
import { Badge, Button, EmptyHint, ErrorNote, IconButton, Modal, Segmented, Switch, TextArea, TextInput } from '../../ui'
import { useAppStore } from '../../store'
import {
  connectorsApi,
  CONNECTOR_CHANNELS,
  type ConnectorListResult,
  type ConnectorOAuthStatus,
  type ConnectorScope,
  type ConnectorTestResult,
  type ConnectorToolInfo,
  type ConnectorTransport,
  type ConnectorView,
  type ConnectorPaths,
  type SecretStorageMode
} from './connectors-api'
import { ConnectorDirectory } from './ConnectorDirectory'
import { errorText } from '../../lib'
import './ConnectorsPanel.css'

export interface ConnectorsPanelProps {
  open: boolean
  onClose: () => void
  /** 可选：显式指定文件夹；不传时用当前对话/最近文件夹 */
  workspace?: string | null
}

interface SecretRow {
  key: string
  /** 新值（明文，仅本次输入；已保存的密钥永远不回显） */
  value: string
  hasSecret: boolean
  plaintext: boolean
}

interface Draft {
  originalName: string | null
  transport: ConnectorTransport
  name: string
  command: string
  argsText: string
  cwd: string
  url: string
  env: SecretRow[]
  headers: SecretRow[]
  timeoutMs: string
  retries: string
  allowPrivateNetwork: boolean
  description: string
  enabled: boolean
  oauthAuthorizationUrl: string
  oauthTokenUrl: string
  oauthClientId: string
  oauthScopes: string
}

const TRANSPORT_LABEL: Record<ConnectorTransport, string> = {
  stdio: '本机程序',
  http: '网络服务',
  sse: '网络服务（旧版）'
}

function emptyDraft(): Draft {
  return {
    originalName: null,
    transport: 'stdio',
    name: '',
    command: '',
    argsText: '',
    cwd: '',
    url: '',
    env: [],
    headers: [],
    timeoutMs: '',
    retries: '',
    allowPrivateNetwork: false,
    description: '',
    enabled: true,
    oauthAuthorizationUrl: '',
    oauthTokenUrl: '',
    oauthClientId: '',
    oauthScopes: ''
  }
}

function fromView(view: ConnectorView): Draft {
  return {
    originalName: view.name,
    transport: view.transport,
    name: view.name,
    command: view.command ?? '',
    argsText: (view.args ?? []).join('\n'),
    cwd: view.cwd ?? '',
    url: view.url ?? '',
    env: view.env.map((field) => ({ key: field.key, value: '', hasSecret: field.hasSecret, plaintext: field.plaintext })),
    headers: view.headers.map((field) => ({ key: field.key, value: '', hasSecret: field.hasSecret, plaintext: field.plaintext })),
    timeoutMs: view.timeoutMs !== undefined ? String(view.timeoutMs) : '',
    retries: view.retries !== undefined ? String(view.retries) : '',
    allowPrivateNetwork: view.allowPrivateNetwork,
    description: view.description ?? '',
    enabled: view.enabled,
    oauthAuthorizationUrl: view.oauth?.authorizationUrl ?? '',
    oauthTokenUrl: view.oauth?.tokenUrl ?? '',
    oauthClientId: view.oauth?.clientId ?? '',
    oauthScopes: (view.oauth?.scopes ?? []).join(' ')
  }
}

function transportIcon(transport: ConnectorTransport): React.JSX.Element {
  return transport === 'stdio' ? <Terminal size={14} strokeWidth={1.5} aria-hidden /> : <Server size={14} strokeWidth={1.5} aria-hidden />
}



function SecretRows({
  label,
  hint,
  rows,
  onChange,
  keyPlaceholder
}: {
  label: string
  hint: string
  rows: SecretRow[]
  onChange: (rows: SecretRow[]) => void
  keyPlaceholder: string
}): React.JSX.Element {
  const update = (index: number, patch: Partial<SecretRow>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }
  return (
    <div className="conn-secrets">
      <div className="conn-secrets-head">
        <span className="conn-label">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus size={13} strokeWidth={1.6} />}
          onClick={() => onChange([...rows, { key: '', value: '', hasSecret: false, plaintext: false }])}
        >
          添加
        </Button>
      </div>
      <p className="conn-hint">{hint}</p>
      {rows.length === 0 ? <p className="conn-empty-inline">还没有配置。</p> : null}
      {rows.map((row, index) => (
        <div className="conn-secret-row" key={`${row.key}-${index}`}>
          <TextInput
            aria-label={`${label}键名`}
            className="conn-secret-key"
            placeholder={keyPlaceholder}
            value={row.key}
            mono
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <TextInput
            aria-label={`${label}值`}
            className="conn-secret-value"
            type="password"
            autoComplete="off"
            placeholder={row.hasSecret ? '已保存（输入新值可替换）' : row.plaintext ? '明文值（建议重新保存）' : '值'}
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <IconButton label={`删除${label} ${row.key || index + 1}`} size={28} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
            <Trash2 size={13} strokeWidth={1.5} aria-hidden />
          </IconButton>
        </div>
      ))}
    </div>
  )
}

function ToolList({ tools }: { tools: ConnectorToolInfo[] }): React.JSX.Element {
  return (
    <div className="conn-tools">
      {tools.map((tool) => (
        <details className="conn-tool" key={tool.name}>
          <summary className="conn-tool-summary">
            <span className="conn-tool-name mono">{tool.name}</span>
            <span className="conn-tool-desc">{tool.description || '（无描述）'}</span>
          </summary>
          {tool.inputSchema ? <pre className="conn-tool-schema">{JSON.stringify(tool.inputSchema, null, 2)}</pre> : null}
        </details>
      ))}
    </div>
  )
}

function CopyChip({ value, label }: { value: string; label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="conn-copy"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {copied ? <Check size={10} strokeWidth={1.8} aria-hidden /> : <Copy size={10} strokeWidth={1.6} aria-hidden />}
      {copied ? '已复制' : '复制'}
    </button>
  )
}

function ResourceCatalog({ resources }: { resources: NonNullable<ConnectorTestResult['resources']> }): React.JSX.Element {
  return (
    <details className="conn-catalog">
      <summary className="conn-catalog-summary">
        资源 <span className="mono">{resources.resources.length}</span>
        <span className="conn-catalog-sub">模板 <span className="mono">{resources.templates.length}</span></span>
      </summary>
      <div className="conn-catalog-list">
        {resources.resources.map((item) => (
          <div className="conn-catalog-row" key={item.uri}>
            <span className="conn-catalog-name mono truncate" title={item.uri}>
              {item.uri}
            </span>
            <span className="conn-catalog-desc truncate">{item.name || item.description || item.mimeType || ''}</span>
            <CopyChip value={item.uri} label={`复制资源 URI ${item.uri}`} />
          </div>
        ))}
        {resources.templates.map((item) => (
          <div className="conn-catalog-row is-template" key={item.uriTemplate}>
            <span className="conn-catalog-name mono truncate" title={item.uriTemplate}>
              {item.uriTemplate}
            </span>
            <span className="conn-catalog-desc truncate">{item.name || item.description || 'URI 模板'}</span>
            <CopyChip value={item.uriTemplate} label={`复制资源模板 ${item.uriTemplate}`} />
          </div>
        ))}
        {resources.resources.length === 0 && resources.templates.length === 0 ? (
          <p className="conn-hint">该 server 没有公布资源。</p>
        ) : null}
      </div>
    </details>
  )
}

function PromptCatalog({ prompts }: { prompts: NonNullable<ConnectorTestResult['prompts']> }): React.JSX.Element {
  return (
    <details className="conn-catalog">
      <summary className="conn-catalog-summary">
        提示词 <span className="mono">{prompts.prompts.length}</span>
      </summary>
      <div className="conn-catalog-list">
        {prompts.prompts.map((prompt) => (
          <div className="conn-catalog-row" key={prompt.name}>
            <span className="conn-catalog-name mono truncate">{prompt.name}</span>
            <span className="conn-catalog-desc truncate">
              {prompt.description || ''}
              {prompt.arguments?.length ? ` · 参数：${prompt.arguments.map((arg) => arg.name).join('、')}` : ''}
            </span>
            <CopyChip value={prompt.name} label={`复制提示词名称 ${prompt.name}`} />
          </div>
        ))}
        {prompts.prompts.length === 0 ? <p className="conn-hint">该 server 没有公布提示词。</p> : null}
      </div>
    </details>
  )
}

function TestResult({ result }: { result: ConnectorTestResult }): React.JSX.Element {
  if (result.ok) {
    return (
      <div className="conn-test conn-test-ok" role="status">
        <p className="conn-test-title">
          <Check size={14} strokeWidth={1.8} aria-hidden /> 连接成功 · {TRANSPORT_LABEL[result.transport]} · {result.latencyMs}ms ·{' '}
          {result.tools?.length ?? 0} 个工具
          {result.resources?.supported ? ` · ${result.resources.resources.length} 个资源` : ''}
          {result.prompts?.supported ? ` · ${result.prompts.prompts.length} 个提示词` : ''}
        </p>
        {result.warnings && result.warnings.length > 0 ? (
          <ul className="conn-notes">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        {result.tools && result.tools.length > 0 ? <ToolList tools={result.tools} /> : <p className="conn-hint">该 server 没有公布工具。</p>}
        {result.resources?.supported ? <ResourceCatalog resources={result.resources} /> : null}
        {result.prompts?.supported ? <PromptCatalog prompts={result.prompts} /> : null}
        {result.resources?.supported || result.prompts?.supported ? (
          <p className="conn-hint">
            资源和提示词可在对话中让 Morrow 通过 <code className="mono">mcp_resources</code> /{' '}
            <code className="mono">mcp_prompt</code> 读取；每次读取都会单独请求审批。
          </p>
        ) : null}
      </div>
    )
  }
  return (
    <div className="conn-test conn-test-error" role="alert">
      <p className="conn-test-title">
        <AlertTriangle size={14} strokeWidth={1.8} aria-hidden /> 连接失败
        {result.blockedReason ? <span className="conn-test-reason mono">{result.blockedReason}</span> : null}
      </p>
      <p className="conn-test-message">{result.error ?? '未知错误'}</p>
      {result.hint ? <p className="conn-hint">{result.hint}</p> : null}
    </div>
  )
}

export function ConnectorsPanel({ open, onClose, workspace: workspaceProp }: ConnectorsPanelProps): React.JSX.Element | null {
  const sessionWorkspace = useAppStore((state) => state.session?.workspace ?? null)
  const lastWorkspace = useAppStore((state) => state.settings.lastWorkspace ?? null)
  const workspace = workspaceProp !== undefined ? workspaceProp : (sessionWorkspace ?? lastWorkspace)

  const [scope, setScope] = useState<ConnectorScope>('user')
  const [list, setList] = useState<ConnectorListResult | null>(null)
  const [paths, setPaths] = useState<ConnectorPaths | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'delete'>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [oauthStatus, setOauthStatus] = useState<ConnectorOAuthStatus | null>(null)
  const [oauthBusy, setOauthBusy] = useState(false)
  const [oauthMessage, setOauthMessage] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [secretMode, setSecretMode] = useState<SecretStorageMode>('encrypted')
  const [catalogOpen, setCatalogOpen] = useState(false)

  const workspaceRequired = scope === 'workspace' && !workspace

  const refresh = useCallback(
    async (nextScope: ConnectorScope = scope): Promise<void> => {
      if (nextScope === 'workspace' && !workspace) {
        setList(null)
        setLoading(false)
        setError(null)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const result = await connectorsApi.list(nextScope, nextScope === 'workspace' ? workspace : null)
        setList(result)
        setSecretMode(result.secretsMode)
      } catch (err) {
        setError(errorText(err, '读取外部工具列表失败。'))
      } finally {
        setLoading(false)
      }
    },
    [scope, workspace]
  )

  useEffect(() => {
    if (!open) return
    setCatalogOpen(false)
    setDeleteArmed(false)
    setTestResult(null)
    setNotice(null)
    void refresh(scope)
  }, [open, scope, refresh])

  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const [pathInfo, secretStatus] = await Promise.all([
          connectorsApi.paths(workspace),
          connectorsApi.secretStatus()
        ])
        setPaths(pathInfo)
        setSecretMode(secretStatus.mode)
      } catch (err) {
        setError(errorText(err, '读取外部工具配置信息失败。'))
      }
    })()
  }, [open, workspace])

  const selectSaved = useCallback(
    (name: string): void => {
      const view = list?.connectors.find((item) => item.name === name)
      if (!view) return
      setDraft(fromView(view))
      setIsNew(false)
      setTestResult(null)
      setError(null)
      setNotice(null)
      setOauthMessage(null)
      setDeleteArmed(false)
    },
    [list]
  )

  const startNew = (): void => {
    setDraft(emptyDraft())
    setIsNew(true)
    setTestResult(null)
    setError(null)
    setNotice('手动添加外部工具：需要自己填写服务地址或启动命令。')
    setOauthStatus(null)
    setOauthMessage(null)
    setDeleteArmed(false)
  }

  const updateDraft = (patch: Partial<Draft>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
    setNotice(null)
    setTestResult(null)
  }

  const selectedName = !isNew && draft?.originalName ? draft.originalName : null

  useEffect(() => {
    if (!open || !selectedName) {
      setOauthStatus(null)
      return
    }
    let cancelled = false
    void connectorsApi
      .oauthStatus(scope, selectedName, workspace)
      .then((status) => {
        if (!cancelled) setOauthStatus(status)
      })
      .catch(() => {
        if (!cancelled) setOauthStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [open, selectedName, scope, workspace])

  useEffect(() => {
    if (!open || !selectedName) return
    return window.morrow.features.on(CONNECTOR_CHANNELS.oauthEvent, (payload) => {
      const event = payload as { name?: string; status?: string; message?: string }
      if (event.name !== selectedName) return
      if (event.status === 'success') {
        setOauthMessage('授权成功，已保存加密令牌。')
      } else if (event.status === 'refreshed') {
        setOauthMessage('访问令牌已自动刷新。')
      } else if (event.status === 'revoked') {
        setOauthMessage('授权已清除。')
      } else if (event.status === 'error') {
        setOauthMessage(event.message ?? '授权失败。')
      } else {
        return
      }
      void connectorsApi
        .oauthStatus(scope, selectedName, workspace)
        .then(setOauthStatus)
        .catch(() => undefined)
    })
  }, [open, selectedName, scope, workspace])

  const authorizeOAuth = async (): Promise<void> => {
    if (!selectedName) {
      setOauthMessage('请先保存外部工具，再开始 OAuth 授权。')
      return
    }
    if (!draft) return
    setOauthBusy(true)
    setOauthMessage(null)
    try {
      // 授权读取的是磁盘配置；先保存当前表单，避免用旧端点发起授权
      const saved = await persist(draft)
      if (!saved) return
      const { authorizationUrl } = await connectorsApi.oauthStart(scope, saved.name, scope === 'workspace' ? workspace : null)
      await window.morrow.app.openExternal(authorizationUrl)
      setOauthMessage('已在浏览器打开授权页；完成后回到这里查看状态。')
    } catch (err) {
      setOauthMessage(errorText(err, '开始授权失败'))
    } finally {
      setOauthBusy(false)
    }
  }

  const revokeOAuth = async (): Promise<void> => {
    if (!selectedName) return
    setOauthBusy(true)
    try {
      await connectorsApi.oauthRevoke(scope, selectedName, scope === 'workspace' ? workspace : null)
      setOauthStatus(await connectorsApi.oauthStatus(scope, selectedName, scope === 'workspace' ? workspace : null))
      setOauthMessage('授权已清除。')
    } catch (err) {
      setOauthMessage(errorText(err, '清除授权失败'))
    } finally {
      setOauthBusy(false)
    }
  }

  const buildPayload = (current: Draft): Parameters<typeof connectorsApi.save>[0] => {
    const transport = current.transport
    const args = current.argsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const numeric = (value: string): number | undefined => {
      if (!value.trim()) return undefined
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return {
      scope,
      ...(scope === 'workspace' && workspace ? { workspace } : {}),
      ...(current.originalName ? { originalName: current.originalName } : {}),
      name: current.name.trim(),
      transport,
      ...(transport === 'stdio'
        ? {
            command: current.command.trim(),
            ...(args.length > 0 ? { args } : {}),
            ...(current.cwd.trim() ? { cwd: current.cwd.trim() } : {}),
            env: current.env
              .filter((row) => row.key.trim())
              .map((row) => ({ key: row.key.trim(), ...(row.value ? { value: row.value } : {}) }))
          }
        : {
            url: current.url.trim(),
            headers: current.headers
              .filter((row) => row.key.trim())
              .map((row) => ({ key: row.key.trim(), ...(row.value ? { value: row.value } : {}) })),
            oauth:
              current.oauthAuthorizationUrl.trim() &&
              current.oauthTokenUrl.trim() &&
              current.oauthClientId.trim()
                ? {
                    authorizationUrl: current.oauthAuthorizationUrl.trim(),
                    tokenUrl: current.oauthTokenUrl.trim(),
                    clientId: current.oauthClientId.trim(),
                    ...(current.oauthScopes.trim()
                      ? { scopes: current.oauthScopes.trim().split(/\s+/).filter(Boolean).slice(0, 20) }
                      : {})
                  }
                : null
          }),
      ...(numeric(current.timeoutMs) !== undefined ? { timeoutMs: numeric(current.timeoutMs) } : {}),
      ...(numeric(current.retries) !== undefined ? { retries: numeric(current.retries) } : {}),
      ...(current.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      ...(current.description.trim() ? { description: current.description.trim() } : {}),
      enabled: current.enabled
    }
  }

  const validateDraft = (current: Draft): string | null => {
    if (!current.name.trim()) return '请填写外部工具名称。'
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(current.name.trim())) {
      return '名称只能包含字母、数字、下划线、点、短横线，最长 64 字符。'
    }
    const duplicate = list?.connectors.find((item) => item.name === current.name.trim())
    if (duplicate && (isNew || duplicate.name !== current.originalName)) {
      return `名称「${current.name.trim()}」已被另一个外部工具使用。`
    }
    if (current.transport === 'stdio' && !current.command.trim()) return 'stdio 外部工具需要填写启动命令（command）。'
    if (current.transport !== 'stdio' && !current.url.trim()) return 'HTTP/SSE 外部工具需要填写 URL。'
    const oauthFields = [current.oauthAuthorizationUrl, current.oauthTokenUrl, current.oauthClientId].map((value) => value.trim())
    if (current.transport !== 'stdio' && oauthFields.some(Boolean) && !oauthFields.every(Boolean)) {
      return 'OAuth 需要同时填写授权地址、令牌地址和 Client ID（或全部留空）。'
    }
    const timeout = current.timeoutMs.trim()
    if (timeout && (!Number.isFinite(Number(timeout)) || Number(timeout) < 250 || Number(timeout) > 120_000)) {
      return '超时时间需在 250–120000 毫秒之间。'
    }
    return null
  }

  const persist = async (current: Draft): Promise<ConnectorView | null> => {
    const validation = validateDraft(current)
    if (validation) {
      setError(validation)
      return null
    }
    const saved = await connectorsApi.save(buildPayload(current))
    await refresh(scope)
    setDraft(fromView(saved.connector))
    setIsNew(false)
    setNotice('已保存。每次调用外部工具仍会先询问你。')
    try {
      setOauthStatus(
        saved.connector.oauth
          ? await connectorsApi.oauthStatus(scope, saved.connector.name, scope === 'workspace' ? workspace : null)
          : null
      )
    } catch {
      setOauthStatus(null)
    }
    return saved.connector
  }

  const handleSave = async (): Promise<void> => {
    if (!draft) return
    setBusy('save')
    setError(null)
    setNotice(null)
    try {
      await persist(draft)
    } catch (err) {
      setError(errorText(err, '保存外部工具失败。'))
    } finally {
      setBusy(null)
    }
  }

  const handleTest = async (): Promise<void> => {
    if (!draft) return
    if (workspaceRequired) {
      setError('当前文件夹的外部工具需要先选择一个文件夹。')
      return
    }
    setBusy('test')
    setError(null)
    setNotice(null)
    setTestResult(null)
    try {
      // 已保存过的外部工具先保存再测（密钥不回显，必须用服务端已存的值测试）
      const view = selectedName ? await persist(draft) : null
      if (!view) {
        // 新建：直接测草稿（不写盘）
        const validation = validateDraft(draft)
        if (validation) {
          setError(validation)
          return
        }
        const payload = buildPayload(draft)
        const { scope: draftScope, workspace: draftWorkspace, ...rest } = payload
        const result = await connectorsApi.test({
          scope: draftScope,
          ...(draftWorkspace ? { workspace: draftWorkspace } : {}),
          draft: rest as unknown as Record<string, unknown>
        })
        setTestResult(result)
        if (!result.ok) setError(null)
        return
      }
      const result = await connectorsApi.test({
        scope,
        ...(scope === 'workspace' && workspace ? { workspace } : {}),
        name: view.name
      })
      setTestResult(result)
    } catch (err) {
      setError(errorText(err, '测试连接失败。'))
    } finally {
      setBusy(null)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!selectedName) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      return
    }
    setBusy('delete')
    setError(null)
    try {
      await connectorsApi.remove(scope, selectedName, scope === 'workspace' ? workspace : null)
      setDeleteArmed(false)
      setDraft(null)
      setIsNew(false)
      setTestResult(null)
      setNotice('已删除该外部工具，并清理了它保存的密钥。')
      await refresh(scope)
    } catch (err) {
      setError(errorText(err, '删除外部工具失败。'))
    } finally {
      setBusy(null)
    }
  }

  const handleToggle = async (view: ConnectorView, enabled: boolean): Promise<void> => {
    try {
      await connectorsApi.setEnabled(scope, view.name, enabled, scope === 'workspace' ? workspace : null)
      await refresh(scope)
      setNotice(enabled ? `已启用「${view.name}」。` : `已停用「${view.name}」。`)
    } catch (err) {
      setError(errorText(err, '切换启停失败。'))
    }
  }

  const handleTrustWorkspace = async (): Promise<void> => {
    if (!workspace) return
    try {
      await connectorsApi.trustWorkspace(workspace)
      await refresh('workspace')
      setNotice('已信任当前文件夹的外部工具配置。配置被改动后需要重新确认。')
    } catch (err) {
      setError(errorText(err, '信任文件夹配置失败。'))
    }
  }

  const handleCatalogInstalled = async (view: ConnectorView, test?: ConnectorTestResult): Promise<void> => {
    setCatalogOpen(false)
    setDraft(fromView(view))
    setIsNew(false)
    setOauthStatus(null)
    setOauthMessage(null)
    setDeleteArmed(false)
    setError(null)
    setTestResult(test ?? null)
    setNotice(
      test?.ok
        ? `已安装「${view.name}」，连接测试已通过。`
        : `已安装「${view.name}」。可以在这里点「测试连接」验证。`
    )
    await refresh(scope)
  }

  const workspaceTrust = list?.workspaceTrust
  const connectors = useMemo(() => list?.connectors ?? [], [list])
  const configPath = list?.configPath ?? (scope === 'workspace' ? '' : (paths?.userConfigPath ?? ''))

  if (!open) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="外部工具（MCP）"
      description="把 Morrow 接到本机程序或网络服务上，让它能用更多工具。每次外部操作都会先问你；密钥只保存在本机并加密。"
      width={940}
      ariaLabel="外部工具（MCP）"
    >
      {catalogOpen ? (
        <ConnectorDirectory
          scope={scope}
          workspace={workspace}
          installed={connectors}
          onBack={() => setCatalogOpen(false)}
          onInstalled={(view, test) => {
            void handleCatalogInstalled(view, test)
          }}
          onOpenInstalled={(name) => {
            setCatalogOpen(false)
            selectSaved(name)
          }}
        />
      ) : (
      <div className="conn" data-testid="connectors-panel">
        <div className="conn-top">
          <Segmented<ConnectorScope>
            value={scope}
            ariaLabel="作用范围"
            onChange={(next) => {
              setScope(next)
              setDraft(null)
              setIsNew(false)
              setTestResult(null)
              setError(null)
              setNotice(null)
              setOauthStatus(null)
              setOauthMessage(null)
              setDeleteArmed(false)
            }}
            options={[
              { value: 'user', label: '所有对话', description: '对所有对话生效，保存在应用数据里' },
              { value: 'workspace', label: '当前文件夹', description: '只在当前文件夹生效（.morrow/mcp.json）' }
            ]}
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={13} strokeWidth={1.6} className={loading ? 'conn-spin' : undefined} />}
            onClick={() => void refresh(scope)}
            disabled={loading}
          >
            刷新
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<LayoutGrid size={13} strokeWidth={1.6} />}
            onClick={() => setCatalogOpen(true)}
          >
            工具目录
          </Button>
          <Button
            size="sm"
            variant="gold"
            icon={<Plus size={14} strokeWidth={1.7} />}
            disabled={workspaceRequired}
            onClick={() => startNew()}
          >
            添加外部工具
          </Button>
        </div>

        <p className="conn-path mono" title={configPath}>
          保存位置：
          {configPath
            ? `…/${configPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}`
            : '尚未创建'}
        </p>

        {secretMode === 'plaintext-fallback' ? (
          <div className="conn-warn" role="alert">
            <AlertTriangle size={14} strokeWidth={1.7} aria-hidden />
            当前系统无法使用安全加密存储（safeStorage 不可用）：密钥会以降级方式保存在本机文件里。请只在受信任的电脑上使用。
          </div>
        ) : null}

        {scope === 'workspace' ? (
          <div className={['conn-workspace', workspaceTrust?.trusted ? 'is-trusted' : ''].join(' ')}>
            <ShieldCheck size={14} strokeWidth={1.6} aria-hidden />
            {!workspace ? (
              <span>当前文件夹的外部工具需要先选择一个文件夹。</span>
            ) : workspaceTrust?.trusted ? (
              <span>
                当前文件夹的配置已信任。改动 <span className="mono">.morrow/mcp.json</span> 后需要重新确认。
              </span>
            ) : (
              <>
                <span>文件夹里的配置默认不会自动运行，防止打开别人的项目时执行未知命令。保存后会自动记住；也可以手动信任当前内容。</span>
                <Button size="sm" variant="secondary" onClick={() => void handleTrustWorkspace()}>
                  信任当前配置
                </Button>
              </>
            )}
          </div>
        ) : null}

        {error ? <ErrorNote title="操作失败" detail={error} /> : null}
        {notice ? <p className="conn-notice">{notice}</p> : null}

        <div className="conn-main">
          <aside className="conn-list" aria-label="外部工具列表">
            {loading && connectors.length === 0 ? <EmptyHint>正在读取外部工具…</EmptyHint> : null}
            {!loading && connectors.length === 0 ? (
              <EmptyHint>
                还没有添加外部工具。
                <br />
                从「工具目录」一键安装，或点「添加外部工具」手动配置。
              </EmptyHint>
            ) : null}
            {connectors.map((view) => {
              const active = !isNew && draft?.originalName === view.name
              return (
                <div className={['conn-item', active ? 'is-active' : ''].join(' ')} key={view.name} data-testid="connector-item" data-name={view.name}>
                  <button type="button" className="conn-item-main" onClick={() => selectSaved(view.name)}>
                    <span className="conn-item-icon" aria-hidden>
                      {transportIcon(view.transport)}
                    </span>
                    <span className="conn-item-text">
                      <span className="conn-item-name">{view.name}</span>
                      <span className="conn-item-meta">
                        <Badge tone={view.transport === 'stdio' ? 'neutral' : 'gold'} mono>
                          {TRANSPORT_LABEL[view.transport]}
                        </Badge>
                        {view.enabled ? null : <span className="conn-item-off">已停用</span>}
                      </span>
                    </span>
                  </button>
                  <Switch
                    checked={view.enabled}
                    onChange={(next) => void handleToggle(view, next)}
                    label={`${view.enabled ? '停用' : '启用'} ${view.name}`}
                  />
                </div>
              )
            })}

          </aside>

          <section className="conn-detail" aria-label="外部工具编辑">
            {!draft ? (
              <div className="conn-placeholder">
                <EmptyHint>选择左侧外部工具查看/编辑，或点「添加外部工具」新建一个。</EmptyHint>
                <ul className="conn-notes">
                  <li>本机程序：填写启动命令和参数，密钥会隐藏保存。</li>
                  <li>网络服务：填写地址和密钥；只支持网页地址。</li>
                  <li>本机或内网地址默认不可访问，需要时手动打开。</li>
                  <li>每次调用外部工具都会先询问你。</li>
                </ul>
              </div>
            ) : (
              <>
                <div className="conn-form-head">
                  <TextInput
                    label="名称"
                    value={draft.name}
                    placeholder="例如 morrow_mock"
                    autoFocus
                    onChange={(event) => updateDraft({ name: event.target.value })}
                  />
                  <div className="conn-transport">
                    <span className="conn-label">连接方式</span>
                    <Segmented<ConnectorTransport>
                      value={draft.transport}
                      ariaLabel="连接方式"
                      onChange={(next) => {
                        if (next === draft.transport) return
                        updateDraft({
                          transport: next,
                          allowPrivateNetwork: next === 'stdio' ? false : draft.allowPrivateNetwork
                        })
                      }}
                      options={[
                        { value: 'stdio', label: 'stdio' },
                        { value: 'http', label: 'HTTP' },
                        { value: 'sse', label: 'SSE' }
                      ]}
                    />
                  </div>
                  <Switch checked={draft.enabled} onChange={(next) => updateDraft({ enabled: next })} label="启用" />
                </div>

                {draft.transport === 'stdio' ? (
                  <>
                    <TextInput
                      label="启动命令"
                      mono
                      value={draft.command}
                      placeholder="node 或 C:\\path\\to\\node.exe"
                      onChange={(event) => updateDraft({ command: event.target.value })}
                      hint="Windows 不支持 .cmd/.bat 启动器；请填 .exe 完整路径或 Node 脚本路径。"
                    />
                    <TextArea
                      label="启动参数（每行一个）"
                      className="conn-mono-area"
                      rows={3}
                      value={draft.argsText}
                      placeholder={'C:\\path\\to\\mock-server.mjs\n--flag'}
                      onChange={(event) => updateDraft({ argsText: event.target.value })}
                    />
                    <TextInput
                      label="工作目录（可选）"
                      mono
                      value={draft.cwd}
                      placeholder="C:\\path\\to\\folder"
                      onChange={(event) => updateDraft({ cwd: event.target.value })}
                    />
                    <SecretRows
                      label="环境变量"
                      hint="值会被系统加密保存并掩码显示；已保存的值不会回显，重新输入即可替换。"
                      keyPlaceholder="API_KEY"
                      rows={draft.env}
                      onChange={(rows) => updateDraft({ env: rows })}
                    />
                  </>
                ) : (
                  <>
                    <TextInput
                      label="服务地址"
                      mono
                      value={draft.url}
                      placeholder={draft.transport === 'http' ? 'https://mcp.example.com/mcp' : 'https://mcp.example.com/sse'}
                      onChange={(event) => updateDraft({ url: event.target.value })}
                      hint="只支持 http:// 或 https:// 的地址。"
                    />
                    <SecretRows
                      label="请求头 headers"
                      hint="鉴权用请求头（例如 Authorization: Bearer …）；值会被系统加密保存并掩码显示。"
                      keyPlaceholder="Authorization"
                      rows={draft.headers}
                      onChange={(rows) => updateDraft({ headers: rows })}
                    />
                    <div className="conn-oauth">
                      <p className="conn-oauth-title">OAuth 2.0（可选）</p>
                      <p className="conn-hint">
                        有些 MCP 服务需要先授权。填好下面的地址后点「开始授权」，Morrow 会自动带上令牌；不用填 client_secret。地址由服务商提供。
                      </p>
                      <TextInput
                        label="授权地址"
                        mono
                        value={draft.oauthAuthorizationUrl}
                        placeholder="https://auth.example.com/oauth/authorize"
                        onChange={(event) => updateDraft({ oauthAuthorizationUrl: event.target.value })}
                      />
                      <TextInput
                        label="令牌地址"
                        mono
                        value={draft.oauthTokenUrl}
                        placeholder="https://auth.example.com/oauth/token"
                        onChange={(event) => updateDraft({ oauthTokenUrl: event.target.value })}
                      />
                      <div className="conn-grid">
                        <TextInput
                          label="Client ID"
                          mono
                          value={draft.oauthClientId}
                          onChange={(event) => updateDraft({ oauthClientId: event.target.value })}
                        />
                        <TextInput
                          label="Scope（空格分隔）"
                          mono
                          value={draft.oauthScopes}
                          placeholder="mcp.read mcp.write"
                          onChange={(event) => updateDraft({ oauthScopes: event.target.value })}
                        />
                      </div>
                      <div className="conn-oauth-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!selectedName || oauthBusy}
                          onClick={() => void authorizeOAuth()}
                        >
                          {oauthBusy ? '处理中…' : oauthStatus?.authorized ? '重新授权' : '开始授权'}
                        </Button>
                        {oauthStatus?.authorized ? (
                          <Button size="sm" variant="ghost" disabled={oauthBusy} onClick={() => void revokeOAuth()}>
                            清除授权
                          </Button>
                        ) : null}
                        <span className="conn-oauth-status">
                          {!selectedName
                            ? '先保存外部工具，再开始授权'
                            : oauthStatus?.authorized
                              ? oauthStatus.expired
                                ? oauthStatus.hasRefreshToken
                                  ? '令牌已过期，正在尝试自动刷新；如持续失败请重新授权'
                                  : '令牌已过期，请重新授权'
                                : `已授权${oauthStatus.expiresAt ? ` · 有效期至 ${new Date(oauthStatus.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}`
                              : oauthStatus?.configured
                                ? '未授权'
                                : '填写端点并保存后可授权'}
                        </span>
                      </div>
                      {oauthMessage ? <p className="conn-hint">{oauthMessage}</p> : null}
                    </div>
                    <Switch
                      checked={draft.allowPrivateNetwork}
                      onChange={(next) => updateDraft({ allowPrivateNetwork: next })}
                      label="允许访问本机/内网地址"
                      description="只有信任这个地址时才打开；本机或内网服务默认不连接。"
                    />
                  </>
                )}

                <div className="conn-grid">
                  <TextInput
                    label="超时 ms"
                    mono
                    inputMode="numeric"
                    value={draft.timeoutMs}
                    placeholder="15000"
                    onChange={(event) => updateDraft({ timeoutMs: event.target.value })}
                    hint="单个 JSON-RPC 请求超时（250–120000）。"
                  />
                  {draft.transport === 'stdio' ? null : (
                    <TextInput
                      label="重试次数"
                      mono
                      inputMode="numeric"
                      value={draft.retries}
                      placeholder="2"
                      onChange={(event) => updateDraft({ retries: event.target.value })}
                      hint="瞬时网络错误/SSE 断线重连次数（0–5）。"
                    />
                  )}
                </div>

                <TextArea
                  label="说明（可选）"
                  rows={2}
                  value={draft.description}
                  placeholder="给自己看的备注，例如「公司知识库」"
                  onChange={(event) => updateDraft({ description: event.target.value })}
                />

                <ul className="conn-notes">
                  <li>每次调用外部工具都会先询问你，不会自动执行。</li>
                  <li>本机程序会在电脑上启动；网络服务会连接这个地址。只添加你信任的来源。</li>
                  <li>当前文件夹里的配置默认不会自动运行；保存后会记住当时的内容，文件改动后需要重新确认。</li>
                </ul>

                {testResult ? <TestResult result={testResult} /> : null}
                <p className="conn-hint conn-action-hint">
                  测试或授权前会先保存当前修改；新建的外部工具只测试，不会写入。
                </p>

                <div className="conn-actions">
                  <Button
                    variant="secondary"
                    loading={busy === 'test'}
                    disabled={busy !== null}
                    icon={<ShieldCheck size={14} strokeWidth={1.7} />}
                    onClick={() => void handleTest()}
                  >
                    测试连接
                  </Button>
                  <Button variant="gold" loading={busy === 'save'} disabled={busy !== null} onClick={() => void handleSave()}>
                    保存
                  </Button>
                  {selectedName ? (
                    <Button
                      variant="danger"
                      loading={busy === 'delete'}
                      disabled={busy !== null}
                      icon={<Trash2 size={14} strokeWidth={1.6} />}
                      onClick={() => void handleDelete()}
                    >
                      {deleteArmed ? '确认删除' : '删除'}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      setDraft(null)
                      setIsNew(false)
                      setTestResult(null)
                      setError(null)
                      setNotice(null)
                      setDeleteArmed(false)
                    }}
                  >
                    取消
                  </Button>
                </div>
                {deleteArmed ? (
                  <p className="conn-hint" role="alert">
                    再次点击「确认删除」会删除该外部工具及其保存的密钥，且不可恢复。
                  </p>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>
      )}
    </Modal>
  )
}

