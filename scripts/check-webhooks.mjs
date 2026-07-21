import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8")
    .split("\n").filter(l => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")]; })
);

const key = env.STRIPE_SECRET_KEY;
console.log("Local key mode :", key?.startsWith("sk_test_") ? "TEST" : key?.startsWith("sk_live_") ? "LIVE" : "MISSING");
console.log("Webhook secret :", env.STRIPE_WEBHOOK_SECRET ? `present (${env.STRIPE_WEBHOOK_SECRET.slice(0,8)}...)` : "MISSING");

const stripe = new Stripe(key, { apiVersion: "2026-01-28.clover" });
const eps = await stripe.webhookEndpoints.list({ limit: 20 });

console.log(`\nWebhook endpoints in THIS mode: ${eps.data.length}`);
for (const e of eps.data) {
  console.log(`\n  ${e.url}`);
  console.log(`    status : ${e.status}`);
  console.log(`    id     : ${e.id}`);
  console.log(`    events : ${e.enabled_events.join(", ")}`);
  const need = ["payment_intent.amount_capturable_updated", "payment_intent.canceled"];
  const has = e.enabled_events.includes("*");
  const missing = has ? [] : need.filter(n => !e.enabled_events.includes(n));
  console.log(`    MISSING for this release: ${missing.length ? missing.join(", ") : "none"}`);
}
