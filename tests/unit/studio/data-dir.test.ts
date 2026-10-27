import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StudioStore } from '../../../src/main/studio/store'
import {
  copyUserDataForMigration,
  removeStudioLocation,
  resolveDefaultStudioRoot,
  resolveStudioDataRoot,
  studioDataDirInfo,
  writeStudioLocation
} from '../../../src/main/services/paths'

describe('创作台自定义数据目录', () => {
  const original = process.env.MORROW_STUDIO_LOCATION_FILE
  let root = ''
  let dataDir = ''
  let pointer = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'morrow-studio-dir-'))
    dataDir = join(root, 'agent-data')
    pointer = join(root, 'studio-location.json')
    process.env.MORROW_STUDIO_LOCATION_FILE = pointer
    mkdirSync(dataDir, { recursive: true })
  })

  afterEach(() => {
    if (original === undefined) delete process.env.MORROW_STUDIO_LOCATION_FILE
    else process.env.MORROW_STUDIO_LOCATION_FILE = original
    rmSync(root, { recursive: true, force: true })
  })

  it('默认使用 Agent 数据目录下的 studio，显式 dataDir 的测试实例仍隔离', () => {
    const info = studioDataDirInfo(dataDir)
    expect(info.source).toBe('default')
    expect(info.root).toBe(resolveDefaultStudioRoot(dataDir))
    const store = new StudioStore(dataDir)
    expect(store.root).toBe(resolveDefaultStudioRoot(dataDir))
  })

  it('自定义指针优先，显式 dataDir 的测试实例不读取用户指针', () => {
    const custom = join(root, 'custom-studio')
    writeStudioLocation(custom)
    const info = studioDataDirInfo(dataDir)
    expect(info.source).toBe('custom')
    expect(info.root).toBe(custom)
    expect(resolveStudioDataRoot(dataDir)).toBe(custom)
    const isolated = new StudioStore(dataDir)
    expect(isolated.root).toBe(resolveDefaultStudioRoot(dataDir))
    const explicit = new StudioStore(dataDir, custom)
    expect(explicit.root).toBe(custom)
  })

  it('自定义目录不可用时回退默认；迁移复制作品文件且保留源目录', () => {
    const blocked = join(root, 'not-a-dir')
    writeFileSync(blocked, 'file')
    writeStudioLocation(blocked)
    expect(resolveStudioDataRoot(dataDir)).toBe(resolveDefaultStudioRoot(dataDir))

    const source = join(root, 'source-studio')
    const target = join(root, 'target-studio')
    mkdirSync(join(source, 'projects', 'p1'), { recursive: true })
    writeFileSync(join(source, 'projects', 'p1', 'project.json'), '{"title":"demo"}')
    writeFileSync(join(source, 'studio-index.json'), '{"projects":[]}')
    const copied = copyUserDataForMigration(source, target)
    expect(copied).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(target, 'studio-index.json'))).toBe(true)
    expect(existsSync(join(source, 'studio-index.json'))).toBe(true)
    removeStudioLocation()
  })
})
