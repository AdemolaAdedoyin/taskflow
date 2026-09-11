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
local token = ARGV[1]
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local expiresAt = now + ttl
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) >= limit then
  return 0
end
redis.call('ZADD', key, expiresAt, token)
redis.call('PEXPIRE', key, ttl * 2)
return 1
`;

const renewPermitScript = `
local key = KEYS[1]
local token = ARGV[1]
local ttl = tonumber(ARGV[2])
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local score = redis.call('ZSCORE', key, token)
if not score or tonumber(score) <= now then
  redis.call('ZREM', key, token)
  return 0
end
redis.call('ZADD', key, now + ttl, token)
redis.call('PEXPIRE', key, ttl * 2)
return 1
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
    const ttl = config.HANDLER_PERMIT_TTL_MS;
    const acquired = Number(
      await redisConnection.eval(
        acquirePermitScript,
        1,
        concurrencyKey(type),
        permitToken,
        policy.concurrency,
        ttl
      )
    );

    if (acquired !== 1) {
      permitToken = undefined;
      return { delayMs: config.HANDLER_LIMIT_RETRY_DELAY_MS, release };
    }

    const renewalEveryMs = Math.max(1_000, Math.floor(ttl / 3));
    renewalTimer = setInterval(() => {
      if (!permitToken || released) return;
      void redisConnection
        .eval(renewPermitScript, 1, concurrencyKey(type), permitToken, ttl)
        .then((renewed) => {
          if (Number(renewed) !== 1) {
            logger.warn({ handlerType: type }, "handler concurrency permit expired before renewal");
          }
        })
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
