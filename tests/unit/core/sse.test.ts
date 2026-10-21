import { describe, expect, it } from 'vitest'
import { SSEParser, iterateSSE } from '../../../src/core/providers/sse'

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

describe('SSEParser', () => {
  it('处理跨 chunk 的半行', () => {
    const parser = new SSEParser()
    expect(parser.push('data: hel')).toEqual([])
    const frames = parser.push('lo\n\ndata: world\n\n')
    expect(frames.map((frame) => frame.data)).toEqual(['hello', 'world'])
  })

  it('兼容 CRLF、注释与 event/id 字段', () => {
    const parser = new SSEParser()
    const frames = parser.push(': ping\r\nevent: message_start\r\nid: 7\r\ndata: {"a":1}\r\n\r\n')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ event: 'message_start', data: '{"a":1}', id: '7' })
  })

  it('多行 data 用换行拼接', () => {
    const parser = new SSEParser()
    const frames = parser.push('data: line1\ndata: line2\n\n')
    expect(frames[0].data).toBe('line1\nline2')
  })

  it('混合换行（LF 结束数据行 + CRLF 空行）也能正确分帧', () => {
    const parser = new SSEParser()
    const frames = parser.push('data: a\n\r\ndata: b\r\n\r\ndata: c\r\r')
    expect(frames.map((frame) => frame.data)).toEqual(['a', 'b'])
    // 块尾孤立 \r 需要等 flush 确认不是 CRLF 的前半
    expect(parser.flush().map((frame) => frame.data)).toEqual(['c'])
  })

  it('CRLF 被 chunk 边界切开时不会丢帧', () => {
    const parser = new SSEParser()
    expect(parser.push('data: hello\r')).toEqual([])
    expect(parser.push('\n\r')).toEqual([])
    expect(parser.push('\ndata: world\r\n\r\n').map((frame) => frame.data)).toEqual(['hello', 'world'])
  })

  it('event 字段只作用于当前帧，不泄漏到下一帧', () => {
    const parser = new SSEParser()
    const frames = parser.push('event: ping\ndata: 1\n\ndata: 2\n\n')
    expect(frames.map((frame) => frame.event)).toEqual(['ping', null])
  })

  it('只有 event/id 没有 data 的帧不派发', () => {
    const parser = new SSEParser()
    expect(parser.push('event: ping\nid: 3\n\n')).toEqual([])
    expect(parser.push('data: ok\n\n').map((frame) => frame.data)).toEqual(['ok'])
  })

  it('flush 收下没有末尾空行的最后一帧', () => {
    const parser = new SSEParser()
    expect(parser.push('data: {"done":true}')).toEqual([])
    expect(parser.flush().map((frame) => frame.data)).toEqual(['{"done":true}'])
  })

  it('空输入 flush 返回空数组', () => {
    const parser = new SSEParser()
    expect(parser.flush()).toEqual([])
  })
})

describe('iterateSSE', () => {
  it('逐帧产出，处理多字节字符跨 chunk', async () => {
    const frames = []
    for await (const frame of iterateSSE(streamFrom(['data: {"text":"你', '好"}\n\n', 'data: [DONE]\n\n']))) {
      frames.push(frame.data)
    }
    expect(frames).toEqual(['{"text":"你好"}', '[DONE]'])
  })

  it('缺少末尾空行时也能产出最后一帧', async () => {
    const frames = []
    for await (const frame of iterateSSE(streamFrom(['data: a\n\ndata: b']))) frames.push(frame.data)
    expect(frames).toEqual(['a', 'b'])
  })
})
