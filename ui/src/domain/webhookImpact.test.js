import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WEBHOOK_IMPACT, repoHasDeployTarget, webhookImpact } from './webhookImpact'

const { RELEASES_BLOCKED, SYNC_CONTINUES, SYNC_DELAY_ONLY } = WEBHOOK_IMPACT

describe('webhookImpact', () => {
  for (const status of ['missing', 'mismatched']) {
    test(`${status} with a deploy target: releases blocked, sync continues`, () => {
      expect(webhookImpact({ status, hasDeployTarget: true })).toEqual([RELEASES_BLOCKED, SYNC_CONTINUES])
    })
    test(`${status} with no deploy target: only a sync delay`, () => {
      expect(webhookImpact({ status, hasDeployTarget: false })).toEqual([SYNC_DELAY_ONLY])
    })
    test(`${status} with an unknown deploy target: only the sync line, never "nothing is lost"`, () => {
      expect(webhookImpact({ status, hasDeployTarget: null })).toEqual([SYNC_CONTINUES])
    })
  }

  for (const status of ['ok', 'error', undefined, 'constructor']) {
    test(`${status} shows nothing whatever the target state`, () => {
      for (const hasDeployTarget of [true, false, null]) {
        expect(webhookImpact({ status, hasDeployTarget })).toBeNull()
      }
    })
  }
})

describe('repoHasDeployTarget', () => {
  const targets = [{ key: 'ui-service', repo: 'FinTekkers/ui-service' }]

  test('unknown targets give null', () => {
    expect(repoHasDeployTarget(null, 'FinTekkers/ui-service')).toBeNull()
    expect(repoHasDeployTarget(undefined, 'FinTekkers/ui-service')).toBeNull()
  })

  test('matches a target repo, ignoring case', () => {
    expect(repoHasDeployTarget(targets, 'FinTekkers/ui-service')).toBe(true)
    expect(repoHasDeployTarget(targets, 'fintekkers/UI-Service')).toBe(true)
  })

  test('a repo with no target, or an empty list, gives false', () => {
    expect(repoHasDeployTarget(targets, 'acme/web')).toBe(false)
    expect(repoHasDeployTarget([], 'FinTekkers/ui-service')).toBe(false)
  })
})

// Guardrail: the wording lives in one place. Every other file under ui/src
// must import it, never copy it.
test('the four strings appear in ui/src only inside webhookImpact.js', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const srcRoot = join(here, '..')
  const home = join(here, 'webhookImpact.js')
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(jsx?|css|html)$/.test(name)) files.push(full)
    }
  }
  walk(srcRoot)
  const offenders = []
  for (const file of files) {
    if (file === home) continue
    const text = readFileSync(file, 'utf8')
    for (const [key, value] of Object.entries(WEBHOOK_IMPACT)) {
      if (text.includes(value)) offenders.push(`${relative(srcRoot, file)}: ${key}`)
    }
  }
  expect(offenders).toEqual([])
})
