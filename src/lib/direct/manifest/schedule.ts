import { createAdminClient } from "@/lib/supabase/server";
import { isValidTimeZone, zonedWallClock } from "@/lib/utils/time";
import { calendarDayIn, shiftIsoDate } from "@/lib/digest/window";
import { fetchDirectLots, isSellable, type DirectLot } from "@/lib/direct/store";
import { isDirectCheckoutOpen } from "@/lib/direct/flag";

/**
 * Which lots get an evening manifest, and for which day (6b plan §3.1, D3, D5).
 *
 * Pure time arithmetic on wall clocks: a lot's "today" is `zonedWallClock` in
 * its IANA zone, the manifest is for lot-local today + 1, new manifests go out
 * 18:00–23:00 lot-local, and nothing is sent after 12:00 lot-local ON the
 * manifest date. Booking times are TIMESTAMP literals ("YYYY-MM-DDTHH:MM:SS")
 * and are only ever compared as strings — never turned into instants.
 *
 *   booked lots     confirmed direct bookings of this Stripe mode arriving or
 *                   departing in [UTC today − 1, UTC today + 2] — wide enough
 *                   to hold lot-local tomorrow in every US zone.
 *   empty-day lots  CMS lots that are sellable here AND whose checkout is open
 *                   (E1: never in production before DIRECT_BOOKING_OPEN) with
 *                   NO confirmed booking at all tomorrow, listed or not.
 *
 * Zone (D3): `bookings.location_timezone`, else `lot_snapshot.timezone`. Any
 * disagreement — within a booking, between bookings, or with the CMS lot — or
 * an invalid zone takes the lot out entirely and becomes a `lot_config`
 * problem: a manifest computed on the wrong day is worse than none.
 */

export type AdminClient = Awaited<ReturnType<typeof createAdminClient>>;

export interface ManifestLotDay {
  lotId: string;          // String(payloadId), e.g. "1" — never "direct-1"
  timezone: string;       // IANA
  localDate: string;      // lot-local today "YYYY-MM-DD"
  localMinutes: number;   // minutes since lot-local midnight (0..1439)
  manifestDate: string;   // lot-local today + 1
  hasBookingsTomorrow: boolean; // any confirmed booking (listed or not) for manifestDate
  expectsManifest: boolean;     // booked lot, or an empty-day lot that passes the E1 gate (§3.1)
}

export const MANIFEST_SEND_FROM_MIN = 18 * 60;   // 18:00
export const MANIFEST_SEND_UNTIL_MIN = 23 * 60;  // 23:00 (new sends)
export const MANIFEST_CUTOFF_MIN = 12 * 60;      // 12:00 on the manifest date (no more sends)

export interface LotProblem {
  lotId: string;
  kind: "tz" | "cms";
  /** Lot id, TRP numbers, zone names, error classes — never names, phones or emails. */
  detail: string;
}

/** Everything the manifest cron needs beyond the exported per-lot view. */
export interface ManifestSchedule {
  lots: ManifestLotDay[];
  problems: LotProblem[];
  /** Lot id → agreed IANA zone, for every lot whose zone is known (booked or CMS). Recovery uses it. */
  zones: Map<string, string>;
  /** CMS lots by id. Empty when the CMS read failed. */
  cmsLots: Map<string, DirectLot>;
  /** Empty-day lots that passed the E1 gate (sellable here + checkout open). */
  emptyDayEligible: Set<string>;
}

const DB_TIMEOUT_MS = 3_000;
/** Far above a few days of one lot's bookings; a full page means "can't be sure it is complete". */
const WINDOW_ROW_LIMIT = 5_000;
const LOT_ID_RE = /^[0-9]+$/;

/** "YYYY-MM-DD" of a TIMESTAMP literal as PostgREST returns it — string slicing, never Date. */
export function wallDate(ts: unknown): string {
  return String(ts ?? "").replace("T", " ").slice(0, 10);
}

