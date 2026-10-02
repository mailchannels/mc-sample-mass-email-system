import type { Env, AccountRecord } from "../types";
export function accountStub(
  env: Env,
  account: Pick<AccountRecord, "id" | "jurisdiction">,
): DurableObjectStub {
  const namespace =
    account.jurisdiction === "eu"
      ? env.ACCOUNTS.jurisdiction("eu")
      : env.ACCOUNTS;
  return namespace.get(namespace.idFromName(account.id));
}
