import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ capturePaymentCompare: vi.fn() }));

import { capturePaymentCompare } from "@/lib/sentry";
import { readServiceFeeCents } from "@/lib/promo/stamped-discount";
import {
  boundFromPayment,
  comparePriceCheck,
  compareRequestWithPayment,
  compareReservationWithPayment,
  fieldsDifferingFromPayment,
  fieldsDifferingFromRow,
  noteUnstagedPayment,
} from "../payment-compare";

const META = {
  customerEmail: " Ada@Example.com ",
  locationId: "42",
  parkingTypeId: "7",
  checkin: "2026-08-14",
  checkout: "2026-08-18",
  checkinTime: "10:00 AM",
  checkoutTime: "2:00 PM",
  serviceFee: "5.95",
};
const used = {
  locationId: 42,
  parkingTypeId: 7,
  fromDate: "2026-08-14 10:00:00",
  toDate: "2026-08-18 14:00:00",
  customer: { email: "ada@example.com" },
  triplyServiceFee: 5.95,
};
const row = { location_id: 42, parking_type_id: 7, from_date: used.fromDate, to_date: used.toDate, customer: { email: "ADA@example.com" } };
const pi = (metadata: Record<string, string> = META, amount = 7395) => ({ id: "pi_1", amount, livemode: true, metadata });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
const last = () => vi.mocked(capturePaymentCompare).mock.calls.at(-1)!;

beforeEach(() => {
  vi.mocked(capturePaymentCompare).mockReset();
});

describe("readServiceFeeCents", () => {
  it.each([
    ["5.95", 595],
    ["6", 600],
    ["12.5", 1250],
    ["0", 0],
  ])("reads %s as %i cents", (raw, cents) => expect(readServiceFeeCents({ serviceFee: raw })).toBe(cents));

  it.each(["", "six", "-1", "5.955", "05", " 6", "6 ", "1e2", "NaN"])("refuses %j", (raw) =>
    expect(readServiceFeeCents({ serviceFee: raw })).toBeNull()
  );

  it("is null, never 0, when the key is absent", () => {
    expect(readServiceFeeCents({})).toBeNull();
    expect(readServiceFeeCents(null)).toBeNull();
  });
});

describe("boundFromPayment", () => {
  it("builds the priced window with checkout's own helper", () => {
    expect(boundFromPayment(META)).toEqual({
      ok: true,
      locationId: 42,
      parkingTypeId: 7,
      fromDate: "2026-08-14 10:00:00",
      toDate: "2026-08-18 14:00:00",
      email: "ada@example.com",
    });
  });

  it.each([
    ["12:00 AM", "00:00:00"],
    ["12:00 PM", "12:00:00"],
    ["9:30 AM", "09:30:00"],
    ["09:30 AM", "09:30:00"],
    ["11:30 PM", "23:30:00"],
  ])("reads %s as %s", (time, clock) => {
    const bound = boundFromPayment({ ...META, checkinTime: time });
    expect(bound.ok && bound.fromDate).toBe(`2026-08-14 ${clock}`);
  });

  it.each(["locationId", "parkingTypeId", "checkin", "checkout", "checkinTime", "checkoutTime", "customerEmail"] as const)(
    "names %s when it is missing or empty",
    (key) => {
      const rest: Record<string, string> = { ...META };
      Reflect.deleteProperty(rest, key);
      expect(boundFromPayment(rest)).toEqual({ ok: false, unusable: [key] });
      expect(boundFromPayment({ ...META, [key]: "" })).toEqual({ ok: false, unusable: [key] });
    }
  );

  it.each(["0", "042", "4.2", "abc", "-1", "42 "])("refuses the id %j", (id) => {
    expect(boundFromPayment({ ...META, locationId: id })).toEqual({ ok: false, unusable: ["locationId"] });
    expect(boundFromPayment({ ...META, parkingTypeId: id })).toEqual({ ok: false, unusable: ["parkingTypeId"] });
  });

  it.each(["2026/08/14", "14-08-2026", "tomorrow"])("refuses the date %j", (date) => {
    expect(boundFromPayment({ ...META, checkin: date })).toEqual({ ok: false, unusable: ["checkin"] });
    expect(boundFromPayment({ ...META, checkout: date })).toEqual({ ok: false, unusable: ["checkout"] });
  });

  it.each(["10:00", "10 AM", "morning", "10:00\tAM", "25:99 XM", "13:00 PM", "9:60 AM", "0:30 AM", "009:30 AM", "9:30 am"])("refuses the time %j without throwing", (time) => {
    expect(boundFromPayment({ ...META, checkinTime: time })).toEqual({ ok: false, unusable: ["checkinTime"] });
    expect(boundFromPayment({ ...META, checkoutTime: time })).toEqual({ ok: false, unusable: ["checkoutTime"] });
  });

  it("no metadata at all names every key", () => {
    expect(boundFromPayment(undefined)).toMatchObject({ ok: false, unusable: expect.arrayContaining(["locationId", "customerEmail"]) });
  });
});

