/**
 * R10-G MCP 连接器管理面板（独立受控组件，Lead 负责挂载）。
 *
 * 用法：
 *   <ConnectorsPanel open={connectorsOpen} onClose={() => setConnectorsOpen(false)} />
 *   // 可选 workspace={string|null} 覆盖；不传时自动取当前会话/最近工作区。
 *
 * 能力：列表（名称/transport/启用状态）、新增/编辑/删除/启停、测试连接并查看工具列表、
 * stdio（command/args/env/cwd）与 HTTP/SSE（url/headers）表单、密钥掩码（不显示明文，只写新值）、
 * 用户级/工作区级切换、模板（仅配置示例）、安全说明。
 * 样式全部使用全局 tokens（石墨/香槟金），无自建主题、无外边框卡片。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Loader2, Plus, RefreshCw, Server, ShieldCheck, Terminal, Trash2 } from 'lucide-react'
import { Badge, Button, EmptyHint, ErrorNote, IconButton, Modal, Segmented, Switch, TextArea, TextInput } from '../../ui'
import { useAppStore } from '../../state/store'
import {
  connectorsApi,
  CONNECTOR_CHANNELS,
  type ConnectorListResult,
  type ConnectorScope,
  type ConnectorTemplate,
  type ConnectorTestResult,
  type ConnectorToolInfo,
  type ConnectorTransport,
  type ConnectorView,
  type ConnectorPaths,
  type SecretStorageMode
} from './connectors-api'
import './ConnectorsPanel.css'

export interface ConnectorsPanelProps {
  open: boolean
  onClose: () => void
  /** 可选：显式指定工作区；不传时用当前会话/最近工作区 */
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
    enabled: true
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
    enabled: view.enabled
  }
}

function draftFromTemplate(template: ConnectorTemplate): Draft {
  const draft = emptyDraft()
  draft.transport = template.transport
  draft.command = template.command ?? ''
  draft.argsText = (template.args ?? []).join('\n')
  draft.url = template.url ?? ''
  draft.description = template.description
  draft.headers = (template.headerKeys ?? []).map((key) => ({ key, value: '', hasSecret: false, plaintext: false }))
  return draft
}

