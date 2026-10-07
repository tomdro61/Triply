// Apply supabase/migrations/032_cancellation_reason.sql to the live project
// through the same Postgres connection the CMS uses (transaction-mode pooler),
// then verify — same pattern as apply-migration-030.mjs. Apply BEFORE the
// PR #47 code: it is additive and the current code ignores every column/table
// it adds. Re-run-safe.
//   node scripts/apply-migration-032.mjs          # apply (one transaction) + verify
//   node scripts/apply-migration-032.mjs verify   # verify only
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("C:/Projects/Triply_claude/triply-cms/package.json");
const { Client } = require("pg");
const cmsEnv = fs.readFileSync("C:/Projects/Triply_claude/triply-cms/.env.local", "utf8");
const DATABASE_URI = cmsEnv.match(/^DATABASE_URI=(.+)$/m)[1].trim().replace(/^"|"$/g, "");
const MODE = process.argv[2] ?? "apply";

const sql = fs.readFileSync("C:/Projects/Triply_claude/triply/supabase/migrations/032_cancellation_reason.sql", "utf8");
const client = new Client({ connectionString: DATABASE_URI });
await client.connect();
const q = async (text, params) => (await client.query(text, params)).rows;

const state = async () => ({
  constraints: await q(
    `select conname, convalidated, pg_get_constraintdef(oid) as def
       from pg_constraint
      where conrelid = 'bookings'::regclass and conname like 'bookings_cancel%'
        and conname <> 'bookings_cancel_state_check' order by 1`,
  ),
  columns: await q(
    `select column_name, data_type, is_nullable from information_schema.columns
      where table_name = 'bookings'
        and column_name in ('cancellation_reason', 'cancelled_by', 'cancellation_note') order by 1`,
  ),
  notesTable: await q(
    `select relrowsecurity as rls from pg_class where relname = 'booking_cancellation_notes'`,
  ),
  privileges: await q(
    `select r as role,
            has_table_privilege(r, 'booking_cancellation_notes', 'SELECT') as can_select,
            has_table_privilege(r, 'booking_cancellation_notes', 'INSERT') as can_insert
       from unnest(array['anon','authenticated','service_role']) as r`,
  ).catch((e) => `n/a (${e.message})`),
});

console.log("before:", JSON.stringify(await state(), null, 1));

if (MODE === "apply") {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log("MIGRATION 032 APPLIED (committed)");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("MIGRATION FAILED, rolled back:", e.message);
    process.exit(1);
  }
}

const after = await state();
console.log("after:", JSON.stringify(after, null, 1));

const ok =
  after.constraints.length === 2 &&
  after.constraints.every((c) => c.convalidated) &&
  after.columns.length === 2 &&
  after.columns.every((c) => c.data_type === "text" && c.is_nullable === "YES") &&
  !after.columns.some((c) => c.column_name === "cancellation_note") &&
  after.notesTable[0]?.rls === true &&
  Array.isArray(after.privileges) &&
  after.privileges.every((p) =>
    p.role === "service_role" ? p.can_select && p.can_insert : !p.can_select && !p.can_insert,
  );
console.log(ok ? "VERIFIED: 2 constraints, 2 text columns, no cancellation_note, notes table RLS on + service_role only — OK" : "VERIFICATION FAILED — inspect the output above");
await client.end();
process.exit(ok ? 0 : 2);
