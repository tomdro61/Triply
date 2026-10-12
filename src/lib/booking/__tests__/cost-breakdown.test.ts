import { describe, it, expect } from "vitest";
import { buildCostBreakdown, fallbackDue, formatUsd, toCents, type CostBreakdown, type ReslabCostInput, type DirectCostInput } from "../cost-breakdown";

const reslab = (over: Partial<ReslabCostInput> = {}): ReslabCostInput => ({
  source: "reslab",
  days: 3,
  subtotal: "105.00",
  fees: "15.00",
  longTermDiscount: 0,
  tax: "14.40",
  grandTotal: "134.40",
  dueAtLocation: 0,
  serviceFee: "7.20",
  promoDiscount: "0.00",
  promoCode: null,
  expectedPromoCents: null,
  protection: null,
  anchorChargedCents: 14160, // 134.40 + 7.20
  refundedCents: 0,
  cancelled: false,
  ...over,
});

const direct = (over: Partial<DirectCostInput> = {}): DirectCostInput => ({
  source: "direct",
  days: 2,
  subtotal: "19.90",
  tax: "3.18",
  serviceFee: "5.95",
  promoDiscount: "0.00",
  promoCode: null,
  expectedPromoCents: null,
  protection: { name: "Plan A", premium: "12.99" },
  anchorChargedCents: 4202,
  refundedCents: 0,
  cancelled: false,
  atLot: { surchargeCents: 1000, surchargeTaxCents: 160, vehicleSizeLabel: "Small SUV" },
  ...over,
});

const ok = (r: ReturnType<typeof buildCostBreakdown>): CostBreakdown => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r;
};

describe("toCents — decimal half-up, never a guessed $0", () => {
  it.each([
    [1.005, 101],
    ["1.005", 101],
    [0.1 + 0.2, 30],
    ["19.90", 1990],
    [12.99, 1299],
    ["0", 0],
    [7, 700],
    ["134.4", 13440],
  ])("%s → %i", (v, want) => expect(toCents(v)).toBe(want));
  it.each([null, undefined, "", "abc", "-1.00", NaN, Infinity, "1e-7", -3])("%s → null", (v) => expect(toCents(v as never)).toBeNull());
});

