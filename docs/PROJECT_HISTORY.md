# VDT Platform — Project History

Full build history, decisions, and lessons learned, captured from the Cowork session memory before migrating to Claude Code. This is reference/context — the operational guide is `CLAUDE.md`. Point-in-time notes; verify against current code before treating any file:line claim as live.

Last synced: 2026-06-25. GitHub `main` at `6432010`.

---

## 1. What VDT Platform is

A real web app that automates the Planner → Dev → QA → Code Review → Docs workflow. After deploy, the Code De Bear team uses the web UI to create projects / submit Change Requests instead of typing `PROJECT:`/`INPUT:` commands in chat. The platform calls the Anthropic API itself for real generation in each phase, and now runs **real test execution** (HTTP + browser). It is not a ticketing/tracking tool.

Two project tracks: `FULL_SDLC` (Planner→Dev→QA→Review→Docs) and `QA_ONLY` (lightweight test-scope planner → repeatable QA cycles for clients who already have code). Phases are `PhaseExecution` rows (one per run, many per phase type) so QA is repeatable with full history.

The Cowork project's own Planner/Dev/QA/Review/Docs instructions were both the **meta-process** used to build VDT, and the workflow VDT automates for other projects.

---

## 2. Infrastructure decisions

**Hosting / DB.** Backend in Docker on a Raspberry Pi (self-host, low/infrequent usage). Database is **Neon** (serverless Postgres free tier — 100 CU-hrs/mo, 0.5GB, scale-to-zero, 7-day PITR), **not** a local container on the Pi. Reason: avoid the Pi SD-card/power-loss single point of failure for data. `docker-compose.yml` has no `postgres` service; `DATABASE_URL` is a Neon string ending `?sslmode=require`. Neon host `ep-late-rain-aoc0pn1d.c-2.ap-southeast-1.aws.neon.tech`, db `neondb`.

Rejected alternatives: Azure PostgreSQL Flexible Server (B1ms ~$12.41/mo, too expensive for infrequent use), Azure SQL Serverless (non-zero baseline + provider switch), self-host Postgres on Pi + USB SSD + `pg_dump` to Blob (cheapest but higher RPO/ops). Upgrade path if usage grows = Neon paid tier, no code change.

**Stack.** Node.js 20 + TypeScript (strict) + Express + Prisma, JWT (`bcryptjs`). Frontend React 18 + Vite 5 + TS strict + Tailwind 3, served by a separate nginx container proxying `/api`+`/health` to `backend:4000`. Docker base `node:20-slim` + `openssl` (alpine/musl breaks Prisma on ARM).

**Execution worker.** Separate `worker/` package (Node 20 + tsx + Playwright), runs in Docker on the MacBook Pro (interim; Mac mini purchase deferred until M5). No model needed (executor replays compiled artifacts). Browser tests run on the Mac (x86), not the Pi (ARM/RAM) and not Fargate (Mac is free + on-demand). Dockerfile has no `volumes:` (host-filesystem isolation for client-data concern).

---

## 3. Core backend + frontend build (FULL_SDLC track)

Built in 8 dev sub-phases, one at a time with explicit `APPROVE & DEPLOY` gates.

- **Sub-phase 1** — backend scaffold + JWT auth. Deployed, QA passed.
- **Sub-phase 2** — Core Domain & Workflow Engine (`00ce85d`), QA 24/24. Project (FULL_SDLC/QA_ONLY) + repeatable `PhaseExecution`; pure `domain/workflow.ts`; routes `/api/projects` + `/api/phases`. Code review found a critical authZ gap.
- **Sub-phase 2.5** — AuthZ & RBAC (`84d420e`), QA 26/26. Global 6-role model (SUPER_ADMIN, PROJECT_OWNER, BA, SA, QA, OPERATION; default OPERATION). Pure `domain/permissions.ts` `can(role, action, ctx)` (16 tests). `requirePermission` middleware + service-layer ownership checks. Prisma error mapping (P2002→409, P2025→404). Role assignment via SQL seed.
- **Sub-phase 3** — AI Generation (`cad0a50` + `700ea1b`), QA 9/9. `POST /api/phases/:id/generate`; pure `domain/prompts.ts`; `services/generation.service.ts` (lazy `@anthropic-ai/sdk`, injectable client). Env `ANTHROPIC_API_KEY` (503 if missing), `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`), `ANTHROPIC_MAX_TOKENS` (8000) — must be in **both** `.env` and the compose `environment:` block.
- **Sub-phase 3.5** — Cost & Robustness (`75ab9df` + `fc8d5c6`), QA 11/11. Client `timeout`+`maxRetries`; per-user rate limit on `/generate`; per-run regeneration cap (`GENERATE_MAX_PER_RUN` default 5 → 429); token usage stored. Additive cols `inputTokens`/`outputTokens`/`generationCount`.
- **Docs phase** — full README rewrite + 4 Mermaid diagrams + DEPLOY.md (`2ff507e`).
- **Sub-phase 4** — User-management API (`13c6dee`, `5651aff`), QA 16/16. `/api/users` (SUPER_ADMIN only): list/get/`PATCH :id/role`. Pure `domain/userManagement.ts` `canChangeRole` (blocks self-role-change + demoting last SUPER_ADMIN); `PUBLIC_USER_SELECT` never selects passwordHash.

