/**
 * R10-C 内置浏览器：对外导出（Lead 在 App 中挂载 BrowserSurface）。
 *
 *   import { BrowserSurface } from './features/browser'
 *   <BrowserSurface open={browserOpen} onClose={() => setBrowserOpen(false)} />
 */
export { BrowserSurface, default } from './BrowserSurface'
export type { BrowserSurfaceProps } from './BrowserSurface'
