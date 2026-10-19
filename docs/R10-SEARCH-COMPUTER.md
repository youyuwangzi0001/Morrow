# R10-I 全局搜索 + K3 受控 computer-use（交付说明）

> 执行：engine · 2026-10-19 · task-28
> 约束：未改 central ipc/preload/feature-ipc/features-index/App/Settings/Sidebar/registry/agent-service；由 Lead 集成。
> 时间盒：120–150 分钟。

## 1. 交付文件

| 文件 | 说明 |
|---|---|
| `src/main/services/search-service.ts` | 全局搜索服务：会话/消息/文件/artifact 索引、增量刷新、ranking、片段高亮、工作区隔离、无网络、无 electron 依赖 |
| `src/main/features/search.ts` | `feature:search:*` 频道注册（query/status/refresh/session-updated/workspace-updated） |
| `src/renderer/src/features/search/SearchPanel.tsx` / `.css` / `index.ts` | 受控搜索面板组件 |
| `src/core/tools/computer-tools.ts` | Windows-only `computer_screenshot` / `computer_click` / `computer_type` / `computer_key` |
| `tests/unit/main/search.test.ts` | 搜索 7 例（中文/忽略/隔离/增量/自动刷新/状态） |
| `tests/unit/core/computer-tools.test.ts` | computer-use 9 例（权限/平台/参数/敏感窗口/截图/频率/失败） |
| `tests/e2e/r10-search.spec.ts` | 搜索 IPC 接线 E2E（搜索模块未注册时自动 skip，注册后真实执行） |
| `docs/R10-SEARCH-COMPUTER.md` | 本文件 |

## 2. Lead 集成清单

### 2.1 全局搜索（3 步）
1. `src/main/features/index.ts` 的 `registerFeatureModules()` 中加一行：
   ```ts
   import './search'
   ```
2. 渲染层挂载受控面板（命令面板/App 均可）：
   ```tsx
   import { SearchPanel } from '../features/search'
   // <SearchPanel open={searchOpen} onClose={() => setSearchOpen(false)} onNavigate={handleNavigate} workspace={currentWorkspace} />
   ```
   Props：
   ```ts
   interface SearchPanelProps {
     open: boolean
     onClose: () => void
     onNavigate: (hit: SearchHit) => void
     workspace?: string | null           // 可选；不传则由主进程用最近工作区（文件结果按工作区隔离）
     initialQuery?: string
   }
   ```
   `SearchHit`：`kind: 'session'|'file'|'artifact'`；会话带 `sessionId/messageId`，文件带 `absolutePath/path/line`，artifact 带 `artifactId/kind`。
3. 可选增强（非必需）：保存会话/工具完成时通知索引（查询前自动刷新已覆盖；有需要可调用）
   ```ts
   await window.morrow.features.invoke('feature:search:session-updated', { sessionId })
   await window.morrow.features.invoke('feature:search:workspace-updated', { workspace })
   ```

搜索 IPC：
- `feature:search:query` `{ q, workspace?, limit? }` → `{ query, groups:{sessions,files,artifacts}, total, tookMs, index }`
- `feature:search:status` → `{ ready, building, sessions, files, artifacts, workspaces, lastBuiltAt? }`
- `feature:search:refresh` `{ workspace?, sessionId?, full? }` → status
- `feature:search:session-updated` `{ sessionId }` / `feature:search:workspace-updated` `{ workspace }`

### 2.2 computer-use 工具
在 Lead 维护的 registry 中导入并注册（不要改本模块）：
```ts
import { computerTools } from './tools/computer-tools'
// toolDefinitions / 工具表：...computerTools
```
导出：
```ts
export const COMPUTER_TOOL_NAMES = ['computer_screenshot','computer_click','computer_type','computer_key'] as const
export const computerTools: ToolImpl[]
export const COMPUTER_TOOL_DEFINITIONS // 如需展示/权限预检
```
模块加载时会把四个工具名登记到 `permissions.ts` 的 `EXTERNAL_ACTION_TOOLS`（同一 Set，未改 central 文件）：
- read-only / chat：权限层直接 **deny**；
- ask / auto：每次动作都 **ask**（外部动作不缓存「始终允许」）；
- 工具执行层还会二次防御：演示模式 / read-only 直接拒绝。

## 3. 搜索实现要点

- **索引范围**：会话标题 + 消息正文（用户/助手/工具结果摘要）；artifact 标题 + 内容（HTML/SVG/Markdown 去标签）；工作区文件路径 + UTF-8 文本内容。
- **忽略**：`node_modules`、`.git`、`Morrow Data`、`out/release/dist/.cache`、符号链接、二进制（前 8KB NUL 检测）、>512KB 文件；每工作区最多 5000 文件、深度 8。
- **增量**：文件按 `mtimeMs+size` 复用缓存；删除的文件在下次重建中消失；会话按 `updatedAt/messageCount` 签名变化重索引。查询前自动刷新（节流 1.5s），保存/工具完成后无需显式通知。
- **隔离**：查询带 `workspace` 时，文件、会话、artifact 均限制在该工作区；不带 workspace 时只返回会话/artifact，不返回任何文件内容（避免跨工作区泄漏）；索引只覆盖用户最近/当前工作区与会话绑定的工作区。
- **ranking**：标题/文件名命中 > 路径/正文命中；会话带近期时间加成；结果分组并给出片段 + 高亮区间 + 行号。
- **耗时/limit**：每个查询计时 `tookMs`；`limit` 1–60（每组最多 ceil(limit/3)）；空查询立即返回空。
- **无网络**：全部本地 fs/内存，不发起任何 HTTP。

