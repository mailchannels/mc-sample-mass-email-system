import { operations, maintenance } from "./control/operations";
import { oidcRoute, oidcSettings } from "./control/oidc";
import { brandAsset, themed, themeRoutes } from "./control/themes";
import { hostnameRoutes } from "./control/hostnames";
import { management } from "./control/management";
import { apiPrincipal, ssoRoute } from "./control/sso";
import { domainRoutes } from "./control/domains";
import { unsubscribe } from "./control/unsubscribe";
import { authRoute, identityRoute } from "./control/sessions";
import { accountStub } from "./account/routing";
import { audit, csrf, principal, resolveHost } from "./control/identity";
import { accountPermission, authorize } from "./control/rbac";
import type { AccountRecord, Env } from "./types";
import { errorResponse, HttpError } from "./utils";
import { receiveWebhook } from "./webhook";
export { EmailRateLimiter } from "./rate-limiter";
export { AccountDO } from "./account/AccountDO";
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const host = await resolveHost(request, env);
      const asset = await brandAsset(request, env, host.resellerId);
      if (asset) return withSecurityHeaders(asset);
      const oidc = await oidcRoute(request, env, host);
      if (oidc) return withSecurityHeaders(oidc);
      const unsub = await unsubscribe(request, env, host.resellerId);
      if (unsub)
        return withSecurityHeaders(await themed(unsub, env, host.resellerId));
      const sso = await ssoRoute(request, env, host);
      if (sso) return withSecurityHeaders(sso);
      const auth = await authRoute(request, env, host);
      if (auth) return withSecurityHeaders(auth);
      let response: Response;
      if (url.pathname === "/webhooks/mailchannels" && !host.resellerId) {
        if (request.method !== "POST")
          throw new HttpError(405, "Method not allowed");
        response = await receiveWebhook(request, env);
      } else if (
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/v1/")
      ) {
        const p = url.pathname.startsWith("/v1/")
          ? await apiPrincipal(request, env, host)
          : await principal(request, env, host);
        if (!p.apiScopes) csrf(request);
        if (
          !["GET", "HEAD"].includes(request.method) ||
          url.pathname === "/api/generate-upload-url"
        )
          await audit(
            env,
            p,
            request.method + " " + url.pathname,
            url.pathname,
            { stage: "attempt" },
          );
        for (const handler of [
          oidcSettings,
          themeRoutes,
          hostnameRoutes,
          operations,
        ]) {
          const result = await handler(request, env, p);
          if (result) return withSecurityHeaders(result);
        }
        const identity = await identityRoute(request, env, p);
        if (identity) return withSecurityHeaders(identity);
        const managed = await management(request, env, p);
        if (managed) return withSecurityHeaders(managed);
        const domain = await domainRoutes(request, env, p);
        if (domain) return withSecurityHeaders(domain);
        authorize(
          p,
          accountPermission(request.method, url.pathname),
          "account",
          p.scopeId,
        );
        const account = await env.DB.prepare(
          "SELECT * FROM accounts WHERE id = ?1 AND status <> 'DELETED'",
        )
          .bind(p.scopeId)
          .first<AccountRecord>();
        if (!account) throw new HttpError(404, "Account not found");
        const headers = new Headers(request.headers);
        headers.set("x-account-id", account.id);
        headers.set("x-user-email", p.email);
        const mutation =
          !["GET", "HEAD"].includes(request.method) ||
          url.pathname === "/api/generate-upload-url";
        response = await accountStub(env, account).fetch(
          new Request(request, { headers }),
        );
        if (mutation)
          await audit(
            env,
            p,
            request.method + " " + url.pathname,
            url.pathname,
            { status: response.status },
          );
      } else
        response = await themed(
          await env.ASSETS.fetch(request),
          env,
          host.resellerId,
        );
      return withSecurityHeaders(response);
    } catch (error) {
      return withSecurityHeaders(errorResponse(error));
    }
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const job = message.body as { accountId?: string };
        if (!job || typeof job.accountId !== "string" || !job.accountId)
          throw new Error("Queue message requires accountId");
        const account = await env.DB.prepare(
          "SELECT * FROM accounts WHERE id = ?1 AND status <> 'DELETED'",
        )
          .bind(job.accountId)
          .first<AccountRecord>();
        if (!account) {
          message.ack();
          continue;
        }
        const response = await accountStub(env, account).fetch(
          "https://account.internal/internal/job",
          {
            method: "POST",
            headers: { "x-account-id": account.id },
            body: JSON.stringify(job),
          },
        );
        if (!response.ok) throw new Error("Account job failed");
        message.ack();
      } catch (error) {
        if (message.attempts >= 5) {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO dead_letters(id,account_id,queue,body_json,error,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
          )
            .bind(
              message.id,
              (message.body as { accountId?: string } | null)?.accountId ??
                null,
              batch.queue,
              JSON.stringify(message.body),
              String(error),
              new Date().toISOString(),
            )
            .run();
          message.ack();
        } else
          message.retry({ delaySeconds: Math.min(300, 2 ** message.attempts) });
      }
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(maintain(env));
  },
};
async function maintain(env: Env): Promise<void> {
  await maintenance(env);
  const accounts = await env.DB.prepare(
    "SELECT * FROM accounts WHERE status = 'ACTIVE' AND created_at < ?1 AND (last_alarm_at IS NULL OR last_alarm_at < ?1) LIMIT 100",
  )
    .bind(new Date(Date.now() - 180_000).toISOString())
    .all<AccountRecord>();
  for (const account of accounts.results) {
    await env.DB.prepare(
      "INSERT INTO alerts(id,account_id,kind,detail_json,created_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET resolved_at=NULL,created_at=excluded.created_at",
    )
      .bind(
        "stalled:" + account.id,
        account.id,
        "stalled_alarm",
        "{}",
        new Date().toISOString(),
      )
      .run();
    await accountStub(env, account).fetch(
      "https://account.internal/internal/maintenance",
      { method: "POST", headers: { "x-account-id": account.id } },
    );
  }
}
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