**Frontend FE-1..FE-4** (all COMPLETE-acked 2026-06-19/20):
- FE-1 — API client (`lib/api.ts`, JWT + 401 auto-logout), AuthContext, ProtectedRoute, Login/Register, app shell.
- FE-2 — projects list/create (track picker)/detail.
- FE-3 (`0291951`/`f9b216e`/`a3a5312`) — Phase Execution UI; FE mirrors `lib/workflow.ts` + `lib/permissions.ts` for button-gating (drift debt logged).
- FE-4 (`4137070`/`8a229a4`) — User-management UI (`/users` admin screen).
- Serving: separate nginx container (multi-stage → `nginx:1.27-alpine`), `default.conf.template` serves SPA + proxies, CSP/security headers (re-declared in `/assets/` block since nginx drops inherited `add_header`). Same-origin API via relative `/api` (dev: Vite proxy; prod: nginx). JWT in localStorage (XSS tradeoff, accepted for internal tool).

**Deploy incident (lesson).** First FE deploy 502'd: the Dev-Agent's own instruction said `cp .env.example .env`, which clobbered the Pi's working `.env` → placeholder `DATABASE_URL` with `<...>` → Prisma `P1013` → backend crash-loop. Fix: restore real `.env`; DEPLOY.md now guards against clobbering. **Never `cp .env.example .env` on an existing deploy.**

---

## 4. Backend debt cleanup + cost budget (BE-DEBT-1)

`3b9e456` → review fixes `e9f2b49`, COMPLETE-acked 2026-06-20, docs `2a4a93b`. Resolved all 4 open backend code-review warnings:
- W1 generationCount cap now atomic (`updateMany where generationCount<cap`).
- W2 input cost-DoS — zod `.max()` + truncate prior outputs.
- W3 raw-error log leak — log `err.message` only.
- W4 last-super-admin race — demotion in Serializable `$transaction` + re-count, `P2034`→409 retry.

Plus **per-project AI cost budget**: `Project.budgetUsd?`/`spentUsd`, `PhaseExecution.costUsd?`. Pure `domain/pricing.ts` (`estimateCostUsd`; table as-of 2026-06 Opus $5/$25, Sonnet $3/$15, Haiku $1/$5 per MTok; env-overridable) + `domain/budget.ts`. Pre-check `isBudgetExhausted` → **402 before** the Claude call. Review-fix added a **reservation pattern**: estimate upper-bound cost + claim gen slot + reserve budget in one Serializable txn (P2034→409 retry), settle to actual after, release on failure → always errs toward under-spend. New `PATCH /api/projects/:id/budget`. Env: `PROJECT_BUDGET_USD_DEFAULT`, `ANTHROPIC_PRICE_INPUT/OUTPUT_PER_MTOK`, `INPUT_MAX_CHARS` (100000), `PRIOR_OUTPUT_MAX_CHARS` (20000).

---

## 5. Attachments (BE-DOC / FE-DOC)

Let users attach documents to the "Start a phase" box; the AI reads them directly at generate time (no extract-then-review step).
- No own OCR — Claude API native PDF `document` content block (base64, reads text + scanned via vision).
- File types v1: PDF (document block), XLSX/XLS (SheetJS), DOCX (mammoth), CSV/TXT/MD (text). All pure-JS (ARM-safe).
- Storage = Neon `bytea`. Caps: per-file ≤10MB, per-run ≤25MB, count-limited (`ATTACHMENT_MAX_FILE_MB`/`_PER_RUN`/`_TOTAL_MB`). Abstracted behind a small interface for a later S3/R2 move.
- `Attachment` entity linked to `PhaseExecution`. Reads return metadata only, never bytes.

