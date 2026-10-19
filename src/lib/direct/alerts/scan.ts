import { isValidTimeZone } from "@/lib/utils/time";
import { calendarDayIn, shiftIsoDate } from "@/lib/digest/window";
import { checkInInstantMs } from "@/lib/cancellation/eligibility";
import { LOT_TOLD_OR } from "@/lib/direct/lot-told";
import { readManifestSchedule, wallDate, lotWallClock, pastCutoff, type AdminClient } from "@/lib/direct/manifest/schedule";
import { CUTOFF_NOT_SENT_REASON, MANIFEST_RUNS_TABLE, STALE_RUN_MS, type RunRow } from "@/lib/direct/manifest/run";
import { normaliseRecipients, recipientsHash } from "@/lib/direct/manifest/select";

/**
 * What the direct-lot alerts cron looks for (6b plan §5). Read-only: every
 * scan returns every open problem it found, uncapped; the caller (run.ts)
 * reads each item's alert row, drops the ones a person marked resolved
 * (`resolved_at`), caps each kind at SCAN_CAP (`cap`, URGENT first), records,
 * de-duplicates and posts them.
 *
 *   lot_notice     confirmed, the lot notice not stamped (`lot_notified_at`
 *                  NULL — "not confirmed": a few were sent but never stamped),
 *                  the stay not over, made ≥ 20 min ago — any age once check-in
 *                  is < 2 h away — and not mid-send (claim < 60 s old). URGENT
 *                  when check-in is < 24 h away or passed, or the zone is
 *                  unknown. Read and ranked upcoming check-ins first.
 *   cancel_notice  cancelled/refunded, the lot told of the booking (LOT_TOLD_OR)
 *                  but not of the cancellation, the stay not over; alerted 30 min
 *                  after first sight (the sweep re-drives it meanwhile). Plus
 *                  "phone the lot": cancelled, the booking notice never even
 *                  claimed, but its lot_notice alert reached someone — posted
 *                  (`alerted_at`, now or in an earlier episode), URGENT (a Sentry
 *                  email went out even if Discord failed), or resolved by an
 *                  admin who phoned the lot. Nothing will ever email that
 *                  cancellation.
 *   manifest       a reminder the lot should have had for tomorrow (from 20:00
 *                  lot time) or today and did not get; a run closed at the noon
 *                  cutoff without a confirmed send; a run that failed for any
 *                  reason other than a deliberate no-send; a `sent` run whose
 *                  date has passed (its follow-up cancels never completed); a
 *                  stale `sending` run that never reached Resend (had_unknown =
 *                  false) past the cutoff.
 *   lot_config     rows the manifest cron writes; open while it saw them in the
 *                  last hour (it rewrites them every tick while the problem lasts).
 *   followup       rows the manifest cron writes once, when a follow-up cancel
 *                  gave up; open until a person resolves it, while the stay is
 *                  not over (manifest date + 1 day ≥ lot-local today).
 *
 * Booking times are literal lot-local TIMESTAMPs: compared as date strings,
 * turned into an instant only via `checkInInstantMs` with the booking's zone.
 * Item text and detail carry TRP numbers, lot ids, dates and reasons — never a
 * name, phone, email or address (they go to Discord and Sentry).
 */

export const ALERTS_TABLE = "direct_lot_alerts";
/** Most items per kind in one tick (URGENT first); the rest are counted as overflow. */
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
/** lot_config rows are open while the manifest cron saw them within this. */
export const CONFIG_FRESH_MS = 3_600_000;
/**
 * DB bound for the followup read (the stay rule decides). A follow-up is written
 * no earlier than the evening before its manifest date, and a stay can last as
 * long as the booking window (100 days) — so a row last written over 110 days
 * ago is past any stay.
 */
