/**
 * Display helpers for /admin/blog-bookings. No imports, so the client page can
 * use them without pulling server modules into its bundle.
 */

/** The NetFigures fields the display needs (see src/lib/admin/blog-bookings.ts). */
export interface NetDisplayInput {
  blogNet: number;
  blogNetKnown: number;
  blogNetUnknown: number;
}

export const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/**
 * One net-take figure as text. "…" while a net load is in flight (even over
 * figures from an earlier load, which that load may replace or withdraw).
 * "—" when nothing is loaded, or when no booking in the cell has a known
 * figure: $0 would claim the bookings earned nothing.
 */
export function fmtNet(net: NetDisplayInput | null, loading = false): string {
  if (loading) return "…";
  if (!net) return "—";
  if (net.blogNetKnown === 0) return "—";
  return fmtMoney(net.blogNet);
}

/** The NetSummary counts the wording needs (see src/lib/admin/blog-bookings.ts). */
export interface NetCountsInput {
  bookings: number;
  known: number;
  fetchErrors: number;
  skipped: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Why some blog bookings have no net figure, from the counts: ResLab reads
 * that failed, reads skipped when the time budget ran out, and the rest,
 * which are not a ResLab failure (the reconciler has no figure for a
 * disputed or direct-lot booking). Empty when every booking has a figure.
 */
export function netGapParts(c: NetCountsInput): string[] {
  const failed = Math.max(0, c.fetchErrors - c.skipped);
  const other = Math.max(0, c.bookings - c.known - c.fetchErrors);
  const parts: string[] = [];
  if (failed > 0) parts.push(`${plural(failed, "ResLab read", "ResLab reads")} failed`);
  if (c.skipped > 0) parts.push(`${plural(c.skipped, "booking", "bookings")} not read before the time limit`);
  if (other > 0) {
    parts.push(`${plural(other, "booking", "bookings")} without a figure for another reason (disputed and direct-lot bookings have none)`);
  }
  return parts;
}

/**
 * The page's "net take is partial" notice, or null. Null while a net load is
 * in flight: the cells show "…" then, and a notice about the previous load's
 * figures would describe numbers no longer on screen.
 */
export function partialNetNotice(c: NetCountsInput | null, loading: boolean): string | null {
  if (loading || c === null || c.fetchErrors === 0) return null;
  return `Net take is partial: it covers ${c.known} of ${c.bookings} blog bookings (${netGapParts(c).join("; ")}).`;
}

/** The net section's error when fewer than half the blog bookings have a figure. */
export function netShortfallText(c: NetCountsInput): string {
  const parts = netGapParts(c);
  return `net take has a figure for only ${c.known} of ${c.bookings} blog bookings${parts.length > 0 ? `: ${parts.join("; ")}` : ""}`;
}
