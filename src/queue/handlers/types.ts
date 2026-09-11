export interface JobHandlerContext {
  jobId: string;
  attemptNumber: number;
}

/** A handler receives the job's payload and returns a JSON-serializable result. */
export type JobHandler = (payload: unknown, ctx: JobHandlerContext) => Promise<unknown>;
