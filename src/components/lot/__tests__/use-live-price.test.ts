import { describe, it, expect, vi } from "vitest";
import { fetchQuote, pickLive, planLivePrice, settleQuote, type LivePriceInput } from "../use-live-price";
import { PRICE_MESSAGES, isUnavailable, shownPrice } from "../shown-price";
import type { LotQuote } from "@/lib/pricing/price-view";

const input = (over: Partial<LivePriceInput> = {}): LivePriceInput => ({
  lotId: "reslab-275",
  checkIn: "2026-10-30",
  checkOut: "2026-11-02",
  checkInTime: "",
  checkOutTime: "",
  pricedCheckIn: "2026-10-30",
  pricedCheckOut: "2026-11-02",
  enabled: true,
  ...over,
});

describe("planLivePrice", () => {
  it("keeps the loaded price only while the dates are unchanged and no time is picked", () => {
    expect(planLivePrice(input())).toEqual({ kind: "as_loaded" });
  });

  it("one time picked shows no figure — it can already change the billed days", () => {
    expect(planLivePrice(input({ checkInTime: "11:00 PM" }))).toEqual({ kind: "needs_times" });
    expect(planLivePrice(input({ checkOutTime: "8:00 PM" }))).toEqual({ kind: "needs_times" });
  });

  it("dates changed with times not picked: no figure (Tom, option A)", () => {
    expect(planLivePrice(input({ checkOut: "2026-11-05" }))).toEqual({ kind: "needs_times" });
  });

  it("both times picked: quotes the stay on screen — even the link's own times, which the server may have priced differently", () => {
    const plan = planLivePrice(input({ checkInTime: "10:00 AM", checkOutTime: "2:00 PM" }));
    expect(plan.kind).toBe("fetch");
    if (plan.kind !== "fetch") return;
    expect(Object.fromEntries(new URLSearchParams(plan.key))).toEqual({
      lotId: "reslab-275",
      checkin: "2026-10-30",
      checkout: "2026-11-02",
      checkinTime: "10:00 AM",
      checkoutTime: "2:00 PM",
    });
  });

  it("each stay gets its own key", () => {
    const a = planLivePrice(input({ checkInTime: "8:00 AM", checkOutTime: "6:30 PM" }));
    const b = planLivePrice(input({ checkInTime: "8:00 AM", checkOutTime: "7:00 PM" }));
    expect(a.kind === "fetch" && b.kind === "fetch" && a.key !== b.key).toBe(true);
  });

  it("a pick-up at or before the drop-off is refused without asking the server", () => {
    const same = { checkIn: "2026-10-30", checkOut: "2026-10-30" };
    expect(planLivePrice(input({ ...same, checkInTime: "6:00 PM", checkOutTime: "8:00 AM" }))).toEqual({ kind: "not_bookable" });
    expect(planLivePrice(input({ ...same, checkInTime: "8:00 AM", checkOutTime: "8:00 AM" }))).toEqual({ kind: "not_bookable" });
    // 12:00 PM sorts after 9:00 AM once converted to 24 h — not as text.
    expect(planLivePrice(input({ ...same, checkInTime: "9:00 AM", checkOutTime: "12:00 PM" })).kind).toBe("fetch");
  });

  it("a lot not open for booking never quotes, and never shows the old figure for other dates", () => {
    const picked = { checkInTime: "8:00 AM", checkOutTime: "6:30 PM" };
    expect(planLivePrice(input({ enabled: false, ...picked }))).toEqual({ kind: "as_loaded" });
    expect(planLivePrice(input({ enabled: false, checkOut: "2026-11-05", ...picked }))).toEqual({ kind: "closed" });
  });
});

const QUOTE: LotQuote = {
  grandTotal: 55.2,
  subtotal: 46.25,
  feesTotal: 3.99,
  taxTotal: 4.96,
  serviceFee: 5.95,
  dueAtLocation: 43.24,
  numberOfDays: 3,
  soldOut: false,
};

describe("settleQuote", () => {
  it("a valid quote becomes the figures — PARK AC 8 AM → 8 AM is checkout's $61.15", () => {
    const s = settleQuote(200, { quote: QUOTE });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") {
      expect(s.view.total).toBeCloseTo(61.15, 10);
      expect(s.view.dueAtLocation).toBe(43.24);
    }
  });

  it("refusals turn Reserve off; outages and malformed answers show no figure", () => {
    expect(settleQuote(200, { quote: { ...QUOTE, soldOut: true } })).toEqual({ kind: "sold_out" });
    for (const status of [400, 404, 422]) expect(settleQuote(status, { code: "x" })).toEqual({ kind: "not_bookable" });
    for (const status of [500, 502, 503]) expect(settleQuote(status, null)).toEqual({ kind: "error" });
    expect(settleQuote(200, null)).toEqual({ kind: "error" });
    expect(settleQuote(200, { quote: { ...QUOTE, taxTotal: undefined } })).toEqual({ kind: "error" });
    expect(settleQuote(200, { quote: { ...QUOTE, grandTotal: "55.2" } })).toEqual({ kind: "error" });
    expect(settleQuote(200, { quote: { ...QUOTE, grandTotal: 0 } })).toEqual({ kind: "error" });
  });
});

