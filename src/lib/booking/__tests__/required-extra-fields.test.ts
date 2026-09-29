import { describe, it, expect } from "vitest";
import {
  isRequiredExtraField,
  missingRequiredExtraFields,
  reslabExtraFieldValues,
  extraFieldStepErrors,
  checkoutExtraFields,
  declaredExtraFieldsSchema,
  notApplicableHint,
} from "../required-extra-fields";
import { isVehicleFieldName } from "../vehicle-field-aliases";

const vehicle = { make: "Toyota", model: "Camry", color: "Blue", licensePlate: "ABC123", state: "TN" };

// The shape ResLab actually sends (client.ts ReslabExtraField, OpenAPI v1.10):
// `type` is the product scope, never "required".
const flight = { id: 1, name: "return_flight_number", label: "Return flight #", type: "parking", inputType: "text", perCar: false };
const both = { id: 2, name: "passengers", label: "Passengers", type: "both", inputType: "number", perCar: false };
const room = { id: 3, name: "room_preference", label: "Room preference", type: "room", inputType: "text", perCar: false };
const plate = { id: 4, name: "license_plate_number", label: "Plate", type: "parking", inputType: "license_plate", perCar: true };

describe("isRequiredExtraField — ResLab gives no required flag", () => {
  it("treats parking and both as required (the old `type === \"required\"` test was never true)", () => {
    expect(isRequiredExtraField(flight)).toBe(true);
    expect(isRequiredExtraField(both)).toBe(true);
  });

  it("room-only fields are optional — we only book parking", () => {
    expect(isRequiredExtraField(room)).toBe(false);
    expect(isRequiredExtraField({ type: " Room " })).toBe(false);
  });

  it("an unknown scope fails SAFE (required)", () => {
    expect(isRequiredExtraField({ type: "" })).toBe(true);
    expect(isRequiredExtraField({ type: "required" })).toBe(true);
    expect(isRequiredExtraField({ type: "valet" })).toBe(true);
  });
});

describe("missingRequiredExtraFields", () => {
  it("flags blank and whitespace-only answers, ignores room fields", () => {
    const missing = missingRequiredExtraFields([flight, both, room], { passengers: "   " });
    expect(missing.map((f) => f.name)).toEqual(["return_flight_number", "passengers"]);
  });

  it("an N/A answer satisfies the field (a driver with no return flight can still book)", () => {
    expect(missingRequiredExtraFields([flight], { return_flight_number: "N/A" })).toEqual([]);
  });

  it("no declared fields → nothing missing", () => {
    expect(missingRequiredExtraFields(undefined, {})).toEqual([]);
    expect(missingRequiredExtraFields([], {})).toEqual([]);
  });
});

describe("reslabExtraFieldValues — the map fulfilment sends", () => {
  it("always carries the common vehicle names, overlaid by the payload", () => {
    expect(reslabExtraFieldValues(vehicle, { return_flight_number: "DL12", car_color: "Red" })).toEqual({
      car_make: "Toyota",
      car_model: "Camry",
      car_makemodel: "Toyota Camry",
      car_color: "Red",
      license_plate: "ABC123",
      license_plate_state: "TN",
      return_flight_number: "DL12",
    });
  });
});

describe("extraFieldStepErrors — the vehicle step cannot advance with a required lot field empty", () => {
  it("blocks on an empty return flight number", () => {
    expect(extraFieldStepErrors([flight], vehicle, {})).toEqual({
      return_flight_number: "Return flight # is required",
    });
  });

  it("advances once it is answered (N/A included)", () => {
    expect(extraFieldStepErrors([flight], vehicle, { return_flight_number: "UA 455" })).toEqual({});
    expect(extraFieldStepErrors([flight], vehicle, { return_flight_number: "N/A" })).toEqual({});
  });

  it("vehicle-named fields are answered by the vehicle inputs, never asked again", () => {
    expect(extraFieldStepErrors([plate], vehicle, {})).toEqual({});
    // …and a stale typed value can't stand in for the vehicle step's answer.
    expect(extraFieldStepErrors([plate], { ...vehicle, licensePlate: "" }, { license_plate_number: "X" })).toEqual({});
  });

  it("room-only fields never block", () => {
    expect(extraFieldStepErrors([room], vehicle, {})).toEqual({});
  });

  it("falls back to a generic label", () => {
    expect(extraFieldStepErrors([{ ...flight, label: " " }], vehicle, {})).toEqual({
      return_flight_number: "This field is required",
    });
  });
});

