import { describe, expect, it } from "vitest";
import { initialCsvState, parseCsvChunk, rowsToRecipients } from "../src/worker/csv";

const encoder = new TextEncoder();

describe("incremental CSV parser", () => {
  it("maps headers and retains arbitrary template data", () => {
    const state = initialCsvState();
    const parsed = parseCsvChunk(encoder.encode("email,first_name,last_name,topics,company\nalice@example.net,Alice,Ng,news;pro,Acme\n"), state, true);
    const recipients = rowsToRecipients(parsed.rows, parsed.state);
    expect(recipients).toEqual([{
      email: "alice@example.net",
      firstName: "Alice",
      lastName: "Ng",
      topics: ["news", "pro"],
      data: { email: "alice@example.net", firstname: "Alice", lastname: "Ng", topics: "news;pro", company: "Acme" },
    }]);
  });

  it("survives arbitrary chunk boundaries, UTF-8, escaped quotes, and quoted newlines", () => {
    const source = encoder.encode('email,first_name,note\nalice@example.net,Zoë,"line one\nline ""two"" — ✓"\n');
    let state = initialCsvState();
    const rows: string[][] = [];
    for (let offset = 0; offset < source.length; offset += 7) {
      const result = parseCsvChunk(source.slice(offset, offset + 7), state, offset + 7 >= source.length);
      state = result.state;
      rows.push(...result.rows);
    }
    const recipients = rowsToRecipients(rows, state);
    expect(recipients[0].firstName).toBe("Zoë");
    expect(recipients[0].data.note).toBe('line one\nline "two" — ✓');
  });

  it("accepts a headerless AWS-sample-style file", () => {
    const state = initialCsvState();
    const parsed = parseCsvChunk(encoder.encode("alice@example.net,Alice,Ng,newsletter\ninvalid,A,B,C\n"), state, true);
    const recipients = rowsToRecipients(parsed.rows, parsed.state);
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({ email: "alice@example.net", firstName: "Alice", lastName: "Ng" });
  });

  it("handles CRLF exactly once", () => {
    let state = initialCsvState();
    const first = parseCsvChunk(encoder.encode("email,first_name\r"), state, false);
    state = first.state;
    const second = parseCsvChunk(encoder.encode("\nalice@example.net,Alice\r\n"), state, true);
    const recipients = rowsToRecipients([...first.rows, ...second.rows], second.state);
    expect(recipients).toHaveLength(1);
  });
});
