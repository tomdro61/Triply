import type { UnifiedLot } from "@/types/lot";

const STOPPED =
  /\b(?:suspended|discontinued|paused|no longer|not operating|out of service)\b|^\s*(?:n\/?a|none)\s*\.?\s*$|\bshuttle\s*:\s*none\b/i;
const RUNS = /\bruns?\b|\bevery\s+\d|\bon[\s-]demand\b|\b24\/7\b|\b24\s*(?:hours|hrs)\b|\bcomplimentary\b|\bfree\s+shuttle\b/i;
const NONE = /\bno\s+shuttle\b|\bnot\s+(?:available|offered|running|provided)\b|\bunavailable\b|\bnone\s+available\b|\bno\s+longer\s+offered\b/i;
// "No free shuttle", "Shuttle does not run": a run word under a negation.
const NEGATED = /\b(?:no|not|doesn'?t|does\s+not)\s+(?:\w+\s+){0,2}(?:shuttle|runs?|complimentary|free)\b/i;

// A stop or "none" limited to some hours or days ("12:00 AM - 5:00 AM: No
// shuttle.", "unavailable on holidays") is a gap in a shuttle that runs the
// rest of the time. Only a clock range counts: "3-1-2026" or "555-1234" doesn't.
const PARTIAL = /\b\d{1,2}(?::\d\d)?\s*(?:[AP]M\s*[-–]\s*\d{1,2}(?::\d\d)?\s*(?:[AP]M)?|[-–]\s*\d{1,2}(?::\d\d)?\s*[AP]M)\b|\bon\s+(?:holidays|weekends|sundays|saturdays)\b/i;

/**
 * Whether a lot's free-text shuttle summary lists a running shuttle. The summary is
 * free text from the lot ("24/7 on demand", "No Shuttle", "Shuttle temporarily
 * suspended. You may arrange for your own Uber/Lyft"), so a summary that is
 * present is not proof of a shuttle: the Norfolk page said "Most lots offer
 * complimentary shuttle service" for a lot whose shuttle was suspended.
 *
 * Order matters:
 * 1. A shuttle that has stopped ("suspended", "discontinued", "None", "N/A")
 *    is never a shuttle, whatever else the text says.
 * 2. A sign that it runs ("runs", "every 20 minutes", "on demand", "24/7")
 *    wins over a partial "no shuttle": "12:00 AM - 5:00 AM: No shuttle." is
 *    the overnight gap of a lot that does run one.
 * 3. Otherwise a "no shuttle" / "not available" means none.
 *    Steps 1 and 3, and a negated run word ("no free shuttle"), are skipped
 *    for a gap limited to some hours or days (PARTIAL).
 * 4. Otherwise the word "shuttle" means one; anything else ("Walk to
 *    terminal") means none.
 */
export function runsShuttle(summary: string | null | undefined): boolean {
  if (!summary || !summary.trim()) return false;
  const partial = PARTIAL.test(summary);
  if (!partial && STOPPED.test(summary)) return false;
  if (!partial && NEGATED.test(summary)) return false;
  if (RUNS.test(summary)) return true;
  if (!partial && NONE.test(summary)) return false;
  return /\bshuttle/i.test(summary);
}

/**
 * Whether the page may say this lot runs a shuttle: only when its own summary
 * says so. A lot with no summary gets no shuttle claim (as before this change):
 * a "free shuttle" amenity can outlive a suspended shuttle.
 */
export function lotRunsShuttle(lot: Pick<UnifiedLot, "shuttleInfo">): boolean {
  return runsShuttle(lot.shuttleInfo?.summary);
}
