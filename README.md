# What

Before: Using many agents to try to get your work done. They forget things. They don't respect your rules of the road. You spend time fixing the damage they do, whilst debating if AI is actually making you faster.

After: A well-defined software development lifecycle with explicit gates that cannot be broken (e.g. testing is a MUST). This development lifecycle is accessible by non-engineers who can create work for the bot farm, whilst an engineer oversees the agents to ensure high quality and rapid build-out.

# Running the prototype

```
cd server && npm install && npm run dev   # API + SQLite on :3001
cd ui && npm install && npm run dev       # UI on :5173 (proxies /api to :3001)
```

Real agents (optional — without this, agent steps are mocked in-process):

```
./farm/run.sh                                        # farmd in tmux on :4100
cd server && FARM_URL=http://localhost:4100 npm run dev
```

See `farm/README.md` and `farm/PLAN.md`.

The UI can also run standalone on an in-browser mock: `VITE_MOCK=1 npm run dev`.
The SQLite file lives at `server/data/horizon.db` (gitignored); delete it to reset.

## GitHub issue sync

Without configuration the server runs on demo seed data. To sync real issues, open
**Admin** (avatar menu) and enter the repo (`owner/name`) plus an access token
(fine-grained with Issues + Actions read/write, or classic `repo` + `workflow` scopes —
write access is for the bots' target state: creating issues, commenting, triggering
workflows; blank is fine for read-only sync of public repos).
The token is validated against GitHub and stored in the local SQLite DB (gitignored).
Connecting replaces the demo data with the repo's issues.

Env vars work too (used as fallback when nothing is configured in the UI):

```
HORIZON_REPO=FinTekkers/horizon GITHUB_TOKEN=ghp_... npm run dev
```

Sync is event-based (webhooks) with an ETag-conditional polling fallback (60s default,
`POLL_INTERVAL_MS` to change). New/edited/closed issues upsert into the board; GitHub owns
title/description/priority (via a `critical|high|medium|low` or `priority: x` label, default
Medium), the lifecycle state stays local. Delete `server/data` when switching between demo
and synced mode.

For instant updates, add a repo webhook (issues events, JSON, with a secret) pointing at
`POST /api/webhooks/github` and start the server with `GITHUB_WEBHOOK_SECRET=...`.
Locally, bridge with a tunnel, e.g. `npx smee-client --url https://smee.io/<channel>
--target http://localhost:3001/api/webhooks/github`.

# The Development Lifecycle

* Plan
  *  A concise description of the outcome
  *  How dow e measusre success
  *  Guardrails, beyond the default ones below
  *  [HUMAN GATE] Approve and prioritize this work
* Technical Plan
  * An ensemble of PM / QA / Architect agents plan the technical work creatings pros/cons of various options
  * [HUMAN GATE] Approve the high level design
  * Eng agents create technical plans of how they will implement (e.g. which codebases to touch, rough outline of the work to be done, testing impact, etc)
  * Architecture agents reviews plans (e.g. code cleaniless, etc)
  * QA agent reviews if the test plan is sufficient
  * [Optional: Human gate] Review before execution
* Execute
  * Eng Agents with specific knowledge of relevant
  * Pass the work off to an agent with specific expertise in the area of work
  * [HUMAN GATE] Accept the code
* Deploy
  * DevOps agent depoys the changes 
* Review
  * [HUMAN GATE] Review the work before closing the task 

## The Non-Negotiable Checkpoints

* Deterministic Guardrails: A set of tasks to run that must pass in order to proceed
  * Unit tests
  * Integration tests
  * Data Quality tests
  * Performance tests
  * Code linters
  * End-to-end tests inc. UI
* Non-deterministic Guardrails: Run by agents
  * Code duplication
  * Code Encapsulation
  * Code cleanliness
 
## Customizatable Checkpoints

Ability to add additional human steps where necessary

# The Bot Farm Model

[Protoype]

* Work is modeled as GitHub issues (source of truth)
* Work lifecycle is modeled in a database (sqlite for now?)
* Users interact mostly by GH comments
* WhatsApp MCP server allows user to talk to the orchestrator bot directly
* Bot updates are written to a local database
* For now, bots run local to the UI presentation layer (web)

Example flow:

1. User creates a new GH issue (e.g. create a hello world)
2. A server-side process (within the UI project) queries GH periodically to look for new updates
3. Issues are reflected in teh database and show the current state
4. A server-side process controls when development lifecycle steps can process
5. The server-side process kicks of work to agents (via tmux)
6. After human gates are completed the agent is killed and restarted (i.e. keep context relevant to the current task)
7. Useful knowledge per agent is modeled as skills/context/etc that is loaded upon startup

## Workflow

We can't guarantee that progress is ever-forward so we need the following abilities at each step:

* Feedback: at any point feedback should be possible to give to agent. The backend will forward it to the agent
* Pause/Stop: Ability to pause agents' work on an item
* Reject: Ability to reject an agent step, or human gate with feedback.
* Startover: Ability to re-start a phase of a task (e.g. restart Plan phase, with feedback)
