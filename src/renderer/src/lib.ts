/** 渲染层通用小工具：错误文案、格式化与 IPC 解包集中在这里，组件不再各写一份。 */

export function errorText(err: unknown, fallback = '操作失败，请重试。'): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err.trim()) return err
  return fallback
}

/** 历史/版本列表的时间：当天只显示时分，其它日期加上月日。 */
export function formatArtifactTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  if (date.toDateString() === now.toDateString()) return time
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`
}
