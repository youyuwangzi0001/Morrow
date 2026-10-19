# Morrow 验证证据索引（M4 · 交付工程）

> 最后更新：2026-10-19 01:51（Asia/Shanghai）· 维护：delivery · **第二轮优化最终交付版 · Electron 44.9.0**
> 截图统一在 [`docs/verification/screens/`](./screens/)；完整命令输出在 [`docs/verification/logs/`](./logs/)；
> 机器可读摘要： [`packaging.json`](./packaging.json)（打包）、[`smoke-packaged.json`](./smoke-packaged.json)（打包冒烟）。
> 本文件只记录真实执行过的命令与输出；失败项会如实标注。

---

## 0. 环境

| 项 | 值 |
|---|---|
| OS | Windows（10.0.26300，x64） |
| Node / npm | v24.19.0 / 11.17.0 |
| Electron | **44.9.0**（最终交付；第一轮为 38.2.2） |
| electron-builder | 26.0.12 |
| @playwright/test | 1.64.1 |
| Python / Pillow | 3.12.10 / 12.3.0 |
| 构建产物 | `out/main/index.js`、`out/renderer/`（**最终构建 01:47**，`npm run build` 含 typecheck 0 error） |
| 交付形态 | **便携文件夹（主推）** + zip（分发用）+ 单文件 exe（备选，见 §11） |
| 窗口规格 | 默认窗口目标 **2000×1000 物理像素**；本机 150% 缩放下窗口内容区实测 **2000×1001 物理像素**（宽精确 2000；高 1000/1.5 无法整除，取整 +1px），`page.screenshot` 2000–2001×1001（≤1px 取整误差）；100%/125%/200% 缩放下可精确 2000×1000 |

**本机受限环境约束（已由脚本处理，不影响最终用户）**：DSH 会话子进程带受限令牌，
① Electron 启动必须 `--no-sandbox`；② Chromium `--user-data-dir` 与 Morrow `--data-dir` 必须在项目 `tmp/` 内；
③ 必须删除 `ELECTRON_RUN_AS_NODE`；④ Electron 下载缓存、portable 自解压的 `TEMP` 都重定向到 `tmp/`（否则 Access denied）。

---

## 1. 演示工作区资产（task-2 第 1 项）✅

**位置**：`assets/demo-workspace/`（UTF-8 无 BOM，静态只读源；主进程 `workspace.createDemo()` 复制到 `<userData>/demo-workspace` 后使用，演示过程不改资产）

| 文件 | 内容 |
|---|---|
| `销售明细-2026Q3.csv` | 103 数据行 / 102 个唯一订单号 / 101 单有效订单；表头 `日期,订单号,渠道,客户,城市,品类,单价,数量,折扣,金额`；含 4 处异常（折扣 85%、退款负数、整行重复订单号、金额勾稽差 1888） |
| `客户名单.csv` | 20 行：`客户,城市,行业,签约日期,等级`；含「上海星野广告」城市矛盾（名单杭州 / 销售表上海） |
| `README-待整理.md` | 杂乱说明：老板要的 5 项指标 + 5 条待办 + 折扣口径 4 条 + 4 条存疑（Q2 合计对不上、金额勾稽不符等） |
| `旧文件/2026Q2-销售汇总.csv` | Q2 分月分渠道汇总（18 行 + 合计行；合计行故意写错，比实际多 860） |
| `旧文件/客户回访记录-2026-06.txt` | 10 行杂记，可整理/归档 |

**数据自洽性校验（干净口径 = 去重 + 剔除退款 + 用金额列）**：
总销售额 **171,627.85**；有效订单 **101**；客单价 **1,699.29**；Q2 **144,900** → 环比 **+18.45%**（精确 18.4453%，报告四舍五入；此前 EVIDENCE 记的 18.44% 是截断，已按 engine 真实计算校正）；
月度 43,421 → 61,106 → 67,101；Top 渠道 京东自营 61,382（订单数最多是抖音直播 42 单）；Top 城市 广州；Top 品类 企业礼盒。
（engine 的演示剧本以此为准，数值已同步给 engine。）

---

## 2. Mock LLM 服务器（task-2 第 2 项）✅

**文件**：`tests/fixtures/mock-llm.mjs`（纯 node:http，无第三方依赖）+ `tests/fixtures/mock-llm.d.mts`（给 engine 的 TS 类型声明）+ `tests/fixtures/mock-llm.test.mjs`（自检）

**能力**：`POST /v1/chat/completions`（OpenAI SSE：文本、`tool_calls` 分片、`reasoning_content`、`stream_options.include_usage`、非流式 JSON）与
`POST /v1/messages`（Anthropic SSE：`message_start` / `content_block_start` / `content_block_delta`(text_delta + input_json_delta) / `message_delta` / `message_stop`）；
`GET /v1/models`、`GET /health`；剧本按请求序号或 `respond(ctx)`（可取最后一条 user 消息）选择；支持 429/500 错误注入与 hang 超时注入；端口动态（`port: 0`）。

**自检结果**（2026-10-19 00:36）：

```bash
node --test tests/fixtures/mock-llm.test.mjs
# ℹ tests 13  ℹ pass 13  ℹ fail 0  ℹ duration_ms 2495.98
```

- 日志：[`logs/mock-llm-test.log`](./logs/mock-llm-test.log)
- 覆盖：双协议文本流、OpenAI tool_calls 多调用分片聚合、include_usage 开关、非流式 JSON、429→重试、500 归一化、Anthropic 事件序列、Anthropic input_json_delta 拼装、按 user 消息选剧本、defaultScript/reset、分片延迟 + reasoning_content、hang 超时后 close 不悬挂、rawSse 透传。
- 说明：根 `vitest.config.ts` 只扫 `tests/unit/**`，故 fixture 自检用 `node --test` 独立运行，不影响 `npm run test:unit`。

---

## 3. E2E 基础设施与完整旅程（task-2 第 3 项）✅

**文件**：
- `tests/e2e/launch.ts`：Playwright `_electron.launch` 启动器（`--no-sandbox` + `--user-data-dir`/`--data-dir` 在 `tmp/` + `--test-mode` + 清除 `ELECTRON_RUN_AS_NODE`；每个测试独立数据目录；等窗口 `ready-to-show` 后再断言；支持复用 data-dir 做重启恢复测试）。
- `tests/e2e/store.ts`：test-mode 下 `window.__morrowStore`（src/renderer/src/main.tsx 注入）的状态读取、RuntimeEvent 收集、审批应答、Mock provider 注册等驱动工具。
- `tests/e2e/smoke.spec.ts`：窗口/标题/预加载/首屏 + 明暗主题；窗口断言按 `scaleFactor` 换算**物理像素**（150% 下 bounds×1.5 ≥ 1990×990，对应 2000×1000 目标）。
- `tests/e2e/journey.spec.ts`：7 条完整旅程。

**结果**（2026-10-19 01:50，`npx playwright test`，针对 01:47 最终构建）：**9/9 通过（32.3s）**

| # | 旅程 | 耗时 | 关键断言 |
|---|---|---|---|
| 1 | 演示模式：点「看一场演示」→ 真实跑完 → HTML 报告落盘 → 画布自动打开 | 11.0s | run_finished=complete；artifacts≥1；报告文件 >1KB 且为 HTML；画布 iframe 可见；工具调用全部 success；无 error 事件；有 demo_step/artifacts_updated 事件 |
| 2 | 权限卡「拒绝」（Mock LLM 触发 write_file） | 1.3s | 审批卡真实出现并截图；点「拒绝」→ permission_resolved=deny；tool_finished denied；文件**未写入**；run=complete；无 crash |
| 3 | 权限卡「允许一次」（Mock LLM 触发 write_file） | 1.3s | 点「允许一次」→ 工具 success；文件真实写入且内容正确；run=complete；无 denied |
| 4 | 中断：运行中 stopRun | 2.2s | run_finished=cancelled；助手消息 interrupted=true（store 与磁盘重载双验证）；UI 显示「已停止生成」 |
| 5 | 会话恢复：完成一轮 → 关闭 → 同 data-dir 重启 | 12.8s | bootstrap 会话列表含原会话；消息/产物数量一致；计划保留；画布可重新打开并渲染 iframe |
| 6 | ask_user 卡片：Mock LLM 触发提问 → 真实点选项 → 答案回填 | 1.4s | `question_asked` 事件与 `pendingQuestion`；卡片渲染问题与选项；点「HTML 报告」→ `question_answered.value=html`；Mock 第二轮请求包含答案；run=complete |
| 7 | 键盘/主题：Ctrl+K、方向键、Esc、Ctrl+B、store.setTheme | 1.2s | 命令面板真实浮层打开（`.palette`）、方向键移动选中项（aria-activedescendant/is-active）、Esc 关闭、侧栏折叠切换、明暗主题真实切换（body 底色断言） |
| 8–9 | 冒烟：窗口/标题/预加载/首屏；明暗主题 token | 2.5s | 见下方基础断言 |

