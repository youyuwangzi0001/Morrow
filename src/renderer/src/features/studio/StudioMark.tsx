import icon32 from '../../assets/studio/studio-icon-32.png'
import icon48 from '../../assets/studio/studio-icon-48.png'
import icon96 from '../../assets/studio/studio-icon-96.png'
import icon256 from '../../assets/studio/studio-icon-256.png'

const SOURCES = [
  { size: 32, src: icon32 },
  { size: 48, src: icon48 },
  { size: 96, src: icon96 },
  { size: 256, src: icon256 }
]

/** 创作台品牌徽记：按显示尺寸选择最接近的 2× 切片，避免小图标加载大图。 */
export function StudioMark({ size = 16, className = '' }: { size?: number; className?: string }): React.JSX.Element {
  const target = size * 2
  const source = SOURCES.find((item) => item.size >= target) ?? SOURCES[SOURCES.length - 1]
  return (
    <img
      className={['studio-mark', className].filter(Boolean).join(' ')}
      src={source.src}
      width={size}
      height={size}
      alt=""
      draggable={false}
      aria-hidden
    />
  )
}