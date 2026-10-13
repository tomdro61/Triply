import * as Sentry from "@sentry/nextjs";
import { postToDiscord } from "@/lib/digest/discord";
import type { AdminClient } from "@/lib/direct/manifest/schedule";
import {
  ALERTS_TABLE,
  scanLotNotices,
  scanCancelNotices,
  scanManifests,
  scanConfigAlerts,
  redact,
  type AlertItem,
  type AlertKind,
  type AlertState,
  type ScanName,
  type ScanResult,
} from "./scan";
import { buildAlertMessages, alertLine, ALERTS_USERNAME, KIND_ORDER, type AlertMessage } from "./message";

/**
 * One tick of the direct-lot alerts cron (6b plan §5).
 *
 *   1 scan     four scans in parallel (scan.ts); one that fails is reported,
 *              counted, and the others still run.
 *   2 record   every item this cron owns is upserted — ONLY last_seen_at and
 *              detail, so first_seen_at (insert default) and alerted_at are
 *              never reset. lot_config / followup rows are the manifest cron's.
 *   3 due      alerted_at NULL (and first_seen_at past the item's grace), or
 *              alerted_at older than 1 h (URGENT) / 6 h (others), or the item
 *              just turned URGENT. The condition still holds: it was found now.
 *   4 Sentry   every due URGENT item → an error fingerprinted per item + kind
 *              (a new issue = Sentry's real-time email), whatever Discord does.
 *   5 post     one Discord message (split only past Discord's limits), URGENT
 *              first; alerted_at is set ONLY for the items of a post Discord
 *              accepted, so a failed post re-alerts on the next tick.
 *
 * `dry` reads and renders only: no row written, nothing posted, no Sentry event.
 */

export const URGENT_REALERT_MS = 3_600_000;
export const REALERT_MS = 6 * 3_600_000;
/** No more upserts start with less than this left: the post (8 s + one retry) needs the rest. */
const POST_RESERVE_MS = 20_000;
const UPSERT_CONCURRENCY = 8;
const DB_TIMEOUT_MS = 3_000;
const dbSignal = () => AbortSignal.timeout(DB_TIMEOUT_MS);
const OWNED_KINDS: AlertKind[] = ["lot_notice", "cancel_notice", "manifest"];

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
  scans: Record<ScanName, { ok: boolean; shown: number; overflow: number; truncated: boolean }>;
  open: number;
  due: number;
  urgentDue: number;
  posts: Array<{ items: number; urgent: number; outcome: "posted" | "failed"; status: number | null }>;
  /** Scan failures + DB write failures (a Discord failure is in `posts`). */
  errors: number;
  budgetExhausted: boolean;
  /** Every open item this tick (TRP numbers / lot ids only), due ones flagged. */
  lines: Array<{ kind: AlertKind; urgent: boolean; due: boolean; text: string }>;
  /** dry only: what would be posted. */
  messages?: Array<Omit<AlertMessage, "items">>;
}

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
  if (item.urgent && !state.prevUrgent) return true;
  return nowMs - state.alertedMs >= (item.urgent ? URGENT_REALERT_MS : REALERT_MS);
}

const stateKey = (kind: AlertKind, subject: string) => `${kind}\u0000${subject}`;

interface StateRow {
  subject: string;
  kind: AlertKind;
  first_seen_at: string;
  alerted_at: string | null;
  detail: Record<string, unknown> | null;
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
  const settled = await Promise.allSettled(names.map((n) => scanners[n]()));
  const notRun = { ok: false, shown: 0, overflow: 0, truncated: false };
  const scans: AlertsCronResult["scans"] = { lot_notice: notRun, cancel_notice: notRun, manifest: notRun, config: notRun };
  const items: AlertItem[] = [];
  const overflow: Partial<Record<AlertKind, number>> = {};
  settled.forEach((s, i) => {
    const name = names[i];
    if (s.status === "rejected") {
      errors++;
      report(["scan", name], `Direct lot alerts: the ${name} scan failed: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`, "error");
      return;
    }
    scans[name] = { ok: true, shown: s.value.items.length, overflow: s.value.overflow, truncated: s.value.truncated };
    items.push(...s.value.items);
    if (s.value.overflow > 0) {
      const kind = name === "config" ? "lot_config" : name;
      overflow[kind] = (overflow[kind] ?? 0) + s.value.overflow;
    }
  });