describe("field differences", () => {
  const bound = boundFromPayment(META);
  if (!bound.ok) throw new Error("fixture");

  it("none when everything agrees, whatever the email's case", () => {
    expect(fieldsDifferingFromPayment(used, bound)).toEqual([]);
    expect(fieldsDifferingFromRow(used, row)).toEqual([]);
  });

  it.each([
    ["lot", { locationId: 43 }],
    ["parkingType", { parkingTypeId: 8 }],
    ["from", { fromDate: "2026-08-14 10:30:00" }],
    ["to", { toDate: "2026-08-19 14:00:00" }],
    ["email", { customer: { email: "eve@example.com" } }],
  ] as const)("names %s against the payment and against the row", (field, change) => {
    expect(fieldsDifferingFromPayment({ ...used, ...change }, bound)).toEqual([field]);
    expect(fieldsDifferingFromRow({ ...used, ...change }, row)).toEqual([field]);
  });

  it("a row with no customer, or no readable email, differs on email without throwing", () => {
    expect(fieldsDifferingFromRow(used, { ...row, customer: null })).toEqual(["email"]);
    expect(fieldsDifferingFromRow(used, { ...row, customer: {} })).toEqual(["email"]);
    expect(fieldsDifferingFromRow(used, { ...row, customer: { email: 7 } })).toEqual(["email"]);
  });
});

describe("compareRequestWithPayment", () => {
  const feeRow = (fee: string | number | null | undefined) => ({ ...row, triply_service_fee: fee });

  it.each([
    ["5.95", "match", "same"],
    [5.95, "match", "same"],
    ["6.00", "fee_differs", "differs"],
    [null, "fee_unknown", "unknown"],
    [undefined, "fee_unknown", "unknown"],
    ["", "fee_unknown", "unknown"],
    ["5.955", "fee_unknown", "unknown"],
    [-1, "fee_unknown", "unknown"],
  ] as const)("a staged fee of %j is %s", (fee, outcome, tag) => {
    compareRequestWithPayment(pi(), feeRow(fee), used, undefined);
    expect(last()[1]).toBe(outcome);
    expect(last()[2].tags).toMatchObject({ "check.fee": tag, "check.payload_source": "row", "check.reservation_recorded": "no", "check.discount_stamp": "no" });
  });

  it("with a request, the fee compared is the request's, not the row's", () => {
    compareRequestWithPayment(pi(), feeRow("9.99"), used, { ...used, triplyServiceFee: 5.95 });
    expect(last()[1]).toBe("match");
    compareRequestWithPayment(pi(), feeRow("5.95"), used, { ...used, triplyServiceFee: 7 });
    expect(last()[1]).toBe("fee_differs");
    expect(last()[2].detail).toEqual({ incomingFeeCents: 700, paymentFeeCents: 595 });
  });

  it("orders the outcomes: record unusable, then a booked field, then the row, then the fee", () => {
    const other = { ...used, locationId: 43 };
    compareRequestWithPayment(pi({ ...META, checkin: "" }), feeRow("1"), other, other);
    expect(last()[1]).toBe("payment_record_unusable");
    compareRequestWithPayment(pi(), feeRow("1"), other, other);
    expect(last()[1]).toBe("differs");
    compareRequestWithPayment(pi(), { ...feeRow("5.95"), parking_type_id: 8 }, used, used);
    expect(last()[1]).toBe("row_differs");
    expect(last()[2].detail).toEqual({ rowVsRequestFields: ["parkingType"] });
  });

  it("tags a resume and a discount stamp", () => {
    compareRequestWithPayment(pi({ ...META, discountCents: "500" }), { ...feeRow("5.95"), reslab_reservation_number: "RTL1" }, used, undefined);
    expect(last()[2].tags).toMatchObject({ "check.reservation_recorded": "yes", "check.discount_stamp": "yes" });
  });
});

