/** 会话删除后立即通知搜索索引失效；搜索模块未初始化时无需处理。 */
type SearchInvalidationHandler = (sessionId: string) => void | Promise<void>

let handler: SearchInvalidationHandler | null = null
let clearHandler: (() => void | Promise<void>) | null = null

export function setSearchInvalidationHandler(next: SearchInvalidationHandler | null): void {
  handler = next
}

export function setSearchClearHandler(next: (() => void | Promise<void>) | null): void {
  clearHandler = next
}

export async function invalidateSearchSession(sessionId: string): Promise<void> {
  await handler?.(sessionId)
}

/** 清除全部对话后立刻丢掉搜索索引里的会话条目。 */
export async function clearSearchIndex(): Promise<void> {
  await clearHandler?.()
}

export function resetSearchInvalidationForTest(): void {
  handler = null
  clearHandler = null
}
