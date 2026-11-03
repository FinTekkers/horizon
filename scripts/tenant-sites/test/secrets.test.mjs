// Guardrail 2: nothing under scripts/tenant-sites/ holds a token, a Stripe
// value or an email address, and every phone number is in the reserved
// 555-01xx range. A founder name cannot be checked without committing it, so
// that part stays a review-time check.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

// Token shapes, written so this file does not match itself.
const SECRET_SHAPES = [
  /\bghp_[A-Za-z0-9]{30,}/,
  /\bgh[ousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}/,
  /\bwhsec_[A-Za-z0-9]{10,}/,
]
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
const PHONE = /\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g

function textFiles() {
  return readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)))
    .filter((f) => !f.split(path.sep).includes('node_modules') && !/\.(jpe?g|png|gif|webp)$/i.test(f))
}

test('no token, Stripe value or email address in any file, and only 555-01xx phone numbers', () => {
  const files = textFiles()
  assert.ok(files.includes(path.join('parvati-site', 'data', 'sales.csv')), 'the scan covers sales.csv')
  assert.ok(files.length >= 15, `scan saw only ${files.length} files`)
  for (const file of files) {
    const text = readFileSync(path.join(ROOT, file), 'utf8')
    for (const shape of SECRET_SHAPES) assert.doesNotMatch(text, shape, `${file} matches ${shape}`)
    assert.doesNotMatch(text, EMAIL, `${file} has an email address`)
    for (const [phone] of text.matchAll(PHONE)) assert.match(phone, /555[ .-]01\d\d$/, `${file} has phone ${phone}`)
  }
})
