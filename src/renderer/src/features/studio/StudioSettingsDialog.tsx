import { useEffect, useRef, useState } from 'react'
import {
  ExternalLink,
  FileClock,
  Film,
  FolderCog,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Mic2,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { Button, Modal, Segmented } from '../../ui'
import { useAppStore } from '../../store'
import { useStudioStore } from './studio-store'
import { studioApi } from './api'
import { StudioProgress } from './components'
import { VersionHistoryPanel } from './VersionHistoryPanel'
import type { StudioDataDirInfo, StudioEngineStatus } from '@shared/studio'

export type StudioSettingsTab = 'models' | 'voice-engines' | 'versions' | 'data'

const TABS: Array<{ id: StudioSettingsTab; label: string; icon: LucideIcon }> = [
  { id: 'models', label: '模型与预算', icon: Sparkles },
  { id: 'voice-engines', label: '配音与引擎', icon: Wrench },
  { id: 'versions', label: '历史版本', icon: FileClock },
  { id: 'data', label: '数据与安全', icon: ShieldCheck }
]

const PAGE_META: Record<StudioSettingsTab, { title: string; description: string }> = {
  models: { title: '模型与预算', description: '选择先用本机还是云端模型，并为当前作品设定预算上限；密钥仍在 Agent 设置里。' },
  'voice-engines': { title: '配音与引擎', description: '决定草稿配音方式，并查看本机 ComfyUI、FFmpeg 与系统声线是否就绪。' },
  versions: { title: '历史版本', description: '作品自动留档的关键节点都在这里；恢复前会先备份当前版本。' },
  data: { title: '数据与安全', description: '作品、素材和任务记录都只存在本机；密钥由 Agent 设置保管。' }
}

function contextLabel(value?: number): string {
  if (!value) return ''
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M 上下文`
  if (value >= 1000) return `${Math.round(value / 1000)}k 上下文`
  return `${value} 上下文`
}

export function StudioSettingsDialog({
  open,
  onClose,
  initialTab = 'models',
  initialFocus
}: {
  open: boolean
  onClose: () => void
  initialTab?: StudioSettingsTab
  initialFocus?: 'budget'
}): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const refreshEngine = useStudioStore((state) => state.refreshEngine)
  const notify = useStudioStore((state) => state.notify)
  const openAppSettings = useAppStore((state) => state.openSettings)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const [tab, setTab] = useState<StudioSettingsTab>(initialTab)
  const [limit, setLimit] = useState(String(active?.runtime.budget.limit ?? 30))
  const [noLimit, setNoLimit] = useState((active?.runtime.budget.limit ?? 30) === 0)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [strategy, setStrategy] = useState(active?.runtime.strategy ?? 'local-first')
  const [routes, setRoutes] = useState<NonNullable<StudioEngineStatus['text']['routes']>>([])
  const [ttsMode, setTtsMode] = useState<'system' | 'cloud'>(active?.runtime.tts?.mode ?? 'system')
  const [ttsModel, setTtsModel] = useState(active?.runtime.tts?.model ?? 'tts-1')
  const [ttsVoice, setTtsVoice] = useState(active?.runtime.tts?.voice ?? '')
  const [dataInfo, setDataInfo] = useState<StudioDataDirInfo | null>(null)
  const [dataBusy, setDataBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setTab(initialTab)
    void studioApi.dataDirInfo().then(setDataInfo).catch(() => undefined)
  }, [open, initialTab])

  useEffect(() => {
    if (!open || initialFocus !== 'budget' || tab !== 'models') return
    const timer = window.setTimeout(() => {
      paneRef.current?.querySelector<HTMLElement>('[data-settings-section="budget"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [open, initialFocus, tab])

  useEffect(() => {
    if (!open) return
    setLimit(String(active?.runtime.budget.limit ?? 30))
    setNoLimit((active?.runtime.budget.limit ?? 30) === 0)
    setStrategy(active?.runtime.strategy ?? 'local-first')
    setTtsMode(active?.runtime.tts?.mode ?? 'system')
    setTtsModel(active?.runtime.tts?.model ?? 'tts-1')
    setTtsVoice(active?.runtime.tts?.voice ?? '')
  }, [open, active?.id, active?.runtime.budget.limit, active?.runtime.strategy, active?.runtime.tts?.mode, active?.runtime.tts?.model, active?.runtime.tts?.voice])

  useEffect(() => {
    if (!open || !active) return
    let cancelled = false
    void run<{ routes: NonNullable<StudioEngineStatus['text']['routes']> }>('text-routes', { strategy })
      .then((result) => {
        if (!cancelled) setRoutes(result.routes)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, active?.id, strategy, run])

  const budgetInvalid = Boolean(active) && !noLimit && !(Number(limit) > 0)

  const save = async (): Promise<void> => {
    if (!active) return
    setSaving(true)
    try {
      await run('update-runtime', {
        strategy,
        budget: { limit: noLimit ? 0 : Math.max(0, Number(limit) || 0), spent: active.runtime.budget.spent },
        tts: { mode: ttsMode, model: ttsModel, voice: ttsVoice }
      })
      notify('success', '创作台设置已保存。')
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const openFolder = async (): Promise<void> => {
    try {
      await studioApi.openDataDir()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }

  const changeStudioDataDir = async (): Promise<void> => {
    if (dataBusy) return
    setDataBusy(true)
    try {
      const result = await studioApi.changeDataDir()
      if (result.canceled) return
      setDataInfo(await studioApi.dataDirInfo())
      notify('info', result.restarted ? '创作台数据目录已更换，应用正在重启。' : `已切换到 ${result.path ?? '新目录'}。`)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setDataBusy(false)
    }
  }

  const resetStudioDataDir = async (): Promise<void> => {
    if (dataBusy) return
    setDataBusy(true)
    try {
      const result = await studioApi.resetDataDir()
      if (result.canceled) return
      setDataInfo(await studioApi.dataDirInfo())
      notify('info', result.restarted ? '正在恢复默认创作台目录并重启。' : `已恢复默认目录：${result.path ?? ''}`)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setDataBusy(false)
    }
  }

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshEngine()
      notify('info', '已重新检测这台电脑。')
    } finally {
      setRefreshing(false)
    }
  }

  const engineCards = (
    <div className="studio-engine-grid">
      <div className={`studio-engine-card ${engine?.media.imageReady ? 'is-on' : ''}`}>
        <span className="studio-engine-icon"><ImageIcon size={16} /></span>
        <div><b>画面引擎</b><span>{engine?.media.imageReady ? `已就绪${engine.media.gpu ? ` · ${engine.media.gpu}` : ''}` : engine?.media.message ?? '未检查'}</span></div>
        <i />
      </div>
      <div className={`studio-engine-card ${engine?.media.videoReady ? 'is-on' : ''}`}>
        <span className="studio-engine-icon"><Film size={16} /></span>
        <div><b>视频引擎</b><span>{engine?.media.videoReady ? '已就绪 · 图片可以变成视频' : '未就绪 · 草稿不需要视频'}</span></div>
        <i />
      </div>
      <div className={`studio-engine-card ${engine?.ffmpeg.available ? 'is-on' : ''}`}>
        <span className="studio-engine-icon"><Wrench size={16} /></span>
        <div><b>FFmpeg</b><span title={engine?.ffmpeg.available ? `FFmpeg ${engine.ffmpeg.profile === 'enhanced' ? '增强包' : '默认包'}` : engine?.ffmpeg.message ?? undefined}>{engine?.ffmpeg.available ? '已就绪' : engine?.ffmpeg.message ?? '未检查'}</span></div>
        <i />
      </div>
      <div className={`studio-engine-card ${engine?.voices.length ? 'is-on' : ''}`}>
        <span className="studio-engine-icon"><Mic2 size={16} /></span>
        <div><b>系统声线</b><span>{engine?.voices.length ? `${engine.voices.length} 个可用 · 可以做草稿配音` : engine?.voiceError ?? '未检测到'}</span></div>
        <i />
      </div>
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创作台设置"
      width={880}
      layer="overlay"
      footer={
        <div className="studio-modal-footer">
          <span className="studio-settings-foot-hint">模型、配音和预算要点“保存设置”；历史版本和数据会即时读取。</span>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          {active ? <Button variant="gold" onClick={() => void save()} loading={saving} disabled={budgetInvalid}>保存设置</Button> : null}
        </div>
      }
    >
      <div className="studio-settings-layout">
        <nav className="studio-settings-nav" role="tablist" aria-label="创作台设置">
          {TABS.map((item) => {
            const Icon = item.icon
            const disabled = !active && item.id === 'versions'
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={tab === item.id ? 'is-active' : ''}
                onClick={() => setTab(item.id)}
                disabled={disabled}
              >
                <span className="studio-settings-nav-icon" aria-hidden><Icon size={15} /></span>
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="studio-settings-pane" ref={paneRef}>
          <header className="studio-settings-head">
            <h2>{PAGE_META[tab].title}</h2>
            <p>{PAGE_META[tab].description}</p>
          </header>
          {tab === 'models' ? (
            <div className="studio-settings">
              <section className="studio-settings-section">
                <header><span className="studio-settings-title">文本模型</span><button type="button" onClick={() => void refresh()}>{refreshing ? <Loader2 size={12} className="studio-spin" /> : <RefreshCw size={12} />} 刷新</button></header>
                <div className={`studio-engine-card ${engine?.text.configured ? 'is-on' : ''}`}>
                  <span className="studio-engine-icon"><Sparkles size={16} /></span>
                  <div><b>当前使用</b><span title={engine?.text.message ?? undefined}>{engine?.text.configured ? `${engine.text.providerLabel} · ${engine.text.modelLabel}` : '还没有可用的文字模型，去 Agent 设置连接一个。'}</span></div>
                  <i />
                </div>
                <div className="studio-settings-actions">
                  <Button variant="secondary" size="sm" icon={<SlidersHorizontal size={12} />} onClick={() => { openAppSettings(); onClose() }}>去连接模型</Button>
                  <span>连接方式、密钥和订阅由 Agent 设置管理。</span>
                </div>
              </section>

              <section className="studio-settings-section" data-settings-section="budget">
                <header><span className="studio-settings-title">预算保护</span><span className="studio-settings-note">{noLimit ? '已关闭上限' : '花到上限会先停一下问你'}</span></header>
                {active ? (
                  <>
                    <div className="studio-budget-editor">
                      <label><span>项目预算上限</span><div><em>¥</em><input value={noLimit ? '' : limit} placeholder="不限" disabled={noLimit} onChange={(event) => setLimit(event.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" /><em>元</em></div></label>
                      <button
                        type="button"
                        className={['studio-budget-unlimited', noLimit ? 'is-on' : ''].filter(Boolean).join(' ')}
                        aria-pressed={noLimit}
                        onClick={() => {
                          if (noLimit) {
                            setNoLimit(false)
                            if (!(Number(limit) > 0)) setLimit('30')
                          } else {
                            setNoLimit(true)
                          }
                        }}
                      >
                        {noLimit ? '已不限' : '不设上限'}
                      </button>
                      <div className="studio-budget-stats">
                        <div><span>已花</span><b className="mono">¥{active.runtime.budget.spent.toFixed(2)}</b></div>
                        <div><span>最多</span><b className="mono">{noLimit ? '不限' : `¥${limit || '0'}`}</b></div>
                      </div>
                    </div>
                    {noLimit ? (
                      <p className="studio-settings-hint">没有上限：花费仍会逐项记录，付费动作开始前仍会先问你。</p>
                    ) : (
                      <>
                        <StudioProgress value={Number(limit) > 0 ? (active.runtime.budget.spent / Number(limit)) * 100 : 0} tone={active.runtime.budget.spent > Number(limit) ? 'rust' : 'gold'} />
                        {budgetInvalid ? <p className="studio-settings-hint">上限要大于 0；不想设上限就选「不设上限」。</p> : null}
                      </>
                    )}
                    <p className="studio-settings-hint">本机生成不额外收费；云端模型按服务商账单记录。不知道单价时会写“未知”，不会挡住任务。</p>
                  </>
                ) : (
                  <p className="studio-settings-hint">打开一部作品后可以设置花费上限。</p>
                )}
              </section>

              <section className="studio-settings-section">
                <header><span className="studio-settings-title">先用哪个模型</span><span className="studio-settings-note">保存后生效</span></header>
                <Segmented
                  value={strategy}
                  options={[
                    { value: 'local-first', label: '本机优先' },
                    { value: 'cloud-first', label: '云端优先' },
                    { value: 'local-only', label: '只本机' },
                    { value: 'cloud-only', label: '只云端' }
                  ]}
                  onChange={(value) => setStrategy(value as typeof strategy)}
                  ariaLabel="模型策略"
                />
                <p className="studio-settings-hint">
                  {strategy === 'local-first'
                    ? '先试这台电脑；做不到或会超预算时先问你，再换云端。'
                    : strategy === 'cloud-first'
                      ? '先试已经连好的云端模型；价格不明时会标“未知”，不猜账单。'
                      : strategy === 'local-only'
                        ? '只用这台电脑；本机做不到就直接说失败，不会偷偷联网。'
                        : '只用云端模型；合成和预览仍在这台电脑完成。'}
                </p>
              </section>

              <section className="studio-settings-section">
                <header><span className="studio-settings-title">实际会按这个顺序试</span><span className="studio-settings-note">按上面的选择排序</span></header>
                <div className="studio-route-table">
                  {routes.map((route) => (
                    <div key={`${route.providerId}:${route.modelId}`} className={`studio-route-row ${route.configured ? 'is-ready' : ''}`}>
                      <span className="studio-route-kind">{route.local ? '本机' : '云端'}</span>
                      <div><b>{route.providerLabel}</b><em>{route.modelLabel}{route.contextWindow ? ` · ${contextLabel(route.contextWindow)}` : ''}{route.supportsVision ? ' · 会看图' : ''}{route.supportsTools ? ' · 会用工具' : ''}</em></div>
                      <span className="mono" title="每百万 token 的输入 / 输出参考价">{route.inputPerMTok !== undefined && route.outputPerMTok !== undefined ? `参考价 $${route.inputPerMTok} / $${route.outputPerMTok}` : '价格未知'}</span>
                      <i>{route.configured ? '已连接' : '未连接'}</i>
                    </div>
                  ))}
                  {!routes.length ? <p className="studio-hint">当前没有可用的文本模型。到 Agent 设置里连接，或换成另一边再试。</p> : null}
                </div>
                <p className="studio-settings-hint">越靠前越先用；写作和预算估算用的是同一个模型。价格只作参考，以服务商账单为准。</p>
              </section>

            </div>
          ) : null}

          {tab === 'voice-engines' ? (
            <div className="studio-settings">
              <section className="studio-settings-section">
                <header><span className="studio-settings-title">配音方式</span><span className="studio-settings-note">{ttsMode === 'cloud' ? '用当前云端服务商' : 'Windows 自带'}</span></header>
                <Segmented
                  value={ttsMode}
                  options={[
                    { value: 'system', label: '系统声线' },
                    { value: 'cloud', label: '云端配音' }
                  ]}
                  onChange={(value) => setTtsMode(value === 'cloud' ? 'cloud' : 'system')}
                  ariaLabel="配音方式"
                />
                {ttsMode === 'cloud' ? (
                  <div className="studio-settings-inline">
                    <label><span>模型</span><input value={ttsModel} onChange={(event) => setTtsModel(event.target.value)} placeholder="例如 tts-1" /></label>
                    <label><span>声线</span><input value={ttsVoice} onChange={(event) => setTtsVoice(event.target.value)} placeholder="例如 alloy / 角色声" /></label>
                  </div>
                ) : null}
                <p className="studio-settings-hint">
                  {ttsMode === 'cloud'
                    ? '用当前云端服务商生成配音；不支持时会直接说明，不会偷偷换回系统声线。费用按账单记录，不知道就写未知。'
                    : '用 Windows 自带声线在本机生成，不额外收费；失败时可以去分镜页导入录音。'}
                </p>
                <div className={`studio-engine-card ${engine?.voices.length ? 'is-on' : ''}`}>
                  <span className="studio-engine-icon"><Mic2 size={16} /></span>
                  <div><b>系统声线</b><span>{engine?.voices.length ? `${engine.voices.length} 个可用` : engine?.voiceError ?? '未检测到系统声线'}</span></div>
                  <i />
                </div>
              </section>

              <section className="studio-settings-section">
                <header><span className="studio-settings-title">本机能力</span><button type="button" onClick={() => void refresh()}>{refreshing ? <Loader2 size={12} className="studio-spin" /> : <RefreshCw size={12} />} 刷新</button></header>
                {engineCards}
                <div className="studio-settings-actions">
                  <Button variant="secondary" size="sm" icon={<FolderOpen size={12} />} onClick={() => void openFolder()}>打开作品总文件夹</Button>
                  <Button variant="secondary" size="sm" icon={<SlidersHorizontal size={12} />} onClick={() => { openAppSettings(); onClose() }}>打开 Agent 设置</Button>
                </div>
                <p className="studio-settings-hint">画面生成需要本机 ComfyUI，视频合成需要 FFmpeg；它们不随 Morrow 一起安装。上方会显示实际检测结果。</p>
              </section>
            </div>
          ) : null}

          {tab === 'versions' ? (
            <VersionHistoryPanel onClose={onClose} />
          ) : null}

          {tab === 'data' ? (
            <div className="studio-settings">
              <section className="studio-settings-section">
                <header><span className="studio-settings-title">本机数据</span><span className="studio-settings-note">{dataInfo?.source === 'custom' ? '自定义创作台目录' : '全部在本机'}</span></header>
                <div className="studio-engine-grid">
                  <div className="studio-engine-card">
                    <span className="studio-engine-icon"><FolderOpen size={16} /></span>
                    <div><b>创作台数据</b><span title={dataInfo?.root ?? engine?.studioDataDir}>{dataInfo?.root ?? engine?.studioDataDir ?? '本地数据目录'}</span></div>
                    <button type="button" title="打开创作台数据文件夹" onClick={() => void openFolder()}><ExternalLink size={11} /></button>
                  </div>
                  <div className="studio-engine-card">
                    <span className="studio-engine-icon"><FileClock size={16} /></span>
                    <div><b>作品数量</b><span>{engine?.projectCount ?? 0} 部 · 自动留档，删除会先放进回收站</span></div>
                    <i />
                  </div>
                </div>
                <div className="studio-settings-actions">
                  <Button variant="gold" size="sm" icon={<FolderCog size={12} />} onClick={() => void changeStudioDataDir()} loading={dataBusy}>更换目录…</Button>
                  {dataInfo?.source === 'custom' ? <Button variant="ghost" size="sm" onClick={() => void resetStudioDataDir()} disabled={dataBusy}>恢复默认目录</Button> : null}
                  <Button variant="secondary" size="sm" icon={<FolderOpen size={12} />} onClick={() => void openFolder()}>打开创作台文件夹</Button>
                  <Button variant="secondary" size="sm" icon={<SlidersHorizontal size={12} />} onClick={() => { openAppSettings(); onClose() }}>打开 Agent 设置</Button>
                </div>
                <p className="studio-settings-hint">只迁移创作台作品、素材、历史版本与任务记录；Agent 对话、设置和密钥不移动。更换后应用会自动重启。</p>
              </section>
              <section className="studio-settings-security">
                <ShieldCheck size={16} />
                <div>
                  <b>密钥只保存在本机</b>
                  <p>作品、素材与任务记录都在本地；导出的文件不包含密钥、账号或旧应用数据。删除作品会先放进回收站。</p>
                </div>
                <span className="mono">只在本机</span>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
