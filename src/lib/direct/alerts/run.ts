import * as Sentry from "@sentry/nextjs";
import { postToDiscord } from "@/lib/digest/discord";
import type { AdminClient } from "@/lib/direct/manifest/schedule";
import {
  ALERTS_TABLE,
  ALERT_KINDS,
  OWNED_KINDS,
  SCAN_KINDS,
  scanLotNotices,
  scanCancelNotices,
  scanManifests,
  scanConfigAlerts,
  cap,
  isOwnedKind,
  redact,
  type AlertDetail,
  type AlertItem,
  type AlertKind,
  type AlertState,
  type ScanName,
  type ScanResult,
} from "./scan";
import { buildAlertMessages, alertLine, ALERTS_USERNAME, type AlertMessage } from "./message";

/**
 * One tick of the direct-lot alerts cron (6b plan §5).
 *
 *   1 scan     four scans in parallel (scan.ts). A scan that fails runs once
 *              more while the budget allows (its reads change nothing); one that
 *              fails again is reported, counted, and the others still run.
 *   2 state    the alert row of every item this cron owns (lot_notice,
 *              cancel_notice, manifest). An item whose row a person resolved
 *              (`resolved_at`) is closed and dropped; then each kind is capped.
 *              A row not seen for EPISODE_GAP_MS is a new episode: treated as
 *              never alerted, and its first_seen_at reset (compare-and-set on
 *              the last_seen_at read). If the read fails, every item is treated
 *              as never alerted: lot_notice, manifest and phone-the-lot items
 *              post now; a told-lot cancel waits its grace.
 *   3 record   every shown item this cron owns is upserted — ONLY last_seen_at
 *              and detail, so first_seen_at (insert default) and alerted_at are
 *              never reset here. lot_config / followup rows are the manifest
 *              cron's.
 *   4 due      not alerted this episode (and first_seen_at past the item's
 *              grace), or alerted ≥ 1 h ago (URGENT) / 6 h (others), or URGENT
 *              now but not on the last post Discord accepted. The condition
 *              still holds: it was found now.
 *   5 Sentry   every due URGENT item → an error fingerprinted per item + kind
 *              (a new issue = Sentry's real-time email), whatever Discord does.
 *   6 post     one Discord message (split only past Discord's limits), URGENT
 *              first; alerted_at (= this tick's time) and detail.alertedUrgent
 *              are written ONLY for the items of a post Discord accepted, so a
 *              failed post re-alerts on the next tick and never uses up an
 *              URGENT escalation.
 *
 * `dry` reads and renders only: no row written, nothing posted, no Sentry event.
 */

export const URGENT_REALERT_MS = 3_600_000;
export const REALERT_MS = 6 * 3_600_000;
/**
 * An owned row whose last_seen_at is older than this was missed by at least
 * two ticks (`*\/10`; one skipped tick — a notice mid-send — is 20 min): the
 * problem went away and came back, a new episode.
 */
export const EPISODE_GAP_MS = 25 * 60_000;
/** No more upserts start with less than this left: the post (8 s + one retry) needs the rest. */
const POST_RESERVE_MS = 20_000;
const UPSERT_CONCURRENCY = 8;
const STATE_CHUNK = 100;
const DB_TIMEOUT_MS = 3_000;
const dbSignal = () => AbortSignal.timeout(DB_TIMEOUT_MS);
/**
 * A failed scan is retried only while this much of the budget is left: the
 * state read, the upserts and the post (POST_RESERVE_MS) come after it. A
 * cold-start timeout fails within a few seconds, well clear of it.
 */
const SCAN_RETRY_RESERVE_MS = 30_000;

export interface AlertsCronOptions {
  supabase: AdminClient;
  livemode: boolean;
  nowMs: number;
  /** Wall-clock (Date.now()) end of the run's budget. */
  deadlineMs: number;
  dry: boolean;
  /** Required unless `dry`. */
  webhookUrl: string | null;
  /** DIRECT_LOT_MANIFEST_DISABLED — noted on manifest alerts. */
  manifestsDisabled: boolean;
  fetchImpl?: typeof fetch;
}

