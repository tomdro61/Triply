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
 * One net-take figure as text. "—" when nothing is loaded, or when no booking
 * in the cell has a known figure: $0 would claim the bookings earned nothing.
 */
export function fmtNet(net: NetDisplayInput | null, loading = false): string {
  if (!net) return loading ? "…" : "—";
  if (net.blogNetKnown === 0) return "—";
  return fmtMoney(net.blogNet);
}
