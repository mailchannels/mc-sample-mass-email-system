import { beforeAll, afterAll, it, expect } from "vitest";
import { harness } from "./local-harness";
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
}, 30_000);
afterAll(async () => h?.mf.dispose());
const platform = { host: "platform.local.test", user: "platform@local.test" };
it("compensates partial provisioning, then resumes without creating another child", async () => {
  const r = await h.request("/api/platform/resellers", {
    ...platform,
    method: "POST",
    body: {
      name: "Failure Test",
      planId: "reseller",
      parentHandle: "failure",
      apiKey: "parent",
    },
  });
  const resellerId = ((await r.json()) as { id: string }).id;
  h.setFailure("/webhook");
  const a = await h.request("/api/platform/accounts", {
    ...platform,
    method: "POST",
    headers: { "idempotency-key": "failure-case" },
    body: { resellerId, name: "Retry Account", planId: "starter" },
  });
  const accountId = ((await a.json()) as { id: string }).id;
  const state = await h.db
    .prepare(
      "SELECT a.status,p.step,p.error FROM accounts a JOIN provisioning p ON p.account_id=a.id WHERE a.id=?1",
    )
    .bind(accountId)
    .first();
  expect(state?.status).toBe("PROVISIONING");
  expect(state?.step).toBe("WEBHOOK");
  expect(state?.error).toBeTruthy();
  expect(h.calls.some((c) => c.path.endsWith("/suspend"))).toBe(true);
  h.setFailure();
  await h.db
    .prepare("UPDATE provisioning SET next_attempt=0 WHERE account_id=?1")
    .bind(accountId)
    .run();
  const retry = await h.request(`/api/platform/accounts/${accountId}/retry`, {
    ...platform,
    method: "POST",
  });
  expect(retry.status).toBe(200);
  expect(
    (
      await h.db
        .prepare("SELECT status FROM accounts WHERE id=?1")
        .bind(accountId)
        .first()
    )?.status,
  ).toBe("ACTIVE");
  expect(
    h.calls.filter(
      (c) => c.path === "/tx/v1/sub-account" && c.method === "POST",
    ),
  ).toHaveLength(1);
  expect(
    h.calls.filter((c) => c.path.endsWith("/api-key") && c.method === "POST"),
  ).toHaveLength(1);
  expect(h.calls.some((c) => c.path.endsWith("/activate"))).toBe(true);
  // Deletion removes object data, R2 prefix, sub-account and credentials; retry is harmless.
  await h.internal(accountId, "/internal/rollup");
  await (
    await h.mf.getR2Bucket("CONTENT")
  ).put(`acct/${accountId}/file`, "private");
  const deleted = await h.request(`/api/platform/accounts/${accountId}`, {
    ...platform,
    method: "DELETE",
  });
  expect(deleted.status).toBe(200);
  expect(
    (
      await (
        await h.mf.getR2Bucket("CONTENT")
      ).list({ prefix: `acct/${accountId}/` })
    ).objects,
  ).toHaveLength(0);
  expect(
    await h.db
      .prepare("SELECT status,mc_key_ref FROM accounts WHERE id=?1")
      .bind(accountId)
      .first(),
  ).toEqual({ status: "DELETED", mc_key_ref: null });
  expect((await h.internal(accountId, "/internal/export")).status).toBe(404);
});
it("reconciles processed events before retry and stops after repeated ambiguity", async () => {
  await h.request("/api/dashboard");
  const sql = await h.storage("account-a");
  const old = new Date(Date.now() - 7200_000).toISOString();
  await sql.exec(
    "INSERT INTO templates(name,subject,text_body,created_at,updated_at) VALUES ('reconcile','Subject','Body',?,?)",
    old,
    old,
  );
  await sql.exec(
    "INSERT INTO recipient_lists(id,name,original_filename,object_key,status,created_at,updated_at) VALUES ('reconcile','List','list.csv','acct/account-a/list.csv','READY',?,?)",
    old,
    old,
  );
  await sql.exec(
    "INSERT INTO recipients(list_id,email,created_at) VALUES ('reconcile','a@example.test',?),('reconcile','b@example.test',?),('reconcile','c@example.test',?)",
    old,
    old,
    old,
  );
  await sql.exec(
    "INSERT INTO campaigns(id,list_id,list_name,template_name,sender_email,status,pending_count,total_count,expansion_done,created_at,updated_at) VALUES ('reconcile','reconcile','List','reconcile','sender@example.test','RUNNING',3,3,1,?,?)",
    old,
    old,
  );
  await sql.exec(
    "INSERT INTO campaign_batches(id,campaign_id,sequence,first_recipient_id,last_recipient_id,recipient_count,created_at,updated_at) VALUES ('reconcile','reconcile',1,1,3,3,?,?)",
    old,
    old,
  );
  await sql.exec(
    "INSERT INTO campaign_recipients(id,campaign_id,batch_id,source_recipient_id,email,status,attempts,updated_at) SELECT email,'reconcile','reconcile',id,email,'SENDING',CASE WHEN email='c@example.test' THEN 2 ELSE 1 END,? FROM recipients WHERE list_id='reconcile'",
    old,
  );
  const event = {
    event: "processed",
    customer_handle: "handle-a",
    timestamp: Date.now(),
    request_id: "processed-request",
    campaign_id: "reconcile",
    recipients: ["a@example.test"],
  };
  await h.internal("account-a", "/internal/event", {
    eventId: "event-reconcile",
    event,
  });
  await h.internal("account-a", "/internal/maintenance", {});
  const rows = await sql.exec(
    "SELECT email,status,mailchannels_request_id FROM campaign_recipients ORDER BY email",
  );
  expect(rows).toEqual([
    {
      email: "a@example.test",
      status: "ACCEPTED",
      mailchannels_request_id: "processed-request",
    },
    {
      email: "b@example.test",
      status: "PENDING",
      mailchannels_request_id: null,
    },
    {
      email: "c@example.test",
      status: "UNCONFIRMED",
      mailchannels_request_id: null,
    },
  ]);
  await h.internal("account-a", "/internal/maintenance", {});
  expect(
    (
      await sql.exec(
        "SELECT accepted_count,failed_count FROM campaigns WHERE id='reconcile'",
      )
    )[0],
  ).toEqual({ accepted_count: 1, failed_count: 1 });
});
it("captures exhausted jobs and replays them through an operator endpoint", async () => {
  const worker = await h.mf.getWorker();
  await worker.queue("campaigns", [
    {
      id: "broken",
      timestamp: new Date(),
      body: { type: "import-list" },
      attempts: 5,
    },
  ]);
  const row = await h.db
    .prepare("SELECT * FROM dead_letters WHERE id='broken'")
    .first();
  expect(row).toBeTruthy();
  const replay = await h.request("/api/platform/dead-letters/broken/replay", {
    ...platform,
    method: "POST",
  });
  expect(replay.status).toBe(200);
  expect(
    (
      await h.db
        .prepare("SELECT replayed_at FROM dead_letters WHERE id='broken'")
        .first()
    )?.replayed_at,
  ).toBeTruthy();
});
it("does not activate unverified hostnames and injects only the owning reseller theme", async () => {
  const theme = await h.request("/api/reseller/theme", {
    method: "PUT",
    body: {
      tokens: { productName: "Pilot Post", primary: "#abcdef" },
      css: ".card {color:#abcdef;}",
    },
  });
  expect(theme.status).toBe(200);
  const branded = await h.request("/");
  expect(await branded.text()).toContain("<title>Pilot Post</title>");
  const other = await h.request("/", { host: "b.local.test" });
  expect(await other.text()).not.toContain("Pilot Post");
  const host = await h.request("/api/reseller/hostnames", {
    method: "POST",
    body: { hostname: "brand.example.test" },
  });
  expect(host.status).toBe(201);
  expect((await h.request("/", { host: "brand.example.test" })).status).toBe(
    404,
  );
  const verified = await h.request(
    "/api/reseller/hostnames/brand.example.test",
    { method: "POST" },
  );
  expect(verified.status).toBe(200);
  expect(
    await (await h.request("/", { host: "brand.example.test" })).text(),
  ).toContain("Pilot Post");
});

it("repairs an interrupted hostname registration through the console verification action", async () => {
  await h.db
    .prepare(
      "INSERT INTO hostnames(hostname,reseller_id,status) VALUES ('repair.example.test','reseller-a','PENDING')",
    )
    .run();
  expect(
    (
      await h.request("/api/reseller/hostnames/repair.example.test", {
        host: "b.local.test",
        method: "POST",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await h.request("/api/reseller/hostnames/repair.example.test", {
        method: "POST",
      })
    ).status,
  ).toBe(200);
  expect(
    await h.db
      .prepare(
        "SELECT status,cf_custom_hostname_id FROM hostnames WHERE hostname='repair.example.test'",
      )
      .first(),
  ).toMatchObject({
    status: "PENDING",
    cf_custom_hostname_id: expect.any(String),
  });
});