Sub-phases: **BE-DOC-1** upload API (`417e085`, multer memoryStorage, `2f52467` docs), **BE-DOC-2** generate integration (`0902a8e`/`be7d79e`, `attachmentContent.service.ts`; PDF magic-byte check; office parsers lazy-loaded; `generation.service` widened to `string|ContentBlock[]`), **FE-DOC-1** attach UI (`62fd8d3` → review-fix `d3b18f4` → docs `f97c131`; new `GET /api/config` exposes limits as single source; project response embeds attachment metadata to avoid N GETs).

Open warnings: (a) PDFs sent whole as document blocks (per-page token cost) and re-sent on every regenerate — consider a page/size cap; (b) extracted attachment text concatenated into prompt = prompt-injection vector (mitigated by human review gate).

---

## 6. Batch generation (BE-BATCH / FE-BATCH)

Optional generation via the Anthropic Message Batches API (~50% cheaper).
- Per-generate UI toggle: "Generate now" (sync, full price) vs "Generate (batch, cheaper)". Not global.
- Async → new `PhaseExecution` status `QUEUED` + `batchId` col. Flow IN_PROGRESS → [generate-batch] → QUEUED → [poller] → AWAITING_REVIEW | FAILED.
- In-process `setInterval` poller (wired in `server.ts`, not `app.ts`, so supertest spawns no timer), recovers across restarts from persisted `batchId`.

**BE-BATCH-1** (`bf96096` → smoke fix `66e2e1d` → review fixes `9022944` → docs `288a665`). Pure `domain/batch.ts`; `pricing.estimateCostUsd` gained `discountFactor` (`BATCH_PRICE_FACTOR=0.5`); refactored shared `prepareGenerationContext`/`reserveGenerationSlot` used by both sync and batch (kills mirror-drift). Review fixes: W1 stuck-QUEUED hard age cutoff (`BATCH_MAX_AGE_MS` ~26h) + terminal-404 detection; W2 crash-window closed by flipping to QUEUED atomically inside the reserve txn + status-guarded `batchId` attach + grace-period reconcile.

**FE-BATCH-1** (`26956df` → `9b917b1` → review fixes `653a64e` → docs `ce5efc6`). QUEUED badge; two generate buttons both behind a confirm step; auto-refresh while QUEUED. Review-fix W1: backend `getStartablePhases()` returned by `GET /api/projects/:id`, FE `lib/workflow.ts` **deleted** (mirror eliminated; `permissions.ts` mirror kept as debt). W2: poll only the QUEUED run ids via new `GET /api/phases/:executionId`, pause while `document.hidden`.

---

## 7. QA Execution Redesign (QAX-1..8) — the big one

**Problem.** Original QA = a single LLM generation producing one markdown blob; it executed nothing. Desired: AI gen scenario → confirm → AI gen step → confirm → AI execute (API + browser) → AI update result → review → download.

**Locked design** (`docs/QA_EXECUTION_DESIGN.md`, approved 2026-06-21):
- Executor = **deterministic compiled**: AI compiles confirmed steps → HTTP spec / Playwright actions **once**; a plain-code worker replays; AI re-enters only for failure triage. Execute = 0 tokens; re-runs ~free.
- Data model: `TestRun → TestScenario → TestStep(+artifactSpec) → TestResult(status/actualResult/evidence/durationMs)`, maps 1:1 to the UATR Excel template sheets.
- QA phase = state machine SCENARIO_DRAFT → STEPS_DRAFT → COMPILED → EXECUTING → RESULTS_REVIEW → EXPORTED (confirm gates).
- Job queue = DB-backed on Neon (worker leases via conditional-updateMany + heartbeat; outbound-only worker service token). Global/oldest-first across all projects.
- Target env = non-prod only in v1 (host allowlist + secrets vault + confirm gate).

