import { describe, expect, it } from "vitest";
import {
  convertCost,
  convertMinPrice,
  isSellableLocation,
  lotCurrency,
  lotFxFields,
  minPriceInUsd,
  pricingCurrencyFields,
  stampedCurrencyProblem,
} from "../currency";
import type { ReslabCostResponse, ReslabMinPriceResponse } from "../client";

const RATE = { id: "t1", micros: 725_000 };
const NOW = new Date("2026-11-17T12:00:00Z");

const minPrice = (r: Partial<ReslabMinPriceResponse["reservation"]> = {}): ReslabMinPriceResponse => ({
  rates: [{ id: 9, location_parking_type_id: 44, price: 15.98, from_date: "a", to_date: "b", number_of_days: 8 }],
  reservation: {
    fees: [{ id: 1, name: "Channel fee", amount: 5, calculation: "one_time", type: "percentage", associated_to: "parking", total: 5.38 }],
    due_at_location: 0,
    tax_total: 12.88,
    long_term_discount: 0,
    location_commission: 98.92,
    available_spots: 7,
    discount: 0,
    parking_sold_out: false,
    fees_total: 5.38,
    totals: { parking: { number_of_days: 8, sub_total: 107.55 } },
    sold_out: false,
    sub_total: 107.55,
    grand_total: 125.81,
    ...r,
  },
  token: "search-token",
});

describe("lotCurrency", () => {
  it("a US lot, and a lot with no currency outside Canada, are USD (as before)", () => {
    expect(lotCurrency({ currency: { code: "USD" } }, NOW)).toEqual({ kind: "usd" });
    expect(lotCurrency({ currency: { code: "usd" }, country: { code: "US" } }, NOW)).toEqual({ kind: "usd" });
    expect(lotCurrency({}, NOW)).toEqual({ kind: "usd" });
    expect(lotCurrency({ currency: null }, NOW)).toEqual({ kind: "usd" });
  });
  it("a lot in Canada must say its currency: missing or 'USD' is hidden, never sold one-for-one", () => {
    expect(lotCurrency({ country: { code: "CA" } }, NOW)).toEqual({ kind: "hidden", reason: "currency_missing" });
    expect(lotCurrency({ currency: null, country: { code: "ca" } }, NOW)).toEqual({ kind: "hidden", reason: "currency_missing" });
    expect(lotCurrency({ currency: { code: "USD" }, country: { code: "CA" } }, NOW)).toEqual({ kind: "hidden", reason: "currency_missing" });
  });
  it("a third currency is hidden", () => {
    expect(lotCurrency({ currency: { code: "EUR" } }, NOW)).toEqual({ kind: "hidden", reason: "currency" });
  });
  it("a CAD lot is hidden while no rate is set", () => {
    expect(lotCurrency({ currency: { code: "CAD" }, country: { code: "CA" } }, NOW, null)).toEqual({ kind: "hidden", reason: "no_rate" });
    expect(isSellableLocation({ currency: { code: "CAD" } }, NOW, null)).toBe(false);
  });
  it("a CAD lot that collects at the lot is hidden before the rate is even looked at", () => {
    expect(lotCurrency({ currency: { code: "CAD" }, parking_due_at_location: 1 }, NOW)).toEqual({ kind: "hidden", reason: "pay_at_lot" });
    expect(lotCurrency({ currency: { code: "CAD" }, parking_due_at_location: true }, NOW)).toEqual({ kind: "hidden", reason: "pay_at_lot" });
  });
  it("with no rate, isSellableLocation gives the old USD-only rule's answer for every case the old tests pinned", () => {
    expect(isSellableLocation({ currency: { code: "USD" } }, NOW, null)).toBe(true);
    expect(isSellableLocation({ currency: { code: "usd" } }, NOW, null)).toBe(true);
    expect(isSellableLocation({ currency: null }, NOW, null)).toBe(true);
    expect(isSellableLocation({}, NOW)).toBe(true);
    expect(isSellableLocation({ currency: { code: "CAD" } }, NOW, null)).toBe(false);
    expect(isSellableLocation({ currency: { code: "EUR" } }, NOW)).toBe(false);
  });
});

describe("pricingCurrencyFields", () => {
  it("a US lot reports what it always did", () => {
    expect(pricingCurrencyFields({ currency: { code: "USD" } }, { kind: "usd" })).toEqual({ currency: "$", currencyCode: "USD" });
    expect(pricingCurrencyFields({}, { kind: "usd" })).toEqual({ currency: "$", currencyCode: "USD" });
  });
  it("a converted lot's pricing reports US dollars; the rate id goes on the lot, and only for a converted lot", () => {
    expect(pricingCurrencyFields({ currency: { code: "CAD" } }, { kind: "cad", rate: RATE })).toEqual({ currency: "$", currencyCode: "USD" });
    expect(lotFxFields({ kind: "cad", rate: RATE })).toEqual({ fxRateId: "t1" });
    expect(lotFxFields({ kind: "usd" })).toEqual({});
    expect(lotFxFields({ kind: "hidden", reason: "no_rate" })).toEqual({});
  });
});

