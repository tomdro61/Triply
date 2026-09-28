/**
 * Shared ResLab location-list snapshot — the store half.
 * Plan: notes/2026-09-27-reslab-location-snapshot-plan-v3.md (§2, §3, §5, Appendix B).
 *
 * ONE row per {environment, ResLab account} in `reslab_location_snapshot`,
 * holding the whole verified-complete list gzip+base64. Written only by the
 * refresh cron (Production); read by `maybeWarmFromSnapshot()` in search.ts
 * before a cold instance would sweep ResLab's 40 pages.
 *
 * Every read is UNTRUSTED input (an older deploy, a hand-edited row, a
 * truncated payload). `validateSnapshotRow` re-validates everything before a
 * single byte reaches the in-memory cache; any failure is a miss, reported.
 *
 * Node-only (`node:zlib`): no importer of search.ts runs on Edge. Keep it so —
 * do not add `runtime = "edge"` to a route that reaches this module.
 */

import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveEnv } from "@/lib/availability/log";
import type { ReslabLocation } from "@/lib/reslab/client";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Bump on ANY change to what is stored; the reader ignores rows whose version differs.
 *
 * v1 = `projectForSnapshot()`: the raw location minus `facility_photos`,
 * `parking_photos` and `room_photos`, with `photos` trimmed to the first
 * SNAPSHOT_MAX_PHOTOS (the featured one is always kept).
 * Measured 2026-09-27: the raw 391-location list is 1,377 KB base64 (2.8× the
 * ceiling); trimmed it is 402 KB. Search cards render one photo from `photos`
 * (search.ts transformLocation) and the lot page refetches its own record by
 * id (get-lot.ts getLocation), so nothing customer-facing reads the dropped
 * fields from the list.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const SNAPSHOT_MAX_PHOTOS = 3;

/** The stored shape. Applied by the writer to every location; the reader validates the result. */
export function projectForSnapshot(location: ReslabLocation): ReslabLocation {
  // Every gallery-shaped field: `facility_photos` and `parking_photos` are on
  // the ReslabLocation type; `room_photos` is observed on the wire (0.8 MB of
  // the 6.5 MB list on 2026-09-27) but absent from the type.
  const {
    facility_photos: _facility,
    parking_photos: _parking,
    room_photos: _room,
    photos,
    ...rest
  } = location as ReslabLocation & { facility_photos?: unknown; parking_photos?: unknown; room_photos?: unknown };
  void _facility;
  void _parking;
  void _room;
  // Keep the featured photo (getFeaturedPhoto in client.ts picks it) so a
  // lot's card image does not depend on whether the list came from the
  // snapshot or a sweep.
  const list = Array.isArray(photos) ? photos : [];
  const featured = list.find((p) => p && typeof p === "object" && (p as { featured?: unknown }).featured);
  const kept = list.slice(0, SNAPSHOT_MAX_PHOTOS);
  if (featured && !kept.includes(featured)) kept[kept.length - 1] = featured;
  return { ...rest, photos: kept } as ReslabLocation;
}

/**
 * Reader freshness ladder (plan v3 §3):
 *   < FRESH      served `stale:false` (5-min CDN TTL on /api/search)
 *   < MAX_AGE    served complete but `stale:true` (60-s CDN TTL)
 *   < ADOPT_MAX  not served on its own, but ADOPTED into memory so a cold
 *                instance has the "never downgrade" fallback while it sweeps
 *   older        ignored
 * FRESH is ≥ 2 missed 4-hourly cron runs: at 6 h a SINGLE refused sweep flipped
 * /api/search to s-maxage=60 and 5×'d the min-price fan-out this feature is
 * meant to reduce.
 */
export const SNAPSHOT_FRESH_MS = 10 * 60 * 60 * 1000;
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SNAPSHOT_ADOPT_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** The admin line / heartbeat call the cron "behind" from here (search is already paying for it). */
export const SNAPSHOT_WARN_MS = SNAPSHOT_FRESH_MS;

/** Hard ceiling on the stored wire size (base64 length). Measure in the PR; see plan §2. */
export const SNAPSHOT_MAX_WIRE_BYTES = 500 * 1024;

/** A snapshot below this many locations is never written or adopted (CHECK mirrors it). */
export const SNAPSHOT_MIN_LOCATIONS = 100;

/** Full-payload read (~400 KB on a cold TLS connection): a timeout costs a 40-page sweep. */
export const SNAPSHOT_READ_TIMEOUT_MS = 5_000;
/** Metadata-only reads (a few bytes). */
export const SNAPSHOT_META_TIMEOUT_MS = 2_000;
/** gunzip bound: a hand-written high-ratio row must not OOM every reader. */
const SNAPSHOT_MAX_DECODED_BYTES = 32 * 1024 * 1024;

