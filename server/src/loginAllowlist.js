// Google-login gate. HZ-36 added ALLOWED_LOGIN_EMAILS (config.js), the invite
// list — deny-by-default, so an empty/unset list admits no invitee, not "allow
// all". HZ-635 adds the second way in: a paid account, whose user.account_status
// (HZ-632, written by HZ-634's Stripe webhook) is 'active' or 'cancelling'.
// Status is read from Horizon's DB only; nothing here calls Stripe.

import { ADMIN_EMAIL, ALLOWED_LOGIN_EMAILS } from './config.js'
import { disableUser, enableUser } from './membership.js'

const ENTITLED_STATUSES = new Set(['active', 'cancelling'])

// user_event.who for the writes below.
const ALLOWLIST_ACTOR = 'login allowlist'

export function isAllowedEmail(email) {
  return typeof email === 'string' && ALLOWED_LOGIN_EMAILS.has(email.trim().toLowerCase())
}

// Fail closed: a missing, null or unknown status is refused unless the email
// is allowlisted. Allowlisted emails keep access whatever their status.
export function isEntitled({ email, accountStatus }) {
  return isAllowedEmail(email) || ENTITLED_STATUSES.has(accountStatus)
}

// Whether a user row's access depends on isEntitled: any row a Google identity
// can sign in to — 'google' auth, or a row that linked a google_sub through
// the adopt path. The ADMIN_EMAIL row is the password sign-in account and is
// never gated, so password sign-in stays unchanged whatever its status.
export function isGoogleGated(row) {
  if (!row) return false
  if (row.auth_method !== 'google' && !row.google_sub) return false
  return String(row.email).trim().toLowerCase() !== ADMIN_EMAIL.trim().toLowerCase()
}

// Ends access for every Google-gated row that is no longer entitled, so
// removing an address from ALLOWED_LOGIN_EMAILS, or a lapsed payment, revokes
// existing access, not just future logins. Runs on every boot (see db.js), not
// one-time-gated like the pipeline shift migrations there: ops can edit the
// env var while the process is down and expect it enforced the moment it
// comes back up. Between boots, auth.js's getSessionUser and getTokenAuth
// apply the same check on every request, so no restart is needed. Only rows
// whose state changes are written, so a boot with nothing to change writes
// nothing.
//
// Nothing is deleted but sessions. A 'google'-auth row (an invitee's, HZ-654)
// that is not entitled is disabled, and re-enabled once entitled again; its
// row, sessions and tokens stay, and auth.js refuses them. Any other gated row
// is a paid sign-up (HZ-633) that linked Google: once it is no longer paid it
// loses its sessions (HZ-635) but keeps its row, so its status and projects
// survive a re-payment and the user simply signs in again.
export function reconcileGoogleUsers(db) {
  const rows = db
    .prepare(
      `SELECT id, email, auth_method, google_sub, account_status, disabled_at,
              EXISTS (SELECT 1 FROM session WHERE session.user_id = user.id) AS has_session
         FROM user
        WHERE auth_method = 'google' OR google_sub IS NOT NULL`,
    )
    .all()
  const entitled = (row) => isEntitled({ email: row.email, accountStatus: row.account_status })
  const googleRows = rows.filter((row) => row.auth_method === 'google')
  const toDisable = googleRows.filter((row) => row.disabled_at == null && !entitled(row))
  const toEnable = googleRows.filter((row) => row.disabled_at != null && entitled(row))
  const toEndSessions = rows.filter((row) => row.auth_method !== 'google' && row.has_session && isGoogleGated(row) && !entitled(row))
  if (toDisable.length === 0 && toEnable.length === 0 && toEndSessions.length === 0) return
  db.transaction(() => {
    for (const row of toDisable) disableUser(db, row.id, ALLOWLIST_ACTOR)
    for (const row of toEnable) enableUser(db, row.id, ALLOWLIST_ACTOR)
    for (const row of toEndSessions) db.prepare('DELETE FROM session WHERE user_id = ?').run(row.id)
  })()
}
