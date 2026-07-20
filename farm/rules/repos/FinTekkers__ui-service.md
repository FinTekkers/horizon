# FinTekkers/ui-service — repo rules

The web application for the FinTekkers platform.

## Tech stack

- Svelte + TypeScript (SvelteKit, file-based routing)
- Vite (build), Tailwind CSS + SCSS
- SQLite + Drizzle ORM (local auth/session data)
- Vitest + @testing-library/svelte
- `@fintekkers/ledger-models` npm package (gRPC service clients)

## Build & run

- **Install:** `npm install --ignore-scripts` — required: node-sass is broken
  on Node 25+.
- **Dev server:** `ORIGIN=https://dev.fintekkers.org npm run dev -- --host 0.0.0.0`
  (HTTPS port 443, reachable from all network interfaces including
  dev.fintekkers.org). The `--host 0.0.0.0` flag is required so other
  machines on the local network can reach it, not just localhost.
- **Build:** `npm run build`
- **Test:** `npx vitest run`
- **Type check:** `npx svelte-check --tsconfig ./tsconfig.json`
- **Lint:** `npm run lint`

## Local development setup

The UI calls backend services via gRPC through `@fintekkers/ledger-models`.
For full functionality start Postgres, then the backend services in order
(valuation → price → ledger → broker), then the UI. The UI also runs
standalone for frontend-only work — pages that don't fetch data work fine.

## Project structure

- `src/routes/` — SvelteKit routing; `(authenticated)/data/` holds
  portfolio, positions, securities, transactions, calculators; login,
  register and the landing page are public.
- `src/components/widgets/` — reusable grid/table components
  (PortfolioGrid, PositionGrid, …)
- `src/lib/` — service layer (portfolios.ts, positions.ts, security.ts,
  valuation.ts); `src/lib/store/` — Svelte stores for UI state.
- `src/tests/` — unit tests.

## Constraints

- All service calls go through the broker service — never call backend
  services directly.
- Use types generated from ledger-models protobuf definitions.
- Follow existing component patterns; write unit tests with Vitest +
  @testing-library/svelte.
- Run `npx svelte-check` before marking work complete — no new errors.
- Keep the dev server running after changes (`npm run dev -- --host 0.0.0.0`)
  so the app stays available in the browser and on the network.
