# Taskflow API guide

Taskflow is intentionally backend-only. The API contract, Swagger UI, health endpoints, metrics, and operational runbooks are the product surface a reviewer or integrator uses instead of a frontend.

## Start locally

The fastest path is Docker Compose:

```bash
docker compose up --build
```

This starts PostgreSQL, Redis, a one-off migration service, the API, and the worker. The API listens on `http://localhost:4000`; Swagger UI is at `http://localhost:4000/docs`; the raw OpenAPI document is at `http://localhost:4000/openapi.json`.

The default local scoped credential is:

```text
Authorization: Bearer local.dev-local-client-secret
```

## Authentication and scopes

Production callers use named credentials configured through `TASKFLOW_API_CLIENTS` and send tokens as `<clientId>.<secret>`.

Available scopes:

| Scope | Allows |
| --- | --- |
| `jobs.read` | list jobs, read one job, read execution history |
| `jobs.write` | create and cancel jobs |
| `operations.read` | operations overview and Prometheus metrics |
| `*` | all current API capabilities |

Use `GET /v1/auth/whoami` to confirm the active client identity and scopes. Authentication failures return `401 UNAUTHORIZED`; a valid credential without the required scope returns `403 FORBIDDEN`.

## Endpoint catalog

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | public | lightweight process check |
| `GET` | `/health/live` | public | liveness probe |
| `GET` | `/health/ready` | public | PostgreSQL + Redis readiness |
| `GET` | `/docs` | public | interactive Swagger UI |
| `GET` | `/openapi.json` | public | machine-readable API contract |
| `GET` | `/metrics` | `operations.read` | Prometheus text export |
| `GET` | `/v1/auth/whoami` | authenticated | caller identity and scopes |
| `POST` | `/v1/jobs` | `jobs.write` | create one-off or recurring job |
| `GET` | `/v1/jobs` | `jobs.read` | filter/list jobs |
| `GET` | `/v1/jobs/:id` | `jobs.read` | job detail + recent attempts |
| `GET` | `/v1/jobs/:id/executions` | `jobs.read` | cursor-paginated attempt history |
| `POST` | `/v1/jobs/:id/cancel` | `jobs.write` | cancel a scheduled job |
| `GET` | `/v1/operations/overview` | `operations.read` | queue and durable-state overview |

## Job lifecycle

A one-off job normally moves through:

```text
SCHEDULED -> RUNNING -> SUCCEEDED
                    \-> FAILED
SCHEDULED -> CANCELLED
```

Recurring jobs return to `SCHEDULED` after each completed firing so BullMQ can execute the next occurrence. A `RUNNING` job cannot be reported as cancelled because Taskflow cannot safely pre-empt arbitrary handler code.

Each real handler attempt creates a durable `JobExecution` row. While a handler is running, the worker refreshes a durable heartbeat. If that heartbeat expires because a worker dies, recovery marks the abandoned execution failed and makes the job schedulable again so BullMQ can retry it safely. Waiting for a handler-level concurrency or rate-limit permit happens before the durable `RUNNING` claim, so throttling does not consume a business retry attempt.

## Create a one-off job

```bash
curl -X POST http://localhost:4000/v1/jobs \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  -H 'Content-Type: application/json' \
  -H 'x-request-id: demo-create-1' \
  -d '{
    "type": "log_message",
    "payload": { "message": "portfolio demo" },
    "schedule": { "type": "once" },
    "idempotencyKey": "portfolio-demo-1",
    "maxAttempts": 3
  }'
```

`idempotencyKey` is optional, but when supplied it is the durable duplicate boundary. Taskflow also stores a fingerprint of the normalized job definition. Repeating the same request returns the existing job and repairs a missing Redis projection if necessary; reusing the key with a different payload, schedule, callback, priority, or retry configuration returns `409 CONFLICT` instead of silently returning unrelated work.

## Create a recurring job

```bash
curl -X POST http://localhost:4000/v1/jobs \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "log_message",
    "payload": { "message": "nightly tick" },
    "schedule": {
      "type": "recurring",
      "cron": "0 2 * * *",
      "timezone": "UTC"
    }
  }'
```

Cron expressions and IANA timezones are validated together. Invalid schedule/timezone combinations return `422 VALIDATION_ERROR`.

## List and inspect jobs

```bash
curl -H 'Authorization: Bearer local.dev-local-client-secret' \
  'http://localhost:4000/v1/jobs?status=SCHEDULED&limit=25'
```

```bash
curl -H 'Authorization: Bearer local.dev-local-client-secret' \
  http://localhost:4000/v1/jobs/<job-id>
```

The detail endpoint includes the 20 most recent attempts for convenience. Use the execution-history endpoint for complete history.

## Execution-history pagination

```bash
curl -H 'Authorization: Bearer local.dev-local-client-secret' \
  'http://localhost:4000/v1/jobs/<job-id>/executions?status=FAILED&limit=50'
```

The response contains:

```json
{
  "data": [],
  "pageInfo": {
    "nextCursor": null,
    "hasMore": false
  }
}
```

The cursor is opaque. Pass `pageInfo.nextCursor` back unchanged; clients should not decode or construct it.

## Cancellation

```bash
curl -X POST \
  -H 'Authorization: Bearer local.dev-local-client-secret' \
  http://localhost:4000/v1/jobs/<job-id>/cancel
```

Cancellation first performs the durable `SCHEDULED -> CANCELLED` transition in PostgreSQL, then does best-effort BullMQ cleanup. `RUNNING` or terminal jobs return `409 CONFLICT` rather than claiming cancellation succeeded.

## Error contract

Application errors use one envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request failed validation",
    "details": {}
  }
}
```

Common codes:

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 401 | `UNAUTHORIZED` | bearer token missing or invalid |
| 403 | `FORBIDDEN` | authenticated client lacks required scope |
| 404 | `NOT_FOUND` | job or route does not exist |
| 409 | `CONFLICT` | operation conflicts with current durable state or an idempotency key was reused for different work |
| 422 | `VALIDATION_ERROR` | body/query/cursor/schedule validation failed |
| 429 | rate-limit response | API rate limit exceeded |
| 500 | `INTERNAL_ERROR` | unexpected server error; internal details are not exposed |

Every API request returns `x-request-id`; supply your own valid ID to correlate client logs with Taskflow logs.

## Operations and metrics

```bash
curl -H 'Authorization: Bearer local.dev-local-client-secret' \
  http://localhost:4000/v1/operations/overview
```

```bash
curl -H 'Authorization: Bearer local.dev-local-client-secret' \
  http://localhost:4000/metrics
```

The operations endpoint is JSON for humans/automation. `/metrics` is Prometheus text and exposes process uptime, durable job counts, BullMQ job states, callback-delivery counts, and callback queue states.

## Completion callbacks

Create requests may include `callbackUrl`. Taskflow persists callback intent and delivers it on a separate queue after a successful execution or a final failed attempt. Callback failure never causes the original business job to run again.

See [CALLBACKS.md](./CALLBACKS.md) for payloads and signature verification.

## Production operations

See [RUNBOOK.md](./RUNBOOK.md) for deployment order, migration strategy, scaling, health checks, and failure recovery. For a reviewer-friendly end-to-end demo, follow [PORTFOLIO_WALKTHROUGH.md](./PORTFOLIO_WALKTHROUGH.md).
