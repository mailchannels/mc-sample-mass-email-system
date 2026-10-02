import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
async function request(
  path: string,
  options: {
    host?: string;
    user?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const origin = `http://${options.host ?? "a.local.test"}`;
  return mf.dispatchFetch(origin + path, {
    method: options.method ?? "GET",
    headers: {
      origin,
      "x-dev-user-email": options.user ?? "developer@local.test",
      "content-type": "application/json",
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
beforeAll(async () => {
  const output = await build({
    entryPoints: ["src/worker/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
  });
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [
        {
          name: "app",
          modules: true,
          script: output.outputFiles[0].text,
          compatibilityDate: "2026-08-01",
          bindings: {
            AUTH_MODE: "development",
            LOCAL_TEST: "true",
            PLATFORM_HOST: "platform.local.test",
            WEBHOOK_VERIFY_SIGNATURES: "false",
          },
          d1Databases: ["DB"],
          r2Buckets: ["CONTENT"],
          durableObjects: {
            ACCOUNTS: { className: "AccountDO", useSQLite: true },
            RATE_LIMITER: { className: "EmailRateLimiter", useSQLite: true },
          },
          queueProducers: {
            CAMPAIGN_QUEUE: "campaigns",
            EMAIL_QUEUE: "emails",
            EVENT_QUEUE: "events",
          },
          serviceBindings: {
            ASSETS: async () =>
              new Response(
                '<html><head><title>Email</title></head><body><div id="root"></div></body></html>',
                { headers: { "content-type": "text/html" } },
              ),
          },
        },
      ],
    }),
    unsafeInspectDurableObjects: true,
  });
  db = await mf.getD1Database("DB");
  for (const file of [
    "migrations/control/0001_control.sql",
    "scripts/seed-local.sql",
  ]) {
    const sql = await readFile(file, "utf8");
    for (const statement of sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  }
}, 30_000);
afterAll(async () => {
  await mf?.dispose();
});
describe("local Durable Object tenant isolation", () => {
  it("rejects unknown hostnames and unauthorized account selection", async () => {
    expect(
      (await request("/api/templates", { host: "unknown.test" })).status,
    ).toBe(404);
    expect(
      (
        await request("/api/templates", {
          headers: { "x-dev-account-id": "account-b" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/templates", { host: "b.local.test" })).status,
    ).toBe(403);
  });
  it("isolates same-name templates and records mutations", async () => {
    const created = await request("/api/templates", {
      method: "POST",
      body: { name: "welcome", subject: "A secret", text: "Hello" },
    });
    expect(await created.text()).toContain("A secret");
    expect(created.status).toBe(201);
    const other = await request("/api/templates", {
      host: "b.local.test",
      user: "other@local.test",
    });
    expect(await other.json()).toEqual({ templates: [] });
    expect(
      (
        await request("/api/templates/welcome", {
          host: "b.local.test",
          user: "other@local.test",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("/api/templates/welcome", {
          host: "b.local.test",
          user: "other@local.test",
          method: "PUT",
          body: { subject: "steal", text: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("/api/templates/welcome", {
          host: "b.local.test",
          user: "other@local.test",
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(
      (await db.prepare("SELECT * FROM audit_log").all()).results.length,
    ).toBeGreaterThan(0);
  });
  it("keeps lists, upload tokens, and object keys inside an account", async () => {
    const res = await request(
      "/api/generate-upload-url?filename=people.csv&consent=true",
    );
    const upload = (await res.json()) as {
      uploadUrl: string;
      resourceId: string;
    };
    expect(res.status).toBe(200);
    const path = new URL(upload.uploadUrl).pathname;
    expect(
      (
        await request(path, {
          host: "b.local.test",
          user: "other@local.test",
          method: "PUT",
          body: "email\na@example.test",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("/api/recipients-lists/" + upload.resourceId, {
          host: "b.local.test",
          user: "other@local.test",
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    const objects = await (await mf.getR2Bucket("CONTENT")).list();
    expect(objects.objects).toHaveLength(0);
  });
  it("fails closed for undeclared routes and cross-origin writes", async () => {
    expect((await request("/api/not-declared")).status).toBe(404);
    expect(
      (
        await request("/api/templates", {
          method: "POST",
          body: {},
          headers: { origin: "https://evil.test" },
        })
      ).status,
    ).toBe(403);
  });
});

describe("route-by-route foreign-resource probes", () => {
  beforeAll(async () => {
    await request("/api/dashboard");
    const sql = await mf.unsafeGetDurableObjectStorage("app", "AccountDO", {
      name: "account-a",
    });
    const now = new Date().toISOString();
    await sql.exec(
      "INSERT OR IGNORE INTO templates(name,subject,text_body,created_at,updated_at) VALUES ('welcome','A secret','A body',?,?)",
      now,
      now,
    );
    await sql.exec(
      "INSERT INTO recipient_lists(id,name,original_filename,object_key,status,created_at,updated_at) VALUES ('foreign-list','A secret','people.csv','acct/account-a/people.csv','READY',?,?)",
      now,
      now,
    );
    await sql.exec(
      "INSERT INTO attachments(id,filename,content_type,size,object_key,created_at) VALUES ('foreign-attachment','A secret','text/plain',1,'acct/account-a/attachment',?)",
      now,
    );
    await sql.exec(
      "INSERT INTO upload_tokens(token,kind,object_key,filename,content_type,list_id,expires_at) VALUES ('foreign-token','recipient-list','acct/account-a/upload.csv','A secret','text/csv','foreign-list',?)",
      Math.floor(Date.now() / 1000) + 900,
    );
    await sql.exec(
      "INSERT INTO campaigns(id,list_id,list_name,template_name,sender_email,status,created_at,updated_at) VALUES ('foreign-campaign','foreign-list','A secret','welcome','sender@example.test','PREPARING',?,?)",
      now,
      now,
    );
    await db
      .prepare(
        "INSERT INTO sender_domains(id,account_id,domain) VALUES ('foreign-domain','account-a','private.example.test')",
      )
      .run();
  });
  it.each([
    ["GET", "/api/templates/welcome", undefined, 404],
    [
      "PUT",
      "/api/templates/welcome",
      { subject: "stolen", text: "stolen" },
      404,
    ],
    ["DELETE", "/api/templates/welcome", undefined, 404],
    ["DELETE", "/api/recipients-lists/foreign-list", undefined, 404],
    ["DELETE", "/api/attachments/foreign-attachment", undefined, 404],
    ["PUT", "/api/uploads/foreign-token", "secret", 404],
    ["GET", "/api/campaigns/foreign-campaign", undefined, 404],
    ["PUT", "/api/campaigns/foreign-campaign", { name: "stolen" }, 404],
    ["POST", "/api/domains/foreign-domain/verify", {}, 404],
  ])(
    "%s %s does not reveal another tenant resource",
    async (method, path, body, status) => {
      const result = await request(String(path), {
        host: "b.local.test",
        user: "other@local.test",
        method: String(method),
        body,
      });
      expect(result.status).toBe(status);
    },
  );
  it.each([
    "/api/templates",
    "/api/recipients-lists",
    "/api/attachments",
    "/api/campaigns",
    "/api/topics",
    "/api/suppressions",
  ])("keeps %s listings account-local", async (path) => {
    const result = await request(path, {
      host: "b.local.test",
      user: "other@local.test",
    });
    expect(result.status).toBe(200);
    expect(JSON.stringify(await result.json())).not.toMatch(
      /A secret|people.csv|welcome/,
    );
  });
});