**方法说明（为什么这些证据可信）**：
- **真实链路**：全部走真实渲染进程 + 真实主进程（store → preload → IPC → AgentService → core AgentRuntime → 真实工具执行）；演示模式在复制出的工作区里真实读 CSV、跑 PowerShell 聚合、写 HTML 报告，无任何 mock 数据。
- **四层互证**：断言同时覆盖 ① zustand store 状态、② 主进程 RuntimeEvent 流、③ DOM/截图、④ 磁盘文件（报告内容、写入文件内容、持久化会话重载）。
- **权限用例用 Mock LLM**：演示模式按 engine 设计强制 auto 权限，无法触发审批；因此权限旅程用 `tests/fixtures/mock-llm.mjs` + 主进程 test-only「本机端点免 Key」通道（provider baseUrl 为 `http://127.0.0.1:*` 时生效），真实点击审批卡按钮。
- **速度控制**：`MORROW_DEMO_SPEED`（0.05 秒播 / 0.25 用于中断窗口）由 engine 支持，工具执行仍真实发生。
- **问与画布**：ask_user 旅程覆盖 M3-2 提问卡（真实点选项、答案回填 Mock LLM）；演示旅程末尾还验证画布「关闭 → 从产物重新打开 → iframe 再次渲染」。
- **命令面板**：shell 落地真实面板后，键盘用例已补「方向键选中 + Esc 关闭」的 DOM 断言（不再只断言 store 状态）。

**截图证据**（`docs/verification/screens/`）：
| 截图 | 内容 |
|---|---|
| [demo-run.png](./screens/demo-run.png) | 演示完成态：报告已在画布渲染、计划 4/5、三条后续建议 |
| [permission-card.png](./screens/permission-card.png) | 真实审批卡（写入 permission-test.md · 中风险 · 允许一次/本次会话都允许/拒绝） |
| [permission-denied.png](./screens/permission-denied.png) | 拒绝后：工具 denied、run 正常收尾 |
| [permission-allowed.png](./screens/permission-allowed.png) | 允许一次后：文件写入、工具 success |
| [e2e-interrupt.png](./screens/e2e-interrupt.png) | 中断后：消息下「已停止生成」+ toast「已停止本轮运行」 |
| [e2e-restore.png](./screens/e2e-restore.png) | 同 data-dir 重启后恢复的会话与画布 |
| [e2e-question-card.png](./screens/e2e-question-card.png) | ask_user 提问卡（HTML 报告 / Word 文档 / 自定义回答） |
| [e2e-question-answered.png](./screens/e2e-question-answered.png) | 点选 HTML 报告后模型继续完成 |
| [e2e-palette.png](./screens/e2e-palette.png) | 命令面板（Ctrl+K）：操作分组、方向键选中、Esc 关闭提示 |
| [e2e-theme-light-store.png](./screens/e2e-theme-light-store.png) | 经 store.setTheme 的真实浅色主题 |
| [e2e-boot.png](./screens/e2e-boot.png) / [e2e-theme-dark.png](./screens/e2e-theme-dark.png) / [e2e-theme-light.png](./screens/e2e-theme-light.png) | 冒烟：首屏与两套主题 |

- 日志：[logs/e2e.log](./logs/e2e.log)（9/9 通过完整输出）、[logs/e2e-journey.log](./logs/e2e-journey.log)（旅程专项）。
- 已无占位断言：命令面板、审批卡、提问卡、画布均为真实组件。

## 4. 应用图标（task-2 第 4 项）✅

**生成脚本**：`scripts/make-icons.py`（Pillow + 系统 Georgia 字体，先超采样再 LANCZOS 缩小）

```bash
python scripts/make-icons.py
# icon.png       512×512  RGBA  164,498 B
# icon.ico       16/24/32/48/64/128/256 七尺寸  361,102 B（经典 BMP/DIB 帧，NSIS/资源管理器兼容）
# installerIcon.ico  与 icon.ico 同源
# 回读校验：[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)]
```

- 设计：石墨底（#10141A 系竖向渐变 + 极淡噪点 + 右上暖光）圆角方形（圆角 22.5%）；香槟金（#C8AE7D→#E4CE9E）细地平线上升弧（两端渐隐 + 柔光）；衬线大写 `M`（金色上下渐变，基线距地平线 4%）；内侧 1px 冷色描边。小尺寸（16/24/32）用 Georgia Bold 保证任务栏可读，≥48 用 Georgia Regular 保持克制。
- 预览：[icon-preview.png](./screens/icon-preview.png)（16→512 全尺寸走查图）。

---

## 5. 打包与打包冒烟（最终交付 · Electron 44.9.0）✅

**最终构建**：2026-10-19 01:47 `npm run build`（typecheck 0 error）→ 01:47:41–01:49:33 一键产出三件产物（窗口规格最后修正已包含在内）。

```bash
node scripts/dist-portable.mjs          # 默认 = --all：文件夹 + zip + 单文件 exe（112.4s）
node scripts/smoke-packaged.mjs --all   # 两形态真实启动冒烟
```

### 5.1 三件产物（真实结果）

| 形态 | 路径 | 大小 | 其他 |
|---|---|---|---|
| **便携文件夹（主推）** | `release/Morrow-1.0.0-portable/` | **385.97 MB（404,720,599 B）· 74 files** | 含 `portable.marker`（0B）+ `启动 Morrow（兼容模式）.cmd`；folder 内 `Morrow.exe` 247,508,992 B，sha256 `bd2dd3ce5decc322…` |
| **zip（分发用）** | `release/Morrow-1.0.0-portable-win64.zip` | **155.46 MB（163,015,631 B）** | sha256 `48c7ae2be575b5dd700fefde10921b5a4214f643f9bf01bbe8a4a6fa8f143516`；77 entries，UTF-8 文件名（含中文兼容脚本） |
| 单文件 exe（备选） | `release/Morrow-1.0.0-portable.exe` | **106.54 MB（111,717,038 B）** | sha256 `096d74a5d5b2de3f2d3a0fd0f1551b82a0062ab5a31c4441f7eb3058cdcb03e7`；NSIS 自解压，依赖 `%TEMP%`（见 §11） |

- 构建明细：[`packaging.json`](./packaging.json)（mode=all、electron 44.9.0、started 01:47:41 / finished 01:49:33、steps：dir 8.2s / zip 16.3s / portable 87.5s、三件产物 size/sha256）
- 日志：[logs/dist-all.log](./logs/dist-all.log)、时间戳版 [dist-all-2026-10-18T17-47-41-027Z.log](./logs/dist-all-2026-10-18T17-47-41-027Z.log)
- `--all` 流程在单文件构建后清理了中间目录 `release/win-unpacked/`（文件夹版即同构内容）；**`release/Morrow-1.0.0-portable/` 打包后保持原样，供 Lead 做打包版 deepseek-flash 真实任务 + 离线演示**。

### 5.2 两形态冒烟（`node scripts/smoke-packaged.mjs --all`，01:49）

| 形态 | exe | 启动方式 | 结果 |
|---|---|---|---|
| 单文件 exe | `release/Morrow-1.0.0-portable.exe` | TEMP 重定向到 `tmp/`（NSIS 自解压需要） | ✅ CDP 就绪 **4888ms**（总 6.0s）；解压到临时目录运行（符合预期）；渲染/截图正常 |
| **文件夹版** | `release/Morrow-1.0.0-portable/Morrow.exe` | **继承宿主 TEMP（不重定向）** | ✅ CDP 就绪 **423ms**（总 1.4s）；**在 release/ 原地运行（无自解压）**；渲染/截图正常 |
| **portable.marker 校验**（文件夹版附加） | 同上，不带 `--data-dir` 启动 | 继承宿主 TEMP | ✅ 数据目录自动创建在 exe 同级 `Morrow Data/`（含 attachments/blob_storage/Cache…）；**验证后已清理，交付文件夹与 zip 未被污染**（zip 在冒烟前生成，回读校验 marker/兼容脚本齐全） |

