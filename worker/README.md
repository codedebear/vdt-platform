# VDT QA Execution Worker (QAX-3C)

A small Node service that runs the platform's compiled QA tests. It polls the VDT
backend for runs that are EXECUTING, runs each step's **HTTP** artifact against the
project's configured **non-production** target, and reports PASS/FAIL with the
response captured as evidence. BROWSER steps are reported as **SKIPPED** until the
Playwright worker (QAX-4) lands.

Run it on a dedicated always-on machine (e.g. the spare Windows laptop). It needs
no inbound ports — it only makes outbound calls to the backend and the test target.

## Prerequisites

- Node.js 20+
- Network access to the VDT backend and to the non-prod target system

## Setup

```bash
cd worker
npm install
cp .env.example .env       # then edit .env
```

Set in `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `VDT_API_URL` | ✅ | Backend base URL, e.g. `http://192.168.1.13:4000` |
| `WORKER_TOKEN` | ✅ | Must match the backend's `WORKER_TOKEN` |
| `WORKER_ID` | | Label for this worker (lease holder); defaults to `worker-<pid>` |
| `WORKER_POLL_MS` | | Idle poll interval (default 5000) |
| `WORKER_LEASE_MS` | | Must match the backend lease (default 120000); heartbeat is half |
| `WORKER_HTTP_TIMEOUT_MS` | | Per-request timeout (default 30000) |

## Run

```bash
npm start        # poll + execute continuously
npm test         # unit tests for the pure core (resolve / jsonpath / assertions)
npm run typecheck
```

## Run continuously on Windows

Use any process supervisor so it restarts on boot/crash, e.g. **PM2**:

```bash
npm install -g pm2
pm2 start npm --name vdt-qa-worker -- start
pm2 save
pm2 startup        # follow the printed instructions to start on boot
```

(or Task Scheduler running `npm start` in this folder at logon.)

## What it does per step

1. Resolve `${VAR}` placeholders from the run's secrets (fails the step if any are missing).
2. Build the absolute URL from the project's base URL + the artifact's relative path.
3. **Enforce the host allowlist** — refuse any host the project did not allow.
4. Send the request, time it, evaluate the assertions (`statusCode`, `jsonPath`,
   `bodyContains`, `headerContains`).
5. Submit the result (PASS/FAIL + the response as evidence). When all steps are
   terminal the backend rolls the run up and moves it to RESULTS_REVIEW.

## Safety

- Only **non-prod** targets are accepted (enforced by the backend).
- The host allowlist is enforced again here, in the worker, before any request.
- Secrets are received over the authenticated channel and used only at run time;
  they are never written to disk or logged.
