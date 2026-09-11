import { CronExpressionParser } from "cron-parser";

export function isValidCronExpression(expression: string): boolean {
  if (!expression || !expression.trim()) return false;
  try {
    CronExpressionParser.parse(expression);
    return true;
  } catch {
    return false;
  }
}

export function nextRunFromCron(expression: string, timezone: string): Date {
  const interval = CronExpressionParser.parse(expression, { tz: timezone });
  return interval.next().toDate();
}
