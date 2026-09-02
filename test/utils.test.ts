import { describe, expect, it } from "vitest";
import { email, HttpError, isAllowedSender, parseStringArray, safeName } from "../src/worker/utils";
import { renderSubject } from "../src/worker/email";

describe("API validation", () => {
  it("normalizes email addresses", () => expect(email(" Alice@Example.NET ")).toBe("alice@example.net"));
  it("rejects invalid email addresses", () => expect(() => email("not-an-address")).toThrow(HttpError));
  it("enforces configured sender domains", () => {
    expect(isAllowedSender("news@example.com", "example.com,other.test")).toBe(true);
    expect(isAllowedSender("news@attacker.test", "example.com,other.test")).toBe(false);
  });
  it("deduplicates string arrays", () => expect(parseStringArray(["a", " a ", "b"], "items")).toEqual(["a", "b"]));
  it("rejects control-only names", () => expect(() => safeName("\u0000\u0007")).toThrow(HttpError));
  it("renders scalar and nested subject placeholders", () => {
    expect(renderSubject("Hello {{user.name}} — {{plan}}", { user: { name: "Alice" }, plan: "pro" })).toBe("Hello Alice — pro");
  });
});
