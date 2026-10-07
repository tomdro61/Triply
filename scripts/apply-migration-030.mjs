// Apply supabase/migrations/030_waitlist_opens_on_100_days.sql to the live
// project through the same Postgres connection the CMS uses (transaction-mode
// pooler), then verify. Apply AFTER the 100-day code is live: the other order
// emails waitlist rows a link the 60-day validator still rejects.
//   node scripts/apply-migration-030.mjs          # apply (idempotent) + verify
//   node scripts/apply-migration-030.mjs verify   # verify only
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("C:/Projects/Triply_claude/triply-cms/package.json");
const { Client } = require("pg");
const cmsEnv = fs.readFileSync("C:/Projects/Triply_claude/triply-cms/.env.local", "utf8");
const DATABASE_URI = cmsEnv.match(/^DATABASE_URI=(.+)$/m)[1].trim().replace(/^"|"$/g, "");
const MODE = process.argv[2] ?? "apply";

const sql = fs.readFileSync("C:/Projects/Triply_claude/triply/supabase/migrations/030_waitlist_opens_on_100_days.sql", "utf8");
const client = new Client({ connectionString: DATABASE_URI });
await client.connect();
const q = async (text, params) => (await client.query(text, params)).rows;

const summary = () =>
  q(`select count(*)::int as total,
            count(*) filter (where notified_at is null)::int as pending,
            count(*) filter (where notified_at is null and opens_on <> wanted_checkin - 100)::int as pending_not_on_100,
            count(*) filter (where notified_at is null and unsubscribed_at is null and opens_on <= current_date)::int as due_now
     from booking_waitlist`);

console.log("before:", JSON.stringify(await summary()));

if (MODE === "apply") {
  await client.query("BEGIN");
  try {
    const res = await client.query(sql);
    await client.query("COMMIT");
    console.log(`MIGRATION 030 APPLIED (committed), rows updated: ${res.rowCount}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("MIGRATION FAILED, rolled back:", e.message);
    process.exit(1);
  }
}

const after = await summary();
console.log("after:", JSON.stringify(after));
console.log(after[0].pending_not_on_100 === 0 ? "every pending row is on the 100-day window — OK" : "pending rows still off the 100-day window — INVESTIGATE");
await client.end();
