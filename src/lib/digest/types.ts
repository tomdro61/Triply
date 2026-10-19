/**
 * Digest data shapes. Every metric is `number | "unavailable"` — a failed or
 * uncovered query can never render as 0 (plan v2 §0).
 */

import type { BookingSource } from "@/lib/attribution/source";

export type Metric = number | "unavailable";

/** A headline number with its trailing baselines (per-day averages). */
export interface Baselined {
  value: Metric;
  /** null = the window is not fully covered by data ("n/a (data since …)"). */
  avg7: number | null;
  avg28: number | null;
  since: string;
  /** Set when the baseline query itself failed (the headline value is still real). */
  baselineError?: string;
}

export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

export interface BookingsSection {
  count: Baselined;
  staging: number;
  unmatched: number;
  otherStatus: number;
  refunded: number;
  disputed: number;
  cancelledOrFailed: number;
  gmv: Metric;
  chargedOnline: Metric;
  avgOrder: Metric;
  feeIncome: Metric;
  serviceFees: Metric;
  pgMargin: Metric;
  pgRefundedWholesaleEaten: Metric;
  pgAttachRate: Metric;
  dirtyPgRows: number;
  promoBookings: number;
  promoDiscount: Metric;
  repeatByEmail: Metric;
  repeatCapped: boolean;
  /** Set when the repeat lookup failed (a comparison nicety — the day's numbers stand). */
  repeatError?: string;
  /** Confirmed rows with a NULL money column; > 0 means every money total above is "unavailable" for the day. */
  unpricedRows: number;
  leadTime: { sameDay: number; d1to3: number; d4to14: number; d15plus: number; unknown: number };
}

export interface SourceCount {
  key: BookingSource;
  bookings: number;
}

export interface WhereFromSection {
  /** The day's live confirmed bookings by reporting source (attribution/source.ts). */
  bySource: SourceCount[];
  /**
   * The 7 ET days ending with the digest day, same definition. One day is ~6
   * bookings, too few to read a mix from. Its own query: a failure here leaves
   * the day's line standing.
   */
  bySource7d: Section<{ total: number; rows: SourceCount[] }>;
  topAirports: Array<{ key: string; bookings: number }>;
  landing: { blog: number; airportPage: number; homepage: number; other: number; none: number };
  topBlogPosts: Array<{ path: string; bookings: number }>;
}

/** Month-to-date vs the same days of the previous month (live confirmed bookings, as they stand now). */
export interface PaceSection {
  /** "2026-10-01" … the digest day. */
  mtdFirstDay: string;
  mtdLastDay: string;
  /** The previous month's first day … the same day number (capped at that month's length). */
  priorFirstDay: string;
  priorLastDay: string;
  mtd: PaceTotals;
  prior: PaceTotals;
  /**
   * (mtd − prior) ÷ prior bookings, computed once here so the embed and the
   * model read can never state two different figures. null when there is no
   * fair comparison: no prior bookings, or either period has unmatched rows.
   */
  bookingsChange: number | null;
}

export interface PaceTotals {
  bookings: number;
  gmv: Metric;
  /** Service fees + Park Guard margin; PG rows with no recorded wholesale are excluded and counted in dirtyPgRows. */
  feeIncome: Metric;
  /** Rows partitionBookings could not classify as live or staging; they are NOT in bookings/gmv/feeIncome. */
  unmatched: number;
  dirtyPgRows: number;
}

/** Abandoned-checkout recovery email (#44) over the 7 ET days ending with the digest day. Live mode only. */
export interface RecoverySection {
  sent: number;
  failed: number;
  /**
   * Rows still `claimed` or parked in `retry`. A Resend outage or config failure
   * parks rows here; a retry older than the cron's 24 h candidate window is never
   * re-claimed, and a claim with send_started_at set may already have gone out.
   * So this is "in progress or stuck", not a send queue.
   */
  waiting: number;
  optOuts: number;
  /** Live confirmed bookings whose first or last touch carried utm_campaign=checkout_recovery (the email's link). */
  recoveredBookings: Metric;
}

