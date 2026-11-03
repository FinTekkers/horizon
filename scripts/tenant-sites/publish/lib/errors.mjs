// A failure the operator can act on. main() prints only the message, after
// redact(), and exits 1. Callers never put the token in a message.
export class PublishError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PublishError'
  }
}

// GitHub token shapes. writeReport refuses any of them, and redact() masks
// them in printed output even when they are not the token in use.
export const TOKEN_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
]

// Deep-replaces every secret string, and every token-shaped string, with
// [redacted]. Non-string leaves pass through unchanged.
export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let out = value
    for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]')
    for (const shape of TOKEN_SHAPES) out = out.replace(shape, '[redacted]')
    return out
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, secrets)]))
  }
  return value
}
