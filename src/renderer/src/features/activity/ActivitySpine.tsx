import type { ToolUseBlock } from '@shared/types'
import { ToolRow } from './ToolRow'
import './activity.css'

/**
 * 行动轨迹（Spine）：同一条助手消息内的工具调用按顺序串成一条竖线。
 * 这是 Morrow 的签名可视化——不是卡片列表，而是一份安静的执行日志。
 */
export function ActivitySpine({ blocks }: { blocks: ToolUseBlock[] }): React.JSX.Element | null {
  if (blocks.length === 0) return null
  return (
    <div className="spine" role="group" aria-label="行动轨迹">
      {blocks.map((block, index) => (
        <ToolRow key={block.id} block={block} last={index === blocks.length - 1} />
      ))}
    </div>
  )
}
