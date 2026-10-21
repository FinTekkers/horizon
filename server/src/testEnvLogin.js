// Screenshot capture's login (HZ-511). The farm's screenshot runner never
// visits the login page: a `login: true` shot sends each value of the repo's
// test_env_file as an X-Horizon-Test-Env-<NAME> header (farm/screenshot_runner.py
// login_headers()). Horizon's file holds SCREENSHOT_LOGIN_KEY, so the header
// below arrives on every request of a logged-in shot, and a match is treated
// as the ADMIN_EMAIL account.
//
// Test servers only: this is the one place HORIZON_TEST_HOOKS is checked for
// it, so a production server ignores the header even with the key in its env.
// An empty key disables it too. The caller (app.js) labels the request
// `via: 'test-env'`, never 'session', so the header can not pass a gate.

import crypto from 'node:crypto'
import * as auth from './auth.js'
import { SCREENSHOT_LOGIN_KEY, TEST_HOOKS_ENABLED } from './config.js'

// Lowercase, as Node presents incoming header names. Never log this header's
// value, or the key: both are the provisioned secret.
export const TEST_ENV_LOGIN_HEADER = 'x-horizon-test-env-screenshot-login-key'

function digest(s) {
  return crypto.createHash('sha256').update(s).digest()
}

// The admin user when `headers` carries the key, else null. `enabled` and
// `key` default to the server's config; tests pass their own.
export function testEnvUser(headers, { enabled = TEST_HOOKS_ENABLED, key = SCREENSHOT_LOGIN_KEY } = {}) {
  if (!enabled || !key) return null
  const sent = headers?.[TEST_ENV_LOGIN_HEADER]
  if (typeof sent !== 'string' || sent === '') return null
  if (!crypto.timingSafeEqual(digest(sent), digest(key))) return null
  return auth.adminUser()
}
