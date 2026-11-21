# 登录规则 v1

## 服务

`login(input, accounts)` 返回 `{ status, body }`：

- 用户名不存在或密码错误：`401`，body 为 `{ error: 'invalid_credentials' }`。
- 账户已锁定：`423`，body 为 `{ error: 'account_locked' }`。
- 校验通过：`200`，body 为 `{ accessToken: 'token-<username>' }`。
- 锁定检查优先于密码校验之外的其它分支，不得返回 token。

## 页面

`loginErrorMessage(status)` 返回给用户看的中文提示：

- `401`：`账号或密码不正确`
- `423`：`账户已锁定`
- 其它：`登录失败，请稍后再试`

## 稳定项

- 页面只依赖状态码，不读取 token。
- 锁定账户不得签发 token。
