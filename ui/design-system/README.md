# Horizon Aura Design System

A Horizon UI foundation themed with the Pantone **Aura** palette.

## Files
- **Aura Design System.dc.html** — the reusable system: color tokens, surface/border tokens, the DM Sans type scale, and components (buttons, semantic buttons, status badges, inputs, stat card, progress bars, chart palette, nav items, promo card, data table). Fully static — open directly in a browser.
- **Main Dashboard.dc.html** — an example screen built on the system.
- **horizon-icon.svg** — the Horizon app icon as a standalone SVG: the top-bar logo tile (`.topbar__logo` in `ui/src/index.css`, a Super Sonic → Açaí gradient) with the white `GridIcon` from `ui/src/components/icons.jsx`. Keep it in step with those two if the logo changes.
- **horizon-icon-512.png** — the same icon rendered as a 512×512 PNG (transparent outside the rounded tile), for places that need a raster image. Re-render it from `horizon-icon.svg` if the icon changes.
- **support.js** — runtime helper used by the `.dc.html` files (loaded via `<script src="./support.js">`).

## Aura palette (Pantone TCX)
| Token | Role | Pantone | Hex |
|---|---|---|---|
| Super Sonic | Primary / brand | 18-4143 | `#2E6CB2` |
| Açaí | Deep / heading | 19-3628 | `#38294F` |
| Deep Lake | Success | 18-4834 | `#0E6E74` |
| Symphonic Sunset | Warning | 15-0954 | `#DFA200` |
| Garnet | Danger | 19-1655 | `#9C333E` |
| Orchid Bloom | Accent | 14-3612 | `#C9B4D9` |
| Anthracite | Ink | 19-4007 | `#2A2A2E` |
| Liquid Luster | Muted | 20-0006 | `#8C8C8E` |

Surfaces: canvas `#F3F1F8`, surface `#FFFFFF`, subtle `#F0ECF6`, border `#ECE7F3`.
Type: **DM Sans** (DM Mono for code/spec labels).

> Hex values are close approximations of the Pantone TCX standards.