const FOLLOWUP_LOOKBACK_MS = 110 * 86_400_000;
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
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every alert kind — the one list: the type, the order kinds are listed in within an urgency tier, the labels. */
export const ALERT_KINDS = ["lot_notice", "cancel_notice", "manifest", "followup", "lot_config"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Kinds whose rows THIS cron writes (last_seen_at + detail every tick). lot_config / followup rows are the manifest cron's. */
export const OWNED_KINDS = ["lot_notice", "cancel_notice", "manifest"] as const satisfies readonly AlertKind[];
export type OwnedKind = (typeof OWNED_KINDS)[number];
export const isOwnedKind = (kind: AlertKind): kind is OwnedKind => OWNED_KINDS.some((k) => k === kind);

export type ScanName = "lot_notice" | "cancel_notice" | "manifest" | "config";
/** The kinds each scan finds (each kind belongs to exactly one scan). */
export const SCAN_KINDS: Record<ScanName, readonly AlertKind[]> = {
  lot_notice: ["lot_notice"],
  cancel_notice: ["cancel_notice"],
  manifest: ["manifest"],
  config: ["lot_config", "followup"],
};

/** An alert row's state as last recorded, for the current episode. */
export interface AlertState {
  firstSeenMs: number;
  /** When Discord last accepted a post with this item in this episode; null = not yet. */
  alertedMs: number | null;
  /** detail.alertedUrgent: the last post Discord ACCEPTED showed it URGENT — an item that turns URGENT after that posts at once. */
  alertedUrgent: boolean;
  /** alerted_at was ever set (or detail.everAlerted, kept across episodes) — "phone the lot" reads it. */
  everAlerted: boolean;
  /**
   * Owned rows only: the row's last_seen_at as read, when it is so old the
   * problem was gone for a while and is back (a new episode). The caller resets
   * first_seen_at with a compare-and-set on this value. null = same episode.
   */
  newEpisodeFrom: string | null;
}

export type AlertDetail = Record<string, string | number | boolean>;

export interface AlertItem {
  /** PaymentIntent id (booking alerts), "{lot}:{YYYY-MM-DD}" (manifest), the manifest cron's subject otherwise. */
  subject: string;
  kind: AlertKind;
  urgent: boolean;
  /** One line for Discord / Sentry: TRP number or lot id + a short reason. */
  text: string;
  /** direct_lot_alerts.detail — the same rule as `text`. The writer adds `urgent` (run.ts `rowDetail`). */
  detail: AlertDetail;
  /** Alerted only once first_seen_at is at least this old. */
  graceMs: number;
  /** Order within an urgency tier: soonest first. */
  sortKey: string;
  /** Known row state (the config scan reads it with the row; owned items are looked up by the caller). */
  state?: AlertState;
}

export interface ScanResult {
  /** Every open item found — uncapped: the caller drops resolved ones, then caps (`cap`). */
  items: AlertItem[];
  /** A row read hit its limit: there may be more than `items.length`. */
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

const utcToday = (nowMs: number) => calendarDayIn("UTC", new Date(nowMs));

/** The DB bound for "the stay is not over": lot-local today − 1 is never earlier than UTC today − 2 in any US zone. */
function stayFloor(nowMs: number): string {
  return shiftIsoDate(utcToday(nowMs), -2);
}

/** `lastDay` ≥ lot-local today − 1. An unknown zone keeps the row (the DB bound alone): never silently dropped. */
function stayOpen(lastDay: string, zones: string[], nowMs: number): boolean {
  if (zones.length === 0) return true;
  const today = zones.map((z) => calendarDayIn(z, new Date(nowMs))).sort()[0];
  return wallDate(lastDay) >= shiftIsoDate(today, -1);
}

/** The items shown this tick (URGENT first, then by sortKey) and how many more there were. Call per kind. */
export function cap(items: AlertItem[]): { shown: AlertItem[]; overflow: number } {
  const sorted = [...items].sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.sortKey.localeCompare(b.sortKey));
  return { shown: sorted.slice(0, SCAN_CAP), overflow: Math.max(0, sorted.length - SCAN_CAP) };
}

/**
 * A failed read as one line. postgrest-js reports a fetch-level failure with an
 * empty code and the real cause ("Caused by: … ECONNRESET") only in `details`,
 * so that line is kept.
 */
const dbFail = (what: string, e: { code?: string; message: string; details?: string | null }) => {
  const cause = e.details?.match(/Caused by: [^\n]*/)?.[0];
  return new Error(`${what} failed: ${e.code || "?"} ${e.message}${cause ? ` (${cause})` : ""}`);
};

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
  const rowsWhere = () =>
    sb
      .from("bookings")
      .select(NOTICE_COLS)
      .eq("inventory_source", "direct")
      .eq("livemode", livemode)
      .eq("status", "confirmed")
      .is("lot_notified_at", null)
      .gte("check_out", stayFloor(nowMs));
  // Check-ins from UTC yesterday on first (soonest first), then the passed ones
  // fill what is left of the read: a backlog of stays already under way can
  // never push an imminent arrival out of it. `cap` ranks the same way.
  const upcomingFrom = shiftIsoDate(utcToday(nowMs), -1);
  const upcoming = await rowsWhere().gte("check_in", upcomingFrom).order("check_in").limit(SCAN_ROW_LIMIT).abortSignal(dbSignal());
  if (upcoming.error) throw dbFail("lot_notice scan", upcoming.error);
  const rows = [...((upcoming.data ?? []) as NoticeRow[])];
  if (rows.length < SCAN_ROW_LIMIT) {
    const passed = await rowsWhere().lt("check_in", upcomingFrom).order("check_in").limit(SCAN_ROW_LIMIT - rows.length).abortSignal(dbSignal());
    if (passed.error) throw dbFail("lot_notice (passed check-ins) scan", passed.error);
    rows.push(...((passed.data ?? []) as NoticeRow[]));
  }

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
    const passed = until !== null && until < 0;
    const number = displayNumber(r.reslab_reservation_number);
    const when = until === null ? "lot time zone unknown" : until >= 0 ? `check-in ${relative(until)}` : `check-in passed ${span(until)} ago`;
    items.push({
      subject: subjectOf(r),
      kind: "lot_notice",
      urgent,
      // "Not confirmed", not "never sent": a notice can be delivered and its stamp still fail.
      text: `${number} — lot notice not confirmed, it may not have arrived; check-in ${wallMinutes(r.check_in)} lot time (${when})`,
      detail: { number, checkIn: wallMinutes(r.check_in), reason: "lot notice not confirmed" },
      graceMs: 0,
      // Upcoming check-ins (soonest first) before passed ones.
      sortKey: `${passed ? 1 : 0}|${wallMinutes(r.check_in)}`,
    });
  }
  return { items, truncated: rows.length >= SCAN_ROW_LIMIT };
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