describe("buildCostBreakdown — ResLab (due at location is INSIDE grand_total)", () => {
  it("plain: fees rolled into parking, the card charge is the total", () => {
    const b = ok(buildCostBreakdown(reslab()));
    expect(b.lines.map((l) => [l.label, l.cents])).toEqual([
      ["Parking — 3 days", 12000],
      ["Taxes", 1440],
      ["Triply service fee", 720],
    ]);
    expect(b.totalLabel).toBe("Paid online (card)");
    expect(b.totalCents).toBe(14160);
    expect(b.dueAtLocationCents).toBe(0);
    expect(b.tripTotalCents).toBeNull();
  });

  it("pay-at-lot: lines sum to the TOTAL; paid online + due = total — the due amount is never counted twice", () => {
    // 134.40 grand of which 60.00 is paid at the lot; card = 134.40 + 7.20 + 12.99 − 60.00
    const b = ok(buildCostBreakdown(reslab({ dueAtLocation: "60.00", protection: { name: "Plan A", premium: "12.99" }, anchorChargedCents: 9459 })));
    const sum = b.lines.reduce((s, l) => s + (l.credit ? -l.cents : l.cents), 0);
    expect(sum).toBe(b.totalCents);
    expect(b.totalLabel).toBe("Total");
    expect(b.totalCents).toBe(15459);
    expect(b.paidOnlineCents).toBe(9459);
    expect(b.dueAtLocationCents).toBe(6000);
    expect(b.paidOnlineCents + b.dueAtLocationCents).toBe(b.totalCents);
  });

  it("long-stay discount and promo are credit lines with the code", () => {
    // grand = 105 + 15 − 5 + 14.40 = 129.40; card = 129.40 + 7.20 − 10.00
    const b = ok(buildCostBreakdown(reslab({ longTermDiscount: "5.00", grandTotal: "129.40", promoDiscount: "10.00", promoCode: "WELCOME10", expectedPromoCents: 1000, anchorChargedCents: 12660 })));
    expect(b.lines.find((l) => l.key === "long_stay_discount")).toMatchObject({ cents: 500, credit: true, label: "Long-stay discount" });
    expect(b.lines.find((l) => l.key === "promo")).toMatchObject({ cents: 1000, credit: true, label: "Promo discount (WELCOME10)" });
    expect(b.totalCents).toBe(12660);
  });

  it("refused: a MISSING due-at-location is not $0 (ResLab omitted it at creation before)", () => {
    expect(buildCostBreakdown(reslab({ dueAtLocation: null }))).toMatchObject({ ok: false, reason: /due at location/ });
    expect(buildCostBreakdown(reslab({ dueAtLocation: undefined }))).toMatchObject({ ok: false });
  });

  it("refused: a promo that is not what the code's percent gives — a moved price or a swallowed due amount, not a discount", () => {
    // the derived 'discount' 70.00 absorbed a 60.00 due-at-location; the code gives 10.00
    expect(
      buildCostBreakdown(reslab({ promoDiscount: "70.00", promoCode: "WELCOME10", expectedPromoCents: 1000, anchorChargedCents: 7160 }))
    ).toMatchObject({ ok: false, reason: /percent/ });
    // within 1¢ of the percent is fine (rounded bases)
    expect(buildCostBreakdown(reslab({ promoDiscount: "10.01", promoCode: "WELCOME10", expectedPromoCents: 1000, anchorChargedCents: 13159 })).ok).toBe(true);
    // a discount with nothing to check it against falls back
    expect(buildCostBreakdown(reslab({ promoDiscount: "10.00", promoCode: "X", expectedPromoCents: null, anchorChargedCents: 13160 }))).toMatchObject({ ok: false });
  });

  it("refused: the PaymentIntent carries a promo percent but a price drop derived a $0 discount — never a receipt that silently drops the code", () => {
    expect(buildCostBreakdown(reslab({ promoDiscount: "0.00", promoCode: null, expectedPromoCents: 900 }))).toMatchObject({ ok: false, reason: /percent/ });
    // no promo on either side is fine
    expect(buildCostBreakdown(reslab({ promoDiscount: "0.00", expectedPromoCents: null })).ok).toBe(true);
  });

  it("refused: ResLab's parts do not add up to its grand total", () => {
    expect(buildCostBreakdown(reslab({ grandTotal: "134.41", anchorChargedCents: 14161 }))).toMatchObject({ ok: false, reason: /grand total/ });
  });

  it("refused: the card was charged something else (price moved after authorization, dates edited, manual recovery)", () => {
    expect(buildCostBreakdown(reslab({ anchorChargedCents: 14000 }))).toMatchObject({ ok: false, reason: /card was charged/ });
  });

  it("refused: ResLab's live total no longer matches the stored booking (modified after booking)", () => {
    expect(buildCostBreakdown(reslab({ storedGrandTotal: "120.00" }))).toMatchObject({ ok: false, reason: /modified/ });
    expect(ok(buildCostBreakdown(reslab({ storedGrandTotal: "134.40" }))).totalCents).toBe(14160);
  });

  it.each([
    ["the service fee is NULL (legacy row)", { serviceFee: null }, /service fee/],
    ["no anchor (Stripe read failed)", { anchorChargedCents: null }, /unknown/],
    ["a protection plan with no valid premium", { protection: { name: "Plan A", premium: null } }, /premium/],
    ["the subtotal is missing (a failed read)", { subtotal: undefined }, /subtotal/],
    ["fees are null", { fees: null }, /fees/],
  ])("refused, never $0: %s", (_n, over, reason) => {
    expect(buildCostBreakdown(reslab(over as Partial<ReslabCostInput>))).toMatchObject({ ok: false, reason });
  });

  it("cancelled pay-at-lot booking: the record stays, nothing is due any more, the refund is shown", () => {
    const b = ok(buildCostBreakdown(reslab({ dueAtLocation: "60.00", anchorChargedCents: 8160, cancelled: true, refundedCents: 8160 })));
    expect(b.dueAtLocationCents).toBe(0);
    expect(b.refundedCents).toBe(8160);
    expect(b.netPaidCents).toBe(0);
  });

  it("zero-value lines are hidden (no taxes line at $0)", () => {
    const b = ok(buildCostBreakdown(reslab({ tax: 0, grandTotal: "120.00", anchorChargedCents: 12720 })));
    expect(b.lines.map((l) => l.key)).toEqual(["parking", "service_fee"]);
  });
});

