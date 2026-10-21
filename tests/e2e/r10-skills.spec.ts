/**
 * R10-H 技能库 E2E —— 真实 Electron + 真实主进程 `feature:skills:*` IPC。
 *
 * 验收点（不依赖 LLM、不联网、不产生费用）：
 * 1. 主进程 feature 频道已注册（Lead 需在 src/main/features/index.ts import './skills'）；
 * 2. 从本地 .zip 真实安装到应用数据目录 <dataDir>/skills，文件真实落盘；
 * 3. list / read / setEnabled / remove / rescan 真实往返；
 * 4. 可执行文件（.js）、zip-slip（../）技能包被拒绝且不落盘；
 * 5. 技能库面板挂载后（Lead 集成）截图深/浅两套主题。
 *
 * 面板 UI 断言说明：Lead 统一挂载 <SkillsPanel/>，本 spec 通过
 * `window.morrow.features.invoke` 直接验证 IPC + 磁盘两层证据；若面板已挂载
 * （存在 `[data-testid="skills-panel"]` 且能找到打开入口）则补截图，否则跳过该段。
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, openToolPanel, waitForStoreReady } from './store'

type InvokeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

interface SkillView {
  id: string
  name: string
  source: 'workspace' | 'user'
  enabled: boolean
  dir: string
  skillPath: string
  fileCount: number
}

interface SkillsSnapshot {
  userDir: string
  stateFile: string
  workspace: string | null
  skills: SkillView[]
  errors: string[]
}

interface SkillDetail extends SkillView {
  raw: string
  files: Array<{ path: string; size: number }>
}

/* 手工构造 store 模式 ZIP（e2e 里不依赖 jszip 的 CJS 互操作，也让恶意条目名保持原样） */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeZip(path: string, entries: Record<string, string>): string {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBuffer.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuffer.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuffer.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuffer.copy(central, 46)
    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const localBuffer = Buffer.concat(locals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(centrals.length, 8)
  end.writeUInt16LE(centrals.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(localBuffer.length, 16)
  end.writeUInt16LE(0, 20)
  writeFileSync(path, Buffer.concat([localBuffer, centralBuffer, end]))
  return path
}

async function invoke<T>(
  page: Parameters<typeof waitForStoreReady>[0],
  channel: string,
  payload?: unknown
): Promise<InvokeResult<T>> {
  return page.evaluate(
    async ({ channel: channelName, payload: channelPayload }) => {
      return (window as unknown as {
        morrow: { features: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }
      }).morrow.features.invoke(channelName, channelPayload) as Promise<never>
    },
    { channel, payload }
  )
}

test.describe('R10-H 技能库（真实主进程 feature IPC）', () => {
  test('安装 / 读取 / 启停 / 删除 / 重扫 + 恶意 zip 拒绝', async () => {
    const morrow = await launchMorrow({ name: 'r10-skills', waitForSelector: '#root' })
    const fixtureId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixtureDir = join(root, 'tmp', `r10-skills-fixtures-${fixtureId}`)
    mkdirSync(fixtureDir, { recursive: true })
    try {
      await waitForStoreReady(morrow.page)

      // 0. 频道必须已注册（Lead 在 features/index.ts import './skills'）
      const initial = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:list', { workspace: null })
      expect(initial.ok, `feature:skills:list 未注册或失败：${initial.ok ? '' : initial.error.message}`).toBe(true)
      if (!initial.ok) throw new Error('技能库 feature 频道未注册')
      const userDir = initial.data.userDir
      expect(userDir).toContain('skills')
      expect(initial.data.skills.map((item) => item.name)).toEqual(expect.arrayContaining(['code-review', 'debugging']))

      // 1. 从 zip 真实安装
      const zipPath = writeZip(join(fixtureDir, 'release-skill.zip'), {
        'release/SKILL.md': '---\nname: release\ndescription: E2E 安装的发版技能\n---\n# Release\n读取 changelog 并生成 release.json。',
        'release/checklist.md': '- 检查 changelog\n- 打 tag\n'
      })
      const installed = await invoke<{ installed: SkillView; snapshot: SkillsSnapshot }>(
        morrow.page,
        'feature:skills:install',
        { sourcePath: zipPath, workspace: null }
      )
      expect(installed.ok).toBe(true)
      if (!installed.ok) throw new Error(installed.error.message)
      const skill = installed.data.installed
      expect(skill).toMatchObject({ name: 'release', source: 'user', enabled: true })
      expect(existsSync(join(userDir, 'release', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(userDir, 'release', 'checklist.md'))).toBe(true)
      expect(readFileSync(join(userDir, 'release', 'SKILL.md'), 'utf8')).toContain('E2E 安装的发版技能')

      // 2. list / read
      const listed = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:list', { workspace: null })
      expect(listed.ok).toBe(true)
      if (!listed.ok) throw new Error(listed.error.message)
      expect(listed.data.skills.map((item) => item.name)).toContain('release')
      const detail = await invoke<SkillDetail>(morrow.page, 'feature:skills:read', { id: skill.id, workspace: null })
      expect(detail.ok).toBe(true)
      if (!detail.ok) throw new Error(detail.error.message)
      expect(detail.data.raw).toContain('# Release')
      expect(detail.data.files.map((file) => file.path)).toEqual(expect.arrayContaining(['SKILL.md', 'checklist.md']))

      // 3. 启停（状态真实写盘）
      const disabled = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:setEnabled', {
        id: skill.id,
        enabled: false,
        workspace: null
      })
      expect(disabled.ok).toBe(true)
      if (!disabled.ok) throw new Error(disabled.error.message)
      expect(disabled.data.skills.find((item) => item.id === skill.id)?.enabled).toBe(false)
      const stateFile = disabled.data.stateFile
      expect(readFileSync(stateFile, 'utf8')).toContain('"enabled": false')

      const enabledAgain = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:setEnabled', {
        id: skill.id,
        enabled: true,
        workspace: null
      })
      expect(enabledAgain.ok).toBe(true)
      if (!enabledAgain.ok) throw new Error(enabledAgain.error.message)
      expect(enabledAgain.data.skills.find((item) => item.id === skill.id)?.enabled).toBe(true)

      // 4. 恶意技能包：可执行文件 & zip-slip 都要被拒绝且不落盘
      const exeZip = writeZip(join(fixtureDir, 'exe-skill.zip'), {
        'SKILL.md': '# Bad\nx',
        'run.js': 'console.log(1)'
      })
      const exeRejected = await invoke(morrow.page, 'feature:skills:install', { sourcePath: exeZip, workspace: null })
      expect(exeRejected.ok).toBe(false)
      if (!exeRejected.ok) expect(exeRejected.error.message).toContain('可执行')

      const evilZip = writeZip(join(fixtureDir, 'evil-skill.zip'), {
        'SKILL.md': '# Evil\nx',
        '../escaped.txt': 'pwned'
      })
      const evilRejected = await invoke(morrow.page, 'feature:skills:install', { sourcePath: evilZip, workspace: null })
      expect(evilRejected.ok).toBe(false)
      if (!evilRejected.ok) expect(evilRejected.error.message).toMatch(/zip-slip|越界/)
      expect(existsSync(join(userDir, '..', 'escaped.txt'))).toBe(false)
      expect(existsSync(join(morrow.dataDir, 'escaped.txt'))).toBe(false)

      // 5. rescan + remove
      const rescanned = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:rescan', { workspace: null })
      expect(rescanned.ok).toBe(true)
      if (!rescanned.ok) throw new Error(rescanned.error.message)
      expect(rescanned.data.errors).toEqual([])

      const removed = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:remove', {
        id: skill.id,
        workspace: null
      })
      expect(removed.ok).toBe(true)
      if (!removed.ok) throw new Error(removed.error.message)
      expect(removed.data.skills.some((item) => item.name === 'release')).toBe(false)
      expect(removed.data.skills.map((item) => item.name)).toEqual(expect.arrayContaining(['code-review']))
      expect(existsSync(join(userDir, 'release'))).toBe(false)
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
      await morrow.close()
    }
  })

  test('面板 UI（工作台入口）：打开技能库并截图深/浅两套主题', async () => {
    const morrow = await launchMorrow({ name: 'r10-skills-ui', waitForSelector: '#root' })
    const fixtureId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixtureDir = join(root, 'tmp', `r10-skills-ui-${fixtureId}`)
    mkdirSync(fixtureDir, { recursive: true })
    try {
      await waitForStoreReady(morrow.page)
      await dismissOnboarding(morrow.page)
      // 先安装一个真实技能，让面板截图里有内容（列表 + 详情 + SKILL.md）
      const zipPath = writeZip(join(fixtureDir, 'release-skill.zip'), {
        'release/SKILL.md':
          '---\nname: release\ndescription: E2E 安装的发版技能\n---\n# Release\n读取 changelog 并生成 release.json。\n',
        'release/checklist.md': '- 检查 changelog\n- 打 tag\n'
      })
      const installed = await invoke(morrow.page, 'feature:skills:install', { sourcePath: zipPath, workspace: null })
      expect(installed.ok).toBe(true)

      // 统一入口：设置 → 功能与工具 → 技能
      await openToolPanel(morrow.page, '技能库')
      await morrow.page.waitForSelector('[data-testid="skills-panel"]', { timeout: 10_000 })
      await morrow.page.waitForTimeout(300)
      const bodyOverflow = await morrow.page
        .getByRole('dialog', { name: '技能' })
        .evaluate((panel) => {
          const body = panel.querySelector<HTMLElement>('.modal-body')
          return body ? body.scrollHeight - body.clientHeight : null
        })
      expect(bodyOverflow).not.toBeNull()
      expect(bodyOverflow!).toBeLessThanOrEqual(1)
      // 内置技能随首次启动安装，面板里应能看到
      const builtin = morrow.page.getByRole('option', { name: /code-review/ }).first()
      await expect(builtin).toBeVisible()
      await builtin.click()
      await expect(morrow.page.getByText('代码审查').first()).toBeVisible()
      await morrow.page.screenshot({ path: screenshotPath('r10-skills-dark.png') })

      // 选中列表里的 release 技能（安装后默认选中第一个，这里显式点一下更稳）
      const card = morrow.page.getByRole('option', { name: /release/ }).first()
      if ((await card.count()) > 0) await card.click()
      await morrow.page.waitForTimeout(200)
      await morrow.page.screenshot({ path: screenshotPath('r10-skills-dark-detail.png') })

      await morrow.page.evaluate(() => {
        const state = (window as unknown as { __morrowStore?: { getState: () => Record<string, void> } }).__morrowStore
        ;(state?.getState().setTheme as ((theme: string) => void) | undefined)?.('light')
      })
      await morrow.page.waitForTimeout(400)
      await morrow.page.waitForTimeout(260)
      await morrow.page.screenshot({ path: screenshotPath('r10-skills-light.png') })
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
      await morrow.close()
    }
  })
})
