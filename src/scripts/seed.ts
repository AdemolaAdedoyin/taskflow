import "dotenv/config";

const BASE_URL = process.env.TASKFLOW_URL ?? "http://localhost:4000";
const API_KEY = process.env.TASKFLOW_API_KEY;

if (!API_KEY) {
  console.error("Set TASKFLOW_API_KEY in your environment before running the seed script.");
  process.exit(1);
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} failed: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  console.log(`Seeding against ${BASE_URL} ...\n`);

  const onceJob = await post("/v1/jobs", {
    type: "log_message",
    payload: { message: "Hello from a one-off job!" },
    schedule: { type: "once" }, // runs as soon as possible
  });
  console.log("Created one-off job:", onceJob.id);

  const retryDemoJob = await post("/v1/jobs", {
    type: "simulate_failure",
    payload: { failUntilAttempt: 3 },
    schedule: { type: "once" },
    maxAttempts: 5,
  });
  console.log("Created retry-demo job (fails twice, then succeeds):", retryDemoJob.id);

  const recurringJob = await post("/v1/jobs", {
    type: "log_message",
    payload: { message: "Recurring heartbeat" },
    schedule: { type: "recurring", cron: "*/5 * * * *", timezone: "UTC" },
  });
  console.log("Created recurring job (every 5 minutes):", recurringJob.id);

  console.log("\nCheck progress:");
  console.log(`  curl -H "Authorization: Bearer ${API_KEY}" ${BASE_URL}/v1/jobs/${onceJob.id}`);
  console.log(`\nOr browse the API docs at ${BASE_URL}/docs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