describe("buildCostBreakdown — direct (the at-lot surcharge is OUTSIDE the charge)", () => {
  it("TRP-D0K1KGXC: lines sum to the card charge; due at the lot and the trip total come after", () => {
    const b = ok(buildCostBreakdown(direct()));
    expect(b.lines.map((l) => [l.label, l.cents])).toEqual([
      ["Parking — 2 days", 1990],
      ["Taxes", 318],
      ["Triply service fee", 595],
      ["Parking Protection — Plan A", 1299],
    ]);
    expect(b.totalLabel).toBe("Charged to card");
    expect(b.totalCents).toBe(4202);
    expect(b.atLot).toEqual({ cents: 1160, surchargeCents: 1000, surchargeTaxCents: 160, vehicleSizeLabel: "Small SUV" });
    expect(b.tripTotalCents).toBe(5362);
    expect(b.tripTotalIsEstimate).toBe(true);
  });

  it("no oversized vehicle: no at-lot line, no trip total", () => {
    const b = ok(buildCostBreakdown(direct({ atLot: null })));
    expect(b.atLot).toBeNull();
    expect(b.tripTotalCents).toBeNull();
  });

  it("promo: its own credit line with the code", () => {
    const b = ok(buildCostBreakdown(direct({ promoDiscount: "2.00", promoCode: "SAVE2", expectedPromoCents: 200, anchorChargedCents: 4002 })));
    expect(b.lines.find((l) => l.key === "promo")).toMatchObject({ label: "Promo discount (SAVE2)", cents: 200, credit: true });
  });

  it("refused when the parts do not add up to the charge", () => {
    expect(buildCostBreakdown(direct({ anchorChargedCents: 4203 }))).toMatchObject({ ok: false });
  });

  it("cancelled: no money due at the lot; a refund nets out", () => {
    const b = ok(buildCostBreakdown(direct({ cancelled: true, refundedCents: 3602 })));
    expect(b.atLot).toBeNull();
    expect(b.tripTotalCents).toBeNull();
    expect(b.netPaidCents).toBe(600);
  });
});

describe("formatUsd", () => {
  it.each([
    [4202, false, "$42.02"],
    [123456, false, "$1,234.56"],
    [500, true, "−$5.00"],
    [5, false, "$0.05"],
  ])("%i (credit %s) → %s", (c, credit, want) => expect(formatUsd(c, credit)).toBe(want));
});


describe("toCents never throws on vendor JSON", () => {
  it.each([false, true, {}, []])("%j → null", (v) => expect(toCents(v as never)).toBeNull());
});

