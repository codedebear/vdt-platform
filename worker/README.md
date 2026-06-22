# VDT QA Execution Worker (QAX-3C / QAX-4)

A small Node service that runs the platform's compiled QA tests. It polls the VDT
backend for runs that are EXECUTING, runs each step's artifact against the
project's configured **non-production** target, and reports PASS/FAIL with
evidence. It supports two artifact kinds:

- **HTTP** — an API request + assertions (`statusCode`, `jsonPath`, `bodyContains`,
  `headerContains`); evidence = the response.
- **BROWSER** — ordered Playwright actions (`goto`, `click`, `fill`, `select`,
  `waitFor`) + assertions (`textVisible`, `urlContains`, `elementVisible`) on
  headless Chromium; evidence = a viewport screenshot per step.

Run it on a dedicated always-on machine. It needs no inbound ports — it only makes
outbound calls to the backend and the test target.

## Recommended: run in Docker (isolated)

Running the worker in a container keeps it **isolated from the host filesystem** —
with no volumes mounted it cannot read or modify any file on your machine (e.g.
documents, cloud-synced folders). The Playwright base image already bundles the
matching browsers, so there is nothing to install on the host but Docker.

```bash
cd worker
cp .env.example .env       # then edit .env (see the table below)

docker compose up --build  # start; Ctrl-C to stop (add -d to run in the background)
docker compose down        # stop and remove the container
```

Start it only when you want to run tests, and `down` it when finished — outbound
connections happen only while it is up, and nothing persists on the host.

Requirements on the host: **Docker Desktop** (Apple Silicon supported; the image
runs natively on arm64). No Node install needed.

## Alternative: run directly with Node

```bash
cd worker
npm install
npx playwright install chromium   # one-time: download the browser
cp .env.example .env              # then edit .env
npm start                         # poll + execute continuously
```

For an always-on bare-metal worker, supervise it (e.g. **PM2**:
`pm2 start npm --name vdt-qa-worker -- start && pm2 save && pm2 startup`).

## Configuration (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VDT_API_URL` | ✅ | Backend base URL, e.g. `http://192.168.1.13:4000` |
| `WORKER_TOKEN` | ✅ | Must match the backend's `WORKER_TOKEN` |
| `WORKER_ID` | | Label for this worker (lease holder); defaults to `worker-<pid>` |
| `WORKER_POLL_MS` | | Idle poll interval (default 5000) |
| `WORKER_LEASE_MS` | | Must match the backend lease (default 120000); heartbeat is half |
| `WORKER_HTTP_TIMEOUT_MS` | | Per-request timeout for HTTP steps (default 30000) |
| `WORKER_BROWSER_TIMEOUT_MS` | | Per-action/assertion timeout for browser steps (default 30000) |
| `WORKER_MAX_EVIDENCE_BYTES` | | Cap for the base64 evidence per step (default 1500000) |

## Development

```bash
npm test         # pure unit tests (resolve / jsonpath / assertions / selectors)
npm run typecheck
```

## What it does per step

**HTTP:**

1. Resolve `${VAR}` placeholders from the run's secrets (fails the step if any are missing).
2. Build the absolute URL from the project's base URL + the artifact's relative path.
3. **Enforce the host allowlist** — refuse any host the project did not allow.
4. Send the request, time it, evaluate the assertions.

**BROWSER:**

1. Resolve `${VAR}` placeholders across the artifact (goto path, selector text, fill values).
2. Run the actions in order on a headless Chromium page. One browser **context per
   scenario** — steps within a scenario share session state (e.g. login); scenarios
   are isolated from each other.
3. `goto` targets are checked against the **host allowlist**.
4. Evaluate the assertions and capture a viewport screenshot as evidence.

Either way, the result (PASS/FAIL + evidence) is submitted. When all steps are
terminal the backend rolls the run up and moves it to RESULTS_REVIEW.

## Safety

- Only **non-prod** targets are accepted (enforced by the backend).
- The host allowlist is enforced again here, in the worker, before any HTTP request
  and any browser navigation.
- Secrets are received over the authenticated channel and used only at run time;
  they are never written to disk or logged.
- In Docker, no host volumes are mounted, so the worker process cannot touch the
  host filesystem even if a dependency misbehaves; it runs as the non-root `pwuser`.
