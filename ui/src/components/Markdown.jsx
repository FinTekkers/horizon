// HZ-153: item descriptions, success metrics and guardrails are copied
// verbatim out of GitHub issue bodies, so they are untrusted input that
// happens to be written in markdown.
//
// We call marked's *lexer* only — never marked.parse() — and map the token
// tree onto React elements. No HTML string is ever produced, so there is
// nothing to sanitise, dangerouslySetInnerHTML is never reached for, and a
// token type we don't map can only ever degrade to its own literal source
// text (which React escapes). That is why `<script>alert(1)</script>` in a
// description shows up as visible, inert text instead of vanishing.
//
// server/src/app.js renders artifact pages with marked on the same major
// version, so the tracker speaks the same markdown dialect as those.
//
// HZ-546: given a `linkContext` (domain/js/codeRefs.js's buildLinkContext), a
// code span that is a well-formed code reference links to GitHub at the
// step's recorded sha, and a known item id links to its Horizon page. Without
// one, the output is exactly what it was before.

import { Fragment } from 'react'
import { marked } from 'marked'
import { codeRefUrl, parseCodeRef, splitItemIds } from '../../../domain/js/codeRefs.js'

// Allowlist, not a blocklist. javascript:, data:, and protocol-relative
// //host URLs are all rejected and render as plain text — only a scheme we
// named can produce a clickable <a>.
function safeHref(href) {
  const value = String(href ?? '').trim()
  return /^(?:https?:|mailto:)/i.test(value) ? value : null
}

// Plain text with each known item id as a link; the text itself when there
// is no context or no known id in it.
function linkIds(text, ctx, key) {
  if (!ctx) return text
  const pieces = splitItemIds(text, ctx)
  if (!pieces.some((piece) => piece.id)) return text
  return pieces.map((piece, i) =>
    piece.id ? (
      <a key={`${key}.id${i}`} href={piece.href}>
        {piece.id}
      </a>
    ) : (
      piece.text
    ),
  )
}

// A code span's link: a code reference's GitHub URL, or the page of the one
// known item id the span holds. Null without a context.
function codespanHref(text, ctx) {
  if (!ctx) return null
  const url = codeRefUrl(parseCodeRef(text), ctx)
  if (url) return url
  const pieces = splitItemIds(text.trim(), ctx)
  return pieces.length === 1 && pieces[0].id ? pieces[0].href : null
}

// Inline tokens -> React nodes. `html` lands in the default branch on
// purpose: an <img src=x onerror=...> written mid-sentence is an *inline*
// html token, and it has to become text exactly like a block-level one.
// `ctx` is the HZ-546 link context, or null for no links.
function renderInline(tokens, keyPrefix, ctx = null) {
  return (tokens || []).map((token, i) => {
    const key = `${keyPrefix}.${i}`
    switch (token.type) {
      case 'text':
      case 'escape':
        // A text token inside a list item carries its own nested tokens;
        // one inside a paragraph is already flat.
        if (token.tokens) return <Fragment key={key}>{renderInline(token.tokens, key, ctx)}</Fragment>
        return ctx ? <Fragment key={key}>{linkIds(token.text, ctx, key)}</Fragment> : token.text
      case 'strong':
        return <strong key={key}>{renderInline(token.tokens, key, ctx)}</strong>
      case 'em':
        return <em key={key}>{renderInline(token.tokens, key, ctx)}</em>
      case 'del':
        return <del key={key}>{renderInline(token.tokens, key, ctx)}</del>
      case 'codespan': {
        const href = codespanHref(token.text, ctx)
        if (!href) return <code key={key}>{token.text}</code>
        return (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            <code>{token.text}</code>
          </a>
        )
      }
      case 'br':
        return <br key={key} />
      case 'checkbox':
        return <input key={key} type="checkbox" checked={!!token.checked} disabled readOnly />
      case 'link': {
        const href = safeHref(token.href)
        // No context inside a link's label, so nothing in it links twice.
        const label = renderInline(token.tokens, key)
        // A rejected link keeps its visible label — dropping it would hide
        // content, which is a worse outcome than an unclickable phrase.
        if (!href) return <Fragment key={key}>{label}</Fragment>
        return (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        )
      }
      case 'image':
        // Markdown images render as their alt text. An untrusted description
        // must not be able to make this page fetch a remote URL.
        return <Fragment key={key}>{token.text || token.href || ''}</Fragment>
      default:
        return <Fragment key={key}>{token.raw ?? ''}</Fragment>
    }
  })
}

function renderListItem(item, key, ctx) {
  return (item.tokens || []).map((token, j) => {
    const childKey = `${key}.${j}`
    // Inline-ish content of a list item stays unwrapped, so a tight list
    // doesn't pick up paragraph margins between its own bullets.
    if (token.type === 'text' || token.type === 'checkbox') {
      return <Fragment key={childKey}>{renderInline([token], childKey, ctx)}</Fragment>
    }
    return <Fragment key={childKey}>{renderBlocks([token], childKey, ctx)}</Fragment>
  })
}

// Block tokens -> React elements.
function renderBlocks(tokens, keyPrefix, ctx = null) {
  const out = []
  ;(tokens || []).forEach((token, i) => {
    const key = `${keyPrefix}.${i}`
    switch (token.type) {
      case 'space':
        return
      case 'heading': {
        // Clamped to h3-h6. An untrusted `# heading` in an issue body must
        // never outrank the item title in the page's heading outline; the
        // matching sizes live under .md-body in index.css.
        const Tag = `h${Math.min(token.depth + 2, 6)}`
        out.push(<Tag key={key}>{renderInline(token.tokens, key, ctx)}</Tag>)
        return
      }
      case 'paragraph':
        out.push(<p key={key}>{renderInline(token.tokens, key, ctx)}</p>)
        return
      case 'text':
        out.push(
          <p key={key}>{token.tokens ? renderInline(token.tokens, key, ctx) : linkIds(token.text, ctx, key)}</p>,
        )
        return
      case 'list': {
        const Tag = token.ordered ? 'ol' : 'ul'
        const start = token.ordered && Number(token.start) > 1 ? { start: Number(token.start) } : {}
        out.push(
          <Tag key={key} {...start}>
            {(token.items || []).map((item, j) => (
              <li key={`${key}.${j}`}>{renderListItem(item, `${key}.${j}`, ctx)}</li>
            ))}
          </Tag>,
        )
        return
      }
      case 'code':
        out.push(
          <pre key={key}>
            <code>{token.text}</code>
          </pre>,
        )
        return
      case 'blockquote':
        out.push(<blockquote key={key}>{renderBlocks(token.tokens, key, ctx)}</blockquote>)
        return
      case 'hr':
        out.push(<hr key={key} />)
        return
      case 'br':
        out.push(<br key={key} />)
        return
      default:
        // Raw HTML, GFM tables, link-reference definitions — anything we
        // haven't mapped shows its own source text. Never blank, never live.
        // A known item id in it (a GFM table cell) still links.
        out.push(<p key={key}>{linkIds(token.raw ?? '', ctx, key)}</p>)
    }
  })
  return out
}

export default function Markdown({ text, className, linkContext = null }) {
  if (typeof text !== 'string' || text.trim() === '') return null

  let blocks
  try {
    blocks = renderBlocks(marked.lexer(text), 'md', linkContext)
  } catch {
    // The lexer choking on a pathological description must not blank the
    // whole item page — fall back to the pre-HZ-153 behaviour.
    blocks = [<p key="md.raw">{text}</p>]
  }

  return <div className={className ? `md-body ${className}` : 'md-body'}>{blocks}</div>
}
