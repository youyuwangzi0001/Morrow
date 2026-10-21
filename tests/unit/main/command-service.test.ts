import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandCustomCommand } from '../../../src/shared/commands'
import { discoverCustomCommands, parseCommandFile } from '../../../src/main/services/command-service'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('自定义命令发现', () => {
  it('解析 frontmatter、参数提示与正文；无描述时取正文第一行', () => {
    const withMeta = parseCommandFile(
      `---\ndescription: "生成发布说明"\nargument-hint: 版本号\n---\n\n请为 $1 写发布说明。\n`,
      'release',
      'project',
      'C:/repo/.morrow/commands/release.md'
    )
    expect(withMeta).toMatchObject({
      name: 'release',
      description: '生成发布说明',
      argumentHint: '版本号',
      scope: 'project',
      body: '请为 $1 写发布说明。'
    })
    const withoutMeta = parseCommandFile('# 代码审查\n\n检查 $ARGUMENTS', 'review', 'user', 'x.md')
    expect(withoutMeta?.description).toBe('代码审查')
    expect(parseCommandFile('---\ndescription: 空\n---\n', 'empty', 'user', 'x.md')).toBeNull()
  })

  it('项目命令覆盖同名用户命令，非法文件名与非 Markdown 被忽略', () => {
    const home = tempDir('morrow-cmd-home-')
    const workspace = tempDir('morrow-cmd-ws-')
    mkdirSync(join(home, '.morrow', 'commands'), { recursive: true })
    mkdirSync(join(workspace, '.morrow', 'commands'), { recursive: true })
    writeFileSync(join(home, '.morrow', 'commands', 'deploy.md'), '用户级部署 $ARGUMENTS\n', 'utf8')
    writeFileSync(join(home, '.morrow', 'commands', 'notes.txt'), '忽略\n', 'utf8')
    writeFileSync(join(home, '.morrow', 'commands', 'bad name.md'), '忽略\n', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'commands', 'deploy.md'), '项目级部署 $ARGUMENTS\n', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'commands', 'review.md'), '审查 $1\n', 'utf8')

    const commands = discoverCustomCommands(workspace, home)
    expect(commands.map((command) => command.name)).toEqual(['deploy', 'review'])
    expect(commands.find((command) => command.name === 'deploy')?.scope).toBe('project')
    expect(commands.find((command) => command.name === 'deploy')?.body).toContain('项目级')
  })

  it('拒绝通过链接到工作区外的 .morrow 读取项目命令', () => {
    const home = tempDir('morrow-cmd-link-home-')
    const workspace = tempDir('morrow-cmd-link-ws-')
    const outside = tempDir('morrow-cmd-link-out-')
    mkdirSync(join(outside, 'commands'), { recursive: true })
    writeFileSync(join(outside, 'commands', 'leak.md'), '工作区外命令\n', 'utf8')
    symlinkSync(outside, join(workspace, '.morrow'), 'junction')

    expect(discoverCustomCommands(workspace, home)).toHaveLength(0)
  })

  it('达到 100 条上限后，项目命令仍可覆盖同名用户命令', () => {
    const home = tempDir('morrow-cmd-cap-home-')
    const workspace = tempDir('morrow-cmd-cap-ws-')
    const homeDir = join(home, '.morrow', 'commands')
    const projectDir = join(workspace, '.morrow', 'commands')
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    for (let index = 0; index < 100; index += 1) {
      const name = index === 0 ? 'review' : `cmd-${String(index).padStart(3, '0')}`
      writeFileSync(join(homeDir, `${name}.md`), `用户级 ${name}\n`, 'utf8')
    }
    writeFileSync(join(projectDir, 'review.md'), '项目级覆盖\n', 'utf8')
    writeFileSync(join(projectDir, 'extra.md'), '超出上限\n', 'utf8')

    const commands = discoverCustomCommands(workspace, home)
    expect(commands).toHaveLength(100)
    expect(commands.find((command) => command.name === 'review')?.body).toBe('项目级覆盖')
    expect(commands.some((command) => command.name === 'extra')).toBe(false)
  })

  it('展开模板：$ARGUMENTS、位置参数与无占位符时追加参数', () => {
    expect(expandCustomCommand('请审查 $1，重点 $2', 'a.ts 性能')).toBe('请审查 a.ts，重点 性能')
    expect(expandCustomCommand('总结：$ARGUMENTS', ' 前后 空格 ')).toBe('总结：前后 空格')
    expect(expandCustomCommand('只写代码', '额外要求')).toBe('只写代码\n\n额外要求')
    expect(expandCustomCommand('固定模板', '   ')).toBe('固定模板')
  })
})
