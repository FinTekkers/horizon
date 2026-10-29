// HZ-642: Approve & file's one Autopilot choice for every item the Plan files.
// "Off for these items" files each issue with the autopilot-off label. It
// only changes anything in a project whose Autopilot is on (caretaker.js's
// itemOff), so in an off or shadow project the select is disabled and says
// why. The server checks the mode again at approval.
export const FILED_AUTOPILOT_LABEL = 'Autopilot for filed items'

export default function FiledAutopilotSelect({ item, value = 'default', onChange }) {
  const mode = item.projectAutopilot ?? 'off'
  const disabled = mode !== 'on'
  const selectId = `filed-autopilot-${item.id}`
  const noteId = `${selectId}-note`
  return (
    <div className="step-card__persona">
      <label className="step-card__persona-label" htmlFor={selectId}>
        {FILED_AUTOPILOT_LABEL}
      </label>
      <select
        id={selectId}
        className="step-card__persona-select"
        value={disabled ? 'default' : value}
        disabled={disabled}
        aria-describedby={disabled ? noteId : undefined}
        onChange={(e) => onChange?.(item.id, e.target.value)}
      >
        <option value="default">Project default ({mode === 'on' ? 'On' : mode === 'shadow' ? 'Shadow' : 'Off'})</option>
        <option value="off">Off for these items</option>
      </select>
      {disabled && (
        <span id={noteId} className="step-card__persona-label">
          Autopilot is {mode} for this project
        </span>
      )}
    </div>
  )
}
