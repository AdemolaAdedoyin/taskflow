import { JobHandler } from "./types";
import { httpRequestHandler } from "./httpRequest.handler";
import { logMessageHandler } from "./logMessage.handler";
import { simulateFailureHandler } from "./simulateFailure.handler";

/**
 * Maps a job's `type` string to the function that executes it. To add a new
 * kind of job, write a handler module and register it here — nothing else
 * in the system needs to change.
 */
export const handlerRegistry: Record<string, JobHandler> = {
  http_request: httpRequestHandler,
  log_message: logMessageHandler,
  simulate_failure: simulateFailureHandler,
};

export function getHandler(type: string): JobHandler {
  const handler = handlerRegistry[type];
  if (!handler) {
    throw new Error(`No handler registered for job type '${type}'. Known types: ${Object.keys(handlerRegistry).join(", ")}`);
  }
  return handler;
}
