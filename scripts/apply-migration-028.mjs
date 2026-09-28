// Apply supabase/migrations/028_reslab_location_snapshot.sql to the live project
// through the same Postgres connection the CMS uses (transaction-mode pooler),
// then verify structure, RLS, grants and the anon denial through PostgREST.
//   node scripts/apply-migration-028.mjs          # apply (idempotent) + verify
//   node scripts/apply-migration-028.mjs verify   # verify only
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

const sql = fs.readFileSync("C:/Projects/Triply_claude/triply/supabase/migrations/028_reslab_location_snapshot.sql", "utf8");
const client = new Client({ connectionString: DATABASE_URI });
await client.connect();
const q = async (text, params) => (await client.query(text, params)).rows;

const exists = async () => (await q("select 1 from information_schema.tables where table_schema='public' and table_name='reslab_location_snapshot'")).length > 0;
console.log("before: table exists:", await exists());

if (MODE === "apply") {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log("MIGRATION 028 APPLIED (committed)");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("MIGRATION FAILED, rolled back:", e.message);
    process.exit(1);
  }
}

// --- structural verification -------------------------------------------------
console.log("columns:", JSON.stringify(await q("select column_name, data_type, is_generated from information_schema.columns where table_schema='public' and table_name='reslab_location_snapshot' order by ordinal_position")));
console.log("wire_bytes stored-generated:", JSON.stringify(await q("select attgenerated from pg_attribute where attrelid='public.reslab_location_snapshot'::regclass and attname='wire_bytes'")));
console.log("checks:", JSON.stringify(await q("select conname from pg_constraint where conrelid='public.reslab_location_snapshot'::regclass and contype='c' order by 1")));
console.log("rls:", JSON.stringify(await q("select relrowsecurity from pg_class where oid='public.reslab_location_snapshot'::regclass")));
console.log("table grants:", JSON.stringify(await q("select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='reslab_location_snapshot' order by 1,2")));
console.log("function:", JSON.stringify(await q("select proname, prosecdef, proconfig from pg_proc where proname='reslab_snapshot_upsert'")));
console.log("function grants:", JSON.stringify(await q("select grantee, privilege_type from information_schema.role_routine_grants where routine_schema='public' and routine_name='reslab_snapshot_upsert' order by 1,2")));
console.log("rows:", JSON.stringify(await q("select env_key, built_at, rows_fetched, location_count, paginator_total, wire_bytes, written_by from reslab_location_snapshot")));
await client.end();

// --- anon denial through PostgREST (must be a permission ERROR, not 0 rows) ----
const r = await fetch(`${SUPA_URL}/rest/v1/reslab_location_snapshot?select=env_key`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
const body = await r.text();
console.log(`anon select: HTTP ${r.status} ${body.slice(0, 160)}`);
console.log(r.status === 401 || r.status === 403 ? "anon DENIED — OK" : "anon NOT denied — INVESTIGATE");
