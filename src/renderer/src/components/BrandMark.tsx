import { useAppStore } from '../store'
import darkMark from '../assets/brand-mark-dark.png'
import lightMark from '../assets/brand-mark-light.png'

/** 双主题品牌徽记：日常会话、演示入口与工作状态共用同一套图标资产。 */
export function BrandMark({
  size = 16,
  className = ''
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  const theme = useAppStore((s) => s.settings.theme)
  return (
    <img
      className={['brand-mark', className].filter(Boolean).join(' ')}
      src={theme === 'light' ? lightMark : darkMark}
      width={size}
      height={size}
      alt=""
      draggable={false}
      aria-hidden
    />
  )
}
