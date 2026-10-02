import { readSecret } from "../control/crypto";
import { MailChannels } from "../mailchannels/client";
import { emit } from "../control/provisioning";
import { accountClient } from "../control/provisioning";
import { DurableObject } from "cloudflare:workers";
import { handleApi } from "../api";
import { handleQueue, scheduledMaintenance, flushOutbox } from "../queue";
import type { Env, TenantContext, AccountRecord } from "../types";
import { errorResponse, HttpError } from "../utils";
import { SqlStore } from "./sql";
import { schemaV1, schemaV2, schemaV3 } from "./schema";

export class AccountDO extends DurableObject<Env> {
  private store: SqlStore;
  private tail: Promise<unknown> = Promise.resolve();
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
    );
    if (
      !ctx.storage.sql.exec("SELECT version FROM schema_version").toArray()
        .length
    ) {
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec(schemaV1);
        ctx.storage.sql.exec("INSERT INTO schema_version VALUES (1)");
      });
    }
    const version = Number(
      ctx.storage.sql.exec("SELECT version FROM schema_version").one().version,
    );
    if (version < 2)
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec(schemaV2);
        ctx.storage.sql.exec("UPDATE schema_version SET version=2");
      });
    if (version < 3)
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec(schemaV3);
        ctx.storage.sql.exec("UPDATE schema_version SET version=3");
      });
  }
  private async context(
    accountId: string,
    deleting = false,
  ): Promise<TenantContext> {
    const existing = await this.ctx.storage.get<string>("accountId");
    if (existing && existing !== accountId)
      throw new HttpError(403, "Account mismatch");
    const account = await this.env.DB.prepare(
      "SELECT * FROM accounts WHERE id = ?1",
    )
      .bind(accountId)
      .first<AccountRecord>();
    if (
      !account ||
      account.status === "DELETED" ||
      (account.status === "DELETING" && !deleting)
    )
      throw new HttpError(404, "Account not found");
    await this.ctx.storage.put("accountId", accountId);
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    const { DB: _db, ACCOUNTS: _accounts, ...bindings } = this.env;
    const settings = await this.env.DB.prepare(
      "SELECT a.postal_address,a.retention_days,a.created_at,p.rate,p.contacts,p.monthly_sends FROM accounts a LEFT JOIN plans p ON p.id=a.plan_id WHERE a.id=?1",
    )
      .bind(accountId)
      .first<{
        postal_address: string;
        retention_days: number;
        rate: number;
        contacts: number;
        monthly_sends: number;
        created_at: string;
      }>();
    const domains = (
      await this.env.DB.prepare(
        "SELECT domain FROM sender_domains WHERE account_id=?1 AND verified_at IS NOT NULL",
      )
        .bind(accountId)
        .all<{ domain: string }>()
    ).results;
    const host = await this.env.DB.prepare(
      "SELECT hostname FROM hostnames WHERE reseller_id=?1 AND status='ACTIVE' ORDER BY hostname LIMIT 1",
    )
      .bind(account.reseller_id)
      .first<{ hostname: string }>();
    const tracking = (
      await this.env.DB.prepare(
        "SELECT scope,name FROM tracking_domains WHERE account_id=?1 AND status='ACTIVE'",
      )
        .bind(accountId)
        .all<{ scope: string; name: string }>()
    ).results;
    const emails = (
      await this.env.DB.prepare(
        "SELECT u.email FROM users u JOIN role_assignments r ON r.user_id=u.id WHERE r.scope_type='account' AND r.scope_id=?1 AND u.status='ACTIVE' AND u.email_verified_at IS NOT NULL",
      )
        .bind(accountId)
        .all<{ email: string }>()
    ).results;
    const resellerPlan = await this.env.DB.prepare(
      "SELECT p.rate,r.status FROM resellers r LEFT JOIN plans p ON p.id=r.plan_id WHERE r.id=?1",
    )
      .bind(account.reseller_id)
      .first<{ rate: number; status: string }>();
    const history = this.ctx.storage.sql
      .exec(
        "SELECT COALESCE(SUM(accepted_count),0) AS accepted,COALESCE(SUM(complained_count),0) AS complaints FROM campaigns",
      )
      .one();
    const established =
      Number(history.accepted) >= 1000 &&
      Number(history.complaints) === 0 &&
      Date.parse(settings?.created_at ?? "") < Date.now() - 7 * 86400_000;
    return {
      ...bindings,
      STORE: this.store,
      accountId,
      resellerId: account.reseller_id,
      MAILCHANNELS_API_KEY: account.mc_key_ref
        ? await readSecret(this.env, account.mc_key_ref)
        : "",
      MAILCHANNELS_CUSTOMER_HANDLE: account.mc_handle ?? "",
      ALLOWED_SENDER_DOMAINS:
        domains.map((d) => d.domain).join(",") || "invalid",
      postalAddress: settings?.postal_address ?? "",
      publicHost: host?.hostname ?? "",
      trackingDomains: Object.fromEntries(
        tracking.map((d) => [d.scope, d.name]),
      ),
      TRACKING_RETENTION_DAYS: String(settings?.retention_days ?? 90),
      sendRate: established
        ? (settings?.rate ?? 5)
        : Math.min(settings?.rate ?? 1, 5),
      resellerRate: resellerPlan?.rate ?? 50,
      monthlyLimit: Math.min(
        settings?.monthly_sends ?? 1000,
        established ? Number.MAX_SAFE_INTEGER : 1000,
      ),
      contactLimit: settings?.contacts ?? 1000,
      accountStatus:
        resellerPlan?.status === "ACTIVE" ? account.status : "SUSPENDED",
      verifiedTestEmails: emails.map((u) => u.email),
    };
  }
  async fetch(request: Request): Promise<Response> {
    return this.serialize(() => this.dispatch(request));
  }
  private async dispatch(request: Request): Promise<Response> {
    try {
      const accountId = request.headers.get("x-account-id");
      if (!accountId) throw new HttpError(400, "Account context required");
      const path = new URL(request.url).pathname;
      const env = await this.context(
        accountId,
        ["/internal/begin-delete", "/internal/delete"].includes(path),
      );
      if (path === "/internal/begin-delete") {
        await this.ctx.storage.deleteAlarm();
        return Response.json({ ok: true });
      }
      if (path === "/internal/rollup") {
        for (const [column, metric] of [
          ["accepted_at", "accepted"],
          ["delivered_at", "delivered"],
          ["bounced_at", "bounced"],
          ["complained_at", "complained"],
        ]) {
          this.ctx.storage.sql.exec(
            `INSERT INTO account_usage(day,${metric}) SELECT substr(${column},1,10),COUNT(*) FROM campaign_recipients WHERE ${column} IS NOT NULL GROUP BY substr(${column},1,10) ON CONFLICT(day) DO UPDATE SET ${metric}=MAX(account_usage.${metric},excluded.${metric})`,
          );
        }
        const usage = this.ctx.storage.sql
          .exec("SELECT * FROM account_usage ORDER BY day")
          .toArray();
        const window = this.ctx.storage.sql
          .exec(
            `SELECT COUNT(*) AS total,SUM(CASE WHEN complained_at IS NOT NULL THEN 1 ELSE 0 END) AS complaints,SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounces FROM campaign_recipients WHERE accepted_at>?`,
            new Date(Date.now() - 86400_000).toISOString(),
          )
          .one();
        const total = Number(window.total);
        const breach =
          total >= 100 &&
          (Number(window.complaints) / total >= 0.001 ||
            Number(window.bounces) / total >= 0.05);

        return Response.json({ usage, breach });
      }
      if (path === "/internal/delete") {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        return Response.json({ ok: true });
      }
      if (path === "/internal/export") {
        const tables = [
          "templates",
          "recipient_lists",
          "recipients",
          "attachments",
          "campaigns",
          "campaign_batches",
          "campaign_recipients",
          "suppressions",
          "account_usage",
        ];
        let table = 0,
          offset = 0,
          started = false;
        const sql = this.ctx.storage.sql;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!started) {
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({ accountId }).slice(0, -1) + ',"data":{',
                ),
              );
              started = true;
            }
            if (table >= tables.length) {
              controller.enqueue(encoder.encode("}}"));
              controller.close();
              return;
            }
            if (offset === 0)
              controller.enqueue(
                encoder.encode(
                  (table ? "," : "") + JSON.stringify(tables[table]) + ":[",
                ),
              );
            const rows = sql
              .exec(`SELECT * FROM ${tables[table]} LIMIT 250 OFFSET ?`, offset)
              .toArray();
            if (rows.length)
              controller.enqueue(
                encoder.encode(
                  (offset ? "," : "") +
                    rows.map((row) => JSON.stringify(row)).join(","),
                ),
              );
            offset += rows.length;
            if (rows.length < 250) {
              controller.enqueue(encoder.encode("]"));
              table++;
              offset = 0;
            }
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "application/json",
            "content-disposition": 'attachment; filename="account-export.json"',
          },
        });
      }
      if (path === "/internal/unsubscribe") {
        const { email } = await request.json<{ email: string }>();
        await env.STORE.prepare(
          "INSERT INTO suppressions(email,reason,created_at) VALUES (?1,'unsubscribed',?2) ON CONFLICT(email) DO UPDATE SET reason='unsubscribed'",
        )
          .bind(email.toLowerCase(), new Date().toISOString())
          .run();
        // Durable pending marker makes provider mirroring retryable without losing local suppression.
        await this.ctx.storage.put(
          "suppression:" + email.toLowerCase(),
          email.toLowerCase(),
        );
        try {
          await (await accountClient(this.env, accountId)).suppress(email);
          await this.ctx.storage.delete("suppression:" + email.toLowerCase());
        } catch {
          /* alarm retries */
        }
        return Response.json({ ok: true });
      }
      if (path === "/internal/event") {
        const { eventId, event } = await request.json<{
          eventId: string;
          event: import("../types").MailChannelsEvent;
        }>();
        await env.CONTENT.put(
          `acct/${accountId}/events/${eventId}.json`,
          JSON.stringify(event),
          { httpMetadata: { contentType: "application/json" } },
        );
        await env.STORE.prepare(
          `INSERT OR IGNORE INTO webhook_events
          (id,request_id,smtp_id,event_type,customer_handle,event_timestamp,recipients_json,payload_json,received_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
        )
          .bind(
            eventId,
            event.request_id ?? null,
            event.smtp_id ?? null,
            event.event,
            event.customer_handle,
            event.timestamp,
            JSON.stringify(event.recipients ?? []),
            JSON.stringify({
              event: event.event,
              customer_handle: event.customer_handle,
              timestamp: event.timestamp,
              request_id: event.request_id,
              campaign_id: event.campaign_id,
              recipients: event.recipients,
              email: event.email,
              smtp_id: event.smtp_id,
              reason: event.reason,
            }),
            new Date().toISOString(),
          )
          .run();
        await env.EVENT_QUEUE.send({
          accountId,
          type: "delivery-event",
          eventId,
        });
        return Response.json({ ok: true });
      }
      if (path === "/internal/job") {
        const job = await request.json<{ accountId: string }>();
        if (job.accountId !== accountId)
          throw new HttpError(403, "Account mismatch");
        let retry = false;
        await handleQueue(
          {
            messages: [
              {
                body: job,
                id: "internal",
                attempts: 1,
                ack() {},
                retry() {
                  retry = true;
                },
              },
            ],
          } as unknown as MessageBatch<unknown>,
          env,
        );
        if (!retry && (job as { type?: string }).type === "delivery-event")
          await this.checkAbuse(env);
        return Response.json({ ok: !retry }, { status: retry ? 503 : 200 });
      }
      if (path === "/internal/resume") {
        await this.ctx.storage.delete("abusePaused");
        this.ctx.storage.sql.exec(
          "UPDATE campaigns SET paused=0 WHERE paused=1",
        );
        return Response.json({ ok: true });
      }
      if (path === "/internal/maintenance") {
        await scheduledMaintenance(env, "17 3 * * *");
        return Response.json({ ok: true });
      }
      return await handleApi(
        request,
        env,
        request.headers.get("x-user-email") ?? "",
      );
    } catch (error) {
      return errorResponse(error);
    }
  }
  private async checkAbuse(env: TenantContext): Promise<void> {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT COUNT(*) AS total,SUM(complained_at IS NOT NULL) AS complaints,SUM(bounced_at IS NOT NULL) AS bounces FROM campaign_recipients WHERE accepted_at>?`,
        new Date(Date.now() - 86400_000).toISOString(),
      )
      .one();
    const total = Number(row.total);
    if (
      total < 100 ||
      (Number(row.complaints) / total < 0.001 &&
        Number(row.bounces) / total < 0.05)
    )
      return;
    const latest = this.ctx.storage.sql
      .exec(
        "SELECT id FROM webhook_events WHERE event_type IN ('complained','hard-bounced') ORDER BY received_at DESC,id DESC LIMIT 1",
      )
      .toArray()[0]?.id;
    if (!latest || (await this.ctx.storage.get("lastAbuseEvent")) === latest)
      return;
    await this.ctx.storage.put("abusePaused", true);
    this.ctx.storage.sql.exec(
      "UPDATE campaigns SET paused=1 WHERE status IN ('PREPARING','RUNNING')",
    );
    const changed = await this.env.DB.prepare(
      "UPDATE accounts SET abuse_breaches=abuse_breaches+1,status=CASE WHEN abuse_breaches>=1 THEN 'SUSPENDED' ELSE 'FLAGGED' END WHERE id=?1 AND status='ACTIVE' RETURNING abuse_breaches,mc_handle",
    )
      .bind(env.accountId)
      .first<{ abuse_breaches: number; mc_handle: string }>();
    if (!changed) return;
    await this.ctx.storage.put("lastAbuseEvent", latest);
    await this.env.DB.prepare(
      "INSERT INTO alerts(id,account_id,kind,detail_json,created_at) VALUES (?1,?2,'abuse_threshold',?3,?4)",
    )
      .bind(
        crypto.randomUUID(),
        env.accountId,
        JSON.stringify(row),
        new Date().toISOString(),
      )
      .run();
    await emit(this.env, env.resellerId, "account.abuse", {
      accountId: env.accountId,
      metrics: row,
    });
    if (changed.abuse_breaches > 1) {
      const reseller = await this.env.DB.prepare(
        "SELECT mc_parent_key_ref FROM resellers WHERE id=?1",
      )
        .bind(env.resellerId)
        .first<{ mc_parent_key_ref: string }>();
      if (reseller?.mc_parent_key_ref)
        await new MailChannels(
          this.env,
          await readSecret(this.env, reseller.mc_parent_key_ref),
        ).suspend(changed.mc_handle);
    }
  }
  async alarm(): Promise<void> {
    return this.serialize(() => this.runAlarm());
  }
  private async runAlarm(): Promise<void> {
    const id = await this.ctx.storage.get<string>("accountId");
    if (!id) return;
    try {
      const env = await this.context(id);
      if (!(await this.ctx.storage.get("abusePaused"))) await flushOutbox(env);
      const lastRepair =
        (await this.ctx.storage.get<number>("lastRepair")) ?? 0;
      if (Date.now() - lastRepair > 60_000) {
        await scheduledMaintenance(env, "* * * * *");
        await this.ctx.storage.put("lastRepair", Date.now());
      }
      const lastRetention =
        (await this.ctx.storage.get<number>("lastRetention")) ?? 0;
      if (Date.now() - lastRetention > 86400_000) {
        await this.dispatch(
          new Request("https://account.internal/internal/rollup", {
            headers: { "x-account-id": id },
          }),
        );
        await scheduledMaintenance(env, "17 3 * * *");
        await this.ctx.storage.put("lastRetention", Date.now());
      }
      const pending = await this.ctx.storage.list<string>({
        prefix: "suppression:",
        limit: 100,
      });
      for (const [key, email] of pending) {
        await (await accountClient(this.env, id)).suppress(email);
        await this.ctx.storage.delete(key);
      }
      await this.env.DB.prepare(
        "UPDATE accounts SET last_alarm_at = ?2 WHERE id = ?1",
      )
        .bind(id, new Date().toISOString())
        .run();
    } finally {
      const alive = await this.env.DB.prepare(
        "SELECT id FROM accounts WHERE id=?1 AND status NOT IN ('DELETING','DELETED')",
      )
        .bind(id)
        .first();
      if (alive) await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }
}