describe("the entries write to nothing they are given", () => {
  it("run on deep-frozen inputs", () => {
    const frozenPi = deepFreeze(pi());
    const frozenUsed = deepFreeze({ ...used, customer: { ...used.customer } });
    const frozenRow = deepFreeze({ ...row, customer: { ...row.customer } });
    const cost = deepFreeze({ reservation: { grand_total: 88, due_at_location: 20 } });
    const fr = deepFreeze({
      money: { grandTotal: 88, dueAtLocation: 20 },
      location: { reslabLocationId: 42 },
      dates: [{ fromDate: used.fromDate, toDate: used.toDate }],
    });

    compareRequestWithPayment(frozenPi, frozenRow, frozenUsed, frozenUsed);
    noteUnstagedPayment(frozenPi);
    comparePriceCheck(frozenPi, frozenUsed, cost, 0, 0, 7395);
    compareReservationWithPayment(frozenPi, fr, deepFreeze({ premium: 0 }));

    const outcomes = vi.mocked(capturePaymentCompare).mock.calls.map(([site, outcome]) => `${site}:${outcome}`);
    expect(outcomes).toEqual(["request:match", "unstaged:no_staged_row", "price_check:match", "reservation:match"]);
  });
});

describe("a fault inside a comparison", () => {
  it("is reported by class only, and never thrown", () => {
    const hostile = {
      ...pi(),
      get metadata(): Record<string, string> {
        throw new TypeError("customer ada@example.com");
      },
    };
    expect(() => compareRequestWithPayment(hostile, row, used, undefined)).not.toThrow();
    expect(() => comparePriceCheck(hostile, used, { reservation: { grand_total: 1, due_at_location: 0 } }, 0, 0, 1)).not.toThrow();
    expect(() => compareReservationWithPayment(hostile, { money: { grandTotal: 1, dueAtLocation: 0 }, location: null, dates: null }, null)).not.toThrow();
    expect(() => noteUnstagedPayment(hostile)).not.toThrow();
    const calls = vi.mocked(capturePaymentCompare).mock.calls;
    expect(calls.map(([site, outcome]) => `${site}:${outcome}`)).toEqual([
      "request:crashed",
      "price_check:crashed",
      "reservation:crashed",
      "unstaged:crashed",
    ]);
    expect(calls[0][2]).toEqual({ stripePaymentIntentId: "pi_1", livemode: true, detail: { errorClass: "TypeError" } });
    expect(JSON.stringify(calls)).not.toContain("ada@");
  });

  it("never throws when the reporter itself throws, and logs the site name only", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(capturePaymentCompare).mockImplementation(() => {
      throw new Error("reporter down for ada@example.com");
    });
    expect(() => compareRequestWithPayment(pi(), row, used, undefined)).not.toThrow();
    expect(() => noteUnstagedPayment(pi())).not.toThrow();
    expect(logged.mock.calls).toEqual([
      ["payment-compare: reporter failed", "request"],
      ["payment-compare: reporter failed", "unstaged"],
    ]);
    logged.mockRestore();
  });

  it("copes with a null PaymentIntent", () => {
    // @ts-expect-error a caller bug this file must still survive
    expect(() => noteUnstagedPayment(null)).not.toThrow();
    expect(last()[2]).toMatchObject({ stripePaymentIntentId: "unknown", livemode: false });
  });
});

