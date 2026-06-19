# Docker Deploy — VDT Platform

Backend API (JWT auth, RBAC, AI phase generation) running in Docker on a Raspberry Pi.
Database is **Neon** (managed serverless Postgres) — no DB container on the Pi.

Code is on GitHub: `https://github.com/codedebear/vdt-platform` (branch `main`).

---

## 0. (Already done from the build side)
The latest sub-phase has been committed and pushed to `main`. Nothing to do here — go to step 1 on the Pi.

---

## 1. On the Raspberry Pi — get the code

First time (clone):
```bash
cd ~
git clone https://github.com/codedebear/vdt-platform.git
cd vdt-platform
```

Already cloned before (pull latest):
```bash
cd ~/vdt-platform
git pull origin main
```

> If git asks for credentials on a private repo, use your GitHub username +
> a fine-grained PAT as the password (the same PAT type used to push).

---

## 2. Create the `.env` (repo root, next to docker-compose.yml)

`.env` is **gitignored**, so it is NOT in the clone — you must create it on the Pi.

> ⚠️ **Do this only if `.env` does not already exist.** Never run `cp .env.example .env`
> over a working `.env` — it overwrites your real secrets with placeholders. The
> example's `DATABASE_URL` contains `<...>` angle brackets, which Prisma rejects at
> boot with `P1013: invalid domain character in database URL` and crash-loops the
> backend. The safe command below refuses to clobber an existing file:

```bash
[ -f .env ] && echo ".env already exists — leaving it untouched" || cp .env.example .env
nano .env
```

Fill in these keys:

| Variable | Value to use |
|----------|--------------|
| `DATABASE_URL` | Your Neon connection string, ending `?sslmode=require` (host `ep-late-rain-aoc0pn1d.c-2.ap-southeast-1.aws.neon.tech`, db `neondb`) |
| `JWT_SECRET` | A random string, **min 16 chars** (e.g. `openssl rand -hex 24`) |
| `JWT_EXPIRES_IN` | `8h` |
| `PORT` | `4000` |
| `NODE_ENV` | `production` |
| `ANTHROPIC_API_KEY` | Your Anthropic key (optional — `/generate` returns `503` without it) |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` (default; override if needed) |
| `ANTHROPIC_MAX_TOKENS` | `8000` (default) |
| `ANTHROPIC_TIMEOUT_MS` | `120000` (default) |
| `ANTHROPIC_MAX_RETRIES` | `2` (default) |
| `GENERATE_RATE_LIMIT_PER_MIN` | `10` (default) — per-user limit on `/generate` |
| `GENERATE_MAX_PER_RUN` | `5` (default) — max regenerations per phase run |

> Do not commit this file. Keep the Neon password, JWT secret, and Anthropic key off git.
> The `ANTHROPIC_*` and `GENERATE_*` keys have safe defaults in `docker-compose.yml`, so
> you only need to set `ANTHROPIC_API_KEY` to enable AI generation; the rest are optional.

---

## 3. Build & run

```bash
docker compose up --build -d
```

On first start the container runs `prisma db push` to sync the schema
(`User`, `Project`, `PhaseExecution`) to Neon, then boots the API. (Prisma's
engine is generated inside the build on the Pi, so the correct ARM build is
selected automatically.)

> **Assigning roles.** Every registration creates an `OPERATION` user. To grant
> a worker or owner role, run SQL against Neon after the user registers, e.g.
> `UPDATE "User" SET role = 'PROJECT_OWNER' WHERE email = 'owner@codedebear.com';`
> Valid roles: `SUPER_ADMIN`, `PROJECT_OWNER`, `BA`, `SA`, `QA`, `OPERATION`
> (see `qa/seed-roles.sql`). A user-management endpoint/UI is a planned follow-up.

---

## 4. Verify the container is running

```bash
docker compose ps                  # both backend AND frontend should be "Up"
docker compose logs -f backend     # Ctrl+C to stop following
```

Expect to see the server listening on port 4000 and no Prisma connection errors.

Services available at:
- **App (SPA):** `http://localhost:8080` (or `http://<pi-lan-ip>:8080`) — port set by `FRONTEND_PORT`.
- **API:** `http://localhost:4000`.

`docker compose up --build -d` builds and runs **both** containers. The frontend
(`nginx:alpine`) serves the built React app and proxies `/api` + `/health` to the
`backend` container — so a `502` on those paths means the backend is down, not a
frontend problem (see Troubleshooting).

---

## 5. QA smoke test (run on the Pi or any machine that can reach it)

Replace `localhost` with the Pi's LAN IP if testing from another machine.

**a) Health check** — expect `200 {"status":"ok"}`
```bash
curl -i http://localhost:4000/health
```

**b) Register a user** — expect `201`
```bash
curl -i -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@codedebear.com","password":"changeme123","name":"Admin"}'
```

**c) Login** — expect `200` with a JWT `token` in the response
```bash
curl -i -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@codedebear.com","password":"changeme123"}'
```

**d) Validation check** — expect `400` (password too short / missing fields)
```bash
curl -i -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"bad@x.com","password":"123","name":"x"}'
```

**e) Frontend smoke** — expect `13/13` (SPA routing, security headers, `/api`+`/health` proxy)
```bash
BASE_URL=http://localhost:8080 ./qa/smoke-frontend.sh
```

---

## 6. Useful ops commands

```bash
docker compose restart backend     # restart after an env change
docker compose down                # stop and remove the container
docker compose up --build -d       # rebuild after a git pull
docker compose logs --tail=100 backend
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Backend `Restarting`, logs show Prisma `P1013: invalid domain character in database URL` | `DATABASE_URL` is malformed — usually the `.env` was overwritten by the placeholder (contains `<...>`), or the password has unescaped special chars. Restore the real Neon string and `docker compose up -d backend`. |
| Frontend reachable but `/api`/`/health` return `502` | The backend container is down/crash-looping (nginx is fine). Check `docker compose ps` + `docker compose logs backend`; fix the backend, then re-run `./qa/smoke-frontend.sh`. |
| Container exits immediately, logs show Prisma `P1001` | Can't reach Neon — check `DATABASE_URL` and that it ends with `?sslmode=require`; Neon may need a few seconds to wake from scale-to-zero. |
| `JWT_SECRET must be at least 16 characters` on boot | `JWT_SECRET` in `.env` is too short. |
| `port is already allocated` | Something else uses 4000 — change `PORT` in `.env` and rebuild. |
| Build fails on `prisma generate` (ARM) | Ensure you built on the Pi itself (not cross-built); re-run `docker compose build --no-cache backend`. |