export interface AlertsCronResult {
  ok: boolean;
  /** Suggested HTTP status: 500 for a failed scan or DB write, 502 for a failed Discord post. */
  status: number;
  livemode: boolean;
  dry: boolean;
  /** `retried`: the scan failed once and ran again (`ok` says how the retry went). */
  scans: Record<ScanName, { ok: boolean; retried: boolean; shown: number; overflow: number; truncated: boolean }>;
  /** Open items shown this tick (resolved ones and the overflow excluded). */
  open: number;
  /** Items closed this tick because a person marked them resolved. */
  resolved: number;
  due: number;
  urgentDue: number;
  posts: Array<{ items: number; urgent: number; outcome: "posted" | "failed"; status: number | null }>;
  /** Scan failures + DB read/write failures (a Discord failure is in `posts`). */
  errors: number;
  budgetExhausted: boolean;
  /** Every open item this tick (TRP numbers / lot ids only), due ones flagged. */
  lines: Array<{ kind: AlertKind; urgent: boolean; due: boolean; text: string }>;
  /** dry only: what would be posted. */
  messages?: Array<Omit<AlertMessage, "items">>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A bounded read that ran out of time (AbortSignal.timeout) — the cold-start case. */
const isTimeout = (e: unknown) => /TimeoutError|AbortError|aborted/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));

function report(fingerprint: string[], message: string, level: "warning" | "error") {
  Sentry.withScope((scope) => {
    scope.setFingerprint(["direct-lot-alerts", ...fingerprint]);
    scope.setTag("cron", "direct-lot-alerts");
    Sentry.captureMessage(redact(message, 500), level);
  });
}

/** One Sentry issue per item + kind: the real-time email for an URGENT problem. TRP number only. */
function reportUrgent(item: AlertItem, livemode: boolean) {
  Sentry.withScope((scope) => {
    scope.setFingerprint(["direct-lot-alert", item.kind, item.subject]);
    scope.setTag("cron", "direct-lot-alerts");
    scope.setTag("alert.kind", item.kind);
    scope.setLevel("error");
    Sentry.captureMessage(`Direct lot alert: ${alertLine(item, livemode)}`, "error");
  });
}

export function isDue(item: AlertItem, state: AlertState, nowMs: number): boolean {
  if (state.alertedMs === null) return nowMs - state.firstSeenMs >= item.graceMs;
  if (item.urgent && !state.alertedUrgent) return true;
  return nowMs - state.alertedMs >= (item.urgent ? URGENT_REALERT_MS : REALERT_MS);
}

const NEVER_ALERTED: AlertState = { firstSeenMs: 0, alertedMs: null, alertedUrgent: false, everAlerted: false, newEpisodeFrom: null };
const stateKey = (kind: AlertKind, subject: string) => `${kind}\u0000${subject}`;

/**
 * The one place an alert row's `detail` is built: the item's detail, whether
 * it is URGENT now, and the posting facts carried across writes (a write
 * replaces the whole JSON). `alertedUrgent` is set only by the post-accepted
 * write, so writing `urgent` before posting never uses up an escalation.
 */
function rowDetail(item: AlertItem, carried: { alertedUrgent: boolean; everAlerted: boolean }): AlertDetail {
  return {
    ...item.detail,
    urgent: item.urgent,
    ...(carried.alertedUrgent ? { alertedUrgent: true } : {}),
    ...(carried.everAlerted ? { everAlerted: true } : {}),
  };
}

interface StateRow {
  subject: string;
  kind: AlertKind;
  first_seen_at: string;
  last_seen_at: string;
  alerted_at: string | null;
  resolved_at: string | null;
  detail: Record<string, unknown> | null;
}

function stateOf(r: StateRow, nowMs: number): AlertState {
  const everAlerted = r.alerted_at != null || r.detail?.everAlerted === true;
  const lastSeen = Date.parse(r.last_seen_at);
  if (!Number.isNaN(lastSeen) && nowMs - lastSeen > EPISODE_GAP_MS) {
    return { firstSeenMs: nowMs, alertedMs: null, alertedUrgent: false, everAlerted, newEpisodeFrom: r.last_seen_at };
  }
  const first = Date.parse(r.first_seen_at);
  const alerted = r.alerted_at ? Date.parse(r.alerted_at) : NaN;
  return {
    firstSeenMs: Number.isNaN(first) ? nowMs : first,
    alertedMs: Number.isNaN(alerted) ? null : alerted,
    alertedUrgent: r.detail?.alertedUrgent === true,
    everAlerted,
    newEpisodeFrom: null,
  };
}

