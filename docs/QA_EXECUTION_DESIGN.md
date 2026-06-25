# QA Execution Flow — Design

Status: **Draft for approval** · Last updated: 2026-06-21 · Owner: Code De Bear

This document designs the upgrade of the VDT Platform **QA phase** from a single
LLM markdown generation into a **staged, real-test-execution flow** that runs API
and browser tests for real, records structured results, and exports a **UATR Excel
report** matching the company's existing template.

---

## 1. Goals

- Turn QA from "generate a markdown blob a human fills in" into "generate → confirm
  → execute for real → record results → export UATR".
- Reuse the existing **QA_ONLY repeatable track** (re-test every time client code
  changes; full run history retained).
- Keep AI cost **predictable and low**: execution itself spends **0 tokens**.
- Output the same **UATR `.xlsx`** the team already uses, persisted per run.

## 2. Locked decisions

| Topic | Decision |
|---|---|
| Brain (gen/triage) | **Claude API** — generate scenarios, steps, compile, triage failures |
| Execution model | **Deterministic compiled** — AI compiles confirmed steps into a replayable artifact once; plain code runs it. Not a live AI agent driving the browser. |
| Execution token cost | **0 tokens to execute.** Claude only at gen/compile/triage. |
| Where it runs | **Spare Windows laptop as a 24/7 execution worker.** Pi stays the orchestrator. |
| Mac mini / local model | **Not needed.** Executor needs no model; client code may be sent to Claude API (no privacy constraint). |
| Target environment | **Non-prod only** (staging/UAT/test). No prod execution in v1. |
| Output | **Excel UATR** per the company template, stored in Neon, history retained. |

## 3. Architecture

```
                         Claude API
                     (gen / compile / triage)
                            ▲   ▲
                            │   │
   ┌────────────────────────┴───┴───────────┐         ┌──────────────────────┐
   │  Raspberry Pi — VDT backend (orchestr.)│         │  Windows laptop        │
   │  - QA phase state machine              │  job    │  Execution Worker 24/7 │
   │  - gen scenario / step / compile       │  queue  │  - poll claimed jobs   │
   │  - store TestRun/Scenario/Step/Result  │◄───────►│  - run API (HTTP)      │
   │  - build UATR .xlsx, store in Neon     │ (DB poll│  - run browser         │
   │                                        │  + pull)│    (Playwright headless)│
   └───────────────────┬────────────────────┘         │  - capture evidence    │
                       │                               │  - push results back   │
                       ▼                               └──────────────────────┘
                 Neon Postgres
        (TestRun, Scenario, Step, Result, evidence, UATR blobs)
```

**Why this split:** the Pi is ARM + low RAM — fine for orchestration and Claude
calls, bad for headless Chromium. The laptop is x86, free, already owned, and can
stay on. The worker **pulls** jobs (outbound only) so the laptop needs no inbound
firewall holes.

## 4. QA phase state machine

The QA phase becomes a state machine inside one `PhaseExecution` (QA type). Each
transition between draft states is gated by a human confirm, consistent with the
rest of the platform.

```
SCENARIO_DRAFT ──confirm──▶ STEPS_DRAFT ──confirm──▶ COMPILED
      ▲                          ▲                       │
      │ request changes          │ request changes       │ run
      └──────────────────────────┴───────────────────────┤
                                                          ▼
                              EXECUTING ──▶ RESULTS_REVIEW ──confirm──▶ EXPORTED
                                  │               │
                                  │               └─ request re-run / re-triage
                                  └─ (worker pushes per-step results)
```

- **SCENARIO_DRAFT** — Claude proposes test scenarios from the spec/attachments.
- **STEPS_DRAFT** — for confirmed scenarios, Claude proposes ordered steps +
  expected results.
- **COMPILED** — Claude compiles each step into an executable artifact
  (HTTP request spec or Playwright actions + assertion). One-time per step.
- **EXECUTING** — worker pulls the run, executes every step, streams results.
- **RESULTS_REVIEW** — human reviews per-step status + evidence; can request
  re-run or AI triage on failures.
- **EXPORTED** — UATR `.xlsx` generated and stored against the run.

Re-running a QA_ONLY project that already has COMPILED artifacts jumps straight to
EXECUTING (no Claude spend) unless scenarios changed.

## 5. Data model (maps 1:1 to the UATR template)

The uploaded template `UATR_..._SF+.xlsx` has 4 sheets; **Detail Test Scenario
Summary** is the master data, **Test Scenario Summary** is a roll-up, **Amendment**
is document metadata, **Test Case** sheet is unused.

```
TestRun                         → drives Amendment + Test Scenario Summary sheets
  id, phaseExecutionId, runNo, version, preparedBy, reviewedBy,
  approvedBy, startedAt, finishedAt, overallResult

  TestScenario                  → one "test case" group in the Detail sheet
    id, runId, no, topic, testName, system, remark

    TestStep
      id, scenarioId, order, stepName, expectedResult
      artifactType (HTTP | BROWSER)
      artifactSpec  (JSON: request/actions + assertion)   ← compiled once

      TestResult                → one row per step per run
        id, stepId, status (NOT_START | PASS | FAIL | IN_PROGRESS),
        actualResult, evidenceRef (screenshot/response blob),
        durationMs, executedAt, remark
```