interface LotNoticeAlertRow {
  subject: string;
  alerted_at: string | null;
  resolved_at: string | null;
  detail: Record<string, unknown> | null;
}

/** The lot_notice alert reached someone: posted (now or in an earlier episode), URGENT (Sentry emailed), or resolved (the lot was phoned). */
const reachedSomeone = (a: LotNoticeAlertRow) =>
  a.alerted_at != null || a.resolved_at != null || a.detail?.urgent === true || a.detail?.everAlerted === true;

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
      detail: { number, checkIn: wallMinutes(r.check_in), reason: "lot not sent the cancellation" },
      graceMs: CANCEL_GRACE_MS,
      sortKey: wallMinutes(r.check_in),
    };
  });

  // "Phone the lot": only those whose lot_notice alert reached someone.
  if (untoldRows.length > 0) {
    const pis = untoldRows.map((r) => r.stripe_payment_intent_id as string);
    const { data: alerts, error } = await sb
      .from(ALERTS_TABLE)
      .select("subject, alerted_at, resolved_at, detail")
      .eq("kind", "lot_notice")
      .eq("livemode", livemode)
      .in("subject", pis)
      .abortSignal(dbSignal());
    if (error) throw dbFail("cancel_notice (lot_notice alerts) read", error);
    const reached = new Set(((alerts ?? []) as LotNoticeAlertRow[]).filter(reachedSomeone).map((a) => a.subject));
    for (const r of untoldRows) {
      if (!reached.has(r.stripe_payment_intent_id as string)) continue;
      const number = displayNumber(r.reslab_reservation_number);
      items.push({
        subject: subjectOf(r),
        kind: "cancel_notice",
        urgent: false,
        text: `${number} — cancelled; the lot was never emailed this booking but we alerted on it (it may have been phoned) — phone the lot to cancel (check-in ${wallMinutes(r.check_in)} lot time)`,
        detail: { number, checkIn: wallMinutes(r.check_in), reason: "phone the lot to cancel" },
        // Nothing will ever email this cancellation: no grace period to wait out.
        graceMs: 0,
        sortKey: wallMinutes(r.check_in),
      });
    }
  }
  return { items, truncated: toldRows.length >= SCAN_ROW_LIMIT || untoldRows.length >= SCAN_ROW_LIMIT };
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

