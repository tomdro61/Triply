/**
 * Shared types for the revenue reconciliation feature.
 *
 * Lives in its own file so both the server lib (src/lib/accounting/reconcile.ts,
 * which imports server-only Supabase clients) and the client page
 * (src/app/(main)/admin/accounting/page.tsx) can import without dragging
 * server-only code into the client bundle.
 *
 * Zero runtime imports.
 */

export type DateField = "created" | "checkout" | "checkin";

export interface ReconcileOptions {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  by: DateField;
  invoiceAmount: number;
  includeReslab: boolean;
  includeStripe: boolean;
}

export interface BookingDetail {
  id: string;
  reslab_reservation_number: string;
  status: string;
  created_at: string;
  check_in: string;
  check_out: string;
  customer_email: string;
  location_name: string;
  airport_code: string;
  reslab_location_id: number | null;
  grand_total: number;
  subtotal: number;
  due_at_location: number;
  parking_online: number;
  triply_service_fee: number;
  protection_plan: string | null;
  protection_plan_price: number;
  has_pg: boolean;
  pg_identifier: string | null;
  // Derived expected charge (parking_online + service_fee + pg_premium).
  // Used only as the fallback when Stripe fetch fails or is disabled.
  expected_stripe: number;
  // Real Stripe data (null when Stripe disabled or per-booking fetch failed).
  stripe_amount_received: number | null;
  stripe_amount_refunded: number | null;
  stripe_status: string | null;
  // Original capture fee from balance_transaction.fee. Does NOT reflect
  // fee refunds on cancelled charges (Stripe sometimes returns the fee
  // for full refunds; capturing that perfectly would require a second
  // API call per booking — deferred). null when Stripe fetch failed or
  // the charge has no balance_transaction.
  stripe_fee: number | null;
  stripe_error: string | null;
  reslab_location_total: number | null;
  reslab_channel_total: number | null;
  reslab_commissions_total: number | null;
  reslab_grand_total: number | null;
  reslab_refund_amount: number | null;
  reslab_partial_refund: number | null;
  reslab_cancelled: boolean | null;
  reslab_error: string | null;
  // "Triply fee" = service fee + PG margin (the on-top charges).
  // Excludes channel commission. Was misleadingly named "triply_keeps"
  // before — the rename matches what's actually computed.
  triply_keeps: number;
  // "Triply total" = channel commission + service fee + PG margin (the
  // complete pile Triply kept per booking). Null for confirmed bookings
  // when ResLab data is unavailable (we can't compute channel commission
  // without it). For refunded bookings, equals service fee only (channel
  // refunded along with parking). For cancelled bookings, 0.
  triply_total: number | null;
  note: string;
}

/**
 * Three "take rate" formulas (per user request — show all three so it's
 * obvious which one is being quoted in a given context):
 *
 * - `stripeTakeRate`        = Triply income ÷ Stripe gross collected
 *                             "Of every $ a customer paid Triply, what %
 *                             did we keep?" ~27% on May 2026 data.
 * - `totalTakeRate`         = Triply income ÷ (Stripe gross + due-at-lot)
 *                             "Of every $ that moved (including the lot's
 *                             at-gate collection), what % did Triply
 *                             touch?" ~24% on May 2026 data.
 * - `channelCommissionRate` = ResLab channel_total ÷ ResLab subtotal
 *                             The contract-level parking split with the
 *                             lot. Useful for ResLab negotiations.
 *                             ~17% weighted avg on May 2026.
 *
 * Each is `null` when the inputs aren't available (e.g., Stripe disabled,
 * ResLab disabled, or denominator is zero).
 */
export interface TakeRates {
  stripeTakeRate: number | null;
  totalTakeRate: number | null;
  channelCommissionRate: number | null;
  // Net of Stripe processing fees — closest to "actual cash margin."
  // Null when Stripe fees couldn't be measured (test mode, fetch failure,
  // or any per-booking balance_transaction missing — surfaced inline).
  netStripeTakeRate: number | null;
}

export interface ReconcileResult {
  options: ReconcileOptions;
  counts: {
    confirmed: number;
    refunded: number;
    cancelled: number;
    other: number;
    testExcluded: number;
    total: number;
  };
  // Gross revenue = SUM(grand_total) for confirmed bookings. INCLUDES the
  // due-at-location portion (the full value of every booking sold).
  // Matches /admin dashboard's "gross revenue."
  grossRevenue: number;
  // Stripe figures are REAL when includeStripe=true (live `amount_received`
  // from per-booking PaymentIntent fetch). When includeStripe=false OR a
  // per-booking fetch failed, falls back to the derived `expected_stripe`
  // (overstated for promo bookings — flagged via stripe.isDerived).
  stripe: {
    gross: number;
    refunded: number;
    net: number;
    isDerived: boolean;
  };
  confirmed: {
    parkingOnline: number;
    parkingSubtotal: number; // SUM(subtotal), pre-tax-pre-fee — denominator for channel rate
    dueAtLot: number;
    serviceFee: number;
    pgPremium: number;
    pgOptIns: number;
    pgWholesale: number;
    pgMargin: number;
    locationTotalOwed: number | null;
    channelTotal: number | null;
    commissionsTotal: number | null;
  };
  refunded: {
    serviceFeeKept: number;
    parkingRefunded: number;
    pgRefunded: number;
    pgOptIns: number;
  };
  triplyNet: {
    serviceFee: number;
    pgMargin: number;
    parkingChannelCommission: number | null;
    total: number | null;
    // Net cash to Triply (= total - Stripe processing fees). Null when
    // either `total` is null OR Stripe fees couldn't be measured.
    cashTotal: number | null;
    // Stripe processing fees absorbed by Triply across the period.
    // Sum of balance_transaction.fee across all successfully-fetched
    // Stripe charges. Null when Stripe data is derived/unavailable.
    stripeProcessingFees: number | null;
    // When `total` or `cashTotal` is null, explains why so the UI can
    // render an inline reason at the headline.
    totalReason: string | null;
  };
  takeRates: TakeRates;
  reslab: {
    invoiceAmount: number;
    sumLocationTotal: number | null;
    variance: number | null;
    grandTotalMismatches: Array<{ resNum: string; supabase: number; reslab: number; diff: number }>;
    fetchErrors: Array<{ resNum: string; err: string }>;
    fetched: number;
  };
  stripeFetch: {
    fetched: number;
    errors: Array<{ resNum: string; err: string }>;
    derivedFallbacks: number;
  };
  bookings: BookingDetail[];
}
