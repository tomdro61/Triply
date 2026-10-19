/**
 * Room cancellation policy → refundability, from LiteAPI's
 * `cancellationPolicies { refundableTag, cancelPolicyInfos[{cancelTime, amount, timezone}] }`.
 *
 * Direction of every ambiguity is NON-refundable (plan §9.5): an unknown tag, a
 * refundable tag with no usable deadline, or a deadline we cannot parse all
 * render as "Non-refundable room" and are reported so the mapping can be
 * extended — never as free cancellation.
 *
 * Phase A only needs the refundability (for the card and hotel page). The
 * refund-amount-at-time function (`roomRefundAt`) lands with Phase C.
 */

import type { RoomRefundability } from "./refundability";
import { isValidTimeZone, zonedWallClock, zonedWallTimeToEpochMs } from "@/lib/utils/time";

export interface LiteApiCancelPolicyInfo {
  /** e.g. "2026-10-14 18:00:00" — a wall clock in `timezone` (often "GMT"), NOT the hotel's. */
  cancelTime?: string | null;
  amount?: number | null;
  currency?: string | null;
  type?: string | null;
  timezone?: string | null;
}

export interface LiteApiCancellationPolicies {
  refundableTag?: string | null;
  cancelPolicyInfos?: LiteApiCancelPolicyInfo[] | null;
  hotelRemarks?: string[] | null;
}

export type RefundableTag = "RFN" | "NRFN";

export interface RefundabilityResult {
  refundability: RoomRefundability;
  /** Non-null when the input was ambiguous and we fell back to non-refundable; callers report it. */
  anomaly: string | null;
}

/** Normalise the tag; anything but the two documented values is an anomaly. */
export function normaliseRefundableTag(tag: string | null | undefined): { tag: RefundableTag; anomaly: string | null } {
  if (tag === "RFN" || tag === "NRFN") return { tag, anomaly: null };
  return { tag: "NRFN", anomaly: `unrecognised refundableTag ${JSON.stringify(tag)} treated as NRFN` };
}

const CANCEL_TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

const NRFN = (anomaly: string): RefundabilityResult => ({ refundability: { kind: "non_refundable" }, anomaly });

/**
 * The free-cancellation deadline: the EARLIEST penalised `cancelTime`, compared
 * as INSTANTS — each entry is read in its own declared `timezone` (LiteAPI
 * sends e.g. "GMT"), then shown on the hotel's wall clock, so "(local time at
 * the hotel)" on every surface is true. Before it, cancellation is free; from
 * it on, a charge applies.
 *
 * Non-refundable (+ anomaly, never a guess) when: the tag is not RFN; an RFN
 * rate has no penalised entry; a cancelTime is unparseable; an entry has no
 * timezone or one we don't recognise; or the deadline is already at or before
 * `now` (a passed deadline must never read as free cancellation).
 */
export function refundabilityFromPolicies(
  policies: LiteApiCancellationPolicies | null | undefined,
  hotelTimeZone: string,
  now: Date
): RefundabilityResult {
  const { tag, anomaly: tagAnomaly } = normaliseRefundableTag(policies?.refundableTag);
  if (tag === "NRFN") {
    return { refundability: { kind: "non_refundable" }, anomaly: tagAnomaly };
  }
  if (!isValidTimeZone(hotelTimeZone)) return NRFN(`hotel timezone ${JSON.stringify(hotelTimeZone)} invalid — treated as NRFN`);
  const infos = policies?.cancelPolicyInfos ?? [];
  // Every entry is validated BEFORE any is used: a penalty we can't read must
  // not quietly drop out and leave a later deadline looking like free
  // cancellation (review pass 2, M4).
  for (const p of infos) {
    if (typeof p.amount !== "number" || !Number.isFinite(p.amount) || p.amount < 0) {
      return NRFN(`cancelPolicyInfos entry with unreadable amount ${JSON.stringify(p.amount ?? null)} — treated as NRFN`);
    }
    if (p.amount > 0 && !p.cancelTime) {
      return NRFN("penalty entry without a cancelTime — deadline unknown, treated as NRFN");
    }
  }
  const penalised = infos.filter((p) => typeof p.amount === "number" && p.amount > 0);
  if (penalised.length === 0) {
    return NRFN("RFN rate with no penalised cancelPolicyInfos — deadline unknown, treated as NRFN");
  }
  let earliest: number | null = null;
  for (const p of penalised) {
    const m = CANCEL_TIME_RE.exec(p.cancelTime ?? "");
    if (!m) return NRFN(`unparseable cancelTime ${JSON.stringify(p.cancelTime)} — treated as NRFN`);
    const zone = p.timezone?.trim();
    if (!zone || !isValidTimeZone(zone)) {
      return NRFN(`cancelTime timezone ${JSON.stringify(p.timezone ?? null)} missing or unrecognised — treated as NRFN`);
    }
    const seconds = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0);
    const instant = zonedWallTimeToEpochMs(m[1], seconds, zone);
    if (earliest === null || instant < earliest) earliest = instant;
  }
  if (earliest === null) return NRFN("no usable cancelTime — treated as NRFN");
  if (earliest <= now.getTime()) {
    return NRFN("free-cancellation deadline already passed — treated as NRFN");
  }
  const wall = zonedWallClock(hotelTimeZone, new Date(earliest));
  const hh = String(Math.floor(wall.secondsOfDay / 3600)).padStart(2, "0");
  const mm = String(Math.floor((wall.secondsOfDay % 3600) / 60)).padStart(2, "0");
  return {
    refundability: { kind: "free_until", deadlineLocal: `${wall.date} ${hh}:${mm}`, timeZone: hotelTimeZone },
    anomaly: null,
  };
}
