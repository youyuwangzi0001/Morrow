/**
 * HTML 产物沙箱预览：
 * - 独立协议返回文档与自带 CSP（不继承主窗口 script-src，内联脚本可运行）；
 * - token 校验、过期/未知 404、大小上限。
 */
import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_PREVIEW_CSP,
  ARTIFACT_PREVIEW_SCHEME,
  handleArtifactPreview,
  registerArtifactHtml
} from '../../../src/main/services/artifact-preview'

function requestOf(url: string): Request {
  // Node 的 Request 不接受自定义协议；handler 只读取 request.url
  return { url } as Request
}

describe('artifact preview protocol', () => {
  it('登记 HTML 并返回带独立 CSP 的文档', async () => {
    const url = registerArtifactHtml('<h1>报告</h1><script>document.title="ok"</script>')
    expect(url.startsWith(`${ARTIFACT_PREVIEW_SCHEME}://preview/`)).toBe(true)
    const response = handleArtifactPreview(requestOf(url))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toBe(ARTIFACT_PREVIEW_CSP)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toContain('<h1>报告</h1>')
  })

  it('未知 token / 非法 token 返回 404', () => {
    expect(handleArtifactPreview(requestOf(`${ARTIFACT_PREVIEW_SCHEME}://preview/${'a'.repeat(36)}`)).status).toBe(404)
    expect(handleArtifactPreview(requestOf(`${ARTIFACT_PREVIEW_SCHEME}://preview/..%2F..%2Fsecret`)).status).toBe(404)
  })

  it('拒绝非字符串与超大 HTML', () => {
    expect(() => registerArtifactHtml(undefined)).toThrow(/无效/)
    expect(() => registerArtifactHtml('x'.repeat(10 * 1024 * 1024 + 1))).toThrow(/过大/)
  })
})
