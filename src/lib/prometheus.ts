export function escapePrometheusLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export function prometheusMetric(name: string, value: number, labels: Record<string, string> = {}) {
  const encodedLabels = Object.entries(labels)
    .map(([key, labelValue]) => `${key}="${escapePrometheusLabel(labelValue)}"`)
    .join(",");
  return `${name}${encodedLabels ? `{${encodedLabels}}` : ""} ${value}`;
}
