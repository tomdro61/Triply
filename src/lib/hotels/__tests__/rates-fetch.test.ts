import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hotels/liteapi/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hotels/liteapi/env")>();
  return { ...actual, resolveHotelEnv: () => ({ mode: "sandbox", apiKey: "k", dataBaseUrl: "https://data.test", bookBaseUrl: "https://book.test" }) };
});

import { fetchParkStayRates } from "../liteapi/rates";
import { LiteApiError } from "../liteapi/client";
import { takeLiteApiCall } from "../liteapi/budget";
import { HOTEL_LOTS } from "../hotel-lots";
import { content, hotelRates, rate } from "./fixtures";

const doubletree = HOTEL_LOTS[0];
const fetchMock = vi.fn();
let reply: { status: number; text: string };

async function call() {
  const ticket = await takeLiteApiCall("sandbox", "/hotels/rates", async () => ({ data: [{ allowed: true, calls: 1, denied: 0 }], error: null }));
  return fetchParkStayRates({
    hotelIds: ["lp27fe6"],
    checkin: "2026-11-10",
    checkout: "2026-11-11",
    adults: 2,
    hotelTimeZone: "America/New_York",
    now: new Date("2026-10-20T16:00:00Z"),
    ticket,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(reply.text, { status: reply.status }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchParkStayRates — the 200 body is validated at the boundary (review H1, T5)", () => {
  it("a normal body maps rates and content", async () => {
    reply = { status: 200, text: JSON.stringify({ data: [hotelRates("lp27fe6", [rate({ rateId: "a", net: 200, ssp: 220 })])], hotels: [content(doubletree)], sandbox: true }) };
    const r = await call();
    expect(r.rates.get("lp27fe6")?.rates).toHaveLength(1);
    expect(r.content.get("lp27fe6")?.name).toBe(doubletree.liteapi.name);
    expect(r.sandbox).toBe(true);
  });

  it("{ data: [], hotels: [] } is a genuine empty — no rates, no error", async () => {
    reply = { status: 200, text: JSON.stringify({ data: [], hotels: [] }) };
    const r = await call();
    expect(r.rates.size).toBe(0);
  });

  it.each([
    ["{} (no data)", "{}"],
    ["an error body", JSON.stringify({ error: { code: 4000, description: "invalid request" } })],
    ["data that is not an array", JSON.stringify({ data: { hotelId: "lp27fe6" } })],
    ["HTML", "<html>gateway</html>"],
    ["an empty body", ""],
  ])("%s at HTTP 200 → LiteApiError (the route answers 503), never 'sold out'", async (_label, text) => {
    reply = { status: 200, text };
    await expect(call()).rejects.toBeInstanceOf(LiteApiError);
  });

  it("LiteAPI's no-availability code 2001 is an honest empty — as a 200 body…", async () => {
    reply = { status: 200, text: JSON.stringify({ error: { code: 2001, description: "no availability found" } }) };
    expect((await call()).rates.size).toBe(0);
  });

  it("…and as a 4xx (no 503, no Sentry for an ordinary sold-out night)", async () => {
    reply = { status: 400, text: JSON.stringify({ error: { code: 2001, description: "no availability found" } }) };
    expect((await call()).rates.size).toBe(0);
  });

  it("another 4xx, or a 5xx, still throws", async () => {
    reply = { status: 400, text: JSON.stringify({ error: { code: 4002, description: "bad hotelIds" } }) };
    await expect(call()).rejects.toBeInstanceOf(LiteApiError);
    reply = { status: 503, text: "down" };
    await expect(call()).rejects.toMatchObject({ statusCode: 503 });
  });

  it("a malformed hotels[] entry is skipped (the hotel falls back to the map's name), the rest still map", async () => {
    reply = { status: 200, text: JSON.stringify({ data: [hotelRates("lp27fe6", [rate({ rateId: "a", net: 200, ssp: 220 })])], hotels: [{ id: 5 }] }) };
    const r = await call();
    expect(r.content.size).toBe(0);
    expect(r.anomalies.some((a) => a.includes("hotels[]"))).toBe(true);
  });
});
