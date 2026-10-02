import type { Env } from "../types";
import {
  base64FromBytes,
  bytesFromBase64,
  HttpError,
  id,
  nowIso,
} from "../utils";
function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  if (!env.KEY_ENCRYPTION_SECRET)
    throw new HttpError(503, "Key encryption is not configured");
  const raw = bytesFromBase64(env.KEY_ENCRYPTION_SECRET);
  if (raw.length !== 32)
    throw new HttpError(503, "Key encryption requires a 256-bit key");
  return crypto.subtle.importKey("raw", buffer(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(env: Env, value: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await encryptionKey(env),
    new TextEncoder().encode(value),
  );
  return (
    base64FromBytes(nonce) + "." + base64FromBytes(new Uint8Array(encrypted))
  );
}
export async function unseal(env: Env, value: string): Promise<string> {
  const [nonce, data] = value.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buffer(bytesFromBase64(nonce)) },
      await encryptionKey(env),
      buffer(bytesFromBase64(data)),
    ),
  );
}
export async function storeSecret(env: Env, value: string): Promise<string> {
  const ref = id("secret");
  await env.DB.prepare("INSERT INTO secrets VALUES (?1,?2,?3)")
    .bind(ref, await seal(env, value), nowIso())
    .run();
  return ref;
}
export async function readSecret(env: Env, ref: string): Promise<string> {
  const row = await env.DB.prepare("SELECT ciphertext FROM secrets WHERE id=?1")
    .bind(ref)
    .first<{ ciphertext: string }>();
  if (!row) throw new HttpError(503, "Credential unavailable");
  return unseal(env, row.ciphertext);
}
export async function signToken(
  secret: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const data = base64FromBytes(
    new TextEncoder().encode(JSON.stringify(payload)),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
  );
  return (
    data +
    "." +
    base64FromBytes(signature)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")
  );
}
export async function verifyToken<T>(
  secret: string,
  token: string,
): Promise<T> {
  try {
    const [data, sig, ...extra] = token.split(".");
    if (extra.length || !sig) throw new Error();
    const decode = (s: string) =>
      bytesFromBase64(
        s
          .replaceAll("-", "+")
          .replaceAll("_", "/")
          .padEnd(Math.ceil(s.length / 4) * 4, "="),
      );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        buffer(decode(sig)),
        new TextEncoder().encode(data),
      ))
    )
      throw new Error();
    return JSON.parse(new TextDecoder().decode(decode(data))) as T;
  } catch {
    throw new HttpError(403, "Invalid token");
  }
}
