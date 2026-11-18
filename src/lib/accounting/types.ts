/**
 * Shared types for the revenue reconciliation feature.
 *
 * Lives in its own file so both the server lib (src/lib/accounting/reconcile.ts,
 * which imports server-only Supabase clients) and the client page
 * (src/app/(main)/admin/accounting/page.tsx) can import without dragging
 * server-only code into the client bundle.
 *
 * Zero runtime imports (type-only imports are erased).
 */

import type { CanadianRowKind } from "./reslab-currency";

export type DateField = "created" | "checkout" | "checkin";

export interface ReconcileOptions {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  by: DateField;
  invoiceAmount: number;
  /**
   * The US-dollar value of one Canadian dollar that ResLab used on this
   * invoice (it converts what Canadian lots are owed on the invoice date).
   * Above 0.5 and below 1, at most six decimals: anything else is refused.
   * Omitted = not known: the Canadian part of the invoice is then estimated at
   * each booking's own rate. Only moves the invoice comparison, never the keep.
   */
  invoiceCadRate?: number;
  includeReslab: boolean;
  includeStripe: boolean;
  /**
   * Restrict the read to these booking ids (still inside from/to). Omitted =
   * every booking in the range (the monthly accounting page). The id list is
   * chunked and each chunk paged, so PostgREST's 1,000-row cap can't truncate
   * it. An empty array reads nothing.
   */
  bookingIds?: readonly string[];
  /** ResLab reads in flight at once. Default 5. */
  reslabConcurrency?: number;
  /**
   * Opt-in time bounds for a caller with a hard function budget
   * (/admin/blog-bookings). Omitted = no timeout and no deadline, exactly as
   * the monthly accounting page has always run.
   *
   * `fetchTimeoutMs`: each ResLab request (auth and every reservation read)
   * and each by-id bookings page is aborted after this many ms.
   */
  fetchTimeoutMs?: number;
  /**
   * Epoch ms. A ResLab read that has not started by then is not made: the
   * row becomes a fetch error (RESLAB_SKIPPED_TIME_BUDGET), so the result
   * reads as incomplete rather than as a figure.
   */
  deadline?: number;
  /**
   * Also work out what Triply made on each direct-lot booking
   * (`result.direct.detail`): three more database reads for the direct rows and
   * the payout rules. Only the accounting page sets it; every other caller gets
   * exactly the reads it always had.
   */
  includeDirectDetail?: boolean;
}

/** A sum over the direct bookings whose figure is known: `known` of `of` rows are in `cents`. */
export interface DirectSum {
  cents: number;
  known: number;
  of: number;
}

/** One direct-lot booking in the report. Integer cents; null = unknown, never $0. */
export interface DirectBookingDetail {
  reservationNumber: string;
  status: string;
  /** Literal airport-local wall clock, "YYYY-MM-DD HH:MM:SS". */
  checkIn: string;
  checkOut: string;
  lotName: string;
  /**
   * ok                  every figure below is known
   * needs_decision      only a person can decide what the lot is owed (payout statement)
   * adjustment_pending  paid, and something changed since: waiting on a person
   * not_read            the payment was not read from Stripe: no figure, never an estimate
   * no_figure           a figure it needs is unknown, the booking was disputed, or it was decided
   *                     by hand where Triply remits the tax
   * blocked             cannot be worked out at all (no PaymentIntent, no terms, a broken ledger,
   *                     its booking columns could not be read)
   */
  state: "ok" | "needs_decision" | "adjustment_pending" | "not_read" | "no_figure" | "blocked";
  reason: string | null;
  receivedCents: number | null;
  /** Capped at what was received (Stripe reports a released hold as refunded). */
  refundedCents: number | null;
  owedToLotCents: number | null;
  /** ledger = what was recorded as paid to the lot; rule = what the rules say is due, not paid yet. */
  owedSource: "rule" | "ledger" | null;
  stripeFeeCents: number | null;
  /** Triply revenue before Stripe fees (like for like with the ResLab "Triply revenue (gross)"). */
  grossCents: number | null;
  /** After Stripe fees, by the payout statement's rule; on a paid booking, against what the lot was actually paid. */
  netCents: number | null;
}

