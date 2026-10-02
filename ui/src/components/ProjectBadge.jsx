// The project an item belongs to (HZ-208), on every board card and tracker
// header. Clamped by .proj-badge so a long name never widens its row; the
// full name is in the tooltip. Local demo items have no project and no badge.
export default function ProjectBadge({ projectId, projects }) {
  if (projectId == null) return null
  const project = (projects || []).find((p) => p.id === projectId)
  if (!project) return null
  return (
    <span className="proj-badge" title={project.name}>
      {project.name}
    </span>
  )
}
