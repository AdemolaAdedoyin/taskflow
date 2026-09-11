# Operations runbook

This runbook covers the production path for Taskflow's API, worker, PostgreSQL, Redis, migrations, health checks, metrics, scaling, and common failure modes.

## Runtime topology

Taskflow uses one codebase and two long-lived processes:

- API: `npm start`
- Worker: `npm run start:worker`

A third short-lived process applies database migrations from the Docker `migrator` target before a release.

PostgreSQL owns durable application state. Redis/BullMQ is execution infrastructure and can be repaired from durable rows where Taskflow has explicit reconciliation logic.

## Release order

1. Build the application image and the `migrator` target from the same commit.
2. Run the migration job once against production PostgreSQL.
3. Deploy the API image.
4. Wait for `/health/ready` to report PostgreSQL and Redis as healthy.
5. Deploy worker replicas from the same application version.
6. Verify `/v1/operations/overview` and `/metrics`.
7. Send a small `log_message` smoke-test job.

Do not run old workers against a newly deployed schema for longer than the platform's normal rolling window. API and worker should converge on the same release version.

## Health endpoints

`GET /health/live` proves the API process can answer HTTP. It does not check external dependencies.

`GET /health/ready` checks PostgreSQL and Redis. A failing readiness check should remove the API instance from normal traffic while leaving it alive for diagnosis.

The worker has no HTTP server. Monitor worker process/container health, logs, queue activity, and execution progress instead.

## Metrics and operational overview

Use a named API client with `operations.read` for both:

```bash
curl -H "Authorization: Bearer ops.<secret>" \
  https://taskflow.example.com/v1/operations/overview
```

```bash
curl -H "Authorization: Bearer ops.<secret>" \
  https://taskflow.example.com/metrics
```

Useful signals include queue `waiting`, `active`, `delayed`, and `failed` counts; durable job status counts; callback queue counts; failed callback deliveries; and process uptime.

## Scaling

Scale API and workers independently. Increasing API replicas increases HTTP capacity but does not increase handler throughput. Increasing worker replicas increases potential execution throughput up to configured global/per-handler limits and dependency capacity.

Per-handler concurrency leases and fixed-window rate limits are coordinated through Redis, so configured limits apply across worker replicas rather than per process.

## PostgreSQL unavailable

Expected symptoms include `/health/ready` returning `503`, API operations failing, and workers being unable to claim/update durable state.

Actions:

1. Check managed PostgreSQL status and network/TLS credentials.
2. Keep workers from churning if the outage is prolonged; restart policy should not create an aggressive crash loop.
3. Restore database connectivity before treating Redis queue state as authoritative.
4. After recovery, verify durable job/execution state and queue counts.

Never rebuild durable state from Redis alone. PostgreSQL is the source of truth.

## Redis unavailable

Expected symptoms include `/health/ready` returning `503`, new jobs potentially being durably created but not projected into BullMQ, and workers pausing because queue operations cannot proceed.

Actions:

1. Restore Redis connectivity.
2. Restart the API/worker normally so startup reconciliation can repair scheduled jobs and pending callbacks that are missing queue projections.
3. Check `/v1/operations/overview` for durable/queue mismatches.
4. Do not delete durable `SCHEDULED` rows merely because Redis was unavailable.

This is an intentional failure model: durable PostgreSQL writes can survive an ambiguous Redis failure and be repaired later.

## Queue backlog

If `waiting` or `delayed` grows continuously:

1. Check worker replica count and worker logs.
2. Check whether jobs are intentionally delayed by scheduling, retry backoff, or handler limits.
3. Inspect per-handler concurrency/rate settings before scaling workers; a distributed handler limit can intentionally cap throughput.
4. Check downstream dependencies used by `http_request` handlers.
5. Scale workers only when the bottleneck is execution capacity rather than a configured safety limit.

## Failed jobs

Use `GET /v1/jobs/:id` for recent attempts and `GET /v1/jobs/:id/executions` for the full cursor-paginated history. The execution table is the audit trail for actual handler attempts.

A job that is waiting for a distributed handler permit is not a failed attempt and should not produce an execution row merely for being throttled.

## Callback failures

Callback delivery has its own durable state and queue. A callback outage must not cause the original business handler to run again.

Check callback queue failed/delayed counts and durable `CallbackDelivery` status. Verify destination availability, `CALLBACK_ALLOWED_HOSTS`, DNS/network policy, TLS, and receiver signature handling.

## Cancellation incidents

Only `SCHEDULED` work is cancellable. If cancellation returns `409`, inspect the job's durable status. A running handler cannot be safely pre-empted, so Taskflow deliberately refuses to report a false cancellation.

Cancellation is durable-first: PostgreSQL transitions to `CANCELLED` before best-effort BullMQ cleanup. If queue cleanup fails, workers still cannot legitimately claim the cancelled durable job.

## Secret rotation

For API clients, add a new named client/secret, deploy, move callers to the new token, then remove the old client and deploy again. Do not log or expose configured client secrets.

For callback signing-secret rotation, coordinate the receiver because callbacks are signed with one configured secret. A production extension could support overlapping current/previous signing keys if zero-downtime receiver rotation is required.

## Backup and recovery

Back up PostgreSQL according to the managed provider's point-in-time recovery capabilities. Redis should be treated as reconstructible execution infrastructure, not the sole backup of business state.

After restoring PostgreSQL to a recovery point, evaluate whether Redis contains queue state from a different logical time. The safest recovery sequence is to isolate workers, establish the restored durable state, clear/recreate inappropriate queue state if necessary, then allow Taskflow reconciliation to repopulate scheduled/pending projections.
