import { describe, expect, it } from "vitest";
import { escapePrometheusLabel, prometheusMetric } from "../lib/prometheus";

describe("Prometheus text formatting", () => {
  it("escapes label values safely", () => {
    expect(escapePrometheusLabel('line\\one\n"two"')).toBe('line\\\\one\\n\\"two\\"');
  });

  it("renders metrics with and without labels", () => {
    expect(prometheusMetric("taskflow_process_uptime_seconds", 12)).toBe(
      "taskflow_process_uptime_seconds 12"
    );
    expect(prometheusMetric("taskflow_jobs", 3, { status: "SCHEDULED" })).toBe(
      'taskflow_jobs{status="SCHEDULED"} 3'
    );
  });
});
