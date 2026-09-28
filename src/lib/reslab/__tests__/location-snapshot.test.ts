import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The store talks to Supabase through the admin client; fake it per test.
const supabaseMock = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: async () => supabaseMock,
  createClient: vi.fn(),
}));

import {
  encodePayload,
  decodePayload,
  projectForSnapshot,
  SNAPSHOT_MAX_PHOTOS,
  validateSnapshotRow,
  readSnapshot,
  readSnapshotMeta,
  writeSnapshot,
  keyFingerprint,
  snapshotEnvKey,
  isSnapshotEnabled,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_MIN_LOCATIONS,
  SNAPSHOT_MAX_WIRE_BYTES,
  type SnapshotRow,
} from "../location-snapshot";
import type { ReslabLocation } from "@/lib/reslab/client";

const NOW = Date.parse("2026-09-27T12:00:00Z");

function loc(id: number, over: Partial<ReslabLocation> = {}): ReslabLocation {
  return {
    id,
    name: `Lot ${id}`,
    latitude: "40.6",
    longitude: "-73.7",
    // A realistic amount of the bulk that makes the real list 6.5 MB: ~17 KB
    // per location, most of it three photo arrays.
    description: "x".repeat(600),
    shuttle_info_details: "y".repeat(600),
    photos: Array.from({ length: 12 }, (_, i) => ({ id: id * 100 + i, url: `https://karaaj.s3.amazonaws.com/${id}-${i}-${"p".repeat(40)}.jpg` })),
    facility_photos: Array.from({ length: 10 }, (_, i) => ({ id: id * 1000 + i, url: `https://karaaj.s3.amazonaws.com/f-${id}-${i}-${"q".repeat(40)}.jpg` })),
    room_photos: Array.from({ length: 5 }, (_, i) => ({ id: id * 10000 + i, url: `https://karaaj.s3.amazonaws.com/r-${id}-${i}-${"r".repeat(40)}.jpg` })),
    ...over,
  } as unknown as ReslabLocation;
}
function list(n: number): ReslabLocation[] {
  return Array.from({ length: n }, (_, i) => loc(i + 1));
}

const ENV = { RESLAB_API_KEY: "prod_key_abc", NEXT_PUBLIC_APP_ENV: "production" };
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    RESLAB_API_KEY: process.env.RESLAB_API_KEY,
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    ENABLE_RESLAB_LOCATION_SNAPSHOT: process.env.ENABLE_RESLAB_LOCATION_SNAPSHOT,
  };
  process.env.RESLAB_API_KEY = ENV.RESLAB_API_KEY;
  process.env.NEXT_PUBLIC_APP_ENV = ENV.NEXT_PUBLIC_APP_ENV;
  supabaseMock.from.mockReset();
  supabaseMock.rpc.mockReset();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function rowFor(locations: ReslabLocation[], over: Partial<SnapshotRow> = {}): Promise<SnapshotRow> {
  return {
    env_key: snapshotEnvKey()!,
    key_fingerprint: keyFingerprint()!,
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    built_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
    rows_fetched: locations.length,
    location_count: locations.length,
    paginator_total: locations.length,
    payload_gzip_b64: await encodePayload(locations),
    written_by: "cron",
    ...over,
  };
}

function selectReturns(result: { data: unknown; error: unknown }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gt: () => chain,
    abortSignal: () => chain,
    maybeSingle: async () => result,
  };
  supabaseMock.from.mockReturnValue(chain);
}

describe("identity — no defaults, ever", () => {
  it("fingerprint and env key derive from the API key; unset key ⇒ null (never a default)", () => {
    expect(keyFingerprint({ RESLAB_API_KEY: "prod_key_abc" })).toHaveLength(16);
    expect(keyFingerprint({ RESLAB_API_KEY: "prod_key_abc" })).not.toBe(keyFingerprint({ RESLAB_API_KEY: "staging_key" }));
    expect(keyFingerprint({})).toBeNull();
    expect(keyFingerprint({ RESLAB_API_KEY: "   " })).toBeNull();
    expect(snapshotEnvKey()).toBe(`production:${keyFingerprint()}`);
  });
  it("flag is read at call time", () => {
    expect(isSnapshotEnabled({})).toBe(false);
    expect(isSnapshotEnabled({ ENABLE_RESLAB_LOCATION_SNAPSHOT: "true" })).toBe(true);
    expect(isSnapshotEnabled({ ENABLE_RESLAB_LOCATION_SNAPSHOT: "TRUE " })).toBe(true);
    expect(isSnapshotEnabled({ ENABLE_RESLAB_LOCATION_SNAPSHOT: "1" })).toBe(false);
  });
});

