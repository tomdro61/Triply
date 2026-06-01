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
  due_at_location: number;
  parking_online: number;
  triply_service_fee: number;
  protection_plan: string | null;
  protection_plan_price: number;
  has_pg: boolean;
  pg_identifier: string | null;
  expected_stripe: number;
  reslab_location_total: number | null;
  reslab_channel_total: number | null;
  reslab_commissions_total: number | null;
  reslab_grand_total: number | null;
  reslab_refund_amount: number | null;
  reslab_partial_refund: number | null;
  reslab_cancelled: boolean | null;
  reslab_error: string | null;
  triply_keeps: number;
  note: string;
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
  // Stripe gross/refunded are estimates based on booking-row composition —
  // they do NOT reflect actual Stripe `amount_received`, so they will be
  // overstated for any booking that used a promo discount at checkout.
  // For exact figures, cross-check against Stripe directly.
  stripe: { gross: number; refunded: number; net: number; promoCaveat: true };
  confirmed: {
    parkingOnline: number;
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
  // `total` is null when includeReslab=false because channel commission
  // (Triply's largest parking-side revenue line) lives in ResLab — a
  // "total Triply" figure without it would be misleadingly low.
  triplyNet: {
    serviceFee: number;
    pgMargin: number;
    parkingChannelCommission: number | null;
    total: number | null;
  };
  reslab: {
    invoiceAmount: number;
    sumLocationTotal: number | null;
    variance: number | null;
    grandTotalMismatches: Array<{ resNum: string; supabase: number; reslab: number; diff: number }>;
    fetchErrors: Array<{ resNum: string; err: string }>;
    fetched: number;
  };
  bookings: BookingDetail[];
}
