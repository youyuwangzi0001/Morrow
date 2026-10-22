import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanUserSkills } from '../../../src/core/tools/skills'
import { BUILTIN_SKILLS, ensureBuiltinSkills } from '../../../src/main/services/builtin-skills'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morrow-builtin-skills-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('内置技能安装', () => {
  it('首次启动安装全部内置技能，并能被 core 发现与解析描述', () => {
    const dataDir = tempDir()
    const changed = ensureBuiltinSkills(dataDir)
    expect(changed.sort()).toEqual(BUILTIN_SKILLS.map((skill) => skill.name).sort())
    for (const skill of BUILTIN_SKILLS) {
      const path = join(dataDir, 'skills', skill.name, 'SKILL.md')
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toContain(`name: ${skill.name}`)
    }
    const discovered = scanUserSkills(join(dataDir, 'skills'))
    expect(discovered.map((skill) => skill.name).sort()).toEqual(BUILTIN_SKILLS.map((skill) => skill.name).sort())
    for (const skill of discovered) expect(skill.description.length).toBeGreaterThan(5)
    const art = discovered.find((skill) => skill.name === 'frontend-art-direction')
    expect(art).toBeTruthy()
    expect(readFileSync(art!.skillPath, 'utf8')).toContain('视觉简报')
    const quality = discovered.find((skill) => skill.name === 'deliverable-quality')
    expect(quality).toBeTruthy()
    expect(readFileSync(quality!.skillPath, 'utf8')).toContain('跨类型交付质量门槛')
  })

  it('不覆盖用户编辑，也不恢复用户删除的技能', () => {
    const dataDir = tempDir()
    ensureBuiltinSkills(dataDir)
    const editedPath = join(dataDir, 'skills', 'code-review', 'SKILL.md')
    writeFileSync(editedPath, '---\nname: code-review\ndescription: 用户改过的\n---\n保留我\n', 'utf8')
    rmSync(join(dataDir, 'skills', 'debugging'), { recursive: true, force: true })

    const changed = ensureBuiltinSkills(dataDir)
    expect(changed).not.toContain('code-review')
    expect(readFileSync(editedPath, 'utf8')).toContain('保留我')
    expect(existsSync(join(dataDir, 'skills', 'debugging', 'SKILL.md'))).toBe(false)

    // 再次启动也必须保留用户编辑（旧实现第二次启动会用内置内容覆盖）
    const changedAgain = ensureBuiltinSkills(dataDir)
    expect(changedAgain).not.toContain('code-review')
    expect(readFileSync(editedPath, 'utf8')).toContain('保留我')
  })

  it('已并入 frontend-art-direction 的旧技能 ui-polish 会在升级时移除，用户改过的保留', () => {
    const dataDir = tempDir()
    ensureBuiltinSkills(dataDir)
    const markerPath = join(dataDir, 'skills', '.builtin-skills.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      version: number
      skills: Record<string, { hash: string; modified?: boolean }>
    }
    const retiredDir = join(dataDir, 'skills', 'ui-polish')
    mkdirSync(retiredDir, { recursive: true })
    const original = '---\nname: ui-polish\ndescription: 旧内置技能\n---\n旧内容\n'
    writeFileSync(join(retiredDir, 'SKILL.md'), original, 'utf8')
    marker.skills['ui-polish'] = { hash: createHash('sha256').update(original).digest('hex') }
    writeFileSync(markerPath, JSON.stringify(marker), 'utf8')

    const changed = ensureBuiltinSkills(dataDir)
    expect(changed).toContain('ui-polish')
    expect(existsSync(retiredDir)).toBe(false)

    // 用户改过的旧技能不被删除，而是转为用户自有技能
    mkdirSync(retiredDir, { recursive: true })
    const edited = '---\nname: ui-polish\ndescription: 我改过的\n---\n保留我\n'
    writeFileSync(join(retiredDir, 'SKILL.md'), edited, 'utf8')
    const nextMarker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      version: number
      skills: Record<string, { hash: string; modified?: boolean }>
    }
    nextMarker.skills['ui-polish'] = { hash: createHash('sha256').update(original).digest('hex') }
    writeFileSync(markerPath, JSON.stringify(nextMarker), 'utf8')
    ensureBuiltinSkills(dataDir)
    expect(readFileSync(join(retiredDir, 'SKILL.md'), 'utf8')).toContain('保留我')
    const after = JSON.parse(readFileSync(markerPath, 'utf8')) as { skills: Record<string, unknown> }
    expect(after.skills['ui-polish']).toBeUndefined()
  })

  it('同名用户技能已存在时不覆盖', () => {
    const dataDir = tempDir()
    const dir = join(dataDir, 'skills', 'code-review')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: code-review\ndescription: 我自己的审查流程\n---\n自己的内容\n', 'utf8')
    ensureBuiltinSkills(dataDir)
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('自己的内容')
  })
})
