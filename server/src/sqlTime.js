// SQLite datetime('now') form: UTC, no zone. Shared by the deploy queue
// (HZ-333) and deploy holds (HZ-408), so neither imports the other for it.
export const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
export const msOf = (sql) => Date.parse(`${sql.replace(' ', 'T')}Z`)
