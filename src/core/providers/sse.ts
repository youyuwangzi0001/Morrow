/**
 * SSE（text/event-stream）增量解析。
 *
 * 为什么自己写：双协议（OpenAI / Anthropic）都需要处理跨 chunk 的半行、CRLF、
 * 多条 data 行、注释帧；Node 的 fetch 只给 ReadableStream<Uint8Array>，没有现成解析器。
 * 解析器做成「纯状态机 + push/flush」，便于单元测试任意切片。
 */

export interface SSEFrame {
  event: string | null
  data: string
  id?: string
  retry?: number
}

/** 空行是帧分隔：兼容 \n\n、\r\n\r\n、\r\r */
const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/

export class SSEParser {
  private buffer = ''
  private lastEvent: string | null = null

  /** 输入任意切片，返回本切片内已经完整的帧（不完整的留在内部 buffer） */
  push(chunk: string): SSEFrame[] {
    this.buffer += chunk
    const frames: SSEFrame[] = []
    let match = FRAME_SEPARATOR.exec(this.buffer)
    while (match) {
      const raw = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      const frame = this.parseFrame(raw)
      if (frame) frames.push(frame)
      match = FRAME_SEPARATOR.exec(this.buffer)
    }
    return frames
  }

  /** 流结束时调用：把残留 buffer 当作最后一帧（服务端也可能不发末尾空行） */
  flush(): SSEFrame[] {
    const rest = this.buffer
    this.buffer = ''
    if (!rest.trim()) return []
    const frame = this.parseFrame(rest)
    return frame ? [frame] : []
  }

  private parseFrame(raw: string): SSEFrame | null {
    if (!raw) return null
    const dataLines: string[] = []
    let event: string | null = null
    let id: string | undefined
    let retry: number | undefined
    let hasField = false
    for (const line of raw.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(':')) continue // 注释/心跳（": ping"）
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      hasField = true
      switch (field) {
        case 'data':
          dataLines.push(value)
          break
        case 'event':
          event = value
          break
        case 'id':
          id = value
          break
        case 'retry': {
          const n = Number(value)
          if (Number.isFinite(n)) retry = n
          break
        }
        default:
          // 未知字段按规范忽略
          break
      }
    }
    if (!hasField) return null
    // `event:` 单独一行时，规范上下一帧 data 继承事件名；这里简化：只在本帧返回
    const resolvedEvent = event ?? this.lastEvent
    if (event !== null) this.lastEvent = event
    return { event: resolvedEvent, data: dataLines.join('\n'), id, retry }
  }
}

/**
 * 把 fetch 的 body 流转成 SSE 帧。
 * 注意：调用方负责判断 `data: [DONE]`。
 */
export async function* iterateSSE(stream: ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array>): AsyncGenerator<SSEFrame> {
  const parser = new SSEParser()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  for await (const chunk of stream as AsyncIterable<string | Uint8Array>) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    for (const frame of parser.push(text)) yield frame
  }
  const tail = decoder.decode()
  if (tail) for (const frame of parser.push(tail)) yield frame
  for (const frame of parser.flush()) yield frame
}

/** 逐帧 JSON 解析（跳过注释/心跳/空 data/[DONE]） */
export async function* iterateSSEData(stream: ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array>): AsyncGenerator<unknown> {
  for await (const frame of iterateSSE(stream)) {
    const data = frame.data.trim()
    if (!data || data === '[DONE]') continue
    try {
      yield JSON.parse(data) as unknown
    } catch {
      // 单帧 JSON 坏掉不应让整个流死亡：跳过由上层通过「没有内容」感知
    }
  }
}
