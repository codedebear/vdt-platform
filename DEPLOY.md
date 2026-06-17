# Docker Deploy — VDT Platform (Dev Sub-phase 1)

Backend API + JWT auth, running in Docker on a Raspberry Pi.
Database is **Neon** (managed serverless Postgres) — no DB container on the Pi.

Code is on GitHub: `https://github.com/codedebear/vdt-platform` (branch `main`, commit `8edb344`).

---

## 0. (Already done from the build side)
Sub-phase 1 has been committed and pushed to `main`. Nothing to do here — go to step 1 on the Pi.

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

```bash
cp .env.example .env
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

> Do not commit this file. Keep the Neon password and JWT secret off git.

---

## 3. Build & run

```bash
docker compose up --build -d
```

On first start the container runs `prisma db push` to sync the `User` table
to Neon, then boots the API. (Prisma's engine is generated inside the build on
the Pi, so the correct ARM build is selected automatically.)

---

## 4. Verify the container is running

```bash
docker ps
docker compose logs -f backend     # Ctrl+C to stop following
```

Expect to see the server listening on port 4000 and no Prisma connection errors.

Service available at: `http://localhost:4000`

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
| Container exits immediately, logs show Prisma `P1001` | Can't reach Neon — check `DATABASE_URL` and that it ends with `?sslmode=require`; Neon may need a few seconds to wake from scale-to-zero. |
| `JWT_SECRET must be at least 16 characters` on boot | `JWT_SECRET` in `.env` is too short. |
| `port is already allocated` | Something else uses 4000 — change `PORT` in `.env` and rebuild. |
| Build fails on `prisma generate` (ARM) | Ensure you built on the Pi itself (not cross-built); re-run `docker compose build --no-cache backend`. |