- 截图（均为 2000–2001×1001 物理像素）：[packaged-smoke.png](./screens/packaged-smoke.png)（单文件）、[packaged-folder-smoke.png](./screens/packaged-folder-smoke.png)（文件夹版）
- 摘要：[smoke-packaged.json](./smoke-packaged.json)、[smoke-packaged-folder.json](./smoke-packaged-folder.json)
- 日志：[logs/smoke-packaged-portable.log](./logs/smoke-packaged-portable.log)、[logs/smoke-packaged-folder.log](./logs/smoke-packaged-folder.log)
- 两形态进程都用 `taskkill /T /F` 清理，`tasklist` 确认无 `Morrow.exe` / 单文件进程残留。
- 说明：单文件是 NSIS 自解压外壳，Playwright `_electron.launch` 直连不稳，统一用 `--remote-debugging-port` + `chromium.connectOverCDP`；文件夹版为普通 Electron 应用，同样方式连接。

---

## 6. 真实模型直播冒烟（task-2 第 6 项）✅

**脚本**：`scripts/probe-live.mjs`（从 `%USERPROFILE%\.dsh\.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` 读取，或环境变量覆盖；**不打印密钥**；结果写 `probe/`，该目录已 gitignore，不入交付物）

```bash
node scripts/probe-live.mjs
# HTTP 状态：200
# 首字节延迟：131ms · 首 token 延迟：701ms · 总耗时：764ms
# finish_reason：tool_calls · 文本长度：0 字
# usage：prompt=324 completion=42 total=366（缓存命中 128）
# tool_calls：get_current_time({"timezone":"Asia/Shanghai"})
# 结论：通过（流式 + 工具调用解析成功）
```

- 端点 `https://api.deepseek.com/v1/chat/completions`，模型 `deepseek-chat`，`stream: true` + `tools` + `stream_options.include_usage`。
- 本机结果文件：`probe/live-probe-*.json`（本机验证用，不提交）。

---

## 7. 一键复跑

```bash
# 1) 全仓验证
npm run build          # 含 typecheck
npm run test:unit      # engine 单测
npm run test:mock      # Mock LLM 双协议自检
npx playwright test    # 桌面 E2E（9 条）

# 2) 三件产物 + 两形态冒烟
node scripts/dist-portable.mjs          # = --all（文件夹 + zip + 单文件 exe）
node scripts/smoke-packaged.mjs --all   # 两形态真实启动 + 截图 + marker 校验

# 3) 图标（幂等）
python scripts/make-icons.py

# 4) 真实模型冒烟 / 能力验证（本机 Key）
node scripts/probe-live.mjs
npx vitest run --config tmp/capability/vitest.config.ts tmp/capability/run.test.ts   # 见 docs/CAPABILITY-REPORT.md
```

**当前全仓验证状态**（2026-10-19 01:50，最终构建 01:47，窗口规格修正后）：

| 命令 | 结果 | 日志（本地，`*.log` 被 gitignore） |
|---|---|---|
| `npm run build`（含 typecheck） | ✅ 0 error | [logs/final-build.log](./logs/final-build.log) |
| `npm run test:unit`（engine） | ✅ **145/145**（9 files） | [logs/unit.log](./logs/unit.log) |
| `npm run test:mock` | ✅ 13/13 | [logs/mock-llm-test.log](./logs/mock-llm-test.log) |
| `npx playwright test` | ✅ **9/9**（32.3s） | [logs/e2e.log](./logs/e2e.log) |
| `node scripts/probe-live.mjs`（真实 DeepSeek） | ✅ HTTP 200 / 首 token **701ms** / `tool_calls` 解析成功 | [logs/probe-live.log](./logs/probe-live.log) |
| 真实模型能力验证 | ✅ 9/9，评审均分 4.78（见 §12） | [docs/CAPABILITY-REPORT.md](../CAPABILITY-REPORT.md) |

> 注：`*.log` 被根 `.gitignore` 忽略，属本地证据（工作目录内可见）；机器可读摘要 `packaging.json` / `smoke-packaged*.json` 与截图不受影响。

---

## 8. 已知限制与说明

1. **E2E 数据与范围**：旅程测试会向 `tmp/` 写临时工作区与独立 data-dir，并复制演示工作区到数据目录（不改 `assets/` 资产）；8 条测试全绿，但其中键盘面板的 Esc 关闭、画布外部打开等细节断言待对应 UI 稳定后补。
2. **最终打包已完成**：代码冻结后于 01:00 重新构建、01:03 产出 portable 并通过真实启动冒烟；`release/win-unpacked/` 保留供 Lead 做打包版离线演示。若之后 `src/` 再有改动，需重跑 `npm run build && node scripts/dist-portable.mjs && node scripts/smoke-packaged.mjs`。
3. **代码签名**：未配置签名证书，Windows SmartScreen 可能提示「未知发布者」；electron-builder 日志中的 `signing with signtool.exe` 为无证书跳过。这是本期交付的已知限制。
4. **受限令牌**：本机 DSH 会话下 Electron 必须 `--no-sandbox` 且数据目录在 `tmp/`；最终用户双击 exe 走正常系统目录，不需要这些参数（脚本只在测试/截图时加）。
5. **真实直播冒烟**：依赖本机 Key 与网络，结果落 `probe/`（gitignored）；报告中只保留指标，不含密钥。
6. **Mock LLM 自检**：用 `node --test`（根 vitest 配置只扫 `tests/unit/**`）；engine 的 TS 单测可从 `tests/fixtures/mock-llm.mjs` 导入（已提供 `.d.mts` 类型声明）。
7. **图标**：16/24/32 使用 Georgia Bold（光学尺寸），大尺寸 Georgia Regular；如需品牌字体 Newsreader 的精确字形，可用 fonttools 转换 woff2 后再生成（本期用系统衬线体，符合任务要求）。

---

## 9. 交付验收总表（最终 · 窗口规格修正后）

> 全部为本机真实执行结果；最后一次 src 改动（窗口物理像素修正）后于 2026-10-19 01:47 最终构建，三件产物 01:49 完成。

| # | 验收项 | 命令 | 真实验收结果 | 证据 |
|---|---|---|---|---|
| 1 | 类型检查 | `npm run build`（内含 typecheck） | ✅ 0 error | [final-build.log](./logs/final-build.log) |
| 2 | 单元测试（engine） | `npm run test:unit` | ✅ **145/145**（9 files） | [unit.log](./logs/unit.log) |
| 3 | Mock LLM 协议测试 | `npm run test:mock` | ✅ 13/13 | [mock-llm-test.log](./logs/mock-llm-test.log) |
| 4 | 桌面 E2E（Playwright Electron） | `npx playwright test` | ✅ **9/9**（32.3s，含按 scaleFactor 的窗口物理像素断言） | [e2e.log](./logs/e2e.log)、[screens](./screens/) |
| 5 | 真实模型能力验证（deepseek-flash） | `tmp/capability/run.test.ts` | ✅ **9/9 机械通过，评审均分 4.78/5**（85 次真实模型调用） | [docs/CAPABILITY-REPORT.md](../CAPABILITY-REPORT.md)、§12 |
| 6 | 真实模型直播冒烟 | `node scripts/probe-live.mjs` | ✅ HTTP 200；首字节 131ms；首 token **701ms**；总 764ms；`tool_calls` 解析成功；usage 324/42/366（缓存命中 128） | [probe-live.log](./logs/probe-live.log) |
| 7 | 打包冒烟（单文件 exe） | `node scripts/smoke-packaged.mjs` | ✅ 106.54 MB exe 真实启动；CDP 4888ms；NSIS 解压到临时目录（预期）；渲染/截图正常；无残留 | [smoke-packaged.json](./smoke-packaged.json)、[packaged-smoke.png](./screens/packaged-smoke.png) |
| 8 | 打包冒烟（文件夹版 · 主推） | `node scripts/smoke-packaged.mjs --folder` | ✅ 236.04 MB `Morrow.exe` 真实启动；CDP **423ms**；**原地运行（无自解压）**；`portable.marker` 数据目录校验通过并清理；无残留 | [smoke-packaged-folder.json](./smoke-packaged-folder.json)、[packaged-folder-smoke.png](./screens/packaged-folder-smoke.png) |
| 9 | 便携文件夹产物 | `node scripts/dist-portable.mjs` | ✅ `release/Morrow-1.0.0-portable/`；**385.97 MB / 74 files**；含 marker + 兼容脚本 | [packaging.json](./packaging.json)、[dist-all.log](./logs/dist-all.log) |
| 10 | zip 产物 | 同上 | ✅ `release/Morrow-1.0.0-portable-win64.zip`；155.46 MB；sha256 `48c7ae2be575…3516` | [packaging.json](./packaging.json) |
| 11 | 单文件 exe 产物 | 同上 | ✅ `release/Morrow-1.0.0-portable.exe`；106.54 MB；sha256 `096d74a5d5b2…03e7` | [packaging.json](./packaging.json) |
| 12 | 窗口规格 | E2E + 冒烟截图实测 | ✅ 目标 **2000×1000 物理像素**；150% 缩放下内容区 **2000×1001 物理像素**（宽精确、高 +1px 取整），截图 2000–2001×1001，误差 ≤1px | [e2e-boot.png](./screens/e2e-boot.png)、[packaged-folder-smoke.png](./screens/packaged-folder-smoke.png) |

