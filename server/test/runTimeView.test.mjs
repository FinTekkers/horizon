// HZ-803: server/src/runTimeView.js — the started/finished times at the top
// of the artifact and output pages, and the browser script that rewrites them
// in the viewer's timezone. The script is run in node:vm against stub <time>
// elements, so a formatter edit that adds an import or a closure (which the
// embedded source cannot carry) fails here, not only in a real browser.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { runTimesHtml, clientScript } from '../src/runTimeView.js'

test('runTimesHtml prints each stored time as UTC inside <time datetime>', () => {
  assert.equal(
    runTimesHtml({ started_at: '2026-11-05 19:52:10', ended_at: '2026-11-05 20:06:41' }),
    'started <time datetime="2026-11-05T19:52:10Z">2026-11-05 19:52 UTC</time> · ' +
      'finished <time datetime="2026-11-05T20:06:41Z">2026-11-05 20:06 UTC</time>',
  )
})

test('runTimesHtml leaves out a missing time, and is empty with neither', () => {
  assert.equal(runTimesHtml({ started_at: '2026-11-05 19:52:10', ended_at: null }), 'started <time datetime="2026-11-05T19:52:10Z">2026-11-05 19:52 UTC</time>')
  assert.equal(runTimesHtml({ started_at: null, ended_at: '2026-11-05 20:06:41' }), 'finished <time datetime="2026-11-05T20:06:41Z">2026-11-05 20:06 UTC</time>')
  assert.equal(runTimesHtml({ started_at: null, ended_at: null }), '')
  assert.equal(runTimesHtml({}), '')
})

test('runTimesHtml never copies the stored text into the markup', () => {
  assert.equal(runTimesHtml({ started_at: '<script>alert(1)</script>', ended_at: '"><img src=x>' }), '')
})

test('clientScript rewrites each <time datetime> in the viewer’s timezone, keeping the UTC text as its title', () => {
  const el = { textContent: '2026-11-05 20:06 UTC', title: '', getAttribute: (name) => (name === 'datetime' ? '2026-11-05T20:06:00Z' : null) }
  const document = { querySelectorAll: (sel) => (sel === 'time[datetime]' ? [el] : []) }
  const FixedDate = class extends Date {
    static now() {
      return Date.parse('2026-11-06T16:06:00Z')
    }
  }
  // A bare context: only what a page would have. Its Intl uses the host zone,
  // so the vm runs with an explicit UTC default for the absolute part.
  const context = vm.createContext({
    document,
    Date: FixedDate,
    Math,
    Number,
    Intl: {
      DateTimeFormat: function (locale, options) {
        return new Intl.DateTimeFormat(locale, { ...options, timeZone: options.timeZone ?? 'UTC' })
      },
    },
  })
  vm.runInContext(clientScript(), context)
  assert.equal(el.textContent, '5 Nov 20:06 · 20 h ago')
  assert.equal(el.title, '2026-11-05 20:06 UTC')
})
