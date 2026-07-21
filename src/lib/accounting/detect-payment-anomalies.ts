/**
 * Payment→booking anomaly detector.
 *
 * The invariant this enforces: every SUCCEEDED Stripe charge that retained
 * money (not fully refunded) MUST have a corresponding booking row, and no
 * customer should hold more successful charges than bookings.
 *
 * Reads Stripe (live in prod) + Supabase, cross-checks, and returns any
 * violations. Read-only — never writes. Used by the daily cron
 * (/api/cron/reconcile-payments) so a "charged but no booking" gap is caught
 * within a day instead of via a chargeback (see the July 2026 incident:
 * 7 orphan charges + double-charges surfaced only through customer disputes).
 */
import Stripe from "stripe";
import { stripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/server";
import { isAtTestLot } from "@/config/admin";

export interface OrphanCharge {
  paymentIntentId: string;
  createdISO: string;
  amount: number; // net retained (charge − refunds), dollars
  email: string;
  method: string;
  disputed: boolean;
  /** true = created by our checkout (has lotId metadata); false = likely a
   *  manual Stripe Payment Link (supplemental charge) — lower priority. */
  fromCheckout: boolean;
}

export interface DoubleCharge {
  email: string;
  charges: number;
  bookings: number;
  spanMinutes: number;
  paymentIntentIds: string[];
  amounts: number[];
}

export interface AnomalyReport {
  windowDays: number;
  stripeLivemode: boolean;
  scannedPaymentIntents: number;
  succeededRetained: number;
  /** succeeded + retained + NO booking + came from checkout — real bugs. */
  orphans: OrphanCharge[];
  /** succeeded + retained + NO booking + NOT from checkout — likely manual links. */
  possibleManualCharges: OrphanCharge[];
  /** same card/email, more retained charges than bookings — unresolved double-charge. */
  doubleCharges: DoubleCharge[];
  /**
   * Same cart (email + lot + dates) booked twice under DIFFERENT PaymentIntents.
   * Invisible to `doubleCharges`, whose `charges > bookings` test is false when
   * both charges produced a booking row.
   */
  duplicateBookings: DuplicateCartBooking[];
}

export interface DuplicateCartBooking {
  email: string;
  reservationNumbers: string[];
  paymentIntentIds: string[];
}

function methodOf(ch: Stripe.Charge | null): string {
  const d = ch?.payment_method_details;
  if (!d) return "unknown";
  if (d.type === "card") return d.card?.wallet?.type || d.card?.brand || "card";
  return d.type || "unknown";
}

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

export async function detectPaymentAnomalies(windowDays = 14): Promise<AnomalyReport> {
  // Use the request timestamp for the window bound. Date.now() is a runtime
  // API — fine in a server route/lib (the purity lint only flags it in
  // React components).
  const sinceUnix = Math.floor(Date.now() / 1000) - windowDays * 86400;

  // 1) Pull PaymentIntents created in the window (auto-paginates; ~dozens/2wk).
  const pis: Stripe.PaymentIntent[] = [];
  for await (const pi of stripe.paymentIntents.list({
    created: { gte: sinceUnix },
    limit: 100,
    expand: ["data.latest_charge"],
  })) {
    pis.push(pi);
  }

  // 2) Match against bookings by the exact PI ids (avoids window-boundary
  //    mismatches where a booking's created_at sits just outside the window).
  const piIds = pis.map((p) => p.id);
  const bookedPI = new Set<string>();
  if (piIds.length > 0) {
    const supabase = await createAdminClient();
    const { data: bookings, error } = await supabase
      .from("bookings")
      .select("stripe_payment_intent_id")
      .in("stripe_payment_intent_id", piIds);
    if (error) throw new Error(`Supabase bookings lookup failed: ${error.message}`);
    for (const b of bookings ?? []) {
      if (b.stripe_payment_intent_id) bookedPI.add(b.stripe_payment_intent_id);
    }
  }

  // 2b) Same-cart double BOOKINGS.
  //
  // The `charges > bookings` rule below cannot see these: when a customer is
  // charged twice and BOTH charges produce a booking row, the group is balanced
  // (2 > 2 is false) and the whole thing is invisible. That is exactly the shape
  // an async payment settling after its cart lock expired produces — two real
  // ResLab reservations, two captures, one customer.
  const duplicateBookings: DuplicateCartBooking[] = [];
  {
    const supabase = await createAdminClient();
    const sinceISO = new Date(sinceUnix * 1000).toISOString();
    const { data: recent, error } = await supabase
      .from("bookings")
      .select(
        "reslab_reservation_number, stripe_payment_intent_id, reslab_location_id, check_in, check_out, created_at, customers!inner(email)"
      )
      .eq("status", "confirmed")
      .gte("created_at", sinceISO);
    if (error) {
      throw new Error(`Supabase duplicate-cart lookup failed: ${error.message}`);
    }

    const byCart = new Map<string, typeof recent>();
    for (const b of recent ?? []) {
      // Triply-prod is shared by staging and production, and `bookings` has no
      // livemode column. Testers exercising this very feature book the same cart
      // repeatedly under different test PaymentIntents, which would otherwise
      // become "duplicate bookings" on the production cron run. Same test-lot
      // exclusion the charge rows above already use.
      if (b.reslab_location_id != null && isAtTestLot(b.reslab_location_id)) {
        continue;
      }
      const email = (b.customers as unknown as { email: string })?.email ?? "";
      const key = [
        email.toLowerCase(),
        b.reslab_location_id,
        b.check_in,
        b.check_out,
      ].join("|");
      const g = byCart.get(key);
      if (g) g.push(b);
      else byCart.set(key, [b]);
    }

    for (const [key, group] of byCart) {
      const distinctPIs = new Set(
        group.map((b) => b.stripe_payment_intent_id).filter(Boolean)
      );
      if (group.length >= 2 && distinctPIs.size >= 2) {
        duplicateBookings.push({
          email: key.split("|")[0],
          reservationNumbers: group.map((b) => b.reslab_reservation_number),
          paymentIntentIds: [...distinctPIs] as string[],
        });
      }
    }
  }

  // 3) Normalize + classify.
  type Row = {
    id: string;
    created: number;
    netRetained: number; // dollars
    email: string;
    method: string;
    fingerprint: string;
    disputed: boolean;
    fromCheckout: boolean;
    testLot: boolean;
    hasBooking: boolean;
  };
  const rows: Row[] = pis
    .filter((pi) => pi.status === "succeeded")
    .map((pi) => {
      const ch =
        pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
      const card = ch?.payment_method_details?.card;
      const locationId = pi.metadata?.locationId ? parseInt(pi.metadata.locationId, 10) : null;
      return {
        id: pi.id,
        created: pi.created,
        netRetained: (pi.amount - (ch?.amount_refunded || 0)) / 100,
        email: pi.metadata?.customerEmail || ch?.billing_details?.email || pi.receipt_email || "",
        method: methodOf(ch),
        fingerprint: card?.fingerprint || "",
        disputed: ch?.disputed || false,
        fromCheckout: !!pi.metadata?.lotId,
        testLot: locationId != null && isAtTestLot(locationId),
        hasBooking: bookedPI.has(pi.id),
      };
    })
    .filter((r) => !r.testLot); // ignore test-lot charges

  const retained = rows.filter((r) => r.netRetained > 0);

  // Orphans: retained, no booking. Split checkout vs likely-manual.
  const orphans: OrphanCharge[] = [];
  const possibleManualCharges: OrphanCharge[] = [];
  for (const r of retained) {
    if (r.hasBooking) continue;
    const entry: OrphanCharge = {
      paymentIntentId: r.id,
      createdISO: iso(r.created),
      amount: r.netRetained,
      email: r.email,
      method: r.method,
      disputed: r.disputed,
      fromCheckout: r.fromCheckout,
    };
    (r.fromCheckout ? orphans : possibleManualCharges).push(entry);
  }

  // Double-charges: group retained by card fingerprint (fallback email);
  // flag groups holding MORE charges than bookings (an unresolved duplicate).
  const groups = new Map<string, Row[]>();
  for (const r of retained) {
    // Group by customer EMAIL first — it's stable across payment methods. Card
    // fingerprints are NOT: the same card via Apple/Google Pay carries a
    // device token with a different fingerprint than the card entered manually,
    // so fingerprint-first grouping would split a wallet-then-card double-charge
    // by the same customer and miss it. Checkout always stamps customerEmail.
    const key = r.email
      ? `em:${r.email.toLowerCase()}`
      : r.fingerprint
      ? `fp:${r.fingerprint}`
      : `id:${r.id}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const doubleCharges: DoubleCharge[] = [];
  for (const g of groups.values()) {
    const bookingsInGroup = g.filter((r) => r.hasBooking).length;
    if (g.length >= 2 && g.length > bookingsInGroup) {
      const sorted = g.slice().sort((a, b) => a.created - b.created);
      doubleCharges.push({
        email: sorted[0].email,
        charges: sorted.length,
        bookings: bookingsInGroup,
        spanMinutes: Math.round((sorted[sorted.length - 1].created - sorted[0].created) / 60),
        paymentIntentIds: sorted.map((r) => r.id),
        amounts: sorted.map((r) => r.netRetained),
      });
    }
  }

  return {
    windowDays,
    // Derived from the KEY, not from the results. Reading `pis[0].livemode` made
    // this false whenever the list came back empty — which is precisely the case
    // the route's zero-scan escalation exists to catch, so that guard
    // (`stripeLivemode && scannedPaymentIntents === 0`) could never fire. A
    // rotated or broken Stripe key reported a clean run.
    stripeLivemode: (process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live_"),
    scannedPaymentIntents: pis.length,
    succeededRetained: retained.length,
    orphans: orphans.sort((a, b) => a.createdISO.localeCompare(b.createdISO)),
    possibleManualCharges,
    doubleCharges,
    duplicateBookings,
  };
}