describe("codec + projection + size", () => {
  it("gzip+base64 round-trips", async () => {
    const locations = list(150);
    const b64 = await encodePayload(locations);
    expect(await decodePayload(b64)).toEqual(JSON.parse(JSON.stringify(locations)));
  });
  it("projectForSnapshot drops the two gallery arrays, keeps the first photos, and never loses the featured one", () => {
    const p = projectForSnapshot(loc(1, { parking_photos: [{ id: 1, url: "x" }] } as never)) as unknown as Record<string, unknown>;
    expect(p.facility_photos).toBeUndefined();
    expect(p.parking_photos).toBeUndefined();
    expect(p.room_photos).toBeUndefined();
    expect((p.photos as unknown[]).length).toBe(SNAPSHOT_MAX_PHOTOS);
    expect(p.name).toBe("Lot 1");
    expect(p.description).toBe("x".repeat(600));
    const withFeaturedLate = loc(2, { photos: Array.from({ length: 8 }, (_, i) => ({ id: i, url: `u${i}`, featured: i === 6 })) } as never);
    const q = projectForSnapshot(withFeaturedLate) as unknown as { photos: Array<{ id: number; featured?: boolean }> };
    expect(q.photos).toHaveLength(SNAPSHOT_MAX_PHOTOS);
    expect(q.photos.some((ph) => ph.featured)).toBe(true);
  });
  it("the raw 391-location list would NOT fit the ceiling; the projection does (measured 1,377 KB vs 402 KB on 2026-09-27)", async () => {
    const locations = list(391);
    const raw = await encodePayload(locations);
    const projected = await encodePayload(locations.map(projectForSnapshot));
    expect(projected.length).toBeLessThan(raw.length);
    expect(projected.length).toBeLessThan(SNAPSHOT_MAX_WIRE_BYTES);
  });
});

describe("validateSnapshotRow — Appendix B, conservative direction", () => {
  const expected = () => ({ envKey: snapshotEnvKey()!, fingerprint: keyFingerprint()! });

  it("accepts a good row and reports its age from a clamped built_at", async () => {
    const l = list(150);
    const v = validateSnapshotRow(await rowFor(l), l, expected(), NOW);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ageMs).toBe(60 * 60 * 1000);
  });

  it("a 533-rows / 381-unique / 533-total sweep is ACCEPTED (rows_fetched, never location_count, is the plausibility base)", async () => {
    const l = list(381);
    const v = validateSnapshotRow(await rowFor(l, { rows_fetched: 533, paginator_total: 533 }), l, expected(), NOW);
    expect(v.ok).toBe(true);
  });

  it("rejects another ResLab account, another environment, and another schema version", async () => {
    const l = list(150);
    const good = await rowFor(l);
    expect(validateSnapshotRow({ ...good, key_fingerprint: "deadbeefdeadbeef" }, l, expected(), NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/fingerprint/) });
    expect(validateSnapshotRow({ ...good, env_key: "preview:" + keyFingerprint() }, l, expected(), NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/env_key/) });
    expect(validateSnapshotRow({ ...good, schema_version: 99 }, l, expected(), NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/schema_version/) });
  });

  it("built_at: unparseable ⇒ miss; a writer clock ahead is clamped to now; older than 72 h ⇒ miss (24–72 h is adoptable as a fallback, never served)", async () => {
    const l = list(150);
    const good = await rowFor(l);
    expect(validateSnapshotRow({ ...good, built_at: "yesterday" }, l, expected(), NOW).ok).toBe(false);
    const ahead = validateSnapshotRow({ ...good, built_at: new Date(NOW + 10 * 60_000).toISOString() }, l, expected(), NOW);
    expect(ahead.ok).toBe(true);
    if (ahead.ok) expect(ahead.ageMs).toBe(0);
    expect(validateSnapshotRow({ ...good, built_at: new Date(NOW - 25 * 3_600_000).toISOString() }, l, expected(), NOW).ok).toBe(true);
    expect(validateSnapshotRow({ ...good, built_at: new Date(NOW - 73 * 3_600_000).toISOString() }, l, expected(), NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/too old/) });
  });

  it("payload: not an array, count mismatch, too small, or a malformed location ⇒ miss", async () => {
    const l = list(150);
    const good = await rowFor(l);
    expect(validateSnapshotRow(good, { not: "array" }, expected(), NOW).ok).toBe(false);
    expect(validateSnapshotRow(good, l.slice(0, 149), expected(), NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/149 locations, row says 150/) });
    const small = list(12);
    expect(validateSnapshotRow(await rowFor(small), small, expected(), NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/only 12/) });
    const bad = [...l.slice(0, 149), { ...l[149], name: "" }];
    expect(validateSnapshotRow(good, bad, expected(), NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/location\[149\]/) });
    // getFeaturedPhoto dereferences `photos` unguarded: a non-array must never be adopted.
    const noPhotos = [...l.slice(0, 149), { ...l[149], photos: "nope" }];
    expect(validateSnapshotRow(good, noPhotos, expected(), NOW).ok).toBe(false);
    const badAmenities = [...l.slice(0, 149), { ...l[149], amenities: { not: "array" } }];
    expect(validateSnapshotRow(good, badAmenities, expected(), NOW).ok).toBe(false);
  });
});

