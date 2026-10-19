# R10-B/F：画布代码编辑器与文件版本历史

> 归属：surfaces（task-23）。实现范围：`src/renderer/src/components/editor/**`、`src/renderer/src/features/artifacts/**`、`src/main/services/editor-history.ts`、`src/main/features/editor-history.ts`。
> 约束遵守：未修改 central `ipc.ts` / `preload` / `feature-ipc.ts` / `features/index.ts` / `App.tsx` / `Sidebar` / `Settings` / `agent-service`。

## 1. 功能总览

### B. 画布代码编辑器

- **真实编辑器**：CodeMirror 6（非 textarea），支持：
  - 语法高亮：JavaScript / TypeScript / JSON / HTML / CSS / Markdown / Python / XML（语言包按需动态加载）；
  - 行号、代码折叠、括号匹配、自动缩进、行内查找替换（Ctrl+F）、撤销重做、多光标/矩形选择；
  - **Ctrl+S 保存**、脏标记（标题金点 + 工具栏「未保存」）、自动保存无（显式保存）；
  - Markdown 预览切换、HTML 沙箱预览切换（编辑/预览二态）；
  - 只读产物仍可查看：内联 artifact 走原只读渲染；工作区外文件在编辑器中只读。
- **多标签**：Canvas tabs 现在同时承载「只读产物」与「可编辑文件」，文件 tab 带脏点、只读徽标、独立关闭按钮。
- **保存/另存**：`Ctrl+S` 或工具栏保存；「另存为」在对话框输入工作区相对路径（主进程 `feature:files:create` + `write`，不会覆盖已有文件）。
- **未保存关闭确认**：关闭文件 tab / 关闭画布时弹确认（保存并关闭 / 不保存 / 取消），关闭画布时对全部脏文件生效。
- **外部修改冲突**：窗口重新获得焦点、切回文件或保存时对比 mtime；冲突时显示黄色提示条（重新加载 / 覆盖保存），保存被主进程拒绝时不丢失编辑器内容。
- **只读模式**：会话权限为 `read-only` 时禁用保存并展示「只读」徽标；主进程同样会拒绝写入。
- **打开入口**：监听 `window` 事件 `morrow:open-file`（`detail.path` 工作区相对路径、可选 `absolutePath`），由文件树点击触发；Open 一个不在工作区的 artifact 时以只读方式打开。

### F. 文件版本历史

- 每次保存成功写入一个版本；首次打开文件时若历史为空自动记录一份「打开时基线」；检测到外部（Agent/其它程序）写入时自动记录「外部修改前 / 外部写入」两个版本。
- 历史抽屉（Canvas 右侧浮层）：
  - 版本列表：时间、来源（手动保存 / Agent 修改 / 打开基线 / 版本恢复）、大小；
  - 选中版本后与**当前编辑器内容**做 unified diff（DiffView，行号/上下文折叠）；
  - 恢复需二次确认：`feature:history:restore` 会写回文件、记录一个 `restore` 版本，然后刷新编辑器；若文件在恢复前又被外部修改会拒绝（mtime 冲突）。
- 存储：用户数据目录 `editor-history/<sha256(规范路径) 前 24 位>/`，`versions.json` 索引 + `<versionId>.txt` 内容。
  - **每文件最多 30 版**；全库容量上限 128 MB、单版本内容上限 2 MB（超出不记录）；
  - 内容完全相同的连续保存会去重（避免刷屏），恢复动作强制记录；
  - 路径哈希归一化：Windows 下大小写不敏感。
- 安全：`restore` 只允许恢复**曾经记录过历史**的路径（不能凭版本 id 任意写文件）；恢复前做目录/文件类型与 mtime 校验；写入走同目录临时文件 + rename 原子替换。

## 2. IPC 契约

### 文件读写（由 shell/A 实现，编辑器调用）

```ts
const res = await window.morrow.features.invoke('feature:files:read', {
  workspace,          // 会话工作区绝对路径（session.workspace ?? settings.lastWorkspace）
  path: relativePath, // 工作区相对路径（posix 分隔）
  maxBytes: 2 * 1024 * 1024
})
// data: { path, content, size, mtimeMs, binary, truncated, encoding, readOnly? }

await window.morrow.features.invoke('feature:files:write', {
  workspace, path, content,
  expectedMtimeMs: doc.mtimeMs // 冲突检测；不匹配时主进程拒绝保存
})
// data: { path, size, mtimeMs, snapshot?, created }
```

### 版本历史（本任务新增）

| 频道 | payload | 返回 |
| --- | --- | --- |
| `feature:history:record` | `{ path, content, source?, mtimeMs?, label?, force? }` | `HistoryVersion \| null` |
| `feature:history:list` | `{ path }` | `{ path, versions: HistoryVersion[] }` |
| `feature:history:read` | `{ path, versionId }` | `{ version, content }` |
| `feature:history:diff` | `{ path, versionId, targetContent? }` | `{ patch, added, removed, truncated, version, targetLabel }` |
| `feature:history:restore` | `{ path, versionId, expectedMtimeMs? }` | `{ path, versionId, mtimeMs, size, newVersionId }` |
| `feature:history:clear` | `{ path }` | `{ cleared: true }` |

`HistoryVersion = { id, path, name, createdAt, source, size, contentHash, mtimeMs?, label? }`，`source ∈ user | agent | baseline | restore`。

