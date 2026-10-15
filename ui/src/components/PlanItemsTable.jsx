import { Fragment, useEffect, useRef, useState } from 'react'
import { PRIORITIES } from '../../../domain/js/priorities.js'
import { ITEM_KIND_INFO, LANES, laneOf } from '../../../domain/js/lifecycle.js'
import { getPlanDraft, savePlanDraft } from '../api'
import { itemHref } from './DependencyBadge'

// HZ-449: a Plan's one items table, in both of its states. Before filing it
// is the Approve & file card's editable table: each row's Edit opens its
// draft for editing, and every save sends the whole draft to the server
// (PUT /api/items/:id/plan-draft), which re-validates it. After filing the
// same table is read-only, and its last column is "Filed as": each draft's
// real key. The server is the only judge of both: `editable` and `filed`
// come from GET /plan-draft, never from the item's cursor.

const STALE_NOTE = 'Draft changed in another tab — reloaded'
const SAVE_ERRORS = {
  pin_needed: 'Enter your gate PIN to save the draft.',
  human_gate_key_required: 'The gate PIN was not accepted — the draft was not saved.',
  not_editable: 'The draft can no longer be edited.',
  run_active: 'A step is running on this Plan — try again when it finishes.',
  network: 'The server did not answer — the draft was not saved.',
}

const short = (repo) => repo.split('/').pop()
const toLines = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
const toList = (text) =>
  text
    .split(',')
    .map((dep) => dep.trim())
    .filter(Boolean)

// The form's text for one draft.
function formOf(d) {
  return {
    title: d.title,
    outcome: d.outcome,
    metric: d.metric.join('\n'),
    guardrails: d.guardrails.join('\n'),
    must_also_cover: d.must_also_cover.join('\n'),
    depends_on: d.depends_on.join(', '),
    priority: d.priority ?? '',
    kind: d.kind ?? '',
    trivial: d.lane !== undefined,
  }
}

// The draft the form describes. Optional fields left empty stay absent.
function draftOf(d, form) {
  const { priority: _p, kind: _k, lane: _l, ...rest } = d
  const lane = form.trivial ? LANES[0] : null
  return {
    ...rest,
    title: form.title.trim(),
    outcome: form.outcome.trim(),
    metric: toLines(form.metric),
    guardrails: toLines(form.guardrails),
    must_also_cover: toLines(form.must_also_cover),
    depends_on: toList(form.depends_on),
    ...(form.priority ? { priority: form.priority } : {}),
    ...(form.kind ? { kind: form.kind } : {}),
    ...(lane ? { lane } : {}),
  }
}

// The whole draft without row `id`, and without it in any other row's
// dependencies.
export function dropRow(doc, id) {
  return {
    ...doc,
    items: doc.items.filter((d) => d.id !== id).map((d) => ({ ...d, depends_on: d.depends_on.filter((dep) => dep !== id) })),
  }
}

function Field({ label, children }) {
  return (
    <label className="field" style={{ display: 'block' }}>
      <div className="field__label">{label}</div>
      {children}
    </label>
  )
}

