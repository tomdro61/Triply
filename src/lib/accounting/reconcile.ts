/**
 * Revenue reconciliation for Triply unit economics + ResLab invoice matching.
 *
 * Pulls bookings from Supabase, optionally cross-checks each against:
 *   - ResLab (authoritative settlement view: channel_total / location_total
 *     / commissions_total)
 *   - Stripe (authoritative cash flow: amount_received / amount_refunded)
 *
 * Used by:
 *   - GET /api/admin/accounting (admin UI)
 *   - scripts/reconcile-revenue.mjs (CLI; will migrate to import this)
 *
 * Money model (see src/app/api/admin/bookings/cancel/route.ts:126-135):
 *   - Service fee is non-refundable. Refunded bookings retain triply_service_fee.
 *   - PG auto-cancels on full refund — no wholesale owed for refunded opt-ins.
 *   - PG wholesale is contractual: $6 × confirmed opt-ins (regardless of retail).
 *   - ResLab invoices by trip-completion month: sum location_total for
 *     bookings whose check_out falls within the invoice period.
 *
 * Stripe fetch:
 *   Lib calls Stripe PaymentIntent (+ latest_charge) per booking in parallel
 *   (concurrency 5). Production Vercel env has live keys; local dev test
 *   keys will fail the lookups, in which case the lib falls back to the
 *   derived expectedStripe (parking_online + service_fee + pg_premium) and
 *   sets `stripe.isDerived = true` so the UI surfaces the caveat. With live
 *   keys, Stripe figures are authoritative — promo discounts, partial
 *   refunds, and dispute reversals all reflect correctly.
 */

import { stripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/server";
import { isAtTestLot } from "@/config/admin";
import type {
  DateField,
  ReconcileOptions,
  BookingDetail,
  ReconcileResult,
  TakeRates,
} from "./types";

export type { DateField, ReconcileOptions, BookingDetail, ReconcileResult, TakeRates };

const PG_WHOLESALE = 6.0;
const RESLAB_CONCURRENCY = 5;
const STRIPE_CONCURRENCY = 5;

const DATE_COLUMN: Record<DateField, string> = {
  created: "created_at",
  checkout: "check_out",
  checkin: "check_in",
};

interface ReslabHistoryEntry {
  location_total?: number | string;
  channel_total?: number | string;
  commissions_total?: number | string;
  grand_total?: number | string;
  refund_amount?: number | string;
  partial_refund?: number | string;
  due_at_location_total?: number | string;
}
interface ReslabResponse {
  cancelled?: number | boolean;
  history?: ReslabHistoryEntry[];
}

async function reslabAuth(): Promise<string> {
  const url = process.env.RESLAB_API_URL || "https://api.reservationslab.com/v1";
  const res = await fetch(`${url}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: process.env.RESLAB_API_KEY,
      domain: process.env.RESLAB_API_DOMAIN || "triplypro.com",
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ResLab auth ${res.status}`);
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error("ResLab auth missing token");
  return json.token;
}

async function reslabReservation(resNum: string, token: string): Promise<ReslabResponse> {
  const url = process.env.RESLAB_API_URL || "https://api.reservationslab.com/v1";
  const res = await fetch(`${url}/reservations/${resNum}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ResLab ${res.status} on ${resNum}`);
  return (await res.json()) as ReslabResponse;
}

/**
 * Run fetches with a concurrency cap. Preserves input order in output.
 *
 * Contract: `fn` MUST NOT throw. If a per-item failure is possible, the
 * caller catches inside `fn` and returns a structured error sentinel.
 * A throw here would abort `Promise.all(workers)` and lose in-flight
 * results from the other N-1 workers.
 *
 * The `const idx = i++` increment is atomic w.r.t. the JS event loop — a
 * post-increment expression evaluates as one synchronous step, so each
 * worker claims a unique index even with N parallel workers. Do NOT split
 * it into `const idx = i; i++;` "for clarity" — that would race.
 *
 * Per-worker side effects (e.g., `arr.push(x)` to an outer collector) are
 * safe under the same single-threaded model — `push` is one synchronous
 * call. Do NOT replace with non-atomic compound operations like
 * `arr = arr.concat(x)` — that would race.
 */
async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++; // atomic; see contract above
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

const num = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

type CustomersJoin = { email?: string | null } | null;
interface SupabaseRow {
  id: string;
  reslab_reservation_number: string;
  status: string;
  created_at: string;
  check_in: string;
  check_out: string;
  grand_total: string | number | null;
  subtotal: string | number | null;
  due_at_location: string | number | null;
  triply_service_fee: string | number | null;
  protection_plan: string | null;
  protection_plan_price: string | number | null;
  pg_identifier: string | null;
  stripe_payment_intent_id: string | null;
  reslab_location_id: number | null;
  location_name: string | null;
  airport_code: string | null;
  customers: CustomersJoin | CustomersJoin[];
}

const oneCustomer = (c: CustomersJoin | CustomersJoin[]): CustomersJoin =>
  Array.isArray(c) ? (c[0] ?? null) : c;

export async function reconcileRevenue(opts: ReconcileOptions): Promise<ReconcileResult> {
  const supabase = await createAdminClient();
  const dateCol = DATE_COLUMN[opts.by];

  // Test-booking filter: lot-id-based (aligned with /api/admin/stats post-
  // 2026-06-01). A booking is excluded iff it's at a TEST ResLab lot id.
  const { data: rows, error } = await supabase
    .from("bookings")
    .select(
      `
      id, reslab_reservation_number, status, created_at, check_in, check_out,
      grand_total, subtotal, due_at_location, triply_service_fee,
      protection_plan, protection_plan_price, pg_identifier,
      stripe_payment_intent_id,
      reslab_location_id, location_name, airport_code,
      customers ( email )
    `
    )
    .gte(dateCol, `${opts.from}T00:00:00Z`)
    .lte(dateCol, `${opts.to}T23:59:59.999Z`)
    .order(dateCol, { ascending: true })
    .returns<SupabaseRow[]>();

  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  const allRows: SupabaseRow[] = rows ?? [];

  const real: SupabaseRow[] = [];
  let testExcluded = 0;
  for (const b of allRows) {
    if (isAtTestLot(b.reslab_location_id)) {
      testExcluded++;
      continue;
    }
    real.push(b);
  }

  // ---- ResLab + Stripe fetches (concurrent batches, each gated by flag) ----

  type ReslabSlice = {
    locationTotal: number | null;
    channelTotal: number | null;
    commissionsTotal: number | null;
    grandTotal: number | null;
    refundAmount: number | null;
    partialRefund: number | null;
    cancelled: boolean | null;
    error: string | null;
  };
  const emptyReslab: ReslabSlice = {
    locationTotal: null,
    channelTotal: null,
    commissionsTotal: null,
    grandTotal: null,
    refundAmount: null,
    partialRefund: null,
    cancelled: null,
    error: null,
  };

  type StripeSlice = {
    amountReceived: number | null;
    amountRefunded: number | null;
    fee: number | null; // balance_transaction.fee (original capture fee)
    status: string | null;
    error: string | null;
  };
  const emptyStripe: StripeSlice = {
    amountReceived: null,
    amountRefunded: null,
    fee: null,
    status: null,
    error: null,
  };

  const reslabFetchErrors: ReconcileResult["reslab"]["fetchErrors"] = [];
  const stripeFetchErrors: ReconcileResult["stripeFetch"]["errors"] = [];

  const reslabPromise = (async (): Promise<ReslabSlice[]> => {
    if (!opts.includeReslab || real.length === 0) return real.map(() => ({ ...emptyReslab }));
    const token = await reslabAuth();
    return withConcurrency(real, RESLAB_CONCURRENCY, async (b) => {
      if (!b.reslab_reservation_number) return { ...emptyReslab };
      try {
        const data = await reslabReservation(b.reslab_reservation_number, token);
        const h = data.history?.[0];
        if (!h) {
          // Also push to fetchErrors so the strict-mode guard's "—" headline
          // has a visible diagnostic in the UI. Otherwise the user sees "—"
          // with no warning anywhere.
          reslabFetchErrors.push({
            resNum: b.reslab_reservation_number,
            err: "no history[0] in response",
          });
          return { ...emptyReslab, error: "no history[0] in response" };
        }
        return {
          locationTotal: num(h.location_total),
          channelTotal: num(h.channel_total),
          commissionsTotal: num(h.commissions_total),
          grandTotal: num(h.grand_total),
          refundAmount: num(h.refund_amount),
          partialRefund: num(h.partial_refund),
          cancelled: !!data.cancelled,
          error: null,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reslabFetchErrors.push({ resNum: b.reslab_reservation_number, err: msg });
        return { ...emptyReslab, error: msg };
      }
    });
  })();

  const stripePromise = (async (): Promise<StripeSlice[]> => {
    if (!opts.includeStripe || real.length === 0) return real.map(() => ({ ...emptyStripe }));
    if (!process.env.STRIPE_SECRET_KEY) {
      return real.map(() => ({ ...emptyStripe, error: "STRIPE_SECRET_KEY missing" }));
    }
    return withConcurrency(real, STRIPE_CONCURRENCY, async (b) => {
      if (!b.stripe_payment_intent_id) return { ...emptyStripe };
      try {
        const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id, {
          // Expand balance_transaction so we can read the original Stripe
          // processing fee directly (no second API call). The fee value
          // is the original capture fee — does NOT subtract fee refunds
          // on cancelled charges (Stripe sometimes returns the fee for
          // full refunds; capturing that requires summing the charge's
          // full balance-transaction history, deferred for MVP).
          expand: ["latest_charge.balance_transaction"],
        });
        const charge =
          pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
        const bt =
          charge?.balance_transaction && typeof charge.balance_transaction === "object"
            ? charge.balance_transaction
            : null;
        return {
          amountReceived: (pi.amount_received || 0) / 100,
          amountRefunded: charge ? (charge.amount_refunded || 0) / 100 : 0,
          fee: bt ? (bt.fee || 0) / 100 : null,
          status: pi.status,
          error: null,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        stripeFetchErrors.push({ resNum: b.reslab_reservation_number, err: msg });
        return { ...emptyStripe, error: msg };
      }
    });
  })();

  const [reslabSlices, stripeSlices] = await Promise.all([reslabPromise, stripePromise]);

  // ---- Per-booking detail + aggregation ----

  const bookings: BookingDetail[] = [];
  const grandTotalMismatches: ReconcileResult["reslab"]["grandTotalMismatches"] = [];

  const counts = { confirmed: 0, refunded: 0, cancelled: 0, other: 0 };
  let grossRevenue = 0; // SUM(grand_total) for confirmed (incl. due-at-lot)
  let confParkingOnline = 0;
  let confParkingSubtotal = 0;
  let confDueAtLot = 0;
  let confServiceFee = 0;
  let confPGPremium = 0;
  let confPGOptIns = 0;
  let confPGMarginPerRow = 0;
  let confLocTotal = 0;
  let confChannelTotal = 0;
  let confCommissionsTotal = 0;
  let confReslabSeen = 0;
  let refServiceFee = 0;
  let refParkingRefunded = 0;
  let refPGRefunded = 0;
  let refPGOptIns = 0;
  let stripeGrossReal = 0;
  let stripeRefundedReal = 0;
  let stripeGrossDerived = 0;
  let stripeRefundedDerived = 0;
  let stripeFetched = 0;
  let stripeDerivedFallbacks = 0;
  // Stripe processing fees absorbed by Triply (sum of balance_transaction.fee
  // across real Stripe fetches). Tracks per-booking fee availability so the
  // aggregate is null if any contributing booking is missing fee data.
  let stripeFeesReal = 0;
  let stripeFeesMissing = 0;

  for (let idx = 0; idx < real.length; idx++) {
    const b = real[idx];
    const rl = reslabSlices[idx] ?? emptyReslab;
    const st = stripeSlices[idx] ?? emptyStripe;

    const grandTotal = num(b.grand_total);
    const subtotal = num(b.subtotal);
    const dueAtLot = num(b.due_at_location);
    const parkingOnline = Math.max(0, grandTotal - dueAtLot);
    const serviceFee = num(b.triply_service_fee);
    const pgPremium = num(b.protection_plan_price);
    const hasPG = !!b.protection_plan;
    const expectedStripe = parkingOnline + serviceFee + pgPremium;

    const stripeReceivedReal = st.amountReceived;
    const stripeRefundedRow = st.amountRefunded;
    const stripeFeeRow = st.fee;
    const usedRealStripe = opts.includeStripe && stripeReceivedReal !== null;
    if (opts.includeStripe) {
      if (usedRealStripe) {
        stripeFetched++;
        if (stripeFeeRow !== null) stripeFeesReal += stripeFeeRow;
        // Missing fee on a real fetch happens when the PI has no
        // latest_charge (abandoned/uncaptured) — fee genuinely is 0
        // for those, so only count missing when amountReceived > 0.
        else if (stripeReceivedReal > 0) stripeFeesMissing++;
      } else if (b.stripe_payment_intent_id) stripeDerivedFallbacks++;
    }

    const bothAgreeCancelled =
      (b.status === "refunded" || b.status === "cancelled") &&
      (rl.cancelled === true || rl.grandTotal === 0);
    if (
      opts.includeReslab &&
      rl.grandTotal !== null &&
      !bothAgreeCancelled &&
      Math.abs(rl.grandTotal - grandTotal) > 0.01
    ) {
      grandTotalMismatches.push({
        resNum: b.reslab_reservation_number,
        supabase: grandTotal,
        reslab: rl.grandTotal,
        diff: grandTotal - rl.grandTotal,
      });
    }

    let triplyKeeps = 0; // service fee + PG margin (on-top charges)
    let triplyTotal: number | null = 0; // channel + fee + PG margin (full keep)
    let note = "";

    if (b.status === "confirmed") {
      counts.confirmed++;
      grossRevenue += grandTotal;
      confParkingOnline += parkingOnline;
      confParkingSubtotal += subtotal;
      confDueAtLot += dueAtLot;
      confServiceFee += serviceFee;
      if (hasPG) {
        confPGPremium += pgPremium;
        confPGOptIns += 1;
        confPGMarginPerRow += pgPremium - PG_WHOLESALE;
      }
      if (opts.includeReslab && rl.locationTotal !== null) {
        confLocTotal += rl.locationTotal;
        confChannelTotal += rl.channelTotal ?? 0;
        confCommissionsTotal += rl.commissionsTotal ?? 0;
        confReslabSeen++;
      }
      if (usedRealStripe) {
        stripeGrossReal += stripeReceivedReal;
        stripeRefundedReal += stripeRefundedRow ?? 0;
      } else {
        stripeGrossDerived += expectedStripe;
      }
      triplyKeeps = serviceFee + (hasPG ? pgPremium - PG_WHOLESALE : 0);
      // Total keep = channel commission + on-top charges. Null when we
      // can't compute channel (no ResLab data for this row) — the UI/CSV
      // shows "—" in that case rather than an under-counted number.
      triplyTotal =
        rl.channelTotal !== null ? rl.channelTotal + triplyKeeps : null;
      if (hasPG && pgPremium < PG_WHOLESALE) {
        note =
          (note ? note + "; " : "") +
          `PG underwater: premium $${pgPremium.toFixed(2)} < wholesale $${PG_WHOLESALE.toFixed(2)}`;
      }
    } else if (b.status === "refunded") {
      counts.refunded++;
      refServiceFee += serviceFee;
      refParkingRefunded += parkingOnline;
      if (hasPG) {
        refPGRefunded += pgPremium;
        refPGOptIns += 1;
      }
      if (usedRealStripe) {
        stripeGrossReal += stripeReceivedReal;
        stripeRefundedReal += stripeRefundedRow ?? 0;
      } else {
        stripeGrossDerived += expectedStripe;
        stripeRefundedDerived += Math.max(0, expectedStripe - serviceFee);
      }
      triplyKeeps = serviceFee;
      // Refunded: channel was refunded along with parking; PG was
      // refunded along with the premium → no channel/PG kept.
      triplyTotal = serviceFee;
      note = "service fee retained";
    } else if (b.status === "cancelled") {
      counts.cancelled++;
      note = "no payment captured";
    } else {
      counts.other++;
    }
    if (rl.error) note = (note ? note + "; " : "") + `reslab error: ${rl.error}`;
    if (st.error) note = (note ? note + "; " : "") + `stripe error: ${st.error}`;

    const customer = oneCustomer(b.customers);
    bookings.push({
      id: b.id,
      reslab_reservation_number: b.reslab_reservation_number,
      status: b.status,
      created_at: b.created_at,
      check_in: b.check_in,
      check_out: b.check_out,
      customer_email: customer?.email ?? "",
      location_name: b.location_name ?? "",
      airport_code: b.airport_code ?? "",
      reslab_location_id: b.reslab_location_id,
      grand_total: grandTotal,
      subtotal,
      due_at_location: dueAtLot,
      parking_online: parkingOnline,
      triply_service_fee: serviceFee,
      protection_plan: b.protection_plan,
      protection_plan_price: pgPremium,
      has_pg: hasPG,
      pg_identifier: b.pg_identifier,
      expected_stripe: expectedStripe,
      stripe_amount_received: stripeReceivedReal,
      stripe_amount_refunded: stripeRefundedRow,
      stripe_fee: stripeFeeRow,
      stripe_status: st.status,
      stripe_error: st.error,
      reslab_location_total: rl.locationTotal,
      reslab_channel_total: rl.channelTotal,
      reslab_commissions_total: rl.commissionsTotal,
      reslab_grand_total: rl.grandTotal,
      reslab_refund_amount: rl.refundAmount,
      reslab_partial_refund: rl.partialRefund,
      reslab_cancelled: rl.cancelled,
      reslab_error: rl.error,
      triply_keeps: triplyKeeps,
      triply_total: triplyTotal,
      note,
    });
  }

  // PG wholesale is the contractual truth: $6 × confirmed opt-ins.
  // Margin = per-row sum (can be negative when retail < wholesale).
  const pgWholesale = confPGOptIns * PG_WHOLESALE;
  const pgMargin = confPGMarginPerRow;
  const netServiceFee = confServiceFee + refServiceFee;
  const stripeGross = stripeGrossReal + stripeGrossDerived;
  const stripeRefundedTotal = stripeRefundedReal + stripeRefundedDerived;
  const stripeNet = stripeGross - stripeRefundedTotal;
  // Aggregate is "derived" when ANY contribution used the expectedStripe
  // fallback (so the UI keeps the caveat in that case).
  const stripeIsDerived = stripeGrossDerived > 0 || !opts.includeStripe;

  // Guard against silent under-reporting when ResLab data is missing for
  // any confirmed booking. `confReslabSeen` only counts the confirmed
  // branch, so the predicate denominator must also be "confirmed bookings
  // expecting a ResLab fetch" — otherwise an all-refunded month would
  // false-positive (no confirmed → no fetches → guard fires) AND a
  // partial-failure case would false-negative (some succeeded → guard
  // satisfied even though half the channel commission is missing).
  const reslabConfirmedExpected = real.filter(
    (b) => b.status === "confirmed" && !!b.reslab_reservation_number
  ).length;
  const reslabDataIncomplete =
    opts.includeReslab &&
    reslabConfirmedExpected > 0 &&
    confReslabSeen < reslabConfirmedExpected;

  const triplyTotal =
    opts.includeReslab && !reslabDataIncomplete
      ? netServiceFee + pgMargin + confChannelTotal
      : null;

  // Stripe processing fees aggregate: null when ANY contributing booking
  // is missing fee data (so the UI doesn't show a confidently-incomplete
  // number). When all real-Stripe rows had a balance_transaction, this
  // is the authoritative total fee Triply absorbed in the period.
  const stripeProcessingFees =
    opts.includeStripe && !stripeIsDerived && stripeFeesMissing === 0
      ? stripeFeesReal
      : null;

  // Net cash to Triply: triplyTotal minus Stripe processing fees.
  // Null when either input is null.
  const triplyCashTotal =
    triplyTotal !== null && stripeProcessingFees !== null
      ? triplyTotal - stripeProcessingFees
      : null;
  // Reason string for the headline when total is null. Surfaced in the
  // UI so the admin sees a self-explaining "—" instead of an opaque one.
  const triplyTotalReason =
    triplyTotal !== null
      ? null
      : !opts.includeReslab
      ? "ResLab cross-check disabled"
      : reslabDataIncomplete
      ? `missing ResLab data for ${reslabConfirmedExpected - confReslabSeen} of ${reslabConfirmedExpected} confirmed bookings`
      : null;

  // Take rate denominators reuse stripeGross / totalMoved / parkingSubtotal
  // from below; the net rate uses triplyCashTotal as a stand-in numerator
  // (cash margin) instead of triplyIncome.
  const triplyIncome =
    netServiceFee + pgMargin + (opts.includeReslab ? confChannelTotal : 0);
  const totalMoved = stripeGross + confDueAtLot;
  // Take rates whose numerator depends on channelTotal are also gated on
  // ResLab data being available (same reason as triplyTotal above).
  const channelDataOk = opts.includeReslab && !reslabDataIncomplete;
  const takeRates: TakeRates = {
    stripeTakeRate: channelDataOk && stripeGross > 0 ? triplyIncome / stripeGross : null,
    totalTakeRate: channelDataOk && totalMoved > 0 ? triplyIncome / totalMoved : null,
    channelCommissionRate:
      channelDataOk && confParkingSubtotal > 0 ? confChannelTotal / confParkingSubtotal : null,
    netStripeTakeRate:
      channelDataOk && stripeProcessingFees !== null && stripeGross > 0
        ? (triplyIncome - stripeProcessingFees) / stripeGross
        : null,
  };

  return {
    options: opts,
    counts: { ...counts, testExcluded, total: real.length },
    grossRevenue,
    stripe: {
      gross: stripeGross,
      refunded: stripeRefundedTotal,
      net: stripeNet,
      isDerived: stripeIsDerived,
    },
    confirmed: {
      parkingOnline: confParkingOnline,
      parkingSubtotal: confParkingSubtotal,
      dueAtLot: confDueAtLot,
      serviceFee: confServiceFee,
      pgPremium: confPGPremium,
      pgOptIns: confPGOptIns,
      pgWholesale,
      pgMargin,
      locationTotalOwed: opts.includeReslab ? confLocTotal : null,
      channelTotal: opts.includeReslab ? confChannelTotal : null,
      commissionsTotal: opts.includeReslab ? confCommissionsTotal : null,
    },
    refunded: {
      serviceFeeKept: refServiceFee,
      parkingRefunded: refParkingRefunded,
      pgRefunded: refPGRefunded,
      pgOptIns: refPGOptIns,
    },
    triplyNet: {
      serviceFee: netServiceFee,
      pgMargin,
      parkingChannelCommission: opts.includeReslab ? confChannelTotal : null,
      total: triplyTotal,
      cashTotal: triplyCashTotal,
      stripeProcessingFees,
      totalReason: triplyTotalReason,
    },
    takeRates,
    reslab: {
      invoiceAmount: opts.invoiceAmount,
      sumLocationTotal: opts.includeReslab ? confLocTotal : null,
      variance: opts.includeReslab ? confLocTotal - opts.invoiceAmount : null,
      grandTotalMismatches,
      fetchErrors: reslabFetchErrors,
      fetched: confReslabSeen,
    },
    stripeFetch: {
      fetched: stripeFetched,
      errors: stripeFetchErrors,
      derivedFallbacks: stripeDerivedFallbacks,
    },
    bookings,
  };
}
