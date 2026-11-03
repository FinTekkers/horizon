// Text an agent drafts that may become a public issue body (a split, a
// spawned item, an ask) carries plan text only. A leaf module, so split.js,
// spawn.js and asks.js share one pattern without importing each other.
export const HOST_PATH = /(?:\/home|\/Users|\/root)\/[^\s`'")\]]*/g

// HOST_PATH is global, so .test() on it is stateful; this is not.
export const hasHostPath = (text) => String(text).search(HOST_PATH) !== -1
