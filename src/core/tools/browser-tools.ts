/**
 * K1 浏览器自动化工具（core 层，不依赖 electron）。
 *
 * 工具通过 `core/browser-bridge.ts` 的可注入 bridge 调用主进程浏览器服务：
 * - browser_open / browser_click / browser_type / browser_read / browser_screenshot /
 *   browser_back / browser_forward
 * - 全部是外部动作：category=exec、risk=high（只读模式由权限层直接拒绝；
 *   ask 模式逐次审批；**auto 模式也必须逐次审批**——权限层需把这 7 个工具名加入
 *   `EXTERNAL_ACTION_TOOLS`，见 docs/R10-BROWSER.md 的接线说明）。
 * - 限制：URL 仅 http/https、target 长度、输入长度、读取上限、单次超时、单轮步数上限（bridge 内）；
 * - 截图写入工作区 `.morrow/browser/*.png` 并注册为 artifact；没有工作区时不写盘、只返回图片信息；
 * - 工具只操作主进程浏览器服务自己的自动化窗口，不会查找/操作用户其它窗口。
 *
 * 本模块只导出数组与常量，不修改 registry（由 Lead 集成）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Artifact, ToolResult } from '../../shared/types'
import type { ToolContext } from '../types'
import {
  BROWSER_LIMITS,
  BrowserUnavailableError,
  getBrowserBridge,
  normalizeBrowserAddress,
  validateBrowserTarget,
  type BrowserCallContext,
  type BrowserState
} from '../browser-bridge'
import { clampInt, errorMessage } from '../util'
import { errResult, okResult, oneLineInput, type ToolImpl } from './types'

/** 供 permissions.ts 接线：全部浏览器工具都是外部动作，ask/auto 均需审批 */
export const BROWSER_TOOL_NAMES = [
  'browser_open',
  'browser_click',
  'browser_type',
  'browser_read',
  'browser_screenshot',
  'browser_back',
  'browser_forward'
] as const

const MAX_RESULT_CHARS = 12_000

function requireBridge(): NonNullable<ReturnType<typeof getBrowserBridge>> {
  const bridge = getBrowserBridge()
  if (!bridge) throw new BrowserUnavailableError()
  return bridge
}

/** 读取 timeout_ms 参数并夹到安全区间 */
function callContext(ctx: ToolContext, input: Record<string, unknown>): BrowserCallContext {
  const raw = input.timeout_ms
  const timeoutMs =
    typeof raw === 'number' && Number.isFinite(raw) ? clampInt(raw, BROWSER_LIMITS.minTimeoutMs, BROWSER_LIMITS.maxTimeoutMs) : undefined
  return { runId: ctx.runId, ...(timeoutMs ? { timeoutMs } : {}) }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 60)
  }
}

function summarizeState(state: BrowserState): string {
  const flags = [state.loading ? '加载中' : '已加载', state.canGoBack ? '可后退' : '', state.canGoForward ? '可前进' : '']
    .filter(Boolean)
    .join(' · ')
  return `${state.title || '(无标题)'}\n${state.url}（${flags}）`
}

function toolError(err: unknown, hint?: string): ToolResult {
  if (err instanceof BrowserUnavailableError) {
    return errResult(err.message, '主进程浏览器服务未初始化；请重启应用后再试。')
  }
  const message = errorMessage(err)
  return errResult(`浏览器操作失败：${message}`, hint)
}

function requireWritableContext(ctx: ToolContext): ToolResult | null {
  if (ctx.readOnly) return errResult('子代理是只读模式，不能控制浏览器。', '浏览器自动化只能在主 Agent 的工作模式中使用。')
  return null
}

/* ── browser_open ─────────────────────────────────────────────── */

const browserOpenTool: ToolImpl = {
  definition: {
    name: 'browser_open',
    description:
      '在 Morrow 内置浏览器中打开一个 http/https 网址（本机 localhost 也允许）。仅用于需要真实浏览网页的任务；' +
      '打开后可用 browser_read 读取页面、browser_click/browser_type 交互、browser_screenshot 截图。' +
      '不允许打开 file:/javascript:/data: 等本地或代码地址。每次调用都需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网址（http/https；可省略协议，默认补 https://）' },
        timeout_ms: { type: 'number', description: `加载超时（${BROWSER_LIMITS.minTimeoutMs}-${BROWSER_LIMITS.maxTimeoutMs}ms，默认 ${BROWSER_LIMITS.openTimeoutMs}）` }
      },
      required: ['url']
    },
    category: 'exec',
    risk: 'high',
    titleFor: (input) => `打开网页 ${oneLineInput(input, 'url', 80)}`
  },
  async execute(input, ctx) {
    const readonly = requireWritableContext(ctx)
    if (readonly) return readonly
    const check = normalizeBrowserAddress(typeof input.url === 'string' ? input.url : '')
    if (!check.allowed || !check.url) return errResult(check.reason ?? '网址无效。', '只允许 http/https 网址；本机 localhost 可用。')
    try {
      const bridge = requireBridge()
      const callCtx = callContext(ctx, input)
      const state = await bridge.open(check.url, {
        ...callCtx,
        ...(typeof input.timeout_ms === 'number' ? { timeoutMs: callCtx.timeoutMs ?? BROWSER_LIMITS.openTimeoutMs } : {})
      })
      return okResult(`已在 Morrow 浏览器打开：${summarizeState(state)}`, {
        url: state.url,
        title: state.title,
        canGoBack: state.canGoBack,
        canGoForward: state.canGoForward
      })
    } catch (err) {
      return toolError(err, '请检查网址是否可访问，或稍后重试。')
    }
  }
}

