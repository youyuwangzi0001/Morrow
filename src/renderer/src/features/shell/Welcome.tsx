import { ArrowUpRight, Folder, Sparkles } from 'lucide-react'
import { SUGGESTIONS, findModel } from '@shared/models'
import { useAppStore } from '../../state/store'
import './Welcome.css'

/* ── 编辑感问候：按时段变化 ───────────────────────────────────── */

function greetingOf(hour: number): { zh: string; en: string } {
  if (hour < 5) return { zh: '夜深了', en: 'Still up?' }
  if (hour < 11) return { zh: '早上好', en: 'Good morning' }
  if (hour < 13) return { zh: '中午好', en: 'Good afternoon' }
  if (hour < 18) return { zh: '下午好', en: 'Good afternoon' }
  return { zh: '晚上好', en: 'Good evening' }
}

function dateLine(date: Date): string {
  const week = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()]
  return `${date.getMonth() + 1}月${date.getDate()}日，周${week}。`
}

/** 每天换一句安静的提示，不做模板化小标签 */
const DAILY_NOTES = [
  '适合把散在桌面上的文件理一理',
  '适合把攒下的表格算成一个结论',
  '适合把一个想法写成能用的第一版',
  '适合让 Morrow 跑完一件拖了很久的小事',
  '适合把周报写完，然后去散个步',
  '适合慢慢读一份数据，找出一个问题',
  '适合先做最小的一步，剩下的交给它'
]

function noteOf(date: Date): string {
  const start = new Date(date.getFullYear(), 0, 0)
  const day = Math.floor((date.getTime() - start.getTime()) / 86_400_000)
  return DAILY_NOTES[day % DAILY_NOTES.length]
}

/* ── Welcome ─────────────────────────────────────────────────── */

export function Welcome(): React.JSX.Element {
  const demoAvailable = useAppStore((s) => s.demoAvailable)
  const startDemo = useAppStore((s) => s.startDemo)
  const onboardingDone = useAppStore((s) => s.settings.onboardingDone)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const hasAnyApiKey = useAppStore((s) => s.hasAnyApiKey)
  const workspace = useAppStore((s) => s.settings.lastWorkspace)
  const modelRef = useAppStore((s) => s.settings.defaultModel)
  const providers = useAppStore((s) => s.settings.providers)
  const openSettings = useAppStore((s) => s.openSettings)

  const now = new Date()
  const greeting = greetingOf(now.getHours())
  const model = findModel(providers, modelRef)
  const workspaceName = workspace ? (workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace) : null

  const openOnboarding = (): void => {
    useAppStore.setState({ onboardingOpen: true })
  }

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <p className="welcome-overline">
          {dateLine(now)}
          {noteOf(now)}。
        </p>

        <h1 className="welcome-title">
          <em className="welcome-en serif">{greeting.en},</em>
          <span className="welcome-zh">{greeting.zh}，今天想完成什么？</span>
        </h1>
        <p className="welcome-sub">说清想要的结果就行，过程我来想办法。</p>

        <div className="welcome-actions">
          {demoAvailable ? (
            <button type="button" className="welcome-demo" onClick={() => void startDemo()}>
              <Sparkles size={15} strokeWidth={1.5} aria-hidden />
              <span>看一场演示</span>
              <span className="welcome-demo-meta mono">离线 · 约 40 秒</span>
            </button>
          ) : null}
          {!onboardingDone ? (
            <button type="button" className="welcome-link" onClick={openOnboarding}>
              连接我的模型
              <ArrowUpRight size={13} strokeWidth={1.5} aria-hidden />
            </button>
          ) : null}
        </div>

        <div className="welcome-papers">
          {SUGGESTIONS.map((suggestion, index) => (
            <button
              key={suggestion.title}
              type="button"
              className={['welcome-paper', index === 0 ? 'is-wide' : ''].filter(Boolean).join(' ')}
              onClick={() => void sendMessage(suggestion.prompt)}
            >
              <span className="welcome-paper-text">
                <span className="welcome-paper-title">{suggestion.title}</span>
                <span className="welcome-paper-desc">{suggestion.description}</span>
              </span>
              <ArrowUpRight className="welcome-paper-arrow" size={14} strokeWidth={1.5} aria-hidden />
            </button>
          ))}
        </div>

        <div className="welcome-foot">
          <span className="welcome-foot-item">
            <Folder size={12} strokeWidth={1.5} aria-hidden />
            <span className="truncate">{workspaceName ?? '还没有工作区'}</span>
          </span>
          <span className="welcome-foot-dot" aria-hidden />
          {hasAnyApiKey ? (
            <span className="welcome-foot-item">
              <span className="welcome-model-dot is-on" aria-hidden />
              <span className="mono">{model?.label ?? '模型已就绪'}</span>
            </span>
          ) : (
            <button type="button" className="welcome-foot-item is-action" onClick={openSettings}>
              <span className="welcome-model-dot is-off" aria-hidden />
              模型未连接 · 去连接
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
