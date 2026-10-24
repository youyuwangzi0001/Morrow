/** 内置斜杠命令名。自定义命令与它们重名时不会出现在菜单，避免静默覆盖内置行为。 */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'new',
  'temp',
  'demo',
  'plan',
  'settings',
  'btw',
  'swarm',
  'goal',
  'init',
  'clear',
  'rewind',
  'export',
  'export-json',
  'usage',
  'compact',
  'git',
  'research'
])

/** `/init` 模板：渲染层与主进程共用的提示词，避免两处文案漂移。 */
export const INIT_RULES_PROMPT = [
  '请先只读分析当前工作区，然后创建或更新项目规则文件 AGENTS.md。',
  '',
  '分析内容：目录结构、README/文档、package.json 或构建脚本、已有测试与代码约定。',
  'AGENTS.md 使用简体中文，包含：',
  '1. 项目概述（这是什么、给谁用）',
  '2. 目录结构与关键文件',
  '3. 常用命令（安装依赖、开发、构建、测试、lint）',
  '4. 代码风格与协作约定',
  '5. 注意事项（不要改哪些文件、环境要求）',
  '',
  '如果工作区已有规则文件（AGENTS.md / CLAUDE.md / MORROW.md，含 .morrow/ 下的），先读取并在现有文件上补充更新，不要新建重复文件、不要删除已有约定。',
  '只修改规则文件，不要改动其他文件；写文件会按当前权限模式请求我批准。完成后用几句话说明你写了什么。'
].join('\n')

/** 自定义斜杠命令模板展开：支持 $ARGUMENTS 与 $1..$9；没有占位符时把参数附在末尾。 */
export function expandCustomCommand(template: string, rawArgs: string): string {
  const args = rawArgs.trim()
  const positional = args ? args.split(/\s+/) : []
  const hasPlaceholder = /\$ARGUMENTS|\$[1-9](?!\d)/.test(template)
  const expanded = template.replace(/\$ARGUMENTS|\$([1-9])(?!\d)/g, (match, digit?: string) => {
    if (match === '$ARGUMENTS') return args
    return positional[Number(digit) - 1] ?? ''
  })
  if (!hasPlaceholder && args) return `${expanded.trimEnd()}\n\n${args}`.trim()
  return expanded.trim()
}

/**
 * Morrow 实际支持的键盘快捷键清单。
 * 设置 → 快捷键直接渲染这里；新增快捷键时同时更新真实处理器，避免 UI 展示不可用的键。
 */
export interface ShortcutEntry {
  id: string
  keys: string
  label: string
  hint?: string
  /** 仅在对应功能开启时可用 */
  requires?: 'islandEnabled'
  /** 发送键跟随设置动态显示 */
  dynamic?: 'sendKey'
}

export interface ShortcutGroup {
  id: string
  label: string
  description?: string
  entries: ShortcutEntry[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: 'global',
    label: '全局',
    description: '在 Morrow 窗口里生效；桌面伙伴快捷键在 Morrow 后台也有效。',
    entries: [
      { id: 'palette', keys: 'Ctrl+K', label: '打开命令面板' },
      { id: 'sidebar', keys: 'Ctrl+B', label: '收起或展开侧栏' },
      { id: 'new-session', keys: 'Ctrl+N', label: '新建对话' },
      { id: 'settings', keys: 'Ctrl+,', label: '打开设置' },
      { id: 'terminal', keys: 'Ctrl+`', label: '打开或收起终端' },
      {
        id: 'island',
        keys: 'Ctrl+Shift+M',
        label: '显示或隐藏桌面伙伴',
        hint: '需在设置中开启桌面伙伴',
        requires: 'islandEnabled'
      },
      { id: 'escape', keys: 'Esc', label: '停止生成或关闭弹窗' }
    ]
  },
  {
    id: 'chat',
    label: '对话输入',
    description: '在输入框中生效；发送键跟随「设置 → 回答」。',
    entries: [
      {
        id: 'send',
        keys: 'Enter',
        label: '发送消息',
        hint: '可在设置 → 回答切换为 Ctrl+Enter',
        dynamic: 'sendKey'
      },
      { id: 'newline', keys: 'Shift+Enter', label: '在消息中换行' },
      { id: 'command', keys: '/', label: '打开命令菜单' },
      { id: 'mention', keys: '@', label: '引用文件夹里的文件' }
    ]
  },
  {
    id: 'editor',
    label: '编辑器',
    description: '在画布或文件编辑器聚焦时生效。',
    entries: [
      { id: 'save', keys: 'Ctrl+S', label: '保存当前文件' },
      { id: 'find', keys: 'Ctrl+F', label: '查找' },
      { id: 'undo', keys: 'Ctrl+Z', label: '撤销' },
      { id: 'redo', keys: 'Ctrl+Y', label: '重做' }
    ]
  },
  {
    id: 'files',
    label: '文件树',
    description: '在文件树获得焦点时生效。',
    entries: [
      { id: 'open', keys: 'Enter', label: '打开文件或展开文件夹' },
      { id: 'rename', keys: 'F2', label: '重命名' },
      { id: 'delete', keys: 'Delete', label: '删除' },
      { id: 'navigate', keys: '方向键', label: '在文件之间移动' },
      { id: 'menu', keys: 'Shift+F10', label: '打开右键菜单' }
    ]
  },
  {
    id: 'browser',
    label: '内置浏览器',
    description: '内置浏览器面板显示时生效。',
    entries: [
      { id: 'new-tab', keys: 'Ctrl+T', label: '新建标签页' },
      { id: 'address', keys: 'Ctrl+L', label: '聚焦地址栏' },
      { id: 'close-tab', keys: 'Ctrl+W', label: '关闭当前标签页' },
      { id: 'next-tab', keys: 'Ctrl+Tab', label: '切换到下一个标签页' },
      { id: 'prev-tab', keys: 'Ctrl+Shift+Tab', label: '切换到上一个标签页' }
    ]
  }
]
