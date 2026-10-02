import { it, expect } from "vitest";
import { harness, eventually } from "./local-harness";
import { seal } from "../src/worker/control/crypto";
import type { Env } from "../src/worker/types";
it("a 100,000-row backlog does not delay a 100-recipient account beyond 10 seconds over its 20-second pacing budget", async () => {
  const h = await harness({ queues: true });
  try {
    for (const [accountId, count] of [
      ["account-a", 100000],
      ["account-b", 100],
    ] as const) {
      const secret = await seal(
        {
          KEY_ENCRYPTION_SECRET: Buffer.alloc(32, 7).toString("base64"),
        } as Env,
        "key-" + accountId,
      );
      await h.db
        .prepare(
          "INSERT INTO secrets(id,ciphertext,created_at) VALUES (?1,?2,datetime('now'))",
        )
        .bind("secret-" + accountId, secret)
        .run();
      await h.db
        .prepare(
          "UPDATE accounts SET mc_key_ref=?2,mc_handle=?1,postal_address='123 Test Road' WHERE id=?1",
        )
        .bind(accountId, "secret-" + accountId)
        .run();
      await h.db
        .prepare(
          "INSERT INTO sender_domains(id,account_id,domain,verified_at) VALUES (?1,?1,'sender.test',datetime('now'))",
        )
        .bind(accountId)
        .run();
      await h.internal(accountId, "/internal/rollup");
      const sql = await h.storage(accountId);
      const now = new Date().toISOString();
      await sql.exec(
        "INSERT INTO templates(name,subject,text_body,created_at,updated_at) VALUES ('test','Hello {{firstName}}','Hello',?,?)",
        now,
        now,
      );
      await sql.exec(
        "INSERT INTO recipient_lists(id,name,original_filename,object_key,status,recipient_count,created_at,updated_at) VALUES ('list','list','list.csv',?,'READY',?,?,?)",
        "acct/" + accountId + "/list.csv",
        count,
        now,
        now,
      );
      await sql.exec(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO recipients(list_id,email,first_name,created_at) SELECT 'list','user'||x||'@example.test','Test',? FROM n`,
        count,
        now,
      );
      await sql.exec(
        "INSERT INTO campaigns(id,list_id,list_name,template_name,sender_email,status,total_count,pending_count,expansion_done,created_at,updated_at) VALUES ('campaign','list','list','test','news@sender.test','RUNNING',?,?,1,?,?)",
        count,
        count,
        now,
        now,
      );
      await sql.exec(
        "INSERT INTO campaign_batches(id,campaign_id,sequence,first_recipient_id,last_recipient_id,recipient_count,created_at,updated_at) VALUES ('batch','campaign',1,1,?,?,?,?)",
        count,
        count,
        now,
        now,
      );
      await sql.exec(
        "INSERT INTO campaign_recipients(id,campaign_id,batch_id,source_recipient_id,email,updated_at) SELECT 'cr-'||id,'campaign','batch',id,email,? FROM recipients",
        now,
      );
      await sql.exec(
        "INSERT INTO delivery_outbox(id,campaign_recipient_id,created_at) SELECT 'out-'||id,id,? FROM campaign_recipients",
        now,
      );
    }
    const start = Date.now();
    const small = await h.storage("account-b");
    await eventually(
      () =>
        small.exec("SELECT accepted_count FROM campaigns WHERE id='campaign'"),
      (rows) => rows[0]?.accepted_count === 100,
      30_000,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(30_000);
    const large = await (
      await h.storage("account-a")
    ).exec("SELECT pending_count FROM campaigns WHERE id='campaign'");
    expect(Number(large[0].pending_count)).toBeGreaterThan(99000);
    const keys = new Set(
      h.calls.filter((c) => c.path === "/tx/v1/send-async").map((c) => c.key),
    );
    expect(keys).toEqual(new Set(["key-account-a", "key-account-b"]));
    console.info(
      `Local fairness: 100-recipient account finished in ${elapsed}ms beside 100,000-recipient backlog (30,000ms bound).`,
    );
  } finally {
    await h.mf.dispose();
  }
}, 45_000);
