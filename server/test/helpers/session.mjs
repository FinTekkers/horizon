// Shared fixture for HTTP-contract tests (HZ-21): every /api/* route now
// requires a logged-in session, so any test driving the app through
// app.inject() needs a real user + session cookie, not just a header.
//
// Call this AFTER dynamically importing '../../src/auth.js' and
// '../../src/config.js' from the same HORIZON_DB the test configured —
// passing those modules in (instead of importing them here) avoids a second,
// possibly-earlier-cached import of db.js under the wrong DB path.
export function loginFixtureUser(auth, config, opts = {}) {
  const { email = 'fixture@example.com', name = 'Fixture User', authMethod = 'password' } = opts
  const { user, pin } = auth.createUser({ email, name, authMethod })
  const token = auth.createSession(user.id)
  return { user, pin, cookie: `${config.SESSION_COOKIE_NAME}=${token}` }
}
