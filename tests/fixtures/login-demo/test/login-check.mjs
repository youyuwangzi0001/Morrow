import assert from 'node:assert/strict'
import test from 'node:test'
import { login } from '../src/service.js'
import { loginErrorMessage } from '../src/page.js'

const accounts = {
  alice: { password: 'secret', locked: false },
  bob: { password: 'pw', locked: true }
}

test('有效凭据返回 token', () => {
  assert.deepEqual(login({ username: 'alice', password: 'secret' }, accounts), {
    status: 200,
    body: { accessToken: 'token-alice' }
  })
})

test('错误密码返回 401', () => {
  assert.deepEqual(login({ username: 'alice', password: 'wrong' }, accounts), {
    status: 401,
    body: { error: 'invalid_credentials' }
  })
})

test('锁定账户返回 423 且不签发 token', () => {
  const result = login({ username: 'bob', password: 'pw' }, accounts)
  assert.equal(result.status, 423)
  assert.deepEqual(result.body, { error: 'account_locked' })
  assert.equal(result.body.accessToken, undefined)
})

test('页面显示锁定提示', () => {
  assert.equal(loginErrorMessage(423), '账户已锁定')
  assert.equal(loginErrorMessage(401), '账号或密码不正确')
})
