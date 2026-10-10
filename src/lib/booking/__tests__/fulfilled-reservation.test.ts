import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromReslab } from "../fulfilled-reservation";

/**
 * fromReslab runs on the money path AFTER the reservation number is recorded
 * and BEFORE capture (direct-lots 4a plan §6 A1), outside any try block — a
 * throw there would leave a live reservation with the authorization held and
 * no booking. So it must be TOTAL: no input, however malformed the ResLab
 * body, may make it throw. ResLab bodies are cast, never validated, so these
 * come in through JSON.parse exactly as a wire body would.
 */
const wire = (json: string) => fromReslab(JSON.parse(json));

describe("fromReslab — never throws", () => {
  const hostile = [
    "null",
    "{}",
    '"RTL1"',
    "42",
    "[]",
    '{"reservation_number":"RTL1","history":null}',
    '{"reservation_number":"RTL1","history":[null]}',
    '{"reservation_number":"RTL1","history":"x"}',
    '{"reservation_number":"RTL1","history":[{"location":null,"dates":null}]}',
    '{"reservation_number":"RTL1","history":[{"location":{"state":null,"timezone":null},"dates":[null]}]}',
    '{"reservation_number":"RTL1","history":[{"location":"lot","dates":"x"}]}',
    '{"reservation_number":"RTL1","history":[{"location":{"state":"NY","timezone":"EST","latitude":"x"},"dates":{}}]}',
    // An object whose toString isn't callable: String() on it throws.
    '{"reservation_number":"RTL1","history":[{"location":{"latitude":{"toString":1},"longitude":{"valueOf":1}}}]}',
  ];
  for (const json of hostile) {
    it(`handles ${json}`, () => {
      expect(() => wire(json)).not.toThrow();
    });
  }

  it("an unparseable coordinate object yields no coordinates (persistBooking then falls back to getLocation)", () => {
    const r = wire('{"reservation_number":"RTL1","history":[{"location":{"latitude":{"toString":1},"longitude":"-73.7"}}]}');
    expect(r.location?.coords).toBeNull();
  });

  it("non-array dates become null (the response then sends items: [])", () => {
    expect(wire('{"reservation_number":"RTL1","history":[{"dates":"x"}]}').dates).toBeNull();
    expect(wire('{"reservation_number":"RTL1","history":[{"dates":{}}]}').dates).toBeNull();
  });
});

describe("fromReslab — mapping", () => {
  const full = wire(
    JSON.stringify({
      reservation_number: "RTL900",
      cancelled: 0,
      history: [
        {
          id: 777,
          grand_total: 89.75,
          due_at_location_total: 0,
          subtotal: 81,
          total_tax: 6.5,
          total_fees: 2.25,
          dates: [{ from_date: "2026-08-14 10:00:00", to_date: "2026-08-18 14:00:00" }],
          location: {
            id: 4242,
            name: "Lot",
            address: "1 Road",
            city: "Jamaica",
            state: { code: "NY" },
            zip_code: "11430",
            phone: "+1",
            latitude: "40.6675",
            longitude: "-73.7845",
            timezone: { code: "America/New_York" },
            shuttle_info_details: "<p>x</p>",
            special_conditions: null,
          },
        },
      ],
    })
  );

  it("carries money raw, keeping 0 as 0 (callers' ?? and || then behave as before)", () => {
    expect(full.money).toEqual({ subtotal: 81, taxTotal: 6.5, feesTotal: 2.25, grandTotal: 89.75, dueAtLocation: 0 });
  });

  it("cancelled follows ResLab's 0/1 numbers", () => {
    expect(full.cancelled).toBe(false);
    expect(wire('{"reservation_number":"R","cancelled":1}').cancelled).toBe(true);
    expect(wire('{"reservation_number":"R","cancelled":true}').cancelled).toBe(true);
  });

  it("keeps the ResLab location id apart from a direct lot id", () => {
    expect(full.location?.reslabLocationId).toBe(4242);
    expect(full.location?.directLotId).toBeNull();
  });

  it("parses coordinates with the same validCoords persistBooking used", () => {
    expect(full.location?.coords).toEqual({ lat: 40.6675, lng: -73.7845 });
    expect(full.location?.timezone).toBe("America/New_York");
  });

  it("keeps absent vs null as received for the fields the response copies verbatim", () => {
    const sparse = wire('{"reservation_number":"R","history":[{"location":{"name":null}}]}');
    expect(sparse.location?.name).toBeNull();
    expect(sparse.location).toHaveProperty("phone", undefined);
    expect(sparse.historyId).toBeNull();
  });

  it("no history at all → no location, no dates, all money null", () => {
    const bare = wire('{"reservation_number":"R"}');
    expect(bare.location).toBeNull();
    expect(bare.dates).toBeNull();
    expect(Object.values(bare.money).every((v) => v === null)).toBe(true);
  });
});

describe("fulfil functions no longer read ResLab's raw shape (4a plan §6 A9)", () => {
  const src = readFileSync(fileURLToPath(new URL("../fulfill.ts", import.meta.url)), "utf8");

  it("fulfill.ts reads no reservation history or raw reservation number", () => {
    expect(src).not.toMatch(/\.history\b/);
    expect(src).not.toMatch(/\breservation\.reservation_number\b/);
  });

  it("ReslabReservation appears only as createReslabReservation's return type", () => {
    const uses = src.match(/\bReslabReservation\b/g) ?? [];
    // the `import type` line + `Promise<ReslabReservation>`
    expect(uses).toHaveLength(2);
    expect(src).toMatch(/Promise<ReslabReservation>/);
  });
});
