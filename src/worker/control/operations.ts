import type { AccountRecord, Env } from "../types";
import { HttpError, id, json, nowIso, readJson } from "../utils";
import { authorize, type Principal } from "./rbac";
import { audit } from "./identity";
import { accountStub } from "../account/routing";
import { accountClient, provision, emit } from "./provisioning";
import { deleteAccount } from "./management";
import { readSecret, signToken } from "./crypto";
import { verifyTracking } from "./domains";
import { reverifyHostnames } from "./hostnames";
import { MailChannels } from "../mailchannels/client";
export async function operations(
  request: Request,
  env: Env,
  p: Principal,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/settings") {
    authorize(p, "settings.write", "account", p.scopeId);
    if (request.method === "GET")
      return json(
        await env.DB.prepare(
          "SELECT postal_address,retention_days FROM accounts WHERE id=?1",
        )
          .bind(p.scopeId)
          .first(),
      );
    if (request.method === "PUT") {
      const body = await readJson<{
        postalAddress: string;
        retentionDays: number;
      }>(request);
      if (
        typeof body.postalAddress !== "string" ||
        body.postalAddress.trim().length < 5 ||
        body.postalAddress.length > 500 ||
        !Number.isInteger(body.retentionDays) ||
        body.retentionDays < 7 ||
        body.retentionDays > 365
      )
        throw new HttpError(
          400,
          "Postal address and retention of 7–365 days required",
        );
      await env.DB.prepare(
        "UPDATE accounts SET postal_address=?2,retention_days=?3 WHERE id=?1",
      )
        .bind(p.scopeId, body.postalAddress.trim(), body.retentionDays)
        .run();
      await audit(env, p, "settings.update", p.scopeId);
      return json({ ok: true });
    }
  }
  if (path === "/api/impersonation/stop" && request.method === "POST") {
    if (!p.actorUserId || !p.sessionId)
      throw new HttpError(409, "Not impersonating");
    await env.DB.prepare("DELETE FROM sessions WHERE id=?1")
      .bind(p.sessionId)
      .run();
    await audit(env, p, "impersonation.stop", p.scopeId);
    return json(
      { ok: true },
      {
        headers: {
          "set-cookie":
            "__Host-session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        },
      },
    );
  }
  if (
    (path === "/api/export/files" || path === "/api/export/file") &&
    request.method === "GET"
  ) {
    authorize(p, "contacts.export", "account", p.scopeId);
    const prefix = `acct/${p.scopeId}/`;
    if (path.endsWith("/files")) {
      const page = await env.CONTENT.list({
        prefix,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: 1000,
      });
      await audit(env, p, "account.export.files", p.scopeId);
      return json({
        files: page.objects.map((o) => ({ key: o.key, size: o.size })),
        cursor: page.truncated ? page.cursor : null,
      });
    }
    const key = url.searchParams.get("key") ?? "";
    if (!key.startsWith(prefix)) throw new HttpError(404, "File not found");
    const object = await env.CONTENT.get(key);
    if (!object) throw new HttpError(404, "File not found");
    await audit(env, p, "account.export.file", key);
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
      },
    });
  }
  if (path === "/api/export" && request.method === "GET") {
    authorize(p, "contacts.export", "account", p.scopeId);
    const account = await env.DB.prepare("SELECT * FROM accounts WHERE id=?1")
      .bind(p.scopeId)
      .first<AccountRecord>();
    if (!account) throw new HttpError(404, "Account not found");
    await audit(env, p, "account.export", p.scopeId);
    return accountStub(env, account).fetch(
      "https://account.internal/internal/export",
      { headers: { "x-account-id": p.scopeId } },
    );
  }
  if (path === "/api/reseller/usage" || path === "/api/platform/usage") {
    const platform = path.includes("/platform/");
    authorize(
      p,
      "usage.read",
      platform ? "platform" : "reseller",
      platform ? "platform" : (p.resellerId ?? ""),
    );
    const rows = (
      await (
        platform
          ? env.DB.prepare(
              "SELECT * FROM usage_daily ORDER BY day DESC LIMIT 10000",
            )
          : env.DB.prepare(
              "SELECT * FROM usage_daily WHERE scope_type='reseller' AND scope_id=?1 ORDER BY day DESC LIMIT 366",
            ).bind(p.resellerId)
      ).all()
    ).results;
    if (url.searchParams.get("format") === "csv") {
      const fields = [
        "scope_type",
        "scope_id",
        "day",
        "accepted",
        "delivered",
        "bounced",
        "complained",
      ];
      const csv = [
        fields.join(","),
        ...rows.map((row) =>
          fields
            .map((k) => '"' + String(row[k] ?? "").replaceAll('"', '""') + '"')
            .join(","),
        ),
      ].join("\r\n");
      return new Response(csv, {
        headers: {
          "content-type": "text/csv",
          "content-disposition": 'attachment; filename="usage.csv"',
        },
      });
    }
    const providerUsage = (
      await (
        platform
          ? env.DB.prepare(
              "SELECT id,name,provider_usage_json FROM accounts WHERE provider_usage_json IS NOT NULL",
            )
          : env.DB.prepare(
              "SELECT id,name,provider_usage_json FROM accounts WHERE reseller_id=?1 AND provider_usage_json IS NOT NULL",
            ).bind(p.resellerId)
      ).all()
    ).results;
    return json({ usage: rows, providerUsage });
  }
  if (!path.startsWith("/api/platform/")) return null;
  if (p.hostname !== env.PLATFORM_HOST)
    throw new HttpError(403, "Wrong console");
  const check = (permission: string) =>
    authorize(p, permission, "platform", "platform");
  if (path === "/api/platform/search" && request.method === "GET") {
    check("accounts.read");
    const q =
      "%" + (url.searchParams.get("q") ?? "").replace(/[\\%_]/g, "\\$&") + "%";
    const accounts = (
      await env.DB.prepare(
        "SELECT id,name,reseller_id,status FROM accounts WHERE (name LIKE ?1 ESCAPE '\\' OR id LIKE ?1 ESCAPE '\\') AND status<>'DELETED' LIMIT 100",
      )
        .bind(q)
        .all()
    ).results;
    const resellers = (
      await env.DB.prepare(
        "SELECT id,name,status FROM resellers WHERE name LIKE ?1 ESCAPE '\\' OR id LIKE ?1 ESCAPE '\\' LIMIT 100",
      )
        .bind(q)
        .all()
    ).results;
    return json({ accounts, resellers });
  }
  if (path === "/api/platform/health" && request.method === "GET") {
    check("operations.read");
    return json({
      accounts: (
        await env.DB.prepare(
          "SELECT status,COUNT(*) AS count FROM accounts GROUP BY status",
        ).all()
      ).results,
      alerts: (
        await env.DB.prepare(
          "SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100",
        ).all()
      ).results,
      callbacks: (
        await env.DB.prepare(
          "SELECT id,reseller_id,type,attempts,next_attempt FROM outbound_events WHERE delivered_at IS NULL ORDER BY attempts DESC LIMIT 100",
        ).all()
      ).results,
      systemEmail: (
        await env.DB.prepare(
          "SELECT id,reseller_id,recipient,subject,attempts,created_at FROM system_emails WHERE sent_at IS NULL ORDER BY attempts DESC LIMIT 100",
        ).all()
      ).results,
      provisioning: (
        await env.DB.prepare(
          "SELECT account_id,step,attempts,error,next_attempt FROM provisioning WHERE step<>'DONE' LIMIT 100",
        ).all()
      ).results,
    });
  }
  if (path === "/api/platform/dead-letters" && request.method === "GET") {
    check("operations.read");
    return json({
      messages: (
        await env.DB.prepare(
          "SELECT * FROM dead_letters ORDER BY created_at DESC LIMIT 100",
        ).all()
      ).results,
    });
  }
  const callbackRetry = path.match(
    /^\/api\/platform\/callbacks\/([^/]+)\/retry$/,
  );
  if (callbackRetry && request.method === "POST") {
    check("operations.write");
    await env.DB.prepare(
      "UPDATE outbound_events SET next_attempt=0 WHERE id=?1 AND delivered_at IS NULL",
    )
      .bind(callbackRetry[1])
      .run();
    await audit(env, p, "callback.retry", callbackRetry[1]);
    return json({ ok: true });
  }
  const replay = path.match(/^\/api\/platform\/dead-letters\/([^/]+)\/replay$/);
  if (replay && request.method === "POST") {
    check("operations.write");
    const row = await env.DB.prepare(
      "SELECT body_json FROM dead_letters WHERE id=?1",
    )
      .bind(replay[1])
      .first<{ body_json: string }>();
    if (!row) throw new HttpError(404, "Message not found");
    const body = JSON.parse(row.body_json);
    const queue =
      body.type === "send-recipient"
        ? env.EMAIL_QUEUE
        : body.type === "delivery-event"
          ? env.EVENT_QUEUE
          : env.CAMPAIGN_QUEUE;
    await queue.send(body);
    await env.DB.prepare("UPDATE dead_letters SET replayed_at=?2 WHERE id=?1")
      .bind(replay[1], nowIso())
      .run();
    await audit(env, p, "dead-letter.replay", replay[1]);
    return json({ ok: true });
  }
  const alertReplay = path.match(/^\/api\/platform\/alerts\/([^/]+)\/replay$/);
  if (alertReplay && request.method === "POST") {
    check("operations.write");
    const row = await env.DB.prepare(
      "SELECT detail_json FROM alerts WHERE id=?1 AND kind='unknown_webhook_handle'",
    )
      .bind(alertReplay[1])
      .first<{ detail_json: string }>();
    if (!row) throw new HttpError(404, "Unknown-handle alert not found");
    const event = JSON.parse(row.detail_json);
    const account = await env.DB.prepare(
      "SELECT * FROM accounts WHERE mc_handle=?1 AND status<>'DELETED'",
    )
      .bind(event.customer_handle)
      .first<AccountRecord>();
    if (!account)
      throw new HttpError(409, "Link the customer handle before replaying");
    const response = await accountStub(env, account).fetch(
      "https://account.internal/internal/event",
      {
        method: "POST",
        headers: { "x-account-id": account.id },
        body: JSON.stringify({ eventId: alertReplay[1], event }),
      },
    );
    if (!response.ok) throw new HttpError(503, "Account unavailable");
    await env.DB.prepare("UPDATE alerts SET resolved_at=?2 WHERE id=?1")
      .bind(alertReplay[1], nowIso())
      .run();
    await audit(env, p, "alert.replay", alertReplay[1]);
    return json({ ok: true });
  }
  const resolve = path.match(/^\/api\/platform\/alerts\/([^/]+)\/resolve$/);
  if (resolve && request.method === "POST") {
    check("operations.write");
    await env.DB.prepare("UPDATE alerts SET resolved_at=?2 WHERE id=?1")
      .bind(resolve[1], nowIso())
      .run();
    await audit(env, p, "alert.resolve", resolve[1]);
    return json({ ok: true });
  }
  const abuse = path.match(
    /^\/api\/platform\/abuse\/([^/]+)\/(suspend|resume)$/,
  );
  if (abuse && request.method === "POST") {
    check("abuse.manage");
    const account = await env.DB.prepare("SELECT * FROM accounts WHERE id=?1")
      .bind(abuse[1])
      .first<AccountRecord>();
    if (!account?.mc_handle) throw new HttpError(404, "Account not found");
    const reseller = await env.DB.prepare(
      "SELECT mc_parent_key_ref FROM resellers WHERE id=?1",
    )
      .bind(account.reseller_id)
      .first<{ mc_parent_key_ref: string }>();
    const parent = new MailChannels(
      env,
      await readSecret(env, reseller!.mc_parent_key_ref),
    );
    if (abuse[2] === "suspend") {
      await env.DB.prepare("UPDATE accounts SET status='SUSPENDED' WHERE id=?1")
        .bind(account.id)
        .run();
      await parent.suspend(account.mc_handle);
    } else {
      await parent.activate(account.mc_handle);
      await accountStub(env, account).fetch(
        "https://account.internal/internal/resume",
        { method: "POST", headers: { "x-account-id": account.id } },
      );
      await env.DB.prepare("UPDATE accounts SET status='ACTIVE' WHERE id=?1")
        .bind(account.id)
        .run();
    }
    await audit(env, p, "abuse." + abuse[2], account.id);
    return json({ ok: true });
  }
  if (path === "/api/platform/maintenance" && request.method === "POST") {
    check("operations.write");
    await maintenance(env);
    await audit(env, p, "maintenance.run", "platform");
    return json({ ok: true });
  }
  return null;
}
export async function maintenance(env: Env): Promise<void> {
  const pending = (
    await env.DB.prepare(
      "SELECT account_id FROM provisioning WHERE step<>'DONE' AND next_attempt<=?1 LIMIT 20",
    )
      .bind(Date.now())
      .all<{ account_id: string }>()
  ).results;
  for (const row of pending) {
    try {
      await provision(env, row.account_id);
    } catch (error) {
      await maintenanceAlert(env, row.account_id, error);
    }
  }
  const deleting = (
    await env.DB.prepare(
      "SELECT * FROM accounts WHERE status='DELETING' ORDER BY COALESCE(last_metered_at,'') LIMIT 10",
    ).all<AccountRecord>()
  ).results;
  for (const account of deleting) {
    try {
      await deleteAccount(env, account);
    } catch (error) {
      await maintenanceAlert(env, account.id, error);
    } finally {
      await env.DB.prepare("UPDATE accounts SET last_metered_at=?2 WHERE id=?1")
        .bind(account.id, nowIso())
        .run();
    }
  }
  const accounts = (
    await env.DB.prepare(
      "SELECT * FROM accounts WHERE status IN ('ACTIVE','FLAGGED','SUSPENDED') ORDER BY COALESCE(last_metered_at,'') LIMIT 50",
    ).all<AccountRecord>()
  ).results;
  for (const account of accounts) {
    try {
      const response = await accountStub(env, account).fetch(
        "https://account.internal/internal/rollup",
        { headers: { "x-account-id": account.id } },
      );
      if (!response.ok) throw new Error("Account rollup unavailable");
      const data = await response.json<{
        usage: {
          day: string;
          accepted: number;
          delivered: number;
          bounced: number;
          complained: number;
        }[];
        breach: boolean;
        stalled: boolean;
      }>();
      for (const day of data.usage)
        await env.DB.prepare(
          "INSERT INTO usage_daily(scope_type,scope_id,day,accepted,delivered,bounced,complained) VALUES ('account',?1,?2,?3,?4,?5,?6) ON CONFLICT(scope_type,scope_id,day) DO UPDATE SET accepted=excluded.accepted,delivered=excluded.delivered,bounced=excluded.bounced,complained=excluded.complained",
        )
          .bind(
            account.id,
            day.day,
            day.accepted,
            day.delivered,
            day.bounced,
            day.complained,
          )
          .run();
      if (account.mc_key_ref) {
        const usage = (await (await accountClient(env, account.id)).usage())
          .data;
        await env.DB.prepare(
          "UPDATE accounts SET provider_usage_json=?2 WHERE id=?1",
        )
          .bind(account.id, JSON.stringify(usage))
          .run();

        if (usage.total_usage >= usage.monthly_limit)
          await emit(env, account.reseller_id, "quota.exhausted", {
            accountId: account.id,
          });
      }
    } catch (error) {
      await maintenanceAlert(env, account.id, error);
    } finally {
      await env.DB.prepare("UPDATE accounts SET last_metered_at=?2 WHERE id=?1")
        .bind(account.id, nowIso())
        .run();
    }
  }
  await env.DB.prepare(
    `INSERT INTO usage_daily(scope_type,scope_id,day,accepted,delivered,bounced,complained)
    SELECT 'reseller',a.reseller_id,u.day,SUM(u.accepted),SUM(u.delivered),SUM(u.bounced),SUM(u.complained) FROM usage_daily u JOIN accounts a ON u.scope_type='account' AND u.scope_id=a.id GROUP BY a.reseller_id,u.day
    ON CONFLICT(scope_type,scope_id,day) DO UPDATE SET accepted=excluded.accepted,delivered=excluded.delivered,bounced=excluded.bounced,complained=excluded.complained`,
  ).run();
  const tracking = (
    await env.DB.prepare(
      "SELECT DISTINCT account_id FROM tracking_domains WHERE status<>'ACTIVE' AND next_attempt<=?1 LIMIT 10",
    )
      .bind(Date.now())
      .all<{ account_id: string }>()
  ).results;
  for (const row of tracking) {
    try {
      await verifyTracking(env, row.account_id);
    } catch (error) {
      console.error("tracking.verify", {
        accountId: row.account_id,
        error: String(error),
      });
    }
  }
  await reverifyHostnames(env);
  await deliverOutbound(env);
  await deliverSystemEmails(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<?1").bind(Date.now()),
    env.DB.prepare("DELETE FROM login_tokens WHERE expires_at<?1").bind(
      Date.now(),
    ),
    env.DB.prepare("DELETE FROM sso_nonces WHERE expires_at<?1").bind(
      Date.now(),
    ),
    env.DB.prepare("DELETE FROM oidc_states WHERE expires_at<?1").bind(
      Date.now(),
    ),
  ]);
}
async function deliverOutbound(env: Env): Promise<void> {
  const events = (
    await env.DB.prepare(
      "SELECT e.*,r.webhook_url,r.webhook_secret_ref FROM outbound_events e JOIN resellers r ON r.id=e.reseller_id WHERE e.delivered_at IS NULL AND e.next_attempt<=?1 AND r.webhook_url IS NOT NULL LIMIT 50",
    )
      .bind(Date.now())
      .all<{
        id: string;
        type: string;
        payload_json: string;
        webhook_url: string;
        webhook_secret_ref: string;
        attempts: number;
      }>()
  ).results;
  for (const event of events) {
    if (!event.webhook_secret_ref) continue;
    const payload = {
      id: event.id,
      type: event.type,
      data: JSON.parse(event.payload_json),
      timestamp: Date.now(),
    };
    const token = await signToken(
      await readSecret(env, event.webhook_secret_ref),
      payload,
    );
    try {
      const fetcher =
        env.LOCAL_TEST === "true" && env.PROVIDER
          ? env.PROVIDER.fetch.bind(env.PROVIDER)
          : fetch;
      const response = await fetcher(event.webhook_url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: {
          "content-type": "application/json",
          "x-event-signature": token,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("Webhook rejected");
      await env.DB.prepare(
        "UPDATE outbound_events SET delivered_at=?2 WHERE id=?1",
      )
        .bind(event.id, nowIso())
        .run();
    } catch {
      await env.DB.prepare(
        "UPDATE outbound_events SET attempts=attempts+1,next_attempt=?2 WHERE id=?1",
      )
        .bind(
          event.id,
          Date.now() +
            Math.min(86400, 2 ** Math.min(event.attempts, 16)) * 1000,
        )
        .run();
    }
  }
}
async function deliverSystemEmails(env: Env): Promise<void> {
  const messages = (
    await env.DB.prepare(
      "SELECT m.*,r.system_email_from,r.system_email_key_ref FROM system_emails m LEFT JOIN resellers r ON r.id=m.reseller_id WHERE m.sent_at IS NULL AND m.attempts<5 LIMIT 25",
    ).all<{
      id: string;
      recipient: string;
      subject: string;
      body: string;
      system_email_from: string;
      system_email_key_ref: string;
    }>()
  ).results;
  for (const message of messages) {
    if (!message.system_email_from || !message.system_email_key_ref) continue;
    await env.DB.prepare(
      "UPDATE system_emails SET attempts=attempts+1 WHERE id=?1",
    )
      .bind(message.id)
      .run();
    try {
      await new MailChannels(
        env,
        await readSecret(env, message.system_email_key_ref),
      ).call("/send", "POST", {
        personalizations: [{ to: [{ email: message.recipient }] }],
        from: { email: message.system_email_from },
        subject: message.subject,
        content: [{ type: "text/plain", value: message.body }],
        transactional: true,
      });
      await env.DB.prepare("UPDATE system_emails SET sent_at=?2 WHERE id=?1")
        .bind(message.id, nowIso())
        .run();
    } catch {
      /* Retained for operator retry. */
    }
  }
}

async function maintenanceAlert(
  env: Env,
  accountId: string,
  error: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO alerts(id,account_id,kind,detail_json,created_at) VALUES (?1,?2,'maintenance_failure',?3,?4) ON CONFLICT(id) DO UPDATE SET detail_json=excluded.detail_json,resolved_at=NULL,created_at=excluded.created_at",
  )
    .bind(
      "maintenance:" + accountId,
      accountId,
      JSON.stringify({ error: String(error).slice(0, 500) }),
      nowIso(),
    )
    .run();
}
