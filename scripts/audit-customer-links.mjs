// Audit: customers rows whose user_id points at an auth user whose (verified)
// email is NOT the row's email. Before the 2026-09-24 fix, fulfilment wrote a
// client-supplied userId onto an email-matched customers row, so such rows
// are exactly what an account-takeover attempt — or an innocent "booked for
// my spouse while signed in" — would leave behind. READ-ONLY: prints the rows
// and the SQL to unlink them; run the SQL by hand after eyeballing the list.
//
//   node scripts/audit-customer-links.mjs
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config({ path: ".env.local" });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const norm = (e) => (e ?? "").trim().toLowerCase();

// PostgREST caps a response at 1,000 rows by default — page explicitly so a
// grown customers table can't silently truncate the audit.
const customers = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("customers")
    .select("id, email, user_id, created_at")
    .not("user_id", "is", null)
    // Page on the unique key: created_at is non-unique and nullable, so ties
    // could land on two pages or none.
    .order("id", { ascending: true })
    .range(from, from + 999);
  if (error) throw error;
  customers.push(...data);
  if (data.length < 1000) break;
}

const users = new Map();
for (let page = 1; ; page++) {
  const { data, error: uerr } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
  if (uerr) throw uerr;
  for (const u of data.users) users.set(u.id, u);
  // GoTrue returns an empty page past the end; also stop on a short page.
  if (data.users.length === 0 || data.users.length < 1000) break;
}

const mismatches = [];
const orphans = [];
for (const c of customers) {
  const u = users.get(c.user_id);
  if (!u) { orphans.push(c); continue; }
  if (norm(u.email) !== norm(c.email)) mismatches.push({ c, u });
}

console.log(`customers with user_id: ${customers.length}; auth users: ${users.size}`);
console.log(`mismatched links: ${mismatches.length}; links to a deleted auth user: ${orphans.length}\n`);
for (const { c, u } of mismatches) {
  console.log(`customer ${c.id}  email=${c.email}  <-  user ${u.id} (${u.email}, confirmed=${Boolean(u.email_confirmed_at)})  since ${(c.created_at ?? "unknown").slice(0, 10)}`);
}
for (const c of orphans) console.log(`customer ${c.id}  email=${c.email}  ->  user_id ${c.user_id} no longer exists`);

// Only the mismatches go in the SQL. `customers.user_id` references
// auth.users ON DELETE SET NULL, so a true orphan cannot exist; one showing
// up here means the auth listing was incomplete — investigate, don't unlink.
if (orphans.length > 0) {
  console.log("\n!! links to unknown auth users found — the auth listing may be incomplete; NOT included in the SQL below.");
}
const ids = mismatches.map((m) => m.c.id);
if (ids.length > 0) {
  console.log("\n-- To unlink (review the list first; the account can re-claim via the verified-email flow):");
  console.log(`UPDATE customers SET user_id = NULL WHERE id IN (${ids.map((id) => `'${id}'`).join(", ")});`);
}
