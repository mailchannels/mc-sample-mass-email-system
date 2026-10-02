import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
export interface ProviderCall {
  path: string;
  method: string;
  key: string | null;
  body: Record<string, unknown>;
}
export async function harness(
  options: {
    sessionsOnly?: boolean;
    queues?: boolean;
    provider?: (request: Request) => Promise<Response | null>;
  } = {},
) {
  const calls: ProviderCall[] = [];
  const children = new Map<string, string>();
  let trackingReady = false;
  let failure: string | undefined;
  const output = await build({
    entryPoints: ["src/worker/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
  });
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [
        {
          name: "app",
          modules: true,
          script: output.outputFiles[0].text,
          compatibilityDate: "2026-08-01",
          bindings: {
            AUTH_MODE: options.sessionsOnly
              ? "cloudflare-access"
              : "development",
            LOCAL_TEST: "true",
            PLATFORM_HOST: "platform.local.test",
            WEBHOOK_VERIFY_SIGNATURES: "false",
            SESSION_SECRET: "local-test-signing-key-not-for-production",
            KEY_ENCRYPTION_SECRET: Buffer.alloc(32, 7).toString("base64"),
            CF_ZONE_ID: "local-zone",
            CF_API_TOKEN: "local-token",
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
          ...(options.queues
            ? {
                queueConsumers: {
                  campaigns: { maxBatchTimeout: 0 },
                  emails: { maxBatchTimeout: 0 },
                  events: { maxBatchTimeout: 0 },
                },
              }
            : {}),
          serviceBindings: {
            ASSETS: async () =>
              new Response(
                '<html><head><title>Email</title></head><body><div id="root"></div></body></html>',
                { headers: { "content-type": "text/html" } },
              ),
            PROVIDER: async (request) => {
              const custom = await options.provider?.(
                request.clone() as unknown as Request,
              );
              if (custom) return custom;
              const url = new URL(request.url);
              const body = (await request.json().catch(() => ({}))) as Record<
                string,
                unknown
              >;
              calls.push({
                path: url.pathname,
                method: request.method,
                key: request.headers.get("x-api-key"),
                body,
              });
              if (failure && url.pathname.includes(failure))
                return Response.json(
                  { error: "injected failure" },
                  { status: 500 },
                );
              if (url.hostname === "api.cloudflare.com")
                return Response.json({
                  success: true,
                  result: {
                    id: "cf-host",
                    hostname: String(body.hostname ?? "brand.example.test"),
                    status: request.method === "POST" ? "pending" : "active",
                    ssl: {
                      status:
                        request.method === "POST"
                          ? "pending_validation"
                          : "active",
                    },
                    ownership_verification: {
                      type: "txt",
                      name: "_cf-custom-hostname.brand.example.test",
                      value: "nonce",
                    },
                  },
                });
              const path = url.pathname.replace("/tx/v1", "");
              if (request.headers.get("x-api-key") === "invalid")
                return new Response("", { status: 403 });
              if (path === "/sub-account" && request.method === "GET")
                return Response.json(
                  [...children.keys()].map((handle) => ({ handle })),
                );
              if (path === "/sub-account" && request.method === "POST") {
                const handle = String(body.handle);
                if (children.has(handle))
                  return new Response("", { status: 409 });
                children.set(handle, "key-" + handle);
                return Response.json({ handle }, { status: 201 });
              }
              if (path.endsWith("/api-key") && request.method === "POST")
                return Response.json(
                  { id: 1, key: "key-" + path.split("/")[2] },
                  { status: 201 },
                );
              if (path === "/custom-tracking-domains")
                return Response.json(
                  trackingReady
                    ? { status: "active" }
                    : { token: "nonce-" + request.headers.get("x-api-key") },
                  { status: trackingReady ? 201 : 202 },
                );
              if (path.includes("/dkim-keys"))
                return Response.json(
                  {
                    selector: body.selector,
                    dkim_dns_records: [
                      {
                        type: "TXT",
                        name: body.selector + "._domainkey.sender.test",
                        value: "v=DKIM1; p=local-key",
                      },
                    ],
                  },
                  { status: 201 },
                );
              if (path === "/check-domain")
                return Response.json({
                  check_results: {
                    domain_lockdown: { verdict: "passed" },
                    spf: { verdict: "passed" },
                    dkim: [{ verdict: "passed" }],
                  },
                });
              if (path === "/send-async")
                return Response.json(
                  {
                    request_id: "request-" + crypto.randomUUID(),
                    queued_at: new Date().toISOString(),
                  },
                  { status: 202 },
                );
              if (path === "/usage")
                return Response.json({
                  total_usage: 10,
                  monthly_limit: 10000,
                  period_start_date: "2026-10-01",
                  period_end_date: "2026-11-01",
                });
              return Response.json({ ok: true });
            },
          },
        },
      ],
    }),
    unsafeInspectDurableObjects: true,
  });
  const db = await mf.getD1Database("DB");
  for (const file of [
    "migrations/control/0001_control.sql",
    "scripts/seed-local.sql",
  ])
    for (const sql of (await readFile(file, "utf8"))
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  async function request(
    path: string,
    options: {
      host?: string;
      user?: string;
      method?: string;
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const origin = `http://${options.host ?? "a.local.test"}`;
    return mf.dispatchFetch(origin + path, {
      redirect: "manual",
      method: options.method ?? "GET",
      headers: {
        origin,
        "x-dev-user-email": options.user ?? "developer@local.test",
        "content-type": "application/json",
        ...(options.raw
          ? { "content-length": String(Buffer.byteLength(options.raw)) }
          : {}),
        ...options.headers,
      },
      body:
        options.raw ??
        (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
  }
  const storage = (accountId: string) =>
    mf.unsafeGetDurableObjectStorage("app", "AccountDO", { name: accountId });
  async function internal(accountId: string, path: string, body?: unknown) {
    const ns = await mf.getDurableObjectNamespace("ACCOUNTS");
    return ns
      .get(ns.idFromName(accountId))
      .fetch("https://account.internal" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-account-id": accountId },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
  }
  return {
    mf,
    db,
    request,
    calls,
    storage,
    internal,
    setTrackingReady: (value: boolean) => {
      trackingReady = value;
    },
    setFailure: (path?: string) => {
      failure = path;
    },
  };
}
export async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 10000,
): Promise<T> {
  const end = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < end);
  throw new Error("Condition not reached: " + JSON.stringify(value));
}
