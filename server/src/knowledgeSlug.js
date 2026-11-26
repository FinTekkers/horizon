// HZ-537: the doc slug of a knowledge source — the `<doc>` of a
// `<doc>#<section>` citation. Pure, so quantResources.js can derive it
// without knowledgeDocs.js and its DB; knowledgeDocs.js re-exports it.
//
// Two projects naming the same repo and path share one slug. Any other repo or
// path gets another slug: the readable part can collide ('a-b/x.pdf' vs
// 'a/b-x.pdf'), so a hash of the exact repo and path ends it.

import { createHash } from 'node:crypto'

const slugPart = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// 'FinTekkers/docs' + 'specs/bond-spec.pdf' -> 'fintekkers-docs__specs-bond-spec-<10 hex>'.
// The readable part is capped so the slug stays within the route's 200 chars.
export function knowledgeSlug(repo, path) {
  const readable = `${slugPart(repo)}__${slugPart(path.replace(/\.pdf$/i, ''))}`.slice(0, 160)
  const hash = createHash('sha256').update(`${repo}\n${path}`).digest('hex').slice(0, 10)
  return `${readable}-${hash}`
}
