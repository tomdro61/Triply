import { describe, it, expect } from "vitest";
import {
  isRequiredExtraField,
  missingRequiredExtraFields,
  reslabExtraFieldValues,
  extraFieldStepErrors,
  declaredExtraFieldsSchema,
  notApplicableHint,
} from "../required-extra-fields";

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
