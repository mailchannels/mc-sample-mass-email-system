import type { Env } from "./types";
import { HttpError } from "./utils";

interface AccessClaims {
  aud: string | string[];
  email: string;
  exp: number;
  iat?: number;
  iss?: string;
}

type AccessJwk = JsonWebKey & { kid?: string };
interface JwkSet { keys: AccessJwk[] }

const keyCache = new Map<string, { expires: number; keys: AccessJwk[] }>();

export async function requireUser(request: Request, env: Env): Promise<string> {
  if (env.AUTH_MODE === "development") {
    return request.headers.get("x-dev-user-email")?.toLowerCase() || "developer@local.test";
  }
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    throw new HttpError(500, "Cloudflare Access is not configured");
  }
  const token = request.headers.get("cf-access-jwt-assertion") || cookie(request, "CF_Authorization");
  if (!token) throw new HttpError(401, "Cloudflare Access authentication is required");

  const segments = token.split(".");
  if (segments.length !== 3) throw new HttpError(401, "Invalid Access token");
  const header = decodeJwtPart<{ kid?: string; alg?: string }>(segments[0]);
  const claims = decodeJwtPart<AccessClaims>(segments[1]);
  if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "Unsupported Access token");
  const keys = await accessKeys(env.CF_ACCESS_TEAM_DOMAIN);
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new HttpError(401, "Unknown Access signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    asArrayBuffer(base64UrlBytes(segments[2])),
    asArrayBuffer(new TextEncoder().encode(`${segments[0]}.${segments[1]}`)),
  );
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!valid || claims.exp <= now || !audiences.includes(env.CF_ACCESS_AUD) || !claims.email) {
    throw new HttpError(401, "Expired or invalid Access token");
  }
  const user = claims.email.toLowerCase();
  if (env.ALLOWED_EMAIL_DOMAIN && env.ALLOWED_EMAIL_DOMAIN !== "*" && !user.endsWith(`@${env.ALLOWED_EMAIL_DOMAIN.toLowerCase()}`)) {
    throw new HttpError(403, "Your email domain is not allowed");
  }
  return user;
}

async function accessKeys(teamDomain: string): Promise<AccessJwk[]> {
  const host = teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const cached = keyCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.keys;
  const response = await fetch(`https://${host}/cdn-cgi/access/certs`);
  if (!response.ok) throw new HttpError(503, "Could not retrieve Cloudflare Access signing keys");
  const value = await response.json<JwkSet>();
  keyCache.set(host, { expires: Date.now() + 60 * 60 * 1000, keys: value.keys });
  return value.keys;
}

function decodeJwtPart<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlBytes(part))) as T;
  } catch {
    throw new HttpError(401, "Invalid Access token encoding");
  }
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function cookie(request: Request, name: string): string | undefined {
  const match = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}