/** Lot-local calendar date and minutes since midnight at an instant. The zone must be valid. */
export function lotWallClock(timezone: string, nowMs: number): { localDate: string; localMinutes: number } {
  const w = zonedWallClock(timezone, new Date(nowMs));
  return { localDate: w.date, localMinutes: Math.floor(w.secondsOfDay / 60) };
}

/** New manifests only 18:00–23:00 lot-local. */
export function inSendWindow(localMinutes: number): boolean {
  return localMinutes >= MANIFEST_SEND_FROM_MIN && localMinutes < MANIFEST_SEND_UNTIL_MIN;
}

/** At or after 12:00 lot-local on the manifest date (or any later day): no more manifest sends. */
export function pastCutoff(manifestDate: string, localDate: string, localMinutes: number): boolean {
  return localDate > manifestDate || (localDate === manifestDate && localMinutes >= MANIFEST_CUTOFF_MIN);
}

interface WindowRow {
  direct_lot_id: string | null;
  location_timezone: string | null;
  lot_snapshot: { timezone?: unknown } | null;
  check_in: string;
  check_out: string;
  reslab_reservation_number: string | null;
}

function snapshotZone(snapshot: WindowRow["lot_snapshot"]): string | null {
  return snapshot && typeof snapshot === "object" && typeof snapshot.timezone === "string" ? snapshot.timezone : null;
}