function EditRow({ draft, busy, onSave, onDrop, onCancel }) {
  const [form, setForm] = useState(() => formOf(draft))
  const set = (name) => (e) => setForm({ ...form, [name]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  // The trivial lane is a change's only: offered for a change, kept off otherwise.
  const laneKind = laneOf({ kind: form.kind || 'change', lane: LANES[0] })
  return (
    <tr>
      <td colSpan={6}>
        <form
          aria-label={`Edit ${draft.id}`}
          onSubmit={(e) => {
            e.preventDefault()
            onSave(draftOf(draft, laneKind ? form : { ...form, trivial: false }))
          }}
        >
          <Field label="Title">
            <input className="field__input" value={form.title} onChange={set('title')} />
          </Field>
          <Field label="Outcome">
            <textarea className="field__input field__textarea" value={form.outcome} onChange={set('outcome')} />
          </Field>
          <Field label="Success metric (one per line)">
            <textarea className="field__input field__textarea field__textarea--short" value={form.metric} onChange={set('metric')} />
          </Field>
          <Field label="Guardrails (one per line)">
            <textarea className="field__input field__textarea field__textarea--short" value={form.guardrails} onChange={set('guardrails')} />
          </Field>
          <Field label="Must also cover (one per line)">
            <textarea className="field__input field__textarea field__textarea--short" value={form.must_also_cover} onChange={set('must_also_cover')} />
          </Field>
          <Field label="Depends on (#n or an existing key, comma-separated)">
            <input className="field__input" value={form.depends_on} onChange={set('depends_on')} />
          </Field>
          <Field label="Priority">
            <select className="field__input" value={form.priority} onChange={set('priority')}>
              <option value="">The Plan's priority</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Kind">
            <select className="field__input" value={form.kind} onChange={set('kind')}>
              <option value="">{ITEM_KIND_INFO[0].label} (default)</option>
              {ITEM_KIND_INFO.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          {laneKind && (
            <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={form.trivial} onChange={set('trivial')} />
              <span className="field__label" style={{ margin: 0 }}>
                {laneKind} lane
              </span>
            </label>
          )}
          <div className="step-card__actions">
            <button type="submit" className="btn-gate-approve" disabled={busy} aria-busy={busy || undefined}>
              Save
            </button>
            <button type="button" className="btn-gate-feedback" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn-gate-reject" disabled={busy} onClick={onDrop}>
              Drop row
            </button>
          </div>
        </form>
      </td>
    </tr>
  )
}

export default function PlanItemsTable({ item }) {
  const [draft, setDraft] = useState(null)
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const saving = useRef(false)
  const { id, cursor, paused } = item

  const load = () =>
    getPlanDraft(id).then(
      (next) => setDraft(next),
      () => setDraft(null),
    )
  // Again whenever the item moves, so the table turns read-only once filed.
  useEffect(() => {
    let open = true
    getPlanDraft(id).then(
      (next) => open && setDraft(next),
      () => open && setDraft(null),
    )
    return () => {
      open = false
    }
  }, [id, cursor, paused])

  if (!draft) return null
  const filed = draft.filed ?? {}
  const isFiled = Object.keys(filed).length > 0
  const keyOf = (ref) => (Object.hasOwn(filed, ref) && filed[ref].key) || ref

  const save = (doc) => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setMessage(null)
    savePlanDraft(id, draft.version, doc)
      .then(
        (saved) => {
          setDraft({ ...draft, version: saved.version, doc: saved.doc })
          setEditing(null)
        },
        (err) => {
          if (err?.message === 'stale_version') {
            setEditing(null)
            setMessage({ kind: 'status', text: STALE_NOTE })
            return load()
          }
          const detail = err?.errors?.[0]?.message
          setMessage({ kind: 'alert', text: detail || SAVE_ERRORS[err?.message] || 'The draft was not saved — try again.' })
          return undefined
        },
      )
      .finally(() => {
        saving.current = false
        setBusy(false)
      })
  }

  return (
    <div style={{ marginTop: 12 }}>
      {message && (
        <div role={message.kind} className={message.kind === 'alert' ? 'field__error' : 'field__help'} style={{ marginBottom: 8 }}>
          {message.text}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" aria-label="Plan items">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Repo</th>
              <th scope="col">Title</th>
              <th scope="col">Depends on</th>
              <th scope="col">Must also cover</th>
              <th scope="col">{isFiled ? 'Filed as' : 'Edit'}</th>
            </tr>
          </thead>
          <tbody>
            {draft.doc.items.map((d) => (
              <Fragment key={d.id}>
                <tr>
                  <td>
                    <code>{d.id}</code>
                  </td>
                  <td title={d.repo}>{short(d.repo)}</td>
                  <td>{d.title}</td>
                  <td>
                    <code>{d.depends_on.length ? d.depends_on.map(isFiled ? keyOf : (dep) => dep).join(', ') : '—'}</code>
                  </td>
                  <td>{d.must_also_cover.length ? d.must_also_cover.join('; ') : '—'}</td>
                  <td>
                    {isFiled ? (
                      filed[d.id]?.key ? (
                        <a href={itemHref(filed[d.id].key)}>{filed[d.id].key}</a>
                      ) : (
                        <span className="field__error" style={{ margin: 0 }}>
                          {filed[d.id]?.error || 'Not filed yet'}
                        </span>
                      )
                    ) : (
                      <button
                        type="button"
                        className="btn-step-feedback"
                        disabled={!draft.editable || busy || editing !== null}
                        aria-label={`Edit ${d.id}`}
                        onClick={() => {
                          setMessage(null)
                          setEditing(d.id)
                        }}
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
                {editing === d.id && !isFiled && (
                  <EditRow
                    draft={d}
                    busy={busy}
                    onSave={(next) => save({ ...draft.doc, items: draft.doc.items.map((x) => (x.id === d.id ? next : x)) })}
                    onDrop={() => save(dropRow(draft.doc, d.id))}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
