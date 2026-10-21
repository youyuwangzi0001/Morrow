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
  'git'
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