describe("declaredExtraFieldsSchema — the ResLab boundary", () => {
  it("accepts ResLab's field objects (extra keys pass through)", () => {
    const raw = [{ id: 9, name: "flight", label: "Flight", type: "parking", input_type: "text", per_car: 0 }];
    expect(declaredExtraFieldsSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects a shape it can't reason about", () => {
    expect(declaredExtraFieldsSchema.safeParse([{ label: "no name", type: "parking" }]).success).toBe(false);
    expect(declaredExtraFieldsSchema.safeParse({ name: "x" }).success).toBe(false);
  });
});

describe("notApplicableHint", () => {
  it("tells a number field to take 0, a text field N/A", () => {
    expect(notApplicableHint("number")).toMatch(/enter 0/);
    expect(notApplicableHint("text")).toMatch(/N\/A/);
  });
});

describe("a field with no scope", () => {
  it("counts as required and never throws (the checkout page calls this while rendering)", () => {
    expect(isRequiredExtraField({ type: null })).toBe(true);
    expect(isRequiredExtraField({ type: undefined })).toBe(true);
    expect(isRequiredExtraField({})).toBe(true);
  });

  it("passes the ResLab boundary instead of failing the lot's whole list", () => {
    const parsed = declaredExtraFieldsSchema.safeParse([
      { id: 1, name: "ship", label: null, type: null },
      { id: 2, name: "flight", label: "Flight" },
    ]);
    expect(parsed.success).toBe(true);
  });
});

// Field lists copied from the live ResLab lot list (2026-09-29), labels
// verbatim including their stray whitespace. `type` is what ResLab sent.
type LotField = { id: number; name: string; label: string; type: string; inputType: string; perCar: boolean };
type RealLot =
  | "Park For U (LGA) 343"
  | "Southwestern Airport Parking (BNA) 471"
  | "Quality Inn Buffalo Airport (BUF) 35"
  | "CLE Park (CLE) 258";

const REAL_LOTS: Record<RealLot, LotField[]> = {
  "Park For U (LGA) 343": [
    { id: 1, name: "car_makemodel", label: "Car Make/Model", type: "parking", inputType: "text", perCar: true },
    { id: 2, name: "license_plate", label: "License Plate", type: "both", inputType: "text", perCar: true },
    { id: 3, name: "return_flight_number", label: "Return Flight number", type: "both", inputType: "flight_number", perCar: false },
  ],
  "Southwestern Airport Parking (BNA) 471": [
    { id: 4, name: "license_plate_number", label: "License Plate Number", type: "both", inputType: "license_plate", perCar: true },
    { id: 5, name: "vehicle_make", label: "Vehicle Make", type: "both", inputType: "text", perCar: true },
  ],
  "Quality Inn Buffalo Airport (BUF) 35": [
    { id: 6, name: "stateprovince", label: "State/Province ", type: "both", inputType: "text", perCar: false },
    { id: 7, name: "number_of_passengers", label: "#Number of Passengers ", type: "both", inputType: "text", perCar: false },
    { id: 8, name: "makemodel_of_car", label: "Make/Model of Car", type: "both", inputType: "text", perCar: true },
  ],
  "CLE Park (CLE) 258": [
    { id: 9, name: "returning_flight", label: "Returning Flight #", type: "both", inputType: "text", perCar: false },
    { id: 10, name: "returning_flight_arrival_time", label: "Returning Flight Arrival Time", type: "both", inputType: "text", perCar: false },
  ],
};

// What the customer must TYPE at each lot (everything else comes from the
// vehicle step).
const ASKED: Record<RealLot, string[]> = {
  "Park For U (LGA) 343": ["return_flight_number"],
  "Southwestern Airport Parking (BNA) 471": [],
  "Quality Inn Buffalo Airport (BUF) 35": ["stateprovince", "number_of_passengers"],
  "CLE Park (CLE) 258": ["returning_flight", "returning_flight_arrival_time"],
};

/** The server gate, fed the body the form sends. */
function serverMissing(
  fields: ReadonlyArray<{ name: string; type: string }>,
  typed: Record<string, string>
): string[] {
  return missingRequiredExtraFields(
    fields,
    reslabExtraFieldValues(vehicle, checkoutExtraFields(fields, vehicle, typed))
  ).map((f) => f.name);
}

describe("client and server gates agree on real lots", () => {
  const lots: RealLot[] = [
    "Park For U (LGA) 343",
    "Southwestern Airport Parking (BNA) 471",
    "Quality Inn Buffalo Airport (BUF) 35",
    "CLE Park (CLE) 258",
  ];

  it.each(lots)("%s — nothing typed: both gates name exactly the fields the customer owes", (lot) => {
    const fields = REAL_LOTS[lot];
    expect(Object.keys(extraFieldStepErrors(fields, vehicle, {})).sort()).toEqual([...ASKED[lot]].sort());
    expect(serverMissing(fields, {}).sort()).toEqual([...ASKED[lot]].sort());
  });

  it.each(lots)("%s — whitespace is not an answer, on either gate", (lot) => {
    const fields = REAL_LOTS[lot];
    const typed = Object.fromEntries(ASKED[lot].map((n) => [n, "   "]));
    expect(Object.keys(extraFieldStepErrors(fields, vehicle, typed)).sort()).toEqual([...ASKED[lot]].sort());
    expect(serverMissing(fields, typed).sort()).toEqual([...ASKED[lot]].sort());
  });

  it.each(lots)("%s — N/A everywhere: both gates pass", (lot) => {
    const fields = REAL_LOTS[lot];
    const typed = Object.fromEntries(ASKED[lot].map((n) => [n, "N/A"]));
    expect(extraFieldStepErrors(fields, vehicle, typed)).toEqual({});
    expect(serverMissing(fields, typed)).toEqual([]);
  });

  it("uses the lot's label, trimmed, in the message", () => {
    const errors = extraFieldStepErrors(REAL_LOTS["Quality Inn Buffalo Airport (BUF) 35"], vehicle, {});
    expect(errors.stateprovince).toBe("State/Province is required");
    expect(errors.number_of_passengers).toBe("#Number of Passengers is required");
  });

  it("no declared fields: the step advances and nothing is sent", () => {
    expect(extraFieldStepErrors(undefined, vehicle, {})).toEqual({});
    expect(extraFieldStepErrors([], vehicle, {})).toEqual({});
    expect(checkoutExtraFields(undefined, vehicle, {})).toEqual({});
  });
});

describe("what the form sends for each kind of field", () => {
  it("Quality Inn: make/model comes from the vehicle step under the lot's name; state/province is typed", () => {
    const fields = REAL_LOTS["Quality Inn Buffalo Airport (BUF) 35"];
    expect(isVehicleFieldName("makemodel_of_car")).toBe(true);
    // Could be the plate's state or the customer's home state: the customer answers.
    expect(isVehicleFieldName("stateprovince")).toBe(false);
    expect(
      checkoutExtraFields(fields, vehicle, { stateprovince: "NY", number_of_passengers: "2" })
    ).toEqual({ stateprovince: "NY", number_of_passengers: "2", makemodel_of_car: "Toyota Camry" });
  });

  it("a stale typed value for a vehicle-named field never outranks the vehicle step", () => {
    const fields = REAL_LOTS["Southwestern Airport Parking (BNA) 471"];
    expect(checkoutExtraFields(fields, vehicle, { license_plate_number: "OLD" })).toEqual({
      license_plate_number: "ABC123",
      vehicle_make: "Toyota",
    });
  });

  it("a declared name with odd case or spacing is answered under the lot's exact key on both gates", () => {
    const fields = [{ id: 1, name: "License_Plate_Number ", label: "Plate", type: "parking" }];
    expect(checkoutExtraFields(fields, vehicle, {})).toEqual({ "License_Plate_Number ": "ABC123" });
    expect(extraFieldStepErrors(fields, vehicle, {})).toEqual({});
    expect(serverMissing(fields, {})).toEqual([]);
  });
});
