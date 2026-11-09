// Apply supabase/migrations/051_guest_lookup_attempts.sql to the live project
// through the same Postgres connection the CMS uses (transaction-mode pooler),
// then verify — the apply-migration-050.mjs pattern. Additive (a new table and
// two functions nothing reads yet), so it goes on before the code that calls it.
// Re-run-safe (IF NOT EXISTS / CREATE OR REPLACE).
//   node scripts/apply-migration-051.mjs          # apply (one transaction) + verify
//   node scripts/apply-migration-051.mjs verify   # verify only
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const cmsRequire = createRequire("C:/Projects/Triply_claude/triply-cms/package.json");
const appRequire = createRequire("C:/Projects/Triply_claude/triply/package.json");
const { Client } = cmsRequire("pg");
const { createClient } = appRequire("@supabase/supabase-js");

const envValue = (text, name) => text.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1].trim().replace(/^"|"$/g, "");
const cmsEnv = fs.readFileSync("C:/Projects/Triply_claude/triply-cms/.env.local", "utf8");
const appEnv = fs.readFileSync("C:/Projects/Triply_claude/triply/.env.local", "utf8");
const DATABASE_URI = envValue(cmsEnv, "DATABASE_URI");
const SUPABASE_URL = envValue(appEnv, "NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY = envValue(appEnv, "SUPABASE_SERVICE_ROLE_KEY");
if (!DATABASE_URI || !SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing DATABASE_URI (triply-cms/.env.local) or the Supabase URL / service key (triply/.env.local)");
  process.exit(1);
}
const MODE = process.argv[2] ?? "apply";

const sql = fs.readFileSync("C:/Projects/Triply_claude/triply/supabase/migrations/051_guest_lookup_attempts.sql", "utf8");
const client = new Client({ connectionString: DATABASE_URI });
await client.connect();
const q = async (text, params) => (await client.query(text, params)).rows;

const ROLES = ["anon", "authenticated", "service_role"];
const TAKE = "public.guest_lookup_take(text[], text[], integer[], integer)";
const RELEASE = "public.guest_lookup_release(text[], integer)";

const state = async () => {
  const [{ exists }] = await q(`select to_regclass('public.guest_lookup_attempts') is not null as exists`);
  if (!exists) return { exists };
  return {
    exists,
    rls: (await q(`select relrowsecurity as rls from pg_class where oid = 'public.guest_lookup_attempts'::regclass`))[0].rls,
    policies: (await q(`select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = 'guest_lookup_attempts'`))[0].n,
    table: await q(
      `select r as role,
              has_table_privilege(r, 'public.guest_lookup_attempts', 'SELECT') as sel,
              has_table_privilege(r, 'public.guest_lookup_attempts', 'INSERT') as ins,
              has_table_privilege(r, 'public.guest_lookup_attempts', 'UPDATE') as upd,
              has_table_privilege(r, 'public.guest_lookup_attempts', 'DELETE') as del
         from unnest($1::text[]) as r order by 1`,
      [ROLES],
    ),
    functions: await q(
      `select r as role,
              to_regprocedure($2) is not null and has_function_privilege(r, $2, 'EXECUTE') as take,
              to_regprocedure($3) is not null and has_function_privilege(r, $3, 'EXECUTE') as release
         from unnest($1::text[]) as r order by 1`,
      [ROLES, TAKE, RELEASE],
    ),
    rows: (await q(`select count(*)::int as n from public.guest_lookup_attempts`))[0].n,
  };
};

const show = (label, s) => {
  console.log(`== ${label} ==`);
  if (!s.exists) return console.log("table guest_lookup_attempts: not present");
  console.log(`rls on: ${s.rls}; policies: ${s.policies}; rows: ${s.rows}`);
  console.table(s.table);
  console.table(s.functions);
};

show("before", await state());

if (MODE === "apply") {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log("MIGRATION 051 APPLIED (committed)");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`MIGRATION FAILED, rolled back (${e.code ?? "?"}): ${e.message}`);
    await client.end();
    process.exit(1);
  }
}

const after = await state();
show("after", after);

// One take and one release through PostgREST as the service role: proves the
// API sees both functions (schema reload) and the grants work end to end.
// A random probe key no real bucket can have; its row is deleted afterwards.
const probeKey = crypto.randomBytes(32).toString("base64url");
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
let rpc = "not run";
try {
  const take = await supabase.rpc("guest_lookup_take", {
    p_keys: [probeKey],
    p_kinds: ["number"],
    p_limits: [5],
    p_window_seconds: 60,
  });
  const release = await supabase.rpc("guest_lookup_release", { p_keys: [probeKey], p_window_seconds: 60 });
  const row = Array.isArray(take.data) ? take.data[0] : null;
  rpc =
    take.error || release.error
      ? `error: ${take.error?.message ?? release.error?.message}`
      : row?.allowed === true && release.data === 1
        ? "take allowed, release gave 1 back"
        : `unexpected: take=${JSON.stringify(take.data)} release=${JSON.stringify(release.data)}`;
} finally {
  await q(`delete from public.guest_lookup_attempts where key_hash = $1`, [probeKey]);
}
console.log(`rpc probe (service role via PostgREST): ${rpc}`);

const role = (list, name) => list?.find((x) => x.role === name);
const ok =
  after.exists &&
  after.rls === true &&
  after.policies === 0 &&
  ["anon", "authenticated"].every((r) => {
    const t = role(after.table, r);
    const f = role(after.functions, r);
    return t && !t.sel && !t.ins && !t.upd && !t.del && f && !f.take && !f.release;
  }) &&
  (() => {
    const t = role(after.table, "service_role");
    const f = role(after.functions, "service_role");
    return t && t.sel && t.ins && t.upd && t.del && f && f.take && f.release;
  })() &&
  rpc === "take allowed, release gave 1 back";
console.log(
  ok
    ? "VERIFIED: RLS on, no policy; anon/authenticated have no table or function access; service_role reads, writes, deletes and runs both functions through PostgREST — OK"
    : "VERIFICATION FAILED — inspect the output above",
);
await client.end();
process.exit(ok ? 0 : 2);
