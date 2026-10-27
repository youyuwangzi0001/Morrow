import { useAppStore } from '../../store'
import dark32 from '../../../../../build/studio-icon-dark-32.png'
import dark48 from '../../../../../build/studio-icon-dark-48.png'
import dark96 from '../../../../../build/studio-icon-dark-96.png'
import dark256 from '../../../../../build/studio-icon-dark-256.png'
import light32 from '../../../../../build/studio-icon-light-32.png'
import light48 from '../../../../../build/studio-icon-light-48.png'
import light96 from '../../../../../build/studio-icon-light-96.png'
import light256 from '../../../../../build/studio-icon-light-256.png'

const SOURCES = {
  dark: [
    { size: 32, src: dark32 },
    { size: 48, src: dark48 },
    { size: 96, src: dark96 },
    { size: 256, src: dark256 }
  ],
  light: [
    { size: 32, src: light32 },
    { size: 48, src: light48 },
    { size: 96, src: light96 },
    { size: 256, src: light256 }
  ]
}

/** 创作台品牌徽记：按当前主题与显示尺寸选择最接近的 2× 切片。 */
export function StudioMark({ size = 16, className = '' }: { size?: number; className?: string }): React.JSX.Element {
  const theme = useAppStore((state) => state.theme)
  const sources = SOURCES[theme === 'light' ? 'light' : 'dark']
  const target = size * 2
  const source = sources.find((item) => item.size >= target) ?? sources[sources.length - 1]
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
