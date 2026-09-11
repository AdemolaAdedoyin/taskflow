import { Queue } from "bullmq";
import { config } from "../config";
import { redisConnection } from "./connection";

export interface CallbackPayload {
  deliveryId: string;
}

export const CALLBACK_QUEUE_NAME = "taskflow-callbacks";

export const callbackQueue = new Queue<CallbackPayload>(CALLBACK_QUEUE_NAME, {
  connection: redisConnection,
});

function callbackQueueJobId(deliveryId: string) {
  return `callback-${deliveryId}`;
}

/**
 * Queue projection for a durable callback-delivery row. The deterministic
 * BullMQ id makes retries/reconciliation safe after ambiguous Redis failures.
 */
export async function enqueueCallbackDelivery(deliveryId: string) {
  await callbackQueue.add(
    "deliver",
    { deliveryId },
    {
      jobId: callbackQueueJobId(deliveryId),
      attempts: config.CALLBACK_MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { age: 24 * 3600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    }
  );
}

export async function closeCallbackQueueResources() {
  await callbackQueue.close();
}
