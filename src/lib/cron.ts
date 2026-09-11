import { CronExpressionParser } from "cron-parser";

function isValidTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function isValidCronExpression(expression: string, timezone?: string): boolean {
  if (!expression || !expression.trim()) return false;
  if (timezone && !isValidTimeZone(timezone)) return false;

  try {
    const interval = CronExpressionParser.parse(expression, timezone ? { tz: timezone } : undefined);
    interval.next();
    return true;
  } catch {
    return false;
  }
}

export function nextRunFromCron(expression: string, timezone: string): Date {
  const interval = CronExpressionParser.parse(expression, { tz: timezone });
  return interval.next().toDate();
}
