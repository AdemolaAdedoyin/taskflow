# Taskflow documentation

Taskflow is backend-only, so this documentation is intentionally part of the product surface rather than an afterthought.

Start with these guides:

- [API guide](./API_GUIDE.md) — authentication, scopes, endpoint catalog, lifecycle semantics, pagination, cancellation, errors, operations, and metrics.
- [Portfolio walkthrough](./PORTFOLIO_WALKTHROUGH.md) — a reviewer-friendly curl/Swagger path through the system and the architecture decisions worth discussing in an interview.
- [Completion callbacks](./CALLBACKS.md) — event shape, at-least-once delivery, HMAC verification, idempotent consumption, and callback security.
- [Operations runbook](./RUNBOOK.md) — release order, migration job, health checks, scaling, PostgreSQL/Redis outages, backlog diagnosis, secret rotation, and recovery.
- [Production deployment example](../deploy/README.md) — Docker migration/runtime targets and a practical managed PostgreSQL/Redis topology.

Interactive Swagger UI is served by a running Taskflow API at `/docs`; the raw OpenAPI document is available at `/openapi.json`.

For local evaluation, run:

```bash
docker compose up --build
```

Then open `http://localhost:4000/docs` or follow the portfolio walkthrough. The default local bearer token is `local.dev-local-client-secret`.
