import { it, expect } from "vitest";
import { harness } from "./local-harness";
import { seal, verifyToken } from "../src/worker/control/crypto";
import type { Env } from "../src/worker/types";
it("signs lifecycle callbacks, sends branded login mail, and retains failed callbacks for retry", async () => {
  const delivered: {
    signature: string | null;
    body: Record<string, unknown>;
  }[] = [];
  let fail = true;
  const h = await harness({
    provider: async (request) => {
      if (new URL(request.url).hostname !== "hooks.example.test") return null;
      delivered.push({
        signature: request.headers.get("x-event-signature"),
        body: (await request.json()) as Record<string, unknown>,
      });
      return Response.json({}, { status: fail ? 503 : 200 });
    },
  });
  try {
    const secret = await h.request("/api/reseller/integration-secret", {
      method: "POST",
      body: { kind: "webhook" },
    });
    const signing = ((await secret.json()) as { secret: string }).secret;
    expect(
      (
        await h.request("/api/reseller/settings", {
          method: "PUT",
          body: {
            webhookUrl: "https://hooks.example.test/events",
            systemEmailFrom: "login@brand.test",
            systemEmailKey: "system-key",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request("/api/reseller/theme", {
          method: "PUT",
          body: { tokens: { productName: "Pilot Post" } },
        })
      ).status,
    ).toBe(200);
    await h.request("/api/auth/login", {
      method: "POST",
      body: { email: "developer@local.test" },
    });
    await h.db
      .prepare(
        "INSERT INTO outbound_events(id,reseller_id,type,payload_json) VALUES ('outbound','reseller-a','account.created','{\"accountId\":\"account-a\"}')",
      )
      .run();
    const maintenance = () =>
      h.request("/api/platform/maintenance", {
        host: "platform.local.test",
        user: "platform@local.test",
        method: "POST",
      });
    expect((await maintenance()).status).toBe(200);
    const failed = await h.db
      .prepare(
        "SELECT attempts,delivered_at FROM outbound_events WHERE id='outbound'",
      )
      .first();
    expect(failed).toEqual({ attempts: 1, delivered_at: null });
    const signature = await verifyToken(signing, delivered[0].signature!);
    expect(signature).toEqual(delivered[0].body);
    const mail = h.calls.find((c) => c.path === "/tx/v1/send");
    expect(mail?.key).toBe("system-key");
    expect(mail?.body.from).toEqual({ email: "login@brand.test" });
    expect(mail?.body.subject).toBe("Sign in to Pilot Post");
    expect(JSON.stringify(mail?.body)).not.toMatch(/MailChannels|Cloudflare/);
    fail = false;
    await h.db
      .prepare("UPDATE outbound_events SET next_attempt=0 WHERE id='outbound'")
      .run();
    expect((await maintenance()).status).toBe(200);
    expect(
      (
        await h.db
          .prepare(
            "SELECT delivered_at FROM outbound_events WHERE id='outbound'",
          )
          .first()
      )?.delivered_at,
    ).toBeTruthy();
  } finally {
    await h.mf.dispose();
  }
});
it("enforces abuse thresholds immediately on events and preserves daily usage through retention", async () => {
  const h = await harness();
  try {
    await h.request("/api/dashboard");
    const sql = await h.storage("account-a");
    const now = new Date().toISOString();
    await sql.exec(
      "INSERT INTO templates(name,subject,text_body,created_at,updated_at) VALUES ('abuse','Subject','Body',?,?)",
      now,
      now,
    );
    await sql.exec(
      "INSERT INTO recipient_lists(id,name,original_filename,object_key,status,created_at,updated_at) VALUES ('abuse','List','list.csv','acct/account-a/list.csv','READY',?,?)",
      now,
      now,
    );
    await sql.exec(
      "INSERT INTO campaigns(id,list_id,list_name,template_name,sender_email,status,total_count,pending_count,accepted_count,expansion_done,created_at,updated_at) VALUES ('abuse','abuse','List','abuse','sender@example.test','RUNNING',100,0,100,1,?,?)",
      now,
      now,
    );
    await sql.exec(
      "INSERT INTO campaign_batches(id,campaign_id,sequence,first_recipient_id,last_recipient_id,recipient_count,created_at,updated_at) VALUES ('abuse','abuse',1,1,100,100,?,?)",
      now,
      now,
    );
    await sql.exec(
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO campaign_recipients(id,campaign_id,batch_id,source_recipient_id,email,status,accepted_at,mailchannels_request_id,updated_at,expires_at) SELECT 'abuse-'||x,'abuse','abuse',x,'user'||x||'@example.test','ACCEPTED',?,'request-'||x,?,1 FROM n",
      now,
      now,
    );
    const event = {
      event: "complained",
      customer_handle: "local",
      timestamp: Date.now(),
      request_id: "request-1",
      recipients: ["user1@example.test"],
    };
    await h.internal("account-a", "/internal/event", {
      eventId: "complaint",
      event,
    });
    await h.internal("account-a", "/internal/job", {
      accountId: "account-a",
      type: "delivery-event",
      eventId: "complaint",
    });
    expect(
      await h.db
        .prepare(
          "SELECT status,abuse_breaches FROM accounts WHERE id='account-a'",
        )
        .first(),
    ).toEqual({ status: "FLAGGED", abuse_breaches: 1 });
    expect(
      (
        await h.db
          .prepare("SELECT kind FROM alerts WHERE account_id='account-a'")
          .first()
      )?.kind,
    ).toBe("abuse_threshold");
    expect(
      (await sql.exec("SELECT COUNT(*) AS n FROM suppressions"))[0].n,
    ).toBe(1);
    await h.internal("account-a", "/internal/rollup");
    await h.internal("account-a", "/internal/maintenance", {});
    expect(
      (await sql.exec("SELECT COUNT(*) AS n FROM campaign_recipients"))[0].n,
    ).toBe(0);
    const rollup = await h.internal("account-a", "/internal/rollup");
    const usage = (await rollup.json()) as {
      usage: { accepted: number; complained: number }[];
    };
    expect(usage.usage[0].accepted).toBe(100);
    expect(usage.usage[0].complained).toBe(1);
  } finally {
    await h.mf.dispose();
  }
});
it("exports only the active account's original files and denies viewer exports", async () => {
  const h = await harness();
  try {
    const bucket = await h.mf.getR2Bucket("CONTENT");
    await bucket.put("acct/account-a/original.csv", "email\na@example.test");
    await bucket.put("acct/account-b/original.csv", "email\nb@example.test");
    const listing = await h.request("/api/export/files");
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({
      files: [{ key: "acct/account-a/original.csv" }],
      cursor: null,
    });
    expect(
      (await h.request("/api/export/file?key=acct/account-b/original.csv"))
        .status,
    ).toBe(404);
    expect(
      await (
        await h.request("/api/export/file?key=acct/account-a/original.csv")
      ).text(),
    ).toContain("a@example.test");
    await h.db
      .prepare(
        "UPDATE role_assignments SET role='viewer' WHERE scope_type='account' AND scope_id='account-a'",
      )
      .run();
    expect((await h.request("/api/export/files")).status).toBe(403);
  } finally {
    await h.mf.dispose();
  }
});
