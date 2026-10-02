/** Local-only provider double. Never imported into the deployed Worker. */
export function localProvider() {
  const accounts = new Map();
  const messages = [];
  const hostnames = new Map();
  return {
    messages,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = await request.json().catch(() => ({}));
      const path = url.pathname.replace("/tx/v1", "");
      if (url.hostname === "api.cloudflare.com") {
        let record;
        if (request.method === "POST") {
          record = {
            id: crypto.randomUUID(),
            hostname: body.hostname,
            status: "pending",
            ssl: { status: "pending" },
            ownership_verification: {
              type: "TXT",
              name: "_cf-custom-hostname." + body.hostname,
              value: "local-only-verification",
            },
          };
          hostnames.set(record.id, record);
        } else {
          record = hostnames.get(path.split("/").at(-1));
          if (record)
            record = { ...record, status: "active", ssl: { status: "active" } };
        }
        return Response.json({ success: !!record, result: record });
      }
      if (path === "/sub-account" && request.method === "GET")
        return Response.json([...accounts.values()]);
      if (path === "/sub-account" && request.method === "POST") {
        if (accounts.has(body.handle)) return new Response("", { status: 409 });
        accounts.set(body.handle, body);
        return Response.json(body, { status: 201 });
      }
      if (path.endsWith("/api-key") && request.method === "POST")
        return Response.json(
          { id: 1, key: "local-key-" + path.split("/")[2] },
          { status: 201 },
        );
      if (path === "/custom-tracking-domains")
        return Response.json({ status: "active" }, { status: 201 });
      if (path.includes("/dkim-keys"))
        return Response.json(
          {
            selector: body.selector,
            dkim_dns_records: [
              {
                type: "TXT",
                name: body.selector + "._domainkey." + path.split("/")[2],
                value: "v=DKIM1; p=LOCAL_TEST_KEY",
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
      if (path === "/send" || path === "/send-async") {
        const request_id = crypto.randomUUID();
        messages.push({
          request_id,
          key: request.headers.get("x-api-key"),
          ...body,
        });
        return Response.json(
          { request_id, queued_at: new Date().toISOString() },
          { status: 202 },
        );
      }
      if (path === "/usage")
        return Response.json({
          total_usage: messages.length,
          monthly_limit: 10000,
          period_start_date: new Date().toISOString().slice(0, 7) + "-01",
        });
      return Response.json({ ok: true });
    },
  };
}
