import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySignature } from "../src/worker/webhook";

const encoder = new TextEncoder();

describe("MailChannels webhook signature verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("verifies digest, replay window, and Ed25519 signature", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const keyId = `test-${crypto.randomUUID()}`;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: keyId, key: pem(spki) })));
    const body = encoder.encode('[{"event":"delivered"}]');
    const digest = base64(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
    const digestHeader = `sha-256=:${digest}:`;
    const created = Math.floor(Date.now() / 1000);
    const parameters = `(\"content-digest\");created=${created};alg=\"ed25519\";keyid=\"${keyId}\"`;
    const signatureName = "sig_test";
    const signingString = `\"content-digest\": ${digestHeader}\n\"@signature-params\": ${parameters}`;
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, encoder.encode(signingString)));
    const headers = new Headers({
      "content-digest": digestHeader,
      "signature-input": `${signatureName}=${parameters}`,
      "signature": `${signatureName}=:${base64(signature)}:`,
    });
    await expect(verifySignature(body, headers)).resolves.toBeUndefined();
  });

  it("rejects a modified body before fetching a key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const headers = new Headers({
      "content-digest": "sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:",
      "signature-input": `sig=(\"content-digest\");created=${Math.floor(Date.now() / 1000)};alg=\"ed25519\";keyid=\"x\"`,
      "signature": "sig=:AAAA:",
    });
    await expect(verifySignature(encoder.encode("changed"), headers)).rejects.toThrow("digest mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function pem(bytes: Uint8Array): string {
  const value = base64(bytes).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PUBLIC KEY-----\n${value}\n-----END PUBLIC KEY-----`;
}