**Sub-phases:**
- **QAX-1** (`bd60e00`) — schema + state machine. Pure `domain/qaExecution.ts` (QA_STAGE_SEQUENCE, advanceStage, reviseStage, rollUpScenario/Run, isExecutionComplete). New TestRun/Scenario/Step/Result tables + enums. Deployed via `prisma db push --force-reset` (data not important yet).
- **QAX-2A** (`1c87c5c` + feedback-regen `c502d4a`) — scenario stage: AI gen + confirm + **feedback→regen loop**. `domain/qaPrompts.ts` `buildScenarioPrompt` (strict JSON), `domain/qaParsing.ts` (zod), `services/qaExecution.service.ts`. Established the rule: **every AI-gen stage must support review→feedback→regen until approved.**
- **QAX-2B-1** (`504f8c4`) — step stage: AI gen steps+expectedResult per scenario, feedback loop.
- **QAX-2B-2** (`ecdc84f`) — compile → `artifactSpec`. Pure `domain/qaArtifact.ts`: discriminatedUnion HTTP `{request, assertions}` | BROWSER `{actions, assertions}`; resilient `selectorSchema` (role/name, label, text, testId, css). Paths relative (base URL injected at execute), secrets via `${VAR}`, assertions declarative. `confirmSteps` compiles → COMPILED; `recompileArtifacts` feedback loop; `reviseStage` back-nav.
- **QAX-3A** (`48b6a0b`) — target config + secrets vault. Pure `domain/crypto.ts` (AES-256-GCM, `SECRETS_KEY`). `TargetEnvironment` (baseUrl + host allowlist, non-prod only → 422 if prod) + `Secret` tables. `startRun` COMPILED→EXECUTING, seeds NOT_START results.
- **QAX-3B** (`a9faa0e` + smoke fix `50477b4`) — worker job queue. Lease cols; `middleware/workerAuth` (shared token, constant-time compare); `worker.service` claimJob/heartbeat/submitResults; finalize rolls up + advances EXECUTING→RESULTS_REVIEW. express.json limit raised to 5MB (inline evidence). Lesson: the queue is global — tests must not assume single-run isolation.
- **QAX-3C** — `SKIPPED` status for browser steps pre-QAX-4 (`505de99`); the **worker process** `worker/` package (`24a4d0a`): pure `core.ts` (resolvePlaceholders, buildUrl, isHostAllowed, queryJsonPath, evaluateHttpAssertions), `runner.ts`, `api.ts`, poll loop + heartbeat. Runtime = tsx (no build step).
- **QAX-4** — browser/Playwright + dockerize. **4A** (`16df969`) `worker/src/browser.ts` `runBrowserStep` (goto/click/fill/select/waitFor + textVisible/urlContains/elementVisible); pure `planSelector` precedence **testId > role+name > label > text > css**; one browser context per scenario; viewport-only screenshot per step (PNG→JPEG fallback→omit, never truncate); never throws. Playwright pinned exactly 1.61.0. **4B** (`fdb8d59`) `worker/Dockerfile` FROM `mcr.microsoft.com/playwright:v1.61.0-noble`, no `volumes:`, `shm_size: 1gb`, non-root, on-demand up/down.

**Full-loop UI verify (2026-06-25).** Drove the entire flow through the real web UI as SUPER_ADMIN: QA_ONLY project, PLANNER scope, gen 15 scenarios (feedback-regen → 14), steps, compile, target set via curl (no FE — E-3), start → EXECUTING, Mac Docker worker ran 14 scenarios HTTP+browser, results auto-polled, evidence rendered, signed off → EXPORTED → PDF with embedded screenshots. End-to-end verified. Compile hiccups (product-real): empty assertion `text` → zod 422 (retry passed); Anthropic **529 Overloaded** → hand-retry (no auto-backoff at compile → backlog item).

