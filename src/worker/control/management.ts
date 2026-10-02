import type { AccountRecord, Env } from "../types";
import { HttpError, id, json, nowIso, readJson, safeName } from "../utils";
import { audit, hash } from "./identity";
import { authorize, type Principal } from "./rbac";
import { readSecret, storeSecret, signToken } from "./crypto";
import { MailChannels } from "../mailchannels/client";
import { provision, emit, dnsRecords } from "./provisioning";
import { hostname, verifyTracking } from "./domains";
import { newSession, sessionCookie, publicOrigin } from "./sessions";
import { accountStub } from "../account/routing";
export async function management(
  request: Request,
  env: Env,
  p: Principal,
): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method;
  const platform = url.pathname.startsWith("/api/platform/");
  const reseller =
    url.pathname.startsWith("/api/reseller/") ||
    url.pathname.startsWith("/v1/");
  if (!platform && !reseller) return null;
  if (p.actorUserId)
    throw new HttpError(
      403,
      "Leave support access before managing the service",
    );
  const scope = platform ? "platform" : "reseller";
  const scopeId = platform ? "platform" : p.resellerId;
  if (!scopeId || (platform && p.hostname !== env.PLATFORM_HOST))
    throw new HttpError(403, "Wrong console");
  const path = url.pathname.replace(/^\/api\/(platform|reseller)|^\/v1/, "");
  const check = (permission: string) =>
    authorize(p, permission, scope, scopeId);
  const scoped = { ...p, scopeType: scope, scopeId } as Principal;
  if (platform && path === "/resellers") {
    check(method === "GET" ? "accounts.read" : "resellers.manage");
    if (method === "GET")
      return json({
        resellers: (
          await env.DB.prepare(
            "SELECT id,name,status,plan_id,mc_parent_handle,tracking_pattern,created_at FROM resellers ORDER BY created_at DESC",
          ).all()
        ).results,
      });
    if (method === "POST") {
      const body = await readJson<{
        name: string;
        planId: string;
        parentHandle: string;
        apiKey: string;
      }>(request);
      const name = safeName(body.name);
      if (!body.parentHandle || !body.apiKey)
        throw new HttpError(400, "Parent handle and key required");
      await new MailChannels(env, body.apiKey).listAccounts();
      const plan = await env.DB.prepare(
        "SELECT id FROM plans WHERE id=?1 AND scope_type='reseller'",
      )
        .bind(body.planId)
        .first();
      if (!plan) throw new HttpError(400, "Invalid reseller plan");
      const resellerId = id("reseller");
      const key = await storeSecret(env, body.apiKey);
      await env.DB.prepare(
        "INSERT INTO resellers(id,name,plan_id,mc_parent_handle,mc_parent_key_ref,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
      )
        .bind(resellerId, name, body.planId, body.parentHandle, key, nowIso())
        .run();
      await audit(env, scoped, "reseller.link", resellerId);
      return json({ id: resellerId }, { status: 201 });
    }
  }
  const resellerSettings = path.match(/^\/resellers\/([^/]+)\/system-email$/);
  if (platform && resellerSettings && method === "PUT") {
    check("resellers.manage");
    const body = await readJson<{ from: string; apiKey: string }>(request);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.from ?? "") || !body.apiKey)
      throw new HttpError(400, "System sender and key required");
    const reseller = await env.DB.prepare(
      "SELECT id FROM resellers WHERE id=?1",
    )
      .bind(resellerSettings[1])
      .first();
    if (!reseller) throw new HttpError(404, "Reseller not found");
    await new MailChannels(env, body.apiKey).usage();
    const ref = await storeSecret(env, body.apiKey);
    await env.DB.prepare(
      "UPDATE resellers SET system_email_from=?2,system_email_key_ref=?3 WHERE id=?1",
    )
      .bind(resellerSettings[1], body.from, ref)
      .run();
    await audit(env, scoped, "reseller.system-email", resellerSettings[1]);
    return json({ ok: true });
  }
  const resellerUpdate = path.match(/^\/resellers\/([^/]+)$/);
  if (platform && resellerUpdate && method === "PUT") {
    check("resellers.manage");
    const body = await readJson<{ planId?: string; status?: string }>(request);
    const reseller = await env.DB.prepare(
      "SELECT plan_id,status FROM resellers WHERE id=?1",
    )
      .bind(resellerUpdate[1])
      .first<{ plan_id: string; status: string }>();
    if (!reseller) throw new HttpError(404, "Reseller not found");
    if (body.status && !["ACTIVE", "SUSPENDED"].includes(body.status))
      throw new HttpError(400, "Invalid reseller status");
    if (
      body.planId &&
      !(await env.DB.prepare(
        "SELECT id FROM plans WHERE id=?1 AND scope_type='reseller'",
      )
        .bind(body.planId)
        .first())
    )
      throw new HttpError(400, "Invalid reseller plan");
    await env.DB.prepare(
      "UPDATE resellers SET plan_id=?2,status=?3 WHERE id=?1",
    )
      .bind(
        resellerUpdate[1],
        body.planId ?? reseller.plan_id,
        body.status ?? reseller.status,
      )
      .run();
    await audit(env, scoped, "reseller.update", resellerUpdate[1]);
    return json({ ok: true });
  }
  const keyRotation = path.match(/^\/resellers\/([^/]+)\/mailchannels-key$/);
  if (platform && keyRotation && method === "PUT") {
    check("resellers.manage");
    const body = await readJson<{ apiKey: string }>(request);
    const row = await env.DB.prepare(
      "SELECT mc_parent_key_ref FROM resellers WHERE id=?1",
    )
      .bind(keyRotation[1])
      .first<{ mc_parent_key_ref: string }>();
    if (!row) throw new HttpError(404, "Reseller not found");
    await new MailChannels(env, body.apiKey).listAccounts();
    const ref = await storeSecret(env, body.apiKey);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE resellers SET mc_parent_key_ref=?2 WHERE id=?1",
      ).bind(keyRotation[1], ref),
      env.DB.prepare("DELETE FROM secrets WHERE id=?1").bind(
        row.mc_parent_key_ref,
      ),
    ]);
    await audit(env, scoped, "reseller.rotate-key", keyRotation[1]);
    return json({ ok: true });
  }
  if (path === "/plans") {
    check(method === "GET" ? "usage.read" : "plans.write");
    if (method === "GET")
      return json({
        plans: (await env.DB.prepare("SELECT * FROM plans").all()).results,
      });
    if (platform && method === "POST") {
      const body = await readJson<{
        name: string;
        scopeType: string;
        monthlySends: number;
        contacts: number;
        rate: number;
      }>(request);
      if (
        !["reseller", "account"].includes(body.scopeType) ||
        ![body.monthlySends, body.contacts, body.rate].every(
          (v) => Number.isInteger(v) && v > 0,
        )
      )
        throw new HttpError(400, "Positive plan limits required");
      const planId = id("plan");
      await env.DB.prepare(
        "INSERT INTO plans(id,scope_type,monthly_sends,contacts,rate) VALUES (?1,?2,?3,?4,?5)",
      )
        .bind(
          planId,
          body.scopeType,
          body.monthlySends,
          body.contacts,
          body.rate,
        )
        .run();
      await audit(env, scoped, "plan.create", planId);
      return json({ id: planId }, { status: 201 });
    }
  }
  if (path === "/accounts") {
    check(method === "GET" ? "accounts.read" : "accounts.manage");
    if (method === "GET") {
      const query = platform
        ? env.DB.prepare(
            "SELECT id,reseller_id,name,status,plan_id,mc_handle,jurisdiction,created_at FROM accounts WHERE status<>'DELETED' ORDER BY created_at DESC LIMIT 500",
          )
        : env.DB.prepare(
            "SELECT id,reseller_id,name,status,plan_id,mc_handle,jurisdiction,created_at FROM accounts WHERE reseller_id=?1 AND status<>'DELETED' ORDER BY created_at DESC LIMIT 500",
          ).bind(scopeId);
      return json({ accounts: (await query.all()).results });
    }
    if (method === "POST") {
      const body = await readJson<{
        name: string;
        resellerId?: string;
        planId: string;
        jurisdiction?: string;
      }>(request);
      const resellerId = platform ? String(body.resellerId ?? "") : scopeId;
      const parent = await env.DB.prepare(
        "SELECT id FROM resellers WHERE id=?1 AND status='ACTIVE' AND mc_parent_key_ref IS NOT NULL",
      )
        .bind(resellerId)
        .first();
      if (!parent) throw new HttpError(400, "Link an active reseller first");
      const plan = await env.DB.prepare(
        "SELECT id FROM plans WHERE id=?1 AND scope_type='account'",
      )
        .bind(body.planId)
        .first();
      if (!plan) throw new HttpError(400, "Invalid account plan");
      if (body.jurisdiction && !["default", "eu"].includes(body.jurisdiction))
        throw new HttpError(400, "Invalid jurisdiction");
      const supplied = request.headers.get("idempotency-key");
      if (!supplied || supplied.length > 200)
        throw new HttpError(400, "Idempotency-Key header required");
      const accountName = safeName(body.name);
      if (accountName.length < 3)
        throw new HttpError(
          400,
          "Account name must contain at least three characters",
        );
      const idem = resellerId + ":" + supplied;
      const previous = await env.DB.prepare(
        "SELECT account_id FROM provisioning WHERE idempotency_key=?1",
      )
        .bind(idem)
        .first<{ account_id: string }>();
      if (previous) {
        await provision(env, previous.account_id);
        return json({ id: previous.account_id }, { status: 202 });
      }
      const accountId = id("acct");
      try {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO accounts(id,reseller_id,name,plan_id,jurisdiction,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
          ).bind(
            accountId,
            resellerId,
            accountName,
            body.planId,
            body.jurisdiction ?? "default",
            nowIso(),
          ),
          env.DB.prepare(
            "INSERT INTO provisioning(account_id,idempotency_key) VALUES (?1,?2)",
          ).bind(accountId, idem),
        ]);
      } catch (error) {
        const concurrent = await env.DB.prepare(
          "SELECT account_id FROM provisioning WHERE idempotency_key=?1",
        )
          .bind(idem)
          .first<{ account_id: string }>();
        if (concurrent)
          return json({ id: concurrent.account_id }, { status: 202 });
        throw error;
      }
      await audit(env, scoped, "account.create", accountId);
      await provision(env, accountId);
      return json(
        { id: accountId, records: await dnsRecords(env, accountId) },
        { status: 202 },
      );
    }
  }
  const accountPath = path.match(
    /^\/accounts\/([^/]+)(?:\/(suspend|resume|plan|usage|dns-records|verify|impersonate|sso|export|retry))?$/,
  );
  if (accountPath) {
    const accountId = accountPath[1];
    const action = accountPath[2];
    const account = await env.DB.prepare(
      "SELECT * FROM accounts WHERE id=?1 AND status<>'DELETED'",
    )
      .bind(accountId)
      .first<AccountRecord>();
    if (!account || (!platform && account.reseller_id !== scopeId))
      throw new HttpError(404, "Account not found");
    const permission =
      action === "impersonate"
        ? "impersonate"
        : action === "sso"
          ? "sso.mint"
          : action === "plan"
            ? "plans.write"
            : action === "usage"
              ? "usage.read"
              : method === "GET"
                ? "accounts.read"
                : "accounts.manage";
    check(permission);
    if (method === "GET" && !action)
      return json({
        account: {
          id: account.id,
          name: account.name,
          status: account.status,
          resellerId: account.reseller_id,
          jurisdiction: account.jurisdiction,
        },
      });
    if (action === "dns-records" && method === "GET")
      return json({ records: await dnsRecords(env, accountId) });
    if (action === "verify" && method === "POST") {
      await verifyTracking(env, accountId, true);
      await audit(env, scoped, "tracking.verify", accountId);
      return json({ records: await dnsRecords(env, accountId) });
    }
    if (action === "retry" && method === "POST") {
      await provision(env, accountId);
      await audit(env, scoped, "provision.retry", accountId);
      return json({ ok: true });
    }
    if (action === "usage" && method === "GET")
      return json({
        usage: (
          await env.DB.prepare(
            "SELECT * FROM usage_daily WHERE scope_type='account' AND scope_id=?1 ORDER BY day DESC LIMIT 366",
          )
            .bind(accountId)
            .all()
        ).results,
      });
    if (action === "impersonate" && method === "POST") {
      const body = await readJson<{ reason: string }>(request);
      const reason = safeName(body.reason, 500);
      const owner = await env.DB.prepare(
        "SELECT user_id FROM role_assignments WHERE scope_type='account' AND scope_id=?1 AND role='owner' LIMIT 1",
      )
        .bind(accountId)
        .first<{ user_id: string }>();
      if (!owner)
        throw new HttpError(
          409,
          "Account needs an owner before support access",
        );
      const token = await newSession(
        env,
        owner.user_id,
        p.hostname,
        "account",
        accountId,
        p.userId,
        reason,
      );
      await audit(
        env,
        { ...scoped, scopeType: "account", scopeId: accountId },
        "impersonation.start",
        accountId,
        { reason },
      );
      return json(
        { ok: true },
        { headers: { "set-cookie": sessionCookie(token, 3600) } },
      );
    }
    if (action === "sso" && method === "POST") {
      const body = await readJson<{ email: string }>(request);
      if (!env.SESSION_SECRET)
        throw new HttpError(503, "SSO is not configured");
      const host = await env.DB.prepare(
        "SELECT hostname FROM hostnames WHERE reseller_id=?1 AND status='ACTIVE' ORDER BY hostname LIMIT 1",
      )
        .bind(account.reseller_id)
        .first<{ hostname: string }>();
      if (!host) throw new HttpError(409, "Activate a hostname first");
      const token = await signToken(env.SESSION_SECRET, {
        purpose: "panel-sso",
        resellerId: account.reseller_id,
        accountId,
        email: body.email,
        host: host.hostname,
        exp: Date.now() + 60_000,
        nonce: id("nonce"),
      });
      await audit(env, scoped, "sso.mint", accountId);
      return json({
        url: `${publicOrigin(env, host.hostname)}/sso?token=${token}`,
        expiresIn: 60,
      });
    }
    if (
      (action === "suspend" || action === "resume" || action === "plan") &&
      method === "POST"
    ) {
      const resellerRow = await env.DB.prepare(
        "SELECT mc_parent_key_ref FROM resellers WHERE id=?1",
      )
        .bind(account.reseller_id)
        .first<{ mc_parent_key_ref: string }>();
      if (!resellerRow?.mc_parent_key_ref || !account.mc_handle)
        throw new HttpError(409, "Account is not provisioned");
      const parent = new MailChannels(
        env,
        await readSecret(env, resellerRow.mc_parent_key_ref),
      );
      if (action === "plan") {
        const body = await readJson<{ planId: string }>(request);
        const plan = await env.DB.prepare(
          "SELECT monthly_sends FROM plans WHERE id=?1 AND scope_type='account'",
        )
          .bind(body.planId)
          .first<{ monthly_sends: number }>();
        if (!plan) throw new HttpError(400, "Invalid plan");
        await parent.limit(account.mc_handle, plan.monthly_sends);
        await env.DB.prepare("UPDATE accounts SET plan_id=?2 WHERE id=?1")
          .bind(accountId, body.planId)
          .run();
      } else {
        if (action === "suspend") {
          await env.DB.prepare(
            "UPDATE accounts SET status='SUSPENDED' WHERE id=?1",
          )
            .bind(accountId)
            .run();
          await parent.suspend(account.mc_handle);
        } else {
          await parent.activate(account.mc_handle);
          await accountStub(env, account).fetch(
            "https://account.internal/internal/resume",
            { method: "POST", headers: { "x-account-id": account.id } },
          );
          await env.DB.prepare(
            "UPDATE accounts SET status='ACTIVE' WHERE id=?1",
          )
            .bind(accountId)
            .run();
        }
      }
      await emit(env, account.reseller_id, "account." + action, { accountId });
      await audit(env, scoped, "account." + action, accountId);
      return json({ ok: true });
    }
    if (action === "export" && method === "GET") {
      check("accounts.manage");
      return accountStub(env, account).fetch(
        "https://account.internal/internal/export",
        { headers: { "x-account-id": accountId } },
      );
    }
    if (!action && method === "DELETE") {
      await deleteAccount(env, account);
      await audit(env, scoped, "account.delete", accountId);
      return json({ ok: true });
    }
  }
  if (path === "/api-keys" && !platform) {
    check("keys.manage");
    if (method === "GET")
      return json({
        keys: (
          await env.DB.prepare(
            "SELECT id,scopes,last_used_at,revoked_at,created_at FROM api_keys WHERE reseller_id=?1",
          )
            .bind(scopeId)
            .all()
        ).results,
      });
    if (method === "POST") {
      const body = await readJson<{ scopes: string[] }>(request);
      const allowed = [
        "accounts.read",
        "accounts.manage",
        "usage.read",
        "plans.write",
        "sso.mint",
      ];
      if (
        !Array.isArray(body.scopes) ||
        !body.scopes.length ||
        body.scopes.some((s) => !allowed.includes(s))
      )
        throw new HttpError(400, "Invalid API scopes");
      const key = id("rk");
      const keyId = id("key");
      await env.DB.prepare(
        "INSERT INTO api_keys(id,reseller_id,key_hash,scopes,created_at) VALUES (?1,?2,?3,?4,?5)",
      )
        .bind(
          keyId,
          scopeId,
          await hash(key),
          JSON.stringify(body.scopes),
          nowIso(),
        )
        .run();
      await audit(env, scoped, "api-key.create", keyId);
      return json({ id: keyId, key }, { status: 201 });
    }
  }
  if (/^\/api-keys\/[^/]+$/.test(path) && !platform && method === "DELETE") {
    check("keys.manage");
    const keyId = path.split("/").at(-1)!;
    await env.DB.prepare(
      "UPDATE api_keys SET revoked_at=?3 WHERE id=?1 AND reseller_id=?2",
    )
      .bind(keyId, scopeId, nowIso())
      .run();
    await audit(env, scoped, "api-key.revoke", keyId);
    return json({ ok: true });
  }
  if (path === "/integration-secret" && !platform && method === "POST") {
    check("keys.manage");
    const body = await readJson<{ kind: string }>(request);
    if (!["sso", "webhook"].includes(body.kind))
      throw new HttpError(400, "Invalid secret kind");
    const secret = id("shared") + id("secret");
    const ref = await storeSecret(env, secret);
    const column =
      body.kind === "sso" ? "sso_secret_ref" : "webhook_secret_ref";
    await env.DB.prepare(`UPDATE resellers SET ${column}=?2 WHERE id=?1`)
      .bind(scopeId, ref)
      .run();
    await audit(env, scoped, "integration-secret.rotate", body.kind);
    return json({ secret });
  }
  if (path === "/settings" && !platform) {
    check("branding.write");
    if (method === "GET")
      return json(
        await env.DB.prepare(
          "SELECT name,tracking_pattern,webhook_url FROM resellers WHERE id=?1",
        )
          .bind(scopeId)
          .first(),
      );
    if (method === "PUT") {
      const body = await readJson<{
        trackingPattern?: string;
        webhookUrl?: string;
        systemEmailFrom?: string;
        systemEmailKey?: string;
      }>(request);
      if (
        body.trackingPattern &&
        (!body.trackingPattern.includes("{account}") ||
          body.trackingPattern.split("{account}").length !== 2)
      )
        throw new HttpError(400, "Pattern must contain one {account}");
      if (body.trackingPattern)
        hostname(body.trackingPattern.replace("{account}", "account"));
      if (body.webhookUrl) {
        const target = new URL(body.webhookUrl);
        if (target.protocol !== "https:")
          throw new HttpError(400, "HTTPS webhook required");
        hostname(target.hostname);
      }
      if (
        body.systemEmailFrom &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.systemEmailFrom)
      )
        throw new HttpError(400, "Invalid system sender");
      if (body.systemEmailKey) {
        const ref = await storeSecret(env, body.systemEmailKey);
        await env.DB.prepare(
          "UPDATE resellers SET system_email_key_ref=?2,system_email_from=?3 WHERE id=?1",
        )
          .bind(scopeId, ref, body.systemEmailFrom ?? null)
          .run();
      }
      await env.DB.prepare(
        "UPDATE resellers SET tracking_pattern=?2,webhook_url=?3 WHERE id=?1",
      )
        .bind(scopeId, body.trackingPattern ?? null, body.webhookUrl ?? null)
        .run();
      await audit(env, scoped, "reseller.settings", scopeId);
      return json({ ok: true });
    }
  }
  throw new HttpError(404, "Route not found");
}
export async function deleteAccount(
  env: Env,
  account: AccountRecord,
): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET status='DELETING' WHERE id=?1")
    .bind(account.id)
    .run();
  const barrier = await accountStub(env, account).fetch(
    "https://account.internal/internal/begin-delete",
    { method: "POST", headers: { "x-account-id": account.id } },
  );
  if (!barrier.ok) throw new Error("Could not quiesce account");
  if (account.mc_handle) {
    const reseller = await env.DB.prepare(
      "SELECT mc_parent_key_ref FROM resellers WHERE id=?1",
    )
      .bind(account.reseller_id)
      .first<{ mc_parent_key_ref: string }>();
    if (reseller?.mc_parent_key_ref) {
      try {
        await new MailChannels(
          env,
          await readSecret(env, reseller.mc_parent_key_ref),
        ).deleteAccount(account.mc_handle);
      } catch (error) {
        if (!(
          error instanceof HttpError &&
          "providerStatus" in error &&
          error.providerStatus === 404
        ))
          throw error;
      }
    }
  }
  let cursor: string | undefined;
  do {
    const objects = await env.CONTENT.list({
      prefix: `acct/${account.id}/`,
      cursor,
    });
    if (objects.objects.length)
      await env.CONTENT.delete(objects.objects.map((o) => o.key));
    cursor = objects.truncated ? objects.cursor : undefined;
  } while (cursor);
  const response = await accountStub(env, account).fetch(
    "https://account.internal/internal/delete",
    { method: "POST", headers: { "x-account-id": account.id } },
  );
  if (!response.ok) throw new Error("Account deletion failed");
  await env.DB.batch([
    ...["sender_domains", "tracking_domains", "provisioning"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table} WHERE account_id=?1`).bind(
        account.id,
      ),
    ),
    env.DB.prepare(
      "DELETE FROM sessions WHERE scope_type='account' AND scope_id=?1",
    ).bind(account.id),
    env.DB.prepare(
      "DELETE FROM role_assignments WHERE scope_type='account' AND scope_id=?1",
    ).bind(account.id),
    env.DB.prepare("DELETE FROM secrets WHERE id=?1").bind(account.mc_key_ref),
    env.DB.prepare(
      "UPDATE accounts SET status='DELETED',name='Deleted account',mc_handle=NULL,mc_key_ref=NULL,postal_address='' WHERE id=?1",
    ).bind(account.id),
  ]);
  await emit(env, account.reseller_id, "account.deleted", {
    accountId: account.id,
  });
}
