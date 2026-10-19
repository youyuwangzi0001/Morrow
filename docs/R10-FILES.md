# R10-A 文件树与文件操作

> 版本：R10（2026-10-19）· 负责人：shell · 作用域：`src/main/services/workspace-files.ts`、`src/main/features/files.ts`、`src/renderer/src/features/files/**`、`features/shell/Sidebar.tsx/.css`、`tests/unit/main/files.test.ts`、`tests/e2e/r10-files.spec.ts`
>
> 集成方式：`src/main/features/index.ts` 顶层 `import './files'`（模块 import 即注册频道，Lead 维护该文件）。

## 1. 概述

左侧栏「工作区」区块下新增**真实文件树**，并对工作区文件提供安全的读写与增删改操作：

- 懒加载目录、隐藏文件开关、过滤、手动/焦点刷新、当前打开文件高亮；
- 右键菜单 + 键盘可达：新建文件/文件夹、重命名、删除（二次确认）、复制路径、在资源管理器中显示、刷新；
- 只读模式（`session.permissionMode ?? settings.permissionMode === 'read-only'`）下所有写操作在 UI 禁用，主进程按全局只读再兜底拒绝；
- 点击文件派发 `morrow:open-file` 事件（`detail.path` 工作区相对路径 + `detail.absolutePath`），交给 Canvas 编辑器（surfaces 的 R10-B）；
- 文件可**原生拖拽**进 Composer 作为附件：`feature:files:startDrag` → `event.sender.startDrag`，Composer 现有 `dataTransfer.files` 路径直接接收，无需改动 Composer。

## 2. API 契约（`window.morrow.features.invoke`）

所有频道以 `feature:files:` 开头；`payload` 均支持可选 `workspace`（工作区绝对路径）。编辑器只传 `{path}` 时主进程按以下顺序安全回退：已绑定会话工作区中「真实存在该路径」的那个 → `settings.lastWorkspace` → 唯一存在的工作区；无法确定则返回可读错误（建议明显场景下显式传 `workspace`）。

| 频道 | payload | 成功返回 |
|---|---|---|
| `feature:files:list` | `{ dir?, showHidden?, workspace? }` | `{ workspace, dir, entries: FileEntry[], limited, readOnly }` |
| `feature:files:read` | `{ path, workspace?, maxBytes? }` | `{ path, absolutePath, content, size, mtimeMs, encoding:'utf8', workspace, readOnly }` |
| `feature:files:stat` | `{ path, workspace? }` | `{ path, absolutePath, kind, size, mtimeMs, workspace, readOnly }` |
| `feature:files:write` | `{ path, content, expectedMtimeMs?, workspace? }` | `{ path, absolutePath, size, mtimeMs, created, snapshot?, workspace }` |
| `feature:files:create` | `{ path, kind:'file'\|'dir', workspace? }` | `FileEntry`（已存在/父目录缺失会报错） |
| `feature:files:rename` | `{ from, to, workspace? }` | `{ from, to, kind }`（目标已存在不覆盖） |
| `feature:files:move` | `{ from, toDir, workspace? }` | `{ from, to, kind }` |
| `feature:files:delete` | `{ path, recursive?, confirm:true, workspace? }` | `{ deleted:true, path, kind }` |
| `feature:files:inspect` | `{ path, workspace? }` | `FileEntry & { childCount? }`（删除确认展示内容数量） |
| `feature:files:reveal` | `{ path, workspace? }` | `{ ok:true }` |
| `feature:files:attachPath` | `{ path, workspace? }` | `Attachment`（文本带内容、图片标记 kind、其它元信息） |
| `feature:files:startDrag` | `{ path, workspace? }` | `{ ok:true }`（仅普通文件；原生拖拽） |

`FileEntry = { name, path(相对 posix), kind:'file'|'dir'|'symlink', size, mtimeMs, isSymlink, restricted? }`。

