import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname,"..",".env.local"),"utf8")
  .split("\n").filter(l=>l.trim()&&!l.trim().startsWith("#")&&l.includes("="))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
const anon = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth:{persistSession:false} });

const PENDING_COLS = "stripe_payment_intent_id,location_id,costs_token,from_date,to_date,parking_type_id,customer,vehicle,extra_fields,confirmation_params,location_name,location_address,airport_code,subtotal,tax_total,fees_total,grand_total,triply_service_fee,user_id,has_protection_plan,status,reslab_reservation_number,reslab_attempt_started_at,claimed_at,last_error,email_sent,livemode,created_at,updated_at";
const CART_COLS = "id,cart_key,stripe_payment_intent_id,claimed_at,released_at,livemode";

async function colCheck(table, cols) {
  const { error } = await svc.from(table).select(cols).limit(1);
  console.log(error ? `  FAIL ${table}: ${error.message}` : `  OK   ${table}: all ${cols.split(",").length} columns exist`);
}
async function anonCheck(table) {
  const { data, error } = await anon.from(table).select("*").limit(1);
  if (error) console.log(`  OK   ${table}: anon DENIED (${error.message.slice(0,60)})`);
  else if (!data?.length) console.log(`  OK   ${table}: anon returned 0 rows (RLS no-policy deny)`);
  else console.log(`  FAIL ${table}: anon READ ${data.length} ROW(S) — PII EXPOSED`);
}

console.log("=== column/code agreement (service role) ===");
await colCheck("pending_bookings", PENDING_COLS);
await colCheck("cart_claims", CART_COLS);

console.log("\n=== RLS: anon must not read (tables hold customer PII) ===");
await anonCheck("pending_bookings");
await anonCheck("cart_claims");

console.log("\n=== status CHECK constraint (invalid value must be rejected) ===");
const { error: badStatus } = await svc.from("pending_bookings").insert({
  stripe_payment_intent_id:"pi_verify015_bogus", location_id:1, from_date:"2026-01-01 10:00:00",
  to_date:"2026-01-02 10:00:00", parking_type_id:1, customer:{}, vehicle:{},
  has_protection_plan:false, livemode:false, status:"not_a_real_status" });
console.log(badStatus?.code === "23514"
  ? "  OK   invalid status rejected by CHECK constraint"
  : `  FAIL expected 23514 check_violation, got: ${badStatus?.code ?? "INSERT SUCCEEDED"} ${badStatus?.message ?? ""}`);
await svc.from("pending_bookings").delete().eq("stripe_payment_intent_id","pi_verify015_bogus");
