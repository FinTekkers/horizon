// Google-login allowlist (HZ-36): before this existed, any Google account
// that completed the OAuth consent screen got a full Horizon account.
// ALLOWED_LOGIN_EMAILS (config.js) is the only gate — deny-by-default, so an
// empty/unset list means every Google login is rejected, not "allow all".

import { ALLOWED_LOGIN_EMAILS } from './config.js'
import { disableUser, enableUser } from './membership.js'

// user_event.who for the writes below.
const ALLOWLIST_ACTOR = 'login allowlist'

export function isAllowedEmail(email) {
  return typeof email === 'string' && ALLOWED_LOGIN_EMAILS.has(email.trim().toLowerCase())
}

// Disables any 'google'-auth user whose email has fallen off the allowlist
// (or was never on it), and re-enables a disabled one that is back on it — so
// removing an address from ALLOWED_LOGIN_EMAILS revokes existing access, not
// just future logins. HZ-654: nothing is deleted. The row, its sessions and
// its tokens stay; auth.js refuses them, and the ones issued before the
// disable stay refused after a re-enable (membership.js's disableUser).
// Runs on every boot (see db.js), not one-time-gated like the pipeline shift
// migrations there: ops can edit the env var while the process is down and
// expect it enforced the moment it comes back up. Only rows whose state
// changes are written, so a boot with an unchanged allowlist writes nothing.
//
// Scope note: a 'password'-auth row that previously linked a google_sub (the
// "adopt" path in auth.js's findOrCreateGoogleUser) keeps auth_method =
// 'password' and is deliberately left alone here — it's still gated at
// login time (the allowlist check runs before any Google identity is even
// looked up), so this narrower scope isn't a hole, just a smaller blast
// radius than "every user row".
export function reconcileGoogleUsers(db) {
  const rows = db.prepare("SELECT id, email, disabled_at FROM user WHERE auth_method = 'google'").all()
  const toDisable = rows.filter((row) => row.disabled_at == null && !isAllowedEmail(row.email))
  const toEnable = rows.filter((row) => row.disabled_at != null && isAllowedEmail(row.email))
  if (toDisable.length === 0 && toEnable.length === 0) return
  db.transaction(() => {
    for (const row of toDisable) disableUser(db, row.id, ALLOWLIST_ACTOR)
    for (const row of toEnable) enableUser(db, row.id, ALLOWLIST_ACTOR)
  })()
}
