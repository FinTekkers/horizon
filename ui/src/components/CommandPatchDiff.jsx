// HO-843: what a per-command re-approval at Approve the run approves — the
// one patched command, old and new, and nothing else of the plan. The server
// sends it as item.runPlan.commandPatch ({ index, count, before, after });
// index is 0-based, shown 1-based. Both lines render as React text only.
export default function CommandPatchDiff({ patch }) {
  return (
    <div className="command-patch" data-testid="command-patch">
      <div className="command-patch__title">
        Command {patch.index + 1} of {patch.count} changed
      </div>
      <pre className="command-patch__diff">
        <code className="command-patch__line command-patch__line--removed" aria-label={`Old command ${patch.index + 1}`}>
          − {patch.before}
        </code>
        {'\n'}
        <code className="command-patch__line command-patch__line--added" aria-label={`New command ${patch.index + 1}`}>
          + {patch.after}
        </code>
      </pre>
      <div className="command-patch__note">Only this command needs your approval — the others keep theirs.</div>
    </div>
  )
}
