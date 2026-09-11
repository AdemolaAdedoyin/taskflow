export type ScheduleInput =
  | { type: "once"; runAt?: string }
  | { type: "recurring"; cron: string; timezone?: string };

export interface CreateJobInput {
  type: string;
  payload: unknown;
  schedule: ScheduleInput;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
  callbackUrl?: string;
}