export interface DirectDetail {
  bookings: DirectBookingDetail[];
  totals: {
    /** Received − refunded, over confirmed, refunded and cancelled bookings: a disputed booking is left out, as in the ResLab column. `of` counts only those bookings. */
    collected: DirectSum;
    /** Over the same bookings as `net` (those with a full figure), so gross − stripeFees = net. */
    owedToLots: DirectSum;
    gross: DirectSum;
    stripeFees: DirectSum;
    net: DirectSum;
  };
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
  /** Derived at fulfilment from the lot's coordinates (migration 023 era);
   *  "RESLAB" on legacy rows until the backfill runs; null when unresolvable. */
  airport_code: string | null;
  reslab_location_id: number | null;
  grand_total: number;
  subtotal: number;
  due_at_location: number;
  parking_online: number;
  // The promo discount the booking got (bookings.discount_amount). On a ResLab
  // row Triply funds it — it is deducted from triply_total (D3).
  promo_discount: number;
  triply_service_fee: number;
  protection_plan: string | null;
  protection_plan_price: number;
  has_pg: boolean;
  pg_identifier: string | null;
  // Derived expected charge (parking_online + service_fee + pg_premium −
  // promo_discount). Used only as the fallback when Stripe fetch fails or is
  // disabled.
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
  // ResLab's "RL Fee" for this booking — the `channel_fee` line in
  // history[0].fees[], billed on top of the lot settlement (and billed even on
  // Due-at-Lot bookings, where reslab_location_total is $0). Reported raw: a
  // ResLab-cancelled row can carry a fee here that is NOT billed, and is
  // excluded from the settlement totals accordingly.
  reslab_channel_fee: number | null;
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
  // "Triply total" = channel commission + service fee + PG margin − the promo
  // discount Triply funded (the complete pile Triply kept per booking). Null for confirmed bookings
  // when ResLab data is unavailable (we can't compute channel commission
  // without it). For refunded bookings, equals service fee only (channel
  // refunded along with parking). For cancelled bookings, 0.
  triply_total: number | null;
  note: string;
  /**
   * Only on a booking whose ResLab reservation is in Canadian dollars. Every
   * `reslab_*` field above is then US dollars ("converted": at the booking's
   * own rate, an estimate until ResLab invoices) or null (anything else: the
   * ResLab side is left out). The `*_cad` figures are ResLab's own, in
   * Canadian dollars; they are null on a fault ("no_rate" / "conflict"),
   * whose figures are in no sum in any currency.
   */
  fx?: {
    kind: CanadianRowKind;
    /** The booking's own rate, six decimals; null when the row has no usable one. */
    rate: string | null;
    /** Owed to the lot (location_total − due at the lot), like `reslab_location_total`. */
    location_total_cad: number | null;
    due_at_location_cad: number | null;
    channel_fee_cad: number | null;
    channel_total_cad: number | null;
    commissions_total_cad: number | null;
    grand_total_cad: number | null;
  };
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

/**
 * Why integrity check #3 lists a booking (its discount vs the code's percent):
 *   mismatch              the recorded discount is more than 1¢ off the percent
 *   no_discount_recorded  the PaymentIntent has a percent, the booking no
 *                         discount: before migration 016 (Jul 23, 2026), or a
 *                         later booking whose price fell after authorization,
 *                         so the charge-derived discount came out $0
 *   no_percent            a discount with no percent on the PaymentIntent
 *   subtotal_unknown      ResLab gave no usable subtotal — NOT checked
 */
export type PromoMismatchReason = "mismatch" | "no_discount_recorded" | "no_percent" | "subtotal_unknown";

export interface ReconcileResult {
  options: ReconcileOptions;
  counts: {
    confirmed: number;
    refunded: number;
    cancelled: number;
    other: number;
    testExcluded: number;
    // Staging bookings in the shared prod DB, excluded from everything: rows
    // that RECORD Stripe test mode (`livemode === false`), plus NULL-livemode
    // rows inferred as staging (test-mode PI unreadable by the live key AND a
    // definitive prod-ResLab 404). Distinct from testExcluded (test LOTS).
    stagingExcluded: number;
    // ResLab bookings in `bookings[]`. Direct-lot bookings are NOT in it — see
    // `direct.count`.
    total: number;
  };
  // Bookings at Triply-owned DIRECT lots (`inventory_source === "direct"`,
  // live only — a test-mode direct row is in counts.stagingExcluded). Kept OUT
  // of every other figure in this result (counts, bookings[]/CSV, stripe,
  // confirmed, triplyNet, takeRates, the ResLab settlement): Triply collects
  // the whole parking charge and owes the lot a payout, which the ResLab-shaped
  // P&L does not describe. Never fetched from ResLab. The payout / margin
  // section is Phase 6; this is the explicit placeholder so they're never $0.
  direct: {
    count: number; // all statuses
    confirmed: number;
    refunded: number;
    cancelled: number;
    other: number;
    // What customers paid online for CONFIRMED direct bookings: live Stripe
    // amount_received per row, or — when Stripe is off/unavailable for a row —
    // grand_total + service fee + PG premium − promo discount (flagged below).
    grossOnlineCharge: number;
    grossOnlineChargeIsDerived: boolean;
    // Our TRP- confirmation numbers, all statuses (audit trail).
    reservations: string[];
    // Stripe fetch failures for direct rows (incl. a live key unable to read a
    // live direct row's PI). Separate from stripeFetch.errors, whose rows are
    // in the CSV; these are not.
    stripeErrors: Array<{ resNum: string; err: string }>;
    /**
     * Per-booking profit, only when `options.includeDirectDetail` was set.
     * `{ error }` = its reads failed: the rest of the report is still good.
     */
    detail?: DirectDetail | { error: string };
  };
  /**
   * Bookings whose ResLab reservation is in Canadian dollars (all zero for a
   * US-only period). ResLab invoices them in US dollars at its own rate on the
   * invoice date, so what is owed for them is kept apart from the US-dollar
   * settlement figures in `reslab`.
   */
  canadian: {
    /**
     * Converted at checkout. In `confirmed`, `triplyNet` and the take rates at
     * the booking's own rate. NOT in the `reslab` settlement sums: what is owed
     * for them is `convertedOwed`. All statuses.
     */
    converted: number;
    /** The old bookings charged one-for-one before conversion: ResLab side left out. All statuses. */
    noRateLegacy: number;
    /**
     * Any other row whose currency cannot be handled, or a marked Canadian
     * booking ResLab could not be read for. All statuses. A confirmed one
     * withholds the headline.
     */
    faults: number;
    reservations: Array<{ resNum: string; kind: CanadianRowKind; reason: string | null }>;
    /**
     * What ResLab bills for converted bookings (lot settlement + its fee;
     * `rows` = reservations it has not cancelled): in CAD, and in US dollars
     * at each booking's own rate.
     */
    convertedOwed: { rows: number; cad: number; usdAtBookingRates: number };
    /** The same for the old one-for-one bookings. CAD only: there is no rate to estimate with. */
    legacyOwed: { rows: number; cad: number };
    /** Fault rows ResLab has not cancelled: billed by ResLab and in NO figure here, in either currency. */
    billedFaults: number;
    /** Channel commission − ResLab fee on confirmed converted bookings: the estimated part of `triplyNet.total`. */
    keepEstimate: number;
    confirmedConverted: number;
    /**
     * Confirmed bookings whose ResLab side is left out, and their Stripe
     * parking. It IS in `confirmed.stripeParkingCollected`; the page takes it
     * out of "net parking cash", where there is nothing owed to set against it.
     */
    leftOutConfirmed: number;
    leftOutStripeParking: number;
    /**
     * Stripe refunds on confirmed Canadian bookings (a partial refund does not
     * lower `triplyNet`). null when a payment was not read from Stripe.
     */
    stripeRefunded: number | null;
  };
  // Reservation numbers of the rows counted in `counts.stagingExcluded` — the
  // audit trail for the exclusion (which specific bookings were dropped as
  // staging junk), so a misclassified row is traceable rather than invisible.
  // Recorded-livemode=false rows first, then the inferred ones.
  stagingExcludedReservations: string[];
  // Reservation numbers of Park Guard opt-ins whose row carries NO wholesale
  // (deploy-window rows written before migration 022's repair). They count $0
  // PG cost, so pgWholesale is under-stated and pgMargin / triplyNet are
  // OVER-stated by their real wholesale until the rows are repaired.
  pgWholesaleMissingReservations: string[];
  // Parking gross = SUM(grand_total) for confirmed bookings, INCLUDING the
  // due-at-location portion. Parking-only (no service fee / Park Guard) —
  // used for the "Total parking customers paid" line in the parking money flow.
  grossRevenue: number;
  // Total customer spend (GMV) = SUM(grand_total + service_fee + pg_premium)
  // for confirmed bookings, BEFORE promo discounts (they are their own line,
  // triplyNet.promoDiscounts). Matches the /admin dashboard's "Booking value"
  // (stats route sums these same three fields).
  grossCustomerSpend: number;
  // Stripe figures are REAL when includeStripe=true (live `amount_received`
  // from per-booking PaymentIntent fetch). When includeStripe=false OR a
  // per-booking fetch failed, falls back to the derived `expected_stripe`
  // (net of promo discounts) — flagged via stripe.isDerived.
  stripe: {
    gross: number;
    refunded: number;
    net: number;
    isDerived: boolean;
  };
  confirmed: {
    parkingOnline: number; // Supabase grand_total − due_at_location (legacy; use stripeParkingCollected for cash)
    parkingSubtotal: number; // SUM(Supabase subtotal), pre-tax-pre-fee
    dueAtLot: number; // Supabase due_at_location (legacy; use reslabDueAtLot for the authoritative at-gate amount)
    serviceFee: number;
    pgPremium: number;
    pgOptIns: number;
    pgWholesale: number;
    pgMargin: number;
    locationTotalOwed: number | null;
    // ResLab's channel fee ("RL Fee") across confirmed, non-cancelled
    // bookings. A cost to Triply, deducted in triplyNet.total.
    channelFee: number | null;
    channelTotal: number | null;
    // Also null when a converted Canadian booking's figure could not be read,
    // or a confirmed booking's ResLab side is left out (`canadian.leftOutConfirmed`).
    commissionsTotal: number | null;
    // Authoritative parking cash collected = SUM(Stripe amount_received −
    // service_fee − pg_premium) over confirmed bookings. Falls back to the
    // Supabase-derived parkingOnline per booking when live Stripe is
    // unavailable; `stripeParkingIsDerived` is true if ANY booking fell back.
    // Includes confirmed Canadian bookings whose ResLab side is left out
    // (`canadian.leftOutStripeParking`).
    stripeParkingCollected: number;
    stripeParkingIsDerived: boolean;
    // Authoritative at-gate amount = SUM(ResLab due_at_location_total).
    // null when ResLab cross-check is disabled.
    reslabDueAtLot: number | null;
    // Authoritative parking subtotal = SUM(ResLab subtotal) — denominator for
    // the channel commission rate. null when ResLab cross-check is disabled.
    reslabSubtotal: number | null;
    // Σ bookings.discount_amount over confirmed ResLab bookings, and how many
    // had one (counted by the discount, not promo_code: fulfilment can record a
    // discount with no code). Funded by Triply (D3).
    promoDiscount: number;
    // The part of promoDiscount that came out of the parking paid online (the
    // rest came out of the service fee: pre-PR 2 bug-6 rows only). The parking
    // money flow's "promo discounts" row.
    promoDiscountParking: number;
    promoDiscountCount: number;
  };
  refunded: {
    serviceFeeKept: number;
    parkingRefunded: number;
    pgRefunded: number;
    pgOptIns: number;
    // PG wholesale still owed on refunded opt-ins (Σ per-row wholesale — $6 /
    // $4 / $2 by tier, migration 021) and the net PG margin on them (retained
    // premium − wholesale; ≈$0 standard, −wholesale full).
    pgWholesale: number;
    pgMargin: number;
  };
  triplyNet: {
    serviceFee: number;
    pgMargin: number;
    // Gross channel commission (the contract figure), BEFORE ResLab's fee.
    parkingChannelCommission: number | null;
    // ResLab's channel fee ("RL Fee") on confirmed bookings — already deducted
    // from `total`. Surfaced separately so the commission above stays gross.
    reslabChannelFee: number | null;
    // Promo discounts Triply funded on confirmed ResLab bookings (ResLab
    // invoices the lot's full share) — already deducted from `total`, like the
    // channel fee. Null when the ResLab cross-check is off (as is `total`).
    promoDiscounts: number | null;
    promoDiscountCount: number;
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
    // Confirmed Canadian bookings inside `total` at a booking-rate estimate.
    canadianEstimated: number;
    // Confirmed bookings whose channel commission is NOT in `total` (their
    // ResLab side is left out: no rate, or a currency conflict).
    canadianLeftOut: number;
  };
  takeRates: TakeRates;
  reslab: {
    invoiceAmount: number;
    // The US-DOLLAR reservations' part of what ResLab's settlement invoice
    // bills = sumLocationTotal + sumChannelFee. `variance` is measured off it.
    // In a period with Canadian reservations the invoice bills those too:
    // read `varianceInclCanadian`.
    //
    // Scope note: the settlement figures below follow ResLab's OWN billing rule,
    // which is NOT the same as our booking status. They cover every US-dollar
    // reservation ResLab has not cancelled — so a `disputed` booking counts (ResLab bills
    // it) and a ResLab-cancelled one does not (they bill neither the parking
    // nor the fee, even though the fee line survives in the history).
    sumAmountOwed: number | null;
    // Lot settlement only: Σ (location_total − due_at_location_total).
    sumLocationTotal: number | null;
    // ResLab's "RL Fee" column: Σ channel_fee. Charged even on Due-at-Lot
    // bookings, where the lot settlement itself is $0.
    sumChannelFee: number | null;
    // Reservations behind the settlement figures (non-cancelled, ResLab data
    // present). Differs from `fetched`, which is confirmed-only.
    settlementRows: number;
    // US-dollar reservations only (as are the three sums above).
    variance: number | null;
    /**
     * What the invoice bills for Canadian reservations, in US dollars. null
     * when the ResLab cross-check is off.
     *  - "invoice_rate" (`options.invoiceCadRate` set): every Canadian dollar
     *    owed at ResLab's rate. `exchangeDifference` = what that cost (+) or
     *    saved (−) on converted bookings against their booking rates.
     *  - "booking_rates": converted bookings at their own rates, an estimate.
     * `unpriced` = reservations ResLab bills that are NOT in `usd`: the old
     * one-for-one bookings (booking_rates only) and every currency fault.
     */
    canadianInvoice: null | {
      basis: "invoice_rate" | "booking_rates";
      usd: number;
      exchangeDifference: number | null;
      unpriced: number;
    };
    // sumAmountOwed + canadianInvoice.usd − invoiceAmount: the variance to read
    // in a period with Canadian reservations. Equals `variance` for a US-only
    // period. null when `canadianInvoice.unpriced > 0`: a gap in the sum is
    // never shown as a difference from the invoice.
    varianceInclCanadian: number | null;
    grandTotalMismatches: Array<{ resNum: string; supabase: number; reslab: number; diff: number; note?: string }>;
    fetchErrors: Array<{ resNum: string; err: string }>;
    fetched: number;
    // Confirmed bookings that expected a ResLab fetch (have a reservation
    // number). The denominator for "X of Y cross-checked" messaging.
    confirmedExpected: number;
    // True when one or more confirmed bookings expecting a ResLab fetch are
    // missing data — so the integrity panel won't claim a clean reconciliation
    // for rows it never cross-checked.
    dataIncomplete: boolean;
  };
  stripeFetch: {
    fetched: number;
    errors: Array<{ resNum: string; err: string }>;
    derivedFallbacks: number;
  };
  // Cross-source reconciliation. Surfaces bookings where the three sources
  // disagree — the automatic detector for drifted/mis-stored records like
  // RTL753241 (Supabase due_at_location stored $0 vs ResLab's $98.24).
  integrity: {
    // Supabase's expected charge (parking_online + service_fee + pg_premium −
    // promo discount) vs the ACTUAL Stripe amount_received. Confirmed bookings only, and only
    // when live Stripe was available for the row. A non-trivial diff means the
    // Supabase booking record drifted from what the customer actually paid.
    chargeMismatches: Array<{
      resNum: string;
      expectedSupabase: number;
      stripeActual: number;
      diff: number; // expected − actual
    }>;
    // The parking identity: Stripe parking collected + the promo discount
    // Triply funded out of the parking + ResLab at-gate should equal the
    // booking grand_total. A non-trivial diff means Stripe and ResLab don't
    // reconcile against the booking value.
    parkingFlowMismatches: Array<{
      resNum: string;
      stripeParking: number;
      promoDiscount: number;
      reslabAtGate: number;
      grandTotal: number;
      diff: number; // (stripeParking + promoDiscount + reslabAtGate) − grandTotal
    }>;
    // The recorded promo discount vs the code's percent of ResLab's subtotal,
    // for bookings WITHOUT the discountCents stamp (their discount was derived
    // from the charge, so the two checks above pass by construction). Also
    // lists a percent on the PaymentIntent with no discount recorded (rows
    // before migration 016). Confirmed bookings with live Stripe + ResLab.
    promoMismatches: Array<{
      resNum: string;
      reason: PromoMismatchReason;
      recorded: number;
      percent: number | null; // null with reason "no_percent"
      expected: number | null; // null: no percent, or ResLab's subtotal unknown
      diff: number | null; // recorded − expected; null when expected is
    }>;
  };
  bookings: BookingDetail[];
}