function transportIcon(transport: ConnectorTransport): React.JSX.Element {
  return transport === 'stdio' ? <Terminal size={14} strokeWidth={1.5} aria-hidden /> : <Server size={14} strokeWidth={1.5} aria-hidden />
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
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

function TestResult({ result }: { result: ConnectorTestResult }): React.JSX.Element {
  if (result.ok) {
    return (
      <div className="conn-test conn-test-ok" role="status">
        <p className="conn-test-title">
          <Check size={14} strokeWidth={1.8} aria-hidden /> 连接成功 · {TRANSPORT_LABEL[result.transport]} · {result.latencyMs}ms ·{' '}
          {result.tools?.length ?? 0} 个工具
        </p>
        {result.warnings && result.warnings.length > 0 ? (
          <ul className="conn-notes">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        {result.tools && result.tools.length > 0 ? <ToolList tools={result.tools} /> : <p className="conn-hint">该 server 没有公布工具。</p>}
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
  const [templates, setTemplates] = useState<ConnectorTemplate[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'delete'>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [secretMode, setSecretMode] = useState<SecretStorageMode>('encrypted')

  const workspaceRequired = scope === 'workspace' && !workspace

  const refresh = useCallback(
    async (nextScope: ConnectorScope = scope): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const result = await connectorsApi.list(nextScope, nextScope === 'workspace' ? workspace : null)
        setList(result)
        setSecretMode(result.secretsMode)
      } catch (err) {
        setError(errorText(err, '读取连接器列表失败。'))
      } finally {
        setLoading(false)
      }
    },
    [scope, workspace]
  )

  useEffect(() => {
    if (!open) return
    setDeleteArmed(false)
    setTestResult(null)
    setNotice(null)
    void refresh(scope)
  }, [open, scope, refresh])

  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const [templateList, pathInfo, secretStatus] = await Promise.all([
          connectorsApi.templates(),
          connectorsApi.paths(workspace),
          connectorsApi.secretStatus()
        ])
        setTemplates(templateList)
        setPaths(pathInfo)
        setSecretMode(secretStatus.mode)
      } catch (err) {
        setError(errorText(err, '读取连接器配置信息失败。'))
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
      setDeleteArmed(false)
    },
    [list]
  )

  const startNew = (template?: ConnectorTemplate): void => {
    setDraft(template ? draftFromTemplate(template) : emptyDraft())
    setIsNew(true)
    setTestResult(null)
    setError(null)
    setNotice(template ? `已套用「${template.name}」配置示例；这只是示例，Morrow 不内置该服务。` : null)
    setDeleteArmed(false)
  }

  const updateDraft = (patch: Partial<Draft>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
    setNotice(null)
    setTestResult(null)
  }

  const selectedName = !isNew && draft?.originalName ? draft.originalName : null

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
              .map((row) => ({ key: row.key.trim(), ...(row.value ? { value: row.value } : {}) }))
          }),
      ...(numeric(current.timeoutMs) !== undefined ? { timeoutMs: numeric(current.timeoutMs) } : {}),
      ...(numeric(current.retries) !== undefined ? { retries: numeric(current.retries) } : {}),
      ...(current.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      ...(current.description.trim() ? { description: current.description.trim() } : {}),
      enabled: current.enabled
    }
  }

  const validateDraft = (current: Draft): string | null => {
    if (!current.name.trim()) return '请填写连接器名称。'
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(current.name.trim())) {
      return '名称只能包含字母、数字、下划线、点、短横线，最长 64 字符。'
    }
    if (current.transport === 'stdio' && !current.command.trim()) return 'stdio 连接器需要填写启动命令（command）。'
    if (current.transport !== 'stdio' && !current.url.trim()) return 'HTTP/SSE 连接器需要填写 URL。'
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
    setNotice('已保存。外部调用（mcp_call）仍然会逐次请求你的批准。')
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
      setError(errorText(err, '保存连接器失败。'))
    } finally {
      setBusy(null)
    }
  }

  const handleTest = async (): Promise<void> => {
    if (!draft) return
    if (workspaceRequired) {
      setError('工作区级连接器需要先打开一个工作区文件夹。')
      return
    }
    setBusy('test')
    setError(null)
    setNotice(null)
    setTestResult(null)
    try {
      // 已保存过的连接器先保存再测（密钥不回显，必须用服务端已存的值测试）
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
      setNotice('已删除该连接器，并清理了它保存的密钥。')
      await refresh(scope)
    } catch (err) {
      setError(errorText(err, '删除连接器失败。'))
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
      setNotice('已信任该工作区的 MCP 配置（绑定当前内容哈希；文件被改动后需重新信任）。')
    } catch (err) {
      setError(errorText(err, '信任工作区配置失败。'))
    }
  }

  const workspaceTrust = list?.workspaceTrust
  const connectors = useMemo(() => list?.connectors ?? [], [list])
  const configPath = list?.configPath ?? paths?.userConfigPath ?? ''

  if (!open) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="连接器"
      description="连接外部工具服务，让 Morrow 能做更多事。每次外部调用都会先征求你的同意；密钥只保存在本机并加密。"
      width={940}
      ariaLabel="MCP 连接器管理"
    >
      <div className="conn" data-testid="connectors-panel">
        <div className="conn-top">
          <Segmented<ConnectorScope>
            value={scope}
            ariaLabel="连接器作用域"
            onChange={(next) => {
              setScope(next)
              setDraft(null)
              setIsNew(false)
              setTestResult(null)
              setError(null)
              setNotice(null)
            }}
            options={[
              { value: 'user', label: '用户级', description: '对所有工作区生效（应用数据目录 mcp.json）' },
              { value: 'workspace', label: '工作区级', description: '仅当前工作区生效（.morrow/mcp.json，默认不自动信任）' }
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
          <Button size="sm" variant="gold" icon={<Plus size={14} strokeWidth={1.7} />} onClick={() => startNew()}>
            添加连接器
          </Button>
        </div>

        <p className="conn-path mono" title={configPath}>
          {configPath || '（未初始化配置路径）'}
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
              <span>工作区级连接器需要先打开一个工作区文件夹。</span>
            ) : workspaceTrust?.trusted ? (
              <span>
                当前工作区配置已信任（哈希绑定）。仓库里改动 <span className="mono">.morrow/mcp.json</span> 后会自动失效。
              </span>
            ) : (
              <>
                <span>工作区配置默认不被信任（防止仓库里的命令被自动执行）。在面板保存后会自动登记；也可以手动信任当前内容。</span>
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
          <aside className="conn-list" aria-label="连接器列表">
            {loading && connectors.length === 0 ? <EmptyHint>正在读取连接器…</EmptyHint> : null}
            {!loading && connectors.length === 0 ? (
              <EmptyHint>
                还没有{scope === 'workspace' ? '工作区级' : '用户级'}连接器。
                <br />
                点右上角「添加连接器」，或从下方模板开始。
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

            <div className="conn-templates">
              <p className="conn-label">从模板新建（仅配置示例）</p>
              <p className="conn-hint">模板只是填写示例，Morrow 不内置这些服务，也不会伪造连接成功。</p>
              {templates.map((template) => (
                <button type="button" className="conn-template" key={template.id} onClick={() => startNew(template)}>
                  <span className="conn-template-name">{template.name}</span>
                  <Badge tone="neutral" mono>
                    {TRANSPORT_LABEL[template.transport]}
                  </Badge>
                </button>
              ))}
            </div>
          </aside>

          <section className="conn-detail" aria-label="连接器编辑">
            {!draft ? (
              <div className="conn-placeholder">
                <EmptyHint>选择左侧连接器查看/编辑，或点「添加连接器」新建一个。</EmptyHint>
                <ul className="conn-notes">
                  <li>本机程序：填写启动命令和参数，密钥会隐藏保存。</li>
                  <li>网络服务：填写地址和密钥；只支持网页地址。</li>
                  <li>本机或内网地址默认不可访问，需要时手动打开。</li>
                  <li>每次外部调用都会先询问你。</li>
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
                    <span className="conn-label">传输</span>
                    <Segmented<ConnectorTransport>
                      value={draft.transport}
                      ariaLabel="MCP 传输类型"
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
                      label="启动命令 command"
                      mono
                      value={draft.command}
                      placeholder="node 或 C:\\path\\to\\node.exe"
                      onChange={(event) => updateDraft({ command: event.target.value })}
                      hint="Windows 不支持 .cmd/.bat 启动器；请填 .exe 完整路径或 Node 脚本路径。"
                    />
                    <TextArea
                      label="参数 args（每行一个）"
                      className="conn-mono-area"
                      rows={3}
                      value={draft.argsText}
                      placeholder={'C:\\path\\to\\mock-server.mjs\n--flag'}
                      onChange={(event) => updateDraft({ argsText: event.target.value })}
                    />
                    <TextInput
                      label="工作目录 cwd（可选）"
                      mono
                      value={draft.cwd}
                      placeholder="C:\\path\\to\\folder"
                      onChange={(event) => updateDraft({ cwd: event.target.value })}
                    />
                    <SecretRows
                      label="环境变量 env"
                      hint="值会被系统加密保存并掩码显示；已保存的值不会回显，重新输入即可替换。"
                      keyPlaceholder="API_KEY"
                      rows={draft.env}
                      onChange={(rows) => updateDraft({ env: rows })}
                    />
                  </>
                ) : (
                  <>
                    <TextInput
                      label="MCP endpoint URL"
                      mono
                      value={draft.url}
                      placeholder={draft.transport === 'http' ? 'https://mcp.example.com/mcp' : 'https://mcp.example.com/sse'}
                      onChange={(event) => updateDraft({ url: event.target.value })}
                      hint="只允许 http:// 或 https://；file://、javascript:、data: 等一律拒绝。"
                    />
                    <SecretRows
                      label="请求头 headers"
                      hint="鉴权用请求头（例如 Authorization: Bearer …）；值会被系统加密保存并掩码显示。"
                      keyPlaceholder="Authorization"
                      rows={draft.headers}
                      onChange={(rows) => updateDraft({ headers: rows })}
                    />
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
                  <li>外部调用（mcp_call）不属于「已保存即自动执行」：每次都会弹出审批。</li>
                  <li>本机程序会在电脑上启动；网络服务会连接这个地址。只添加你信任的来源。</li>
                  <li>工作区级配置默认不被信任，保存时登记当前内容哈希；文件被改动后自动失效。</li>
                </ul>

                {testResult ? <TestResult result={testResult} /> : null}

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
                    再次点击「确认删除」会删除该连接器及其保存的密钥，且不可恢复。
                  </p>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>
    </Modal>
  )
}

/** 供 Lead 挂载/调试用：频道清单（与主进程一致） */
export const CONNECTOR_FEATURE_CHANNELS = CONNECTOR_CHANNELS
