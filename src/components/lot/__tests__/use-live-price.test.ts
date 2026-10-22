import { describe, it, expect } from "vitest";
import { planLivePrice, settleQuote, type LivePriceInput } from "../use-live-price";
import { PRICE_MESSAGES, shownPrice } from "../price-summary";
import type { CheckoutCostData } from "@/types/checkout";

const priced = { checkIn: "2026-10-30", checkOut: "2026-11-02", checkInTime: "", checkOutTime: "" };
const input = (over: Partial<LivePriceInput> = {}): LivePriceInput => ({
  lotId: "reslab-275",
  ...priced,
  priced,
  enabled: true,
  ...over,
});

describe("planLivePrice", () => {
  it("keeps the loaded price while nothing has changed and times aren't picked", () => {
    expect(planLivePrice(input())).toEqual({ kind: "as_loaded" });
    expect(planLivePrice(input({ checkInTime: "10:00 AM" }))).toEqual({ kind: "as_loaded" });
  });

  it("shows no figure when the dates changed but times aren't picked yet (Tom, option A)", () => {
    expect(planLivePrice(input({ checkOut: "2026-11-05" }))).toEqual({ kind: "needs_times" });
    expect(planLivePrice(input({ checkIn: "2026-10-31", checkOutTime: "2:00 PM" }))).toEqual({ kind: "needs_times" });
  });

  it("fetches the checkout quote for the stay on screen once both times are picked", () => {
    const plan = planLivePrice(input({ checkInTime: "8:00 AM", checkOutTime: "6:30 PM" }));
    expect(plan.kind).toBe("fetch");
    if (plan.kind !== "fetch") return;
    const q = new URLSearchParams(plan.query);
    expect(Object.fromEntries(q)).toEqual({
      lotId: "reslab-275",
      checkin: "2026-10-30",
      checkout: "2026-11-02",
      checkinTime: "8:00 AM",
      checkoutTime: "6:30 PM",
    });
  });

  it("each stay gets its own key, so an older answer is never shown for a newer stay", () => {
    const a = planLivePrice(input({ checkInTime: "8:00 AM", checkOutTime: "6:30 PM" }));
    const b = planLivePrice(input({ checkInTime: "8:00 AM", checkOutTime: "7:00 PM" }));
    expect(a.kind === "fetch" && b.kind === "fetch" && a.key !== b.key).toBe(true);
  });

  it("doesn't re-fetch the exact stay the page was priced for", () => {
    const pricedWithTimes = { ...priced, checkInTime: "9:00 AM", checkOutTime: "5:00 PM" };
    expect(planLivePrice(input({ priced: pricedWithTimes, checkInTime: "9:00 AM", checkOutTime: "5:00 PM" }))).toEqual({
      kind: "as_loaded",
    });
  });

  it("never fetches where checkout would refuse (direct lot not open)", () => {
    expect(planLivePrice(input({ enabled: false, checkInTime: "8:00 AM", checkOutTime: "6:30 PM" }))).toEqual({
      kind: "as_loaded",
    });
    expect(planLivePrice(input({ enabled: false, checkOut: "2026-11-05", checkInTime: "8:00 AM", checkOutTime: "6:30 PM" }))).toEqual({
      kind: "needs_times",
    });
  });
});

const COST: CheckoutCostData = {
  costsToken: "tok",
  grandTotal: 70.15,
  subtotal: 59.85,
  taxTotal: 6.31,
  feesTotal: 3.99,
  serviceFee: 5.95,
  dueAtLocation: 54.95,
  dueNow: 21.15,
  numberOfDays: 4,
  soldOut: false,
};

describe("settleQuote", () => {
  it("a good answer becomes the checkout figures", () => {
    const s = settleQuote(true, { costData: COST });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") expect(s.view.total).toBeCloseTo(76.1, 10);
  });

  it("sold out, HTTP errors and empty bodies never show a figure", () => {
    expect(settleQuote(true, { costData: { ...COST, soldOut: true } })).toEqual({ kind: "sold_out" });
    expect(settleQuote(false, { costData: COST })).toEqual({ kind: "error" });
    expect(settleQuote(true, { costData: null })).toEqual({ kind: "error" });
    expect(settleQuote(true, null)).toEqual({ kind: "error" });
    expect(settleQuote(true, { costData: { ...COST, grandTotal: 0 } })).toEqual({ kind: "error" });
  });
});

describe("shownPrice", () => {
  const loaded = settleQuote(true, { costData: COST });
  const view = loaded.kind === "ready" ? loaded.view : null;

  it("the loaded price, the fresh price, or the rate only when there is no total", () => {
    expect(shownPrice({ kind: "as_loaded" }, view)).toEqual({ kind: "view", view });
    expect(shownPrice({ kind: "as_loaded" }, null)).toEqual({ kind: "rate_only" });
    expect(shownPrice({ kind: "ready", view: view! }, null)).toEqual({ kind: "view", view });
  });

  it("every other state is a message, never a number", () => {
    expect(shownPrice({ kind: "needs_times" }, view)).toEqual({ kind: "message", ...PRICE_MESSAGES.needsTimes });
    expect(shownPrice({ kind: "loading" }, view)).toEqual({ kind: "message", ...PRICE_MESSAGES.loading });
    expect(shownPrice({ kind: "sold_out" }, view)).toEqual({ kind: "message", ...PRICE_MESSAGES.soldOut });
    expect(shownPrice({ kind: "error" }, view)).toEqual({ kind: "message", ...PRICE_MESSAGES.error });
  });
});
