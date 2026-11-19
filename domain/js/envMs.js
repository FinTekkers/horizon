// HZ-925: a millisecond timer read from the environment, so the e2e run can
// shorten a production timer without changing it. Pure — no I/O — so the
// server (process.env) and the UI build (import.meta.env) share one rule set:
// unset, empty or non-numeric text gives `fallback`; any number, even 0 or
// negative, is held at `floor` or above, so a timer never turns off.
export function envMs(raw, fallback, floor = 50) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(n, floor)
}
