import { isValidTimeZone } from "@/lib/utils/time";
import { calendarDayIn, shiftIsoDate } from "@/lib/digest/window";
import { checkInInstantMs } from "@/lib/cancellation/eligibility";
import { LOT_TOLD_OR } from "@/lib/direct/lot-told";
import { readManifestSchedule, wallDate, type AdminClient } from "@/lib/direct/manifest/schedule";
import { MANIFEST_RUNS_TABLE, STALE_RUN_MS, type RunRow } from "@/lib/direct/manifest/run";
import { normaliseRecipients, recipientsHash } from "@/lib/direct/manifest/select";

/**
 * What the direct-lot alerts cron looks for (6b plan §5). Read-only: every
 * scan returns the open problems it found, capped at SCAN_CAP, URGENT first;
 * the caller (run.ts) records, de-duplicates and posts them.
 *
 *   lot_notice     confirmed, the lot never told (`lot_notified_at` NULL), the
 *                  stay not over, made ≥ 20 min ago — any age once check-in is
 *                  < 2 h away — and not mid-send (claim < 60 s old). URGENT when
 *                  check-in is < 24 h away or passed, or the zone is unknown.
 *   cancel_notice  cancelled/refunded, the lot told of the booking (LOT_TOLD_OR)
 *                  but not of the cancellation, the stay not over; alerted 30 min
 *                  after first sight (the sweep re-drives it meanwhile). Plus
 *                  "phone the lot": cancelled, the lot NEVER emailed the booking,
 *                  but we raised a lot_notice alert for it (someone may have
 *                  phoned the lot) — nothing will ever email that cancellation.
 *   manifest       a reminder the lot should have had for tomorrow (from 20:00
 *                  lot time) or today and did not get; a run closed at the noon
 *                  cutoff without a confirmed send; a run that failed for any
 *                  reason other than a deliberate no-send.
 *   lot_config /   rows the manifest cron writes; open while it saw them in the
 *   followup       last hour.
 *
 * Booking times are literal lot-local TIMESTAMPs: compared as date strings,
 * turned into an instant only via `checkInInstantMs` with the booking's zone.
 * Item text and detail carry TRP numbers, lot ids, dates and reasons — never a
 * name, phone, email or address (they go to Discord and Sentry).
 */

export const ALERTS_TABLE = "direct_lot_alerts";
/** Most items per scan in one tick (URGENT first); the rest are counted as overflow. */
export const SCAN_CAP = 25;
/** Rows read per scan, soonest check-in first — far above a normal backlog. */
const SCAN_ROW_LIMIT = 200;
const RUN_ROW_LIMIT = 500;

export const LOT_NOTICE_GRACE_MS = 20 * 60_000;
export const LOT_NOTICE_FAST_PATH_MS = 2 * 3_600_000;
/** A booking-notice claim this fresh is a notice mid-send, not a missing one. */
export const NOTICE_MID_SEND_MS = 60_000;
export const URGENT_WITHIN_MS = 24 * 3_600_000;
export const CANCEL_GRACE_MS = 30 * 60_000;
/** lot_config / followup rows are open while the manifest cron saw them within this. */
export const CONFIG_FRESH_MS = 3_600_000;
/** Tomorrow's manifest is expected from 20:00 lot time (the window opened at 18:00). */
export const MANIFEST_EXPECTED_FROM_MIN = 20 * 60;
/**
 * A booking only "should have been" on a manifest when it was notified early
 * enough for an in-window tick to see it: half an hour ago, and before 22:40
 * lot time the evening before (the window closes at 23:00; ticks are 10 min).
 */
const MANIFEST_SETTLE_MS = 30 * 60_000;
const MANIFEST_LAST_TICK = "22:40:00";
const DELIBERATE_NO_SEND = ["nothing_to_list:", "superseded:"];

const DB_TIMEOUT_MS = 3_000;
const dbSignal = () => AbortSignal.timeout(DB_TIMEOUT_MS);

