import type { AccountRecord, Env } from "../types";
import { HttpError, json } from "../utils";
import { verifyToken } from "./crypto";
import { accountStub } from "../account/routing";
export async function unsubscribe(
  request: Request,
  env: Env,
  resellerId: string | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/unsubscribe") return null;
  if (!env.SESSION_SECRET) throw new HttpError(503, "Signing key unavailable");
  const token = url.searchParams.get("token") ?? "";
  const payload = await verifyToken<{
    accountId: string;
    email: string;
    host: string;
    purpose: string;
  }>(env.SESSION_SECRET, token);
  if (payload.purpose !== "unsubscribe" || payload.host !== url.hostname)
    throw new HttpError(403, "Invalid unsubscribe link");
  const account = await env.DB.prepare(
    "SELECT * FROM accounts WHERE id=?1 AND reseller_id=?2 AND status<>'DELETED'",
  )
    .bind(payload.accountId, resellerId)
    .first<AccountRecord>();
  if (!account) throw new HttpError(404, "Account not found");
  if (request.method === "POST") {
    const response = await accountStub(env, account).fetch(
      "https://account.internal/internal/unsubscribe",
      {
        method: "POST",
        headers: { "x-account-id": account.id },
        body: JSON.stringify({ email: payload.email }),
      },
    );
    if (!response.ok) throw new HttpError(503, "Please try again");
    return new Response(
      "<!doctype html><html><head><title>Unsubscribed</title></head><body><h1>You have been unsubscribed</h1><p>You will no longer receive marketing email from this sender.</p></body></html>",
      { headers: { "content-type": "text/html" } },
    );
  }
  if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
  return new Response(
    '<!doctype html><html><head><title>Unsubscribe</title></head><body><h1>Unsubscribe</h1><p>Stop marketing email from this sender.</p><form method="post"><button type="submit">Unsubscribe</button></form></body></html>',
    { headers: { "content-type": "text/html" } },
  );
}
