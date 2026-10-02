import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { harness, eventually } from "./local-harness";
let h: Awaited<ReturnType<typeof harness>>;
let resellerId: string, accountId: string, key: string;
const platform = { host: "platform.local.test", user: "platform@local.test" };
beforeAll(async () => {
  h = await harness({ queues: true });
}, 30_000);
afterAll(async () => h?.mf.dispose());
async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const response = await h.request(path, { ...platform, method, body });
  const data = (await response.json()) as Record<string, unknown>;
  expect(response.status, JSON.stringify(data)).toBeLessThan(300);
  return data;
}
describe("provisioning, delivery and operations with local provider doubles", () => {
  it("validates and encrypts reseller credentials", async () => {
    const bad = await h.request("/api/platform/resellers", {
      ...platform,
      method: "POST",
      body: {
        name: "Bad Reseller",
        planId: "reseller",
        parentHandle: "bad",
        apiKey: "invalid",
      },
    });
    expect(bad.status).toBe(502);
    const created = await api("/api/platform/resellers", {
      name: "Pilot Hosting",
      planId: "reseller",
      parentHandle: "pilot",
      apiKey: "parent-secret",
    });
    resellerId = String(created.id);
    const row = await h.db
      .prepare(
        "SELECT s.ciphertext FROM resellers r JOIN secrets s ON s.id=r.mc_parent_key_ref WHERE r.id=?1",
      )
      .bind(resellerId)
      .first<{ ciphertext: string }>();
    expect(row?.ciphertext).not.toContain("parent-secret");
    await h.db
      .prepare(
        "INSERT INTO hostnames(hostname,reseller_id,status) VALUES ('pilot.local.test',?1,'ACTIVE')",
      )
      .bind(resellerId)
      .run();
    await h.db
      .prepare(
        "INSERT INTO role_assignments VALUES ('local-owner','reseller',?1,'owner')",
      )
      .bind(resellerId)
      .run();
    await h.db
      .prepare("UPDATE resellers SET tracking_pattern=?2 WHERE id=?1")
      .bind(resellerId, "{account}.links.pilot.test")
      .run();
  });
  it("provisions idempotently with mandatory webhook and separate child key", async () => {
    const response = await h.request("/api/platform/accounts", {
      ...platform,
      method: "POST",
      headers: { "idempotency-key": "pilot-account" },
      body: { resellerId, name: "Pilot Customer", planId: "starter" },
    });
    const body = (await response.json()) as { id: string; records: unknown[] };
    expect(response.status, JSON.stringify(body)).toBe(202);
    accountId = body.id;
    expect(body.records.length).toBeGreaterThan(1);
    const account = await h.db
      .prepare("SELECT status,mc_handle,mc_key_ref FROM accounts WHERE id=?1")
      .bind(accountId)
      .first<{ status: string; mc_handle: string; mc_key_ref: string }>();
    expect(account?.status).toBe("ACTIVE");
    const again = await h.request("/api/platform/accounts", {
      ...platform,
      method: "POST",
      headers: { "idempotency-key": "pilot-account" },
      body: { resellerId, name: "Pilot Customer", planId: "starter" },
    });
    expect(((await again.json()) as { id: string }).id).toBe(accountId);
    expect(
      h.calls.filter(
        (c) => c.path === "/tx/v1/sub-account" && c.method === "POST",
      ),
    ).toHaveLength(1);
    expect(h.calls.find((c) => c.path === "/tx/v1/webhook")?.key).toBe(
      "key-" + account!.mc_handle,
    );
    const credential = await h.request("/api/reseller/api-keys", {
      host: "pilot.local.test",
      method: "POST",
      body: {
        scopes: ["accounts.read", "accounts.manage", "sso.mint", "usage.read"],
      },
    });
    key = ((await credential.json()) as { key: string }).key;
    expect(key).toBeTruthy();
  });
  it("supports API-key provisioning access without cross-reseller access", async () => {
    const list = await h.request("/v1/accounts", {
      host: "pilot.local.test",
      headers: { authorization: "Bearer " + key },
    });
    expect(list.status).toBe(200);
    const denied = await h.request("/v1/accounts/account-b", {
      host: "pilot.local.test",
      headers: { authorization: "Bearer " + key },
    });
    expect(denied.status).toBe(404);
    const wrongHost = await h.request("/v1/accounts", {
      host: "b.local.test",
      headers: { authorization: "Bearer " + key },
    });
    expect(wrongHost.status).toBe(401);
  });
  let cookie: string;
  it("mints one-use SSO and binds the session to the customer hostname", async () => {
    const handoff = await h.request(`/v1/accounts/${accountId}/sso`, {
      host: "pilot.local.test",
      method: "POST",
      headers: { authorization: "Bearer " + key },
      body: { email: "pilot-user@example.test" },
    });
    expect(handoff.status).toBe(200);
    const token = new URL(
      ((await handoff.json()) as { url: string }).url,
    ).searchParams.get("token");
    const login = await h.request("/api/auth/sso", {
      host: "pilot.local.test",
      method: "POST",
      body: { token },
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect(login.headers.get("set-cookie")).toContain(
      "HttpOnly; Secure; SameSite=Lax",
    );
    expect(
      (
        await h.request("/api/auth/sso", {
          host: "pilot.local.test",
          method: "POST",
          body: { token },
        })
      ).status,
    ).toBe(403);
    const me = await h.request("/api/me", {
      host: "pilot.local.test",
      headers: { cookie },
    });
    expect(((await me.json()) as { scopeId: string }).scopeId).toBe(accountId);
    expect(
      (
        await h.request("/api/templates", {
          host: "b.local.test",
          headers: { cookie },
        })
      ).status,
    ).toBe(403);
  });
  const customer = (
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) =>
    h.request(path, {
      host: "pilot.local.test",
      headers: { cookie },
      body,
      method,
    });
  it("onboards sender domain and records postal settings", async () => {
    expect(
      (
        await customer(
          "/api/settings",
          { postalAddress: "123 Example Road, Sample City", retentionDays: 30 },
          "PUT",
        )
      ).status,
    ).toBe(200);
    const domain = await customer("/api/domains", { domain: "sender.test" });
    const body = (await domain.json()) as { id: string; records: unknown[] };
    expect(domain.status).toBe(201);
    expect(body.records).toHaveLength(3);
    expect((await customer(`/api/domains/${body.id}/verify`, {})).status).toBe(
      200,
    );
  });
  let listId: string, campaignId: string;
  it("imports CSV through R2 and sends personalized marketing email locally", async () => {
    const ticket = await customer(
      "/api/generate-upload-url?filename=pilot.csv&consent=true",
    );
    const upload = (await ticket.json()) as {
      uploadUrl: string;
      resourceId: string;
    };
    listId = upload.resourceId;
    const sent = await h.request(new URL(upload.uploadUrl).pathname, {
      host: "pilot.local.test",
      headers: { cookie },
      method: "PUT",
      raw: "email,first_name\nrecipient@example.test,Ada\nrecipient@example.test,Ada\nsecond@example.test,Grace\n",
    });
    expect(sent.status).toBe(202);
    await eventually(
      async () => {
        const r = await customer("/api/recipients-lists");
        return (
          (await r.json()) as {
            recipientLists: { status: string; recipient_count: number }[];
          }
        ).recipientLists[0];
      },
      (r) => r?.status === "READY",
    );
    expect(
      (
        await customer("/api/templates", {
          name: "welcome",
          subject: "Hello {{firstName}}",
          text: "Hello {{firstName}}",
        })
      ).status,
    ).toBe(201);
    const campaign = await customer("/api/campaigns", {
      recipientListId: listId,
      templateName: "welcome",
      senderEmail: "news@sender.test",
      enableTracking: true,
    });
    const body = (await campaign.json()) as { campaignId: string };
    expect(campaign.status, JSON.stringify(body)).toBe(202);
    campaignId = body.campaignId;
    await eventually(
      async () => h.calls.filter((c) => c.path === "/tx/v1/send-async"),
      (c) => c.length === 2,
    );
    const sends = h.calls.filter((c) => c.path === "/tx/v1/send-async");
    expect(sends[0].key).not.toBe("parent-secret");
    expect(sends[0].body.transactional).toBe(false);
    expect(sends[0].body.tracking_settings).toBeUndefined();
    const headers = sends[0].body.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toContain(
      "pilot.local.test/unsubscribe?token=",
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const stored = await h.storage(accountId);
    expect(
      (await stored.exec("PRAGMA table_info(campaign_recipients)")).some(
        (c) => c.name === "data_json",
      ),
    ).toBe(false);
    const objects = await (await h.mf.getR2Bucket("CONTENT")).list();
    expect(
      objects.objects.every((o) => o.key.startsWith("acct/" + accountId + "/")),
    ).toBe(true);
  }, 15000);
  it("one-click unsubscribe is account-local and mirrored to the child provider", async () => {
    const send = h.calls.find((c) => c.path === "/tx/v1/send-async")!;
    const link = (send.body.headers as Record<string, string>)[
      "List-Unsubscribe"
    ].slice(1, -1);
    const page = await h.mf.dispatchFetch(link);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toMatch(/MailChannels|Cloudflare/);
    const response = await h.mf.dispatchFetch(link, {
      method: "POST",
      body: "List-Unsubscribe=One-Click",
    });
    expect(response.status).toBe(200);
    expect(
      h.calls.some(
        (c) => c.path === "/tx/v1/suppression-list" && c.key === send.key,
      ),
    ).toBe(true);
    const rows = await (
      await h.storage(accountId)
    ).exec("SELECT * FROM suppressions");
    expect(rows).toHaveLength(1);
    await h.request("/api/dashboard");
    expect(
      await (await h.storage("account-a")).exec("SELECT * FROM suppressions"),
    ).toHaveLength(0);
  });
  it("warms one tracking hostname before enabling both scopes", async () => {
    h.setTrackingReady(true);
    const response = await h.request(
      `/api/reseller/accounts/${accountId}/verify`,
      { host: "pilot.local.test", method: "POST" },
    );
    expect(response.status).toBe(200);
    const rows = await h.db
      .prepare(
        "SELECT scope,status FROM tracking_domains WHERE account_id=?1 ORDER BY scope",
      )
      .bind(accountId)
      .all();
    expect(rows.results).toEqual([
      { scope: "click", status: "ACTIVE" },
      { scope: "open", status: "ACTIVE" },
    ]);
    expect(h.calls.filter((c) => c.path === "/")).toHaveLength(1);
  });
  it("meters sends, exports data, and surfaces unknown webhook handles", async () => {
    await api("/api/platform/maintenance", {});
    const rows = await h.db
      .prepare(
        "SELECT accepted FROM usage_daily WHERE scope_type='account' AND scope_id=?1",
      )
      .bind(accountId)
      .all<{ accepted: number }>();
    expect(rows.results[0].accepted).toBe(2);
    const report = await h.request("/api/platform/usage?format=csv", platform);
    expect(report.headers.get("content-type")).toBe("text/csv");
    expect(await report.text()).toContain(accountId);
    const unknown = await h.request("/webhooks/mailchannels", {
      ...platform,
      method: "POST",
      body: [
        {
          customer_handle: "unknown-handle",
          event: "processed",
          timestamp: Date.now(),
        },
      ],
    });
    expect(unknown.status).toBe(202);
    const alerts = await h.db
      .prepare("SELECT * FROM alerts WHERE kind='unknown_webhook_handle'")
      .all();
    expect(alerts.results).toHaveLength(1);
    const exported = await customer("/api/export");
    expect(((await exported.json()) as { accountId: string }).accountId).toBe(
      accountId,
    );
  });
});
