import type { Env } from "../types";
import { email, HttpError, id, json, nowIso, readJson } from "../utils";
import { audit, csrf, hash } from "./identity";
import { authorize, validRole, type Principal, type Scope } from "./rbac";
export async function newSession(
  env: Env,
  userId: string,
  hostname: string,
  scopeType: Scope,
  scopeId: string,
  actor?: string,
  reason?: string,
): Promise<string> {
  const token = id("session");
  await env.DB.prepare(
    "INSERT INTO sessions(id,user_id,hostname,scope_type,scope_id,actor_user_id,expires_at,reason,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
  )
    .bind(
      await hash(token),
      userId,
      hostname,
      scopeType,
      scopeId,
      actor ?? null,
      Date.now() + (actor ? 3600_000 : 86400_000),
      reason ?? null,
      nowIso(),
    )
    .run();
  await audit(
    env,
    {
      userId,
      email: "",
      hostname,
      resellerId: null,
      scopeType,
      scopeId,
      roles: [],
      actorUserId: actor,
    },
    "session.created",
    userId,
    { impersonation: Boolean(actor) },
  );
  return token;
}
export function sessionCookie(token: string, maxAge = 86400): string {
  return `__Host-session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export async function issueLogin(
  env: Env,
  userId: string,
  address: string,
  hostname: string,
  scope: Scope,
  scopeId: string,
  resellerId: string | null,
): Promise<void> {
  const token = id("login");
  await env.DB.prepare(
    "INSERT INTO login_tokens(token_hash,user_id,hostname,scope_type,scope_id,expires_at) VALUES (?1,?2,?3,?4,?5,?6)",
  )
    .bind(
      await hash(token),
      userId,
      hostname,
      scope,
      scopeId,
      Date.now() + 900_000,
    )
    .run();
  const theme = resellerId
    ? await env.DB.prepare(
        "SELECT tokens_json FROM themes WHERE reseller_id=?1",
      )
        .bind(resellerId)
        .first<{ tokens_json: string }>()
    : null;
  const product = theme
    ? (JSON.parse(theme.tokens_json).productName ?? "Email")
    : "Email";
  await env.DB.prepare(
    "INSERT INTO system_emails(id,reseller_id,recipient,subject,body,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
  )
    .bind(
      id("mail"),
      resellerId,
      address,
      `Sign in to ${product}`,
      `Sign in to ${product}: ${publicOrigin(env, hostname)}/login?token=${token}\nThis link expires in 15 minutes.`,
      nowIso(),
    )
    .run();
}
export async function authRoute(
  request: Request,
  env: Env,
  host: { hostname: string; resellerId: string | null },
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/api/auth/login" && request.method === "POST") {
    csrf(request);
    const body = await readJson<{
      email: string;
      scopeType?: Scope;
      scopeId?: string;
    }>(request);
    const address = email(body.email);
    const throttle = await hash(
      host.hostname +
        ":" +
        address +
        ":" +
        (request.headers.get("cf-connecting-ip") ?? "local"),
    );
    const window = Math.floor(Date.now() / 900_000);
    const row = await env.DB.prepare(
      "INSERT INTO auth_throttle(key,count,window) VALUES (?1,1,?2) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=?2 THEN count+1 ELSE 1 END,window=?2 RETURNING count",
    )
      .bind(throttle, window)
      .first<{ count: number }>();
    if ((row?.count ?? 0) > 5)
      throw new HttpError(429, "Please try again later");
    // Platform login always requires Access; magic links never grant platform sessions.
    if (host.resellerId) {
      const user = await env.DB.prepare(
        "SELECT id FROM users WHERE email=?1 AND status='ACTIVE'",
      )
        .bind(address)
        .first<{ id: string }>();
      if (user) {
        const roles = (
          await env.DB.prepare(
            `SELECT r.scope_type,r.scope_id FROM role_assignments r LEFT JOIN accounts a ON r.scope_type='account' AND a.id=r.scope_id
          WHERE r.user_id=?1 AND ((r.scope_type='reseller' AND r.scope_id=?2) OR a.reseller_id=?2)`,
          )
            .bind(user.id, host.resellerId)
            .all<{ scope_type: Scope; scope_id: string }>()
        ).results;
        const role = roles.find(
          (r) =>
            (!body.scopeId || r.scope_id === body.scopeId) &&
            (!body.scopeType || r.scope_type === body.scopeType),
        );
        if (role)
          await issueLogin(
            env,
            user.id,
            address,
            host.hostname,
            role.scope_type,
            role.scope_id,
            host.resellerId,
          );
      }
    }
    return json({
      ok: true,
      message: "If this address has access, a sign-in link has been sent.",
    });
  }
  if (path === "/api/auth/consume" && request.method === "POST") {
    csrf(request);
    const body = await readJson<{ token: string }>(request);
    const token = await env.DB.prepare(
      "UPDATE login_tokens SET used_at=?3 WHERE token_hash=?1 AND hostname=?2 AND used_at IS NULL AND expires_at>?3 RETURNING *",
    )
      .bind(await hash(String(body.token)), host.hostname, Date.now())
      .first<{ user_id: string; scope_type: Scope; scope_id: string }>();
    if (!token || !host.resellerId || token.scope_type === "platform")
      throw new HttpError(403, "Invalid or expired sign-in link");
    await env.DB.prepare("UPDATE users SET email_verified_at=?2 WHERE id=?1")
      .bind(token.user_id, nowIso())
      .run();
    const session = await newSession(
      env,
      token.user_id,
      host.hostname,
      token.scope_type,
      token.scope_id,
    );
    return json(
      { ok: true },
      { headers: { "set-cookie": sessionCookie(session) } },
    );
  }
  return null;
}
export async function identityRoute(
  request: Request,
  env: Env,
  p: Principal,
): Promise<Response | null> {
  let path = new URL(request.url).pathname;
  let delegated = false;
  const staffPath = path.match(
    /^\/api\/platform\/resellers\/([^/]+)\/(users(?:\/[^/]+(?:\/invite)?)?|audit)$/,
  );
  if (staffPath) {
    if (p.hostname !== env.PLATFORM_HOST)
      throw new HttpError(403, "Wrong console");
    authorize(p, "resellers.manage", "platform", "platform");
    const reseller = await env.DB.prepare(
      "SELECT id FROM resellers WHERE id=?1",
    )
      .bind(staffPath[1])
      .first();
    if (!reseller) throw new HttpError(404, "Reseller not found");
    p = {
      ...p,
      scopeType: "reseller",
      scopeId: staffPath[1],
      resellerId: staffPath[1],
    };
    path = "/api/" + staffPath[2];
    delegated = true;
  }
  if (
    path.startsWith("/api/reseller/users") ||
    path === "/api/reseller/audit"
  ) {
    p = { ...p, scopeType: "reseller", scopeId: p.resellerId ?? "" };
    path = path.replace("/api/reseller/", "/api/");
  }
  if (path === "/api/me" && request.method === "GET")
    return json({
      email: p.email,
      scopeType: p.scopeType,
      scopeId: p.scopeId,
      roles: p.roles,
      impersonating: Boolean(p.actorUserId),
      reason: p.reason,
    });
  if (path === "/api/auth/logout" && request.method === "POST") {
    if (p.sessionId)
      await env.DB.prepare("DELETE FROM sessions WHERE id=?1")
        .bind(p.sessionId)
        .run();
    await audit(env, p, "logout", p.userId);
    return json(
      { ok: true },
      { headers: { "set-cookie": sessionCookie("", 0) } },
    );
  }
  if (path === "/api/auth/revoke" && request.method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?1")
      .bind(p.userId)
      .run();
    await audit(env, p, "sessions.revoke", p.userId);
    return json(
      { ok: true },
      { headers: { "set-cookie": sessionCookie("", 0) } },
    );
  }
  const invitation = path.match(/^\/api\/users\/([^/]+)\/invite$/);
  if (invitation && request.method === "POST") {
    if (!delegated) authorize(p, "users.manage");
    const user = await env.DB.prepare(
      "SELECT u.id,u.email FROM users u JOIN role_assignments r ON r.user_id=u.id WHERE u.id=?1 AND r.scope_type=?2 AND r.scope_id=?3",
    )
      .bind(invitation[1], p.scopeType, p.scopeId)
      .first<{ id: string; email: string }>();
    if (!user) throw new HttpError(404, "User not found");
    const host = await env.DB.prepare(
      "SELECT hostname FROM hostnames WHERE reseller_id=?1 AND status='ACTIVE' ORDER BY hostname LIMIT 1",
    )
      .bind(p.resellerId)
      .first<{ hostname: string }>();
    if (!host) throw new HttpError(409, "Activate a reseller hostname first");
    await issueLogin(
      env,
      user.id,
      user.email,
      host.hostname,
      p.scopeType,
      p.scopeId,
      p.resellerId,
    );
    await audit(env, p, "users.reinvite", user.id);
    return json({ ok: true });
  }
  if (path === "/api/users" || /^\/api\/users\/[^/]+$/.test(path)) {
    if (!delegated) authorize(p, "users.manage");
    if (request.method === "GET" && path === "/api/users")
      return json({
        users: (
          await env.DB.prepare(
            "SELECT u.id,u.email,r.role FROM users u JOIN role_assignments r ON r.user_id=u.id WHERE r.scope_type=?1 AND r.scope_id=?2",
          )
            .bind(p.scopeType, p.scopeId)
            .all()
        ).results,
      });
    if (request.method === "POST" && path === "/api/users") {
      const body = await readJson<{ email: string; role: string }>(request);
      const address = email(body.email);
      if (!validRole(p.scopeType, body.role))
        throw new HttpError(400, "Invalid role");
      if (
        body.role === "owner" &&
        !delegated &&
        !p.roles.some(
          (r) =>
            r.scope_type === p.scopeType &&
            r.scope_id === p.scopeId &&
            r.role === "owner",
        )
      )
        throw new HttpError(403, "Only owners may appoint owners");
      await env.DB.prepare(
        "INSERT OR IGNORE INTO users(id,email,created_at) VALUES (?1,?2,?3)",
      )
        .bind(id("user"), address, nowIso())
        .run();
      const user = await env.DB.prepare("SELECT id FROM users WHERE email=?1")
        .bind(address)
        .first<{ id: string }>();
      const prior = await env.DB.prepare(
        "SELECT role FROM role_assignments WHERE user_id=?1 AND scope_type=?2 AND scope_id=?3",
      )
        .bind(user!.id, p.scopeType, p.scopeId)
        .first<{ role: string }>();
      if (prior?.role === "owner")
        throw new HttpError(
          409,
          "Owner role changes require ownership transfer",
        );
      await env.DB.prepare(
        "INSERT INTO role_assignments VALUES (?1,?2,?3,?4) ON CONFLICT(user_id,scope_type,scope_id) DO UPDATE SET role=excluded.role",
      )
        .bind(user!.id, p.scopeType, p.scopeId, body.role)
        .run();
      const inviteHost = delegated
        ? await env.DB.prepare(
            "SELECT hostname FROM hostnames WHERE reseller_id=?1 AND status='ACTIVE' ORDER BY hostname LIMIT 1",
          )
            .bind(p.resellerId)
            .first<{ hostname: string }>()
        : { hostname: p.hostname };
      if (inviteHost && p.scopeType !== "platform")
        await issueLogin(
          env,
          user!.id,
          address,
          inviteHost.hostname,
          p.scopeType,
          p.scopeId,
          p.resellerId,
        );
      await audit(env, p, "users.invite", user!.id, { role: body.role });
      return json({ ok: true }, { status: 201 });
    }
    if (request.method === "DELETE" && path !== "/api/users") {
      const target = path.split("/").at(-1)!;
      if (target === p.userId)
        throw new HttpError(409, "Cannot remove your own access");
      const role = await env.DB.prepare(
        "SELECT role FROM role_assignments WHERE user_id=?1 AND scope_type=?2 AND scope_id=?3",
      )
        .bind(target, p.scopeType, p.scopeId)
        .first<{ role: string }>();
      if (role?.role === "owner")
        throw new HttpError(409, "Transfer ownership before removing an owner");
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM role_assignments WHERE user_id=?1 AND scope_type=?2 AND scope_id=?3",
        ).bind(target, p.scopeType, p.scopeId),
        env.DB.prepare(
          "DELETE FROM sessions WHERE user_id=?1 AND scope_type=?2 AND scope_id=?3",
        ).bind(target, p.scopeType, p.scopeId),
      ]);
      await audit(env, p, "users.remove", target);
      return json({ ok: true });
    }
    throw new HttpError(405, "Method not allowed");
  }
  if (path === "/api/audit" && request.method === "GET") {
    if (!delegated) authorize(p, "users.manage");
    return json({
      audit: (
        await env.DB.prepare(
          "SELECT * FROM audit_log WHERE scope_type=?1 AND scope_id=?2 ORDER BY at DESC LIMIT 200",
        )
          .bind(p.scopeType, p.scopeId)
          .all()
      ).results,
    });
  }
  return null;
}

export function publicOrigin(
  env: Pick<Env, "LOCAL_TEST" | "LOCAL_PORT">,
  hostname: string,
): string {
  return env.LOCAL_TEST === "true" && env.LOCAL_PORT
    ? `http://${hostname}:${env.LOCAL_PORT}`
    : `https://${hostname}`;
}
