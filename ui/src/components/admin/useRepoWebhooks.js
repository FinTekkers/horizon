import { useCallback, useEffect, useRef, useState } from 'react'
import { getRepoWebhooks } from '../../api'

const repoKeyOf = (project) => project.repos.map((r) => r.repo).join(',')

// HZ-244 / HZ-764: live webhook status for every project's repos, one
// getRepoWebhooks call per project that has repos. AdminPage owns it, so Needs
// attention and each project page read the same map. A project is re-read only
// when its repo list changes (a connect or disconnect) or on refresh(id) after
// a Fix, never on a tab or page switch.
//
// byProject[id] is { webhooks: { [repo]: row }, error } once that read
// settles; `settled` is true once every project with repos has settled. A read
// that never answers keeps `settled` false — AdminPage's landing rule waits
// for it only so long.
export function useRepoWebhooks(projects, enabled) {
  const [byProject, setByProject] = useState({})
  const fetched = useRef(new Map())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback((projectId, repoKey) => {
    const set = (entry) => mounted.current && setByProject((prev) => ({ ...prev, [projectId]: entry }))
    if (!repoKey) return set({ webhooks: {}, error: null })
    return getRepoWebhooks(projectId)
      .then((result) => set({ webhooks: Object.fromEntries((result.webhooks || []).map((w) => [w.repo, w])), error: null }))
      .catch((err) => set({ webhooks: null, error: err.message }))
  }, [])

  const allKeys = projects.map((p) => `${p.id}:${repoKeyOf(p)}`).join('|')
  useEffect(() => {
    if (!enabled) return
    for (const p of projects) {
      const repoKey = repoKeyOf(p)
      if (fetched.current.has(p.id) && fetched.current.get(p.id) === repoKey) continue
      fetched.current.set(p.id, repoKey)
      load(p.id, repoKey)
    }
    // `allKeys` stands for the ids and repo lists the loop reads.
  }, [enabled, allKeys, load])

  const refresh = useCallback(
    (projectId) => {
      const project = projects.find((p) => p.id === projectId)
      return project ? load(projectId, repoKeyOf(project)) : undefined
    },
    [allKeys, load],
  )

  const settled = projects.every((p) => p.repos.length === 0 || Object.hasOwn(byProject, p.id))
  return { byProject, settled, refresh }
}
