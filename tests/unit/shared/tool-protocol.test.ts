import { describe, expect, it } from 'vitest'
import { ToolProtocolStreamFilter, parseTextToolCalls, stripToolProtocol } from '../../../src/shared/tool-protocol'

const CALL = { name: 'edit_file', input: { path: 'tetris-soviet/index.html' } }

function stream(text: string, size: number): { visible: string; calls: ReturnType<typeof parseTextToolCalls> } {
  const filter = new ToolProtocolStreamFilter()
  let visible = ''
  for (let index = 0; index < text.length; index += size) {
    visible += filter.feed(text.slice(index, index + size))
  }
  const tail = filter.finish()
  visible += tail.text
  return { visible, calls: parseTextToolCalls(tail.blocks.join('\n')) }
}

describe('厂商无关的工具协议', () => {
  it('DeepSeek DSML（全角）', () => {
    const text = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="edit_file">
<｜｜DSML｜｜ parameter name="path" string="true">tetris-soviet/index.html</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
    expect(parseTextToolCalls(text)).toEqual([CALL])
    expect(stripToolProtocol(`先改文件。\n${text}\n改完了。`)).toBe('先改文件。\n\n改完了。')
  })

  it('Kimi K2/K3 特殊 token', () => {
    const text = `<|tool_calls_section_begin|>
<|tool_call_begin|>functions.edit_file:0<|tool_call_argument_begin|>{"path":"tetris-soviet/index.html"}<|tool_call_end|>
<|tool_calls_section_end|>`
    expect(parseTextToolCalls(text)).toEqual([CALL])
    expect(stripToolProtocol(text)).toBe('')
    const result = stream(text, 13)
    expect(result.visible).toBe('')
    expect(result.calls).toEqual([CALL])
  })

  it('MiniMax M2/M3 XML', () => {
    const text = `<minimax:tool_call>
<invoke name="edit_file">
<parameter name="path">tetris-soviet/index.html</parameter>
</invoke>
</minimax:tool_call>`
    expect(parseTextToolCalls(text)).toEqual([CALL])
    expect(stripToolProtocol(text)).toBe('')
    expect(stream(text, 7).calls).toEqual([CALL])
  })

  it('Qwen JSON 与参数标签两种形态', () => {
    const json = `<tool_call>{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}</tool_call>`
    const tags = `<tool_call><function=edit_file><parameter=path>tetris-soviet/index.html</parameter></function></tool_call>`
    expect(parseTextToolCalls(json)).toEqual([CALL])
    expect(parseTextToolCalls(tags)).toEqual([CALL])
    expect(stripToolProtocol(`改一下：\n${json}\n好了`)).toBe('改一下：\n\n好了')
  })

  it('GLM arg_key / arg_value', () => {
    const text = `<tool_call>edit_file
<arg_key>path</arg_key><arg_value>tetris-soviet/index.html</arg_value>
</tool_call>`
    expect(parseTextToolCalls(text)).toEqual([CALL])
    expect(stripToolProtocol(text)).toBe('')
  })

  it('Mistral [TOOL_CALLS] 与 JSON 后的正文', () => {
    const text = `[TOOL_CALLS] [{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}] 已经改好了。`
    expect(parseTextToolCalls(text)).toEqual([CALL])
    expect(stripToolProtocol(text)).toContain('已经改好了。')
    expect(stream(text, 9).visible).toContain('已经改好了。')
  })

  it('Llama python_tag 与 pythonic 调用', () => {
    const json = `<|python_tag|>{"name":"edit_file","parameters":{"path":"tetris-soviet/index.html"}}`
    const pythonic = '<|python_tag|>[edit_file(path="tetris-soviet/index.html")]'
    expect(parseTextToolCalls(json)).toEqual([CALL])
    expect(parseTextToolCalls(pythonic)).toEqual([CALL])
  })

  it('通用 tool_call / function_call / invoke', () => {
    const cases = [
      '<tool_call>{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}</tool_call>',
      '<function_call>{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}</function_call>',
      '<invoke name="edit_file"><parameter name="path">tetris-soviet/index.html</parameter></invoke>'
    ]
    for (const text of cases) expect(parseTextToolCalls(text)).toEqual([CALL])
  })

  it('流式分片不会把协议标记漏进正文', () => {
    const samples = [
      `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="edit_file"><｜｜DSML｜｜ parameter name="path" string="true">tetris-soviet/index.html</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`,
      `<|tool_calls_section_begin|><|tool_call_begin|>functions.edit_file:0<|tool_call_argument_begin|>{"path":"tetris-soviet/index.html"}<|tool_call_end|><|tool_calls_section_end|>`,
      `<tool_call>{"name":"edit_file","arguments":{"path":"tetris-soviet/index.html"}}</tool_call>`,
      `<minimax:tool_call><invoke name="edit_file"><parameter name="path">tetris-soviet/index.html</parameter></invoke></minimax:tool_call>`
    ]
    for (const sample of samples) {
      for (const size of [5, 11, 29]) {
        const result = stream(`前文${sample}后文`, size)
        expect(result.visible).toBe('前文后文')
        expect(result.calls).toEqual([CALL])
      }
    }
  })

  it('代码围栏里的协议示例按普通代码保留', () => {
    const example = '```html\n<tool_call>{"name":"edit_file","arguments":{"path":"a.html"}}</tool_call>\n```\n这只是示例。'
    const result = stream(example, 7)
    expect(result.visible).toBe(example)
    expect(result.calls).toEqual([])
    expect(stripToolProtocol(example)).toBe(example)
  })

  it('历史消息中的未闭合协议被截断，不显示成乱码', () => {
    const text = `答案在这里：\n<tool_call>{"name":"edit_file","arguments":{"path":"a.html"}}`
    expect(stripToolProtocol(text)).toBe('答案在这里：')
  })
})