  // 2. State of the items this cron owns, then record them ----------------------
  const owned = items.filter((i) => i.owned);
  const states = new Map<string, AlertState>();
  for (const item of items) if (item.state) states.set(stateKey(item.kind, item.subject), item.state);
  for (let i = 0; i < owned.length; i += 100) {
    const chunk = owned.slice(i, i + 100);
    const { data, error } = await sb
      .from(ALERTS_TABLE)
      .select("subject, kind, first_seen_at, alerted_at, detail")
      .eq("livemode", livemode)
      .in("kind", OWNED_KINDS)
      .in("subject", [...new Set(chunk.map((c) => c.subject))])
      .abortSignal(dbSignal());
    if (error) {
      // Unknown state: the items are treated as new (lot_notice alerts at once; cancel waits its grace).
      errors++;
      report(["db", "state read"], `Direct lot alerts: alert state read failed: ${error.code ?? "?"} ${error.message}`, "error");
      continue;
    }
    for (const r of (data ?? []) as StateRow[]) {
      const first = Date.parse(r.first_seen_at);
      const alerted = r.alerted_at ? Date.parse(r.alerted_at) : NaN;
      states.set(stateKey(r.kind, r.subject), {
        firstSeenMs: Number.isNaN(first) ? nowMs : first,
        alertedMs: Number.isNaN(alerted) ? null : alerted,
        prevUrgent: r.detail?.urgent === true,
      });
    }
  }

  if (!dry) {
    for (let i = 0; i < owned.length; i += UPSERT_CONCURRENCY) {
      if (Date.now() + POST_RESERVE_MS > deadlineMs) {
        budgetExhausted = true;
        break;
      }
      await Promise.all(
        owned.slice(i, i + UPSERT_CONCURRENCY).map(async (item) => {
          // ONLY last_seen_at + detail: first_seen_at and alerted_at are never reset.
          const { error } = await sb
            .from(ALERTS_TABLE)
            .upsert({ subject: item.subject, kind: item.kind, livemode, last_seen_at: nowIso, detail: item.detail }, { onConflict: "subject,kind,livemode" })
            .abortSignal(dbSignal());
          if (error) {
            errors++;
            report(["db", "alert write", item.kind], `Direct lot alerts: ${item.kind} row write failed (${String(item.detail.number ?? item.subject)}): ${error.code ?? "?"} ${error.message}`, "error");
          }
        })
      );
    }
  }

  // 3. Due ---------------------------------------------------------------------
  const ordered = [...items].sort(
    (a, b) => Number(b.urgent) - Number(a.urgent) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.sortKey.localeCompare(b.sortKey)
  );
  const dueSet = new Set<AlertItem>();
  for (const item of ordered) {
    const state = states.get(stateKey(item.kind, item.subject)) ?? { firstSeenMs: nowMs, alertedMs: null, prevUrgent: false };
    if (isDue(item, state, nowMs)) dueSet.add(item);
  }
  const due = ordered.filter((i) => dueSet.has(i));
  const messages = buildAlertMessages(due, { livemode, overflow });

  const base = {
    livemode,
    dry,
    scans,
    open: items.length,
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

  // 4. Sentry, per URGENT item -------------------------------------------------
  for (const item of due) if (item.urgent) reportUrgent(item, livemode);

  // 5. Post ---------------------------------------------------------------------
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
    errors += await markAlerted(sb, livemode, msg.items);
  }

  const status = errors > 0 ? 500 : postFailed ? 502 : 200;
  return { ...base, ok: status === 200, status, posts, errors, budgetExhausted };
}

/** alerted_at for exactly the items of an accepted post. Single-condition filters (no `.or()` on UPDATE). Returns the error count. */
async function markAlerted(sb: AdminClient, livemode: boolean, items: AlertItem[]): Promise<number> {
  const at = new Date().toISOString();
  let errors = 0;
  for (const kind of KIND_ORDER) {
    const subjects = items.filter((i) => i.kind === kind).map((i) => i.subject);
    if (subjects.length === 0) continue;
    const { error } = await sb
      .from(ALERTS_TABLE)
      .update({ alerted_at: at })
      .eq("kind", kind)
      .eq("livemode", livemode)
      .in("subject", subjects)
      .abortSignal(dbSignal());
    if (error) {
      errors++;
      report(["db", "alerted_at", kind], `Direct lot alerts: posted, but alerted_at not recorded for ${subjects.length} ${kind} item(s) — they will be posted again: ${error.code ?? "?"} ${error.message}`, "error");
    }
  }
  return errors;
}
