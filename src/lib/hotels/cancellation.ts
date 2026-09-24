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

export interface LiteApiCancelPolicyInfo {
  /** e.g. "2026-10-14 18:00:00" — hotel-local per `timezone`. */
  cancelTime?: string;
  amount?: number;
  currency?: string;
  type?: string;
  timezone?: string;
}

export interface LiteApiCancellationPolicies {
  refundableTag?: string;
  cancelPolicyInfos?: LiteApiCancelPolicyInfo[];
  hotelRemarks?: string[];
}

export type RefundableTag = "RFN" | "NRFN";

export interface RefundabilityResult {
  refundability: RoomRefundability;
  /** Non-null when the input was ambiguous and we fell back to non-refundable; callers report it. */
  anomaly: string | null;
}

/** Normalise the tag; anything but the two documented values is an anomaly. */
export function normaliseRefundableTag(tag: string | undefined): { tag: RefundableTag; anomaly: string | null } {
  if (tag === "RFN" || tag === "NRFN") return { tag, anomaly: null };
  return { tag: "NRFN", anomaly: `unrecognised refundableTag ${JSON.stringify(tag)} treated as NRFN` };
}

const CANCEL_TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/;

/**
 * The free-cancellation deadline: the EARLIEST `cancelTime` among policy
 * entries that carry a penalty (`amount > 0`). Before it, cancellation is free;
 * from it on, a charge applies. A refundable tag with no penalty entries at all
 * means "free until check-in" per LiteAPI's docs, but we do not guess a
 * check-in time — that case is an anomaly and renders non-refundable until the
 * vendor confirms the semantics (Q4).
 */
export function refundabilityFromPolicies(
  policies: LiteApiCancellationPolicies | undefined,
  hotelTimeZone: string
): RefundabilityResult {
  const { tag, anomaly: tagAnomaly } = normaliseRefundableTag(policies?.refundableTag);
  if (tag === "NRFN") {
    return { refundability: { kind: "non_refundable" }, anomaly: tagAnomaly };
  }
  const infos = policies?.cancelPolicyInfos ?? [];
  const penalised = infos.filter((p) => typeof p.amount === "number" && p.amount > 0 && p.cancelTime);
  if (penalised.length === 0) {
    return {
      refundability: { kind: "non_refundable" },
      anomaly: "RFN rate with no penalised cancelPolicyInfos — deadline unknown, treated as NRFN",
    };
  }
  let earliest: string | null = null;
  let tz = hotelTimeZone;
  for (const p of penalised) {
    const m = CANCEL_TIME_RE.exec(p.cancelTime ?? "");
    if (!m) {
      return {
        refundability: { kind: "non_refundable" },
        anomaly: `unparseable cancelTime ${JSON.stringify(p.cancelTime)} — treated as NRFN`,
      };
    }
    const local = `${m[1]} ${m[2]}:${m[3]}`;
    if (earliest === null || local < earliest) {
      earliest = local;
      if (p.timezone) tz = p.timezone;
    }
  }
  return {
    refundability: { kind: "free_until", deadlineLocal: earliest as string, timeZone: tz },
    anomaly: null,
  };
}
