import { handleApi } from "./api";
import { requireUser } from "./auth";
import { handleQueue, scheduledMaintenance } from "./queue";
import type { Env } from "./types";
import { errorResponse, HttpError } from "./utils";
import { receiveWebhook } from "./webhook";

export { EmailRateLimiter } from "./rate-limiter";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      let response: Response;
      if (url.pathname === "/webhooks/mailchannels") {
        if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
        response = await receiveWebhook(request, env);
      } else if (url.pathname.startsWith("/api/")) {
        const user = await requireUser(request, env);
        response = await handleApi(request, env, user);
      } else {
        response = await env.ASSETS.fetch(request);
      }
      return withSecurityHeaders(response);
    } catch (error) {
      return withSecurityHeaders(errorResponse(error));
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },

  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(scheduledMaintenance(env, controller.cron));
  },
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
