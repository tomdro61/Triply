/**
 * Billed parking days for one ResLab reservation date block (`history[0].dates[i]`).
 *
 * ResLab splits a stay into one `parking_rates` line per rate period, so the
 * stay is the SUM of the lines' `number_of_days` — the first line alone
 * under-counts. RTL869257 (Oct 22 06:00 → Oct 26 23:30, 5 days) came back as
 * Oct 22–24 at $7.95 (3 days) + Oct 25 at $6.95 (1) + Oct 26 at $5.95 (1), and
 * the confirmation page told the customer "3 days".
 *
 * Returns null (the page then prints no day count) when any line's count is not
 * a positive integer — an hourly line, or a shape we can't read. Never a guess.
 */
export function billedParkingDays(block: unknown): number | null {
  if (!isRecord(block)) return null;
  const lines = block.parking_rates;
  if (Array.isArray(lines) && lines.length > 0) {
    let total = 0;
    for (const line of lines) {
      const n = isRecord(line) ? line.number_of_days : undefined;
      if (!isPositiveInt(n)) return null;
      total += n;
    }
    return total;
  }
  // No rate lines: the block's own count, if ResLab sent one.
  return isPositiveInt(block.number_of_days) ? block.number_of_days : null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isPositiveInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 1;
}
