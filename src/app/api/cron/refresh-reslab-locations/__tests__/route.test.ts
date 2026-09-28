import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const searchMock = vi.hoisted(() => ({ sweepChannelLocations: vi.fn() }));
vi.mock("@/lib/reslab/search", () => ({ sweepChannelLocations: searchMock.sweepChannelLocations }));
const storeMock = vi.hoisted(() => ({ readSnapshotMeta: vi.fn(), writeSnapshot: vi.fn() }));
vi.mock("@/lib/reslab/location-snapshot", () => storeMock);
const captureMock = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", () => captureMock);

import { GET } from "../route";

const T0 = Date.parse("2026-09-27T03:00:00Z");
function req(query = "") {
  return new NextRequest(`https://www.triplypro.com/api/cron/refresh-reslab-locations${query}`, {
    headers: { authorization: "Bearer test-secret" },
  });
}
function goodSweep(over: Record<string, unknown> = {}) {
  return {
    unique: Array.from({ length: 391 }, (_, i) => ({ id: i + 1, name: `Lot ${i + 1}` })),
    rowsFetched: 391,
    paginatorTotal: 391,
    lastPage: 40,
    refusedPages: 0,
    skippedPages: 0,
    implausible: false,
    sweepStartedAt: T0 + 1000,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0 + 30_000));
  process.env.CRON_SECRET = "test-secret";
  searchMock.sweepChannelLocations.mockReset();
  storeMock.readSnapshotMeta.mockReset();
  storeMock.writeSnapshot.mockReset();
  captureMock.captureAPIError.mockReset();
  storeMock.readSnapshotMeta.mockResolvedValue({ kind: "none" });
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.CRON_SECRET;
});

describe("GET /api/cron/refresh-reslab-locations", () => {
  it("401 without the secret; no sweep", async () => {
    const res = await GET(new NextRequest("https://www.triplypro.com/api/cron/refresh-reslab-locations"));
    expect(res.status).toBe(401);
    expect(searchMock.sweepChannelLocations).not.toHaveBeenCalled();
  });

  it("sweeps, writes with the sweep's own built_at, and passes the current count for the anti-shrink rule", async () => {
    storeMock.readSnapshotMeta.mockResolvedValue({ kind: "row", builtAtMs: T0 - 5 * 3_600_000, locationCount: 380, writtenBy: "cron", wireBytes: 1 });
    searchMock.sweepChannelLocations.mockResolvedValue(goodSweep());
    storeMock.writeSnapshot.mockResolvedValue({ kind: "written", wireBytes: 250_000 });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, outcome: "written", unique: 391, rowsFetched: 391, baselineUnverified: false, allowShrink: false });
    expect(searchMock.sweepChannelLocations).toHaveBeenCalledWith(380);
    expect(storeMock.writeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ builtAtMs: T0 + 1000, rowsFetched: 391, paginatorTotal: 391 }),
      { currentLocationCount: 380, allowShrink: false }
    );
  });

  it("skips the sweep entirely (zero ResLab calls) when the row is younger than 2 h, unless ?force=1", async () => {
    storeMock.readSnapshotMeta.mockResolvedValue({ kind: "row", builtAtMs: T0 - 30 * 60_000, locationCount: 391, writtenBy: "cron", wireBytes: 1 });
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ ok: true, outcome: "skipped_fresh", reslabCalls: 0 });
    expect(searchMock.sweepChannelLocations).not.toHaveBeenCalled();

    searchMock.sweepChannelLocations.mockResolvedValue(goodSweep());
    storeMock.writeSnapshot.mockResolvedValue({ kind: "written", wireBytes: 1 });
    await GET(req("?force=1"));
    expect(searchMock.sweepChannelLocations).toHaveBeenCalledTimes(1);
  });

  it("a rejected sweep (refused pages / implausible) is NON-2xx + one Sentry event, and writes nothing", async () => {
    searchMock.sweepChannelLocations.mockResolvedValue(goodSweep({ refusedPages: 3 }));
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, outcome: "rejected", refusedPages: 3 });
    expect(storeMock.writeSnapshot).not.toHaveBeenCalled();
    expect(captureMock.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("a sweep that throws (unusable paginator) is a 502 with the message", async () => {
    searchMock.sweepChannelLocations.mockRejectedValue(new Error("unusable paginator"));
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, outcome: "sweep_threw" });
  });

  it("refused write (shrunk) is 409; write error is 500; a newer-exists no-op is 200 but labelled", async () => {
    searchMock.sweepChannelLocations.mockResolvedValue(goodSweep());
    storeMock.writeSnapshot.mockResolvedValueOnce({ kind: "refused", reason: "shrunk to 150 from 391" });
    expect((await GET(req())).status).toBe(409);
    storeMock.writeSnapshot.mockResolvedValueOnce({ kind: "error", message: "rpc failed" });
    expect((await GET(req())).status).toBe(500);
    storeMock.writeSnapshot.mockResolvedValueOnce({ kind: "noop_newer_exists", wireBytes: 1 });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "noop_newer_exists" });
  });

  it("a meta-read failure REFUSES the run (503) instead of silently disabling the anti-shrink guard; ?force=1&allowShrink=1 overrides", async () => {
    storeMock.readSnapshotMeta.mockResolvedValue({ kind: "error", message: "timeout" });
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, outcome: "meta_unreadable" });
    expect(searchMock.sweepChannelLocations).not.toHaveBeenCalled();
    expect(storeMock.writeSnapshot).not.toHaveBeenCalled();

    searchMock.sweepChannelLocations.mockResolvedValue(goodSweep());
    storeMock.writeSnapshot.mockResolvedValue({ kind: "written", wireBytes: 1 });
    const forced = await GET(req("?force=1&allowShrink=1"));
    expect(forced.status).toBe(200);
    expect(await forced.json()).toMatchObject({ baselineUnverified: true, allowShrink: true, force: true });
    expect(storeMock.writeSnapshot).toHaveBeenCalledWith(expect.anything(), { currentLocationCount: null, allowShrink: true });
  });

  it("?allowShrink=1 is passed through to the writer", async () => {
    searchMock.sweepChannelLocations.mockResolvedValue(goodSweep());
    storeMock.writeSnapshot.mockResolvedValue({ kind: "written", wireBytes: 1 });
    await GET(req("?allowShrink=1"));
    expect(storeMock.writeSnapshot).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ allowShrink: true }));
  });
});

describe("vercel.json ↔ src/app/api/cron/* bijection (no cron ships unregistered or unimplemented)", () => {
  const ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url)); // triply/
  const registered = (JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] }).crons
    .map((c) => c.path.replace("/api/cron/", ""))
    .sort();
  const implemented = readdirSync(join(ROOT, "src/app/api/cron"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  it("every registered cron has a route directory and every route directory is registered", () => {
    expect(registered).toEqual(implemented);
    expect(registered).toContain("refresh-reslab-locations");
  });
});