错误：主进程 handler throw 后由 `feature-ipc` 统一包装为 `{ok:false,error:{code:'FEATURE_ERROR',message}}`，message 为中文可读原因（如「这个路径在工作区之外，已被拦下。」「这是一个二进制文件…」「文件在编辑器打开后被外部修改了，已停止保存。请重新加载文件后再试。」「当前是只读模式，不能修改文件。」）。

## 3. 安全模型（最高标准）

1. **路径边界与 symlink 防逃逸**：复用 `@core/tools/paths` 的 `inspectWorkspacePath`——绝对化 + `realpath`（解析符号链接/junction）后必须落在工作区内；新建路径对最近存在祖先 realpath 再拼尾巴；Windows 大小写不敏感；删除/重命名用 absolute 路径但「是否允许」以 realpath 判定。
2. **读取限制**：文本上限 2 MB；前 8KB 检测 NUL 字节与替换符比例判定二进制；目录/不存在给出可读错误。
3. **写入安全**：同目录临时文件 + `rename` 原子替换（避免半截文件）；写入前再次 realpath 校验目标；写前快照复制原文件到 `userData/snapshots/files/<日期>/`，并写 `.restore.json`（targetPath / beforeHash / afterHash / time / source）；`expectedMtimeMs` 与磁盘 `mtimeMs` 相差 >1ms 拒绝保存（外部修改冲突）；内容上限 8 MB。
4. **创建/重命名/移动**：拒绝已存在目标（绝不隐式覆盖）；父目录必须存在且在工作区内；禁止重命名/移动工作区根目录；禁止把目录移动到自身子目录。
5. **删除**：必须显式 `confirm:true`；工作区根目录不可删；非空目录必须 `recursive:true`（UI 在确认框展示子项数量）；symlink 删除按 realpath 边界判定（指向工作区外则拒绝，保守策略）。
6. **只读模式**：主进程 `assertWritable()` 对 write/create/rename/move/delete 统一拒绝（读全局 `settings.permissionMode`）；渲染层再按 session 级权限禁用所有入口。
7. **拖拽**：`startDrag` 只允许工作区内普通文件；图标使用应用图标/内联 16px 图标。

## 4. 文件树交互

- **位置**：Sidebar「工作区」区块下方，可折叠「文件」区块；`max-height: 34vh` 独立滚动，不挤占会话列表；无 workspace 显示引导 + 选择文件夹。
- **懒加载**：点击目录展开/收起；目录行右侧显示已加载子项数；文件行 hover 高亮。
- **隐藏文件**：Eye 开关（localStorage 记忆），默认隐藏 dotfiles。
- **过滤**：搜索图标展开输入框，对「已展开目录」做大小写不敏感过滤，匹配项显示所在目录 hint。
- **刷新**：刷新按钮 + 窗口重新获得焦点时静默刷新（1.5s 节流），外部改动不会让树长期过期。
- **当前文件高亮**：点击文件派发 `morrow:open-file` 并高亮；监听同一事件，编辑器切换文件也会联动。
- **右键菜单**（键盘 `Shift+F10`/ContextMenu 键打开）：目录 → 新建文件/文件夹、展开收起、复制路径、资源管理器显示、重命名、删除、刷新；文件 → 打开、复制路径、资源管理器显示、重命名、删除、刷新；只读时写操作 disabled。
- **删除确认**：Modal 显示名称/类型/（目录）子项数量，明确「永久删除，无法恢复；工作区外的其它文件不受影响」。
- **键盘**：`↑↓` 移动、`←` 收起/回父级、`→` 展开/进子级、`Enter` 打开、`F2` 重命名、`Delete` 删除、`Shift+F10`/ContextMenu 打开菜单、`Esc` 关闭菜单；树容器 `role=tree`、行 `role=treeitem` + `aria-level/aria-expanded/aria-selected`。
- **拖拽**：文件行 dragstart → 原生 `startDrag`，可拖到 Composer（生成附件）或资源管理器；目录不可拖。

## 5. 测试

