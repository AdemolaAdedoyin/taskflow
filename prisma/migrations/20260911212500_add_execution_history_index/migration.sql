-- Replace the single-column lookup index with the composite ordering used by
-- cursor-paginated execution history queries. The jobId prefix still supports
-- direct per-job lookups while startedAt/id make descending page scans stable.
DROP INDEX "JobExecution_jobId_idx";
CREATE INDEX "JobExecution_jobId_startedAt_id_idx"
ON "JobExecution"("jobId", "startedAt", "id");
