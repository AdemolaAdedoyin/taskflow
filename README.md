# Taskflow — Durable Job Scheduling & Queue System

[![CI](https://github.com/AdemolaAdedoyin/taskflow/actions/workflows/ci.yml/badge.svg)](https://github.com/AdemolaAdedoyin/taskflow/actions/workflows/ci.yml)

I built Taskflow as a backend-focused scheduling service for work that needs to run later, retry safely, execute on a recurring schedule, and remain understandable when infrastructure partially fails. PostgreSQL is the durable source of truth; Redis/BullMQ is the execution layer.

There is intentionally no frontend. The product surface is the API itself: OpenAPI/Swagger, scoped credentials, durable execution history, signed completion callbacks, health/readiness probes, Prometheus metrics, and operational documentation.

**Stack:** Node.js, TypeScript, Express, PostgreSQL + Prisma, Redis + BullMQ, Zod, Pino, Vitest, OpenAPI/Swagger, Docker Compose, GitHub Actions.

## What this project demonstrates

- **Durable scheduling** — job definitions live in PostgreSQL while Redis/BullMQ is treated as rebuildable execution infrastructure.
- **Idempotent creation and recovery** — a database uniqueness boundary prevents duplicate durable jobs, request fingerprints reject accidental key reuse for different work, and repeat requests can repair missing queue projections.
- **One-off and recurring jobs** — deterministic delayed-job IDs plus BullMQ v5 Job Schedulers.
- **Concurrency-safe state transitions** — first execution claims and cancellation are coordinated through durable PostgreSQL state.
- **Crash recovery for running work** — active executions maintain durable heartbeats; stale `RUNNING` executions are failed and made schedulable again after a worker disappears.
- **Retry audit history** — BullMQ handles retry/backoff while every actual attempt is recorded as a `JobExecution`.
- **Scalable history** — cursor-paginated execution history avoids unbounded relation loads for long-lived recurring jobs.
- **Distributed handler limits** — Redis-backed concurrency leases and fixed-window rate limits coordinate capacity across worker replicas without consuming retry attempts while waiting.
- **Durable signed callbacks** — completion callbacks are persisted before enqueue, retried independently, HMAC-signed, SSRF-checked, and recoverable after Redis failures.
- **Least-privilege API access** — named production clients use explicit `jobs.read`, `jobs.write`, and `operations.read` scopes.
- **Security boundaries** — constant-time secret comparison, rate limits, CORS/proxy configuration, SSRF defenses, redirect blocking, bounded outbound response reads, and production outbound-host allowlists.
- **Operational visibility** — request IDs, structured logs, liveness/readiness, JSON operations overview, and Prometheus-compatible metrics.
- **Production runtime model** — separate API and worker processes plus a one-off migration image target, with non-root/minimal long-lived runtime containers.
- **Real integration coverage** — CI runs PostgreSQL and Redis, applies migrations, exercises real HTTP + queue/database coordination, audits production dependencies, builds TypeScript, and builds both migration and runtime images.

## Architecture

```mermaid
flowchart LR
    Client[Named API client] -->|Bearer clientId.secret| API[Express API]
    API --> Auth[Authentication + scope gate]
    Auth --> PG[(PostgreSQL)]
    Auth --> Redis[(Redis / BullMQ)]

    Redis --> Worker[BullMQ worker]
    Worker --> Limits[Distributed handler limits]
    Limits --> Handler[Handler registry]
    Worker -->|claim + execution audit| PG

    Worker -->|persist delivery| PG
    Worker --> CallbackQ[Callback queue]
    CallbackQ --> CallbackWorker[Callback worker]
    CallbackWorker -->|HMAC-signed POST| Subscriber[Subscriber]

    API --> Ops[Health / Operations / Metrics]
    Ops --> PG
    Ops --> Redis
```

The central design decision is **Postgres before Redis**. If a request commits durable state and the subsequent queue write fails, Taskflow keeps the durable row and repairs the Redis projection later instead of pretending the whole operation never happened.

## API surface

When Taskflow is running:

- Swagger UI: `http://localhost:4000/docs`
- OpenAPI JSON: `http://localhost:4000/openapi.json`
- Liveness: `GET /health/live`
- Readiness: `GET /health/ready`
- Identity: `GET /v1/auth/whoami`
- Create/list jobs: `POST|GET /v1/jobs`
- Job detail: `GET /v1/jobs/:id`
- Execution history: `GET /v1/jobs/:id/executions`
- Cancellation: `POST /v1/jobs/:id/cancel`
- Operations overview: `GET /v1/operations/overview`
- Prometheus metrics: `GET /metrics`

Production bearer tokens use:

```text
Authorization: Bearer <clientId>.<secret>
```

Available scopes are `jobs.read`, `jobs.write`, `operations.read`, and `*`.

## Documentation

Because Taskflow is API-only, I treat documentation as part of the implementation:

- **[API guide](docs/API_GUIDE.md)** — auth, scopes, endpoint catalog, job lifecycle, idempotency, pagination, cancellation, errors, operations, and metrics.
- **[Portfolio walkthrough](docs/PORTFOLIO_WALKTHROUGH.md)** — a reviewer-friendly curl/Swagger demo and the system-design decisions worth discussing in an interview.
- **[Completion callbacks](docs/CALLBACKS.md)** — event contract, HMAC verification, idempotent consumption, retry behavior, and destination security.
- **[Operations runbook](docs/RUNBOOK.md)** — deployment order, health semantics, scaling, outage handling, backlog diagnosis, recovery, and secret rotation.
- **[Production deployment example](deploy/README.md)** — migration target, API/worker runtime model, managed PostgreSQL/Redis topology, and rollout sequence.
- **[`openapi.yaml`](openapi.yaml)** — machine-readable contract used directly by the built-in Swagger UI.

## Run locally

The fastest path is Docker Compose:

```bash
docker compose up --build
```

Compose starts PostgreSQL and Redis, runs the migration target once, then starts the API and worker. The default local credential is:

```text
local.dev-local-client-secret
```

Check the runtime:

```bash
curl http://localhost:4000/health/ready

curl -H 'Authorization: Bearer local.dev-local-client-secret' \
  http://localhost:4000/v1/auth/whoami
```

Then open `http://localhost:4000/docs` or follow the [portfolio walkthrough](docs/PORTFOLIO_WALKTHROUGH.md).

### Local Node processes

If PostgreSQL and Redis are already running:

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

In another terminal:

```bash
npm run worker:dev
```

## Example job

```bash
curl -X POST http://localhost:4000/v1/jobs \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  -H 'Content-Type: application/json' \
  -H 'x-request-id: readme-demo-1' \
  -d '{
    "type": "log_message",
    "payload": { "message": "hello from Taskflow" },
    "schedule": { "type": "once" },
    "idempotencyKey": "readme-demo-1",
    "maxAttempts": 3
  }'
```

Repeat the same request with the same `idempotencyKey`: Taskflow returns the same durable job and can repair its Redis projection if the original request committed to PostgreSQL but queueing failed. Reusing that key for a different normalized job definition returns `409 CONFLICT`.

## Reliability and security decisions

**Durable cancellation first.** Taskflow atomically changes `SCHEDULED -> CANCELLED` in PostgreSQL before best-effort queue cleanup. A worker therefore cannot legitimately claim a cancelled job even if Redis cleanup fails.

**No fake cancellation of running work.** Taskflow returns a conflict instead of claiming an arbitrary running handler was safely pre-empted.

**Running work has a durable lease.** Each `RUNNING` execution refreshes a PostgreSQL heartbeat. If a worker disappears, stale executions are marked failed and their jobs return to `SCHEDULED`; a live worker whose execution lease was recovered cannot later overwrite that recovered execution as successful.

**Capacity waiting is not a business attempt.** Per-handler concurrency/rate checks happen before the durable `RUNNING` transition. A throttled job goes back to BullMQ's delayed set without burning retry budget or creating a fake execution row.

**Crash-safe distributed concurrency.** Handler permits are renewable expiring Redis leases coordinated against Redis time rather than individual worker clocks.

**Callbacks are a separate failure domain.** Callback intent is durable and callback retries never turn a completed business execution back into work that should run again.

**Outbound networking is opt-in in production.** HTTP jobs and callbacks use SSRF checks, do not follow redirects, require explicitly allowed production hostnames, and cap response bodies before storing/logging excerpts.

**API clients are least-privilege.** Authentication identifies a named client; authorization independently checks the endpoint's required scope. Invalid credentials produce `401`; insufficient scope produces `403`.

**Migrations are not hidden inside the runtime image.** The normal long-lived image prunes development tooling. A dedicated Docker `migrator` target runs schema migrations once per release before API/worker rollout.

## Testing and CI

Unit tests:

```bash
npm test
```

The CI integration path uses real PostgreSQL and Redis, applies migrations to a fresh database, verifies API authorization and durable/queue behavior, tests stale-execution recovery and distributed limits, builds the TypeScript project, audits production dependencies, and builds both Docker targets.

## Project layout

```text
docs/                       # API guide, callbacks, runbook, reviewer walkthrough
deploy/                     # production deployment example and env template
prisma/                     # schema + migrations
src/
  modules/
    auth/                   # authenticated client identity
    health/                 # liveness/readiness
    jobs/                   # HTTP validation + job service
    metrics/                # Prometheus export
    operations/             # scoped runtime overview
  queue/
    handlers/               # pluggable business handlers
    jobQueue.ts             # enqueue/scheduler helpers
    handlerLimits.ts        # distributed concurrency/rate coordination
    executionLease.ts       # durable execution heartbeat + stale recovery
    callbackQueue.ts        # callback queue
    callbackDelivery.ts     # callback lifecycle/signing/delivery
    reconcile.ts            # repair queue projections
    worker.ts               # jobs + callbacks + graceful shutdown
  middleware/               # auth/authorization + error handling
  __tests__/                # unit + real runtime integration coverage
openapi.yaml                # Swagger/OpenAPI contract
Dockerfile                  # builder, migrator, hardened runtime targets
docker-compose.yml
.github/workflows/ci.yml
```

## TODO / future improvements

These are intentionally left as future scale/operational improvements rather than missing portfolio fundamentals:

- **Bound reconciliation work** — paginate/batch scheduled-job and pending-callback reconciliation instead of scanning a potentially large durable set at startup; add bounded parallelism with backpressure.
- **Direct recurring-scheduler lookup** — avoid `getJobSchedulers()` + in-memory search when deriving the next recurring run at very high scheduler cardinality.
- **Validate handler payloads at the API boundary** — evolve the handler registry to expose both a request schema and executor so malformed handler-specific payloads fail with `422` before they are scheduled, while retaining worker-side validation as defense in depth.
- **Dependency maintenance** — upgrade deprecated `cron-parser` v4 and refresh GitHub Actions/dependency versions to clear remaining deprecation warnings and non-blocking audit findings while preserving the current production audit gate.
- **Repository governance** — enable `main` branch protection/rulesets requiring CI before merge when repository administration settings are available.
