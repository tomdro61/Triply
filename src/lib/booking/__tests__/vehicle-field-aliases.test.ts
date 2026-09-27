import { describe, it, expect } from "vitest";
import { vehicleFieldAliasValues, isVehicleFieldName } from "../vehicle-field-aliases";

const vehicle = { make: "Toyota", model: "Camry", color: "Blue", licensePlate: "ABC123", state: "TN" };

describe("vehicleFieldAliasValues — the BNA lot 471 case (2026-09-25 lost sale)", () => {
  it("fills a lot's own spellings from the vehicle step", () => {
    const lot = [{ name: "license_plate_number" }, { name: "vehicle_make" }];
    expect(vehicleFieldAliasValues(lot, vehicle)).toEqual({
      license_plate_number: "ABC123",
      vehicle_make: "Toyota",
    });
  });

  it("emits ONLY the names the lot declares, never every alias", () => {
    expect(vehicleFieldAliasValues([{ name: "plate" }], vehicle)).toEqual({ plate: "ABC123" });
    expect(vehicleFieldAliasValues([], vehicle)).toEqual({});
    expect(vehicleFieldAliasValues(undefined, vehicle)).toEqual({});
  });

  it("leaves unknown fields for the customer to answer and skips empty vehicle values", () => {
    expect(vehicleFieldAliasValues([{ name: "flight_number" }], vehicle)).toEqual({});
    expect(vehicleFieldAliasValues([{ name: "vehicle_color" }], { ...vehicle, color: "" })).toEqual({});
  });

  it("combined make+model spellings and case-insensitive names", () => {
    expect(vehicleFieldAliasValues([{ name: "Vehicle_MakeModel" }], vehicle)).toEqual({ Vehicle_MakeModel: "Toyota Camry" });
  });
});

describe("isVehicleFieldName — what the vehicle step hides from 'additional fields'", () => {
  it("recognises the common names AND the lot-specific spellings", () => {
    for (const n of ["car_make", "license_plate", "license_plate_number", "vehicle_make", "plate_state"]) {
      expect(isVehicleFieldName(n), n).toBe(true);
    }
    expect(isVehicleFieldName("flight_number")).toBe(false);
    expect(isVehicleFieldName("return_flight_number")).toBe(false);
  });
});
