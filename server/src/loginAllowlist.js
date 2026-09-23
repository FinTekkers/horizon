// Google-login allowlist (HZ-36): before this existed, any Google account
// that completed the OAuth consent screen got a full Horizon account.
// ALLOWED_LOGIN_EMAILS (config.js) is the only gate — deny-by-default, so an
// empty/unset list means every Google login is rejected, not "allow all".

import { ALLOWED_LOGIN_EMAILS } from './config.js'

export function isAllowedEmail(email) {
  return typeof email === 'string' && ALLOWED_LOGIN_EMAILS.has(email.trim().toLowerCase())
}

// Deletes any 'google'-auth user row whose email has fallen off the
// allowlist (or was never on it), and its sessions — so removing an address
// from ALLOWED_LOGIN_EMAILS revokes existing access, not just future logins.
// Runs on every boot (see db.js), not one-time-gated like the pipeline shift
// migrations there: ops can edit the env var while the process is down and
// expect it enforced the moment it comes back up.
//
// Scope note: a 'password'-auth row that previously linked a google_sub (the
// "adopt" path in auth.js's findOrCreateGoogleUser) keeps auth_method =
// 'password' and is deliberately left alone here — it's still gated at
// login time (the allowlist check runs before any Google identity is even
// looked up), so this narrower scope isn't a hole, just a smaller blast
// radius than "every user row".
export function reconcileGoogleUsers(db) {
  const rows = db.prepare("SELECT id, email FROM user WHERE auth_method = 'google'").all()
  const toRemove = rows.filter((row) => !isAllowedEmail(row.email))
  if (toRemove.length === 0) return
  db.transaction(() => {
    for (const row of toRemove) {
      db.prepare('DELETE FROM session WHERE user_id = ?').run(row.id)
      db.prepare('DELETE FROM user WHERE id = ?').run(row.id)
    }
  })()
}
