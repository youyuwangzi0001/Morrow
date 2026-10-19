/**
 * R10 浏览器验收本地 HTTP fixture（仅 127.0.0.1，无外网）。
 * 供浏览器/自动化测试使用：页面、跳转、慢响应、下载、权限提示页。
 */
import { createServer } from 'node:http'

export function createBrowserFixtureServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>R10 Browser Fixture</title><h1>R10 Home</h1><a href="/page2">page2</a><button id="btn">按钮</button>')
      return
    }
    if (url.pathname === '/page2') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>R10 Page 2</title><h1>R10 Page2</h1><input id="q" /><a href="/">home</a>')
      return
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/page2' })
      res.end()
      return
    }
    if (url.pathname === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.write('slow-')
      setTimeout(() => res.end('done'), 800)
      return
    }
    if (url.pathname === '/download') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="r10-download.bin"'
      })
      res.end(Buffer.from('R10_DOWNLOAD_FIXTURE'))
      return
    }
    if (url.pathname === '/permission') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>R10 Permission</title><script>navigator.mediaDevices?.getUserMedia?.({audio:true}).catch(()=>{})</script><p>permission page</p>')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })
  return server
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`) {
  const server = createBrowserFixtureServer()
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    console.log(JSON.stringify({ ok: true, baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` }))
  })
}
