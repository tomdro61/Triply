import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("C:/Projects/Triply_claude/triply-cms/package.json");
const { Client } = require("pg");
const cmsEnv = fs.readFileSync("C:/Projects/Triply_claude/triply-cms/.env.local", "utf8");
const DATABASE_URI = cmsEnv.match(/^DATABASE_URI=(.+)$/m)[1].trim().replace(/^"|"$/g, "");
const appEnv = fs.readFileSync("C:/Projects/Triply_claude/triply/.env.local", "utf8");
const SUPA_URL = appEnv.match(/^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m)[1].trim();
const SERVICE_KEY = appEnv.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m)[1].trim();
const MODE = process.argv[2] ?? "apply";

const sql = fs.readFileSync("C:/Projects/Triply_claude/triply/supabase/migrations/023_booking_attribution.sql", "utf8");
// TLS is governed by the connection string's own sslmode, exactly as the CMS
// itself connects in production — this script neither loosens nor tightens it.
const client = new Client({ connectionString: DATABASE_URI });
await client.connect();
const q = async (text, params) => (await client.query(text, params)).rows;

const before = await q("select column_name from information_schema.columns where table_schema='public' and table_name in ('bookings','pending_bookings') and column_name in ('attribution','channel')");
console.log("before: attribution/channel columns present:", before.length);

if (MODE === "apply" && before.length < 3) {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log("MIGRATION 023 APPLIED (committed)");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("MIGRATION FAILED, rolled back:", e.message);
    process.exit(1);
  }
} else {
  console.log("skip apply (already present or verify-only)");
}

// --- structural verification -------------------------------------------------
console.log("columns:", JSON.stringify(await q("select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and table_name in ('bookings','pending_bookings') and column_name in ('attribution','channel') order by 1,2")));
console.log("promo current_uses:", JSON.stringify(await q("select column_name, is_nullable, column_default from information_schema.columns where table_name='promo_codes' and column_name='current_uses'")));
console.log("trigger:", JSON.stringify(await q("select tgname, tgenabled from pg_trigger where tgrelid='public.bookings'::regclass and not tgisinternal and tgname='bookings_bump_promo_use'")));
console.log("function:", JSON.stringify(await q("select proname, prosecdef, proconfig from pg_proc where proname='bump_promo_use'")));
console.log("index:", JSON.stringify(await q("select indexname from pg_indexes where tablename='bookings' and indexname='idx_bookings_channel'")));

// --- trigger checklist, all inside ONE transaction that is ROLLED BACK --------
await client.query("BEGIN");
try {
  const uses = async (code) => (await q("select current_uses from promo_codes where code=$1", [code]))[0]?.current_uses;
  const n0 = await uses("SAVE10");
  await client.query("create temp table t on commit drop as select * from bookings order by created_at desc limit 1");
  const mk = async (tag, promo, disc) => {
    // Clear every UNIQUE column the copied row may carry (pg_identifier is unique per booking).
    await client.query("update t set id=gen_random_uuid(), reslab_reservation_number=$1, stripe_payment_intent_id=$2, promo_code=$3, discount_amount=$4, pg_identifier=NULL", [`TEST-TRIG-${tag}`, `pi_test_trigger_${tag}`, promo, disc]);
    await client.query("insert into bookings select * from t");
    return (await q("select id from bookings where reslab_reservation_number=$1", [`TEST-TRIG-${tag}`]))[0].id;
  };
  const idA = await mk("a", "SAVE10", 5);
  const n1 = await uses("SAVE10");
  console.log(`1. promo insert: ${n0} -> ${n1}  ${n1 === n0 + 1 ? "OK" : "FAIL"}`);
  await mk("b", "SAVE10", 0);
  console.log(`2. discount 0: ${await uses("SAVE10")}  ${(await uses("SAVE10")) === n1 ? "OK" : "FAIL"}`);
  await mk("c", "GHOST-CODE", 5);
  console.log(`3. unknown code: insert succeeded, uses ${await uses("SAVE10")} ${(await uses("SAVE10")) === n1 ? "OK" : "FAIL"}`);
  await client.query("update bookings set airport_code='JFK' where id=$1", [idA]);
  console.log(`4. UPDATE on a promo row: uses ${await uses("SAVE10")} ${(await uses("SAVE10")) === n1 ? "OK (no fire)" : "FAIL"}`);
  // 5. The guard: make the counter UPDATE fail (as service_role, with UPDATE revoked) — the INSERT must still succeed.
  await client.query("savepoint guard");
  await client.query("grant select, update on t to service_role"); // the temp copy is owned by postgres
  await client.query("revoke update on public.promo_codes from service_role");
  await client.query("set local role service_role");
  let guardOk = false;
  try {
    await mk("d", "SAVE10", 5);
    guardOk = true;
    await client.query("reset role");
  } catch (e) {
    console.log("5. GUARD FAILED — insert aborted:", e.message);
    await client.query("rollback to savepoint guard");
    await client.query("reset role");
  }
  console.log(`5. counter UPDATE forbidden → INSERT still succeeds: ${guardOk ? "OK" : "FAIL"}; uses ${await uses("SAVE10")} (unchanged expected ${n1})`);
} finally {
  await client.query("ROLLBACK");
  console.log("checklist transaction ROLLED BACK; verifying no TEST-TRIG rows remain:", (await q("select count(*)::int as n from bookings where reslab_reservation_number like 'TEST-TRIG-%'"))[0].n);
}
await client.end();

// --- PostgREST verification (schema cache) -------------------------------------
for (let i = 1; i <= 10; i++) {
  const r = await fetch(`${SUPA_URL}/rest/v1/bookings?select=attribution,channel&limit=1`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  const r2 = await fetch(`${SUPA_URL}/rest/v1/pending_bookings?select=attribution&limit=1`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  console.log(`REST attempt ${i}: bookings ${r.status}, pending_bookings ${r2.status}`);
  if (r.status === 200 && r2.status === 200) break;
  await new Promise((res) => setTimeout(res, 3000));
}
