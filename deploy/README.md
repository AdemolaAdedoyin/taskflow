# Production deployment example

Taskflow is designed to run as two long-lived processes from the same container image:

- **API service:** `npm run prisma:deploy && npm start`
- **Worker service:** `npm run start:worker`

A practical managed topology is a container platform with separate API and worker services, plus managed PostgreSQL and Redis. For example, the API and worker can run on Render/Railway/Fly-style container services while PostgreSQL and Redis are supplied by managed providers such as Supabase/Neon and Upstash/Redis Cloud.

## Deployment order

1. Provision PostgreSQL and Redis with TLS-enabled connection strings.
2. Create production credentials from `deploy/production.env.example`. Do not reuse secrets between API clients or callback signing.
3. Deploy the API service first with the migration command included in its startup command.
4. Confirm `GET /health/ready` reports both dependencies as healthy.
5. Deploy one or more worker replicas from the same image with `npm run start:worker`.
6. Configure a Prometheus-compatible scraper to request `/metrics` with a bearer credential that has `operations.read`.
7. Scale API and worker replicas independently. Handler concurrency/rate policies are coordinated through Redis across worker replicas.

## Process configuration

The API needs `DATABASE_URL`, `REDIS_URL`, and API-client configuration. The worker needs PostgreSQL/Redis plus the handler/callback settings, but it does not need inbound API credentials.

For production, keep only the API service publicly reachable. Workers, PostgreSQL, and Redis should stay on private networking whenever the platform supports it.

## Health and metrics

Use `/health/live` for process liveness and `/health/ready` for dependency readiness. `/metrics` exposes Prometheus text format and requires an `operations.read` client.

Example scrape:

```bash
curl -H "Authorization: Bearer ops.<secret>" \
  https://taskflow.example.com/metrics
```

The exporter currently includes process uptime, durable job counts, BullMQ job-queue counts, durable callback-delivery counts, and callback-queue counts.

## Rollout notes

Run database migrations once per deployment before serving new API traffic. The worker and API should use the same application version. During rolling deploys, graceful shutdown lets in-flight handlers and callback deliveries finish before queue and database connections are closed.
