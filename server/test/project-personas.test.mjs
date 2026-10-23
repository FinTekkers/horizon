// HZ-535: project personas through the real Fastify app and store, with a
// temp HORIZON_FARM_DIR holding farm/projects/<slug>/personas.json.
//
// The database is created in the pre-HZ-535 shape first, so the
// definitions_enabled migration runs on real existing rows: they read 1.
// Every persona id below is fabricated except the global ones read off the
// domain binding.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { loginFixtureUser } from './helpers/session.mjs'
import { PERSONA_IDS, DEFAULT_PERSONAS } from '../../domain/js/personas.js'

const farmDir = mkdtempSync(join(tmpdir(), 'horizon-project-personas-farm-'))
process.env.HORIZON_FARM_DIR = farmDir
process.env.HORIZON_DB = join(mkdtempSync(join(tmpdir(), 'horizon-project-personas-')), 'test.db')
delete process.env.GITHUB_WEBHOOK_SECRET
delete process.env.FARM_URL

const QUANT = { id: 'quant', agent: 'eng', label: 'Quant', initials: 'QT', color: '#2E6CB2', model: 'MODEL', provider: 'claude', file: 'quant.md' }
const catalogue = (await import('../../domain/js/providers.js')).PROVIDERS
const CLAUDE_MODEL = catalogue.find((p) => p.name === 'claude').models[0].id

function writeProject(root, slug, personas, roleFiles = { 'quant.md': 'Think like a quant.\n' }) {
  mkdirSync(join(root, slug, 'personas'), { recursive: true })
  writeFileSync(join(root, slug, 'personas.json'), JSON.stringify({ personas }))
  for (const [file, text] of Object.entries(roleFiles)) writeFileSync(join(root, slug, 'personas', file), text)
}

writeProject(join(farmDir, 'projects'), 'acme-capital', [{ ...QUANT, model: CLAUDE_MODEL }])
// Same file, but this project's switch is turned off below.
writeProject(join(farmDir, 'projects'), 'switched-off', [{ ...QUANT, model: CLAUDE_MODEL }])

const old = new Database(process.env.HORIZON_DB)
old.exec(`
  CREATE TABLE project (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 0);
  INSERT INTO project (name, enabled) VALUES ('Acme Capital', 1), ('Other Co', 1), ('Switched Off', 1);
`)
old.close()

const { db } = await import('../src/db.js')
const { buildApp } = await import('../src/app.js')
const config = await import('../src/config.js')
const store = await import('../src/store.js')
const auth = await import('../src/auth.js')
const definitions = await import('../src/definitions.js')
const { PERSONA_DISPLAY } = await import('../src/personas.js')

const app = buildApp({ logger: false })
const owner = loginFixtureUser(auth, config, { email: 'owner@example.com', name: 'Owner' })
await app.ready()

const ACME = 1
const OTHER = 2
const OFF = 3
const insertItem = db.prepare("INSERT INTO work_item (id, title, priority, cursor, project_id) VALUES (?, ?, 'Medium', 3, ?)")
insertItem.run('AC-1', 'Acme item', ACME)
insertItem.run('OT-1', 'Other item', OTHER)
insertItem.run('SO-1', 'Switched-off item', OFF)
insertItem.run('AC-2', 'Acme item with global personas', ACME)

const setPersona = (id, agent, persona) =>
  app.inject({ method: 'POST', url: `/api/items/${id}/persona`, headers: { cookie: owner.cookie }, payload: { agent, persona } })

async function itemFromApi(id) {
  const res = await app.inject({ method: 'GET', url: '/api/items?v=2', headers: { cookie: owner.cookie } })
  assert.equal(res.statusCode, 200, res.body)
  return res.json().items.find((item) => item.id === id)
}

test('the definitions_enabled column defaults to 1 on rows that existed before it', () => {
  assert.deepEqual(
    db.prepare('SELECT name, definitions_enabled FROM project ORDER BY id').all(),
    [
      { name: 'Acme Capital', definitions_enabled: 1 },
      { name: 'Other Co', definitions_enabled: 1 },
      { name: 'Switched Off', definitions_enabled: 1 },
    ],
  )
  assert.equal(store.listProjects().find((p) => p.id === ACME).definitionsEnabled, true)
})

test('an item keeps a persona from its own project; another project’s item and an unknown id get bad_persona', async () => {
  const ok = await setPersona('AC-1', 'eng', 'acme-capital:quant')
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal((await itemFromApi('AC-1')).personas.eng, 'acme-capital:quant')
  assert.equal(store.getItem('AC-1').personas.eng, 'acme-capital:quant')

  const foreign = await setPersona('OT-1', 'eng', 'acme-capital:quant')
  assert.equal(foreign.statusCode, 409)
  assert.equal(foreign.json().error, 'bad_persona')

  const unknown = await setPersona('AC-1', 'eng', 'acme-capital:nope')
  assert.equal(unknown.json().error, 'bad_persona')
  // The id it already had is untouched.
  assert.equal((await itemFromApi('AC-1')).personas.eng, 'acme-capital:quant')
})

