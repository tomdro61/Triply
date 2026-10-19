import { describe, it, expect } from "vitest";
import { mapHotelContent, mapHotelRates } from "../liteapi/rates";
import { HOTEL_LOTS } from "../hotel-lots";
import { content, hotelRates, rate } from "./fixtures";

const NY = "America/New_York";
const NOW = new Date("2026-10-20T16:00:00Z");
const doubletree = HOTEL_LOTS[0];

describe("mapHotelRates — every USD rate, integer cents, total mapping", () => {
  it("maps EVERY USD rate (the leading one is chosen after pricing, B14) and skips non-USD rates", () => {
    const eur = { ...rate({ rateId: "eur", net: 100 }), retailRate: { total: [{ amount: 100, currency: "EUR" }] } };
    const hr = hotelRates("lp27fe6", [
      rate({ rateId: "a", net: 300, ssp: 310 }),
      rate({ rateId: "b", net: 232.97, ssp: 235.07, refundable: true, atHotel: [{ amount: 3.5, currency: "USD" }, { amount: 34.36, currency: "USD", description: "TAX" }] }),
      eur,
    ]);
    const anomalies = new Set<string>();
    const m = mapHotelRates(hr, NY, NOW, anomalies);
    expect(m.hiddenReason).toBeNull();
    expect(m.malformed).toBe(0);
    expect(m.rates.map((r) => r.rateId)).toEqual(["a", "b"]);
    const b = m.rates[1];
    expect(b).toMatchObject({ roomNetCents: 23_297, sspCents: 23_507, propertyFeesDueAtHotelCents: 3_786, refundableTag: "RFN" });
    expect(b.refundability).toEqual({ kind: "free_until", deadlineLocal: "2026-11-10 15:00", timeZone: NY });
    expect(b.roomKey).toBe("rt-lp27fe6|RO|RFN");
    expect(m.rates[0].roomKey).toBe("rt-lp27fe6|RO|NRFN");
    expect([...anomalies]).toEqual([]);
  });

  it("a hotel-collected fee in another currency hides the hotel (B13)", () => {
    const anomalies = new Set<string>();
    const m = mapHotelRates(hotelRates("lp27fe6", [rate({ rateId: "a", net: 200, atHotel: [{ amount: 10, currency: "EUR" }] })]), NY, NOW, anomalies);
    expect(m.hiddenReason).toBe("non_usd_collected_fee");
    expect([...anomalies][0]).toMatch(/EUR/);
  });

  it("a hotel-collected fee with no currency also hides the hotel — its total can't be stated", () => {
    const m = mapHotelRates(hotelRates("lp27fe6", [rate({ rateId: "a", net: 200, atHotel: [{ amount: 10 }] })]), NY, NOW, new Set());
    expect(m.hiddenReason).toBe("non_usd_collected_fee");
  });

  it("a fee WITHOUT an `included` field is paid at the hotel (+ anomaly), never silently included (M8)", () => {
    const r = rate({ rateId: "a", net: 200 });
    const anomalies = new Set<string>();
    const m = mapHotelRates(
      hotelRates("lp27fe6", [{ ...r, retailRate: { ...r.retailRate, taxesAndFees: [{ amount: 12.5, currency: "USD", description: "City tax" }, { included: true, amount: 30, currency: "USD" }] } }]),
      NY,
      NOW,
      anomalies
    );
    expect(m.rates[0].propertyFeesDueAtHotelCents).toBe(1_250);
    expect([...anomalies]).toEqual([expect.stringMatching(/without "included"/)]);
  });

  it("an unrecognised fee description stays paid-at-the-hotel AND is an anomaly", () => {
    const anomalies = new Set<string>();
    const m = mapHotelRates(hotelRates("lp27fe6", [rate({ rateId: "a", net: 200, atHotel: [{ amount: 20, currency: "USD", description: "Resort levy" }] })]), NY, NOW, anomalies);
    expect(m.rates[0].propertyFeesDueAtHotelCents).toBe(2_000);
    expect([...anomalies]).toEqual([expect.stringMatching(/Resort levy/)]);
  });

  it("an unknown refundable tag renders non-refundable and is reported once", () => {
    const r = rate({ rateId: "a", net: 200 });
    const anomalies = new Set<string>();
    const m = mapHotelRates(hotelRates("lp27fe6", [{ ...r, cancellationPolicies: { refundableTag: "MAYBE", cancelPolicyInfos: [] } }]), NY, NOW, anomalies);
    expect(m.rates[0].refundability).toEqual({ kind: "non_refundable" });
    expect(m.rates[0].roomKey).toBe("rt-lp27fe6|RO|NRFN");
    expect(anomalies.size).toBe(1);
  });

  it("a refundable rate whose deadline has passed shows non-refundable (H4) but keeps its supplier key", () => {
    const later = new Date("2026-11-11T00:00:00Z");
    const m = mapHotelRates(hotelRates("lp27fe6", [rate({ rateId: "a", net: 200, refundable: true })]), NY, later, new Set());
    expect(m.rates[0].refundability).toEqual({ kind: "non_refundable" });
    expect(m.rates[0].roomKey).toBe("rt-lp27fe6|RO|RFN");
  });

  it("malformed rates are skipped and counted; a hotel whose rates are ALL unreadable is rates_malformed, not 'no room'", () => {
    const anomalies = new Set<string>();
    const some = mapHotelRates(hotelRates("lp27fe6", [rate({ rateId: "ok", net: 200 }), { rateId: 7 }, "junk"]), NY, NOW, anomalies);
    expect(some.rates.map((r) => r.rateId)).toEqual(["ok"]);
    expect(some.malformed).toBe(2);
    expect(some.hiddenReason).toBeNull();
    const none = mapHotelRates({ hotelId: "lp27fe6", roomTypes: [{ offerId: "" }, { offerId: "o", rates: [{ retailRate: "x" }] }] }, NY, NOW, anomalies);
    expect(none).toMatchObject({ rates: [], malformed: 2, hiddenReason: "rates_malformed" });
  });
});

describe("mapHotelContent — the snake_case hotels[] block", () => {
  it("maps name, photo, stars, rating, review_count and coordinates", () => {
    const c = mapHotelContent(content(doubletree), new Set());
    expect(c).toMatchObject({
      hotelId: "lp27fe6",
      name: doubletree.liteapi.name,
      photoUrl: "https://static.cupid.travel/hotels/lp27fe6.jpg",
      stars: 3,
      rating: 8,
      reviewCount: 100,
      latitude: doubletree.liteapi.latitude,
    });
  });
  it("a photo on a non-allowlisted host renders the placeholder and is reported", () => {
    const anomalies = new Set<string>();
    expect(mapHotelContent(content(doubletree, { main_photo: "https://cdn.other.example/a.jpg" }), anomalies).photoUrl).toBeNull();
    expect([...anomalies]).toEqual(["photo host rejected: cdn.other.example"]);
  });
});