/** The rows of the owned items: state per item, and the items a person resolved. A failed chunk leaves its items unknown. */
async function readOwnedStates(sb: AdminClient, livemode: boolean, items: AlertItem[], nowMs: number) {
  const states = new Map<string, AlertState>();
  const resolved = new Set<string>();
  const failures: string[] = [];
  const subjects = [...new Set(items.filter((i) => isOwnedKind(i.kind)).map((i) => i.subject))];
  const chunks: string[][] = [];
  for (let i = 0; i < subjects.length; i += STATE_CHUNK) chunks.push(subjects.slice(i, i + STATE_CHUNK));
  await Promise.all(
    chunks.map(async (chunk) => {
      const { data, error } = await sb
        .from(ALERTS_TABLE)
        .select("subject, kind, first_seen_at, last_seen_at, alerted_at, resolved_at, detail")
        .eq("livemode", livemode)
        .in("kind", [...OWNED_KINDS])
        .in("subject", chunk)
        .abortSignal(dbSignal());
      if (error) {
        failures.push(`${error.code ?? "?"} ${error.message}`);
        return;
      }
      for (const r of (data ?? []) as StateRow[]) {
        const key = stateKey(r.kind, r.subject);
        if (r.resolved_at != null) resolved.add(key);
        else states.set(key, stateOf(r, nowMs));
      }
    })
  );
  return { states, resolved, failures };
}