export interface FunnelSection {
  originSearches: Baselined;
  distinctAirports: Metric;
  topAirports: Array<{ key: string; searches: number }>;
  datesDefaultedShare: Metric;
  meanResults: Metric;
  /**
   * Share of PRICED searches that returned zero bookable lots while at least one lot
   * was sold out ("nothing to book" — inventory, not an outage). The writer's
   * sold_out_count is counted BEFORE sold-out lots are filtered from results, so
   * "any lot sold out" is ~100% of searches every day and means nothing.
   */
  nothingBookableShare: Metric;
  /** Of the nothing-bookable searches, how many were degraded (ResLab wobble, not inventory) — reported, not attributed. */
  nothingBookableDegraded: number;
  /** Share of priced searches that showed the customer NO lot for ANY reason (the customer-visible outcome). */
  zeroResultShare: Metric;
  pricedSearches: number;
  nothingBookableByAirport: Array<{ key: string; share: number; priced: number }>;
  /** Σ sold-out lots ÷ Σ (sold-out + returned) lots over priced searches — inventory pressure. */
  lotSoldOutRate: Metric;
  degradedCount: Metric;
}

export interface LostSale {
  airport: string;
  lot: string;
  status: string;
  reason: string;
}

export interface LostSalesSection {
  byStatus: Record<string, number>;
  rows: LostSale[];
}

export interface EngagementSection {
  newsletterBySource: Record<string, number>;
  waitlistByAirport: Record<string, number>;
  chatSessions: Metric;
  welcomeCodesMinted: Metric;
}

export interface HealthSection {
  /** Production search-telemetry writer. "stale" = a row exists in the view's 7-day window but none in ~26 h. */
  telemetry:
    | { kind: "ok" | "stale"; lastRowAt: string; rows24h: number }
    | { kind: "silent_7d" }
    | { kind: "unavailable"; error: string };
  snapshot:
    | { kind: "off" }
    | { kind: "row"; ageHours: number; behind: boolean; stale: boolean; locationCount: number }
    | { kind: "missing" }
    | { kind: "error"; message: string };
  /** Live pending_bookings stuck > 1 h; an error carries its message so it can be flagged, not just "unavailable". */
  stuckPending: { kind: "n"; n: number } | { kind: "error"; message: string };
  /**
   * Live checkouts `completed` in the lookback with `email_sent = false` — the
   * customer may have no confirmation and nothing re-drives it. `numbers` are
   * shape-checked RTL… / TRP-… reservation numbers; `capped` = more rows than
   * the fetch cap (`n` is then a lower bound). An error is flagged, never 0.
   */
  emailNotSent: { kind: "n"; n: number; capped: boolean; numbers: string[]; lookbackDays: number } | { kind: "error"; message: string };
  /**
   * Live DIRECT-lot bookings still `confirmed` more than an hour after creation
   * whose lot was never sent its booking notice (4b plan §9 H-B) — the lot's
   * only channel. `numbers` are shape-checked TRP-… numbers. An error is
   * flagged, never 0.
   */
  /** Direct lots: bookings the LOT was never told about, and cancellations it
   *  was never told about. `capped` = the fetch hit LOT_NOTICE_CAP (show "n+"). */
  lotNotNotified:
    | { kind: "n"; n: number; numbers: string[]; capped: boolean; cancelN: number; cancelNumbers: string[]; cancelCapped: boolean }
    | { kind: "error"; message: string };
  /** "none" = no earlier posted digest; "error" = the run log could not be read (NOT the same as none). */
  lastDigest: { kind: "none" } | { kind: "days"; n: number } | { kind: "error"; message: string };
}

export interface DigestData {
  dateEt: string;
  windowLabel: string;
  generatedAt: string;
  bookings: Section<BookingsSection>;
  whereFrom: Section<WhereFromSection>;
  funnel: Section<FunnelSection>;
  lostSales: Section<LostSalesSection>;
  engagement: Section<EngagementSection>;
  health: Section<HealthSection>;
  /**
   * Comparison sections. NOT part of the run verdict (render.ts SECTION_NAMES):
   * a failure renders its own line as unavailable and never turns the digest
   * partial or could-not-run.
   */
  pace: Section<PaceSection>;
  recovery: Section<RecoverySection>;
}

export interface Flag {
  text: string;
}