/** A stale `sending` run. had_unknown marks a send that was started (it may have been delivered); without it the run never reached Resend. */
function stalledReason(run: RunView): string {
  return run.had_unknown
    ? `manifest for ${run.manifest_date} not confirmed sent — stuck at attempt ${run.attempt}`
    : `manifest for ${run.manifest_date} not sent — the run stalled before reaching Resend (attempt ${run.attempt})`;
}

function missingReason(date: string, run: RunView | undefined, numbers: string[]): string {
  if (!run) {
    const listed = numbers.length > 0 ? ` (would list ${numbers.slice(0, 3).join(", ")}${numbers.length > 3 ? ` +${numbers.length - 3}` : ""})` : " (empty-day reminder)";
    return `no manifest for ${date}${listed}`;
  }
  if (run.status === "sending") return stalledReason(run);
  return `no manifest for ${date} (the run was closed without sending: ${redact(run.last_error ?? "", 80)})`;
}

export async function scanManifests(
  sb: AdminClient,
  livemode: boolean,
  nowMs: number,
  opts: { manifestsDisabled: boolean }
): Promise<ScanResult> {
  const schedule = await readManifestSchedule(sb, livemode, nowMs);
  const today = utcToday(nowMs);

  const runsRes = await sb
    .from(MANIFEST_RUNS_TABLE)
    .select(RUN_COLS)
    .eq("livemode", livemode)
    .gte("manifest_date", shiftIsoDate(today, -2))
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
    const from = shiftIsoDate(today, -1);
    const until = shiftIsoDate(today, 2);
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

  // 2. Every run in the window, on its own terms.
  for (const run of runs) {
    if (deliberate(run)) continue;
    const lotId = String(run.direct_lot_id);
    const zone = schedule.zones.get(lotId);
    // Unknown zone: UTC today − 1 is never later than lot-local today in a US zone (alerts late, never early).
    const clock = zone ? lotWallClock(zone, nowMs) : null;
    const localToday = clock?.localDate ?? shiftIsoDate(today, -1);
    const datePassed = run.manifest_date < localToday;
    const cutoffPassed = clock ? pastCutoff(run.manifest_date, clock.localDate, clock.localMinutes) : datePassed;

    // `sent` is followed up and moved to `checked` on the next manifest tick; one
    // still `sent` after its date never had its follow-up cancels run.
    if (run.status === "sent" && datePassed) {
      add(lotId, run.manifest_date, `manifest for ${run.manifest_date} was sent, but its follow-up check never completed — a cancellation since may not have reached the lot`);
    }
    // Never reached Resend and can no longer be sent: the lot got nothing. Once
    // the date has passed with the lot's zone unknown, recovery closes such a
    // run `failed` with CUTOFF_NOT_SENT_REASON — still reported, in the same words.
    if (
      (run.status === "sending" && !run.had_unknown && !freshSending(run, nowMs) && cutoffPassed) ||
      (run.status === "failed" && (run.last_error ?? "").startsWith(CUTOFF_NOT_SENT_REASON))
    ) {
      add(lotId, run.manifest_date, stalledReason({ ...run, had_unknown: false }));
    }
    // May have been delivered, and its date has passed — but still open: its
    // follow-up cancels have not all gone (6b pass 2). Recovery closes it at the
    // cutoff even with the lot's zone unknown; one that stays open is reported.
    // No "fresh claim" exemption (6b pass 3): such a run never sends again, and
    // every recovery pass refreshes claimed_at, which would hide it each tick.
    if (run.status === "sending" && run.had_unknown && datePassed) {
      add(lotId, run.manifest_date, `manifest for ${run.manifest_date} may have been delivered; follow-ups pending — a cancellation since may not have reached the lot`);
    }
    if (datePassed) continue;
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
      detail: { lotId, manifestDate: date, reason },
      graceMs: 0,
      sortKey: date,
    };
  });
  return { items, truncated: runs.length >= RUN_ROW_LIMIT };
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

/** A followup subject is "{bookingId}:manifest:{lot}:{date}:{hash}". */
function followupParts(subject: string): { bookingId: string | null; lotId: string } {
  const [bookingId, source, lotId] = subject.split(":");
  return { bookingId: UUID_RE.test(bookingId ?? "") ? bookingId : null, lotId: source === "manifest" && /^[0-9]+$/.test(lotId ?? "") ? lotId : "" };
}