describe("convertMinPrice / convertCost", () => {
  it("converts the money, keeps availability and the parking type id, and carries nothing else in CAD", () => {
    const r = convertMinPrice(minPrice(), RATE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reservation).toEqual({
      fees: [],
      location_commission: 0,
      discount: 0,
      available_spots: 7,
      parking_sold_out: false,
      sold_out: false,
      sub_total: 77.97,
      fees_total: 3.9,
      tax_total: 9.34,
      long_term_discount: 0,
      grand_total: 91.21,
      due_at_location: 0,
      totals: { parking: { number_of_days: 8, sub_total: 77.97 } },
    });
    expect(r.value.rates).toEqual([{ id: 9, location_parking_type_id: 44, price: 0, from_date: "a", to_date: "b", number_of_days: 8 }]);
    expect(r.value.token).toBe("search-token");
    // No CAD figure survives anywhere in the converted object.
    expect(JSON.stringify(r.value)).not.toMatch(/107\.55|125\.81|98\.92|15\.98|5\.38|12\.88/);
  });

  it("a cost response keeps its costs_token and drops the fields nothing reads", () => {
    const cost: ReslabCostResponse = {
      ...minPrice(),
      costs_token: "lock-5-min",
      reservation: { ...minPrice().reservation, total_after_cancellation_policy: 125.81 },
    };
    const r = convertCost(cost, RATE);
    expect(r.ok && r.value.costs_token).toBe("lock-5-min");
    expect(r.ok && "old_reservation" in r.value).toBe(false);
    expect(r.ok && "total_after_cancellation_policy" in r.value.reservation).toBe(false);
    expect(r.ok && r.value.reservation.grand_total).toBe(91.21);
  });

  it("a sold-out answer with zero prices converts to zeros and stays sold out", () => {
    const r = convertMinPrice(minPrice({ sub_total: 0, fees_total: 0, tax_total: 0, grand_total: 0, sold_out: true, totals: { parking: { number_of_days: 8, sub_total: 0 } } }), RATE);
    expect(r.ok && r.value.reservation.sold_out).toBe(true);
    expect(r.ok && r.value.reservation.grand_total).toBe(0);
  });

  it.each([
    ["parts that do not add up", { grand_total: 125.82 }, "parts_do_not_add_up"],
    ["a pay-at-lot share", { due_at_location: 20 }, "pay_at_lot"],
    ["a nonzero discount", { discount: 5 }, "discount"],
    ["a discount that is not a number", { discount: "5" as unknown as number }, "discount"],
    ["a missing amount", { tax_total: undefined as unknown as number }, "bad_amount"],
  ])("refuses %s", (_n, bad, reason) => {
    expect(convertMinPrice(minPrice(bad), RATE)).toEqual({ ok: false, reason });
  });

  it("never throws on junk", () => {
    expect(convertMinPrice({} as ReslabMinPriceResponse, RATE).ok).toBe(false);
    expect(convertCost(null as unknown as ReslabCostResponse, RATE).ok).toBe(false);
  });
});

describe("minPriceInUsd", () => {
  it("a US lot's data passes through untouched (same object)", () => {
    const data = minPrice();
    expect(minPriceInUsd(data, { kind: "usd" })).toEqual({ data, unusable: null });
    expect(minPriceInUsd(data, { kind: "usd" }).data).toBe(data);
    expect(minPriceInUsd(null, { kind: "usd" })).toEqual({ data: null, unusable: null });
  });
  it("a CAD lot's data is converted, or dropped with a reason", () => {
    expect(minPriceInUsd(minPrice(), { kind: "cad", rate: RATE }).data?.reservation.grand_total).toBe(91.21);
    expect(minPriceInUsd(minPrice({ grand_total: 1 }), { kind: "cad", rate: RATE })).toEqual({ data: null, unusable: "fx_parts_do_not_add_up" });
    expect(minPriceInUsd(null, { kind: "cad", rate: RATE })).toEqual({ data: null, unusable: null });
  });
  it("a hidden lot never yields a price", () => {
    expect(minPriceInUsd(minPrice(), { kind: "hidden", reason: "no_rate" })).toEqual({ data: null, unusable: "hidden_no_rate" });
  });
});

describe("stampedCurrencyProblem — the lot's currency against the PaymentIntent's stamp, before the card is confirmed", () => {
  const usd = { kind: "usd" } as const;
  const cad = { kind: "cad", rate: RATE } as const;
  const hidden = { kind: "hidden", reason: "no_rate" } as const;

  it("a US lot with a USD stamp, or with no stamp (a PaymentIntent from before it), is fine", () => {
    expect(stampedCurrencyProblem({ kind: "usd" }, usd)).toBeNull();
    expect(stampedCurrencyProblem({ kind: "absent" }, usd)).toBeNull();
  });
  it("a CAD stamp on a CAD lot we sell today is fine, even at a newer rate (the booking keeps its stamped rate)", () => {
    expect(stampedCurrencyProblem({ kind: "cad", rate: { id: "old", micros: 700_000 } }, cad)).toBeNull();
  });
  it.each([
    ["a USD stamp on a CAD lot", { kind: "usd" } as const, cad, /priced in CAD/],
    ["no stamp on a CAD lot", { kind: "absent" } as const, cad, /priced in CAD/],
    ["a CAD stamp on a US lot", { kind: "cad", rate: RATE } as const, usd, /priced in USD/],
    ["a CAD stamp while Canadian lots are switched off", { kind: "cad", rate: RATE } as const, hidden, /not sold \(no_rate\)/],
    ["a USD stamp on a hidden lot", { kind: "usd" } as const, hidden, /not sold/],
    ["an unusable stamp", { kind: "invalid" } as const, usd, /unusable/],
  ])("%s is refused", (_n, stamp, lot, message) => {
    expect(stampedCurrencyProblem(stamp, lot)).toMatch(message);
  });
});
