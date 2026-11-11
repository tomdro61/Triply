/**
 * Airport-local booking times as people read them. No imports, no server
 * APIs: safe in client components as well as server code.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-11-11 07:00:00" → "Nov 11, 2026 at 7:00 AM". String operations only —
 * the value is the customer's literal airport-local wall-clock time and must
 * never pass through Date math. Anything that does not match is shown as-is.
 */
export function formatLiteralDateTime(literal: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(literal.trim());
  if (!m) return literal;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return literal;
  const day = Number(m[3]);
  const hour24 = Number(m[4]);
  const minute = m[5];
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${month} ${day}, ${m[1]} at ${hour12}:${minute} ${suffix}`;
}
