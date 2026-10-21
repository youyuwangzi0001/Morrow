import { expect, test } from '@playwright/test'
import { launchMorrow } from './launch'

test('两份便携副本使用不同数据目录时都能启动', async () => {
  test.setTimeout(180_000)
  const first = await launchMorrow({ name: 'two-copies-a', waitForSelector: '.sidebar' })
  const second = await launchMorrow({ name: 'two-copies-b', waitForSelector: '.sidebar' })
  try {
    expect(await first.page.title()).toBe('Morrow')
    expect(await second.page.title()).toBe('Morrow')
    expect(await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0)
    expect(await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0)
  } finally {
    await first.close()
    await second.close()
  }
})
