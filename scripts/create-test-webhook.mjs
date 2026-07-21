import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import Stripe from "stripe";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname,"..",".env.local"),"utf8")
  .split("\n").filter(l=>l.trim()&&!l.trim().startsWith("#")&&l.includes("="))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));

const key = env.STRIPE_SECRET_KEY;
if (!key?.startsWith("sk_test_")) { console.error("Refusing: not a test key."); process.exit(1); }
const stripe = new Stripe(key, { apiVersion: "2026-01-28.clover" });

const EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.amount_capturable_updated",
  "payment_intent.canceled",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
];

const existing = await stripe.webhookEndpoints.list({ limit: 20 });
const dupe = existing.data.find(e => e.url.includes("staging.triplypro.com"));
if (dupe) {
  console.log(`Already exists: ${dupe.id} -> ${dupe.url}`);
  console.log(`Events: ${dupe.enabled_events.join(", ")}`);
  process.exit(0);
}

const ep = await stripe.webhookEndpoints.create({
  url: "https://staging.triplypro.com/api/webhooks/stripe",
  enabled_events: EVENTS,
  description: "Triply staging — booking fulfilment",
  api_version: "2026-01-28.clover",
});

console.log("CREATED (test mode)");
console.log(`  id     : ${ep.id}`);
console.log(`  url    : ${ep.url}`);
console.log(`  status : ${ep.status}`);
console.log(`  events : ${ep.enabled_events.length} (${ep.enabled_events.join(", ")})`);
console.log("\n  SIGNING SECRET (test mode — put in Vercel PREVIEW as STRIPE_WEBHOOK_SECRET):");
console.log(`  ${ep.secret}`);