describe("comparePriceCheck", () => {
  const cost = { reservation: { grand_total: 88, due_at_location: 20 } };

  it("uses today's sum with only the fee swapped", () => {
    comparePriceCheck(pi({ ...META, serviceFee: "6" }, 7400), { ...used, triplyServiceFee: 6 }, cost, 0, 0, 7400);
    expect(last().slice(0, 2)).toEqual(["price_check", "match"]);
    expect(last()[2]).toMatchObject({ detail: { freshCents: 7400, withPaymentFeeCents: 7400, authorisedCents: 7400 } });
  });

  it("keeps the one-cent tolerance", () => {
    comparePriceCheck(pi({ ...META, serviceFee: "6.01" }, 7400), used, cost, 0, 0, 7400);
    expect(last()[1]).toBe("match");
    comparePriceCheck(pi({ ...META, serviceFee: "6.02" }, 7400), used, cost, 0, 0, 7400);
    expect(last()[1]).toBe("payment_fee_over");
  });

  it("gives the engine's figure the same one-cent tolerance", () => {
    comparePriceCheck(pi({ ...META, serviceFee: "6.01" }, 7400), used, cost, 0, 0, 7401);
    expect(last()[1]).toBe("match");
    comparePriceCheck(pi({ ...META, serviceFee: "6.01" }, 7400), used, cost, 0, 0, 7402);
    expect(last()[1]).toBe("payment_fee_within");
  });

  it("reports when only the engine's figure is over the amount", () => {
    comparePriceCheck(pi({ ...META, serviceFee: "6" }, 7400), used, cost, 0, 0, 7800);
    expect(last()[1]).toBe("payment_fee_within");
  });

  it("takes the promo discount off and adds the premium, as today", () => {
    comparePriceCheck(pi({ ...META, serviceFee: "6" }, 8100), used, cost, 8, 15, 8100);
    expect(last()[2]).toMatchObject({ detail: { withPaymentFeeCents: 8100 } });
    expect(last()[1]).toBe("match");
  });

  it("a figure that is not a number is unverified, not a pass", () => {
    comparePriceCheck(pi(), used, { reservation: { grand_total: Number.NaN, due_at_location: 20 } }, 0, 0, Number.NaN);
    expect(last()[1]).toBe("unverified");
  });

  it("says when the payload carried no fee", () => {
    const noFee = { locationId: 42, parkingTypeId: 7, fromDate: used.fromDate, toDate: used.toDate, customer: used.customer };
    comparePriceCheck(pi(), noFee, cost, 0, 0, 6800);
    expect(last()[2].tags).toEqual({ "check.payload_fee": "missing" });
  });
});

