import type { Env } from "../types";
import { requireUser } from "../auth";
import { HttpError, id, nowIso } from "../utils";
import type { Principal, RoleAssignment, Scope } from "./rbac";
export async function resolveHost(
  request: Request,
  env: Env,
): Promise<{ hostname: string; resellerId: string | null }> {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hostname === env.PLATFORM_HOST)
    await env.DB.prepare(
      "INSERT OR IGNORE INTO hostnames(hostname,reseller_id,status) VALUES (?1,NULL,'ACTIVE')",
    )
      .bind(hostname)
      .run();
  const host = await env.DB.prepare(
    "SELECT reseller_id FROM hostnames WHERE hostname = ?1 AND status = 'ACTIVE'",
  )
    .bind(hostname)
    .first<{ reseller_id: string | null }>();
  if (!host) throw new HttpError(404, "Unknown hostname");
  if (!host.reseller_id && hostname !== env.PLATFORM_HOST)
    throw new HttpError(404, "Unknown hostname");
  return { hostname, resellerId: host.reseller_id };
}
export async function principal(
  request: Request,
  env: Env,
  host: { hostname: string; resellerId: string | null },
): Promise<Principal> {
  const platformEmail =
    host.hostname === env.PLATFORM_HOST
      ? await requireUser(request, env)
      : null;
  const token = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)__Host-session=([^;]+)/)?.[1];
  let session: {
    id: string;
    user_id: string;
    scope_type: Scope;
    scope_id: string;
    actor_user_id: string | null;
    reason: string | null;
  } | null = null;
  if (token)
    session = await env.DB.prepare(
      "SELECT * FROM sessions WHERE id = ?1 AND hostname = ?2 AND expires_at > ?3",
    )
      .bind(await hash(token), host.hostname, Date.now())
      .first();
  let user: { id: string; email: string } | null;
  if (session)
    user = await env.DB.prepare(
      "SELECT id,email FROM users WHERE id = ?1 AND status = 'ACTIVE'",
    )
      .bind(session.user_id)
      .first();
  else if (
    host.hostname === env.PLATFORM_HOST ||
    (env.AUTH_MODE === "development" && env.LOCAL_TEST === "true")
  ) {
    const email = platformEmail ?? (await requireUser(request, env));
    user = await env.DB.prepare(
      "SELECT id,email FROM users WHERE email = ?1 AND status = 'ACTIVE'",
    )
      .bind(email)
      .first();
  } else throw new HttpError(401, "Sign in required");
  if (
    platformEmail &&
    platformEmail === env.BOOTSTRAP_OWNER_EMAIL?.toLowerCase()
  ) {
    const owner = await env.DB.prepare(
      "SELECT user_id FROM role_assignments WHERE scope_type='platform' AND scope_id='platform' AND role='owner'",
    ).first();
    if (!owner) {
      const userId = id("user");
      await env.DB.prepare(
        "INSERT OR IGNORE INTO users(id,email,email_verified_at,created_at) VALUES (?1,?2,?3,?3)",
      )
        .bind(userId, platformEmail, nowIso())
        .run();
      user = await env.DB.prepare(
        "SELECT id,email FROM users WHERE email=?1 AND status='ACTIVE'",
      )
        .bind(platformEmail)
        .first();
      if (user)
        await env.DB.prepare(
          "INSERT OR IGNORE INTO role_assignments SELECT ?1,'platform','platform','owner' WHERE NOT EXISTS(SELECT 1 FROM role_assignments WHERE scope_type='platform' AND role='owner')",
        )
          .bind(user.id)
          .run();
    }
  }
  if (!user) throw new HttpError(401, "Sign in required");
  if (session?.actor_user_id) {
    const actor = await env.DB.prepare(
      "SELECT id,email FROM users WHERE id=?1 AND status='ACTIVE'",
    )
      .bind(session.actor_user_id)
      .first<{ id: string; email: string }>();
    if (!actor || (platformEmail && actor.email !== platformEmail))
      throw new HttpError(403, "Support access revoked");
    const assignments = (
      await env.DB.prepare(
        "SELECT scope_type,scope_id,role FROM role_assignments WHERE user_id=?1",
      )
        .bind(actor.id)
        .all<RoleAssignment>()
    ).results;
    const allowed = assignments.some(
      (r) =>
        ["owner", "support"].includes(r.role) &&
        ((r.scope_type === "platform" && !host.resellerId) ||
          (r.scope_type === "reseller" && r.scope_id === host.resellerId)),
    );
    if (!allowed) throw new HttpError(403, "Support access revoked");
  } else if (platformEmail && user.email !== platformEmail)
    throw new HttpError(403, "Platform identity mismatch");
  const roles = (
    await env.DB.prepare(
      "SELECT scope_type,scope_id,role FROM role_assignments WHERE user_id = ?1",
    )
      .bind(user.id)
      .all<RoleAssignment>()
  ).results;
  const requestedScope =
    session?.scope_type ?? (host.resellerId ? "account" : "platform");
  let scopeId = session?.scope_id;
  if (!scopeId) {
    const requested =
      env.LOCAL_TEST === "true"
        ? request.headers.get("x-dev-account-id")
        : null;
    if (requested) scopeId = requested;
    else if (requestedScope === "platform") scopeId = "platform";
    else {
      const ids = (
        await env.DB.prepare("SELECT id FROM accounts WHERE reseller_id = ?1")
          .bind(host.resellerId)
          .all<{ id: string }>()
      ).results;
      scopeId = roles.find(
        (r) =>
          r.scope_type === "account" && ids.some((a) => a.id === r.scope_id),
      )?.scope_id;
    }
  }
  if (!scopeId) {
    if (
      roles.some(
        (r) => r.scope_type === "reseller" && r.scope_id === host.resellerId,
      )
    )
      return {
        userId: user.id,
        email: user.email,
        ...host,
        scopeType: "reseller",
        scopeId: host.resellerId!,
        roles,
      };
    throw new HttpError(403, "No account access");
  }
  if (requestedScope === "account") {
    const account = await env.DB.prepare(
      "SELECT reseller_id FROM accounts WHERE id = ?1 AND status <> 'DELETED'",
    )
      .bind(scopeId)
      .first<{ reseller_id: string }>();
    if (
      !account ||
      (host.resellerId !== account.reseller_id &&
        !(session?.actor_user_id && !host.resellerId))
    )
      throw new HttpError(403, "No account access");
  }
  if (requestedScope === "reseller" && scopeId !== host.resellerId)
    throw new HttpError(403, "No reseller access");
  return {
    userId: user.id,
    email: user.email,
    ...host,
    scopeType: requestedScope,
    scopeId,
    roles,
    sessionId: session?.id,
    actorUserId: session?.actor_user_id ?? undefined,
    reason: session?.reason ?? undefined,
  };
}
export function csrf(request: Request): void {
  if (
    ["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    new URL(request.url).pathname !== "/api/generate-upload-url"
  )
    return;
  if (
    request.method === "GET" &&
    request.headers.get("sec-fetch-site") === "same-origin"
  )
    return;
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin)
    throw new HttpError(403, "Same-origin request required");
}
export async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function audit(
  env: Env,
  p: Principal,
  action: string,
  target: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log(id,at,actor_user_id,impersonating,scope_type,scope_id,action,target,detail_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
  )
    .bind(
      id("audit"),
      nowIso(),
      p.actorUserId ?? p.userId,
      p.actorUserId ? p.userId : null,
      p.scopeType,
      p.scopeId,
      action,
      target,
      JSON.stringify(detail),
    )
    .run();
}