export type AlertKind = "lot_notice" | "cancel_notice" | "manifest" | "lot_config" | "followup";
export type ScanName = "lot_notice" | "cancel_notice" | "manifest" | "config";

/** An alert row's state as last recorded. */
export interface AlertState {
  firstSeenMs: number;
  alertedMs: number | null;
  /** detail.urgent of the last write — an item that just turned URGENT alerts at once. */
  prevUrgent: boolean;
}

export interface AlertItem {
  /** PaymentIntent id (booking alerts), "{lot}:{YYYY-MM-DD}" (manifest), the manifest cron's subject otherwise. */
  subject: string;
  kind: AlertKind;
  urgent: boolean;
  /** One line for Discord / Sentry: TRP number or lot id + a short reason. */
  text: string;
  /** direct_lot_alerts.detail — the same rule as `text`. */
  detail: Record<string, string | number | boolean>;
  /** Alerted only once first_seen_at is at least this old. */
  graceMs: number;
  /** This cron writes the row (last_seen_at + detail) every tick; lot_config / followup rows are the manifest cron's. */
  owned: boolean;
  /** Order within an urgency tier: soonest first. */
  sortKey: string;
  /** Known row state (the config scan reads it with the row; owned items are looked up by the caller). */
  state?: AlertState;
}

