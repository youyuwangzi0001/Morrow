// SSE（text/event-stream）增量解析。

export interface SSEFrame {
  event: string | null
  data: string
  id?: string
  retry?: number
}

export class SSEParser {
  /** 尚未按行结束符切开的残余文本（可能以孤立的 \r 结尾，等待下一块确认 CRLF） */
  private buffer = ''
  private dataLines: string[] = []
  private event: string | null = null
  private id: string | undefined
  private retry: number | undefined
  private hasField = false

  /** 输入任意切片，返回本切片内已经完整的帧（不完整的留在内部 buffer） */
  push(chunk: string): SSEFrame[] {
    this.buffer += chunk
    const frames: SSEFrame[] = []
    let index = 0
    while (index < this.buffer.length) {
      const lf = this.buffer.indexOf('\n', index)
      const cr = this.buffer.indexOf('\r', index)
      let lineEnd: number
      let nextIndex: number
      if (cr >= 0 && (lf < 0 || cr < lf)) {
        // 块尾的孤立 \r 可能是 CRLF 的前半，留到下一块再判断
        if (cr === this.buffer.length - 1) break
        lineEnd = cr
        nextIndex = this.buffer[cr + 1] === '\n' ? cr + 2 : cr + 1
      } else if (lf >= 0) {
        lineEnd = lf
        nextIndex = lf + 1
      } else {
        break
      }
      const frame = this.consumeLine(this.buffer.slice(index, lineEnd))
      if (frame) frames.push(frame)
      index = nextIndex
    }
    this.buffer = this.buffer.slice(index)
    return frames
  }

  /** 流结束时调用：收下没有行结束符/空行的最后一帧（服务端也可能不发末尾空行） */
  flush(): SSEFrame[] {
    const rest = this.buffer
    this.buffer = ''
    const frames: SSEFrame[] = []
    if (rest) {
      // 句尾孤立的 \r 是已结束的行；其余残余文本也按最后一行解析
      const line = rest.endsWith('\r') ? rest.slice(0, -1) : rest
      if (line) {
        const frame = this.consumeLine(line)
        if (frame) frames.push(frame)
      }
    }
    const tail = this.dispatch()
    if (tail) frames.push(tail)
    return frames
  }

  private consumeLine(line: string): SSEFrame | null {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return null // 注释/心跳（": ping"）
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    this.hasField = true
    switch (field) {
      case 'data':
        this.dataLines.push(value)
        break
      case 'event':
        this.event = value || null
        break
      case 'id':
        this.id = value
        break
      case 'retry': {
        const n = Number(value)
        if (Number.isFinite(n)) this.retry = n
        break
      }
      default:
        // 未知字段按规范忽略
        break
    }
    return null
  }

  /** 空行派发：只有收到过 data 字段的帧才算事件（规范如此，纯 event/id 行不派发） */
  private dispatch(): SSEFrame | null {
    const hasData = this.dataLines.length > 0
    const frame: SSEFrame = {
      event: this.event,
      data: this.dataLines.join('\n'),
      ...(this.id !== undefined ? { id: this.id } : {}),
      ...(this.retry !== undefined ? { retry: this.retry } : {})
    }
    const shouldEmit = hasData && this.hasField
    this.dataLines = []
    this.event = null
    this.id = undefined
    this.retry = undefined
    this.hasField = false
    return shouldEmit ? frame : null
  }
}

export const STREAM_IDLE_TIMEOUT_MS = 180_000

/**
 * 把 fetch 的 body 流转成 SSE 帧。
 * 注意：调用方负责判断 `data: [DONE]`。
 * 超过 idleTimeoutMs 没有任何数据（含心跳）就报错，避免连接半开导致整轮永久卡住。
 */
export async function* iterateSSE(
  stream: ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array>,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS
): AsyncGenerator<SSEFrame> {
  const parser = new SSEParser()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const iterator = (stream as AsyncIterable<string | Uint8Array>)[Symbol.asyncIterator]()
  let timer: NodeJS.Timeout | null = null
  let timedOut = false
  const arm = (): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error(`模型流式响应超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有数据，已中断。`))
      }, idleTimeoutMs)
    })
  try {
    while (true) {
      if (timer) clearTimeout(timer)
      timer = null
      const next = await Promise.race([iterator.next(), arm()])
      if (next.done) break
      if (timer) clearTimeout(timer)
      timer = null
      const chunk = next.value
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      for (const frame of parser.push(text)) yield frame
    }
    const tail = decoder.decode()
    if (tail) for (const frame of parser.push(tail)) yield frame
    for (const frame of parser.flush()) yield frame
  } finally {
    if (timer) clearTimeout(timer)
    // 不等待 return：底层读取可能同样卡死，等它会把超时又变成永久挂起
    if (timedOut) void Promise.resolve(iterator.return?.()).catch(() => undefined)
  }
}

/**
 * 逐帧 JSON 解析（跳过注释/心跳/空 data/[DONE]）。
 * onDone：收到 `[DONE]` 哨兵时回调，供 Provider 区分「正常收尾」与「中途断流」。
 */
export async function* iterateSSEData(
  stream: ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array>,
  onDone?: () => void
): AsyncGenerator<unknown> {
  for await (const frame of iterateSSE(stream)) {
    const data = frame.data.trim()
    if (!data) continue
    if (data === '[DONE]') {
      onDone?.()
      continue
    }
    try {
      yield JSON.parse(data) as unknown
    } catch {
      // 单帧 JSON 坏掉不应让整个流死亡：跳过由上层通过「没有内容」感知
    }
  }
}
