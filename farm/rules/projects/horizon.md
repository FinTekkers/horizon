# Horizon — project rules

Horizon deploys **direct to one EC2 host** — no load balancer, no RDS. A
published GitHub Release on a repo with a deploy target triggers a webhook
(`server/src/app.js`'s `/api/webhooks/github` → `server/src/deploy.js`) that
pulls the tag and restarts a single systemd service. Full runbook:
`infra/host/DEPLOY.md`.

## Deploy targets on this host

| Target | Repo | Service | Front end |
| --- | --- | --- | --- |
| `horizon` | `FinTekkers/horizon` | `horizon-server` (systemd) | `https://shoreward.ai/horizon/` |
| `ui-service` | `FinTekkers/ui-service` | `fintekkers-ui` (systemd) | `https://www.fintekkers.org/` |

Both live on the **same EC2 host**. Horizon's database is the single source
of truth for target → script → service → health URL: the `deploy_target`
table, seeded once from a snapshot in `server/src/deployTargets.js` and shown
in Admin (create/edit/delete in Admin is a follow-up part of HZ-263). Every
release re-validates its row: the script must resolve inside `infra/host/`,
and the service and extra services must be ones
`infra/host/horizon-deploy.sudoers` permits restarting. That check stops bad
rows, but the security boundary is the sudoers file itself — any sudoers
change still needs a reviewed PR, and is never editable outside git.

## Health checks already in place — know their limits

- `deploy-horizon.sh` health-checks `http://127.0.0.1:3001/api/health`: JSON
  `{ok: true, itemCount: <int>}`. This proves the **API process** is up — it
  says nothing about whether the built UI actually renders at
  `/horizon/`. Deep verification of the front end (see your role
  instructions) is not yet part of this script; treat that as your own job
  when asked to verify a Horizon deploy.
- `deploy-ui-service.sh` already does deep verification of its own front
  end (SSR shell + the specific client bundle it references) — it is the
  reference implementation of "don't just check for 200."

## DNS / AWS / GCP context

- Public hostname: `shoreward.ai` (Horizon is served under the `/horizon/`
  path prefix on that host). DNS is managed outside this repo — do not guess
  at a registrar or zone; if you need to change a record, say so as a
  blocking finding rather than acting on an assumption.
- The EC2 instance itself, its security group, and its AWS account/region are
  operational details held outside this repo (unlike FinTekkers' load
  balancer, which was snapshotted at `infra/aws/fintekkers-lb-snapshot.json`
  before teardown) — do not invent ARNs or instance IDs for Horizon.
- GitHub OAuth (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` — see
  `server/src/config.js`) is issued from Google Cloud project
  `fintekkers-422317`. Credentials are environment variables on the host —
  reference them as `$GOOGLE_CLIENT_ID` / `$GOOGLE_CLIENT_SECRET`, never a
  literal value.
- `GITHUB_WEBHOOK_SECRET` and any deploy/release token live as environment
  variables on the host (`$GITHUB_WEBHOOK_SECRET`, `$GITHUB_TOKEN`) — never in
  this file, never in a log line, never in an artifact.

## Rollback

gRPC targets (`deploy-grpc-service.sh` and its ledger, valuation, broker and
price wrappers) auto-roll back once: a failed health check logs `DEPLOY
FAILED: health-check ...`, then the script redeploys the `last-good-tag`
commit under the same lock and logs `ROLLBACK OK`, `ROLLBACK FAILED (<stage>)`
or `ROLLBACK SKIPPED` to `~/.horizon/<stateKey>/self-deploy.log`. The deploy
still counts as failed and `last-good-tag` is never moved to the bad tag.

Other targets (`horizon`, `ui-service`) still never auto-rollback: a failed
health check leaves the bad code live and logs `DEPLOY FAILED: health-check
...`. Manual rollback (also for a gRPC target whose rollback failed): re-run
the target's own script with the tag from
`~/.horizon/<stateKey>/last-good-tag` (see `infra/host/DEPLOY.md` for the
exact command).