export interface ScanResult {
  items: AlertItem[];
  /** Items found beyond SCAN_CAP (not shown, not recorded this tick). */
  overflow: number;
  /** The row read hit its limit: there may be more than `items.length + overflow`. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Helpers

/** Addresses never reach Discord, Sentry or an alert row; long text is cut. */
export function redact(s: string, max = 300): string {
  return s.replace(/[^\s@<>()"',;]+@[^\s@<>()"',;]+/g, "[email]").slice(0, max);
}

/** A reservation number as shown in an alert — anything that is not a plain code is not echoed. */
export function displayNumber(n: unknown): string {
  const s = typeof n === "string" ? n.trim() : "";
  return /^[A-Za-z0-9-]{3,40}$/.test(s) ? s : "(unrecognised number)";
}

/** "YYYY-MM-DD HH:MM" of a TIMESTAMP literal — string slicing, never Date. */
function wallMinutes(ts: unknown): string {
  return String(ts ?? "").replace("T", " ").slice(0, 16);
}

function span(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 3_600_000) return `${Math.max(1, Math.round(abs / 60_000))} min`;
  if (abs < 48 * 3_600_000) return `${Math.round(abs / 3_600_000)} h`;
  return `${Math.round(abs / 86_400_000)} days`;
}
const relative = (ms: number) => (ms >= 0 ? `in ${span(ms)}` : `${span(ms)} ago`);

interface Zoned {
  location_timezone: string | null;
  lot_snapshot: { timezone?: unknown } | null;
}

/** Every valid zone the row names (D3 order). Two that disagree are both kept: the caller takes the more urgent. */
function zonesOf(r: Zoned): string[] {
  const snap = r.lot_snapshot && typeof r.lot_snapshot === "object" && typeof r.lot_snapshot.timezone === "string" ? r.lot_snapshot.timezone : null;
  return [...new Set([r.location_timezone, snap].filter(isValidTimeZone))];
}

/** Check-in as an instant, the earliest the row's zones allow; null = unknown (no valid zone or time). */
function checkInMs(checkIn: string, zones: string[]): number | null {
  const all = zones.map((z) => checkInInstantMs(checkIn, z)).filter((ms): ms is number => ms !== null);
  return all.length > 0 ? Math.min(...all) : null;
}

/** The DB bound for "the stay is not over": lot-local today − 1 is never earlier than UTC today − 2 in any US zone. */
function stayFloor(nowMs: number): string {
  return shiftIsoDate(calendarDayIn("UTC", new Date(nowMs)), -2);
}

/** check_out ≥ lot-local today − 1. An unknown zone keeps the row (the DB bound alone): never silently dropped. */
function stayOpen(checkOut: string, zones: string[], nowMs: number): boolean {
  if (zones.length === 0) return true;
  const today = zones.map((z) => calendarDayIn(z, new Date(nowMs))).sort()[0];
  return wallDate(checkOut) >= shiftIsoDate(today, -1);
}

function cap(items: AlertItem[], truncated: boolean): ScanResult {
  const sorted = [...items].sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.sortKey.localeCompare(b.sortKey));
  return { items: sorted.slice(0, SCAN_CAP), overflow: Math.max(0, sorted.length - SCAN_CAP), truncated };
}

const dbFail = (what: string, e: { code?: string; message: string }) => new Error(`${what} failed: ${e.code ?? "?"} ${e.message}`);

// ---------------------------------------------------------------------------
// lot_notice

interface NoticeRow extends Zoned {
  id: string;
  stripe_payment_intent_id: string | null;
  reslab_reservation_number: string | null;
  check_in: string;
  check_out: string;
  created_at: string | null;
  lot_notice_claimed_at: string | null;
}
const NOTICE_COLS = "id, stripe_payment_intent_id, reslab_reservation_number, check_in, check_out, created_at, lot_notice_claimed_at, location_timezone, lot_snapshot";

const subjectOf = (r: { id: string; stripe_payment_intent_id: string | null }) => r.stripe_payment_intent_id || `booking:${r.id}`;

export async function scanLotNotices(sb: AdminClient, livemode: boolean, nowMs: number): Promise<ScanResult> {
  const { data, error } = await sb
    .from("bookings")
    .select(NOTICE_COLS)
    .eq("inventory_source", "direct")
    .eq("livemode", livemode)
    .eq("status", "confirmed")
    .is("lot_notified_at", null)
    .gte("check_out", stayFloor(nowMs))
    .order("check_in")
    .limit(SCAN_ROW_LIMIT)
    .abortSignal(dbSignal());
  if (error) throw dbFail("lot_notice scan", error);
  const rows = (data ?? []) as NoticeRow[];

  const items: AlertItem[] = [];
  for (const r of rows) {
    const zones = zonesOf(r);
    if (!stayOpen(r.check_out, zones, nowMs)) continue;
    const claimedMs = Date.parse(r.lot_notice_claimed_at ?? "");
    if (!Number.isNaN(claimedMs) && nowMs - claimedMs < NOTICE_MID_SEND_MS) continue; // a notice mid-send
    const at = checkInMs(r.check_in, zones);
    const until = at === null ? null : at - nowMs;
    // An unknown zone is treated as close: never skipped, always URGENT.
    const fastPath = until === null || until < LOT_NOTICE_FAST_PATH_MS;
    const createdMs = Date.parse(r.created_at ?? "");
    const oldEnough = Number.isNaN(createdMs) || createdMs <= nowMs - LOT_NOTICE_GRACE_MS;
    if (!oldEnough && !fastPath) continue;
    const urgent = until === null || until < URGENT_WITHIN_MS;
    const number = displayNumber(r.reslab_reservation_number);
    const when = until === null ? "lot time zone unknown" : until >= 0 ? `check-in ${relative(until)}` : `check-in passed ${span(until)} ago`;
    items.push({
      subject: subjectOf(r),
      kind: "lot_notice",
      urgent,
      text: `${number} — the lot was never told of this booking; check-in ${wallMinutes(r.check_in)} lot time (${when})`,
      detail: { number, urgent, checkIn: wallMinutes(r.check_in), reason: "lot never told of this booking" },
      graceMs: 0,
      owned: true,
      sortKey: wallMinutes(r.check_in),
    });
  }
  return cap(items, rows.length >= SCAN_ROW_LIMIT);
}

// ---------------------------------------------------------------------------
// cancel_notice

interface CancelRow extends Zoned {
  id: string;
  stripe_payment_intent_id: string | null;
  reslab_reservation_number: string | null;
  check_in: string;
  check_out: string;
}
const CANCEL_COLS = "id, stripe_payment_intent_id, reslab_reservation_number, check_in, check_out, location_timezone, lot_snapshot";

export async function scanCancelNotices(sb: AdminClient, livemode: boolean, nowMs: number): Promise<ScanResult> {
  const floor = stayFloor(nowMs);
  const [told, untold] = await Promise.all([
    // `.or()` on a SELECT: PostgREST refuses it only on UPDATE.
    sb
      .from("bookings")
      .select(CANCEL_COLS)
      .eq("inventory_source", "direct")
      .eq("livemode", livemode)
      .in("status", ["cancelled", "refunded"])
      .is("lot_cancel_notified_at", null)
      .or(LOT_TOLD_OR)
      .gte("check_out", floor)
      .order("check_in")
      .limit(SCAN_ROW_LIMIT)
      .abortSignal(dbSignal()),
    // The complement of LOT_TOLD_OR: the lot was never emailed this booking.
    sb
      .from("bookings")
      .select(CANCEL_COLS)
      .eq("inventory_source", "direct")
      .eq("livemode", livemode)
      .in("status", ["cancelled", "refunded"])
      .is("lot_notified_at", null)
      .is("lot_notice_claimed_at", null)
      .is("lot_cancel_notified_at", null)
      .gte("check_out", floor)
      .order("check_in")
      .limit(SCAN_ROW_LIMIT)
      .abortSignal(dbSignal()),
  ]);
  if (told.error) throw dbFail("cancel_notice scan", told.error);
  if (untold.error) throw dbFail("cancel_notice (never told) scan", untold.error);
  const toldRows = ((told.data ?? []) as CancelRow[]).filter((r) => stayOpen(r.check_out, zonesOf(r), nowMs));
  const untoldRows = ((untold.data ?? []) as CancelRow[]).filter((r) => stayOpen(r.check_out, zonesOf(r), nowMs) && !!r.stripe_payment_intent_id);

  const items: AlertItem[] = toldRows.map((r) => {
    const number = displayNumber(r.reslab_reservation_number);
    return {
      subject: subjectOf(r),
      kind: "cancel_notice" as const,
      urgent: false,
      text: `${number} — cancelled, but the lot has not been sent the cancellation (check-in ${wallMinutes(r.check_in)} lot time)`,
      detail: { number, urgent: false, checkIn: wallMinutes(r.check_in), reason: "lot not sent the cancellation" },
      graceMs: CANCEL_GRACE_MS,
      owned: true,
      sortKey: wallMinutes(r.check_in),
    };
  });

  // "Phone the lot": only those we raised (and posted) a lot_notice alert for.
  if (untoldRows.length > 0) {
    const pis = untoldRows.map((r) => r.stripe_payment_intent_id as string);
    const { data: alerts, error } = await sb
      .from(ALERTS_TABLE)
      .select("subject, alerted_at")
      .eq("kind", "lot_notice")
      .eq("livemode", livemode)
      .in("subject", pis)
      .abortSignal(dbSignal());
    if (error) throw dbFail("cancel_notice (lot_notice alerts) read", error);
    const alerted = new Set(((alerts ?? []) as Array<{ subject: string; alerted_at: string | null }>).filter((a) => a.alerted_at != null).map((a) => a.subject));
    for (const r of untoldRows) {
      if (!alerted.has(r.stripe_payment_intent_id as string)) continue;
      const number = displayNumber(r.reslab_reservation_number);
      items.push({
        subject: subjectOf(r),
        kind: "cancel_notice",
        urgent: false,
        text: `${number} — cancelled; the lot was never emailed this booking but we alerted on it (it may have been phoned) — phone the lot to cancel (check-in ${wallMinutes(r.check_in)} lot time)`,
        detail: { number, urgent: false, checkIn: wallMinutes(r.check_in), reason: "phone the lot to cancel" },
        // Nothing will ever email this cancellation: no grace period to wait out.
        graceMs: 0,
        owned: true,
        sortKey: wallMinutes(r.check_in),
      });
    }
  }
  return cap(items, toldRows.length >= SCAN_ROW_LIMIT || untoldRows.length >= SCAN_ROW_LIMIT);
}

// ---------------------------------------------------------------------------
// manifest

interface DayBookingRow {
  stripe_payment_intent_id: string | null;
  reslab_reservation_number: string | null;
  direct_lot_id: string | number | null;
  check_in: string;
  check_out: string;
  lot_notified_at: string | null;
  cancel_state: string | null;
  cancel_claimed_at: string | null;
}

const RUN_COLS = "direct_lot_id, manifest_date, recipients_hash, status, attempt, claimed_at, had_unknown, sent_at, last_error";
type RunView = Pick<RunRow, "direct_lot_id" | "manifest_date" | "recipients_hash" | "status" | "attempt" | "claimed_at" | "had_unknown" | "sent_at" | "last_error">;

const deliberate = (run: RunView) => DELIBERATE_NO_SEND.some((p) => (run.last_error ?? "").startsWith(p));
const freshSending = (run: RunView, nowMs: number) => {
  const at = Date.parse(run.claimed_at);
  return run.status === "sending" && !Number.isNaN(at) && at >= nowMs - STALE_RUN_MS;
};
/** A run that answers "did the lot get a manifest?" — or whose problem is reported by the closed/failed rules below. */
const accountedFor = (run: RunView, nowMs: number) =>
  run.status === "sent" || run.status === "checked" || freshSending(run, nowMs) || (run.status === "failed" && !deliberate(run));

function missingReason(date: string, run: RunView | undefined, numbers: string[]): string {
  if (!run) {
    const listed = numbers.length > 0 ? ` (would list ${numbers.slice(0, 3).join(", ")}${numbers.length > 3 ? ` +${numbers.length - 3}` : ""})` : " (empty-day reminder)";
    return `no manifest for ${date}${listed}`;
  }
  if (run.status === "sending") return `manifest for ${date} not confirmed sent — stuck at attempt ${run.attempt}`;
  return `no manifest for ${date} (the run was closed without sending: ${redact(run.last_error ?? "", 80)})`;
}

export async function scanManifests(
  sb: AdminClient,
  livemode: boolean,
  nowMs: number,
  opts: { manifestsDisabled: boolean }
): Promise<ScanResult> {
  const schedule = await readManifestSchedule(sb, livemode, nowMs);
  const utcToday = calendarDayIn("UTC", new Date(nowMs));

  const runsRes = await sb
    .from(MANIFEST_RUNS_TABLE)
    .select(RUN_COLS)
    .eq("livemode", livemode)
    .gte("manifest_date", shiftIsoDate(utcToday, -2))
    .order("manifest_date")
    .limit(RUN_ROW_LIMIT)
    .abortSignal(dbSignal());
  if (runsRes.error) throw dbFail("manifest runs read", runsRes.error);
  const runs = (runsRes.data ?? []) as RunView[];

  const reasons = new Map<string, { lotId: string; date: string; list: string[] }>();
  const add = (lotId: string, date: string, reason: string) => {
    const key = `${lotId}:${date}`;
    const entry = reasons.get(key) ?? { lotId, date, list: [] };
    if (!entry.list.includes(reason)) entry.list.push(reason);
    reasons.set(key, entry);
  };

  // 1. Manifests that should be there and are not.
  const lotIds = schedule.lots.map((d) => d.lotId);
  if (lotIds.length > 0) {
    // [UTC today − 1, UTC today + 2) holds lot-local today and tomorrow in every US zone.
    const from = shiftIsoDate(utcToday, -1);
    const until = shiftIsoDate(utcToday, 2);
    const { data, error } = await sb
      .from("bookings")
      .select("stripe_payment_intent_id, reslab_reservation_number, direct_lot_id, check_in, check_out, lot_notified_at, cancel_state, cancel_claimed_at")
      .eq("inventory_source", "direct")
      .eq("livemode", livemode)
      .eq("status", "confirmed")
      .in("direct_lot_id", lotIds)
      .or(`and(check_in.gte.${from},check_in.lt.${until}),and(check_out.gte.${from},check_out.lt.${until})`)
      .limit(5_000)
      .abortSignal(dbSignal());
    if (error) throw dbFail("manifest bookings read", error);
    const rows = (data ?? []) as DayBookingRow[];
    // Listable = what the manifest would list (select.ts): notified, not mid-cancel.
    const listable = rows.filter((r) => r.lot_notified_at != null && r.cancel_state == null && r.cancel_claimed_at == null && !!r.stripe_payment_intent_id);

    const recipientsByPi = new Map<string, string[]>();
    if (listable.length > 0) {
      const { data: terms, error: termsError } = await sb
        .from("direct_booking_terms")
        .select("stripe_payment_intent_id, lot_recipients")
        .in("stripe_payment_intent_id", listable.map((r) => r.stripe_payment_intent_id as string))
        .abortSignal(dbSignal());
      if (termsError) throw dbFail("manifest terms read", termsError);
      for (const t of (terms ?? []) as Array<{ stripe_payment_intent_id: string; lot_recipients: string[] | null }>) {
        const set = normaliseRecipients(t.lot_recipients ?? []);
        if (set.length > 0) recipientsByPi.set(t.stripe_payment_intent_id, set);
      }
    }

    for (const day of schedule.lots) {
      const dates = [day.localDate, ...(day.localMinutes >= MANIFEST_EXPECTED_FROM_MIN ? [day.manifestDate] : [])];
      for (const date of dates) {
        const on = (r: DayBookingRow) => String(r.direct_lot_id) === day.lotId && (wallDate(r.check_in) === date || wallDate(r.check_out) === date);
        const lastTick = checkInInstantMs(`${shiftIsoDate(date, -1)} ${MANIFEST_LAST_TICK}`, day.timezone);
        const settleBefore = Math.min(nowMs - MANIFEST_SETTLE_MS, lastTick ?? Number.POSITIVE_INFINITY);
        const dayRuns = runs.filter((r) => String(r.direct_lot_id) === day.lotId && r.manifest_date === date);

        // Per recipient set (D2): one manifest each. Unlisted bookings are not
        // counted — they are URGENT lot_notice alerts already.
        const bySet = new Map<string, string[]>();
        for (const r of listable) {
          if (!on(r)) continue;
          const notifiedMs = Date.parse(r.lot_notified_at ?? "");
          if (!Number.isNaN(notifiedMs) && notifiedMs >= settleBefore) continue; // too late for an in-window tick
          const number = displayNumber(r.reslab_reservation_number);
          const set = recipientsByPi.get(r.stripe_payment_intent_id as string);
          if (!set) {
            add(day.lotId, date, `${number} has no lot recipients on file — it is on no manifest`);
            continue;
          }
          const hash = recipientsHash(set);
          bySet.set(hash, [...(bySet.get(hash) ?? []), number]);
        }
        for (const [hash, numbers] of bySet) {
          const run = dayRuns.find((r) => r.recipients_hash === hash);
          if (!run || !accountedFor(run, nowMs)) add(day.lotId, date, missingReason(date, run, numbers));
        }

        // Empty day (E1 gate passed, a CMS inbox, no confirmed booking at all that day): any run settles it.
        const emptyDay =
          !rows.some(on) &&
          schedule.emptyDayEligible.has(day.lotId) &&
          normaliseRecipients(schedule.cmsLots.get(day.lotId)?.notificationEmails ?? []).length > 0;
        if (emptyDay && !dayRuns.some((r) => accountedFor(r, nowMs))) {
          add(day.lotId, date, missingReason(date, dayRuns.find((r) => r.status === "sending") ?? dayRuns[0], []));
        }
      }
    }
  }

  // 2. Runs closed at the cutoff without a confirmed send, and failed runs.
  for (const run of runs) {
    const lotId = String(run.direct_lot_id);
    const zone = schedule.zones.get(lotId);
    const today = zone ? calendarDayIn(zone, new Date(nowMs)) : shiftIsoDate(utcToday, -1);
    if (run.manifest_date < today || deliberate(run)) continue;
    if (run.status === "checked" && run.sent_at == null) {
      add(lotId, run.manifest_date, `manifest for ${run.manifest_date} closed at the noon cutoff without a confirmed send — it may not have arrived`);
    } else if (run.status === "failed") {
      add(lotId, run.manifest_date, `manifest for ${run.manifest_date} failed to send (attempt ${run.attempt}: ${redact(run.last_error ?? "unknown error", 120)})`);
    }
  }

  const disabledNote = opts.manifestsDisabled ? " [DIRECT_LOT_MANIFEST_DISABLED is on]" : "";
  const items: AlertItem[] = [...reasons.values()].map(({ lotId, date, list }) => {
    const reason = redact(list.join("; "), 600);
    return {
      subject: `${lotId}:${date}`,
      kind: "manifest" as const,
      urgent: false,
      text: `Lot ${lotId} — ${reason}${disabledNote}`,
      detail: { lotId, manifestDate: date, urgent: false, reason },
      graceMs: 0,
      owned: true,
      sortKey: date,
    };
  });
  return cap(items, runs.length >= RUN_ROW_LIMIT);
}

// ---------------------------------------------------------------------------
// lot_config / followup (written by the manifest cron)

interface AlertRow {
  subject: string;
  kind: AlertKind;
  first_seen_at: string;
  last_seen_at: string;
  alerted_at: string | null;
  detail: Record<string, unknown> | null;
}

const str = (v: unknown, max = 200) => (typeof v === "string" || typeof v === "number" ? redact(String(v), max) : "");

export async function scanConfigAlerts(sb: AdminClient, livemode: boolean, nowMs: number): Promise<ScanResult> {
  const { data, error } = await sb
    .from(ALERTS_TABLE)
    .select("subject, kind, first_seen_at, last_seen_at, alerted_at, detail")
    .eq("livemode", livemode)
    .in("kind", ["lot_config", "followup"])
    .gte("last_seen_at", new Date(nowMs - CONFIG_FRESH_MS).toISOString())
    .order("last_seen_at")
    .limit(SCAN_ROW_LIMIT)
    .abortSignal(dbSignal());
  if (error) throw dbFail("lot_config/followup read", error);
  const rows = (data ?? []) as AlertRow[];

  const toItem = (r: AlertRow): AlertItem => {
    const d = r.detail ?? {};
    const lotId = str(d.lotId, 20) || "?";
    const text =
      r.kind === "followup"
        ? `${displayNumber(d.number)} — the follow-up cancellation for the lot ${lotId} manifest of ${str(d.manifestDate, 10) || "?"} was not confirmed sent after ${str(d.attempts, 4) || "?"} attempts — phone the lot`
        : `${lotId === "all" ? "All lots" : `Lot ${lotId}`} setup problem (${str(d.problem, 10) || "?"}): ${str(d.reason) || "see Sentry"}`;
    const firstSeenMs = Date.parse(r.first_seen_at);
    const alertedMs = r.alerted_at ? Date.parse(r.alerted_at) : null;
    return {
      subject: r.subject,
      kind: r.kind,
      urgent: false,
      text,
      detail: {},
      graceMs: 0,
      owned: false,
      sortKey: r.subject,
      state: {
        firstSeenMs: Number.isNaN(firstSeenMs) ? nowMs : firstSeenMs,
        alertedMs: alertedMs === null || Number.isNaN(alertedMs) ? null : alertedMs,
        prevUrgent: false,
      },
    };
  };
  const config = cap(rows.filter((r) => r.kind === "lot_config").map(toItem), false);
  const followup = cap(rows.filter((r) => r.kind === "followup").map(toItem), false);
  return { items: [...config.items, ...followup.items], overflow: config.overflow + followup.overflow, truncated: rows.length >= SCAN_ROW_LIMIT };
}
