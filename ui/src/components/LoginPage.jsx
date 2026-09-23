import { useEffect, useState } from 'react'
import * as api from '../api'
import { GridIcon } from './icons'

// A failed /api/auth/google/* callback (HZ-37) redirects back here with
// ?error=<code> instead of rendering raw JSON in the tab — this maps each
// code to copy a human can act on.
const GOOGLE_ERROR_MESSAGES = {
  google_sso_not_configured: 'Google sign-in is not available right now.',
  bad_state: 'Your sign-in attempt expired. Please try again.',
  google_auth_failed: 'Google sign-in failed. Please try again.',
  google_link_blocked:
    "That Google account's email isn't verified, so it can't be linked. Sign in with your password instead, or retry with a verified Google account.",
  account_link_failed: 'Something went wrong signing you in with Google. Please try again.',
  google_login_not_allowed: "That Google account isn't authorized to sign in here. Sign in with your password instead, or contact an administrator.",
}

function googleErrorFromLocation() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('error')
  if (!code) return null
  return GOOGLE_ERROR_MESSAGES[code] || 'Could not sign in with Google.'
}

// Every page under /horizon requires a login (HZ-21): a hardcoded email/
// password, or Google SSO — a first-time Google sign-in creates the account.
// The Google link is a plain server-driven redirect (no Google JS SDK here).
export default function LoginPage({ onLoggedIn }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(() => googleErrorFromLocation())
  const [busy, setBusy] = useState(false)

  // Strip ?error= after reading it so a page refresh doesn't keep re-showing
  // a stale message, and so it never leaks into a later, unrelated URL.
  useEffect(() => {
    if (!window.location.search.includes('error=')) return
    const params = new URLSearchParams(window.location.search)
    params.delete('error')
    const query = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''))
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    if (!email.trim() || !password) return
    setBusy(true)
    setError(null)
    try {
      const { user } = await api.login(email.trim(), password)
      onLoggedIn(user)
    } catch (err) {
      setError(err.message || 'Could not log in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <div className="topbar__logo">
            <GridIcon />
          </div>
          <div>
            <div className="topbar__title">HORIZON</div>
            <div className="topbar__subtitle">Delivery Lifecycle</div>
          </div>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <div className="field__label">Email</div>
            <input
              className="field__input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <div className="field__label">Password</div>
            <input
              className="field__input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <div className="gh-error">{error}</div>}

          <button className="login__submit" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="login__divider">
          <span>or</span>
        </div>

        <a className="login__google" href={api.googleLoginUrl()}>
          Sign in with Google
        </a>
      </div>
    </div>
  )
}
