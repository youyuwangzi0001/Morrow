import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ appData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'appData' ? electronState.appData : join(electronState.appData, name))
  }
}))

import {
  isNestedPath,
  readDataLocation,
  removeDataLocation,
  resetResolveDataDirCacheForTests,
  resolveDataDir,
  samePath,
  writeDataLocation
} from '../../../src/main/services/paths'
import {
  cleanTargetDataDir,
  copyUserDataForMigration
} from '../../../src/main/services/data-dir-migration'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'morrow-data-dir-'))
  electronState.appData = join(root, 'appdata')
  mkdirSync(electronState.appData, { recursive: true })
  delete process.env.PORTABLE_EXECUTABLE_DIR
  delete process.env.MORROW_DATA_LOCATION_FILE
  resetResolveDataDirCacheForTests()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.PORTABLE_EXECUTABLE_DIR
  delete process.env.MORROW_DATA_LOCATION_FILE
  resetResolveDataDirCacheForTests()
})

describe('data directory pointer', () => {
  it('writes, reads and removes an absolute custom directory', () => {
    const pointer = join(root, 'location.json')
    const target = join(root, 'custom-data')
    writeDataLocation(target, pointer)
    expect(readDataLocation(pointer)).toBe(resolve(target))
    expect(JSON.parse(readFileSync(pointer, 'utf8')).dataDir).toBe(resolve(target))
    removeDataLocation(pointer)
    expect(readDataLocation(pointer)).toBeNull()
  })

  it('ignores malformed and relative pointers', () => {
    const pointer = join(root, 'location.json')
    writeFileSync(pointer, '{not json', 'utf8')
    expect(readDataLocation(pointer)).toBeNull()
    writeFileSync(pointer, JSON.stringify({ dataDir: 'relative/path' }), 'utf8')
    expect(readDataLocation(pointer)).toBeNull()
  })

  it('prefers --data-dir, then a custom pointer, then the default directory', () => {
    const pointer = join(root, 'location.json')
    const custom = join(root, 'custom')
    const argDir = join(root, 'arg-data')
    process.env.MORROW_DATA_LOCATION_FILE = pointer
    writeDataLocation(custom, pointer)

    process.argv.push(`--data-dir=${argDir}`)
    try {
      resetResolveDataDirCacheForTests()
      expect(resolveDataDir()).toBe(resolve(argDir))
    } finally {
      const index = process.argv.findIndex((value) => value.startsWith('--data-dir='))
      if (index >= 0) process.argv.splice(index, 1)
    }

    resetResolveDataDirCacheForTests()
    expect(resolveDataDir()).toBe(resolve(custom))
    removeDataLocation(pointer)
    resetResolveDataDirCacheForTests()
    expect(resolveDataDir()).toBe(join(electronState.appData, 'Morrow'))
  })
})

describe('data directory migration', () => {
  it('copies user data and skips caches, logs and browser transient state', () => {
    const source = join(root, 'source')
    const target = join(root, 'target')
    mkdirSync(join(source, 'sessions'), { recursive: true })
    mkdirSync(join(source, 'attachments'), { recursive: true })
    mkdirSync(join(source, 'providers'), { recursive: true })
    mkdirSync(join(source, 'Cache'), { recursive: true })
    mkdirSync(join(source, 'logs'), { recursive: true })
    mkdirSync(join(source, 'Network'), { recursive: true })
    writeFileSync(join(source, 'settings.json'), '{"theme":"dark"}', 'utf8')
    writeFileSync(join(source, 'sessions', 'one.json'), '{"id":"one"}', 'utf8')
    writeFileSync(join(source, 'attachments', 'a.txt'), 'hello', 'utf8')
    writeFileSync(join(source, 'providers', 'p.json'), '[]', 'utf8')
    writeFileSync(join(source, 'Cache', 'cache.bin'), 'x', 'utf8')
    writeFileSync(join(source, 'logs', 'main.log'), 'x', 'utf8')
    writeFileSync(join(source, 'Network', 'Cookies'), 'x', 'utf8')

    const copied = copyUserDataForMigration(source, target)
    expect(copied).toBe(4)
    expect(existsSync(join(target, 'settings.json'))).toBe(true)
    expect(existsSync(join(target, 'sessions', 'one.json'))).toBe(true)
    expect(existsSync(join(target, 'attachments', 'a.txt'))).toBe(true)
    expect(existsSync(join(target, 'providers', 'p.json'))).toBe(true)
    expect(existsSync(join(target, 'Cache'))).toBe(false)
    expect(existsSync(join(target, 'logs'))).toBe(false)
    expect(existsSync(join(target, 'Network'))).toBe(false)

    cleanTargetDataDir(target)
    expect(existsSync(join(target, 'settings.json'))).toBe(false)
  })

  it('detects same and nested paths', () => {
    const base = join(root, 'base')
    expect(samePath(base, join(base, '..', 'base'))).toBe(true)
    expect(isNestedPath(base, join(base, 'child'))).toBe(true)
    expect(isNestedPath(join(base, 'child'), base)).toBe(false)
    expect(isNestedPath(base, join(root, 'sibling'))).toBe(false)
  })
})
