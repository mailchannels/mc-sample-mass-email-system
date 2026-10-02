import { it, expect } from "vitest";
import { harness } from "./local-harness";
import {
  initialCsvState,
  parseCsvChunk,
  rowsToRecipients,
} from "../src/worker/csv";
it("benchmarks the same 5,000-row CSV against local D1 and the resumable AccountDO import", async () => {
  const h = await harness();
  try {
    const count = 5000;
    const csv =
      "email,first_name,last_name,topics\n" +
      Array.from(
        { length: count },
        (_, i) => `reader${i}@example.test,First${i},Last,news`,
      ).join("\n");
    const bytes = new TextEncoder().encode(csv);
    const parsed = parseCsvChunk(bytes, initialCsvState(), true);
    const rows = rowsToRecipients(parsed.rows, parsed.state);
    await h.db
      .prepare(
        "CREATE TABLE benchmark_recipients(email TEXT PRIMARY KEY,first_name TEXT,last_name TEXT,topics_json TEXT,data_json TEXT)",
      )
      .run();
    const baseline = performance.now();
    for (let offset = 0; offset < rows.length; offset += 75)
      await h.db.batch(
        rows
          .slice(offset, offset + 75)
          .map((r) =>
            h.db
              .prepare(
                "INSERT OR IGNORE INTO benchmark_recipients VALUES (?1,?2,?3,?4,?5)",
              )
              .bind(
                r.email,
                r.firstName,
                r.lastName,
                JSON.stringify(r.topics),
                JSON.stringify(r.data),
              ),
          ),
      );
    const d1ms = performance.now() - baseline;
    const ticket = await h.request(
      "/api/generate-upload-url?filename=benchmark.csv&consent=true",
    );
    const upload = (await ticket.json()) as {
      uploadUrl: string;
      resourceId: string;
    };
    expect(
      (
        await h.request(new URL(upload.uploadUrl).pathname, {
          method: "PUT",
          raw: csv,
        })
      ).status,
    ).toBe(202);
    const start = performance.now();
    expect(
      (
        await h.internal("account-a", "/internal/job", {
          accountId: "account-a",
          type: "import-list",
          listId: upload.resourceId,
          expectedOffset: 0,
        })
      ).status,
    ).toBe(200);
    const doms = performance.now() - start;
    const result = await (
      await h.storage("account-a")
    ).exec(
      "SELECT recipient_count,status,consent_at FROM recipient_lists WHERE id=?",
      upload.resourceId,
    );
    expect(result[0].recipient_count).toBe(count);
    expect(result[0].status).toBe("READY");
    expect(result[0].consent_at).toBeTruthy();
    console.info(
      `Import spike: 5,000 contacts; local D1 ${d1ms.toFixed(0)}ms; AccountDO ${doms.toFixed(0)}ms. Local measurements are not Cloudflare performance estimates.`,
    );
    await h.db.prepare("DROP TABLE benchmark_recipients").run();
  } finally {
    await h.mf.dispose();
  }
}, 20000);