### 单元测试（不依赖 Electron，纯 Node/Vitest）

```bash
npx vitest run tests/unit/main/files.test.ts
# → 1 passed / 16 tests passed
```

覆盖（16 例，全部通过）：
- list：目录在前/文件在后、隐藏文件开关、相对路径、越界拒绝、文件当目录拒绝；
- read：UTF-8 文本、二进制（NUL）、超大、目录/不存在错误；
- write：新建、覆盖生成写前快照（内容=旧版本）、mtime 冲突拒绝且不覆盖、mtime 匹配允许、越界/目录拒绝；
- create/rename/move：新建文件/文件夹、同名 EXISTS、父目录缺失、重命名不覆盖、越界拒绝、目录移入自身拒绝、移动到根目录；
- delete：未确认拒绝、非空目录需 recursive、删除文件/目录、根目录拒绝、子项数量 inspect；
- symlink/junction：工作区内指向工作区外的 junction 列表标记 `restricted`、读取/写入/删除全部拒绝、外部文件未被修改；绝对路径与 `../` 越界拒绝；
- attachment：文本带内容、图片按扩展名识别。

### E2E（真实 Electron + 真实 feature handlers）

```bash
npx electron-vite build
npx playwright test tests/e2e/r10-files.spec.ts
```

实测结果：**5/5 passed（4.7s）**。覆盖：文件树可见/隐藏文件开关/目录懒加载/过滤/点击文件派发事件与高亮；工具栏新建文件落盘；右键菜单重命名/删除二次确认落盘；目录内新建；只读模式下 UI disabled + 主进程写拒绝；越界/二进制/mtime 冲突错误文案；明暗主题截图。

跨功能联调：E2E 中点击 `hello.md` 后，surfaces 的 Canvas 编辑器真实打开并渲染 Markdown（tabs + 历史/预览/另存为），证明 `morrow:open-file` 契约与编辑器监听已打通。

证据截图（`docs/verification/screens/`）：
- `r10-files-tree-dark.png` / `r10-files-tree-light.png`（完整文件树，含展开目录与当前文件高亮）
- `r10-files-menu-dark.png`（右键菜单）
- `r10-files-confirm-dark.png`（删除二次确认）
- `r10-files-readonly-dark.png`（只读模式禁用提示）
- `r10-files-hidden-dark.png`（显示隐藏文件）
- E2E 自动截图：`r10-files-tree-dark/light.png`、`r10-files-context-menu-dark.png`、`r10-files-delete-confirm-dark.png`、`r10-files-readonly-dark.png`（后者为树区域裁剪，最终版以无后缀的干净截图为准）

## 6. 已知限制

1. **原生拖拽**无法在 Playwright 中可靠自动化（会进入 OS 拖拽循环），E2E 未覆盖 `startDrag`，已在代码中做普通文件校验与错误提示；人工验证路径为「树里拖文件到 Composer」。
2. **无文件监听器**：不做 chokidar 级实时监听，改为窗口聚焦时静默刷新 + 手动刷新；外部编辑器保存后可能短暂过期。
3. **工作区回退**：编辑器只传 `{path}` 且路径在工作区内不存在、又有多个会话工作区时无法判定归属，会返回「无法确定文件所属工作区」；建议渲染层显式传 `workspace`。
4. **不做保存对话框**：`saveAs` 不在 A 的范围（编辑器另存为建议在工作区内 `create` + `write`）；如需原生另存对话框可由编辑器侧再提需求。
5. **文件树只显示工作区**：工作区外的文件只能通过系统对话框选入（附件），不进树。
6. **符号链接保守策略**：指向工作区外的 symlink/junction 在树中标记 `restricted` 且不可展开/读/写/删；指向工作区内的链接可按普通文件打开（目录链接不展开）。
7. **大文件/二进制不可编辑**：读取上限 2 MB、二进制请求会被拒绝；图片/文档可由 Agent 工具处理，但不进编辑器。
