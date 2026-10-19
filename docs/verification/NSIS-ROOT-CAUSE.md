# NSIS 便携单文件「打不开」根因与规避（M4 优化轮）

> 记录时间：2026-10-19 01:25（Asia/Shanghai）
> 复现环境：Windows 10.0.26300 x64 · Electron 44.9.0（trial）/ 38.2.2（复现用旧包，NSIS 外壳同模板）
> 相关实现：`node_modules/app-builder-lib/templates/nsis/portable.nsi`、`scripts/dist-portable.mjs`、`scripts/smoke-packaged.mjs`

## 1. 用户现象

双击 `release/Morrow-1.0.0-portable.exe` 报错：

> Error writing temporary file. Make sure your temp folder is valid.

应用不打开。

## 2. 根因

### 2.1 直接原因：单文件便携版是 NSIS 自解压外壳，启动时必须写 `%TEMP%`

electron-builder 的 `portable` target 不是「直接运行的单文件」，而是一个 NSIS 自解压安装器。模板关键代码
（`app-builder-lib/templates/nsis/portable.nsi`）：

```nsis
StrCpy $INSTDIR "$PLUGINSDIR\app"     ; $PLUGINSDIR = %TEMP%\<nsis随机>.tmp
RMDir /r $INSTDIR
SetOutPath $INSTDIR                   ; ← TEMP 不可写/不存在/已满时这里失败
File /r "${APP_DIR_64}\*.*"           ; 把整个 ~250MB 应用解压到 %TEMP%
...
ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0"   ; 再启动解压后的 exe
RMDir /r $INSTDIR                     ; 退出时清理
```

因此：**`%TEMP%` 必须存在、可写、有足够空间**；否则 `SetOutPath` 失败，NSIS 弹出上述错误并退出。
用户如果在受限宿主（例如 DSH 卡片「打开」、被托管的沙箱进程、TEMP 被重定向到不可写目录的环境）里双击，
就会命中这个失败路径。

**复现证据**（旧 Electron 38 单文件包，NSIS 外壳行为与 44 相同）：

| 场景 | TEMP | 结果 |
|---|---|---|
| A 正常宿主 TEMP（本机可写） | 继承宿主 | ✅ CDP 就绪 4391ms（先解压 ~4s） |
| B TEMP 指向不存在的盘符 `Z:\Temp` | `Z:\Temp` | ❌ 无 CDP，5.6s 后进程退出 `code=2`（NSIS 中止，对应 TEMP 错误） |
| C TEMP 指向一个「文件」路径 | `<…>\temp-is-a-file` | ❌ 无 CDP，8.8s 后退出 `code=2` |

> 本机 DSH 会话当前是完全访问策略，宿主 TEMP 可写，所以单文件能启动；在写 TEMP 被拒绝的受限宿主上，
> 失败机制与 B/C 同类（NSIS 无法创建/写入 `$PLUGINSDIR`）。

### 2.2 第二层：即使 TEMP 可写，受限令牌下的 Electron 还需要 `--no-sandbox`

在受限宿主的子进程令牌下，Electron/Chromium 的沙箱初始化会失败（我们在本机受限 shell 中复现）：
单文件解压成功后，子进程**无窗口崩溃**，退出码 `2147483651`（`0x80000003`）。

| 场景 | TEMP | 额外参数 | 结果 |
|---|---|---|---|
| D 单文件（旧包） | 工作区可写 | 无 | ❌ 无 CDP，进程退出 `2147483651`（Electron 崩溃） |
| E 单文件（旧包） | 工作区可写 | `--no-sandbox` | ✅ CDP 就绪 3993ms，正常渲染 |
| F 文件夹版 `Morrow.exe` | 继承宿主 | 无 | ❌ 进程退出 `2147483651`（受限令牌下沙箱失败） |
| G 文件夹版 + 兼容模式 | 继承宿主 | `--no-sandbox` | ✅ CDP 就绪 **422ms**，正常渲染（见 `screens/packaged-folder-smoke.png`） |

结论：用户「打不开」是**两层依赖叠加**：① NSIS 自解压需要可写 `%TEMP%`；② 受限令牌下 Electron 需要
`--no-sandbox`。普通用户双击（正常令牌 + 可写 TEMP）不受影响；从受限宿主启动才会命中。

## 3. 规避方式（本轮交付形态调整）

| 形态 | 路径 | 是否依赖 %TEMP% | 说明 |
|---|---|---|---|
| **便携文件夹（主推）** | `release/Morrow-1.0.0-portable/Morrow.exe` | ❌ 否 | 无自解压，双击直接运行；启动快（CDP 422ms，单文件 ~4000ms）；含 `portable.marker`（数据目录跟随 exe，拷走即用）与兼容模式脚本 |
| **文件夹 zip（分发用）** | `release/Morrow-1.0.0-portable-win64.zip` | ❌ 否 | 解压即得上述文件夹（含 marker/兼容脚本，zip 内文件名 UTF-8） |
| 单文件 exe（备选） | `release/Morrow-1.0.0-portable.exe` | ✅ 是 | 保留兼容，但受限宿主仍可能报 TEMP/沙箱错误；仅作备选 |

**受限宿主启动兜底**：文件夹内 `启动 Morrow（兼容模式）.cmd`：

```bat
@echo off
cd /d "%~dp0"
start "" "%~dp0Morrow.exe" --no-sandbox
```

正常情况双击 `Morrow.exe`；若从受限宿主（如 DSH 卡片「打开」）启动无反应，再用兼容模式脚本。
（普通用户 token 下无需 `--no-sandbox`；Electron 官方不建议常开，因此只在兼容脚本里加。）

## 4. 复现方法（可重复执行）

原生脚本已封装：`scripts/smoke-packaged.mjs --folder|--all` 会真实启动对应形态（CDP 连接 + 截图 + 进程清理）。
上面的 A–G 对照实验用临时探针完成，探针结果归档：

- 机器可读：`docs/verification/nsis-root-cause.json`
- 关键命令形态：`spawn(exe, ['--no-sandbox', '--user-data-dir=…\\tmp\\…', '--data-dir=…\\tmp\\…', '--test-mode', '--remote-debugging-port=<free>'], { env: { ...process.env, TEMP: <场景>, TMP: <场景> } })`，
  轮询 `http://127.0.0.1:<port>/json/version` 判断是否启动，`taskkill /PID <pid> /T /F` 清理。

## 5. 后续（代码冻结后）

1. `npm run build`
2. `node scripts/dist-portable.mjs`（默认 `--all`）→ 一次产出文件夹 + zip + 单文件 exe（Electron 44.9.0）
3. `node scripts/smoke-packaged.mjs --all` → 两形态真实启动冒烟（文件夹用宿主 TEMP 证明无自解压依赖）
4. 更新 `docs/verification/EVIDENCE.md` 的第 9 节验收总表与「便携形态说明」，并刷新 `packaging.json` / `smoke-packaged*.json`
5. 用最终单文件 exe 重跑一次 A/C/F 对照，确认结论不变（Electron 44 + 新构建）
