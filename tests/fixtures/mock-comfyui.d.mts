export interface MockComfyUIRequest {
  method: string | undefined
  path: string
  query: Record<string, string>
  at: number
}

export interface MockComfyUI {
  baseUrl: string
  requests: MockComfyUIRequest[]
  graphs: Record<string, unknown>[]
  close(): Promise<void>
}

export function startMockComfyUI(options?: {
  port?: number
  host?: string
  delayMs?: number
}): Promise<MockComfyUI>