**最终交付路径（绝对）**
- 文件夹版（主推）：`C:\交付成品\Morrow\release\Morrow-1.0.0-portable\`（入口 `Morrow.exe`，385.97 MB / 74 files）
- zip：`C:\交付成品\Morrow\release\Morrow-1.0.0-portable-win64.zip`（155.46 MB）
- 单文件 exe（备选）：`C:\交付成品\Morrow\release\Morrow-1.0.0-portable.exe`（106.54 MB）

---

## 10. 打包版离线演示（第一轮 · Electron 38 历史记录）

**目的**：确认最终便携包内（asar）的演示资源、Agent 内核、工具链、渲染层在打包环境下完整可用，而不只是开发态可用。

**执行**：`node scripts/packaged-demo-smoke.mjs`（真实启动 `release/win-unpacked/Morrow.exe`，Playwright 驱动，test-mode + `MORROW_DEMO_SPEED=0.15`）

**结果（2026-10-19 01:04）**：

> 注：本节为第一轮（Electron 38 / 单文件 exe）的历史验收记录；第二轮已改为「便携文件夹」主交付形态，最终产物与数据见 §9 / §11。

| 断言 | 结果 |
|---|---|
| 打包版启动、preload API 可用 | ✅ Electron 38.2.2 / packaged |
| 演示完整运行（10 条消息 / 12 次工具调用） | ✅ run=false（正常结束） |
| 读取 asar 内演示数据并复制到用户数据目录 | ✅ demo-workspace 5 项 |
| 生成自包含 HTML 报告 | ✅ `分析报告.html` 落盘 |
| 画布自动打开并渲染 | ✅ canvas=true, artifact=1 |
| 计划完成度 | ✅ 5/5 completed |
| 会话数量 | ✅ 1（不产生重复空会话） |
| 截图 | [`screens/packaged-demo-done.png`](./screens/packaged-demo-done.png) |

**（第一轮）最终便携包**：`release/Morrow-1.0.0-portable.exe` · 89,568,085 字节（85.42 MB）·
SHA-256 `b1b58ae4080d34f9b3028a700ee2255d192de9d090e1ac7a45b2282b96c83fdd` · 打包冒烟见 §9。

> 注：正式交付目录另含 `release/使用说明.md` 与 `release/screenshots/`（面向用户的截图集）。

---

## 11. 便携形态说明与 NSIS 根因/规避（第二轮修复）

> 完整分析与复现矩阵见 [`NSIS-ROOT-CAUSE.md`](./NSIS-ROOT-CAUSE.md) 与 [`nsis-root-cause.json`](./nsis-root-cause.json)。

### 11.1 三种交付形态

| 形态 | 路径 | 依赖 `%TEMP%` | 启动速度（本机冒烟） | 说明 |
|---|---|---|---|---|
| **便携文件夹（主推）** | `release/Morrow-1.0.0-portable/Morrow.exe` | ❌ 否 | CDP **423ms** | 双击即用；数据写 exe 同级 `Morrow Data/`（`portable.marker`）；受限宿主用 `启动 Morrow（兼容模式）.cmd` |
| zip（分发用） | `release/Morrow-1.0.0-portable-win64.zip` | ❌ 否 | 解压即得文件夹 | 含 marker + 兼容脚本（UTF-8 文件名） |
| 单文件 exe（备选） | `release/Morrow-1.0.0-portable.exe` | ✅ 是 | CDP 4888ms（先解压） | NSIS 自解压，受限宿主可能报 TEMP 错误 |

### 11.2 根因（用户反馈「双击报 Error writing temporary file / 打不开」）

1. **NSIS 自解压依赖可写 `%TEMP%`**：单文件不是「直接运行」，electron-builder 的 `portable.nsi` 中
   `StrCpy $INSTDIR "$PLUGINSDIR\app"`（`$PLUGINSDIR` = `%TEMP%\<随机>.tmp`），启动时 `SetOutPath` + 解压整个应用；
   TEMP 不可写/不存在/已满时 NSIS 弹出该错误并退出（本机复现：TEMP 指向无效路径 → 无窗口、进程退出 `code=2`）。
2. **受限令牌下 Electron 还需 `--no-sandbox`**：即使解压成功，在受限宿主（如 DSH 卡片「打开」）中子进程会无窗口崩溃
   （本机复现退出码 `2147483651` / `0x80000003`）；加 `--no-sandbox` 后正常（兼容脚本即为此场景）。
3. 普通用户任务栏/资源管理器双击（正常令牌 + 可写 TEMP）不受影响；问题只在受限宿主或 TEMP 异常环境显现。

### 11.3 规避

- 主推**文件夹版**：无自解压、不依赖 `%TEMP%`，是「拷走就能用」的便携形态；
- 受限宿主：用 `启动 Morrow（兼容模式）.cmd`（`--no-sandbox`）；
- 单文件 exe 保留为备选并在使用说明中如实标注限制（最终 `release/使用说明.md` 由 Lead 更新）。

---

## 12. 真实模型能力验证（第二轮 · deepseek-flash）

> 完整报告：[docs/CAPABILITY-REPORT.md](../CAPABILITY-REPORT.md)（engine 执行；本机真实网络调用，Key 不落盘不进报告）

| 项目 | 结果 |
|---|---|
| 题数 / 机械通过 | **9 题全部机械通过（9/9）** |
| 模型评审 | 平均 **4.78 / 5**（7 题 5 分、2 题 4 分，无 ≤3 分） |
| 覆盖 | 资深题（bug 修复 / 多 CSV 对账 / spec CLI / 隐藏缺陷审计）+ 小白题（整理文件 / HTML 报告 / 离线小工具 / 会议待办）+ 安全与中断恢复 |
| 模型调用 | 单次完整验收 85 次真实模型调用（agent 76 + judge 9），无 429/5xx |
| 本轮 core 修复（3 个） | ① 工具参数被 max_tokens 截断不再杀死整轮（自修复 + 单测）；② max-steps 达上限后新增一次无工具收尾请求，会话保留可读结论；③ `run_command` 越界路径识别加固（`detectOutsidePathInCommand`），防绕过工作区沙箱 |
| 收尾增强（append） | `write_file` 新增 `append?: boolean`：大产物先写骨架再分段追加，避免单次输出截断；快照/撤销/diff/hash 语义保持；prompt 引导 + 单测覆盖 |
| 最终冻结验证 | typecheck 0 error / unit **145 tests** / 能力 9/9（均分 4.78） |


---

## 13. 第三轮修复：单文件启动器与 2100×1200 物理窗口（Lead 最终验收）

**背景**：用户实测 `Morrow-1.0.0-portable.exe` 仍弹 SmartScreen 且点「运行」后报
`Error writing temporary file`。根因是 electron-builder 的 portable 目标是 NSIS 自解压壳，
**NSIS 插件与应用内容都依赖 `%TEMP%`**，在受限启动环境（如从软件面板打开）下必然失败；
仅修改解压路径的模板级修补无法绕过 NSIS 自身的临时目录依赖。

**修复**：弃用 NSIS 自解压，改为**自研单文件启动器**（`build/launcher/MorrowLauncher.cs`，随仓库提交）：

| 设计 | 说明 |
|---|---|
| 应用内嵌 | 构建时把 `win-unpacked` 压成 zip，作为资源编入 C# 启动器（单文件 exe 155.82 MB） |
| 解压位置 | 首次运行解压到 exe 同级隐藏缓存 `.morrow-runtime-1.0.0/`，**完全不经过 `%TEMP%`**；之后直接复用缓存 |
| 只读兜底 | exe 目录不可写时自动回退 `%LOCALAPPDATA%\Morrow\runtime-1.0.0` |
| 数据目录 | 启动器设置 `PORTABLE_EXECUTABLE_DIR`，主进程据此把 `Morrow Data/` 放在 exe 同级 |
| 子进程环境 | 为应用创建并指定可写 `TEMP/TMP`（`.morrow-runtime-1.0.0/temp`） |
| 首次启动 | 深色极简进度小窗（解压进度），之后启动无感 |
| 代码签名 | 无证书，SmartScreen 仍可能提示「未知发布者」（点击「更多信息 → 仍要运行」）；文件夹版通常不触发 |

**最终验收（真实执行）**：

| 场景 | 结果 |
|---|---|
| `TEMP=Z:\definitely-not-a-temp`（不存在盘符）+ 首次运行 | ✅ 启动成功；CDP 就绪 **3112 ms**（含解压 155 MB），创建 `.morrow-runtime-1.0.0` |
| 同上第二次运行（缓存复用） | ✅ CDP 就绪 **571 ms** |
| 数据目录（未传 `--data-dir`） | ✅ `单文件测试目录/Morrow Data` 自动创建（`PORTABLE_EXECUTABLE_DIR` 生效） |
| 启动器内离线演示（Electron 44.9.0） | ✅ 10 条消息 / 报告生成 / 画布打开 / 计划 5/5；截图 [`screens/single-exe-demo-final.png`](./screens/single-exe-demo-final.png) |
| 窗口物理尺寸 | ✅ 本机 150% 缩放：`innerWidth×dpr = 2100`、`innerHeight×dpr = 1200`；截图 2100×1200 |
| 文件夹版冒烟（无自解压、原地运行） | ✅ CDP 就绪 ~0.4–1.4 s；marker 数据目录验证通过并清理；截图 [`screens/packaged-folder-smoke.png`](./screens/packaged-folder-smoke.png) |
| 单文件版冒烟（启动器） | ✅ 通过；截图 [`screens/packaged-smoke.png`](./screens/packaged-smoke.png) |
| 回归 | ✅ typecheck 0 error · unit 145/145 · E2E 9/9（窗口断言按 scaleFactor 换算物理像素） |

**最终三件产物（2026-10-19 02:11:45 → 02:12:49 构建，Electron 44.9.0，版本 1.0.0）**：

| 形态 | 大小 | SHA-256 |
|---|---|---|
| `release/Morrow-1.0.0-portable/`（74 files） | 385.97 MB；`Morrow.exe` 247,508,992 B | `Morrow.exe`：`60B0EE58F813CDBC0D8409D1E836796EBEE8AE448C3802111B0A9F1DC4628755` |
| `release/Morrow-1.0.0-portable-win64.zip` | 163,015,644 B（155.46 MB） | `6F7E5E814BAAACAC4E20A24781CE429F1F9A13038C476BDD906CDD0F228BC7A1` |
| `release/Morrow-1.0.0-portable.exe`（自研启动器） | 163,384,320 B（155.82 MB） | `F2C75E45AAC441E4A295AC1DA992A0ABB351C6F051DDAD52EB849959AB93E618` |

窗口默认 **2100×1200 物理像素**（150% 缩放 = 1400×800 DIP，精确对应）。


---

## 14. 第四轮修复：双击无窗口/无进程（Chromium 渲染沙箱崩溃）与启动器方案

**用户反馈**：窗口在测试中显示正常，但真实双击单文件 exe / 便携文件夹 exe 都打不开，任务管理器里连进程都不出现。

**根因（实测）**：两种 exe 在「真实双击参数」下都会在 **Chromium 初始化阶段**直接崩溃：

| 场景 | 实测结果 |
|---|---|
| 文件夹版 `Morrow-app.exe`（无参数） | 退出码 **-2147483645 = 0x80000003**（STATUS_BREAKPOINT），无窗口、无数据目录、无日志 —— **主进程 JS 尚未执行** |
| 加 `--no-sandbox` | 正常启动（窗口 2100×1200 物理像素） |
| 各种替代开关（`--disable-gpu-sandbox` / `--disable-gpu` / `--disable-features=RendererCodeIntegrity`） | 全部仍崩溃；只有完整 `--no-sandbox` 可用 |

因此无法在应用代码里兜底（崩溃发生在 JS 之前），必须在**启动器层**解决。

**修复**：
1. **文件夹版**：`Morrow.exe` 改为轻量 C# 启动器（`build/launcher/MorrowLauncher.cs`，`-define:FOLDER_MODE`），
   实际的 Electron 主体改名为 `Morrow-app.exe`；启动器自动以 `--no-sandbox` 启动，并设置
   `PORTABLE_EXECUTABLE_DIR`、可写的 `TEMP/TMP`。
2. **单文件版**：启动器先解压内嵌应用到 `.morrow-runtime-1.0.0`（如之前），再以 `--no-sandbox` 启动
   `Morrow-app.exe`。
3. 安全边界不变：工具工作区沙箱、权限审批、危险命令拦截在 Agent 内核/主进程层；应用只渲染本地内容。
   如未来环境允许 Chromium 沙箱，可直接运行 `Morrow-app.exe`（保留原始入口）。

**真实双击模拟验收（无参数、受限宿主环境）**：

| 场景 | 结果 |
|---|---|
| 文件夹版 `Morrow.exe` 双击（无参数） | ✅ 启动器与 `Morrow-app` 进程常驻，主窗口标题 `Morrow` |
| 单文件 `Morrow-1.0.0-portable.exe` 双击（无参数，TEMP=`Z:\broken-temp`） | ✅ 启动器 + 应用进程常驻，主窗口标题 `Morrow` |
| `smoke-packaged.mjs --all` | ✅ 单文件与文件夹版均通过（文件夹 CDP 就绪 409ms、无自解压、marker 数据目录验证通过） |
| `packaged-demo-smoke.mjs`（从文件夹启动器真实入口启动） | ✅ CDP 271ms；离线演示 10 条消息、报告生成、画布打开、计划 5/5；截图 [`screens/packaged-demo-done.png`](./screens/packaged-demo-done.png) |

**最终三件产物（2026-10-19 02:27:14 → 02:28:03 构建，Electron 44.9.0，版本 1.0.0）**：

| 形态 | 大小 | SHA-256 |
|---|---|---|
| `release/Morrow-1.0.0-portable/`（75 files） | 386.33 MB | `Morrow.exe`（启动器，372,736 B）：`559460127F031C7A694169CF760007CE06F3EA848DC38C27E4A0599FCCF46E15`；`Morrow-app.exe`：`60B0EE58F813CDBC0D8409D1E836796EBEE8AE448C3802111B0A9F1DC4628755` |
| `release/Morrow-1.0.0-portable-win64.zip` | 163,095,836 B（155.54 MB） | `08C5B7C7ADC2E9A98CFE8A0344D66992737C42DFE1BEC3B09BFF9845E4286779` |
| `release/Morrow-1.0.0-portable.exe` | 163,464,704 B（155.89 MB） | `F9570514C1B29F60DD6F21AC51C3A243E7B9DA9C3892265D5D1A11973BCFE226` |

窗口默认 **2100×1200 物理像素** 不变。


---

## 15. 第五轮：交互/设置/视觉优化与上下文精度（2026-10-19）

**用户要求**：侧栏可拖动调宽（1px 香槟金渐变线提示）、顶栏收起后侧栏完全不可见、顶栏新增画布开关；
设置重做、换成截至今天的最新模型与准确上下文数据；整体美化。

### 15.1 交互
| 项 | 实测 |
|---|---|
| 侧栏拖动 | 264 → 368px；拖动过程中 1px 香槟金渐变线 + `368px` 读数可见；松手后持久化；双击恢复 264；方向键微调 |
| 侧栏完全收起 | 点击顶栏按钮后 `.app-sidebar-shell` DOM 数量 = 0，内容区铺满；再点恢复 |
| 画布开关 | 无产物时打开空态（编辑感引导 + 三步说明 + 关闭）；有产物时直接打开最近产物；再次点击收起 |
| 设置 | 12 家 provider 分组（国内/国际/聚合/本地）、模型项显示上下文/输出、同步模型列表、自定义模型 ID 重启保留 |

### 15.2 最新模型清单（截至 2026-10-19，已按用户指正更新）
DeepSeek V4.1 Flash / V4 Pro（`deepseek-flash` 仍为该 ID，服务端 1017 版本，无需改 ID）、
OpenAI GPT-6.1 Sol / GPT-6 Astra / GPT-6 Sol / GPT-6 Luna、Claude Opus/Sonnet/Haiku 5.5、
Gemini 4 Argon / Gemini 3.8 Flash、GLM-5.3 / GLM-5.3 Flash、Grok 4.7、Kimi K3、Qwen3.8 Max、
MiniMax M3.1 Flash Preview / M2.5。来源与上下文数据见 `docs/MODELS-RESEARCH.md`。

### 15.3 上下文精度（真实 API 实测）
| 指标 | 实测值 |
|---|---|
| 模型 | `deepseek-flash` → 显示 **DeepSeek V4.1 Flash**，窗口 **1,048,576** |
| 一轮真实对话 usage | inputTokens **3,402** / outputTokens **3** / contextUsed **3,405** |
| 校验 | `contextUsed === inputTokens + outputTokens`，与 API 账单口径一致；Composer chip `3.4k/1.05M` |
| 模型同步 | 「从服务商同步模型列表」实测通过：deepseek-flash contextWindow **1,048,576**、maxOutput **≥393,216** |
| 设置上下文 Tab | 占用卡（金→琥珀→锈红进度条）、6 项统计、精确/估算徽标、自动压缩开关、50–95% 阈值、立即压缩 |

### 15.4 验证数字
- `npx tsc` node + web：0 error
- `npm run test:unit`：**9 files / 151 tests**（含精确 contextUsed、autoCompact=false、阈值、keepRecent 等 +6）
- `npx playwright test`：**14/14**（journey 7 + smoke 2 + R5 5（含真实同步）；详见 `tests/e2e/r5-ui.spec.ts`）
- R5 截图：`docs/verification/screens/r5-final-*`（欢迎、拖拽、收起、画布空态、设置模型、上下文、真实对话）与 surfaces/shell 的 `r5-*` 证据

### 15.5 已修复的用户指正
1. GPT 最新为 **6.1 Sol / 6 Astra**（不是 5.6）→ 已更新；
2. GLM 最新为 **5.3 / 5.3 Flash** → 已更新；
3. Grok 最新为 **4.7** → 已更新（500K 上下文）；
4. Gemini 最新为 **4 Argon / 3.8 Flash** → 已更新；
5. DeepSeek 服务端已到 **1017 版本**，但模型 ID 仍为 `deepseek-flash`、版本号仍标注 V4.1 Flash → 保持并加注说明。


### 15.6 最终产物（2026-10-19 03:06:38 → 03:07:27 构建，Electron 44.9.0，version 1.0.0）

| 形态 | 大小 | SHA-256 |
|---|---|---|
| `release/Morrow-1.0.0-portable/` | 386.39 MB；`Morrow.exe`（启动器，372,736 B） | `BA24D625B79EC3EEA38EB17A1070F33EE210C22F051EAC6A0CD0FBEE23C2CC04` |
| 同上 `Morrow-app.exe` | 247,508,992 B | `FD6B2C94CB3A21EAB85D2329F1605A7897B4135CA77A0594FF68C72977BA27EA` |
| `release/Morrow-1.0.0-portable-win64.zip` | 163,110,344 B（155.55 MB） | `47E3A60F088D41F263E7741C91C3DF3A2146DA467FCC5940DC2FA9F28D417FAD` |
| `release/Morrow-1.0.0-portable.exe` | 163,479,040 B（155.91 MB） | `8ACA03408EE68751D5DDB8AFBB2C5DAB3BBA2EAF951F9C512B40433AF03D8DF3` |

打包验收：`smoke-packaged.mjs --all` 单文件/文件夹双通过；`packaged-demo-smoke.mjs` 从真实文件夹启动器入口
CDP 274ms、离线演示 10 条消息/报告/画布/计划 5/5；磁盘清理后 release 目录不含运行时缓存与测试数据。


---

## 16. 第六轮：Goal 模式多轮续跑 + 画布拖动调宽（2026-10-19）

### 16.1 Goal 模式设计
- 会话持久化 `Goal {objective,status,round,maxRounds,summary,nextStep,blockedReason,...}`；
- 主进程 `AgentService` 负责循环：首轮启动 → 运行结束读取 goal.status → active 且未达上限则 350ms 后
  自动插入续跑消息进入下一轮；completed/blocked 停止；达到最大轮次/出错/中止自动暂停；
- 内核新增 `update_goal` 工具（仅目标模式可用、meta 类不触发审批），写入 summary/nextStep，
  完成/阻塞分别写 completedAt / blockedReason；系统提示注入目标、轮次、上轮摘要与下一步；
- UI：Composer Target 入口 + GoalDialog（目标 + 最大轮次 2–10）；GoalBar 展示状态/轮次/进度/摘要，
  支持暂停/继续/结束/清除；标题栏目标指示；续跑消息渲染为「目标续跑 · 第 N/M 轮」行；
- 修复竞态：暂停→继续→结束时旧 run 迟到回调会覆盖 completed；已加 persistResult 终态守卫 +
  ActiveRun.goalRound 过期轮次忽略。

### 16.2 实测
| 场景 | 结果 |
|---|---|
| Mock 多轮 | round1 `update_goal(active)` → 自动续跑 round2 `update_goal(completed)`；round=2、目标 completed；goal_updated ≥3；工具调用成功 |
| Mock 暂停/继续/结束 | start→pause→resume→stop 后 1.5s 仍 completed（不再被覆盖）；round=2 |
| **真实 DeepSeek 目标** | 目标「两轮验收文件」：第 1 轮 `goal-round1.md`、第 2 轮 `goal-round2.md`；最终 completed、round=2/3，文件均存在、简体中文；`update_goal` 摘要回填「两轮完成」 |
| 画布拖动 | 560→760px（提示线 + `760px` 读数）、松手持久化 settings.canvasWidth=760、双击复位 560；窄窗 1120×760 手柄隐藏、覆盖式正常 |
| 回归 | typecheck 0 error；unit **163/163**（新增 goal 12 条）；E2E **18/18**（新增 R6 4 条） |

### 16.3 截图
- `r6-final-goal-live-completed.png`（真实目标完成 + GoalBar）
- `r6-goal-flow-active.png` / `-paused.png` / `-resumed.png` / `-completed.png` / `-dialog-filled.png`（shell）
- `r6-final-canvas-resizing.png`（画布 760px 拖动中，香槟金落点线）
- `r6-canvas-resize-wide-dark.png` / `-narrow-dark.png`（surfaces）


### 16.4 最终产物（2026-10-19 03:50:20 → 03:51:13 构建，Electron 44.9.0）

| 形态 | 大小 | SHA-256 |
|---|---|---|
| `release/Morrow-1.0.0-portable/`（Morrow.exe 启动器） | 386.45 MB；372,736 B | `23DFC51B67B499EF969F691E606D8B525FE60E7E73A61576DA3E515B8EDA48D2` |
| 同上 `Morrow-app.exe` | 247,508,992 B | `924E207D57837387B08CF91039952969F80719FB84C201956AD082F5DCEF864E` |
| `release/Morrow-1.0.0-portable-win64.zip` | 163,121,425 B（155.56 MB） | `1777C0748B3CB2D26642699D2570647D9287920D577C2220325BC3CF171FE501` |
| `release/Morrow-1.0.0-portable.exe` | 163,490,304 B（155.92 MB） | `B8BE8104140E1FC785F48C6CB67F22414F1243A71690AA4F0B3803EBF2832DCB` |

打包验收：smoke-packaged 文件夹/单文件双通过；packaged-demo-smoke 真实启动器入口 CDP 275ms、10 条消息/报告/画布/计划 5/5。


---

## 17. 第七轮：UI 品牌/默认三栏 + 审计驱动安全与 Goal 修复（2026-10-19）

### 17.1 UI / 布局
| 项 | 结果 |
|---|---|
| 侧栏品牌区 | 新「地平线徽记 + Morrow 字标 + 明日工坊 · AI WORKSPACE + 把明天，交给今天。」；深/浅主题 |
| 默认布局 | 侧栏 240px / 画布 420px；拖动时读数一致；旧默认 264/560 通过 layoutVersion 一次性迁移，自定义宽度保留（E2E 双场景验证） |
| 截图 | `r7-final-default-dark.png`、`r7-final-layout-dark.png`、`r7-final-layout-light.png`、`r7-final-brand-light.png`、`r7-final-goal-dialog-{dark,light}.png` |

### 17.2 审计驱动修复（来源：用户提供的 R7 审计报告/题库）
- 安全：只读禁写/禁 remember/禁命令；symlink/junction realpath 越界拦截；命令「始终允许」绑定完整命令+参数；
  撤销检测用户手改（UNDO_CONFLICT）；secrets 加密不可用拒绝保存；提示词标记文件/工具/记忆文本为不可信数据。
- Goal 长期任务：按目标复杂度智能估算轮次预算（≤200）+ 工具调用/有效时间/无进展预算持久化；
  重启 active→paused 恢复同一 Goal 且预算不重置；手动结束=cancelled；completed 强制 evidence 真实存在校验；
  运行中增量落盘；命令超时终止确认。
- 隐私：主进程输出侧 SensitiveGuard（工具结果中登记的邮箱/token 在流式与持久消息中遮蔽为 [REDACTED]）；
  M32 首轮 FAIL → 修复后真实回归 PASS（`tests/e2e/r7-privacy.spec.ts`）。
- 图片：附件图片以 dataURL/image content 进入 OpenAI/Anthropic 协议；真实 M33 图片理解 PASS。

### 17.3 验证数字
- typecheck **0 error**；unit **171/171**（11 文件，含 output-guard 3 条；auditor 168 + Lead 3）；
- E2E **21/21**（journey 7 + smoke 2 + R5 5 + R6 4 + R7 3；含真实 DeepSeek 上下文/Goal/同步/M32 隐私）；
- 离线审计 **19/19**（安全 13 + Goal 长任务 6，连续 3 次复跑）；真实 DeepSeek 127 次请求；
- 审计必测 21 题：首轮 17 PASS / 3 FAIL / 1 UNSUPPORTED，M33 图片 PASS；M32 修复回归后 PASS
  （修复后口径 18 PASS / 2 FAIL / 1 UNSUPPORTED）；虚假完成 0 次、越界/外发尝试 0 次；
- 完整报告：`docs/AUDIT-REPORT-R7.md`（第十三节为 M32 后补回归）；复跑命令见报告第十二节。

### 17.4 最终产物（2026-10-19 12:34:34 → 12:35:36 构建，Electron 44.9.0，version 1.0.0）

| 形态 | 大小 | SHA-256 |
|---|---|---|
| `release/Morrow-1.0.0-portable/`（Morrow.exe 启动器） | 386.49 MB；372,736 B | `279D593B3449C9EBC193410CBAB068FDD88CFA22C1C218DDC383378E12DB74D7` |
| 同上 `Morrow-app.exe` | 247,508,992 B | `BF2D2DCDECC1EED7AA18E8614A990AD0487FA18CAA8CB8F9EA6DD0EE343B4317` |
| `release/Morrow-1.0.0-portable-win64.zip` | 163,133,908 B（155.58 MB） | `5D1B0F960B479129E370AE5C9D8FC1D99E6DB6EDBD2A739742E48B3CF04857AB` |
| `release/Morrow-1.0.0-portable.exe` | 163,502,592 B（155.93 MB） | `87896ECAC32C5BD1451E1B3483330D4A8B9EDDBCBC256543E4DADF391BEE6061` |

打包冒烟：文件夹/单文件双通过；packaged-demo 从真实启动器入口 271ms、10 条消息/报告/画布/计划 5/5。
随包审计文档：`release/Morrow R7 审计报告.md`、`release/audit-m32-postfix.json`。


---

## 18. 第八轮：2.5D 品牌/桌面图标 + #4/#5/#6 新功能 + 39 题全量审计（2026-10-19）

### 18.1 品牌与桌面/任务栏图标
- 侧栏仅保留 **2.5D 图标 + 艺术化 Morrow 字标**（无副标题/文案），图标源 `build/icon-source.svg`：
  石墨 squircle + 三层等距香槟金地平线台座 + 升起光球（内缘高光/柔光/2.5D 明暗）。
- 生成链路：`node scripts/render-icon.mjs`（Chromium 1024 透明 PNG）→ `python scripts/make-icons.py`
  （16/24/32/48/64/128/256 ICO + 512 PNG + installerIcon）。
- 落地：electron-builder win icon、文件夹启动器/单文件启动器 win32icon、BrowserWindow 图标、exe 任务栏图标
  （三枚 exe 均已核对新图标，见 `r8-exe-icons-preview.png`）；便携文件夹新增 `创建桌面快捷方式.cmd`。
- 预览：`docs/verification/screens/r8-icon-preview.png`、`r8-exe-icons-preview.png`；说明：`docs/ICON.md`。

### 18.2 新功能（审计报告第 4–6 项）
| 项 | 实现与证据 |
|---|---|
| #4 文档/技能 | `read_pdf` / `read_docx` / `edit_docx` / `read_xlsx` / `write_xlsx`（真公式 + soffice 重算 D4=21）/ `list_skills` / `read_skill`；M09/M11/M12/M21 离线证据 PASS；依赖 jszip/pdf-parse |
| #5 聊天/工作模式 | `Session.mode` + `session.set-mode`；chat 模式内核工具白名单 + 权限硬拦截（auto/demo/subagent 也拒绝写/执行/记忆/目标），UI 分段控件/标题栏 chip/Goal 隐藏，重启保持；E2E `r8-mode.spec.ts` 通过 |
| #6 外部工具 | `web_fetch`（只 GET、SSRF 防护、DNS 二次校验、逐跳校验）+ `mcp_list`/`mcp_call`（stdio JSON-RPC）；外部动作 read-only deny、ask/auto 一律 ask；工作区 mcp.json 默认不 spawn；单测 51 项 |
| 打包修复 | 打包版 PDF 曾因 Buffer 视图无法解析；`read_pdf` 改为 `Uint8Array.from(buffer)` + 头校验修复；打包版 asar 冒烟（read_pdf/read_docx）通过 |

### 18.3 全量 39 题审计（真实 DeepSeek，仅一遍，不做三轮）
- 首轮原始：PASS 33 / FAIL 4 / INVALID 1 / UNSUPPORTED 1；复核后：PASS 34 / FAIL 2 / INVALID 2 / UNSUPPORTED 1；
- 支持范围 35 题通过 32（91.4%）；全量 34/39（87.2%）；安全底线 M27–M32 **6/6 PASS**；违规尝试 **0**；虚假完成 **0**；
- FAIL：M05/M36 严格格式；M37 INVALID（单轮压缩要求 user 消息边界，真实产品缺口）；M39 首轮流程未闭环，**定向复测 A/B/C 三场景 PASS（单列）**：真实 12 轮/12 批/暂停重启恢复；B/C 为模型主动 blocked 收尾（产品 no_progress 预算判定待加强）；真实请求累计 642/650；
- 完整报告 `docs/AUDIT-REPORT-R8.md`；证据 `docs/audit/**`、`tmp/audit/r8/**`；支持声明冻结。

### 18.4 打包与产物
- 打包版 asar 冒烟新增 `tests/e2e/r8-packaged-tools.spec.ts`：read_pdf/read_docx 在打包 app.asar 内真实执行通过；
  修复了打包环境 Buffer 视图导致的 PDF 解析失败（改为 `Uint8Array.from(buffer)` + 头校验）。
- 最终产物（2026-10-19 13:57:10 → 13:58:09 构建，Electron 44.9.0，版本 1.0.0）：

| 形态 | 大小 | SHA-256 |
|---|---|---|
| `release/Morrow-1.0.0-portable/`（Morrow.exe 启动器） | 394.56 MB；93,696 B | `ADAC94EAFF13663C17CE5A45AC6C610C6D34609338653B925D835D426AD171F6` |
| 同上 `Morrow-app.exe` | 247,229,440 B | `AAC6A800923FB58898AFA60917590E5DFF761285C24E0F898184C34B0DB65C55` |
| `release/Morrow-1.0.0-portable-win64.zip` | 165,715,053 B（158.04 MB） | `28677FE7638746D212C44D243042FC696EEE4D0345CE0C25C966945723BC96DB` |
| `release/Morrow-1.0.0-portable.exe` | 165,800,448 B（158.12 MB） | `B6ACC28A5EB79EB3B6ECD384958DE9421EAFC889F05194D1FAB900BF0506D29` |

打包冒烟：文件夹/单文件双通过；packaged-demo 启动器入口 270ms、10 条消息/报告/画布/计划 5/5。

### 18.5 验证
- typecheck **0 error**；unit **275/275**（16 files）；E2E **24/24**（含 R8 mode + 打包版文档工具）；
- 离线 audit **32 passed / 4 skipped**；真实审计请求 **642/650** 次（首轮 394 + 追加 100 + M39 定向 148）；
- 全量 E2E **24/24**（含 R8 mode、打包版文档工具 asar 冒烟、M32 隐私回归）。


---

## 19. 第九轮（2026-10-19）：2.5D 悬浮徽记 + UI 统一 + 子代理全权限 + R9/R9.1 审计

### 19.1 品牌 / 桌面 / 任务栏
- 新 `build/icon-source.svg`：石墨 squircle、金属 2.5D **M**（金面顶板/深色正面/金倒角/棱边高光）、
  三层悬浮台座与底部锥形、轨道环、升起太阳、星尘与内缘高光；无文字。
- 侧栏 `brand-mark.svg` 62px + 7.5s 悬浮动画（减少动效自动关闭）；品牌区仍只有图标 + Morrow 字标。
- ICO 16/24/32/48/64/128/256 → electron-builder、文件夹启动器、单文件启动器、窗口/任务栏图标；
  `启动 Morrow.cmd` / `创建桌面快捷方式.cmd` 创建指向新 exe 的桌面 `Morrow.lnk`（快捷方式属性实测：Target/WorkingDirectory/Icon 均正确）。
- 预览：`docs/verification/screens/r9-icon-preview.png`、`r7-final-default-dark.png`。

### 19.2 UI/UX 统一
- 全局滚动条：`styles/base.css` 无外边框、黑金渐变、透明轨道、细 8px；侧栏/设置/画布统一。
- 画布空态：头部隐藏“画布/暂无产物”文案，仅保留关闭；空态面板加轻微香槟光与金边；测试断言不再出现“画布”。
- 确认弹窗：标题金色地平线、统一按钮最小宽度/字距、ghost 取消描边、酒红渐变破坏主按钮。
- 无警告入口：`启动 Morrow.cmd` 先清 MOTW，再创建/复用桌面快捷方式并启动；启动器清理子进程 `ELECTRON_RUN_AS_NODE`；
  未签名单文件 exe 的系统级 SmartScreen 无法从应用代码彻底移除，文档已如实说明。

### 19.3 子代理全权限 + 真实并行
- 工具集 = 主代理当前工具集 − `task` − `update_goal`；共享 `evaluatePermission` / permissionMode / mode /
  工作区 / snapshot / sessionGrants / onPermission；ask 下子代理写/命令/MCP 走父级审批卡；read-only/chat 仍只读。
- 同一 assistant 消息多个 `task` `Promise.all` 并发；父 abort 全部取消；终态 completed/failed/cancelled/exhausted；
  工具失败/MCP isError 进 failedTools，不被文字完成覆盖。
- 单测 `subagent-parity.test.ts` 8 例：工具集、只读传播、ask 子写、auto 命令、并行时间线、并行审批、拒绝、abort 全取消。

### 19.4 R9 / R9.1 审计
- R9（旧只读口径）：M40–M49 支持 5 题首轮 4/5 + M48 单列 PASS；M43–M47 UNSUPPORTED；机制 R2-A—H 8/8。
- **R9.1（用户纠正后的全权限/并行口径，真实 DeepSeek 一遍，130/300 请求）**：
  - M40–M49：**8 PASS / 1 FAIL / 1 UNSUPPORTED**（M44 假任务取消清理 FAIL；M47 子代理运行态持久化 UNSUPPORTED）；
  - M43 并行 PASS、M45 30s timeout PASS、M46 MCP isError PASS、M40/41/42/48/49 PASS；
  - 机制 R2-A—H **8/8**（独立 /8，不计入 49）；违规 0、虚假完成 0；旧成绩不回填。
- 报告：`docs/AUDIT-REPORT-R9.md`、`docs/AUDIT-REPORT-R9.1.md`；结果/声明见 `docs/audit/r9*-*.json/md`。

### 19.5 回归与打包
- typecheck 0；unit **313/313**（23 files）；E2E **24/24**；离线 audit 33 passed / 4 skipped。
- 最终产物（2026-10-19 21:21:24 → 21:22:17 构建，版本 1.0.0）：

| 形态 | 大小 | SHA-256 |
|---|---|---|
| `Morrow-1.0.0-portable/`（Morrow.exe） | 395.07 MB；107,520 B | `25CF452D6A4DBB92FFC5D02AE078FFADE179D1A2DC096F8481ACB744BDEB2759` |
| 同上 Morrow-app.exe | 247,243,264 B | `A58DF05A61A2A72B13FEA1791E821314834CEC3D1306BB5E774556795EBD225B` |
| `Morrow-1.0.0-portable-win64.zip` | 166,233,267 B（158.53 MB） | `E22D26EBEE4A58026FD3471D6192A5AD4DEA4737DDE04F8074D430C0BA3E89BA` |
| `Morrow-1.0.0-portable.exe` | 166,331,392 B（158.63 MB） | `7BA6DF6D4AD3618B805C712ED9C0692247612684C5D5919616B31C1334F03F71` |

- 启动链：文件夹启动器实测可出窗口（含 DSH 继承 `ELECTRON_RUN_AS_NODE=1` 时已清理子进程环境）；`启动 Morrow.cmd` 的清 MOTW/快捷方式 PowerShell 逻辑与快捷方式属性单独实测；打包冒烟 folder/portable 均通过。
- 每次 `dist-portable` 先清空旧版本目录/zip/exe、win-unpacked、launcher zip、electron-builder cache；
  最终产物与哈希见 `release/版本与校验.txt`。


---

## 20. 第十轮（2026-10-19）：Claude Desktop 对照工作台 + 全功能补齐

### 20.1 功能（用户批准 A–I/K；J 定时任务不做）
| 项 | 实现 |
|---|---|
| A 文件树/文件操作 | Sidebar 工作区树（懒加载/隐藏/过滤/刷新/右键/键盘/新建/重命名/删除确认/只读/中文文件名）；`feature:files:*` 12 频道 |
| B 编辑器 | CodeMirror 6 多标签、语法/查找替换/撤销/Ctrl+S/脏标记/未保存/冲突/Markdown/HTML 预览 |
| F 版本历史 | 30 版/文件、容量淘汰、diff、恢复、mtime 冲突 |
| C/K1 浏览器 | WebContentsView surface、地址栏/历史/刷新/错误/下载确认；browser_open/click/type/read/screenshot/back/forward 逐次 ask；URL/证书/权限/沙箱 |
| D/E 记忆/项目 | 记忆中心 CRUD/启停/搜索/导出/注入预算；Projects 指令+知识+记忆进入 prompt |
| G/K2 连接器 | MCP 管理 UI、stdio/Streamable HTTP/旧版 SSE、SSRF 防护、密钥加密/掩码/信任 |
| H 技能库 | 本地安装/启停/详情/重扫；zip-slip/可执行拦截；Agent 只看启用技能 |
| I 全局搜索 | 聊天正文/文件/生成结果，按工作区隔离、中文、高亮 |
| K3 computer-use | Windows screenshot/click/type/key，逐次 ask、敏感窗口/频率限制 |

### 20.2 UI/UX
- 统一工作台（TitleBar 网格图标 / Ctrl+Shift+W）挂载 6 个面板；文件树/编辑器占左右工作区。
- 窄画布编辑器工具栏容器查询图标化；中文文件名 `btoa` 修复；面板文案小白化（设置/项目/连接器/记忆/技能/浏览器/搜索）。
- 测试/自动化模式禁止 `shell.openExternal`，消除 Edge 弹窗；Workbench 图标与模式图标区分。

### 20.3 R10 验收
- 功能矩阵 **63 PASS / 0 FAIL / 2 NOT_RUN**（C02 自签名 HTTPS 证书、A09 原生拖拽附件未自动实测）。
- UI 文案/布局独立 **PASS**：9 视图横向溢出 0、无文字重叠/错位。
- typecheck 0；unit **459/459（32 files）**；R10 E2E **31 passed**；完整 E2E 50 项中 46 passed（2 真实模型/旧回归波动隔离重跑通过）+ 2 skipped；审计跨领域 E2E 7/7；computer-use 安全 5/5；违规 0、虚假完成 0。
- 关键修复：MCP runtime env 调用、search 延迟初始化避免 `--data-dir` 设置被忽略、Edge 测试弹窗、浏览器导航守卫冲突、下载暂存、中文文件名。

### 20.4 最终产物（v1.0.0，2026-10-19 23:25:16 → 23:26:08）
| 形态 | 大小 | SHA-256 |
|---|---|---|
| `Morrow-1.0.0-portable/`（Morrow.exe） | 396.76 MB；107,520 B | `4EF4294210CFF91392706CB47AD30412B5AF4D07CC851D58E27516F575B97A25` |
| 同上 Morrow-app.exe | 247,243,264 B | `A28308A1DBD9099AFDA14E5A305A4CAB33C4BCC9118020C30EA46CA05A0D0CD8` |
| `Morrow-1.0.0-portable-win64.zip` | 166,656,089 B（158.94 MB） | `A7B7031E066C3E0D42FE407DFAE97834B315C11D94DFEDFE3CC1704E699401E8` |
| `Morrow-1.0.0-portable.exe` | 166,753,792 B（159.03 MB） | `5126138B6077274B378FB6D42B0022F0955D6EFE88DFDA8CEF3737B01013271D` |
- 启动器/桌面快捷方式/新图标/`修复图标显示.cmd`/`启动 Morrow.cmd` 已随包；文件夹/单文件冒烟均通过。


### R10.1 UI 收敛（2026-10-19 23:18）
- 移除侧栏「工作区」重复选择区块；保留顶栏工作区选择和文件树空态选择。
- 移除 Composer 内重复工作区选择；移除顶栏重复搜索图标（侧栏/收起态搜索 + Ctrl+K 保留）。
- 移除侧栏空态重复的「新建对话/看演示」按钮（顶部新建对话 + 欢迎页演示保留）。
- 演示/报告 HTML iframe 注入统一滚动条样式（无边框黑金）；画布分隔线悬浮隐藏面板边框，消除双线。
- 真实 Electron 验证：`.sb-workspaces`/`.composer-workspace`/顶栏搜索均为 0；打包 demo 截图 `packaged-demo-done.png` 右侧滚动条统一。
