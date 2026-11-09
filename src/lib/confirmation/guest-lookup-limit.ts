import crypto from "crypto";
import { isIPv4, isIPv6 } from "net";
import { captureBookingError } from "@/lib/sentry";
import { createAdminClient } from "@/lib/supabase/server";
import { bounded, BoundedTimeoutError } from "@/lib/utils/bounded";
import { requireBookingLinkSecret } from "./booking-key";

/**
 * Tries for opening a booking with the checkout email, without signing in
 * (migration 051; /api/reservations/[id]).
 *
 * Each try is taken BEFORE the booking is looked up, from three buckets: the
 * caller's network address, the email, and the confirmation number — the
 * number for EVERY number asked about, ours or not, so the answer never shows
 * which numbers are bookings. A full bucket refuses the whole take and charges
 * nothing. The route gives the try back when the email matches, or when the
 * answer could not be decided.
 *
 * Buckets are keyed hashes (HMAC-SHA256 with BOOKING_LINK_SIGNING_SECRET): no
 * email or address is stored, and each environment has its own rows on the
 * shared database.
 *
 * Fails CLOSED: a database error or no answer within the timeout is `error`,
 * and the route answers 500 "try again". Never `allowed` by default.
 *
 * Sentry: refusals on a ladder of the bucket's refusal count (counted by the
 * database, so it holds across instances): 1, 10, 100, then every 1,000.
 */

export type GuestLookupKind = "ip" | "email" | "number";

/** Tries per bucket per window. Code constants: a change needs a deploy. */
export const GUEST_LOOKUP_LIMITS: Readonly<Record<GuestLookupKind, number>> = {
  number: 5,
  email: 10,
  ip: 30,
};

/** Each bucket's window runs this long from its first try. */
export const GUEST_LOOKUP_WINDOW_SECONDS = 24 * 60 * 60;

/** Bounded well inside the route's own latency; the take runs before the lookup. */
export const GUEST_LOOKUP_RPC_TIMEOUT_MS = 3_000;

/** RFC 5321's limit on an address; longer is never a real checkout email. */
const MAX_EMAIL_LENGTH = 254;

/**
 * The one normaliser for a guest's email, also used to compare it with the
 * booking's: trimmed and lowercased. Empty, whitespace-only or too long → null.
 */
export function normalizeGuestEmail(raw: string | null | undefined): string | null {
  const email = (raw ?? "").trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  return email;
}

/** Both sides normalised by normalizeGuestEmail; a blank or missing side never matches. */
export function sameGuestEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeGuestEmail(a);
  return left !== null && left === normalizeGuestEmail(b);
}

/** All eight groups of an IPv6 address, lowercased, or null. */
function expandIPv6(address: string): string[] | null {
  let text = address.toLowerCase();
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const parts = v4[1].split(".").map(Number);
    const hex = [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]].map((n) => n.toString(16));
    text = text.slice(0, v4.index) + hex.join(":");
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  return groups.length === 8 ? groups.map((g) => g.replace(/^0+(?=.)/, "")) : null;
}

/**
 * The network-address bucket's value: an IPv4 address as is; an IPv6 address
 * by its /64 (one connection can move around inside it), or as IPv4 when it is
 * an IPv4-mapped address. "unknown" or anything unparseable → null, and the
 * route skips the address bucket rather than putting everyone in one.
 */
