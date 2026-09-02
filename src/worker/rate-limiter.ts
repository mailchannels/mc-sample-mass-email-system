import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

interface Bucket { tokens: number; updatedAt: number }

/** A single global token bucket keeps queue autoscaling within the account send rate. */
export class EmailRateLimiter extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    const rate = Math.max(1, Math.min(Number.parseInt(this.env.EMAIL_RATE_LIMIT ?? "50", 10) || 50, 10000));
    const burst = Math.max(1, rate);
    const now = Date.now();
    const current = await this.ctx.storage.get<Bucket>("bucket") ?? { tokens: burst, updatedAt: now };
    const elapsed = Math.max(0, now - current.updatedAt) / 1000;
    const tokens = Math.min(burst, current.tokens + elapsed * rate);
    if (tokens < 1) {
      const waitMs = Math.ceil((1 - tokens) / rate * 1000);
      await this.ctx.storage.put("bucket", { tokens, updatedAt: now });
      return Response.json({ allowed: false, retryAfterMs: waitMs }, { status: 429 });
    }
    await this.ctx.storage.put("bucket", { tokens: tokens - 1, updatedAt: now });
    return Response.json({ allowed: true });
  }
}

export async function acquireSendPermit(env: Env): Promise<number> {
  const instance = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("mailchannels-global"));
  const response = await instance.fetch("https://rate-limiter.internal/acquire", { method: "POST" });
  if (response.ok) return 0;
  const body = await response.json<{ retryAfterMs?: number }>();
  return Math.max(1, Math.ceil((body.retryAfterMs ?? 1000) / 1000));
}
