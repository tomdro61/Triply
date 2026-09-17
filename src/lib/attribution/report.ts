/**
 * Pure aggregation for the admin attribution breakdowns. Extracted from the
 * stats route so the arithmetic is unit-testable and the route stays a
 * fetch-and-serialise shell.
 *
 * Status rule: only `confirmed` rows count as live bookings. A refunding
 * cancellation writes `refunded` (not `cancelled`) and a chargeback writes
 * `disputed`, so a "not cancelled" filter would count both as revenue.
 */
import { attributionSourceLabel, type AttributionRow, type AttributionSource } from "./display";

export interface ReportRow extends AttributionRow {
  airport_code: string | null;
  promo_code: string | null;
  discount_amount: string | number | null;
  grand_total: string | number | null;
  triply_service_fee: string | number | null;
  protection_plan: string | null;
  protection_plan_price: string | number | null;
  status: string;
}

export interface Agg {
  key: string;
  bookings: number;
  gross: number;
  triply: number;
  protected: number;
}

const num = (v: string | number | null | undefined) =>
  v === null || v === undefined ? 0 : parseFloat(String(v)) || 0;

export const grossOf = (b: ReportRow) =>
  num(b.grand_total) + num(b.triply_service_fee) + num(b.protection_plan_price);

export const isLive = (b: ReportRow) => b.status === "confirmed";

export function aggregate(rows: ReportRow[], keyOf: (b: ReportRow) => string): Agg[] {
  const map = new Map<string, Agg>();
  for (const b of rows) {
    if (!isLive(b)) continue;
    const key = keyOf(b);
    const a = map.get(key) ?? { key, bookings: 0, gross: 0, triply: 0, protected: 0 };
    a.bookings++;
    a.gross += grossOf(b);
    a.triply += num(b.triply_service_fee);
    if (b.protection_plan) a.protected++;
    map.set(key, a);
  }
  return [...map.values()].sort((x, y) => y.bookings - x.bookings);
}

export function byChannel(rows: ReportRow[]): Array<Agg & { key: AttributionSource }> {
  return aggregate(rows, (b) => attributionSourceLabel(b)) as Array<Agg & { key: AttributionSource }>;
}

export const airportKey = (b: ReportRow) =>
  b.airport_code && b.airport_code !== "RESLAB" ? b.airport_code : "unknown";

/** Top N airports; everything past N is folded into one "other" row so the
 *  share column always sums over ALL live bookings, not the displayed rows. */
export function byAirport(rows: ReportRow[], top = 12): { rows: Agg[]; total: number } {
  const all = aggregate(rows, airportKey);
  const total = all.reduce((n, a) => n + a.bookings, 0);
  if (all.length <= top) return { rows: all, total };
  const head = all.slice(0, top);
  const tail = all.slice(top);
  const other = tail.reduce(
    (o, a) => ({
      key: "other",
      bookings: o.bookings + a.bookings,
      gross: o.gross + a.gross,
      triply: o.triply + a.triply,
      protected: o.protected + a.protected,
    }),
    { key: "other", bookings: 0, gross: 0, triply: 0, protected: 0 }
  );
  return { rows: [...head, other], total };
}

export interface PromoMeta {
  code: string;
  discount_percent: number | null;
  active: boolean | null;
  current_uses: number | null;
  max_uses: number | null;
  expires_at: string | null;
}

export interface PromoReportRow {
  code: string;
  bookings: number;
  discount: number;
  gross: number;
  triply: number;
  currentUses: number | null;
  maxUses: number | null;
  active: boolean | null;
  discountPercent: number | null;
  expired: boolean;
}

/** Derived booking count + discount per code, next to the DB counter so
 *  trigger drift (a 0-row UPDATE, a casing mismatch) is visible. Active codes
 *  with no bookings are listed too — that is where "SAVE20 is live with no
 *  purpose" becomes visible. */
export function buildPromoReport(rows: ReportRow[], meta: PromoMeta[], now = Date.now()): PromoReportRow[] {
  const agg = new Map<string, { bookings: number; discount: number; gross: number; triply: number }>();
  for (const b of rows) {
    if (!b.promo_code || !isLive(b)) continue;
    const p = agg.get(b.promo_code) ?? { bookings: 0, discount: 0, gross: 0, triply: 0 };
    p.bookings++;
    p.discount += num(b.discount_amount);
    p.gross += grossOf(b);
    p.triply += num(b.triply_service_fee);
    agg.set(b.promo_code, p);
  }
  const metaByCode = new Map(meta.map((m) => [m.code.toUpperCase(), m]));
  const out: PromoReportRow[] = [];
  const seen = new Set<string>();
  for (const [code, p] of agg) {
    const m = metaByCode.get(code.toUpperCase());
    seen.add(code.toUpperCase());
    out.push({
      code,
      ...p,
      currentUses: m?.current_uses ?? null,
      maxUses: m?.max_uses ?? null,
      active: m?.active ?? null,
      discountPercent: m?.discount_percent ?? null,
      expired: !!m?.expires_at && new Date(m.expires_at).getTime() < now,
    });
  }
  for (const m of meta) {
    if (!m.active || seen.has(m.code.toUpperCase())) continue;
    out.push({
      code: m.code,
      bookings: 0,
      discount: 0,
      gross: 0,
      triply: 0,
      currentUses: m.current_uses,
      maxUses: m.max_uses,
      active: m.active,
      discountPercent: m.discount_percent,
      expired: !!m.expires_at && new Date(m.expires_at).getTime() < now,
    });
  }
  return out.sort((x, y) => y.bookings - x.bookings || x.code.localeCompare(y.code));
}

/** Capture health over recent rows. Only a VALID cookie counts as present —
 *  the invalid marker is exactly the regression this metric exists to catch,
 *  so it is reported separately and must never read as "captured". */
export function presentRate(rows: Array<{ attribution: AttributionRow["attribution"] }>): {
  presentRate: number | null;
  invalidRate: number | null;
  total: number;
} {
  const total = rows.length;
  if (total === 0) return { presentRate: null, invalidRate: null, total };
  const valid = rows.filter((r) => r.attribution !== null && r.attribution?.v === 1).length;
  const invalid = rows.filter((r) => r.attribution !== null && r.attribution?.v === null).length;
  return { presentRate: valid / total, invalidRate: invalid / total, total };
}