export function ipBucketValue(ip: string): string | null {
  const address = ip.trim();
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return null;
  const groups = expandIPv6(address);
  if (!groups) return null;
  const mapped = groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff";
  if (mapped) {
    const hi = parseInt(groups[6], 16);
    const lo = parseInt(groups[7], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

let unknownIpReported = false;

/**
 * The caller's address was unknown, so its bucket is skipped. Behind Vercel
 * there is always one, so it is reported — once per instance, not per request.
 */
export function noteUnknownGuestIp(reservationNumber: string): void {
  if (unknownIpReported) return;
  unknownIpReported = true;
  captureBookingError(new Error("guest booking lookup: caller address unknown; the address bucket is skipped"), {
    step: "confirmation",
    confirmationNumber: reservationNumber,
    fingerprint: ["guest-lookup-unknown-ip"],
    level: "warning",
  });
}

export function __resetUnknownGuestIpForTests(): void {
  unknownIpReported = false;
}

/** base64url HMAC-SHA256 (43 characters) of the bucket's kind and value. Throws BookingLinkConfigError. */
export function bucketHash(kind: GuestLookupKind, value: string): string {
  return crypto
    .createHmac("sha256", requireBookingLinkSecret())
    .update(`guest-lookup:v1:${kind}:${value}`)
    .digest("base64url");
}

export interface GuestLookupBuckets {
  keys: string[];
  kinds: GuestLookupKind[];
  limits: number[];
}

/**
 * The buckets one email try is charged to, paired by position. `ip` null →
 * no address bucket. Throws BookingLinkConfigError.
 */
export function guestLookupBuckets(input: { ip: string | null; email: string; reservationNumber: string }): GuestLookupBuckets {
  const entries: [GuestLookupKind, string][] = [
    ["number", input.reservationNumber],
    ["email", input.email],
  ];
  if (input.ip) entries.push(["ip", input.ip]);
  return {
    keys: entries.map(([kind, value]) => bucketHash(kind, value)),
    kinds: entries.map(([kind]) => kind),
    limits: entries.map(([kind]) => GUEST_LOOKUP_LIMITS[kind]),
  };
}

/** Which refusal counts get a Sentry event (see the header). */
export function shouldReportRefusal(refused: number): boolean {
  return refused === 1 || refused === 10 || refused === 100 || (refused > 0 && refused % 1000 === 0);
}

export type GuestLookupTake =
  | { kind: "allowed"; keys: string[] }
  | { kind: "blocked"; retryAfterSeconds: number }
  /** `maybeCharged`: no answer in time — the take may still have committed, so the caller gives it back. */
  | { kind: "error"; detail: string; maybeCharged: boolean };

/**
 * The least time a refusal on the email path takes, counted from the take. A
 * wrong email on a real booking costs one more read than a number that isn't
 * a booking; answering both no sooner than this hides the difference.
 */
export const GUEST_LOOKUP_DENY_FLOOR_MS = 800;

/** Wait until GUEST_LOOKUP_DENY_FLOOR_MS after `takenAt` (now, if that has passed). */
export function holdGuestDenial(takenAt: number): Promise<void> {
  const wait = takenAt + GUEST_LOOKUP_DENY_FLOOR_MS - Date.now();
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

type RpcResult = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

/** The database calls, injectable for tests. Resolve `{ data, error }` like supabase-js. */
export interface GuestLookupRpc {
  take(args: { p_keys: string[]; p_kinds: string[]; p_limits: number[]; p_window_seconds: number }): RpcResult;
  release(args: { p_keys: string[]; p_window_seconds: number }): RpcResult;
}

const defaultRpc: GuestLookupRpc = {
  async take(args) {
    const supabase = await createAdminClient();
    return supabase.rpc("guest_lookup_take", args).abortSignal(AbortSignal.timeout(GUEST_LOOKUP_RPC_TIMEOUT_MS));
  },
  async release(args) {
    const supabase = await createAdminClient();
    return supabase.rpc("guest_lookup_release", args).abortSignal(AbortSignal.timeout(GUEST_LOOKUP_RPC_TIMEOUT_MS));
  },
};

interface TakeRow {
  allowed: boolean;
  retryAfterSeconds: number;
  refused: number;
  blockedKinds: string[];
}

function parseTakeRow(data: unknown): TakeRow | null {
  // RETURNS TABLE → PostgREST returns an array of one row.
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (
    typeof r.allowed !== "boolean" ||
    typeof r.retry_after_seconds !== "number" ||
    typeof r.refused !== "number" ||
    !Array.isArray(r.blocked_kinds)
  ) {
    return null;
  }
  return {
    allowed: r.allowed,
    retryAfterSeconds: r.retry_after_seconds,
    refused: r.refused,
    blockedKinds: r.blocked_kinds.filter((k): k is string => typeof k === "string"),
  };
}

/** Take one try from every bucket, or from none. Never throws for a database fault. */
export async function takeGuestLookup(
  buckets: GuestLookupBuckets,
  reservationNumber: string,
  rpc: GuestLookupRpc = defaultRpc
): Promise<GuestLookupTake> {
  let result: Awaited<RpcResult>;
  try {
    result = await bounded(
      rpc.take({
        p_keys: buckets.keys,
        p_kinds: buckets.kinds,
        p_limits: buckets.limits,
        p_window_seconds: GUEST_LOOKUP_WINDOW_SECONDS,
      }),
      GUEST_LOOKUP_RPC_TIMEOUT_MS,
      "guest_lookup_take"
    );
  } catch (err) {
    // Our timeout, or the request aborted: the database may still commit it.
    const maybeCharged = err instanceof BoundedTimeoutError || (err instanceof Error && err.name === "AbortError");
    return { kind: "error", detail: err instanceof Error ? err.message : String(err), maybeCharged };
  }
  if (result.error) {
    // supabase-js turns a fetch that failed or was aborted (our AbortSignal
    // timeout) into an error result with an EMPTY code: the request may have
    // reached the database. A database error carries a code, and its
    // statement was rolled back.
    return {
      kind: "error",
      detail: `rpc failed (${result.error.code || "no code"}): ${result.error.message}`,
      maybeCharged: !result.error.code,
    };
  }
  const row = parseTakeRow(result.data);
  if (!row) return { kind: "error", detail: `unexpected rpc result: ${JSON.stringify(result.data)?.slice(0, 200)}`, maybeCharged: false };
  if (row.allowed) return { kind: "allowed", keys: buckets.keys };

  if (shouldReportRefusal(row.refused)) {
    captureBookingError(new Error(`guest booking lookup refused: too many tries (${row.blockedKinds.join(", ")})`), {
      step: "confirmation",
      confirmationNumber: reservationNumber,
      fingerprint: ["guest-lookup-refused", ...row.blockedKinds],
      level: "warning",
    });
  }
  return { kind: "blocked", retryAfterSeconds: Math.max(1, row.retryAfterSeconds) };
}

/**
 * Give one try back to each bucket. Reports a failure and never throws: one
 * try stays used, which is the safe side.
 */
export async function releaseGuestLookup(
  keys: string[],
  reservationNumber: string,
  rpc: GuestLookupRpc = defaultRpc
): Promise<void> {
  try {
    const result = await bounded(
      rpc.release({ p_keys: keys, p_window_seconds: GUEST_LOOKUP_WINDOW_SECONDS }),
      GUEST_LOOKUP_RPC_TIMEOUT_MS,
      "guest_lookup_release"
    );
    if (result.error) throw new Error(`rpc failed (${result.error.code ?? "?"}): ${result.error.message}`);
  } catch (err) {
    captureBookingError(
      new Error(`guest booking lookup: release failed: ${err instanceof Error ? err.message : String(err)}`),
      { step: "confirmation", confirmationNumber: reservationNumber, fingerprint: ["guest-lookup-release-failed"] }
    );
  }
}
