# VDT Platform — Claude Code Project Guide

VDT (Virtual Development Team) Platform is an internal web app for **Code De Bear Company Limited** that automates the Planner → Dev → QA → Code Review → Docs software-delivery workflow. It calls the Anthropic API to do real generation work in each phase and now also runs **real test execution** (HTTP + browser) for a QA-as-a-service track. It is a working product, not a ticketing tool.

Primary language: English for all code, comments, commits. Thai is fine in chat.

---

## Architecture

- **Backend** — Node.js 20 + TypeScript (strict) + Express + Prisma ORM, JWT auth (`bcryptjs`, not native `bcrypt`). Runs in Docker on a **Raspberry Pi** (ARM). Folder: `backend/`.
- **Database** — **Neon** (serverless Postgres), NOT a local container. `DATABASE_URL` must end `?sslmode=require`. There is no `postgres` service in `docker-compose.yml`.
- **Frontend** — React 18 + Vite 5 + TS strict + Tailwind 3. Served by a separate **nginx** container that also proxies `/api` + `/health` to `backend:4000`. Folder: `frontend/`.
- **Execution worker** — separate `worker/` package (Node 20 + tsx + Playwright). Replays compiled QA artifacts (HTTP via fetch, browser via headless Chromium). Runs in **Docker on the MacBook Pro** (interim host; Mac mini deferred until M5). Dockerfile has **no `volumes:`** on purpose (host-filesystem isolation). Pi backend is unchanged by worker work.

Three machines, three roles: **Pi** = backend + orchestrator, **Mac** = execution worker (on-demand `docker compose up --build` / `down`), **Neon** = data.

### Hard environment constraints (don't relearn these)
- Docker base image is `node:20-slim` + `openssl`, **NOT alpine** — alpine/musl breaks Prisma's engine on ARM (`Could not parse schema engine response`).
- Use `bcryptjs`, never native `bcrypt` (binary download blocked in build env).
- Playwright is pinned **exactly** to the version matching the worker Docker image tag (`mcr.microsoft.com/playwright:vX.Y.Z-noble`). Keep them in lockstep.
- The backend Docker **entrypoint auto-runs `prisma db push` on every container start.** Never run a manual `db push` alongside it — that race causes `type ... already exists`. Let the entrypoint handle schema sync.
- **Never instruct `cp .env.example .env` on an existing deploy** — it clobbers the real Neon `DATABASE_URL` → Prisma `P1013` → backend crash-loop. Guard with `[ -f .env ] && skip || cp`.

---

## Domain model & conventions

- **Pure domain layer** in `backend/src/domain/*.ts` (workflow, permissions, qaExecution, pricing, budget, batch, crypto, etc.) — **no Prisma/IO**, fully unit-tested. Services in `backend/src/services/` do the IO and call the pure layer. Keep this split; it's why most logic is testable in the sandbox without a DB.
- **6 global roles** on `User`: SUPER_ADMIN, PROJECT_OWNER, BA, SA, QA, OPERATION (default OPERATION). Worker roles run phases (BA=PLANNER, SA=DEV+CODE_REVIEW, QA=QA, OPERATION=DOCS); PROJECT_OWNER reviews/approves own projects; SUPER_ADMIN override. `domain/permissions.ts` `can(role, action, ctx)` is the single source; FE `frontend/src/lib/permissions.ts` mirrors it (known drift debt).
- **Project tracks**: `FULL_SDLC` (Planner→Dev→QA→Review→Docs) and `QA_ONLY` (lightweight test-scope planner → repeatable QA cycles). Phases are modeled as **`PhaseExecution` rows** (one per run, many per phase type) — never one fixed field per phase. This enables repeatable QA + retest history.
- **QA execution is a state machine** (`domain/qaExecution.ts`): SCENARIO_DRAFT → STEPS_DRAFT → COMPILED → EXECUTING → RESULTS_REVIEW → EXPORTED, with confirm gates. AI **compiles** confirmed steps into a deterministic `artifactSpec` (HTTP or BROWSER, in `domain/qaArtifact.ts`) **once**; the worker replays it. Execute = **0 Claude tokens** (the QA_ONLY payoff). AI only re-enters to triage.
- **Every AI-gen stage must support a review → feedback → regenerate loop** until the user approves, before advancing (scenarios, steps, compile, results). `generate*` fns take an optional `feedback` string; with feedback present, the current draft + feedback go back to Claude in REVISION mode. Do not make any stage one-shot.
- **AI cost budget** per project (`Project.budgetUsd`/`spentUsd`, `domain/pricing.ts` + `domain/budget.ts`): pre-check before the Claude call (402 if exhausted), reservation pattern in a Serializable `$transaction` so concurrent gens can't overspend, settle to actual after. Errs toward under-spend.
- **Secrets vault** — AES-256-GCM (`domain/crypto.ts`), master key in `SECRETS_KEY`. Per-project `TargetEnvironment` (baseUrl + host allowlist, **non-prod only** in v1). Worker gets decrypted secrets via worker-token-gated endpoint; `${VAR}` placeholders resolved at execute time. Never log secrets.
- **Attachments** — uploaded to a phase run, read directly by the AI at generate time (PDF → Anthropic native `document` block, XLSX→SheetJS, DOCX→mammoth, CSV/TXT/MD→text). Stored as Neon `bytea`. Tight caps (per-file ≤10MB, per-run ≤25MB). `getTestRun`/list endpoints return metadata only, never bytes.
- **Batch generation** — per-generate toggle (sync vs Anthropic Batch API ~50% cheaper). Batch adds `QUEUED` status + `batchId`; in-process `setInterval` poller settles QUEUED runs, recovers across restarts.

