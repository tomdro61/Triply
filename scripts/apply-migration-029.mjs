// Apply supabase/migrations/029_digest_runs.sql to the live project through the
// same Postgres connection the CMS uses (transaction-mode pooler), then verify
// structure, RLS, grants and the anon denial through PostgREST.
//   node scripts/apply-migration-029.mjs          # apply (idempotent) + verify
//   node scripts/apply-migration-029.mjs verify   # verify only
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("C:/Projects/Triply_claude/triply-cms/package.json");
const { Client } = require("pg");
const cmsEnv = fs.readFileSync("C:/Projects/Triply_claude/triply-cms/.env.local", "utf8");
const DATABASE_URI = cmsEnv.match(/^DATABASE_URI=(.+)$/m)[1].trim().replace(/^"|"$/g, "");
const appEnv = fs.readFileSync("C:/Projects/Triply_claude/triply/.env.local", "utf8");
const SUPA_URL = appEnv.match(/^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m)[1].trim();
const ANON_KEY = appEnv.match(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)$/m)[1].trim();
const MODE = process.argv[2] ?? "apply";

const sql = fs.readFileSync("C:/Projects/Triply_claude/triply/supabase/migrations/029_digest_runs.sql", "utf8");
const client = new Client({ connectionString: DATABASE_URI });
await client.connect();
const q = async (text, params) => (await client.query(text, params)).rows;

const exists = async () => (await q("select 1 from information_schema.tables where table_schema='public' and table_name='digest_runs'")).length > 0;
console.log("before: table exists:", await exists());
console.log("before: bookings.triply_service_fee:", JSON.stringify(await q("select data_type, is_nullable from information_schema.columns where table_name='bookings' and column_name='triply_service_fee'")));

if (MODE === "apply") {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log("MIGRATION 029 APPLIED (committed)");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("MIGRATION FAILED, rolled back:", e.message);
    process.exit(1);
  }
}

console.log("columns:", JSON.stringify(await q("select column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and table_name='digest_runs' order by ordinal_position")));
console.log("checks:", JSON.stringify(await q("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid='public.digest_runs'::regclass and contype in ('c','p') order by 1")));
console.log("rls:", JSON.stringify(await q("select relrowsecurity from pg_class where oid='public.digest_runs'::regclass")));
console.log("table grants:", JSON.stringify(await q("select grantee, string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where table_schema='public' and table_name='digest_runs' group by grantee order by 1")));
console.log("rows:", JSON.stringify(await q("select * from digest_runs order by digest_date desc limit 5")));
await client.end();

const r = await fetch(`${SUPA_URL}/rest/v1/digest_runs?select=digest_date`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
const body = await r.text();
console.log(`anon select: HTTP ${r.status} ${body.slice(0, 160)}`);
console.log(r.status === 401 || r.status === 403 ? "anon DENIED — OK" : "anon NOT denied — INVESTIGATE (a 404 PGRST205 right after apply = schema cache not reloaded yet; re-run verify)");
