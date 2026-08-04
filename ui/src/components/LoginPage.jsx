import { useState } from 'react'
import * as api from '../api'
import { GridIcon } from './icons'

// Every page under /horizon requires a login (HZ-21): a hardcoded email/
// password, or Google SSO — a first-time Google sign-in creates the account.
// The Google link is a plain server-driven redirect (no Google JS SDK here).
export default function LoginPage({ onLoggedIn }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

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
