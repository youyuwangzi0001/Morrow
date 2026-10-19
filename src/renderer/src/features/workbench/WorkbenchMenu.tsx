import { BookOpen, Brain, FolderKanban, Globe2, Plug, Search, Sparkles } from 'lucide-react'
import { Modal } from '../../ui'
import type { WorkbenchPanel } from './events'
import './workbench.css'

interface Entry {
  id: WorkbenchPanel
  title: string
  description: string
  icon: React.ReactNode
  available: boolean
}

const ENTRIES: Entry[] = [
  {
    id: 'skills',
    title: '技能库',
    description: '发现、启用或安装工作流技能',
    icon: <Sparkles size={17} strokeWidth={1.5} />,
    available: true
  },
  {
    id: 'memory',
    title: '记忆中心',
    description: '查看、编辑和清理 Morrow 记住的事',
    icon: <Brain size={17} strokeWidth={1.5} />,
    available: true
  },
  {
    id: 'projects',
    title: '项目',
    description: '项目指令、知识文件与长期背景',
    icon: <FolderKanban size={17} strokeWidth={1.5} />,
    available: true
  },
  {
    id: 'connectors',
    title: '连接器',
    description: '管理 MCP 服务与外部工具',
    icon: <Plug size={17} strokeWidth={1.5} />,
    available: true
  },
  {
    id: 'search',
    title: '全局搜索',
    description: '搜索对话、文件与产物内容',
    icon: <Search size={17} strokeWidth={1.5} />,
    available: true
  },
  {
    id: 'browser',
    title: '内置浏览器',
    description: '在同一工作台里打开网页',
    icon: <Globe2 size={17} strokeWidth={1.5} />,
    available: true
  }
]

export function WorkbenchMenu({
  open,
  onClose,
  onSelect
}: {
  open: boolean
  onClose: () => void
  onSelect: (panel: WorkbenchPanel) => void
}): React.JSX.Element {
  return (
    <Modal open={open} onClose={onClose} title="工作台" description="把 Morrow 的能力放到手边。" width={620}>
      <div className="workbench-intro">
        <BookOpen size={16} strokeWidth={1.4} />
        <span>技能、记忆、项目与连接器都在这里；文件树在左侧，编辑器在右侧画布。</span>
      </div>
      <div className="workbench-grid">
        {ENTRIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={['workbench-card', entry.available ? '' : 'is-pending'].filter(Boolean).join(' ')}
            onClick={() => {
              if (!entry.available) return
              onClose()
              onSelect(entry.id)
            }}
            disabled={!entry.available}
            aria-label={`${entry.title}${entry.available ? '' : '（开发中）'}`}
          >
            <span className="workbench-card-icon" aria-hidden>
              {entry.icon}
            </span>
            <span className="workbench-card-copy">
              <span className="workbench-card-title">{entry.title}</span>
              <span className="workbench-card-desc">{entry.description}</span>
            </span>
            <span className="workbench-card-state mono">{entry.available ? '打开' : '即将开放'}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
