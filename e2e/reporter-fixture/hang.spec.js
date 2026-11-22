import { test } from '@playwright/test'

test('first', () => {})

test('second', async () => {
  test.setTimeout(0)
  await new Promise(() => {})
})