describe("compareReservationWithPayment", () => {
  const fr = (money: { grandTotal: unknown; dueAtLocation: unknown }, lot: unknown = 42) => ({
    money,
    location: { reslabLocationId: lot },
    dates: [{ fromDate: used.fromDate, toDate: used.toDate }],
  });
  const money = { grandTotal: 88, dueAtLocation: 20 };
  const tags = () => last()[2].tags;

  it("amount = grand − due + fee − discount + premium, in whole cents", () => {
    compareReservationWithPayment(pi(META, 6800 + 595), fr(money), null);
    expect(last()[1]).toBe("match");
    expect(tags()).toEqual({
      "check.amount": "0",
      "check.amount_direction": "exact",
      "check.lot": "match",
      "check.dates": "match",
      "check.times": "match",
    });
  });

  it("reads ResLab's numeric strings", () => {
    compareReservationWithPayment(pi(META, 7395), fr({ grandTotal: "88.00", dueAtLocation: "20" }), null);
    expect(tags()).toMatchObject({ "check.amount": "0" });
  });

  it("counts a stamped discount and a protection premium", () => {
    const stamped = { ...META, discountCents: "500", onlineParkingCents: "6800", preDiscountOnlineCents: "7395" };
    compareReservationWithPayment(pi(stamped, 7395 - 500 + 1499), fr(money), { premium: 14.99 });
    expect(tags()).toMatchObject({ "check.amount": "0" });
  });

  it.each([
    [7396, "1c", "charged_more"],
    [7394, "1c", "charged_less"],
    [7397, "2_to_100c", "charged_more"],
    [7495, "2_to_100c", "charged_more"],
    [7496, "over_100c", "charged_more"],
    [7294, "over_100c", "charged_less"],
  ])("an amount of %i cents lands in %s, %s", (amount, bucket, direction) => {
    compareReservationWithPayment(pi(META, amount), fr(money), null);
    expect(tags()).toMatchObject({ "check.amount": bucket, "check.amount_direction": direction });
    expect(last()[1]).toBe("differs");
  });

  it.each([
    ["grand", { grandTotal: null, dueAtLocation: 20 }, META],
    ["due", { grandTotal: 88, dueAtLocation: undefined }, META],
    ["grand", { grandTotal: "n/a", dueAtLocation: 20 }, META],
    ["fee", money, { ...META, serviceFee: "free" }],
    ["discount", money, { ...META, discountCents: "-5" }],
    ["discount", money, { ...META, discountPercent: "10" }],
  ] as const)("an unreadable %s is unknown, never 0", (figure, figures, metadata) => {
    compareReservationWithPayment(pi(metadata), fr(figures), null);
    expect(tags()).toMatchObject({ "check.amount": "unknown" });
    expect(last()[1]).toBe("differs");
    expect(last()[2].detail).toEqual({ differenceCents: "unknown", unknownFigures: [figure] });
  });

  it("a premium that is not whole cents is unknown and named", () => {
    compareReservationWithPayment(pi(), fr(money), { premium: Number.NaN });
    expect(last()[2].detail).toEqual({ differenceCents: "unknown", unknownFigures: ["premium"] });
  });

  it("an unusable payment record names its keys", () => {
    compareReservationWithPayment(pi({ ...META, locationId: "" }), fr(money), null);
    expect(tags()).toMatchObject({ "check.lot": "unknown", "check.dates": "unknown", "check.times": "unknown" });
    expect(last()[2].detail).toMatchObject({ unusableKeys: ["locationId"] });
  });

  it("another lot is a mismatch; an absent or unreadable one is unknown, never a match", () => {
    compareReservationWithPayment(pi(), fr(money, 43), null);
    expect(tags()).toMatchObject({ "check.lot": "mismatch" });
    compareReservationWithPayment(pi(), fr(money, "42"), null);
    expect(tags()).toMatchObject({ "check.lot": "match" });
    compareReservationWithPayment(pi(), fr(money, "forty-two"), null);
    expect(tags()).toMatchObject({ "check.lot": "unknown" });
    compareReservationWithPayment(pi(), { money, location: null, dates: null }, null);
    expect(tags()).toMatchObject({ "check.lot": "unknown", "check.dates": "unknown" });
  });

  it("another day is a mismatch", () => {
    compareReservationWithPayment(pi(), { ...fr(money), dates: [{ fromDate: used.fromDate, toDate: "2026-08-19 14:00:00" }] }, null);
    expect(tags()).toMatchObject({ "check.dates": "mismatch" });
    expect(last()[1]).toBe("differs");
  });

  it("the same days at midnight match; the clock time is its own tag", () => {
    compareReservationWithPayment(pi(), { ...fr(money), dates: [{ fromDate: "2026-08-14 00:00:00", toDate: "2026-08-18 00:00:00" }] }, null);
    expect(tags()).toMatchObject({ "check.dates": "match", "check.times": "midnight_only" });
    expect(last()[1]).toBe("match");
    compareReservationWithPayment(pi(), { ...fr(money), dates: [{ fromDate: "2026-08-14 10:00:00", toDate: "2026-08-18 15:00:00" }] }, null);
    expect(tags()).toMatchObject({ "check.dates": "match", "check.times": "mismatch" });
    expect(last()[1]).toBe("differs");
  });
});