**QAX-7** (evidence surfacing + PDF report):
- 7A (`693babc`) — `getStepEvidence` endpoint streams bytes; `getTestRun` now **omits** evidence bytes (perf fix — was shipping screenshots in every poll).
- 7B (`4a8449a`) — FE evidence viewing: BROWSER screenshot thumbnail→modal, HTTP request/response expandable. Auth header can't ride `<img src>` → fetch blob → objectURL.
- 7C (`b0e1f92`) — **UATR PDF report via pdfkit** (pure Node, runs on Pi ARM). Chosen over Excel-with-images (SheetJS can't embed cleanly). `services/uatrPdf.ts`: Amendment + signature section + Test Scenario Summary + per-scenario Detail with inline screenshot/req-resp. Reuses pure label/roll-up fns so PDF + Excel agree. Existing xlsx export kept untouched.
- 7D (`dacd5ba`) — FE PDF download button; Excel button hidden (single-deliverable decision).
- Post-deploy fixes: `dace47c` backend build fix (`@types/pdfkit` omits `PDFDocument.openImage` → cast via `OpenableDoc`; **lesson: transpile-syntax checks miss type errors — run a real type-check**) + smoke PLANNER-role fix (use BA token); `f1963de` **CSP `img-src` += `blob:`** (screenshots were broken — data: is not enough for blob object URLs); `49222cc` PDF table layout (reset `doc.x` after drawTable); `d85a9c0` real signature section.

**QAX-8** (Full Retest — rerun a QA round after a dev fix):
- Problem found while designing: nothing moved a QA `PhaseExecution` off IN_PROGRESS after EXPORTED (`confirmResults` only set `TestRun.stage`), so `canStartPhase('QA')` saw an open run and a second QA run couldn't start.
- Decisions: **full retest** (all cases), clone lands at **COMPILED** (user clicks Start), allow retest from RESULTS_REVIEW **or** EXPORTED; on retest-from-RESULTS_REVIEW also advance source to EXPORTED for consistent history.
- 8A backend (`c3513d0` → `b901115` → `217c7cc`): pure `planRetestClone`; `retestRun` finalizes source APPROVED + creates a new QA PhaseExecution with a TestRun at COMPILED + cloned scenarios/steps (artifactSpec kept, no results), 0 Claude tokens. `POST /api/phases/:executionId/qa/retest`.
- 8B FE (`6432010`): `retestQaRun` + "Full retest" button on QaRunPage at RESULTS_REVIEW/EXPORTED → navigates to the new run. Verified `tsc --noEmit` + `vite build` clean.
- Smoke fixes (`e1bc024`/`dc0a4cc`/`8595474`) were all smoke-harness issues (compile transient retry, worker drain-loop vs the live Mac worker, python heredoc quote-escaping) — the retest feature itself verified working on the Pi.

---

## 8. Git / OneDrive workflow (sandbox-era)

The repo lives in a OneDrive-synced folder. The Cowork sandbox could create but **not unlink** files in `.git/`, so stale `.lock` files blocked git ops. Working procedure was: rsync repo → `/tmp/vdt-build` (non-OneDrive), `find .git -name '*.lock' -delete`, `git add/commit`, push over HTTPS with the PAT (`GITHUB_PAT` in gitignored `.env`). For any **modified** existing file, re-apply edits onto the `/tmp` clone's origin version — never copy the OneDrive file over (it was often stale and would clobber pushed code).

The Pi has its own clean clone at `~/VDT_Platform/vdt-platform` (the deploy target). Mac/OneDrive copy resync: `rm -f .git/*.lock && git fetch origin && git reset --hard origin/main`.

**In Claude Code (native on the Mac) this workaround is unnecessary** — but to avoid OneDrive `.git` lock churn entirely, clone a fresh copy outside OneDrive (e.g. `~/dev/vdt-platform`) and work there, or exclude `.git` from OneDrive sync.

---

## 9. Lessons learned (consolidated)

- Sandbox could not `prisma generate` (engine 403) → `tsc` showed ~15 stale-Prisma-client errors that were artifacts, not defects. **On a real machine, run the full toolchain.**
- `ts.transpileModule` syntax checks do not catch type errors (the `openImage` build break). Run a real `tsc`/`createProgram`.
- The backend Docker entrypoint auto-runs `prisma db push` on every start — never run a manual db push alongside (race → "type already exists").
- Never `cp .env.example .env` on an existing deploy (clobbers Neon `DATABASE_URL` → P1013).
- alpine/musl breaks Prisma on ARM → use `node:20-slim` + openssl.
- Blob object-URL images need CSP `img-src blob:` (not just `data:`).
- The worker queue is global/oldest-first — smoke tests must drain it, not assume single-run isolation.
- Add a `until curl -sf localhost:4000/health` wait to the top of smoke scripts (readiness races).
- New env vars must go in all three: `env.ts`, `.env.example`, `docker-compose.yml`.
- One labeled command block per machine (Pi / Mac worker) — the user copy-pastes whole blocks.

---

## 10. Open backlog (see `docs/ENHANCEMENTS.md`)

- E-1 Edit project description (fed into every Claude prompt; currently set-once at create) — want `PATCH /api/projects/:id` + FE field.
- E-2 Delete project (cascade PhaseExecutions, TestRun/Scenario/Step/Result, TargetEnvironment, Secrets, Attachments) — want `DELETE /api/projects/:id` + confirm gate.
- E-3 Target/Secrets settings UI (exists as API since QAX-3A; users must curl) — want FE target form + secrets manager.
- Polish: sign-off as modal vs inline form; let PROJECT_OWNER download the report; `xlsx` 0.18.5 security debt; **auto retry/backoff on Anthropic 529 at the QA compile call**; FE `permissions.ts` mirror drift; FE budget display/edit UI; W3/W4 (costUsd overloaded while QUEUED, PDF/document-block tokens not in budget reserve estimate); JWT-role-staleness (role read from token, not DB).
