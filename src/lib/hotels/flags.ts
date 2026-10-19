/**
 * Park & Stay feature flags, resolved once per process (plan §7).
 *
 *   ENABLE_PARK_STAY    master switch ("true" enables)
 *   PARK_STAY_AIRPORTS  comma-separated IATA allowlist; EMPTY = off even when
 *                       the master is on
 *
 * Phase A checks it in four places, all answering 404 when off: the
 * /park-stay page and the /park-stay/[airport]/[hotelKey] page (resolved in
 * the Server Component — never a NEXT_PUBLIC_ var), /api/park-stay/search and
 * /api/park-stay/hotel (checked BEFORE input validation, so Production answers
 * 404 to any query). Phase B adds the checkout branch; fulfilment, crons,
 * webhooks and cancellation stay DELIBERATELY UNGATED — a card is already
 * authorised by then.
 *
 * Rollback = remove the codes / set the master false AND REDEPLOY: an env
 * change does not affect the running deployment.
 */

export interface ParkStayFlags {
  enabled: boolean;
  /** Upper-cased IATA codes. Empty when disabled. */
  airports: ReadonlySet<string>;
}

function parse(env: Record<string, string | undefined>): ParkStayFlags {
  const master = (env.ENABLE_PARK_STAY ?? "").trim().toLowerCase() === "true";
  const codes = (env.PARK_STAY_AIRPORTS ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{3}$/.test(c));
  const airports = new Set(master ? codes : []);
  return { enabled: master && airports.size > 0, airports };
}

let cached: ParkStayFlags | null = null;

export function parkStayFlags(): ParkStayFlags {
  if (!cached) cached = parse(process.env);
  return cached;
}

/** Is the tab / search / hotel page on for this airport? */
export function isParkStayEnabledFor(airportCode: string): boolean {
  const f = parkStayFlags();
  return f.enabled && f.airports.has(airportCode.toUpperCase());
}

/** Test seam: re-read the environment. */
export function __resetParkStayFlagsForTests(): void {
  cached = null;
}
