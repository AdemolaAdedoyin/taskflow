# Taskflow — Job Scheduling & Queue System

A backend service for running work later, or on a schedule: one-off delayed
jobs and cron-style recurring jobs, with priorities, automatic retries with
backoff, idempotent creation, and a pluggable handler registry. Pure API —
no UI, documented with OpenAPI/Swagger.

**Stack:** Node.js, TypeScript, Express, PostgreSQL (Prisma), Redis + BullMQ
(v5 Job Schedulers).

## Why this exists

A job/task queue is one of the most common pieces of backend infrastructure,
and building one well touches several distinct problems:

- **Two scheduling models, one engine** — a one-off job (`runAt`) and a
  recurring job (`cron`) both end up as BullMQ jobs, but recurring jobs use
  BullMQ v5's **Job Scheduler** API (`upsertJobScheduler`) rather than manual
  re-enqueueing, so a missed tick can't silently stop the schedule.
- **Idempotent creation** — `POST /v1/jobs` accepts an `idempotencyKey`; a
  retried request with the same key returns the existing job instead of
  scheduling duplicate work, which matters a lot for anything triggered from
  an at-least-once event system (like the companion `webhook-relay` project).
- **Retries are the framework's job, audit trail is ours** — attempt-level
  retry/backoff is delegated to BullMQ's native `attempts`/`backoff` options
  (simpler than reimplementing it), while every individual attempt is still
  recorded in Postgres as a `JobExecution` row so there's a durable history
  independent of what's currently in Redis.
- **Pluggable handlers** — job `type` maps to a handler function via a small
  registry (`src/queue/handlers/index.ts`). Adding a new kind of job is
  "write a handler, register it" — nothing else changes.

## Architecture

```
 POST /v1/jobs               ┌──────────────┐
 ────────────────────────────▶│ API (Express) │── INSERT Job
                              └──────┬───────┘
                                     │ once: enqueue with delay
                                     │ recurring: upsertJobScheduler(cron)
                                     ▼
                              ┌──────────────┐
                              │ Redis (BullMQ)│
                              └──────┬───────┘
                                     │ fires on schedule
                                     ▼
                              ┌──────────────┐      handlerRegistry[type]
                              │  Job Worker   │ ───────────────────────────▶ handler(payload)
                              └──────┬───────┘
                                     │ record attempt
                                     ▼
                              ┌──────────────┐
                              │  PostgreSQL   │  Job + JobExecution history
                              └──────────────┘
```

## Project structure

```
src/
  modules/jobs/         # routes.ts (HTTP + validation) + service.ts (business logic)
  queue/
    jobQueue.ts          # enqueue helpers (once vs. recurring via Job Schedulers)
    worker.ts            # executes jobs, records JobExecution rows
    handlers/            # the extensibility point — one file per job type
  lib/                   # cron validation, errors, logging
  middleware/            # bearer-token auth, centralized error handling
  __tests__/              # vitest: cron validation, handler registry, service logic
prisma/schema.prisma     # Job, JobExecution
openapi.yaml             # served at /docs via Swagger UI
```

## Running it locally

**With Docker (recommended):**

```bash
TASKFLOW_API_KEY=$(openssl rand -hex 24) docker compose up --build
```

API on http://localhost:4000, interactive docs at http://localhost:4000/docs.

**Without Docker**, with local Postgres + Redis:

```bash
cp .env.example .env       # set DATABASE_URL, REDIS_URL, TASKFLOW_API_KEY
npm install
npx prisma migrate dev
npm run dev                 # API on :4000
npm run worker:dev          # in a second terminal
```

```bash
# populate a few example jobs
TASKFLOW_API_KEY=<your key> npm run seed
```

## Trying it via the API

```bash
# A job that runs in 5 minutes
curl -X POST http://localhost:4000/v1/jobs \
  -H "Authorization: Bearer <your key>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "http_request",
    "payload": { "url": "https://example.com/cache/warm", "method": "POST" },
    "schedule": { "type": "once", "runAt": "2026-09-11T20:00:00Z" },
    "maxAttempts": 3
  }'

# A recurring job, every day at 2am UTC
curl -X POST http://localhost:4000/v1/jobs \
  -H "Authorization: Bearer <your key>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "log_message",
    "payload": { "message": "nightly cleanup" },
    "schedule": { "type": "recurring", "cron": "0 2 * * *" }
  }'

# Check status + execution history
curl -H "Authorization: Bearer <your key>" http://localhost:4000/v1/jobs/<job-id>
```

Built-in job types: `http_request` (call any URL), `log_message` (writes a
structured log line — good for smoke-testing), and `simulate_failure`
(deterministically fails N times before succeeding, useful for demonstrating
retry/backoff without a flaky real dependency).

## Tests

```bash
npm test
```

Covers cron expression validation, handler resolution, and job creation
logic (once vs. recurring, idempotency, invalid handler/cron rejection)
against a mocked Prisma client and mocked queue.

## What I'd add with more time

- Webhooks/callbacks on job completion, so callers don't have to poll
  `GET /v1/jobs/:id`
- A `/v1/jobs/:id/executions` endpoint with pagination, for jobs with long
  execution histories
- Per-type concurrency limits (e.g. cap `http_request` jobs separately from
  `log_message` jobs) using BullMQ's group/rate-limit features
- A small admin UI — deliberately left as a pure API here to demonstrate
  OpenAPI-first design, but the same dashboard pattern from `webhook-relay`
  would drop in cleanly
