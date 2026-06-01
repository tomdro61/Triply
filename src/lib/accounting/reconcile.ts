/**
 * Revenue reconciliation for ResLab invoice matching + Triply unit economics.
 *
 * Pulls bookings from Supabase, optionally cross-checks each against ResLab
 * for the authoritative settlement view (channel_total / location_total /
 * commissions_total), and returns a structured aggregation.
 *
 * Used by:
 *   - GET /api/admin/accounting (admin UI)
 *   - scripts/reconcile-revenue.mjs (CLI; will migrate to import this)
 *
 * Money model (see src/app/api/admin/bookings/cancel/route.ts:126-135):
 *   - Service fee is non-refundable. Refunded bookings retain triply_service_fee.
 *   - PG auto-cancels on full refund — no wholesale owed for refunded opt-ins.
 *   - ResLab invoices by trip-completion month: sum location_total for
 *     bookings whose check_out falls within the invoice period.
 *
 * Known limitation (tracked as follow-up): `stripe.gross` and
 * `stripe.refunded` are computed from booking-row composition
 * (parking_online + service_fee + pg_premium), NOT from Stripe's actual
 * amount_received. They will OVERSTATE the figures for any booking with a
 * promo discount. The ResLab-side reconciliation (sum location_total) is
 * unaffected; it pulls directly from ResLab's authoritative totals.
 */

import { createAdminClient } from "@/lib/supabase/server";
import { isAtTestLot } from "@/config/admin";
import type {
  DateField,
  ReconcileOptions,
  BookingDetail,
  ReconcileResult,
} from "./types";

export type { DateField, ReconcileOptions, BookingDetail, ReconcileResult };

const PG_WHOLESALE = 6.0;
const RESLAB_CONCURRENCY = 5;

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
  if (!res.ok) {
    throw new Error(`ResLab auth ${res.status}`);
  }
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
  if (!res.ok) {
    throw new Error(`ResLab ${res.status} on ${resNum}`);
  }
  return (await res.json()) as ReslabResponse;
}