const P88 = { subtotal: "80.00", fees: "3.00", longTermDiscount: 0, tax: "5.00" };
describe("fallbackDue — the due figure judged on its own merits (round-3 review)", () => {
  const PROMO = "promo discount does not match the code's percent";
  const ANCHOR = "the parts do not add up to what the card was charged";
  it("a believable positive due is shown even after an anchor or promo refusal", () => {
    expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: "40.00", grandTotal: "88.00", refusal: ANCHOR, cancelled: false })).toEqual({ kind: "amount", cents: 4000 });
    expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: "40.00", grandTotal: "88.00", refusal: PROMO, cancelled: false })).toEqual({ kind: "amount", cents: 4000 });
  });
  it("a due larger than the whole booking is never printed (Codex: $200 on an $88 booking)", () => {
    expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: "200.00", grandTotal: "88.00", refusal: PROMO, cancelled: false })).toEqual({ kind: "unconfirmed" });
  });
  it("a recorded $0 the refusal casts doubt on is 'unconfirmed', never 'nothing due'", () => {
    expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: "0.00", grandTotal: "88.00", refusal: PROMO, cancelled: false })).toEqual({ kind: "unconfirmed" });
    expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: "0", grandTotal: "88.00", refusal: ANCHOR, cancelled: false })).toEqual({ kind: "unconfirmed" });
  });
  it("$0 with an unrelated refusal (Stripe unreadable, legacy fee) is 'none'", () => {
    expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: 0, grandTotal: "88.00", refusal: "what the card was charged is unknown", cancelled: false })).toEqual({ kind: "none" });
  });
  it("a $0 due after an EARLY refusal (subtotal missing) is unconfirmed — Codex round-4 reproduction", () => {
    expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: 0, grandTotal: "88.00", refusal: "subtotal missing", cancelled: false })).toEqual({ kind: "unconfirmed" });
    expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: 0, grandTotal: "88.00", refusal: "service fee missing (legacy row?)", cancelled: false })).toEqual({ kind: "unconfirmed" });
  });

  it("the grand total cannot bound the due when it is the figure that failed (round 4)", () => {
    expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: "200.00", grandTotal: "880.00", refusal: "ResLab parts do not add up to its grand total", cancelled: false })).toEqual({ kind: "unconfirmed" });
  });

  it("every reason the rule relies on is one buildCostBreakdown really returns (no silent drift)", () => {
    const r = buildCostBreakdown(reslab({ anchorChargedCents: null }));
    expect(r).toMatchObject({ ok: false, reason: "what the card was charged is unknown" });
    const g = buildCostBreakdown(reslab({ grandTotal: "134.41", anchorChargedCents: 14161 }));
    expect(g).toMatchObject({ ok: false, reason: "ResLab parts do not add up to its grand total" });
  });

  it("an inflated grand total never vouches for a due, whatever refusal fired first (Codex confirmation pass)", () => {
    for (const refusal of ["promo discount does not match the code's percent", "service fee missing (legacy row?)", null]) {
      expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: "200.00", grandTotal: "880.00", refusal, cancelled: false })).toEqual({ kind: "unconfirmed" });
    }
    // missing parts cannot prove the total either
    expect(fallbackDue({ source: "reslab", parts: { ...P88, subtotal: null }, recordedDue: "40.00", grandTotal: "88.00", refusal: null, cancelled: false })).toEqual({ kind: "unconfirmed" });
  });

  it("missing or unreadable → unconfirmed; cancelled → none", () => {
    expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: null, grandTotal: "88.00", refusal: null, cancelled: false })).toEqual({ kind: "unconfirmed" });
    expect(fallbackDue({ source: "reslab", parts: P88, recordedDue: "40.00", grandTotal: "88.00", refusal: ANCHOR, cancelled: true })).toEqual({ kind: "none" });
  });
  it("direct: the at-lot surcharge (outside the charge) is shown whatever the refusal", () => {
    expect(fallbackDue({ source: "direct", recordedDue: 1160 / 100, refusal: ANCHOR, cancelled: false })).toEqual({ kind: "amount", cents: 1160 });
    expect(fallbackDue({ source: "direct", recordedDue: null, refusal: ANCHOR, cancelled: false })).toEqual({ kind: "none" });
  });
});
