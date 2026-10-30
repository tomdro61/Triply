// Apply supabase/migrations/043_supplier_call_budget.sql to the live project
// through the same Postgres connection the CMS uses (transaction-mode pooler),
// then verify BY EXECUTING the function (the 040 lesson) — same pattern as
// apply-migration-032.mjs. Purely additive: nothing outside Park & Stay reads
// the table, and Park & Stay is off in Production. Re-run-safe.
//   node scripts/apply-migration-043.mjs          # apply (one transaction) + verify
//   node scripts/apply-migration-043.mjs verify   # verify only
//
// The execution checks run inside transactions that are ROLLED BACK, so they
// leave no budget row behind.
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire("C:/Projects/Triply_claude/triply-cms/package.json");
const { Client } = require("pg");
const cmsEnv = fs.readFileSync("C:/Projects/Triply_claude/triply-cms/.env.local", "utf8");
const DATABASE_URI = cmsEnv.match(/^DATABASE_URI=(.+)$/m)[1].trim().replace(/^"|"$/g, "");
const MODE = process.argv[2] ?? "apply";

const sql = fs.readFileSync(
  fileURLToPath(new URL("../supabase/migrations/043_supplier_call_budget.sql", import.meta.url)),
  "utf8"
);
const client = new Client({ connectionString: DATABASE_URI });
await client.connect();
const q = async (text, params) => (await client.query(text, params)).rows;

const state = async () => ({
  table: await q(`select relrowsecurity as rls from pg_class where relname = 'supplier_call_budget'`),
  privileges: await q(
    `select r as role,
            has_table_privilege(r, 'supplier_call_budget', 'SELECT') as can_select,
            has_table_privilege(r, 'supplier_call_budget', 'INSERT') as can_insert,
            has_function_privilege(r, 'supplier_call_budget_take(text,text,int)', 'EXECUTE') as can_take
       from unnest(array['anon','authenticated','service_role']) as r`
  ).catch((e) => `n/a (${e.message})`),
  rows: await q(`select count(*)::int as n from supplier_call_budget`).catch((e) => `n/a (${e.message})`),
});

console.log("before:", JSON.stringify(await state(), null, 1));

if (MODE === "apply") {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log("MIGRATION 043 APPLIED (committed)");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("MIGRATION FAILED, rolled back:", e.message);
    process.exit(1);
  }
}

const after = await state();
console.log("after:", JSON.stringify(after, null, 1));

// Execute as service_role, then roll back: allowed with calls >= 1; a 0 limit refuses.
let exec = { allowed: null, refused: null, anonDenied: null };
await client.query("BEGIN");
try {
  await client.query("SET LOCAL ROLE service_role");
  const [a] = await q(`select * from supplier_call_budget_take('liteapi', 'sandbox', 1000)`);
  const [b] = await q(`select * from supplier_call_budget_take('liteapi', 'sandbox', 0)`);
  exec.allowed = a;
  exec.refused = b;
} catch (e) {
  exec.error = e.message;
} finally {
  await client.query("ROLLBACK");
}
await client.query("BEGIN");
try {
  await client.query("SET LOCAL ROLE anon");
  await q(`select * from supplier_call_budget`);
  exec.anonDenied = false;
} catch (e) {
  exec.anonDenied = /permission denied/i.test(e.message);
} finally {
  await client.query("ROLLBACK");
}
console.log("execution checks (rolled back):", JSON.stringify(exec));
const rowsAfterChecks = await q(`select count(*)::int as n from supplier_call_budget`);

const ok =
  after.table[0]?.rls === true &&
  Array.isArray(after.privileges) &&
  after.privileges.every((p) =>
    p.role === "service_role" ? p.can_select && p.can_insert && p.can_take : !p.can_select && !p.can_insert && !p.can_take
  ) &&
  exec.allowed?.allowed === true && exec.allowed.calls >= 1 &&
  exec.refused?.allowed === false && exec.refused.denied >= 1 &&
  exec.anonDenied === true &&
  rowsAfterChecks[0].n === after.rows[0]?.n;
console.log(
  ok
    ? "VERIFIED: RLS on, service_role only (select/insert/execute), take allowed + 0-limit refused, anon denied, no rows left behind — OK"
    : "VERIFICATION FAILED — inspect the output above"
);
await client.end();
process.exit(ok ? 0 : 2);
