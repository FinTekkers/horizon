// Pure logic behind the "See agent output" live-tail page (HZ-14:
// `/api/runs/:runId/log/view` in server/src/app.js). appendLog/timedOut are
// unit-tested directly (server/test/runLogView.test.mjs); clientScript()
// embeds their exact source via Function.prototype.toString() so the code
// under test is the code that actually runs in the browser — no drift.

export const POLL_MS = 2000
export const LOG_KEEP_CHARS = 20_000
export const TIMEOUT_MS = 3 * 60 * 1000

export function appendLog(buffer, content) {
  return (buffer + content).slice(-LOG_KEEP_CHARS)
}

export function timedOut(startedAt, now) {
  return now - startedAt >= TIMEOUT_MS
}

// Runs in the browser, not here — written as a plain function so its source
// can be embedded verbatim. Content is always written via .textContent,
// never innerHTML: agent output is untrusted text.
function clientMain() {
  var logEl = document.getElementById('log')
  var statusEl = document.getElementById('status')
  var reconnectBtn = document.getElementById('reconnect')
  var buffer = ''
  var offset = 0
  var startedAt = Date.now()
  var stopped = false

  function render() {
    logEl.textContent = buffer || 'Waiting for output…'
  }

  function setStatus(text) {
    statusEl.textContent = text
  }

  function read() {
    var url = new URL('../log?offset=' + encodeURIComponent(offset), window.location.href)
    return fetch(url)
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('log fetch failed')
          err.status = res.status
          throw err
        }
        return res.json()
      })
      .then(function (data) {
        offset = data.next_offset
        if (data.content) {
          buffer = appendLog(buffer, data.content)
          render()
        }
        return data.active
      })
  }

  function poll() {
    if (stopped) return
    if (timedOut(startedAt, Date.now())) {
      stopped = true
      setStatus('Paused after 3 minutes to save memory.')
      reconnectBtn.hidden = false
      reconnectBtn.focus()
      return
    }
    read()
      .then(function (active) {
        if (active === false) {
          // The run just ended: one final drain so its last lines render.
          return read().then(function () {
            setStatus('Run finished.')
          })
        }
        setTimeout(poll, POLL_MS)
      })
      .catch(function (err) {
        if (err && err.status === 404) {
          setStatus('This run’s output is no longer available.')
          return
        }
        // Transient (farm restarting, network blip): keep polling.
        setTimeout(poll, POLL_MS)
      })
  }

  reconnectBtn.addEventListener('click', function () {
    reconnectBtn.hidden = true
    setStatus('')
    stopped = false
    startedAt = Date.now()
    poll()
  })

  poll()
}

export function clientScript() {
  return [
    `var POLL_MS = ${POLL_MS};`,
    `var LOG_KEEP_CHARS = ${LOG_KEEP_CHARS};`,
    `var TIMEOUT_MS = ${TIMEOUT_MS};`,
    `var appendLog = ${appendLog.toString()};`,
    `var timedOut = ${timedOut.toString()};`,
    `(${clientMain.toString()})();`,
  ].join('\n')
}