describe("readSnapshot — every failure is a miss, PostgREST errors are values not throws", () => {
  it("hit", async () => {
    const l = list(150);
    selectReturns({ data: await rowFor(l), error: null });
    const r = await readSnapshot(NOW);
    expect(r.kind).toBe("hit");
    if (r.kind === "hit") expect(r.locations).toHaveLength(150);
  });
  it("no row ⇒ non-reportable miss (expected during rollout); with newerThan it is 'no newer snapshot'", async () => {
    selectReturns({ data: null, error: null });
    expect(await readSnapshot(NOW)).toEqual({ kind: "miss", reason: "no snapshot row", reportable: false });
    expect(await readSnapshot(NOW, NOW - 3_600_000)).toEqual({ kind: "miss", reason: "no newer snapshot", reportable: false });
  });
  it("PGRST205 (table missing — flag on before the migration) ⇒ reportable miss with the code", async () => {
    selectReturns({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    expect(await readSnapshot(NOW)).toMatchObject({ kind: "miss", reportable: true, reason: expect.stringMatching(/PGRST205/) });
  });
  it("undecodable payload ⇒ reportable miss", async () => {
    selectReturns({ data: { ...(await rowFor(list(150))), payload_gzip_b64: "not-gzip" }, error: null });
    expect(await readSnapshot(NOW)).toMatchObject({ kind: "miss", reportable: true, reason: expect.stringMatching(/undecodable/) });
  });
  it("client throws (timeout) ⇒ reportable miss, never a throw to the caller", async () => {
    supabaseMock.from.mockImplementation(() => {
      throw new Error("The operation was aborted due to timeout");
    });
    expect(await readSnapshot(NOW)).toMatchObject({ kind: "miss", reportable: true, reason: expect.stringMatching(/timeout/) });
  });
  it("unset API key ⇒ reportable miss and NO Supabase call", async () => {
    delete process.env.RESLAB_API_KEY;
    expect(await readSnapshot(NOW)).toMatchObject({ kind: "miss", reason: "RESLAB_API_KEY unset" });
    expect(supabaseMock.from).not.toHaveBeenCalled();
  });
});

describe("readSnapshotMeta — a malformed row is an error, never a 0 baseline", () => {
  it("rejects null / 0 / non-integer location_count", async () => {
    for (const bad of [null, 0, 12.5, "abc"]) {
      selectReturns({ data: { built_at: new Date(NOW).toISOString(), location_count: bad, written_by: "cron", wire_bytes: 1 }, error: null });
      expect(await readSnapshotMeta()).toMatchObject({ kind: "error", message: expect.stringMatching(/malformed metadata/) });
    }
  });
  it("rejects an unparseable built_at, and accepts a good row (metadata only, no payload)", async () => {
    selectReturns({ data: { built_at: "whenever", location_count: 391, written_by: "cron", wire_bytes: 1 }, error: null });
    expect((await readSnapshotMeta()).kind).toBe("error");
    selectReturns({ data: { built_at: new Date(NOW).toISOString(), location_count: 391, written_by: "cron", wire_bytes: 411_000 }, error: null });
    expect(await readSnapshotMeta()).toMatchObject({ kind: "row", locationCount: 391, wireBytes: 411_000 });
  });
});

describe("writeSnapshot — refuses before it writes; the RPC's false is a no-op, not success", () => {
  const good = () => ({ locations: list(391), rowsFetched: 391, paginatorTotal: 391, builtAtMs: NOW - 30_000 });

  it("stores the PROJECTED list (a raw list over the ceiling is written trimmed, never refused for size)", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: true, error: null });
    const r = await writeSnapshot(good(), { currentLocationCount: null });
    expect(r.kind).toBe("written");
    const stored = await decodePayload(supabaseMock.rpc.mock.calls[0][1].p_payload_gzip_b64);
    expect((stored as Array<Record<string, unknown>>)[0].facility_photos).toBeUndefined();
    expect(((stored as Array<Record<string, unknown>>)[0].photos as unknown[]).length).toBe(SNAPSHOT_MAX_PHOTOS);
  });

  it("writes and reports the wire size; built_at is the sweep's own instant", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: true, error: null });
    const r = await writeSnapshot(good(), { currentLocationCount: 380 });
    expect(r.kind).toBe("written");
    const args = supabaseMock.rpc.mock.calls[0][1];
    expect(args.p_built_at).toBe(new Date(NOW - 30_000).toISOString());
    expect(args.p_written_by).toBe("cron");
    expect(args.p_rows_fetched).toBe(391);
    expect(args.p_location_count).toBe(391);
  });
  it("RPC false (a newer row exists) is a distinguishable no-op", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: false, error: null });
    expect((await writeSnapshot(good(), { currentLocationCount: null })).kind).toBe("noop_newer_exists");
  });
  it("RPC error is an error, not a write", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "function does not exist" } });
    expect(await writeSnapshot(good(), { currentLocationCount: null })).toMatchObject({ kind: "error", message: expect.stringMatching(/42883/) });
  });
  it("refuses a shrunk list (< 50 % of the current row) unless allowShrink", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: true, error: null });
    const shrunk = { ...good(), locations: list(150), rowsFetched: 150, paginatorTotal: 150 };
    expect(await writeSnapshot(shrunk, { currentLocationCount: 391 })).toMatchObject({ kind: "refused", reason: expect.stringMatching(/shrunk/) });
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
    expect((await writeSnapshot(shrunk, { currentLocationCount: 391, allowShrink: true })).kind).toBe("written");
  });
  it("refuses a list containing a location the READER would reject (one malformed lot must not become a green monitor)", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: true, error: null });
    const locations = list(391);
    (locations[200] as unknown as Record<string, unknown>).amenities = { not: "an array" };
    const r = await writeSnapshot({ ...good(), locations }, { currentLocationCount: null });
    expect(r).toMatchObject({ kind: "refused", reason: expect.stringMatching(/location\[200\] \(id 201\)/) });
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
  });

  it("refuses fewer than the minimum, rows_fetched < count, and an unset key — without calling Supabase", async () => {
    expect((await writeSnapshot({ ...good(), locations: list(SNAPSHOT_MIN_LOCATIONS - 1), rowsFetched: 99 }, { currentLocationCount: null })).kind).toBe("refused");
    expect((await writeSnapshot({ ...good(), rowsFetched: 10 }, { currentLocationCount: null })).kind).toBe("refused");
    delete process.env.RESLAB_API_KEY;
    expect((await writeSnapshot(good(), { currentLocationCount: null })).kind).toBe("refused");
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
  });
});
