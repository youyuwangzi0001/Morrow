// 统一清理 Electron 启动环境。
// 本机 DSH 运行时设置了 ELECTRON_RUN_AS_NODE=1，会让 electron.exe 退化成 Node，
// 所有启动 Electron（dev / 测试 / 截图）的入口都必须经过这里。
export function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}
