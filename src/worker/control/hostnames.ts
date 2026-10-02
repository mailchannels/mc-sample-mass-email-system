import type { Env } from "../types";
import { HttpError, json, nowIso, readJson } from "../utils";
import { hostname } from "./domains";
import { authorize, type Principal } from "./rbac";
import { audit } from "./identity";
interface HostResult {
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string; validation_records?: unknown[] };
  ownership_verification?: unknown;
}
async function cloudflare(
  env: Env,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<HostResult> {
  if (!env.CF_ZONE_ID || !env.CF_API_TOKEN)
    throw new HttpError(503, "Hostname provider is not configured");
  const url = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames${path}`;
  const options = {
    method,
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const response =
    env.LOCAL_TEST === "true" && env.PROVIDER
      ? await env.PROVIDER.fetch(url, options)
      : await fetch(url, options);
  const data = await response.json<{ success: boolean; result: HostResult }>();
  if (!response.ok || !data.success)
    throw new HttpError(502, "Hostname provider request failed");
  return data.result;
}
export async function hostnameRoutes(
  request: Request,
  env: Env,
  p: Principal,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/api\/(reseller|platform)\/hostnames(?:\/([^/]+))?$/,
  );
  if (!match) return null;
  const platform = match[1] === "platform";
  authorize(
    p,
    "hostnames.write",
    platform ? "platform" : "reseller",
    platform ? "platform" : (p.resellerId ?? ""),
  );
  if (platform && p.hostname !== env.PLATFORM_HOST)
    throw new HttpError(403, "Wrong console");
  if (request.method === "GET" && !match[2])
    return json({
      hostnames: (
        await (
          platform
            ? env.DB.prepare("SELECT * FROM hostnames")
            : env.DB.prepare(
                "SELECT * FROM hostnames WHERE reseller_id=?1",
              ).bind(p.resellerId)
        ).all()
      ).results,
    });
  if (request.method === "POST" && !match[2]) {
    const body = await readJson<{ hostname: string; resellerId?: string }>(
      request,
    );
    const name = hostname(body.hostname);
    const resellerId = platform ? body.resellerId : p.resellerId;
    if (!resellerId || name === env.PLATFORM_HOST)
      throw new HttpError(400, "Reseller hostname required");
    const row = await env.DB.prepare("SELECT id FROM resellers WHERE id=?1")
      .bind(resellerId)
      .first();
    if (!row) throw new HttpError(404, "Reseller not found");
    // Claim uniqueness before the external operation to prevent two reseller ownership races.
    try {
      await env.DB.prepare(
        "INSERT INTO hostnames(hostname,reseller_id,status) VALUES (?1,?2,'PENDING')",
      )
        .bind(name, resellerId)
        .run();
    } catch {
      throw new HttpError(409, "Hostname already registered");
    }
    const result = await cloudflare(env, "", "POST", {
      hostname: name,
      ssl: { method: "txt", type: "dv" },
    });
    await env.DB.prepare(
      "UPDATE hostnames SET cf_custom_hostname_id=?2,verification_json=?3 WHERE hostname=?1",
    )
      .bind(name, result.id, JSON.stringify(result))
      .run();
    await audit(env, p, "hostname.create", name);
    return json({ hostname: name, verification: result }, { status: 201 });
  }
  if (match[2] && request.method === "POST") {
    const name = decodeURIComponent(match[2]);
    const row = await env.DB.prepare(
      "SELECT reseller_id,cf_custom_hostname_id FROM hostnames WHERE hostname=?1",
    )
      .bind(name)
      .first<{ reseller_id: string; cf_custom_hostname_id: string }>();
    if (!row || (!platform && row.reseller_id !== p.resellerId))
      throw new HttpError(404, "Hostname not found");
    const result = row.cf_custom_hostname_id
      ? await cloudflare(
          env,
          "/" + encodeURIComponent(row.cf_custom_hostname_id),
        )
      : await cloudflare(env, "", "POST", {
          hostname: name,
          ssl: { method: "txt", type: "dv" },
        });
    await env.DB.prepare(
      "UPDATE hostnames SET cf_custom_hostname_id=?2 WHERE hostname=?1",
    )
      .bind(name, result.id)
      .run();
    const active =
      result.hostname === name &&
      result.status === "active" &&
      result.ssl.status === "active";
    await env.DB.prepare(
      "UPDATE hostnames SET status=?2,verified_at=?3,verification_json=?4 WHERE hostname=?1",
    )
      .bind(
        name,
        active ? "ACTIVE" : "PENDING",
        nowIso(),
        JSON.stringify(result),
      )
      .run();
    await audit(env, p, "hostname.verify", name);
    return json({ active, verification: result });
  }
  throw new HttpError(404, "Route not found");
}

export async function reverifyHostnames(env: Env): Promise<void> {
  const rows = (
    await env.DB.prepare(
      "SELECT hostname,cf_custom_hostname_id FROM hostnames WHERE cf_custom_hostname_id IS NOT NULL AND (verified_at IS NULL OR verified_at<?1) LIMIT 10",
    )
      .bind(new Date(Date.now() - 86400_000).toISOString())
      .all<{ hostname: string; cf_custom_hostname_id: string }>()
  ).results;
  for (const row of rows) {
    const result = await cloudflare(
      env,
      "/" + encodeURIComponent(row.cf_custom_hostname_id),
    );
    const active =
      result.hostname === row.hostname &&
      result.status === "active" &&
      result.ssl.status === "active";
    await env.DB.prepare(
      "UPDATE hostnames SET status=?2,verified_at=?3,verification_json=?4 WHERE hostname=?1",
    )
      .bind(
        row.hostname,
        active ? "ACTIVE" : "PENDING",
        nowIso(),
        JSON.stringify(result),
      )
      .run();
  }
}