/* ── browser_click ────────────────────────────────────────────── */

const browserClickTool: ToolImpl = {
  definition: {
    name: 'browser_click',
    description:
      '在内置浏览器当前页面点击一个元素。target 可以是 CSS selector（如 "#submit"、"a.more"）或按钮/链接的可见文本（如 "提交"）。' +
      '会先滚动到元素再发送真实鼠标事件。每次调用都需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'CSS selector 或元素可见文本（如 "提交"）' },
        timeout_ms: { type: 'number', description: '动作超时（毫秒）' }
      },
      required: ['target']
    },
    category: 'exec',
    risk: 'high',
    titleFor: (input) => `点击网页元素 ${oneLineInput(input, 'target', 60)}`
  },
  async execute(input, ctx) {
    const readonly = requireWritableContext(ctx)
    if (readonly) return readonly
    const target = validateBrowserTarget(input.target)
    if (!target.ok) return errResult(target.reason)
    try {
      const bridge = requireBridge()
      const result = await bridge.click(target.target, callContext(ctx, input))
      return okResult(`已点击「${result.target ?? target.target}」；当前页面：${result.title || result.url}`, {
        url: result.url,
        title: result.title,
        target: result.target ?? target.target
      })
    } catch (err) {
      return toolError(err, '可先用 browser_read 查看页面内容，确认元素 selector/文本是否准确。')
    }
  }
}

/* ── browser_type ─────────────────────────────────────────────── */

const browserTypeTool: ToolImpl = {
  definition: {
    name: 'browser_type',
    description:
      '在内置浏览器当前页面的输入框/文本域/contenteditable 中键入文本。target 可以是 CSS selector 或输入框的可见文本提示。' +
      'submit=true 时输入后会提交表单（或发送回车）。每次调用都需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'CSS selector 或输入框的可读标识（placeholder/label/邻近文本）' },
        text: { type: 'string', description: `要输入的文本（上限 ${BROWSER_LIMITS.maxTypeChars} 字符）` },
        submit: { type: 'boolean', description: '输入后是否提交表单（默认 false）' },
        timeout_ms: { type: 'number', description: '动作超时（毫秒）' }
      },
      required: ['target', 'text']
    },
    category: 'exec',
    risk: 'high',
    titleFor: (input) => `在网页输入框「${oneLineInput(input, 'target', 40)}」输入文字`
  },
  async execute(input, ctx) {
    const readonly = requireWritableContext(ctx)
    if (readonly) return readonly
    const target = validateBrowserTarget(input.target)
    if (!target.ok) return errResult(target.reason)
    const text = typeof input.text === 'string' ? input.text : ''
    if (!text) return errResult('text 不能为空。')
    if (text.length > BROWSER_LIMITS.maxTypeChars) return errResult(`输入文本过长（上限 ${BROWSER_LIMITS.maxTypeChars} 字符）。`)
    try {
      const bridge = requireBridge()
      const result = await bridge.type(target.target, text, {
        ...callContext(ctx, input),
        submit: input.submit === true
      })
      return okResult(
        `已在「${result.target ?? target.target}」输入 ${text.length} 个字符${input.submit === true ? '并提交' : ''}；当前页面：${result.title || result.url}`,
        { url: result.url, title: result.title, target: result.target ?? target.target, submitted: input.submit === true }
      )
    } catch (err) {
      return toolError(err, '可先用 browser_read 确认输入框是否可见、是否在正确的页面。')
    }
  }
}

/* ── browser_read ─────────────────────────────────────────────── */

const browserReadTool: ToolImpl = {
  definition: {
    name: 'browser_read',
    description:
      '读取内置浏览器当前页面的标题、网址与可见文本（已清理，最多约 2 万字符）。用于核对网页内容/证据；不做任何页面交互。每次调用都需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        max_chars: { type: 'number', description: `最多返回字符数（默认 ${BROWSER_LIMITS.maxReadChars}）` },
        timeout_ms: { type: 'number', description: '读取超时（毫秒）' }
      }
    },
    category: 'exec',
    risk: 'high',
    titleFor: () => '读取网页内容'
  },
  async execute(input, ctx) {
    const readonly = requireWritableContext(ctx)
    if (readonly) return readonly
    const maxChars =
      typeof input.max_chars === 'number' && Number.isFinite(input.max_chars)
        ? clampInt(input.max_chars, 200, BROWSER_LIMITS.maxReadChars)
        : BROWSER_LIMITS.maxReadChars
    try {
      const bridge = requireBridge()
      const page = await bridge.read({ ...callContext(ctx, input), maxChars })
      const header = `标题：${page.title || '(无标题)'}\n网址：${page.url}\n\n`
      const text = page.text.length > MAX_RESULT_CHARS ? page.text.slice(0, MAX_RESULT_CHARS) : page.text
      return okResult(`${header}${text}${page.truncated ? '\n…（页面文本已截断）' : ''}`, {
        url: page.url,
        title: page.title,
        chars: text.length,
        truncated: page.truncated
      })
    } catch (err) {
      return toolError(err, '请确认浏览器里已经打开了目标页面。')
    }
  }
}

