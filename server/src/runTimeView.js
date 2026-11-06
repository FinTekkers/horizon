// HZ-803: when a run started and finished, at the top of the artifact and
// output pages (server/src/app.js). The page prints the stored UTC time inside
// <time datetime>; clientScript() rewrites it in the viewer's timezone with
// the same formatter the step cards use (domain/js/runTime.js). With scripts
// off the UTC text stays. Tested by server/test/runTimeView.test.mjs.

import { parseStoredUtc, runTimeText } from '../../domain/js/runTime.js'

// Rebuilt from the parsed time, never the stored text, so the markup holds
// only digits, '-', ':', 'T' and 'Z' and needs no escaping.
function timeTag(stored) {
  const ms = parseStoredUtc(stored)
  if (ms === null) return null
  const iso = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `<time datetime="${iso}">${iso.slice(0, 16).replace('T', ' ')} UTC</time>`
}

// "started <time> · finished <time>"; a part with no stored time is left out,
// and '' when the run has neither.
export function runTimesHtml(run) {
  const started = timeTag(run.started_at)
  const finished = timeTag(run.ended_at)
  return [started && `started ${started}`, finished && `finished ${finished}`].filter(Boolean).join(' · ')
}

// Runs in the browser. Content is written via .textContent only.
function clientMain() {
  const els = document.querySelectorAll('time[datetime]')
  for (let i = 0; i < els.length; i++) {
    const text = runTimeText(els[i].getAttribute('datetime'), Date.now())
    if (text) {
      els[i].title = els[i].textContent
      els[i].textContent = text
    }
  }
}

export function clientScript() {
  return [parseStoredUtc, runTimeText, clientMain].map((fn) => fn.toString()).join('\n') + '\nclientMain()'
}
