import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { harness } from "./local-harness";
import { sanitizeCss, validateTheme } from "../src/worker/control/themes";
import { permits, type Principal } from "../src/worker/control/rbac";
import { hash } from "../src/worker/control/identity";
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness({ sessionsOnly: true });
}, 30_000);
afterAll(async () => h?.mf.dispose());
async function session(
  user: string,
  scope: string,
  hostname = "a.local.test",
  actor: string | null = null,
) {
  const token = "test-" + crypto.randomUUID();
  await h.db
    .prepare(
      "INSERT INTO sessions(id,user_id,hostname,scope_type,scope_id,actor_user_id,expires_at,created_at) VALUES (?1,?2,?3,'account',?4,?5,?6,datetime('now'))",
    )
    .bind(
      await hash(token),
      user,
      hostname,
      scope,
      actor,
      Date.now() + 3600_000,
    )
    .run();
  return "__Host-session=" + token;
}
describe("sessions and scoped role enforcement", () => {
  it("magic links are single-use, host-bound, and do not enumerate users", async () => {
    const response = await h.request("/api/auth/login", {
      method: "POST",
      body: { email: "developer@local.test" },
    });
    expect(response.status).toBe(200);
    const unknown = await h.request("/api/auth/login", {
      method: "POST",
      body: { email: "unknown@example.test" },
    });
    expect(await unknown.json()).toEqual(await response.json());
    const message = await h.db
      .prepare(
        "SELECT body FROM system_emails ORDER BY created_at DESC LIMIT 1",
      )
      .first<{ body: string }>();
    const token = message!.body.match(/token=(\w+)/)![1];
    expect(
      (
        await h.request("/api/auth/consume", {
          host: "b.local.test",
          method: "POST",
          body: { token },
        })
      ).status,
    ).toBe(403);
    const login = await h.request("/api/auth/consume", {
      method: "POST",
      body: { token },
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect(
      (
        await h.request("/api/auth/consume", {
          method: "POST",
          body: { token },
        })
      ).status,
    ).toBe(403);
    expect((await h.request("/api/me", { headers: { cookie } })).status).toBe(
      200,
    );
    expect(
      (
        await h.request("/api/me", {
          host: "b.local.test",
          headers: { cookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.request("/api/auth/revoke", {
          method: "POST",
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    expect((await h.request("/api/me", { headers: { cookie } })).status).toBe(
      401,
    );
  });
  it.each([
    ["owner", 200, 201, 200],
    ["admin", 200, 201, 200],
    ["marketer", 200, 201, 403],
    ["author", 200, 201, 403],
    ["viewer", 200, 403, 403],
  ])(
    "enforces %s HTTP permissions",
    async (role, dashboard, template, users) => {
      const user = "role-" + role;
      await h.db
        .prepare(
          "INSERT INTO users(id,email,created_at) VALUES (?1,?2,datetime('now'))",
        )
        .bind(user, user + "@example.test")
        .run();
      await h.db
        .prepare(
          "INSERT INTO role_assignments VALUES (?1,'account','account-a',?2)",
        )
        .bind(user, role)
        .run();
      const cookie = await session(user, "account-a");
      expect(
        (await h.request("/api/dashboard", { headers: { cookie } })).status,
      ).toBe(dashboard);
      expect(
        (
          await h.request("/api/templates", {
            method: "POST",
            headers: { cookie },
            body: { name: "role-" + role, subject: "Test", text: "Draft" },
          })
        ).status,
      ).toBe(template);
      expect(
        (await h.request("/api/users", { headers: { cookie } })).status,
      ).toBe(users);
      const send = await h.request("/api/campaigns", {
        method: "POST",
        headers: { cookie },
        body: {},
      });
      expect(send.status).toBe(
        ["author", "viewer"].includes(String(role)) ? 403 : 400,
      );
    },
  );
  it("admin cannot replace an owner role and author cannot export contacts", async () => {
    const admin = await session("role-admin", "account-a");
    expect(
      (
        await h.request("/api/users", {
          method: "POST",
          headers: { cookie: admin },
          body: { email: "developer@local.test", role: "viewer" },
        })
      ).status,
    ).toBe(409);
    const author = await session("role-author", "account-a");
    expect(
      (await h.request("/api/export", { headers: { cookie: author } })).status,
    ).toBe(403);
  });
  it("support access is bounded, reasoned, audited, and revoked with the actor role", async () => {
    await h.db
      .prepare(
        "INSERT INTO users(id,email,created_at) VALUES ('support','support@example.test',datetime('now'))",
      )
      .run();
    await h.db
      .prepare(
        "INSERT INTO role_assignments VALUES ('support','reseller','reseller-a','support')",
      )
      .run();
    const token = "support-" + crypto.randomUUID();
    await h.db
      .prepare(
        "INSERT INTO sessions(id,user_id,hostname,scope_type,scope_id,expires_at,created_at) VALUES (?1,'support','a.local.test','reseller','reseller-a',?2,datetime('now'))",
      )
      .bind(await hash(token), Date.now() + 3600_000)
      .run();
    const staff = "__Host-session=" + token;
    expect(
      (
        await h.request("/api/reseller/accounts/account-b/impersonate", {
          method: "POST",
          headers: { cookie: staff },
          body: { reason: "help" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.request("/api/reseller/accounts/account-a/impersonate", {
          method: "POST",
          headers: { cookie: staff },
          body: { reason: "" },
        })
      ).status,
    ).toBe(400);
    const enter = await h.request(
      "/api/reseller/accounts/account-a/impersonate",
      {
        method: "POST",
        headers: { cookie: staff },
        body: { reason: "Investigate customer report" },
      },
    );
    expect(enter.status).toBe(200);
    const ghost = enter.headers.get("set-cookie")!.split(";")[0];
    expect(
      (await h.request("/api/users", { headers: { cookie: ghost } })).status,
    ).toBe(403);
    expect(
      (await h.request("/api/export", { headers: { cookie: ghost } })).status,
    ).toBe(403);
    expect(
      (
        await h.request("/api/templates", {
          method: "POST",
          headers: { cookie: ghost },
          body: { name: "support-draft", subject: "Draft", text: "Body" },
        })
      ).status,
    ).toBe(201);
    const audit = await h.db
      .prepare(
        "SELECT actor_user_id,impersonating FROM audit_log WHERE action='POST /api/templates' AND actor_user_id='support'",
      )
      .first();
    expect(audit).toEqual({
      actor_user_id: "support",
      impersonating: "local-owner",
    });
    await h.db
      .prepare("DELETE FROM role_assignments WHERE user_id='support'")
      .run();
    expect(
      (await h.request("/api/dashboard", { headers: { cookie: ghost } }))
        .status,
    ).toBe(403);
  });
});
describe("theme boundaries", () => {
  it.each([
    '@import "https://evil.test/a.css";',
    "body{background:url(https://evil.test)}",
    "body{color:r\\65 d}",
    'input[value^="s"]{color:red}',
    "body{display:none}",
    "</style><script>alert(1)</script>",
  ])("rejects unsafe stylesheet %s", (css) =>
    expect(() => sanitizeCss(css)).toThrow(),
  );
  it("allows constrained color overrides and rejects dangerous tokens", () => {
    expect(
      sanitizeCss(".card { color: #ffffff; border-radius: 8px; }"),
    ).toContain("#ffffff");
    expect(() =>
      validateTheme({ supportLink: "javascript:alert(1)" }),
    ).toThrow();
    expect(() => validateTheme({ primary: "red;</style>" })).toThrow();
  });
});
describe("permission map", () => {
  it("does not inherit reseller or platform privileges into customer routes", () => {
    const p: Principal = {
      userId: "x",
      email: "x",
      hostname: "x",
      resellerId: "r",
      scopeType: "account",
      scopeId: "a",
      roles: [{ scope_type: "platform", scope_id: "platform", role: "owner" }],
    };
    expect(permits(p, "campaigns.send", "account", "a")).toBe(false);
    expect(permits(p, "accounts.manage", "platform", "platform")).toBe(true);
  });
});
