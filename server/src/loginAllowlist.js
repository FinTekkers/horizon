// Google-login gate. HZ-36 added ALLOWED_LOGIN_EMAILS (config.js), the invite
// list — deny-by-default, so an empty/unset list admits no invitee, not "allow
// all". HZ-635 adds the second way in: a paid account, whose user.account_status
// (HZ-632, written by HZ-634's Stripe webhook) is 'active' or 'cancelling'.
// Status is read from Horizon's DB only; nothing here calls Stripe.

import { ADMIN_EMAIL, ALLOWED_LOGIN_EMAILS } from './config.js'

const ENTITLED_STATUSES = new Set(['active', 'cancelling'])

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
// apply the same check on every request, so no restart is needed.
//
// What is removed: the sessions always. The row too, but only for a 'google'
// row that was never a Stripe customer — a former invitee. Any other row
// (a paid sign-up that linked Google, an invitee who paid) keeps its row, so
// its status and projects survive a re-payment.
export function reconcileGoogleUsers(db) {
  const rows = db
    .prepare(
      `SELECT id, email, auth_method, google_sub, account_status, stripe_customer_id FROM user
       WHERE auth_method = 'google' OR google_sub IS NOT NULL`,
    )
    .all()
  const toRevoke = rows.filter((row) => isGoogleGated(row) && !isEntitled({ email: row.email, accountStatus: row.account_status }))
  if (toRevoke.length === 0) return
  db.transaction(() => {
    for (const row of toRevoke) {
      db.prepare('DELETE FROM session WHERE user_id = ?').run(row.id)
      if (row.auth_method === 'google' && !row.stripe_customer_id) db.prepare('DELETE FROM user WHERE id = ?').run(row.id)
    }
  })()
}
