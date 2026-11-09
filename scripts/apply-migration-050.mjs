// Apply supabase/migrations/050_customers_server_only_writes.sql to the live project
// through the same Postgres connection the CMS uses (transaction-mode pooler),
// then verify — same pattern as apply-migration-032.mjs. Independent of the code
// change (every writer already uses the service role), so it can go first.
// Re-run-safe; on a lock timeout (55P03) nothing is applied — just run it again.
//   node scripts/apply-migration-050.mjs          # apply (one transaction) + verify
//   node scripts/apply-migration-050.mjs verify   # verify only
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("C:/Projects/Triply_claude/triply-cms/package.json");
const { Client } = require("pg");
const cmsEnv = fs.readFileSync("C:/Projects/Triply_claude/triply-cms/.env.local", "utf8");
const DATABASE_URI = cmsEnv.match(/^DATABASE_URI=(.+)$/m)[1].trim().replace(/^"|"$/g, "");
const MODE = process.argv[2] ?? "apply";

const sql = fs.readFileSync("C:/Projects/Triply_claude/triply/supabase/migrations/050_customers_server_only_writes.sql", "utf8");
const client = new Client({ connectionString: DATABASE_URI });
await client.connect();
const q = async (text, params) => (await client.query(text, params)).rows;

const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const ROLES = ["anon", "authenticated", "service_role"];

const state = async () => ({
  policies: await q(`select policyname, cmd, roles::text as roles from pg_policies
                      where schemaname = 'public' and tablename = 'customers' order by 1`),
  rls: (await q(`select relrowsecurity as rls from pg_class where oid = 'public.customers'::regclass`))[0]?.rls,
  privileges: await q(
    `select r as role, p as privilege, has_table_privilege(r, 'public.customers', p) as granted
       from unnest($1::text[]) as r, unnest($2::text[]) as p order by 1, 2`,
    [ROLES, PRIVS],
  ),
  columnWrites: await q(
    `select r as role,
            has_any_column_privilege(r, 'public.customers', 'INSERT') as col_insert,
            has_any_column_privilege(r, 'public.customers', 'UPDATE') as col_update
       from unnest($1::text[]) as r order by 1`,
    [ROLES],
  ),
});

const show = (label, s) => {
  console.log(`== ${label} ==`);
  console.log("policies:"), console.table(s.policies);
  console.log(`rls on: ${s.rls}`);
  const grid = {};
  for (const { role, privilege, granted } of s.privileges) (grid[role] ??= {})[privilege] = granted;
  console.table(grid);
  console.table(s.columnWrites);
};

show("before", await state());

if (MODE === "apply") {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log("MIGRATION 050 APPLIED (committed)");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`MIGRATION FAILED, rolled back (${e.code ?? "?"}): ${e.message}`);
    if (e.code === "55P03") console.error("Lock timeout — nothing was applied. Run it again.");
    await client.end();
    process.exit(1);
  }
}

const after = await state();
show("after", after);

// Probe as a signed-in user: an UPDATE that matches no row, in a rolled-back
// transaction. Expected: 42501 (permission denied). Touches no row either way.
let probe;
await client.query("BEGIN");
try {
  // Switch role first, on its own: a refused SET ROLE is also 42501 and must
  // not pass for a refused UPDATE.
  try {
    await client.query("SET LOCAL ROLE authenticated");
    const [{ who }] = await q("select current_user as who");
    if (who !== "authenticated") throw new Error(`current_user is ${who}`);
  } catch (e) {
    probe = `could not run (${e.code ?? "?"}): ${e.message}`;
  }
  if (!probe) {
    try {
      await client.query("UPDATE public.customers SET email = email WHERE false");
      probe = "ALLOWED";
    } catch (e) {
      probe = e.code === "42501" ? "denied (42501)" : `other error (${e.code ?? "?"}): ${e.message}`;
    }
  }
} finally {
  await client.query("ROLLBACK").catch(() => {});
}
console.log(`probe — authenticated UPDATE: ${probe}`);

const granted = (role, p) => after.privileges.find((x) => x.role === role && x.privilege === p)?.granted;
const ok =
  !after.policies.some((p) => p.policyname === "Users can update own customer record") &&
  after.policies.every((p) => p.cmd === "SELECT" || p.roles === "{service_role}") &&
  after.rls === true &&
  ["anon", "authenticated"].every((r) => PRIVS.every((p) => granted(r, p) === (p === "SELECT"))) &&
  after.columnWrites.filter((c) => c.role !== "service_role").every((c) => !c.col_insert && !c.col_update) &&
  ["SELECT", "INSERT", "UPDATE", "DELETE"].every((p) => granted("service_role", p) === true) &&
  probe === "denied (42501)";
console.log(
  ok
    ? "VERIFIED: update policy gone; anon/authenticated hold SELECT only (no column writes); service_role reads + writes; signed-in UPDATE refused — OK"
    : "VERIFICATION FAILED — inspect the output above",
);
await client.end();
process.exit(ok ? 0 : 2);