---

## Workflow when building features (carry this over from the old process)

Build **one sub-phase at a time**, self-verify, then stop at a review gate and wait for explicit approval before the next. Never combine sub-phases or jump ahead. This is a firm user preference (catching mistakes early is cheaper). The gate sequence per sub-phase: build → self-verify (type-check + unit tests + any reachable smoke) → present a short summary → wait for `APPROVE & DEPLOY` / `REQUEST CHANGES`.

Each backend sub-phase ships: pure domain logic + unit tests, service/controller/route wiring, a `qa/smoke-*.sh` script (with a `until curl -sf localhost:4000/health` wait preamble), and env additions in **all of** `env.ts`, `.env.example`, and `docker-compose.yml`.

When giving shell commands for different machines, put **each machine's commands in its own labeled code block** (On the Pi / On the Mac worker) — never mix them; the user copy-pastes whole blocks.

---

## Verification notes (important — the sandbox lied here)

The old Cowork sandbox could **not** run `prisma generate` (engine download blocked) → `tsc` always showed ~15 stale-Prisma-client type errors in files importing `@prisma/client`. Those were artifacts, not real defects. **In Claude Code on a real machine with network, this no longer applies** — you can and should run the real toolchain:

```bash
cd backend && npm install && npx prisma generate && npx tsc --noEmit && npm test
cd ../frontend && npm install && npx tsc --noEmit && npm run build
cd ../worker && npm install && npx tsc --noEmit && npm test
```

Past lesson: `ts.transpileModule` syntax checks do **not** catch type errors (e.g. `@types/pdfkit` omitting `PDFDocument.openImage` slipped through and broke a Pi build). Always run a real type-check now that you can.

When rendering fetched binary as a `blob:` object URL in the FE, the nginx CSP `img-src` must include `blob:` (not just `data:`).

---

## Git workflow

GitHub repo: `https://github.com/codedebear/vdt-platform` (HTTPS + fine-grained PAT; SSH was blocked only in the old sandbox). PAT is in repo-root `.env` as `GITHUB_PAT` (gitignored, along with `.env` and `.deploy_key/`).

**The old `/tmp` copy + PAT-push dance was a workaround for the sandbox not being able to unlink OneDrive `.git` locks. In Claude Code running natively on the Mac, normal `git` works** — but the repo still lives under OneDrive, which can still churn `.git` locks. **Strongly recommended: clone a fresh working copy outside OneDrive** (e.g. `~/dev/vdt-platform`) and work there; or exclude `.git` from OneDrive sync. The Pi has its own clean clone at `~/VDT_Platform/vdt-platform` (the deploy target).

Always verify `.env` is never staged before committing.

---

## Deploy

```bash
# On the Pi
cd ~/VDT_Platform/vdt-platform
git pull
docker compose up --build -d        # rebuild BEFORE any schema sync; entrypoint runs prisma db push
docker compose ps
```

```bash
# On the Mac worker (only when running QA executions)
cd worker
docker compose up --build            # claims jobs from the global queue, runs HTTP + browser, submits results
# docker compose down   when finished
```

Run the relevant `qa/smoke-*.sh` after deploy. See `DEPLOY.md` for the full env table and troubleshooting (P1013/502 rows).

---

## Current state (2026-06-25)

GitHub `main` at `6432010`. Backend feature-complete: auth, RBAC, projects (both tracks), AI generation, attachments, batch generation, per-project budget, full QA execution redesign (QAX-1..8) including real HTTP+browser execution, evidence surfacing, **UATR PDF report** (pdfkit), and **Full Retest** (clone a reviewed run → new COMPILED run, 0 tokens). The entire QA flow is end-to-end verified through the web UI. Frontend feature-complete to match.

**Open backlog** (`docs/ENHANCEMENTS.md`): E-1 edit project description, E-2 delete project, E-3 target/secrets settings UI (today set via curl). Known debt: FE `permissions.ts` mirror drift, FE budget display/edit UI, sign-off as modal vs inline form, let PROJECT_OWNER download report, `xlsx` 0.18.5 security debt, and **auto retry/backoff on Anthropic 529 Overloaded at the QA compile call** (currently retried by hand — compile flakes on 20+ scenarios).

---

## User context

Owner of Code De Bear (Thai IT consultancy), AWS Certified Solutions Architect — comfortable with cloud infra/cost trade-offs; explain specifics (SKUs, SLAs, pricing) directly. Priorities: **correctness, performance, efficiency**. Prefers to **confirm before non-trivial work** (avoid wasted effort/tokens). Be concise and direct.