## 4. computer-use 安全边界

| 项 | 规则 |
|---|---|
| 平台 | 仅 `win32`；其它平台返回可读错误，不执行脚本 |
| 窗口 | 只操作**当前前台窗口**；动作前重新读取并校验 hwnd，若窗口已变化则取消 |
| 敏感窗口 | 标题/进程名匹配密码、登录、验证码、支付、银行、钱包、密钥、凭据、系统设置、注册表、UAC 等 → 拒绝 |
| 权限 | 每次动作 ask；read-only/chat deny；auto 也 ask；不复用 always |
| 参数 | 坐标非负整数 ≤10000；文本 ≤2000 字符且不含换行；按键白名单 + Ctrl/Shift 组合（禁止 ALT 组合、Ctrl+Esc、Ctrl+Delete 等系统组合） |
| 频率 | 单工具最小间隔（截图 1200ms / 点击 250ms / 输入 500ms / 按键 300ms）；全局 ≤30 次/分钟 |
| 动作 | PowerShell + Add-Type（user32/GDI/SendInput）；不杀进程、不改系统设置、不读取剪贴板 |
| 截图 | 仅当前前台窗口 → 工作区内 .png（默认 `computer/screenshot-<时间>.png`），注册 `kind=file` 画布 artifact，旧文件写前快照 |
| 失败 | 全部返回中文可读错误 + 下一步提示；超时 20s |

## 5. 测试与验证

```bash
npx vitest run tests/unit/main/search.test.ts tests/unit/core/computer-tools.test.ts
npm run typecheck
npm run test:unit
```

- 搜索 7 例：中文 title/message/file/artifact 命中与高亮；文件名优先 ranking；忽略目录/二进制/超大；工作区隔离；新增/修改/删除/会话增量 + limit；查询前自动刷新；状态/空查询。
- computer-use 9 例：apply auto/ask/read-only 权限决策与 always 不缓存；执行层 read-only/demo 防御；非 Windows 守卫；坐标/文本/按键校验；敏感窗口拒绝（不执行动作）；截图落盘 + artifact + 尺寸；频率限制；PowerShell 失败可读。
- E2E：`tests/e2e/r10-search.spec.ts` 已随 Lead 集成（search 注册 + Workbench 挂载 + registry 注册 computerTools）真实执行：
  `npx playwright test tests/e2e/r10-search.spec.ts` → **1 passed（1.2s）**（status/query 分组/索引状态断言全部通过）。
- 最终工作树数字：见交付消息（含其他队友并行改动，若出现非本模块 typecheck 错误会单独说明归属）。

## 6. 已知限制 / 残余风险

1. **搜索**
   - 索引是内存索引，应用重启后重建；超大工作区受 5000 文件/512KB/深度 8 限制，超出部分不索引。
   - 无 fs.watch：查询前自动刷新有 ≤1.5s 节流窗口；需要强实时可调用 refresh channel。
   - 二进制/超大文件只保留路径可达性，不索引内容；PDF/DOCX/XLSX 未做正文抽取（可按需扩展）。
   - HTML/Markdown 去标签是启发式，复杂脚本/编码可能影响片段可读性；artifact `content` 过长会截断到 20000 字符。
   - 文件索引仅覆盖已知工作区（最近/当前/会话绑定），不会扫描整个磁盘；这是隔离设计而非缺陷。
   - 无跨用户场景（桌面单用户）；会话/artifact 属于本地用户数据。
2. **computer-use**
   - 敏感窗口识别依赖标题/进程名启发式，无法保证 100% 识别所有敏感应用；**用户审批仍是最重要防线**。
   - 截的是真实前台窗口像素，窗口内若显示敏感信息（即使标题正常）也可能被截入；工具只做窗口级控制，不做图像内容脱敏。
   - PowerShell 子进程不在 OS 级沙箱内（与 run_command 同权限模型）；通过固定脚本 + 参数校验 + 前台窗口校验 + 频率限制降低风险。
   - 频率限制为进程内内存状态，重启后清零；多窗口/多会话共享同一限制。
   - 鼠标/键盘真实执行仅能在有交互桌面的 Windows 会话验证；单测用注入 runner 覆盖逻辑，未在 CI 中真实点击（避免误操作）。
3. **集成**
   - 搜索模块必须由 Lead 在 `features/index.ts` import；computerTools 必须由 Lead 注册进 registry，否则模型不可见。
   - `EXTERNAL_ACTION_TOOLS` 的登记采用同 Set 运行时添加；若 Lead 后续改为在 permissions.ts 字面量维护，可删除该运行时登记（保留一处即可）。
   - UI：SearchPanel 使用独立 CSS class（`search-*`）与设计 token；不依赖 App 布局，Lead 挂载时只需控制 `open` 与 `onNavigate`。
