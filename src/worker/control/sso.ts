import type { Env } from "../types";
import { email, HttpError, id, json, nowIso, readJson } from "../utils";
import { hash, audit, csrf } from "./identity";
import { readSecret, verifyToken } from "./crypto";
import { newSession, sessionCookie } from "./sessions";
import type { Principal } from "./rbac";
export async function apiPrincipal(
  request: Request,
  env: Env,
  host: { hostname: string; resellerId: string | null },
): Promise<Principal> {
  const key = request.headers
    .get("authorization")
    ?.match(/^Bearer (\S+)$/)?.[1];
  if (!key || !host.resellerId) throw new HttpError(401, "API key required");
  const row = await env.DB.prepare(
    "SELECT id,reseller_id,scopes FROM api_keys WHERE key_hash=?1 AND revoked_at IS NULL AND reseller_id=?2",
  )
    .bind(await hash(key), host.resellerId)
    .first<{ id: string; reseller_id: string; scopes: string }>();
  if (!row) throw new HttpError(401, "Invalid API key");
  await env.DB.prepare("UPDATE api_keys SET last_used_at=?2 WHERE id=?1")
    .bind(row.id, nowIso())
    .run();
  return {
    userId: row.id,
    email: "",
    ...host,
    scopeType: "reseller",
    scopeId: row.reseller_id,
    roles: [],
    apiScopes: JSON.parse(row.scopes),
  };
}
export async function ssoRoute(
  request: Request,
  env: Env,
  host: { hostname: string; resellerId: string | null },
): Promise<Response | null> {
  if (
    new URL(request.url).pathname !== "/api/auth/sso" ||
    request.method !== "POST"
  )
    return null;
  csrf(request);
  const body = await readJson<{ token: string; issuer?: string }>(request);
  if (!host.resellerId) throw new HttpError(403, "Customer hostname required");
  let secret = env.SESSION_SECRET;
  if (body.issuer === "reseller") {
    const row = await env.DB.prepare(
      "SELECT sso_secret_ref FROM resellers WHERE id=?1",
    )
      .bind(host.resellerId)
      .first<{ sso_secret_ref: string }>();
    if (!row?.sso_secret_ref)
      throw new HttpError(403, "Panel SSO is not configured");
    secret = await readSecret(env, row.sso_secret_ref);
  }
  if (!secret) throw new HttpError(503, "SSO unavailable");
  const token = await verifyToken<{
    purpose: string;
    resellerId: string;
    accountId: string;
    email: string;
    host: string;
    exp: number;
    nonce: string;
  }>(secret, body.token);
  if (
    token.purpose !== "panel-sso" ||
    token.resellerId !== host.resellerId ||
    token.host !== host.hostname ||
    !Number.isFinite(token.exp) ||
    token.exp < Date.now() ||
    token.exp > Date.now() + 120_000 ||
    !token.nonce
  )
    throw new HttpError(403, "Invalid or expired SSO token");
  const account = await env.DB.prepare(
    "SELECT id FROM accounts WHERE id=?1 AND reseller_id=?2 AND status='ACTIVE'",
  )
    .bind(token.accountId, host.resellerId)
    .first();
  if (!account) throw new HttpError(403, "Account unavailable");
  const consumed = await env.DB.prepare(
    "INSERT OR IGNORE INTO sso_nonces(nonce,expires_at) VALUES (?1,?2)",
  )
    .bind(token.nonce, token.exp)
    .run();
  if (!consumed.meta.changes)
    throw new HttpError(403, "SSO token already used");
  const address = email(token.email);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users(id,email,created_at) VALUES (?1,?2,?3)",
  )
    .bind(id("user"), address, nowIso())
    .run();
  const user = await env.DB.prepare(
    "SELECT id FROM users WHERE email=?1 AND status='ACTIVE'",
  )
    .bind(address)
    .first<{ id: string }>();
  if (!user) throw new HttpError(403, "User unavailable");
  // First panel user owns a newly provisioned account; later new users enter as marketers.
  const owner = await env.DB.prepare(
    "SELECT user_id FROM role_assignments WHERE scope_type='account' AND scope_id=?1 AND role='owner'",
  )
    .bind(token.accountId)
    .first();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO role_assignments VALUES (?1,'account',?2,?3)",
  )
    .bind(user.id, token.accountId, owner ? "marketer" : "owner")
    .run();
  await env.DB.prepare("UPDATE users SET email_verified_at=?2 WHERE id=?1")
    .bind(user.id, nowIso())
    .run();
  const session = await newSession(
    env,
    user.id,
    host.hostname,
    "account",
    token.accountId,
  );
  await audit(
    env,
    {
      userId: user.id,
      email: address,
      ...host,
      scopeType: "account",
      scopeId: token.accountId,
      roles: [],
    },
    "sso.login",
    token.accountId,
  );
  return json(
    { ok: true },
    { headers: { "set-cookie": sessionCookie(session) } },
  );
}