/** The full schedule. Throws when the bookings read fails (nothing can be decided without it). */
export async function readManifestSchedule(supabase: AdminClient, livemode: boolean, nowMs: number): Promise<ManifestSchedule> {
  const utcToday = calendarDayIn("UTC", new Date(nowMs));
  const from = shiftIsoDate(utcToday, -1);
  const until = shiftIsoDate(utcToday, 3); // exclusive: covers all of UTC today + 2
  const { data, error } = await supabase
    .from("bookings")
    .select("direct_lot_id, location_timezone, lot_snapshot, check_in, check_out, reslab_reservation_number")
    .eq("inventory_source", "direct")
    .eq("status", "confirmed")
    .eq("livemode", livemode)
    .or(`and(check_in.gte.${from},check_in.lt.${until}),and(check_out.gte.${from},check_out.lt.${until})`)
    .limit(WINDOW_ROW_LIMIT)
    .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
  if (error) throw new Error(`manifest schedule: bookings read failed: ${error.code ?? "?"} ${error.message}`);
  const rows = (data ?? []) as WindowRow[];
  if (rows.length >= WINDOW_ROW_LIMIT) throw new Error(`manifest schedule: ${rows.length} bookings in the window — cannot be sure the read is complete`);

  const problems: LotProblem[] = [];
  const tzIssues = new Map<string, string[]>();
  const addTzIssue = (lotId: string, issue: string) => tzIssues.set(lotId, [...(tzIssues.get(lotId) ?? []), issue]);

  // Booked lots: every row's zone, agreed per lot.
  const bookedRows = new Map<string, WindowRow[]>();
  const bookedZones = new Map<string, Set<string>>();
  for (const row of rows) {
    const lotId = String(row.direct_lot_id ?? "");
    if (!LOT_ID_RE.test(lotId)) {
      problems.push({ lotId: lotId || "unknown", kind: "cms", detail: `booking ${row.reslab_reservation_number ?? "?"} has a non-numeric direct_lot_id` });
      continue;
    }
    bookedRows.set(lotId, [...(bookedRows.get(lotId) ?? []), row]);
    const fromRow = row.location_timezone;
    const fromSnapshot = snapshotZone(row.lot_snapshot);
    const number = row.reslab_reservation_number ?? "?";
    if (fromRow && fromSnapshot && fromRow !== fromSnapshot) {
      addTzIssue(lotId, `${number}: location_timezone '${fromRow}' ≠ lot_snapshot '${fromSnapshot}'`);
      continue;
    }
    const zone = fromRow ?? fromSnapshot;
    if (!isValidTimeZone(zone)) {
      addTzIssue(lotId, `${number}: no valid zone (${JSON.stringify(zone)})`);
      continue;
    }
    bookedZones.set(lotId, (bookedZones.get(lotId) ?? new Set<string>()).add(zone));
  }

  // CMS lots: the empty-day candidates, and a zone for lots with no booking in the window.
  const cmsLots = new Map<string, DirectLot>();
  const cms = await fetchDirectLots({}, "/api/cron/direct-lot-manifest");
  if (!cms.ok) {
    problems.push({ lotId: "all", kind: "cms", detail: `CMS lot read failed (${cms.kind}${cms.code ? ` ${cms.code}` : ""}) — no empty-day manifests this run` });
  } else {
    for (const key of cms.droppedKeys) {
      problems.push({ lotId: key.id === null ? "unknown" : String(key.id), kind: "cms", detail: "CMS lot row did not parse (see Sentry direct_lots_parse)" });
    }
    for (const lot of cms.lots) cmsLots.set(String(lot.payloadId), lot);
  }

  const zones = new Map<string, string>();
  for (const [lotId, set] of bookedZones) {
    if (set.size > 1) addTzIssue(lotId, `bookings disagree: ${[...set].sort().join(" vs ")}`);
    else zones.set(lotId, [...set][0]);
  }
  for (const [lotId, lot] of cmsLots) {
    if (!isValidTimeZone(lot.timezone)) {
      addTzIssue(lotId, `CMS lot zone invalid (${JSON.stringify(lot.timezone)})`);
      continue;
    }
    const booked = zones.get(lotId);
    if (booked && booked !== lot.timezone) addTzIssue(lotId, `bookings say '${booked}', CMS airport says '${lot.timezone}'`);
    else if (!booked && !bookedRows.has(lotId)) zones.set(lotId, lot.timezone);
  }
  for (const [lotId, issues] of tzIssues) {
    zones.delete(lotId);
    problems.push({ lotId, kind: "tz", detail: issues.join("; ").slice(0, 500) });
  }

  const checkoutOpen = isDirectCheckoutOpen();
  const emptyDayEligible = new Set<string>();
  const lots: ManifestLotDay[] = [];
  const candidates = new Set<string>([...bookedRows.keys(), ...cmsLots.keys()]);
  for (const lotId of [...candidates].sort((a, b) => Number(a) - Number(b))) {
    if (tzIssues.has(lotId)) continue;
    const timezone = zones.get(lotId);
    if (!timezone) continue;
    const { localDate, localMinutes } = lotWallClock(timezone, nowMs);
    const manifestDate = shiftIsoDate(localDate, 1);
    const hasBookingsTomorrow = (bookedRows.get(lotId) ?? []).some(
      (r) => wallDate(r.check_in) === manifestDate || wallDate(r.check_out) === manifestDate
    );
    const cmsLot = cmsLots.get(lotId);
    const eligible = !!cmsLot && isSellable(cmsLot) && checkoutOpen;
    if (eligible) emptyDayEligible.add(lotId);
    if (eligible && !hasBookingsTomorrow && !cmsLot.notificationEmails.some((e) => e.trim())) {
      problems.push({ lotId, kind: "cms", detail: "sellable lot has no notification inbox — its empty-day manifest cannot be sent" });
    }
    if (!bookedRows.has(lotId) && !eligible) continue;
    lots.push({
      lotId,
      timezone,
      localDate,
      localMinutes,
      manifestDate,
      hasBookingsTomorrow,
      expectsManifest: hasBookingsTomorrow || eligible,
    });
  }
  return { lots, problems, zones, cmsLots, emptyDayEligible };
}

/**
 * The per-lot view the alerts cron imports: which lots should have a manifest
 * for tomorrow, and the zone/CMS problems found while deciding.
 */
export async function manifestLotDays(
  supabase: AdminClient,
  livemode: boolean,
  nowMs: number
): Promise<{ lots: ManifestLotDay[]; problems: Array<{ lotId: string; kind: "tz" | "cms"; detail: string }> }> {
  const s = await readManifestSchedule(supabase, livemode, nowMs);
  return { lots: s.lots, problems: s.problems };
}
