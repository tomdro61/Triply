import { describe, it, expect } from "vitest";
import { aggregate, buildPromoReport, byAirport, byChannel, presentRate, type ReportRow } from "../report";
import { attributionSourceLabel } from "../display";

const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  channel: null,
  attribution: null,
  airport_code: "JFK",
  promo_code: null,
  discount_amount: "0",
  grand_total: "80",
  triply_service_fee: "6",
  protection_plan: null,
  protection_plan_price: null,
  status: "confirmed",
  ...over,
});

describe("attributionSourceLabel", () => {
  it("channel wins; invalid marker → 'invalid'; nothing → 'unknown'; 'direct' stays distinct", () => {
    expect(attributionSourceLabel({ channel: "paid_search", attribution: null })).toBe("paid_search");
    expect(attributionSourceLabel({ channel: "direct", attribution: { v: 1 } })).toBe("direct");
    expect(attributionSourceLabel({ channel: null, attribution: { v: null, invalid: true } })).toBe("invalid");
    expect(attributionSourceLabel({ channel: null, attribution: null })).toBe("unknown");
  });
  it("an unexpected DB value for channel reads as 'unknown', never raw", () => {
    expect(attributionSourceLabel({ channel: "", attribution: null })).toBe("unknown");
    expect(attributionSourceLabel({ channel: "Paid_Search", attribution: null })).toBe("unknown");
  });
});

describe("aggregate", () => {
  it("counts ONLY confirmed rows — refunded (the common cancellation status) and disputed are excluded", () => {
    const rows = [
      row({ channel: "email" }),
      row({ channel: "email", status: "refunded" }),
      row({ channel: "email", status: "disputed" }),
      row({ channel: "email", status: "cancelled" }),
    ];
    const out = byChannel(rows);
    expect(out).toEqual([{ key: "email", bookings: 1, gross: 86, triply: 6, protected: 0 }]);
  });
  it("gross = grand_total + service fee + protection premium, NULL numerics as 0; sorted by bookings desc", () => {
    const rows = [
      row({ channel: "direct", grand_total: "100", triply_service_fee: null, protection_plan: "Plan A", protection_plan_price: "12.99" }),
      row({ channel: "paid_search" }),
      row({ channel: "paid_search" }),
    ];
    const out = byChannel(rows);
    expect(out[0]).toEqual({ key: "paid_search", bookings: 2, gross: 172, triply: 12, protected: 0 });
    expect(out[1]).toEqual({ key: "direct", bookings: 1, gross: 112.99, triply: 0, protected: 1 });
  });
});

describe("byAirport", () => {
  it("folds RESLAB / '' / NULL into 'unknown'", () => {
    const rows = [row({ airport_code: "RESLAB" }), row({ airport_code: "" }), row({ airport_code: null }), row()];
    const { rows: out, total } = byAirport(rows);
    expect(total).toBe(4);
    expect(out.find((a) => a.key === "unknown")?.bookings).toBe(3);
    expect(out.find((a) => a.key === "JFK")?.bookings).toBe(1);
  });
  it("keeps the top N and folds the tail into 'other' so Share sums over ALL bookings", () => {
    const rows = ["A", "B", "C", "D"].flatMap((code, i) =>
      Array.from({ length: 4 - i }, () => row({ airport_code: code }))
    );
    const { rows: out, total } = byAirport(rows, 2);
    expect(total).toBe(10);
    expect(out.map((a) => a.key)).toEqual(["A", "B", "other"]);
    expect(out[2].bookings).toBe(3);
    expect(out.reduce((n, a) => n + a.bookings, 0)).toBe(total);
  });
});

describe("buildPromoReport", () => {
  const meta = [
    { code: "SAVE20", discount_percent: 20, active: true, current_uses: 0, max_uses: null, expires_at: null },
    { code: "WELCOME-1", discount_percent: 10, active: true, current_uses: 1, max_uses: 1, expires_at: "2020-01-01T00:00:00Z" },
    { code: "OLD", discount_percent: 5, active: false, current_uses: 3, max_uses: null, expires_at: null },
  ];
  it("puts the derived booking count next to promo_codes.current_uses so trigger drift is visible", () => {
    const rows = [row({ promo_code: "SAVE20", discount_amount: "16" }), row({ promo_code: "SAVE20", discount_amount: "16", status: "refunded" })];
    const out = buildPromoReport(rows, meta, Date.parse("2026-09-17"));
    const save = out.find((p) => p.code === "SAVE20")!;
    expect(save).toMatchObject({ bookings: 1, discount: 16, currentUses: 0, active: true, discountPercent: 20 });
  });
  it("lists an ACTIVE code with zero bookings (and flags expiry), but not an inactive unused one", () => {
    const out = buildPromoReport([], meta, Date.parse("2026-09-17"));
    expect(out.map((p) => p.code).sort()).toEqual(["SAVE20", "WELCOME-1"]);
    expect(out.find((p) => p.code === "WELCOME-1")?.expired).toBe(true);
  });
  it("a booking whose code has no promo_codes row still appears, with currentUses null; codes match case-insensitively", () => {
    const out = buildPromoReport([row({ promo_code: "GHOST", discount_amount: "5" }), row({ promo_code: "save20", discount_amount: "1" })], meta);
    expect(out.find((p) => p.code === "GHOST")).toMatchObject({ bookings: 1, currentUses: null });
    expect(out.find((p) => p.code === "save20")?.currentUses).toBe(0);
    expect(out.filter((p) => p.code.toUpperCase() === "SAVE20")).toHaveLength(1);
  });
});

describe("presentRate — the capture-health alarm", () => {
  it("null when there were no bookings in the window", () => {
    expect(presentRate([])).toEqual({ presentRate: null, invalidRate: null, total: 0 });
  });
  it("counts ONLY valid cookies as present; the invalid marker is reported separately, never as captured", () => {
    const out = presentRate([
      { attribution: { v: 1 } },
      { attribution: { v: null, invalid: true } },
      { attribution: null },
      { attribution: { v: null, invalid: true } },
    ]);
    expect(out).toEqual({ presentRate: 0.25, invalidRate: 0.5, total: 4 });
  });
});

describe("aggregate is a plain function of its inputs", () => {
  it("does not mutate the rows it is given", () => {
    const rows = [row({ channel: "email" })];
    const snapshot = JSON.stringify(rows);
    aggregate(rows, () => "x");
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});