export async function scanConfigAlerts(sb: AdminClient, livemode: boolean, nowMs: number): Promise<ScanResult> {
  const cols = "subject, kind, first_seen_at, last_seen_at, alerted_at, detail";
  const [config, followup] = await Promise.all([
    // Rewritten every manifest tick while the problem lasts: open while fresh.
    sb
      .from(ALERTS_TABLE)
      .select(cols)
      .eq("livemode", livemode)
      .eq("kind", "lot_config")
      .is("resolved_at", null)
      .gte("last_seen_at", new Date(nowMs - CONFIG_FRESH_MS).toISOString())
      .order("last_seen_at")
      .limit(SCAN_ROW_LIMIT)
      .abortSignal(dbSignal()),
    // Written when a follow-up cancel gave up: open until resolved, while the stay lasts.
    // NEWEST first (6b pass 2): unresolved rows whose stay is over stay in the table
    // for the whole lookback, and reading the oldest first would let 200 of them
    // fill the limit before the stay filter below — starving a current failure.
    sb
      .from(ALERTS_TABLE)
      .select(cols)
      .eq("livemode", livemode)
      .eq("kind", "followup")
      .is("resolved_at", null)
      .gte("last_seen_at", new Date(nowMs - FOLLOWUP_LOOKBACK_MS).toISOString())
      .order("last_seen_at", { ascending: false })
      .limit(SCAN_ROW_LIMIT)
      .abortSignal(dbSignal()),
  ]);
  if (config.error) throw dbFail("lot_config read", config.error);
  if (followup.error) throw dbFail("followup read", followup.error);
  const configRows = (config.data ?? []) as AlertRow[];
  const followupRows = (followup.data ?? []) as AlertRow[];

  // The stay is the booking's: its zone decides lot-local today. Unknown zone:
  // UTC today − 1, never later than lot-local today in a US zone (closes late, never early).
  const zonesByBooking = new Map<string, string[]>();
  const bookingIds = [...new Set(followupRows.map((r) => followupParts(r.subject).bookingId).filter((id): id is string => id !== null))];
  if (bookingIds.length > 0) {
    const { data, error } = await sb.from("bookings").select("id, location_timezone, lot_snapshot").in("id", bookingIds).abortSignal(dbSignal());
    if (error) throw dbFail("followup bookings read", error);
    for (const b of (data ?? []) as Array<Zoned & { id: string }>) zonesByBooking.set(b.id, zonesOf(b));
  }
  const followupOpen = (r: AlertRow) => {
    // Open until the stay ends: the booking's check-out (`stayEnds`, literal wall clock) when recorded, else the
    // manifest date (older rows) — a cancellation matters to the lot until the car would have left.
    const stayEnds = typeof r.detail?.stayEnds === "string" ? r.detail.stayEnds.slice(0, 10) : null;
    const date = stayEnds && ISO_DATE_RE.test(stayEnds) ? stayEnds : r.detail?.manifestDate;
    if (typeof date !== "string" || !ISO_DATE_RE.test(date)) return true; // no date to judge by: keep it open
    const { bookingId } = followupParts(r.subject);
    const zones = bookingId ? zonesByBooking.get(bookingId) ?? [] : [];
    return zones.length > 0 ? stayOpen(date, zones, nowMs) : date >= shiftIsoDate(utcToday(nowMs), -2);
  };

  const toItem = (r: AlertRow): AlertItem => {
    const d = r.detail ?? {};
    const lotId = str(d.lotId, 20) || (r.kind === "followup" ? followupParts(r.subject).lotId : "") || "?";
    const attempts = str(d.attempts, 4);
    const text =
      r.kind === "followup"
        ? `${displayNumber(d.trp ?? d.number)} — the follow-up cancellation for the lot ${lotId} manifest of ${str(d.manifestDate, 10) || "?"} was not confirmed sent${attempts ? ` after ${attempts} attempts` : ""} — phone the lot`
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
      sortKey: r.subject,
      state: {
        firstSeenMs: Number.isNaN(firstSeenMs) ? nowMs : firstSeenMs,
        alertedMs: alertedMs === null || Number.isNaN(alertedMs) ? null : alertedMs,
        alertedUrgent: false,
        everAlerted: r.alerted_at != null,
        newEpisodeFrom: null,
      },
    };
  };
  return {
    items: [...configRows.map(toItem), ...followupRows.filter(followupOpen).map(toItem)],
    truncated: configRows.length >= SCAN_ROW_LIMIT || followupRows.length >= SCAN_ROW_LIMIT,
  };
}