export interface SnapshotRow {
  env_key: string;
  key_fingerprint: string;
  schema_version: number;
  built_at: string; // TIMESTAMPTZ as ISO string over PostgREST
  rows_fetched: number;
  location_count: number;
  paginator_total: number;
  payload_gzip_b64: string;
  written_by: string;
}

export const SNAPSHOT_COLUMNS =
  "env_key, key_fingerprint, schema_version, built_at, rows_fetched, location_count, paginator_total, payload_gzip_b64, written_by";

// ───────────────────────────── identity ─────────────────────────────

/** Read at call time (never module scope) so tests can flip it and so a rollback is flag-off + redeploy. */
export function isSnapshotEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ENABLE_RESLAB_LOCATION_SNAPSHOT ?? "").trim().toLowerCase() === "true";
}

/**
 * The ResLab account this process talks to, as a short hash of its API key.
 * `RESLAB_API_DOMAIN` is `triplypro.com` in prod AND staging (only the key
 * differs), so the key is the only real discriminator. Null when unset — no
 * default, ever: a default here decides which inventory customers see.
 */
export function keyFingerprint(env: Record<string, string | undefined> = process.env): string | null {
  // Cheap insurance: a Vercel dashboard value pasted with literal quotes would
  // otherwise hash differently from a dotenv-stripped local value.
  const key = (env.RESLAB_API_KEY ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (key.length === 0) return null;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function snapshotEnvKey(env: Record<string, string | undefined> = process.env): string | null {
  const fp = keyFingerprint(env);
  if (!fp) return null;
  return `${resolveEnv()}:${fp}`;
}

// ───────────────────────────── codec ─────────────────────────────

export async function encodePayload(locations: ReslabLocation[]): Promise<string> {
  const buf = await gzipAsync(Buffer.from(JSON.stringify(locations), "utf8"));
  return buf.toString("base64");
}

export async function decodePayload(b64: string): Promise<unknown> {
  const buf = await gunzipAsync(Buffer.from(b64, "base64"), { maxOutputLength: SNAPSHOT_MAX_DECODED_BYTES });
  return JSON.parse(buf.toString("utf8"));
}

// ───────────────────────────── validation (Appendix B) ─────────────────────────────

export type SnapshotValidation =
  | { ok: true; locations: ReslabLocation[]; builtAtMs: number; ageMs: number }
  | { ok: false; reason: string };

export function isLocationShape(x: unknown): x is ReslabLocation {
  if (!x || typeof x !== "object") return false;
  const o = x as { id?: unknown; name?: unknown; latitude?: unknown; longitude?: unknown };
  if (!Number.isInteger(o.id)) return false;
  if (typeof o.name !== "string" || o.name.trim().length === 0) return false;
  // The existing code tolerates unparseable coordinates (the lot is simply not
  // distance-filterable) but a coordinate that is present must be a string/number.
  for (const c of [o.latitude, o.longitude]) {
    if (c !== undefined && c !== null && typeof c !== "string" && typeof c !== "number") return false;
  }
  // Every array field the render path .map()s or .find()s over. getFeaturedPhoto
  // (client.ts) dereferences `photos` with no guard, and `x || []` does not
  // rescue a truthy non-array — a bad row would TypeError every search for a day.
  const rec = x as Record<string, unknown>;
  if (!Array.isArray(rec.photos)) return false; // the writer always emits one
  for (const k of ["amenities", "extra_fields", "cancellation_policies", "facility_photos", "parking_photos", "room_photos"]) {
    const v = rec[k];
    if (v !== undefined && v !== null && !Array.isArray(v)) return false;
  }
  return true;
}

/**
 * Pure, given the decoded payload. `now` is injectable for tests.
 * Order matters: cheap identity checks before the gunzip'd shape checks.
 */
export function validateSnapshotRow(
  row: SnapshotRow,
  decoded: unknown,
  expected: { envKey: string; fingerprint: string },
  now: number = Date.now()
): SnapshotValidation {
  if (row.env_key !== expected.envKey) return { ok: false, reason: `wrong env_key ${row.env_key}` };
  if (row.key_fingerprint !== expected.fingerprint) return { ok: false, reason: "wrong key fingerprint (other ResLab account)" };
  if (row.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    return { ok: false, reason: `schema_version ${row.schema_version} ≠ ${SNAPSHOT_SCHEMA_VERSION}` };
  }
  const parsed = Date.parse(row.built_at);
  if (!Number.isFinite(parsed)) return { ok: false, reason: `unparseable built_at ${JSON.stringify(row.built_at)}` };
  // A writer clock ahead of ours must not make the row "fresh" for longer than the TTL.
  const builtAtMs = Math.min(parsed, now);
  const ageMs = now - builtAtMs;
  // Adoptable up to 72 h: the reader never SERVES past SNAPSHOT_MAX_AGE_MS on
  // its own, but a cold instance needs the row in memory as the "never
  // downgrade" fallback (usableFallback, 72 h) while it sweeps for itself.
  if (ageMs > SNAPSHOT_ADOPT_MAX_AGE_MS) return { ok: false, reason: `too old (${Math.round(ageMs / 3_600_000)} h)` };
  if (!Array.isArray(decoded)) return { ok: false, reason: "payload is not an array" };
  if (decoded.length !== row.location_count) {
    return { ok: false, reason: `payload has ${decoded.length} locations, row says ${row.location_count}` };
  }
  if (decoded.length < SNAPSHOT_MIN_LOCATIONS) return { ok: false, reason: `only ${decoded.length} locations` };
  for (let i = 0; i < decoded.length; i++) {
    if (!isLocationShape(decoded[i])) return { ok: false, reason: `location[${i}] has an invalid shape` };
  }
  return { ok: true, locations: decoded as ReslabLocation[], builtAtMs, ageMs };
}

// ───────────────────────────── store ─────────────────────────────

export type ReadSnapshotResult =
  | { kind: "hit"; locations: ReslabLocation[]; builtAtMs: number; ageMs: number; row: SnapshotRow }
  | { kind: "miss"; reason: string; reportable: boolean };

/**
 * One row by primary key. Every failure is a miss with a reason; `reportable`
 * distinguishes "no row yet" (expected during rollout) from a fault worth a
 * Sentry event. PostgREST returns `{ data: null, error }` for a missing table
 * (PGRST205), a missing column, or a denied read — those are NOT throws.
 */
/**
 * `newerThanMs`: when the caller already holds a complete list built at that
 * instant, let Postgres answer "nothing newer" in a few bytes instead of
 * shipping the same ~400 KB row every debounce window for a day.
 */
export async function readSnapshot(now: number = Date.now(), newerThanMs: number | null = null): Promise<ReadSnapshotResult> {
  const envKey = snapshotEnvKey();
  const fingerprint = keyFingerprint();
  if (!envKey || !fingerprint) return { kind: "miss", reason: "RESLAB_API_KEY unset", reportable: true };
  try {
    const supabase = await createAdminClient();
    let q = supabase.from("reslab_location_snapshot").select(SNAPSHOT_COLUMNS).eq("env_key", envKey);
    if (newerThanMs !== null) q = q.gt("built_at", new Date(newerThanMs).toISOString());
    const { data, error } = await q.abortSignal(AbortSignal.timeout(SNAPSHOT_READ_TIMEOUT_MS)).maybeSingle();
    if (error) {
      return { kind: "miss", reason: `read failed (${error.code ?? "?"}): ${error.message}`, reportable: true };
    }
    if (!data) {
      return { kind: "miss", reason: newerThanMs !== null ? "no newer snapshot" : "no snapshot row", reportable: false };
    }
    const row = data as unknown as SnapshotRow;
    let decoded: unknown;
    try {
      decoded = await decodePayload(row.payload_gzip_b64);
    } catch (err) {
      return { kind: "miss", reason: `payload undecodable: ${err instanceof Error ? err.message : String(err)}`, reportable: true };
    }
    const v = validateSnapshotRow(row, decoded, { envKey, fingerprint }, now);
    if (!v.ok) return { kind: "miss", reason: v.reason, reportable: true };
    return { kind: "hit", locations: v.locations, builtAtMs: v.builtAtMs, ageMs: v.ageMs, row };
  } catch (err) {
    return { kind: "miss", reason: `read threw: ${err instanceof Error ? err.message : String(err)}`, reportable: true };
  }
}

export interface WriteSnapshotInput {
  locations: ReslabLocation[];
  rowsFetched: number;
  paginatorTotal: number;
  /** The sweep's own start instant (first successful page fetch) — never Date.now() at write time. */
  builtAtMs: number;
}

export type WriteSnapshotResult =
  | { kind: "written"; wireBytes: number }
  | { kind: "noop_newer_exists"; wireBytes: number }
  | { kind: "refused"; reason: string }
  | { kind: "error"; message: string };

/**
 * The cron's write. Refuses (never writes) anything below the size floor,
 * over the wire ceiling, or shrunk below half of the current row; treats the
 * RPC's `false` as a distinguishable no-op.
 */
export async function writeSnapshot(
  input: WriteSnapshotInput,
  opts: { currentLocationCount: number | null; allowShrink?: boolean }
): Promise<WriteSnapshotResult> {
  const envKey = snapshotEnvKey();
  const fingerprint = keyFingerprint();
  if (!envKey || !fingerprint) return { kind: "refused", reason: "RESLAB_API_KEY unset" };
  if (input.locations.length < SNAPSHOT_MIN_LOCATIONS) {
    return { kind: "refused", reason: `only ${input.locations.length} locations (< ${SNAPSHOT_MIN_LOCATIONS})` };
  }
  if (input.rowsFetched < input.locations.length) {
    return { kind: "refused", reason: `rows_fetched ${input.rowsFetched} < location_count ${input.locations.length}` };
  }
  if (
    !opts.allowShrink &&
    opts.currentLocationCount !== null &&
    input.locations.length < opts.currentLocationCount * 0.5
  ) {
    // A channel answering a consistent, small `total` passes every plausibility
    // check; only the previous row knows the list used to be bigger.
    return {
      kind: "refused",
      reason: `shrunk to ${input.locations.length} from ${opts.currentLocationCount} (< 50 %); pass allowShrink for a deliberate channel change`,
    };
  }
  // Refuse what the reader would reject. The reader rejects the WHOLE snapshot
  // on one malformed location, so writing it would leave a green monitor
  // ("written", fresh age on /admin) over a row no instance can use.
  const projected = input.locations.map(projectForSnapshot);
  const badIndex = projected.findIndex((l) => !isLocationShape(l));
  if (badIndex !== -1) {
    const id = (projected[badIndex] as { id?: unknown }).id;
    return { kind: "refused", reason: `location[${badIndex}] (id ${String(id)}) would fail the reader's shape check` };
  }
  try {
    // Inside the try: writeSnapshot returns a result, it never throws.
    const payload = await encodePayload(projected);
    if (payload.length > SNAPSHOT_MAX_WIRE_BYTES) {
      return { kind: "refused", reason: `wire size ${payload.length} > ${SNAPSHOT_MAX_WIRE_BYTES} — bump schema_version with a smaller projection` };
    }
    const supabase = await createAdminClient();
    const { data, error } = await supabase.rpc("reslab_snapshot_upsert", {
      p_env_key: envKey,
      p_key_fingerprint: fingerprint,
      p_schema_version: SNAPSHOT_SCHEMA_VERSION,
      p_built_at: new Date(input.builtAtMs).toISOString(),
      p_rows_fetched: input.rowsFetched,
      p_location_count: input.locations.length,
      p_paginator_total: input.paginatorTotal,
      p_payload_gzip_b64: payload,
      p_written_by: "cron",
    });
    if (error) return { kind: "error", message: `rpc failed (${error.code ?? "?"}): ${error.message}` };
    return data === true
      ? { kind: "written", wireBytes: payload.length }
      : { kind: "noop_newer_exists", wireBytes: payload.length };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** The cron's "skip if fresh" read and the admin surfaces' age line: metadata only, no payload. */
export async function readSnapshotMeta(): Promise<
  | { kind: "row"; builtAtMs: number; locationCount: number; writtenBy: string; wireBytes: number }
  | { kind: "none" }
  | { kind: "error"; message: string }
> {
  try {
    const envKey = snapshotEnvKey();
    if (!envKey) return { kind: "error", message: "RESLAB_API_KEY unset" };
    const supabase = await createAdminClient();
    // Metadata only — never the payload (wire_bytes is a stored generated column).
    const { data, error } = await supabase
      .from("reslab_location_snapshot")
      .select("built_at, location_count, written_by, wire_bytes")
      .eq("env_key", envKey)
      .abortSignal(AbortSignal.timeout(SNAPSHOT_META_TIMEOUT_MS))
      .maybeSingle();
    if (error) return { kind: "error", message: `${error.code ?? "?"}: ${error.message}` };
    if (!data) return { kind: "none" };
    const parsed = Date.parse(data.built_at as string);
    const count = Number(data.location_count);
    // Number(null) is 0 and finite — a 0 baseline would switch the anti-shrink guard off silently.
    if (!Number.isFinite(parsed) || !Number.isInteger(count) || count <= 0) {
      return { kind: "error", message: `malformed metadata (built_at=${String(data.built_at)}, location_count=${String(data.location_count)})` };
    }
    return {
      kind: "row",
      builtAtMs: parsed,
      locationCount: count,
      writtenBy: String(data.written_by),
      wireBytes: Number(data.wire_bytes) || 0,
    };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