### UATR export mapping

| UATR sheet | Source |
|---|---|
| **Amendment** | `TestRun` metadata (version, preparedBy, date, A/M/D records) |
| **Detail Test Scenario Summary** | one block per `TestScenario`; one row per `TestStep` with its `TestResult` (No, Topic, Test Name, System, Step Name, Expected Result, Status, Remark, Date) |
| **Test Scenario Summary** | auto roll-up: Total Step = count steps; Result = PASS iff all steps PASS else FAIL; Date = run date; Responsible Tester = worker/owner |
| **Test Case** | left as the blank template header (unused) |

Status vocabulary follows the template legend: **Pass / Fail / In progress /
Not Complete / No Run** (summary) and **Not Start** (detail default).

Built with the `xlsx` skill from the stored structured data → re-exportable any
time, identical layout every run.

## 6. Token / cost model

| Stage | Claude? | Frequency |
|---|---|---|
| Gen scenario | ✅ | once / when scenarios change |
| Gen step | ✅ | once / when scenarios change |
| Compile step → artifact | ✅ | once / when a step changes |
| **Execute (API + browser)** | ❌ | **every run — free** |
| Triage failure | ✅ (capped) | only failed steps |

- Compiled artifacts are **stored** — re-runs replay them at 0 token cost. This is
  the QA_ONLY payoff: re-test on every client code change is nearly free.
- Failure triage is **bounded by the existing per-project budget** (`budgetUsd`),
  reusing the platform's reservation/settle cost mechanism.
- Browser selectors compiled with **resilient locators** (`getByRole`/`getByText`/
  `getByLabel`) to minimize false failures; on a selector miss, a single bounded
  Claude "self-heal vs real bug" triage call (also budget-capped).

## 7. Job queue (Pi ↔ laptop)

- **DB-backed queue on Neon** — no new infra (consistent with the project's
  "no extra infra" choices, e.g. attachments in `bytea`).
- New `TestJob`-style claim: worker polls for runs in `EXECUTING` with an
  unclaimed/lease-expired job, atomically claims via a conditional `updateMany`
  (lease + heartbeat), executes, writes `TestResult`s, releases.
- Poll interval tuned to balance latency vs Neon scale-to-zero wake cost
  (e.g. 5–10s while a run is active; idle backoff otherwise).
- Worker auth: a dedicated service token (worker role), outbound HTTPS only.
- Crash recovery: lease expiry returns an abandoned job to the pool; the run
  stays `EXECUTING` until results complete or a max-age fails it.

## 8. Security model (non-prod only)

Even non-prod gets guardrails so a misconfigured target can't be hit:

- **Per-project target config**: base URL(s) + **host allowlist**; worker refuses
  any request to a host not on the list.
- **Non-prod assertion**: project marks its QA target as non-prod; no prod URL
  accepted in v1 (prod support is an explicit future opt-in with extra guards).
- **Secrets vault**: test credentials/API keys encrypted at rest, never logged,
  injected into the artifact at run time only.
- **Confirm gate before EXECUTING** stays — a human approves the compiled run.
- Evidence (screenshots/responses) scrubbed of secret headers before storage.

## 9. Windows laptop worker setup

- **Runtime**: Node 20 worker process; **Playwright** with bundled Chromium.
- **Run as**: native Node service (simplest on Windows) or WSL2/Docker if preferred.
  Auto-start on boot + auto-restart (Windows Service / Task Scheduler / `pm2`).
- **Config**: `.env` with backend URL + worker service token + poll interval.
- **Network**: outbound to the Pi backend + the non-prod targets only.
- **Updates**: worker version pinned; compiled artifacts are backend-authored so the
  worker stays a thin, stable executor.

## 10. Incremental sub-phase breakdown

Per the project's one-sub-phase-at-a-time rule (APPROVE between each):

| Sub-phase | Scope |
|---|---|
| **QAX-1** | Data model + state machine: `TestRun/Scenario/Step/Result` schema (additive), QA phase state transitions, no execution yet. Pure domain + unit tests. |
| **QAX-2** | AI gen + compile: scenario draft → step draft → compile to `artifactSpec` (HTTP + Playwright), behind confirm gates. Reuses `generation.service`. |
| **QAX-3** | Worker + queue (API tests only): `TestJob` claim/lease, Windows worker skeleton, run HTTP artifacts, write results. Non-prod allowlist + secrets vault. |
| **QAX-4** | Browser execution: Playwright runner on the worker, evidence capture, resilient-locator + bounded self-heal triage. |
| **QAX-5** | UATR export: build `.xlsx` from stored results, persist per run in Neon, download + history UI. |
| **QAX-6** | FE: QA phase screens (scenario/step review, run status, results review, export download). |

## 11. Deferred / open

- **Prod target support** (extra guardrails: read-only mode, destructive-op block,
  stricter opt-in) — explicitly out of v1.
- Worker autoscaling / multiple workers — single laptop worker is enough at current
  volume; queue design already allows adding workers later.
- Carryover platform debt (FE budget UI, JWT role staleness, PDF token budget) —
  tracked separately, not part of this feature.
```
