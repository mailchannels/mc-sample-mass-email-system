import { createRemoteJWKSet, jwtVerify, customFetch } from "jose";
import type { Env } from "../types";
import { base64FromBytes, HttpError, id, json, readJson } from "../utils";
import { audit, hash } from "./identity";
import { authorize, type Principal } from "./rbac";
import { readSecret, seal, storeSecret, unseal } from "./crypto";
import { newSession, sessionCookie } from "./sessions";
interface OidcConfig {
  issuer: string;
  clientId: string;
  secretRef: string;
}
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
function secureUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new HttpError(400, "OIDC endpoints must use HTTPS");
  return url;
}
async function discover(env: Env, issuer: string): Promise<Discovery> {
  secureUrl(issuer);
  const fetcher =
    env.LOCAL_TEST === "true" && env.PROVIDER
      ? env.PROVIDER.fetch.bind(env.PROVIDER)
      : fetch;
  const response = await fetcher(
    issuer.replace(/\/$/, "") + "/.well-known/openid-configuration",
    { redirect: "manual" },
  );
  if (!response.ok) throw new HttpError(502, "Identity provider unavailable");
  const data = await response.json<Discovery>();
  if (data.issuer !== issuer)
    throw new HttpError(400, "Identity provider issuer mismatch");
  [data.authorization_endpoint, data.token_endpoint, data.jwks_uri].forEach(
    secureUrl,
  );
  return data;
}
export async function oidcSettings(
  request: Request,
  env: Env,
  p: Principal,
): Promise<Response | null> {
  if (
    new URL(request.url).pathname !== "/api/reseller/oidc" ||
    request.method !== "PUT"
  )
    return null;
  authorize(p, "keys.manage", "reseller", p.resellerId ?? "");
  const body = await readJson<{
    issuer: string;
    clientId: string;
    clientSecret: string;
  }>(request);
  await discover(env, body.issuer);
  if (!body.clientId || !body.clientSecret)
    throw new HttpError(400, "Client credentials required");
  const secretRef = await storeSecret(env, body.clientSecret);
  await env.DB.prepare("UPDATE resellers SET oidc_json=?2 WHERE id=?1")
    .bind(
      p.resellerId,
      JSON.stringify({
        issuer: body.issuer,
        clientId: body.clientId,
        secretRef,
      }),
    )
    .run();
  await audit(env, p, "oidc.configure", p.resellerId!);
  return json({ ok: true });
}
export async function oidcRoute(
  request: Request,
  env: Env,
  host: { hostname: string; resellerId: string | null },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    !["/api/auth/oidc/start", "/api/auth/oidc/callback"].includes(url.pathname)
  )
    return null;
  if (!host.resellerId || request.method !== "GET")
    throw new HttpError(404, "Route not found");
  const row = await env.DB.prepare(
    "SELECT oidc_json FROM resellers WHERE id=?1",
  )
    .bind(host.resellerId)
    .first<{ oidc_json: string }>();
  if (!row?.oidc_json)
    throw new HttpError(404, "Single sign-on is not configured");
  const config = JSON.parse(row.oidc_json) as OidcConfig;
  const discovery = await discover(env, config.issuer);
  const redirect = `https://${host.hostname}/api/auth/oidc/callback`;
  if (url.pathname.endsWith("/start")) {
    const state = id("state"),
      nonce = id("nonce"),
      verifier = id("pkce") + id("pkce");
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    await env.DB.prepare(
      "INSERT INTO oidc_states(state_hash,hostname,reseller_id,verifier,nonce,expires_at) VALUES (?1,?2,?3,?4,?5,?6)",
    )
      .bind(
        await hash(state),
        host.hostname,
        host.resellerId,
        await seal(env, verifier),
        nonce,
        Date.now() + 600_000,
      )
      .run();
    const target = new URL(discovery.authorization_endpoint);
    Object.entries({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: redirect,
      scope: "openid email",
      state,
      nonce,
      code_challenge: base64FromBytes(digest)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, ""),
      code_challenge_method: "S256",
    }).forEach(([k, v]) => target.searchParams.set(k, v));
    return new Response(null, {
      status: 302,
      headers: {
        location: target.toString(),
        "set-cookie": `__Host-oidc=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    });
  }
  const state = url.searchParams.get("state") ?? "";
  const cookie = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)__Host-oidc=([^;]+)/)?.[1];
  if (!state || cookie !== state)
    throw new HttpError(403, "Invalid sign-in state");
  const pending = await env.DB.prepare(
    "DELETE FROM oidc_states WHERE state_hash=?1 AND hostname=?2 AND reseller_id=?3 AND expires_at>?4 RETURNING verifier,nonce",
  )
    .bind(await hash(state), host.hostname, host.resellerId, Date.now())
    .first<{ verifier: string; nonce: string }>();
  if (!pending) throw new HttpError(403, "Expired sign-in state");
  const fetcher =
    env.LOCAL_TEST === "true" && env.PROVIDER
      ? env.PROVIDER.fetch.bind(env.PROVIDER)
      : fetch;
  const tokenResponse = await fetcher(discovery.token_endpoint, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: url.searchParams.get("code") ?? "",
      redirect_uri: redirect,
      client_id: config.clientId,
      client_secret: await readSecret(env, config.secretRef),
      code_verifier: await unseal(env, pending.verifier),
    }),
  });
  if (!tokenResponse.ok)
    throw new HttpError(403, "Identity provider rejected sign-in");
  const tokens = await tokenResponse.json<{ id_token: string }>();
  let claims;
  try {
    claims = (
      await jwtVerify(
        tokens.id_token,
        createRemoteJWKSet(
          new URL(discovery.jwks_uri),
          env.LOCAL_TEST === "true" && env.PROVIDER
            ? {
                [customFetch]: (url, options) =>
                  env.PROVIDER!.fetch(url, options),
              }
            : {},
        ),
        {
          issuer: config.issuer,
          audience: config.clientId,
          algorithms: ["RS256", "ES256"],
          requiredClaims: ["exp", "iat", "sub", "nonce", "email"],
        },
      )
    ).payload;
  } catch {
    throw new HttpError(403, "Invalid identity token");
  }
  if (
    claims.nonce !== pending.nonce ||
    claims.email_verified !== true ||
    typeof claims.email !== "string"
  )
    throw new HttpError(403, "Verified identity required");
  const user = await env.DB.prepare(
    "SELECT u.id FROM users u JOIN role_assignments r ON r.user_id=u.id WHERE u.email=?1 AND u.status='ACTIVE' AND r.scope_type='reseller' AND r.scope_id=?2",
  )
    .bind(claims.email.toLowerCase(), host.resellerId)
    .first<{ id: string }>();
  if (!user) throw new HttpError(403, "Reseller invitation required");
  const token = await newSession(
    env,
    user.id,
    host.hostname,
    "reseller",
    host.resellerId,
  );
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": sessionCookie(token) },
  });
}
