import type { Env } from "../types";
import { HttpError, id, json, nowIso, readJson } from "../utils";
import { audit } from "./identity";
import { authorize, type Principal } from "./rbac";
import { accountClient, dnsRecords, emit } from "./provisioning";
export function hostname(value: unknown): string {
  const host = String(value ?? "")
    .toLowerCase()
    .trim();
  if (
    host.length > 253 ||
    !host.includes(".") ||
    !host
      .split(".")
      .every((s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) ||
    /^\d+(\.\d+){3}$/.test(host)
  )
    throw new HttpError(400, "Invalid domain name");
  return host;
}
export async function domainRoutes(
  request: Request,
  env: Env,
  p: Principal,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/domains")) return null;
  authorize(p, "domains.write", "account", p.scopeId);
  if (path === "/api/domains" && request.method === "GET")
    return json({
      domains: (
        await env.DB.prepare(
          "SELECT id,domain,dkim_selector,records_json,lockdown_ok,dkim_ok,spf_ok,verified_at FROM sender_domains WHERE account_id=?1",
        )
          .bind(p.scopeId)
          .all()
      ).results,
      records: await dnsRecords(env, p.scopeId),
    });
  if (path === "/api/domains" && request.method === "POST") {
    const body = await readJson<{ domain: string }>(request);
    const domain = hostname(body.domain);
    const existing = await env.DB.prepare(
      "SELECT id FROM sender_domains WHERE account_id=?1 AND domain=?2",
    )
      .bind(p.scopeId, domain)
      .first();
    if (existing) throw new HttpError(409, "Domain already registered");
    const selector =
      "mail" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const key = await (
      await accountClient(env, p.scopeId)
    ).dkim(domain, selector);
    const account = await env.DB.prepare(
      "SELECT mc_handle FROM accounts WHERE id=?1",
    )
      .bind(p.scopeId)
      .first<{ mc_handle: string }>();
    const records = [
      ...key.data.dkim_dns_records,
      {
        type: "TXT",
        name: `_mailchannels.${domain}`,
        value: `v=mc1 auth=${account!.mc_handle}`,
      },
      {
        type: "TXT",
        name: domain,
        value: "v=spf1 include:relay.mailchannels.net ~all",
      },
    ];
    const domainId = id("domain");
    await env.DB.prepare(
      "INSERT INTO sender_domains(id,account_id,domain,dkim_selector,records_json) VALUES (?1,?2,?3,?4,?5)",
    )
      .bind(domainId, p.scopeId, domain, selector, JSON.stringify(records))
      .run();
    await audit(env, p, "domain.create", domainId);
    return json({ id: domainId, records }, { status: 201 });
  }
  const match = path.match(/^\/api\/domains\/([^/]+)\/verify$/);
  if (match && request.method === "POST") {
    const domain = await env.DB.prepare(
      "SELECT domain FROM sender_domains WHERE id=?1 AND account_id=?2",
    )
      .bind(match[1], p.scopeId)
      .first<{ domain: string }>();
    if (!domain) throw new HttpError(404, "Domain not found");
    const checks = (
      await (await accountClient(env, p.scopeId)).checkDomain(domain.domain)
    ).data.check_results;
    const lockdown = checks.domain_lockdown?.verdict === "passed";
    const spf = checks.spf?.verdict === "passed";
    const dkim = Boolean(checks.dkim?.some((d) => d.verdict === "passed"));
    await env.DB.prepare(
      "UPDATE sender_domains SET lockdown_ok=?2,spf_ok=?3,dkim_ok=?4,verified_at=?5 WHERE id=?1",
    )
      .bind(
        match[1],
        +lockdown,
        +spf,
        +dkim,
        lockdown && spf && dkim ? nowIso() : null,
      )
      .run();
    await audit(env, p, "domain.verify", match[1]);
    return json({ verified: lockdown && spf && dkim, checks });
  }
  throw new HttpError(404, "Route not found");
}
export async function verifyTracking(
  env: Env,
  accountId: string,
  force = false,
): Promise<void> {
  const domains = (
    await env.DB.prepare(
      "SELECT * FROM tracking_domains WHERE account_id=?1 AND status<>'ACTIVE' AND next_attempt<=?2",
    )
      .bind(accountId, force ? Number.MAX_SAFE_INTEGER : Date.now())
      .all<{ id: string; hostname: string; scope: string; name: string }>()
  ).results;
  const client = await accountClient(env, accountId);
  for (const domain of domains) {
    await env.DB.prepare(
      "UPDATE tracking_domains SET next_attempt=?2 WHERE id=?1",
    )
      .bind(domain.id, Date.now() + 300_000)
      .run();
    const registration = await client.tracking(
      domain.hostname,
      domain.scope,
      domain.name,
    );
    if (registration.status !== 201 && registration.data.status !== "active")
      continue;
    const warm = await env.DB.prepare(
      "SELECT id FROM tracking_domains WHERE account_id=?1 AND hostname=?2 AND status='ACTIVE' LIMIT 1",
    )
      .bind(accountId, domain.hostname)
      .first();
    if (!warm) {
      // One new hostname/minute, burst one: at most 180 certificates per three hours.
      const limiter = env.RATE_LIMITER.get(
        env.RATE_LIMITER.idFromName("tracking-certificates"),
      );
      const permit = await limiter.fetch("https://limiter/acquire", {
        method: "POST",
        body: JSON.stringify({ rate: 1 / 60, burst: 1 }),
      });
      if (!permit.ok) continue;
      const url = `https://${domain.hostname}/`;
      const response =
        env.LOCAL_TEST === "true" && env.PROVIDER
          ? await env.PROVIDER.fetch(url)
          : await fetch(url, { redirect: "manual" });
      if (response.status >= 500) continue;
    }
    await env.DB.prepare(
      "UPDATE tracking_domains SET status='ACTIVE' WHERE id=?1",
    )
      .bind(domain.id)
      .run();
    const account = await env.DB.prepare(
      "SELECT reseller_id FROM accounts WHERE id=?1",
    )
      .bind(accountId)
      .first<{ reseller_id: string }>();
    await emit(env, account!.reseller_id, "tracking_domain.active", {
      accountId,
      hostname: domain.hostname,
      scope: domain.scope,
    });
  }
}
