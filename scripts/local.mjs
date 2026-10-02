import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname } from "node:path";
import { localProvider } from "./local-provider.mjs";
const port = Number(process.env.LOCAL_PORT ?? 8790);
const root = resolve(".");
const state = resolve(".local/state");
await mkdir(state, { recursive: true });
const provider = localProvider();
const bundle = await build({
  entryPoints: ["src/worker/index.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  external: ["cloudflare:workers"],
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    d1Persist: state + "/d1",
    r2Persist: state + "/r2",
    durableObjectsPersist: state + "/do",
    workers: [
      {
        name: "app",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-08-01",
        bindings: {
          AUTH_MODE: "development",
          LOCAL_TEST: "true",
          LOCAL_PORT: String(port),
          PLATFORM_HOST: "platform.localhost",
          WEBHOOK_VERIFY_SIGNATURES: "false",
          KEY_ENCRYPTION_SECRET: Buffer.alloc(32, 7).toString("base64"),
          SESSION_SECRET: "local-only-session-signing-secret",
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
        queueConsumers: {
          campaigns: { maxBatchTimeout: 0 },
          emails: { maxBatchTimeout: 0 },
          events: { maxBatchTimeout: 0 },
        },
        serviceBindings: {
          PROVIDER: provider.fetch,
          ASSETS: async (request) => {
            const pathname = new URL(request.url).pathname;
            let file = resolve(root, "dist", "." + pathname);
            if (!file.startsWith(root + "/dist/"))
              file = root + "/dist/index.html";
            let bytes;
            try {
              bytes = await readFile(file);
            } catch {
              file = root + "/dist/index.html";
              bytes = await readFile(file);
            }
            return new Response(bytes, {
              headers: {
                "content-type":
                  {
                    ".html": "text/html",
                    ".js": "text/javascript",
                    ".css": "text/css",
                    ".png": "image/png",
                    ".svg": "image/svg+xml",
                  }[extname(file)] ?? "application/octet-stream",
              },
            });
          },
        },
      },
    ],
  }),
);
const db = await mf.getD1Database("DB");
await db
  .prepare("CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY)")
  .run();
const name = "0001_control";
if (
  !(await db
    .prepare("SELECT name FROM local_migrations WHERE name=?1")
    .bind(name)
    .first())
) {
  for (const sql of (
    await readFile("migrations/control/0001_control.sql", "utf8")
  )
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await db.prepare(sql).run();
  await db.prepare("INSERT INTO local_migrations VALUES (?1)").bind(name).run();
}
for (const sql of (await readFile("scripts/seed-local.sql", "utf8"))
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean))
  await db.prepare(sql).run();
for (const [host, reseller] of [
  ["a.localhost", "reseller-a"],
  ["b.localhost", "reseller-b"],
  ["platform.localhost", null],
])
  await db
    .prepare(
      "INSERT OR IGNORE INTO hostnames(hostname,reseller_id,status) VALUES (?1,?2,'ACTIVE')",
    )
    .bind(host, reseller)
    .run();
const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? "localhost:8787";
    const url = "http://" + host + (req.url ?? "/");
    if (new URL(url).pathname === "/__local/mailbox") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          {
            systemEmails: (
              await db
                .prepare(
                  "SELECT recipient,subject,body FROM system_emails ORDER BY created_at DESC LIMIT 50",
                )
                .all()
            ).results,
            sentMessages: provider.messages,
          },
          null,
          2,
        ),
      );
      return;
    }
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const body = Buffer.concat(buffers);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    if (!headers.has("x-dev-user-email"))
      headers.set(
        "x-dev-user-email",
        host.startsWith("platform.")
          ? "platform@local.test"
          : host.startsWith("b.")
            ? "other@local.test"
            : "developer@local.test",
      );
    if (body.length) headers.set("content-length", String(body.length));
    const response = await mf.dispatchFetch(url, {
      redirect: "manual",
      method: req.method,
      headers,
      body: body.length ? body : undefined,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    for await (const chunk of response.body ?? []) res.write(chunk);
    res.end();
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Local service: http://a.localhost:${port} · http://b.localhost:${port} · http://platform.localhost:${port}\nLocal email capture: http://localhost:${port}/__local/mailbox\nAll provider calls are local test doubles. State: .local/state`,
  ),
);
const timer = setInterval(async () => {
  try {
    await (await mf.getWorker()).scheduled({ cron: "* * * * *" });
  } catch (error) {
    console.error(error);
  }
}, 60_000);
async function stop() {
  clearInterval(timer);
  server.close();
  await mf.dispose();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
