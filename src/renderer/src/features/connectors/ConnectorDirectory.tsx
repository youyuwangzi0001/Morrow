/**
 * A3 连接器目录视图（渲染在 ConnectorsPanel 内，不是另一套连接器管理）。
 * - 目录条目来自 shared/connector-catalog；安装走 feature:connectors:install，真实写配置并可选真实测试。
 * - 本机服务会先检测 Node.js/npx；没有运行时明确提示，不伪造安装成功。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Brain,
  Check,
  ExternalLink,
  FileText,
  FolderOpen,
  Github,
  Globe2,
  ListOrdered,
  LoaderCircle,
  MonitorPlay,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SquareKanban,
  Terminal
} from 'lucide-react'
import type { ConnectorCatalogEntry, ConnectorRuntimeStatus } from '@shared/connector-catalog'
import { Badge, Button, Spinner, TextInput } from '../../ui'
import {
  connectorsApi,
  type ConnectorScope,
  type ConnectorTestResult,
  type ConnectorView
} from './connectors-api'
import { errorText } from '../../lib'
import './ConnectorDirectory.css'

export interface ConnectorDirectoryProps {
  scope: ConnectorScope
  workspace: string | null
  installed: ConnectorView[]
  onBack: () => void
  onInstalled: (view: ConnectorView, test?: ConnectorTestResult) => void
  onOpenInstalled: (name: string) => void
}

type CatalogFilter = 'all' | 'remote' | 'local'

function shortenPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

function CatalogIcon({ entry, size = 17 }: { entry: ConnectorCatalogEntry; size?: number }): React.JSX.Element {
  if (entry.id === 'github-remote') return <Github size={size} strokeWidth={1.5} aria-hidden />
  if (entry.id === 'linear-remote') return <SquareKanban size={size} strokeWidth={1.5} aria-hidden />
  if (entry.id === 'filesystem-local') return <FolderOpen size={size} strokeWidth={1.5} aria-hidden />
  if (entry.id === 'memory-local') return <Brain size={size} strokeWidth={1.5} aria-hidden />
  if (entry.id === 'sequential-local') return <ListOrdered size={size} strokeWidth={1.5} aria-hidden />
  if (entry.id === 'notion-local') return <FileText size={size} strokeWidth={1.5} aria-hidden />
  if (entry.id === 'playwright-local') return <MonitorPlay size={size} strokeWidth={1.5} aria-hidden />
  if (entry.id === 'context7-local') return <BookOpen size={size} strokeWidth={1.5} aria-hidden />
  return entry.category === 'remote' ? <Globe2 size={size} strokeWidth={1.5} aria-hidden /> : <Terminal size={size} strokeWidth={1.5} aria-hidden />
}

export function ConnectorDirectory({
  scope,
  workspace,
  installed,
  onBack,
  onInstalled,
  onOpenInstalled
}: ConnectorDirectoryProps): React.JSX.Element {
  const [entries, setEntries] = useState<ConnectorCatalogEntry[]>([])
  const [runtime, setRuntime] = useState<ConnectorRuntimeStatus | null>(null)
  const [runtimeChecking, setRuntimeChecking] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CatalogFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState<null | 'test' | 'install'>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [testFailure, setTestFailure] = useState<ConnectorTestResult | null>(null)
  const [picking, setPicking] = useState(false)
  const installBusyRef = useRef(false)

  const installedNames = useMemo(() => new Set(installed.map((item) => item.name)), [installed])

  const detectRuntime = useCallback(async (force = false): Promise<void> => {
    setRuntimeChecking(true)
    try {
      setRuntime(await connectorsApi.runtime(force))
    } catch {
      setRuntime(null)
    } finally {
      setRuntimeChecking(false)
    }
  }, [])


  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const catalog = await connectorsApi.catalog()
      setEntries([...catalog.entries])
    } catch (err) {
      setError(errorText(err, '读取工具目录失败。'))
    } finally {
      setLoading(false)
    }
    // 运行时检测可能较慢（缺少 Node.js 时要等子进程超时），不要挡住目录展示。
    void detectRuntime()
  }, [detectRuntime])

  useEffect(() => {
    void load()
  }, [load])

  const refreshRuntime = async (): Promise<void> => {
    // 用户可能刚装好 Node.js 或改了 PATH：必须绕过运行时的 30 秒缓存
    await detectRuntime(true)
  }

  const selected = entries.find((entry) => entry.id === selectedId) ?? null
  const selectedInstalled = selected ? installed.find((item) => item.name === selected.name) ?? null : null
  const runtimeReady = Boolean(runtime?.npx.available)
  const workspaceMissing = scope === 'workspace' && !workspace
  const requiresRuntime = Boolean(selected?.requiresNpx)
  const installDisabled =
    !selected ||
    busy !== null ||
    workspaceMissing ||
    (requiresRuntime && !runtimeReady) ||
    (selected.requiresToken && !token.trim()) ||
    (selected.requiresFolder && !folder.trim())

  const visibleEntries = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return entries.filter((entry) => {
      if (filter !== 'all' && entry.category !== filter) return false
      if (!keyword) return true
      return [entry.label, entry.name, entry.vendor, entry.description, entry.detail]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    })
  }, [entries, filter, query])

  const choose = (entry: ConnectorCatalogEntry): void => {
    setSelectedId(entry.id)
    setToken('')
    setFolder('')
    setInstallError(null)
    setTestFailure(null)
  }

  const pickFolder = async (): Promise<void> => {
    setPicking(true)
    setInstallError(null)
    try {
      const result = await window.morrow.workspace.pick()
      if (!result.ok) {
        setInstallError(result.error.message)
        return
      }
      if (result.data) setFolder(result.data.path)
    } catch (err) {
      setInstallError(errorText(err, '选择文件夹失败'))
    } finally {
      setPicking(false)
    }
  }

  const install = async (test: boolean): Promise<void> => {
    if (!selected || installBusyRef.current) return
    installBusyRef.current = true
    setBusy(test ? 'test' : 'install')
    setInstallError(null)
    setTestFailure(null)
    try {
      const result = await connectorsApi.install({
        scope,
        ...(scope === 'workspace' && workspace ? { workspace } : {}),
        id: selected.id,
        ...(token.trim() ? { token: token.trim() } : {}),
        ...(folder.trim() ? { folder: folder.trim() } : {}),
        test
      })
      if (!result.saved) {
        setTestFailure(result.test ?? null)
        setInstallError(result.test?.error ?? '连接测试没有通过，尚未保存。')
        return
      }
      if (result.view) onInstalled(result.view, result.test)
    } catch (err) {
      setInstallError(errorText(err, '安装外部工具失败。'))
    } finally {
      installBusyRef.current = false
      setBusy(null)
    }
  }

  return (
    <div className="cd-root" data-testid="connector-directory">
      <div className="cd-top">
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} strokeWidth={1.7} />} onClick={onBack}>
          返回已安装
        </Button>
        <div className="cd-title-wrap">
          <span className="cd-title serif">外部工具目录</span>
          <span className="cd-scope mono">
            安装到：{scope === 'workspace' ? (workspace ? shortenPath(workspace) : '当前文件夹（未选择）') : '所有对话'}
          </span>
        </div>
        <Badge tone={runtimeReady ? 'success' : 'neutral'} mono>
          <Terminal size={10} strokeWidth={1.7} />{' '}
          {runtimeChecking
            ? 'Node.js 检测中'
            : runtimeReady
              ? '本机服务可用 · Node.js'
              : '本机服务需要 Node.js'}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={12} strokeWidth={1.6} className={runtimeChecking ? 'conn-spin' : undefined} />}
          disabled={runtimeChecking}
          onClick={() => void refreshRuntime()}
        >
          重新检测
        </Button>
      </div>

      {workspaceMissing ? (
        <p className="cd-banner is-warn">
          <AlertTriangle size={13} strokeWidth={1.7} /> 目录当前安装到「当前文件夹」，但还没有选择文件夹；返回已安装页先选择文件夹，或切换到「所有对话」。
        </p>
      ) : null}
      {runtime && !runtimeReady ? (
        <p className="cd-banner is-warn">
          <AlertTriangle size={13} strokeWidth={1.7} />
          <span>
            本机服务需要 Node.js。装好 Node.js LTS 后点「重新检测」即可。
            <button type="button" className="cd-link" onClick={() => void window.morrow.app.openExternal('https://nodejs.org/en/download')}>
              打开 Node.js 下载页 <ExternalLink size={10} strokeWidth={1.7} />
            </button>
          </span>
        </p>
      ) : null}
      {error ? <p className="cd-error">{error}</p> : null}

      <div className="conn-main cd-main">
        <aside className="conn-list cd-list" aria-label="外部工具目录列表">
          <div className="cd-search">
            <Search size={13} strokeWidth={1.6} aria-hidden />
            <input
              value={query}
              placeholder="搜索外部工具"
              aria-label="搜索外部工具目录"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="cd-filters" role="radiogroup" aria-label="目录分类">
            {(
              [
                ['all', '全部'],
                ['remote', '在线服务'],
                ['local', '本机服务']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={filter === value}
                className={filter === value ? 'is-active' : ''}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="cd-loading">
              <Spinner /> 正在读取目录…
            </div>
          ) : visibleEntries.length === 0 ? (
            <p className="cd-empty">没有匹配的外部工具。</p>
          ) : (
            visibleEntries.map((entry) => {
              const isInstalled = installedNames.has(entry.name)
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={['cd-item', selectedId === entry.id ? 'is-active' : ''].filter(Boolean).join(' ')}
                  aria-current={selectedId === entry.id ? 'true' : undefined}
                  onClick={() => choose(entry)}
                >
                  <span className="cd-item-icon" aria-hidden>
                    <CatalogIcon entry={entry} />
                  </span>
                  <span className="cd-item-main">
                    <span className="cd-item-name">
                      {entry.label}
                      {entry.official ? <span className="cd-official">官方</span> : <span className="cd-community">社区</span>}
                    </span>
                    <span className="cd-item-desc truncate">{entry.description}</span>
                    <span className="cd-item-meta mono">
                      {entry.category === 'remote' ? '在线' : '本机'}
                      {entry.requiresNpx ? ' · 需 Node.js' : ''}
                      {isInstalled ? ' · 已安装' : ''}
                    </span>
                  </span>
                  {isInstalled ? (
                    <span className="cd-installed-dot" title="已安装" />
                  ) : null}
                </button>
              )
            })
          )}
        </aside>

        <section className="conn-detail cd-detail" aria-label="外部工具目录详情">
          {!selected ? (
            <div className="cd-intro">
              <span className="cd-intro-orb" aria-hidden>
                <Globe2 size={24} strokeWidth={1.2} />
              </span>
              <h3 className="cd-intro-title serif">把常用工具接进来</h3>
              <p>
                目录里的地址和包名都来自官方；安装会把配置写进本机，并加密保存密钥或 Token。可以先测试再保存。
              </p>
              <ul className="cd-notes">
                <li>
                  <ShieldCheck size={12} strokeWidth={1.6} /> 密钥或 Token 只保存在本机，不会发给模型。
                </li>
                <li>
                  <Server size={12} strokeWidth={1.6} /> 在线服务无需安装 Node.js；本机服务需要 Node.js。
                </li>
                <li>
                  <AlertTriangle size={12} strokeWidth={1.6} /> 需要 OAuth 授权的服务（如 Sentry、Notion）不在目录里自动安装，避免伪造授权；可以在外部工具列表里手动填写。
                </li>
              </ul>
            </div>
          ) : (
            <>
              <header className="cd-head">
                <span className="cd-head-icon" aria-hidden>
                  <CatalogIcon entry={selected} size={22} />
                </span>
                <div className="cd-head-text">
                  <div className="cd-head-top">
                    <h3 className="cd-name">{selected.label}</h3>
                    <Badge tone={selected.official ? 'gold' : 'neutral'} mono>
                      {selected.official ? '官方' : '社区'}
                    </Badge>
                    <Badge tone="neutral" mono>
                      {selected.category === 'remote' ? '在线服务' : '本机服务'}
                    </Badge>
                    {selectedInstalled ? <Badge tone="success">已安装</Badge> : null}
                  </div>
                  <p className="cd-vendor">{selected.vendor}</p>
                </div>
                <button
                  type="button"
                  className="cd-docs"
                  onClick={() => void window.morrow.app.openExternal(selected.docsUrl)}
                  title={selected.docsLabel}
                >
                  文档 <ExternalLink size={10} strokeWidth={1.7} />
                </button>
              </header>

              <p className="cd-detail-text">{selected.detail}</p>

              {selected.notes?.length ? (
                <ul className="cd-notes">
                  {selected.notes.map((note) => (
                    <li key={note}>
                      <AlertTriangle size={11} strokeWidth={1.6} /> {note}
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="cd-requirements">
                <div className="cd-requirement">
                  <span className="cd-req-label mono">连接方式</span>
                  <span>{selected.category === 'remote' ? '在线服务（无需安装 Node.js）' : '本机服务（需要 Node.js）'}</span>
                </div>
                {selected.requiresNpx ? (
                  <div className={['cd-requirement', runtimeReady ? 'is-ok' : 'is-warn'].join(' ')}>
                    <span className="cd-req-label mono">本机环境</span>
                    <span>
                      {runtimeReady ? (
                        <>
                          <Check size={11} strokeWidth={2} /> Node.js 已就绪（npx {runtime?.npx.version ?? ''}）
                        </>
                      ) : (
                        '未检测到 Node.js，安装前请先安装 Node.js LTS。'
                      )}
                    </span>
                  </div>
                ) : null}
                {selected.requiresToken ? (
                  <div className="cd-field">
                    <TextInput
                      label={selected.tokenLabel ?? '访问令牌'}
                      type="password"
                      autoComplete="off"
                      placeholder={selected.tokenPlaceholder ?? '粘贴令牌'}
                      value={token}
                      onChange={(event) => {
                        setToken(event.target.value)
                        setInstallError(null)
                        setTestFailure(null)
                      }}
                    />
                    {selected.tokenHint ? <p className="cd-hint">{selected.tokenHint}</p> : null}
                  </div>
                ) : null}
                {selected.requiresFolder ? (
                  <div className="cd-field">
                    <span className="cd-req-label mono">允许访问的文件夹</span>
                    <div className="cd-folder-row">
                      <FolderOpen size={14} strokeWidth={1.5} aria-hidden />
                      <span className="cd-folder-path truncate" title={folder || undefined}>
                        {folder ? shortenPath(folder) : '还没有选择文件夹'}
                      </span>
                      <Button variant="ghost" size="sm" loading={picking} onClick={() => void pickFolder()}>
                        选择文件夹
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>

              {installError ? (
                <div className="cd-install-error" role="alert">
                  <p>{installError}</p>
                  {testFailure?.hint ? <p className="cd-hint">{testFailure.hint}</p> : null}
                  {testFailure ? <p className="cd-hint">可以修正上面的信息后重试，或选择「仅安装，稍后测试」。</p> : null}
                </div>
              ) : null}

              <div className="cd-actions">
                {selectedInstalled ? (
                  <>
                    <Button variant="gold" size="sm" onClick={() => onOpenInstalled(selected.name)}>
                      已安装 · 查看配置
                    </Button>
                    <span className="cd-hint">同名连接器已经在当前范围里，无需重复安装。</span>
                  </>
                ) : (
                  <>
                    <Button
                      variant="gold"
                      size="sm"
                      disabled={installDisabled}
                      icon={busy === 'test' ? <LoaderCircle size={13} className="conn-spin" /> : <Check size={13} strokeWidth={1.8} />}
                      onClick={() => void install(true)}
                    >
                      {busy === 'test' ? '安装并测试中…' : '安装并测试'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={installDisabled || busy !== null}
                      icon={busy === 'install' ? <LoaderCircle size={13} className="conn-spin" /> : <Terminal size={13} strokeWidth={1.6} />}
                      onClick={() => void install(false)}
                    >
                      {busy === 'install' ? '安装中…' : '仅安装'}
                    </Button>
                    {selected.requiresNpx ? <span className="cd-hint">首次安装可能需要下载服务，最多等待 2 分钟。</span> : null}
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
