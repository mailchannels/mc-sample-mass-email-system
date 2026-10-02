import { it, expect } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { harness } from "./local-harness";
it("validates OIDC signature, issuer, audience, nonce, state cookie and invited reseller membership", async () => {
  const pair = await generateKeyPair("RS256");
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = "oidc-test";
  let nonce = "",
    badNonce = false;
  const h = await harness({
    provider: async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "idp.example.test") return null;
      if (url.pathname.endsWith("/.well-known/openid-configuration"))
        return Response.json({
          issuer: "https://idp.example.test",
          authorization_endpoint: "https://idp.example.test/authorize",
          token_endpoint: "https://idp.example.test/token",
          jwks_uri: "https://idp.example.test/jwks",
        });
      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (url.pathname === "/token") {
        const form = await request.formData();
        expect(String(form.get("code_verifier")).length).toBeGreaterThan(43);
        expect(form.get("redirect_uri")).toBe(
          "https://a.local.test/api/auth/oidc/callback",
        );
        const token = await new SignJWT({
          email: "developer@local.test",
          email_verified: true,
          nonce: badNonce ? "wrong" : nonce,
        })
          .setProtectedHeader({ alg: "RS256", kid: "oidc-test" })
          .setIssuer("https://idp.example.test")
          .setAudience("client")
          .setSubject("user-1")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(pair.privateKey);
        return Response.json({ id_token: token });
      }
      return new Response("", { status: 404 });
    },
  });
  try {
    expect(
      (
        await h.request("/api/reseller/oidc", {
          method: "PUT",
          body: {
            issuer: "https://idp.example.test",
            clientId: "client",
            clientSecret: "secret",
          },
        })
      ).status,
    ).toBe(200);
    const begin = await h.request("/api/auth/oidc/start");
    expect(begin.status).toBe(302);
    const location = new URL(begin.headers.get("location")!);
    nonce = location.searchParams.get("nonce")!;
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const state = location.searchParams.get("state");
    const cookie = begin.headers.get("set-cookie")!.split(";")[0];
    expect(
      (await h.request(`/api/auth/oidc/callback?state=${state}&code=code`))
        .status,
    ).toBe(403);
    const callback = await h.request(
      `/api/auth/oidc/callback?state=${state}&code=code`,
      { headers: { cookie } },
    );
    expect(callback.status, await callback.clone().text()).toBe(302);
    expect(
      (
        await h.request(`/api/auth/oidc/callback?state=${state}&code=code`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(403);
    const session = callback.headers.get("set-cookie")!.split(";")[0];
    const me = await h.request("/api/me", { headers: { cookie: session } });
    expect(((await me.json()) as { scopeType: string }).scopeType).toBe(
      "reseller",
    );
    const again = await h.request("/api/auth/oidc/start");
    const next = new URL(again.headers.get("location")!);
    nonce = next.searchParams.get("nonce")!;
    badNonce = true;
    expect(
      (
        await h.request(
          `/api/auth/oidc/callback?state=${next.searchParams.get("state")}&code=code`,
          {
            headers: { cookie: again.headers.get("set-cookie")!.split(";")[0] },
          },
        )
      ).status,
    ).toBe(403);
  } finally {
    await h.mf.dispose();
  }
}, 15000);
