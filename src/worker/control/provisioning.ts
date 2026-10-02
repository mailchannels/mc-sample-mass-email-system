import type { AccountRecord, Env } from "../types";
import { HttpError, id, nowIso } from "../utils";
import { MailChannels, ProviderError } from "../mailchannels/client";
import { readSecret, storeSecret } from "./crypto";
export async function emit(
  env: Env,
  resellerId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO outbound_events(id,reseller_id,type,payload_json) VALUES (?1,?2,?3,?4)",
  )
    .bind(id("event"), resellerId, type, JSON.stringify(payload))
    .run();
}
export async function provision(env: Env, accountId: string): Promise<void> {
  // Lease prevents simultaneous retries from issuing duplicate one-time credentials.
  const lease = await env.DB.prepare(
    "UPDATE provisioning SET next_attempt=?2 WHERE account_id=?1 AND step<>'DONE' AND next_attempt<=?3 RETURNING step",
  )
    .bind(accountId, Date.now() + 120_000, Date.now())
    .first<{ step: string }>();
  if (!lease) return;
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id=?1")
    .bind(accountId)
    .first<AccountRecord>();
  if (!account) return;
  const reseller = await env.DB.prepare(
    "SELECT mc_parent_key_ref,tracking_pattern FROM resellers WHERE id=?1",
  )
    .bind(account.reseller_id)
    .first<{ mc_parent_key_ref: string; tracking_pattern: string | null }>();
  if (!reseller?.mc_parent_key_ref)
    throw new HttpError(
      409,
      "Reseller must link an email provider account first",
    );
  const parent = new MailChannels(
    env,
    await readSecret(env, reseller.mc_parent_key_ref),
  );
  const handle = account.mc_handle ?? accountId.replace(/[^a-z0-9]/g, "");
  const advance = async (step: string) =>
    env.DB.prepare(
      "UPDATE provisioning SET step=?2,error=NULL WHERE account_id=?1",
    )
      .bind(accountId, step)
      .run();
  try {
    if (!account.mc_handle) {
      try {
        await parent.createAccount(handle, account.name);
      } catch (error) {
        if (!(error instanceof ProviderError && error.providerStatus === 409))
          throw error;
        await parent.getAccount(handle);
      }
      await env.DB.prepare("UPDATE accounts SET mc_handle=?2 WHERE id=?1")
        .bind(accountId, handle)
        .run();
      await advance("KEY");
    }
    let keyRef = account.mc_key_ref;
    if (!keyRef) {
      const key = await parent.createKey(handle);
      try {
        keyRef = await storeSecret(env, key.data.key);
        await env.DB.prepare("UPDATE accounts SET mc_key_ref=?2 WHERE id=?1")
          .bind(accountId, keyRef)
          .run();
      } catch (error) {
        await parent.deleteKey(handle, key.data.id);
        throw error;
      }
      await advance("WEBHOOK");
    }
    const child = new MailChannels(env, await readSecret(env, keyRef));
    if (!env.PLATFORM_HOST)
      throw new HttpError(503, "Platform hostname required");
    await child.webhook(`https://${env.PLATFORM_HOST}/webhooks/mailchannels`);
    await advance("LIMIT");
    const plan = await env.DB.prepare(
      "SELECT p.monthly_sends FROM plans p JOIN accounts a ON a.plan_id=p.id WHERE a.id=?1",
    )
      .bind(accountId)
      .first<{ monthly_sends: number }>();
    await parent.limit(handle, plan?.monthly_sends ?? 1000);
    await parent.activate(handle);
    await advance("TRACKING");
    if (reseller.tracking_pattern) {
      const hostname = reseller.tracking_pattern.replace(
        "{account}",
        accountId.replaceAll("_", "-"),
      );
      for (const scope of ["click", "open"]) {
        const existing = await env.DB.prepare(
          "SELECT id FROM tracking_domains WHERE account_id=?1 AND scope=?2",
        )
          .bind(accountId, scope)
          .first();
        if (existing) continue;
        const result = await child.tracking(hostname, scope, scope);
        await env.DB.prepare(
          "INSERT INTO tracking_domains(id,account_id,name,hostname,scope,verify_token,status,next_attempt) VALUES (?1,?2,?3,?4,?3,?5,?6,?7)",
        )
          .bind(
            id("tracking"),
            accountId,
            scope,
            hostname,
            result.data.token ?? null,
            result.status === 201 ? "WARMING" : "PENDING",
            Date.now() + 60_000,
          )
          .run();
      }
      await emit(env, account.reseller_id, "tracking_domain.pending", {
        accountId,
        records: await dnsRecords(env, accountId),
      });
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE accounts SET status='ACTIVE' WHERE id=?1").bind(
        accountId,
      ),
      env.DB.prepare(
        "UPDATE provisioning SET step='DONE',next_attempt=0,error=NULL WHERE account_id=?1",
      ).bind(accountId),
    ]);
    await emit(env, account.reseller_id, "account.created", { accountId });
  } catch (error) {
    // A partially provisioned customer must never send. Resuming activates only after required steps succeed.
    try {
      await parent.suspend(handle);
    } catch {
      /* Original failure is retained for the operator. */
    }
    await env.DB.prepare(
      "UPDATE provisioning SET attempts=attempts+1,error=?2,next_attempt=?3 WHERE account_id=?1",
    )
      .bind(accountId, String(error).slice(0, 500), Date.now() + 60_000)
      .run();
    await env.DB.prepare(
      "INSERT INTO alerts(id,account_id,kind,detail_json,created_at) VALUES (?1,?2,?3,?4,?5)",
    )
      .bind(
        id("alert"),
        accountId,
        "provisioning_failure",
        JSON.stringify({ error: String(error) }),
        nowIso(),
      )
      .run();
  }
}
export async function dnsRecords(
  env: Env,
  accountId: string,
): Promise<unknown[]> {
  const sender = (
    await env.DB.prepare(
      "SELECT records_json FROM sender_domains WHERE account_id=?1",
    )
      .bind(accountId)
      .all<{ records_json: string }>()
  ).results.flatMap((x) => JSON.parse(x.records_json));
  const tracking = (
    await env.DB.prepare(
      "SELECT hostname,verify_token FROM tracking_domains WHERE account_id=?1",
    )
      .bind(accountId)
      .all<{ hostname: string; verify_token: string | null }>()
  ).results;
  const records = [
    ...sender,
    ...tracking.flatMap((t) => [
      { type: "CNAME", name: t.hostname, value: "links.mailchannels.net" },
      ...(t.verify_token
        ? [
            {
              type: "TXT",
              name: `_mailchannels-verify.${t.hostname}`,
              value: t.verify_token,
            },
          ]
        : []),
    ]),
  ];
  return [...new Map(records.map((r) => [JSON.stringify(r), r])).values()];
}
export async function accountClient(
  env: Env,
  accountId: string,
): Promise<MailChannels> {
  const account = await env.DB.prepare(
    "SELECT mc_key_ref FROM accounts WHERE id=?1",
  )
    .bind(accountId)
    .first<{ mc_key_ref: string }>();
  if (!account?.mc_key_ref)
    throw new HttpError(409, "Account provisioning is incomplete");
  return new MailChannels(env, await readSecret(env, account.mc_key_ref));
}
