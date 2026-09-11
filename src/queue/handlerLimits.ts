import { randomUUID } from "node:crypto";
import { config } from "../config";
import { logger } from "../lib/logger";
import { redisConnection } from "./connection";

export interface HandlerLimitPolicy {
  concurrency?: number;
  rate?: { max: number; windowMs: number };
}

export interface HandlerExecutionSlot {
  delayMs: number;
  release: () => Promise<void>;
}

const acquirePermitScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local token = ARGV[3]
local limit = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) >= limit then
  return 0
end
redis.call('ZADD', key, expiresAt, token)
redis.call('PEXPIRE', key, ttl)
return 1
`;

const renewPermitScript = `
local key = KEYS[1]
local token = ARGV[1]
local expiresAt = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if redis.call('ZSCORE', key, token) then
  redis.call('ZADD', key, expiresAt, token)
  redis.call('PEXPIRE', key, ttl)
  return 1
end
return 0
`;

const consumeRateScript = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', key) or '0')
if current >= limit then
  local ttl = redis.call('PTTL', key)
  if ttl < 1 then return windowMs end
  return ttl
end
current = redis.call('INCR', key)
if current == 1 then
  redis.call('PEXPIRE', key, windowMs)
end
return 0
`;

function keyPart(type: string) {
  return encodeURIComponent(type);
}

function concurrencyKey(type: string) {
  return `taskflow:handler-limit:${keyPart(type)}:concurrency`;
}

function rateKey(type: string) {
  return `taskflow:handler-limit:${keyPart(type)}:rate`;
}

export function getHandlerLimitPolicy(type: string): HandlerLimitPolicy {
  return {
    concurrency: config.HANDLER_CONCURRENCY_LIMITS[type],
    rate: config.HANDLER_RATE_LIMITS[type],
  };
}

export async function acquireHandlerExecutionSlot(
  type: string,
  policy: HandlerLimitPolicy = getHandlerLimitPolicy(type)
): Promise<HandlerExecutionSlot> {
  let permitToken: string | undefined;
  let renewalTimer: ReturnType<typeof setInterval> | undefined;
  let released = false;

  const release = async () => {
    if (released) return;
    released = true;
    if (renewalTimer) clearInterval(renewalTimer);
    if (permitToken) {
      await redisConnection.zrem(concurrencyKey(type), permitToken);
    }
  };

  if (policy.concurrency) {
    permitToken = randomUUID();
    const now = Date.now();
    const ttl = config.HANDLER_PERMIT_TTL_MS;
    const acquired = Number(
      await redisConnection.eval(
        acquirePermitScript,
        1,
        concurrencyKey(type),
        now,
        now + ttl,
        permitToken,
        policy.concurrency,
        ttl * 2
      )
    );

    if (acquired !== 1) {
      permitToken = undefined;
      return { delayMs: config.HANDLER_LIMIT_RETRY_DELAY_MS, release };
    }

    const renewalEveryMs = Math.max(1_000, Math.floor(ttl / 3));
    renewalTimer = setInterval(() => {
      if (!permitToken || released) return;
      const expiresAt = Date.now() + ttl;
      void redisConnection
        .eval(renewPermitScript, 1, concurrencyKey(type), permitToken, expiresAt, ttl * 2)
        .catch((error) => logger.warn({ err: error, handlerType: type }, "handler concurrency permit renewal failed"));
    }, renewalEveryMs);
    renewalTimer.unref();
  }

  if (policy.rate) {
    const delayMs = Number(
      await redisConnection.eval(
        consumeRateScript,
        1,
        rateKey(type),
        policy.rate.max,
        policy.rate.windowMs
      )
    );
    if (delayMs > 0) {
      await release();
      return { delayMs: Math.max(delayMs, config.HANDLER_LIMIT_RETRY_DELAY_MS), release };
    }
  }

  return { delayMs: 0, release };
}
