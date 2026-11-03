// HZ-725: the one identity every commit this tool makes is written as, both
// author and committer. It is a constant with no override: it is never read
// from GET /user, git config or the environment, so a commit can never fall
// back to the name of the person who owns the token.
export const IDENTITY = Object.freeze({ name: 'Parvati Real Estate', email: 'site@parvati-realestate.example' })

// "Name <email>", the form the report and the checks compare.
export function personLine(p) {
  return `${p?.name} <${p?.email}>`
}

export const IDENTITY_LINE = personLine(IDENTITY)

// True only for a plain { name, email } object equal to IDENTITY, with no
// other keys, so nothing GitHub might read as a different person rides along.
export function isIdentity(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false
  const keys = Object.keys(p).sort()
  return keys.length === 2 && keys[0] === 'email' && keys[1] === 'name'
    && p.name === IDENTITY.name && p.email === IDENTITY.email
}
