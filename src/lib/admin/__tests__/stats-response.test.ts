import { describe, it, expect } from "vitest";
import { readStatsResponse } from "../stats-response";

type Stats = { bookings: { total: number } };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("readStatsResponse — stats or an error naming the HTTP status, never stale figures", () => {
  it("ok + JSON object → the stats", async () => {
    const r = await readStatsResponse<Stats>(Promise.resolve(json({ bookings: { total: 3 } })));
    expect(r).toEqual({ ok: true, data: { bookings: { total: 3 } } });
  });

  it("503 with the route's JSON error → that message plus the status", async () => {
    const r = await readStatsResponse<Stats>(
      json({ error: "Could not load booking stats — a database query failed. Try again." }, 503)
    );
    expect(r).toEqual({
      ok: false,
      error: "Could not load booking stats — a database query failed. Try again. (HTTP 503)",
    });
  });

  it("504 with an HTML gateway page → an error, not a JSON parse throw", async () => {
    const res = new Response("<html><body>504 Gateway Timeout</body></html>", {
      status: 504,
      headers: { "content-type": "text/html" },
    });
    const r = await readStatsResponse<Stats>(res);
    expect(r).toEqual({ ok: false, error: "Stats failed to load (HTTP 504, non-JSON response)" });
  });

  it("a rejected fetch (network failure) → an error, never a throw", async () => {
    const r = await readStatsResponse<Stats>(Promise.reject(new TypeError("Failed to fetch")));
    expect(r).toEqual({ ok: false, error: "Stats request failed (no response: Failed to fetch)" });
  });

  it("200 with a non-JSON or non-object body is not stats", async () => {
    expect(await readStatsResponse<Stats>(new Response("OK", { status: 200 }))).toEqual({
      ok: false,
      error: "Stats returned an unreadable response (HTTP 200)",
    });
    expect(await readStatsResponse<Stats>(json([1, 2]))).toMatchObject({ ok: false });
    expect(await readStatsResponse<Stats>(json(null))).toMatchObject({ ok: false });
  });

  it("a non-ok JSON body without an error string still names the status", async () => {
    expect(await readStatsResponse<Stats>(json({ nope: true }, 500))).toEqual({
      ok: false,
      error: "Stats failed to load (HTTP 500)",
    });
  });
});
