# Completion callbacks

Taskflow can send a signed HTTP callback after an execution succeeds or after its final failed attempt. Callback delivery is intentionally a separate failure domain from the business job: Taskflow persists a `CallbackDelivery`, projects it into a dedicated BullMQ queue, and retries delivery without rerunning the original handler.

## Request headers

Each callback includes:

```text
Content-Type: application/json
x-taskflow-delivery-id: <durable delivery id>
x-taskflow-signature: sha256=<hex HMAC digest>
```

The signature is HMAC-SHA256 over the **exact raw request body bytes** using `CALLBACK_SIGNING_SECRET`.

## Event shape

A delivery looks like:

```json
{
  "event": "job.execution.succeeded",
  "deliveryId": "clx...",
  "sentAt": "2026-09-11T22:00:00.000Z",
  "job": {
    "id": "clx...",
    "type": "log_message",
    "scheduleType": "ONCE",
    "status": "SUCCEEDED"
  },
  "execution": {
    "id": "clx...",
    "attemptNumber": 1,
    "status": "SUCCEEDED",
    "startedAt": "2026-09-11T21:59:59.500Z",
    "finishedAt": "2026-09-11T22:00:00.000Z",
    "durationMs": 500,
    "result": { "ok": true },
    "error": null
  }
}
```

`event` is either `job.execution.succeeded` or `job.execution.failed`.

## Verify the signature in Node.js

Verify the raw body before parsing JSON:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyTaskflowSignature(rawBody: Buffer, header: string, secret: string) {
  if (!header.startsWith("sha256=")) return false;

  const receivedHex = header.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(receivedHex)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(receivedHex, "hex");

  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

With Express, capture the raw JSON bytes before normal parsing for the callback route. The important rule is that re-serializing a parsed object is not equivalent to verifying the bytes Taskflow signed.

## Idempotent consumers

Callback delivery is at-least-once. A consumer should treat `x-taskflow-delivery-id` as an idempotency key and record processed delivery IDs before applying a side effect. A timeout can occur after the receiver processed a request but before Taskflow observed the response, so retries must be safe.

A practical receiver flow is:

1. Read the raw body.
2. Verify `x-taskflow-signature`.
3. Check whether `x-taskflow-delivery-id` was already processed.
4. Parse and validate the JSON event.
5. Apply the side effect and atomically mark the delivery ID processed.
6. Return a `2xx` response.

## Delivery security

Taskflow does not follow callback redirects. Before each delivery attempt, callback destinations are checked against loopback/private/reserved network ranges. In production, the hostname must also be explicitly included in `CALLBACK_ALLOWED_HOSTS`.

Keep `CALLBACK_SIGNING_SECRET` independent from API-client secrets. When callbacks are enabled in production, use a random secret of at least 32 characters.

## Failure behavior

Non-2xx responses, timeouts, or network failures are retried according to callback-specific retry/backoff settings. Once callback retries are exhausted, the durable callback delivery becomes failed; the original `Job` and `JobExecution` outcome remains unchanged.
