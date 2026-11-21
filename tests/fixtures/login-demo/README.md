# 登录功能基准样例

这是协作升级 T01 使用的隔离样例项目。它故意保留不完整的实现，让基准脚本里的三名成员分别补齐登录服务、页面提示和锁定用例。

## 验收

```bash
node --test test/login-check.mjs test/lockout-check.mjs
```

初始状态会失败；两名实现成员写入后、测试成员补上锁定用例后应全部通过。

## 文件

- `spec/login-v1.md`：登录规则
- `src/service.js`：登录服务（待实现）
- `src/page.js`：页面错误提示（待实现）
- `test/login-check.mjs`：验收用例
- `test/lockout-check.mjs`：由测试成员补充的锁定用例（初始不存在）
