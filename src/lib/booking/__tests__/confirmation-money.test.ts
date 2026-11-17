import { describe, expect, it } from "vitest";
import { reslabHistoryMoney } from "../confirmation-money";
import { fromReslab } from "../fulfilled-reservation";
import { rateToColumn } from "@/lib/fx/cad-usd";

const RATE = { id: "r1", micros: 725_000 };
const CAD_ROW = { reslab_currency: "CAD", fx_rate: rateToColumn(RATE) };
const history = (over: Record<string, unknown> = {}, currency: unknown = "CAD") => ({
  subtotal: 200,
  total_fees: 10,
  total_tax: 26,
  long_term_discount: 20,
  grand_total: 216,
  due_at_location_total: 50,
  location: { currency: { code: currency } },
  ...over,
});

describe("reslabHistoryMoney", () => {
  it("converts every figure, a long-stay discount and a pay-at-lot share included, at the row's rate", () => {
    expect(reslabHistoryMoney(history(), CAD_ROW)).toEqual({
      subtotal: 145,
      total_fees: 7.25,
      total_tax: 18.85,
      long_term_discount: 14.5,
      grand_total: 156.6,
      due_at_location_total: 36.25,
      basis: "converted",
      withheldReason: null,
    });
  });

  it("a US booking's figures pass through exactly as ResLab sent them", () => {
    const h = history({}, "USD");
    expect(reslabHistoryMoney(h, { reslab_currency: null, fx_rate: null })).toMatchObject({ subtotal: 200, grand_total: 216, due_at_location_total: 50, basis: "raw" });
    expect(reslabHistoryMoney(h, {})).toMatchObject({ grand_total: 216, basis: "raw" });
    expect(reslabHistoryMoney(h, null)).toMatchObject({ grand_total: 216, basis: "raw" });
    expect(reslabHistoryMoney(undefined, null)).toMatchObject({ grand_total: undefined, basis: "raw" });
  });

  it.each([
    ["an empty row currency", { reslab_currency: "", fx_rate: null }],
    ["a blank row currency", { reslab_currency: "  ", fx_rate: null }],
    ["a row currency that is not a string", { reslab_currency: 5, fx_rate: null }],
    ["marked as charged one for one (number)", { reslab_currency: "CAD", fx_rate: 1 }],
    ["marked as charged one for one (string)", { reslab_currency: "cad", fx_rate: "1.000000" }],
  ])("%s → raw (a booking charged before conversion existed)", (_n, row) => {
    expect(reslabHistoryMoney(history(), row)).toMatchObject({ grand_total: 216, basis: "raw" });
  });

  it("the stored rate is read whether the driver returns it as a string or a number", () => {
    expect(reslabHistoryMoney(history(), { reslab_currency: "CAD", fx_rate: 0.725 })).toMatchObject({ grand_total: 156.6, basis: "converted" });
  });

  it.each([
    ["the row could not be read and the reservation is in CAD", history(), null, /could not be read/],
    ["the row has a third currency", history(), { reslab_currency: "EUR", fx_rate: "0.725000" }, /unknown currency \(EUR\)/],
    ["the stored rate is upside down", history(), { reslab_currency: "CAD", fx_rate: "1.380000" }, /unusable/],
    ["the stored rate is missing", history(), { reslab_currency: "CAD", fx_rate: null }, /unusable/],
    ["the reservation is now in another currency", history({}, "USD"), CAD_ROW, /now priced in USD/],
    ["the parts do not add up", history({ grand_total: 217 }), CAD_ROW, /parts_do_not_add_up/],
    ["a figure is a string", history({ subtotal: "200" }), CAD_ROW, /bad_amount/],
    ["a figure is missing", history({ total_tax: null }), CAD_ROW, /bad_amount/],
  ])("amounts are withheld — every one undefined — when %s", (_n, h, row, reason) => {
    const m = reslabHistoryMoney(h, row);
    expect(m.basis).toBe("withheld");
    expect(m.withheldReason).toMatch(reason);
    expect([m.subtotal, m.total_fees, m.total_tax, m.long_term_discount, m.grand_total, m.due_at_location_total]).toEqual(Array(6).fill(undefined));
  });

  it("a missing long-stay discount or pay-at-lot amount counts as 0 in a conversion", () => {
    const h = history({ long_term_discount: undefined, due_at_location_total: null, grand_total: 236 });
    expect(reslabHistoryMoney(h, CAD_ROW)).toMatchObject({ long_term_discount: 0, due_at_location_total: 0, grand_total: 171.1, basis: "converted" });
  });

  // The booking row (fromReslab at fulfilment) and this page must read one
  // history the same way, or the page disagrees with the row and with Stripe.
  it.each([
    ["all fields valid", history()],
    ["no long-stay discount key", history({ long_term_discount: undefined, grand_total: 236 })],
    ["a null long-stay discount", history({ long_term_discount: null, grand_total: 236 })],
    ["no pay-at-lot key", history({ due_at_location_total: undefined })],
    ["a string subtotal", history({ subtotal: "200.00" })],
    ["a null subtotal", history({ subtotal: null })],
    ["a three-decimal amount", history({ total_tax: 26.005, grand_total: 216.005 })],
    ["parts that do not add up", history({ grand_total: 215.99 })],
    ["a pay-at-lot amount above the total", history({ due_at_location_total: 300 })],
  ])("fulfilment and the confirmation page agree on %s", (_n, h) => {
    const page = reslabHistoryMoney(h, CAD_ROW);
    const row = fromReslab(JSON.parse(JSON.stringify({ reservation_number: "RTL1", history: [h] })), RATE);
    if (page.basis === "withheld") {
      expect(row.fx).toMatchObject({ converted: false });
      expect(row.money.grandTotal).toBeNull();
    } else {
      expect(row.fx).toEqual({ rate: RATE, converted: true });
      expect(row.money).toEqual({
        subtotal: page.subtotal,
        feesTotal: page.total_fees,
        taxTotal: page.total_tax,
        longTermDiscount: page.long_term_discount,
        grandTotal: page.grand_total,
        dueAtLocation: page.due_at_location_total,
      });
    }
  });
});
