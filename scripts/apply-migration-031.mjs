// Apply supabase/migrations/031_checkout_recovery_emails.sql (the reworked
// version from PR #44, 2026-10-07) to the live project through the same
// Postgres connection the CMS uses (transaction-mode pooler), then verify —
// same pattern as apply-migration-032.mjs. Additive: two new server-only
// tables nothing on main reads yet. Re-run-safe (IF NOT EXISTS throughout).
//   node scripts/apply-migration-031.mjs          # apply (one transaction) + verify
//   node scripts/apply-migration-031.mjs verify   # verify only
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("C:/Projects/Triply_claude/triply-cms/package.json");
const { Client } = require("pg");
const cmsEnv = fs.readFileSync("C:/Projects/Triply_claude/triply-cms/.env.local", "utf8");
const DATABASE_URI = cmsEnv.match(/^DATABASE_URI=(.+)$/m)[1].trim().replace(/^"|"$/g, "");
const MODE = process.argv[2] ?? "apply";
const SQL_PATH =
  process.argv[3] ?? "C:/Projects/_wt-pr44/supabase/migrations/031_checkout_recovery_emails.sql";

const sql = fs.readFileSync(SQL_PATH, "utf8");
const client = new Client({ connectionString: DATABASE_URI });
await client.connect();
const q = async (text, params) => (await client.query(text, params)).rows;

const state = async () => ({
  tables: await q(
    `select relname, relrowsecurity as rls from pg_class
      where relname in ('checkout_recovery_emails', 'checkout_recovery_optouts') order by 1`,
  ),
  columns: await q(
    `select column_name, data_type, is_nullable from information_schema.columns
      where table_name = 'checkout_recovery_emails' order by ordinal_position`,
  ),
  constraints: await q(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = to_regclass('checkout_recovery_emails') order by 1`,
  ),
  indexes: await q(
    `select indexname from pg_indexes where tablename = 'checkout_recovery_emails' order by 1`,
  ),
  privileges: await q(
    `select t as tbl, r as role,
            has_table_privilege(r, t, 'SELECT') as s,
            has_table_privilege(r, t, 'INSERT') as i,
            has_table_privilege(r, t, 'UPDATE') as u,
            has_table_privilege(r, t, 'DELETE') as d
       from unnest(array['checkout_recovery_emails','checkout_recovery_optouts']) as t,
            unnest(array['anon','authenticated','service_role']) as r order by 1, 2`,
  ).catch((e) => `n/a (${e.message})`),
});

console.log("before:", JSON.stringify(await state(), null, 1));

if (MODE === "apply") {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log("MIGRATION 031 APPLIED (committed)");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("MIGRATION FAILED, rolled back:", e.message);
    process.exit(1);
  }
}

const after = await state();
console.log("after:", JSON.stringify(after, null, 1));

const cols = Object.fromEntries(after.columns.map((c) => [c.column_name, c]));
const ok =
  after.tables.length === 2 &&
  after.tables.every((t) => t.rls === true) &&
  ["id", "stripe_payment_intent_id", "email", "livemode", "status", "last_error", "created_at", "claimed_at", "send_started_at", "sent_at"].every((c) => cols[c]) &&
  cols.claimed_at.is_nullable === "NO" &&
  cols.send_started_at.is_nullable === "YES" &&
  after.constraints.some((c) => c.conname === "checkout_recovery_emails_pi_unique") &&
  after.constraints.some((c) => c.conname === "checkout_recovery_emails_status_check" && c.def.includes("'retry'")) &&
  after.indexes.some((x) => x.indexname === "idx_checkout_recovery_emails_email_created") &&
  after.indexes.some((x) => x.indexname === "idx_checkout_recovery_emails_claimed") &&
  Array.isArray(after.privileges) &&
  // service_role may hold more than the explicit GRANT (Supabase's default
  // privileges give it ALL on new tables); what matters is that anon and
  // authenticated hold nothing.
  after.privileges.every((p) =>
    p.role === "service_role" ? p.s && p.i : !p.s && !p.i && !p.u && !p.d,
  );
console.log(
  ok
    ? "VERIFIED: 2 tables RLS on, 10 columns incl. claimed_at/send_started_at, status CHECK has 'retry', UNIQUE + both indexes, service_role only — OK"
    : "VERIFICATION FAILED — inspect the output above",
);
await client.end();
process.exit(ok ? 0 : 2);
