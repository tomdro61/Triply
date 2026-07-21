/**
 * B1 — Stripe manual-capture behaviour matrix.
 *
 * Prerequisite for Phase 2 of the payment<->booking atomicity fix
 * (notes/2026-07-17-payment-booking-atomicity-plan.md §9.1 B1/B3).
 *
 * Answers, empirically rather than from docs:
 *   1. Which payment methods does Stripe still offer when capture_method is
 *      manual? (A method filtered out of the PaymentElement cannot be used at
 *      all; a method that renders but auto-captures gets charge-then-refund
 *      semantics instead of atomicity.)
 *   2. What PI status does a confirmed card land on -- requires_capture, or
 *      processing? Deferred capture is only possible from requires_capture.
 *   3. Does the top-level manual flag differ from
 *      payment_method_options.card.capture_method? (The B3 decision.)
 *
 * TEST MODE ONLY. Refuses to run against a live key -- it confirms real
 * PaymentIntents, which on a live key would be real authorizations.
 *
 *   node scripts/b1-capture-matrix.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env.local");

const env = Object.fromEntries(
  fs
    .readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const key = env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY not found in triply/.env.local");
  process.exit(1);
}
if (!key.startsWith("sk_test_")) {
  console.error(
    "REFUSING TO RUN: key is not sk_test_*. This script confirms PaymentIntents;\n" +
      "against a live key that would create real authorizations on real cards."
  );
  process.exit(1);
}

const stripe = new Stripe(key, { apiVersion: "2026-01-28.clover" });

const AMOUNT = 10307; // yb3246's actual charge, in cents -- realistic bucket
const BASE_METADATA = { b1_probe: "true", note: "B1 capture matrix probe" };

async function methodsOffered(label, extra) {
  const pi = await stripe.paymentIntents.create({
    amount: AMOUNT,
    currency: "usd",
    automatic_payment_methods: { enabled: true },
    metadata: BASE_METADATA,
    ...extra,
  });
  console.log(`\n[${label}]`);
  console.log(`  capture_method : ${pi.capture_method}`);
  console.log(`  status         : ${pi.status}`);
  console.log(`  methods offered: ${pi.payment_method_types.join(", ")}`);
  return pi;
}

async function confirmWith(label, testPaymentMethod, extra) {
  let pi = await stripe.paymentIntents.create({
    amount: AMOUNT,
    currency: "usd",
    payment_method_types: ["card"],
    metadata: BASE_METADATA,
    ...extra,
  });
  try {
    pi = await stripe.paymentIntents.confirm(pi.id, {
      payment_method: testPaymentMethod,
      return_url: "https://www.triplypro.com/checkout/complete",
    });
    console.log(`\n[${label}] ${testPaymentMethod}`);
    console.log(`  status            : ${pi.status}`);
    console.log(`  amount_capturable : ${pi.amount_capturable}`);
    console.log(`  amount_received   : ${pi.amount_received}`);
    if (pi.next_action) console.log(`  next_action       : ${pi.next_action.type}`);

    // Only requires_capture can be captured. Prove capture works from here.
    if (pi.status === "requires_capture") {
      const captured = await stripe.paymentIntents.capture(pi.id, {
        idempotencyKey: `b1-capture:${pi.id}`,
      });
      console.log(`  -> after capture  : ${captured.status} (received ${captured.amount_received})`);
      // Leave no test money captured.
      await stripe.refunds.create({ payment_intent: pi.id });
      console.log(`  -> refunded (probe cleanup)`);
    }
    return pi;
  } catch (err) {
    console.log(`\n[${label}] ${testPaymentMethod}`);
    console.log(`  THREW: ${err.code || err.type} -- ${err.message}`);
    return pi;
  }
}

async function main() {
  console.log("=== B1: Stripe manual-capture matrix (TEST MODE) ===");

  // --- Part 1: which methods survive each capture configuration ---
  const auto = await methodsOffered("A. automatic capture (today's config)", {});
  const manual = await methodsOffered("B. top-level capture_method: manual", {
    capture_method: "manual",
  });
  const cardOnly = await methodsOffered("C. card-only manual (payment_method_options)", {
    payment_method_options: { card: { capture_method: "manual" } },
  });

  const lost = auto.payment_method_types.filter(
    (m) => !manual.payment_method_types.includes(m)
  );
  console.log(
    `\n  >> Methods LOST under top-level manual: ${lost.length ? lost.join(", ") : "(none)"}`
  );
  const lostCardOnly = auto.payment_method_types.filter(
    (m) => !cardOnly.payment_method_types.includes(m)
  );
  console.log(
    `  >> Methods LOST under card-only manual : ${
      lostCardOnly.length ? lostCardOnly.join(", ") : "(none)"
    }`
  );

  // --- Part 2: what status does a confirmed card actually reach ---
  await confirmWith("D. plain visa, manual capture", "pm_card_visa", {
    capture_method: "manual",
  });
  await confirmWith("E. plain visa, card-only manual", "pm_card_visa", {
    payment_method_options: { card: { capture_method: "manual" } },
  });
  await confirmWith("F. 3DS-required card, manual capture", "pm_card_threeDSecure2Required", {
    capture_method: "manual",
  });
  await confirmWith("G. plain visa, AUTOMATIC capture (control)", "pm_card_visa", {});

  console.log("\n=== done ===");
  console.log(
    "Cancel any leftover uncaptured probe holds in the Stripe TEST dashboard\n" +
      "(search metadata b1_probe=true) -- they expire on their own in ~7 days."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
