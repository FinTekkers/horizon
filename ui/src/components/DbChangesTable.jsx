// HZ-814: what a Task's run changed in its database — one row per table the
// run plan's `db_changes` declared, with its row count before and after the
// run and the rows inserted, updated and deleted. The view is the server's
// stepOutputs[Execute].job.dbChanges (server/src/orchestrator.js
// cleanDbChanges): table names, a status, a reason id and whole counts only,
// rendered as React text. A count Postgres could not report is "n/a".

const plain = (n) => (Number.isInteger(n) ? n.toLocaleString('en-US') : 'n/a')
const signed = (n) => (n > 0 ? `+${plain(n)}` : plain(n))

export default function DbChangesTable({ dbChanges, id }) {
  const tables = Array.isArray(dbChanges?.tables) ? dbChanges.tables : []
  if (tables.length === 0) return null
  return (
    <div className="db-changes" id={id} data-testid="db-changes">
      <div className="db-changes__title">
        Database changes · {tables.length} table{tables.length === 1 ? '' : 's'}
      </div>
      <div className="data-table-wrap">
        <table className="data-table" aria-label="Database changes">
          <thead>
            <tr>
              <th scope="col">Table</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
              <th scope="col">Change</th>
              <th scope="col">Inserted</th>
              <th scope="col">Updated</th>
              <th scope="col">Deleted</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((row) => (
              <tr key={row.table}>
                <td>
                  <code className="data-table__ref">{row.table}</code>
                </td>
                {row.status === 'ok' ? (
                  <>
                    <td>{plain(row.before)}</td>
                    <td>{plain(row.after)}</td>
                    <td>{signed(row.after - row.before)}</td>
                    <td>{plain(row.inserted)}</td>
                    <td>{plain(row.updated)}</td>
                    <td>{plain(row.deleted)}</td>
                  </>
                ) : (
                  <td colSpan={6} className="db-changes__failed" title={row.reason}>
                    could not be counted
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="db-changes__source">Inserted, updated and deleted are from Postgres stats.</div>
    </div>
  )
}
