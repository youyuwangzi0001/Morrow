import { useMemo, useState } from 'react'
import { ChevronDown, Globe2, ExternalLink } from 'lucide-react'
import type { WebSearchSource } from '@shared/types'
import { useAppStore } from '../../store'
import './SourcesTray.css'

interface SessionSource extends WebSearchSource {
  query: string
  provider: string
}

interface SourceGroup {
  query: string
  provider: string
  sources: SessionSource[]
}

function collectSourceGroups(
  session: ReturnType<typeof useAppStore.getState>['session']
): SourceGroup[] {
  if (!session) return []
  const seen = new Set<string>()
  const groups = new Map<string, SourceGroup>()
  for (const message of session.messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== 'web_search' || block.status !== 'success') continue
      const meta = block.result?.meta
      if (!meta || !Array.isArray(meta.sources)) continue
      const query = typeof meta.query === 'string' ? meta.query : ''
      const provider = typeof meta.provider === 'string' ? meta.provider : ''
      const key = `${provider}\u0000${query}`
      let group = groups.get(key)
      if (!group) {
        group = { query, provider, sources: [] }
        groups.set(key, group)
      }
      for (const raw of meta.sources as Array<Record<string, unknown>>) {
        const url = typeof raw.url === 'string' ? raw.url : ''
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
        seen.add(url)
        group.sources.push({
          rank: typeof raw.rank === 'number' ? raw.rank : group.sources.length + 1,
          title: typeof raw.title === 'string' ? raw.title : url,
          url,
          snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
          ...(typeof raw.publishedAt === 'string' ? { publishedAt: raw.publishedAt } : {}),
          ...(typeof raw.engine === 'string' ? { engine: raw.engine } : {}),
          query,
          provider
        })
      }
    }
  }
  return [...groups.values()].filter((group) => group.sources.length > 0)
}

/** 对话级来源面板：汇总所有 web_search 结果，点击用系统浏览器打开。 */
export function SourcesTray(): React.JSX.Element | null {
  const session = useAppStore((s) => s.session)
  const openExternal = useAppStore((s) => s.openExternal)
  const [expanded, setExpanded] = useState(false)
  const groups = useMemo(() => collectSourceGroups(session), [session])
  const sources = useMemo(() => groups.flatMap((group) => group.sources), [groups])

  if (sources.length === 0) return null

  return (
    <section className={['sources-tray', expanded ? 'is-expanded' : ''].filter(Boolean).join(' ')} aria-label="来源">
      <button type="button" className="sources-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <Globe2 size={13} strokeWidth={1.5} className="sources-icon" aria-hidden />
        <span className="sources-title">来源</span>
        <span className="sources-count mono">{sources.length}</span>
        {!expanded ? <span className="sources-preview truncate">{sources[0]?.title}</span> : null}
        <span className="sources-hint mono">{expanded ? '收起' : '查看'}</span>
        <ChevronDown size={13} strokeWidth={1.6} className="sources-chevron" aria-hidden />
      </button>
      {expanded ? (
        <ul className="sources-list">
          {groups.map((group) => (
            <li key={`${group.provider}:${group.query}`} className="sources-group">
              {groups.length > 1 ? (
                <div className="sources-group-head">
                  <span className="sources-group-query truncate">{group.query || '搜索结果'}</span>
                  <span className="sources-group-provider mono">{group.provider}</span>
                </div>
              ) : null}
              <ol className="sources-group-list">
                {group.sources.map((source, index) => (
                  <li key={source.url} className="sources-item">
                    <span className="sources-rank mono">[{source.rank || index + 1}]</span>
                    <div className="sources-body">
                      <button type="button" className="sources-link" onClick={() => void openExternal(source.url)} title={source.url}>
                        <span className="sources-link-title">{source.title || source.url}</span>
                        <ExternalLink size={10} strokeWidth={1.6} aria-hidden />
                      </button>
                      {source.snippet ? <p className="sources-snippet">{source.snippet}</p> : null}
                      <span className="sources-url mono">{source.url}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
