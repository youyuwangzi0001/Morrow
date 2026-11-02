// 真实模型直播冒烟（仅本机验证，不进入交付物）。
//
// 用法：
//   node scripts/probe-live.mjs             # 真调用 DeepSeek 流式接口（带一个工具调用）
//   node scripts/probe-live.mjs --dry-run   # 只验证 Key 读取与请求构造，不发网络请求
//
// Key 来源：%USERPROFILE%\.dsh\.credentials.yaml 的 refs.DEEPSEEK_API_KEY；
// 也支持环境变量 DEEPSEEK_API_KEY 覆盖（CI/其他机器）。
//
// 安全约束：
// - 永不打印 Key（只打印「已读取 / 长度 / sk- 前缀校验」这类脱敏状态）；
// - 结果文件写到 probe/（.gitignore 已忽略），不打印任何 Authorization 头；
// - 输出只有：HTTP 状态、首 token 延迟、总耗时、tool_calls 是否解析成功、usage。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const API_URL = 'https://api.deepseek.com/v1/chat/completions'
const MODEL = 'deepseek-chat'
const TIMEOUT_MS = 90_000

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取指定时区的当前日期与时间。用户询问时间时必须调用，不要凭猜测回答。',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA 时区名，例如 Asia/Shanghai' }
        },
        required: ['timezone']
      }
    }
  }
]

const messages = [
  {
    role: 'user',
    content: '现在几点了？请调用 get_current_time 工具查询（时区用 Asia/Shanghai），不要凭猜测回答。'
  }
]

function log(message) {
  console.log(`[probe] ${message}`)
}

/** 从 ~/.dsh/.credentials.yaml 的 refs: 段读取 DEEPSEEK_API_KEY。不打印值。 */
function readDeepSeekKey() {
  const envKey = process.env.DEEPSEEK_API_KEY
  if (envKey) {
    return { key: envKey.trim(), source: '环境变量 DEEPSEEK_API_KEY' }
  }
  const credPath = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', '.credentials.yaml')
  if (!existsSync(credPath)) {
    throw new Error(`未找到凭据文件 ${credPath}，也没有环境变量 DEEPSEEK_API_KEY`)
  }
  const text = readFileSync(credPath, 'utf8')
  const lines = text.split(/\r?\n/)
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (inRefs) {
      // refs 段结束：回到顶层（非缩进行）
      if (/^\S/.test(line)) break
      const match = line.match(/^\s+DEEPSEEK_API_KEY:\s*(.+?)\s*$/)
      if (match) {
        let value = match[1].trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        return { key: value, source: '~/.dsh/.credentials.yaml → refs.DEEPSEEK_API_KEY' }
      }
    }
  }
  throw new Error('凭据文件的 refs 段里没有 DEEPSEEK_API_KEY')
}

