/**
 * 同时尊重系统“减少动效”和 Morrow 设置里的同选项；滚动等 JS 动效也要跟随。
 * 放在 shared 以便单测在 Node 下运行，不依赖 DOM 类型库。
 */
interface MotionDocument {
  documentElement: { dataset: Record<string, string | undefined> }
}

interface MotionWindow {
  matchMedia?: (query: string) => { matches: boolean }
}

export function preferredScrollBehavior(): 'auto' | 'smooth' {
  const scope = globalThis as { document?: MotionDocument; window?: MotionWindow }
  const doc = scope.document
  if (!doc) return 'auto'
  if (doc.documentElement.dataset.reduceMotion === 'true') return 'auto'
  const win = scope.window
  if (win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'auto'
  return 'smooth'
}