test('a resolved project persona takes its badge from the project file; items with none get {}', async () => {
  const item = await itemFromApi('AC-1')
  assert.deepEqual(item.personaBadges, { eng: { label: 'Quant', initials: 'QT', color: '#2E6CB2' } })
  assert.equal(Object.hasOwn(PERSONA_DISPLAY.eng, 'acme-capital:quant'), false)
  assert.deepEqual((await itemFromApi('AC-2')).personaBadges, {})
  assert.deepEqual((await itemFromApi('OT-1')).personaBadges, {})
  // The audit text names the project persona, not the agent's default.
  const events = db.prepare("SELECT text FROM event WHERE item_id = 'AC-1'").all().map((e) => e.text)
  assert.ok(events.includes('set the eng specialist persona to Quant'), JSON.stringify(events))
  // models.personas carries the file's model and provider, keyed <agent>.<slug>:<id>.
  const overlay = store.projectOverlayFor(ACME)
  assert.deepEqual(overlay.models, { 'eng.acme-capital:quant': CLAUDE_MODEL })
  assert.deepEqual(overlay.providers, { 'eng.acme-capital:quant': 'claude' })
})

test('with the switch off, a real personas.json is ignored: null overlay, bad_persona, saved id dropped, {} badges, global compose', async () => {
  db.prepare("UPDATE work_item SET personas_json = ? WHERE id = 'SO-1'").run(JSON.stringify({ eng: 'switched-off:quant' }))
  const saved = await app.inject({
    method: 'POST',
    url: `/api/projects/${OFF}/definitions-enabled`,
    headers: { cookie: owner.cookie, 'x-human-key': owner.pin },
    payload: { enabled: false },
  })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.deepEqual(saved.json(), { ok: true, projectId: OFF, old: true, new: false })
  assert.deepEqual(
    db.prepare("SELECT kind, old_value, new_value FROM project_event WHERE project_id = ? AND kind = 'definitions_enabled'").all(OFF),
    [{ kind: 'definitions_enabled', old_value: '1', new_value: '0' }],
  )

  assert.equal(definitions.projectPersonaOverlay({ name: 'Switched Off', definitions_enabled: 0 }), null)
  assert.equal(store.projectOverlayFor(OFF), null)
  assert.equal((await setPersona('SO-1', 'eng', 'switched-off:quant')).json().error, 'bad_persona')
  const item = await itemFromApi('SO-1')
  assert.deepEqual(item.personas, {})
  assert.deepEqual(item.personaBadges, {})

  // Composed text is byte-identical to a project with no file at all.
  const role = 'ROLE TEXT\n'
  const off = definitions.composeRole(role, 'eng', 'switched-off:quant', store.projectOverlayFor(OFF))
  const noFile = definitions.composeRole(role, 'eng', 'switched-off:quant', definitions.projectPersonaOverlay({ name: 'No File Co', definitions_enabled: 1 }))
  assert.equal(off, noFile)
  assert.equal(off, definitions.composeRole(role, 'eng', 'switched-off:quant'))
})

test('loading a personas.json whose id equals a global persona id fails, and the error names that id', () => {
  const root = mkdtempSync(join(tmpdir(), 'horizon-project-personas-collide-'))
  const globalId = PERSONA_IDS.eng[1]
  writeProject(root, 'acme', [{ ...QUANT, id: globalId, model: CLAUDE_MODEL }])
  assert.throws(() => definitions.loadProjectPersonas('acme', root), (err) => {
    assert.ok(err.message.includes(`"${globalId}"`), err.message)
    assert.ok(err.message.includes(`eng.${globalId}`), err.message)
    return true
  })
  assert.notEqual(globalId, DEFAULT_PERSONAS.eng, 'sanity: the collision is not only with the default')
})

test('the credential lint runs on personas.json and on every role file, and names the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'horizon-project-personas-lint-'))
  const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
  writeProject(root, 'in-json', [{ ...QUANT, model: CLAUDE_MODEL, label: `Quant ${key}` }])
  assert.throws(() => definitions.loadProjectPersonas('in-json', root), /farm\/projects\/in-json\/personas\.json: credential lint refused it \(AWS access key id\)/)

  writeProject(
    root,
    'second-md',
    [
      { ...QUANT, model: CLAUDE_MODEL },
      { ...QUANT, id: 'risk', label: 'Risk', file: 'risk.md', model: CLAUDE_MODEL },
    ],
    { 'quant.md': 'clean\n', 'risk.md': `aws key ${key}\n` },
  )
  assert.throws(() => definitions.loadProjectPersonas('second-md', root), /farm\/projects\/second-md\/personas\/risk\.md: credential lint refused it/)
  // A load error never reaches a board read: the project runs on the global personas.
  assert.equal(definitions.loadProjectPersonas('absent', root), null)
})
