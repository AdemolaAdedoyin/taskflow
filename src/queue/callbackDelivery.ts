import { createHmac } from "node:crypto";
import { Job, JobExecution } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { assertSafeHttpUrl } from "../lib/network";
import { enqueueCallbackDelivery } from "./callbackQueue";

function callbackHostname(rawUrl: string) {
  const target = new URL(rawUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("callbackUrl only supports http:// and https:// targets");
  }
  if (target.username || target.password) {
    throw new Error("callbackUrl must not contain embedded credentials");
  }
  return { target, hostname: target.hostname.toLowerCase() };
}

/** Validate static callback configuration before a durable job is accepted. */
export function assertCallbackConfiguredUrl(rawUrl: string) {
  const { hostname } = callbackHostname(rawUrl);
  const allowedHosts = new Set(config.CALLBACK_ALLOWED_HOSTS);

  if (config.NODE_ENV === "production" && allowedHosts.size === 0) {
    throw new Error("completion callbacks are disabled until CALLBACK_ALLOWED_HOSTS is configured");
  }
  if (allowedHosts.size > 0 && !allowedHosts.has(hostname)) {
    throw new Error(`callback hostname '${hostname}' is not in CALLBACK_ALLOWED_HOSTS`);
  }
}

export function signCallbackBody(body: string) {
  return `sha256=${createHmac("sha256", config.CALLBACK_SIGNING_SECRET).update(body).digest("hex")}`;
}

export function buildCallbackBody(
  deliveryId: string,
  job: Pick<Job, "id" | "type" | "scheduleType" | "status">,
  execution: Pick<
    JobExecution,
    "id" | "attemptNumber" | "status" | "startedAt" | "finishedAt" | "durationMs" | "result" | "error"
  >
) {
  return JSON.stringify({
    event: execution.status === "SUCCEEDED" ? "job.execution.succeeded" : "job.execution.failed",
    deliveryId,
    sentAt: new Date().toISOString(),
    job: {
      id: job.id,
      type: job.type,
      scheduleType: job.scheduleType,
      status: job.status,
    },
    execution: {
      id: execution.id,
      attemptNumber: execution.attemptNumber,
      status: execution.status,
      startedAt: execution.startedAt.toISOString(),
      finishedAt: execution.finishedAt?.toISOString() ?? null,
      durationMs: execution.durationMs,
      result: execution.result,
      error: execution.error,
    },
  });
}

/**
 * Persist the intent before touching Redis so a queue outage cannot lose the
 * callback. executionId is unique, making this safe to call more than once.
 */
export async function scheduleCompletionCallback(job: Job, execution: JobExecution) {
  if (!job.callbackUrl) return null;

  const delivery = await prisma.callbackDelivery.upsert({
    where: { executionId: execution.id },
    create: {
      jobId: job.id,
      executionId: execution.id,
      url: job.callbackUrl,
    },
    update: {},
  });

  if (delivery.status === "PENDING") {
    await enqueueCallbackDelivery(delivery.id);
  }
  return delivery;
}

export async function deliverCallback(deliveryId: string, attemptNumber: number) {
  const delivery = await prisma.callbackDelivery.findUnique({
    where: { id: deliveryId },
    include: { job: true, execution: true },
  });
  if (!delivery || delivery.status !== "PENDING") return;

  let responseStatus: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    // Re-check the network boundary for every attempt. DNS can change between
    // job creation and delivery, so static allowlisting alone is not enough.
    const target = await assertSafeHttpUrl(delivery.url);
    assertCallbackConfiguredUrl(target.toString());

    const body = buildCallbackBody(delivery.id, delivery.job, delivery.execution);
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), config.CALLBACK_TIMEOUT_MS);

    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "taskflow-callback/1.0",
        "x-taskflow-delivery-id": delivery.id,
        "x-taskflow-signature": signCallbackBody(body),
      },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    responseStatus = response.status;

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Callback returned redirect HTTP ${response.status}; redirects are not followed`);
    }
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new Error(`Callback failed with HTTP ${response.status}: ${responseBody.slice(0, 300)}`);
    }

    await prisma.callbackDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "DELIVERED",
        attemptCount: attemptNumber,
        responseStatus,
        lastError: null,
        deliveredAt: new Date(),
      },
    });
  } catch (error: any) {
    const isLastAttempt = attemptNumber >= config.CALLBACK_MAX_ATTEMPTS;
    await prisma.callbackDelivery.update({
      where: { id: delivery.id },
      data: {
        status: isLastAttempt ? "FAILED" : "PENDING",
        attemptCount: attemptNumber,
        responseStatus,
        lastError: error?.message ?? "Unknown callback error",
      },
    });
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
