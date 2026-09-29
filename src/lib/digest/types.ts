/**
 * Digest data shapes. Every metric is `number | "unavailable"` — a failed or
 * uncovered query can never render as 0 (plan v2 §0).
 */

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

export interface WhereFromSection {
  byChannel: Array<{ key: string; bookings: number }>;
  topAirports: Array<{ key: string; bookings: number }>;
  landing: { blog: number; airportPage: number; homepage: number; other: number; none: number };
  aiReferrals: number;
  topBlogPosts: Array<{ path: string; bookings: number }>;
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
}

export interface Flag {
  text: string;
}
