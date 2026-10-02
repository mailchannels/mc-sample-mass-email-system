import { DurableObject } from "cloudflare:workers";
import type { Env, TenantContext } from "./types";
interface Bucket {
  tokens: number;
  updatedAt: number;
}
/** Internal token buckets for platform, reseller, and certificate activation ceilings. */
export class EmailRateLimiter extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const options = await request
      .json<{ rate?: number; burst?: number }>()
      .catch(() => ({}) as { rate?: number; burst?: number });
    const rate =
      options.rate ??
      Math.max(1, Math.min(Number(this.env.EMAIL_RATE_LIMIT ?? 50), 10000));
    const burst = options.burst ?? Math.max(1, rate);
    if (
      !Number.isFinite(rate) ||
      rate <= 0 ||
      !Number.isFinite(burst) ||
      burst < 1
    )
      return new Response("Invalid limit", { status: 400 });
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const current = this.ctx.storage.kv.get<Bucket>("bucket") ?? {
        tokens: burst,
        updatedAt: now,
      };
      const tokens = Math.min(
        burst,
        current.tokens + (Math.max(0, now - current.updatedAt) / 1000) * rate,
      );
      this.ctx.storage.kv.put("bucket", {
        tokens: tokens >= 1 ? tokens - 1 : tokens,
        updatedAt: now,
      });
      return tokens >= 1
        ? Response.json({ allowed: true })
        : Response.json(
            {
              allowed: false,
              retryAfterMs: Math.ceil(((1 - tokens) / rate) * 1000),
            },
            { status: 429 },
          );
    });
  }
}
export async function acquireSendPermit(env: TenantContext): Promise<number> {
  for (const [name, rate] of [
    ["reseller:" + env.resellerId, env.resellerRate],
    ["platform", Number(env.EMAIL_RATE_LIMIT ?? 50)],
  ] as const) {
    const instance = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
    const response = await instance.fetch("https://limiter/acquire", {
      method: "POST",
      body: JSON.stringify({ rate }),
    });
    if (!response.ok) {
      const body = await response.json<{ retryAfterMs: number }>();
      return Math.max(1, Math.ceil(body.retryAfterMs / 1000));
    }
  }
  return 0;
}
