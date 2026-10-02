import { HttpError } from "../utils";
export type Scope = "platform" | "reseller" | "account";
export interface RoleAssignment {
  scope_type: Scope;
  scope_id: string;
  role: string;
}
export interface Principal {
  userId: string;
  email: string;
  hostname: string;
  resellerId: string | null;
  scopeType: Scope;
  scopeId: string;
  roles: RoleAssignment[];
  apiScopes?: string[];
  sessionId?: string;
  actorUserId?: string;
  reason?: string;
}
const permissions: Record<Scope, Record<string, string[]>> = {
  account: {
    owner: ["*"],
    admin: [
      "reports.read",
      "contacts.read",
      "drafts.write",
      "lists.write",
      "campaigns.send",
      "settings.write",
      "users.manage",
      "domains.write",
    ],
    marketer: [
      "reports.read",
      "contacts.read",
      "contacts.export",
      "drafts.write",
      "lists.write",
      "campaigns.send",
    ],
    author: ["reports.read", "drafts.write"],
    viewer: ["reports.read"],
  },
  reseller: {
    owner: ["*"],
    admin: [
      "sso.mint",
      "accounts.read",
      "accounts.manage",
      "branding.write",
      "hostnames.write",
      "domains.write",
    ],
    support: ["accounts.read", "impersonate"],
    billing: ["usage.read", "plans.write"],
  },
  platform: {
    owner: ["*"],
    admin: [
      "resellers.manage",
      "accounts.read",
      "accounts.manage",
      "plans.write",
      "hostnames.write",
      "operations.read",
      "operations.write",
    ],
    support: ["accounts.read", "operations.read", "impersonate"],
    compliance: ["accounts.read", "abuse.manage", "content.read"],
    billing: ["plans.write", "usage.read"],
  },
};
export function permits(
  principal: Principal,
  permission: string,
  scope: Scope,
  scopeId: string,
): boolean {
  if (principal.apiScopes)
    return (
      scope === "reseller" &&
      scopeId === principal.resellerId &&
      principal.apiScopes.includes(permission)
    );
  if (principal.actorUserId) {
    return (
      scope === "account" &&
      scopeId === principal.scopeId &&
      [
        "reports.read",
        "contacts.read",
        "drafts.write",
        "lists.write",
        "campaigns.send",
        "settings.write",
        "domains.write",
      ].includes(permission)
    );
  }
  return principal.roles.some(
    (r) =>
      r.scope_type === scope &&
      r.scope_id === scopeId &&
      (permissions[scope][r.role]?.includes("*") ||
        permissions[scope][r.role]?.includes(permission)),
  );
}
export function authorize(
  p: Principal,
  permission: string,
  scope: Scope = p.scopeType,
  id = p.scopeId,
): void {
  if (!permits(p, permission, scope, id))
    throw new HttpError(403, "Permission denied");
}
export function validRole(scope: Scope, role: string): boolean {
  return Boolean(permissions[scope][role]);
}
// Explicit method + path declarations. Unlisted routes always fail closed.
export function accountPermission(method: string, path: string): string {
  const routes: [string, RegExp, string][] = [
    [
      "GET",
      /^\/api\/(health|me|dashboard|campaigns(?:\/[^/]+)?)$/,
      "reports.read",
    ],
    ["GET", /^\/api\/templates(?:\/[^/]+)?$/, "drafts.write"],
    ["POST", /^\/api\/templates$/, "drafts.write"],
    ["PUT|DELETE", /^\/api\/templates\/[^/]+$/, "drafts.write"],
    [
      "GET",
      /^\/api\/(recipients-lists|topics|suppressions|attachments)$/,
      "contacts.read",
    ],
    ["GET", /^\/api\/generate-upload-url$/, "lists.write"],
    ["PUT", /^\/api\/uploads\/[^/]+$/, "lists.write"],
    ["DELETE", /^\/api\/(recipients-lists|attachments)\/[^/]+$/, "lists.write"],
    ["POST", /^\/api\/attachments\/upload-url$/, "lists.write"],
    ["POST", /^\/api\/(campaigns|send-email)$/, "campaigns.send"],
    ["PUT", /^\/api\/campaigns\/[^/]+$/, "drafts.write"],
    ["GET", /^\/api\/senders$/, "reports.read"],
  ];
  const route = routes.find(
    ([verbs, pattern]) =>
      verbs.split("|").includes(method) && pattern.test(path),
  );
  if (!route) throw new HttpError(404, "Route not found");
  return route[2];
}
