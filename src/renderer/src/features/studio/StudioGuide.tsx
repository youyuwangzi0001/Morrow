import { useEffect, useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { Button } from '../../ui'
import { useAppStore } from '../../store'
import { useStudioStore } from './studio-store'
import { StudioMark } from './StudioMark'

const STEPS = [
  { title: '先写一句', caption: '一句话就是入口' },
  { title: '查看蓝图', caption: '确认前不花钱' },
  { title: '开始制作', caption: '纸页、分镜与成片' }
]

const STAGE_NOTES = ['一句话', '蓝图', '章节 / 分镜', '配音 / 音乐', '交付']

export function StudioGuide(): React.JSX.Element | null {
  const guideOpen = useStudioStore((state) => state.guideOpen)
  const closeGuide = useStudioStore((state) => state.closeGuide)
  const openDemo = useStudioStore((state) => state.openDemo)
  const version = useAppStore((state) => state.appInfo?.version)
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (!guideOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeGuide()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [guideOpen, closeGuide])
  if (!guideOpen) return null
  return (
    <div className="studio-guide" role="dialog" aria-modal="true" aria-label="创作台使用指引">
      <div className="studio-guide-glow" aria-hidden />
      <header className="studio-guide-top">
        <div className="studio-guide-brand">
          <StudioMark size={32} />
          <span className="studio-guide-word serif">创作台</span>
          <span className="studio-guide-caption mono">第一次使用，先看三件事</span>
        </div>
        <button type="button" className="studio-guide-skip" onClick={closeGuide}>跳过指引</button>
      </header>

      <main className="studio-guide-body">
        <nav className="studio-guide-nav" aria-label="指引步骤">
          {STEPS.map((item, index) => {
            const state = index < step ? 'done' : index === step ? 'current' : 'todo'
            return (
              <button
                key={item.title}
                type="button"
                className={`is-${state}`}
                aria-current={index === step ? 'step' : undefined}
                onClick={() => setStep(index)}
              >
                <span className="studio-guide-node" aria-hidden>
                  {state === 'done' ? <Check size={9} strokeWidth={2.4} /> : null}
                </span>
                <span className="studio-guide-step-copy">
                  <span className="studio-guide-step-label">{item.title}</span>
                  <span className="studio-guide-step-caption">{item.caption}</span>
                </span>
              </button>
            )
          })}
        </nav>

        <section className="studio-guide-panel">
          {step === 0 ? (
            <div className="studio-guide-content" key="one-sentence">
              <span className="studio-eyebrow">01 / 一句话</span>
              <h1 className="studio-guide-title">先写一句，<br />剩下交给创作台。</h1>
              <p className="studio-guide-lead">中短篇、长篇和漫剧共用同一套创作流程。你只需要说清想做什么，不必先想章节名或镜头号。</p>
              <ul className="studio-guide-features">
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>中短篇</b><em>3–8 万字，12 章起；按章节写、改、导出。</em></span>
                </li>
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>长篇</b><em>20–100 万字；分卷、设定与前后衔接检查。</em></span>
                </li>
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>漫剧</b><em>30–180 秒；分镜、配音、音乐与成片。</em></span>
                </li>
              </ul>
              <p className="studio-guide-fine">第一份蓝图由本机生成，不调用付费模型。</p>
            </div>
          ) : null}
          {step === 1 ? (
            <div className="studio-guide-content" key="blueprint">
              <span className="studio-eyebrow">02 / 先看蓝图</span>
              <h1 className="studio-guide-title">先看蓝图，<br />再决定花多少。</h1>
              <p className="studio-guide-lead">蓝图画清故事主线、人物、结构、风格与费用区间。你点“确认并开始”之后，才会产生正文或媒体费用。</p>
              <ul className="studio-guide-features">
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>先看蓝图</b><em>故事主线、人物、结构与费用区间一次看清。</em></span>
                </li>
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>不确认不扣费</b><em>正文、画面与配音都从确认之后才开始。</em></span>
                </li>
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>手改优先</b><em>候选稿只放在候选区，不会覆盖你改过的段落。</em></span>
                </li>
              </ul>
              <p className="studio-guide-budget-line"><span>默认预算上限</span><b className="mono">¥30.00</b><em>可随时在“模型与预算”里调整</em></p>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="studio-guide-content" key="make">
              <span className="studio-eyebrow">03 / 开始制作</span>
              <h1 className="studio-guide-title">从纸页到成片，<br />每个决定都看得见。</h1>
              <p className="studio-guide-lead">小说走大纲、纸页、候选稿与导出；漫剧走分镜、画面、配音、音乐、时间线与成片。随时回到 Agent，现场不会丢。</p>
              <ul className="studio-guide-features">
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>纸页与分镜</b><em>小说按章节写作，漫剧按镜头推进；两者共用人物与设定。</em></span>
                </li>
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>交付可验证</b><em>字幕、成片与工程包都能在本机打开，不依赖云端。</em></span>
                </li>
              </ul>
              <div className="studio-guide-pipeline" aria-label="制作流程">
                {STAGE_NOTES.map((note, index) => (
                  <span key={note}>
                    <em>{note}</em>
                    {index < STAGE_NOTES.length - 1 ? <ArrowRight size={11} aria-hidden /> : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="studio-guide-actions">
            {step < STEPS.length - 1 ? (
              <Button variant="gold" iconRight={<ArrowRight size={13} />} onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}>下一步</Button>
            ) : (
              <Button variant="gold" iconRight={<ArrowRight size={13} />} onClick={closeGuide}>开始创作</Button>
            )}
            <button type="button" className="studio-guide-text-action" onClick={openDemo}>
              看演示
            </button>
          </div>
          <p className="studio-guide-hint">随时可以从作品库右上角再看；演示不联网，也不会花额度。</p>
        </section>
      </main>

      <footer className="studio-guide-foot">
        <span className="mono">{version ? `v${version}` : ''}</span>
        <i />
        <span>一句话开始，确认后才花钱</span>
        <i />
        <span>随时可以跳过</span>
      </footer>
    </div>
  )
}