/** 解析 SSE 流：累计文本/工具调用/usage，并记录首 token 时间。 */
async function streamCompletion(apiKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${TIMEOUT_MS}ms）`)), TIMEOUT_MS)
  const startedAt = Date.now()
  const result = {
    httpStatus: null,
    firstByteMs: null,
    firstTokenMs: null,
    totalMs: null,
    textLength: 0,
    toolCalls: [],
    usage: null,
    finishReason: null,
    error: null
  }
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools,
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.1,
        max_tokens: 512
      }),
      signal: controller.signal
    })
    result.httpStatus = response.status
    result.firstByteMs = Date.now() - startedAt
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      result.error = `HTTP ${response.status}: ${body.slice(0, 300)}`
      result.totalMs = Date.now() - startedAt
      return result
    }
    const toolAcc = new Map()
    let buffer = ''
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let parsed
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }
        if (parsed.usage) {
          result.usage = {
            promptTokens: parsed.usage.prompt_tokens,
            completionTokens: parsed.usage.completion_tokens,
            totalTokens: parsed.usage.total_tokens,
            promptCacheHitTokens: parsed.usage.prompt_cache_hit_tokens,
            promptCacheMissTokens: parsed.usage.prompt_cache_miss_tokens
          }
        }
        const choice = parsed.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) result.finishReason = choice.finish_reason
        const delta = choice.delta || {}
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          result.textLength += delta.content.length
          if (result.firstTokenMs === null) result.firstTokenMs = Date.now() - startedAt
        }
        if (Array.isArray(delta.tool_calls)) {
          if (result.firstTokenMs === null) result.firstTokenMs = Date.now() - startedAt
          for (const callDelta of delta.tool_calls) {
            const index = callDelta.index ?? 0
            const acc = toolAcc.get(index) || { id: '', name: '', args: '' }
            if (callDelta.id) acc.id = callDelta.id
            if (callDelta.function?.name) acc.name += callDelta.function.name
            if (callDelta.function?.arguments) acc.args += callDelta.function.arguments
            toolAcc.set(index, acc)
          }
        }
      }
    }
    result.totalMs = Date.now() - startedAt
    result.toolCalls = [...toolAcc.values()].map((call) => {
      let parsedArgs = null
      let argumentsValid = false
      try {
        parsedArgs = JSON.parse(call.args)
        argumentsValid = typeof parsedArgs === 'object' && parsedArgs !== null
      } catch {
        argumentsValid = false
      }
      return { id: call.id, name: call.name, argumentsValid, arguments: parsedArgs, rawArgumentsLength: call.args.length }
    })
    return result
  } catch (err) {
    result.totalMs = Date.now() - startedAt
    result.error = String(err?.message ?? err)
    return result
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  log(`Morrow 真实模型冒烟 · 目标 ${API_URL} · 模型 ${MODEL} · ${dryRun ? 'DRY-RUN' : '真实请求'}`)

  const { key, source } = readDeepSeekKey()
  const masked = {
    source,
    length: key.length,
    looksLikeDeepSeekKey: /^sk-[A-Za-z0-9]{20,}$/.test(key),
    prefix: /^sk-/.test(key) ? 'sk-' : '(非 sk- 前缀)'
  }
  log(`Key：已读取（${masked.source}；长度 ${masked.length}；格式校验 ${masked.looksLikeDeepSeekKey ? '通过' : '可疑'}；前缀 ${masked.prefix}）`)
  if (!masked.looksLikeDeepSeekKey) {
    log('警告：Key 格式不像 DeepSeek Key，继续尝试调用。')
  }

  if (dryRun) {
    log(`请求体：model=${MODEL}，stream=true，tools=[${tools.map((t) => t.function.name).join(', ')}]，stream_options.include_usage=true`)
    log('DRY-RUN 完成：未发送网络请求。')
    return 0
  }

  const result = await streamCompletion(key)
  const ok = result.httpStatus === 200 && result.toolCalls.length > 0 && result.toolCalls.every((call) => call.argumentsValid)
  log(`HTTP 状态：${result.httpStatus ?? '(无响应)'}`)
  log(`首字节延迟：${result.firstByteMs ?? '—'}ms · 首 token 延迟：${result.firstTokenMs ?? '—'}ms · 总耗时：${result.totalMs ?? '—'}ms`)
  log(`finish_reason：${result.finishReason ?? '—'} · 文本长度：${result.textLength} 字`)
  if (result.usage) {
    log(
      `usage：prompt=${result.usage.promptTokens ?? '?'} completion=${result.usage.completionTokens ?? '?'} total=${result.usage.totalTokens ?? '?'}` +
        (result.usage.promptCacheHitTokens !== undefined
          ? `（缓存命中 ${result.usage.promptCacheHitTokens}）`
          : '')
    )
  }
  if (result.toolCalls.length === 0) {
    log('tool_calls：未出现（模型没有调用工具）')
  } else {
    for (const call of result.toolCalls) {
      log(
        `tool_calls：${call.name}(${call.argumentsValid ? JSON.stringify(call.arguments) : `参数 JSON 非法: ${call.rawArgumentsLength}B`})`
      )
    }
  }
  if (result.error) log(`错误：${result.error}`)

  const probeDir = join(root, 'probe')
  mkdirSync(probeDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(probeDir, `live-probe-${stamp}.json`)
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        ok,
        at: new Date().toISOString(),
        endpoint: API_URL,
        model: MODEL,
        httpStatus: result.httpStatus,
        firstByteMs: result.firstByteMs,
        firstTokenMs: result.firstTokenMs,
        totalMs: result.totalMs,
        finishReason: result.finishReason,
        textLength: result.textLength,
        toolCalls: result.toolCalls,
        usage: result.usage,
        error: result.error,
        keySource: source,
        keyLength: key.length
      },
      null,
      2
    )
  )
  log(`结果已写入 ${outPath.replace(root + '\\', '').replace(/\\/g, '/')}（probe/ 已 gitignore，不入交付物）`)
  log(ok ? '结论：通过（流式 + 工具调用解析成功）' : '结论：失败（见上方错误/缺失项）')
  if (!ok && result.httpStatus === undefined) {
    // 网络层失败给一个便于排查的退出码
    return 2
  }
  return ok ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`失败：${err?.message ?? err}`)
    process.exit(1)
  })
