// HZ-462: a Plan's Inventory step output as tables — the current state of each
// repo in scope, then the key facts that cut across them. The rows come from
// the fenced block farm/step_agent.py appends to the artifact (447a's fixed
// format, read by domain/js/planInventory.js). Every value renders as React
// text: the artifact is agent output, so no raw HTML.
import { parseInventory } from '../../../domain/js/planInventory.js'

const TOPIC_LABELS = { storage: 'Storage', data_flow: 'Data flow', infrastructure: 'Infrastructure', other: 'Other' }

function Lines({ lines }) {
  if (lines.length === 0) return '—'
  return (
    <ul>
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  )
}

function Evidence({ evidence }) {
  return (
    <ul>
      {evidence.map((e, i) => (
        <li key={i}>
          <code className="data-table__ref">{e.ref}</code> {e.kind} · {e.note}
        </li>
      ))}
    </ul>
  )
}

export default function PlanInventoryTables({ artifact }) {
  const inventory = parseInventory(artifact)
  if (!inventory) return null
  return (
    <>
      <div className="data-table-wrap">
        <table className="data-table" aria-label="Current state per repo">
          <thead>
            <tr>
              <th scope="col">Repo</th>
              <th scope="col">Has now</th>
              <th scope="col">Gaps</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {inventory.repos.map((row, i) => (
              <tr key={i}>
                <td>{row.repo}</td>
                <td>
                  <Lines lines={row.has} />
                </td>
                <td>
                  <Lines lines={row.gaps} />
                </td>
                <td>
                  <Evidence evidence={row.evidence} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {inventory.key_facts.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table" aria-label="Key facts">
            <thead>
              <tr>
                <th scope="col">Topic</th>
                <th scope="col">Fact</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {inventory.key_facts.map((fact, i) => (
                <tr key={i}>
                  <td>{Object.hasOwn(TOPIC_LABELS, fact.topic) ? TOPIC_LABELS[fact.topic] : fact.topic}</td>
                  <td>{fact.fact}</td>
                  <td>
                    <Evidence evidence={fact.evidence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