/**
 * Run fetches with a concurrency cap. Preserves input order in output.
 *
 * Contract: `fn` MUST NOT throw — if a per-item failure is possible, the
 * caller catches inside `fn` and returns a structured error sentinel. We
 * intentionally do not catch here because a thrown error from `fn` would
 * indicate a bug (the workers race on `i++`, and a throw from one worker
 * aborts the whole `Promise.all(workers)`, losing in-flight results from
 * the other N-1 workers).
 *
 * The `const idx = i++` increment is atomic w.r.t. the JS event loop — a
 * post-increment expression evaluates as one synchronous step, so each
 * worker claims a unique index even with N parallel workers. Do NOT split
 * it into `const idx = i; i++;` "for clarity" — that would race.
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

  // Test-booking filter: same lot-id-based rule as /api/admin/stats
  // (post-2026-06-01 alignment). A booking is excluded iff it's at a
  // TEST ResLab lot id. Bookings missing a customer join are still
  // correctly excluded — the filter never consults email.
  const { data: rows, error } = await supabase
    .from("bookings")
    .select(
      `
      id, reslab_reservation_number, status, created_at, check_in, check_out,
      grand_total, due_at_location, triply_service_fee,
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

  // Fetch ResLab data in parallel (capped).
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
  const empty: ReslabSlice = {
    locationTotal: null,
    channelTotal: null,
    commissionsTotal: null,
    grandTotal: null,
    refundAmount: null,
    partialRefund: null,
    cancelled: null,
    error: null,
  };

  const fetchErrors: ReconcileResult["reslab"]["fetchErrors"] = [];

  let reslabSlices: ReslabSlice[] = real.map(() => ({ ...empty }));
  if (opts.includeReslab && real.length > 0) {
    const token = await reslabAuth();
    reslabSlices = await withConcurrency(real, RESLAB_CONCURRENCY, async (b) => {
      if (!b.reslab_reservation_number) return { ...empty };
      try {
        const data = await reslabReservation(b.reslab_reservation_number, token);
        const h = data.history?.[0];
        if (!h) {
          return { ...empty, error: "no history[0] in response" };
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
        fetchErrors.push({ resNum: b.reslab_reservation_number, err: msg });
        return { ...empty, error: msg };
      }
    });
  }

  // Per-booking detail + aggregation
  const bookings: BookingDetail[] = [];
  const grandTotalMismatches: ReconcileResult["reslab"]["grandTotalMismatches"] = [];

  const counts = { confirmed: 0, refunded: 0, cancelled: 0, other: 0 };
  let confParkingOnline = 0;
  let confDueAtLot = 0;
  let confServiceFee = 0;
  let confPGPremium = 0;
  let confPGOptIns = 0;
  let confPGMarginPerRow = 0; // sum per-row margin to keep aggregate == sum-of-rows
  let confLocTotal = 0;
  let confChannelTotal = 0;
  let confCommissionsTotal = 0;
  let confReslabSeen = 0;
  let refServiceFee = 0;
  let refParkingRefunded = 0;
  let refPGRefunded = 0;
  let refPGOptIns = 0;
  let stripeGross = 0;
  let stripeRefunded = 0;

  for (let idx = 0; idx < real.length; idx++) {
    const b = real[idx];
    const rl = reslabSlices[idx] ?? empty;

    const grandTotal = num(b.grand_total);
    const dueAtLot = num(b.due_at_location);
    const parkingOnline = Math.max(0, grandTotal - dueAtLot);
    const serviceFee = num(b.triply_service_fee);
    const pgPremium = num(b.protection_plan_price);
    const hasPG = !!b.protection_plan;
    // Note: ignores promo discounts (see file-level limitation comment).
    const expectedStripe = parkingOnline + serviceFee + pgPremium;

    // Skip the mismatch flag when ResLab correctly zeroed out a
    // refunded/cancelled booking — both systems agree, just at different
    // "levels" (Supabase preserves the original total for audit; ResLab
    // clears it on cancellation). Also belt-and-suspenders: a Supabase
    // non-confirmed status alongside ResLab grand_total=0 is a clear
    // "both zeroed" case even if ResLab's `cancelled` flag is stale.
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

    let triplyKeeps = 0;
    let note = "";
    if (b.status === "confirmed") {
      counts.confirmed++;
      confParkingOnline += parkingOnline;
      confDueAtLot += dueAtLot;
      confServiceFee += serviceFee;
      if (hasPG) {
        confPGPremium += pgPremium;
        confPGOptIns += 1;
        // Unclamped: PG charges Triply $6 wholesale regardless of retail.
        // If retail drops below $6, margin is genuinely negative — that's
        // the real economic picture and should be visible, not clamped to
        // zero. CLAUDE.md memory project_park_guard_status confirms the
        // contract: flat per-opt-in wholesale.
        confPGMarginPerRow += pgPremium - PG_WHOLESALE;
      }
      if (opts.includeReslab && rl.locationTotal !== null) {
        confLocTotal += rl.locationTotal;
        confChannelTotal += rl.channelTotal ?? 0;
        confCommissionsTotal += rl.commissionsTotal ?? 0;
        confReslabSeen++;
      }
      stripeGross += expectedStripe;
      // Unclamped — matches the aggregate. If a row goes underwater
      // (premium < wholesale) the keep is genuinely reduced; flag it
      // in the note so an admin notices.
      triplyKeeps = serviceFee + (hasPG ? pgPremium - PG_WHOLESALE : 0);
      if (hasPG && pgPremium < PG_WHOLESALE) {
        note = (note ? note + "; " : "") + `PG underwater: premium $${pgPremium.toFixed(2)} < wholesale $${PG_WHOLESALE.toFixed(2)}`;
      }
    } else if (b.status === "refunded") {
      counts.refunded++;
      refServiceFee += serviceFee;
      refParkingRefunded += parkingOnline;
      if (hasPG) {
        refPGRefunded += pgPremium;
        refPGOptIns += 1;
      }
      stripeGross += expectedStripe;
      // Refund = amount_received − service_fee (per cancel route).
      // Like stripeGross, this ignores promo discounts (overstated when present).
      stripeRefunded += Math.max(0, expectedStripe - serviceFee);
      triplyKeeps = serviceFee;
      note = "service fee retained";
    } else if (b.status === "cancelled") {
      counts.cancelled++;
      note = "no payment captured";
    } else {
      counts.other++;
    }
    if (rl.error) note = (note ? note + "; " : "") + `reslab error: ${rl.error}`;

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
      due_at_location: dueAtLot,
      parking_online: parkingOnline,
      triply_service_fee: serviceFee,
      protection_plan: b.protection_plan,
      protection_plan_price: pgPremium,
      has_pg: hasPG,
      pg_identifier: b.pg_identifier,
      expected_stripe: expectedStripe,
      reslab_location_total: rl.locationTotal,
      reslab_channel_total: rl.channelTotal,
      reslab_commissions_total: rl.commissionsTotal,
      reslab_grand_total: rl.grandTotal,
      reslab_refund_amount: rl.refundAmount,
      reslab_partial_refund: rl.partialRefund,
      reslab_cancelled: rl.cancelled,
      reslab_error: rl.error,
      triply_keeps: triplyKeeps,
      note,
    });
  }

  // PG wholesale is the contractual truth: $6 × count of confirmed opt-ins
  // (PG bills Triply flat per opt-in regardless of retail). Margin equals
  // the per-row sum AND `confPGPremium − pgWholesale` by construction;
  // it can be negative when retail drops below wholesale — that's true
  // economics, not a defect to clamp away.
  const pgWholesale = confPGOptIns * PG_WHOLESALE;
  const pgMargin = confPGMarginPerRow;
  const netServiceFee = confServiceFee + refServiceFee;
  const netStripe = stripeGross - stripeRefunded;

  // triplyNet.total is null when ResLab is excluded — channel commission
  // (the largest Triply parking-side revenue line) lives in ResLab, so a
  // "total" without it would be misleadingly low. UI shows "—" instead
  // of a wrong number.
  const triplyTotal = opts.includeReslab
    ? netServiceFee + pgMargin + confChannelTotal
    : null;

  return {
    options: opts,
    counts: { ...counts, testExcluded, total: real.length },
    stripe: { gross: stripeGross, refunded: stripeRefunded, net: netStripe, promoCaveat: true },
    confirmed: {
      parkingOnline: confParkingOnline,
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
    },
    reslab: {
      invoiceAmount: opts.invoiceAmount,
      sumLocationTotal: opts.includeReslab ? confLocTotal : null,
      variance: opts.includeReslab ? confLocTotal - opts.invoiceAmount : null,
      grandTotalMismatches,
      fetchErrors,
      fetched: confReslabSeen,
    },
    bookings,
  };
}
