# Production deployment example

Taskflow runs two long-lived processes from the hardened runtime image, plus a one-off migration job built from the same Dockerfile:

- **Migration job:** build the `migrator` target and run `npm run prisma:deploy` once per release.
- **API service:** run the default runtime image with `npm start`.
- **Worker service:** run the default runtime image with `npm run start:worker`.

The runtime image intentionally prunes development tooling, including the Prisma CLI, so schema migration is kept out of API startup. The dedicated `migrator` target retains build-time tooling without bloating the long-lived runtime image.

A practical managed topology is a container platform with separate API and worker services, plus managed PostgreSQL and Redis. For example, the API and worker can run on Render/Railway/Fly-style container services while PostgreSQL and Redis are supplied by managed providers such as Supabase/Neon and Upstash/Redis Cloud.

## Deployment order

1. Provision PostgreSQL and Redis with TLS-enabled connection strings.
2. Create production credentials from `deploy/production.env.example`. Do not reuse secrets between API clients or callback signing.
3. Build the Docker `migrator` target and run it as a one-off release job against the production database.
4. Deploy the API runtime image with `npm start`.
5. Confirm `GET /health/ready` reports both dependencies as healthy.
6. Deploy one or more worker replicas from the same runtime image with `npm run start:worker`.
7. Configure a Prometheus-compatible scraper to request `/metrics` with a bearer credential that has `operations.read`.
8. Scale API and worker replicas independently. Handler concurrency/rate policies are coordinated through Redis across worker replicas.

Example migration image commands:

```bash
docker build --target migrator -t taskflow-migrator .
docker run --rm \
  -e DATABASE_URL="$DATABASE_URL" \
  taskflow-migrator
```

Most managed container platforms have an equivalent release/pre-deploy job feature. Run exactly one migration job for a rollout, then start the new API and worker version after it succeeds.

## Process configuration

The API needs `DATABASE_URL`, `REDIS_URL`, and API-client configuration. The worker needs PostgreSQL/Redis plus the handler/callback settings, but it does not need inbound API credentials. The migration job only needs `DATABASE_URL`.

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
