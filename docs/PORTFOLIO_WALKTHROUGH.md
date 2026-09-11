# Portfolio walkthrough

This is the shortest path for a reviewer to understand Taskflow without a frontend. It demonstrates the API contract, auth scopes, durable scheduling, Redis projection, execution history, cancellation semantics, callbacks, health, and metrics.

## 1. Start the stack

```bash
docker compose up --build
```

Wait until the API is healthy, then open:

```text
http://localhost:4000/docs
```

Swagger UI is the interactive API surface. The raw contract is at `/openapi.json`.

The default local credential is:

```text
local.dev-local-client-secret
```

## 2. Verify identity

```bash
curl -s \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  http://localhost:4000/v1/auth/whoami
```

This demonstrates named client identity plus authorization scopes.

## 3. Create an immediate job

```bash
curl -s -X POST http://localhost:4000/v1/jobs \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  -H 'Content-Type: application/json' \
  -H 'x-request-id: portfolio-job-1' \
  -d '{
    "type": "log_message",
    "payload": { "message": "hello from the Taskflow walkthrough" },
    "schedule": { "type": "once" },
    "idempotencyKey": "portfolio-job-1",
    "maxAttempts": 3
  }'
```

Save the returned `id` as `JOB_ID`.

What this demonstrates: input validation, request correlation, durable PostgreSQL creation, deterministic BullMQ projection, and idempotency.

## 4. Repeat the same create request

Run the exact same command again. The returned job ID should be the same.

What this demonstrates: the database unique constraint is the concurrency boundary for idempotent creation, and a repeat request can also repair a missing Redis projection after an ambiguous queue failure.

## 5. Inspect the job and attempts

```bash
curl -s \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  http://localhost:4000/v1/jobs/$JOB_ID
```

Then query the paginated audit trail:

```bash
curl -s \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  "http://localhost:4000/v1/jobs/$JOB_ID/executions?limit=10"
```

What this demonstrates: BullMQ owns retry mechanics while PostgreSQL keeps durable attempt history.

## 6. Create and cancel a future job

```bash
RUN_AT=$(node -e 'console.log(new Date(Date.now()+600000).toISOString())')

curl -s -X POST http://localhost:4000/v1/jobs \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"log_message\",\"payload\":{\"message\":\"cancel me\"},\"schedule\":{\"type\":\"once\",\"runAt\":\"$RUN_AT\"}}"
```

Save that ID as `CANCEL_ID`, then:

```bash
curl -s -X POST \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  http://localhost:4000/v1/jobs/$CANCEL_ID/cancel
```

What this demonstrates: durable-first cancellation. PostgreSQL moves `SCHEDULED -> CANCELLED` before best-effort queue cleanup, preventing a worker from legitimately claiming the job afterward.

## 7. Create a recurring job

```bash
curl -s -X POST http://localhost:4000/v1/jobs \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "log_message",
    "payload": { "message": "recurring demo" },
    "schedule": { "type": "recurring", "cron": "*/5 * * * *", "timezone": "UTC" }
  }'
```

What this demonstrates: BullMQ v5 Job Schedulers, overlap-safe durable claims, and execution history that can grow without unbounded response payloads.

## 8. Inspect operational state

```bash
curl -s \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  http://localhost:4000/v1/operations/overview
```

```bash
curl -s \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  http://localhost:4000/metrics
```

What this demonstrates: a human-readable operations endpoint plus Prometheus-compatible metrics for queue and durable state.

## 9. Inspect health semantics

```bash
curl -s http://localhost:4000/health/live
curl -s http://localhost:4000/health/ready
```

What this demonstrates: process liveness is kept separate from dependency readiness.

## 10. Demonstrate authorization boundaries

For a production-style configuration, start Taskflow with separate clients such as a reader, writer, and operator. A client with only `jobs.read` can list jobs but receives `403 FORBIDDEN` when attempting `POST /v1/jobs`. The integration test suite exercises this boundary with real HTTP calls.

## 11. Completion callback path

Create a job with a `callbackUrl` pointing at a receiver you control. Taskflow persists callback intent, queues delivery independently, signs the exact JSON body with HMAC-SHA256, and retries callback failures without rerunning the business job.

See [CALLBACKS.md](./CALLBACKS.md) for a verification implementation and delivery semantics.

## 12. Architecture discussion points

The design choices worth calling out in an interview are:

- PostgreSQL is the durable source of truth; Redis/BullMQ is rebuildable execution infrastructure.
- Idempotency is enforced by a database uniqueness boundary, not only an in-memory check.
- Cancellation and first execution claims use durable state transitions to avoid races.
- Handler throttling happens before an attempt becomes `RUNNING`, so capacity waiting does not consume retry budget.
- Distributed concurrency leases use Redis time, avoiding worker clock-skew decisions.
- Callback delivery is isolated from business execution so notification failures cannot duplicate handler side effects.
- Outbound HTTP and callbacks have SSRF defenses, redirect blocking, and production hostname allowlists.
- API callers are named and scope-limited rather than sharing one production-wide secret.
- The runtime image stays minimal; a separate migration image target handles schema deployment.
- The project has no frontend by design, so Swagger, OpenAPI, curl examples, metrics, and runbooks form the reviewer-facing product surface.
