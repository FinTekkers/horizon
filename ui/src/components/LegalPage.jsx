// Public legal pages: /privacy and /terms. App.jsx routes these BEFORE its
// login gate, so they render for signed-out visitors. The text lives in
// ui/src/legal/*.md and goes through the same safe Markdown renderer as item
// descriptions.
import Markdown from './Markdown'
import { GridIcon } from './icons'
import privacy from '../legal/privacy.md?raw'
import terms from '../legal/terms.md?raw'

export const LEGAL_DOCS = {
  privacy: { path: '/privacy', label: 'Privacy Policy', text: privacy },
  terms: { path: '/terms', label: 'Terms of Service', text: terms },
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

// Markdown.jsx clamps headings to h3 so issue text can never outrank a page
// title. A legal page needs a real title, so the document's leading
// "# Heading" line becomes the page <h1> and the rest is rendered as body.
function splitTitle(text) {
  const match = /^#\s+(.+)\n+/.exec(text)
  return match ? { title: match[1].trim(), body: text.slice(match[0].length) } : { title: '', body: text }
}

export function LegalLinks({ className = 'legal-links' }) {
  return (
    <nav className={className} aria-label="Legal">
      <a href={`${BASE}${LEGAL_DOCS.privacy.path}`}>{LEGAL_DOCS.privacy.label}</a>
      <a href={`${BASE}${LEGAL_DOCS.terms.path}`}>{LEGAL_DOCS.terms.label}</a>
    </nav>
  )
}

export default function LegalPage({ doc }) {
  const { title, body } = splitTitle(LEGAL_DOCS[doc].text)
  return (
    <div className="legal">
      <header className="legal__header">
        <a className="legal__brand" href={`${BASE}/`}>
          <span className="topbar__logo">
            <GridIcon />
          </span>
          <span className="topbar__title">HORIZON</span>
        </a>
      </header>
      <main className="legal__card">
        <h1 className="legal__title">{title}</h1>
        <Markdown text={body} className="legal__body" />
      </main>
      <footer className="legal__footer">
        <LegalLinks />
      </footer>
    </div>
  )
}
