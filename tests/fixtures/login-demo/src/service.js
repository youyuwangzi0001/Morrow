// T01 基准样例：待服务成员实现。当前占位实现会让锁定账户错误地拿到 token。
export function login(input, accounts) {
  const user = accounts?.[input?.username]
  if (!user || user.password !== input?.password) {
    return { status: 401, body: { error: 'invalid_credentials' } }
  }
  return { status: 200, body: { accessToken: `token-${input.username}` } }
}
