import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, Eye, EyeOff, Folder, FolderOpen, KeyRound, Sparkles } from 'lucide-react'
import type { CompleteOnboardingInput } from '@shared/ipc'
import type { ProviderTestResult, WorkspaceInfo } from '@shared/types'
import { useAppStore } from '../../state/store'
import brandMarkUrl from '../../assets/brand-mark.svg'
import { Button, IconButton, Select } from '../../ui'
import './Onboarding.css'

type StepId = 1 | 2 | 3

const STEPS: { id: StepId; label: string; caption: string }[] = [
  { id: 1, label: '认识 Morrow', caption: '它是什么，能做什么' },
  { id: 2, label: '连接模型', caption: '用你自己的 API Key' },
  { id: 3, label: '选择文件夹', caption: '它可以在哪里动手' }
]

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export function Onboarding(): React.JSX.Element | null {
  const open = useAppStore((s) => s.onboardingOpen)
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const completeOnboarding = useAppStore((s) => s.completeOnboarding)
  const startDemo = useAppStore((s) => s.startDemo)
  const testProvider = useAppStore((s) => s.testProvider)
  const pickWorkspaceInfo = useAppStore((s) => s.pickWorkspaceInfo)
  const validateWorkspace = useAppStore((s) => s.validateWorkspace)

  // 首启只露出常用提供方；全部服务可在「设置 → 模型」里选择
  const providers = useMemo(
    () =>
      settings.providers.filter(
        (p) =>
          p.kind !== 'demo' &&
          ['deepseek', 'kimi', 'qwen', 'anthropic', 'openai', 'gemini'].includes(p.id)
      ),
    [settings.providers]
  )
  const [step, setStep] = useState<StepId>(1)
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [modelId, setModelId] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null)
  const [picking, setPicking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const testSeq = useRef(0)
  const submittingRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const provider = providers.find((p) => p.id === providerId) ?? providers[0] ?? null
  const recentWorkspaces = settings.recentWorkspaces.slice(0, 4)

  useEffect(() => {
    if (!open) return
    setStep(1)
    setProviderId(providers.find((p) => p.id === settings.defaultModel.providerId)?.id ?? providers[0]?.id ?? '')
    setApiKey('')
    setShowKey(false)
    setTestResult(null)
    setTesting(false)
    setWorkspace(null)
    setWorkspaceInfo(null)
    setError(null)
    testSeq.current += 1
    submittingRef.current = false
    // 每次打开引导时重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!provider) return
    setModelId(provider.models[0]?.id ?? '')
    // 切换提供方时不能把上一家的 Key 带到下一家
    setApiKey('')
    setShowKey(false)
    setTestResult(null)
    setTesting(false)
    setError(null)
    testSeq.current += 1
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id])

  /* 引导是模态层：焦点陷阱 + 关闭后还原焦点 */
  useEffect(() => {
    if (!open) return undefined
    const root = rootRef.current
    const previous = document.activeElement as HTMLElement | null
    const timer = window.setTimeout(() => root?.focus(), 60)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.getClientRects().length > 0)
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (!root.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [open])

  if (!open) return null

  const handleTest = async (): Promise<void> => {
    if (!provider) return
    const seq = ++testSeq.current
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      const result = await testProvider({
        providerId: provider.id,
        config: { ...provider, enabled: true },
        apiKey: apiKey.trim() || undefined,
        modelId: modelId || provider.models[0]?.id
      })
      if (seq === testSeq.current) setTestResult(result)
    } catch (err) {
      if (seq === testSeq.current) {
        setTestResult({ ok: false, latencyMs: 0, message: errorText(err, '连接测试失败。') })
      }
    } finally {
      if (seq === testSeq.current) setTesting(false)
    }
  }

  const handlePickWorkspace = async (): Promise<void> => {
    setPicking(true)
    setError(null)
    try {
      const info = await pickWorkspaceInfo()
      if (info) {
        setWorkspace(info.path)
        setWorkspaceInfo(info)
      }
    } catch (err) {
      setError(errorText(err, '选择文件夹失败。'))
    } finally {
      setPicking(false)
    }
  }

  const chooseRecentWorkspace = async (path: string): Promise<void> => {
    if (picking) return
    setPicking(true)
    setError(null)
    try {
      const info = await validateWorkspace(path)
      if (!info) {
        setError('这个文件夹已经不可用了，请重新选择。')
        return
      }
      setWorkspace(info.path)
      setWorkspaceInfo(info)
    } finally {
      setPicking(false)
    }
  }

  const finish = async (options?: { demo?: boolean }): Promise<void> => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      if (!options?.demo && workspace) {
        const info = await validateWorkspace(workspace)
        if (!info) {
          setWorkspace(null)
          setWorkspaceInfo(null)
          setStep(3)
          setError('这个文件夹已经不可用了，请重新选择，或先不选。')
          return
        }
      }
      const input: CompleteOnboardingInput = {}
      if (options?.demo) {
        input.demo = true
      } else {
        if (provider && apiKey.trim()) {
          input.providerId = provider.id
          input.apiKey = apiKey.trim()
        }
        if (provider && modelId) input.model = { providerId: provider.id, modelId }
        if (workspace) input.workspace = workspace
      }
      await completeOnboarding(input)
      const state = useAppStore.getState()
      if (state.onboardingOpen) {
        setError('初始化没有完成，请重试。也可以先看一场演示，之后再连接模型。')
        return
      }
      if (options?.demo) await startDemo()
    } catch (err) {
      setError(errorText(err, '初始化失败，请重试。'))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const goDemo = (): void => {
    void finish({ demo: true })
  }


  return (
    <div
      className="onb"
      role="dialog"
      aria-modal="true"
      aria-label="Morrow 首次引导"
      tabIndex={-1}
      ref={rootRef}
    >
      <div className="onb-glow" aria-hidden />
      <div className="grain-overlay" aria-hidden />

      <header className="onb-top">
        <div className="onb-brand">
          <span className="onb-brand-mark" aria-hidden>
            <img className="onb-brand-icon" src={brandMarkUrl} alt="" width={30} height={30} draggable={false} />
            <span className="onb-brand-horizon" aria-hidden />
          </span>
          <span className="onb-brand-word serif">Morrow</span>
          <span className="onb-brand-caption mono">明日工坊</span>
        </div>
        <button type="button" className="onb-skip" onClick={goDemo} disabled={submitting}>
          跳过引导，先看演示
        </button>
      </header>

      <main className="onb-panel">
        <nav className="onb-timeline" aria-label="引导进度">
          {STEPS.map((item) => {
            const state = item.id < step ? 'done' : item.id === step ? 'current' : 'todo'
            return (
              <div key={item.id} className={['onb-step', `is-${state}`].join(' ')}>
                <span className="onb-step-node" aria-hidden>
                  {state === 'done' ? <Check size={9} strokeWidth={2.4} /> : null}
                </span>
                <span className="onb-step-copy">
                  <span className="onb-step-label">{item.label}</span>
                  <span className="onb-step-caption">{item.caption}</span>
                </span>
              </div>
            )
          })}
        </nav>

        <section className="onb-body">
          {step === 1 ? (
            <div className="onb-content">
              <h1 className="onb-title serif">你好，我是 Morrow。</h1>
              <p className="onb-lead">
                住在你电脑里的 AI 工作伙伴。你说清想要的结果，它自己读文件、写代码、跑命令，
                把能直接用的成品放到你面前。
              </p>
              <ul className="onb-features">
                <li className="onb-feature">
                  <span className="onb-feature-node" aria-hidden />
                  <span>
                    <span className="onb-feature-title">它真的会动手</span>
                    <span className="onb-feature-desc">读取你的文件、运行命令、生成报告和网页，不只是聊天。</span>
                  </span>
                </li>
                <li className="onb-feature">
                  <span className="onb-feature-node" aria-hidden />
                  <span>
                    <span className="onb-feature-title">每一步都看得见</span>
                    <span className="onb-feature-desc">做了什么、改了哪里、为什么这么做，都在一条执行过程里。</span>
                  </span>
                </li>
                <li className="onb-feature">
                  <span className="onb-feature-node" aria-hidden />
                  <span>
                    <span className="onb-feature-title">你随时可以叫停</span>
                    <span className="onb-feature-desc">重要操作会先问你；不确定的，直接拒绝就好。</span>
                  </span>
                </li>
              </ul>
              <div className="onb-actions">
                <Button
                  variant="gold"
                  size="lg"
                  icon={<Sparkles size={14} strokeWidth={1.5} />}
                  onClick={goDemo}
                  disabled={submitting}
                >
                  先看一场演示
                </Button>
                <Button variant="ghost" size="lg" onClick={() => setStep(2)}>
                  开始设置
                </Button>
              </div>
              <p className="onb-fine">演示完全离线，不消耗任何额度；也可以先连接模型，再开始自己的任务。</p>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="onb-content">
              <h1 className="onb-title serif">把你的模型接进来。</h1>
              <p className="onb-lead">
                用你自己的 API Key 调用模型。Key 只保存在这台电脑上，由系统加密，界面里再也看不到明文。
              </p>

              <div className="onb-providers" role="radiogroup" aria-label="模型提供方">
                {providers.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={provider?.id === item.id}
                    className={['onb-provider', provider?.id === item.id ? 'is-active' : ''].filter(Boolean).join(' ')}
                    onClick={() => setProviderId(item.id)}
                  >
                    <span className={['onb-provider-radio', provider?.id === item.id ? 'is-on' : ''].filter(Boolean).join(' ')} aria-hidden />
                    <span className="onb-provider-name">{item.name}</span>
                    {item.apiKeyStored ? <span className="onb-provider-saved mono">已存 Key</span> : null}
                  </button>
                ))}
              </div>

              <div className="onb-field">
                <label className="onb-field-label" htmlFor="onb-api-key">
                  API Key
                </label>
                <div className="onb-key">
                  <KeyRound size={13} strokeWidth={1.5} aria-hidden />
                  <input
                    id="onb-api-key"
                    className="onb-key-input mono"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={provider?.apiKeyStored ? '已保存，留空表示不修改' : '粘贴你的 API Key'}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <IconButton
                    label={showKey ? '隐藏密钥' : '显示密钥'}
                    size={24}
                    onClick={() => setShowKey((value) => !value)}
                  >
                    {showKey ? <EyeOff size={13} strokeWidth={1.5} aria-hidden /> : <Eye size={13} strokeWidth={1.5} aria-hidden />}
                  </IconButton>
                </div>
              </div>

              <div className="onb-row">
                <div className="onb-field">
                  <span className="onb-field-label">默认模型</span>
                  <Select
                    ariaLabel="默认模型"
                    width={230}
                    value={modelId}
                    options={(provider?.models ?? []).map((model) => ({
                      value: model.id,
                      label: model.label,
                      description: model.note ?? `上下文 ${Math.round(model.contextWindow / 1000)}k`
                    }))}
                    onChange={(next) => setModelId(next)}
                  />
                </div>
                <Button size="sm" variant="secondary" loading={testing} onClick={() => void handleTest()}>
                  测试连接
                </Button>
              </div>

              {testResult ? (
                <p className={['onb-test-result', testResult.ok ? 'is-ok' : 'is-error'].join(' ')} role="status">
                  {testResult.ok ? `连接正常 · ${testResult.latencyMs}ms` : testResult.message}
                </p>
              ) : null}

              {error ? (
                <p className="onb-error" role="alert">
                  {error}
                </p>
              ) : null}

              <div className="onb-actions">
                <Button variant="ghost" icon={<ChevronLeft size={14} strokeWidth={1.5} />} onClick={() => setStep(1)}>
                  上一步
                </Button>
                <Button variant="gold" onClick={() => setStep(3)}>
                  下一步
                </Button>
                <button type="button" className="onb-escape" onClick={goDemo} disabled={submitting}>
                  还没有 Key，先看演示
                </button>
              </div>
              <p className="onb-fine">
                还没有 Key？可以在 {provider?.name ?? '提供方'} 官网创建，或先看演示；之后能在「设置 → 模型」里切换。
              </p>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="onb-content">
              <h1 className="onb-title serif">选一个文件夹当文件夹。</h1>
              <p className="onb-lead">
                Morrow 只会在这个文件夹里读写文件、运行命令。重要操作仍会先问你，随时可以换一个文件夹。
              </p>

              {workspace ? (
                <div className="onb-workspace is-chosen">
                  <span className="onb-workspace-icon" aria-hidden>
                    <Folder size={17} strokeWidth={1.5} />
                  </span>
                  <span className="onb-workspace-copy">
                    <span className="onb-workspace-name">{workspaceInfo?.name ?? workspace.split(/[\\/]/).pop()}</span>
                    <span className="onb-workspace-path mono">{workspace}</span>
                  </span>
                  {workspaceInfo ? (
                    <span className="onb-workspace-meta mono">{workspaceInfo.fileCount} 个文件</span>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => void handlePickWorkspace()} loading={picking}>
                    换一个
                  </Button>
                </div>
              ) : (
                <button type="button" className="onb-workspace" onClick={() => void handlePickWorkspace()} disabled={picking}>
                  <span className="onb-workspace-icon" aria-hidden>
                    <FolderOpen size={17} strokeWidth={1.5} />
                  </span>
                  <span className="onb-workspace-copy">
                    <span className="onb-workspace-name">{picking ? '正在打开文件夹…' : '选择文件夹'}</span>
                    <span className="onb-workspace-path mono">例如「桌面 / 工作」或某个项目文件夹</span>
                  </span>
                </button>
              )}

              {recentWorkspaces.length > 0 ? (
                <div className="onb-recent">
                  <p className="onb-field-label">最近用过</p>
                  <div className="onb-recent-list">
                    {recentWorkspaces.map((path) => (
                      <button
                        key={path}
                        type="button"
                        className={['onb-recent-item', workspace === path ? 'is-active' : ''].filter(Boolean).join(' ')}
                        disabled={picking}
                        onClick={() => void chooseRecentWorkspace(path)}
                        title={path}
                      >
                        <Folder size={12} strokeWidth={1.5} aria-hidden />
                        <span className="truncate">{path.split(/[\\/]/).filter(Boolean).pop()}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {error ? (
                <p className="onb-error" role="alert">
                  {error}
                </p>
              ) : null}

              <div className="onb-actions">
                <Button variant="ghost" icon={<ChevronLeft size={14} strokeWidth={1.5} />} onClick={() => setStep(2)}>
                  上一步
                </Button>
                <Button variant="gold" size="lg" loading={submitting} onClick={() => void finish()}>
                  完成，开始使用
                </Button>
                {!workspace ? (
                  <button type="button" className="onb-escape" onClick={() => void finish()} disabled={submitting}>
                    先不选，之后在设置里选
                  </button>
                ) : null}
              </div>
              <p className="onb-fine">
                文件夹之外的任何写入都会单独问你，不会悄悄改到别的地方。
              </p>
            </div>
          ) : null}
        </section>
      </main>

      <footer className="onb-foot">
        <span className="onb-foot-item mono">MORROW {appInfo?.version ? `v${appInfo.version}` : ''}</span>
        <span className="onb-foot-dot" aria-hidden />
        <span className="onb-foot-item">对话与文件都在你本机</span>
        <span className="onb-foot-dot" aria-hidden />
        <span className="onb-foot-item">随时可以跳过</span>
      </footer>
    </div>
  )
}