export async function runAlertsCron(opts: AlertsCronOptions): Promise<AlertsCronResult> {
  const { supabase: sb, livemode, nowMs, deadlineMs, dry } = opts;
  let errors = 0;
  let budgetExhausted = false;
  const nowIso = new Date(nowMs).toISOString();

  // 1. Scans ------------------------------------------------------------------
  const scanners: Record<ScanName, () => Promise<ScanResult>> = {
    lot_notice: () => scanLotNotices(sb, livemode, nowMs),
    cancel_notice: () => scanCancelNotices(sb, livemode, nowMs),
    manifest: () => scanManifests(sb, livemode, nowMs, { manifestsDisabled: opts.manifestsDisabled }),
    config: () => scanConfigAlerts(sb, livemode, nowMs),
  };
  const names: ScanName[] = ["lot_notice", "cancel_notice", "manifest", "config"];
  // One retry: the usual failure is the first read on a cold instance outliving
  // its 3 s bound (TRIPLY-41), and the next tick is 10 min away. A recovered
  // retry is a warning (one issue per scan; none when dry) so a slowdown on
  // every tick still shows; a second failure is the scan error, naming both.
  const retried = new Set<ScanName>();
  // A retry may take as long as the first attempt did, so it must fit with the
  // reserve still left after it. A recovered timeout is a warning; any other
  // recovered failure is a real fault and gets its own error-level issue.
  const runScan = async (name: ScanName): Promise<ScanResult> => {
    const startedMs = Date.now();
    try {
      return await scanners[name]();
    } catch (first) {
      const leftMs = deadlineMs - Date.now();
      if (leftMs < SCAN_RETRY_RESERVE_MS + (Date.now() - startedMs)) {
        throw new Error(`${errorText(first)} (not retried: ${Math.round(leftMs / 1000)} s of budget left)`);
      }
      retried.add(name);
      let result: ScanResult;
      try {
        result = await scanners[name]();
      } catch (second) {
        throw new Error(`${errorText(second)} (retried; first attempt: ${errorText(first)})`);
      }
      const cause = isTimeout(first) ? "timeout" : "other";
      if (!dry) {
        report(
          ["scan-retry-recovered", name, cause],
          `Direct lot alerts: the ${name} scan failed (${cause}), then recovered on retry: ${errorText(first)}`,
          cause === "timeout" ? "warning" : "error"
        );
      }
      return result;
    }
  };
  const settled = await Promise.allSettled(names.map(runScan));
  const notRun = (name: ScanName) => ({ ok: false, retried: retried.has(name), shown: 0, overflow: 0, truncated: false });
  const scans: AlertsCronResult["scans"] = {
    lot_notice: notRun("lot_notice"),
    cancel_notice: notRun("cancel_notice"),
    manifest: notRun("manifest"),
    config: notRun("config"),
  };
  const found: AlertItem[] = [];
  settled.forEach((s, i) => {
    const name = names[i];
    if (s.status === "rejected") {
      errors++;
      report(["scan", name], `Direct lot alerts: the ${name} scan failed: ${errorText(s.reason)}`, "error");
      return;
    }
    scans[name] = { ok: true, retried: retried.has(name), shown: 0, overflow: 0, truncated: s.value.truncated };
    found.push(...s.value.items);
  });

  // 2. State: drop resolved items, then cap each kind ---------------------------
  const states = new Map<string, AlertState>();
  for (const item of found) if (item.state) states.set(stateKey(item.kind, item.subject), item.state);
  const owned = await readOwnedStates(sb, livemode, found, nowMs);
  for (const [key, state] of owned.states) states.set(key, state);
  if (owned.failures.length > 0) {
    // Unknown state: every item treated as never alerted — lot_notice, manifest and phone-the-lot post now; a told-lot cancel waits its grace.
    errors++;
    report(["db", "state read"], `Direct lot alerts: alert state read failed (${owned.failures.length} chunk(s)): ${owned.failures[0]}`, "error");
  }
  const open = found.filter((i) => !owned.resolved.has(stateKey(i.kind, i.subject)));
  const items: AlertItem[] = [];
  const overflow: Partial<Record<AlertKind, number>> = {};
  for (const kind of ALERT_KINDS) {
    const c = cap(open.filter((i) => i.kind === kind));
    items.push(...c.shown);
    if (c.overflow > 0) overflow[kind] = c.overflow;
  }
  for (const name of names) {
    if (!scans[name].ok) continue;
    const kinds = SCAN_KINDS[name];
    scans[name] = {
      ...scans[name],
      shown: items.filter((i) => kinds.includes(i.kind)).length,
      overflow: kinds.reduce((n, k) => n + (overflow[k] ?? 0), 0),
    };
  }
  const stateFor = (item: AlertItem) => states.get(stateKey(item.kind, item.subject));

  // 3. Record the items this cron owns -------------------------------------------
  if (!dry) {
    const toRecord = items.filter((i) => isOwnedKind(i.kind));
    for (let i = 0; i < toRecord.length; i += UPSERT_CONCURRENCY) {
      if (Date.now() + POST_RESERVE_MS > deadlineMs) {
        budgetExhausted = true;
        break;
      }
      await Promise.all(
        toRecord.slice(i, i + UPSERT_CONCURRENCY).map(async (item) => {
          const state = stateFor(item);
          const label = String(item.detail.number ?? item.subject);
          if (state?.newEpisodeFrom) {
            // A new episode: first_seen_at restarts (so a grace period applies again), and the old
            // alerted_at no longer counts. Compare-and-set on the last_seen_at read: a tick that
            // got here first already did it, and this matches nothing.
            const { error } = await sb
              .from(ALERTS_TABLE)
              .update({ first_seen_at: nowIso, alerted_at: null })
              .eq("subject", item.subject)
              .eq("kind", item.kind)
              .eq("livemode", livemode)
              .eq("last_seen_at", state.newEpisodeFrom)
              .abortSignal(dbSignal());
            if (error) {
              errors++;
              report(["db", "episode reset", item.kind], `Direct lot alerts: ${item.kind} episode reset failed (${label}): ${error.code ?? "?"} ${error.message}`, "error");
            }
          }
          // ONLY last_seen_at + detail: first_seen_at and alerted_at are never reset here.
          const { error } = await sb
            .from(ALERTS_TABLE)
            .upsert(
              {
                subject: item.subject,
                kind: item.kind,
                livemode,
                last_seen_at: nowIso,
                detail: rowDetail(item, { alertedUrgent: state?.alertedUrgent ?? false, everAlerted: state?.everAlerted ?? false }),
              },
              { onConflict: "subject,kind,livemode" }
            )
            .abortSignal(dbSignal());
          if (error) {
            errors++;
            report(["db", "alert write", item.kind], `Direct lot alerts: ${item.kind} row write failed (${label}): ${error.code ?? "?"} ${error.message}`, "error");
          }
        })
      );
    }
  }

  // 4. Due ---------------------------------------------------------------------
  const ordered = [...items].sort(
    (a, b) => Number(b.urgent) - Number(a.urgent) || ALERT_KINDS.indexOf(a.kind) - ALERT_KINDS.indexOf(b.kind) || a.sortKey.localeCompare(b.sortKey)
  );
  const dueSet = new Set<AlertItem>();
  for (const item of ordered) {
    if (isDue(item, stateFor(item) ?? { ...NEVER_ALERTED, firstSeenMs: nowMs }, nowMs)) dueSet.add(item);
  }
  const due = ordered.filter((i) => dueSet.has(i));
  const messages = buildAlertMessages(due, { livemode, overflow });

  const base = {
    livemode,
    dry,
    scans,
    open: items.length,
    resolved: found.length - open.length,
    due: due.length,
    urgentDue: due.filter((i) => i.urgent).length,
    lines: ordered.map((i) => ({ kind: i.kind, urgent: i.urgent, due: dueSet.has(i), text: alertLine(i, livemode) })),
  };

  if (dry) {
    const status = errors > 0 ? 500 : 200;
    return {
      ...base,
      ok: errors === 0,
      status,
      posts: [],
      errors,
      budgetExhausted,
      messages: messages.map(({ embed, content, allowedMentions }) => ({ embed, ...(content !== undefined ? { content } : {}), ...(allowedMentions ? { allowedMentions } : {}) })),
    };
  }

  // 5. Sentry, per URGENT item -------------------------------------------------
  for (const item of due) if (item.urgent) reportUrgent(item, livemode);

  // 6. Post ---------------------------------------------------------------------
  const posts: AlertsCronResult["posts"] = [];
  let postFailed = false;
  const webhook = opts.webhookUrl ?? "";
  if (messages.length > 0 && !webhook) throw new Error("direct lot alerts: no Discord webhook (the route checks this first)");
  for (const msg of messages) {
    const urgent = msg.items.filter((i) => i.urgent).length;
    const res = await postToDiscord(webhook, msg.embed, {
      remainingBudgetMs: Math.max(0, deadlineMs - Date.now()),
      username: ALERTS_USERNAME,
      ...(msg.content !== undefined ? { content: msg.content } : {}),
      ...(msg.allowedMentions ? { allowedMentions: msg.allowedMentions } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    if (res.kind !== "posted") {
      posts.push({ items: msg.items.length, urgent, outcome: "failed", status: res.status });
      postFailed = true;
      report(["discord"], `Direct lot alerts: Discord post failed (${res.status ?? "network"}): ${res.body} — ${msg.items.length} item(s) stay un-alerted and are retried next tick`, "error");
      break; // the rest stay due; the next tick tries again
    }
    posts.push({ items: msg.items.length, urgent, outcome: "posted", status: res.status });
    errors += await markAlerted(sb, livemode, msg.items, nowIso);
  }

  const status = errors > 0 ? 500 : postFailed ? 502 : 200;
  return { ...base, ok: status === 200, status, posts, errors, budgetExhausted };
}

/**
 * Record that Discord accepted a post with exactly these items, at the tick's
 * time (so "hourly" counts from the tick). Never a silent zero-row write:
 *
 *   owned kinds    an upsert per item (inserts the row if its record write
 *                  failed or was cut by the budget), with the full detail plus
 *                  alertedUrgent (this post showed it URGENT) and everAlerted.
 *   lot_config /   the manifest cron's rows (their detail is not ours to
 *   followup       rewrite): alerted_at only, and every subject the UPDATE did
 *                  not match is reported.
 *
 * Single-condition filters (no `.or()` on UPDATE). Returns the error count.
 */
async function markAlerted(sb: AdminClient, livemode: boolean, items: AlertItem[], nowIso: string): Promise<number> {
  let errors = 0;
  const kinds = [...new Set(items.map((i) => i.kind))];
  for (const kind of kinds) {
    const ofKind = items.filter((i) => i.kind === kind);
    if (isOwnedKind(kind)) {
      const failed: string[] = [];
      for (let i = 0; i < ofKind.length; i += UPSERT_CONCURRENCY) {
        await Promise.all(
          ofKind.slice(i, i + UPSERT_CONCURRENCY).map(async (item) => {
            const { error } = await sb
              .from(ALERTS_TABLE)
              .upsert(
                { subject: item.subject, kind, livemode, alerted_at: nowIso, detail: rowDetail(item, { alertedUrgent: item.urgent, everAlerted: true }) },
                { onConflict: "subject,kind,livemode" }
              )
              .abortSignal(dbSignal());
            if (error) failed.push(`${error.code ?? "?"} ${error.message}`);
          })
        );
      }
      if (failed.length > 0) {
        errors++;
        report(["db", "alerted_at", kind], `Direct lot alerts: posted, but alerted_at not recorded for ${failed.length} of ${ofKind.length} ${kind} item(s) — they will be posted again: ${failed[0]}`, "error");
      }
      continue;
    }
    const subjects = ofKind.map((i) => i.subject);
    const { data, error } = await sb
      .from(ALERTS_TABLE)
      .update({ alerted_at: nowIso })
      .eq("kind", kind)
      .eq("livemode", livemode)
      .in("subject", subjects)
      .select("subject")
      .abortSignal(dbSignal());
    if (error) {
      errors++;
      report(["db", "alerted_at", kind], `Direct lot alerts: posted, but alerted_at not recorded for ${subjects.length} ${kind} item(s) — they will be posted again: ${error.code ?? "?"} ${error.message}`, "error");
      continue;
    }
    const matched = new Set(((data ?? []) as Array<{ subject: string }>).map((r) => r.subject));
    const missing = subjects.filter((s) => !matched.has(s));
    if (missing.length > 0) {
      errors++;
      report(["db", "alerted_at missing", kind], `Direct lot alerts: posted, but ${missing.length} ${kind} row(s) were not found to record alerted_at — they will be posted again (${missing.slice(0, 3).join(", ")})`, "error");
    }
  }
  return errors;
}