/* ── browser_screenshot ───────────────────────────────────────── */

function screenshotArtifactPath(workspace: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const random = Math.random().toString(36).slice(2, 8)
  return join(workspace, '.morrow', 'browser', `browser-${stamp}-${random}.png`)
}

const browserScreenshotTool: ToolImpl = {
  definition: {
    name: 'browser_screenshot',
    description:
      '截取内置浏览器当前页面的 PNG 截图，保存到工作区 `.morrow/browser/` 并注册为画布产物（artifact）。' +
      '用于给用户展示网页结果或作为任务证据。每次调用都需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        timeout_ms: { type: 'number', description: '截图超时（毫秒）' }
      }
    },
    category: 'exec',
    risk: 'high',
    titleFor: () => '截取网页截图'
  },
  async execute(input, ctx) {
    const readonly = requireWritableContext(ctx)
    if (readonly) return readonly
    try {
      const bridge = requireBridge()
      const shot = await bridge.screenshot(callContext(ctx, input))
      const buffer = Buffer.from(shot.pngBase64, 'base64')
      if (buffer.length === 0) return errResult('截图失败：浏览器返回了空图片。')
      if (buffer.length > 20 * 1024 * 1024) return errResult('截图失败：图片超过 20MB。')
      if (!ctx.workspace) {
        return errResult('截图失败：当前会话没有工作区，无法保存截图文件。', '请先为会话选择工作文件夹。')
      }
      const path = screenshotArtifactPath(ctx.workspace)
      mkdirSync(join(ctx.workspace, '.morrow', 'browser'), { recursive: true })
      writeFileSync(path, buffer)
      const now = Date.now()
      const artifact: Artifact = {
        id: `artifact-browser-${createHash('sha1').update(path).digest('hex').slice(0, 10)}`,
        title: `网页截图 · ${hostOf(shot.url)}`,
        kind: 'file',
        path,
        createdAt: now,
        updatedAt: now
      }
      ctx.addArtifact(artifact)
      return okResult(
        `已截取网页截图并保存为画布产物：${path}\n页面：${shot.title || '(无标题)'} ${shot.url}\n尺寸：${shot.width}×${shot.height}，${Math.round(buffer.length / 1024)} KB`,
        { path, url: shot.url, title: shot.title, width: shot.width, height: shot.height, bytes: buffer.length, artifactId: artifact.id }
      )
    } catch (err) {
      return toolError(err, '请确认浏览器里已经打开了页面；截图失败时页面可能仍在加载。')
    }
  }
}

/* ── browser_back / browser_forward ──────────────────────────── */

function historyTool(direction: 'back' | 'forward'): ToolImpl {
  return {
    definition: {
      name: direction === 'back' ? 'browser_back' : 'browser_forward',
      description: `让内置浏览器${direction === 'back' ? '后退' : '前进'}一页，返回导航后的标题与网址。每次调用都需要用户审批。`,
      parameters: {
        type: 'object',
        properties: {
          timeout_ms: { type: 'number', description: '动作超时（毫秒）' }
        }
      },
      category: 'exec',
      risk: 'high',
      titleFor: () => (direction === 'back' ? '浏览器后退' : '浏览器前进')
    },
    async execute(input, ctx) {
      const readonly = requireWritableContext(ctx)
      if (readonly) return readonly
      try {
        const bridge = requireBridge()
        const callCtx = callContext(ctx, input)
        const state = direction === 'back' ? await bridge.back(callCtx) : await bridge.forward(callCtx)
        const cannot = direction === 'back' ? '已经到第一页，无法后退。' : '已经在最后一页，无法前进。'
        if (direction === 'back' && !state.canGoBack && !state.canGoForward && state.url === 'about:blank') {
          return errResult(cannot)
        }
        return okResult(`已${direction === 'back' ? '后退' : '前进'}：${summarizeState(state)}`, {
          url: state.url,
          title: state.title,
          canGoBack: state.canGoBack,
          canGoForward: state.canGoForward
        })
      } catch (err) {
        return toolError(err)
      }
    }
  }
}

/** 导出给 registry 集成（Lead 在 registry.ts 里 spread；本文件不改 registry） */
export const browserTools: ToolImpl[] = [
  browserOpenTool,
  browserClickTool,
  browserTypeTool,
  browserReadTool,
  browserScreenshotTool,
  historyTool('back'),
  historyTool('forward')
]