**集成方式**：Lead 在 `src/main/features/index.ts` 添加 `import './files'` 与 `import './editor-history'` 后即注册。`editor-history.ts` 通过 `registerFeatureHandler(...)` 顶层副作用注册，无需改 central 文件。

## 3. 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/renderer/src/components/editor/CodeEditor.tsx` | CodeMirror 6 封装：主题/语言/只读/换行 Compartment、快捷键、Ctrl+S、查找面板样式 |
| `src/renderer/src/components/editor/languages.ts` | 语言按需动态加载 + Morrow 黑金语法高亮（与 shiki 主题同源） |
| `src/renderer/src/components/editor/CodeEditor.css` | 编辑器容器与滚动条 |
| `src/renderer/src/features/artifacts/editor/editor-api.ts` | `feature:files:*` / `feature:history:*` 调用与容错（统一 Result → throw，中文错误）、路径工具、test-mode seam |
| `src/renderer/src/features/artifacts/editor/useEditorDocs.ts` | 编辑器状态机：多标签、脏标记、保存/另存、冲突检测、未保存确认、历史调用、`morrow:open-file` 监听 |
| `src/renderer/src/features/artifacts/editor/EditorPane.tsx` | 单文档 UI：工具栏（语言/状态/光标/保存/历史/预览/另存为）、冲突/截断提示、编辑器与预览 |
| `src/renderer/src/features/artifacts/editor/HistoryDrawer.tsx` | 版本列表 + DiffView + 恢复确认 |
| `src/renderer/src/features/artifacts/editor/editor.css` | 编辑器/历史抽屉样式（全部使用 tokens） |
| `src/renderer/src/features/artifacts/Canvas.tsx` | 多标签整合、文档 header、产物「在编辑器中打开」、关闭确认弹窗 |
| `src/main/services/editor-history.ts` | 纯 Node 版本历史存储（不 import electron，单测直接覆盖） |
| `src/main/features/editor-history.ts` | `feature:history:*` IPC handlers |

## 4. 测试

### 单测（真实主服务、临时目录）

```bash
npx vitest run tests/unit/main/editor-history.test.ts
# 9/9 passed
```

覆盖：记录/列表/读取、内容去重与 force、每文件 30 版淘汰、全库容量淘汰（每文件至少留 1 版）、diff（与上一版/传入内容）、restore 写盘 + mtime 冲突 + 未记录路径防任意写、超大内容拒收、跨实例持久化、Windows 路径大小写归一、clear。

### E2E（真实 Electron + 真实主进程 + 真实文件系统 + 真实 IPC）

```bash
npm run build && npx playwright test tests/e2e/r10-editor.spec.ts
# 实际结果（R10 集成后）：5/5 passed，约 9s；截图自动写入 docs/verification/screens/r10-editor-*.png
```

覆盖 5 条旅程（真实 IPC：feature:files:* 由 shell 的服务实现，feature:history:* 由本任务的版本历史服务实现）：
1. 打开文件 → 语法高亮 → 编辑脏标记 → Ctrl+S 写盘 → 关闭重开读回；
2. 外部改写文件 → 冲突提示 → 覆盖保存写回；
3. 未保存关闭确认（取消保留 / 不保存关闭不写盘）+ Markdown 预览；
4. 版本历史：保存产生版本 → 抽屉列表 → diff → 恢复旧版本后磁盘内容正确；
5. 内联只读产物仍可查看、不出现编辑入口。

截图证据：`docs/verification/screens/r10-editor-*.png`（打开/脏/已保存/明暗、Markdown/HTML 预览、历史抽屉/diff/恢复确认、冲突、未保存弹窗）。

### 说明：test-mode seam

`editor-api.ts` 中存在仅在 `window.morrow.isTest === true` 时生效的 `window.__morrowFeatureTestHooks` 测试缝，用于 A 的文件 handler 尚未注册进 features/index 时做 UI 截图；生产构建不触发，E2E 默认走真实 IPC。**集成完成后 E2E 不依赖该测试缝。**

## 5. 已知限制与残余风险

1. **标题栏画布开关绕过未保存确认**：`store.toggleCanvas()` 由 TitleBar 直接调用，组件无法拦截；使用标题栏按钮关闭画布时，未保存内容不会弹确认（画布内关闭按钮/文件 tab 关闭均有确认）。后续可在 store/TitleBar 增加统一 beforeClose 守卫。
2. **另存为仅限工作区内**：没有原生保存对话框（A 的边界约定），只在工作区内新建文件；已有同名文件会被拒绝。
3. **工作区外文件只读**：没有工作区相对路径就无法调用 files API，编辑器以只读方式展示并使用 `artifact:read` 内容。
4. **二进制/超大文件**：二进制不进入编辑器；读取被截断（truncated）时只读，避免覆盖损坏原文件。
5. **外部修改检测依赖窗口 focus**：后台被改写且窗口始终不切换焦点时，直到下一次保存/聚焦才会发现；保存时主进程 mtime 冲突仍可兜底。
6. **版本历史上限**：30 版/文件 + 128MB 全库，超出自动淘汰最旧版本；单版本 >2MB 不记录。
7. **CodeMirror 依赖体积**：语言包已动态 import，但编辑器本体使 renderer 主 chunk 增大约 ~0.5MB；仅打开文件时加载语言 chunk。
8. **E2E 依赖 Lead 注册 feature 模块**：在 `features/index.ts` 加入 `import './files'` / `import './editor-history'` 前，E2E 会因未注册频道失败（这也是真实集成验收的一部分）。