describe("fetchQuote", () => {
  const ok = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("asks /api/lots/quote for the stay, uncached", async () => {
    const fetchImpl = ok({ quote: QUOTE });
    const out = await fetchQuote("lotId=reslab-275&checkin=2026-10-30", new AbortController().signal, fetchImpl);
    expect(out?.kind).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledWith("/api/lots/quote?lotId=reslab-275&checkin=2026-10-30", expect.objectContaining({ cache: "no-store" }));
  });

  it("a network failure or a non-JSON body shows no figure", async () => {
    const boom = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await fetchQuote("k", new AbortController().signal, boom)).toEqual({ kind: "error" });
    const html = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchQuote("k", new AbortController().signal, html)).toEqual({ kind: "error" });
  });

  it("an answer that lands after its stay was replaced (aborted) is dropped", async () => {
    const controller = new AbortController();
    const late = vi.fn(async () => {
      controller.abort();
      return new Response(JSON.stringify({ quote: QUOTE }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchQuote("k", controller.signal, late)).toBeNull();
  });
});

describe("pickLive", () => {
  const ready = settleQuote(200, { quote: QUOTE });
  it("shows an answer only for the stay it was asked for", () => {
    expect(pickLive({ kind: "fetch", key: "A" }, { key: "A", price: ready })).toBe(ready);
    expect(pickLive({ kind: "fetch", key: "B" }, { key: "A", price: ready })).toEqual({ kind: "loading" });
    expect(pickLive({ kind: "fetch", key: "A" }, null)).toEqual({ kind: "loading" });
    expect(pickLive({ kind: "needs_times" }, { key: "A", price: ready })).toEqual({ kind: "needs_times" });
  });
});

describe("shownPrice", () => {
  const settled = settleQuote(200, { quote: QUOTE });
  const view = settled.kind === "ready" ? settled.view : null;

  it("the loaded price, the fresh price — or the daily rate alone when there's no total", () => {
    expect(shownPrice({ kind: "as_loaded" }, view, 15.96)).toEqual({ kind: "view", view });
    expect(shownPrice({ kind: "ready", view: view! }, null, 15.96)).toEqual({ kind: "view", view });
    expect(shownPrice({ kind: "as_loaded" }, null, 9.95)).toEqual({ kind: "rate_only" });
    expect(shownPrice({ kind: "closed" }, view, 9.95)).toEqual({ kind: "rate_only" });
  });

  it("never a $0.00 rate: no rate → a message", () => {
    expect(shownPrice({ kind: "as_loaded" }, null, 0)).toEqual({ kind: "message", ...PRICE_MESSAGES.needsTimes });
    expect(shownPrice({ kind: "closed" }, null, 0)).toEqual({ kind: "message", ...PRICE_MESSAGES.closed });
  });

  it("every other state is a message, never a number", () => {
    expect(shownPrice({ kind: "needs_times" }, view, 15.96)).toEqual({ kind: "message", ...PRICE_MESSAGES.needsTimes });
    expect(shownPrice({ kind: "loading" }, view, 15.96)).toEqual({ kind: "message", ...PRICE_MESSAGES.loading });
    expect(shownPrice({ kind: "sold_out" }, view, 15.96)).toEqual({ kind: "message", ...PRICE_MESSAGES.soldOut });
    expect(shownPrice({ kind: "not_bookable" }, view, 15.96)).toEqual({ kind: "message", ...PRICE_MESSAGES.notBookable });
    expect(shownPrice({ kind: "error" }, view, 15.96)).toEqual({ kind: "message", ...PRICE_MESSAGES.error });
  });

  it("Reserve is off for sold-out and refused stays only", () => {
    expect(isUnavailable({ kind: "sold_out" })).toBe(true);
    expect(isUnavailable({ kind: "not_bookable" })).toBe(true);
    for (const kind of ["as_loaded", "needs_times", "closed", "loading", "error"] as const) {
      expect(isUnavailable({ kind })).toBe(false);
    }
  });
});
