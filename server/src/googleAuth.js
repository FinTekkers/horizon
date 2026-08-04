// Google Sign-In (HZ-21): server-driven OAuth 2.0 code flow, verified with
// google-auth-library — no Google JS SDK in the UI bundle.
//
// Exported as a mutable object (not bare functions) so tests can stub
// exchangeCodeForProfile at this exact boundary — /api/auth/google/callback
// is then exercised end-to-end via app.inject() without any real network
// call to Google.

import { OAuth2Client } from 'google-auth-library'
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } from './config.js'

function client() {
  return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)
}

export const googleAuth = {
  configured() {
    return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
  },

  buildAuthUrl(state) {
    return client().generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
    })
  },

  // Exchanges the authorization code for tokens, verifies the ID token, and
  // returns the caller's { sub, email, name }. Throws on any failure (bad
  // code, network error, signature mismatch) — the route maps that to a
  // clean error response.
  async exchangeCodeForProfile(code) {
    const oauth2Client = client()
    const { tokens } = await oauth2Client.getToken(code)
    const ticket = await oauth2Client.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID })
    const payload = ticket.getPayload()
    return { sub: payload.sub, email: payload.email, name: payload.name || payload.email }
  },
}
